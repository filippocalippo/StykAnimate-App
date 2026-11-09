use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use styk_core::documents::{*, recovery::{Activity, Command, Event}};
use styk_core::engine::{Engine, Budgets, Value};
use styk_services::{Cancel, FixedClock, Job, SpawnError, Spawner};
use styk_services::files::{FileError, FileTarget, fake::MemoryFiles};
use styk_services::recovery::*;

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
struct Threads;
impl Spawner for Threads {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> { std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|e| SpawnError(e.to_string())) }
}
#[derive(Clone)]
struct Entry { record: Record, bytes: Arc<[u8]>, owned: bool }
#[derive(Default)]
struct State { entries: HashMap<Slot, Entry>, serial: u64, writes: usize, removes: usize }
#[derive(Clone, Default)]
struct Store { state: Arc<Mutex<State>>, fail: Arc<AtomicBool>, fail_remove: Arc<AtomicBool>, hold: Arc<AtomicBool>, entered: Arc<AtomicBool>, wake: Arc<Mutex<Option<std::task::Waker>>> }
impl Store {
    fn insert(&self, slot: Slot, bytes: Arc<[u8]>, name: &str) -> Record {
        let mut state = self.state.lock().unwrap(); state.serial += 1;
        let mut version = [0; 32]; version[..8].copy_from_slice(&state.serial.to_le_bytes());
        let record = Record { slot: slot.clone(), name: name.into(), saved_at: format!("2026-11-08T00:00:{:02}.000Z", state.serial), size: bytes.len(), version, read_only: false, selection: Some(version) };
        state.entries.insert(slot, Entry { record: record.clone(), bytes, owned: false }); record
    }
    fn records(&self) -> Vec<Entry> { self.state.lock().unwrap().entries.values().cloned().collect() }
    fn writes(&self) -> usize { self.state.lock().unwrap().writes }
    fn unblock(&self) { self.hold.store(false, Ordering::SeqCst); if let Some(wake) = self.wake.lock().unwrap().take() { wake.wake(); } }
}
struct Copy { store: Store, slot: Slot }
impl Drop for Copy { fn drop(&mut self) { if let Some(entry) = self.store.state.lock().unwrap().entries.get_mut(&self.slot) { entry.owned = false; } } }
impl Recovery for Store {
    fn list<'a>(&'a self, _: &'a Cancel) -> RecoveryFuture<'a, Vec<Record>> { Box::pin(async move { let mut records: Vec<_> = self.records().into_iter().filter(|e| !e.owned).map(|e| e.record).collect(); records.sort_by(|a,b| b.saved_at.cmp(&a.saved_at)); Ok(records) }) }
    fn create<'a>(&'a self, _: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> { Box::pin(async move {
        let mut state = self.state.lock().unwrap(); state.serial += 1;
        let slot = Slot::named(&format!("00000000-0000-4000-8000-{:012x}", state.serial)).unwrap();
        Ok(Arc::new(Copy { store: self.clone(), slot }) as Arc<dyn RecoveryCopy>)
    }) }
    fn claim<'a>(&'a self, record: &'a Record, _: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> { Box::pin(async move {
        let mut state = self.state.lock().unwrap(); let entry = state.entries.get_mut(&record.slot).ok_or(RecoveryError::Missing)?;
        if entry.owned { return Err(RecoveryError::Owned); } if entry.record != *record { return Err(RecoveryError::Changed); }
        entry.owned = true; Ok(Arc::new(Copy { store: self.clone(), slot: record.slot.clone() }) as Arc<dyn RecoveryCopy>)
    }) }
}
impl RecoveryCopy for Copy {
    fn slot(&self) -> &Slot { &self.slot }
    fn read<'a>(&'a self, record: &'a Record, maximum: usize, _: &'a Cancel) -> RecoveryFuture<'a, Arc<[u8]>> { Box::pin(async move {
        let state = self.store.state.lock().unwrap(); let entry = state.entries.get(&self.slot).ok_or(RecoveryError::Missing)?;
        if entry.record != *record { return Err(RecoveryError::Changed); } if entry.bytes.len() > maximum { return Err(FileError::TooLarge.into()); } Ok(entry.bytes.clone())
    }) }
    fn write<'a>(&'a self, previous: Option<&'a Record>, bytes: &'a [u8], name: &'a str, cancel: &'a Cancel) -> RecoveryFuture<'a, Record> { Box::pin(async move {
        self.store.entered.store(true, Ordering::SeqCst);
        let wake = self.store.wake.clone(); cancel.on_cancel(move || { if let Some(waker) = wake.lock().unwrap().take() { waker.wake(); } });
        std::future::poll_fn(|cx| {
            *self.store.wake.lock().unwrap() = Some(cx.waker().clone());
            if self.store.hold.load(Ordering::SeqCst) && !cancel.is_cancelled() { std::task::Poll::Pending } else { std::task::Poll::Ready(()) }
        }).await;
        if cancel.is_cancelled() { return Err(FileError::Cancelled.into()); }
        if self.store.fail.load(Ordering::SeqCst) { return Err(FileError::Full.into()); }
        { let state = self.store.state.lock().unwrap();
          if state.entries.get(&self.slot).map(|e| &e.record) != previous { return Err(RecoveryError::Changed); } }
        if !cancel.begin_commit() { return Err(FileError::Cancelled.into()); }
        let record = self.store.insert(self.slot.clone(), Arc::from(bytes), name);
        let mut state = self.store.state.lock().unwrap(); state.entries.get_mut(&self.slot).unwrap().owned = true; state.writes += 1;
        Ok(record)
    }) }
    fn remove<'a>(&'a self, record: &'a Record, _: &'a Cancel) -> RecoveryFuture<'a, ()> { Box::pin(async move {
        if self.store.fail_remove.load(Ordering::SeqCst) { return Err(FileError::ReadOnly.into()); }
        let mut state = self.store.state.lock().unwrap(); if state.entries.get(&self.slot).map(|e| &e.record) != Some(record) { return Err(RecoveryError::Changed); }
        state.entries.remove(&self.slot); state.removes += 1; Ok(())
    }) }
}
struct Rig { docs: Documents, store: Store, files: Arc<MemoryFiles>, clock: FixedClock }
impl Rig {
    fn new(store: Store) -> Self {
        let mut docs = Documents::new(); let files = Arc::new(MemoryFiles::default()); let clock = FixedClock::new();
        docs.attach_host(HostOptions { engine: Engine::new(|| 0.0, Budgets::for_device(None)), spawner: Arc::new(Threads), files: files.clone(), startup: styk_doc::json::parse(STARTUP).unwrap(), clock: Arc::new(|| 0.0), notify: Arc::new(|| {}) }).unwrap();
        let mut rig = Self { docs, store, files, clock }; rig.open("Front.styk");
        rig.drain(); rig.docs.attach_recovery(Arc::new(rig.store.clone()), Arc::new(rig.clock.clone())).unwrap();
        rig.wait(|effect| matches!(effect, Effect::Recovery(Event::Listed))); rig
    }
    fn send(&mut self, mut request: Request) -> Effect {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop { match self.docs.dispatch(request) {
            Ok(effect) => return effect,
            Err((HostError::Documents(DocumentsError::Busy), retry)) => { assert!(Instant::now() < deadline, "busy request"); request = retry; self.docs.poll(); std::thread::yield_now(); }
            Err((error, _)) => panic!("dispatch: {error}"),
        } }
    }
    #[track_caller]
    fn wait(&mut self, predicate: impl Fn(&Effect) -> bool) -> Effect {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop { if let Some(effect) = self.docs.poll() { if predicate(&effect) { return effect; } if matches!(effect, Effect::Failed { .. }) { panic!("{effect:?}"); } }
            assert!(Instant::now() < deadline, "missing completion: deadline {:?}, chooser {:?}", self.docs.recovery_deadline(), self.docs.recovery_view()); std::thread::yield_now(); }
    }
    fn drain(&mut self) { // No wall-clock scheduling: only let the real workers drain at this fixed time.
        let until = Instant::now() + Duration::from_millis(80); while Instant::now() < until { self.docs.poll(); std::thread::yield_now(); }
    }
    fn advance(&mut self, ms: u64) { self.clock.advance(Duration::from_millis(ms)); self.drain(); }
    fn active(&self) -> DocumentId { self.docs.active().unwrap().id() }
    fn edit(&mut self, fps: f64) { let id = self.active(); self.docs.call(id, "setFPS", &[Value::Num(fps)], &Value::Null).unwrap().result.unwrap(); }
    fn open(&mut self, name: &str) -> DocumentId { self.send(Request::OpenBytes { bytes: Arc::from(STARTUP), name: name.into() }); let Effect::Opened(id) = self.wait(|e| matches!(e, Effect::Opened(_))) else { unreachable!() }; id }
    fn checkpoint(&mut self) { self.send(Request::Recovery(Command::Checkpoint)); self.wait(|e| matches!(e, Effect::Recovery(Event::Written { current: true, .. }))); }
    fn save(&mut self, id: DocumentId) -> Arc<[u8]> {
        let target = FileTarget::new("saved.styk");
        let mut effect = self.send(Request::Save { document: id, save_as: true });
        if !matches!(effect, Effect::SaveDialog { .. }) { effect = self.wait(|e| matches!(e, Effect::SaveDialog { .. })); }
        let Effect::SaveDialog { prompt, .. } = effect else { panic!("save dialog") };
        self.send(Request::SaveTarget { prompt, target: Some(target.clone()) }); self.wait(|e| matches!(e, Effect::Saved { current: true, .. }));
        self.files.get(&target).unwrap()
    }
}

