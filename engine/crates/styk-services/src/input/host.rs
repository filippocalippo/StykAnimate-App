//! What the developer tools read of the platform's input source, without naming the platform.
//!
//! The pen lab hooks a window's input, reads the source's counters and the display's refresh rate, and times with the clock
//! that pointer messages are stamped in. Those are an [`InputHost`]: `styk-platform` implements it for its target and the
//! application hands the implementation to the tools, so they import nothing from a platform module.

use super::InputQueue;
use crate::Clock;
use raw_window_handle::HasWindowHandle;
use std::any::Any;
use std::sync::Arc;

/// What the input source counted, since it was attached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourceCounters {
    /// Pen messages seen.
    pub pen_messages: u64,
    pub pen_samples: u64,
    /// Samples recovered from the history of a message.
    pub history_samples: u64,
    /// History entries a later message repeated, dropped.
    pub repeated_entries: u64,
    pub touch_samples: u64,
    pub real_mouse_messages: u64,
    /// Mouse messages the system promoted from a pen or a finger; none became samples.
    pub promoted_mouse_messages: u64,
    /// Context-menu messages, which press-and-hold would raise.
    pub context_menus: u64,
}

/// A live reading of an attached source's counters.
pub trait InputDiagnostics: Send + Sync {
    fn counters(&self) -> SourceCounters;
}

/// A source hooked to a window.
pub struct AttachedInput {
    /// Reads the source's counters from any thread.
    pub diagnostics: Arc<dyn InputDiagnostics>,
    /// The refresh rate of the display the window is on, in hertz (0 when unknown).
    pub refresh_hz: f64,
    /// Keeps the hook alive: dropping it unhooks the window. It must be dropped on the thread that attached it.
    pub hook: Box<dyn Any>,
}

/// The platform's input source, as the developer tools use it.
pub trait InputHost: Send + Sync {
    /// The clock pointer messages are stamped in (the performance counter on Windows).
    fn clock(&self) -> Arc<dyn Clock>;

    /// Hooks `window` (on the interface thread) and starts pushing its events into `queue`.
    fn attach(&self, window: &dyn HasWindowHandle, queue: InputQueue) -> Result<AttachedInput, String>;
}
