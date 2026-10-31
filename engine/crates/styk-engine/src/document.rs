//! Documents entering the engine, and the published document following the session's.
//!
//! A document arrives as a file's bytes (Pivot `.piv`, a native `.styk`, …) or as JSON text (a new document,
//! a recovery copy, an import the interface decoded). [`Engine::open_document`] decodes it, normalizes it as
//! the editor's load does (`styk_edit::load`), and converts it into the typed views evaluation reads, all on
//! the calling thread: the interface hands it to a worker (`Engine::spawn`). The result holds the document's
//! tree, the indexes the interface adopts and the typed views, ready to be published ([`Engine::activate`])
//! and edited (`styk_edit::session::Session::start_prepared`).
//!
//! Once a session edits the document, [`Engine::publish_tree`] brings the published document to the
//! session's tree after each call: only the records the call replaced are converted again, as the tree is
//! shared copy-on-write.

use std::sync::Arc;

use styk_doc::{Obj, Value};
use styk_eval::assets::Assets;
use styk_eval::eval::Prepared;
use styk_eval::load::Loader;

use crate::store::Committed;
use crate::{Engine, Generation};

/// What the interface knows about the editor that opens the document.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenOptions {
    /// The editor gives every document a layer sheet (the app's editor does).
    pub layer_timeline: bool,
}

/// Where a document comes from.
pub enum OpenSource<'a> {
    /// A file: its bytes and its name (the extension says what kind of file it is).
    File { bytes: &'a [u8], name: &'a str },
    /// A document as JSON text, and the name it is shown under.
    Json { bytes: &'a [u8], name: &'a str },
}

/// How far an open got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenStage {
    /// The file could not be read.
    Decode,
    /// The document was read but cannot be edited or drawn.
    Prepare,
}

/// Why a document did not open, as the interface words it: a message key with its parameters where the
/// editor has one, else the plain message.
#[derive(Clone, Debug)]
pub struct OpenError {
    pub message: String,
    pub key: Option<String>,
    pub params: Vec<(String, String)>,
    /// The machine code the interface branches on (`invalid_project`, `file_too_large`, …).
    pub code: Option<String>,
    /// The status the Pivot codec answers a bad file with.
    pub status: Option<u16>,
    pub stage: OpenStage,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.key.as_deref().unwrap_or(&self.message))
    }
}

impl std::error::Error for OpenError {}

/// The key of the message shown for a document the load cannot make sense of.
const UNREADABLE: &str = "errors.importWorker.unreadableProject";

/// The key of the message shown when the engine is too low on memory for the work asked of it: the engine
/// refuses the work and goes on with what it holds ([`styk_alloc`]).
pub const OUT_OF_MEMORY: &str = "errors.engine.outOfMemory";

/// What opening a document takes beyond its file, per byte of the file or text, at most: the decoded document, its
/// typed views and what the reader holds on the way. Measured at the peak of opening (2026-10-24, the private
/// documents): a Pivot file of 4 to 41 MB took 6.7 to 14.2 bytes, a .styk of 35 MB 11.4. Opening reserves this
/// much before it starts.
pub const OPEN_BYTES_PER_BYTE: usize = 16;

/// The least an open reserves: small files of vector drawings take dozens of times their size (a 1 MB .styk
/// took 60 MB), so 96 MiB.
const OPEN_MINIMUM_BYTES: usize = 96 << 20;

/// Whether the engine has the memory to take a file of `file_bytes` bytes in and open it: the bytes cross into the
/// module first (one block, which a memory with room left in many pieces may not have: it is tried), then the open
/// reserves what it needs ([`open_estimate`]). The interface asks before it copies a file in, because the copy itself
/// cannot be refused.
pub fn admit_open(file_bytes: usize) -> Result<(), OpenError> {
    styk_alloc::admit(file_bytes.saturating_add(open_estimate(file_bytes))).map_err(OpenError::out_of_memory)?;
    block(file_bytes)
}

/// Whether the engine has the memory to take `bytes` bytes in (a file kept with its document): one block.
pub fn admit_copy(bytes: usize) -> Result<(), OpenError> {
    styk_alloc::admit(bytes).map_err(OpenError::out_of_memory)?;
    block(bytes)
}

