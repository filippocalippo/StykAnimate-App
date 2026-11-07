//! Everything the operating system tells the application about input, and the checks that drive it: one owner.
//!
//! - [`ime`]: keyboard layouts, input-method compositions and key posting, for the developer build's input check and the tests
//!   (the application itself never calls them). Their functions are re-exported here, so callers write `input::compose`.
//! - [`host`]: the [`styk_services::input::InputHost`] of this target, which the developer tools read the pen source through.
//! - `windows` (Windows only): the pointer source. A `WM_POINTER` window subclass turns pen and touch messages, with the pen's
//!   history, into [`styk_services::input::InputEvent`]s on the application's queue; `qpc` is the performance counter, the clock
//!   those messages are stamped in. Every window subclass this crate installs takes its id from `windows::subclass_id`, one id
//!   per owner, so the chain on a window holds them all.

pub mod host;
pub mod ime;
#[cfg(windows)]
pub mod windows;

pub use host::host;
pub use ime::{Candidate, ImePhase, activate_layout, candidate, complete, compose, key_text, post_key, primary_button_down, send_ime};
