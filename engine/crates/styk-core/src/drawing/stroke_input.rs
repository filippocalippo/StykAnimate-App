//! Today's drawing-input rules (`src/drawing-controller.mjs`, `src/pen-input.mjs`) as a state machine over input events.
//!
//! [`StrokeInput::feed`] takes one [`InputEvent`] and the stage's current context and appends the [`StrokeCommand`]s the
//! drawing worker and the interface act on. It decides nothing about pixels: dabs, pressure curves and smoothing belong
//! to the brush (`styk-drawing`), and positions reach the cel through [`Mapping`], on the worker.

use super::mapping::Mapping;
use styk_services::input::{InputEvent, InterruptReason, Modifiers, PenButtons, PenSample, Phase, Tool, Valid};

/// Samples one stroke may queue (`MAX_STROKE_SAMPLES`): minutes of 240 Hz pen input.
pub const MAX_STROKE_SAMPLES: usize = 65_536;

/// A touch is ignored while a pen is down and for this long after the pen's last event (palm rejection).
pub const PALM_WINDOW_NS: u64 = 700_000_000;

/// Pixels a pen tip may travel and still make a tap (`SLOP.pen`).
pub const PEN_SLOP: f64 = 5.0;
/// Pixels a finger may travel and still make a tap (`SLOP.touch`).
pub const TOUCH_SLOP: f64 = 10.0;

/// Pixels the tilt lean reaches from the pen position.
const LEAN_PIXELS: f64 = 16.0;

/// The pressure a pen at zero reports as: the smallest dab (`event.pressure || .05`).
const PRESSURE_FLOOR: f64 = 0.05;

/// What a pen without pressure reports in contact (what a browser reports for it).
const UNKNOWN_PRESSURE: f64 = 0.5;

/// `dragSlop`: the travel a press may make before a drag begins, by tool; `mouse` is the caller's own value.
pub fn drag_slop(tool: Tool, mouse: f64) -> f64 {
    match tool {
        Tool::Pen | Tool::Eraser => PEN_SLOP,
        Tool::Touch => TOUCH_SLOP,
        Tool::Mouse => mouse,
    }
}

/// `beyondSlop`: whether a drag that began at `start` has left its slop.
pub fn beyond_slop(x: f64, y: f64, start: (f64, f64), slop: f64) -> bool {
    slop == 0.0 || styk_math::hypot(x - start.0, y - start.1) >= slop
}

/// Which tool the stage has selected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolMode {
    Brush,
    Eraser,
    /// The pan tool: presses pan, they never draw.
    Pan,
    /// Any tool that does not take pen strokes through this path.
    Other,
}

/// Whether a finger draws (`Settings > Interface > Draw with a finger`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FingerDraw {
    Never,
    /// Until a pen has been used in this session.
    Auto,
    Always,
}

/// What the stage tells the input about its state, with every event.
#[derive(Clone, Debug)]
pub struct Context<'a> {
    pub tool: ToolMode,
    pub space_held: bool,
    pub playing: bool,
    pub finger: FingerDraw,
    /// How positions reach the cel for a stroke that begins now.
    pub mapping: &'a Mapping,
    /// Where the previous stroke on this cel ended, in window pixels, for a Shift press to continue from.
    pub continue_from: Option<(f64, f64)>,
}

/// A gesture of the drawing tool other than painting.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    /// The barrel button over the canvas: the pop-up palette opens at the pointer.
    OpenPalette { x: f64, y: f64 },
    /// An Alt press (and its drag) samples a colour under the pointer.
    PickColor { x: f64, y: f64 },
    /// A Ctrl or Meta press resizes the brush by dragging.
    ResizeBegin { x: f64, y: f64 },
    ResizeMove { x: f64, y: f64 },
    /// The resize ended; `cancelled` restores the previous size.
    ResizeEnd { cancelled: bool },
}

