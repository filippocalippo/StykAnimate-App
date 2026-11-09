//! The document of an export of the open document in a file the editable document cannot be saved as (Pivot `.piv` and
//! `.stk`, figure files `.stkz` and `.stykmov`), made from the document the engine holds. It runs on a worker that has
//! joined the engine, never on the interface thread: it waits for a publication in progress and works for as long as
//! the document is large.
//!
//! The request names the revision the interface exports; the engine must hold exactly that one (an edit made since
//! cancels the export on the interface's side, as for every export). The work is `styk_edit::export`; this module takes
//! the snapshot and writes the answer the interface sends on: the document as JSON, or the body of the codec's export
//! request with the document in it.

use std::cell::Cell;

use styk_doc::{Obj, Value};
use styk_edit::export::{Exported, Format, Hold, Request};
use styk_formats::Kind;

use crate::save::SaveError;

use crate::Engine;

/// What the interface gets back.
#[derive(Debug)]
pub struct DocumentExport {
    /// The bytes: the document as JSON, or the codec's export request body.
    pub bytes: Vec<u8>,
    pub figure_type_id: Option<f64>,
    /// The document holds drawing cels the interface still flattens into pictures.
    pub drawings: bool,
    /// What the container held before compression (`Output::Container`), else the length of `bytes`.
    pub raw_bytes: usize,
}

/// What the answer is.
#[derive(Clone, Debug, PartialEq)]
pub enum Output {
    /// The document as JSON.
    Document,
    /// The body of the codec's export request (`styk_piv::service::FRAMED_EXPORT`): four bytes of the length of the JSON
    /// `{document, format, filename, figureTypeId}` (little-endian), the JSON, and the bytes of the Pivot original the document
    /// carries (`_stykSource`), which the JSON does not hold: a base64 string of the whole file in it is a third more of the file, built
    /// and sent and parsed, and a project of 90 MB then exceeds what the codec takes in one request.
    CodecRequest { format: String },
    /// The finished Pivot file (`.piv`, `.stk`), written by the codec from the document without a request in between: the document is
    /// not written as JSON for the codec to read back, so what the file is limited by is the file (256 MiB), not twice its text.
    Pivot { format: String },
    /// The figure file's container (`.stkz`, `.stykmov`), written and checked here.
    Container,
}

#[derive(Debug)]
pub enum DocumentExportError {
    /// The engine does not hold the revision the interface exports.
    Stale,
    Cancelled,
    /// A refusal: the editor's message key (with its values after a separator), as the commands raise them.
    Refused(String),
    Unported(String),
    /// The container could not be written.
    Save(SaveError),
}

