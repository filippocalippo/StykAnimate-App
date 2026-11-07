//! The ink pad: a drawing surface on the real pen path (`docs/native/input.md`).
//!
//! Input events from the platform source are read from the [`InputQueue`] in the widget's `update`, turned into stroke
//! commands by [`StrokeInput`] and sent to the drawing worker, which never runs on this thread. The widget's primitive
//! brings the worker's tiles to the GPU and draws the wet ink in the toolkit's own render pass. Mouse events from the
//! toolkit never start a stroke: every stroke comes from the queue, whose samples say what produced them.

mod core;
mod gpu;

pub use self::core::{BrushConfig, FrameRow, GpuStats, Inspector, Live, PadCore, SampleRow, Switches, View};

use iced::advanced::mouse;
use iced::keyboard::{self, key::Named};
use iced::widget::shader::{self, Action, Shader};
use iced::{Element, Event, Length, Rectangle, Widget};
use std::sync::Arc;
use styk_core::drawing::mapping::Mapping;
use styk_core::drawing::stroke_input::{Action as PenAction, Context, FingerDraw, InputError, StrokeCommand, StrokeInput, ToolMode};
use styk_services::input::{InputEvent, Phase, SampleFlags, Tool};

/// Samples the prediction looks at.
const PREDICTION_WINDOW: usize = 8;
/// How far ahead the prediction reaches, in sample periods and at most in nanoseconds.
const PREDICTION_PERIODS: f64 = 1.5;
const PREDICTION_MAX_NS: f64 = 8_000_000.0;
/// The farthest the predicted point may be from the newest sample, in cel pixels.
const PREDICTION_MAX_PIXELS: f64 = 24.0;

/// The pad as a widget.
pub fn ink_pad<'a, Message: 'a>(core: Arc<PadCore>) -> Element<'a, Message> {
    Shader::new(Pad { core }).width(Length::Fill).height(Length::Fill).boxed()
}

struct Pad {
    core: Arc<PadCore>,
}

#[derive(Default)]
pub struct PadState {
    input: StrokeInput,
    mapping: Mapping,
    brush_json: Option<Arc<str>>,
    last_time: Option<u64>,
    recent: Vec<(f64, f64, u64)>,
    /// The stroke in progress, and whether it may be previewed.
    stroke_id: u64,
    eligible: bool,
    commands: Vec<StrokeCommand>,
    events: Vec<InputEvent>,
}

impl Pad {
    /// Window pixels to cel pixels for a stroke that begins now: the pad's own origin and view.
    fn mapping(&self, bounds: Rectangle) -> Mapping {
        let view = self.core.view();
        let scale = self.core.scale() as f64;
        let (ox, oy) = (bounds.x as f64 * scale, bounds.y as f64 * scale);
        let k = 1.0 / view.zoom;
        let z = view.zoom;
        let mirror_x = self.core.switches().mirror_x.then(|| view.pan.0 + bounds.width as f64 * scale * k / 2.0);
        Mapping { window_origin: (ox, oy), camera: [z, 0.0, 0.0, z, -view.pan.0 * z, -view.pan.1 * z], mirror_x, ..Mapping::default() }
    }

    fn note(&self, inspector: &mut Inspector, state: &mut PadState, event: &InputEvent, received_ns: u64) {
        match event {
            InputEvent::Sample(sample) => {
                inspector.samples += 1;
                match sample.phase {
                    Phase::Hover => inspector.hover_samples += 1,
                    _ => inspector.contact_samples += 1,
                }
                if sample.flags.contains(SampleFlags::HISTORY) {
                    inspector.history_samples += 1;
                }
                match sample.tool {
                    Tool::Touch => inspector.touch_samples += 1,
                    Tool::Mouse => {
                        inspector.mouse_samples += 1;
                        if sample.phase != Phase::Hover {
                            inspector.mouse_contact_samples += 1;
                        }
                    }
                    _ => {}
                }
                match state.last_time {
                    Some(last) if sample.time_ns > last => inspector.push_gap(sample.time_ns - last),
                    Some(last) if sample.time_ns == last => inspector.duplicates += 1,
                    _ => {}
                }
                state.last_time = Some(sample.time_ns);
                inspector.last = Some(*sample);
                self.core.record_sample(SampleRow { sample: *sample, received_ns });
            }
            InputEvent::Interrupted { .. } => inspector.interrupts += 1,
            InputEvent::Overflowed { .. } => inspector.overflows += 1,
        }
    }

    /// The preview's pointer position and the predicted point after a sample, in cel pixels.
    fn follow(&self, state: &mut PadState, x: f64, y: f64, time_ns: u64, show: bool) {
        state.recent.push((x, y, time_ns));
        if state.recent.len() > PREDICTION_WINDOW {
            state.recent.remove(0);
        }
        let switches = self.core.switches();
        let predicted = (switches.prediction && state.recent.len() >= 2).then(|| {
            let (newest, first) = (state.recent[state.recent.len() - 1], state.recent[0]);
            let span = (newest.2.saturating_sub(first.2)) as f64;
            let period = span / (state.recent.len() - 1) as f64;
            if period <= 0.0 {
                return None;
            }
            let horizon = (PREDICTION_PERIODS * period).min(PREDICTION_MAX_NS);
            let (vx, vy) = ((newest.0 - first.0) / span, (newest.1 - first.1) / span);
            let (mut dx, mut dy) = (vx * horizon, vy * horizon);
            let length = (dx * dx + dy * dy).sqrt();
            if length > PREDICTION_MAX_PIXELS {
                dx *= PREDICTION_MAX_PIXELS / length;
                dy *= PREDICTION_MAX_PIXELS / length;
            }
            Some(((newest.0 + dx) as f32, (newest.1 + dy) as f32))
        });
        self.core.with_live(|live| {
            live.raw = Some((x as f32, y as f32, time_ns));
            live.predicted = predicted.flatten();
            live.show = show;
            live.stroke = state.stroke_id;
            live.eligible = state.eligible;
        });
    }

