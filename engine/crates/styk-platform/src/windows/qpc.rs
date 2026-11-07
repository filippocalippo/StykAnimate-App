//! The performance counter as the application's monotonic clock: the clock `PerformanceCount` of a pointer message is
//! in, so a sample's time and "now" are comparable without conversion error.

use std::sync::OnceLock;
use std::time::Duration;
use styk_services::Clock;
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

fn frequency() -> u64 {
    static FREQUENCY: OnceLock<u64> = OnceLock::new();
    *FREQUENCY.get_or_init(|| {
        let mut ticks = 0i64;
        // SAFETY: `ticks` outlives the call. The call cannot fail on Windows XP and later.
        unsafe { QueryPerformanceFrequency(&mut ticks) };
        (ticks as u64).max(1)
    })
}

/// Counter ticks as nanoseconds at `frequency` ticks per second.
pub fn ticks_to_ns(ticks: u64, frequency: u64) -> u64 {
    (ticks as u128 * 1_000_000_000 / frequency.max(1) as u128) as u64
}

/// The counter now, in nanoseconds since the counter's origin.
pub fn now_ns() -> u64 {
    let mut ticks = 0i64;
    // SAFETY: `ticks` outlives the call. The call cannot fail on Windows XP and later.
    unsafe { QueryPerformanceCounter(&mut ticks) };
    ticks_to_ns(ticks as u64, frequency())
}

/// A raw `PerformanceCount` of a pointer message, in nanoseconds.
pub fn counter_ns(ticks: u64) -> u64 {
    ticks_to_ns(ticks, frequency())
}

/// The performance counter as a [`Clock`]: the time since the counter's origin.
#[derive(Clone, Copy, Debug, Default)]
pub struct QpcClock;

impl Clock for QpcClock {
    fn now(&self) -> Duration {
        Duration::from_nanos(now_ns())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_convert_without_overflow_at_any_uptime() {
        assert_eq!(ticks_to_ns(10_000_000, 10_000_000), 1_000_000_000);
        assert_eq!(ticks_to_ns(25, 10_000_000), 2_500);
        // Ten years of uptime at a 10 MHz counter.
        let ticks = 10 * 365 * 24 * 3600 * 10_000_000u64;
        assert_eq!(ticks_to_ns(ticks, 10_000_000), 10 * 365 * 24 * 3600 * 1_000_000_000);
    }

    #[test]
    fn the_counter_only_grows_and_counts_real_time() {
        let a = now_ns();
        std::thread::sleep(Duration::from_millis(20));
        let b = now_ns();
        assert!(b - a >= 19_000_000 && b - a < 200_000_000, "{}", b - a);
        assert!(QpcClock.now() >= Duration::from_nanos(b));
    }
}
