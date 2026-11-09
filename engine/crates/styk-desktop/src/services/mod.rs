//! Area 3: export, audio, fonts, localization, the public library and samples, the shared clipboard, support and
//! telemetry. Each `desktop/*.cjs` module of that area becomes one module here; their commands are added below with
//! `desktop.commands(crate::commands![...])`.

use crate::Desktop;

pub fn register(_desktop: &mut Desktop) {}

/// Ends the page's telemetry session before the window closes (shell::window's close flow). Area 3 fills it in.
pub async fn close_telemetry(_app: &tauri::AppHandle) {}
