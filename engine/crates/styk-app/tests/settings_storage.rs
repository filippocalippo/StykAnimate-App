#![cfg(windows)]
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};
use styk_core::settings::{
    SettingId, Settings, TimelineMode,
    persistence::{Completion, FILE, LEGACY, Persistence, Store, change_patch},
};
use styk_core::engine::{Value, json};
use styk_platform::{spawn::ThreadSpawner, storage::LocalStorage};
use styk_services::{Cancel, worker::run_future};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("styk-timeline-settings-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn storage(&self) -> Arc<LocalStorage> {
        Arc::new(LocalStorage::new(&self.0, &ThreadSpawner).unwrap())
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn real_storage_preserves_unknowns_and_refuses_future_file_at_load_and_transaction() {
    let dir = Directory::new();
    let storage = dir.storage();
    let store = Store::new(storage);
    std::fs::write(
        dir.0.join(FILE),
        br#"{"schema":1,"values":{"futureKnob":{"x":3}},"view":{"futureView":true},"futureEnvelope":[1,2],"shortcuts":{"a":"b"}}"#,
    )
    .unwrap();
    let mut settings = Settings::default();
    settings.loaded(run_future(store.load()).unwrap().envelope);
    let change = settings.set(SettingId::LoopPlayback, Value::Bool(false)).unwrap();
    run_future(store.save(change_patch(&change), &Cancel::new())).unwrap();
    let saved = json::parse(&std::fs::read(dir.0.join(FILE)).unwrap()).unwrap();
    assert_eq!(saved.path(&["values", "futureKnob", "x"]), Some(&Value::Num(3.)));
    assert_eq!(saved.path(&["view", "futureView"]), Some(&Value::Bool(true)));
    assert!(saved.get("futureEnvelope").is_some());
    assert!(saved.get("shortcuts").is_some());
    let future = br#"{"schema":2,"values":{"loopPlayback":true},"view":{}}"#;
    std::fs::write(dir.0.join(FILE), future).unwrap();
    assert!(run_future(store.save(change_patch(&change), &Cancel::new())).is_err());
    assert_eq!(std::fs::read(dir.0.join(FILE)).unwrap(), future);
    settings.loaded(run_future(store.load()).unwrap().envelope);
    assert!(settings.read_only());
    assert!(settings.set(SettingId::LoopPlayback, Value::Bool(true)).is_err());
}
#[test]
fn real_storage_imports_legacy_without_touching_it_and_load_cannot_undo_local_edits() {
    let dir = Directory::new();
    let store = Store::new(dir.storage());
    let legacy = br#"{"timelineMode":"simple","fitViewOnPlayback":false,"loopPlayback":false,"autoKey":true,"onionBefore":4,"futurePreference":"retained"}"#;
    std::fs::write(dir.0.join(LEGACY), legacy).unwrap();
    let loaded = run_future(store.load()).unwrap();
    let mut settings = Settings::default();
    settings.set(SettingId::LoopPlayback, Value::Bool(true)).unwrap();
    settings.loaded(loaded.envelope);
    assert_eq!(settings.animation().timeline_mode, TimelineMode::Simple);
    assert!(!settings.animation().fit_view_on_playback);
    assert!(settings.animation().loop_playback);
    assert!(settings.view().auto_key);
    run_future(store.save(loaded.import.unwrap(), &Cancel::new())).unwrap();
    let saved = json::parse(&std::fs::read(dir.0.join(FILE)).unwrap()).unwrap();
    assert_eq!(saved.path(&["view", "autoKey"]), Some(&Value::Bool(true)));
    assert_eq!(saved.path(&["extra", "futurePreference"]), Some(&Value::str("retained")));
    assert!(saved.path(&["values", "autoKey"]).is_none());
    assert_eq!(std::fs::read(dir.0.join(LEGACY)).unwrap(), legacy);
    assert!(run_future(store.load()).unwrap().import.is_none());
}
#[test]
fn real_failed_transaction_retries_on_layout_backoff_and_coalesces_newer_changes() {
    let dir = Directory::new();
    let (send, wake) = mpsc::channel();
    let mut lane = Persistence::start(
        &ThreadSpawner,
        dir.storage(),
        Arc::new(move || {
            let _ = send.send(());
        }),
    )
    .unwrap();
    wake.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(lane.poll(0), Some(Completion::Loaded(Ok(_)))));
    let mut settings = Settings::default();
    lane.changed(&settings.set(SettingId::FitViewOnPlayback, Value::Bool(false)).unwrap(), 0);
    assert_eq!(lane.deadline(), Some(200));
    // This task owns the directory obstruction. Atomic replacement must fail without deleting it.
    std::fs::create_dir(dir.0.join(FILE)).unwrap();
    lane.poll(200);
    wake.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(lane.poll(200), Some(Completion::Saved(Err(_)))));
    assert_eq!(lane.deadline(), Some(400));
    lane.poll(400);
    wake.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(lane.poll(400), Some(Completion::Saved(Err(_)))));
    assert_eq!(lane.deadline(), Some(800));
    lane.changed(&settings.set(SettingId::LoopPlayback, Value::Bool(false)).unwrap(), 500);
    std::fs::remove_dir(dir.0.join(FILE)).unwrap();
    lane.poll(700);
    wake.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(lane.poll(700), Some(Completion::Saved(Ok(())))));
    assert!(lane.idle());
    let saved = json::parse(&std::fs::read(dir.0.join(FILE)).unwrap()).unwrap();
    assert_eq!(saved.path(&["values", "fitViewOnPlayback"]), Some(&Value::Bool(false)));
    assert_eq!(saved.path(&["values", "loopPlayback"]), Some(&Value::Bool(false)));
}

