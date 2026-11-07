//! Which frames reach the screen.
//!
//! A frame is prepared as a candidate. When glyphs a worker is still drawing are missing from it (`incomplete`), showing
//! it would show text with holes in it, so the window keeps the last complete frame and the candidate is dropped; the
//! next candidate is built when the worker has the glyphs. The wait is bounded: after [`LIMIT`] the incomplete frame
//! is shown, so a worker that never delivers cannot freeze a window.

use std::time::{Duration, Instant};

/// How long a window keeps its last complete frame while the latest candidate waits for glyphs.
pub const LIMIT: Duration = Duration::from_millis(150);

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

    /// Whether the candidate prepared at `now` is shown: `None` shows it, `Some(until)` keeps the last complete frame
    /// and asks to be tried again at the latest at `until`, when the wait ends.
    pub fn hold(&mut self, incomplete: bool, now: Instant, limit: Duration) -> Option<Instant> {
        if !incomplete {
            self.since = None;
            return None;
        }
        let since = *self.since.get_or_insert(now);
        if now.saturating_duration_since(since) >= limit {
            // The wait is over: show what there is. The next incomplete candidate starts a wait of its own.
            self.since = None;
            return None;
        }
        Some(since + limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_candidate_is_shown_and_an_incomplete_one_is_not() {
        let mut gate = Gate::new();
        let start = Instant::now();
        assert_eq!(gate.hold(false, start, LIMIT), None);
        assert!(gate.hold(true, start, LIMIT).is_some(), "kept for the glyphs");
        assert_eq!(gate.hold(false, start + Duration::from_millis(5), LIMIT), None, "shown when complete");
    }

    #[test]
    fn the_wait_is_bounded_and_counted_from_its_first_candidate() {
        let mut gate = Gate::new();
        let start = Instant::now();
        let until = gate.hold(true, start, LIMIT).expect("kept");
        assert_eq!(until, start + LIMIT);
        // Later candidates do not push the deadline back.
        assert_eq!(gate.hold(true, start + LIMIT / 2, LIMIT), Some(until));
        // At the deadline the incomplete frame is shown.
        assert_eq!(gate.hold(true, start + LIMIT, LIMIT), None);
        // And the next incomplete candidate starts a new wait.
        assert!(gate.hold(true, start + LIMIT + Duration::from_millis(1), LIMIT).is_some());
    }
}