/// Tries one block of `bytes` bytes: a memory with room left only in pieces has none.
fn block(bytes: usize) -> Result<(), OpenError> {
    let mut copy: Vec<u8> = Vec::new();
    copy.try_reserve_exact(bytes).map_err(|_| OpenError::out_of_memory(styk_alloc::OutOfMemory { requested: bytes, available: styk_alloc::headroom() }))
}

/// What opening a document of `file_bytes` bytes may take, for the reservation that precedes the open.
pub fn open_estimate(file_bytes: usize) -> usize {
    file_bytes.saturating_mul(OPEN_BYTES_PER_BYTE).max(OPEN_MINIMUM_BYTES)
}

impl OpenError {
    fn decode(message: impl Into<String>) -> OpenError {
        OpenError { message: message.into(), key: None, params: Vec::new(), code: None, status: None, stage: OpenStage::Decode }
    }

    fn unreadable() -> OpenError {
        OpenError { key: Some(UNREADABLE.into()), ..OpenError::decode("The project is not readable.") }
    }

    /// The engine has too little memory left for the work: it is refused, with the memory unchanged.
    pub fn out_of_memory(error: styk_alloc::OutOfMemory) -> OpenError {
        OpenError { key: Some(OUT_OF_MEMORY.into()), code: Some("out_of_memory".into()), ..OpenError::decode(error.to_string()) }
    }

    fn from_codec(error: styk_piv::CodecError) -> OpenError {
        OpenError { code: Some(error.code), status: Some(error.status), ..OpenError::decode(error.message) }
    }

    fn from_file(error: styk_formats::files::FileError) -> OpenError {
        let params = error.kind.map(|kind| vec![("kind".to_string(), kind.to_string())]).unwrap_or_default();
        OpenError { key: Some(error.message_key.into()), params, code: error.code.map(str::to_string), ..OpenError::decode(error.detail) }
    }

    fn from_edit(error: styk_edit::EditError) -> OpenError {
        match error {
            styk_edit::EditError::Invalid(text) if text == styk_edit::load::TYPE_ERROR => OpenError { stage: OpenStage::Prepare, ..OpenError::unreadable() },
            styk_edit::EditError::Invalid(text) if text.starts_with("errors.") => OpenError { key: Some(text.clone()), stage: OpenStage::Prepare, ..OpenError::decode(text) },
            other => OpenError { stage: OpenStage::Prepare, ..OpenError::decode(other.to_string()) },
        }
    }

    /// The error as JSON: `{message, messageKey?, messageParams?, code?, status?, stage}`.
    pub fn to_json(&self) -> String {
        let text = |value: &str| styk_doc::json::to_string(&Value::str(value));
        let mut out = format!("{{\"message\":{},\"stage\":\"{}\"", text(&self.message), if self.stage == OpenStage::Decode { "decode" } else { "prepare" });
        if let Some(key) = &self.key {
            out.push_str(&format!(",\"messageKey\":{}", text(key)));
            if !self.params.is_empty() {
                let params: Vec<String> = self.params.iter().map(|(name, value)| format!("{}:{}", text(name), text(value))).collect();
                out.push_str(&format!(",\"messageParams\":{{{}}}", params.join(",")));
            }
        }
        if let Some(code) = &self.code {
            out.push_str(&format!(",\"code\":{}", text(code)));
        }
        if let Some(status) = self.status {
            out.push_str(&format!(",\"status\":{status}"));
        }
        out.push('}');
        out
    }
}

/// Where the typed views of a published tree come from.
enum Views {
    /// Made again from the tree.
    Convert,
    /// The ones the engine holds: the tree is the one they were made from.
    Same(Arc<Prepared>),
    /// The ones the caller made of the tree; the engine's atlas is extended by their document.
    Made(Arc<Prepared>),
}

/// The typed views of a document and the image atlas that belong to it: what publishing it needs.
pub struct Typed {
    /// The tree the views were made from.
    pub(crate) tree: Value,
    pub(crate) loader: Loader,
    pub(crate) prepared: Arc<Prepared>,
    pub(crate) assets: Arc<Assets>,
    pub(crate) lineage: u64,
}

