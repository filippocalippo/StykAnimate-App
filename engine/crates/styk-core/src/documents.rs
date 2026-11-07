//! Open projects and the narrow editing/read seam used by panel logic.
//!
//! Prepare bytes on a worker, then move the ready session into `Documents::open`.
//! Each tab holds exactly one session; commands and queries use that owner directly.
//! There is no read-view tree, patch application, or second history in the core.

use std::sync::Arc;

use crate::engine::{Value, CallAnswer, DocumentView, EditError, Selection, OpenError, TypedDocument, Engine};

use styk_doc::Obj;
use styk_edit::session::Session;
use styk_engine::document::{OpenOptions, OpenSource, OpenedDocument};

mod host;
mod tabs;
pub use tabs::drop_index;
pub use host::{CloseChoice, Dispatch, Effect, HostError, HostOptions, JobId, PromptId, Request};
use styk_services::files::FileTarget;

/// Today's project-tab limit (`src/project-tabs.mjs`).
pub const MAX_OPEN_PROJECTS: usize = 12;

/// Stable identity within one `Documents` owner. Pair this with a revision in caches and job replies:
/// two projects can have the same history revision, and undo deliberately restores an older revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DocumentId(u64);

impl DocumentId {
    /// The identity as a number, for the interface's own keys (focus targets); it means nothing else.
    pub const fn get(self) -> u64 {
        self.0
    }

    /// An identity for a band shown without open projects (`Shell::preview`) and for tests of logic that only holds ids.
    pub const fn preview(serial: u64) -> DocumentId {
        DocumentId(serial)
    }
}

/// A fully prepared session. Construct on the open worker; installing it only moves ownership.
pub struct PreparedDocument {
    name: String,
    session: SessionOwner,
    lineage: u64,
    kind: &'static str,
    original_first: bool,
    repairs: usize,
}

/// Only scalar tab chrome survives an exclusive handoff. No document, selection, cache or history
/// is mirrored; borrowed reads refuse until the exact same session returns.
enum SessionOwner { Ready(Box<Session>), Working { revision: u64, dirty: bool } }
impl SessionOwner {
    fn get(&self) -> Result<&Session, DocumentsError> {
        match self { Self::Ready(session) => Ok(session), Self::Working { .. } => Err(DocumentsError::Busy) }
    }
    fn get_mut(&mut self) -> Result<&mut Session, DocumentsError> {
        match self { Self::Ready(session) => Ok(session), Self::Working { .. } => Err(DocumentsError::Busy) }
    }
    fn revision(&self) -> u64 { match self { Self::Ready(session) => session.revision(), Self::Working { revision, .. } => *revision } }
    fn dirty(&self) -> bool { match self { Self::Ready(session) => session.view().dirty, Self::Working { dirty, .. } => *dirty } }
    fn take(&mut self) -> Result<Box<Session>, DocumentsError> {
        let session = self.get()?;
        let parked = Self::Working { revision: session.revision(), dirty: session.view().dirty };
        match std::mem::replace(self, parked) { Self::Ready(session) => Ok(session), Self::Working { .. } => Err(DocumentsError::Busy) }
    }
}

impl PreparedDocument {
    /// Worker-only preparation of a project file, using today's engine open path and normalization.
    /// The file's extension selects the format. A legacy JSON project uses its `.styk` name too.
    /// Pivot originals stay attached to the session's tree, with the engine's source facts and order.
    pub fn open_bytes(engine: &Engine, bytes: Arc<[u8]>, name: &str, cancel: &dyn Fn() -> bool) -> Result<Self, OpenError> {
        let mut opened = engine.open_document(OpenSource::File { bytes: &bytes, name }, OpenOptions { layer_timeline: true }, cancel)?;
        if opened.source.is_some() {
            opened.attach_source(bytes)?;
        }
        Self::from_opened(opened, cancel)
    }

    /// Worker-only adoption of an engine open (also used for new projects and decoded imports).
    /// Index creation in `start_session` stays on this worker, never on tab installation.
    pub fn from_opened(opened: OpenedDocument, cancel: &dyn Fn() -> bool) -> Result<Self, OpenError> {
        Self::prepare(opened, false, cancel)
    }