#[test]
fn final_settings_flush_preserves_the_last_file_on_refusal_and_stops_retrying() {
    use std::os::windows::fs::OpenOptionsExt;
    use styk_core::{app::Core, commands::Command, settings::Event};
    let dir = Directory::new();
    let previous = br#"{"schema":1,"values":{"loopPlayback":true,"future":7},"view":{}}"#;
    std::fs::write(dir.0.join(FILE), previous).unwrap();
    let (send, wake) = mpsc::channel();
    let mut core = Core::default();
    core.start_settings(&ThreadSpawner, dir.storage(), Arc::new(move || { let _ = send.send(()); })).unwrap();
    while !core.settings_idle() {
        wake.recv_timeout(Duration::from_secs(30)).unwrap();
        core.dispatch(Command::Settings(Event::Wake { now: 0 }));
    }
    core.dispatch(Command::Settings(Event::Set { id: SettingId::LoopPlayback, value: Value::Bool(false), now: 0 }));
    // A real sharing refusal in LocalStorage, with the previous complete file on disk.
    let locked = std::fs::OpenOptions::new().read(true).share_mode(0).open(dir.0.join(FILE)).unwrap();
    core.dispatch(Command::Settings(Event::Finish { now: 0 }));
    let until = std::time::Instant::now() + Duration::from_secs(30);
    while !core.settings_idle() {
        assert!(std::time::Instant::now() < until, "a refused final transaction must settle");
        wake.recv_timeout(Duration::from_secs(30)).unwrap();
        core.dispatch(Command::Settings(Event::Wake { now: 0 }));
    }
    drop(locked);
    core.dispatch(Command::Settings(Event::Wake { now: 60_000 }));
    assert_eq!(std::fs::read(dir.0.join(FILE)).unwrap(), previous);
    assert!(!core.settings().animation().loop_playback, "abandoning persistence does not invent an applied revert");
}

