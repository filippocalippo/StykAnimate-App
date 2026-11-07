//! The shell contracts: how the window is laid out and moved, how the program is started and found again, and which
//! files and links it owns. Pure data and functions with test fakes; the operating-system side is
//! `styk_platform::windows`. The design is `docs/native/shell.md`.

pub mod associations;
pub mod chrome;
pub mod geometry;
pub mod instance;
pub mod launch;
pub mod protocol;
pub mod window_state;
pub mod wire;

pub use geometry::Rect;