/// What the input asks of the drawing worker and the interface.
#[derive(Clone, Debug, PartialEq)]
pub enum StrokeCommand {
    Begin {
        id: u64,
        /// The eraser end of the pen, or the eraser tool.
        erase: bool,
        mapping: Mapping,
        modifiers: Modifiers,
    },
    /// One sample, in window pixels; `lean` is the tilt lean point, also in window pixels.
    Sample { id: u64, x: f64, y: f64, pressure: f64, time_ms: f64, lean: Option<(f64, f64)> },
    /// The stroke is over and keeps its ink.
    End { id: u64 },
    /// The stroke is discarded: the cel is restored.
    Cancel { id: u64 },
    Action(Action),
}

/// Why input was refused rather than turned into strokes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    /// A stroke queued more than [`MAX_STROKE_SAMPLES`] samples.
    QueueLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gesture {
    Stroke,
    Pick,
    Resize,
}

#[derive(Clone, Copy, Debug)]
struct Active {
    pointer: u32,
    id: u64,
    gesture: Gesture,
    last_time_ns: Option<u64>,
    samples: usize,
    tool: Tool,
}

/// The state of drawing input.
#[derive(Debug, Default)]
pub struct StrokeInput {
    next_id: u64,
    active: Option<Active>,
    pen_down: Option<u32>,
    last_pen_ns: Option<u64>,
    pen_seen: bool,
    barrel_held: bool,
    limit_hit: bool,
    last_end: Option<(f64, f64)>,
    interrupted: u64,
    damaged: u64,
}

impl StrokeInput {
    pub fn new() -> StrokeInput {
        StrokeInput::default()
    }

    /// Whether a gesture is in progress.
    pub fn active(&self) -> bool {
        self.active.is_some()
    }

    /// The id of the stroke in progress.
    pub fn stroke_id(&self) -> Option<u64> {
        self.active.filter(|a| a.gesture == Gesture::Stroke).map(|a| a.id)
    }

    /// Where the last painted sample was, in window pixels.
    pub fn last_end(&self) -> Option<(f64, f64)> {
        self.last_end
    }

    /// Whether any pen has pressed in this session (`penSeen`).
    pub fn pen_seen(&self) -> bool {
        self.pen_seen
    }

    /// Strokes ended by an interrupt (kept their ink), and by a damaged queue.
    pub fn interrupted_strokes(&self) -> (u64, u64) {
        (self.interrupted, self.damaged)
    }

    /// The error the last input raised, once.
    pub fn take_error(&mut self) -> Option<InputError> {
        std::mem::take(&mut self.limit_hit).then_some(InputError::QueueLimit)
    }

    /// Escape: discards the gesture in progress.
    pub fn discard(&mut self, out: &mut Vec<StrokeCommand>) {
        if let Some(active) = self.active.take() {
            match active.gesture {
                Gesture::Stroke => out.push(StrokeCommand::Cancel { id: active.id }),
                Gesture::Resize => out.push(StrokeCommand::Action(Action::ResizeEnd { cancelled: true })),
                Gesture::Pick => {}
            }
        }
    }

    fn end(&mut self, out: &mut Vec<StrokeCommand>) {
        if let Some(active) = self.active.take() {
            match active.gesture {
                Gesture::Stroke => out.push(StrokeCommand::End { id: active.id }),
                Gesture::Resize => out.push(StrokeCommand::Action(Action::ResizeEnd { cancelled: false })),
                Gesture::Pick => {}
            }
        }
    }

    /// Takes one event.
    pub fn feed(&mut self, event: &InputEvent, context: &Context, out: &mut Vec<StrokeCommand>) {
        match event {
            InputEvent::Sample(sample) => self.sample(sample, context, out),
            InputEvent::Interrupted { pointer, reason, .. } => {
                if self.pen_down == Some(*pointer) {
                    self.pen_down = None;
                }
                if self.active.is_some_and(|a| a.pointer == *pointer) {
                    self.interrupted += 1;
                    self.end(out);
                }
                if *reason == InterruptReason::FocusLost {
                    self.barrel_held = false;
                }
            }
            InputEvent::Overflowed { .. } => {
                if self.active.is_some() {
                    self.damaged += 1;
                    self.end(out);
                }
            }
        }
    }

