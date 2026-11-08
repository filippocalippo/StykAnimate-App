//! The native monotonic clock implementation.
use styk_services::Clock;
use std::time::{Duration, Instant};

/// One process session's persistence clock. Clone it for hosts in the same session.
#[derive(Clone, Debug)]
pub struct SystemWallClock {
    writer: String,
}
impl Default for SystemWallClock {
    fn default() -> Self {
        let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        Self { writer: format!("{:x}-{:x}", std::process::id(), started.as_nanos()) }
    }
}
impl styk_services::clock::WallClock for SystemWallClock {
    fn unix_millis(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
    }
    fn writer(&self) -> &str { &self.writer }
}
/// The real clock: its origin is the moment it was created.
#[derive(Clone, Debug)]
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    /// A clock whose origin is now.
    pub fn new() -> SystemClock {
        SystemClock { origin: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> SystemClock {
        SystemClock::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}
