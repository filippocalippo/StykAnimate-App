//! The operating-system side of the native app.
//!
//! One module per concern, each with an implementation per target (Windows today; macOS, Linux and the browser as the
//! platforms land). Code here may call the OS and use OS crates; it is the only place that may. It implements the
//! traits of `styk-services` and holds the few window-level helpers that are not services (showing a window without
//! activating it, capturing its pixels for a screenshot) and the choice of how an unattended run stays off the desktop
//! ([`unattended`]).
//!
//! It must never depend on the engine, the core or a toolkit: windows reach it as `raw-window-handle` handles.

pub mod environment;
pub mod font_smoothing;
// Audio decoding and the WASAPI output run the bundled FFmpeg and the Windows device; Windows only in this phase (decision N8).
#[cfg(windows)]
pub mod audio;
pub mod input;
pub mod spawn;
// Video export runs the bundled FFmpeg and the Windows codec helper; Windows only in this phase (decision N8).
#[cfg(windows)]
pub mod video;
pub mod unattended;
pub mod window;
pub mod fonts;
pub mod diagnostics;

pub mod screenshot;

// Platform-owned compile-time capability: tools may compose the native video
// service without embedding target predicates or importing unavailable services.
// Both forms accept items or an expression; unsupported targets keep their
// existing explicit "unavailable" path, not an unimplemented OS backend.
#[cfg(windows)]
#[macro_export]
macro_rules! video_tools {
    ({ $($available:tt)* } { $($unavailable:tt)* }) => { $($available)* };
}

#[cfg(not(windows))]
#[macro_export]
macro_rules! video_tools {
    ({ $($available:tt)* } { $($unavailable:tt)* }) => { $($unavailable)* };
}

pub mod clock;
#[cfg(windows)]
pub mod windows;

pub mod shell;
pub mod shell_check;

#[cfg(windows)]
#[macro_export]
macro_rules! shell_window_settings {
    ($settings:expr) => { $settings.platform_specific.undecorated_shadow = true; };
}
#[cfg(not(windows))]
#[macro_export]
macro_rules! shell_window_settings { ($settings:expr) => {}; }
