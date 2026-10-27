//! Pivot `.piv`/`.stk` files: reading them into the document store, writing
//! Pivot 5 projects, and the request service the editor talks to.
//!
//! This crate replaces the Python codec (`codecs/`, `backend/`) and its C++
//! frame scanner. The contract is `docs/engine/formats-piv.md`.

mod base64;
mod bridge;
mod ctx;
mod digest;
mod docjson;
mod error;
mod native;
mod piv;
mod py;
mod pyfmt;
mod pyjson;
mod reader;
mod service;
mod store;
mod text;
mod wire;
mod write;
mod zlib;

pub use error::CodecError;
#[cfg(feature = "containers")]
pub use native::Containers;
pub use native::{NativeDocuments, NativeError};
pub use service::{Codec, Limits, Response};
pub use wire::{CONTENT_TYPE as NATIVE_FRAMES_CONTENT_TYPE, MAGIC as NATIVE_FRAMES_MAGIC};

/// A file decoded into the document store.
#[derive(Clone, Debug)]
pub struct Decoded {
    /// The editable document: the report the Python decoder returned as JSON
    /// (same keys, same order, same values), with pose arrays packed.
    pub document: styk_doc::Value,
    /// `"piv"`, `"stk"`, `"styk"`, `"stkz"` or `"stykmov"`.
    pub kind: &'static str,
    /// The document's `version`: 2-5 for a Pivot file, 5 for a figure file.
    pub version: f64,
    /// The file name the service would report (directories and unsafe characters removed).
    pub filename: String,
}

fn cancel_ctx(cancel: &dyn Fn() -> bool) -> ctx::Ctx<'_> {
    ctx::Ctx::new(cancel)
}

/// Reads a `.piv` or `.stk` file (or, with the `containers` feature, a native
/// StykAnimate file) into a document tree, with every check an import runs.
///
/// This is what `/api/import` does before it caches and serializes: the engine
/// calls it directly when a file is opened. `cancel` is polled between frames
/// and records; once it returns `true` the call fails with `499 cancelled`.
pub fn decode_document(bytes: &[u8], filename: &str, cancel: &dyn Fn() -> bool) -> Result<Decoded, CodecError> {
    let ctx = cancel_ctx(cancel);
    let name = store::filename_only(filename)?;
    if bytes.is_empty() {
        return Err(error::api(400, "empty_file", "This file is empty.").into());
    }
    let kind = store::kind_of_name(&name);
    #[cfg(feature = "containers")]
    let native: Option<&dyn NativeDocuments> = Some(&Containers);
    #[cfg(not(feature = "containers"))]
    let native: Option<&dyn NativeDocuments> = None;
    let imported = store::decode_upload(&ctx, native, bytes, &name, &name, kind, false)?;
    let version = imported.document.get("version").and_then(styk_doc::Value::as_f64).unwrap_or(5.0);
    Ok(Decoded { document: imported.document, kind: kind.name(), version, filename: name })
}

/// Writes `document` as a Pivot 5 project.
///
/// `source` is the file the document was decoded from, when there is one: its
/// media and trailer bytes are kept, a legacy (Pivot 2-4) document is migrated
/// from it, and the result is `source` itself when nothing it stores changed.
/// Without a source the project is built from a blank scaffold.
pub fn encode_piv(document: &styk_doc::Value, source: Option<&[u8]>, cancel: &dyn Fn() -> bool) -> Result<Vec<u8>, CodecError> {
    use piv::frames::FrameMode;
    let ctx = cancel_ctx(cancel);
    bridge::validate_document(&ctx, document)?;
    let legacy_document = document.get("version").and_then(styk_doc::Value::as_f64).is_some_and(|version| version < 5.0);
    let bytes = match source {
        Some(source) if legacy_document => write::migrate::migrate_legacy_bytes(&ctx, source, Some(document))?,
        None if legacy_document => return Err(error::api(422, "missing_legacy_source", "Legacy PIV export requires its imported source.").into()),
        Some(source) => {
            let (payload, _) = piv::unpack_source(source)?;
            if matches!(payload.first(), Some(2..=4)) {
                // An upgraded document keeps its legacy source for provenance only.
                piv::decode_piv_bytes(&ctx, &payload, "", FrameMode::Build)?;
                let digest = piv::v5::sha256_hex(source);
                if document.get("source_sha256").is_some_and(|recorded| recorded.as_str() != Some(digest.as_str())) {
                    return Err(error::piv("Edited document belongs to a different original source").into());
                }
                write::full::encode_piv_project(&ctx, &bridge::scaffold(document)?, document, true)?
            } else {
                write::full::encode_piv_project(&ctx, source, document, false)?
            }
        }
        None => write::full::encode_piv_project(&ctx, &bridge::scaffold(document)?, document, true)?,
    };
    Ok(bytes)
}

