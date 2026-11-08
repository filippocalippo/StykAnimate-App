use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use styk_platform::recovery::LocalRecovery;
use styk_services::{Cancel, recovery::*, worker::run_future};

const PROJECT: &[u8] = include_bytes!("../../../tests/containers/project-channels.styk");
static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Folder { path: std::path::PathBuf, files: Vec<std::path::PathBuf> }
impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("styk-native-recovery-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap(); Self { path, files: Vec::new() }
    }
    fn remember(&mut self, slot: &Slot) { for ext in ["styk", "json"] { self.files.push(self.path.join(format!("{}.{}", slot.stem(), ext))); } }
    fn put(&mut self, name: &str, bytes: &[u8]) { let path = self.path.join(name); fs::write(&path, bytes).unwrap(); self.files.push(path); }
}
impl Drop for Folder {
    fn drop(&mut self) {
        for path in &self.files { if let Err(error) = fs::remove_file(path) { assert_eq!(error.kind(), std::io::ErrorKind::NotFound); } }
        fs::remove_dir(&self.path).unwrap();
    }
}

#[test]
fn real_store_is_atomic_owned_and_conditional_and_preserves_invalid_copies() {
    let mut folder = Folder::new(); let store = LocalRecovery::new(&folder.path);
    let copy = run_future(store.create(&Cancel::new())).unwrap(); folder.remember(copy.slot());
    let record = run_future(copy.write(None, PROJECT, "A/b\n日本", &Cancel::new())).unwrap();
    assert_eq!(record.name, "A_b_日本"); assert_eq!(&*run_future(copy.read(&record, MAX_BYTES, &Cancel::new())).unwrap(), PROJECT);
    assert!(run_future(store.list(&Cancel::new())).unwrap().is_empty());
    assert!(matches!(run_future(store.claim(&record, &Cancel::new())), Err(RecoveryError::Owned)));
    assert!(run_future(copy.write(Some(&record), b"", "bad", &Cancel::new())).is_err());
    let cancelled = Cancel::new(); cancelled.cancel(); assert!(run_future(copy.write(Some(&record), b"bad", "bad", &cancelled)).is_err());
    assert_eq!(&*run_future(copy.read(&record, MAX_BYTES, &Cancel::new())).unwrap(), PROJECT);
    drop(copy); assert_eq!(run_future(store.list(&Cancel::new())).unwrap(), vec![record.clone()]);
    let meta = folder.path.join(format!("{}.json", record.slot.stem())); fs::write(&meta, br#"{"name":"different","savedAt":"2026-01-01T00:00:00.000Z"}"#).unwrap();
    assert!(matches!(run_future(store.claim(&record, &Cancel::new())), Err(RecoveryError::Changed)));
    let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    let copy = run_future(store.claim(&record, &Cancel::new())).unwrap(); run_future(copy.remove(&record, &Cancel::new())).unwrap(); drop(copy);
    assert!(run_future(store.list(&Cancel::new())).unwrap().is_empty());
    folder.put("recovery.styk", b""); folder.put("recovery-not-a-uuid.styk", b"unknown");
    assert!(run_future(store.list(&Cancel::new())).unwrap().is_empty());
    assert!(folder.path.join("recovery.styk").exists()); assert!(folder.path.join("recovery-not-a-uuid.styk").exists());
}

#[test]
fn pruning_keeps_sixteen_named_copies_all_owned_copies_and_the_legacy_copy() {
    let mut folder = Folder::new(); let store = LocalRecovery::new(&folder.path);
    folder.put("recovery.styk", PROJECT);
    let mut held = Vec::new();
    for index in 0..18 {
        let copy = run_future(store.create(&Cancel::new())).unwrap(); folder.remember(copy.slot());
        let record = run_future(copy.write(None, PROJECT, &format!("Copy {index}"), &Cancel::new())).unwrap();
        if index < 2 { held.push((copy, record)); }
    }
    assert_eq!(run_future(store.list(&Cancel::new())).unwrap().len(), MAX_SLOTS - held.len() + 1);
    for (copy, record) in &held { assert_eq!(&*run_future(copy.read(record, MAX_BYTES, &Cancel::new())).unwrap(), PROJECT); }
    drop(held); assert_eq!(run_future(store.list(&Cancel::new())).unwrap().len(), MAX_SLOTS + 1);
}

#[test]
fn legacy_optional_malformed_metadata_is_read_and_a_same_size_changed_payload_is_refused() {
    let mut folder = Folder::new(); folder.put("recovery.styk", PROJECT); folder.put("recovery.json", b"not JSON");
    let store = LocalRecovery::new(&folder.path); let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    assert!(record.slot.is_legacy()); assert_eq!(record.name, "Recovered animation"); assert!(record.saved_at.ends_with('Z'));
    let mut changed = PROJECT.to_vec(); let last = changed.len() - 1; changed[last] ^= 1; fs::write(folder.path.join("recovery.styk"), &changed).unwrap();
    assert!(matches!(run_future(store.claim(&record, &Cancel::new())), Err(RecoveryError::Changed)));
    assert_eq!(fs::read(folder.path.join("recovery.styk")).unwrap(), changed);
}

#[test]
fn discard_checks_the_chosen_bytes_again_after_claim_and_keeps_a_changed_file() {
    let mut folder = Folder::new(); folder.put("recovery.styk", PROJECT);
    let store = LocalRecovery::new(&folder.path); let record = run_future(store.list(&Cancel::new())).unwrap().remove(0);
    let copy = run_future(store.claim(&record, &Cancel::new())).unwrap();
    let mut changed = PROJECT.to_vec(); let at = changed.len() - 1; changed[at] ^= 1;
    fs::write(folder.path.join("recovery.styk"), &changed).unwrap();
    assert_eq!(run_future(copy.remove(&record, &Cancel::new())), Err(RecoveryError::Changed));
    assert_eq!(fs::read(folder.path.join("recovery.styk")).unwrap(), changed);
}

#[test]
#[ignore = "run tests/native-recovery-reference.test.mjs first; explicit pinned compatibility oracle"]
fn finds_and_reads_both_copies_written_by_the_pinned_electron_recovery_store() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../artifacts/native-recovery-reference");
    let bytes = fs::read(root.join("source.styk")).expect("reference generator must run first");
    // Copy only the public synthetic oracle into this test's isolated folder; never use an app profile.
    let mut folder = Folder::new();
    for name in ["recovery.styk", "recovery.json", "recovery-12345678-1234-4234-8234-123456789abc.styk", "recovery-12345678-1234-4234-8234-123456789abc.json"] { folder.put(name, &fs::read(root.join("first").join(name)).unwrap()); }
    let store = LocalRecovery::new(&folder.path); let records = run_future(store.list(&Cancel::new())).unwrap(); assert_eq!(records.len(), 2);
    assert!(records.iter().any(|record| record.name == "Recovered 日本"));
    for record in records { let copy = run_future(store.claim(&record, &Cancel::new())).unwrap(); assert_eq!(&*run_future(copy.read(&record, MAX_BYTES, &Cancel::new())).unwrap(), bytes); }
}
