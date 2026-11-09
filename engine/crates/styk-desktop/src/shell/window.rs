//! The editor window: how it opens, what it tells the page about itself, how it closes with unsaved work, and its
//! commands (`styk:window`, `styk:window-state`, `styk:document-state`, `styk:new-window`, `styk:memory-bytes`,
//! `styk:page-listening`), ported from desktop/main.cjs.
//!
//! The page reaches the native side through the bridge (src/desktop-bridge.mjs), injected before any of its own
//! scripts with the values preload gave synchronously (`platform`, `memoryBytes`, `startupView`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use super::text::{t, t0};
use super::{Failure, Shell, gpu, web_host};

/// The editor window's label.
pub const MAIN: &str = "main";
const BRIDGE: &str = include_str!("../../../../../src/desktop-bridge.mjs");
const DEFAULT_SIZE: (f64, f64) = (1560.0, 1000.0);
const MIN_SIZE: (f64, f64) = (1000.0, 680.0);

/// `{maximized, fullscreen, focused}`, as `styk:window-state` carries it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct WindowState {
    pub maximized: bool,
    pub fullscreen: bool,
    pub focused: bool,
}

fn state_of(window: &tauri::Window) -> WindowState {
    WindowState {
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
    }
}

/// Where the window was, kept in `window-state.json` in the user-data folder: its normal (not maximized) bounds in
/// physical pixels, the scale of the monitor it was on, and whether it was maximized. A saved place that no monitor
/// shows any more (a monitor unplugged, resolution changed) is ignored, and the window opens centred.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub maximized: bool,
}

/// A monitor's work area in physical pixels.
#[derive(Debug, Clone, Copy)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Placement {
    /// The saved place, fitted to the monitors there are now; `None` when none shows enough of it to grab.
    pub fn fitted(self, areas: &[Area]) -> Option<Placement> {
        if self.width < 200 || self.height < 150 {
            return None;
        }
        // The title bar's middle must be on a monitor, or the person could not move the window back.
        let (grab_x, grab_y) = (self.x + self.width as i32 / 2, self.y + 16);
        let area = areas.iter().find(|a| {
            grab_x >= a.x && grab_x < a.x + a.width as i32 && grab_y >= a.y && grab_y < a.y + a.height as i32
        })?;
        let width = self.width.min(area.width);
        let height = self.height.min(area.height);
        let x = self.x.clamp(area.x, area.x + (area.width - width) as i32);
        let y = self.y.clamp(area.y, area.y + (area.height - height) as i32);
        Some(Placement { x, y, width, height, ..self })
    }
}

/// The window's last normal bounds, followed while it moves so a maximized window still saves where it returns to.
#[derive(Default)]
struct Tracker {
    normal: Option<Placement>,
}

fn placement_file(shell: &Shell) -> std::path::PathBuf {
    shell.user_data.join("window-state.json")
}

fn read_placement(shell: &Shell) -> Option<Placement> {
    serde_json::from_slice(&std::fs::read(placement_file(shell)).ok()?).ok()
}

fn monitor_areas(window: &WebviewWindow) -> Vec<Area> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            Area { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height }
        })
        .collect()
}

fn current_normal(window: &tauri::Window) -> Option<Placement> {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false)
    {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale: window.scale_factor().unwrap_or(1.0),
        maximized: false,
    })
}

fn save_placement(window: &tauri::Window, tracker: &Mutex<Tracker>) {
    let app = window.app_handle();
    let shell = app.state::<Shell>();
    // Only the first window's place is remembered: further windows open where the first one would.
    if shell.background || !shell.primary {
        return;
    }
    let normal = current_normal(window).or(tracker.lock().unwrap_or_else(|e| e.into_inner()).normal);
    let Some(mut placement) = normal else { return };
    placement.maximized = window.is_maximized().unwrap_or(false);
    let Ok(bytes) = serde_json::to_vec(&placement) else { return };
    // A small file written whole: a temporary beside it, then renamed over the old one.
    let path = placement_file(&shell);
    let staged = path.with_extension("json.tmp");
    if std::fs::write(&staged, bytes).is_ok() && std::fs::rename(&staged, &path).is_err() {
        let _ = std::fs::remove_file(&staged);
    }
}

