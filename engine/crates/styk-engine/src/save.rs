//! Writing StykAnimate's own files from the document the engine holds: a `.styk` project from the tree an edit session
//! holds (its movieclip scopes folded in), a `.stkz` or `.stykmov` figure file from the document an export made
//! (`document_export`). It runs on a worker that has joined the engine, never on the interface thread, and works on an
//! immutable snapshot of the copy-on-write tree: the session goes on editing meanwhile.
//!
//! The document is prepared as the save has always prepared it (`styk_edit::export::project_document`), lifted into the
//! container's skeleton and sections (`styk_formats::container::lift_until`, which makes the choices the JavaScript writer made) and
//! framed (`styk_formats::files::save`). The worker that runs it may be told to give its thread back at any moment, so the interface does not wait on it: the lift asks `cancel` every few thousand values, hashing every few megabytes and the
//! preparation between its steps, and compression (one call per frame, to keep the frames' bytes) before and after each frame. The
//! three hashes (side by side) and the three frames (in turn, to keep the memory of one frame's output buffer) run beside one another on the engine's other workers
//! (`Host::together`, `Engine::run_together`). A
//! worker found inside this function when it is told to stop finishes the frame it is on and returns `Cancelled`; it is never ended
//! inside it (`docs/engine/threading.md`, "Ending a worker").

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use styk_doc::Value;
use crate::Engine;
use styk_edit::EditError;
use styk_edit::export::{Hold, Openable, Projected, check_openable, fold_movieclip, prepare_project};
use styk_formats::Kind;
use styk_formats::container::{self, ContainerError};
use styk_formats::files::{self, FileError, FrameTimings, Host, Job, Joiner, JobsFailed};

/// What a project save writes.
pub struct ProjectRequest {
    /// A name for the save's reservation of memory, under which the interface releases it if the thread saving dies without dropping it
    /// (`styk_alloc::release_named`).
    pub reservation: Option<u64>,
    /// The name the file is saved under, which the document carries.
    pub name: Option<String>,
    /// The document was read from a Pivot file and carries its original (`_stykSource`): the save stores the original first in the payload
    /// section and its record last in the root, as a save of a project opened from Pivot has always laid them out. A document read from a
    /// project file is saved in the order it holds them in.
    pub original_first: bool,
}

/// A container written.
#[derive(Debug)]
pub struct Written {
    pub bytes: Vec<u8>,
    /// The skeleton and both sections before compression.
    pub raw_bytes: usize,
    pub timings: SaveTimings,
    /// How many things the file's document had that opening would mend, mended in what was written (zero for a document that needed nothing).
    pub repairs: usize,
    /// What opening would still refuse of what was written, where no repair mends it (the message key of the refusal): the file is written all the same.
    pub warning: Option<String>,
}

/// Where a save's time went, by the clock the caller gave (milliseconds; zero without one).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SaveTimings {
    /// Preparing the document: folding movieclips, the checks, display aliases, pose sequences stored once (the scene check apart, which runs beside the lift).
    pub prepare_ms: f64,
    /// Lifting it into the skeleton and the two sections: the elements of the biggest array in pieces side by side.
    pub lift_ms: f64,
    /// Of the lift: waiting for the pieces side by side, and stitching them together (zero when the lift was not in pieces).
    pub lift_pieces_ms: f64,
    pub lift_splice_ms: f64,
    /// The reader's check of the document (the scene, the layers, the animation and every movieclip and retained scene), which runs beside the lift
    /// and the frames (its own duration).
    pub check_ms: f64,
    /// Hashing and compressing the skeleton, the arrays section and the payloads section.
    pub frames: [FrameTimings; 3],
    /// From the first job started to the last done: the hashes beside the frames.
    pub frames_ms: f64,
    /// Putting the container together after the frames.
    pub assemble_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug)]
