//! The stage widget: the iced shader widget that shows the stage painter's picture and reports pointer, wheel, key,
//! pen and size to the core (`docs/native/stage.md`, "The stage widget").
//!
//! It is glue. What an input means (pan or zoom, which unit a wheel line is, which presses the stage keeps, when a
//! frame is demanded) is decided by `styk_core::stage::Surface`; this file turns toolkit events into
//! [`Event`]s that travel as `Command::Stage` through `Core::dispatch`, and brings the surface's two render-path
//! entry points into the toolkit's frame: `prepare` (after the previous frame's encoder was submitted) and
//! `present` (recording into the widget's pass). Neither waits: the surface is read with `try_lock` and the picture
//! is whatever the paint worker last completed.

use iced::advanced::mouse;
use iced::keyboard::{self, key::Named};
use iced::widget::shader::{self, Action, Shader, Viewport};
use bytemuck::{Pod, Zeroable};
use iced::{Element, Event as Toolkit, Length, Point, Rectangle, Widget as _, touch, wgpu, window};
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use styk_core::services::input::{InputEvent, InputQueue, Modifiers};
use styk_core::stage::input::{Button, Pointer, PointerPhase};
use styk_core::stage::{Cursor, Event, Gpu, Place, Surface, Wheel, WheelDelta};
use crate::Message;
use iced::widget::container;
use styk_core::app::Core;
use styk_core::commands::Command;
use styk_design::Theme;

/// A checker cell, in logical pixels (the 16 px tile of today's gradient is four 8 px quadrants).
const CHECKER: f32 = 8.0;

/// The mouse as a pointer. Fingers count up from one, so a finger never takes the mouse's identity.
const MOUSE: u32 = 0;

/// The stage widget for `surface`. `queue` is the platform's input queue, when a pen source feeds one; `send` wraps an
/// [`Event`] as the application's message (`Message::Command(Command::Stage(event))`).
pub fn stage<'a, Message: 'a>(surface: Arc<Surface>, queue: Option<InputQueue>, theme: Theme, send: impl Fn(Event) -> Message + 'a) -> Element<'a, Message> {
    Shader::new(Program { surface, queue, theme, send: Box::new(send) }).width(Length::Fill).height(Length::Fill).boxed()
}

struct Program<'a, Message> {
    surface: Arc<Surface>,
    queue: Option<InputQueue>,
    theme: Theme,
    send: Box<dyn Fn(Event) -> Message + 'a>,
}

/// What the widget remembers between events: the held modifiers and the captured pointer. Nothing of the stage's.
#[derive(Default)]
pub struct State {
    modifiers: iced::keyboard::Modifiers,
    space: bool,
    /// The mouse button held since a press over the stage, and where the pointer last was.
    button: Option<Button>,
    last: [f64; 2],
    finger: Option<u64>,
    scratch: Vec<InputEvent>,
}

fn modifiers(held: iced::keyboard::Modifiers) -> Modifiers {
    let mut set = Modifiers::NONE;
    for (flag, on) in [(Modifiers::SHIFT, held.shift()), (Modifiers::CTRL, held.control()), (Modifiers::ALT, held.alt()), (Modifiers::META, held.logo())] {
        if on {
            set = set.with(flag);
        }
    }
    set
}

fn button(button: mouse::Button) -> Option<Button> {
    match button {
        mouse::Button::Left => Some(Button::Left),
        mouse::Button::Middle => Some(Button::Middle),
        mouse::Button::Right => Some(Button::Right),
        _ => None,
    }
}

