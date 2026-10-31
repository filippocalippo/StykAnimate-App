//! The document of an export that is not the editable one (Pivot files, figure files), made from the document the
//! engine holds on a worker that joined it (`src/engine/engine-document-export.mjs`, `styk_engine::document_export`).
//!
//! The worker passes an address of the engine ([`crate::engine::EngineHandle::address`], consumed), the revision the
//! interface exports and the request as JSON; a function it polls for cancellation is called between the ticks of the
//! work. A failure is an error whose message is JSON: `{name, message, messageKey, messageParams}`, `name` being
//! `AbortError` for a cancelled or superseded export.

use std::cell::Cell;

use styk_doc::{Value, json};
use styk_edit::export::{FigureRequest, Format, Request};
use styk_engine::Engine;
use styk_engine::document_export::{DocumentExport as Made, DocumentExportError, Output};
use styk_engine::save::SaveError;
use wasm_bindgen::prelude::*;

/// What an export made: its bytes, once.
#[wasm_bindgen]
pub struct DocumentExport {
    made: Made,
}

#[wasm_bindgen]
impl DocumentExport {
    /// The bytes (the first call takes them).
    pub fn bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.made.bytes)
    }

    /// What the container held before compression (a container output), else the length of the bytes.
    pub fn raw_bytes(&self) -> usize {
        self.made.raw_bytes
    }

    pub fn length(&self) -> usize {
        self.made.bytes.len()
    }

    /// For a Pivot figure file: the figure type the file holds.
    pub fn figure_type_id(&self) -> Option<f64> {
        self.made.figure_type_id
    }

    /// The document holds drawing cels that Pivot cannot carry: the interface flattens them into pictures.
    pub fn drawings(&self) -> bool {
        self.made.drawings
    }
}

fn error(name: &str, message: &str, key: Option<&str>, params: Option<Value>) -> JsError {
    error_coded(name, message, key, params, None)
}

fn error_coded(name: &str, message: &str, key: Option<&str>, params: Option<Value>, code: Option<&str>) -> JsError {
    let mut body = styk_doc::Obj::new();
    body.set("name", Value::str(name));
    body.set("message", Value::str(message));
    if let Some(key) = key {
        body.set("messageKey", Value::str(key));
    }
    if let Some(params) = params {
        body.set("messageParams", params);
    }
    if let Some(code) = code {
        body.set("code", Value::str(code));
    }
    JsError::new(&json::to_string(&Value::object(body)))
}

/// A save that failed, as the error the worker raises: the message key the interface shows (with its values and the
/// container's machine code), `AbortError` for one that was stopped.
pub(crate) fn save_failure(failure: SaveError) -> JsError {
    match failure {
        SaveError::Cancelled => error("AbortError", &failure.to_string(), None, None),
        SaveError::Refused(message) => {
            let key = styk_edit::error_key(&message).to_string();
            error("Error", &key, Some(&key), styk_edit::error_params(&message))
        }
        SaveError::File(file) => {
            let params = file.kind.map(|kind| {
                let mut values = styk_doc::Obj::new();
                values.set("kind", Value::str(kind));
                Value::object(values)
            });
            error_coded("Error", &file.detail, Some(file.message_key), params, file.code)
        }
        SaveError::OutOfMemory(memory) => error_coded("Error", &memory.to_string(), Some(styk_engine::document::OUT_OF_MEMORY), None, Some("out_of_memory")),
    }
}

fn refusal(error_text: DocumentExportError) -> JsError {
    match error_text {
        DocumentExportError::Cancelled | DocumentExportError::Stale => error("AbortError", &error_text.to_string(), None, None),
        DocumentExportError::Refused(message) => {
            let key = styk_edit::error_key(&message).to_string();
            error("Error", &key, Some(&key), styk_edit::error_params(&message))
        }
        DocumentExportError::Unported(feature) => error("Error", &format!("{feature} is not exported by the engine yet"), None, None),
        DocumentExportError::Save(failure) => save_failure(failure),
    }
}

fn bad(message: &str) -> JsError {
    error("Error", message, None, None)
}

