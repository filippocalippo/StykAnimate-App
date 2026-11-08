//! Asynchronous document effects. A single bounded lane owns open/save/publication work and reclamation.
use super::*;
use styk_engine::save::{EngineHost, ProjectRequest, SaveError, save_project};
use styk_services::{Cancel, Spawner};
use styk_services::files::{FileError, Files};
use styk_services::worker::{Worker, run_future, run_scheduled};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobId(u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PromptId(u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseChoice { Save, Discard, Cancel, RetryRecovery }

pub struct HostOptions {
    pub engine: Engine,
    pub spawner: Arc<dyn Spawner>,
    pub files: Arc<dyn Files>,
    /// The application's startup document (the same input used for New and closing the last tab).
    pub startup: Value,
    pub clock: fn() -> f64,
    /// Announces a ready job to the host's event loop; no assumption that a channel wakes the interface.
    pub notify: Arc<dyn Fn() + Send + Sync>,
}

pub(super) struct EngineLifetime(Engine);
impl Drop for EngineLifetime { fn drop(&mut self) { self.0.stop(); } }

pub enum Request {
    Recovery(recovery::Command),
    OpenDialog,
    OpenFile(FileTarget),
    OpenBytes { bytes: Arc<[u8]>, name: String },
    /// An import decoder's canonical tree, including Stick Nodes imports. Decoding has its own owner.
    OpenDocument { document: Value, name: String },
    New,
    Save { document: DocumentId, save_as: bool },
    SaveAll,
    Rename { document: DocumentId, name: String },
    CloseSaved,
    SaveTarget { prompt: PromptId, target: Option<FileTarget> },
    Publish,
    /// Exclusive worker-session command. `call` names this entry when a command is long work.
    Call { document: DocumentId, method: String, args: Vec<Value>, view: Value },
    EnterMovieclip { document: DocumentId, type_id: f64 },
    LeaveMovieclip { document: DocumentId, save: bool },
    Close(DocumentId),
    Quit,
    Respond { prompt: PromptId, choice: CloseChoice },
    Cancel(JobId),
}

#[derive(Debug)]
pub enum HostError {
    Documents(DocumentsError), Open(Box<OpenError>), Save(Box<SaveError>), File(FileError), Edit(EditError),
    NoHost, ScheduledJobLost, Stale, Spawn(String), Recovery(styk_services::recovery::RecoveryError),
}
impl From<DocumentsError> for HostError { fn from(value: DocumentsError) -> Self { Self::Documents(value) } }
impl From<EditError> for HostError { fn from(value: EditError) -> Self { Self::Edit(value) } }
impl From<OpenError> for HostError { fn from(value: OpenError) -> Self { Self::Open(Box::new(value)) } }
impl From<SaveError> for HostError { fn from(value: SaveError) -> Self { Self::Save(Box::new(value)) } }
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Documents(e) => e.fmt(f), Self::Open(e) => e.fmt(f), Self::Save(e) => e.fmt(f),
            Self::File(e) => e.fmt(f), Self::Edit(e) => write!(f, "{e}"),
            Self::Recovery(e) => e.fmt(f),
            Self::ScheduledJobLost => f.write_str("scheduled document work ended without a result"),
            Self::NoHost => f.write_str("document services are not attached"), Self::Stale => f.write_str("the document changed"), Self::Spawn(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for HostError {}

#[derive(Debug)]
pub enum Effect {
    Recovery(recovery::Event),
    None, OpenDialog, Started(JobId), Cancelled(JobId),
    Opened(DocumentId), Closed(DocumentId), ClosedSaved(Vec<DocumentId>), Renamed(DocumentId), SavedAll, QuitReady,
    Published { document: DocumentId, revision: u64, generation: u64 },
    Called { document: DocumentId, answer: CallAnswer },
    Saved { document: DocumentId, current: bool, repairs: usize, warning: Option<String> },
    SaveDialog { prompt: PromptId, document: DocumentId, name: String },
    ConfirmClose { prompt: PromptId, document: DocumentId, name: String, recovery_error: Option<String> },
    ConfirmQuit { prompt: PromptId, names: Vec<String>, recovery_error: Option<String> },
    ScopeChanged(DocumentId), Imported(DocumentId), Failed { job: JobId, error: HostError }, Stale(JobId),
}

/// A request rejected before submission retains its payload, including imported bytes or trees.
pub type Dispatch = Result<Effect, (HostError, Request)>;
pub(super) struct Scope { pub parent: PreparedDocument, pub(super) type_id: f64 }
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp { id: DocumentId, revision: u64, epoch: u64, depth: usize }
impl Stamp { fn of(tab: &Document) -> Self { Self { id: tab.id, revision: tab.revision(), epoch: tab.epoch, depth: tab.scopes.len() } } }

struct CallWork { session: Box<Session>, method: String, args: Vec<Value>, view: Value, depth: usize }
enum Input {
    Call(Box<CallWork>),
    Bytes(Arc<[u8]>, String), File(FileTarget), Tree(Value, String),
    Save { tree: Value, name: String, original_first: bool, target: FileTarget },
    Publish { lineage: u64, tree: Value, revision: u64, views: Option<Arc<styk_eval::eval::Prepared>> },
    Leave { tree: Value },
}
struct Work { id: JobId, cancel: Cancel, input: Input }
enum Output {
    Called { session: Box<Session>, answer: Result<CallAnswer, EditError>, changed: bool },
    Open(PreparedDocument), Saved { repairs: usize, warning: Option<String> },
    Published(u64), Leave { document: Value, duration: f64 },
}
struct Reply { id: JobId, result: Result<Output, HostError> }
enum Action {
    Call(Stamp),
    Open { target: Option<FileTarget>, blank: bool, replace: Option<Stamp>, base: Option<Stamp> },
    Save { stamp: Stamp, target: FileTarget }, Publish(Stamp), Enter { stamp: Stamp, type_id: f64 }, Leave(Stamp),
    LastClose(Stamp),
    Import(Stamp),
}
struct Pending { id: JobId, cancel: Cancel, action: Action }
enum Prompt {
    Save { id: PromptId, stamp: Stamp }, Close { id: PromptId, stamp: Stamp }, Quit { id: PromptId, stamps: Vec<Stamp> },
}
enum AfterSave { Close(DocumentId), All { origin: Option<DocumentId>, quit: bool } }

pub(super) struct Host {
    pub(super) options: Arc<HostOptions>,
    pub(super) lifetime: Arc<EngineLifetime>,
    worker: Option<Worker<Work, Reply>>,
    pending: Option<Pending>,
    prompt: Option<Prompt>,
    after_save: Option<AfterSave>,
    continue_save: Option<(Stamp, bool)>,
    retired: Vec<Box<dyn Send>>,
    startup: Value,
    serial: u64,
    pub(super) publication_needed: bool,
    published: Option<(Stamp, u64)>,
    clock: fn() -> f64,
}

impl Host {
    pub(super) fn recovery_busy(&self) -> bool { self.pending.is_some() || self.prompt.is_some() || self.continue_save.is_some() }
    pub(super) fn retire(&mut self, value: impl Send + 'static) { self.retired.push(Box::new(value)); }
    pub(super) fn retire_clipboard(&mut self, value: Option<Clipboard>) {
        if let Some(value) = value { self.retired.push(Box::new(value)); }
    }
    pub(super) fn retire_value(&mut self, value: Value) { self.retired.push(Box::new(value)); }
    pub(super) fn allow_clipboard(&mut self) -> bool { self.flush_retired() }
    pub(super) fn blocks_switch(&self) -> bool {
        self.prompt.is_some() || self.continue_save.is_some() || self.pending.as_ref().is_some_and(|job| !matches!(job.action, Action::Publish(_)))
    }
    fn next(&mut self) -> Result<u64, HostError> {
        self.serial = self.serial.checked_add(1).ok_or(DocumentsError::IdentityExhausted)?;
        Ok(self.serial)
    }
    fn flush_retired(&mut self) -> bool {
        if self.retired.is_empty() { return true; }
        let Some(worker) = &self.worker else { return false; };
        // One batch, with at most the twelve tabs and one completed operation. Retain it on a busy exchange.
        let batch = std::mem::take(&mut self.retired);
        match worker.retire(batch) {
            Ok(()) => true,
            Err(batch) => { self.retired = batch; false }
        }
    }
    fn start(&mut self, action: Action, input: Input) -> Result<Effect, (HostError, Input)> {
        if self.pending.is_some() || !self.flush_retired() { return Err((DocumentsError::Busy.into(), input)); }
        let id = match self.next() { Ok(id) => JobId(id), Err(error) => return Err((error, input)) };
        let cancel = Cancel::new();
        let work = Work { id, cancel: cancel.clone(), input };
        let Some(worker) = &self.worker else { return Err((HostError::NoHost, work.input)); };
        match worker.submit(work) {
            Ok(()) => { self.pending = Some(Pending { id, cancel, action }); Ok(Effect::Started(id)) }
            Err(work) => Err((DocumentsError::Busy.into(), work.input)),
        }
    }
}

fn execute(options: &HostOptions, work: Work) -> Reply {
    // Even cancellation before execution must return the exclusive owner. No error path may
    // discard the only session while its tab remains parked on the interface.
    if let Input::Call(call) = work.input {
        let CallWork { mut session, method, args, mut view, depth } = *call;
        session.set_outer_depth(depth);
        if let Some(fields) = view.make_obj() { fields.set("outerDepth", Value::Num(depth as f64)); }
        let before = session.report().clone(); let revision = session.revision();
        let mut owner = (*session).into_worker();
        let cancelled = || EditError::Invalid("errors.editorSessions.backgroundOperationCancelled".into());
        let answer = owner.call_native_long(&method, &args, &view,
            &mut || if work.cancel.is_cancelled() { Err(cancelled()) } else { Ok(()) },
            || if work.cancel.begin_commit() { Ok(()) } else { Err(cancelled()) });
        let changed = owner.revision() != revision || !owner.report().same_node(&before);
        let session = Box::new(owner.into_session());
        return Reply { id: work.id, result: Ok(Output::Called { session, answer, changed }) };
    }
    let cancel = &|| work.cancel.is_cancelled();
    let result = (|| {
        if cancel() { return Err(HostError::File(FileError::Cancelled)); }
        match work.input {
            Input::Call(_) => Err(HostError::Stale),
            Input::Bytes(bytes, name) => PreparedDocument::open_application(&options.engine, bytes, &name, cancel).map(Output::Open).map_err(HostError::from),
            Input::File(target) => {
                let name = target.name();
                // The file service holds one Vec and its Arc destination while handing the bytes over.
                // This bounds actual byte buffers (not a tree expansion estimate) before either copy.
                const SCRATCH: usize = 1 << 20;
                let maximum = import_limit(&name).min(styk_alloc::headroom().saturating_sub(SCRATCH) / 2);
                let reservation = styk_alloc::reserve(maximum * 2 + SCRATCH).map_err(|error| HostError::from(OpenError::out_of_memory(error)))?;
                let bytes = run_future(options.files.read(&target, maximum, &work.cancel)).map_err(HostError::File)?;
                drop(reservation);
                PreparedDocument::open_application(&options.engine, bytes, &name, cancel).map(Output::Open).map_err(HostError::from)
            }
            Input::Tree(document, name) => {
                let opened = options.engine.open_document(OpenSource::Tree { document, name: &name }, OpenOptions { layer_timeline: true }, cancel).map_err(HostError::from)?;
                PreparedDocument::prepare(opened, true, cancel).map(Output::Open).map_err(HostError::from)
            }
            Input::Save { tree, name, original_first, target } => {
                // No helper is borrowed until an engine worker pool has explicitly supplied one.
                let host = EngineHost { engine: Some(&options.engine), cancel, clock: options.clock, helpers: 0, aside: false };
                let written = save_project(&[tree], &[], ProjectRequest { reservation: None, name: Some(name), original_first }, &host).map_err(HostError::from)?;
                run_future(options.files.replace(&target, &written.bytes, &work.cancel)).map_err(HostError::File)?;
                Ok(Output::Saved { repairs: written.repairs, warning: written.warning })
            }
            Input::Publish { lineage, tree, revision, views } => {
                let committed = options.engine.activate_tree_with(lineage, tree, revision, views).map_err(HostError::from)?;
                Ok(Output::Published(committed.generation))
            }
            Input::Leave { tree } => {
                let (document, duration) = styk_edit::export::movieclip_edit_document(&tree).map_err(HostError::Edit)?;
                if cancel() { return Err(HostError::File(FileError::Cancelled)); }
                Ok(Output::Leave { document, duration })
            }
        }
    })();
    let result = result.map(|mut output| { if let Output::Open(prepared) = &mut output { prepared.set_clock(options.clock); } output });
    Reply { id: work.id, result }
}

fn import_limit(name: &str) -> usize {
    if ["styk", "stkz", "stykmov", "json"].iter().any(|extension| name.rsplit('.').next().is_some_and(|value| value.eq_ignore_ascii_case(extension))) { 256 << 20 } else { 128 << 20 }
}

impl Documents {
    /// Start the bounded document lane before accepting work; a refused spawn leaves this owner unchanged.
    pub fn attach_host(&mut self, options: HostOptions) -> Result<(), HostError> {
        if self.host.is_some() { return Err(DocumentsError::Busy.into()); }
        let startup = options.startup.clone();
        let spawner = options.spawner.clone();
        let notify = options.notify.clone();
        let engine = options.engine.clone();
        let clock = options.clock;
        let options = Arc::new(options);
        let lifetime = Arc::new(EngineLifetime(engine.clone()));
        let job_lifetime = lifetime.clone();
        let saved_options = options.clone();
        let worker = Worker::start(spawner.as_ref(), "styk-documents", move |work: Work| {
            let _keep = &job_lifetime;
            let id = work.id;
            let job_options = options.clone();
            run_scheduled(|job| options.engine.spawn(move |_| job()), move || execute(&job_options, work))
                .unwrap_or(Reply { id, result: Err(HostError::ScheduledJobLost) })
        }, notify).map_err(|e| HostError::Spawn(e.to_string()))?;
        // The engine's own jobs (decode, publication retirement, frames) have a bounded worker too.
        // Shutdown happens on the document worker, never by joining from the interface.
        for name in ["styk-document-engine", "styk-frame-engine"] {
            let engine = engine.clone();
            if let Err(error) = spawner.spawn(name, Box::new(move || engine.work())) {
                worker.shutdown(Box::new(())); return Err(HostError::Spawn(error.to_string()));
            }
        }
        for tab in &mut self.tabs {
            tab.prepared.set_clock(clock);
            for scope in &mut tab.scopes { scope.parent.set_clock(clock); }
        }
        self.host = Some(Host { options: saved_options, lifetime, worker: Some(worker), pending: None, prompt: None, after_save: None, continue_save: None, retired: Vec::new(), startup, serial: 0, publication_needed: self.active.is_some(), published: None, clock });
        Ok(())
    }

    pub fn recency(&self) -> impl Iterator<Item = &Document> { self.recent.iter().filter_map(|id| self.get(*id)) }
    pub fn saving(&self, id: DocumentId) -> bool {
        self.host.as_ref().is_some_and(|host| host.pending.as_ref().is_some_and(|pending| matches!(pending.action, Action::Save { stamp, .. } if stamp.id == id))
            || host.continue_save.is_some_and(|(stamp, _)| stamp.id == id)
            || matches!(host.prompt, Some(Prompt::Save { stamp, .. }) if stamp.id == id))
    }
    /// The stage accepts only this identity. An engine generation prepared for a stale head is never admitted here.
    pub fn published(&self) -> Option<(DocumentId, u64, u64)> {
        let (stamp, generation) = self.host.as_ref()?.published?;
        (self.active == Some(stamp.id) && self.matches(stamp)).then_some((stamp.id, stamp.revision, generation))
    }
    pub fn successor(&self, id: DocumentId) -> Option<DocumentId> { self.recent.iter().copied().find(|other| *other != id) }
    pub fn neighbour(&self, step: isize) -> Option<DocumentId> {
        let at = self.tabs.iter().position(|tab| Some(tab.id) == self.active)?;
        if self.tabs.len() < 2 { return None; }
        Some(self.tabs[(at as isize + step.rem_euclid(self.tabs.len() as isize)).rem_euclid(self.tabs.len() as isize) as usize].id)
    }
    pub fn reorder(&mut self, id: DocumentId, index: usize) -> bool {
        let Some(from) = self.tabs.iter().position(|tab| tab.id == id) else { return false; };
        let to = index.min(self.tabs.len() - 1);
        if from == to { return false; }
        let tab = self.tabs.remove(from); self.tabs.insert(to, tab); true
    }
    pub fn replaceable(&self) -> bool {
        self.active().is_some_and(|tab| tab.blank && !tab.dirty() && tab.view().is_ok_and(|view| view.history.undo == 0 && view.history.redo == 0) && tab.scopes.is_empty())
    }
    fn matches(&self, stamp: Stamp) -> bool { self.get(stamp.id).is_some_and(|tab| Stamp::of(tab) == stamp) }
    fn matches_quiet(&self, stamp: Stamp) -> bool { self.matches(stamp) && self.get(stamp.id).is_some_and(|tab| tab.view().is_ok_and(|view| !view.editing)) }
    fn host(&mut self) -> Result<&mut Host, HostError> { self.host.as_mut().ok_or(HostError::NoHost) }
    fn ready(&mut self) -> Result<(), HostError> {
        let host = self.host()?;
        if host.pending.is_some() || host.prompt.is_some() || host.continue_save.is_some() || !host.flush_retired() { return Err(DocumentsError::Busy.into()); }
        Ok(())
    }

    /// Every heavy operation is queued. Refused input is returned, never decoded or dropped behind the caller's back.
    pub fn dispatch(&mut self, request: Request) -> Dispatch {
        // Validate before moving payloads. Control replies/cancel are admitted while a prompt/job is outstanding.
        let validation = match &request {
            Request::Cancel(_) | Request::Respond { .. } | Request::SaveTarget { .. } => self.host().map(|_| ()),
            _ => self.ready(),
        };
        if let Err(error) = validation { return Err((error, request)); }
        self.dispatch_ready(request)
    }

    fn dispatch_ready(&mut self, request: Request) -> Dispatch {
        match request {
            Request::Recovery(command) => self.recovery_command(&command).map_err(|error| (error, Request::Recovery(command))),
            Request::OpenDialog => Ok(Effect::OpenDialog),
            request @ (Request::OpenFile(_) | Request::OpenBytes { .. } | Request::OpenDocument { .. } | Request::New) => {
                if let Err(error) = self.can_switch() { return Err((error.into(), request)); }
                let replace = self.replaceable().then(|| self.active().map(Stamp::of)).flatten();
                let incoming_name = match &request { Request::OpenFile(target) => target.name(), Request::OpenBytes { name, .. } => name.clone(), _ => String::new() };
                let figure = ["stk", "stkz", "stykmov"].iter().any(|extension| incoming_name.rsplit('.').next().is_some_and(|value| value.eq_ignore_ascii_case(extension)));
                let importing = figure && self.active.is_some();
                if !importing && replace.is_none() && self.tabs.len() >= MAX_OPEN_PROJECTS { return Err((DocumentsError::TabLimit.into(), request)); }
                let (input, target, blank) = match request {
                    Request::OpenFile(target) => (Input::File(target.clone()), Some(target).filter(|target| target.path().extension().is_some_and(|s| s.eq_ignore_ascii_case("styk"))), false),
                    Request::OpenBytes { bytes, name } => {
                        if bytes.len() > import_limit(&name) { return Err((HostError::File(FileError::TooLarge), Request::OpenBytes { bytes, name })); }
                        (Input::Bytes(bytes, name), None, false)
                    }
                    Request::OpenDocument { document, name } => (Input::Tree(document, name), None, false),
                    Request::New => (Input::Tree(self.host.as_ref().map(|host| host.startup.clone()).unwrap_or(Value::Null), "Untitled animation".into()), None, true),
                    _ => return Err((HostError::Stale, request)),
                };
                let action = if figure && let Some(tab) = self.active() { Action::Import(Stamp::of(tab)) } else { Action::Open { target, blank, replace, base: self.active().map(Stamp::of) } };
                self.start_open(input, action)
            }
            Request::Save { document, save_as } => self.begin_save(document, save_as).map_err(|error| (error, Request::Save { document, save_as })),
            Request::SaveAll => self.save_next_for_all(self.active, false).map_err(|error| (error, Request::SaveAll)),
            Request::Rename { document, name } => self.rename(document, &name).map_err(|error| (error, Request::Rename { document, name })),
            Request::CloseSaved => {
                let ids: Vec<_> = self.tabs.iter().filter(|tab| Some(tab.id) != self.active && !tab.dirty()).map(|tab| tab.id).collect();
                for id in &ids { self.remove_tab(*id); }
                Ok(Effect::ClosedSaved(ids))
            }
            Request::Publish => self.begin_publication().map_err(|error| (error, Request::Publish)),
            Request::Call { document, method, args, view } => self.begin_call(document, method, args, view),
            Request::Cancel(id) => {
                let Some(pending) = self.host.as_ref().and_then(|host| host.pending.as_ref()).filter(|pending| pending.id == id) else { return Err((HostError::Stale, Request::Cancel(id))); };
                if pending.cancel.cancel() { Ok(Effect::Cancelled(id)) } else { Ok(Effect::None) }
            }
            Request::Close(id) => self.recovery_close(recovery::CloseIntent::Close(id)).and_then(|effect| match effect { Some(effect) => Ok(effect), None => self.begin_close(id) }).map_err(|error| (error, Request::Close(id))),
            Request::Quit => self.recovery_close(recovery::CloseIntent::Quit).and_then(|effect| match effect { Some(effect) => Ok(effect), None => self.begin_quit() }).map_err(|error| (error, Request::Quit)),
            Request::Respond { prompt, choice } => self.respond(prompt, choice).map_err(|error| (error, Request::Respond { prompt, choice })),
            Request::SaveTarget { prompt, target } => self.save_target(prompt, target.clone()).map_err(|error| (error, Request::SaveTarget { prompt, target })),
            Request::EnterMovieclip { document, type_id } => self.enter_scope(document, type_id).map_err(|error| (error, Request::EnterMovieclip { document, type_id })),
            Request::LeaveMovieclip { document, save } => self.leave_scope(document, save).map_err(|error| (error, Request::LeaveMovieclip { document, save })),
        }
    }

    fn start_open(&mut self, input: Input, action: Action) -> Dispatch {
        let Some(host) = self.host.as_mut() else { return Err((HostError::NoHost, Request::New)); };
        host.start(action, input).map_err(|(error, input)| (error, match input {
            Input::Bytes(bytes, name) => Request::OpenBytes { bytes, name }, Input::File(target) => Request::OpenFile(target),
            Input::Tree(document, name) => Request::OpenDocument { document, name }, _ => Request::New,
        }))
    }

    fn begin_publication(&mut self) -> Result<Effect, HostError> {
        let Some(tab) = self.active() else { return Ok(Effect::None); };
        let stamp = Stamp::of(tab);
        let input = Input::Publish { lineage: tab.lineage(), tree: tab.records()?.clone(), revision: tab.revision(), views: tab.prepared.session.get()?.views() };
        let host = self.host()?;
        match host.start(Action::Publish(stamp), input) {
            Ok(effect) => { host.publication_needed = false; Ok(effect) }
            Err((error, input)) => { host.retired.push(Box::new(input)); Err(error) }
        }
    }

    fn begin_call(&mut self, id: DocumentId, method: String, args: Vec<Value>, view: Value) -> Dispatch {
        let validation = (|| {
            if self.active != Some(id) { return Err(DocumentsError::NotActive); }
            let tab = self.get(id).ok_or(DocumentsError::NotOpen)?;
            if tab.view()?.editing { return Err(DocumentsError::FinishEdit); }
            Ok(Stamp::of(tab))
        })();
        let stamp = match validation { Ok(stamp) => stamp, Err(error) => return Err((error.into(), Request::Call { document: id, method, args, view })) };
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) else { return Err((DocumentsError::NotOpen.into(), Request::Call { document: id, method, args, view })); };
        let session = match tab.prepared.session.take() { Ok(session) => session, Err(error) => return Err((error.into(), Request::Call { document: id, method, args, view })) };
        let input = Input::Call(Box::new(CallWork { session, method, args, view, depth: stamp.depth }));
        let started = match self.host.as_mut() { Some(host) => host.start(Action::Call(stamp), input), None => Err((HostError::NoHost, input)) };
        match started {
            Ok(effect) => Ok(effect),
            Err((error, Input::Call(call))) => {
                let CallWork { session, method, args, view, .. } = *call;
                tab.prepared.session = SessionOwner::Ready(session);
                Err((error, Request::Call { document: id, method, args, view }))
            }
            Err((error, input)) => { if let Some(host) = self.host.as_mut() { host.retire(input); } Err((error, Request::Publish)) }
        }
    }

    fn begin_save(&mut self, id: DocumentId, save_as: bool) -> Result<Effect, HostError> {
        self.interrupt_recovery(id);
        if self.recovery_writing(id) { return Err(DocumentsError::Busy.into()); }
        if self.active != Some(id) { return Err(DocumentsError::NotActive.into()); }
        // Desktop Save settles the nested editor first, giving each parent its one undo entry.
        // Changed clips are prepared by the worker; unedited scopes only exchange owners.
        if self.get(id).is_some_and(|tab| !tab.scopes.is_empty()) {
            let effect = self.leave_scope(id, true)?;
            let stamp = Stamp::of(self.get(id).ok_or(DocumentsError::NotOpen)?);
            self.host()?.continue_save = Some((stamp, save_as));
            return Ok(effect);
        }
        let tab = self.get(id).ok_or(DocumentsError::NotOpen)?;
        if tab.view()?.editing { return Err(DocumentsError::FinishEdit.into()); }
        if save_as || tab.target.is_none() {
            let (stamp, name) = (Stamp::of(tab), format!("{}.styk", tab.project_name()));
            let host = self.host()?;
            let prompt = PromptId(host.next()?);
            host.prompt = Some(Prompt::Save { id: prompt, stamp });
            return Ok(Effect::SaveDialog { prompt, document: id, name });
        }
        let target = tab.target.clone().ok_or(HostError::Stale)?;
        self.save_to(id, target)
    }

    fn save_to(&mut self, id: DocumentId, target: FileTarget) -> Result<Effect, HostError> {
        let tab = self.get(id).ok_or(DocumentsError::NotOpen)?;
        let stamp = Stamp::of(tab);
        if !tab.scopes.is_empty() || tab.view()?.editing { return Err(DocumentsError::FinishEdit.into()); }
        let input = Input::Save { tree: tab.records()?.clone(), name: tab.project_name().to_owned(), original_first: tab.original_first(), target: target.clone() };
        let host = self.host()?;
        host.start(Action::Save { stamp, target }, input).map_err(|(error, input)| { host.retired.push(Box::new(input)); error })
    }

    fn save_target(&mut self, prompt: PromptId, target: Option<FileTarget>) -> Result<Effect, HostError> {
        let stamp = match self.host.as_ref().and_then(|host| host.prompt.as_ref()) { Some(Prompt::Save { id, stamp }) if *id == prompt => *stamp, _ => return Err(HostError::Stale) };
        self.host()?.prompt = None;
        if !self.matches(stamp) { self.host()?.after_save = None; return Err(HostError::Stale); }
        let Some(target) = target else { self.host()?.after_save = None; return Ok(Effect::None); };
        let result = self.save_to(stamp.id, target);
        if let Err(error) = &result {
            if matches!(error, HostError::Documents(DocumentsError::Busy)) { self.host()?.prompt = Some(Prompt::Save { id: prompt, stamp }); }
            else { self.host()?.after_save = None; }
        }
        result
    }

    /// Process at most one job per interface update. Large rejected results go back to the worker.
    pub fn poll(&mut self) -> Option<Effect> {
        if let Some(effect) = self.poll_recovery() { return Some(effect); }
        let host = self.host.as_mut()?;
        if !host.flush_retired() { return None; }
        let reply = host.worker.as_ref()?.take();
        if reply.is_none() {
            if host.pending.is_none() && let Some((stamp, save_as)) = host.continue_save.take() {
                if !self.matches(stamp) {
                    if let Some(host) = self.host.as_mut() { host.after_save = None; }
                    return Some(Effect::Stale(JobId(self.host.as_ref().map_or(0, |host| host.serial))));
                }
                return Some(match self.begin_save(stamp.id, save_as) {
                    Ok(effect) => effect,
                    Err(HostError::Documents(DocumentsError::Busy)) => {
                        if let Some(host) = self.host.as_mut() { host.continue_save = Some((stamp, save_as)); }
                        Effect::None
                    }
                    Err(error) => { if let Some(host) = self.host.as_mut() { host.after_save = None; } Effect::Failed { job: JobId(self.host.as_ref().map_or(0, |host| host.serial)), error } }
                });
            }
            if host.pending.is_none() && host.prompt.is_none() && host.publication_needed {
                return Some(match self.begin_publication() { Ok(effect) => effect, Err(_) => Effect::None });
            }
            return None;
        }
        let reply = reply?;
        let pending = host.pending.take()?;
        let id = reply.id;
        if let Action::Call(stamp) = pending.action {
            // Reattach before reporting cancellation or a command error. The worker rolled back
            // cancelled work before returning, including history, selection and evaluation heads.
            return Some(match reply.result {
                Ok(Output::Called { session, answer, changed }) => {
                    if pending.id != id || !self.matches(stamp) {
                        if let Some(host) = self.host.as_mut() { host.retire((session, answer)); }
                        Effect::Stale(id)
                    } else if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == stamp.id) {
                        tab.prepared.session = SessionOwner::Ready(session);
                        if changed { tab.epoch = tab.epoch.wrapping_add(1); tab.blank = false;
                            if let Some(host) = self.host.as_mut() { host.publication_needed = true; } }
                        if pending.cancel.is_cancelled() {
                            if let Some(host) = self.host.as_mut() { host.retire(answer); }
                            Effect::Cancelled(id)
                        } else { match answer { Ok(answer) => Effect::Called { document: stamp.id, answer }, Err(error) => Effect::Failed { job: id, error: error.into() } } }
                    } else { if let Some(host) = self.host.as_mut() { host.retire((session, answer)); } Effect::Stale(id) }
                }
                Err(error) => Effect::Failed { job: id, error },
                Ok(output) => { if let Some(host) = self.host.as_mut() { host.retire(output); } Effect::Stale(id) }
            });
        }
        if pending.id != id || pending.cancel.is_cancelled() {
            if matches!(pending.action, Action::Publish(_)) { host.published = None; host.publication_needed = self.active.is_some(); }
            host.retired.push(Box::new(reply)); host.after_save = None; host.continue_save = None;
            return Some(Effect::Cancelled(id));
        }
        let output = match reply.result {
            Ok(output) => output,
            Err(error) => { host.after_save = None; host.continue_save = None; return Some(Effect::Failed { job: id, error }); }
        };
        Some(self.complete(id, pending.action, output))
    }

    fn complete(&mut self, id: JobId, action: Action, output: Output) -> Effect {
        let result = self.accept(action, output);
        match result { Ok(effect) => effect, Err((error, retired)) => {
            if let Some(host) = self.host.as_mut() { host.retired.push(retired); host.after_save = None; host.continue_save = None; }
            if matches!(error, HostError::Stale) { Effect::Stale(id) } else { Effect::Failed { job: id, error } }
        } }
    }

    fn accept(&mut self, action: Action, output: Output) -> Result<Effect, (HostError, Box<dyn Send>)> {
        match (action, output) {
            (Action::Open { target, blank, replace, base }, Output::Open(prepared)) => {
                if base.is_some_and(|stamp| !self.matches(stamp) || self.active != Some(stamp.id)) || self.active().is_some_and(|tab| tab.view().map_or(true, |view| view.editing)) { return Err((HostError::Stale, Box::new(prepared))); }
                let id = if let Some(stamp) = replace {
                    if !self.matches(stamp) || !self.replaceable() { return Err((HostError::Stale, Box::new(prepared))); }
                    self.replace_tab(stamp.id, prepared)?;
                    stamp.id
                } else { self.open(prepared).map_err(|(error, prepared)| (error.into(), Box::new(prepared) as Box<dyn Send>))? };
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) { tab.target = target; tab.blank = blank; }
                if let Some(host) = self.host.as_mut() { host.publication_needed = true; }
                Ok(Effect::Opened(id))
            }
            (Action::Save { stamp, target }, Output::Saved { repairs, warning }) => {
                let current = self.matches(stamp) && self.get(stamp.id).is_some_and(|tab| tab.view().is_ok_and(|view| !view.editing));
                let saved_at = self.host.as_ref().map(|host| (host.clock)());
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == stamp.id) {
                    tab.target = Some(target);
                    if current { tab.prepared.session.get_mut().map_err(|error| (error.into(), Box::new(()) as Box<dyn Send>))?.call_native("@markSaved", &[], &Value::Null).result.map_err(|error| (error.into(), Box::new(()) as Box<dyn Send>))?; tab.saved_at = saved_at; }
                }
                if current {
                    if let Some(recovery) = self.recovery.as_mut() && let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == stamp.id) { recovery.saved(tab); }
                    match self.host.as_mut().and_then(|host| host.after_save.take()) {
                        Some(AfterSave::Close(document)) => return self.finish_close(document).map_err(|error| (error, Box::new(()) as Box<dyn Send>)),
                        Some(AfterSave::All { origin, quit }) => return self.save_next_for_all(origin, quit).map_err(|error| (error, Box::new(()) as Box<dyn Send>)),
                        None => {}
                    }
                } else if let Some(host) = self.host.as_mut() { host.after_save = None; }
                Ok(Effect::Saved { document: stamp.id, current, repairs, warning })
            }
            (Action::Publish(stamp), Output::Published(generation)) => {
                if !self.matches(stamp) || self.active != Some(stamp.id) { return Err((HostError::Stale, Box::new(()))); }
                if let Some(host) = self.host.as_mut() { host.published = Some((stamp, generation)); }
                Ok(Effect::Published { document: stamp.id, revision: stamp.revision, generation })
            }
            (Action::Import(stamp), Output::Open(prepared)) => {
                if !self.matches_quiet(stamp) { return Err((HostError::Stale, Box::new(prepared))); }
                let answer = prepared.session.get().map(|session| session.report().clone()).map_err(HostError::Documents)
                    .and_then(|tree| self.call(stamp.id, "importFigure", &[tree], &Value::Null).map_err(HostError::Documents))
                    .and_then(|answer| answer.result.map_err(HostError::Edit));
                if let Some(host) = self.host.as_mut() { host.retired.push(Box::new(prepared)); }
                answer.map(|_| Effect::Imported(stamp.id)).map_err(|error| (error, Box::new(()) as Box<dyn Send>))
            }
            (Action::Enter { stamp, type_id }, Output::Open(mut prepared)) => {
                if !self.matches_quiet(stamp) { return Err((HostError::Stale, Box::new(prepared))); }
                let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == stamp.id) else { return Err((HostError::Stale, Box::new(prepared))); };
                if let Ok(session) = prepared.session.get_mut() { session.set_outer_depth(tab.scopes.len() + 1); }
                let parent = std::mem::replace(&mut tab.prepared, prepared);
                tab.scopes.push(Scope { parent, type_id }); tab.epoch = tab.epoch.wrapping_add(1);
                if let Some(host) = self.host.as_mut() { host.publication_needed = true; }
                Ok(Effect::ScopeChanged(stamp.id))
            }
            (Action::Leave(stamp), Output::Leave { document, duration }) => {
                if !self.matches_quiet(stamp) { return Err((HostError::Stale, Box::new(document))); }
                let result = self.finish_leave(stamp.id, Some((document, duration)));
                let updated = self.get(stamp.id).map(Stamp::of);
                if let Some(host) = self.host.as_mut() && let Some((stamp, _)) = host.continue_save.as_mut() && let Some(updated) = updated { *stamp = updated; }
                result.map_err(|error| (error, Box::new(()) as Box<dyn Send>))
            }
            (Action::LastClose(stamp), Output::Open(prepared)) => {
                if !self.matches_quiet(stamp) { return Err((HostError::Stale, Box::new(prepared))); }
                self.replace_tab(stamp.id, prepared)?;
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == stamp.id) { tab.blank = true; }
                if let Some(host) = self.host.as_mut() { host.publication_needed = true; }
                Ok(Effect::Closed(stamp.id))
            }
            (_, output) => Err((HostError::Stale, Box::new(output))),
        }
    }

    pub(super) fn begin_close(&mut self, id: DocumentId) -> Result<Effect, HostError> {
        self.activate(id)?;
        let tab = self.get(id).ok_or(DocumentsError::NotOpen)?;
        if tab.view()?.editing { return Err(DocumentsError::FinishEdit.into()); }
        if !tab.dirty() { return self.finish_close(id); }
        let (stamp, name) = (Stamp::of(tab), tab.project_name().to_string());
        let host = self.host()?; let prompt = PromptId(host.next()?);
        host.prompt = Some(Prompt::Close { id: prompt, stamp });
        Ok(Effect::ConfirmClose { prompt, document: id, name, recovery_error: None })
    }
    fn finish_close(&mut self, id: DocumentId) -> Result<Effect, HostError> {
        if self.tabs.len() == 1 {
            let stamp = Stamp::of(self.get(id).ok_or(DocumentsError::NotOpen)?);
            let host = self.host()?;
            let input = Input::Tree(host.startup.clone(), "Untitled animation".into());
            return host.start(Action::LastClose(stamp), input).map_err(|(error, input)| { host.retired.push(Box::new(input)); error });
        }
        self.remove_tab(id);
        Ok(Effect::Closed(id))
    }
    fn remove_tab(&mut self, id: DocumentId) {
        let Some(at) = self.tabs.iter().position(|tab| tab.id == id) else { return; };
        if self.active == Some(id) { self.active = self.successor(id); }
        let mut tab = self.tabs.remove(at); self.recent.retain(|other| *other != id);
        self.interrupt_recovery(id);
        if let Some(recovery) = self.recovery.as_mut() { recovery.release(&mut tab.recovery); }
        if let Some(host) = self.host.as_mut() { host.retired.push(Box::new(tab)); host.publication_needed = self.active.is_some(); }
    }
    fn replace_tab(&mut self, id: DocumentId, prepared: PreparedDocument) -> Result<(), (HostError, Box<dyn Send>)> {
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) else { return Err((HostError::Stale, Box::new(prepared))); };
        let old = std::mem::replace(&mut tab.prepared, prepared);
        let scopes = std::mem::take(&mut tab.scopes);
        if let Some(recovery) = self.recovery.as_mut() { recovery.release(&mut tab.recovery); }
        tab.target = None; tab.saved_at = None; tab.blank = false; tab.epoch = tab.epoch.wrapping_add(1);
        if let Some(host) = self.host.as_mut() { host.retired.push(Box::new((old, scopes))); }
        Ok(())
    }
    pub(super) fn begin_quit(&mut self) -> Result<Effect, HostError> {
        self.can_switch()?;
        let stamps: Vec<Stamp> = self.tabs.iter().filter(|tab| tab.dirty()).map(Stamp::of).collect();
        if stamps.is_empty() { return Ok(self.finish_quit()); }
        let names = self.tabs.iter().filter(|tab| tab.dirty()).map(|tab| tab.project_name().to_string()).collect();
        let host = self.host()?; let prompt = PromptId(host.next()?);
        host.prompt = Some(Prompt::Quit { id: prompt, stamps });
        Ok(Effect::ConfirmQuit { prompt, names, recovery_error: None })
    }
    fn respond(&mut self, prompt: PromptId, choice: CloseChoice) -> Result<Effect, HostError> {
        let matched = match self.host.as_ref().and_then(|host| host.prompt.as_ref()) {
            Some(Prompt::Close { id, .. } | Prompt::Quit { id, .. }) => *id == prompt, _ => false,
        };
        if !matched { return Err(HostError::Stale); }
        let question = self.host()?.prompt.take().ok_or(HostError::Stale)?;
        if choice == CloseChoice::Cancel { self.host()?.after_save = None; return Ok(Effect::None); }
        match question {
            Prompt::Close { stamp, .. } => {
                if !self.matches(stamp) { return Err(HostError::Stale); }
                if choice == CloseChoice::RetryRecovery {
                    return self.recovery_close(recovery::CloseIntent::Close(stamp.id)).map(|effect| effect.unwrap_or(Effect::None));
                }
                let result = if choice == CloseChoice::Discard { self.finish_close(stamp.id) } else {
                    self.host()?.after_save = Some(AfterSave::Close(stamp.id)); self.begin_save(stamp.id, false)
                };
                if let Err(error) = &result {
                    let host = self.host()?; host.after_save = None;
                    if matches!(error, HostError::Documents(DocumentsError::Busy)) { host.prompt = Some(Prompt::Close { id: prompt, stamp }); }
                }
                result
            }
            Prompt::Quit { stamps, .. } => {
                if stamps.iter().any(|stamp| !self.matches(*stamp)) || self.tabs.iter().filter(|tab| tab.dirty()).count() != stamps.len() { return Err(HostError::Stale); }
                if choice == CloseChoice::RetryRecovery {
                    return self.recovery_close(recovery::CloseIntent::Quit).map(|effect| effect.unwrap_or(Effect::None));
                }
                let result = if choice == CloseChoice::Discard { Ok(self.finish_quit()) } else { self.save_next_for_all(self.active, true) };
                if matches!(result, Err(HostError::Documents(DocumentsError::Busy))) { self.host()?.prompt = Some(Prompt::Quit { id: prompt, stamps }); }
                result
            }
            _ => Err(HostError::Stale),
        }
    }
    fn save_next_for_all(&mut self, origin: Option<DocumentId>, quit: bool) -> Result<Effect, HostError> {
        let next = self.tabs.iter().filter(|tab| Some(tab.id) != origin).chain(self.tabs.iter().filter(|tab| Some(tab.id) == origin)).find(|tab| tab.dirty()).map(|tab| tab.id);
        let Some(next) = next else { if let Some(origin) = origin { self.activate(origin)?; } return Ok(if quit { self.finish_quit() } else { Effect::SavedAll }); };
        self.activate(next)?;
        self.host()?.after_save = Some(AfterSave::All { origin, quit });
        let result = self.begin_save(next, false);
        if result.is_err() { self.host()?.after_save = None; }
        result
    }

    fn rename(&mut self, id: DocumentId, name: &str) -> Result<Effect, HostError> {
        self.activate(id)?;
        self.call(id, "@touch", &[], &Value::Null)?.result?;
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id).ok_or(DocumentsError::NotOpen)?;
        tab.prepared.name = if name.trim().is_empty() { "Untitled".to_string() } else { name.trim().to_string() };
        Ok(Effect::Renamed(id))
    }

    fn enter_scope(&mut self, id: DocumentId, type_id: f64) -> Result<Effect, HostError> {
        self.can_switch()?;
        if self.active != Some(id) { return Err(DocumentsError::NotActive.into()); }
        let tab = self.get(id).ok_or(DocumentsError::NotOpen)?;
        let stamp = Stamp::of(tab);
        let (document, name) = tab.prepared.session.get()?.movieclip_document(type_id)?;
        let host = self.host()?;
        host.start(Action::Enter { stamp, type_id }, Input::Tree(document, name)).map_err(|(error, input)| { host.retired.push(Box::new(input)); error })
    }
    fn leave_scope(&mut self, id: DocumentId, save: bool) -> Result<Effect, HostError> {
        self.can_switch()?;
        if self.active != Some(id) { return Err(DocumentsError::NotActive.into()); }
        let tab = self.get(id).ok_or(DocumentsError::NotOpen)?;
        if tab.scopes.is_empty() { return Ok(Effect::None); }
        if !save || !tab.view()?.dirty { return self.finish_leave(id, None); }
        let stamp = Stamp::of(tab); let tree = tab.records()?.clone();
        let host = self.host()?;
        host.start(Action::Leave(stamp), Input::Leave { tree }).map_err(|(error, input)| { host.retired.push(Box::new(input)); error })
    }
    fn finish_leave(&mut self, id: DocumentId, edited: Option<(Value, f64)>) -> Result<Effect, HostError> {
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id).ok_or(DocumentsError::NotOpen)?;
        let scope = tab.scopes.last_mut().ok_or(HostError::Stale)?;
        if let Some((document, duration)) = edited {
            scope.parent.session.get_mut()?.call_native("publishMovieclipEdit", &[Value::Num(scope.type_id), document, Value::Num(duration)], &Value::Null).result?;
        }
        let scope = tab.scopes.pop().ok_or(HostError::Stale)?;
        let retired = std::mem::replace(&mut tab.prepared, scope.parent); tab.epoch = tab.epoch.wrapping_add(1);
        if let Some(host) = self.host.as_mut() { host.retired.push(Box::new(retired)); host.publication_needed = true; }
        Ok(Effect::ScopeChanged(id))
    }
}