    fn prepare(opened: OpenedDocument, application_open: bool, cancel: &dyn Fn() -> bool) -> Result<Self, OpenError> {
        check_cancel(cancel)?;
        // The decoded tree and typed views are already live. Observe the remaining session/index
        // construction against the counted ceiling, not against the compressed input's size.
        let memory = styk_alloc::reserve(1).map_err(OpenError::out_of_memory)?;
        let mut state = Obj::new();
        state.set("propertyChannels", Value::Bool(true));
        state.set("layerTimeline", Value::Bool(true));
        state.set("layerRevision", Value::Num(1.0));
        state.set("nextFrameIdentity", Value::Num(opened.indexes.next_frame_identity));
        state.set("nextUid", Value::Num(opened.indexes.next_uid));
        let index = if application_open && opened.kind == "piv" && !opened.indexes.saved_draft { opened.tree.get("keyframes").and_then(Value::array_len).unwrap_or(1).saturating_sub(1) } else { 0 };
        let tick = if index == 0 { 0.0 } else { styk_edit::timeline_rows(&opened.tree).get(index).map_or(0.0, |row| row.0) };
        state.set("frameIndex", Value::Num(index as f64));
        state.set("tick", Value::Num(tick));
        let selected = opened.tree.get("keyframes").and_then(|frames| frames.item(index))
            .and_then(|frame| frame.get("objects").and_then(|objects| objects.item(0)))
            .and_then(|object| object.get("unique_id").cloned()).unwrap_or(Value::Null);
        state.set("selectedUid", selected.clone());
        state.set("selectedUids", Value::array(if selected.is_null() { Vec::new() } else { vec![selected] }));
        state.set("selectedJoint", Value::Num(-1.0));
        let mut session = opened.start_session(&styk_doc::json::to_string(&Value::object(state)))
            .map_err(|message| OpenError::refused(&message))?;
        if let Some(error) = memory.overrun() { return Err(OpenError::out_of_memory(error)); }
        session.set_memory_gate(|bytes| styk_alloc::admit(bytes).is_ok());
        session.call_native("@revisions", &[Value::Num(1.0), Value::Num(1.0), Value::Num(1.0)], &Value::Null)
            .result.map_err(|error| OpenError::refused(&error.to_string()))?;
        if application_open && opened.indexes.repairs > 0 {
            session.call_native("@touch", &[], &Value::Null).result.map_err(|error| OpenError::refused(&error.to_string()))?;
        }
        check_cancel(cancel)?;
        if let Some(error) = memory.overrun() { return Err(OpenError::out_of_memory(error)); }
        // `_publishLoadedReport`: remove only these extensions, then the stored name, then the default.
        let name = opened.name.rsplit_once('.').filter(|(_, extension)| ["piv", "stk", "styk"].iter().any(|known| extension.eq_ignore_ascii_case(known)) || application_open && ["stkz", "stykmov", "json", "nodes", "nodemc", "stknds"].iter().any(|known| extension.eq_ignore_ascii_case(known)))
            .map_or(opened.name.as_str(), |(stem, _)| stem);
        let name = if name.is_empty() { opened.tree.path(&["_styk", "name"]).and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or("Untitled animation") } else { name };
        Ok(Self {
            lineage: opened.lineage(),
            name: name.to_string(),
            session: SessionOwner::Ready(Box::new(session)),
            kind: opened.kind,
            original_first: opened.original_first,
            repairs: opened.indexes.repairs,
        })
    }

    /// The host's injected clock for budgeted reads, in milliseconds; no platform clock in the core.
    pub fn set_clock(&mut self, clock: fn() -> f64) {
        if let SessionOwner::Ready(session) = &mut self.session { session.set_clock(clock); }
    }

    fn open_application(engine: &Engine, bytes: Arc<[u8]>, name: &str, cancel: &dyn Fn() -> bool) -> Result<Self, OpenError> {
        let mut opened = engine.open_document(OpenSource::File { bytes: &bytes, name }, OpenOptions { layer_timeline: true }, cancel)?;
        if opened.source.is_some() { opened.attach_source(bytes)?; }
        Self::prepare(opened, true, cancel)
    }
}