#[test]
fn default_deadline_busy_retry_maximum_wait_and_off_match_the_reference() {
    let mut rig = Rig::new(Store::default()); rig.edit(30.0);
    rig.advance(2499); assert_eq!(rig.store.writes(), 0);
    rig.advance(1); assert_eq!(rig.store.writes(), 1);
    assert!(rig.docs.active().unwrap().dirty(), "autosave is not a manual save");
    rig.docs.set_autosave_seconds(0.0); rig.edit(40.0); rig.advance(600_000); assert_eq!(rig.store.writes(), 1);
    rig.docs.set_autosave_seconds(2.5);
    for busy in [Activity { playing: true, ..Activity::default() }, Activity { gesture: true, ..Activity::default() }, Activity { scrubbing: true, ..Activity::default() }, Activity { saving: true, ..Activity::default() }, Activity { exporting: true, ..Activity::default() }] {
        rig.docs.set_recovery_activity(busy); rig.advance(7500); assert_eq!(rig.store.writes(), 1);
    }
    rig.docs.set_recovery_activity(Activity::default()); rig.advance(999); assert_eq!(rig.store.writes(), 1); rig.advance(1); assert_eq!(rig.store.writes(), 2);
    for i in 0..7 { rig.advance(1000); rig.edit(50.0 + i as f64); }
    assert_eq!(rig.store.writes(), 2); rig.advance(500); assert_eq!(rig.store.writes(), 3, "edits retain the 3-interval maximum wait");
}

