//! Updating the program: the release feed, what an update is and whether to take it, the state the interface shows, and
//! the plan for handing over to the installer. Pure logic and traits with fakes; the network, the files and the
//! installer process are `styk_platform::windows::updates`. The design is `docs/native/shell.md`.
//!
//! Behaviour kept from `desktop/updates.cjs`: the first check 10 s after the start and then hourly, the same status
//! names, fields and message keys, no prereleases, no downgrades, a restart only from `ready`, nothing installed
//! without that explicit restart.

pub mod feed;
pub mod flow;
pub mod plan;
pub mod staging;
pub mod state;

pub use feed::{FeedError, FileInfo, ReleaseInfo, Version};
pub use state::{UpdateState, UpdateStatus};

use std::time::Duration;

/// The first check after the start.
pub const FIRST_CHECK: Duration = Duration::from_secs(10);
/// The time between checks.
pub const EVERY: Duration = Duration::from_secs(60 * 60);
/// The most progress reports per second.
pub const PROGRESS_PER_SECOND: u32 = 10;
/// The owner and name of the public release repository (`package.json` `build.publish`).
pub const RELEASE_REPOSITORY: (&str, &str) = ("filippocalippo", "styk-animate-releases");
