//! What the interface's file workers ask of a native file.
//!
//! The editor's document is a JavaScript object, so a file reaches it, and leaves
//! it, in the form the document store shares with the interface (`container::lift`):
//! a JSON skeleton whose large number arrays and images are markers into two byte
//! sections. [`open`] reads a container into that form and applies the document
//! rules; [`save`] writes the skeleton and sections the interface lifted from its
//! document as a version 2 container. Both run inside the codec module of the
//! app's workers (`styk-codec-wasm`) and on the engine's save worker, and neither keeps any state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use styk_doc::json;

use crate::container::{self, ContainerError, Frame, Kind, encode_v2_with, pack_zstd};
use crate::native::{self, NativeError};

/// Why a file could not be opened or saved: the interface's message for it
/// (`errors.nativeContainer.*`), the machine code callers branch on, and the
/// file kind some messages name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileError {
    pub message_key: &'static str,
    pub code: Option<&'static str>,
    /// The `kind` parameter of the message (`stkz`, `stykmov`), where it has one.
    pub kind: Option<&'static str>,
    /// What failed and where, in English, for logs.
    pub detail: String,
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for FileError {}

impl From<ContainerError> for FileError {
    fn from(error: ContainerError) -> Self {
        FileError { message_key: error.message_key(), code: error.code(), kind: None, detail: error.to_string() }
    }
}

impl From<NativeError> for FileError {
    fn from(error: NativeError) -> Self {
        let kind = match error {
            NativeError::FigureShape(kind) | NativeError::FigureNotSelfContained(kind) => Some(kind),
            _ => None,
        };
        FileError { message_key: error.message_key(), code: error.code(), kind, detail: error.to_string() }
    }
}

/// Which document rules [`open`] applies after decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rules {
    /// Unwrap the early project wrapper, check the figure-file shape and drop fields
    /// only older builds or the browser wrote (`native::normalize_decoded`).
    pub normalize: bool,
    /// Check the embedded original source against its fingerprint (`native::verify_embedded_source`).
    /// Only meaningful with `normalize`.
    pub verify_source: bool,
}

impl Rules {
    /// The container as stored, with no document rules.
    pub const RAW: Rules = Rules { normalize: false, verify_source: false };
    /// What opening a project does.
    pub const PROJECT: Rules = Rules { normalize: true, verify_source: true };
    /// What a preview does: the document rules, without reading the embedded source.
    pub const PREVIEW: Rules = Rules { normalize: true, verify_source: false };
}

/// An opened file in the interface's form.
pub struct Opened {
    /// `0` for a plain JSON project, otherwise the container version.
    pub version: u8,
    /// An upper bound of the JSON the document stands for, as the importer reports it.
    pub materialized_bytes: usize,
    /// The skeleton's JSON text. Markers in it name ranges of `sections`; arrays and images
    /// shared in the file are shared in the skeleton: one marker names them wherever they occur.
    pub skeleton: Vec<u8>,
    /// Whether the skeleton holds markers. A plain JSON project or a version 1 file handed over
    /// as stored is the document itself, and a string in it that looks like a marker is a string.
    pub markers: bool,
    /// The sections the markers name, by the index they use.
    pub sections: Vec<Vec<u8>>,
}

/// Reads a `.styk`, `.stkz` or `.stykmov` file (or a plain JSON project) and puts
/// the document it holds in the interface's form.
///
/// A project whose document the rules leave as it is (nearly every one) is checked by a scan of its
/// skeleton and handed over as the file stores it: no tree is built, and nothing is written again.
/// A document the rules rewrite, a figure file (small, and its shape needs the tree) and one too
/// large to admit without measuring are decoded into the store and lifted from it.
pub fn open(bytes: &[u8], kind: Kind, rules: Rules) -> Result<Opened, FileError> {
    let checked = container::check(bytes, kind)?;
    if checked.within_limit && keeps_document(&checked, kind, rules)? {
        let container::Checked { parts, .. } = checked;
        let materialized_bytes = parts.skeleton.len() + 3 * parts.sections.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        return Ok(Opened { version: parts.version, materialized_bytes, skeleton: parts.skeleton, markers: parts.version >= 2, sections: parts.sections.into_iter().map(|(_, bytes)| bytes).collect() });
    }
    drop(checked);
    let decoded = container::decode(bytes, kind)?;
    let mut document = decoded.document;
    if rules.normalize {
        document = native::normalize_decoded(document, kind)?;
        if rules.verify_source {
            native::verify_embedded_source(&document)?;
        }
    }
    let lifted = container::lift(&document, &[])?;
    let materialized_bytes = lifted.skeleton.len() + 3 * (lifted.arrays.len() + lifted.payloads.len());
    Ok(Opened { version: decoded.version, materialized_bytes, skeleton: lifted.skeleton, markers: true, sections: vec![lifted.arrays, lifted.payloads] })
}

