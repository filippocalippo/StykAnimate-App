//! The program's shell: which instance this is, where the window goes, its chrome, and what later starts ask of it.
//!
//! The contracts are `styk_services::shell`; the Windows implementations are `styk_platform::windows`. This module wires
//! them to the application: it decides at start whether to go on at all (a start that only hands a link to the running
//! program ends here), what frame the window opens at, and keeps the window's frame saved. Unattended runs
//! (`STYK_BACKGROUND_WINDOW`) touch none of it: they take no instance, read no window state and write none.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::ExitCode;
use styk_services::shell::launch::{LaunchRequest, launch_requests};
use styk_services::shell::protocol::looks_like_link;
use styk_services::shell::window_state::{SaveDebounce, SetupKey, WindowFrame, WindowStateFile, default_frame, fit_to_monitors};

#[cfg(windows)]
pub use styk_platform::windows::{chrome::Chrome, monitors::Sample};
#[cfg(windows)]
use styk_platform::windows::{
    instance::{self, Primary, Role},
    monitors::{self, FrameTracker},
};
#[cfg(not(windows))]
pub use stub::{Chrome, Sample};

/// What the other platforms have until their shells land: nothing is attached and nothing is saved.
#[cfg(not(windows))]
mod stub {
    use styk_services::shell::chrome::{ChromeRegions, MaxButtonState};

    /// No chrome.
    #[derive(Clone, Debug)]
    pub struct Chrome;

    impl Chrome {
        pub fn publish(&self, _: ChromeRegions) {}
        pub fn set_fullscreen(&self, _: bool) {}
        pub fn max_button(&self) -> MaxButtonState {
            MaxButtonState::Idle
        }
        pub fn take_toggles(&self) -> u32 {
            0
        }
        pub fn on_change(&self, _: impl Fn() + Send + Sync + 'static) {}
    }

    /// No sample.
    #[derive(Clone, Copy, Debug)]
    pub struct Sample;
}

/// A reason for the event loop to look at the shell again.
#[derive(Clone, Copy, Debug)]
pub enum Wake {
    /// The window's chrome changed (a hover, a click on maximize).
    Chrome,
    /// A later start queued a request.
    Instance,
    /// The quiet period after a window change may have passed.
    SaveCheck,
}

/// Sends wake-ups to the event loop without blocking: when the channel is full a wake is already pending, and what it
/// is for (the chrome's state, the inbox) is read, not replayed.
#[derive(Clone)]
pub struct Wakes(iced::futures::channel::mpsc::Sender<Wake>);

impl Wakes {
    /// A sender and the receiver the event loop listens to.
    pub fn channel() -> (Wakes, iced::futures::channel::mpsc::Receiver<Wake>) {
        let (sender, receiver) = iced::futures::channel::mpsc::channel(16);
        (Wakes(sender), receiver)
    }