pub enum SaveError {
    /// The save was stopped; nothing was written.
    Cancelled,
    /// A refusal: the editor's message key (with its values after a separator), as the commands raise them.
    Refused(String),
    /// The container's own refusal (a document over its limits, a figure file that is not self-contained).
    File(FileError),
    OutOfMemory(styk_alloc::OutOfMemory),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Cancelled => f.write_str("The save was cancelled."),
            SaveError::Refused(message) => f.write_str(message),
            SaveError::File(error) => error.fmt(f),
            SaveError::OutOfMemory(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SaveError {}

impl From<EditError> for SaveError {
    fn from(error: EditError) -> Self {
        match error {
            EditError::Invalid(message) if message == styk_edit::export::CANCELLED => SaveError::Cancelled,
            EditError::Invalid(message) => SaveError::Refused(message),
            EditError::Unported(feature) => SaveError::Refused(format!("{feature} is not ported to the engine yet")),
        }
    }
}

impl From<ContainerError> for SaveError {
    fn from(error: ContainerError) -> Self {
        match error {
            ContainerError::Cancelled => SaveError::Cancelled,
            error => SaveError::File(FileError::from(error)),
        }
    }
}

impl From<FileError> for SaveError {
    fn from(error: FileError) -> Self {
        if error.code == Some(styk_formats::container::CANCELLED) { SaveError::Cancelled } else { SaveError::File(error) }
    }
}

/// What a save asks of the memory beyond the document it reads: the lifted sections (about half of what the document holds in
/// the engine, measured 167 MiB of raw container for 214 MiB live), the Pivot original twice (the copy a blob shares and the
/// payload section) and the compressed file.
fn working_bytes(source: usize) -> usize {
    (64 << 20) + styk_alloc::live_bytes() / 2 + 2 * source
}

/// The host of a save on the engine's worker: the question to the interface's cancel flag, a clock, and the engine's other workers for the
/// jobs a save can run side by side (without an engine they run one after another).
pub struct EngineHost<'a> {
    pub engine: Option<&'a Engine>,
    pub cancel: &'a dyn Fn() -> bool,
    pub clock: fn() -> f64,
    /// How many of the engine's workers the save may take (the rest stay free for the frame on show).
    pub helpers: usize,
    /// Whether one more worker, besides the helpers, may run the scene check beside the lift and the frames (the interface says so only when
    /// that still leaves a worker free for the frame on show).
    pub aside: bool,
}

impl Host for EngineHost<'_> {
    fn cancelled(&self) -> bool {
        (self.cancel)()
    }

    fn clock(&self) -> fn() -> f64 {
        self.clock
    }

    fn start<'a>(&'a self, job: Job, stop: &Arc<AtomicBool>) -> Joiner<'a> {
        match self.engine {
            // One of the engine's workers for the job, besides the ones the hashes, the frames and the pieces of the lift take, and one left
            // for the frame on show: the interface says whether the machine has the threads for that (`aside`).
            Some(engine) if self.aside => Box::new(engine.start_later(job, stop, self.cancel)),
            _ => files::start_when_waited_for(job, stop),
        }
    }

    fn threads(&self) -> usize {
        if self.engine.is_some() { self.helpers + 1 } else { 1 }
    }

    fn together(&self, jobs: Vec<Job>, stop: &Arc<AtomicBool>) -> Result<(), JobsFailed> {
        match self.engine {
            Some(engine) => engine.run_together(jobs, stop, self.cancel, self.helpers),
            None => {
                files::one_after_another(self, jobs, stop);
                Ok(())
            }
        }
    }
}

/// The container of a project: `trees` are the documents of the movieclips being edited, outermost first, then the document
/// in front; `scopes[i]` is the movieclip of `trees[i]` that `trees[i + 1]` is the document of. Each is a snapshot of a
/// session's tree. `host` is asked whether to stop between the steps, and times them.
///
/// What is written is a file opening accepts. Beside the lift runs the reader's whole check of the document (`check_openable`, on every
/// document the project holds): when opening would mend something, the document it would make is written instead and the answer says
/// how much (`Written::repairs`); when opening would refuse something no repair mends, the file is written all the same, as refusing
/// leaves the person with nothing, and the answer carries the reason (`Written::warning`).
pub fn save_project(trees: &[Value], scopes: &[f64], request: ProjectRequest, host: &dyn Host) -> Result<Written, SaveError> {
    let clock = host.clock();
    let cancel = &|| host.cancelled();
    let started = clock();
    let Some(mut document) = trees.last().cloned() else { return Err(SaveError::Refused("errors.documentExportWorker.theDocumentSnapshotWasNotInitialized".into())) };
    debug_assert_eq!(scopes.len() + 1, trees.len(), "one movieclip per document it was entered from");
    let source = if request.original_first { carried_len(&document) } else { 0 };
    let _memory = match request.reservation {
        Some(token) => styk_alloc::reserve_named(token, working_bytes(source)),
        None => styk_alloc::reserve(working_bytes(source)),
    }
    .map_err(SaveError::OutOfMemory)?;
    let hold = Hold { cancel };
    for (parent, &type_id) in trees.iter().zip(scopes).rev() {
        document = fold_movieclip(parent, type_id, &document)?;
    }
    let projected = prepare_project(&document, request.name.as_deref(), &hold)?;
    // The tree it was made from is the session's; what this save holds of it goes now.
    drop(document);
    let Projected { mut document, scene, unmet } = projected;
    let prepared = clock();
    // A project opened from Pivot carries its original in the document: it is stored where the app has always stored it.
    let original = if request.original_first { carried_source(&mut document) } else { None };
    let reserved: Vec<Arc<[u8]>> = original.iter().map(|original| original.bytes.clone()).collect();
    let (mut written, verdict) = write(&document, Kind::Styk, &reserved, Some(scene), host)?;
    match verdict {
        Some(Openable::Mended { document: mended, repairs }) => {
            // The document opening would hold is prepared as a save prepares one (its pose lists stored once) and written instead,
            // with the original last in the root as before.
            drop(document);
            let again = prepare_project(&mended, None, &hold)?;
            drop(mended);
            let mut document = again.document;
            if let Some(original) = &original {
                keep_last(&mut document, original)?;
            }
            let (mut second, _) = write(&document, Kind::Styk, &reserved, None, host)?;
            second.repairs = repairs;
            second.warning = again.unmet.as_ref().map(describe);
            second.timings.check_ms = written.timings.check_ms;
            written = second;
        }
        Some(Openable::Refused(refusal)) => written.warning = Some(describe(&refusal)),
        Some(Openable::Sound) | None => written.warning = unmet.as_ref().map(describe),
    }
    written.timings.prepare_ms = prepared - started;
    written.timings.total_ms = clock() - started;
    Ok(written)
}

