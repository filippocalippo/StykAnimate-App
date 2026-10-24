//! Reading Pivot projects: the container (raw or zlib), then the version's grammar.

pub(crate) mod frames;
pub(crate) mod image_stream;
pub(crate) mod legacy;
pub(crate) mod legacy_v2;
pub(crate) mod legacy_v4;
pub(crate) mod side_tables;
pub(crate) mod v5;

use std::borrow::Cow;

use styk_doc::Value;

use crate::ctx::{Ctx, text};
use crate::error::{PyResult, piv};
use crate::reader::Reader;
use crate::zlib::{StreamEnd, inflate};
use frames::FrameMode;

/// Largest decompressed project the codec reads or writes.
pub(crate) const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;

/// `piv_codec._unpack_source`: the payload of a project file and whether the
/// file was compressed. Legacy raw files begin directly with a version byte.
pub(crate) fn unpack_source(source: &[u8]) -> PyResult<(Cow<'_, [u8]>, bool)> {
    if source.is_empty() {
        return Err(piv("Empty project"));
    }
    if source.len() > MAX_PAYLOAD_BYTES {
        return Err(piv("Project exceeds size limit"));
    }
    if (1..=5).contains(&source[0]) {
        return Ok((Cow::Borrowed(source), false));
    }
    let inflated = inflate(source, MAX_PAYLOAD_BYTES + 1).map_err(|message| piv(format!("Invalid zlib project: {message}")))?;
    match inflated.end {
        StreamEnd::Limit => Err(piv("Decompressed project exceeds size limit")),
        _ if inflated.data.len() > MAX_PAYLOAD_BYTES => Err(piv("Decompressed project exceeds size limit")),
        StreamEnd::Truncated => Err(piv("Truncated compressed project")),
        StreamEnd::Complete { consumed } if consumed < source.len() => Err(piv("Unexpected bytes after compressed project")),
        StreamEnd::Complete { .. } => Ok((Cow::Owned(inflated.data), true)),
    }
}

/// The version byte of a project file's payload, read without inflating the rest of it.
pub(crate) fn payload_version(source: &[u8]) -> PyResult<u8> {
    if source.is_empty() {
        return Err(piv("Empty project"));
    }
    let first = if (1..=5).contains(&source[0]) {
        source[0]
    } else {
        let inflated = inflate(source, 1).map_err(|message| piv(format!("Invalid zlib project: {message}")))?;
        *inflated.data.first().ok_or_else(|| piv("Truncated compressed project"))?
    };
    if (2..=5).contains(&first) { Ok(first) } else { Err(piv(format!("Unsupported Pivot version {first}"))) }
}

/// A decoded project file.
pub(crate) struct Decoded<'a> {
    /// The report `piv_codec.decode_piv_bytes` returned (without the scalar-editor
    /// inventories `editable_paths` and `_codec`, which the service always dropped).
    pub report: Value,
    pub version: u8,
    /// The inflated payload (the file itself when it is stored uncompressed).
    pub payload: Cow<'a, [u8]>,
}

/// `piv_codec.decode_piv_bytes`.
///
/// `mode` only matters for version 5: legacy files always decode completely.
pub(crate) fn decode_piv_bytes<'a>(ctx: &Ctx<'_>, source: &'a [u8], source_path: &str, mode: FrameMode) -> PyResult<Decoded<'a>> {
    let (payload, _) = unpack_source(source)?;
    let version = Reader::new(&payload).u8()?;
    if version != 5 {
        let mut report = legacy::decode_legacy_payload(ctx, &payload, source_path)?;
        if let Some(object) = report.make_obj() {
            if !object.contains("source_size") {
                object.set("source_size", crate::ctx::int(source.len()));
            }
            if !object.contains("payload_size") {
                object.set("payload_size", crate::ctx::int(payload.len()));
            }
            object.set("source_sha256", text(&v5::sha256_hex(source)));
        }
        return Ok(Decoded { report, version, payload });
    }
    let mut decoded = v5::decode(ctx, &payload, source.len(), source_path, mode)?;
    if let Some(object) = decoded.report.make_obj() {
        object.set("source_sha256", text(&v5::sha256_hex(source)));
    }
    Ok(Decoded { report: decoded.report, version, payload })
}
