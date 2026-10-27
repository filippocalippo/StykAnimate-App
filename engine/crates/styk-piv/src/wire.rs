//! The native-frame transport (`backend/import_wire.py`).
//!
//! A validated Pivot 5 import can answer with the decoded header (definitions,
//! media, trailer facts; `keyframes` empty) followed by the file's own frame
//! table bytes, instead of a JSON object per pose. The editor rebuilds the
//! frames from those bytes. This is a transfer format, not a file format.

use std::sync::Arc;

use styk_doc::Value;

use crate::docjson;
use crate::error::{PyResult, value_error};
use crate::py;
use crate::pyjson::{self, Py};

/// `Accept` value that asks for the transport, and its response `Content-Type`.
pub const CONTENT_TYPE: &str = "application/vnd.stykanimate.piv-frames-v1";
/// First bytes of a native-frame response.
pub const MAGIC: &[u8; 8] = b"STYKPIV1";

/// The cached parts of a native-frame response: the encoded header document,
/// the frame bytes, and where they start in the payload.
pub(crate) struct WireParts {
    pub header: Vec<u8>,
    pub frames: Vec<u8>,
    pub start: usize,
}

fn number(value: Option<&Value>) -> PyResult<f64> {
    match value {
        Some(Value::Num(n)) => Ok(*n),
        Some(other) => Err(crate::error::type_error(format!("unsupported operand type(s) for -: '{}' and 'int'", py::type_name(other)))),
        None => Err(crate::error::key_error("frame_start")),
    }
}

/// `import_wire.native_frame_wire`: `None` for anything but a Pivot 5 report.
pub(crate) fn native_frame_wire(document: &Value, payload: &[u8]) -> PyResult<Option<WireParts>> {
    let is_v5 = py::get(document, "version")?.is_some_and(|v| py::eq(v, &Value::Num(5.0)));
    let standalone = py::get(document, "format")?.and_then(Value::as_str) == Some("piv_v5_standalone");
    if !is_v5 || !standalone {
        return Ok(None);
    }
    let validation = py::item(document, "validation")?;
    let start = number(Some(py::item(validation, "frame_start")?))?;
    let end = number(Some(py::item(validation, "trailer_start")?))? - 4.0;
    if !(0.0 <= start && start < end && end <= payload.len() as f64) {
        return Err(value_error("Invalid validated native frame extent"));
    }
    let (start, end) = (start as usize, end as usize);
    let mut header = document.clone();
    if let Some(object) = header.make_obj() {
        object.set("keyframes", Value::Arr(Arc::new(Vec::new())));
    }
    let mut frames = payload[start..end].to_vec();
    if let Some(recovery) = py::get(document, "piv_identity_recovery")?.filter(|r| py::truthy(r)) {
        // Only the renamed object IDs change; joins, draw order and pose bits stay the file's.
        if !py::get(recovery, "version")?.is_some_and(|v| py::eq(v, &Value::Num(1.0))) {
            return Err(value_error("Unsupported PIV identity recovery version"));
        }
        for repair in py::iter(py::item(recovery, "objects")?)?.iter() {
            let offset = number(Some(py::item(&repair, "record_offset")?))? - start as f64;
            let source_id = py::item(&repair, "source_unique_id")?;
            let fits = 0.0 <= offset && offset <= frames.len() as f64 - 4.0 && offset.fract() == 0.0;
            if !fits {
                return Err(value_error("PIV identity recovery does not match source bytes"));
            }
            let at = offset as usize;
            if !py::eq(source_id, &Value::Num(u32::from_le_bytes([frames[at], frames[at + 1], frames[at + 2], frames[at + 3]]) as f64)) {
                return Err(value_error("PIV identity recovery does not match source bytes"));
            }
            let replacement = match py::item(&repair, "unique_id")? {
                Value::Num(n) if n.fract() == 0.0 && (0.0..=4294967295.0).contains(n) => *n as u32,
                _ => return Err(crate::error::struct_error("'I' format requires 0 <= number <= 4294967295")),
            };
            frames[at..at + 4].copy_from_slice(&replacement.to_le_bytes());
        }
    }
    Ok(Some(WireParts { header: docjson::to_bytes(&header), frames, start }))
}

/// `import_wire.response_bytes`: magic, header length, `{"document":…,<metadata>}`, frame bytes.
pub(crate) fn response_bytes(parts: &WireParts, mut metadata: Vec<(&'static str, Py)>) -> Vec<u8> {
    metadata.push((
        "nativeFrames",
        Py::Dict(vec![("version", Py::Int(1)), ("sourceOffset", Py::Int(parts.start as i64)), ("byteLength", Py::Int(parts.frames.len() as i64))]),
    ));
    let wire = pyjson::to_bytes(&Py::Dict(metadata));
    let header_length = 12 + parts.header.len() + 1 + (wire.len() - 1);
    let mut out = Vec::with_capacity(12 + header_length + parts.frames.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header_length as u32).to_le_bytes());
    out.extend_from_slice(b"{\"document\":");
    out.extend_from_slice(&parts.header);
    out.push(b',');
    out.extend_from_slice(&wire[1..]);
    out.extend_from_slice(&parts.frames);
    out
}