/// The bytes of the Pivot original a document carries (`_stykSource`), 0 when it carries none.
fn carried_len(document: &Value) -> usize {
    match document.get("_stykSource").and_then(|source| source.get("source_base64")) {
        Some(Value::Blob(blob)) if blob.prefix.is_empty() => blob.bytes.len(),
        _ => 0,
    }
}

/// The Pivot original of a project opened from Pivot: the record the document keeps (the bytes are in it) and the bytes, which the
/// container stores first in its payload section.
struct Original {
    record: Value,
    bytes: Arc<[u8]>,
}

/// The Pivot original a document carries, made ready to be written as a save of a project whose original the interface held writes it:
/// its record is the last member of the root, and the bytes come first in the payload section (the caller reserves them). `None` when the
/// document carries no original as bytes.
fn carried_source(document: &mut Value) -> Option<Original> {
    let object = document.make_obj()?;
    let record = object.get("_stykSource")?.clone();
    let bytes = match record.get("source_base64")? {
        Value::Blob(blob) if blob.prefix.is_empty() => blob.bytes.clone(),
        _ => return None,
    };
    object.remove("_stykSource");
    object.set("_stykSource", record.clone());
    Some(Original { record, bytes })
}

/// `document` (made again from the mended one) with the original's record as the last member of its root.
fn keep_last(document: &mut Value, original: &Original) -> Result<(), SaveError> {
    let object = document.make_obj().ok_or_else(|| SaveError::Refused("errors.nativeContainer.projectDataMustBeAJsonObject".into()))?;
    object.remove("_stykSource");
    object.set("_stykSource", original.record.clone());
    Ok(())
}

/// What a refusal says, as the editor words it: the message key (with its values after a separator).
fn describe(error: &EditError) -> String {
    match error {
        EditError::Invalid(message) => message.clone(),
        EditError::Unported(feature) => format!("{feature} is not ported to the engine yet"),
    }
}

/// The container of a figure file (`.stkz`, `.stykmov`) made of the document an export prepared.
pub fn save_figure_file(document: &Value, kind: Kind, host: &dyn Host) -> Result<Written, SaveError> {
    write(document, kind, &[], None, host).map(|(written, _)| written)
}

/// Lifts `document` into the container's skeleton and sections and frames them. `scene` is the document the scene check of a project is still
/// to be run on: it runs beside the lift, on another thread where the host has one, and its error is the save's.
fn write(document: &Value, kind: Kind, reserved: &[Arc<[u8]>], scene: Option<Value>, host: &dyn Host) -> Result<(Written, Option<Openable>), SaveError> {
    if host.cancelled() {
        return Err(SaveError::Cancelled);
    }
    let clock = host.clock();
    let started = clock();
    // The jobs own what they use: a worker may still be running one when this returns early.
    // The reader's check only has to be done before the file is, and is the longest single job of the save: it starts first, on a thread the
    // host has to spare, and runs beside the lift and the frames. What it finds decides what the save writes (`save_project`).
    let stop = Arc::new(AtomicBool::new(false));
    let checked: Arc<Mutex<Option<(Openable, f64)>>> = Arc::new(Mutex::new(None));
    let joiner = scene.map(|scene| {
        let checked = checked.clone();
        let job: Job = Box::new(move |_| {
            let begun = clock();
            let verdict = check_openable(&scene);
            *checked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((verdict, clock() - begun));
        });
        host.start(job, &stop)
    });
    let (lifted, lift_times) = container::lift_together(document, reserved, host)?;
    let lifted_at = clock();
    let saved = files::save(kind, Arc::new(lifted.skeleton), Arc::new(lifted.arrays), Arc::new(lifted.payloads), host)?;
    if let Some(join) = joiner {
        join().map_err(|_| ContainerError::WorkerStopped)?;
    }
    let mut check_ms = 0.0;
    let mut verdict = None;
    if let Some((answer, took)) = checked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        verdict = Some(answer);
        check_ms = took;
    }
    let timings = SaveTimings { lift_ms: lifted_at - started, lift_pieces_ms: lift_times.pieces_ms, lift_splice_ms: lift_times.splice_ms, check_ms, frames: saved.frames, frames_ms: saved.frames_ms, assemble_ms: clock() - lifted_at - saved.frames_ms, ..SaveTimings::default() };
    Ok((Written { bytes: saved.bytes, raw_bytes: saved.stats.container_raw_bytes, timings, repairs: 0, warning: None }, verdict))
}
