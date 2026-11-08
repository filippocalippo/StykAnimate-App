use super::*;
use crate::files::{WriteStep, WRITE_OBSERVER};
use styk_services::worker::run_future;
const OLD: &[u8] = include_bytes!("../../../../tests/containers/project-channels.styk");
const NEW: &[u8] = include_bytes!("../../../../tests/containers/project-drawing.styk");

#[test]
fn live_electron_owner_allows_read_but_never_discard_or_prune() {
    let root = Sandbox::new("legacy-owner");
    fs::write(root.0.join("recovery.styk"), OLD).unwrap();
    // Chromium's ProcessSingleton holds this exact file for the primary profile's lifetime.
    let owner = OpenOptions::new().write(true).create(true).truncate(true).share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE).open(root.0.join("lockfile")).unwrap();
    let store = LocalRecovery::new(&root.0);
    let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    let copy = run_future(store.claim(&record, &Cancel::new())).unwrap();
    assert_eq!(&*run_future(copy.read(&record, MAX_BYTES, &Cancel::new())).unwrap(), OLD);
    assert!(run_future(copy.remove(&record, &Cancel::new())).is_err(), "a native slot lock does not exclude Electron");
    drop(copy);
    assert_eq!(fs::read(root.0.join("recovery.styk")).unwrap(), OLD);
    drop(owner);
}

#[test]
fn orphaned_electron_copy_is_adopted_under_profile_exclusion() {
    let root = Sandbox::new("legacy-orphan");
    fs::write(root.0.join("recovery.styk"), OLD).unwrap();
    let store = LocalRecovery::new(&root.0);
    let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    let copy = run_future(store.claim(&record, &Cancel::new())).unwrap();
    let racing_owner = OpenOptions::new().write(true).create(true).truncate(true).share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE).open(root.0.join("lockfile"));
    assert!(racing_owner.is_err(), "the orphan proof must exclude a new legacy owner until adoption ends");
    run_future(copy.remove(&record, &Cancel::new())).unwrap();
}

#[test]
fn live_legacy_named_copies_are_never_pruned_and_native_leases_still_exclude() {
    let root = Sandbox::new("legacy-prune");
    let owner = OpenOptions::new().write(true).create(true).truncate(true).share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE).open(root.0.join("lockfile")).unwrap();
    let names: Vec<_> = (0..18).map(|n| format!("recovery-00000000-0000-4000-8000-{n:012x}.styk")).collect();
    for name in &names { fs::write(root.0.join(name), OLD).unwrap(); }
    let store = LocalRecovery::new(&root.0);
    let native = run_future(store.create(&Cancel::new())).unwrap();
    let receipt = run_future(native.write(None, NEW, "Native", &Cancel::new())).unwrap();
    let native_owned = matches!(run_future(store.claim(&receipt, &Cancel::new())), Err(RecoveryError::Owned));
    let intact = names.iter().all(|name| fs::read(root.0.join(name)).is_ok_and(|bytes| bytes == OLD));
    let listed = run_future(store.list(&Cancel::new())).unwrap();
    run_future(native.remove(&receipt, &Cancel::new())).unwrap(); drop(native); drop(owner);
    for name in names { let path = root.0.join(name); if path.exists() { fs::remove_file(path).unwrap(); } }
    assert!(native_owned);
    assert!(intact, "pruning must preserve every live legacy copy");
    assert_eq!(listed.len(), 18); assert!(listed.iter().all(|copy| copy.read_only));
}

struct Sandbox(PathBuf);
impl Sandbox {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("styk-rec-review-{}-{label}", std::process::id()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = None);
        for name in ["recovery.styk", "recovery.json", "recovery.lock", "ready"] {
            let path = self.0.join(name);
            if let Ok(meta) = fs::metadata(&path) {
                let mut permissions = meta.permissions(); permissions.set_readonly(false);
                fs::set_permissions(&path, permissions).unwrap(); fs::remove_file(path).unwrap();
            }
        }
        fs::remove_dir(&self.0).unwrap();
    }
}