    fn clear_live(&self, state: &mut PadState) {
        state.recent.clear();
        self.core.with_live(|live| *live = Live::default());
    }
}

impl<Message> shader::Program<Message> for Pad {
    type State = PadState;
    type Primitive = gpu::InkPrimitive;

    fn update(&self, state: &mut PadState, event: &Event, bounds: Rectangle, _cursor: mouse::Cursor) -> Option<Action<Message>> {
        let started = self.core.now_ns();
        let mut commands = std::mem::take(&mut state.commands);
        commands.clear();
        if let Event::Keyboard(keyboard::Event::KeyPressed { key: keyboard::Key::Named(Named::Escape), .. }) = event {
            self.core.request_discard();
        }
        if self.core.take_discard() {
            state.input.discard(&mut commands);
        }
        let mut events = std::mem::take(&mut state.events);
        events.clear();
        self.core.queue.drain(&mut events);
        let brush = self.core.brush();
        let json = state.brush_json.get_or_insert_with(|| brush.to_json()).clone();
        let switches = self.core.switches();
        let mapping_now = self.mapping(bounds);
        let scale = self.core.scale() as f64;
        self.core.with_inspector(|inspector| {
            for input in &events {
                self.note(inspector, state, input, started);
                let context = Context {
                    tool: if switches.erase_tool { ToolMode::Eraser } else { ToolMode::Brush },
                    space_held: false,
                    playing: false,
                    finger: if switches.finger_draws { FingerDraw::Always } else { FingerDraw::Never },
                    mapping: &mapping_now,
                    continue_from: state.input.last_end(),
                    region: Some((mapping_now.window_origin.0, mapping_now.window_origin.1, mapping_now.window_origin.0 + bounds.width as f64 * scale, mapping_now.window_origin.1 + bounds.height as f64 * scale)),
                };
                let before = commands.len();
                state.input.feed(input, &context, &mut commands);
                if state.input.take_error() == Some(InputError::QueueLimit) {
                    inspector.limit_errors += 1;
                }
                for command in &commands[before..] {
                    match command {
                        StrokeCommand::Begin { id, erase, mapping, .. } => {
                            inspector.strokes += 1;
                            state.mapping = mapping.clone();
                            state.brush_json = Some(brush.to_json());
                            state.stroke_id = *id;
                            state.eligible = brush.wet_eligible(*erase) && switches.wet_ink;
                            self.core.with_ledger(|ledger| ledger.stroke_started(*id, state.eligible));
                            self.clear_live(state);
                        }
                        StrokeCommand::Sample { x, y, time_ms, .. } => {
                            if let Some((cx, cy)) = state.mapping.cel_point((false, false), (*x, *y)) {
                                let time_ns = (*time_ms * 1e6).round() as u64;
                                self.follow(state, cx, cy, time_ns, brush.stabilization <= 0.0);
                            }
                        }
                        StrokeCommand::End { .. } | StrokeCommand::Cancel { .. } => self.clear_live(state),
                        StrokeCommand::Action(PenAction::OpenPalette { .. }) => inspector.palette_opens += 1,
                        StrokeCommand::Action(PenAction::PickColor { .. }) => inspector.color_picks += 1,
                        StrokeCommand::Action(PenAction::ResizeBegin { .. }) => inspector.resizes += 1,
                        StrokeCommand::Action(_) => {}
                    }
                }
            }
        });
        // The commands reach the worker in order, after the bookkeeping.
        let json = state.brush_json.clone().unwrap_or(json);
        let mut refused_stroke = None;
        for command in commands.drain(..) {
            let id = if let StrokeCommand::Sample { id, .. } = &command { Some(*id) } else { None };
            if !self.core.worker.command(command, &json) {
                refused_stroke = id;
            }
        }
        // The worker is too far behind to take more of this stroke: it ends here and keeps what it has.
        if refused_stroke.is_some() {
            let mut ending = Vec::new();
            state.input.finish(&mut ending);
            for command in ending {
                self.core.worker.command(command, &json);
            }
            self.core.with_inspector(|inspector| inspector.worker_refusals += 1);
        }
        let gpu = self.core.gpu_stats();
        let busy = state.input.active() || self.core.worker.queued() > 0 || gpu.replies_left || gpu.batches_waiting > 0;
        let took = (self.core.now_ns() - started) / 1000;
        self.core.with_inspector(|inspector| {
            inspector.update_last_us = took;
            inspector.update_max_us = inspector.update_max_us.max(took);
        });
        state.commands = commands;
        state.events = events;
        busy.then(Action::request_redraw)
    }

    fn draw(&self, _state: &PadState, _cursor: mouse::Cursor, _bounds: Rectangle) -> gpu::InkPrimitive {
        gpu::InkPrimitive { core: self.core.clone() }
    }

    fn mouse_interaction(&self, _state: &PadState, bounds: Rectangle, cursor: mouse::Cursor) -> mouse::Interaction {
        if cursor.is_over(bounds) { mouse::Interaction::Crosshair } else { mouse::Interaction::default() }
    }
}
