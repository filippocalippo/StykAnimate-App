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

use styk_doc::{Blob, Value};
use crate::Engine;
use styk_edit::EditError;
use styk_edit::export::{Hold, Projected, check_scene, fold_movieclip, prepare_project};
use styk_formats::Kind;
use styk_formats::container::{self, ContainerError};
use styk_formats::files::{self, FileError, FrameTimings, Host, Job, JobsFailed};

/// The original file of a project opened from Pivot (`_stykSource`): the codec's description of it and its bytes, which
/// the container stores first in its payload section.
pub struct Source {
    /// The record the file keeps beside the bytes (`kind`, `version`, `sha256`, …).
    pub record: Value,
    pub bytes: Vec<u8>,
}

/// What a project save writes.
pub struct ProjectRequest {
    /// A name for the save's reservation of memory, under which the interface releases it if the thread saving dies without dropping it
    /// (`styk_alloc::release_named`).
    pub reservation: Option<u64>,
    /// The name the file is saved under, which the document carries.
    pub name: Option<String>,
    /// The Pivot original of the project, when the interface holds it for the project (the document has no copy of its own).
    pub source: Option<Source>,
}

/// A container written.
#[derive(Debug)]
pub struct Written {
    pub bytes: Vec<u8>,
    /// The skeleton and both sections before compression.
    pub raw_bytes: usize,
    pub timings: SaveTimings,
}

/// Where a save's time went, by the clock the caller gave (milliseconds; zero without one).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SaveTimings {
    /// Preparing the document: folding movieclips, the checks, display aliases, pose sequences stored once (the scene check apart, which runs beside the lift).
    pub prepare_ms: f64,
    /// Lifting it into the skeleton and the two sections (beside the scene check).
    pub lift_ms: f64,
    /// The scene check, which runs beside the lift.
    pub scene_ms: f64,
    /// From the start of the lift to the end of the scene check beside it, whichever is later.
    pub stage_ms: f64,
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
}

impl Host for EngineHost<'_> {
    fn cancelled(&self) -> bool {
        (self.cancel)()
    }

    fn clock(&self) -> fn() -> f64 {
        self.clock
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
pub fn save_project(trees: &[Value], scopes: &[f64], request: ProjectRequest, host: &dyn Host) -> Result<Written, SaveError> {
    let clock = host.clock();
    let cancel = &|| host.cancelled();
    let started = clock();
    let Some(mut document) = trees.last().cloned() else { return Err(SaveError::Refused("errors.documentExportWorker.theDocumentSnapshotWasNotInitialized".into())) };
    debug_assert_eq!(scopes.len() + 1, trees.len(), "one movieclip per document it was entered from");
    let source = request.source.as_ref().map_or(0, |source| source.bytes.len());
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
    let Projected { document: mut document, scene } = projected;
    let prepared = clock();
    let reserved: Vec<Arc<[u8]>> = match request.source {
        Some(Source { record, bytes }) => {
            let bytes: Arc<[u8]> = Arc::from(bytes);
            let mut stored = record.as_obj().cloned().unwrap_or_default();
            stored.set("source_base64", Value::Blob(Arc::new(Blob { prefix: Arc::from(""), bytes: bytes.clone() })));
            let object = document.make_obj().ok_or_else(|| SaveError::Refused("errors.nativeContainer.projectDataMustBeAJsonObject".into()))?;
            object.set("_stykSource", Value::object(stored));
            vec![bytes]
        }
        None => Vec::new(),
    };
    let mut written = write(&document, Kind::Styk, &reserved, Some(scene), host)?;
    written.timings.prepare_ms = prepared - started;
    written.timings.total_ms = clock() - started;
    Ok(written)
}

/// The container of a figure file (`.stkz`, `.stykmov`) made of the document an export prepared.
pub fn save_figure_file(document: &Value, kind: Kind, host: &dyn Host) -> Result<Written, SaveError> {
    write(document, kind, &[], None, host)
}

/// Lifts `document` into the container's skeleton and sections and frames them. `scene` is the document the scene check of a project is still
/// to be run on: it runs beside the lift, on another thread where the host has one, and its error is the save's.
fn write(document: &Value, kind: Kind, reserved: &[Arc<[u8]>], scene: Option<Value>, host: &dyn Host) -> Result<Written, SaveError> {
    if host.cancelled() {
        return Err(SaveError::Cancelled);
    }
    let clock = host.clock();
    let started = clock();
    // The jobs own what they use: a worker may still be running one when this returns early.
    let stop = Arc::new(AtomicBool::new(false));
    let lifted: Arc<Mutex<Option<(Result<container::Lifted, ContainerError>, f64)>>> = Arc::new(Mutex::new(None));
    let checked: Arc<Mutex<Option<(Result<(), EditError>, f64)>>> = Arc::new(Mutex::new(None));
    let mut jobs: Vec<Job> = Vec::with_capacity(2);
    {
        let (document, reserved, lifted) = (document.clone(), reserved.to_vec(), lifted.clone());
        jobs.push(Box::new(move |stop_now| {
            let begun = clock();
            let result = container::lift_until(&document, &reserved, stop_now);
            *lifted.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((result, clock() - begun));
        }));
    }
    if let Some(scene) = scene {
        let checked = checked.clone();
        jobs.push(Box::new(move |_| {
            let begun = clock();
            let result = check_scene(&scene);
            *checked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((result, clock() - begun));
        }));
    }
    host.together(jobs, &stop).map_err(|_| ContainerError::WorkerStopped)?;
    let lifted_at = clock();
    if stop.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(SaveError::Cancelled);
    }
    let mut scene_ms = 0.0;
    if let Some((result, took)) = checked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        result?;
        scene_ms = took;
    }
    let Some((lifted_result, lift_ms)) = lifted.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() else { return Err(SaveError::Cancelled) };
    let lifted_document = lifted_result?;
    let saved = files::save(kind, Arc::new(lifted_document.skeleton), Arc::new(lifted_document.arrays), Arc::new(lifted_document.payloads), host)?;
    let timings = SaveTimings { lift_ms, scene_ms, stage_ms: lifted_at - started, frames: saved.frames, frames_ms: saved.frames_ms, assemble_ms: clock() - lifted_at - saved.frames_ms, ..SaveTimings::default() };
    Ok(Written { bytes: saved.bytes, raw_bytes: saved.stats.container_raw_bytes, timings })
}
