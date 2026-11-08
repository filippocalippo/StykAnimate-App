//! Slider (`slider.css`): a 4 px track filled up to the value, a 14 px thumb, and the keys, drag and wheel of a native range.
//!
//! - **Drag.** A press on the track jumps the thumb to the pointer; a press on the thumb grabs it where it was touched. The
//!   drag follows the pointer wherever it goes until release (winit captures the mouse), snapped to the step; the release
//!   commits. The window losing focus, a touch cancel or a lost capture ends it the same way, once.
//! - **Keys** (only while focused, `styk_core::controls::slider_value`): the arrows step (Left and Right mirror in a
//!   right-to-left interface), Shift and Alt scale the step as in number fields, Page keys ten steps, Home and End the ends.
//! - **Wheel.** Native ranges do not take the wheel; a slider asked to (`wheel`: the drawing quick bar) steps by one notch
//!   a click, up raising the value.
//!
//! It reports [`Slide`]: a live value while dragging and a committed one when the gesture ends (`input` and `change`).
//! The role is [`InputRole::Other`], declared here: a focused slider keeps Delete, the arrows and the editing keys from the
//! document.

use iced::Widget as _;
use super::control::{DISABLED, Preview, paint_fill, paint_shadows, words};
use super::dir::Dir;
use super::focus::{Focusable, Keys, Ring, RingVisible};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::advanced::layout::{self, Layout};
use iced::advanced::renderer;
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{Row, Space, container};
use iced::{Alignment, Color, Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, mouse, touch};
use styk_core::controls::{SliderKey, slider_value};
use styk_core::focus::{FocusArea, FocusId, InputRole};
use styk_core::number::StepKeys;

/// The thumb (`::-webkit-slider-thumb`): 14 px.
const THUMB: f32 = 14.0;
/// The track (`::-webkit-slider-runnable-track`): 4 px.
const TRACK: f32 = 4.0;

/// What a slider reports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slide {
    /// The value, on the step grid and inside the range.
    pub value: f64,
    /// The gesture is over (release, a key, a wheel notch): the value is final. A drag sends `false` as it goes.
    pub commit: bool,
}

/// How far a drag may be from a lost mouse capture before it is ended: asked of the system on each move.
type Held = Option<fn() -> bool>;

#[derive(Default)]
struct State {
    /// The pointer's distance from the thumb's centre where it was grabbed, while a drag is under way.
    drag: Option<f32>,
    /// The last value the drag reported.
    last: Option<f64>,
    ring: bool,
}

struct Track<'a, Message> {
    inner: Element<'a, Message>,
    palette: &'static Palette,
    value: f64,
    min: f64,
    max: f64,
    step: f64,
    quiet: bool,
    disabled: bool,
    dir: Dir,
    wheel: Option<f64>,
    held: Held,
    on_slide: std::sync::Arc<dyn Fn(Slide) -> Message + 'a>,
    shown: bool,
    width: Length,
}

impl<Message> Track<'_, Message> {
    /// The thumb's centre for the value.
    fn thumb_x(&self, bounds: Rectangle) -> f32 {
        let span = (self.max - self.min).max(f64::EPSILON);
        let fraction = ((self.value - self.min) / span).clamp(0.0, 1.0) as f32;
        let fraction = if self.dir.is_rtl() { 1.0 - fraction } else { fraction };
        bounds.x + THUMB / 2.0 + fraction * (bounds.width - THUMB).max(0.0)
    }

    /// The value the pointer at `x` asks for, on the step grid.
    fn value_at(&self, bounds: Rectangle, x: f32) -> f64 {
        let travel = (bounds.width - THUMB).max(f32::EPSILON);
        let fraction = f64::from(((x - bounds.x - THUMB / 2.0) / travel).clamp(0.0, 1.0));
        let fraction = if self.dir.is_rtl() { 1.0 - fraction } else { fraction };
        let raw = self.min + fraction * (self.max - self.min);
        let snapped = if self.step > 0.0 { self.min + ((raw - self.min) / self.step).round() * self.step } else { raw };
        ((snapped.clamp(self.min, self.max)) * 1e9).round() / 1e9
    }
}

impl<Message> widget::Meta for Track<'_, Message> {}