#[test]
fn resting_copy_waits_1500ms_is_not_cancelled_by_front_edits_and_aborts_when_activated() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); let a = rig.active();
    let b = rig.open("Second.styk"); rig.advance(1499); assert_eq!(rig.store.writes(), 0);
    rig.store.hold.store(true, Ordering::SeqCst); rig.advance(1);
    assert!(rig.store.entered.load(Ordering::SeqCst)); rig.edit(45.0); rig.drain(); assert_eq!(rig.store.writes(), 0);
    rig.store.unblock(); rig.wait(|e| matches!(e, Effect::Recovery(Event::Written { document, current: true }) if *document == a));
    assert_eq!(rig.store.writes(), 1);
    rig.docs.activate(a).unwrap(); rig.edit(35.0); rig.docs.activate(b).unwrap(); rig.store.entered.store(false, Ordering::SeqCst); rig.store.hold.store(true, Ordering::SeqCst);
    rig.advance(1500); assert!(rig.store.entered.load(Ordering::SeqCst)); rig.docs.activate(a).unwrap();
    rig.wait(|e| matches!(e, Effect::Recovery(Event::Written { current: false, .. }))); assert_eq!(rig.store.writes(), 1);
    rig.store.unblock();
}

#[test]
fn failure_backoff_and_three_resting_failures_are_bounded() {
    let mut rig = Rig::new(Store::default()); rig.store.fail.store(true, Ordering::SeqCst); rig.edit(30.0);
    rig.clock.advance(Duration::from_millis(2500)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_))));
    assert_eq!(rig.docs.recovery_deadline(), Some(Duration::from_millis(7500)));
    rig.store.fail.store(false, Ordering::SeqCst); rig.advance(4999); assert_eq!(rig.store.writes(), 0); rig.advance(1); assert_eq!(rig.store.writes(), 1);
    rig.docs.set_autosave_seconds(0.0); rig.edit(40.0); rig.open("Other.styk"); rig.store.fail.store(true, Ordering::SeqCst);
    for delay in [1500, 15000, 15000] { rig.drain(); rig.clock.advance(Duration::from_millis(delay)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_)))); }
    rig.advance(15000); assert_eq!(rig.docs.recovery_deadline(), None); rig.store.fail.store(false, Ordering::SeqCst); rig.advance(300000); assert_eq!(rig.store.writes(), 1);
}