/// A document ready to be published and edited.
pub struct OpenedDocument {
    /// The normalized document, exactly as the interface's read view will hold it.
    pub tree: Value,
    /// The indexes the editor adopts with it (its `report` is empty: the tree is above).
    pub indexes: styk_edit::load::Prepared,
    /// The name the document is shown under.
    pub name: String,
    /// What kind of file it came from (`piv`, `styk`, …; `json` for JSON text).
    pub kind: &'static str,
    /// The document's `version`.
    pub version: f64,
    /// The typed views and image atlas of the tree.
    pub typed: Typed,
}

/// The extension of a file name, lower case.
fn extension(name: &str) -> &str {
    name.rsplit_once('.').map_or("", |(_, extension)| extension)
}

impl Engine {
    /// Opens a document: decodes it, normalizes it as the editor's load does and builds its typed views. Runs
    /// on the calling thread, for as long as the document takes; `cancel` is polled where the Pivot reader
    /// checks (between frames).
    pub fn open_document(&self, source: OpenSource<'_>, options: OpenOptions, cancel: &dyn Fn() -> bool) -> Result<OpenedDocument, OpenError> {
        // The open allocates in pieces nothing can refuse: it starts only when the memory can hold all of it.
        let (OpenSource::File { bytes, .. } | OpenSource::Json { bytes, .. }) = &source;
        let _memory = styk_alloc::reserve(open_estimate(bytes.len())).map_err(OpenError::out_of_memory)?;
        let (document, kind, version, name) = match source {
            OpenSource::File { bytes, name } => {
                let extension = extension(name).to_ascii_lowercase();
                match extension.as_str() {
                    "piv" | "stk" => {
                        let decoded = styk_piv::decode_document(bytes, name, cancel).map_err(OpenError::from_codec)?;
                        (decoded.document, decoded.kind, decoded.version, decoded.filename)
                    }
                    other => {
                        let Some(kind) = styk_formats::Kind::from_extension(other) else {
                            return Err(OpenError::decode("Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file."));
                        };
                        let document = styk_formats::files::open_document(bytes, kind).map_err(OpenError::from_file)?;
                        let version = document.get("version").and_then(Value::as_f64).unwrap_or(5.0);
                        (document, kind.name(), version, name.to_string())
                    }
                }
            }
            OpenSource::Json { bytes, name } => {
                let document = styk_doc::json::parse(bytes).map_err(|_| OpenError::unreadable())?;
                let version = document.get("version").and_then(Value::as_f64).unwrap_or(5.0);
                (document, "json", version, name.to_string())
            }
        };
        if cancel() {
            return Err(OpenError { code: Some("cancelled".into()), status: Some(499), ..OpenError::decode("The import was cancelled.") });
        }
        let mut indexes = styk_edit::load::prepare_for_editor(document, options.layer_timeline).map_err(OpenError::from_edit)?;
        let tree = std::mem::replace(&mut indexes.report, Value::Null);
        let shown = tree.path(&["_styk", "name"]).and_then(Value::as_str).unwrap_or("").to_string();
        let mut loader = Loader::new();
        let converted = loader.document(&tree, &shown).map_err(|error| OpenError { stage: OpenStage::Prepare, ..OpenError::decode(error.to_string()) })?;
        let assets = Arc::new(Assets::build(&converted));
        let prepared = Arc::new(Prepared::new(Arc::new(converted)));
        let lineage = self.inner.next_generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(OpenedDocument { tree: tree.clone(), indexes, name, kind, version, typed: Typed { tree, loader, prepared, assets, lineage } })
    }

    /// Makes the document that `typed` belongs to the engine's document, at `revision`, with `tree` as it
    /// is now: the stage draws it, playback and exports read it. What changed in `tree` since `typed` was made
    /// is converted again; nothing else is.
    pub fn activate(&self, typed: &Typed, tree: &Value, revision: u64) -> Result<Committed, OpenError> {
        let mut store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        store.loader = typed.loader.clone();
        store.lineage = typed.lineage;
        store.assets = Some(typed.assets.clone());
        store.prepared = Some(typed.prepared.clone());
        store.tree = typed.tree.clone();
        // The tree it was opened as needs no conversion: its views are the ones made at the open.
        let reuse = tree.same_node(&typed.tree).then(|| typed.prepared.clone());
        self.publish_locked(store, tree.clone(), revision, reuse.map_or(Views::Convert, Views::Same))
    }

