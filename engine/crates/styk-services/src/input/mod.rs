//! Pen, tablet, touch and mouse input as plain data (`docs/native/input.md`).
//!
//! A platform source turns the operating system's pointer messages into [`InputEvent`]s and pushes them into an
//! [`InputQueue`]; the application core drains the queue and turns the events into strokes. Nothing here calls the
//! operating system: the same types are produced by a real source, by the [`FakeSource`] of the tests and by the
//! [`script`] replayer that the automation mode and the developer tools use.

mod fake;
mod history;
mod queue;
pub mod script;

pub use fake::FakeSource;
pub use history::{EntryTime, HistoryClock};
pub use queue::{InputQueue, QueueStats, Waker};
pub use script::{Script, ScriptSpec, ScriptStep, StrokeSpec};

use std::ops::BitOr;

macro_rules! flags {
    ($(#[$meta:meta])* $name:ident { $($(#[$doc:meta])* $flag:ident = $value:expr),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
        pub struct $name(pub u8);
        impl $name {
            $($(#[$doc])* pub const $flag: $name = $name($value);)+
            /// No flag set.
            pub const NONE: $name = $name(0);
            /// Whether every flag of `other` is set.
            pub const fn contains(self, other: $name) -> bool { self.0 & other.0 == other.0 }
            /// Whether no flag is set.
            pub const fn is_empty(self) -> bool { self.0 == 0 }
            /// This set with `other` added.
            pub const fn with(self, other: $name) -> $name { $name(self.0 | other.0) }
            /// This set with `other` removed.
            pub const fn without(self, other: $name) -> $name { $name(self.0 & !other.0) }
        }
        impl BitOr for $name {
            type Output = $name;
            fn bitor(self, other: $name) -> $name { $name(self.0 | other.0) }
        }
    };
}

flags! {
    /// The keyboard modifiers held when a sample was produced. They travel with the sample so that a modifier released
    /// before the queue is drained is still what the press saw.
    Modifiers {
        SHIFT = 1,
        CTRL = 2,
        ALT = 4,
        META = 8,
    }
}

flags! {
    /// The buttons of the pointer: the tip in contact, and the pen's barrel button.
    PenButtons {
        /// The tip touches the surface (or the mouse's left button, or a finger, is down).
        TIP = 1,
        /// The pen's barrel button (a mouse's right button is reported the same way).
        BARREL = 2,
    }
}

flags! {
    /// Which fields of a sample the device actually reported. A pen without tilt reports zero tilt, and that is not
    /// the same as an upright pen.
    Valid {
        PRESSURE = 1,
        TILT = 2,
        TWIST = 4,
    }
}

flags! {
    /// How a sample came to be.
    SampleFlags {
        /// An entry of the history the system kept since the previous message, not the message's own newest sample.
        HISTORY = 1,
        /// Extrapolated by the application; never reaches the brush or the document.
        PREDICTED = 2,
    }
}

/// What produced a sample, as the operating system reported it. A mouse message that Windows promoted from a pen is
/// not a source and is never reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tool {
    /// The pen's tip.
    Pen,
    /// The pen's eraser end (inverted, or the eraser flag).
    Eraser,
    Mouse,
    Touch,
}

/// Where in its gesture a sample falls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Phase {
    /// In range of the surface, not touching it (a pen), or a mouse moving with no button down.
    Hover,
    /// The first sample in contact.
    Down,
    /// A later sample in contact.
    Move,
    /// The last sample: the tip lifted.
    Up,
}

/// One sample of one pointer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PenSample {
    /// When the device took the sample, in nanoseconds on the application's monotonic clock.
    pub time_ns: u64,
    /// The operating system's pointer id, stable from the first contact to the last.
    pub pointer: u32,
    pub tool: Tool,
    /// The position in the window's client area, in physical pixels, sub-pixel where the device is.
    pub x: f64,
    pub y: f64,
    /// Pressure, 0 to 1.
    pub pressure: f32,
    /// The device's own pressure value and its maximum, when the device reports them.
    pub raw_pressure: u32,
    pub pressure_max: u32,
    /// Tilt in degrees from upright, −90 to 90.
    pub tilt_x: f32,
    pub tilt_y: f32,
    /// Rotation of the pen about its axis, degrees.
    pub twist: f32,
    pub valid: Valid,
    pub buttons: PenButtons,
    pub phase: Phase,
    pub flags: SampleFlags,
    pub modifiers: Modifiers,
}

