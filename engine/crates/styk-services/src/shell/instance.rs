//! Which process is the primary, and where a secondary keeps its recovery files.
//!
//! Today (`desktop/main.cjs`, `workspace-instance.cjs`): the lock belongs to the profile directory; a second process is
//! an independent editor with its own `workspaces/<pid>` directory (reusing the one of a dead process), except that a
//! protocol link goes to the primary and the process that carried it ends.
//!
//! A named mutex is not proof that a primary is alive: the object lives until its last handle closes. So a secondary
//! releases its handle at once, and a forwarder trusts only an acknowledgement from the primary's pipe; a primary that
//! is gone, or that dies mid-forward, leads to another election and then to handling the request itself.

use super::launch::LaunchRequest;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Names the profile (user data) directory in the names of the mutex and the pipe: the same directory gives the same id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileId(String);

impl ProfileId {
    /// The id of a profile directory. Case and the kind of slash do not matter on Windows, so they do not change it.
    pub fn of(directory: &Path) -> ProfileId {
        let text: String = directory.to_string_lossy().chars().map(|c| if c == '/' { '\\' } else { c.to_ascii_lowercase() }).collect();
        let text = text.trim_end_matches('\\');
        ProfileId(format!("{:016x}", fnv1a(text.as_bytes())))
    }

    /// The id as hexadecimal text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The mutex name: `Local\StykAnimate-<id>`.
    pub fn mutex_name(&self) -> String {
        format!("Local\\StykAnimate-{}", self.0)
    }

    /// The pipe name: `\\.\pipe\StykAnimate-<id>`.
    pub fn pipe_name(&self) -> String {
        format!("\\\\.\\pipe\\StykAnimate-{}", self.0)
    }
}

/// FNV-1a, 64 bit: stable across runs and builds, which `std`'s hashers are not promised to be.
pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// The operating system's named lock.
pub trait Locker {
    /// What holding the lock means; dropping it releases the lock.
    type Held;
    /// Takes the lock if nobody holds it. When it is taken, no handle is kept.
    fn try_acquire(&self) -> Option<Self::Held>;
}

/// The result of handing a request to the primary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// The primary has queued the request.
    Acked,
    /// The primary is there but its queue is full.
    Busy,
    /// No primary answered: absent, dead, died mid-way, or silent past the deadline.
    NoServer,
    /// The primary refused the request for good.
    Refused,
}

/// Hands a request to whoever serves the pipe.
pub trait Courier {
    /// Sends one request and waits for the answer, within the courier's own deadline.
    fn deliver(&self, request: &LaunchRequest) -> Delivery;
}

/// How long and how often the election tries.
#[derive(Clone, Copy, Debug)]
pub struct ElectionPolicy {
    /// Rounds of "take the lock, else deliver".
    pub rounds: u32,
    /// Waiting before the next round after a dead or busy primary (doubled each round, up to `max_pause`).
    pub pause: Duration,
    /// The longest single wait.
    pub max_pause: Duration,
}

impl Default for ElectionPolicy {
    fn default() -> Self {
        ElectionPolicy { rounds: 8, pause: Duration::from_millis(25), max_pause: Duration::from_millis(400) }
    }
}

/// How the election ended.
#[derive(Debug)]
pub enum Election<H> {
    /// This process is the primary and keeps the lock; any request it carried is its own to handle.
    Primary(H),
    /// The primary acknowledged the request: this process ends.
    Forwarded,
    /// Not the primary and nothing to forward (or the primary could not be reached within the bound): an independent
    /// editor with its own workspace directory, which handles its own request.
    Independent,
    /// The primary refused the request for good.
    Refused,
}

