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

use styk_doc::fanout::{Failed, Fanout, Task};
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
    /// A file the open owns: a Pivot project's bytes are dropped as soon as they are inflated, before the document is built, so
    /// the file is never held with the document under construction.
    Owned { bytes: Vec<u8>, name: &'a str },
    /// A document as JSON text, and the name it is shown under.
    Json { bytes: &'a [u8], name: &'a str },
    /// A document already in memory as a tree, and the name it is shown under: a movieclip's own, taken from the project that holds it (as the
    /// project holds it: its arrays shared with the project's other records, which the open unshares once its memory is reserved, so that the
    /// document is the one its text would give). Nothing is read from text, so what the open makes is the normalized document and its views.
    Tree { document: Value, name: &'a str },
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

/// [`OUT_OF_MEMORY`] for a save or an export, which fails without touching the open document: the message does not tell
/// the person to save their work.
pub const OUT_OF_MEMORY_SAVING: &str = "errors.engine.outOfMemoryWhileSaving";

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
    // Only the copy and the least an open takes: what the open itself needs is reserved by the open, which knows more than the size
    // of the file (a project states the size of its parts), and refuses with the same message.
    styk_alloc::admit(file_bytes.saturating_add(OPEN_MINIMUM_BYTES)).map_err(OpenError::out_of_memory)?;
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

/// How many times the text of a document that is already a tree the open of it may take: the normalized copy and the typed views (a clip of
/// every figure of a large project took one time its text; the open of its text takes sixteen, for the buffers it parses through).
pub const OPEN_BYTES_PER_TREE_BYTE: usize = 3;

/// What opening `tree` may take, for the reservation that precedes the open.
pub fn open_tree_estimate(tree: &Value) -> usize {
    let text = styk_doc::json::utf16_units_checked::<std::convert::Infallible>(tree, || Ok(())).unwrap_or(0);
    // The copy that gives the text's arrays (`Value::unshared`) is made once the memory is reserved, and what it allocates is not what the text says.
    text.saturating_mul(OPEN_BYTES_PER_TREE_BYTE).saturating_add(tree.unshared_cost()).max(OPEN_MINIMUM_BYTES)
}

/// What opening a document of `file_bytes` bytes may take, for the reservation that precedes the open.
pub fn open_estimate(file_bytes: usize) -> usize {
    file_bytes.saturating_mul(OPEN_BYTES_PER_BYTE).max(OPEN_MINIMUM_BYTES)
}

/// What opening a Pivot file takes beyond the file, per byte of the payload it inflates to, at most. Measured at the peak of opening
/// (2026-11-01, the private documents): 5.7 for a file of 39 MiB that inflates to 54, 5.2 for 21 MiB that inflates to 42.
pub const PIVOT_OPEN_BYTES_PER_INFLATED_BYTE: usize = 8;

/// The size of the payload a Pivot file inflates to, counted by inflating it and keeping nothing: a window of 32 KiB, the input as it
/// is, and a look at `cancel` for every megabyte. `None` for a stream that does not inflate (the open says why) or an open that was
/// cancelled. A payload that is not compressed (a version byte first) is the file.
fn inflated_size(file: &[u8], cancel: &dyn Fn() -> bool) -> Option<usize> {
    use miniz_oxide::inflate::TINFLStatus;
    use miniz_oxide::inflate::core::{DecompressorOxide, TINFL_LZ_DICT_SIZE, decompress, inflate_flags};
    if file.first().is_some_and(|version| (1..=5).contains(version)) {
        return Some(file.len());
    }
    let mut state = Box::new(DecompressorOxide::new());
    let mut window = vec![0u8; TINFL_LZ_DICT_SIZE];
    let flags = inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER | inflate_flags::TINFL_FLAG_IGNORE_ADLER32;
    let (mut read, mut at, mut total, mut checked) = (0usize, 0usize, 0usize, 0usize);
    loop {
        let (status, used, written) = decompress(&mut state, &file[read..], &mut window, at, flags);
        read += used;
        total = total.saturating_add(written);
        at = (at + written) & (TINFL_LZ_DICT_SIZE - 1);
        if total - checked >= 1 << 20 {
            checked = total;
            if cancel() {
                return None;
            }
        }
        match status {
            TINFLStatus::Done => return Some(total),
            TINFLStatus::HasMoreOutput => {}
            _ => return None,
        }
    }
}

/// The reservation the open of `source` makes before it starts. A Pivot file's size says little of what it opens to (a project of
/// 120 MB of pictures stored as they were needs a tenth of what 16 times its size says, and a compressed one needs more of it), so a Pivot
/// file the estimate by size refuses is asked what it inflates to, and refused only when that does not fit either.
fn reserve_for_open(source: &OpenSource<'_>, cancel: &dyn Fn() -> bool) -> Result<styk_alloc::Reservation, OpenError> {
    let estimate = open_estimate_of(source);
    let refused = match styk_alloc::reserve(estimate) {
        Ok(reservation) => return Ok(reservation),
        Err(refused) => refused,
    };
    let (bytes, name): (&[u8], &str) = match source {
        OpenSource::File { bytes, name } => (bytes, name),
        OpenSource::Owned { bytes, name } => (bytes.as_slice(), name),
        OpenSource::Json { .. } | OpenSource::Tree { .. } => return Err(OpenError::out_of_memory(refused)),
    };
    if !matches!(extension(name).to_ascii_lowercase().as_str(), "piv" | "stk") {
        return Err(OpenError::out_of_memory(refused));
    }
    let counted = inflated_size(bytes, cancel);
    if cancel() {
        return Err(OpenError::cancelled());
    }
    match counted.map(|size| size.saturating_mul(PIVOT_OPEN_BYTES_PER_INFLATED_BYTE).max(OPEN_MINIMUM_BYTES)) {
        Some(real) if real < estimate => styk_alloc::reserve(real).map_err(OpenError::out_of_memory),
        _ => Err(OpenError::out_of_memory(refused)),
    }
}

/// What opening `source` may take, for the reservation that precedes the open: [`open_estimate`] of the file, or for a project
/// container (which states how large its parts are) what its parts take, never more than the file's estimate.
fn open_estimate_of(source: &OpenSource<'_>) -> usize {
    let (bytes, name): (&[u8], &str) = match source {
        OpenSource::File { bytes, name } => (bytes, name),
        OpenSource::Owned { bytes, name } => (bytes.as_slice(), name),
        OpenSource::Json { bytes, .. } => return open_estimate(bytes.len()),
        OpenSource::Tree { document, .. } => return open_tree_estimate(document),
    };
    let by_size = open_estimate(bytes.len());
    let Some(kind) = styk_formats::Kind::from_extension(&extension(name).to_ascii_lowercase()) else { return by_size };
    styk_formats::container::open_cost(bytes, kind).map_or(by_size, |cost| cost.clamp(OPEN_MINIMUM_BYTES, by_size))
}

impl OpenError {
    fn decode(message: impl Into<String>) -> OpenError {
        OpenError { message: message.into(), key: None, params: Vec::new(), code: None, status: None, stage: OpenStage::Decode }
    }

    /// A refusal that is a message of the interface's, for a document that cannot be opened as asked.
    pub fn refused(key: &str) -> OpenError {
        OpenError { key: Some(key.into()), stage: OpenStage::Prepare, ..OpenError::decode(key) }
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

    /// The open was stopped.
    fn cancelled() -> OpenError {
        OpenError { code: Some("cancelled".into()), status: Some(499), ..OpenError::decode("The import was cancelled.") }
    }

    /// A worker that had a piece of the open stopped, so the open cannot be trusted to have seen the whole document.
    fn worker_lost() -> OpenError {
        OpenError { key: Some("errors.importClient.theFileImporterStoppedUnexpectedly".into()), code: Some("worker_failed".into()), ..OpenError::decode("A worker of the engine stopped while the document was being opened.") }
    }

    fn from_edit(error: styk_edit::EditError) -> OpenError {
        match error {
            styk_edit::EditError::Invalid(text) if text == styk_edit::load::CANCELLED => OpenError { stage: OpenStage::Prepare, ..OpenError::cancelled() },
            styk_edit::EditError::Invalid(text) if text == styk_edit::load::WORKER_LOST => OpenError { stage: OpenStage::Prepare, ..OpenError::worker_lost() },
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
    /// What a Pivot project says of its original (`_stykSource` without the file: kind, version, the SHA-256 of the file and of the
    /// document read from it); the file is added by [`OpenedDocument::attach_source`]. `None` for any other kind of document.
    pub source: Option<styk_doc::Obj>,
    /// A save stores the document's Pivot original (`_stykSource`) first in the payload section: the document was read from a Pivot file.
    /// A project file that carries one keeps the order its file had.
    pub original_first: bool,
    /// Where the open's time went, in milliseconds by the engine's clock: `decode` (the file read into a document), `prepare` (the
    /// load's checks and normalization), `views` (the typed views), `check` (what was left of the skeleton's checksum when the
    /// rest was done).
    pub timings: Vec<(&'static str, f64)>,
}

/// The engine's workers as the open's [`Fanout`]: the open's own thread and up to `helpers` others take the tasks.
struct OpenFanout<'a> {
    engine: &'a Engine,
    cancel: &'a dyn Fn() -> bool,
    helpers: usize,
    /// How many workers had stopped when the open began.
    lost_before: u32,
    /// The tasks given to other workers by [`Fanout::spawn`] that have not ended: never more than `helpers`.
    spawned: Arc<std::sync::atomic::AtomicUsize>,
    /// The phases the readers marked, with the time each was reached.
    marks: std::sync::Mutex<Vec<(&'static str, f64)>>,
}

impl Fanout for OpenFanout<'_> {
    fn threads(&self) -> usize {
        self.helpers + 1
    }

    /// Gives `task` to another worker unless `helpers` of them hold the open's tasks already: the open never takes every worker, so the
    /// frame on show of another document is prepared meanwhile. A task that is handed back runs on the open's own thread.
    fn spawn(&self, task: Task) -> Result<(), Task> {
        use std::sync::atomic::Ordering;
        if self.spawned.fetch_add(1, Ordering::SeqCst) >= self.helpers {
            self.spawned.fetch_sub(1, Ordering::SeqCst);
            return Err(task);
        }
        struct Ended(Arc<std::sync::atomic::AtomicUsize>);
        impl Drop for Ended {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let ended = Ended(self.spawned.clone());
        self.engine.spawn(move |_| {
            let _ended = ended;
            task()
        });
        Ok(())
    }

    fn cancelled(&self) -> bool {
        (self.cancel)()
    }

    fn lost(&self) -> bool {
        self.engine.workers_lost() != self.lost_before
    }

    fn mark(&self, phase: &'static str) {
        self.marks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((phase, self.engine.now()));
    }

    fn run(&self, tasks: Vec<Task>) -> Result<(), Failed> {
        let jobs: Vec<styk_formats::files::Job> = tasks.into_iter().map(|task| Box::new(move |_: &dyn Fn() -> bool| task()) as styk_formats::files::Job).collect();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // The workers that hold a task of the open already (the skeleton's checksum) are not asked again.
        let helpers = self.helpers.saturating_sub(self.spawned.load(std::sync::atomic::Ordering::SeqCst));
        self.engine.run_together(jobs, &stop, self.cancel, helpers).map_err(|_| Failed)
    }
}

/// The phases the readers marked, as the time from the start of the open to each.
fn steps(fan: &OpenFanout<'_>, began: f64) -> Vec<(&'static str, f64)> {
    fan.marks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().map(|(phase, at)| (*phase, at - began)).collect()
}

/// A file's document, what kind of file it was, its version and the name it is shown under. A native file's skeleton checksum is left
/// to `check`, to be asked for before the document is believed.
fn read_file(bytes: &[u8], name: &str, cancel: &dyn Fn() -> bool, fan: &OpenFanout<'_>, check: &mut Option<styk_formats::container::Deferred>) -> Result<Read, OpenError> {
    let extension = extension(name).to_ascii_lowercase();
    match extension.as_str() {
        "piv" | "stk" => {
            let decoded = styk_piv::decode_document_with(bytes, name, cancel, fan).map_err(OpenError::from_codec)?;
            Ok((decoded.document, decoded.kind, decoded.version, decoded.filename, decoded.source))
        }
        other => {
            let Some(kind) = styk_formats::Kind::from_extension(other) else {
                return Err(OpenError::decode("Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file."));
            };
            // The skeleton's checksum is checked beside the rest of the open: see [`styk_formats::container::decode_deferred`].
            let (document, deferred) = styk_formats::files::open_document_deferred(bytes, kind, fan).map_err(OpenError::from_file)?;
            *check = Some(deferred);
            let version = document.get("version").and_then(Value::as_f64).unwrap_or(5.0);
            Ok((document, kind.name(), version, name.to_string(), None))
        }
    }
}

/// A file read: its document, what kind of file it was, its version, the name it is shown under, and what a Pivot project says of its file.
type Read = (Value, &'static str, f64, String, Option<styk_piv::SourceFacts>);

/// `_stykSource` without the file, in the order the codec wrote it: kind, version, the file's SHA-256, the document's, and the version of that digest.
fn describe_source(facts: &styk_piv::SourceFacts, document_sha256: String) -> styk_doc::Obj {
    let mut description = styk_doc::Obj::new();
    description.set("kind", Value::str("piv"));
    description.set("version", Value::Num(f64::from(facts.version)));
    description.set("sha256", Value::str(&facts.sha256));
    description.set("document_sha256", Value::str(&document_sha256));
    description.set("document_digest_version", Value::Num(3.0));
    description
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
        self.open_document_with(source, options, cancel, 0)
    }

    /// [`Engine::open_document`] with up to `helpers` of the engine's other workers reading, checking and converting the
    /// document's records beside this thread. The document is the same whatever `helpers` is; so is the refusal.
    pub fn open_document_with(&self, source: OpenSource<'_>, options: OpenOptions, cancel: &dyn Fn() -> bool, helpers: usize) -> Result<OpenedDocument, OpenError> {
        let fan = OpenFanout { engine: self, cancel, helpers, lost_before: self.workers_lost(), marks: Default::default(), spawned: Default::default() };
        let began = self.now();
        fan.mark("started");
        // The open allocates in pieces nothing can refuse: it starts only when the memory can hold all of it.
        // The open allocates in pieces nothing can refuse: it starts only when the memory can hold all of it.
        let _memory = reserve_for_open(&source, cancel)?;

        let mut check = None;
        let (document, kind, version, name, facts) = match source {
            OpenSource::File { bytes, name } => read_file(bytes, name, cancel, &fan, &mut check)?,
            OpenSource::Owned { bytes, name } => match extension(name).to_ascii_lowercase().as_str() {
                "piv" | "stk" => {
                    let decoded = styk_piv::decode_document_owned(bytes, name, cancel, &fan).map_err(OpenError::from_codec)?;
                    (decoded.document, decoded.kind, decoded.version, decoded.filename, decoded.source)
                }
                other => match styk_formats::Kind::from_extension(other) {
                    Some(kind) => {
                        // The file is let go once the container is unpacked, before the skeleton is read into a tree.
                        let (document, deferred) = styk_formats::files::open_document_deferred_owned(bytes, kind, &fan).map_err(OpenError::from_file)?;
                        check = Some(deferred);
                        let version = document.get("version").and_then(Value::as_f64).unwrap_or(5.0);
                        (document, kind.name(), version, name.to_string(), None)
                    }
                    None => read_file(&bytes, name, cancel, &fan, &mut check)?,
                },
            },
            OpenSource::Tree { document, name } => {
                // Copied only now that the open holds the memory it asked for: the copy is as large as the text of the document.
                let document = document.unshared();
                let version = document.get("version").and_then(Value::as_f64).unwrap_or(5.0);
                (document, "json", version, name.to_string(), None)
            }
            OpenSource::Json { bytes, name } => {
                let document = styk_doc::json::parse(bytes).map_err(|_| OpenError::unreadable())?;
                let version = document.get("version").and_then(Value::as_f64).unwrap_or(5.0);
                (document, "json", version, name.to_string(), None)
            }
        };
        let decoded = self.now();
        // A Pivot project's fingerprint (what the codec records of the document read from the file) is computed on a helper while the
        // document is prepared: it holds the document as it was read, and the preparation copies what it changes.
        let fingerprint = facts.map(|facts| {
            let document = document.clone();
            (facts, styk_doc::fanout::start(&fan, move || styk_piv::source_digest(&document).map_err(|error| error.message)))
        });
        let opened = self.prepare_opened(document, kind, version, name, options, cancel, &fan);
        let prepared = self.now();
        let source = match (fingerprint, &opened) {
            (Some((facts, digest)), Ok(_)) => match digest.wait(&fan) {
                Ok(Ok(document_sha256)) => Some(describe_source(&facts, document_sha256)),
                Ok(Err(message)) => return Err(OpenError::decode(message)),
                Err(_) => return Err(OpenError::worker_lost()),
            },
            _ => None,
        };
        let original_first = source.is_some();
        // A skeleton that does not match its checksum is the file's error, whatever became of the document read from it. A stopped
        // open does not wait for the check.
        match check {
            Some(check) if !opened.as_ref().is_err_and(|error| error.code.as_deref() == Some("cancelled")) => {
                check.finish(&fan).map_err(|error| OpenError::from_file(styk_formats::files::FileError::from(error)))?;
                if cancel() {
                    return Err(OpenError::cancelled());
                }
                opened.map(|mut opened| {
                    opened.source = source;
                    opened.original_first = original_first;
                    opened.timings.insert(0, ("decode", decoded - began));
                    opened.timings.push(("check", self.now() - prepared));
                    opened.timings.extend(steps(&fan, began));
                    opened
                })
            }
            _ => opened.map(|mut opened| {
                opened.source = source;
                opened.original_first = original_first;
                opened.timings.insert(0, ("decode", decoded - began));
                opened.timings.extend(steps(&fan, began));
                opened
            }),
        }
    }

    /// The tail of an open: the document read, normalized and made into typed views.
    #[allow(clippy::too_many_arguments)]
    fn prepare_opened(&self, document: Value, kind: &'static str, version: f64, name: String, options: OpenOptions, cancel: &dyn Fn() -> bool, fan: &OpenFanout<'_>) -> Result<OpenedDocument, OpenError> {
        if cancel() {
            return Err(OpenError::cancelled());
        }
        let started = self.now();
        let mut indexes = styk_edit::load::prepare_for_editor_with(document, options.layer_timeline, fan).map_err(OpenError::from_edit)?;
        let prepared = self.now();
        if cancel() {
            return Err(OpenError::cancelled());
        }
        let tree = std::mem::replace(&mut indexes.report, Value::Null);
        let shown = tree.path(&["_styk", "name"]).and_then(Value::as_str).unwrap_or("").to_string();
        let mut loader = Loader::new();
        let converted = loader.document_with(&tree, &shown, fan).map_err(|error| {
            // A load that was stopped, or whose worker was lost, says so rather than what it found on the way.
            if cancel() {
                OpenError::cancelled()
            } else if fan.lost() {
                OpenError::worker_lost()
            } else {
                OpenError { stage: OpenStage::Prepare, ..OpenError::decode(error.to_string()) }
            }
        })?;
        if cancel() {
            return Err(OpenError::cancelled());
        }
        let assets = Arc::new(Assets::build(&converted));
        let prepared_views = Arc::new(Prepared::new(Arc::new(converted)));
        let lineage = self.inner.next_generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let views = self.now() - prepared;
        let prepare = prepared - started;
        Ok(OpenedDocument { tree: tree.clone(), indexes, name, kind, version, typed: Typed { tree, loader, prepared: prepared_views, assets, lineage }, source: None, original_first: false, timings: vec![("prepare", prepare), ("views", views)] })
    }

    /// Makes the document that `typed` belongs to the engine's document, at `revision`, with `tree` as it
    /// is now: the stage draws it, playback and exports read it. What changed in `tree` since `typed` was made
    /// is converted again; nothing else is.
    pub fn activate(&self, typed: &Typed, tree: &Value, revision: u64) -> Result<Committed, OpenError> {
        let mut store = styk_doc::lock::spinning(&self.inner.store);
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
        let store = styk_doc::lock::spinning(&self.inner.store);
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
        let store = styk_doc::lock::spinning(&self.inner.store);
        store.tree.same_node(tree).then(|| store.prepared.clone()).flatten()
    }

    fn publish_locked(&self, mut store: std::sync::MutexGuard<'_, crate::store::Store>, tree: Value, revision: u64, views: Views) -> Result<Committed, OpenError> {
        let started = self.now();
        let (prepared, assets, converted) = match views {
            Views::Same(prepared) => (prepared, store.assets.clone().expect("an activated document has its atlas"), Default::default()),
            Views::Made(prepared) => {
                let quiet = self.pictures_settled();
                let assets = Arc::new(match &store.assets {
                    Some(previous) => previous.extended_inheriting(&prepared.doc, quiet),
                    None => Assets::build(&prepared.doc),
                });
                (prepared, assets, Default::default())
            }
            Views::Convert => {
                let name = tree.path(&["_styk", "name"]).and_then(Value::as_str).unwrap_or("").to_string();
                let document = store.loader.document(&tree, &name).map_err(|error| OpenError { stage: OpenStage::Prepare, ..OpenError::decode(error.to_string()) })?;
                let converted = store.loader.converted;
                let quiet = self.pictures_settled();
                let assets = Arc::new(match &store.assets {
                    Some(previous) => previous.extended_inheriting(&document, quiet),
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
        let mut store = styk_doc::lock::spinning(&self.inner.store);
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
        let mut store = styk_doc::lock::spinning(&self.inner.store);
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
    /// Gives the document the Pivot file it was read from, as a saved native document carries its source (`_stykSource`: the
    /// description the open made of the file, and the file itself), so that saving it needs no copy of the file anywhere else.
    pub fn attach_source(&mut self, file: Arc<[u8]>) -> Result<(), OpenError> {
        let Some(description) = &self.source else {
            return Err(OpenError::decode("The document was not read from a Pivot file."));
        };
        let mut source = description.clone();
        source.set("source_base64", Value::Blob(Arc::new(styk_doc::Blob { prefix: Arc::from(""), bytes: file })));
        let mut root = self.tree.as_obj().cloned().ok_or_else(|| OpenError::decode("The document is not an object."))?;
        root.set("_stykSource", Value::object(source));
        self.tree = Value::object(root);
        Ok(())
    }
}

#[cfg(test)]
mod inflate_tests {
    use super::inflated_size;
    use miniz_oxide::deflate::compress_to_vec_zlib;

    fn sample(length: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..length)
            .map(|at| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                // Runs and noise, so that matches reach back across the window.
                if at % 5000 < 3000 { (at % 251) as u8 } else { (state >> 24) as u8 }
            })
            .collect()
    }

    #[test]
    fn the_size_counted_is_the_size_inflated_whatever_the_level_and_the_length() {
        for length in [0, 1, 4096, 32767, 32768, 32769, 100_000, 3_000_000] {
            let data = sample(length, 7 + length as u64);
            for level in [0, 1, 6, 9] {
                let packed = compress_to_vec_zlib(&data, level);
                assert_eq!(inflated_size(&packed, &|| false), Some(length), "{length} bytes at level {level}");
            }
        }
    }

    #[test]
    fn a_payload_that_is_not_compressed_is_the_file_and_a_broken_stream_is_nothing() {
        assert_eq!(inflated_size(&[5, 1, 2, 3], &|| false), Some(4));
        let mut packed = compress_to_vec_zlib(&sample(100_000, 3), 6);
        packed.truncate(packed.len() / 2);
        assert_eq!(inflated_size(&packed, &|| false), None);
        assert_eq!(inflated_size(b"\x78\x9cnot a stream at all", &|| false), None);
    }

    #[test]
    fn counting_stops_when_the_open_is_cancelled() {
        let packed = compress_to_vec_zlib(&sample(5_000_000, 11), 0);
        let asked = std::cell::Cell::new(0);
        assert_eq!(inflated_size(&packed, &|| { asked.set(asked.get() + 1); asked.get() > 2 }), None);
        assert!(asked.get() <= 3, "it looked every megabyte and stopped at once");
    }
}