    fn sample(&mut self, sample: &PenSample, context: &Context, out: &mut Vec<StrokeCommand>) {
        let pen = matches!(sample.tool, Tool::Pen | Tool::Eraser);
        if pen {
            self.last_pen_ns = Some(sample.time_ns);
            match sample.phase {
                Phase::Down => {
                    self.pen_down = Some(sample.pointer);
                    self.pen_seen = true;
                }
                Phase::Up if self.pen_down == Some(sample.pointer) => self.pen_down = None,
                _ => {}
            }
        }
        if sample.tool == Tool::Touch && self.palm(sample) {
            return;
        }
        match sample.phase {
            Phase::Hover => self.hover(sample, context, out),
            Phase::Down => self.press(sample, context, out),
            Phase::Move => self.contact(sample, context, out),
            Phase::Up => {
                if self.active.is_some_and(|a| a.pointer == sample.pointer) {
                    self.end(out);
                }
                self.barrel_held = sample.buttons.contains(PenButtons::BARREL);
            }
        }
    }

    /// A touch is ignored while a pen is down or was used within the palm window.
    fn palm(&self, touch: &PenSample) -> bool {
        self.pen_down.is_some() || self.last_pen_ns.is_some_and(|pen| touch.time_ns.saturating_sub(pen) < PALM_WINDOW_NS && touch.time_ns >= pen)
    }

    fn paints(context: &Context) -> bool {
        matches!(context.tool, ToolMode::Brush | ToolMode::Eraser)
    }

    fn hover(&mut self, sample: &PenSample, context: &Context, out: &mut Vec<StrokeCommand>) {
        let barrel = sample.buttons.contains(PenButtons::BARREL);
        if barrel && !self.barrel_held && self.active.is_none() && Self::paints(context) && !context.playing {
            out.push(StrokeCommand::Action(Action::OpenPalette { x: sample.x, y: sample.y }));
        }
        self.barrel_held = barrel;
    }

    fn press(&mut self, sample: &PenSample, context: &Context, out: &mut Vec<StrokeCommand>) {
        // A pointer arriving while another gesture is open is ignored, as is any press while playing, over the pan tool or
        // with Space held; a finger that does not draw belongs to the stage's navigation.
        if self.active.is_some() || context.playing || context.space_held || context.tool == ToolMode::Pan {
            return;
        }
        if sample.tool == Tool::Touch {
            let draws = match context.finger {
                FingerDraw::Always => true,
                FingerDraw::Auto => !self.pen_seen,
                FingerDraw::Never => false,
            };
            if !draws {
                return;
            }
        }
        self.barrel_held = sample.buttons.contains(PenButtons::BARREL);
        let modifiers = sample.modifiers;
        let id = self.next_id + 1;
        let start = |gesture| Active { pointer: sample.pointer, id, gesture, last_time_ns: None, samples: 0, tool: sample.tool };
        if modifiers.contains(Modifiers::ALT) && context.tool == ToolMode::Brush {
            self.next_id = id;
            self.active = Some(start(Gesture::Pick));
            out.push(StrokeCommand::Action(Action::PickColor { x: sample.x, y: sample.y }));
            return;
        }
        if (modifiers.contains(Modifiers::CTRL) || modifiers.contains(Modifiers::META)) && Self::paints(context) {
            self.next_id = id;
            self.active = Some(start(Gesture::Resize));
            out.push(StrokeCommand::Action(Action::ResizeBegin { x: sample.x, y: sample.y }));
            return;
        }
        if !Self::paints(context) {
            return;
        }
        self.next_id = id;
        self.limit_hit = false;
        let erase = context.tool == ToolMode::Eraser || sample.tool == Tool::Eraser;
        self.active = Some(start(Gesture::Stroke));
        out.push(StrokeCommand::Begin { id, erase, mapping: context.mapping.clone(), modifiers });
        // Shift continues from where the previous stroke ended, in a straight line.
        if modifiers.contains(Modifiers::SHIFT) {
            if let Some((x, y)) = context.continue_from {
                out.push(StrokeCommand::Sample { id, x, y, pressure: pressure_of(sample), time_ms: sample.time_ns as f64 / 1e6, lean: None });
            }
        }
        self.paint_sample(sample, out);
    }

