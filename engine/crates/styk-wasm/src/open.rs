//! Opening a document: a file's bytes or JSON text decoded, normalized and made ready on the engine's
//! workers, then read back by the interface in bounded pieces (docs/engine/document.md).
//!
//! The interface starts a job ([`EngineHandle::open_document`]), waits on the progress counter, and takes the
//! [`OpenedDocument`]. The editor's read view is built from its pieces ([`OpenedDocument::part`]), each a
//! record of the document lifted as a file would lift it; the session that edits the document starts from
//! the same tree ([`OpenedDocument::start_session`]).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use styk_doc::{Obj, Value, json};
use styk_engine::Engine;
use styk_engine::document::{OpenError, OpenOptions, OpenSource, OpenedDocument as Opened};
use styk_formats::container::ViewLifter;
use wasm_bindgen::prelude::*;

use crate::edit::EditSession;
use crate::engine::EngineHandle;
use crate::js_error;

/// A job the interface started, until it takes the outcome.
pub(crate) struct Job {
    cancelled: Arc<AtomicBool>,
    outcome: Option<Result<Opened, OpenError>>,
}

/// The jobs of a handle, by number.
#[derive(Clone, Default)]
pub(crate) struct Jobs {
    table: Arc<Mutex<HashMap<u32, Job>>>,
    next: Arc<AtomicU32>,
}

fn options_of(text: &str) -> Result<OpenOptions, JsError> {
    let options = json::parse(text.as_bytes()).map_err(js_error)?;
    Ok(OpenOptions { layer_timeline: options.get("layerTimeline").is_some_and(Value::truthy) })
}

fn run(engine: &Engine, bytes: &[u8], name: &str, source: &str, options: OpenOptions, cancel: &dyn Fn() -> bool) -> Result<Opened, OpenError> {
    match source {
        "json" => engine.open_document(OpenSource::Json { bytes, name }, options, cancel),
        _ => engine.open_document(OpenSource::File { bytes, name }, options, cancel),
    }
}

#[wasm_bindgen]
impl EngineHandle {
    /// Starts opening a document on a worker and returns the job's number. `source` is `"file"` (the bytes of a
    /// file called `name`) or `"json"` (JSON text, shown under `name`); `options` is JSON (`layerTimeline`: the
    /// editor gives every document a layer sheet). Watch the progress counter, then call
    /// [`EngineHandle::take_opened_document`].
    pub fn open_document(&self, bytes: Vec<u8>, name: String, source: String, options: &str) -> Result<u32, JsError> {
        let options = options_of(options)?;
        let jobs = self.jobs.clone();
        let id = jobs.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancelled = Arc::new(AtomicBool::new(false));
        jobs.table.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Job { cancelled: cancelled.clone(), outcome: None });
        self.engine.spawn(move |engine| {
            let outcome = run(engine, &bytes, &name, &source, options, &|| cancelled.load(Ordering::Relaxed));
            drop(bytes);
            let mut table = jobs.table.lock().unwrap_or_else(|e| e.into_inner());
            // A job nobody wants any more (cancelled and forgotten) is dropped here, on the worker.
            if let Some(job) = table.get_mut(&id) {
                job.outcome = Some(outcome);
            }
        });
        Ok(id)
    }

    /// Whether the engine has the memory to open a file of `file_bytes` bytes ([`styk_engine::document::admit_open`]).
    /// Checked by the interface before it copies a file in. The error is an open error.
    pub fn admit_open(&self, file_bytes: f64) -> Result<(), JsError> {
        let bytes = crate::engine::counter(file_bytes).map_or(usize::MAX, |bytes| bytes as usize);
        styk_engine::document::admit_open(bytes).map_err(|error| js_error(error.to_json()))
    }

    /// Whether the engine has the memory to take `bytes` bytes in, as the Pivot original kept with a document is
    /// ([`OpenedDocument::attach_source`]). The error is an open error.
    pub fn admit_copy(&self, bytes: f64) -> Result<(), JsError> {
        let bytes = crate::engine::counter(bytes).map_or(usize::MAX, |bytes| bytes as usize);
        styk_engine::document::admit_copy(bytes).map_err(|error| js_error(error.to_json()))
    }

    /// Asks a job to stop at its next checkpoint; its outcome is still taken (as a cancellation).
    pub fn cancel_open(&self, job: u32) {
        if let Some(job) = self.jobs.table.lock().unwrap_or_else(|e| e.into_inner()).get(&job) {
            job.cancelled.store(true, Ordering::Relaxed);
        }
    }

    /// The outcome of a job, once: `undefined` while it runs. An error carries the open error as JSON in its
    /// message (`message`, `messageKey`, `messageParams`, `code`, `status`, `stage`).
    pub fn take_opened_document(&self, job: u32) -> Result<Option<OpenedDocument>, JsError> {
        // Only tried: the interface thread must not wait for a worker storing its result.
        let Ok(mut table) = self.jobs.table.try_lock() else { return Ok(None) };
        if table.get(&job).is_none_or(|entry| entry.outcome.is_none()) {
            return if table.contains_key(&job) { Ok(None) } else { Err(js_error("no such open job")) };
        }
        match table.remove(&job).and_then(|entry| entry.outcome) {
            Some(Ok(opened)) => Ok(Some(OpenedDocument::new(self.engine.clone(), opened))),
            Some(Err(error)) => Err(js_error(error.to_json())),
            None => Ok(None),
        }
    }

    /// Opens a document on this thread and returns it: for small documents (a new one, a tutorial's), where
    /// the editor needs the document at once.
    pub fn open_document_now(&self, bytes: &[u8], name: &str, source: &str, options: &str) -> Result<OpenedDocument, JsError> {
        let options = options_of(options)?;
        match run(&self.engine, bytes, name, source, options, &|| false) {
            Ok(opened) => Ok(OpenedDocument::new(self.engine.clone(), opened)),
            Err(error) => Err(js_error(error.to_json())),
        }
    }
}

