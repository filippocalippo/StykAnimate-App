//! The recovery views' logic through the core: the offer as the stage's message, the chooser and the close prompt as dialogs
//! on the overlay stack, every event a request to the documents host and every answer read back on `Core::refresh`. The store
//! is a private in-memory one; the documents host, its recovery lane and its workers are the real ones.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use styk_core::app::Core;
use styk_core::commands::Command;
use styk_core::documents::{Effect as Doc, Request};
use styk_core::overlay::host::Event as Overlay;
use styk_core::overlay::messages::Do;
use styk_core::overlay::Kind;
use styk_core::recovery::model::{Choice, Event};
use styk_services::recovery::*;
use styk_services::{Cancel, Job, SpawnError, Spawner};
use styk_services::files::FileError;

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

struct Threads;
impl Spawner for Threads {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
        std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|error| SpawnError(error.to_string()))
    }
}

#[derive(Clone)]
struct Entry {
    record: Record,
    bytes: Arc<[u8]>,
    owned: bool,
}
#[derive(Default)]
struct State {
    entries: HashMap<Slot, Entry>,
    serial: u64,
}
/// An in-memory store. `fail` makes every write fail (the close prompt's recovery error); `locked` slots refuse a claim.
#[derive(Clone, Default)]
struct Store {
    state: Arc<Mutex<State>>,
    fail: Arc<AtomicBool>,
}
impl Store {
    fn seed(&self, name: &str) -> Slot {
        let mut state = self.state.lock().unwrap();
        state.serial += 1;
        let slot = Slot::named(&format!("00000000-0000-4000-8000-{:012x}", state.serial)).unwrap();
        let mut version = [0; 32];
        version[..8].copy_from_slice(&state.serial.to_le_bytes());
        let bytes: Arc<[u8]> = Arc::from(STARTUP);
        let record = Record { slot: slot.clone(), name: name.into(), saved_at: format!("2026-11-08T00:00:{:02}.000Z", state.serial), size: bytes.len(), version, selection: Some(version) };
        state.entries.insert(slot.clone(), Entry { record, bytes, owned: false });
        slot
    }
    fn lock(&self, slot: &Slot) {
        self.state.lock().unwrap().entries.get_mut(slot).unwrap().owned = true;
    }
    fn count(&self) -> usize {
        self.state.lock().unwrap().entries.len()
    }
}
struct Copy {
    store: Store,
    slot: Slot,
}
impl Recovery for Store {
    fn list<'a>(&'a self, _: &'a Cancel) -> RecoveryFuture<'a, Vec<Record>> {
        Box::pin(async move {
            let mut records: Vec<Record> = self.state.lock().unwrap().entries.values().filter(|entry| !entry.owned).map(|entry| entry.record.clone()).collect();
            records.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
            Ok(records)
        })
    }
    fn create<'a>(&'a self, _: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            state.serial += 1;
            let slot = Slot::named(&format!("00000000-0000-4000-8000-{:012x}", state.serial)).unwrap();
            Ok(Arc::new(Copy { store: self.clone(), slot }) as Arc<dyn RecoveryCopy>)
        })
    }
    fn claim<'a>(&'a self, record: &'a Record, _: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            let entry = state.entries.get_mut(&record.slot).ok_or(RecoveryError::Missing)?;
            if entry.owned {
                return Err(RecoveryError::Owned);
            }
            entry.owned = true;
            Ok(Arc::new(Copy { store: self.clone(), slot: record.slot.clone() }) as Arc<dyn RecoveryCopy>)
        })
    }
}
impl RecoveryCopy for Copy {
    fn slot(&self) -> &Slot {
        &self.slot
    }
    fn read<'a>(&'a self, record: &'a Record, _: usize, _: &'a Cancel) -> RecoveryFuture<'a, Arc<[u8]>> {
        Box::pin(async move { self.store.state.lock().unwrap().entries.get(&record.slot).map(|entry| entry.bytes.clone()).ok_or(RecoveryError::Missing) })
    }
    fn write<'a>(&'a self, _: Option<&'a Record>, bytes: &'a [u8], name: &'a str, _: &'a Cancel) -> RecoveryFuture<'a, Record> {
        Box::pin(async move {
            if self.store.fail.load(Ordering::SeqCst) {
                return Err(FileError::Full.into());
            }
            let mut state = self.store.state.lock().unwrap();
            state.serial += 1;
            let mut version = [0; 32];
            version[..8].copy_from_slice(&state.serial.to_le_bytes());
            let record = Record { slot: self.slot.clone(), name: name.into(), saved_at: "2026-11-08T00:01:00.000Z".into(), size: bytes.len(), version, selection: Some(version) };
            state.entries.insert(self.slot.clone(), Entry { record: record.clone(), bytes: Arc::from(bytes), owned: true });
            Ok(record)
        })
    }
    fn remove<'a>(&'a self, record: &'a Record, _: &'a Cancel) -> RecoveryFuture<'a, ()> {
        Box::pin(async move {
            self.store.state.lock().unwrap().entries.remove(&record.slot);
            Ok(())
        })
    }
}

