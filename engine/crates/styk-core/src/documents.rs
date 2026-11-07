//! Open projects and the narrow editing/read seam used by panel logic.
//!
//! Prepare bytes on a worker, then move the ready session into `Documents::open`.
//! Each tab holds exactly one session; commands and queries use that owner directly.
//! There is no read-view tree, patch application, or second history in the core.

use std::sync::Arc;

pub use styk_doc::Value;
pub use styk_edit::session::{NativeCall as CallAnswer, SessionView as DocumentView};
pub use styk_edit::{EditError, Selection};
pub use styk_engine::document::OpenError;
pub use styk_eval::doc::Document as TypedDocument;

use styk_doc::Obj;
use styk_edit::session::Session;
use styk_engine::Engine;
use styk_engine::document::{OpenOptions, OpenSource, OpenedDocument};

/// Today's project-tab limit (`src/project-tabs.mjs`).
pub const MAX_OPEN_PROJECTS: usize = 12;

/// Stable identity within one `Documents` owner. Pair this with a revision in caches and job replies:
/// two projects can have the same history revision, and undo deliberately restores an older revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DocumentId(u64);

/// A fully prepared session. Construct on the open worker; installing it only moves ownership.
pub struct PreparedDocument {
    name: String,
    session: Box<Session>,
    lineage: u64,
    kind: &'static str,
    original_first: bool,
    repairs: usize,
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
        check_cancel(cancel)?;
        let mut state = Obj::new();
        state.set("propertyChannels", Value::Bool(true));
        state.set("layerTimeline", Value::Bool(true));
        state.set("layerRevision", Value::Num(1.0));
        state.set("nextFrameIdentity", Value::Num(opened.indexes.next_frame_identity));
        state.set("nextUid", Value::Num(opened.indexes.next_uid));
        let selected = opened.tree.get("keyframes").and_then(|frames| frames.item(0))
            .and_then(|frame| frame.get("objects").and_then(|objects| objects.item(0)))
            .and_then(|object| object.get("unique_id").cloned()).unwrap_or(Value::Null);
        state.set("selectedUid", selected.clone());
        state.set("selectedUids", Value::array(if selected.is_null() { Vec::new() } else { vec![selected] }));
        state.set("selectedJoint", Value::Num(-1.0));
        let mut session = opened.start_session(&styk_doc::json::to_string(&Value::object(state)))
            .map_err(|message| OpenError::refused(&message))?;
        session.set_memory_gate(|bytes| styk_alloc::admit(bytes).is_ok());
        session.call_native("@revisions", &[Value::Num(1.0), Value::Num(1.0), Value::Num(1.0)], &Value::Null)
            .result.map_err(|error| OpenError::refused(&error.to_string()))?;
        check_cancel(cancel)?;
        // `_publishLoadedReport`: remove only these extensions, then the stored name, then the default.
        let name = opened.name.rsplit_once('.').filter(|(_, extension)| ["piv", "stk", "styk"].iter().any(|known| extension.eq_ignore_ascii_case(known)))
            .map_or(opened.name.as_str(), |(stem, _)| stem);
        let name = if name.is_empty() { opened.tree.path(&["_styk", "name"]).and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or("Untitled animation") } else { name };
        Ok(Self {
            lineage: opened.lineage(),
            name: name.to_string(),
            session: Box::new(session),
            kind: opened.kind,
            original_first: opened.original_first,
            repairs: opened.indexes.repairs,
        })
    }

    /// The host's injected clock for budgeted reads, in milliseconds; no platform clock in the core.
    pub fn set_clock(&mut self, clock: fn() -> f64) {
        self.session.set_clock(clock);
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
}

