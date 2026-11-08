//! The application core.
//!
//! Everything that decides what the application does lives here, in plain Rust: how it was launched, and, as the
//! port proceeds, the app and view state, every command, the docking model, settings and the view models panels
//! display (`docs/native/architecture.md`). The interface (`styk-ui`) only draws what the core holds and turns input
//! into core commands, so a feature is tested here without a window.
//!
//! Dependencies point one way: the core may depend on the engine crates, `styk-services` and `styk-trace`, and must never depend on
//! iced, `styk-ui` or `styk-devtools` (`cargo xtask deps` fails the build if it does).

#[cfg(feature = "engine")]
pub mod answers;
#[cfg(feature = "engine")]
pub mod app;
#[cfg(feature = "engine")]
pub mod audio;
#[cfg(feature = "engine")]
pub mod automation;
#[cfg(feature = "engine")]
pub mod camera_actions;
#[cfg(feature = "engine")]
pub mod clipboard;
pub mod command_queue;
pub mod error_policy;
pub mod commands;
pub mod controls;
#[cfg(feature = "engine")]
pub mod documents;
#[cfg(feature = "engine")]
pub mod engine;
#[cfg(feature = "engine")]
pub mod drawing;
#[cfg(feature = "engine")]
pub mod export;
#[cfg(feature = "engine")]
pub mod facts;
pub mod field;
pub mod focus;
#[cfg(feature = "engine")]
pub mod frames;
#[cfg(feature = "engine")]
pub mod history;
pub mod i18n;
pub mod inspector;
pub mod launch;
pub mod layout;
pub mod limits;
pub mod number;
pub mod overlay;
pub mod recovery;
#[cfg(feature = "engine")]
pub mod range;
pub mod roving;
pub mod screens;
#[cfg(feature = "engine")]
pub mod selection_actions;
pub mod shell;
pub mod shortcuts;
pub mod stage;
pub mod text_entry;
#[cfg(feature = "engine")]
pub mod text;
#[cfg(feature = "testing")]
pub mod testing;
#[cfg(feature = "engine")]
pub mod view_state;

pub use launch::{ClockMode, Launch, LaunchError, USAGE};

#[cfg(feature = "inspect")]
pub mod inspect;
/// Service contracts exposed to views through the application core.
pub use styk_services as services;

pub mod identity;
