//! The operating-system side of the native app.
//!
//! One module per concern, each with an implementation per target (Windows today; macOS, Linux and the browser as the
//! platforms land). Code here may call the OS and use OS crates; it is the only place that may. It implements the
//! traits of `styk-services` and holds the few window-level helpers that are not services (showing a window without
//! activating it, capturing its pixels for a screenshot).
//!
//! It must never depend on the engine, the core or a toolkit: windows reach it as `raw-window-handle` handles.

pub mod input;
pub mod window;
