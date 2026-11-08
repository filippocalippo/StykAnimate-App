use super::*;
use crate::files::{WriteStep, WRITE_OBSERVER};
use styk_services::worker::run_future;
const OLD: &[u8] = include_bytes!("../../../../tests/containers/project-channels.styk");
const NEW: &[u8] = include_bytes!("../../../../tests/containers/project-drawing.styk");

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