/// Makes the document the export in `request` saves, at `revision` of the document the engine at `address` holds.
/// `request` is JSON: `format` (`piv`, `stk`, `stkz`, `stykmov`), `name`, `figureTypeId`, `figureUid`, `figureUids`,
/// `tick`, and `output`: `document` (the document as JSON) or `codec` (the codec's export request body, with `sourceId`).
/// `cancel()` answers whether the export is stopped.
#[wasm_bindgen]
pub fn export_document(address: usize, revision: f64, request: &str, cancel: &js_sys::Function) -> Result<DocumentExport, JsError> {
    if address == 0 {
        return Err(bad("the engine address is missing"));
    }
    // SAFETY: `address` was produced by `EngineHandle::address` in this memory and is used once.
    let engine = unsafe { *Box::from_raw(address as *mut Engine) };
    if !revision.is_finite() || revision < 0.0 || revision.fract() != 0.0 {
        return Err(bad("the revision is not valid"));
    }
    let request = json::parse(request.as_bytes()).map_err(|why| bad(&why.to_string()))?;
    let format = request.get("format").and_then(Value::as_str).and_then(Format::parse).ok_or_else(|| bad("choose a piv, stk, stkz or stykmov export"))?;
    let number = |key: &str| request.get(key).and_then(Value::as_f64);
    let figure = FigureRequest {
        figure_type_id: number("figureTypeId"),
        figure_uid: number("figureUid"),
        figure_uids: request.get("figureUids").and_then(Value::numbers).unwrap_or_default(),
        tick: number("tick").filter(|tick| tick.is_finite()).unwrap_or(0.0),
    };
    let name = request.get("name").and_then(Value::as_str).map(str::to_string);
    let output = match request.get("output").and_then(Value::as_str) {
        Some("container") => Output::Container,
        Some("codec") => Output::CodecRequest { source_id: request.get("sourceId").and_then(Value::as_str).map(str::to_string), format: request.get("format").and_then(Value::as_str).unwrap_or("piv").to_string() },
        _ => Output::Document,
    };
    let cancelled = Cell::new(false);
    let stop = || {
        if !cancelled.get() {
            cancelled.set(cancel.call0(&JsValue::NULL).map(|answer| answer.is_truthy()).unwrap_or(true));
        }
        cancelled.get()
    };
    let made = engine.export_document(revision as u64, &Request { format, name, figure }, &output, &stop).map_err(refusal)?;
    Ok(DocumentExport { made })
}

/// The documents sessions have handed over for a save, by token: a snapshot is the session's tree at one moment (an
/// immutable copy-on-write handle, so taking one copies nothing and the session goes on editing). The registry lives in
/// the shared memory, so the worker that saves finds what the interface thread took.
static SNAPSHOTS: std::sync::Mutex<Vec<(u64, Value)>> = std::sync::Mutex::new(Vec::new());
static NEXT_SNAPSHOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Registers `tree` for [`save_project`]; the token names it until it is saved or [`release_snapshot`]d.
pub(crate) fn snapshot(tree: Value) -> f64 {
    let token = NEXT_SNAPSHOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    SNAPSHOTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((token, tree));
    token as f64
}

/// Lets go of a snapshot nobody saved (a save that was cancelled or failed before it reached the worker). Harmless when the
/// save took it.
#[wasm_bindgen]
pub fn release_snapshot(token: f64) {
    let mut held = SNAPSHOTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    held.retain(|(held_token, _)| *held_token as f64 != token);
}

/// Takes the snapshots, in the order asked; the registry keeps none of them.
fn take_snapshots(tokens: &[f64]) -> Option<Vec<Value>> {
    let mut held = SNAPSHOTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut trees = Vec::with_capacity(tokens.len());
    for token in tokens {
        let at = held.iter().position(|(held_token, _)| *held_token as f64 == *token)?;
        trees.push(held.swap_remove(at).1);
    }
    Some(trees)
}

/// Writes the `.styk` container of the project the snapshots hold (`src/engine/engine-document-export.mjs`). `request` is
/// JSON: `snapshots` (tokens of [`crate::edit::EditSession::snapshot`], outermost document first, the document in front last),
/// `scopes` (for each document but the last, the movieclip type the next one is the document of), `name`, and `source`: the
/// record of the Pivot original the interface holds for the project, whose bytes are `source`. `cancel()` answers whether the
/// save is stopped. Nothing is written anywhere: the answer is the file's bytes.
#[wasm_bindgen]
pub fn save_project(request: &str, source: Option<Vec<u8>>, cancel: &js_sys::Function) -> Result<DocumentExport, JsError> {
    let request = json::parse(request.as_bytes()).map_err(|why| bad(&why.to_string()))?;
    let numbers = |key: &str| request.get(key).and_then(Value::numbers).unwrap_or_default();
    let tokens = numbers("snapshots");
    let scopes = numbers("scopes");
    let Some(trees) = take_snapshots(&tokens) else { return Err(error("AbortError", "The document was changed or closed before it was saved.", None, None)) };
    if trees.is_empty() || scopes.len() + 1 != trees.len() {
        return Err(bad("the save names no document"));
    }
    let source = match (source, request.get("source")) {
        (Some(bytes), Some(record)) => Some(styk_engine::save::Source { record: record.clone(), bytes }),
        _ => None,
    };
    let name = request.get("name").and_then(Value::as_str).map(str::to_string);
    let cancelled = Cell::new(false);
    let stop = || {
        if !cancelled.get() {
            cancelled.set(cancel.call0(&JsValue::NULL).map(|answer| answer.is_truthy()).unwrap_or(true));
        }
        cancelled.get()
    };
    let written = styk_engine::save::save_project(&trees, &scopes, styk_engine::save::ProjectRequest { name, source }, &stop).map_err(save_failure)?;
    Ok(DocumentExport { made: Made { raw_bytes: written.raw_bytes, bytes: written.bytes, figure_type_id: None, drawings: false } })
}