#[test]
fn copies_equal_save_bytes_and_only_current_manual_saves_clean_up() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); rig.checkpoint();
    let copy = rig.store.records()[0].bytes.clone(); let slot = rig.store.records()[0].record.slot.clone(); let id = rig.active(); let saved = rig.save(id);
    assert_eq!(&*copy, &*saved); rig.drain(); assert!(rig.store.records().is_empty());
    rig.edit(40.0); rig.checkpoint(); let count = rig.store.records().len(); assert_eq!(rig.store.records()[0].record.slot, slot, "the open project keeps its issued slot");
    rig.send(Request::Save { document: id, save_as: false }); rig.edit(50.0);
    rig.wait(|e| matches!(e, Effect::Saved { current: false, .. })); rig.drain(); assert_eq!(rig.store.records().len(), count); assert!(rig.docs.active().unwrap().dirty());
}

#[test]
fn failed_cleanup_retains_ownership_and_retries_on_the_next_copy() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); rig.checkpoint();
    let slot = rig.store.records()[0].record.slot.clone(); rig.store.fail_remove.store(true, Ordering::SeqCst); let id = rig.active(); rig.save(id);
    rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_))));
    rig.send(Request::Recovery(Command::Refresh)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Listed))); assert!(rig.docs.recovery_view().unwrap().copies.is_empty());
    rig.edit(40.0); rig.checkpoint(); assert_eq!(rig.store.records()[0].record.slot, slot);
    rig.store.fail_remove.store(false, Ordering::SeqCst); rig.save(id); rig.drain(); assert!(rig.store.records().is_empty());
}

#[test]
fn a_failed_copy_keeps_the_previous_bytes_and_unsaved_history() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); rig.checkpoint();
    let previous = rig.store.records()[0].bytes.clone(); rig.edit(40.0);
    let revision = rig.docs.active().unwrap().revision(); rig.store.fail.store(true, Ordering::SeqCst);
    rig.send(Request::Recovery(Command::Checkpoint)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_))));
    assert_eq!(rig.store.records()[0].bytes, previous); assert_eq!(rig.docs.active().unwrap().revision(), revision); assert!(rig.docs.active().unwrap().dirty());
    rig.store.fail.store(false, Ordering::SeqCst); rig.checkpoint(); assert_ne!(rig.store.records()[0].bytes, previous);
    let id = rig.active(); rig.docs.undo(id).unwrap().result.unwrap(); assert_eq!(rig.docs.get(id).unwrap().with_document(|doc| doc.fps).unwrap(), 30.0);
}

