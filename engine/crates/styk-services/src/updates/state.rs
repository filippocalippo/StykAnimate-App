//! The state the interface shows for updates: `UpdateService` of `desktop/updates.cjs`, status for status.

/// Where the update flow is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateStatus {
    /// Nothing has happened yet.
    Idle,
    /// Looking for a newer release.
    Checking,
    /// Fetching it.
    Downloading,
    /// Up to date.
    Current,
    /// Downloaded, verified, waiting for the person to restart.
    Ready,
    /// Handing over to the installer.
    Restarting,
    /// The last attempt failed.
    Error,
    /// Updates cannot work here.
    Unavailable,
}

impl UpdateStatus {
    /// The name the interface knows it by.
    pub fn name(self) -> &'static str {
        match self {
            UpdateStatus::Idle => "idle",
            UpdateStatus::Checking => "checking",
            UpdateStatus::Downloading => "downloading",
            UpdateStatus::Current => "current",
            UpdateStatus::Ready => "ready",
            UpdateStatus::Restarting => "restarting",
            UpdateStatus::Error => "error",
            UpdateStatus::Unavailable => "unavailable",
        }
    }
}

/// A message shown to the person, with the key it is translated by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Message {
    /// The English text.
    pub text: &'static str,
    /// The localisation key.
    pub key: &'static str,
}

/// The message after a failed attempt.
pub const RETRY_CONNECTION: Message = Message { text: "The update could not be completed. Check your connection and try again.", key: "desktop.updates.retryConnection" };
/// A development copy does not update.
pub const DEVELOPMENT_UNAVAILABLE: Message = Message { text: "Updates are available in the installed app. Development copies do not update.", key: "desktop.updates.developmentUnavailable" };
/// Windows needs the Setup install.
pub const WINDOWS_SETUP_REQUIRED: Message = Message { text: "Install StykAnimate using the Windows Setup installer to enable automatic updates.", key: "desktop.updates.windowsSetupRequired" };
/// Linux needs the AppImage.
pub const LINUX_APPIMAGE_REQUIRED: Message = Message { text: "Run the Linux AppImage to enable automatic updates.", key: "desktop.updates.linuxAppImageRequired" };
/// The AppImage must sit where it can be replaced.
pub const WRITABLE_APPIMAGE_REQUIRED: Message = Message { text: "Move the AppImage to a writable folder, such as Applications in your home folder, and reopen it to enable automatic updates.", key: "desktop.updates.writableAppImageRequired" };
/// Other platforms.
pub const SUPPORTED_INSTALLER_REQUIRED: Message = Message { text: "Automatic updates require the Windows installer or Linux AppImage.", key: "desktop.updates.supportedInstallerRequired" };

/// What the copy being run can do about updates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    /// Windows.
    Windows,
    /// Linux.
    Linux,
    /// Anything else.
    Other,
}

/// What `updateAvailabilityDetails` looks at.
#[derive(Clone, Copy, Debug)]
pub struct Environment {
    /// A packaged build, not a development copy.
    pub packaged: bool,
    /// The platform.
    pub platform: Platform,
    /// Windows: running the portable copy.
    pub portable: bool,
    /// Windows: installed by the Setup (the uninstaller sits beside the program).
    pub installed: bool,
    /// Linux: running from an AppImage.
    pub appimage: bool,
    /// Linux: the AppImage can be replaced where it is.
    pub appimage_writable: bool,
}

/// `None` when updates can work, else why not (`updateAvailabilityDetails`).
pub fn unavailable_reason(env: Environment) -> Option<Message> {
    if !env.packaged {
        return Some(DEVELOPMENT_UNAVAILABLE);
    }
    match env.platform {
        Platform::Linux if !env.appimage => Some(LINUX_APPIMAGE_REQUIRED),
        Platform::Linux if !env.appimage_writable => Some(WRITABLE_APPIMAGE_REQUIRED),
        Platform::Linux => None,
        Platform::Windows if env.portable || !env.installed => Some(WINDOWS_SETUP_REQUIRED),
        Platform::Windows => None,
        Platform::Other => Some(SUPPORTED_INSTALLER_REQUIRED),
    }
}

/// The snapshot the interface reads (`UpdateService.state`).
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateState {
    /// Where the flow is.
    pub status: UpdateStatus,
    /// The running version.
    pub current_version: String,
    /// The version found, while there is one.
    pub version: Option<String>,
    /// Download progress, 0 to 100.
    pub percent: f64,
    /// Bytes downloaded.
    pub transferred: u64,
    /// Bytes to download.
    pub total: u64,
    /// A message for the person, empty if none.
    pub message: String,
    /// Its localisation key, when it has one.
    pub message_key: Option<&'static str>,
}

impl UpdateState {
    /// The state at the start: idle, or unavailable with the reason.
    pub fn new(current_version: &str, unavailable: Option<Message>) -> UpdateState {
        UpdateState {
            status: if unavailable.is_some() { UpdateStatus::Unavailable } else { UpdateStatus::Idle },
            current_version: current_version.to_string(),
            version: None,
            percent: 0.0,
            transferred: 0,
            total: 0,
            message: unavailable.map(|m| m.text.to_string()).unwrap_or_default(),
            message_key: unavailable.map(|m| m.key),
        }
    }

    /// Whether a new check may start: not while one runs, and not once the state is final for this run.
    pub fn may_check(&self, busy: bool) -> bool {
        !busy && !matches!(self.status, UpdateStatus::Unavailable | UpdateStatus::Ready | UpdateStatus::Restarting)
    }

    /// A check starts.
    pub fn checking(&mut self) {
        self.status = UpdateStatus::Checking;
        self.clear_message();
        self.percent = 0.0;
        self.transferred = 0;
        self.total = 0;
    }

