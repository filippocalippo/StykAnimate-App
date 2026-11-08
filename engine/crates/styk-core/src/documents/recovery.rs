//! Autosave deadlines, copy ownership and the chooser's logic. No widget or file I/O lives here.
use super::*;
use super::host::{HostOptions, EngineLifetime};
use std::time::Duration;
use styk_engine::save::{EngineHost, ProjectRequest, save_project};
use styk_services::{Cancel, Clock};
use styk_services::recovery::{Recovery, RecoveryCopy, RecoveryError, Record, Slot, MAX_BYTES};
use styk_services::worker::{Worker, run_future, run_scheduled};

pub const DEFAULT_AUTOSAVE_SECONDS: f64 = 2.5;

#[derive(Clone, Copy, Debug, Default)]
pub struct Activity { pub playing: bool, pub scrubbing: bool, pub gesture: bool, pub importing: bool, pub saving: bool, pub exporting: bool }
impl Activity { fn busy(self) -> bool { self.playing || self.scrubbing || self.gesture || self.importing || self.saving || self.exporting } }
#[derive(Clone, Debug, Default)]
pub struct View { pub copies: Vec<Record>, pub selected: Option<Slot>, pub visible: bool, pub busy: bool, pub error: Option<String> }
#[derive(Clone, Debug)]
pub enum Command { Refresh, Select(Slot), Restore(Slot), Discard(Slot), Dismiss, Checkpoint }
#[derive(Debug)]
pub enum Event { Started, Listed, Dismissed, Selected, Written { document: DocumentId, current: bool }, Restored(DocumentId), Discarded(Slot), Cleaned, Failed(RecoveryError) }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp { id: DocumentId, lineage: u64, revision: u64, epoch: u64, depth: usize }
impl Stamp { fn of(tab: &Document) -> Self { Self { id: tab.id, lineage: tab.scopes.first().map_or(tab.lineage(), |scope| scope.parent.lineage), revision: tab.revision(), epoch: tab.epoch, depth: tab.scopes.len() } } }
#[derive(Clone)]
struct Owned { lease: Arc<dyn RecoveryCopy>, record: Option<Record> }
struct Cleanup { owned: Owned, document: Option<(DocumentId, u64)> }
#[derive(Default)]
pub(super) struct CopyState { owned: Option<Owned>, current: Option<Stamp>, seen: Option<Stamp>, failures: u8 }
#[derive(Default)]
struct Deadline { since: Option<Duration>, retry: Duration, due: Option<Duration> }
impl Deadline {
    fn schedule(&mut self, now: Duration, interval: Duration, backoff: u32) {
        let since = *self.since.get_or_insert(now);
        let maximum = interval.max((interval * 3).min(Duration::from_secs(60)));
        self.due = Some((now + interval * backoff).min(since + maximum).max(self.retry));
    }
    fn retry(&mut self, now: Duration, delay: Duration) { self.retry = now + delay; self.due = Some(self.retry); }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind { Front, Resting, Forced }
struct Snapshot { stamp: Stamp, trees: Vec<Value>, scopes: Vec<f64>, name: String, original_first: bool, owned: Option<Owned> }
enum Input { Save(Snapshot), List, Restore(Record), Discard(Record), Remove(Owned) }
enum Output { Written(Owned), Listed(Vec<Record>), Restored(PreparedDocument, Owned), Discarded(Slot), Removed }
struct Work { input: Input, cancel: Cancel }
enum Action { Write(Stamp, Kind), List, Restore(Slot), Discard(Slot), Remove(Cleanup) }
struct Pending { action: Action, cancel: Cancel }
type Reply = Result<Output, HostError>;
#[derive(Clone, Copy)]
pub(super) enum CloseIntent { Close(DocumentId), Quit }
struct Closing { intent: CloseIntent, stamps: Vec<Stamp>, done: Vec<DocumentId>, failure: Option<String> }

pub(super) struct RecoveryHost {
    worker: Option<Worker<Work, Reply>>,
    clock: Arc<dyn Clock>,
    pending: Option<Pending>,
    retired: Vec<Box<dyn Send>>,
    cleanup: Vec<Cleanup>,
    interval: Duration,
    front: Option<DocumentId>,
    deadline: Deadline,
    resting: Option<Duration>,
    backoff: u32,
    activity: Activity,
    view: View,
    refresh: bool,
    closing: Option<Closing>,
    checkpoint: bool,
    quitting: bool,
    quit_ready: bool,
}

fn execute(options: &HostOptions, store: &dyn Recovery, work: Work) -> Reply {
    let cancel = &work.cancel;
    let error = HostError::Recovery;
    match work.input {
        Input::List => run_future(store.list(cancel)).map(Output::Listed).map_err(error),
        Input::Save(snapshot) => {
            let host = EngineHost { engine: Some(&options.engine), cancel: &|| cancel.is_cancelled(), clock: options.clock, helpers: 0, aside: false };
            let written = save_project(&snapshot.trees, &snapshot.scopes, ProjectRequest { reservation: None, name: Some(snapshot.name.clone()), original_first: snapshot.original_first }, &host)?;
            if let Some(warning) = written.warning { return Err(HostError::Recovery(RecoveryError::Unavailable(warning))); }
            let lease = match &snapshot.owned { Some(owned) => owned.lease.clone(), None => run_future(store.create(cancel)).map_err(error)? };
            let record = run_future(lease.write(snapshot.owned.as_ref().and_then(|owned| owned.record.as_ref()), &written.bytes, &snapshot.name, cancel)).map_err(error)?;
            Ok(Output::Written(Owned { lease, record: Some(record) }))
        }
        Input::Restore(record) => {
            let lease = run_future(store.claim(&record, cancel)).map_err(error)?;
            const SCRATCH: usize = 1 << 20;
            let size = record.size.min(MAX_BYTES);
            let memory = styk_alloc::reserve(size.saturating_mul(2).saturating_add(SCRATCH)).map_err(|error| HostError::from(OpenError::out_of_memory(error)))?;
            let bytes = run_future(lease.read(&record, size, cancel)).map_err(error)?;
            drop(memory);
            let mut prepared = PreparedDocument::open_application(&options.engine, bytes, "recovery.styk", &|| cancel.is_cancelled())?;
            prepared.name = record.name.clone(); prepared.set_clock(options.clock);
            prepared.session.get_mut()?.call_native("@touch", &[], &Value::Null).result?;
            Ok(Output::Restored(prepared, Owned { lease, record: Some(record) }))
        }
        Input::Discard(record) => {
            let lease = run_future(store.claim(&record, cancel)).map_err(error)?;
            run_future(lease.remove(&record, cancel)).map_err(error)?;
            Ok(Output::Discarded(record.slot))
        }
        Input::Remove(owned) => { if let Some(record) = &owned.record { run_future(owned.lease.remove(record, cancel)).map_err(error)?; } Ok(Output::Removed) }
    }
}

impl RecoveryHost {
    pub(super) fn start(options: Arc<HostOptions>, lifetime: Arc<EngineLifetime>, store: Arc<dyn Recovery>, clock: Arc<dyn Clock>) -> Result<Self, HostError> {
        let job_options = options.clone();
        let worker = Worker::start(options.spawner.as_ref(), "styk-recovery", move |work| {
            let _keep = &lifetime; let options = job_options.clone(); let store = store.clone();
            run_scheduled(|job| job_options.engine.spawn(move |_| job()), move || execute(&options, store.as_ref(), work)).unwrap_or(Err(HostError::NoHost))
        }, options.notify.clone()).map_err(|error| HostError::Spawn(error.to_string()))?;
        Ok(Self { worker: Some(worker), clock, pending: None, retired: Vec::new(), cleanup: Vec::new(), interval: Duration::from_millis(2500), front: None,
            deadline: Deadline::default(), resting: None, backoff: 1, activity: Activity::default(), view: View::default(), refresh: true, closing: None, checkpoint: false, quitting: false, quit_ready: false })
    }
    fn start_job(&mut self, action: Action, input: Input) -> bool {
        if self.pending.is_some() || !self.flush() { self.retired.push(Box::new(input)); return false; }
        let cancel = Cancel::new();
        let Some(worker) = &self.worker else { self.retired.push(Box::new(input)); return false; };
        match worker.submit(Work { input, cancel: cancel.clone() }) {
            Ok(()) => { self.pending = Some(Pending { action, cancel }); self.view.busy = true; true }
            Err(work) => { self.retired.push(Box::new(work)); false }
        }
    }
    fn flush(&mut self) -> bool {
        if self.retired.is_empty() { return true; }
        let Some(worker) = &self.worker else { return false; };
        match worker.retire(std::mem::take(&mut self.retired)) { Ok(()) => true, Err(retired) => { self.retired = retired; false } }
    }
    pub(super) fn release(&mut self, state: &mut CopyState) {
        if let Some(owned) = state.owned.take() {
            if owned.record.is_some() { self.queue_cleanup(Cleanup { owned, document: None }); } else { self.retired.push(Box::new(owned)); }
        }
        *state = CopyState::default();
    }
    pub(super) fn saved(&mut self, tab: &mut Document) {
        let stamp = Stamp::of(tab);
        if let Some(owned) = &mut tab.recovery.owned && let Some(record) = owned.record.take() {
            // Keep this tab's issued slot and lease through save/edit cycles. A failed removal
            // returns its identity so a retry can replace it and it never appears as unowned.
            self.queue_cleanup(Cleanup { owned: Owned { lease: owned.lease.clone(), record: Some(record) }, document: Some((tab.id, stamp.lineage)) });
        }
        tab.recovery.current = None;
    }
    fn queue_cleanup(&mut self, cleanup: Cleanup) {
        if let Some(queued) = self.cleanup.iter_mut().find(|queued| Arc::ptr_eq(&queued.owned.lease, &cleanup.owned.lease)) { *queued = cleanup; }
        else { self.cleanup.push(cleanup); }
    }
    pub(super) fn stop(mut self) {
        if let Some(pending) = self.pending.take() { pending.cancel.cancel(); }
        if let Some(worker) = self.worker.take() { worker.shutdown(Box::new((self.cleanup, self.retired))); }
    }
}

impl Documents {
    pub(super) fn finish_quit(&mut self) -> Effect {
        let Some(host) = self.recovery.as_mut() else { return Effect::QuitReady; };
        host.quitting = true; host.quit_ready = false;
        if let Some(pending) = &host.pending { pending.cancel.cancel(); }
        for tab in &mut self.tabs { host.release(&mut tab.recovery); }
        Effect::Recovery(Event::Started)
    }
    pub(super) fn interrupt_recovery(&mut self, id: DocumentId) {
        if let Some(host) = &self.recovery && let Some(Pending { action: Action::Write(stamp, _), cancel }) = &host.pending && stamp.id == id { cancel.cancel(); }
    }
    pub(super) fn recovery_writing(&self, id: DocumentId) -> bool {
        self.recovery.as_ref().is_some_and(|host| host.pending.as_ref().is_some_and(|pending| matches!(pending.action, Action::Write(stamp, _) if stamp.id == id)))
    }
    /// Requires the documents host. Initial listing is queued by `poll`; no service runs here.
    pub fn attach_recovery(&mut self, store: Arc<dyn Recovery>, clock: Arc<dyn Clock>) -> Result<(), HostError> {
        if self.recovery.is_some() { return Err(DocumentsError::Busy.into()); }
        let host = self.host.as_ref().ok_or(HostError::NoHost)?;
        self.recovery = Some(RecoveryHost::start(host.options.clone(), host.lifetime.clone(), store, clock)?);
        self.sync_recovery(); Ok(())
    }
    pub fn recovery_view(&self) -> Option<&View> { self.recovery.as_ref().map(|host| &host.view) }
    pub fn set_autosave_seconds(&mut self, seconds: f64) {
        let Some(host) = self.recovery.as_mut() else { return; };
        let seconds = if seconds.is_finite() { seconds.clamp(0.0, 300.0) } else { DEFAULT_AUTOSAVE_SECONDS };
        host.interval = Duration::from_secs_f64(seconds);
        host.deadline = Deadline::default();
        for tab in &mut self.tabs { tab.recovery.seen = None; }
        self.sync_recovery();
    }
    pub fn set_recovery_activity(&mut self, activity: Activity) {
        if let Some(host) = self.recovery.as_mut() {
            if activity.busy() && let Some(Pending { action: Action::Write(_, Kind::Front), cancel }) = &host.pending && cancel.cancel() { host.backoff = (host.backoff * 2).min(12); }
            host.activity = activity;
        }
    }
    /// Schedule an event-loop wake at this monotonic time. `poll` also starts jobs at this deadline.
    pub fn recovery_deadline(&self) -> Option<Duration> {
        let host = self.recovery.as_ref()?;
        if host.pending.is_some() || host.quitting { return None; }
        host.deadline.due.into_iter().chain(host.resting).min()
    }
    pub(super) fn sync_recovery(&mut self) {
        let Some(host) = self.recovery.as_mut() else { return; }; let now = host.clock.now();
        if host.quitting { return; }
        let switched = host.front != self.active;
        if switched {
            if let Some(Pending { action: Action::Write(stamp, kind), cancel }) = &host.pending
                && (*kind == Kind::Front || Some(stamp.id) == self.active) { cancel.cancel(); }
            host.front = self.active; host.deadline = Deadline::default(); host.backoff = 1;
        }
        for tab in &mut self.tabs {
            let stamp = Stamp::of(tab); let changed = tab.recovery.seen != Some(stamp);
            if changed {
                if let Some(Pending { action: Action::Write(writing, kind), cancel }) = &host.pending
                    && writing.id == tab.id && *writing != stamp && *kind != Kind::Resting {
                    if cancel.cancel() { host.backoff = (host.backoff * 2).min(12); }
                }
                tab.recovery.seen = Some(stamp);
            }
            if Some(tab.id) == self.active {
                if tab.view().is_ok_and(|view| view.editing) && let Some(Pending { action: Action::Write(_, Kind::Front), cancel }) = &host.pending { cancel.cancel(); }
                if !tab.dirty() || host.interval.is_zero() { host.deadline = Deadline::default(); }
                else if changed || switched && tab.recovery.current != Some(stamp) { host.deadline.schedule(now, host.interval, host.backoff); }
            }
        }
        let owed = self.tabs.iter().any(|tab| Some(tab.id) != self.active && tab.dirty() && tab.recovery.current != Some(Stamp::of(tab)) && tab.recovery.failures < 3);
        if owed && host.resting.is_none() { host.resting = Some(now + Duration::from_millis(1500)); }
        if !owed { host.resting = None; }
    }
    pub(super) fn recovery_close(&mut self, intent: CloseIntent) -> Result<Option<Effect>, HostError> {
        let Some(host) = self.recovery.as_mut() else { return Ok(None); };
        if host.closing.is_some() { return Err(DocumentsError::Busy.into()); }
        let stamps: Vec<_> = self.tabs.iter().filter(|tab| tab.dirty() && match intent { CloseIntent::Close(id) => tab.id == id, CloseIntent::Quit => true }).map(Stamp::of).collect();
        if stamps.is_empty() { return Ok(None); }
        if self.tabs.iter().any(|tab| stamps.iter().any(|stamp| stamp.id == tab.id) && tab.view().map_or(true, |view| view.editing)) { return Err(DocumentsError::FinishEdit.into()); }
        host.closing = Some(Closing { intent, stamps, done: Vec::new(), failure: None });
        Ok(Some(Effect::Recovery(Event::Started)))
    }
    pub(super) fn recovery_command(&mut self, command: &Command) -> Result<Effect, HostError> {
        let host = self.recovery.as_mut().ok_or(HostError::NoHost)?;
        match command {
            Command::Dismiss => { host.view.visible = false; Ok(Effect::Recovery(Event::Dismissed)) }
            Command::Select(slot) => {
                if !host.view.copies.iter().any(|record| record.slot == *slot) { return Err(HostError::Recovery(RecoveryError::Missing)); }
                host.view.selected = Some(slot.clone()); Ok(Effect::Recovery(Event::Selected))
            }
            Command::Refresh => { host.refresh = true; Ok(Effect::Recovery(Event::Started)) }
            Command::Checkpoint => { host.checkpoint = true; Ok(Effect::Recovery(Event::Started)) }
            Command::Restore(slot) | Command::Discard(slot) => {
                if host.pending.is_some() || host.closing.is_some() || !host.cleanup.is_empty() || !host.flush() { return Err(DocumentsError::Busy.into()); }
                let record = host.view.copies.iter().find(|record| record.slot == *slot).cloned().ok_or(HostError::Recovery(RecoveryError::Missing))?;
                if matches!(command, Command::Restore(_)) {
                    if self.tabs.len() >= MAX_OPEN_PROJECTS { return Err(DocumentsError::TabLimit.into()); }
                    if self.active().is_some_and(|tab| tab.view().map_or(true, |view| view.editing)) { return Err(DocumentsError::FinishEdit.into()); }
                }
                let host = self.recovery.as_mut().ok_or(HostError::NoHost)?;
                let (action, input) = if matches!(command, Command::Restore(_)) { (Action::Restore(slot.clone()), Input::Restore(record)) } else { (Action::Discard(slot.clone()), Input::Discard(record)) };
                if !host.start_job(action, input) { return Err(DocumentsError::Busy.into()); }
                Ok(Effect::Recovery(Event::Started))
            }
        }
    }
    pub(super) fn poll_recovery(&mut self) -> Option<Effect> {
        self.sync_recovery();
        let host = self.recovery.as_mut()?;
        if !host.flush() { return None; }
        if let Some(reply) = host.worker.as_ref()?.take() {
            let pending = host.pending.take()?; host.view.busy = false;
            return Some(self.accept_recovery(pending, reply));
        }
        if host.pending.is_some() { return None; }
        // No new copy can be created until cleanup is drained: at most twelve tab leases and one
        // in-flight copy exist, even under repeated open/close input while a file service is slow.
        if let Some(cleanup) = host.cleanup.pop() {
            let input = Input::Remove(cleanup.owned.clone());
            let retry = Cleanup { owned: cleanup.owned.clone(), document: cleanup.document };
            if !host.start_job(Action::Remove(cleanup), input) { host.cleanup.push(retry); }
            return None;
        }
        if host.quitting {
            if !host.quit_ready { host.quit_ready = true; return Some(Effect::QuitReady); }
            return None;
        }
        if host.refresh {
            if host.start_job(Action::List, Input::List) { host.refresh = false; }
            return None;
        }
        let now = host.clock.now();
        let forced = host.closing.as_ref().and_then(|closing| closing.stamps.iter().find(|stamp| !closing.done.contains(&stamp.id))).copied();
        if let Some(stamp) = forced && !self.tabs.iter().any(|tab| Stamp::of(tab) == stamp) {
            host.closing = None; return Some(Effect::Recovery(Event::Failed(RecoveryError::Changed)));
        }
        if host.closing.as_ref().is_some_and(|closing| closing.failure.is_some() || closing.done.len() == closing.stamps.len()) {
            let closing = host.closing.take()?;
            if closing.stamps.iter().any(|stamp| !self.tabs.iter().any(|tab| Stamp::of(tab) == *stamp))
                || matches!(closing.intent, CloseIntent::Quit) && self.tabs.iter().filter(|tab| tab.dirty()).count() != closing.stamps.len() {
                return Some(Effect::Recovery(Event::Failed(RecoveryError::Changed)));
            }
            let result = match closing.intent { CloseIntent::Close(id) => self.begin_close(id), CloseIntent::Quit => self.begin_quit() };
            if matches!(result, Err(HostError::Documents(DocumentsError::Busy))) {
                if let Some(host) = self.recovery.as_mut() { host.closing = Some(closing); }
                return None;
            }
            return Some(match result {
                Ok(mut effect) => {
                    if let Effect::ConfirmClose { recovery_error, .. } | Effect::ConfirmQuit { recovery_error, .. } = &mut effect { *recovery_error = closing.failure; }
                    effect
                }
                Err(error) => Effect::Recovery(Event::Failed(RecoveryError::Unavailable(error.to_string()))),
            });
        }
        let front_due = host.checkpoint || host.deadline.due.is_some_and(|due| now >= due);
        let resting_due = host.resting.is_some_and(|due| now >= due);
        let candidate = forced.map(|stamp| (stamp.id, Kind::Forced))
            .or_else(|| front_due.then_some(self.active).flatten().map(|id| (id, if host.checkpoint { Kind::Forced } else { Kind::Front })))
            .or_else(|| if resting_due { self.tabs.iter().find(|tab| Some(tab.id) != self.active && tab.dirty() && tab.recovery.current != Some(Stamp::of(tab)) && tab.recovery.failures < 3).map(|tab| (tab.id, Kind::Resting)) } else { None });
        let (id, kind) = candidate?;
        let manual_busy = self.host.as_ref().is_some_and(|host| host.recovery_busy());
        let editing = self.active().is_some_and(|tab| tab.view().map_or(true, |view| view.editing));
        let host = self.recovery.as_mut()?;
        if host.activity.busy() || manual_busy || editing {
            if front_due { host.deadline.retry(now, Duration::from_secs(1)); }
            if resting_due { host.resting = Some(now + Duration::from_secs(1)); }
            return None;
        }
        let tab = self.tabs.iter().find(|tab| tab.id == id)?;
        if !tab.dirty() { host.checkpoint = false; host.deadline = Deadline::default(); return None; }
        let snapshot = (|| -> Result<Snapshot, DocumentsError> {
            let trees = tab.scopes.iter().map(|scope| scope.parent.session.get().map(|session| session.report().clone())).chain(std::iter::once(tab.records().cloned())).collect::<Result<Vec<_>, _>>()?;
            Ok(Snapshot { stamp: Stamp::of(tab), trees, scopes: tab.scopes.iter().map(|scope| scope.type_id).collect(), name: tab.project_name().into(),
                original_first: tab.scopes.first().map_or(tab.original_first(), |scope| scope.parent.original_first), owned: tab.recovery.owned.clone() })
        })();
        let Ok(snapshot) = snapshot else { return None; }; let stamp = snapshot.stamp;
        if host.start_job(Action::Write(stamp, kind), Input::Save(snapshot)) {
            host.checkpoint = false;
            if kind == Kind::Front { host.deadline.retry(now, (host.interval * host.backoff).clamp(Duration::from_secs(1), Duration::from_secs(30))); }
            if kind == Kind::Resting { host.resting = None; }
        }
        None
    }
    fn accept_recovery(&mut self, pending: Pending, reply: Reply) -> Effect {
        let Some(host) = self.recovery.as_mut() else { return Effect::None; }; let now = host.clock.now();
        if let Action::Write(stamp, kind) = pending.action {
            let tab = self.tabs.iter_mut().find(|tab| tab.id == stamp.id);
            let mut current = false;
            let failure = match reply {
                Ok(Output::Written(owned)) => {
                    if let Some(tab) = tab {
                        if tab.dirty() && Stamp::of(tab).lineage == stamp.lineage && !host.quitting {
                            current = Stamp::of(tab) == stamp;
                            if let Some(old) = tab.recovery.owned.replace(owned) { host.retired.push(Box::new(old)); }
                            if current { tab.recovery.current = Some(stamp); }
                        } else { host.queue_cleanup(Cleanup { owned, document: None }); }
                    } else { host.queue_cleanup(Cleanup { owned, document: None }); }
                    None
                }
                Err(error) => Some(error),
                Ok(output) => { host.retired.push(Box::new(output)); Some(HostError::Stale) }
            };
            if let Some(closing) = host.closing.as_mut() && kind == Kind::Forced && closing.stamps.contains(&stamp) {
                if current && failure.is_none() { closing.done.push(stamp.id); }
                else {
                    // Failure is not completion. Carry it into the close/quit prompt, which retains
                    // its intent and offers RetryRecovery, Save, Cancel, or explicit Discard.
                    closing.failure = Some(format!("Recovery copy could not be written: {}", failure.as_ref().map_or_else(|| "the checkpoint was interrupted".into(), ToString::to_string)));
                }
            }
            let cancelled = pending.cancel.is_cancelled() || matches!(failure, Some(HostError::Save(ref error)) if matches!(**error, styk_engine::save::SaveError::Cancelled));
            if kind == Kind::Resting {
                let delay = if failure.is_some() && !cancelled {
                    if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == stamp.id) { tab.recovery.failures += 1; }
                    15000
                } else { 250 };
                host.resting = Some(now + Duration::from_millis(delay));
            } else if Some(stamp.id) == self.active {
                if current { host.deadline = Deadline::default(); host.backoff = 1; }
                else if failure.is_some() && !cancelled { host.backoff = (host.backoff * 2).min(12); host.deadline.retry(now, (host.interval * host.backoff).min(Duration::from_secs(60))); }
                if !host.interval.is_zero() { host.deadline.schedule(now, host.interval, host.backoff); }
            }
            if let Some(error) = failure && !cancelled { host.view.error = Some(error.to_string()); return Effect::Recovery(Event::Failed(RecoveryError::Unavailable(error.to_string()))); }
            return Effect::Recovery(Event::Written { document: stamp.id, current });
        }
        if let Action::Remove(cleanup) = pending.action {
            let result = match reply { Ok(Output::Removed) => Ok(()), Err(error) => Err(error), Ok(output) => { host.retired.push(Box::new(output)); Err(HostError::Stale) } };
            if result.is_err() && let Some((id, lineage)) = cleanup.document
                && let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id && Stamp::of(tab).lineage == lineage)
                && let Some(owned) = &mut tab.recovery.owned
                && owned.record.is_none() && Arc::ptr_eq(&owned.lease, &cleanup.owned.lease) { owned.record = cleanup.owned.record.clone(); }
            host.retired.push(Box::new(cleanup));
            return match result { Ok(()) => Effect::Recovery(Event::Cleaned), Err(error) => { host.view.error = Some(error.to_string()); Effect::Recovery(Event::Failed(RecoveryError::Unavailable(error.to_string()))) } };
        }
        let output = match reply {
            Ok(output) => output,
            Err(error) => { host.view.error = Some(error.to_string()); return Effect::Recovery(Event::Failed(match error { HostError::Recovery(error) => error, error => RecoveryError::Unavailable(error.to_string()) })); }
        };
        match (pending.action, output) {
            (Action::List, Output::Listed(records)) => { host.view.selected = records.first().map(|record| record.slot.clone()); host.view.visible = !records.is_empty(); host.view.copies = records; host.view.error = None; Effect::Recovery(Event::Listed) }
            (Action::Discard(slot), Output::Discarded(done)) if slot == done => { host.view.copies.retain(|record| record.slot != slot); host.view.selected = host.view.copies.first().map(|record| record.slot.clone()); host.view.visible = !host.view.copies.is_empty(); host.view.error = None; Effect::Recovery(Event::Discarded(slot)) }
            (Action::Restore(slot), Output::Restored(prepared, owned)) => {
                match self.open(prepared) {
                    Ok(id) => {
                        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) { tab.recovery.owned = Some(owned); tab.recovery.current = Some(Stamp::of(tab)); }
                        if let Some(host) = self.recovery.as_mut() { host.view.copies.retain(|record| record.slot != slot); host.view.selected = host.view.copies.first().map(|record| record.slot.clone()); host.view.visible = !host.view.copies.is_empty(); host.view.error = None; }
                        Effect::Recovery(Event::Restored(id))
                    }
                    Err((error, prepared)) => { if let Some(host) = self.recovery.as_mut() { host.retired.push(Box::new((prepared, owned))); host.view.error = Some(error.to_string()); } Effect::Recovery(Event::Failed(RecoveryError::Unavailable(error.to_string()))) }
                }
            }
            (_, output) => { host.retired.push(Box::new(output)); Effect::Recovery(Event::Failed(RecoveryError::Changed)) }
        }
    }
}
