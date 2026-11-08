use super::*;
use crate::files::{WRITE_FAILURE, WRITE_OBSERVER, WriteStep};
use crate::spawn::ThreadSpawner;
use crate::video::process::{self, ChildGuard, ChildPipes};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

const HANG: Duration = Duration::from_secs(60);
const NAME: &str = "preferences.json";
static SERIAL: AtomicU64 = AtomicU64::new(0);
thread_local! {
    static WAIT_OBSERVER: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
    static OPEN_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
pub(super) fn observe_open(opened: std::io::Result<File>) -> std::io::Result<File> {
    if OPEN_FAILURE.with(|fail| fail.replace(false)) {
        // Reproduce the observed Windows open result once, without replacing the real writer
        // or creating a non-atomic rename in test code. The next open goes to the real file.
        assert!(opened.is_ok(), "the seeded destination must exist");
        Err(std::io::Error::from_raw_os_error(2))
    } else {
        opened
    }
}
pub(super) fn observe_wait() {
    WAIT_OBSERVER.with(|observer| {
        if let Some(observer) = observer.borrow().as_ref() {
            observer();
        }
    });
}

struct Folder(PathBuf);
impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "styk-storage-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn seed(&self) {
        fs::write(self.0.join(NAME), b"[7]").unwrap();
    }
    fn unchanged(&self) {
        assert_eq!(fs::read(self.0.join(NAME)).unwrap(), b"[7]");
        let names: BTreeSet<_> = fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            names,
            BTreeSet::from([NAME.to_string(), LOCK_NAME.to_string()])
        );
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        for name in [NAME, LOCK_NAME, "window-state.txt", ".styk-doc-unrelated.tmp"] {
            match fs::remove_file(self.0.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => panic!("remove test file {name}: {e}"),
            }
        }
        fs::remove_dir(&self.0).unwrap();
    }
}

/// The worker's real boundaries, instrumented only on this test's thread. Teardown waits on the
/// test thread, never in LocalStorage or a future's Drop; a timeout is a hang guard, not a latency score.
struct TestSpawner {
    setup: Mutex<Option<styk_services::Job>>,
    ended: Mutex<Option<Receiver<()>>>,
}
impl TestSpawner {
    fn new(setup: impl FnOnce() + Send + 'static) -> Self {
        Self {
            setup: Mutex::new(Some(Box::new(setup))),
            ended: Mutex::new(None),
        }
    }
}
impl Spawner for TestSpawner {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        let setup = self.setup.lock().unwrap().take().unwrap();
        let (send, receive) = channel();
        *self.ended.lock().unwrap() = Some(receive);
        ThreadSpawner.spawn(
            name,
            Box::new(move || {
                setup();
                job();
                send.send(()).unwrap();
            }),
        )
    }
}
impl Drop for TestSpawner {
    fn drop(&mut self) {
        if let Some(receive) = self.ended.lock().unwrap().take() {
            receive.recv_timeout(HANG).unwrap();
        }
    }
}

fn poll<T>(future: &mut FileFuture<'_, T>) -> Poll<Result<T, FileError>> {
    future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
}

fn finish<T>(future: impl Future<Output = T>) -> T {
    struct Wake(SyncSender<()>);
    impl std::task::Wake for Wake {
        fn wake(self: Arc<Self>) {
            let _ = self.0.try_send(());
        }
    }
    let (send, receive) = sync_channel(1);
    let waker = Waker::from(Arc::new(Wake(send)));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    let deadline = Instant::now() + HANG;
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(result) => return result,
            Poll::Pending => receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("storage future hung"),
        }
    }
}

#[test]
fn missing_open_during_replacement_waits_for_commit_before_reporting_absence() {
    missing_during_replacement(true);
}

#[test]
fn missing_first_publication_waits_for_the_in_flight_writer() {
    missing_during_replacement(false);
}