    /// Wakes the loop.
    pub fn send(&self, wake: Wake) {
        let _ = self.0.clone().try_send(wake);
    }
}

/// The user data folder: `STYK_USER_DATA_DIR`, else the Electron app's own (`%APPDATA%\StykAnimate`), so settings and
/// recovery files carry over.
pub fn profile_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("STYK_USER_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))).unwrap_or_else(std::env::temp_dir);
    base.join("StykAnimate")
}

/// The command line without our links, which are not files.
pub fn without_links(arguments: &[String]) -> Vec<String> {
    arguments.iter().filter(|argument| !looks_like_link(argument)).cloned().collect()
}

/// How the start went.
pub enum Start {
    /// Go on with this shell.
    Run(Box<Shell>),
    /// End now with this status.
    End(ExitCode),
}

/// The shell of one running program.
pub struct Shell {
    state_path: Option<PathBuf>,
    /// The frame the window opens at, when state is used.
    pub restore: Option<WindowFrame>,
    /// The recovery directory of an independent editor.
    pub workspace: Option<PathBuf>,
    /// What this start itself asked for, then what later starts sent, until the core takes them.
    pub pending: VecDeque<LaunchRequest>,
    #[cfg(windows)]
    primary: Option<Primary>,
    #[cfg(windows)]
    tracker: FrameTracker,
    debounce: SaveDebounce,
    check_scheduled: bool,
    started: std::time::Instant,
}

/// Decides what this process is and what frame its window opens at.
pub fn start(arguments: &[String], unattended: bool, wakes: &Wakes) -> Start {
    let requests = launch_requests(arguments);
    let mut shell = Shell {
        state_path: None,
        restore: None,
        workspace: None,
        pending: requests.iter().cloned().collect(),
        #[cfg(windows)]
        primary: None,
        #[cfg(windows)]
        tracker: FrameTracker::default(),
        debounce: SaveDebounce::default(),
        check_scheduled: false,
        started: std::time::Instant::now(),
    };
    if unattended {
        return Start::Run(Box::new(shell));
    }
    let profile = profile_dir();
    let _ = std::fs::create_dir_all(&profile);
    #[cfg(windows)]
    {
        use styk_services::shell::instance::ProfileId;
        let id = ProfileId::of(&profile);
        let link = requests.iter().find(|request| matches!(request, LaunchRequest::Protocol(_)));
        let wake = wakes.clone();
        match instance::acquire(&id, link, move || wake.send(Wake::Instance)) {
            Role::Forwarded => return Start::End(ExitCode::SUCCESS),
            Role::Refused => {
                eprintln!("the running program refused the request");
                return Start::End(ExitCode::FAILURE);
            }
            Role::Independent => {
                shell.workspace = workspace_directory(&profile);
            }
            Role::Primary(primary) => shell.primary = Some(primary),
        }
        let monitors = monitors::monitors();
        shell.state_path = Some(profile.join("window-state.txt"));
        let file = std::fs::read_to_string(shell.state_path.as_ref().expect("just set")).map(|text| WindowStateFile::parse(&text)).unwrap_or_default();
        let saved = file.frame_for(SetupKey::of(&monitors));
        shell.restore = saved.and_then(|frame| fit_to_monitors(&frame, &monitors)).or_else(|| default_frame(&monitors));
    }
    #[cfg(not(windows))]
    let _ = wakes;
    Start::Run(Box::new(shell))
}

#[cfg(windows)]
fn workspace_directory(profile: &std::path::Path) -> Option<PathBuf> {
    use styk_platform::windows::updates::process_alive;
    use styk_services::shell::instance::{RenameFailure, WorkspaceEntry, WorkspaceFs, workspace_directory};
    struct RealFs;
    impl WorkspaceFs for RealFs {
        fn create_dir_all(&self, path: &std::path::Path) -> std::io::Result<()> {
            std::fs::create_dir_all(path)
        }
        fn exists(&self, path: &std::path::Path) -> bool {
            path.exists()
        }
        fn entries(&self, path: &std::path::Path) -> std::io::Result<Vec<WorkspaceEntry>> {
            Ok(std::fs::read_dir(path)?.flatten().map(|entry| WorkspaceEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir: entry.file_type().is_ok_and(|t| t.is_dir()) }).collect())
        }
        fn rename(&self, from: &std::path::Path, to: &std::path::Path) -> Result<(), RenameFailure> {
            std::fs::rename(from, to).map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => RenameFailure::Missing,
                std::io::ErrorKind::AlreadyExists => RenameFailure::Exists,
                std::io::ErrorKind::PermissionDenied => RenameFailure::Denied,
                _ => RenameFailure::Other,
            })
        }
    }
    workspace_directory(&RealFs, profile, std::process::id(), &process_alive).ok()
}

impl Shell {
    /// Takes what later starts have sent into `pending`; true if any arrived.
    pub fn collect_requests(&mut self) -> bool {
        #[cfg(windows)]
        if let Some(primary) = &self.primary {
            let before = self.pending.len();
            while let Some(request) = primary.inbox.pop() {
                self.pending.push_back(request);
            }
            return self.pending.len() > before;
        }
        false
    }

    /// The window changed; a save is due after the quiet period.
    pub fn changed(&mut self, wakes: &Wakes) {
        if self.state_path.is_some() {
            self.debounce.changed(self.started.elapsed().as_millis() as u64);
            self.schedule_check(wakes);
        }
    }