/// Reads a project file into the document store: the container, the document rules and the embedded
/// source's fingerprint, as [`open`] applies them for a project (`Rules::PROJECT`), but as a tree the
/// caller keeps rather than as the interface's lifted form.
pub fn open_document(bytes: &[u8], kind: Kind) -> Result<styk_doc::Value, FileError> {
    let decoded = container::decode(bytes, kind)?;
    let document = native::normalize_decoded(decoded.document, kind)?;
    native::verify_embedded_source(&document)?;
    Ok(document)
}

/// Whether the rules leave a checked document exactly as it is stored, verifying what they verify.
/// `false` sends it down the path that builds the document.
fn keeps_document(checked: &container::Checked, kind: Kind, rules: Rules) -> Result<bool, FileError> {
    if !rules.normalize {
        return Ok(true);
    }
    // A figure file's shape is checked on the tree; a root that is not an object is the tree's error to report.
    let (Kind::Styk, Some(members)) = (kind, &checked.members) else { return Ok(false) };
    let last = |key: &str| members.iter().rev().find(|member| member.key == key);
    if ["editable_paths", "_codec", "_stykWeb"].iter().any(|key| last(key).is_some()) {
        return Ok(false);
    }
    if let Some(format) = last("format")
        && container::member_value(checked, format)?.as_str() == Some("stykanimate")
    {
        return Ok(false);
    }
    if rules.verify_source
        && let Some(source) = last("_stykSource")
    {
        let mut document = styk_doc::Obj::new();
        document.set("_stykSource", container::member_value(checked, source)?);
        native::verify_embedded_source(&styk_doc::Value::object(document))?;
    }
    Ok(true)
}

/// A piece of a save that can run on any thread. It is handed the question "should this stop?" that is right for the thread it
/// runs on: the host's own cancel where that thread can ask it, a flag the host keeps up to date elsewhere.
pub type Job<'a> = Box<dyn FnOnce(&dyn Fn() -> bool) + Send + 'a>;

/// What a save asks of the thread and the machine it runs on. Any `Fn() -> bool` is a host that is stopped when it says so, has no
/// clock and runs jobs one after another, which is what the tools and the tests want.
pub trait Host {
    /// Whether the save is stopped. Called on the thread that runs the save.
    fn cancelled(&self) -> bool;

    /// Milliseconds, for timings; a plain function so that any thread can call it. Zero by default.
    fn clock(&self) -> fn() -> f64 {
        || 0.0
    }

    /// Runs `jobs` and returns when all of them are done: side by side where the host has threads to spare, else one after another.
    /// A host that stops (`cancelled`) sets `stop`, which the jobs on other threads see; jobs that notice it end early.
    fn together(&self, jobs: Vec<Job<'_>>, stop: &Arc<AtomicBool>) {
        one_after_another(self, jobs, stop);
    }
}

/// [`Host::together` ](Host::together) on the calling thread: each job in turn, none started once the host is stopped.
pub fn one_after_another<H: Host + ?Sized>(host: &H, jobs: Vec<Job<'_>>, stop: &Arc<AtomicBool>) {
    let asked = || {
        if !stop.load(Ordering::Relaxed) && host.cancelled() {
            stop.store(true, Ordering::Relaxed);
        }
        stop.load(Ordering::Relaxed)
    };
    for job in jobs {
        if asked() {
            return;
        }
        job(&asked);
    }
}

impl<F: Fn() -> bool> Host for F {
    fn cancelled(&self) -> bool {
        self()
    }
}

/// The skeleton and both sections before compression.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SaveStats {
    pub container_raw_bytes: usize,
}

/// What one block of a save cost (milliseconds by the host's clock; zero where it has none).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FrameTimings {
    pub raw_bytes: usize,
    pub stored_bytes: usize,
    pub hash_ms: f64,
    pub compress_ms: f64,
}