fn check_cancel(cancel: &dyn Fn() -> bool) -> Result<(), OpenError> {
    if !cancel() { return Ok(()); }
    Err(OpenError {
        message: "The import was cancelled.".into(), key: None, params: Vec::new(),
        code: Some("cancelled".into()), status: Some(499), stage: styk_engine::document::OpenStage::Prepare,
    })
}

pub struct Document {
    id: DocumentId,
    prepared: PreparedDocument,
    scopes: Vec<host::Scope>,
    target: Option<FileTarget>,
    blank: bool,
    epoch: u64,
    saved_at: Option<f64>,
}

impl Document {
    pub fn id(&self) -> DocumentId { self.id }
    pub fn name(&self) -> &str { &self.prepared.name }
    pub fn revision(&self) -> u64 { self.prepared.session.revision() }
    pub fn view(&self) -> Result<DocumentView<'_>, DocumentsError> { Ok(self.prepared.session.get()?.view()) }
    pub fn selection(&self) -> Result<&Selection, DocumentsError> { Ok(self.view()?.selection) }
    pub fn lineage(&self) -> u64 { self.prepared.lineage }
    pub fn source_kind(&self) -> &'static str { self.prepared.kind }
    pub fn original_first(&self) -> bool { self.prepared.original_first }
    pub fn repairs(&self) -> usize { self.prepared.repairs }
    pub fn target(&self) -> Option<&FileTarget> { self.target.as_ref() }
    pub fn saved_at(&self) -> Option<f64> { self.saved_at }
    pub fn scope_depth(&self) -> usize { self.scopes.len() }
    pub fn project_name(&self) -> &str { self.scopes.first().map_or(self.name(), |scope| &scope.parent.name) }
    pub fn dirty(&self) -> bool { self.prepared.session.dirty() || self.scopes.iter().any(|scope| scope.parent.session.dirty()) }
    pub fn title(&self) -> String { format!("{}{} — StykAnimate", if self.dirty() { "• " } else { "" }, self.project_name()) }

    /// Borrow the canonical store for core logic such as save preparation. Never an editable mirror.
    pub fn records(&self) -> Result<&Value, DocumentsError> { Ok(self.prepared.session.get()?.report()) }

    /// Typed figures, keyframes, layers and project properties from the session's existing cache.
    /// Panel logic projects the fields it displays into its own plain-data view model inside `read`.
    pub fn with_document<T>(&self, read: impl FnOnce(&TypedDocument) -> T) -> Result<T, EditError> {
        self.prepared.session.get().map_err(|error| EditError::Invalid(error.to_string()))?.with_document(read)
    }

    /// Current frame records, shared with the session (live drafts and previews included).
    pub fn frame_records(&self) -> Result<Value, EditError> { self.prepared.session.get().map_err(|error| EditError::Invalid(error.to_string()))?.frame_records() }