impl<Message> Program<'_, Message> {
    fn pointer(&self, id: u32, phase: PointerPhase, button: Button, point: [f64; 2], held: Modifiers) -> Event {
        Event::Pointer(Pointer { id, phase, point, button, modifiers: held })
    }

    /// The one event an input comes to, if any.
    fn translate(&self, state: &mut State, event: &Toolkit, bounds: Rectangle, cursor: mouse::Cursor) -> Option<(Event, bool)> {
        let local = |point: Point| [f64::from(point.x - bounds.x), f64::from(point.y - bounds.y)];
        match event {
            Toolkit::Keyboard(keyboard::Event::ModifiersChanged(held)) => {
                state.modifiers = *held;
                None
            }
            Toolkit::Keyboard(keyboard::Event::KeyPressed { key: keyboard::Key::Named(Named::Space), repeat: false, modifiers: held, .. }) if cursor.is_over(bounds) => {
                state.modifiers = *held;
                state.space = true;
                Some((Event::Space(true), false))
            }
            Toolkit::Keyboard(keyboard::Event::KeyReleased { key: keyboard::Key::Named(Named::Space), .. }) if state.space => {
                state.space = false;
                Some((Event::Space(false), false))
            }
            Toolkit::Mouse(mouse::Event::CursorMoved { position }) => {
                state.last = local(*position);
                state.button.map(|held| (self.pointer(MOUSE, PointerPhase::Move, held, state.last, modifiers(state.modifiers)), false))
            }
            Toolkit::Mouse(mouse::Event::ButtonPressed(pressed)) => {
                let (pressed, position) = (button(*pressed)?, cursor.position_in(bounds)?);
                if state.button.is_some() {
                    return None;
                }
                state.button = Some(pressed);
                state.last = [f64::from(position.x), f64::from(position.y)];
                Some((self.pointer(MOUSE, PointerPhase::Down, pressed, state.last, modifiers(state.modifiers)), false))
            }
            Toolkit::Mouse(mouse::Event::ButtonReleased(released)) => {
                let held = state.button.filter(|held| Some(*held) == button(*released))?;
                state.button = None;
                Some((self.pointer(MOUSE, PointerPhase::Up, held, state.last, modifiers(state.modifiers)), false))
            }
            Toolkit::Mouse(mouse::Event::WheelScrolled { delta }) => {
                let position = cursor.position_in(bounds)?;
                let delta = match *delta {
                    mouse::ScrollDelta::Lines { x, y } => WheelDelta::Lines([f64::from(x), f64::from(y)]),
                    mouse::ScrollDelta::Pixels { x, y } => WheelDelta::Pixels([f64::from(x), f64::from(y)]),
                };
                let point = [f64::from(position.x), f64::from(position.y)];
                Some((Event::Wheel(Wheel { delta, point, modifiers: modifiers(state.modifiers) }), true))
            }
            Toolkit::Touch(touch::Event::FingerPressed { id, position }) => {
                if state.finger.is_some() || !bounds.contains(*position) {
                    return None;
                }
                state.finger = Some(id.0);
                state.last = local(*position);
                Some((self.pointer(finger(id.0), PointerPhase::Down, Button::Left, state.last, modifiers(state.modifiers)), false))
            }
            Toolkit::Touch(touch::Event::FingerMoved { id, position }) if state.finger == Some(id.0) => {
                state.last = local(*position);
                Some((self.pointer(finger(id.0), PointerPhase::Move, Button::Left, state.last, modifiers(state.modifiers)), false))
            }
            Toolkit::Touch(touch::Event::FingerLifted { id, position }) if state.finger == Some(id.0) => {
                state.finger = None;
                state.last = local(*position);
                Some((self.pointer(finger(id.0), PointerPhase::Up, Button::Left, state.last, modifiers(state.modifiers)), false))
            }
            Toolkit::Touch(touch::Event::FingerLost { id, .. }) if state.finger == Some(id.0) => {
                state.finger = None;
                Some((self.pointer(finger(id.0), PointerPhase::Cancel, Button::Left, state.last, modifiers(state.modifiers)), false))
            }
            // The window lost focus mid-drag: the gesture ends where it stands, as an interrupted pointer does.
            Toolkit::Window(window::Event::Unfocused) => {
                if let Some(held) = state.button.take() {
                    Some((self.pointer(MOUSE, PointerPhase::Cancel, held, state.last, Modifiers::NONE), false))
                } else {
                    state.finger.take().map(|id| (self.pointer(finger(id), PointerPhase::Cancel, Button::Left, state.last, Modifiers::NONE), false))
                }
            }
            _ => None,
        }
    }
}

fn finger(id: u64) -> u32 {
    (id % u64::from(u32::MAX - 1)) as u32 + 1
}

impl<Message> shader::Program<Message> for Program<'_, Message> {
    type State = State;
    type Primitive = Primitive;

    fn update(&self, state: &mut State, event: &Toolkit, bounds: Rectangle, cursor: mouse::Cursor) -> Option<Action<Message>> {
        let translated = self.translate(state, event, bounds, cursor);
        let captured = translated.as_ref().is_some_and(|(_, capture)| *capture);
        let sent = translated.map(|(event, _)| event).or_else(|| {
            // Pen samples wait in the platform's queue; they go with the next event that carries nothing else.
            let queue = self.queue.as_ref()?;
            state.scratch.clear();
            queue.drain(&mut state.scratch);
            (!state.scratch.is_empty()).then(|| Event::Pen(std::mem::take(&mut state.scratch)))
        });
        let sent = sent.or_else(|| (matches!(event, Toolkit::Window(window::Event::RedrawRequested(_))) && self.surface.moving()).then_some(Event::Tick));
        let action = match sent {
            Some(event) => Action::publish((self.send)(event)),
            // A picture on its way, or the view easing: one more frame, from the toolkit's own redraw. The painter's
            // wake and the scheduler's progress are the other signals; this is the one that needs no owner.
            None if self.surface.needs_frames() && matches!(event, Toolkit::Window(window::Event::RedrawRequested(_))) => Action::request_redraw(),
            None => return None,
        };
        Some(if captured { action.and_capture() } else { action })
    }

    fn draw(&self, _state: &State, _cursor: mouse::Cursor, _bounds: Rectangle) -> Primitive {
        Primitive { surface: self.surface.clone(), shadow: shadow(self.theme) }
    }

    fn mouse_interaction(&self, _state: &State, bounds: Rectangle, cursor: mouse::Cursor) -> mouse::Interaction {
        match self.surface.cursor() {
            Cursor::Grabbing => mouse::Interaction::Grabbing,
            Cursor::Grab if cursor.is_over(bounds) => mouse::Interaction::Grab,
            _ => mouse::Interaction::default(),
        }
    }
}