/// Where the read view splits a document into pieces: tables and tables of records at these paths arrive one
/// entry at a time, after the rest of the document.
const SPLITS: [&[&str]; 5] = [&["figure_types"], &["keyframes"], &["backgrounds"], &["_styk", "frameSources"], &["_styk", "audio", "assets"]];

/// An opened document, until the editor has built its view and a session has started from it.
#[wasm_bindgen]
pub struct OpenedDocument {
    engine: Engine,
    /// Taken out only when the opening is released ([`Drop`]).
    opened: Option<Arc<Opened>>,
    lifter: RefCell<ViewLifter>,
}

/// An opened document can be hundreds of megabytes: the last owner drops it on an engine worker, never on the
/// interface thread (D7).
impl Drop for OpenedDocument {
    fn drop(&mut self) {
        if let Some(opened) = self.opened.take() {
            self.engine.spawn(move |_| drop(opened));
        }
    }
}

impl OpenedDocument {
    fn new(engine: Engine, opened: Opened) -> OpenedDocument {
        OpenedDocument { engine, opened: Some(Arc::new(opened)), lifter: RefCell::new(ViewLifter::new()) }
    }

    fn opened(&self) -> &Arc<Opened> {
        self.opened.as_ref().expect("an opened document is held until it is dropped")
    }

    /// The splits the document has, in order, with how many entries each holds.
    fn splits(&self) -> Vec<(usize, &'static [&'static str], Value)> {
        SPLITS.iter().enumerate().filter_map(|(at, path)| self.opened().tree.path(path).filter(|value| matches!(value, Value::Arr(_) | Value::Nums(_) | Value::Obj(_))).map(|value| (at, *path, value.clone()))).collect()
    }
}

/// `value` with the entry at `path` replaced by `empty` (where the path leads).
fn emptied(value: &Value, path: &[&str], empty: &Value) -> Value {
    let Some((first, rest)) = path.split_first() else { return empty.clone() };
    let Some(object) = value.as_obj() else { return value.clone() };
    let Some(child) = object.get(first) else { return value.clone() };
    let mut copy = object.clone();
    copy.set(first, emptied(child, rest, empty));
    Value::object(copy)
}

/// The root with every split's contents taken out (the empty array or object stays, so the keys keep their places).
fn without_splits(tree: &Value, splits: &[(usize, &'static [&'static str], Value)]) -> Value {
    let mut root = tree.clone();
    for (_, path, value) in splits {
        let empty = if matches!(value, Value::Obj(_)) { Value::object(Obj::new()) } else { Value::array(Vec::new()) };
        root = emptied(&root, path, &empty);
    }
    root
}

/// One piece of the read view: a record lifted as a file lifts it, and the section bytes it gained.
#[wasm_bindgen]
pub struct ViewPart {
    skeleton: String,
    sequences: String,
    arrays: Vec<u8>,
    arrays_base: f64,
    payloads: Vec<u8>,
    payloads_base: f64,
}

#[wasm_bindgen]
impl ViewPart {
    /// The JSON text of the record, with markers (`S2B:…`, `S2D:…`) where arrays and images moved out.
    #[wasm_bindgen(getter)]
    pub fn skeleton(&self) -> String {
        self.skeleton.clone()
    }