/// The script the page runs before its own: the boot values, then the bridge.
fn boot_script(shell: &Shell) -> String {
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let boot = json!({
        "platform": platform,
        "memoryBytes": total_memory(),
        "startupView": shell.startup_view,
        "packaged": shell.packaged,
        "effectsShader": if gpu::fxc() { Some(gpu::EFFECTS_SHADER) } else { None },
    });
    format!("Object.defineProperty(window, '__STYK_BOOT__', {{value: Object.freeze({boot}), configurable: false}});\n{BRIDGE}")
}

/// Opens the editor window.
pub fn create(app: &AppHandle) -> Result<WebviewWindow, Box<dyn std::error::Error>> {
    let shell = app.state::<Shell>();
    let background = shell.background;
    // IndexedDB here is temporary worker storage (undo caches), so the previous launch's is reclaimed before any
    // editor or worker can use it. Local storage stays: the origin is the same on every launch, so recent colours,
    // palettes and the brush library last; settings, layout, hotkeys and recovery live in native files.
    let browser_data = shell.instance_dir.join("webview");
    let _ = std::fs::remove_dir_all(browser_data.join("EBWebView").join("Default").join("IndexedDB"));
    let debugging = if cfg!(any(debug_assertions, feature = "devtools")) {
        std::env::var("STYK_REMOTE_DEBUGGING_PORT").ok().and_then(|v| v.parse::<u16>().ok())
    } else {
        None
    };
    let mut switches = gpu::switches(std::env::var("STYK_GPU_UNSAFE").ok().as_deref(), background, debugging);
    // Diagnosing a driver or browser problem: more switches, in development and developer builds only.
    if cfg!(any(debug_assertions, feature = "devtools"))
        && let Ok(extra) = std::env::var("STYK_EXTRA_BROWSER_ARGS")
    {
        switches.switches.extend(extra.split_whitespace().map(str::to_owned));
    }
    let url = WebviewUrl::CustomProtocol(url::Url::parse(web_host::origin())?);
    let mut builder = tauri::WebviewWindowBuilder::new(app, MAIN, url)
        .title("StykAnimate")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .decorations(cfg!(target_os = "macos"))
        .visible(false)
        .focused(!background)
        .skip_taskbar(background)
        .background_color(tauri::window::Color(0x0a, 0x0b, 0x0f, 0xff))
        .data_directory(browser_data)
        .additional_browser_args(&switches.arguments())
        .disable_drag_drop_handler()
        .initialization_script(boot_script(&shell))
        // The page never leaves its origin; links open through `window.open` below.
        .on_navigation(web_host::owns)
        .on_new_window(|url, _features| {
            // Help links to GitHub and Pivot's site open in the system browser; nothing else opens a window.
            let text = url.as_str();
            if text.starts_with("https://github.com/") || text.starts_with("https://pivotanimator.net/") {
                let _ = super::open_external(text);
            }
            tauri::webview::NewWindowResponse::Deny
        });
    let first_load = Arc::new(AtomicBool::new(true));
    let shown = first_load.clone();
    builder = builder.on_page_load(move |webview, payload| {
        let app = webview.app_handle();
        match payload.event() {
            tauri::webview::PageLoadEvent::Started => app.state::<Shell>().page_started(app),
            tauri::webview::PageLoadEvent::Finished => {
                if shown.swap(false, Ordering::SeqCst) {
                    let _ = webview.show();
                    app.state::<Shell>().flush_pending(app);
                }
            }
        }
    });
    let window = builder.build()?;

    if background {
        let _ = window.set_position(PhysicalPosition::new(-20000, -20000));
    } else if let Some(saved) = read_placement(&shell) {
        if let Some(fitted) = saved.fitted(&monitor_areas(&window)) {
            let _ = window.set_position(PhysicalPosition::new(fitted.x, fitted.y));
            let _ = window.set_size(PhysicalSize::new(fitted.width, fitted.height));
            if fitted.maximized {
                let _ = window.maximize();
            }
        } else {
            let _ = window.center();
        }
    } else {
        let _ = window.center();
    }

    let tracker = Arc::new(Mutex::new(Tracker::default()));
    let last = Arc::new(Mutex::new(WindowState::default()));
    let prompting = Arc::new(AtomicBool::new(false));
    let telemetry_closed = Arc::new(AtomicBool::new(false));
    let events = window.clone();
    window.on_window_event(move |event| {
        let window = events.as_ref().window();
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(normal) = current_normal(&window) {
                    tracker.lock().unwrap_or_else(|e| e.into_inner()).normal = Some(normal);
                }
            }
            _ => {}
        }
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(_)) {
            let now = state_of(&window);
            let mut previous = last.lock().unwrap_or_else(|e| e.into_inner());
            if *previous != now {
                *previous = now;
                let _ = window.emit_to(MAIN, "styk:window-state", now);
            }
        }
        if let WindowEvent::CloseRequested { api, .. } = event {
            let app = window.app_handle();
            let shell = app.state::<Shell>();
            let dirty = shell.document.lock().unwrap_or_else(|e| e.into_inner()).dirty;
            if !shell.quitting.load(Ordering::SeqCst) && dirty {
                api.prevent_close();
                if !prompting.swap(true, Ordering::SeqCst) {
                    let app = app.clone();
                    let prompting = prompting.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let answer = ask_unsaved(&app, false);
                        prompting.store(false, Ordering::SeqCst);
                        let shell = app.state::<Shell>();
                        match answer {
                            Unsaved::Save => shell.send_action(&app, "save-and-close"),
                            Unsaved::Discard => {
                                shell.document.lock().unwrap_or_else(|e| e.into_inner()).dirty = false;
                                if let Some(main) = app.get_webview_window(MAIN) {
                                    let _ = main.close();
                                }
                            }
                            Unsaved::Cancel => {}
                        }
                    });
                }
            } else if !telemetry_closed.swap(true, Ordering::SeqCst) {
                // The page counts and writes its telemetry session first (a second at most), then the window closes.
                api.prevent_close();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::services::close_telemetry(&app).await;
                    if let Some(main) = app.get_webview_window(MAIN) {
                        let _ = main.close();
                    }
                });
            } else {
                save_placement(&window, &tracker);
            }
        }
    });
    if std::env::var("STYK_DEVTOOLS").as_deref() == Ok("1") {
        #[cfg(any(debug_assertions, feature = "devtools"))]
        window.open_devtools();
    }
    Ok(window)
}