fn missing_during_replacement(existing: bool) {
    let folder = Folder::new();
    if existing { folder.seed(); }
    let (staged, reached) = channel();
    let (release, gate) = channel();
    let writer_spawner = TestSpawner::new(move || {
        WRITE_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move |step, _, _| {
                if step == WriteStep::Flushed {
                    staged.send(()).unwrap();
                    gate.recv_timeout(HANG).unwrap();
                }
            }));
        });
    });
    let writer = LocalStorage::new(&folder.0, &writer_spawner).unwrap();
    let cancel = Cancel::new();
    let mut write = writer.update(NAME, 32, Box::new(|_| Ok(b"[8]".to_vec())), &cancel);
    assert!(poll(&mut write).is_pending());
    reached.recv_timeout(HANG).unwrap();

    // Either the reader waits for the real writer's lock or it incorrectly returns None.
    // One channel orders those outcomes, so the fail-first case needs no sleep or timeout.
    let (events, receive) = channel();
    let waiting = events.clone();
    let reader_spawner = TestSpawner::new(move || {
        OPEN_FAILURE.with(|fail| fail.set(existing));
        WAIT_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move || { let _ = waiting.send(true); }));
        });
    });
    let reader = LocalStorage::new(&folder.0, &reader_spawner).unwrap();
    let (waited, result) = std::thread::scope(|scope| {
        let read = scope.spawn(|| {
            let result = finish(reader.load(NAME, 32));
            events.send(false).unwrap();
            result
        });
        let waited = receive.recv_timeout(HANG).unwrap();
        release.send(()).unwrap();
        finish(write).unwrap();
        (waited, read.join().unwrap())
    });
    assert!(waited, "a transient missing open escaped while replacement held the lock: {result:?}");
    assert_eq!(&*result.unwrap().expect("committed file"), b"[8]");
}

#[test]
fn dropping_a_missing_read_wakes_its_lock_wait_without_creating_files() {
    let folder = Folder::new();
    let held = acquire(&folder.0, &Cancel::new()).unwrap();
    let (waiting, reached) = sync_channel(1);
    let spawner = TestSpawner::new(move || {
        WAIT_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move || { let _ = waiting.try_send(()); }));
        });
    });
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let mut read = storage.load(NAME, 32);
    assert!(poll(&mut read).is_pending());
    reached.recv_timeout(HANG).unwrap();
    drop(read);
    // A successful handle read needs no lock. Its completion before releasing the holder
    // proves that dropping the previous future woke the blocked worker.
    fs::write(folder.0.join(NAME), b"[7]").unwrap();
    assert_eq!(&*finish(storage.load(NAME, 32)).unwrap().unwrap(), b"[7]");
    drop(held);
    fs::remove_file(folder.0.join(NAME)).unwrap();
    assert!(finish(storage.load(NAME, 32)).unwrap().is_none());
    assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 1, "only the existing lock remains");
}

#[test]
fn gated_replacements_keep_old_handles_and_every_read_complete() {
    let folder = Folder::new();
    folder.seed();
    let (steps, reached) = channel();
    let (release, gate) = channel();
    let writer_spawner = TestSpawner::new(move || {
        WRITE_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move |step, _, _| {
                steps.send(step).unwrap();
                gate.recv_timeout(HANG).unwrap();
            }));
        });
    });
    let writer = LocalStorage::new(&folder.0, &writer_spawner).unwrap();
    let reader_spawner = TestSpawner::new(|| {});
    let reader = LocalStorage::new(&folder.0, &reader_spawner).unwrap();
    let target = FileTarget::new(folder.0.join(NAME));
    let mut previous = b"[7]".to_vec();
    for generation in 0..128 {
        let next = format!("[{generation},{}]", "9,".repeat(400).trim_end_matches(',')).into_bytes();
        let proposed = next.clone();
        // Keep this read handle alive across the rename, forcing Windows' open-reader case.
        let old = File::open(target.path()).unwrap();
        let cancel = Cancel::new();
        let mut write = writer.update(NAME, 8192, Box::new(move |_| Ok(proposed)), &cancel);
        assert!(poll(&mut write).is_pending());
        let mut observations = Vec::new();
        loop {
            let step = reached.recv_timeout(HANG).unwrap();
            let stored = finish(reader.load(NAME, 8192));
            let document = run_future(LocalFiles.read(&target, 8192, &Cancel::new()));
            observations.push((step, stored, document));
            release.send(()).unwrap();
            if step == WriteStep::Renamed { break; }
        }
        finish(write).unwrap();
        assert_eq!(&*read_bounded(old, 8192, &Cancel::new()).unwrap(), previous);
        for (step, stored, document) in observations {
            let expected = if step == WriteStep::Renamed { &next } else { &previous };
            assert_eq!(&*stored.unwrap().expect("replacement must not lose the path"), expected, "{step:?}");
            assert_eq!(&*document.unwrap(), expected, "{step:?}");
        }
        previous = next;
    }
}