/// A core with one project open ("Front.styk") and the store's copies offered.
fn core_with(store: &Store) -> Core {
    let mut core = styk_core::testing::core_with_document(STARTUP, "Front.styk", Arc::new(Threads)).unwrap();
    styk_core::testing::attach_recovery(&mut core, Arc::new(store.clone())).unwrap();
    core
}

fn send(core: &mut Core, event: Event) {
    core.dispatch(Command::Recovery(event));
    core.refresh();
}

/// Waits for the documents host to answer what the last event asked for.
fn settle(core: &mut Core) {
    styk_core::testing::poll_until(core, |core| core.documents.recovery_view().is_some_and(|view| !view.busy)).unwrap();
}

fn offer(core: &Core) -> Option<(String, String, Vec<String>)> {
    core.overlays().messages().current().map(|message| (message.title.clone(), message.text.clone(), message.actions.iter().map(|action| action.label.clone()).collect()))
}

fn dialogs(core: &Core) -> usize {
    core.overlays().stack().entries().iter().filter(|entry| entry.kind == Kind::Dialog).count()
}

#[test]
fn one_copy_is_offered_by_name_and_time_and_several_by_count() {
    let store = Store::default();
    store.seed("Rooftop fight");
    let core = core_with(&store);
    assert_eq!(offer(&core), Some(("Restore unsaved work".into(), "in Rooftop fight from 12:00 AM?".into(), vec!["Not now".into(), "Restore".into()])));
    let message = core.overlays().messages().current().unwrap();
    assert_eq!(message.icon.as_deref(), Some("clock"));
    assert!(!message.dismissible && message.timeout == 0, "the offer waits for an answer");

    let store = Store::default();
    store.seed("Rooftop fight");
    store.seed("Chase");
    let core = core_with(&store);
    assert_eq!(offer(&core), Some(("Restore unsaved work".into(), "2 recovery copies are available.".into(), vec!["Not now".into(), "Manage copies".into(), "Restore".into()])));
}

#[test]
fn a_copy_without_a_name_is_named_for_the_project_in_front() {
    let store = Store::default();
    store.seed("");
    let core = core_with(&store);
    let front = core.documents.active().unwrap().name().to_string();
    assert_eq!(offer(&core).unwrap().1, format!("in {front} from 12:00 AM?"));
}

#[test]
fn not_now_hides_the_offer_and_the_copy_stays_on_disk() {
    let store = Store::default();
    store.seed("Rooftop fight");
    let mut core = core_with(&store);
    send(&mut core, Event::NotNow);
    assert_eq!(offer(&core), None);
    assert!(!core.documents.recovery_view().unwrap().visible);
    assert_eq!(store.count(), 1, "dismissing deletes nothing");
}

#[test]
fn an_offer_action_reaches_the_core_through_the_message_host() {
    let store = Store::default();
    store.seed("Rooftop fight");
    store.seed("Chase");
    let mut core = core_with(&store);
    let message = core.overlays().messages().current().unwrap().clone();
    assert_eq!(message.actions[1].command, Do::Recovery(Event::Manage), "Manage copies carries its recovery event");
    // The action the toast reports: the host hands the event to the core, which opens the chooser.
    let now = core.overlays().now();
    core.dispatch(Command::Overlay { event: Overlay::MessageAction { id: message.id, index: 1 }, now });
    core.refresh();
    assert_eq!(dialogs(&core), 1, "Manage copies opened the chooser");
    assert!(offer(&core).is_some(), "Manage copies leaves the offer standing, as today");
}

