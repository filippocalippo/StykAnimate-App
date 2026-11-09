//! Updates, as desktop/updates.cjs ran them on electron-updater, now on `tauri-plugin-updater` (docs/UPDATES.md,
//! docs/tauri/updater-migration.md).
//!
//! The release feed and the installer stay on the native side: the page receives only status, never installer
//! paths or a configurable download URL. Installed Windows copies check 10 seconds after start and every hour;
//! Help → Check for updates checks at once. A newer stable version is downloaded and its signature verified, then
//! kept until the person chooses Restart to update: a normal exit never installs it. Restart asks first when work is
//! unsaved (Save and restart, Cancel, Discard and restart); a cancelled or failed save never starts the installer.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::text::t0;
use super::window::{MAIN, Unsaved, ask_unsaved};
use super::{Failure, Shell};
use crate::shell::release::RELEASES_URL;

/// What the page shows of the updater (`styk:update-state`, `styk:update-state-changed`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: &'static str,
    pub current_version: String,
    pub version: Option<String>,
    pub percent: f64,
    pub transferred: u64,
    pub total: u64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_params: Option<Map<String, Value>>,
}

/// Why this copy cannot update itself, as a message key; `None` when it can.
pub fn unavailable(packaged: bool, windows: bool, portable: bool, installed: bool) -> Option<&'static str> {
    if !packaged {
        return Some("desktop.updates.developmentUnavailable");
    }
    if !windows {
        return Some("desktop.updates.supportedInstallerRequired");
    }
    if portable || !installed {
        return Some("desktop.updates.windowsSetupRequired");
    }
    None
}

/// The updater's state, managed by Tauri.
pub struct Updates {
    state: Mutex<UpdateState>,
    busy: AtomicBool,
    restarting: AtomicBool,
    started: AtomicBool,
    ready: Mutex<Option<Ready>>,
}

/// A downloaded update waiting for Restart to update.
enum Ready {
    Verified(Box<Update>, Vec<u8>),
    /// The smokes' stand-in (shell::test_hooks, `update.json`).
    Hooked(String),
}

impl Updates {
    pub fn snapshot(&self) -> UpdateState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, app: &AppHandle, change: impl FnOnce(&mut UpdateState)) {
        let snapshot = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            change(&mut state);
            state.clone()
        };
        if snapshot.status == "error" {
            app.state::<Shell>().quitting.store(false, Ordering::SeqCst);
        }
        let _ = app.emit_to(MAIN, "styk:update-state-changed", snapshot);
    }

    fn fail(&self, app: &AppHandle, error: &dyn std::fmt::Display) {
        eprintln!("Update failed: {error}");
        self.set(app, |state| {
            state.status = "error";
            state.message = t0("desktop.updates.retryConnection");
            state.message_key = Some("desktop.updates.retryConnection".into());
            state.message_params = None;
        });
    }
}

fn clear_message(state: &mut UpdateState) {
    state.message.clear();
    state.message_key = None;
    state.message_params = None;
}

/// Whether this copy was installed by the Setup installer: the uninstaller sits beside it.
fn installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").exists()))
        .unwrap_or(false)
}

/// Sets the updater up (called at start, before the window opens).
pub fn init(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let portable = std::env::var_os("STYK_PORTABLE_DIR").is_some();
    let hooked = super::test_hooks::read("update.json").is_some();
    let reason = if hooked { None } else { unavailable(shell.packaged, cfg!(windows), portable, installed()) };
    let state = UpdateState {
        status: if reason.is_some() { "unavailable" } else { "idle" },
        current_version: app.package_info().version.to_string(),
        version: None,
        percent: 0.0,
        transferred: 0,
        total: 0,
        message: reason.map(t0).unwrap_or_default(),
        message_key: reason.map(str::to_owned),
        message_params: None,
    };
    app.manage(Updates {
        state: Mutex::new(state),
        busy: AtomicBool::new(false),
        restarting: AtomicBool::new(false),
        started: AtomicBool::new(false),
        ready: Mutex::new(None),
    });
}

/// Checks 10 seconds after start, then every hour.
pub fn start(app: &AppHandle) {
    let updates = app.state::<Updates>();
    if updates.snapshot().status == "unavailable" || updates.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        loop {
            check(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
        }
    });
}

/// One check, and the download when there is a newer version. Checks and downloads are never doubled.
pub async fn check(app: &AppHandle) -> UpdateState {
    if begin(app) {
        run(app).await;
    }
    app.state::<Updates>().snapshot()
}

/// Starts a check when none runs and the state allows one: the state says `checking` when this returns true.
fn begin(app: &AppHandle) -> bool {
    let updates = app.state::<Updates>();
    if ["unavailable", "ready", "restarting"].contains(&updates.snapshot().status) || updates.busy.swap(true, Ordering::SeqCst)
    {
        return false;
    }
    updates.set(app, |state| {
        state.status = "checking";
        clear_message(state);
        state.percent = 0.0;
        state.transferred = 0;
        state.total = 0;
    });
    true
}

/// The smokes' stand-in for the feed: finds `version` and "downloads" it in five steps.
async fn run_hooked(app: &AppHandle, hooked: &Value) -> Result<(), String> {
    let updates = app.state::<Updates>();
    let version = hooked.get("version").and_then(Value::as_str).unwrap_or("9.9.9").to_owned();
    let step = std::time::Duration::from_millis(hooked.get("stepMs").and_then(Value::as_u64).unwrap_or(200));
    for percent in [0u64, 25, 50, 75] {
        updates.set(app, |state| {
            state.status = "downloading";
            state.version = Some(version.clone());
            state.percent = percent as f64;
            state.transferred = percent * 1_048_576;
            state.total = 100 * 1_048_576;
            clear_message(state);
        });
        tokio::time::sleep(step).await;
    }
    *updates.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ready::Hooked(version.clone()));
    updates.set(app, |state| {
        state.status = "ready";
        state.version = Some(version);
        state.percent = 100.0;
    });
    Ok(())
}

