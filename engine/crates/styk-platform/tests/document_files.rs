#![cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
use styk_platform::files::LocalFiles;
use styk_services::Cancel;
use styk_services::files::{FileError, FileTarget, Files};
use styk_services::worker::run_future;

static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Folder(std::path::PathBuf);
impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("styk-doc-files-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        // Only this test's explicit files, never a recursively enumerated directory.
        for name in ["project.styk", "new.styk"] { let _ = std::fs::remove_file(self.0.join(name)); }
        std::fs::remove_dir(&self.0).unwrap();
    }
}

#[test]
fn real_atomic_replace_reads_back_and_cancellation_leaves_no_stage() {
    let folder = Folder::new(); let files = LocalFiles;
    let target = FileTarget::new(folder.0.join("project.styk"));
    std::fs::write(target.path(), b"old").unwrap();
    let bytes = vec![7; 700_000];
    run_future(files.replace(&target, &bytes, &Cancel::new())).unwrap();
    assert_eq!(&*run_future(files.read(&target, bytes.len(), &Cancel::new())).unwrap(), &bytes);
    let stop = Cancel::new(); stop.cancel();
    assert_eq!(run_future(files.replace(&target, b"cancelled", &stop)), Err(FileError::Cancelled));
    assert_eq!(std::fs::read(target.path()).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(&folder.0).unwrap().count(), 1);
    assert_eq!(run_future(files.read(&target, 1, &Cancel::new())), Err(FileError::TooLarge));
}

#[test]
fn read_only_destination_keeps_old_bytes_and_failed_creation_owns_no_file() {
    let folder = Folder::new(); let files = LocalFiles;
    let target = FileTarget::new(folder.0.join("project.styk"));
    std::fs::write(target.path(), b"old").unwrap();
    let mut permissions = std::fs::metadata(target.path()).unwrap().permissions(); permissions.set_readonly(true);
    std::fs::set_permissions(target.path(), permissions).unwrap();
    let result = run_future(files.replace(&target, b"new", &Cancel::new()));
    let mut permissions = std::fs::metadata(target.path()).unwrap().permissions(); permissions.set_readonly(false);
    std::fs::set_permissions(target.path(), permissions).unwrap();
    assert_eq!(result, Err(FileError::ReadOnly));
    assert_eq!(std::fs::read(target.path()).unwrap(), b"old");
    let absent = FileTarget::new(folder.0.join("absent").join("new.styk"));
    assert!(run_future(files.replace(&absent, b"new", &Cancel::new())).is_err());
    assert_eq!(std::fs::read_dir(&folder.0).unwrap().count(), 1);
}