/// Decides this process's role.
///
/// Without a request to forward (an ordinary launch) it takes the lock or is independent, once. With one it repeats
/// "take the lock, else deliver" until the primary acknowledges, the lock is free, or the rounds are spent; `sleep` is
/// how it waits, so tests do not.
pub fn elect<L: Locker, C: Courier>(locker: &L, courier: &C, request: Option<&LaunchRequest>, policy: ElectionPolicy, sleep: &mut dyn FnMut(Duration)) -> Election<L::Held> {
    let Some(request) = request else {
        return match locker.try_acquire() {
            Some(held) => Election::Primary(held),
            None => Election::Independent,
        };
    };
    let mut pause = policy.pause;
    for round in 0..policy.rounds.max(1) {
        if let Some(held) = locker.try_acquire() {
            return Election::Primary(held);
        }
        match courier.deliver(request) {
            Delivery::Acked => return Election::Forwarded,
            Delivery::Refused => return Election::Refused,
            Delivery::Busy | Delivery::NoServer => {
                if round + 1 < policy.rounds.max(1) {
                    sleep(pause);
                    pause = (pause * 2).min(policy.max_pause);
                }
            }
        }
    }
    Election::Independent
}

/// What a directory listing says about an entry of `workspaces/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEntry {
    /// The entry's name.
    pub name: String,
    /// Whether it is a directory.
    pub is_dir: bool,
}

/// Why a rename did not happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenameFailure {
    /// The source is gone (another process took it first).
    Missing,
    /// The target exists.
    Exists,
    /// Refused or busy.
    Denied,
    /// Anything else: the caller gives up.
    Other,
}

/// The file operations `workspace_directory` needs.
pub trait WorkspaceFs {
    /// Creates a directory and its parents.
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()>;
    /// Whether the path exists.
    fn exists(&self, path: &Path) -> bool;
    /// The entries of a directory.
    fn entries(&self, path: &Path) -> std::io::Result<Vec<WorkspaceEntry>>;
    /// Renames a directory.
    fn rename(&self, from: &Path, to: &Path) -> Result<(), RenameFailure>;
}