/// The shadow of today's `#artboard` (`--theme-shadow`: `#1b263814` in the light theme, `#00000055` in the dark one).
fn shadow(theme: Theme) -> [f32; 4] {
    match theme {
        Theme::Light => [27.0 / 255.0, 38.0 / 255.0, 56.0 / 255.0, 20.0 / 255.0],
        Theme::Dark => [0.0, 0.0, 0.0, 85.0 / 255.0],
    }
}

/// What one frame draws: the artboard's backing, then the surface's last complete picture.
pub struct Primitive {
    surface: Arc<Surface>,
    shadow: [f32; 4],
}

impl fmt::Debug for Primitive {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Primitive").finish_non_exhaustive()
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Backing {
    rect: [f32; 4],
    shadow: [f32; 4],
    place: [f32; 4],
    edge: [f32; 4],
}

/// The toolkit's graphics context for the stage: a number for it, so a recreated context gets a new painter, and the
/// pipeline that draws the artboard's backing in the widget's pass.
pub struct Pipeline {
    id: u64,
    format: wgpu::TextureFormat,
    backing: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    /// Whether there is an artboard to draw this frame.
    shown: bool,
}

impl shader::Pipeline for Pipeline {
    fn new(device: &wgpu::Device, _queue: &wgpu::Queue, format: wgpu::TextureFormat) -> Pipeline {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk.stage.backing"), source: wgpu::ShaderSource::Wgsl(include_str!("stage/backing.wgsl").into()) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk.stage.backing.layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            }],
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk.stage.backing.uniforms"), size: std::mem::size_of::<Backing>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("styk.stage.backing.bind_group"), layout: &layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }] });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("styk.stage.backing.pipeline_layout"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let backing = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("styk.stage.backing"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: wgpu::PipelineCompilationOptions::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Pipeline { id: NEXT.fetch_add(1, Ordering::Relaxed), format, backing, uniforms, bind_group, shown: false }
    }
}

impl shader::Primitive for Primitive {
    type Pipeline = Pipeline;

    fn prepare(&self, pipeline: &mut Pipeline, device: &wgpu::Device, queue: &wgpu::Queue, bounds: &Rectangle, viewport: &Viewport) {
        let scale = viewport.scale_factor();
        let place = Place { origin: [f64::from(bounds.x), f64::from(bounds.y)], size: [f64::from(bounds.width), f64::from(bounds.height)], dpr: f64::from(scale) };
        self.surface.prepare(place, Gpu { id: pipeline.id, device, queue, format: pipeline.format });
        // The backing sits where the core says the canvas lies, on whole device pixels as the browser snaps a box.
        pipeline.shown = match self.surface.artboard() {
            Some([x, y, w, h]) => {
                let snap = |v: f64| (v * f64::from(scale)).round() as f32;
                let (left, top, right, bottom) = (snap(x), snap(y), snap(x + w), snap(y + h));
                let uniforms = Backing {
                    rect: [left, top, right - left, bottom - top],
                    shadow: self.shadow,
                    place: [bounds.x * scale, bounds.y * scale, CHECKER * scale, if pipeline.format.is_srgb() { 1.0 } else { 0.0 }],
                    edge: [scale, 2.0 * scale, 5.0 * scale, 0.0],
                };
                queue.write_buffer(&pipeline.uniforms, 0, bytemuck::bytes_of(&uniforms));
                true
            }
            None => false,
        };
    }

    fn draw(&self, pipeline: &Pipeline, pass: &mut wgpu::RenderPass<'_>) -> bool {
        if pipeline.shown {
            pass.set_pipeline(&pipeline.backing);
            pass.set_bind_group(0, &pipeline.bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.surface.present(pass);
        true
    }
}

/// The active document's stage on the window field, filling the region it is given, as the message the application
/// carries: every input travels as `Command::Stage` through `Core::dispatch`. `None` while no document has a stage.
pub fn view<'a>(core: &Core, queue: Option<InputQueue>, theme: Theme) -> Option<Element<'a, Message>> {
    let surface = core.stage()?;
    let field = theme.palette().surface_field;
    let widget = stage(surface, queue, theme, |event| Message::Command(Command::Stage(event)));
    Some(container(widget).width(Length::Fill).height(Length::Fill).style(move |_| container::Style::default().background(iced::Color::from(field))).boxed())
}
