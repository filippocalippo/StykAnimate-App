//! The platform services the application core is written against.
//!
//! This crate holds traits, the plain data they exchange and a fake of each for tests: nothing here calls the
//! operating system. `styk-platform` implements the traits for each target; the core depends on this crate alone, so
//! its tests compile quickly, never touch the machine they run on, and a touch or web build can supply its own
//! implementations.
//!
//! It must never depend on the engine, the core, a toolkit or an OS crate. A service is added when a chunk first
//! needs it, not before.

pub mod clock;
pub mod shell;
pub mod updates;

pub use clock::{Clock, FixedClock, SystemClock};

pub mod fonts;