struct SidecarDirectory(PathBuf);
impl SidecarDirectory {
    fn new(path: PathBuf) -> Self {
        fs::create_dir(&path).unwrap(); fs::write(path.join("keep"), b"not recovery metadata").unwrap(); Self(path)
    }
}
impl Drop for SidecarDirectory {
    fn drop(&mut self) { fs::remove_file(self.0.join("keep")).unwrap(); fs::remove_dir(&self.0).unwrap(); }
}

fn check_unavailable_sidecar(store: LocalRecovery) {
    let copy = store.lease(Slot::legacy()).unwrap();
    let receipt = run_future(copy.write(None, OLD, "Committed project", &Cancel::new())).unwrap();
    assert_eq!(&*run_future(copy.read(&receipt, MAX_BYTES, &Cancel::new())).unwrap(), OLD);
    drop(copy);
    let reopened = LocalRecovery::new(store.directory());
    let records = run_future(reopened.list(&Cancel::new())).unwrap();
    assert_eq!(records.len(), 1, "unavailable optional metadata must not hide committed data");
    let selected = &records[0];
    assert_eq!(selected.name, "Recovered animation");
    assert_eq!(selected.saved_at, metadata::file_time(fs::metadata(store.path(&Slot::legacy(), "styk")).unwrap().last_write_time()));
    assert_eq!(selected.version, receipt.version); assert_eq!(selected.size, OLD.len());
    let claimed = run_future(reopened.claim(selected, &Cancel::new())).unwrap();
    assert_eq!(&*run_future(claimed.read(selected, MAX_BYTES, &Cancel::new())).unwrap(), OLD);
    fs::write(store.path(&Slot::legacy(), "styk"), NEW).unwrap();
    assert_eq!(run_future(claimed.read(selected, MAX_BYTES, &Cancel::new())), Err(RecoveryError::Changed));
    assert_eq!(run_future(claimed.remove(selected, &Cancel::new())), Err(RecoveryError::Changed));
    fs::write(store.path(&Slot::legacy(), "styk"), OLD).unwrap();
    run_future(claimed.remove(selected, &Cancel::new())).unwrap();
    assert!(!store.path(&Slot::legacy(), "styk").exists());
}

#[test]
fn unavailable_sidecar_directory_keeps_the_committed_copy_listed_and_selectable() {
    let folder = Sandbox::new("sidecar-directory");
    let directory = SidecarDirectory::new(folder.0.join("recovery.json"));
    check_unavailable_sidecar(LocalRecovery::new(&folder.0));
    assert_eq!(fs::read(directory.0.join("keep")).unwrap(), b"not recovery metadata");
}

#[test]
fn unavailable_sidecar_sharing_violation_keeps_the_committed_copy_listed_and_selectable() {
    let folder = Sandbox::new("sidecar-unreadable"); let path = folder.0.join("recovery.json");
    fs::write(&path, b"unreadable display info").unwrap();
    let held = OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
    check_unavailable_sidecar(LocalRecovery::new(&folder.0));
    drop(held); assert_eq!(fs::read(path).unwrap(), b"unreadable display info");
}

#[test]
fn unavailable_sidecar_after_listing_does_not_block_claim_read_or_data_removal() {
    let folder = Sandbox::new("sidecar-becomes-unreadable"); let store = LocalRecovery::new(&folder.0);
    let copy = store.lease(Slot::legacy()).unwrap(); run_future(copy.write(None, OLD, "Known", &Cancel::new())).unwrap(); drop(copy);
    let record = run_future(store.list(&Cancel::new())).unwrap().remove(0); assert_eq!(record.name, "Known");
    let path = folder.0.join("recovery.json"); let before = fs::read(&path).unwrap();
    let held = OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
    let copy = run_future(store.claim(&record, &Cancel::new())).unwrap();
    assert_eq!(&*run_future(copy.read(&record, MAX_BYTES, &Cancel::new())).unwrap(), OLD);
    run_future(copy.remove(&record, &Cancel::new())).unwrap(); drop(copy); drop(held);
    assert_eq!(fs::read(path).unwrap(), before, "an unverifiable sidecar is left untouched");
}