#[test]
fn the_offers_restore_restores_the_only_copy_and_asks_among_several() {
    let store = Store::default();
    store.seed("Rooftop fight");
    let mut core = core_with(&store);
    let tabs = core.documents.tabs().len();
    send(&mut core, Event::Restore);
    assert_eq!(dialogs(&core), 0, "one copy is restored without asking");
    settle(&mut core);
    assert_eq!(core.documents.tabs().len(), tabs + 1, "the copy opened beside the project in front");
    assert!(core.documents.active().unwrap().dirty(), "it opens with unsaved changes");
    assert_eq!(offer(&core), None, "nothing is left to offer");

    let store = Store::default();
    store.seed("Rooftop fight");
    store.seed("Chase");
    let mut core = core_with(&store);
    send(&mut core, Event::Restore);
    assert_eq!(dialogs(&core), 1, "several copies are chosen from");
}

#[test]
fn the_chooser_lists_selects_restores_and_closes() {
    let store = Store::default();
    store.seed("Rooftop fight");
    store.seed("Chase");
    let mut core = core_with(&store);
    send(&mut core, Event::Manage);
    let (overlay, chooser) = core.recovery_chooser().expect("the chooser is open");
    assert_eq!(core.recovery().chooser_overlay(), Some(overlay));
    assert_eq!(chooser.rows.iter().map(|row| row.text(&core.presentation().label(&row.name))).collect::<Vec<_>>(), ["Chase \u{b7} 11/8/26, 12:00 AM", "Rooftop fight \u{b7} 11/8/26, 12:00 AM"]);
    assert_eq!(chooser.selected, Some(0), "the newest copy is selected");
    assert!(!chooser.busy && chooser.error.is_none());

    let second = chooser.rows[1].slot.clone();
    send(&mut core, Event::Pick(second.clone()));
    assert_eq!(core.recovery_chooser().unwrap().1.selected, Some(1));

    let tabs = core.documents.tabs().len();
    send(&mut core, Event::RestoreChosen);
    assert!(core.recovery_chooser().unwrap().1.busy, "the host is working: the dialog's buttons are busy");
    styk_core::testing::poll_until(&mut core, |core| core.recovery().chooser_overlay().is_none()).unwrap();
    assert_eq!(dialogs(&core), 0, "the restored copy closed the dialog");
    assert_eq!(core.documents.tabs().len(), tabs + 1);
    let view = core.documents.recovery_view().unwrap();
    assert!(view.copies.iter().all(|copy| copy.slot != second), "the restored copy left the list");
    assert_eq!(offer(&core).unwrap().1, "in Chase from 12:00 AM?", "the one copy left is offered again");
}

#[test]
fn discarding_removes_the_copy_and_the_last_one_closes_the_chooser() {
    let store = Store::default();
    store.seed("Rooftop fight");
    store.seed("Chase");
    let mut core = core_with(&store);
    send(&mut core, Event::Manage);
    send(&mut core, Event::DiscardChosen);
    settle(&mut core);
    let (_, chooser) = core.recovery_chooser().expect("a copy is left to choose from");
    assert_eq!(chooser.rows.len(), 1);
    assert_eq!(chooser.selected, Some(0), "the next copy is selected");
    assert_eq!(store.count(), 1, "the copy was removed for good");
    send(&mut core, Event::DiscardChosen);
    styk_core::testing::poll_until(&mut core, |core| core.recovery().chooser_overlay().is_none()).unwrap();
    assert_eq!(dialogs(&core), 0, "no copy is left: the dialog closes");
    assert_eq!(offer(&core), None);
    assert_eq!(store.count(), 0);
}

#[test]
fn a_copy_the_host_cannot_restore_reports_why_and_keeps_the_dialog() {
    let store = Store::default();
    let slot = store.seed("Rooftop fight");
    store.seed("Chase");
    let mut core = core_with(&store);
    send(&mut core, Event::Manage);
    // The copy is taken by another window after it was listed.
    store.lock(&slot);
    send(&mut core, Event::Pick(slot.clone()));
    send(&mut core, Event::RestoreChosen);
    styk_core::testing::poll_until(&mut core, |core| core.documents.recovery_view().is_some_and(|view| !view.busy)).unwrap();
    let (_, chooser) = core.recovery_chooser().expect("the dialog stays open");
    assert_eq!(chooser.error, Some(styk_core::i18n::Label::key("errors.app.thisRecoveryCopyIsOpenInAnotherTab")), "the refusal is shown under the body in today's words");
    assert_eq!(core.presentation().label(chooser.error.as_ref().unwrap()), "This recovery copy is open in another tab.");
    assert!(chooser.rows.iter().any(|row| row.slot == slot), "the copy is still listed");
    assert!(!chooser.busy, "the buttons work again");
}