/// What the person chose when unsaved work would close.
#[derive(Debug, PartialEq, Eq)]
pub enum Unsaved {
    Save,
    Cancel,
    Discard,
}

/// Asks before unsaved work closes (or the app restarts to update): one project by its name, several by their
/// count. Blocks; call it off the main thread.
pub fn ask_unsaved(app: &AppHandle, restart: bool) -> Unsaved {
    if let Some(answer) = super::test_hooks::take_answer("message") {
        return match answer.as_str() {
            Some("save") => Unsaved::Save,
            Some("discard") => Unsaved::Discard,
            _ => Unsaved::Cancel,
        };
    }
    let state = app.state::<Shell>().document.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let several = state.unsaved > 1;
    let mut params = Map::new();
    let message = if several {
        params.insert("count".into(), state.unsaved.into());
        t("desktop.main.saveChangesToProjects", &params)
    } else {
        let name = if state.unsaved_name.is_empty() { &state.name } else { &state.unsaved_name };
        params.insert("name".into(), name.clone().into());
        t("desktop.main.saveChangesToName", &params)
    };
    let (save, discard) = match (several, restart) {
        (true, true) => ("desktop.main.saveAllAndRestart", "desktop.main.discardAllAndRestart"),
        (true, false) => ("desktop.main.saveAll", "desktop.main.discardAll"),
        (false, true) => ("desktop.main.saveAndRestart", "desktop.main.discardAndRestart"),
        (false, false) => ("common.save", "desktop.main.discard"),
    };
    let (title, detail) = if restart {
        ("desktop.main.restartToUpdate", "desktop.main.stykanimateWillCloseInstallTheDownloadedUpdateAndReopen")
    } else if several {
        ("desktop.main.unsavedAnimation", "desktop.main.theseProjectsHaveChangesThatHaveNotBeenSaved")
    } else {
        ("desktop.main.unsavedAnimation", "desktop.main.yourAnimationHasChangesThatHaveNotBeenSaved")
    };
    let (save, discard, cancel) = (t0(save), t0(discard), t0("desktop.main.cancel"));
    let mut dialog = app
        .dialog()
        .message(format!("{message}\n\n{}", t0(detail)))
        .title(t0(title))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(save.clone(), discard.clone(), cancel.clone()));
    if let Some(main) = app.get_webview_window(MAIN) {
        dialog = dialog.parent(&main);
    }
    match dialog.blocking_show_with_result() {
        MessageDialogResult::Yes => Unsaved::Save,
        MessageDialogResult::No => Unsaved::Discard,
        MessageDialogResult::Custom(label) if label == save => Unsaved::Save,
        MessageDialogResult::Custom(label) if label == discard => Unsaved::Discard,
        _ => Unsaved::Cancel,
    }
}

