//! Time, as a service, so a run can be made deterministic.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// A monotonic clock: the time elapsed since an origin of its own, which only ever grows.
///
/// Everything that schedules, animates or measures asks a `Clock` instead of `Instant::now()`, so the automation
/// mode (`--clock fixed`) can drive the application through a script and get the same frames every run.
pub trait Clock: Send + Sync {
    /// The time since this clock's origin.
    fn now(&self) -> Duration;
}

#[cfg(any(test, feature = "test-fakes"))]
pub mod test_fakes;
#[cfg(any(test, feature = "test-fakes"))]
pub use test_fakes::SystemClock;

/// A clock that moves only when told to. Clones share one time.
#[derive(Clone, Debug, Default)]
pub struct FixedClock {
    nanos: Arc<AtomicU64>,
}

impl FixedClock {
    /// A clock standing at its origin.
    pub fn new() -> FixedClock {
        FixedClock::default()
    }

    /// Moves every clone of this clock forward.
    pub fn advance(&self, by: Duration) {
        self.nanos.fetch_add(by.as_nanos() as u64, Ordering::SeqCst);
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Duration {
        Duration::from_nanos(self.nanos.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_clock_stands_still_until_advanced() {
        let clock = FixedClock::new();
        assert_eq!(clock.now(), Duration::ZERO);
        assert_eq!(clock.now(), Duration::ZERO);
        clock.advance(Duration::from_millis(16));
        clock.advance(Duration::from_micros(667));
        assert_eq!(clock.now(), Duration::from_micros(16_667));
    }

    #[test]
    fn clones_of_a_fixed_clock_share_time() {
        let clock = FixedClock::new();
        let other = clock.clone();
        other.advance(Duration::from_secs(2));
        assert_eq!(clock.now(), Duration::from_secs(2));
    }

    #[test]
    fn the_system_clock_only_grows() {
        let clock = SystemClock::new();
        let first = clock.now();
        std::thread::sleep(Duration::from_millis(2));
        assert!(clock.now() >= first + Duration::from_millis(2));
    }

    #[test]
    fn clocks_are_usable_through_the_trait() {
        let clocks: Vec<Box<dyn Clock>> = vec![Box::new(FixedClock::new()), Box::new(SystemClock::new())];
        assert_eq!(clocks.len(), 2);
    }
}