impl<'a, Message: Clone + 'a> Widget<Message, Theme, Renderer> for Track<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(self.width, Length::Fixed(scale::CONTROL_SM))
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.inner));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.inner.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &iced::Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.inner.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        // Keys and focus first: the inner target is the keyboard's owner.
        self.inner.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
        let mut visible = ProbeRing(false);
        self.inner.operate(&mut tree.children[0], layout, viewport, renderer, &mut visible);
        let bounds = layout.bounds();
        let state = tree.state.downcast_mut::<State>();
        if state.ring != visible.0 {
            state.ring = visible.0;
            shell.request_redraw();
        }
        if self.disabled {
            state.drag = None;
            return;
        }
        let slide = |value: f64, commit: bool| (self.on_slide)(Slide { value, commit });
        // The capture was lost (another window took the mouse): the button is up and no event says so.
        if matches!(event, Event::Mouse(mouse::Event::CursorMoved { .. }) | Event::Window(iced::window::Event::RedrawRequested(_)))
            && state.drag.is_some()
            && self.held.is_some_and(|held| !held())
        {
            state.drag = None;
            shell.publish(slide(state.last.take().unwrap_or(self.value), true));
            return;
        }
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) | Event::Touch(touch::Event::FingerPressed { .. }) if cursor.is_over(bounds) && !shell.is_event_captured() => {
                let Some(Point { x, .. }) = cursor.position() else { return };
                let centre = self.thumb_x(bounds);
                if (x - centre).abs() <= THUMB / 2.0 {
                    state.drag = Some(x - centre);
                } else {
                    state.drag = Some(0.0);
                    let value = self.value_at(bounds, x);
                    state.last = Some(value);
                    shell.publish(slide(value, false));
                }
                shell.capture_event();
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) | Event::Touch(touch::Event::FingerMoved { position, .. }) => {
                if let Some(grab) = state.drag {
                    let value = self.value_at(bounds, position.x - grab);
                    if state.last != Some(value) {
                        state.last = Some(value);
                        shell.publish(slide(value, false));
                    }
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) | Event::Touch(touch::Event::FingerLifted { .. }) => {
                if state.drag.take().is_some() {
                    shell.publish(slide(state.last.take().unwrap_or(self.value), true));
                    shell.capture_event();
                }
            }
            Event::Window(iced::window::Event::Unfocused) | Event::Touch(touch::Event::FingerLost { .. }) => {
                if state.drag.take().is_some() {
                    shell.publish(slide(state.last.take().unwrap_or(self.value), true));
                }
            }
            Event::Mouse(mouse::Event::WheelScrolled { delta }) if cursor.is_over(bounds) => {
                if let Some(notch) = self.wheel {
                    let y = match delta {
                        mouse::ScrollDelta::Lines { y, .. } | mouse::ScrollDelta::Pixels { y, .. } => *y,
                    };
                    if y != 0.0 {
                        let toward = if y > 0.0 { notch } else { -notch };
                        let value = ((self.value + toward).clamp(self.min, self.max) * 1e9).round() / 1e9;
                        shell.publish(slide(value, true));
                        shell.capture_event();
                    }
                }
            }
            _ => {}
        }
    }

    fn mouse_interaction(&self, _tree: &Tree, _layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        mouse::Interaction::None
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let palette = self.palette;
        let bounds = layout.bounds();
        let opacity = if self.disabled { DISABLED } else { 1.0 };
        let centre_y = bounds.y + bounds.height / 2.0;
        let thumb_x = self.thumb_x(bounds);
        let (fill, rest) = (if self.quiet { palette.line_control } else { palette.slider_fill }, palette.slider_track);
        // The track: the filled part from the start to the thumb, the rest after it.
        let track = Rectangle { x: bounds.x, y: centre_y - TRACK / 2.0, width: bounds.width, height: TRACK };
        paint_fill(renderer, track, TRACK / 2.0, rest.faded(opacity));
        let filled = if self.dir.is_rtl() {
            Rectangle { x: thumb_x, y: track.y, width: (bounds.x + bounds.width - thumb_x).max(0.0), height: TRACK }
        } else {
            Rectangle { x: bounds.x, y: track.y, width: (thumb_x - bounds.x).max(0.0), height: TRACK }
        };
        if filled.width > 0.0 {
            paint_fill(renderer, filled, TRACK / 2.0, fill.faded(opacity));
        }
        let focus = !self.disabled && (tree.state.downcast_ref::<State>().ring || self.shown);
        let thumb = Rectangle { x: thumb_x - THUMB / 2.0, y: centre_y - THUMB / 2.0, width: THUMB, height: THUMB };
        let disc = |renderer: &mut Renderer, grow: f32, color: Rgba| {
            let bounds = Rectangle { x: thumb.x - grow, y: thumb.y - grow, width: THUMB + 2.0 * grow, height: THUMB + 2.0 * grow };
            paint_fill(renderer, bounds, bounds.width / 2.0, color.faded(opacity));
        };
        if focus {
            // `0 0 0 1px line-control, 0 0 0 2px surface, 0 0 0 4px focus-ring`.
            disc(renderer, 4.0, palette.focus_ring);
            disc(renderer, 2.0, palette.surface);
        } else {
            paint_shadows(renderer, thumb, THUMB / 2.0, palette.elevation_1, opacity);
        }
        disc(renderer, 1.0, palette.line_control);
        disc(renderer, 0.0, palette.slider_thumb);
        self.inner.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }
}

/// Reads whether the inner [`Focusable`] shows its ring.
struct ProbeRing(bool);