    /// The bytes the numeric-array section gained, starting at [`ViewPart::arrays_base`] of the whole section.
    /// The pose key sequences first met in this piece, as JSON (`[{"id":0,"v":[…]},…]`), or empty. The skeleton
    /// names one `S2R:<id>` wherever a channel holds it.
    #[wasm_bindgen(getter)]
    pub fn sequences(&self) -> String {
        self.sequences.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn arrays(&self) -> Vec<u8> {
        self.arrays.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn arrays_base(&self) -> f64 {
        self.arrays_base
    }

    #[wasm_bindgen(getter)]
    pub fn payloads(&self) -> Vec<u8> {
        self.payloads.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn payloads_base(&self) -> f64 {
        self.payloads_base
    }
}

#[wasm_bindgen]
impl OpenedDocument {
    /// What the interface needs to know before it reads the document, as JSON: its `name`, `kind`, `version`,
    /// the `lineage` of its generations, whether it stored a frame draft (`savedDraft`), the `indexes` the editor
    /// adopts (next identities, figures per layer, tracks) and the `splits` its view arrives in
    /// (`path`, and `count` of an array or `keys` of an object).
    pub fn meta(&self) -> String {
        let opened = self.opened();
        let mut out = Obj::new();
        out.set("name", Value::str(&opened.name));
        out.set("kind", Value::str(opened.kind));
        out.set("version", Value::Num(opened.version));
        out.set("lineage", Value::Num(opened.lineage() as f64));
        out.set("savedDraft", Value::Bool(opened.indexes.saved_draft));
        out.set("indexes", opened.indexes.indexes());
        let splits: Vec<Value> = self
            .splits()
            .into_iter()
            .map(|(_, path, value)| {
                let mut split = Obj::new();
                split.set("path", Value::array(path.iter().map(|key| Value::str(key)).collect()));
                match &value {
                    Value::Obj(object) => split.set("keys", Value::array(object.keys().map(|key| Value::str(key)).collect())),
                    other => split.set("count", Value::Num(other.array_len().unwrap_or(0) as f64)),
                }
                Value::object(split)
            })
            .collect();
        out.set("splits", Value::array(splits));
        json::to_string(&Value::object(out))
    }

    /// A piece of the document: `split` -1 is the document without the contents of its splits, `split` n
    /// (an index into [`OpenedDocument::meta`]'s `splits`) the entry `index` of that split. Pieces are lifted
    /// in the order they are asked for; ask for each once, the root first.
    pub fn part(&self, split: i32, index: u32) -> Result<ViewPart, JsError> {
        let splits = self.splits();
        let lifted = if split < 0 {
            let root = without_splits(&self.opened().tree, &splits);
            self.lifter.borrow_mut().part(&root, "")
        } else {
            let (_, _, container) = splits.get(split as usize).ok_or_else(|| js_error("no such document split"))?;
            let entry = match &container {
                Value::Obj(object) => object.iter().nth(index as usize).map(|(_, value)| value.clone()),
                other => other.elements().and_then(|items| items.get(index as usize)),
            };
            let entry = entry.ok_or_else(|| js_error("no such document entry"))?;
            self.lifter.borrow_mut().part(&entry, "")
        };
        let part = lifted.map_err(js_error)?;
        Ok(ViewPart { skeleton: String::from_utf8_lossy(&part.skeleton).into_owned(), sequences: String::from_utf8_lossy(&part.sequences).into_owned(), arrays: part.arrays, arrays_base: part.arrays_base as f64, payloads: part.payloads, payloads_base: part.payloads_base as f64 })
    }

    /// Gives the document the Pivot file it was read from (`description`: the codec's JSON description of it), so
    /// that it carries its own original (`_stykSource`). Before the read view is built and the session starts.
    pub fn attach_source(&mut self, description: &str, file: Vec<u8>) -> Result<(), JsError> {
        let description = json::parse(description.as_bytes()).map_err(js_error)?;
        let opened = Arc::get_mut(self.opened.as_mut().expect("an opened document is held until it is dropped")).ok_or_else(|| js_error("the document is being edited already"))?;
        opened.attach_source(&description, file).map_err(|error| js_error(error.to_json()))
    }

    /// Starts the session that edits this document, with the editor's `state` (JSON: options, view and
    /// counters). The session shares the document's tree and typed views.
    pub fn start_session(&self, state: &str) -> Result<EditSession, JsError> {
        let session = self.opened().start_session(state).map_err(js_error)?;
        Ok(EditSession::publishing(session, self.engine.clone(), self.opened().clone()))
    }
}
