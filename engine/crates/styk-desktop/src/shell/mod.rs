//! Area 1: the shell. The window and its state, the web host, the single instance and second launches, the
//! `stykanimate://` links, GPU switches, updates, release notes and links (ports of desktop/main.cjs's window code,
//! web-host.cjs, workspace-instance.cjs, gpu-switches.cjs, page-pushes.cjs, updates.cjs, release-history.cjs and
//! release-links.cjs).
//!
//! It also holds what every area needs from the shell: [`Shell`] (the profile folders, whether this copy is
//! packaged, the document state) and [`Failure`] (an error the page shows).

pub mod gpu;
pub mod instance;
pub mod links;
pub mod profile;
pub mod pushes;
pub mod release;
pub mod test_hooks;
pub mod text;
pub mod updates;
pub mod web_host;
pub mod window;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::Desktop;
use pushes::PagePushes;
use web_host::WebAssets;

/// An error the page shows: the text in the current language, and the key it came from (`messageKey`), as the
/// Electron app's errors carried them. The bridge turns it into an `Error` with these fields.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub message_params: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Failure {
    /// The error `key` names, in the current language.
    pub fn key(key: &str) -> Self {
        Self::with(key, Map::new())
    }
    /// The error `key` names, with its parameters.
    pub fn with(key: &str, params: Map<String, Value>) -> Self {
        Self { message: text::t(key, &params), message_key: Some(key.to_owned()), message_params: params, name: None }
    }
    /// An error with only a message (from the system).
    pub fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), message_key: None, message_params: Map::new(), name: None }
    }
    /// The same error with a JavaScript error name (`RangeError`, `TypeError`).
    pub fn named(mut self, name: &str) -> Self {
        self.name = Some(name.to_owned());
        self
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::plain(error.to_string())
    }
}
impl From<tauri::Error> for Failure {
    fn from(error: tauri::Error) -> Self {
        Self::plain(error.to_string())
    }
}

/// What the window holds (several projects, one in front): `name` is the project in front, `dirty` is true while
/// any open project has unsaved changes, `unsaved` counts them and `unsaved_name` names one of them.
#[derive(Debug, Clone, Default)]
pub struct DocumentState {
    pub name: String,
    pub dirty: bool,
    pub revision: String,
    pub unsaved: u32,
    pub unsaved_name: String,
}

impl DocumentState {
    fn untitled() -> Self {
        Self { name: "Untitled".into(), ..Self::default() }
    }

    /// Whether a close or restart the page asked for still matches what the window holds: no checkpoint, or the
    /// same revision and, when the page believed it saved, nothing unsaved since.
    pub fn action_current(&self, checkpoint: Option<&Value>) -> bool {
        let Some(checkpoint) = checkpoint else { return true };
        if checkpoint.is_null() {
            return false;
        }
        match (checkpoint.get("revision").and_then(Value::as_str), checkpoint.get("saved").and_then(Value::as_bool)) {
            (Some(revision), Some(saved)) => revision == self.revision && (!saved || !self.dirty),
            _ => false,
        }
    }
}

type OpenFile = Arc<dyn Fn(AppHandle, PathBuf) -> Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send>> + Send + Sync>;
type Hook = Box<dyn Fn(&AppHandle) + Send + Sync>;

/// The shell's state, managed by Tauri: `app.state::<Shell>()`.
pub struct Shell {
    /// Built by `tauri build` (assets embedded, installed or portable), not run from the source tree.
    pub packaged: bool,
    /// `STYK_BACKGROUND_WINDOW=1`: scripts and agents driving the app.
    pub background: bool,
    /// Where the Electron app kept its user data, and this app keeps it now.
    pub user_data: PathBuf,
    /// This process's folder: the user-data folder for the first window, a workspace folder for others.
    pub instance_dir: PathBuf,
    /// Whether this is the first window's process.
    pub primary: bool,
    /// The page's files.
    pub assets: Arc<WebAssets>,
    /// 'home' or 'editor' when the launch decides where the window starts.
    pub startup_view: Option<&'static str>,
    pub document: Mutex<DocumentState>,
    pub quitting: AtomicBool,
    pushes: Mutex<PagePushes>,
    pending_files: Mutex<Vec<PathBuf>>,
    pending_link: Mutex<Option<String>>,
    public_library_link: Mutex<Option<String>>,
    open_file: OnceLock<OpenFile>,
    page_start: Mutex<Vec<Hook>>,
    before_quit: Mutex<Vec<Hook>>,
}