    fn contact(&mut self, sample: &PenSample, _context: &Context, out: &mut Vec<StrokeCommand>) {
        let Some(active) = self.active else { return };
        if active.pointer != sample.pointer {
            return;
        }
        match active.gesture {
            Gesture::Stroke => self.paint_sample(sample, out),
            Gesture::Pick => out.push(StrokeCommand::Action(Action::PickColor { x: sample.x, y: sample.y })),
            Gesture::Resize => out.push(StrokeCommand::Action(Action::ResizeMove { x: sample.x, y: sample.y })),
        }
        self.barrel_held = sample.buttons.contains(PenButtons::BARREL);
    }

    /// One painted sample: the timestamp drops repeats (raw and regular reports of one sample), the queue bound refuses
    /// the sample past it.
    fn paint_sample(&mut self, sample: &PenSample, out: &mut Vec<StrokeCommand>) {
        let Some(active) = self.active.as_mut() else { return };
        if active.last_time_ns.is_some_and(|last| sample.time_ns <= last) {
            return;
        }
        active.last_time_ns = Some(sample.time_ns);
        if active.samples >= MAX_STROKE_SAMPLES {
            self.limit_hit = true;
            return;
        }
        active.samples += 1;
        let pen = matches!(active.tool, Tool::Pen | Tool::Eraser);
        // Pen tilt is a screen-space lean: sin(tilt) * 16 px from the pen, mapped by the worker like the position.
        let lean = (pen && (sample.tilt_x != 0.0 || sample.tilt_y != 0.0)).then(|| {
            let rad = |degrees: f32| degrees as f64 * std::f64::consts::PI / 180.0;
            (sample.x + styk_math::sin(rad(sample.tilt_x)) * LEAN_PIXELS, sample.y + styk_math::sin(rad(sample.tilt_y)) * LEAN_PIXELS)
        });
        self.last_end = Some((sample.x, sample.y));
        out.push(StrokeCommand::Sample { id: active.id, x: sample.x, y: sample.y, pressure: pressure_of(sample), time_ms: sample.time_ns as f64 / 1e6, lean });
    }
}