    fn schedule_check(&mut self, wakes: &Wakes) {
        if !self.check_scheduled {
            self.check_scheduled = true;
            let wakes = wakes.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(styk_services::shell::window_state::SAVE_DELAY_MS));
                wakes.send(Wake::SaveCheck);
            });
        }
    }

    /// The quiet period may have passed: save if it has, else look again later.
    pub fn save_check(&mut self, wakes: &Wakes) {
        self.check_scheduled = false;
        if self.debounce.due(self.started.elapsed().as_millis() as u64) {
            self.save_in_background();
        } else if self.debounce.pending() {
            self.schedule_check(wakes);
        }
    }

    /// The window is closing: save what is pending, now.
    pub fn save_now(&mut self) {
        if self.debounce.pending() {
            let _ = self.debounce.due(u64::MAX);
            self.save();
        }
    }

    fn snapshot(&self) -> Option<(PathBuf, WindowFrame)> {
        #[cfg(windows)]
        return Some((self.state_path.clone()?, self.tracker.frame()?));
        #[cfg(not(windows))]
        None
    }

    fn save_in_background(&self) {
        if let Some((path, frame)) = self.snapshot() {
            std::thread::spawn(move || write_state(&path, frame));
        }
    }

    fn save(&self) {
        if let Some((path, frame)) = self.snapshot() {
            write_state(&path, frame);
        }
    }

    /// A sample of the window was taken.
    pub fn observe(&mut self, sample: Sample) {
        #[cfg(windows)]
        self.tracker.observe(sample);
        #[cfg(not(windows))]
        let _ = sample;
    }

    /// The window was put at this frame.
    pub fn assume(&mut self, frame: &WindowFrame) {
        #[cfg(windows)]
        self.tracker.assume(frame);
        #[cfg(not(windows))]
        let _ = frame;
    }

}

/// Reads the file, records the frame, and replaces the file atomically (a temporary file, then a rename).
fn write_state(path: &std::path::Path, frame: WindowFrame) {
    #[cfg(windows)]
    {
        let monitors = monitors::monitors();
        let mut file = std::fs::read_to_string(path).map(|text| WindowStateFile::parse(&text)).unwrap_or_default();
        file.record(SetupKey::of(&monitors), frame);
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let temporary = path.with_extension(format!("tmp{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        if std::fs::write(&temporary, file.to_text()).and_then(|()| std::fs::rename(&temporary, path)).is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
    #[cfg(not(windows))]
    let _ = (path, frame);
}

/// What attaching the shell to the open window produced.
#[derive(Clone)]
pub struct Attached {
    /// The window's chrome.
    pub chrome: Chrome,
    /// How the window looked right after.
    pub sample: Sample,
    /// The frame it was put at, when one was applied.
    pub applied: Option<WindowFrame>,
}

impl std::fmt::Debug for Attached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attached").field("sample", &self.sample).field("applied", &self.applied).finish()
    }
}

/// Attaches the chrome to the window; when `show` says this run owns the showing, puts the window at `frame` (else where it is) and shows it.
/// Runs on the window's thread.
#[cfg(windows)]
pub fn attach(window: &dyn iced::window::Window, frame: Option<WindowFrame>, show: bool) -> Result<Attached, String> {
    let chrome = styk_platform::windows::chrome::attach(window).map_err(|e| e.to_string())?;
    let hwnd = monitors::hwnd_of(window).ok_or("not a Windows window")?;
    let applied = if show {
        match frame {
            Some(frame) => {
                monitors::apply_frame(hwnd, &frame, true);
                Some(frame)
            }
            None => {
                monitors::show_normal(hwnd);
                None
            }
        }
    } else {
        None
    };
    Ok(Attached { chrome, sample: monitors::sample(hwnd), applied })
}

/// No shell on this platform yet.
#[cfg(not(windows))]
pub fn attach(_: &dyn iced::window::Window, _: Option<WindowFrame>, _: bool) -> Result<Attached, String> {
    Ok(Attached { chrome: Chrome, sample: Sample, applied: None })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use styk_services::shell::Rect;

    fn frame(x: i32) -> WindowFrame {
        WindowFrame { rect: Rect::new(x, 20, 1234, 777), maximized: false, scale_milli: 1000 }
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("styk-shell-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_saved_frame_comes_back_exactly_for_this_monitor_setup() {
        let dir = temp("roundtrip");
        let path = dir.join("window-state.txt");
        write_state(&path, frame(111));
        let file = WindowStateFile::parse(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(file.frame_for(SetupKey::of(&monitors::monitors())), Some(frame(111)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_starts_saving_at_the_same_time_leave_a_valid_file() {
        let dir = temp("race");
        let path = dir.join("window-state.txt");
        std::thread::scope(|scope| {
            for worker in 0..2 {
                let path = path.clone();
                scope.spawn(move || {
                    for n in 0..40 {
                        write_state(&path, frame(worker * 1000 + n));
                    }
                });
            }
        });
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(WindowStateFile::parse(&text).last.is_some(), "the file is whole: {text:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_link_is_not_mistaken_for_a_file_on_the_command_line() {
        let arguments = vec!["stykanimate://library/abcdefghij".to_string(), "a.piv".to_string()];
        assert_eq!(without_links(&arguments), vec!["a.piv".to_string()]);
    }
}
