//! The platform services the application core is written against.
//!
//! This crate holds traits, the plain data they exchange and a fake of each for tests: nothing here calls the
//! operating system. `styk-platform` implements the traits for each target; the core depends on this crate alone, so
//! its tests compile quickly, never touch the machine they run on, and a touch or web build can supply its own
//! implementations.
//!
//! It must never depend on the engine, the core, a toolkit or an OS crate. A service is added when a chunk first
//! needs it, not before.

pub mod audio;
pub mod cancel;
pub mod clock;
pub mod input;
pub mod installer;
pub mod shell;
pub mod spawn;
pub mod updates;
pub mod video;
pub mod video_limits;

pub use cancel::Cancel;
pub use clock::{Clock, FixedClock, SystemClock};
pub use spawn::{Job, ManualSpawner, SpawnError, Spawner};

pub mod fonts;
pub mod control;

pub mod inspection;