impl PenSample {
    /// A sample at a position with every other field at its neutral value: no pressure, upright, nothing pressed.
    pub fn at(time_ns: u64, pointer: u32, tool: Tool, x: f64, y: f64) -> PenSample {
        PenSample {
            time_ns,
            pointer,
            tool,
            x,
            y,
            pressure: 0.0,
            raw_pressure: 0,
            pressure_max: 0,
            tilt_x: 0.0,
            tilt_y: 0.0,
            twist: 0.0,
            valid: Valid::NONE,
            buttons: PenButtons::NONE,
            phase: Phase::Hover,
            flags: SampleFlags::NONE,
            modifiers: Modifiers::NONE,
        }
    }

    /// Whether the pointer is in contact with the surface at this sample.
    pub fn in_contact(&self) -> bool {
        self.phase != Phase::Hover
    }

    /// Whether this sample is the last of its contact.
    pub fn is_terminal(&self) -> bool {
        self.phase == Phase::Up
    }
}

/// Why a pointer's gesture ended without its own last sample.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterruptReason {
    /// The window lost the pointer's capture (a system dialog, another window, the pen leaving range).
    CaptureLost,
    /// The system cancelled the contact (a palm, a gesture the system took over).
    Canceled,
    /// The window lost the keyboard focus.
    FocusLost,
}

/// What a source delivers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InputEvent {
    Sample(PenSample),
    /// A pointer's gesture ended without a last sample. Independent of the sample history, which carries no notice of it.
    Interrupted { pointer: u32, time_ns: u64, reason: InterruptReason },
    /// The queue was full and `dropped` samples of this drain were lost: an open stroke is damaged and must end.
    Overflowed { dropped: u32 },
}

impl InputEvent {
    /// Whether this event ends a gesture. A terminal event is never dropped by a full queue.
    pub fn is_terminal(&self) -> bool {
        match self {
            InputEvent::Sample(sample) => sample.is_terminal(),
            InputEvent::Interrupted { .. } => true,
            InputEvent::Overflowed { .. } => true,
        }
    }
}

/// What a source can report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputCaps {
    pub name: &'static str,
    pub pressure: bool,
    /// The device's pressure range maximum (0 when it reports none).
    pub pressure_max: u32,
    pub tilt: bool,
    pub twist: bool,
    pub eraser: bool,
    pub barrel: bool,
    pub hover: bool,
    /// A history of samples between messages.
    pub history: bool,
}

/// A source of input events: it pushes into the [`InputQueue`] it was attached with.
pub trait InputSource {
    fn caps(&self) -> InputCaps;
    /// Stops delivering and releases the window hook.
    fn detach(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn flags_combine_and_test() {
        let held = Modifiers::SHIFT | Modifiers::ALT;
        assert!(held.contains(Modifiers::SHIFT));
        assert!(!held.contains(Modifiers::CTRL));
        assert!(held.without(Modifiers::SHIFT).contains(Modifiers::ALT));
        assert!(Modifiers::NONE.is_empty());
        assert!(held.contains(Modifiers::SHIFT | Modifiers::ALT));
    }

    #[test]
    fn terminal_events_are_pen_up_interrupts_and_overflow() {
        let mut up = PenSample::at(1, 1, Tool::Pen, 0.0, 0.0);
        up.phase = Phase::Up;
        assert!(InputEvent::Sample(up).is_terminal());
        up.phase = Phase::Move;
        assert!(!InputEvent::Sample(up).is_terminal());
        up.phase = Phase::Hover;
        assert!(!InputEvent::Sample(up).is_terminal());
        assert!(InputEvent::Interrupted { pointer: 1, time_ns: 2, reason: InterruptReason::CaptureLost }.is_terminal());
        assert!(InputEvent::Overflowed { dropped: 3 }.is_terminal());
    }
}