/// An error dialog (Electron's `dialog.showErrorBox`).
pub fn error_box(app: &AppHandle, title: &str, message: &str) {
    if super::test_hooks::record("error-box", json!({"title": title, "message": message})) {
        return;
    }
    let mut dialog = app.dialog().message(message).title(title).kind(MessageDialogKind::Error);
    if let Some(main) = app.get_webview_window(MAIN) {
        dialog = dialog.parent(&main);
    }
    dialog.show(|_| {});
}

/// The system's total memory in bytes; 0 when unknown (the page then uses `navigator.deviceMemory`).
pub fn total_memory() -> u64 {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: the structure is zeroed with its length set, as the call requires.
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut status) != 0 {
                return status.ullTotalPhys;
            }
        }
        0
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find(|l| l.starts_with("MemTotal:"))
                    .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
            })
            .map(|kb| kb * 1024)
            .unwrap_or(0)
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, Failure> {
    app.get_webview_window(MAIN).ok_or_else(|| Failure::plain("The window is closed."))
}

/// `styk:window`: minimize, maximize (or restore) and close. A close the page asked for at a checkpoint that no
/// longer matches the document is refused (false).
#[tauri::command]
pub fn window(app: AppHandle, action: String, checkpoint: Option<Value>) -> Result<Value, Failure> {
    let window = main_window(&app)?;
    match action.as_str() {
        "minimize" => window.minimize()?,
        "maximize" => {
            if window.is_maximized()? {
                window.unmaximize()?
            } else {
                window.maximize()?
            }
        }
        "close" => {
            let shell = app.state::<Shell>();
            if !shell.document.lock().unwrap_or_else(|e| e.into_inner()).action_current(checkpoint.as_ref()) {
                return Ok(Value::Bool(false));
            }
            window.close()?
        }
        _ => return Err(Failure::key("desktop.main.errors.unknownWindowAction")),
    }
    Ok(serde_json::to_value(state_of(&window.as_ref().window())).unwrap_or(Value::Null))
}

/// `styk:window-state`.
#[tauri::command]
pub fn window_state(app: AppHandle) -> Result<WindowState, Failure> {
    Ok(state_of(&main_window(&app)?.as_ref().window()))
}

/// `styk:document-state`: what the window holds, for its title and the questions asked before it closes.
#[tauri::command]
pub fn document_state(app: AppHandle, state: Option<Value>) -> Result<(), Failure> {
    let state = state.unwrap_or(Value::Null);
    let text = |key: &str, fallback: &str, limit: usize| -> String {
        let value = match state.get(key) {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(true)) => "true".into(),
            _ => fallback.to_owned(),
        };
        value.chars().take(limit).collect()
    };
    let truthy = |key: &str| match state.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    };
    let name = text("name", "Untitled", 180);
    let dirty = truthy("dirty");
    // A whole number of projects (JavaScript's `Number.isSafeInteger`), at most 64, at least one while dirty.
    let unsaved = match state.get("unsaved").and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 => (n.min(64.0) as i64).max(i64::from(dirty)) as u32,
        _ => u32::from(dirty),
    };
    let unsaved_name = text("unsavedName", &name, 180);
    let active_dirty = match state.get("activeDirty") {
        None | Some(Value::Null) => dirty,
        Some(_) => truthy("activeDirty"),
    };
    let shell = app.state::<Shell>();
    *shell.document.lock().unwrap_or_else(|e| e.into_inner()) =
        super::DocumentState { name: name.clone(), dirty, revision: text("revision", "", 160), unsaved, unsaved_name };
    // The title names the project in front; its dot is that project's own.
    let window = main_window(&app)?;
    window.set_title(&format!("{}{name} — StykAnimate", if active_dirty { "• " } else { "" }))?;
    Ok(())
}

