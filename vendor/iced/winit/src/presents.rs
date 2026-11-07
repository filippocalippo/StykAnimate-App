//! When each frame was presented (StykAnimate patch, see `VENDOR.md`).
//!
//! A check that times keystroke to presentation needs the instant the surface was presented. Recording is off until
//! [`start`] is called, so a normal run pays one lock-free-looking mutex lookup per frame and keeps nothing.

use std::sync::Mutex;
use std::time::Instant;

static LOG: Mutex<Option<Vec<Instant>>> = Mutex::new(None);

/// Starts recording presents (and forgets any earlier ones).
pub fn start() {
    if let Ok(mut log) = LOG.lock() {
        *log = Some(Vec::new());
    }
}

/// The presents recorded since [`start`] (or the last call), oldest first; recording goes on.
pub fn take() -> Vec<Instant> {
    LOG.lock()
        .ok()
        .and_then(|mut log| log.as_mut().map(std::mem::take))
        .unwrap_or_default()
}

pub(crate) fn record() {
    if let Ok(mut log) = LOG.lock()
        && let Some(log) = log.as_mut()
    {
        log.push(Instant::now());
    }
}