#[test]
fn missing_load_creates_nothing_and_names_cannot_escape_the_store() {
    let folder = Folder::new();
    let missing = folder.0.join("missing");
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&missing, &spawner).unwrap();
    assert!(finish(storage.load(NAME, 32)).unwrap().is_none());
    for name in [
        "",
        "../escape",
        "C:\\escape",
        "x:stream",
        ".storage.lock",
        "CON.json",
        "lpt9",
        "trailing.",
        "a/b",
    ] {
        assert!(
            finish(storage.update(
                name,
                32,
                Box::new(|_| panic!("invalid name reached callback")),
                &Cancel::new()
            ))
            .is_err(),
            "{name}"
        );
    }
    assert!(!missing.exists());
}

#[test]
fn input_and_existing_file_limits_refuse_before_replacement() {
    let folder = Folder::new();
    folder.seed();
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    assert_eq!(finish(storage.load(NAME, 2)), Err(FileError::TooLarge));
    assert_eq!(
        finish(storage.update(
            NAME,
            2,
            Box::new(|_| panic!("oversized input reached callback")),
            &Cancel::new()
        )),
        Err(FileError::TooLarge)
    );
    folder.unchanged();
    assert_eq!(
        finish(storage.update(
            NAME,
            3,
            Box::new(|old| {
                assert_eq!(old.unwrap(), b"[7]");
                Ok(vec![0; 4])
            }),
            &Cancel::new()
        )),
        Err(FileError::TooLarge)
    );
    folder.unchanged();
    assert!(
        finish(storage.update(
            NAME,
            32,
            Box::new(|_| Err("merge refused".into())),
            &Cancel::new()
        ))
        .is_err()
    );
    folder.unchanged();
    finish(storage.update(NAME, 3, Box::new(|_| Ok(b"[8]".to_vec())), &Cancel::new())).unwrap();
    assert_eq!(&*finish(storage.load(NAME, 3)).unwrap().unwrap(), b"[8]");
}

#[test]
fn staging_and_flush_failures_preserve_bytes_and_remove_only_owned_staging() {
    for step in [WriteStep::Created, WriteStep::Written, WriteStep::Flushed] {
        let folder = Folder::new();
        folder.seed();
        fs::write(folder.0.join(".styk-doc-unrelated.tmp"), b"unrelated").unwrap();
        let spawner =
            TestSpawner::new(move || WRITE_FAILURE.with(|failure| failure.set(Some(step))));
        let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
        assert_eq!(
            finish(storage.update(NAME, 32, Box::new(|_| Ok(b"[8]".to_vec())), &Cancel::new())),
            Err(FileError::Full)
        );
        assert_eq!(
            fs::read(folder.0.join(".styk-doc-unrelated.tmp")).unwrap(),
            b"unrelated"
        );
        fs::remove_file(folder.0.join(".styk-doc-unrelated.tmp")).unwrap();
        folder.unchanged();
    }
}

#[test]
fn refused_windows_replacement_preserves_bytes_and_cleans_the_stage() {
    let folder = Folder::new();
    folder.seed();
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    // Read sharing allows the merge, but this real OS handle denies deletion/replacement.
    let held = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(folder.0.join(NAME))
        .unwrap();
    let cancel = Cancel::new();
    assert!(finish(storage.update(NAME, 32, Box::new(|_| Ok(b"[8]".to_vec())), &cancel)).is_err());
    assert!(
        !cancel.cancel(),
        "the actual replacement failed after begin_commit"
    );
    folder.unchanged();
    drop(held);
    finish(storage.update(NAME, 32, Box::new(|_| Ok(b"[8]".to_vec())), &Cancel::new())).unwrap();
}

#[test]
fn unpolled_and_already_cancelled_requests_never_reach_the_worker() {
    let folder = Folder::new();
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let cancel = Cancel::new();
    drop(storage.update(
        NAME,
        32,
        Box::new(|_| panic!("unpolled update ran")),
        &cancel,
    ));
    assert!(cancel.is_cancelled());
    assert_eq!(
        finish(storage.update(
            NAME,
            32,
            Box::new(|_| panic!("cancelled update ran")),
            &cancel
        )),
        Err(FileError::Cancelled)
    );
    assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 0);
}