impl Shell {
    /// Sends `payload` to the page on `channel` now, or once its listeners are on.
    pub fn push(&self, app: &AppHandle, channel: &str, payload: Value) {
        let ready = self.pushes.lock().unwrap_or_else(|e| e.into_inner()).send(channel, payload);
        if let Some((channel, payload)) = ready {
            let _ = app.emit_to(window::MAIN, &channel, payload);
        }
    }

    /// Sends a menu action to the page (`styk:menu-action`).
    pub fn send_action(&self, app: &AppHandle, action: &str) {
        if app.get_webview_window(window::MAIN).is_some() {
            self.push(app, "styk:menu-action", Value::String(action.into()));
        }
    }

    /// Area 2 hands over how a file opened from outside (a second launch, the command line) is read for the page:
    /// what it returns is sent on `styk:file-opened`.
    pub fn set_open_file(&self, read: OpenFile) {
        let _ = self.open_file.set(read);
    }

    /// Work to do each time the page starts loading (its previous documents can no longer be written).
    pub fn on_page_start(&self, hook: impl Fn(&AppHandle) + Send + Sync + 'static) {
        self.page_start.lock().unwrap_or_else(|e| e.into_inner()).push(Box::new(hook));
    }

    /// Work to do before the app quits or restarts to update (flush settings, close telemetry).
    pub fn on_before_quit(&self, hook: impl Fn(&AppHandle) + Send + Sync + 'static) {
        self.before_quit.lock().unwrap_or_else(|e| e.into_inner()).push(Box::new(hook));
    }

    /// The public library link (`stykanimate://library/<id>`) that came last, taken once by the page.
    pub fn take_public_library_link(&self) -> Option<String> {
        self.public_library_link.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    pub(crate) fn run_before_quit(&self, app: &AppHandle) {
        let hooks = std::mem::take(&mut *self.before_quit.lock().unwrap_or_else(|e| e.into_inner()));
        for hook in hooks {
            hook(app);
        }
    }

    fn page_started(&self, app: &AppHandle) {
        self.pushes.lock().unwrap_or_else(|e| e.into_inner()).reset();
        for hook in self.page_start.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            hook(app);
        }
    }

    fn page_listening(&self, app: &AppHandle) {
        let held = self.pushes.lock().unwrap_or_else(|e| e.into_inner()).listen();
        for (channel, payload) in held {
            let _ = app.emit_to(window::MAIN, &channel, payload);
        }
    }

    /// Opens a file from outside: read for the page and sent on `styk:file-opened` (held while there is no page).
    pub fn open_file(&self, app: &AppHandle, file: PathBuf) {
        if app.get_webview_window(window::MAIN).is_none() {
            self.pending_files.lock().unwrap_or_else(|e| e.into_inner()).push(file);
            return;
        }
        let Some(read) = self.open_file.get().cloned() else {
            window::error_box(app, &text::t0("desktop.main.unableToOpenFile"), "This build cannot open files yet.");
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match read(app.clone(), file).await {
                Ok(result) => app.state::<Shell>().push(&app, "styk:file-opened", result),
                Err(error) => window::error_box(&app, &text::t0("desktop.main.unableToOpenFile"), &error.message),
            }
        });
    }

    /// Opens and links that came before the window existed go to the page once it does.
    pub(crate) fn flush_pending(&self, app: &AppHandle) {
        if let Some(link) = self.pending_link.lock().unwrap_or_else(|e| e.into_inner()).take() {
            links::handle(app, &link);
        }
        let files = std::mem::take(&mut *self.pending_files.lock().unwrap_or_else(|e| e.into_inner()));
        for file in files {
            self.open_file(app, file);
        }
    }
}

/// Opens a web page in the system browser (Electron's `shell.openExternal`).
pub fn open_external(url: &str) -> Result<(), Failure> {
    if test_hooks::record("open-url", Value::String(url.to_owned())) {
        return Ok(());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| Failure::plain(e.to_string()))
}

/// Files the app opens from its command line: the extensions it imports.
pub fn openable(argument: &str) -> bool {
    let lower = argument.to_ascii_lowercase();
    ["piv", "stk", "styk", "stkz", "stykmov", "json", "nodes", "nodemc", "stknds", "zip"]
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Shows a fatal start-up error and ends the process.
pub fn fatal(title: &str, message: &str) -> ! {
    eprintln!("{title}: {message}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (title, message) = (wide(title), wide(message));
        // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call.
        unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
    }
    std::process::exit(1);
}

/// The app's run loop events: before it exits, every area's quit work runs once.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::Exit = event
        && let Some(shell) = app.try_state::<Shell>()
    {
        shell.quitting.store(true, Ordering::SeqCst);
        shell.run_before_quit(app);
    }
}