#[test]
fn cancel_and_escape_close_the_chooser_and_keep_every_copy() {
    let store = Store::default();
    store.seed("Rooftop fight");
    store.seed("Chase");
    let mut core = core_with(&store);
    send(&mut core, Event::Manage);
    send(&mut core, Event::CancelChooser);
    assert_eq!(dialogs(&core), 0);
    assert!(core.recovery_chooser().is_none());
    send(&mut core, Event::Manage);
    let now = core.overlays().now();
    core.dispatch(Command::Overlay { event: Overlay::Escape, now });
    core.refresh();
    assert_eq!(dialogs(&core), 0, "Escape closed it");
    assert!(core.recovery_chooser().is_none());
    assert_eq!(core.documents.recovery_view().unwrap().copies.len(), 2);
    send(&mut core, Event::Manage);
    assert_eq!(dialogs(&core), 1, "it opens again");
}

/// A project with unsaved changes asked to close: the host answers with a confirmation, which the core shows as the close prompt.
fn confirm_close(core: &mut Core) -> Doc {
    let id = core.documents.active().unwrap().id();
    core.documents.call(id, "setFPS", &[styk_core::engine::Value::Num(30.0)], &styk_core::engine::Value::Null).unwrap().result.unwrap();
    let asked = core.documents.dispatch(Request::Close(id)).map_err(|(error, _)| error).unwrap();
    let mut effect = asked;
    // A failed or running checkpoint comes first: wait for the confirmation.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !matches!(effect, Doc::ConfirmClose { .. }) {
        assert!(std::time::Instant::now() < deadline, "no confirmation");
        if let Some(next) = core.documents.poll() {
            effect = next;
        }
        std::thread::yield_now();
    }
    effect
}

#[test]
fn the_close_prompt_asks_and_cancel_keeps_the_project() {
    let store = Store::default();
    let mut core = core_with(&store);
    let effect = confirm_close(&mut core);
    let Doc::ConfirmClose { name, .. } = &effect else { unreachable!() };
    let name = name.clone();
    core.document_effect(&effect);
    let (_, prompt) = core.recovery().closing().expect("the prompt is open");
    assert_eq!(core.presentation().label(&prompt.title), format!("Save changes to {name}?"));
    assert_eq!(core.presentation().label(&prompt.body), "Your changes will be lost if you don't save them.");
    assert!(prompt.warning.is_none() && !prompt.retry(), "no recovery failure, no Retry");
    assert_eq!(dialogs(&core), 1);
    let tabs = core.documents.tabs().len();
    send(&mut core, Event::Respond(Choice::Cancel));
    assert_eq!(dialogs(&core), 0);
    assert!(core.recovery().closing().is_none());
    assert_eq!(core.documents.tabs().len(), tabs, "Cancel keeps the project open");
}

#[test]
fn a_failed_recovery_copy_shows_under_the_prompt_and_retry_goes_on_with_the_close() {
    let store = Store::default();
    store.fail.store(true, Ordering::SeqCst);
    let mut core = core_with(&store);
    let effect = confirm_close(&mut core);
    assert!(matches!(&effect, Doc::ConfirmClose { recovery_error: Some(_), .. }), "the checkpoint failed: {effect:?}");
    core.document_effect(&effect);
    let (_, prompt) = core.recovery().closing().expect("the prompt is open");
    assert!(prompt.retry(), "Retry shows beside the failure");
    let warning = core.presentation().label(prompt.warning.as_ref().unwrap());
    assert!(warning.starts_with("Recovery copy could not be written: "), "{warning}");

    // The disk works again: Retry writes the copy and the close goes on to its own question.
    store.fail.store(false, Ordering::SeqCst);
    send(&mut core, Event::Respond(Choice::Retry));
    assert_eq!(dialogs(&core), 0, "the prompt closed while the copy is written");
    styk_core::testing::poll_until(&mut core, |core| core.recovery().closing().is_some()).unwrap();
    assert!(!core.recovery().closing().unwrap().1.retry(), "the second question carries no failure");
}
