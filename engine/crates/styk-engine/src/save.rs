//! Writing StykAnimate's own files from the document the engine holds: a `.styk` project from the tree an edit session
//! holds (its movieclip scopes folded in), a `.stkz` or `.stykmov` figure file from the document an export made
//! (`document_export`). It runs on a worker that has joined the engine, never on the interface thread, and works on an
//! immutable snapshot of the copy-on-write tree: the session goes on editing meanwhile.
//!
//! The document is prepared as the save has always prepared it (`styk_edit::export::project_document`), lifted into the
//! container's skeleton and sections (`styk_formats::container::lift`, which makes the choices the JavaScript writer made) and
//! framed (`styk_formats::files::save`).

use std::sync::Arc;

use styk_doc::{Blob, Value};
use styk_edit::EditError;
use styk_edit::export::{Hold, fold_movieclip, project_document};
use styk_formats::Kind;
use styk_formats::container::{self, ContainerError};
use styk_formats::files::{self, FileError, NoStore};

/// The original file of a project opened from Pivot (`_stykSource`): the codec's description of it and its bytes, which
/// the container stores first in its payload section.
pub struct Source {
    /// The record the file keeps beside the bytes (`kind`, `version`, `sha256`, …).
    pub record: Value,
    pub bytes: Vec<u8>,
}

/// What a project save writes.
pub struct ProjectRequest {
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
        SaveError::File(FileError::from(error))
    }
}

/// What a save asks of the memory beyond the document it reads: the lifted sections (about half of what the document holds in
/// the engine, measured 167 MiB of raw container for 214 MiB live), the Pivot original twice (the copy a blob shares and the
/// payload section) and the compressed file.
fn working_bytes(source: usize) -> usize {
    (64 << 20) + styk_alloc::live_bytes() / 2 + 2 * source
}

/// The container of a project: `trees` are the documents of the movieclips being edited, outermost first, then the document
/// in front; `scopes[i]` is the movieclip of `trees[i]` that `trees[i + 1]` is the document of. Each is a snapshot of a
/// session's tree. `cancel` is asked between the steps.
pub fn save_project(trees: &[Value], scopes: &[f64], request: ProjectRequest, cancel: &dyn Fn() -> bool) -> Result<Written, SaveError> {
    let Some(mut document) = trees.last().cloned() else { return Err(SaveError::Refused("errors.documentExportWorker.theDocumentSnapshotWasNotInitialized".into())) };
    debug_assert_eq!(scopes.len() + 1, trees.len(), "one movieclip per document it was entered from");
    let source = request.source.as_ref().map_or(0, |source| source.bytes.len());
    let _memory = styk_alloc::reserve(working_bytes(source)).map_err(SaveError::OutOfMemory)?;
    let hold = Hold { cancel };
    for (parent, &type_id) in trees.iter().zip(scopes).rev() {
        document = fold_movieclip(parent, type_id, &document)?;
    }
    document = project_document(&document, request.name.as_deref(), &hold)?;
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
    write(&document, Kind::Styk, &reserved, cancel)
}

/// The container of a figure file (`.stkz`, `.stykmov`) made of the document an export prepared.
pub fn save_figure_file(document: &Value, kind: Kind, cancel: &dyn Fn() -> bool) -> Result<Written, SaveError> {
    write(document, kind, &[], cancel)
}

fn write(document: &Value, kind: Kind, reserved: &[Arc<[u8]>], cancel: &dyn Fn() -> bool) -> Result<Written, SaveError> {
    if cancel() {
        return Err(SaveError::Cancelled);
    }
    let lifted = container::lift(document, reserved)?;
    if cancel() {
        return Err(SaveError::Cancelled);
    }
    let saved = files::save(kind, &lifted.skeleton, &lifted.arrays, &lifted.payloads, &mut NoStore).map_err(SaveError::File)?;
    Ok(Written { bytes: saved.bytes, raw_bytes: saved.stats.container_raw_bytes })
}