#[test]
fn a_damaged_copy_preserves_the_front_and_releases_its_claim_for_retry() {
    let store = Store::default(); store.insert(Slot::legacy(), Arc::from(&b"not a project"[..]), "Damaged");
    let mut rig = Rig::new(store); let front = rig.active(); rig.edit(30.0); let revision = rig.docs.active().unwrap().revision();
    rig.send(Request::Recovery(Command::Restore(Slot::legacy()))); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_))));
    assert_eq!(rig.active(), front); assert_eq!(rig.docs.tabs().len(), 1); assert_eq!(rig.docs.active().unwrap().revision(), revision);
    rig.send(Request::Recovery(Command::Refresh)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Listed))); assert_eq!(rig.docs.recovery_view().unwrap().copies.len(), 1);
}

#[test]
fn quit_checkpoint_covers_all_dirty_tabs_and_discard_finishes_cleanup_before_quit_ready() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); rig.open("Other.styk"); rig.edit(40.0); rig.drain();
    assert!(matches!(rig.send(Request::Quit), Effect::Recovery(Event::Started)));
    let Effect::ConfirmQuit { prompt, names, .. } = rig.wait(|e| matches!(e, Effect::ConfirmQuit { .. })) else { unreachable!() };
    assert_eq!(names.len(), 2); assert_eq!(rig.store.records().len(), 2);
    rig.send(Request::Respond { prompt, choice: CloseChoice::Discard }); rig.wait(|e| matches!(e, Effect::QuitReady)); assert!(rig.store.records().is_empty());
    rig.advance(100_000); assert!(rig.store.records().is_empty()); assert_eq!(rig.docs.recovery_deadline(), None);
}

#[test]
fn movieclip_recovery_folds_the_scope_without_leaving_it_and_matches_manual_save() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0);
    rig.send(Request::OpenBytes { bytes: Arc::from(&include_bytes!("../../../tests/edit/sheet-movieclip.document.json")[..]), name: "Clip.styk".into() });
    let Effect::Opened(id) = rig.wait(|e| matches!(e, Effect::Opened(_))) else { unreachable!() };
    let type_id = rig.docs.get(id).unwrap().records().unwrap().get("figure_types").unwrap().elements().unwrap().iter().find(|figure| figure.path(&["_styk", "movieclip", "document"]).is_some()).unwrap().get("figure_type_id").unwrap().as_f64().unwrap();
    rig.send(Request::EnterMovieclip { document: id, type_id }); rig.wait(|e| matches!(e, Effect::ScopeChanged(_))); rig.edit(30.0); rig.drain(); rig.checkpoint();
    assert_eq!(rig.docs.get(id).unwrap().scope_depth(), 1); let copy = rig.store.records()[0].bytes.clone();
    let saved = rig.save(id); assert_eq!(&*copy, &*saved); assert_eq!(rig.docs.get(id).unwrap().scope_depth(), 0);
}

#[test]
#[ignore = "run tests/native-recovery-reference.test.mjs first; explicit pinned compatibility oracle"]
fn restores_the_repository_project_written_by_the_pinned_recovery_writer() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../artifacts/native-recovery-reference");
    let bytes = std::fs::read(root.join("first/recovery.styk")).expect("reference generator must run first");
    assert_eq!(bytes, std::fs::read(root.join("source.styk")).unwrap());
    let store = Store::default(); store.insert(Slot::legacy(), Arc::from(bytes.clone()), "Recovered 日本");
    let mut rig = Rig::new(store); rig.send(Request::Recovery(Command::Restore(Slot::legacy())));
    let Effect::Recovery(Event::Restored(id)) = rig.wait(|e| matches!(e, Effect::Recovery(Event::Restored(_)))) else { unreachable!() };
    let engine = Engine::new(|| 0.0, Budgets::for_device(None)); let prepared = PreparedDocument::open_bytes(&engine, Arc::from(bytes), "Reference.styk", &|| false).unwrap();
    let mut expected = Documents::new(); let other = expected.open(prepared).map_err(|(error, _)| error).unwrap();
    assert_eq!(styk_doc::json::to_string(rig.docs.get(id).unwrap().records().unwrap()), styk_doc::json::to_string(expected.get(other).unwrap().records().unwrap()));
    assert_eq!(rig.docs.get(id).unwrap().name(), "Recovered 日本"); assert!(rig.docs.get(id).unwrap().dirty());
}