/// The page's zoom (Settings → Interface scale): page zoom keeps CSS layout, pointer coordinates and
/// `devicePixelRatio` aligned. The bridge checks the value first, as preload did.
#[tauri::command]
pub fn set_ui_scale(app: AppHandle, percent: f64) -> Result<(), Failure> {
    if !percent.is_finite() || !(75.0..=200.0).contains(&percent) || percent % 5.0 != 0.0 {
        return Err(Failure::key("desktop.preload.errors.uiScaleMustBe75200InStepsOf5").named("RangeError"));
    }
    Ok(main_window(&app)?.set_zoom(percent / 100.0)?)
}

/// `styk:new-window`: another process with its own window and project.
#[tauri::command]
pub fn new_window() -> Result<bool, Failure> {
    let exe = std::env::current_exe()?;
    let mut command = std::process::Command::new(exe);
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn()?;
    Ok(true)
}

/// `styk:memory-bytes`. The bridge has it from the start (`memoryBytes`); this answers a later ask.
#[tauri::command]
pub fn memory_bytes() -> u64 {
    total_memory()
}

/// `styk:page-listening`: the page's listeners for what the native side pushes are on; everything held goes out.
#[tauri::command]
pub fn page_listening(app: AppHandle) -> bool {
    app.state::<Shell>().page_listening(&app);
    true
}

/// What the page found at start: whether it is cross-origin isolated (the engine's threads need it) and which
/// WebGPU adapter it got. Logged, and kept for the smoke checks.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupReport {
    pub cross_origin_isolated: bool,
    pub shared_array_buffer: bool,
    pub webgpu: bool,
    #[serde(default)]
    pub adapter: Option<String>,
}

/// The last start-up report this process received.
pub static STARTUP_REPORT: Mutex<Option<StartupReport>> = Mutex::new(None);

#[tauri::command]
pub fn startup_report(app: AppHandle, report: StartupReport) {
    let packaged = app.state::<Shell>().packaged;
    if report.cross_origin_isolated && report.shared_array_buffer {
        eprintln!(
            "[stykanimate] cross-origin isolated; WebGPU {}",
            if report.webgpu { report.adapter.as_deref().unwrap_or("available") } else { "unavailable (WebGL2 backend)" }
        );
    } else {
        eprintln!("[stykanimate] the page is NOT cross-origin isolated: the engine cannot run its threads");
        if packaged {
            error_box(
                &app,
                "StykAnimate",
                "This window could not enable the engine's threads (cross-origin isolation). Please reinstall StykAnimate.",
            );
        }
    }
    *STARTUP_REPORT.lock().unwrap_or_else(|e| e.into_inner()) = Some(report);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_place_is_used_only_where_a_monitor_shows_it() {
        let primary = Area { x: 0, y: 0, width: 1920, height: 1040 };
        let left = Area { x: -2560, y: 0, width: 2560, height: 1400 };
        let saved = Placement { x: -2000, y: 100, width: 1560, height: 1000, scale: 1.5, maximized: true };
        assert_eq!(saved.fitted(&[primary, left]), Some(saved));
        // The left monitor is gone: nothing shows the title bar.
        assert_eq!(saved.fitted(&[primary]), None);
        // Bigger than the monitor now: shrunk to fit, kept on it.
        let big = Placement { x: 100, y: 10, width: 3000, height: 2000, scale: 1.0, maximized: false };
        let fitted = big.fitted(&[primary]).unwrap();
        assert_eq!((fitted.x, fitted.y, fitted.width, fitted.height), (0, 0, 1920, 1040));
        assert_eq!(Placement { width: 10, ..saved }.fitted(&[left]), None);
    }
}