#[test]
fn unavailable_sidecar_at_listing_is_not_deleted_when_it_later_becomes_readable() {
    let folder = Sandbox::new("sidecar-becomes-readable"); let store = LocalRecovery::new(&folder.0);
    fs::write(folder.0.join("recovery.styk"), OLD).unwrap();
    let path = folder.0.join("recovery.json"); let before = metadata::encode("Other info", "2026-01-01T00:00:00.000Z"); fs::write(&path, &before).unwrap();
    let held = OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
    let records = run_future(store.list(&Cancel::new())).unwrap();
    assert_eq!(records.len(), 1, "a sidecar that could not be verified is optional");
    // This offer is identified by its bytes, even if its file timestamp changes before selection.
    OpenOptions::new().write(true).open(folder.0.join("recovery.styk")).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(2)).unwrap();
    drop(held);
    let copy = run_future(store.claim(&records[0], &Cancel::new())).unwrap();
    assert_eq!(&*run_future(copy.read(&records[0], MAX_BYTES, &Cancel::new())).unwrap(), OLD);
    run_future(copy.remove(&records[0], &Cancel::new())).unwrap(); drop(copy);
    assert_eq!(fs::read(path).unwrap(), before, "becoming readable does not authorize deleting unselected metadata");
}

#[test]
fn review_orphaned_lock_does_not_hide_a_good_copy() {
    let folder = Sandbox::new("orphan");
    fs::write(folder.0.join("recovery.styk"), OLD).unwrap();
    fs::write(folder.0.join("recovery.lock"), b"orphan after power loss").unwrap();
    let store = LocalRecovery::new(&folder.0);
    let records = run_future(store.list(&Cancel::new())).unwrap();
    assert_eq!(records.len(), 1, "a file without a holder is not ownership");
    let copy = run_future(store.claim(&records[0], &Cancel::new())).unwrap();
    assert_eq!(&*run_future(copy.read(&records[0], MAX_BYTES, &Cancel::new())).unwrap(), OLD);
}

#[test]
#[ignore = "child held and killed by review_live_process_owns_the_copy_until_its_handle_is_closed"]
fn review_lock_child() {
    let folder = PathBuf::from(std::env::var_os("STYK_REVIEW_LOCK_FOLDER").unwrap());
    assert!(folder.file_name().unwrap().to_string_lossy().starts_with("styk-rec-review-"));
    let store = LocalRecovery::new(&folder); let _copy = store.lease(Slot::legacy()).unwrap();
    fs::write(folder.join("ready"), b"held").unwrap();
    let mut byte = [0]; std::io::stdin().read_exact(&mut byte).unwrap();
}