#[test]
fn chooser_lists_only_unowned_restores_beside_front_and_refuses_changed_or_owned_copies() {
    let store = Store::default(); let legacy = store.insert(Slot::legacy(), Arc::from(STARTUP), "Legacy");
    let named = store.insert(Slot::named("00000000-0000-4000-8000-000000000002").unwrap(), Arc::from(STARTUP), "Second");
    let owned = store.insert(Slot::named("00000000-0000-4000-8000-000000000003").unwrap(), Arc::from(STARTUP), "Owned");
    let lease = styk_services::worker::run_future(store.claim(&owned, &Cancel::new())).unwrap();
    let mut rig = Rig::new(store); let front = rig.active();
    assert_eq!(rig.docs.recovery_view().unwrap().copies, vec![named.clone(), legacy.clone()]);
    rig.send(Request::Recovery(Command::Restore(legacy.slot.clone())));
    let Effect::Recovery(Event::Restored(restored)) = rig.wait(|e| matches!(e, Effect::Recovery(Event::Restored(_)))) else { unreachable!() };
    assert_eq!(rig.docs.tabs().iter().map(|t| t.id()).collect::<Vec<_>>(), vec![front, restored]);
    assert!(rig.docs.get(restored).unwrap().dirty()); assert_eq!(rig.docs.get(restored).unwrap().name(), "Legacy");
    assert_eq!(rig.docs.recovery_view().unwrap().copies, vec![named.clone()]);
    assert!(rig.docs.dispatch(Request::Recovery(Command::Restore(legacy.slot.clone()))).is_err());
    rig.store.insert(named.slot.clone(), Arc::from(STARTUP), "Changed");
    rig.send(Request::Recovery(Command::Discard(named.slot.clone())));
    rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(RecoveryError::Changed)))); assert_eq!(rig.store.records().len(), 3);
    rig.send(Request::Recovery(Command::Refresh)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Listed)));
    let record = rig.docs.recovery_view().unwrap().copies[0].clone(); let other = styk_services::worker::run_future(rig.store.claim(&record, &Cancel::new())).unwrap();
    rig.send(Request::Recovery(Command::Restore(record.slot.clone()))); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(RecoveryError::Owned))));
    drop(other); rig.send(Request::Recovery(Command::Discard(record.slot.clone()))); rig.wait(|e| matches!(e, Effect::Recovery(Event::Discarded(_))));
    assert!(rig.docs.recovery_view().unwrap().copies.is_empty()); drop(lease);
    rig.save(restored); rig.drain(); assert!(!rig.store.records().iter().any(|e| e.record.slot.is_legacy()));
}

#[test]
fn close_checkpoints_with_autosave_off_cancel_preserves_and_discard_deletes_only_its_copy() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); let a = rig.active(); rig.edit(30.0);
    assert!(matches!(rig.send(Request::Close(a)), Effect::Recovery(Event::Started)));
    let Effect::ConfirmClose { prompt, .. } = rig.wait(|e| matches!(e, Effect::ConfirmClose { .. })) else { unreachable!() };
    assert_eq!(rig.store.writes(), 1); rig.send(Request::Respond { prompt, choice: CloseChoice::Cancel }); assert!(rig.docs.get(a).unwrap().dirty());
    rig.send(Request::Close(a)); let Effect::ConfirmClose { prompt, .. } = rig.wait(|e| matches!(e, Effect::ConfirmClose { .. })) else { unreachable!() };
    rig.send(Request::Respond { prompt, choice: CloseChoice::Discard }); rig.wait(|e| matches!(e, Effect::Closed(_))); rig.drain();
    assert!(rig.store.records().is_empty()); assert!(!rig.docs.active().unwrap().dirty());
}