    /// Brings the engine's document to `tree` at `revision`, converting only the records that changed since the
    /// last publication. `None` when `lineage` is not the document the engine holds (another document is in
    /// front, or none): nothing is published.
    pub fn publish_tree(&self, lineage: u64, tree: Value, revision: u64) -> Result<Option<Committed>, OpenError> {
        self.publish_tree_with(lineage, tree, revision, None)
    }

    /// [`Engine::publish_tree`] with the typed views the caller already made of `tree` (the editing session converts the
    /// document for its own reads): they are published as they are, and the document is converted once.
    pub fn publish_tree_with(&self, lineage: u64, tree: Value, revision: u64, made: Option<Arc<Prepared>>) -> Result<Option<Committed>, OpenError> {
        let store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if store.lineage != lineage || store.prepared.is_none() {
            return Ok(None);
        }
        // A revision that moved with the tree untouched (a document marked as changed) keeps its typed views.
        let views = if tree.same_node(&store.tree) {
            store.prepared.clone().map_or(Views::Convert, Views::Same)
        } else {
            made.map_or(Views::Convert, Views::Made)
        };
        self.publish_locked(store, tree, revision, views).map(Some)
    }

    /// The typed views of the document the engine holds, when `tree` is the tree it was published from.
    pub fn views_of(&self, tree: &Value) -> Option<Arc<Prepared>> {
        let store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        store.tree.same_node(tree).then(|| store.prepared.clone()).flatten()
    }

    fn publish_locked(&self, mut store: std::sync::MutexGuard<'_, crate::store::Store>, tree: Value, revision: u64, views: Views) -> Result<Committed, OpenError> {
        let started = self.now();
        let (prepared, assets, converted) = match views {
            Views::Same(prepared) => (prepared, store.assets.clone().expect("an activated document has its atlas"), Default::default()),
            Views::Made(prepared) => {
                let assets = Arc::new(match &store.assets {
                    Some(previous) => previous.extended(&prepared.doc),
                    None => Assets::build(&prepared.doc),
                });
                (prepared, assets, Default::default())
            }
            Views::Convert => {
                let name = tree.path(&["_styk", "name"]).and_then(Value::as_str).unwrap_or("").to_string();
                let document = store.loader.document(&tree, &name).map_err(|error| OpenError { stage: OpenStage::Prepare, ..OpenError::decode(error.to_string()) })?;
                let converted = store.loader.converted;
                let assets = Arc::new(match &store.assets {
                    Some(previous) => previous.extended(&document),
                    None => Assets::build(&document),
                });
                (Arc::new(Prepared::new(Arc::new(document))), assets, converted)
            }
        };
        let generation = Generation { id: 0, lineage: store.lineage, revision, prepared: prepared.clone(), assets: assets.clone(), open_ms: self.now() - started, anchors: None };
        store.tree = tree;
        store.revision = revision;
        // A publication of the document itself takes a draft out.
        store.draft = None;
        store.prepared = Some(prepared);
        store.assets = Some(assets);
        store.loader.release_unused();
        drop(store);
        let id = self.publish(generation);
        Ok(Committed { generation: id, revision, converted, ms: self.now() - started })
    }
}

/// What a draft adds to the document: the figure definitions after its own, and the layers the objects
/// it draws belong to (object `unique_id` to layer id).
pub struct Draft {
    pub figures: Vec<Value>,
    pub assignments: Obj,
}

impl Draft {
    /// `tree` with the draft added, or `None` when `tree` has no place for it (it is not a document).
    fn applied(&self, tree: &Value) -> Option<Value> {
        let mut root = tree.clone();
        root.make_obj()?.get_mut("figure_types")?.make_arr()?.extend(self.figures.iter().cloned());
        if !self.assignments.is_empty() {
            let layers = root.make_obj()?.get_mut("_styk")?.make_obj()?.get_mut("layers")?;
            let assignments = layers.make_obj()?.get_mut("assignments")?.make_obj()?;
            for (uid, layer) in self.assignments.iter() {
                assignments.set(uid, layer.clone());
            }
        }
        Some(root)
    }
}