/// `pen ? (pressure || .05) : 1`.
fn pressure_of(sample: &PenSample) -> f64 {
    if !matches!(sample.tool, Tool::Pen | Tool::Eraser) {
        return 1.0;
    }
    let pressure = if sample.valid.contains(Valid::PRESSURE) { sample.pressure as f64 } else { UNKNOWN_PRESSURE };
    if pressure == 0.0 { PRESSURE_FLOOR } else { pressure }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_services::input::{InputQueue, Script, ScriptSpec};

    fn context(mapping: &Mapping) -> Context<'_> {
        Context { tool: ToolMode::Brush, space_held: false, playing: false, finger: FingerDraw::Never, mapping, continue_from: None }
    }

    fn sample(time_ms: u64, phase: Phase) -> PenSample {
        let mut s = PenSample::at(time_ms * 1_000_000, 1, Tool::Pen, 100.0 + time_ms as f64, 50.0);
        s.phase = phase;
        s.valid = Valid::PRESSURE | Valid::TILT;
        s.pressure = 0.5;
        if phase != Phase::Hover {
            s.buttons = PenButtons::TIP;
        }
        s
    }

    fn run(input: &mut StrokeInput, ctx: &Context, events: &[PenSample]) -> Vec<StrokeCommand> {
        let mut out = Vec::new();
        for s in events {
            input.feed(&InputEvent::Sample(*s), ctx, &mut out);
        }
        out
    }

    fn samples(commands: &[StrokeCommand]) -> Vec<(f64, f64, f64)> {
        commands.iter().filter_map(|c| if let StrokeCommand::Sample { x, pressure, time_ms, .. } = c { Some((*x, *pressure, *time_ms)) } else { None }).collect()
    }

    #[test]
    fn a_stroke_is_begin_samples_end_and_the_lift_adds_no_sample() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let out = run(&mut input, &context(&mapping), &[sample(1, Phase::Hover), sample(2, Phase::Down), sample(3, Phase::Move), sample(4, Phase::Move), sample(5, Phase::Up)]);
        assert!(matches!(out[0], StrokeCommand::Begin { id: 1, erase: false, .. }));
        assert_eq!(samples(&out).len(), 3, "the press and two moves; the lift is only End");
        assert_eq!(out.last(), Some(&StrokeCommand::End { id: 1 }));
        assert!(!input.active());
    }

    #[test]
    fn a_repeated_timestamp_is_skipped_once_and_an_older_one_too() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let out = run(&mut input, &context(&mapping), &[sample(2, Phase::Down), sample(3, Phase::Move), sample(3, Phase::Move), sample(2, Phase::Move), sample(4, Phase::Move)]);
        let times: Vec<f64> = samples(&out).iter().map(|s| s.2).collect();
        assert_eq!(times, [2.0, 3.0, 4.0]);
    }

    #[test]
    fn a_pen_at_zero_pressure_floors_to_five_hundredths_and_a_mouse_is_one() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut zero = sample(2, Phase::Down);
        zero.pressure = 0.0;
        let mut full = sample(3, Phase::Move);
        full.pressure = 1.0;
        let out = run(&mut input, &context(&mapping), &[zero, full, sample(4, Phase::Up)]);
        assert_eq!(samples(&out).iter().map(|s| s.1).collect::<Vec<_>>(), [0.05, 1.0]);
        let mut mouse = sample(5, Phase::Down);
        mouse.tool = Tool::Mouse;
        mouse.pressure = 0.2;
        let out = run(&mut input, &context(&mapping), &[mouse]);
        assert_eq!(samples(&out)[0].1, 1.0);
    }

    #[test]
    fn a_pen_that_reports_no_pressure_is_half_pressure_in_contact() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut down = sample(2, Phase::Down);
        down.valid = Valid::NONE;
        down.pressure = 0.0;
        assert_eq!(samples(&run(&mut input, &context(&mapping), &[down]))[0].1, 0.5);
    }

    #[test]
    fn tilt_leans_sixteen_pixels_of_its_sine_and_an_upright_pen_has_no_lean() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut tilted = sample(2, Phase::Down);
        tilted.tilt_x = 30.0;
        tilted.tilt_y = -90.0;
        let upright = sample(3, Phase::Move);
        let out = run(&mut input, &context(&mapping), &[tilted, upright]);
        let leans: Vec<Option<(f64, f64)>> = out.iter().filter_map(|c| if let StrokeCommand::Sample { lean, .. } = c { Some(*lean) } else { None }).collect();
        let (lx, ly) = leans[0].unwrap();
        assert!((lx - (102.0 + 8.0)).abs() < 1e-9, "{lx}");
        assert!((ly - (50.0 - 16.0)).abs() < 1e-9, "{ly}");
        assert_eq!(leans[1], None);
    }

    #[test]
    fn the_eraser_end_and_the_eraser_tool_erase() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut end = sample(2, Phase::Down);
        end.tool = Tool::Eraser;
        let out = run(&mut input, &context(&mapping), &[end, sample(3, Phase::Up)]);
        assert!(matches!(out[0], StrokeCommand::Begin { erase: true, .. }));
        let mut eraser = context(&mapping);
        eraser.tool = ToolMode::Eraser;
        let out = run(&mut input, &eraser, &[sample(4, Phase::Down)]);
        assert!(matches!(out[0], StrokeCommand::Begin { erase: true, .. }));
    }

    #[test]
    fn a_barrel_press_over_the_canvas_opens_the_palette_instead_of_drawing_and_only_once() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut a = sample(2, Phase::Hover);
        a.buttons = PenButtons::BARREL;
        let mut b = sample(3, Phase::Hover);
        b.buttons = PenButtons::BARREL;
        let out = run(&mut input, &context(&mapping), &[sample(1, Phase::Hover), a, b, sample(4, Phase::Hover), a]);
        let actions: Vec<&StrokeCommand> = out.iter().filter(|c| matches!(c, StrokeCommand::Action(Action::OpenPalette { .. }))).collect();
        assert_eq!(actions.len(), 2, "one per press: held samples do not repeat it");
        assert!(!out.iter().any(|c| matches!(c, StrokeCommand::Begin { .. })));
        // The pan tool and playback leave the barrel alone.
        let mut panning = context(&mapping);
        panning.tool = ToolMode::Pan;
        let mut quiet = StrokeInput::new();
        assert!(run(&mut quiet, &panning, &[sample(1, Phase::Hover), a]).is_empty());
    }

    #[test]
    fn a_barrel_held_through_the_press_still_draws() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut down = sample(2, Phase::Down);
        down.buttons = PenButtons::TIP | PenButtons::BARREL;
        let out = run(&mut input, &context(&mapping), &[down]);
        assert!(matches!(out[0], StrokeCommand::Begin { .. }));
    }

    #[test]
    fn a_touch_is_ignored_while_the_pen_is_down_and_for_700_ms_after() {
        let mapping = Mapping::default();
        let mut ctx = context(&mapping);
        ctx.finger = FingerDraw::Always;
        let mut input = StrokeInput::new();
        let touch = |ms: u64| {
            let mut t = sample(ms, Phase::Down);
            t.tool = Tool::Touch;
            t.pointer = 9;
            t
        };
        // While the pen is down.
        let out = run(&mut input, &ctx, &[sample(10, Phase::Down), touch(12)]);
        assert_eq!(out.iter().filter(|c| matches!(c, StrokeCommand::Begin { .. })).count(), 1);
        input.discard(&mut Vec::new());
        // Within 700 ms of the lift.
        let mut lift = sample(100, Phase::Up);
        lift.pointer = 1;
        assert!(run(&mut input, &ctx, &[lift, touch(799)]).is_empty());
        // After it.
        let out = run(&mut input, &ctx, &[touch(801)]);
        assert!(matches!(out[0], StrokeCommand::Begin { .. }));
    }

    #[test]
    fn a_finger_draws_by_the_setting_and_never_after_a_pen_in_automatic() {
        let mapping = Mapping::default();
        let mut finger = sample(5000, Phase::Down);
        finger.tool = Tool::Touch;
        finger.pointer = 9;
        let mut never = context(&mapping);
        never.finger = FingerDraw::Never;
        assert!(run(&mut StrokeInput::new(), &never, &[finger]).is_empty());
        let mut auto = context(&mapping);
        auto.finger = FingerDraw::Auto;
        assert!(!run(&mut StrokeInput::new(), &auto, &[finger]).is_empty());
        let mut input = StrokeInput::new();
        run(&mut input, &auto, &[sample(1, Phase::Down), sample(2, Phase::Up)]);
        assert!(input.pen_seen());
        assert!(run(&mut input, &auto, &[finger]).is_empty(), "a pen has been used");
    }

    #[test]
    fn modifiers_at_the_press_choose_the_gesture_even_if_released_before_the_drain() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut alt = sample(2, Phase::Down);
        alt.modifiers = Modifiers::ALT;
        let out = run(&mut input, &context(&mapping), &[alt, sample(3, Phase::Move), sample(4, Phase::Up)]);
        assert!(matches!(out[0], StrokeCommand::Action(Action::PickColor { .. })));
        assert!(matches!(out[1], StrokeCommand::Action(Action::PickColor { .. })), "dragging keeps picking");
        assert!(!out.iter().any(|c| matches!(c, StrokeCommand::Begin { .. })));
        let mut ctrl = sample(5, Phase::Down);
        ctrl.modifiers = Modifiers::CTRL;
        let out = run(&mut input, &context(&mapping), &[ctrl, sample(6, Phase::Move), sample(7, Phase::Up)]);
        assert!(matches!(out[0], StrokeCommand::Action(Action::ResizeBegin { .. })));
        assert!(matches!(out[1], StrokeCommand::Action(Action::ResizeMove { .. })));
        assert_eq!(out[2], StrokeCommand::Action(Action::ResizeEnd { cancelled: false }));
    }

    #[test]
    fn shift_continues_from_the_previous_end_with_the_presss_pressure() {
        let mapping = Mapping::default();
        let mut ctx = context(&mapping);
        ctx.continue_from = Some((7.0, 8.0));
        let mut down = sample(2, Phase::Down);
        down.modifiers = Modifiers::SHIFT;
        let out = run(&mut StrokeInput::new(), &ctx, &[down]);
        let s = samples(&out);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], (7.0, 0.5, 2.0));
        assert_eq!(s[1].0, 102.0);
    }

    #[test]
    fn a_stroke_that_is_interrupted_keeps_its_ink_and_escape_discards_it() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut out = Vec::new();
        run(&mut input, &context(&mapping), &[sample(2, Phase::Down), sample(3, Phase::Move)]);
        input.feed(&InputEvent::Interrupted { pointer: 1, time_ns: 4, reason: InterruptReason::CaptureLost }, &context(&mapping), &mut out);
        assert_eq!(out, [StrokeCommand::End { id: 1 }]);
        assert!(!input.active());
        // The next press starts clean, and the pen is no longer counted as down.
        let out = run(&mut input, &context(&mapping), &[sample(1000, Phase::Down)]);
        assert!(matches!(out[0], StrokeCommand::Begin { id: 2, .. }));
        let mut out = Vec::new();
        input.discard(&mut out);
        assert_eq!(out, [StrokeCommand::Cancel { id: 2 }]);
        assert!(!input.active());
        input.discard(&mut out);
        assert_eq!(out.len(), 1, "nothing left to discard");
    }

    #[test]
    fn a_lost_pointer_that_is_not_the_stroke_pointer_changes_nothing() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        run(&mut input, &context(&mapping), &[sample(2, Phase::Down)]);
        let mut out = Vec::new();
        input.feed(&InputEvent::Interrupted { pointer: 77, time_ns: 4, reason: InterruptReason::Canceled }, &context(&mapping), &mut out);
        assert!(out.is_empty() && input.active());
    }

    #[test]
    fn an_overflow_notice_ends_the_stroke_and_the_next_press_is_clean() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        run(&mut input, &context(&mapping), &[sample(2, Phase::Down)]);
        let mut out = Vec::new();
        input.feed(&InputEvent::Overflowed { dropped: 12 }, &context(&mapping), &mut out);
        assert_eq!(out, [StrokeCommand::End { id: 1 }]);
        assert_eq!(input.interrupted_strokes(), (0, 1));
        // The lift of the damaged stroke is a no-op, the next press paints.
        let out = run(&mut input, &context(&mapping), &[sample(3, Phase::Up), sample(500, Phase::Down)]);
        assert!(matches!(out[0], StrokeCommand::Begin { id: 2, .. }));
    }

    #[test]
    fn the_sample_queue_is_bounded_and_the_error_is_reported_once() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let ctx = context(&mapping);
        let mut out = Vec::new();
        input.feed(&InputEvent::Sample(sample(1, Phase::Down)), &ctx, &mut out);
        out.clear();
        for t in 2..(MAX_STROKE_SAMPLES as u64 + 20) {
            input.feed(&InputEvent::Sample(sample(t, Phase::Move)), &ctx, &mut out);
        }
        assert_eq!(out.len(), MAX_STROKE_SAMPLES - 1, "the press took one of the allowed samples");
        assert_eq!(input.take_error(), Some(InputError::QueueLimit));
        assert_eq!(input.take_error(), None);
        assert!(input.active(), "the stroke stays open until the pen lifts");
    }

    #[test]
    fn nothing_paints_while_playing_with_space_held_or_over_the_pan_tool() {
        let mapping = Mapping::default();
        for edit in [|c: &mut Context| c.playing = true, |c: &mut Context| c.space_held = true, |c: &mut Context| c.tool = ToolMode::Pan, |c: &mut Context| c.tool = ToolMode::Other] {
            let mut ctx = context(&mapping);
            edit(&mut ctx);
            assert!(run(&mut StrokeInput::new(), &ctx, &[sample(2, Phase::Down), sample(3, Phase::Move)]).is_empty());
        }
    }

    #[test]
    fn a_second_pointer_is_ignored_while_a_stroke_is_open() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let mut mouse = sample(3, Phase::Down);
        mouse.tool = Tool::Mouse;
        mouse.pointer = 2;
        let mut mouse_move = mouse;
        mouse_move.phase = Phase::Move;
        mouse_move.time_ns += 1_000_000;
        let out = run(&mut input, &context(&mapping), &[sample(2, Phase::Down), mouse, mouse_move]);
        assert_eq!(out.iter().filter(|c| matches!(c, StrokeCommand::Begin { .. })).count(), 1);
        assert_eq!(samples(&out).len(), 1);
    }

    #[test]
    fn tap_slop_is_five_pixels_for_a_pen_ten_for_a_finger_and_the_callers_for_a_mouse() {
        assert_eq!(drag_slop(Tool::Pen, 0.0), 5.0);
        assert_eq!(drag_slop(Tool::Eraser, 0.0), 5.0);
        assert_eq!(drag_slop(Tool::Touch, 0.0), 10.0);
        assert_eq!(drag_slop(Tool::Mouse, 3.0), 3.0);
        assert!(!beyond_slop(103.0, 104.0, (100.0, 100.0), 5.0 + 1e-9));
        assert!(beyond_slop(103.0, 104.0, (100.0, 100.0), 5.0));
        assert!(beyond_slop(100.0, 100.0, (100.0, 100.0), 0.0));
    }

    #[test]
    fn the_standard_script_makes_two_strokes_the_second_erasing() {
        let mapping = Mapping::default();
        let mut input = StrokeInput::new();
        let queue = InputQueue::new();
        let script = Script::generate(&ScriptSpec::standard(240.0, 5.0, 800.0, 600.0), 1);
        for step in &script.steps {
            queue.push(InputEvent::Sample(step.sample(1, 1_000)));
        }
        let mut events = Vec::new();
        queue.drain(&mut events);
        let mut out = Vec::new();
        for event in &events {
            input.feed(event, &context(&mapping), &mut out);
        }
        let begins: Vec<bool> = out.iter().filter_map(|c| if let StrokeCommand::Begin { erase, .. } = c { Some(*erase) } else { None }).collect();
        assert_eq!(begins, [false, true]);
        assert_eq!(out.iter().filter(|c| matches!(c, StrokeCommand::End { .. })).count(), 2);
        // The barrel pulse inside the first stroke is chorded with the tip: it opens no palette.
        assert!(!out.iter().any(|c| matches!(c, StrokeCommand::Action(_))));
        assert!(samples(&out).iter().all(|s| s.1 >= 0.05 && s.1 <= 1.0));
    }
}