#[test]
fn review_failed_close_checkpoint_is_explicit_in_the_prompt() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0);
    rig.store.fail.store(true, Ordering::SeqCst); let id = rig.active();
    rig.send(Request::Close(id)); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_))));
    let Effect::ConfirmClose { prompt, recovery_error, .. } = rig.wait(|e| matches!(e, Effect::ConfirmClose { .. })) else { unreachable!() };
    assert!(recovery_error.unwrap().contains("Full"), "the close prompt must report the failed checkpoint");
    assert!(rig.docs.get(id).unwrap().dirty()); assert_eq!(rig.store.writes(), 0);
    rig.store.fail.store(false, Ordering::SeqCst);
    assert!(matches!(rig.send(Request::Respond { prompt, choice: CloseChoice::RetryRecovery }), Effect::Recovery(Event::Started)));
    let Effect::ConfirmClose { prompt, recovery_error, .. } = rig.wait(|e| matches!(e, Effect::ConfirmClose { .. })) else { unreachable!() };
    assert_eq!(recovery_error, None); assert_eq!(rig.store.writes(), 1);
    rig.send(Request::Respond { prompt, choice: CloseChoice::Cancel }); assert!(rig.docs.get(id).unwrap().dirty());
}

#[test]
fn review_failed_quit_checkpoint_is_explicit_in_the_prompt() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0);
    rig.store.fail.store(true, Ordering::SeqCst);
    rig.send(Request::Quit); rig.wait(|e| matches!(e, Effect::Recovery(Event::Failed(_))));
    let Effect::ConfirmQuit { prompt, recovery_error, .. } = rig.wait(|e| matches!(e, Effect::ConfirmQuit { .. })) else { unreachable!() };
    assert!(recovery_error.unwrap().contains("Full"), "the quit prompt must report the failed checkpoint");
    assert!(rig.docs.active().unwrap().dirty()); assert_eq!(rig.store.writes(), 0);
    rig.store.fail.store(false, Ordering::SeqCst);
    rig.send(Request::Respond { prompt, choice: CloseChoice::RetryRecovery });
    let Effect::ConfirmQuit { prompt, recovery_error, .. } = rig.wait(|e| matches!(e, Effect::ConfirmQuit { .. })) else { unreachable!() };
    assert_eq!(recovery_error, None); assert_eq!(rig.store.writes(), 1);
    rig.send(Request::Respond { prompt, choice: CloseChoice::Cancel }); assert!(rig.docs.active().unwrap().dirty());
}

#[test]
fn review_another_tabs_in_flight_checkpoint_cannot_complete_a_close() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); let closing = rig.active();
    rig.open("Other.styk"); rig.edit(40.0); rig.drain();
    rig.store.hold.store(true, Ordering::SeqCst); rig.send(Request::Recovery(Command::Checkpoint)); rig.drain();
    assert!(rig.store.entered.load(Ordering::SeqCst));
    rig.send(Request::Close(closing)); rig.store.unblock();
    let Effect::ConfirmClose { document, prompt, recovery_error, .. } = rig.wait(|e| matches!(e, Effect::ConfirmClose { .. })) else { unreachable!() };
    assert_eq!(document, closing); assert_eq!(recovery_error, None);
    assert_eq!(rig.store.records().len(), 2, "the closing tab needs its own current checkpoint");
    rig.send(Request::Respond { prompt, choice: CloseChoice::Cancel });
}

#[test]
fn an_edit_and_owner_drop_cancel_a_blocked_write_without_waiting_or_losing_good_bytes() {
    let mut rig = Rig::new(Store::default()); rig.docs.set_autosave_seconds(0.0); rig.edit(30.0); rig.checkpoint(); let previous = rig.store.records()[0].bytes.clone();
    rig.store.hold.store(true, Ordering::SeqCst); rig.store.entered.store(false, Ordering::SeqCst); rig.edit(40.0); rig.send(Request::Recovery(Command::Checkpoint)); rig.drain();
    assert!(rig.store.entered.load(Ordering::SeqCst)); rig.edit(50.0);
    rig.wait(|e| matches!(e, Effect::Recovery(Event::Written { current: false, .. }))); assert_eq!(rig.store.records()[0].bytes, previous);
    rig.send(Request::Recovery(Command::Checkpoint)); rig.drain(); let store = rig.store.clone();
    let (send, receive) = std::sync::mpsc::channel(); std::thread::spawn(move || { drop(rig); send.send(()).unwrap(); });
    receive.recv_timeout(Duration::from_secs(1)).expect("drop never joins the blocked recovery worker"); store.unblock();
    assert_eq!(store.records()[0].bytes, previous);
}