#[test]
fn cancellation_at_commit_refuses_replace_and_after_commit_reports_success() {
    for step in [WriteStep::Commit, WriteStep::Renamed] {
        let folder = Folder::new();
        folder.seed();
        let cancel = Cancel::new();
        let stop = cancel.clone();
        let spawner = TestSpawner::new(move || {
            WRITE_OBSERVER.with(|observer| {
                *observer.borrow_mut() = Some(Box::new(move |seen, _, _| {
                    if seen == step {
                        assert_eq!(stop.cancel(), step == WriteStep::Commit);
                    }
                }))
            });
        });
        let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
        let result = finish(storage.update(NAME, 32, Box::new(|_| Ok(b"[8]".to_vec())), &cancel));
        if step == WriteStep::Commit {
            assert_eq!(result, Err(FileError::Cancelled));
            folder.unchanged();
        } else {
            assert_eq!(result, Ok(()));
            assert_eq!(fs::read(folder.0.join(NAME)).unwrap(), b"[8]");
        }
    }
}

#[test]
fn dropped_future_wakes_staged_worker_and_leaves_original_bytes() {
    let folder = Folder::new();
    folder.seed();
    let cancel = Cancel::new();
    let stopped = cancel.clone();
    let (staged, reached) = channel();
    let (wake, wait) = sync_channel(1);
    cancel.on_cancel(move || {
        let _ = wake.try_send(());
    });
    let spawner = TestSpawner::new(move || {
        WRITE_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move |step, _, stage| {
                if step == WriteStep::Flushed {
                    assert!(stage.exists());
                    staged.send(()).unwrap();
                    wait.recv_timeout(HANG).unwrap();
                    assert!(stopped.is_cancelled());
                }
            }))
        });
    });
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let mut future = storage.update(NAME, 32, Box::new(|_| Ok(b"[8]".to_vec())), &cancel);
    assert!(poll(&mut future).is_pending());
    reached.recv_timeout(HANG).unwrap();
    drop(future);
    assert!(cancel.is_cancelled());
    // This ordered read completes only after the cancelled transaction has cleaned its stage.
    assert_eq!(&*finish(storage.load(NAME, 32)).unwrap().unwrap(), b"[7]");
    folder.unchanged();
}

#[test]
fn lock_acquisition_is_woken_by_cancellation_and_by_dropping_the_future() {
    for drop_future in [false, true] {
        let folder = Folder::new();
        folder.seed();
        let held = acquire(&folder.0, &Cancel::new()).unwrap();
        let (waiting, reached) = sync_channel(1);
        let spawner = TestSpawner::new(move || {
            WAIT_OBSERVER.with(|observer| {
                *observer.borrow_mut() = Some(Box::new(move || {
                    let _ = waiting.try_send(());
                }))
            });
        });
        let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
        let cancel = Cancel::new();
        let mut future = storage.update(
            NAME,
            32,
            Box::new(|_| panic!("cancelled acquisition reached merge")),
            &cancel,
        );
        assert!(poll(&mut future).is_pending());
        reached.recv_timeout(HANG).unwrap();
        if !drop_future {
            cancel.cancel();
            assert_eq!(finish(future), Err(FileError::Cancelled));
        } else {
            drop(future);
            assert!(cancel.is_cancelled());
        }
        // Completion before releasing the holder proves cancellation interrupts contention.
        assert_eq!(&*finish(storage.load(NAME, 32)).unwrap().unwrap(), b"[7]");
        folder.unchanged();
        drop(held);
    }
}

#[test]
fn bounded_lane_orders_updates_and_refuses_overflow_without_running_it() {
    let folder = Folder::new();
    folder.seed();
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let (entered, reached) = channel();
    let (resume, wait) = channel();
    let a = Cancel::new();
    let b = Cancel::new();
    let c = Cancel::new();
    let mut first = storage.update(
        NAME,
        32,
        Box::new(move |old| {
            assert_eq!(old.unwrap(), b"[7]");
            entered.send(()).unwrap();
            wait.recv_timeout(HANG).unwrap();
            Ok(b"[8]".to_vec())
        }),
        &a,
    );
    assert!(poll(&mut first).is_pending());
    reached.recv_timeout(HANG).unwrap();
    let mut second = storage.update(
        NAME,
        32,
        Box::new(|old| {
            assert_eq!(old.unwrap(), b"[8]");
            Ok(b"[9]".to_vec())
        }),
        &b,
    );
    assert!(poll(&mut second).is_pending());
    assert!(matches!(
        finish(storage.update(NAME, 32, Box::new(|_| panic!("overflow ran")), &c)),
        Err(FileError::Io(_))
    ));
    resume.send(()).unwrap();
    finish(first).unwrap();
    finish(second).unwrap();
    assert_eq!(&*finish(storage.load(NAME, 32)).unwrap().unwrap(), b"[9]");
}