    /// A newer release exists and is being downloaded.
    pub fn update_available(&mut self, version: &str) {
        self.status = UpdateStatus::Downloading;
        self.version = Some(version.to_string());
        self.clear_message();
    }

    /// No newer release.
    pub fn not_available(&mut self) {
        self.status = UpdateStatus::Current;
        self.version = None;
        self.clear_message();
    }

    /// Bytes arrived.
    pub fn progress(&mut self, transferred: u64, total: u64) {
        self.status = UpdateStatus::Downloading;
        self.total = total;
        self.transferred = transferred.min(total.max(transferred));
        self.percent = if total == 0 { 0.0 } else { (transferred as f64 / total as f64 * 100.0).clamp(0.0, 100.0) };
    }

    /// The download is complete and verified.
    pub fn downloaded(&mut self, version: &str) {
        self.status = UpdateStatus::Ready;
        self.version = Some(version.to_string());
        self.percent = 100.0;
        self.clear_message();
    }

    /// The attempt failed.
    pub fn failed(&mut self) {
        self.status = UpdateStatus::Error;
        self.message = RETRY_CONNECTION.text.to_string();
        self.message_key = Some(RETRY_CONNECTION.key);
    }

    /// Whether a restart may begin: only from `ready`, and not twice.
    pub fn may_restart(&self, restarting: bool) -> bool {
        self.status == UpdateStatus::Ready && !restarting
    }

    /// The restart began (the close guard said yes).
    pub fn restarting(&mut self) {
        self.status = UpdateStatus::Restarting;
    }

    /// The restart did not happen: back to `ready` if the verified file is still there, else the error.
    pub fn restart_failed(&mut self, file_kept: bool) {
        if file_kept {
            self.status = UpdateStatus::Ready;
            self.message = RETRY_CONNECTION.text.to_string();
            self.message_key = Some(RETRY_CONNECTION.key);
        } else {
            self.failed();
        }
    }

    fn clear_message(&mut self) {
        self.message.clear();
        self.message_key = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Environment {
        Environment { packaged: true, platform: Platform::Windows, portable: false, installed: true, appimage: false, appimage_writable: false }
    }

    #[test]
    fn availability_keeps_todays_four_messages() {
        assert_eq!(unavailable_reason(Environment { packaged: false, ..env() }).unwrap().key, "desktop.updates.developmentUnavailable");
        assert_eq!(unavailable_reason(Environment { portable: true, ..env() }).unwrap().key, "desktop.updates.windowsSetupRequired");
        assert_eq!(unavailable_reason(Environment { installed: false, ..env() }).unwrap().key, "desktop.updates.windowsSetupRequired");
        assert_eq!(unavailable_reason(Environment { platform: Platform::Linux, ..env() }).unwrap().key, "desktop.updates.linuxAppImageRequired");
        assert_eq!(unavailable_reason(Environment { platform: Platform::Linux, appimage: true, ..env() }).unwrap().key, "desktop.updates.writableAppImageRequired");
        assert_eq!(unavailable_reason(Environment { platform: Platform::Linux, appimage: true, appimage_writable: true, ..env() }), None);
        assert_eq!(unavailable_reason(Environment { platform: Platform::Other, ..env() }).unwrap().key, "desktop.updates.supportedInstallerRequired");
        assert_eq!(unavailable_reason(env()), None);
    }

    #[test]
    fn an_unavailable_state_never_checks() {
        let state = UpdateState::new("1.0.0", Some(WINDOWS_SETUP_REQUIRED));
        assert_eq!(state.status.name(), "unavailable");
        assert_eq!(state.message_key, Some("desktop.updates.windowsSetupRequired"));
        assert!(!state.may_check(false));
    }

    #[test]
    fn the_flow_goes_checking_downloading_ready() {
        let mut state = UpdateState::new("1.0.0", None);
        assert!(state.may_check(false) && !state.may_check(true), "a check in progress is not repeated");
        state.checking();
        state.update_available("1.1.0");
        state.progress(50, 200);
        assert_eq!((state.status.name(), state.percent, state.version.as_deref()), ("downloading", 25.0, Some("1.1.0")));
        state.downloaded("1.1.0");
        assert_eq!((state.status.name(), state.percent), ("ready", 100.0));
        assert!(!state.may_check(false), "no more checks once an update is ready");
        assert!(state.may_restart(false) && !state.may_restart(true));
    }

    #[test]
    fn only_ready_may_restart() {
        let mut state = UpdateState::new("1.0.0", None);
        assert!(!state.may_restart(false));
        state.checking();
        assert!(!state.may_restart(false));
        state.not_available();
        assert_eq!(state.status.name(), "current");
        assert!(!state.may_restart(false));
    }

    #[test]
    fn a_failure_says_the_same_words_as_today() {
        let mut state = UpdateState::new("1.0.0", None);
        state.checking();
        state.failed();
        assert_eq!((state.status.name(), state.message_key), ("error", Some("desktop.updates.retryConnection")));
        state.checking();
        assert!(state.message.is_empty() && state.message_key.is_none(), "a new check clears the message");
    }

    #[test]
    fn a_failed_restart_keeps_the_verified_update_when_the_file_is_there() {
        let mut state = UpdateState::new("1.0.0", None);
        state.downloaded("1.1.0");
        state.restarting();
        state.restart_failed(true);
        assert_eq!(state.status, UpdateStatus::Ready);
        state.restarting();
        state.restart_failed(false);
        assert_eq!(state.status, UpdateStatus::Error);
    }

    #[test]
    fn progress_never_exceeds_a_hundred_percent() {
        let mut state = UpdateState::new("1.0.0", None);
        state.progress(300, 200);
        assert_eq!(state.percent, 100.0);
        state.progress(5, 0);
        assert_eq!(state.percent, 0.0);
    }
}