/// Area 1's commands, plugins and start-up work.
pub fn register(desktop: &mut Desktop) {
    desktop.builder(|builder| {
        builder
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .register_asynchronous_uri_scheme_protocol(web_host::SCHEME, |context, request, responder| {
                let app = context.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let assets = app.state::<Shell>().assets.clone();
                    responder.respond(assets.answer(&request));
                });
            })
    });
    desktop.commands(crate::commands![
        window::window,
        window::window_state,
        window::document_state,
        window::set_ui_scale,
        window::new_window,
        window::memory_bytes,
        window::page_listening,
        window::startup_report,
        updates::update_state,
        updates::update_check,
        updates::update_restart,
        updates::update_releases,
        release::release_info,
        release::release_history,
        release::donate,
    ]);
    desktop.setup(|app| {
        let handle = app.handle().clone();
        let packaged = !tauri::is_dev();
        let background = std::env::var("STYK_BACKGROUND_WINDOW").as_deref() == Ok("1");
        let user_data = profile::user_data_dir(packaged, handle.path().config_dir().ok());
        std::fs::create_dir_all(&user_data)?;
        let arguments: Vec<String> = std::env::args().skip(1).collect();
        let link = arguments.iter().find(|a| a.to_ascii_lowercase().starts_with("stykanimate://")).cloned();
        let files: Vec<PathBuf> = arguments.iter().filter(|a| openable(a)).map(PathBuf::from).collect();

        let claim = instance::claim(&user_data);
        if !claim.primary && let Some(link) = &link {
            // A link goes to the first window, which handles it; this process has nothing else to do.
            instance::forward(&user_data, link);
            std::process::exit(0);
        }
        let instance_dir = if claim.primary {
            user_data.clone()
        } else {
            profile::workspace_directory(&user_data, std::process::id(), profile::process_alive)?
        };

        let assets = if packaged {
            WebAssets::embedded(&handle)
        } else {
            let bundle = std::env::var_os("STYK_BUNDLE_DIR").map(PathBuf::from);
            WebAssets::disk(&profile::source_root(), bundle.as_deref())?
        };
        let locale = std::fs::read(user_data.join("editor-settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("locale").and_then(Value::as_str).map(str::to_owned));
        text::use_locale(&assets, locale.as_deref());

        let startup_view = match std::env::var("STYK_STARTUP_VIEW").as_deref() {
            Ok("home") => Some("home"),
            Ok("editor") => Some("editor"),
            _ if !files.is_empty() || link.is_some() => Some("editor"),
            _ => None,
        };
        app.manage(Shell {
            packaged,
            background,
            user_data: user_data.clone(),
            instance_dir,
            primary: claim.primary,
            assets: Arc::new(assets),
            startup_view,
            document: Mutex::new(DocumentState::untitled()),
            quitting: AtomicBool::new(false),
            pushes: Mutex::new(PagePushes::default()),
            pending_files: Mutex::new(files),
            pending_link: Mutex::new(link),
            public_library_link: Mutex::new(None),
            open_file: OnceLock::new(),
            page_start: Mutex::new(Vec::new()),
            before_quit: Mutex::new(Vec::new()),
        });
        if claim.primary {
            instance::serve(&handle, claim);
            // Only an installed copy on its real data folder takes over stykanimate:// for the user: a portable copy,
            // a test run (scratch STYK_USER_DATA_DIR) or a build in the source tree leaves the registered app alone.
            if packaged && updates::installed() && std::env::var_os("STYK_USER_DATA_DIR").is_none() {
                links::register_scheme();
            }
        }
        updates::init(&handle);
        Ok(())
    });
    // The window opens after every area's own start-up work, so their state is there for the page's first calls.
    desktop.after_setup(|app| {
        window::create(app.handle())?;
        updates::start(app.handle());
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checkpoints_match_the_document_state_as_today() {
        let state = DocumentState { revision: "r2".into(), dirty: true, ..DocumentState::untitled() };
        assert!(state.action_current(None));
        assert!(!state.action_current(Some(&Value::Null)));
        assert!(state.action_current(Some(&json!({"revision": "r2", "saved": false}))));
        assert!(!state.action_current(Some(&json!({"revision": "r2", "saved": true}))));
        assert!(!state.action_current(Some(&json!({"revision": "r1", "saved": false}))));
        assert!(!state.action_current(Some(&json!({"revision": 2, "saved": false}))));
    }

    #[test]
    fn opens_only_the_files_it_imports() {
        assert!(openable("C:\\a\\Walk.STYK"));
        assert!(openable("x.piv"));
        assert!(!openable("--flag"));
        assert!(!openable("x.exe"));
    }
}