impl Drop for Documents {
    fn drop(&mut self) {
        if let Some(recovery) = self.recovery.take() { recovery.stop(); }
        if let Some(mut host) = self.host.take() {
            if let Some(pending) = host.pending.take() { pending.cancel.cancel(); }
            if let Some(worker) = host.worker.take() {
                worker.shutdown(Box::new((std::mem::take(&mut self.tabs), std::mem::take(&mut self.clipboards), std::mem::take(&mut host.retired), host.startup)));
            }
        }
    }
}

#[cfg(test)]
mod close_wiring_regression {
    use super::*;
    use styk_services::{ManualSpawner, files::fake::MemoryFiles};
    #[test]
    fn refused_save_answer_keeps_the_core_prompt() {
        let startup = include_bytes!("../../../../tests/edit/startup.document.json");
        let engine = Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
        let prepared = PreparedDocument::open_bytes(&engine, Arc::from(startup.as_slice()), "Project.styk", &|| false).unwrap();
        let mut documents = Documents::new();
        documents.attach_host(HostOptions { engine, spawner: Arc::new(ManualSpawner::default()), files: Arc::new(MemoryFiles::default()), startup: styk_doc::json::parse(startup).unwrap(), clock: || 0.0, notify: Arc::new(|| {}) }).unwrap();
        let id = documents.open(prepared).map_err(|(e, _)| e).unwrap();
        documents.tabs[0].target = Some(FileTarget::new("Project.styk"));
        documents.call(id, "setFPS", &[Value::Num(30.0)], &Value::Null).unwrap().result.unwrap();
        // Publication does not block the close prompt, but the single document lane refuses Save.
        assert!(matches!(documents.dispatch(Request::Publish), Ok(Effect::Started(_))));
        let prompt = documents.begin_quit().unwrap();
        let mut core = crate::app::Core::new(documents);
        core.document_effect(&prompt);
        core.dispatch(crate::commands::Command::Recovery(crate::recovery::model::Event::Respond(crate::recovery::model::Choice::Save)));
        assert!(core.recovery().closing().is_some(), "Busy must not consume the visible prompt");
        assert!(matches!(core.documents.host.as_ref().unwrap().prompt, Some(Prompt::Quit { .. })));
    }