#[test]
fn profile_lock_covers_merge_and_every_replacement_step() {
    fn assert_locked(directory: &Path) {
        let handle = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(directory.join(LOCK_NAME))
            .unwrap();
        let mut overlap = OVERLAPPED::default();
        let locked = unsafe {
            LockFileEx(
                handle.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlap,
            )
        };
        assert_eq!(locked, 0, "transaction released its lock too early");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(ERROR_LOCK_VIOLATION as i32)
        );
    }
    let folder = Folder::new();
    folder.seed();
    let spawner = TestSpawner::new(|| {
        WRITE_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(|_, target, _| {
                assert_locked(target.parent().unwrap())
            }))
        });
    });
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let directory = folder.0.clone();
    finish(storage.update(
        NAME,
        32,
        Box::new(move |_| {
            assert_locked(&directory);
            Ok(b"[8]".to_vec())
        }),
        &Cancel::new(),
    ))
    .unwrap();
    assert_eq!(&*finish(storage.load(NAME, 32)).unwrap().unwrap(), b"[8]");
}

#[test]
fn zero_byte_limit_allows_only_an_empty_file() {
    let folder = Folder::new();
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    finish(storage.update(
        NAME,
        0,
        Box::new(|old| {
            assert!(old.is_none());
            Ok(vec![])
        }),
        &Cancel::new(),
    ))
    .unwrap();
    assert_eq!(&*finish(storage.load(NAME, 0)).unwrap().unwrap(), b"");
    assert_eq!(
        finish(storage.update(NAME, 0, Box::new(|_| Ok(vec![1])), &Cancel::new())),
        Err(FileError::TooLarge)
    );
    assert_eq!(fs::read(folder.0.join(NAME)).unwrap(), b"");
}

// A minimal, independent decoder of this test's JSON integer array. Every read (including each
// child merge) must decode; the final set must contain every distinct writer's entry exactly once.
fn decode(bytes: &[u8]) -> BTreeSet<u32> {
    let text = std::str::from_utf8(bytes).unwrap();
    let entries = text.strip_prefix('[').unwrap().strip_suffix(']').unwrap();
    if entries.is_empty() {
        return BTreeSet::new();
    }
    let numbers: Vec<u32> = entries.split(',').map(|n| n.parse().unwrap()).collect();
    let set: BTreeSet<_> = numbers.iter().copied().collect();
    assert_eq!(numbers.len(), set.len());
    set
}
fn encode(entries: BTreeSet<u32>) -> Vec<u8> {
    format!(
        "[{}]",
        entries
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    )
    .into_bytes()
}

struct Child(ChildGuard, ChildPipes, Arc<Mutex<Vec<u8>>>);
impl Child {
    fn start(folder: &Folder, mode: &str) -> Self {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "storage::tests::storage_child",
                "--ignored",
                "--nocapture",
            ])
            .env("STYK_STORAGE_TEST_ROOT", &folder.0)
            .env("STYK_STORAGE_TEST_MODE", mode)
            .env("STYK_BACKGROUND_WINDOW", "1");
        let (guard, mut pipes) = process::spawn(&mut command, true).unwrap();
        let mut stderr = pipes.stderr.take().unwrap();
        let tail = Arc::new(Mutex::new(Vec::new()));
        let captured = tail.clone();
        std::thread::spawn(move || {
            let mut scratch = [0; 1024];
            while let Ok(count) = stderr.read(&mut scratch) {
                if count == 0 {
                    break;
                }
                let mut tail = captured.lock().unwrap();
                let excess = (tail.len() + count).saturating_sub(4096);
                tail.drain(..excess);
                tail.extend_from_slice(&scratch[..count]);
            }
        });
        Self(guard, pipes, tail)
    }
    fn ready(&mut self) {
        let stdout = self.1.stdout.take().unwrap();
        let (send, receive) = channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                if reader.by_ref().take(512).read_line(&mut line).unwrap() == 0 {
                    break;
                }
                if line.trim_end().ends_with("STORAGE_READY") {
                    send.send(()).unwrap();
                    break;
                }
            }
            // Drain bounded chunks so test-harness output can never block the child.
            let mut scratch = [0; 1024];
            while reader.read(&mut scratch).unwrap_or(0) != 0 {}
        });
        receive.recv_timeout(HANG).unwrap();
    }
    fn go(&mut self) {
        self.1.stdin.as_mut().unwrap().write_all(b"!").unwrap();
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        self.0.terminate();
        self.0.wait();
    }
}