impl Document {
    pub fn id(&self) -> DocumentId { self.id }
    pub fn name(&self) -> &str { &self.prepared.name }
    pub fn revision(&self) -> u64 { self.prepared.session.revision() }
    pub fn view(&self) -> DocumentView<'_> { self.prepared.session.view() }
    pub fn selection(&self) -> &Selection { self.view().selection }
    pub fn lineage(&self) -> u64 { self.prepared.lineage }
    pub fn source_kind(&self) -> &'static str { self.prepared.kind }
    pub fn original_first(&self) -> bool { self.prepared.original_first }
    pub fn repairs(&self) -> usize { self.prepared.repairs }

    /// Borrow the canonical store for core logic such as save preparation. Never an editable mirror.
    pub fn records(&self) -> &Value { self.prepared.session.report() }

    /// Typed figures, keyframes, layers and project properties from the session's existing cache.
    /// Panel logic projects the fields it displays into its own plain-data view model inside `read`.
    pub fn with_document<T>(&self, read: impl FnOnce(&TypedDocument) -> T) -> Result<T, EditError> {
        self.prepared.session.with_document(read)
    }

    /// Current frame records, shared with the session (live drafts and previews included).
    pub fn frame_records(&self) -> Result<Value, EditError> { self.prepared.session.frame_records() }

    /// The selected figures' bounds in the frame on show (`selectionBounds()`), measured by the session.
    pub fn selection_bounds(&self) -> Result<Option<[f64; 4]>, EditError> { self.prepared.session.selection_bounds() }

    /// A named read of the session (`animationValue`, ...); `None` when the session does not answer that name.
    pub fn read(&self, name: &str, args: &Value) -> Option<Result<Option<Value>, EditError>> { self.prepared.session.read(name, args) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentsError {
    NotOpen,
    NotActive,
    FinishEdit,
    TabLimit,
    IdentityExhausted,
}

impl DocumentsError {
    pub fn message_key(self) -> &'static str {
        match self {
            Self::NotOpen => "errors.editorSessions.thisProjectIsNoLongerOpen",
            Self::FinishEdit => "errors.editorSessions.finishTheCurrentEditFirst",
            Self::TabLimit => "errors.projectTabs.closeAProjectToOpenAnother",
            Self::NotActive => "The project is not active.",
            Self::IdentityExhausted => "No project identity is available.",
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
}

impl Documents {
    pub fn new() -> Self { Self::default() }
    pub fn tabs(&self) -> &[Document] { &self.tabs }
    pub fn get(&self, id: DocumentId) -> Option<&Document> { self.tabs.iter().find(|tab| tab.id == id) }
    pub fn active(&self) -> Option<&Document> { self.active.and_then(|id| self.get(id)) }

    fn can_switch(&self) -> Result<(), DocumentsError> {
        if self.active().is_some_and(|tab| tab.view().editing) { Err(DocumentsError::FinishEdit) } else { Ok(()) }
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
        self.tabs.insert(at, Document { id, prepared });
        self.serial = serial;
        self.active = Some(id);
        Ok(id)
    }

    /// Switch by stable identity; history, selection and playhead stay in their original session.
    pub fn activate(&mut self, id: DocumentId) -> Result<bool, DocumentsError> {
        if self.get(id).is_none() { return Err(DocumentsError::NotOpen); }
        if self.active == Some(id) { return Ok(false); }
        self.can_switch()?;
        self.active = Some(id);
        Ok(true)
    }

    /// Today's command name/arguments and optional view inputs. A session refusal is `answer.result`,
    /// with its original `EditError` and events. A host refusal means no session was called.
    pub fn call(&mut self, id: DocumentId, method: &str, args: &[Value], view: &Value) -> Result<CallAnswer, DocumentsError> {
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id).ok_or(DocumentsError::NotOpen)?;
        if self.active != Some(id) { return Err(DocumentsError::NotActive); }
        Ok(tab.prepared.session.call_native(method, args, view))
    }

    pub fn undo(&mut self, id: DocumentId) -> Result<CallAnswer, DocumentsError> { self.call(id, "undo", &[], &Value::Null) }
    pub fn redo(&mut self, id: DocumentId) -> Result<CallAnswer, DocumentsError> { self.call(id, "redo", &[], &Value::Null) }
}