/// The recovery directory of this process, `<profile>/workspaces/<pid>` (`workspace-instance.cjs`): the directory if it
/// exists; else a numerically named directory whose process is gone, renamed to this pid; else a new one.
pub fn workspace_directory(fs: &dyn WorkspaceFs, profile: &Path, pid: u32, alive: &dyn Fn(u32) -> bool) -> std::io::Result<PathBuf> {
    let root = profile.join("workspaces");
    let directory = root.join(pid.to_string());
    fs.create_dir_all(&root)?;
    if fs.exists(&directory) {
        return Ok(directory);
    }
    for entry in fs.entries(&root)? {
        let Ok(other) = entry.name.parse::<u32>() else { continue };
        if !entry.is_dir || entry.name.chars().any(|c| !c.is_ascii_digit()) || alive(other) {
            continue;
        }
        match fs.rename(&root.join(&entry.name), &directory) {
            Ok(()) => return Ok(directory),
            Err(RenameFailure::Other) => return Err(std::io::Error::other("a workspace directory could not be renamed")),
            Err(_) => {}
        }
    }
    fs.create_dir_all(&directory)?;
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;

    struct FakeLocker {
        free_after: Cell<u32>,
        calls: Cell<u32>,
    }

    impl Locker for FakeLocker {
        type Held = &'static str;
        fn try_acquire(&self) -> Option<&'static str> {
            let call = self.calls.get();
            self.calls.set(call + 1);
            (call >= self.free_after.get()).then_some("held")
        }
    }

    struct Script(RefCell<Vec<Delivery>>, Cell<u32>);

    impl Courier for Script {
        fn deliver(&self, _: &LaunchRequest) -> Delivery {
            self.1.set(self.1.get() + 1);
            let mut script = self.0.borrow_mut();
            if script.len() > 1 { script.remove(0) } else { script[0] }
        }
    }

    fn open() -> LaunchRequest {
        LaunchRequest::Protocol(super::super::protocol::ProtocolLink::Open)
    }

    fn run(free_after: u32, script: Vec<Delivery>, request: Option<&LaunchRequest>) -> (Election<&'static str>, u32, Vec<Duration>) {
        let locker = FakeLocker { free_after: Cell::new(free_after), calls: Cell::new(0) };
        let courier = Script(RefCell::new(script), Cell::new(0));
        let mut sleeps = Vec::new();
        let election = elect(&locker, &courier, request, ElectionPolicy::default(), &mut |d| sleeps.push(d));
        (election, courier.1.get(), sleeps)
    }

    #[test]
    fn the_first_launch_is_the_primary() {
        assert!(matches!(run(0, vec![Delivery::NoServer], Some(&open())).0, Election::Primary("held")));
        assert!(matches!(run(0, vec![Delivery::NoServer], None).0, Election::Primary(_)));
    }

    #[test]
    fn an_ordinary_second_launch_is_independent_and_forwards_nothing() {
        let (election, delivered, sleeps) = run(u32::MAX, vec![Delivery::Acked], None);
        assert!(matches!(election, Election::Independent));
        assert_eq!((delivered, sleeps.len()), (0, 0));
    }

    #[test]
    fn a_link_is_forwarded_and_the_forwarder_ends_only_on_the_acknowledgement() {
        let (election, delivered, _) = run(u32::MAX, vec![Delivery::Acked], Some(&open()));
        assert!(matches!(election, Election::Forwarded));
        assert_eq!(delivered, 1);
    }

    #[test]
    fn a_busy_primary_is_retried_with_a_growing_pause() {
        let (election, delivered, sleeps) = run(u32::MAX, vec![Delivery::Busy, Delivery::Busy, Delivery::Busy, Delivery::Acked], Some(&open()));
        assert!(matches!(election, Election::Forwarded));
        assert_eq!(delivered, 4);
        assert_eq!(sleeps, vec![Duration::from_millis(25), Duration::from_millis(50), Duration::from_millis(100)]);
    }

    #[test]
    fn a_dead_primary_whose_mutex_lingers_is_replaced_by_the_forwarder_itself() {
        // Launch A, launch B, kill A: C finds the lock taken by a handle that is about to close, hears nothing on the
        // pipe, retries, and gets the lock on the third round. It becomes the primary and handles the link locally.
        let (election, delivered, sleeps) = run(2, vec![Delivery::NoServer], Some(&open()));
        assert!(matches!(election, Election::Primary("held")));
        assert_eq!(delivered, 2);
        assert_eq!(sleeps.len(), 2);
    }

    #[test]
    fn a_primary_that_dies_mid_forward_does_not_lose_the_link() {
        // The first delivery meets a pipe that breaks before the acknowledgement (NoServer); by the next round the
        // primary's handle is gone, so the forwarder takes the lock and handles the link itself.
        let (election, delivered, _) = run(1, vec![Delivery::NoServer], Some(&open()));
        assert!(matches!(election, Election::Primary(_)));
        assert_eq!(delivered, 1);
    }

    #[test]
    fn a_silent_primary_forever_ends_independent_within_the_bound() {
        let (election, delivered, sleeps) = run(u32::MAX, vec![Delivery::NoServer], Some(&open()));
        assert!(matches!(election, Election::Independent));
        assert_eq!(delivered, ElectionPolicy::default().rounds);
        assert_eq!(sleeps.len() as u32, ElectionPolicy::default().rounds - 1);
        assert!(sleeps.iter().all(|pause| *pause <= Duration::from_millis(400)));
    }

    #[test]
    fn a_refusal_is_final() {
        assert!(matches!(run(u32::MAX, vec![Delivery::Refused], Some(&open())).0, Election::Refused));
    }

    #[test]
    fn the_profile_id_ignores_case_and_slashes_but_not_the_directory() {
        let a = ProfileId::of(Path::new("C:/Users/Me/AppData/Roaming/StykAnimate"));
        assert_eq!(a, ProfileId::of(Path::new("c:\\users\\me\\appdata\\roaming\\stykanimate\\")));
        assert_ne!(a, ProfileId::of(Path::new("C:/Users/Me/AppData/Roaming/Other")));
        assert!(a.mutex_name().starts_with("Local\\StykAnimate-") && a.pipe_name().starts_with("\\\\.\\pipe\\StykAnimate-"));
        assert_eq!(a.as_str().len(), 16);
    }

    #[derive(Default)]
    struct FakeFs {
        dirs: RefCell<BTreeSet<PathBuf>>,
        files: RefCell<BTreeSet<PathBuf>>,
        deny: RefCell<BTreeSet<PathBuf>>,
    }

    impl WorkspaceFs for FakeFs {
        fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
            let mut dirs = self.dirs.borrow_mut();
            for ancestor in path.ancestors() {
                dirs.insert(ancestor.to_path_buf());
            }
            Ok(())
        }
        fn exists(&self, path: &Path) -> bool {
            self.dirs.borrow().contains(path) || self.files.borrow().contains(path)
        }
        fn entries(&self, path: &Path) -> std::io::Result<Vec<WorkspaceEntry>> {
            let name = |p: &PathBuf| p.file_name().unwrap().to_string_lossy().into_owned();
            let mut out: Vec<_> = self.dirs.borrow().iter().filter(|p| p.parent() == Some(path)).map(|p| WorkspaceEntry { name: name(p), is_dir: true }).collect();
            out.extend(self.files.borrow().iter().filter(|p| p.parent() == Some(path)).map(|p| WorkspaceEntry { name: name(p), is_dir: false }));
            Ok(out)
        }
        fn rename(&self, from: &Path, to: &Path) -> Result<(), RenameFailure> {
            if self.deny.borrow().contains(from) {
                return Err(RenameFailure::Denied);
            }
            let mut dirs = self.dirs.borrow_mut();
            if !dirs.remove(from) {
                return Err(RenameFailure::Missing);
            }
            dirs.insert(to.to_path_buf());
            Ok(())
        }
    }

    fn fs_with(names: &[&str]) -> FakeFs {
        let fs = FakeFs::default();
        for name in names {
            fs.create_dir_all(&Path::new("P/workspaces").join(name)).unwrap();
        }
        fs
    }

    #[test]
    fn an_existing_directory_of_this_pid_is_kept() {
        let fs = fs_with(&["100", "200"]);
        assert_eq!(workspace_directory(&fs, Path::new("P"), 100, &|_| false).unwrap(), Path::new("P/workspaces/100"));
        assert!(fs.exists(Path::new("P/workspaces/200")), "nothing else is touched");
    }

    #[test]
    fn the_directory_of_a_dead_process_is_taken_over_and_a_live_one_is_not() {
        let fs = fs_with(&["100", "200"]);
        let dir = workspace_directory(&fs, Path::new("P"), 300, &|pid| pid == 100).unwrap();
        assert_eq!(dir, Path::new("P/workspaces/300"));
        assert!(fs.exists(Path::new("P/workspaces/100")), "100 is alive and keeps its directory");
        assert!(!fs.exists(Path::new("P/workspaces/200")) && fs.exists(&dir), "200 was dead and became 300");
    }

    #[test]
    fn a_fresh_directory_is_made_when_every_other_is_alive_and_odd_names_are_ignored() {
        let fs = fs_with(&["100", "notes", "12a"]);
        let dir = workspace_directory(&fs, Path::new("P"), 5, &|_| true).unwrap();
        assert_eq!(dir, Path::new("P/workspaces/5"));
        assert!(fs.exists(&dir) && fs.exists(Path::new("P/workspaces/notes")) && fs.exists(Path::new("P/workspaces/12a")));
    }

    #[test]
    fn a_refused_rename_moves_on_to_the_next_dead_directory() {
        let fs = fs_with(&["100", "200"]);
        fs.deny.borrow_mut().insert(PathBuf::from("P/workspaces/100"));
        let dir = workspace_directory(&fs, Path::new("P"), 7, &|_| false).unwrap();
        assert!(fs.exists(&dir) && fs.exists(Path::new("P/workspaces/100")) && !fs.exists(Path::new("P/workspaces/200")));
    }
}