#[test]
#[ignore = "helper invoked only by the real multi-process storage tests"]
fn storage_child() {
    let root = PathBuf::from(std::env::var_os("STYK_STORAGE_TEST_ROOT").expect("child profile"));
    let mode = std::env::var("STYK_STORAGE_TEST_MODE").expect("child mode");
    let storage = LocalStorage::new(root, &ThreadSpawner).unwrap();
    if mode == "holder" {
        finish(storage.update(
            NAME,
            8192,
            Box::new(|_| {
                println!("STORAGE_READY");
                std::io::stdout().flush().unwrap();
                let mut byte = [0];
                std::io::stdin().read_exact(&mut byte).unwrap();
                Err("holder should be killed before release".into())
            }),
            &Cancel::new(),
        ))
        .unwrap();
    } else {
        let writer: u32 = mode.parse().unwrap();
        println!("STORAGE_READY");
        std::io::stdout().flush().unwrap();
        let mut byte = [0];
        std::io::stdin().read_exact(&mut byte).unwrap();
        for i in 0..24 {
            finish(storage.update(
                NAME,
                8192,
                Box::new(move |old| {
                    let mut entries = decode(old.unwrap());
                    assert!(entries.insert(writer * 24 + i));
                    // Yield within the locked read/merge interval to make a missing lock lose entries.
                    std::thread::yield_now();
                    Ok(encode(entries))
                }),
                &Cancel::new(),
            ))
            .unwrap();
        }
    }
}

#[test]
fn four_process_updates_keep_every_entry_and_every_read_decodes() {
    let folder = Folder::new();
    fs::write(folder.0.join(NAME), b"[]").unwrap();
    let mut children: Vec<_> = (0..4)
        .map(|i| Child::start(&folder, &i.to_string()))
        .collect();
    for child in &mut children {
        child.ready();
    }
    for child in &mut children {
        child.go();
    }
    let spawner = TestSpawner::new(|| {});
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let start = Instant::now();
    let mut previous = 0;
    loop {
        let bytes = finish(storage.load(NAME, 8192)).unwrap().unwrap();
        let count = decode(&bytes).len();
        assert!(count >= previous);
        previous = count;
        if children.iter().all(|child| child.0.has_exited()) {
            break;
        }
        assert!(start.elapsed() < HANG, "children hung");
        std::thread::sleep(Duration::from_millis(2));
    }
    for child in &children {
        assert!(
            child.0.wait().success(),
            "child failed: {}",
            String::from_utf8_lossy(&child.2.lock().unwrap())
        );
    }
    let bytes = finish(storage.load(NAME, 8192)).unwrap().unwrap();
    assert_eq!(decode(&bytes), (0..96).collect());
    assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 2);
}

#[test]
fn killing_a_lock_holder_releases_the_lock_for_the_next_update() {
    let folder = Folder::new();
    folder.seed();
    let mut holder = Child::start(&folder, "holder");
    holder.ready();
    let (waiting, reached) = sync_channel(1);
    let spawner = TestSpawner::new(move || {
        WAIT_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move || {
                let _ = waiting.try_send(());
            }))
        });
    });
    let storage = LocalStorage::new(&folder.0, &spawner).unwrap();
    let cancel = Cancel::new();
    let mut next = storage.update(
        NAME,
        32,
        Box::new(|old| {
            assert_eq!(old.unwrap(), b"[7]");
            Ok(b"[8]".to_vec())
        }),
        &cancel,
    );
    assert!(poll(&mut next).is_pending());
    reached.recv_timeout(HANG).unwrap();
    holder.0.terminate();
    assert!(!holder.0.wait().success());
    finish(next).unwrap();
    assert_eq!(&*finish(storage.load(NAME, 32)).unwrap().unwrap(), b"[8]");
}