/// Writes one figure of `document` as a modern `.stk` file: the figure with
/// `figure_type_id`, or the figure of the first object when `None`.
pub fn encode_stk(document: &styk_doc::Value, figure_type_id: Option<f64>, cancel: &dyn Fn() -> bool) -> Result<Vec<u8>, CodecError> {
    let ctx = cancel_ctx(cancel);
    bridge::validate_document(&ctx, document)?;
    let mut selected = document.clone();
    if let (Some(id), Some(object)) = (figure_type_id, selected.make_obj()) {
        object.set("_exportFigureTypeId", styk_doc::Value::Num(id));
    }
    Ok(bridge::export_stk(&ctx, &selected)?)
}

/// Low-level pieces exposed for the command-line tool and the parity suite.
#[doc(hidden)]
pub mod internals {
    use crate::zlib::StreamEnd;

    /// `zlib.compress(data)`.
    pub fn zlib_compress(data: &[u8]) -> Vec<u8> {
        crate::zlib::compress(data)
    }

    /// `zlib.decompressobj().decompress(data, limit)`: the output and
    /// `complete:<consumed>`, `truncated` or `limit`; or the `zlib.error` text.
    pub fn zlib_inflate(data: &[u8], limit: usize) -> Result<(Vec<u8>, String), String> {
        let inflated = crate::zlib::inflate(data, limit)?;
        let end = match inflated.end {
            StreamEnd::Complete { consumed } => format!("complete:{consumed}"),
            StreamEnd::Truncated => "truncated".to_string(),
            StreamEnd::Limit => "limit".to_string(),
        };
        Ok((inflated.data, end))
    }

    /// The document JSON writer of responses (keeps negative zero).
    pub fn write_document_json(value: &styk_doc::Value, out: &mut Vec<u8>) {
        crate::docjson::write(value, out)
    }

    /// `repr(float)`.
    pub fn float_repr(value: f64) -> String {
        crate::pyfmt::float_repr(value)
    }

    /// Stage timings of one Pivot import, in milliseconds, with the clock the caller supplies:
    /// inflate, validation-only decode, full decode into the document tree, JSON
    /// text of that tree, and the two SHA-256 passes over the source.
    pub fn profile_import(source: &[u8], clock: &dyn Fn() -> f64) -> Result<Vec<(&'static str, f64)>, crate::CodecError> {
        use crate::piv::frames::FrameMode;
        let never = || false;
        let ctx = crate::ctx::Ctx::new(&never);
        let mut stages = Vec::new();
        let mut started = clock();
        let mut mark = |name: &'static str, stages: &mut Vec<(&'static str, f64)>| {
            let now = clock();
            stages.push((name, now - started));
            started = now;
        };
        let (payload, _) = crate::piv::unpack_source(source)?;
        mark("inflate", &mut stages);
        if payload.first() == Some(&5) {
            crate::piv::v5::decode(&ctx, &payload, source.len(), "", FrameMode::Validate)?;
            mark("decode (frames validated only)", &mut stages);
            let decoded = crate::piv::v5::decode(&ctx, &payload, source.len(), "", FrameMode::Build)?;
            mark("decode into the document tree", &mut stages);
            let mut out = Vec::new();
            crate::docjson::write(&decoded.report, &mut out);
            mark("document JSON text", &mut stages);
            let bytes = out.len() as f64;
            drop(out);
            drop(decoded);
            mark("drop tree and text", &mut stages);
            stages.push(("document JSON bytes", bytes));
        }
        let _ = crate::piv::v5::sha256_hex(source);
        mark("SHA-256 of the source", &mut stages);
        Ok(stages)
    }

    /// `format(value, '.9g')`.
    pub fn format_g9(value: f64) -> String {
        let mut out = Vec::new();
        crate::pyfmt::g9_into(value, &mut out);
        String::from_utf8(out).unwrap_or_default()
    }

    /// A document number in fingerprint text.
    pub fn py_number(value: f64) -> String {
        crate::pyfmt::py_number(value)
    }

    /// CPython's `math.hypot`.
    pub fn py_hypot(x: f64, y: f64) -> f64 {
        crate::piv::side_tables::py_hypot(x, y)
    }
}