impl std::fmt::Display for DocumentExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocumentExportError::Stale => f.write_str("The engine does not hold this revision of the document."),
            DocumentExportError::Cancelled => f.write_str("The export was cancelled."),
            DocumentExportError::Refused(message) => f.write_str(message),
            DocumentExportError::Unported(feature) => write!(f, "{feature} is not exported by the engine yet"),
            DocumentExportError::Save(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for DocumentExportError {}

impl Engine {
    /// The document the export of `request` saves, at `revision`.
    pub fn export_document(&self, revision: u64, request: &Request, output: &Output, cancel: &dyn Fn() -> bool) -> Result<DocumentExport, DocumentExportError> {
        let (tree, loader, prepared) = {
            let store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let prepared = store.prepared.clone().ok_or(DocumentExportError::Stale)?;
            if store.revision != revision {
                return Err(DocumentExportError::Stale);
            }
            (store.tree.clone(), store.loader.clone(), prepared)
        };
        // A Pivot file is written from the tree by allocations nothing can refuse one by one: what the file itself takes is asked for first (the
        // original it carries and the file written), and the work then asks between its steps whether it has outgrown what the memory had
        // ([`styk_alloc::Reservation::overrun`]), so that it stops, with what it built dropped, before anything is written.
        let memory = match output {
            Output::Pivot { .. } => Some(reserve_pivot_export(&tree)?),
            _ => None,
        };
        let outgrown = Cell::new(None);
        let stop = || {
            cancel()
                || memory.as_ref().is_some_and(|memory| match memory.overrun() {
                    Some(overrun) => {
                        outgrown.set(Some(overrun));
                        true
                    }
                    None => false,
                })
        };
        // A stop that is the memory's is a refusal for lack of it, whatever stopped the step that saw it.
        let stopped = |error: DocumentExportError| match outgrown.take() {
            Some(overrun) => DocumentExportError::Save(SaveError::OutOfMemory(overrun)),
            None => error,
        };
        let Exported { mut document, figure_type_id, drawings } = styk_edit::export::export_document(&tree, &loader, &prepared, request, &Hold { cancel: &stop })
            .map_err(|error| {
                stopped(match error {
                    styk_edit::EditError::Invalid(message) if message == styk_edit::export::CANCELLED => DocumentExportError::Cancelled,
                    styk_edit::EditError::Invalid(message) => DocumentExportError::Refused(message),
                    styk_edit::EditError::Unported(feature) => DocumentExportError::Unported(feature),
                })
            })?;
        drop((tree, loader, prepared));
        if stop() {
            return Err(stopped(DocumentExportError::Cancelled));
        }
        let bytes = match output {
            Output::Document => styk_doc::json::to_string(&document).into_bytes(),
            Output::Container => {
                let kind = match request.format {
                    Format::Stkz => Kind::Stkz,
                    Format::Stykmov => Kind::Stykmov,
                    Format::Piv | Format::Stk => return Err(DocumentExportError::Refused("errors.documentExport.chooseAPivStkStykStkzOrStykmov".into())),
                };
                let written = crate::save::save_figure_file(&document, kind, &cancel).map_err(|error| match error {
                    SaveError::Cancelled => DocumentExportError::Cancelled,
                    other => DocumentExportError::Save(other),
                })?;
                return Ok(DocumentExport { bytes: written.bytes, figure_type_id, drawings, raw_bytes: written.raw_bytes });
            }
            Output::Pivot { format } => {
                let original = take_original(&mut document);
                // What the codec's route reads of the request it is sent: the document as text read back (no negative zero, no NaN, no infinity).
                let body = styk_doc::json::read_back(&codec_request(document, format, request, figure_type_id), || if stop() { Err(()) } else { Ok(()) })
                    .map_err(|()| stopped(DocumentExportError::Cancelled))?;
                let (file, _) = styk_piv::Codec::new(styk_piv::Limits::desktop()).export_tree(&body, original, &stop).map_err(|error| {
                    stopped(match error.status {
                        499 => DocumentExportError::Cancelled,
                        _ => DocumentExportError::Refused(error.message),
                    })
                })?;
                file
            }
            Output::CodecRequest { format } => {
                let original = take_original(&mut document);
                let body = codec_request(document, format, request, figure_type_id);
                let json = styk_doc::json::to_string(&body).into_bytes();
                let original: &[u8] = original.as_deref().unwrap_or(&[]);
                let mut framed = Vec::with_capacity(4 + json.len() + original.len());
                framed.extend_from_slice(&(json.len() as u32).to_le_bytes());
                framed.extend_from_slice(&json);
                drop(json);
                framed.extend_from_slice(original);
                framed
            }
        };
        Ok(DocumentExport { raw_bytes: bytes.len(), bytes, figure_type_id, drawings })
    }
}

/// The least a Pivot export reserves: a small document still needs the codec's working storage.
const PIVOT_EXPORT_MINIMUM_BYTES: usize = 64 << 20;

/// The reservation a Pivot export makes before it starts: the codec's working storage, and the original the document carries twice (the
/// file is written from it, and what is written is as large). What else the export takes depends on the document and is asked for as it is
/// taken. Refused with the message of a save that ran out of memory.
fn reserve_pivot_export(tree: &Value) -> Result<styk_alloc::Reservation, DocumentExportError> {
    let original = match tree.get("_stykSource").and_then(|record| record.get("source_base64")) {
        Some(Value::Blob(blob)) => blob.bytes.len(),
        _ => 0,
    };
    styk_alloc::reserve(PIVOT_EXPORT_MINIMUM_BYTES.saturating_add(original.saturating_mul(2))).map_err(|error| DocumentExportError::Save(SaveError::OutOfMemory(error)))
}

/// The request the codec's export route takes: the document, the format, the name and the figure type.
fn codec_request(document: Value, format: &str, request: &Request, figure_type_id: Option<f64>) -> Value {
    let mut body = Obj::new();
    body.set("document", document);
    body.set("format", Value::str(format));
    if let Some(name) = request.name.as_deref() {
        body.set("filename", Value::str(name));
    }
    if let Some(id) = figure_type_id {
        body.set("figureTypeId", Value::Num(id));
    }
    Value::object(body)
}

/// The Pivot original a document carries (`_stykSource.source_base64`, held as bytes), taken out of it.
fn take_original(document: &mut Value) -> Option<std::sync::Arc<[u8]>> {
    let record = document.make_obj()?.get_mut("_stykSource")?.make_obj()?;
    let Some(Value::Blob(blob)) = record.get("source_base64") else { return None };
    if !blob.prefix.is_empty() {
        return None;
    }
    let bytes = blob.bytes.clone();
    record.remove("source_base64");
    Some(bytes)
}

/// The format a file extension names, if the engine exports it.
pub fn format_of(name: &str) -> Option<Format> {
    Format::parse(name)
}
