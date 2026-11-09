//! The stage's plain events and policies: what the widget (or an automation step) tells the stage, and the values it reads
//! back. No engine type is named here, so the interface builds with the engine off; `Surface` (engine) acts on them.

use super::input::Pointer;
use styk_services::input::{InputEvent, Modifiers};

/// Pixels a wheel line stands for: Chromium reports one notch of a mouse wheel as 100 pixels at the default scroll
/// setting, and today's gains (`canvas-wheel-zoom.mjs`: a notch is a delta of 100) are tuned to that.
pub const LINE_PIXELS: f64 = 100.0;

/// What the person set for the canvas (`canvasZoomGesture`, `smoothZoom`, reduced motion). Settings land with their
/// own chunk; until then these are today's defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gestures {
    /// "Zoom gesture: scroll to zoom": plain scroll zooms. Otherwise Ctrl or Cmd with the wheel zooms and plain scroll pans.
    pub scroll_zooms: bool,
    /// Notches glide (Smooth zooming on, or automatic on a backend that is not WebGL2).
    pub smooth: bool,
    /// The system asks for reduced motion: notches zoom directly.
    pub reduced_motion: bool,
}

impl Default for Gestures {
    fn default() -> Gestures {
        Gestures { scroll_zooms: false, smooth: true, reduced_motion: false }
    }
}

/// The amount a wheel event reports, in the toolkit's sign: positive is away from the person (content moves down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WheelDelta {
    Lines([f64; 2]),
    Pixels([f64; 2]),
}

impl WheelDelta {
    /// The browser's `deltaX` and `deltaY` for it (positive scrolls down and right), which today's gains use.
    pub fn browser(self) -> [f64; 2] {
        match self {
            WheelDelta::Lines([x, y]) => [-x * LINE_PIXELS, -y * LINE_PIXELS],
            WheelDelta::Pixels([x, y]) => [-x, -y],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wheel {
    pub delta: WheelDelta,
    /// Logical stage coordinates.
    pub point: [f64; 2],
    pub modifiers: Modifiers,
}

/// What the widget (or an automation step) tells the stage.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A mouse button or a finger. Points are logical stage coordinates.
    Pointer(Pointer),
    Wheel(Wheel),
    /// Space went down or up over the stage (Space and drag pans).
    Space(bool),
    /// The Pan tool became (or stopped being) the tool.
    PanTool(bool),
    /// What the platform's input queue held: pen samples with their provenance.
    Pen(Vec<InputEvent>),
    /// Pan by a delta (an automation step, the keyboard).
    Pan([f64; 2]),
    /// Zoom by a factor about a stage point.
    Zoom { factor: f64, at: [f64; 2] },
    FitCanvas,
    /// The view eases one frame on: sent on each redraw while [`Surface::moving`] says the view is moving.
    Tick,
    /// The scheduler, the paint worker or the pen queue made progress (the coalesced wake, [`Progress`]): scheduler
    /// results are collected and queued pen samples reach the host. The message that carries it is the one redraw.
    Progress,
    /// The window lost focus: Space is no longer held, no drag stays captured. Whatever the keyboard said before is stale.
    Blur,
    /// Show this tick of the animation.
    Frame(f64),
}

/// What an event came to, for the owner that routes input the stage does not keep.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    /// The view or the demanded frame changed: a redraw is due.
    pub changed: bool,
    /// Presses and moves the stage did not take (the tool owner's: none yet).
    pub routed: Vec<super::input::InputResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The surface is closed, or its lock was taken (it never is, but the interface never waits for it).
    Unavailable,
    /// The event named something the stage cannot take (a NaN, a size of zero).
    Invalid,
}

/// The identity of a graphics context: the painter belongs to the device it was made on, and a new context (the
/// surface was recreated) needs a new painter.
pub type GpuId = u64;

/// The pointer the stage asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cursor {
    Default,
    Grab,
    Grabbing,
}