#[test]
fn review_live_process_owns_the_copy_until_its_handle_is_closed() {
    use std::process::{Child, Command, Stdio};
    struct Owner(Child);
    impl Drop for Owner { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
    let folder = Sandbox::new("live"); fs::write(folder.0.join("recovery.styk"), OLD).unwrap();
    let store = LocalRecovery::new(&folder.0); let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    let mut child = Owner(Command::new(std::env::current_exe().unwrap()).args(["--exact", "recovery::tests::review_lock_child", "--ignored"])
        .env("STYK_REVIEW_LOCK_FOLDER", &folder.0).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap());
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !folder.0.join("ready").exists() {
        assert!(child.0.try_wait().unwrap().is_none()); assert!(std::time::Instant::now() < until);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(run_future(store.list(&Cancel::new())).unwrap().is_empty());
    assert!(matches!(run_future(store.claim(&record, &Cancel::new())), Err(RecoveryError::Owned)));
    drop(child); // Kill only this test's child through its stable process handle.
    assert_eq!(run_future(store.list(&Cancel::new())).unwrap(), vec![record]);
}

#[test]
fn review_metadata_delete_failure_commits_data_removal_and_allows_later_copies() {
    let folder = Sandbox::new("remove"); let store = LocalRecovery::new(&folder.0);
    let copy = store.lease(Slot::legacy()).unwrap();
    let record = run_future(copy.write(None, OLD, "Old", &Cancel::new())).unwrap();
    let path = folder.0.join("recovery.json"); let original = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original.clone(); readonly.set_readonly(true); fs::set_permissions(&path, readonly).unwrap();
    let removed = run_future(copy.remove(&record, &Cancel::new()));
    assert!(!folder.0.join("recovery.styk").exists(), "the data removal committed");
    assert_eq!(removed, Ok(()), "optional metadata must not restore the obsolete data record");
    assert!(path.exists());
    // A still-blocked optional sidecar cannot stop another data commit or its later removal.
    let while_blocked = run_future(copy.write(None, NEW, "While blocked", &Cancel::new())).unwrap();
    run_future(copy.remove(&while_blocked, &Cancel::new())).unwrap();
    // Clearing the obstruction allows the deferred cleanup to run on the next write.
    fs::set_permissions(&path, original).unwrap();
    let sidecar = path.clone();
    WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = Some(Box::new(move |step, target, _| {
        if step == WriteStep::Created && target.extension().is_some_and(|ext| ext == "styk") {
            assert!(!sidecar.exists(), "the deferred sidecar deletion was retried before this write");
        }
    })));
    let next = run_future(copy.write(None, NEW, "New", &Cancel::new())).unwrap();
    WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = None);
    assert_eq!(&*run_future(copy.read(&next, MAX_BYTES, &Cancel::new())).unwrap(), NEW);
}

#[test]
fn review_deferred_cleanup_does_not_delete_replaced_metadata() {
    let folder = Sandbox::new("replaced-sidecar"); let store = LocalRecovery::new(&folder.0);
    let copy = store.lease(Slot::legacy()).unwrap();
    let record = run_future(copy.write(None, OLD, "Old", &Cancel::new())).unwrap();
    let path = folder.0.join("recovery.json"); let original = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original.clone(); readonly.set_readonly(true); fs::set_permissions(&path, readonly).unwrap();
    run_future(copy.remove(&record, &Cancel::new())).unwrap();
    fs::set_permissions(&path, original).unwrap(); fs::write(&path, b"someone else's sidecar").unwrap();
    let sidecar = path.clone();
    WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = Some(Box::new(move |step, target, _| {
        if step == WriteStep::Created && target.extension().is_some_and(|ext| ext == "styk") {
            assert_eq!(fs::read(&sidecar).unwrap(), b"someone else's sidecar", "cleanup revalidates its exact sidecar");
        }
    })));
    run_future(copy.write(None, NEW, "New", &Cancel::new())).unwrap();
}

#[test]
fn review_committed_write_survives_optional_metadata_and_describe_read_failures() {
    use std::{cell::RefCell, rc::Rc};
    for extension in ["json", "styk"] {
        let folder = Sandbox::new(extension); let store = LocalRecovery::new(&folder.0); let copy = store.lease(Slot::legacy()).unwrap();
        let old = run_future(copy.write(None, OLD, "Old", &Cancel::new())).unwrap();
        let locked = Rc::new(RefCell::new(None)); let hold = locked.clone(); let path = folder.0.join(format!("recovery.{extension}"));
        WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = Some(Box::new(move |step, target, _| {
            if step == WriteStep::Renamed && target.extension().is_some_and(|ext| ext == "styk") {
                *hold.borrow_mut() = Some(OpenOptions::new().read(true).share_mode(0).open(&path).unwrap());
            }
        })));
        let committed = run_future(copy.write(Some(&old), NEW, "New", &Cancel::new()));
        WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = None);
        locked.borrow_mut().take();
        assert_eq!(fs::read(folder.0.join("recovery.styk")).unwrap(), NEW);
        let record = committed.expect("post-commit reads cannot retract a committed copy");
        let next = run_future(copy.write(Some(&record), OLD, "Again", &Cancel::new())).unwrap();
        assert_eq!(&*run_future(copy.read(&next, MAX_BYTES, &Cancel::new())).unwrap(), OLD);
    }
}