    /// A named read of the session (`animationValue`, ...); `None` when the session does not answer that name.
    pub fn read(&self, name: &str, args: &Value) -> Option<Result<Option<Value>, EditError>> {
        match self.prepared.session.get() {
            Ok(session) => session.read(name, args),
            Err(error) => Some(Err(EditError::Invalid(error.to_string()))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentsError {
    NotOpen,
    NotActive,
    FinishEdit,
    TabLimit,
    IdentityExhausted,
    Busy,
    AsyncRequired { entry: &'static str },
    ServicesRequired,
}

impl DocumentsError {
    pub fn message_key(self) -> &'static str {
        match self {
            Self::NotOpen => "errors.editorSessions.thisProjectIsNoLongerOpen",
            Self::FinishEdit => "errors.editorSessions.finishTheCurrentEditFirst",
            Self::TabLimit => "errors.projectTabs.closeAProjectToOpenAnother",
            Self::NotActive => "errors.editorSessions.thisProjectIsNotActive",
            Self::IdentityExhausted => "errors.editorSessions.noProjectIdentityIsAvailable",
            Self::Busy => "errors.editorSessions.finishTheCurrentOperationFirst",
            Self::AsyncRequired { .. } => "errors.editorSessions.runThisOperationInTheBackground",
            Self::ServicesRequired => "errors.editorSessions.documentServicesAreNotAttached",
        }
    }
}

impl std::fmt::Display for DocumentsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message_key()) }
}
impl std::error::Error for DocumentsError {}

#[derive(Default)]
pub struct Documents {
    tabs: Vec<Document>,
    active: Option<DocumentId>,
    serial: u64,
    recent: Vec<DocumentId>,
    host: Option<host::Host>,
    clipboards: std::collections::HashMap<&'static str, Clipboard>,
}

struct Clipboard { source: (DocumentId, u64), holder: (DocumentId, u64), value: Value }

impl Documents {
    pub fn new() -> Self { Self::default() }
    pub fn tabs(&self) -> &[Document] { &self.tabs }
    pub fn get(&self, id: DocumentId) -> Option<&Document> { self.tabs.iter().find(|tab| tab.id == id) }
    pub fn active(&self) -> Option<&Document> { self.active.and_then(|id| self.get(id)) }
    /// Whether the shared clipboard of `kind` (`camera`, `figures`, ...) holds something to paste.
    pub fn has_clipboard(&self, kind: &str) -> bool { self.clipboards.contains_key(kind) }

    fn can_switch(&self) -> Result<(), DocumentsError> {
        if self.host.as_ref().is_some_and(host::Host::blocks_switch) { return Err(DocumentsError::Busy); }
        if let Some(tab) = self.active() && tab.view()?.editing { return Err(DocumentsError::FinishEdit); }
        Ok(())
    }

    /// Install a worker's ready session beside the active tab. On refusal return it to the caller:
    /// it can retry or dispose of it on a worker, without dropping a large project on the interface thread.
    pub fn open(&mut self, prepared: PreparedDocument) -> Result<DocumentId, (DocumentsError, PreparedDocument)> {
        if let Err(error) = self.can_switch() { return Err((error, prepared)); }
        if self.tabs.len() >= MAX_OPEN_PROJECTS { return Err((DocumentsError::TabLimit, prepared)); }
        let Some(serial) = self.serial.checked_add(1) else {
            return Err((DocumentsError::IdentityExhausted, prepared));
        };
        let id = DocumentId(serial);
        let at = self.active.and_then(|active| self.tabs.iter().position(|tab| tab.id == active)).map_or(self.tabs.len(), |at| at + 1);
        self.tabs.insert(at, Document { id, prepared, scopes: Vec::new(), target: None, blank: false, epoch: 0, saved_at: None });
        self.serial = serial;
        self.active = Some(id);
        self.recent.insert(0, id);
        if let Some(host) = self.host.as_mut() { host.publication_needed = true; }
        Ok(id)
    }

    /// Switch by stable identity; history, selection and playhead stay in their original session.
    pub fn activate(&mut self, id: DocumentId) -> Result<bool, DocumentsError> {
        if self.get(id).is_none() { return Err(DocumentsError::NotOpen); }
        if self.active == Some(id) { return Ok(false); }
        self.can_switch()?;
        self.active = Some(id);
        self.recent.retain(|other| *other != id);
        self.recent.insert(0, id);
        if let Some(host) = self.host.as_mut() { host.publication_needed = true; }
        Ok(true)
    }

