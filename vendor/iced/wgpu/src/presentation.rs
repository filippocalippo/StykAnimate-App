//! Which frames reach the screen.
//!
//! A frame is prepared as a candidate. When glyphs a worker is still drawing are missing from it (`incomplete`), showing
//! it would show text with holes in it, so the window keeps the last complete frame and the candidate is dropped; the
//! next candidate is built when the worker has the glyphs. **There is no deadline**: an incomplete candidate is never
//! shown, however long the worker takes, as Chromium's compositor does not activate a frame before its raster is done.
//! The worker restarts itself if it dies and draws with swash what DirectWrite cannot, so a wait ends; how long
//! frames were held is counted for the developer tools ([`crate::graphics::text::held_frames`]).

use std::time::{Duration, Instant};

/// How soon a window asks again while it keeps its last frame, whether or not the worker has said it has glyphs.
pub const RETRY: Duration = Duration::from_millis(8);

/// Decides, candidate by candidate, whether a window shows it.
#[derive(Debug, Default)]
pub struct Gate {
    /// When the window began keeping its frame for the glyphs of the candidates since.
    since: Option<Instant>,
}

impl Gate {
    /// A new gate.
    pub const fn new() -> Self {
        Self { since: None }
    }

    /// Whether the candidate prepared at `now` is shown: `None` shows it, `Some(retry)` keeps the last complete frame
    /// and asks to be tried again at `retry`. Every held candidate and every finished wait is counted.
    pub fn hold(&mut self, incomplete: bool, now: Instant) -> Option<Instant> {
        if !incomplete {
            if let Some(since) = self.since.take() {
                crate::graphics::text::record_wait(now.saturating_duration_since(since));
            }
            return None;
        }
        let _ = self.since.get_or_insert(now);
        crate::graphics::text::record_held_frame();
        Some(now + RETRY)
    }

    /// How long the current wait has lasted, if there is one.
    pub fn waiting(&self, now: Instant) -> Option<Duration> {
        self.since.map(|since| now.saturating_duration_since(since))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_candidate_is_shown_and_an_incomplete_one_is_not() {
        let mut gate = Gate::new();
        let start = Instant::now();
        assert_eq!(gate.hold(false, start), None);
        assert!(gate.hold(true, start).is_some(), "kept for the glyphs");
        assert_eq!(gate.hold(false, start + Duration::from_millis(5)), None, "shown when complete");
    }

    #[test]
    fn an_incomplete_candidate_is_never_shown_however_long_the_wait() {
        let mut gate = Gate::new();
        let start = Instant::now();
        for step in 0..2000u64 {
            // A wait of up to thirty-three minutes in 1 s steps: there is no deadline.
            let now = start + Duration::from_secs(step);
            assert!(gate.hold(true, now).is_some(), "the candidate at {step} s was shown with glyphs missing");
        }
        assert!(gate.waiting(start + Duration::from_secs(2000)).is_some_and(|waited| waited >= Duration::from_secs(1999)));
        assert_eq!(gate.hold(false, start + Duration::from_secs(2000)), None, "and shown whole when the glyphs have landed");
    }

    #[test]
    fn a_new_wait_after_a_shown_frame_counts_from_its_own_start() {
        let mut gate = Gate::new();
        let start = Instant::now();
        let _ = gate.hold(true, start);
        let _ = gate.hold(false, start + Duration::from_secs(10));
        assert_eq!(gate.waiting(start + Duration::from_secs(10)), None);
        let _ = gate.hold(true, start + Duration::from_secs(11));
        assert_eq!(gate.waiting(start + Duration::from_secs(12)), Some(Duration::from_secs(1)));
    }
}