pub struct Saved {
    pub bytes: Vec<u8>,
    pub stats: SaveStats,
    /// The skeleton, the arrays section and the payloads section, in that order.
    pub frames: [FrameTimings; 3],
    /// From the first block handed to `together` to the last one done: the hashes and the frames run side by side.
    pub frames_ms: f64,
}

/// One block's results, written by the jobs that make them.
#[derive(Default)]
struct Made {
    digest: Mutex<Option<([u8; 32], f64)>>,
    stored: Mutex<Option<(Vec<u8>, f64)>>,
}

/// Writes a version 2 container of `kind` around a lifted document. A `.stkz` or
/// `.stykmov` skeleton must be the self-contained figure the file stores
/// (`native::validate_figure`). The hash of each block and its zstd frame (one `zstd::bulk::compress` call at level 3: frames made
/// any other way are other, valid frames, and an unchanged document must save to the bytes it was opened from) are independent jobs: three
/// hashes and the three frames in turn, which the `host` may run side by side. `host.cancelled()` is asked by the hashing every few megabytes and before and after
/// each frame; a save it stops fails with the code [`container::CANCELLED`] and produces nothing.
pub fn save(kind: Kind, skeleton: &[u8], arrays: &[u8], payloads: &[u8], host: &dyn Host) -> Result<Saved, FileError> {
    if kind != Kind::Styk {
        native::validate_figure(&json::parse(skeleton).map_err(ContainerError::from)?, kind)?;
    }
    let stats = SaveStats { container_raw_bytes: skeleton.len() + arrays.len() + payloads.len() };
    let clock = host.clock();
    let mut frames_ms = 0.0;
    let mut timings = [FrameTimings::default(); 3];
    let bytes = encode_v2_with(skeleton, arrays, payloads, kind, &mut |blocks| {
        let made: [Made; 3] = Default::default();
        let stop = Arc::new(AtomicBool::new(false));
        let mut jobs: Vec<Job<'_>> = Vec::with_capacity(4);
        // The largest blocks first: a host with fewer threads than jobs starts the longest ones earliest.
        let mut order = [0usize, 1, 2];
        order.sort_by_key(|&index| std::cmp::Reverse(blocks[index].len()));
        // The frames run one after another in a single job, started first because it takes longest, and the hashes run beside it. The frames are one job: `zstd::bulk::compress` needs an output buffer
        // the size of the worst case, and three of them at once would put the largest two beside the sections in the memory.
        let (blocks_ref, made_ref) = (&blocks, &made);
        jobs.push(Box::new(move |stop_now| {
            for &index in &order {
                // One call per frame, so a stop is obeyed before it and after it, not inside it.
                if stop_now() {
                    return;
                }
                let started = clock();
                let stored = pack_zstd(blocks_ref[index]);
                if stop_now() {
                    return;
                }
                *made_ref[index].stored.lock().unwrap_or_else(|p| p.into_inner()) = Some((stored, clock() - started));
            }
        }));
        for &index in &order {
            let (raw, slot) = (blocks[index], &made[index]);
            jobs.push(Box::new(move |stop_now| {
                let started = clock();
                if let Some(digest) = styk_doc::digest::sha256_until(raw, stop_now) {
                    *slot.digest.lock().unwrap_or_else(|p| p.into_inner()) = Some((digest, clock() - started));
                }
            }));
        }
        let started = clock();
        host.together(jobs, &stop);
        frames_ms = clock() - started;
        if stop.load(Ordering::Relaxed) {
            return Err(ContainerError::Cancelled);
        }
        let mut frames = Vec::with_capacity(3);
        for (index, slot) in made.into_iter().enumerate() {
            let digest = slot.digest.into_inner().unwrap_or_else(|p| p.into_inner());
            let stored = slot.stored.into_inner().unwrap_or_else(|p| p.into_inner());
            let (Some((digest, hash_ms)), Some((stored, compress_ms))) = (digest, stored) else { return Err(ContainerError::Cancelled) };
            timings[index] = FrameTimings { raw_bytes: blocks[index].len(), stored_bytes: stored.len(), hash_ms, compress_ms };
            frames.push(Frame { digest, stored });
        }
        Ok(frames.try_into().unwrap_or_else(|_| unreachable!("three blocks, three frames")))
    })
    .map_err(|error| match error {
        ContainerError::Cancelled => FileError::from(error),
        error => FileError { code: Some("document_too_large"), ..FileError::from(error) },
    })?;
    Ok(Saved { bytes, stats, frames: timings, frames_ms })
}