async fn run(app: &AppHandle) {
    let updates = app.state::<Updates>();
    let result = async {
        if let Some(hooked) = super::test_hooks::read("update.json") {
            return run_hooked(app, &hooked).await;
        }
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            updates.set(app, |state| {
                state.status = "current";
                state.version = None;
                clear_message(state);
            });
            return Ok(());
        };
        updates.set(app, |state| {
            state.status = "downloading";
            state.version = Some(update.version.clone());
            clear_message(state);
        });
        let mut transferred: u64 = 0;
        let mut shown = -1.0f64;
        let bytes = update
            .download(
                |chunk, total| {
                    transferred += chunk as u64;
                    let total = total.unwrap_or(0);
                    let percent = if total > 0 { (transferred as f64 * 100.0 / total as f64).clamp(0.0, 100.0) } else { 0.0 };
                    // About one message per percent: progress, not a flood.
                    if percent.floor() != shown {
                        shown = percent.floor();
                        updates.set(app, |state| {
                            state.status = "downloading";
                            state.percent = percent;
                            state.transferred = transferred;
                            state.total = total;
                        });
                    }
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        let version = update.version.clone();
        *updates.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ready::Verified(Box::new(update), bytes));
        updates.set(app, |state| {
            state.status = "ready";
            state.version = Some(version);
            state.percent = 100.0;
            clear_message(state);
        });
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        updates.fail(app, &error);
    }
    updates.busy.store(false, Ordering::SeqCst);
}

/// `styk:update-state`.
#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateState {
    app.state::<Updates>().snapshot()
}

/// `styk:update-check`: starts a check and answers at once with the state.
#[tauri::command]
pub fn update_check(app: AppHandle) -> UpdateState {
    if begin(&app) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { run(&handle).await });
    }
    app.state::<Updates>().snapshot()
}

/// `styk:update-restart`: installs the downloaded update and reopens, after asking about unsaved work. False when
/// nothing happens (no update ready, the person cancelled or chose to save first, the document changed meanwhile).
#[tauri::command]
pub async fn update_restart(app: AppHandle, checkpoint: Option<Value>) -> Result<bool, Failure> {
    let current = move |app: &AppHandle| {
        app.state::<Shell>().document.lock().unwrap_or_else(|e| e.into_inner()).action_current(checkpoint.as_ref())
    };
    if !current(&app) {
        return Ok(false);
    }
    let updates = app.state::<Updates>();
    if updates.snapshot().status != "ready" || updates.restarting.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let handle = app.clone();
    let checkpoint_ok = move |app: &AppHandle| current(app);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let app = handle;
        let shell = app.state::<Shell>();
        let updates = app.state::<Updates>();
        if !checkpoint_ok(&app) {
            return Ok(false);
        }
        let (revision, dirty) = {
            let state = shell.document.lock().unwrap_or_else(|e| e.into_inner());
            (state.revision.clone(), state.dirty)
        };
        if dirty {
            match ask_unsaved(&app, true) {
                Unsaved::Save => {
                    shell.send_action(&app, "save-and-update");
                    return Ok(false);
                }
                Unsaved::Cancel => return Ok(false),
                Unsaved::Discard => {}
            }
        }
        if shell.document.lock().unwrap_or_else(|e| e.into_inner()).revision != revision || !checkpoint_ok(&app) {
            return Ok(false);
        }
        let ready = updates.ready.lock().unwrap_or_else(|e| e.into_inner()).take();
        let (update, bytes) = match ready {
            Some(Ready::Verified(update, bytes)) => (update, bytes),
            Some(Ready::Hooked(version)) => {
                updates.set(&app, |state| state.status = "restarting");
                super::test_hooks::record("update-install", Value::String(version));
                return Ok(true);
            }
            None => return Ok(false),
        };
        shell.quitting.store(true, Ordering::SeqCst);
        updates.set(&app, |state| state.status = "restarting");
        // Settings, the clipboard and telemetry are flushed before the installer replaces the app.
        shell.run_before_quit(&app);
        // On Windows this starts the installer (which reopens the app) and ends this process.
        match update.install(&bytes) {
            Ok(()) => {
                app.restart();
            }
            Err(error) => {
                *updates.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ready::Verified(update, bytes));
                shell.quitting.store(false, Ordering::SeqCst);
                Err(error.to_string())
            }
        }
    })
    .await;
    updates.restarting.store(false, Ordering::SeqCst);
    match result {
        Ok(Ok(done)) => Ok(done),
        Ok(Err(error)) => {
            updates.fail(&app, &error);
            Ok(false)
        }
        Err(error) => {
            updates.fail(&app, &error);
            Ok(false)
        }
    }
}

/// `styk:update-releases`: the public downloads page, in the system browser.
#[tauri::command]
pub fn update_releases() -> Result<(), Failure> {
    super::open_external(RELEASES_URL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_installed_windows_copy_updates_itself() {
        assert_eq!(unavailable(false, true, false, true), Some("desktop.updates.developmentUnavailable"));
        assert_eq!(unavailable(true, false, false, true), Some("desktop.updates.supportedInstallerRequired"));
        assert_eq!(unavailable(true, true, true, true), Some("desktop.updates.windowsSetupRequired"));
        assert_eq!(unavailable(true, true, false, false), Some("desktop.updates.windowsSetupRequired"));
        assert_eq!(unavailable(true, true, false, true), None);
    }
}