#[test]
fn core_loads_separate_legacy_root_and_flushes_changes_before_exit() {
    use styk_core::{
        app::Core,
        commands::{Command, Effect},
        settings::Event,
    };
    let native = Directory::new();
    let legacy = Directory::new();
    let bytes = br#"{"fitViewOnPlayback":false,"timelineMode":"simple","autoKey":true,"motionPaths":true,"motionPathRange":7,"builderOutlinerWidth":300}"#;
    std::fs::write(legacy.0.join(LEGACY), bytes).unwrap();
    let storage = Arc::new(LocalStorage::with_legacy(&native.0, &legacy.0, &ThreadSpawner).unwrap());
    let (send, wake) = mpsc::channel();
    let mut core = Core::default();
    core.start_settings(
        &ThreadSpawner,
        storage,
        Arc::new(move || {
            let _ = send.send(());
        }),
    )
    .unwrap();
    core.dispatch(Command::Settings(Event::Set { id: SettingId::LoopPlayback, value: Value::Bool(false), now: 10 }));
    wake.recv_timeout(Duration::from_secs(30)).unwrap();
    let effects = core.dispatch(Command::Wake { now: 20 });
    assert!(effects.iter().any(|e| matches!(e,Effect::SettingsChanged(c) if c.id == SettingId::FitViewOnPlayback)));
    assert!(!core.settings().animation().fit_view_on_playback);
    assert!(!core.settings().animation().loop_playback);
    assert_eq!(core.settings().animation().timeline_mode, TimelineMode::Simple);
    assert!(!core.dispatch(Command::PrepareExit).iter().any(|e| matches!(e, Effect::ExitReady)), "exit waits for the transaction");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        assert!(std::time::Instant::now() < deadline);
        wake.recv_timeout(Duration::from_secs(30)).unwrap();
        if core.dispatch(Command::Wake { now: 20 }).iter().any(|e| matches!(e, Effect::ExitReady)) {
            break;
        }
    }
    let stored = json::parse(&std::fs::read(native.0.join(FILE)).unwrap()).unwrap();
    assert_eq!(stored.path(&["values", "loopPlayback"]), Some(&Value::Bool(false)));
    assert_eq!(stored.path(&["values", "fitViewOnPlayback"]), Some(&Value::Bool(false)));
    assert_eq!(stored.path(&["view", "motionPathRange"]), Some(&Value::Num(7.)));
    assert!(stored.path(&["values", "motionPaths"]).is_none());
    assert_eq!(stored.path(&["view", "builderOutlinerWidth"]), Some(&Value::Num(300.)));
    assert_eq!(std::fs::read(legacy.0.join(LEGACY)).unwrap(), bytes);
    assert!(!legacy.0.join(FILE).exists());
}

#[test]
fn failed_load_retries_without_overwriting_and_large_unknown_import_uses_settings_limit() {
    let dir = Directory::new();
    std::fs::create_dir(dir.0.join(FILE)).unwrap();
    let (send, wake) = mpsc::channel();
    let mut lane = Persistence::start(
        &ThreadSpawner,
        dir.storage(),
        Arc::new(move || {
            let _ = send.send(());
        }),
    )
    .unwrap();
    wake.recv_timeout(Duration::from_secs(30)).unwrap();
    assert!(matches!(lane.poll(0), Some(Completion::Loaded(Err(_)))));
    assert_eq!(lane.deadline(), Some(200));
    assert!(!lane.idle());
    assert!(!lane.read_only());
    std::fs::remove_dir(dir.0.join(FILE)).unwrap();
    let large = "x".repeat(300 * 1024);
    let legacy = format!(r#"{{"unknownLarge":"{large}","fitViewOnPlayback":false}}"#);
    std::fs::write(dir.0.join(LEGACY), &legacy).unwrap();
    lane.poll(200);
    wake.recv_timeout(Duration::from_secs(30)).unwrap();
    assert!(matches!(lane.poll(200), Some(Completion::Loaded(Ok(_)))));
    assert_eq!(lane.deadline(), Some(400));
    lane.poll(400);
    wake.recv_timeout(Duration::from_secs(30)).unwrap();
    assert!(matches!(lane.poll(400), Some(Completion::Saved(Ok(())))));
    assert!(lane.idle());
    let stored = json::parse(&std::fs::read(dir.0.join(FILE)).unwrap()).unwrap();
    assert_eq!(stored.path(&["extra", "unknownLarge"]).and_then(Value::as_str), Some(large.as_str()));
    assert_eq!(std::fs::read_to_string(dir.0.join(LEGACY)).unwrap(), legacy);
}