    /// Today's command name/arguments and optional view inputs. A session refusal is `answer.result`,
    /// with its original `EditError` and events. A host refusal means no session was called.
    pub fn call(&mut self, id: DocumentId, method: &str, args: &[Value], view: &Value) -> Result<CallAnswer, DocumentsError> {
        if matches!(method, "@setClipboard" | "copySelection" | "cutSelection" | "sheetCopyFrames" | "copyCameraMotion" | "copyCamera" | "copySegmentValues" | "copyVfxClip" | "copyAudioClip" | "cutAudioClip" | "pasteSelection" | "pasteFiguresInFrames" | "sheetPasteFrames" | "pasteCamera" | "pasteCameraMotion" | "pasteSegmentValues" | "pasteAudioClip" | "pasteVfxClip") {
            let host = self.host.as_mut().ok_or(DocumentsError::ServicesRequired)?;
            if !host.allow_clipboard() { return Err(DocumentsError::Busy); }
        }
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id).ok_or(DocumentsError::NotOpen)?;
        if self.active != Some(id) { return Err(DocumentsError::NotActive); }
        if tab.prepared.session.get()?.requires_worker(method, args) {
            return Err(DocumentsError::AsyncRequired { entry: "Documents::dispatch(Request::Call)" });
        }
        let before = tab.revision();
        let before_tree = tab.records()?.clone();
        let paste = match method {
            "pasteSelection" | "pasteFiguresInFrames" => Some("figures"), "sheetPasteFrames" => Some("sheet"), "pasteCamera" => Some("camera"),
            "pasteCameraMotion" => Some("cameraMotion"), "pasteSegmentValues" => Some("segmentValues"),
            "pasteAudioClip" => Some("audio"), "pasteVfxClip" => Some("vfxClip"), _ => None,
        };
        if let Some(kind) = paste && let Some(clipboard) = self.clipboards.get_mut(kind) && clipboard.holder != (id, tab.lineage()) {
            let foreign = clipboard.source != (id, tab.lineage());
            let mut answer = tab.prepared.session.get_mut()?.call_native("@setClipboard", &[Value::str(kind), clipboard.value.clone(), Value::Bool(foreign)], &Value::Null);
            if let Some(old) = answer.retired_clipboard.take() && let Some(host) = self.host.as_mut() { host.retire(old); }
            if answer.result.is_err() { return Ok(answer); }
            clipboard.holder = (id, tab.lineage());
        }
        let mut view = view.clone();
        if let Some(fields) = view.make_obj() { fields.set("outerDepth", Value::Num(tab.scopes.len() as f64)); }
        tab.prepared.session.get_mut()?.set_outer_depth(tab.scopes.len());
        let mut result = tab.prepared.session.get_mut()?.call_native(method, args, &view);
        if let Some(old) = result.retired_clipboard.take() && let Some(host) = self.host.as_mut() { host.retire(old); }
        if tab.revision() != before || !tab.records()?.same_node(&before_tree) {
            tab.epoch = tab.epoch.wrapping_add(1);
            tab.blank = false;
            if let Some(host) = self.host.as_mut() { host.publication_needed = true; }
        }
        let copied = result.clipboard.as_ref().map(|(kind, _)| (*kind, (id, tab.lineage())));
        if let Some((kind, _)) = &result.clipboard && let Some(value) = tab.prepared.session.get()?.clipboard(kind) {
            let old = self.clipboards.insert(kind, Clipboard { source: (id, tab.lineage()), holder: (id, tab.lineage()), value });
            if let Some(host) = self.host.as_mut() { host.retire_clipboard(old); }
        }
        if paste == Some("figures") && result.result.is_ok() && let Some(clipboard) = self.clipboards.get_mut("figures") && let Some(value) = tab.prepared.session.get()?.clipboard("figures") {
            let old = std::mem::replace(&mut clipboard.value, value);
            if let Some(host) = self.host.as_mut() { host.retire_value(old); }
        }
        if let Some((kind, owner)) = copied {
            // A refused paste can leave a typed clipboard in any tab or parent scope. Once the
            // shared clipboard changes none of those old payloads is current, even if it is not
            // the last holder recorded by the wire handoff.
            for tab in &mut self.tabs {
                for prepared in std::iter::once(&mut tab.prepared).chain(tab.scopes.iter_mut().map(|scope| &mut scope.parent)) {
                    if (tab.id, prepared.lineage) != owner
                        && let Ok(session) = prepared.session.get_mut()
                        && let Some(old) = session.take_clipboard(kind)
                        && let Some(host) = self.host.as_mut() { host.retire(old); }
                }
            }
        }
        Ok(result)
    }

    pub fn undo(&mut self, id: DocumentId) -> Result<CallAnswer, DocumentsError> { self.call(id, "undo", &[], &Value::Null) }
    pub fn redo(&mut self, id: DocumentId) -> Result<CallAnswer, DocumentsError> { self.call(id, "redo", &[], &Value::Null) }
}