impl Engine {
    /// Whether the engine's generation holds the draft `token` made.
    pub fn draft_held(&self, token: u64) -> bool {
        self.inner.store.try_lock().is_ok_and(|store| store.draft == Some(token))
    }

    /// Draws the engine's document with `draft` added, as the generation in front, until the next publication of
    /// the document or [`Engine::clear_draft`]. A cel a first stroke is about to create is drawn this way: the
    /// document only has it once the stroke commits. The stored tree, its views and what an edit session or
    /// a planner reads never include a draft. `None` while no document is open.
    pub fn publish_draft(&self, token: u64, draft: &Draft) -> Result<Option<Committed>, OpenError> {
        let started = self.now();
        let mut store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if store.prepared.is_none() {
            return Ok(None);
        }
        let tree = draft.applied(&store.tree).ok_or_else(|| OpenError::decode("The draft has no document to be added to."))?;
        let name = tree.path(&["_styk", "name"]).and_then(Value::as_str).unwrap_or("").to_string();
        let document = store.loader.document(&tree, &name).map_err(|error| OpenError { stage: OpenStage::Prepare, ..OpenError::decode(error.to_string()) })?;
        let converted = store.loader.converted;
        let assets = Arc::new(match &store.assets {
            Some(previous) => previous.extended(&document),
            None => Assets::build(&document),
        });
        let revision = store.revision;
        let generation = Generation { id: 0, lineage: store.lineage, revision, prepared: Arc::new(Prepared::new(Arc::new(document))), assets, open_ms: self.now() - started, anchors: None };
        store.draft = Some(token);
        store.loader.release_unused();
        drop(store);
        let id = self.publish(generation);
        Ok(Some(Committed { generation: id, revision, converted, ms: self.now() - started }))
    }

    /// Takes a draft out: the document itself is the generation in front again. `None` when none is held.
    pub fn clear_draft(&self) -> Option<Committed> {
        let started = self.now();
        let mut store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        store.draft.take()?;
        let (prepared, assets) = (store.prepared.clone()?, store.assets.clone()?);
        let revision = store.revision;
        let generation = Generation { id: 0, lineage: store.lineage, revision, prepared, assets, open_ms: 0.0, anchors: None };
        drop(store);
        let id = self.publish(generation);
        Some(Committed { generation: id, revision, converted: Default::default(), ms: self.now() - started })
    }
}

impl OpenedDocument {
    /// Starts an editing session on the document with the editor's `state` (JSON: options, view and counters;
    /// see `styk_edit::session::Session`). The session shares the tree and the typed views, so nothing is
    /// converted again.
    pub fn start_session(&self, state: &str) -> Result<styk_edit::session::Session, String> {
        styk_edit::session::Session::start_prepared(self.tree.clone(), state, self.typed.loader.clone(), self.typed.prepared.clone())
    }

    /// The lineage of the document's generations.
    pub fn lineage(&self) -> u64 {
        self.typed.lineage
    }
}

impl OpenedDocument {
    /// Gives the document the Pivot file it was read from, as a saved native document carries its source
    /// (`_stykSource`: the codec's description of the file and the file itself), so that saving it needs no
    /// copy of the file anywhere else. `description` is an object; the file is added to it as `source_base64`.
    pub fn attach_source(&mut self, description: &Value, file: Vec<u8>) -> Result<(), OpenError> {
        let Some(description) = description.as_obj() else {
            return Err(OpenError::decode("The description of the original source is not an object."));
        };
        let mut source = description.clone();
        source.set("source_base64", Value::Blob(Arc::new(styk_doc::Blob { prefix: Arc::from(""), bytes: Arc::from(file) })));
        let mut root = self.tree.as_obj().cloned().ok_or_else(|| OpenError::decode("The document is not an object."))?;
        root.set("_stykSource", Value::object(source));
        self.tree = Value::object(root);
        Ok(())
    }
}