impl Operation for ProbeRing {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<()>)) {
        operate(self);
    }

    fn custom(&mut self, _id: Option<&widget::Id>, _bounds: Rectangle, state: &mut dyn std::any::Any) {
        if let Some(RingVisible(visible)) = state.downcast_ref::<RingVisible>() {
            self.0 |= *visible;
        }
    }
}

/// A slider.
pub struct Slider<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    value: f64,
    range: (f64, f64),
    step: f64,
    quiet: bool,
    disabled: bool,
    dir: Dir,
    width: Length,
    wheel: Option<f64>,
    held: Held,
    on_slide: Box<dyn Fn(Slide) -> Message + 'a>,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> Slider<'a, Message> {
    /// A slider of `value` in `range` moving in steps of `step`, the focus target `id` in `area`.
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, value: f64, range: (f64, f64), step: f64, on_slide: impl Fn(Slide) -> Message + 'a) -> Self {
        Slider { id, area, palette, value, range, step, quiet: false, disabled: false, dir: Dir::Ltr, width: Length::Fill, wheel: None, held: None, on_slide: Box::new(on_slide), preview: None }
    }

    /// `data-quiet`: a neutral fill (a view slider: the timeline zoom).
    pub fn quiet(mut self, quiet: bool) -> Self {
        self.quiet = quiet;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn dir(mut self, dir: Dir) -> Self {
        self.dir = dir;
        self
    }

    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    /// The wheel steps the value by `notch` per click (up raises it). Off by default, as a native range's is.
    pub fn wheel(mut self, notch: f64) -> Self {
        self.wheel = Some(notch);
        self
    }

    /// How a drag asks the system whether the primary button is still down (a lost capture ends it).
    pub fn held(mut self, held: Held) -> Self {
        self.held = held;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Slider { id, area, palette, value, range: (min, max), step, quiet, disabled, dir, width, wheel, held, on_slide, preview } = self;
        let on_slide: std::sync::Arc<dyn Fn(Slide) -> Message + 'a> = std::sync::Arc::from(on_slide);
        let key_value = on_slide.clone();
        let keys = Keys::Custom(Box::new(move |event| match event {
            keyboard::Event::KeyPressed { key, modifiers, .. } if !modifiers.control() && !modifiers.logo() => {
                let keys = StepKeys { shift: modifiers.shift(), alt: modifiers.alt() };
                let rtl = dir.is_rtl();
                let slider_key = match key.as_ref() {
                    Key::Named(Named::ArrowRight) => if rtl { SliderKey::Decrease } else { SliderKey::Increase },
                    Key::Named(Named::ArrowLeft) => if rtl { SliderKey::Increase } else { SliderKey::Decrease },
                    Key::Named(Named::ArrowUp) => SliderKey::Increase,
                    Key::Named(Named::ArrowDown) => SliderKey::Decrease,
                    Key::Named(Named::PageUp) => SliderKey::PageUp,
                    Key::Named(Named::PageDown) => SliderKey::PageDown,
                    Key::Named(Named::Home) => SliderKey::Home,
                    Key::Named(Named::End) => SliderKey::End,
                    _ => return None,
                };
                Some(key_value(Slide { value: slider_value(value, min, max, step, slider_key, keys), commit: true }))
            }
            _ => None,
        }));
        // The thumb draws the focus ring itself (`:focus-visible { outline: none }`), so the target's own ring is empty.
        let no_ring = Ring { color: Color::TRANSPARENT, width: 0.0, offset: 0.0, radius: 0.0 };
        let target = Focusable::new(id, area, Space::new().width(width).height(scale::CONTROL_SM).boxed(), no_ring)
            .input_role(InputRole::Other)
            .keys(keys)
            .enabled(!disabled);
        let track = Track { inner: target.boxed(), palette, value, min, max, step, quiet, disabled, dir, wheel, held, on_slide, shown: preview == Some(Preview::Focus), width };
        track.boxed()
    }

    /// The slider in a row (`.ui-slider-row`): a label of at least 56 px, the track, a 44 px value read-out on the right.
    pub fn row(self, label: String, readout: String) -> Element<'a, Message> {
        let palette = self.palette;
        let disabled = self.disabled;
        let ink = |color: Rgba| if disabled { color.faded(DISABLED) } else { color };
        let line = Row::with_children([
            container(words(label, TextStyle::from_role(&scale::TYPE_SMALL), ink(palette.text_2))).width(Length::Shrink).boxed(),
            self.into_element(),
            container(words(readout, TextStyle::from_role(&scale::TYPE_VALUE).tabular(), ink(palette.text_1))).width(Length::Fixed(44.0)).align_right(Length::Fixed(44.0)).boxed(),
        ])
        .spacing(scale::SPACE_2_5)
        .align_y(Alignment::Center);
        container(line).height(Length::Fixed(scale::CONTROL_MD)).center_y(Length::Fixed(scale::CONTROL_MD)).boxed()
    }
}

