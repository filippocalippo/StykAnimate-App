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
    let mut body = styk_doc::Obj::new();
    body.set("name", Value::str(name));
    body.set("message", Value::str(message));
    if let Some(key) = key {
        body.set("messageKey", Value::str(key));
    }
    if let Some(params) = params {
        body.set("messageParams", params);
    }
    JsError::new(&json::to_string(&Value::object(body)))
}

fn refusal(error_text: DocumentExportError) -> JsError {
    match error_text {
        DocumentExportError::Cancelled | DocumentExportError::Stale => error("AbortError", &error_text.to_string(), None, None),
        DocumentExportError::Refused(message) => {
            let key = styk_edit::error_key(&message).to_string();
            error("Error", &key, Some(&key), styk_edit::error_params(&message))
        }
        DocumentExportError::Unported(feature) => error("Error", &format!("{feature} is not exported by the engine yet"), None, None),
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
