//! The application core.
//!
//! Everything that decides what the application does lives here, in plain Rust: how it was launched, and, as the
//! port proceeds, the app and view state, every command, the docking model, settings and the view models panels
//! display (`docs/native/architecture.md`). The interface (`styk-ui`) only draws what the core holds and turns input
//! into core commands, so a feature is tested here without a window.
//!
//! Dependencies point one way: the core may depend on the engine crates, `styk-services` and `styk-trace`, and must never depend on
//! iced, `styk-ui` or `styk-devtools` (`cargo xtask deps` fails the build if it does).

pub mod answers;
pub mod app;
pub mod audio;
pub mod camera_actions;
pub mod clipboard;
pub mod commands;
pub mod controls;
pub mod documents;
pub mod drawing;
pub mod export;
pub mod facts;
pub mod field;
pub mod focus;
pub mod frames;
pub mod engine;
pub mod history;
pub mod i18n;
pub mod inspector;
pub mod launch;
pub mod limits;
pub mod number;
pub mod range;
pub mod roving;
pub mod selection_actions;
pub mod text_entry;
pub mod text;
#[cfg(feature = "testing")]
pub mod testing;
pub mod view_state;

pub use launch::{Launch, LaunchError, USAGE};

/// Service contracts exposed to views through the application core.
pub use styk_services as services;