// Shell lifecycle against the real profile lock, with worker-only instrumentation.
struct ShellWorkers {
    starts: Arc<std::sync::atomic::AtomicUsize>,
    commits: Arc<std::sync::atomic::AtomicUsize>,
    waited: std::sync::mpsc::Sender<()>,
    ended: std::sync::mpsc::Sender<()>,
}
impl Spawner for ShellWorkers {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (waited, ended, commits) = (self.waited.clone(), self.ended.clone(), self.commits.clone());
        ThreadSpawner.spawn(name, Box::new(move || {
            WAIT_OBSERVER.with(|o| *o.borrow_mut() = Some(Box::new(move || { let _ = waited.send(()); })));
            WRITE_OBSERVER.with(|o| *o.borrow_mut() = Some(Box::new(move |step, _, _| {
                if matches!(step, WriteStep::Renamed) { commits.fetch_add(1, Ordering::SeqCst); }
            })));
            job();
            let _ = ended.send(());
        }))
    }
}

fn shell_lifecycle(moves: i32, cancel: bool) {
    use crate::shell::{self, Wake, Wakes};
    use styk_services::shell::{Rect, window_state::{WindowFrame, WindowStateFile}};
    let folder = Folder::new();
    let lock = acquire(&folder.0, &Cancel::new()).unwrap();
    let (waited, waits) = channel(); let (ended, ends) = channel(); let (wake, wakes) = channel();
    let counts = ShellWorkers { starts: Arc::default(), commits: Arc::default(), waited, ended };
    let notify = Wakes(Arc::new(move |w| { let _ = wake.send(w); }));
    let storage = Arc::new(LocalStorage::new(&folder.0, &counts).unwrap());
    let shell::Start::Run(mut shell) = shell::start(&[], true, &notify) else { panic!("test shell") };
    shell.set_window_state_storage(storage, &counts, &notify).unwrap();
    let frame = |x| WindowFrame { rect: Rect::new(x, 20, 1234, 777), maximized: false, scale_milli: 1000 };
    for n in 0..moves {
        shell.assume(&frame(n)); shell.changed(&notify);
        // Consume the actual debounce wake, not a fabricated completion or a changed deadline.
        loop {
            match wakes.recv_timeout(HANG).unwrap() {
                Wake::SaveCheck => { shell.save_check(&notify); break; }
                Wake::WindowState => shell.window_state_progress(&notify),
                _ => panic!("unexpected wake"),
            }
        }
    }
    waits.recv_timeout(HANG).unwrap(); // The real storage worker reached LockFileEx contention.
    assert_eq!(counts.starts.load(Ordering::SeqCst), 2, "one lane and one reused storage worker");
    if cancel {
        shell.cancel_window_state();
        assert!(!shell.flush_window_state(&notify).unwrap());
        // Both workers terminate while the competing lock is STILL held: no latency threshold.
        ends.recv_timeout(HANG).unwrap(); ends.recv_timeout(HANG).unwrap();
        assert_eq!(counts.commits.load(Ordering::SeqCst), 0);
        assert!(!folder.0.join("window-state.txt").exists());
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 1, "only the persistent OS lock remains");
        drop(lock);
    } else {
        assert!(shell.flush_window_state(&notify).unwrap(), "close must retain an outstanding debounce save");
        drop(lock);
        while shell.flush_window_state(&notify).unwrap() { wakes.recv_timeout(HANG).unwrap(); }
        let bytes = fs::read_to_string(folder.0.join("window-state.txt")).unwrap();
        assert_eq!(WindowStateFile::parse(&bytes).last, Some(frame(moves - 1)));
        assert_eq!(counts.commits.load(Ordering::SeqCst), 1, "superseded placements never commit");
        drop(shell);
        ends.recv_timeout(HANG).unwrap(); ends.recv_timeout(HANG).unwrap();
        fs::remove_file(folder.0.join("window-state.txt")).unwrap();
    }
}
#[test]
fn shell_close_drains_a_debounced_save_waiting_on_the_profile_lock() { shell_lifecycle(1, false); }
#[test]
fn shell_moves_coalesce_without_growing_workers_under_the_profile_lock() { shell_lifecycle(8, false); }
#[test]
fn shell_session_end_cancels_waiters_before_the_profile_lock_is_released() { shell_lifecycle(1, true); }