    struct Threads;
    impl styk_services::Spawner for Threads {
        fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
            std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|e| styk_services::SpawnError(e.to_string()))
        }
    }
    fn saving_core(files: Arc<MemoryFiles>, notify: Arc<dyn Fn() + Send + Sync>) -> crate::app::Core {
        let startup = include_bytes!("../../../../tests/edit/startup.document.json");
        let engine = Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
        let prepared = PreparedDocument::open_bytes(&engine, Arc::from(startup.as_slice()), "Project.styk", &|| false).unwrap();
        let mut documents = Documents::new();
        documents.attach_host(HostOptions { engine, spawner: Arc::new(Threads), files, startup: styk_doc::json::parse(startup).unwrap(), clock: || 0.0, notify }).unwrap();
        let id = documents.open(prepared).map_err(|(e, _)| e).unwrap();
        documents.tabs[0].target = Some(FileTarget::new("Project.styk"));
        documents.call(id, "setFPS", &[Value::Num(30.0)], &Value::Null).unwrap().result.unwrap();
        crate::app::Core::new(documents)
    }
    #[test]
    fn cancelled_save_releases_quit_intent_and_preserves_work() {
        use styk_services::files::fake::Failure;
        let files = Arc::new(MemoryFiles::default());
        let target = FileTarget::new("Project.styk");
        files.put(target.clone(), Arc::from(b"previous complete file".as_slice()));
        files.fail(Failure::CancelBeforeCommit);
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let mut core = saving_core(files.clone(), Arc::new(move || { let _ = send.try_send(()); }));
        core.request_quit(false);
        core.dispatch(crate::commands::Command::Recovery(crate::recovery::model::Event::Respond(crate::recovery::model::Choice::Save)));
        receive.recv_timeout(std::time::Duration::from_secs(15)).unwrap();
        let answer = core.documents.poll().expect("the real worker notified its answer");
        assert!(matches!(answer, Effect::Cancelled(_)), "{answer:?}");
        core.document_effect(&answer);
        assert!(core.documents.active().unwrap().dirty());
        assert_eq!(&*files.get(&target).unwrap(), b"previous complete file");
        core.request_quit(false);
        assert!(core.recovery().closing().is_some(), "a cancelled save must allow a fresh quit");
    }
    #[test]
    fn stale_response_retires_the_invalid_prompt_and_allows_a_fresh_quit() {
        let mut core = saving_core(Arc::new(MemoryFiles::default()), Arc::new(|| {}));
        core.request_quit(false);
        let id = core.documents.active().unwrap().id();
        core.documents.call(id, "setFPS", &[Value::Num(31.0)], &Value::Null).unwrap().result.unwrap();
        core.dispatch(crate::commands::Command::Recovery(crate::recovery::model::Event::Respond(crate::recovery::model::Choice::Discard)));
        assert!(core.recovery().closing().is_none(), "K-doc consumed the stale prompt; the interface must retire it too");
        assert!(core.documents.active().unwrap().dirty());
        core.request_quit(false);
        assert!(core.recovery().closing().is_some());
    }
}