#[test]
#[ignore = "child process used only by crash_at_each_copy_step_keeps_a_complete_project"]
fn copy_crash_child() {
    let directory = PathBuf::from(std::env::var_os("STYK_RECOVERY_CRASH_FOLDER").expect("parent supplies sandbox"));
    assert!(directory.file_name().unwrap().to_string_lossy().starts_with("styk-copy-crash-"));
    assert_eq!(fs::read(directory.join("test-owner")).unwrap(), b"K-rec crash test");
    let index: usize = std::env::var("STYK_RECOVERY_CRASH_STEP").unwrap().parse().unwrap();
    let store = LocalRecovery::new(&directory); let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    let copy = run_future(store.claim(&record, &Cancel::new())).unwrap();
    WRITE_OBSERVER.with(|observer| *observer.borrow_mut() = Some(Box::new(move |step, target, stage| {
        let part = usize::from(target.extension().is_some_and(|ext| ext == "json"));
        let at = match step { WriteStep::Created => 0, WriteStep::Written => 1, WriteStep::Flushed => 2, WriteStep::Commit => 3, WriteStep::Renamed => 4 };
        if part * 5 + at == index {
            fs::write(directory.join("created-stage"), stage.to_string_lossy().as_bytes()).unwrap();
            // Immediate process termination: no Rust destructors or staged-file cleanup run.
            std::process::exit(86);
        }
    })));
    run_future(copy.write(Some(&record), NEW, "New copy", &Cancel::new())).unwrap();
    panic!("the chosen crash point must be reached");
}

#[test]
fn crash_at_each_copy_step_keeps_a_complete_project() {
    for index in 0..10 {
        let directory = std::env::temp_dir().join(format!("styk-copy-crash-{}-{index}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("test-owner"), b"K-rec crash test").unwrap();
        fs::write(directory.join("recovery.styk"), OLD).unwrap();
        fs::write(directory.join("recovery.json"), metadata::encode("Previous", "2026-01-01T00:00:00.000Z")).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recovery::tests::copy_crash_child", "--ignored", "--nocapture"])
            .env("STYK_RECOVERY_CRASH_FOLDER", &directory).env("STYK_RECOVERY_CRASH_STEP", index.to_string()).output().unwrap();
        assert_eq!(output.status.code(), Some(86), "point {index}: {}", String::from_utf8_lossy(&output.stderr));
        let store = LocalRecovery::new(&directory); let records = run_future(store.list(&Cancel::new())).unwrap(); assert_eq!(records.len(), 1);
        let copy = run_future(store.claim(&records[0], &Cancel::new())).unwrap();
        let bytes = run_future(copy.read(&records[0], MAX_BYTES, &Cancel::new())).unwrap();
        assert_eq!(&*bytes, if index < 4 { OLD } else { NEW }, "point {index} has a complete repository project");
        drop(copy);
        let stage = PathBuf::from(fs::read_to_string(directory.join("created-stage")).unwrap());
        assert_eq!(stage.parent(), Some(directory.as_path())); assert!(stage.file_name().unwrap().to_string_lossy().starts_with(".styk-doc-"));
        if stage.exists() { fs::remove_file(stage).unwrap(); }
        for name in ["test-owner", "created-stage", "recovery.styk", "recovery.json"] { fs::remove_file(directory.join(name)).unwrap(); }
        fs::remove_dir(directory).unwrap();
    }
}
