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
        StreamEnd::Complete { .. } => {
            // The output was sized for three times the input and grows by doubling: the payload is held while the
            // document is built from it, so the spare capacity goes back to the allocator before the tree needs it.
            let mut payload = inflated.data;
            payload.shrink_to_fit();
            Ok((Cow::Owned(payload), true))
        }
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
    decode_payload(ctx, payload, source.len(), || v5::sha256_hex(source), source_path, mode)
}

/// [`decode_piv_bytes`] for a caller that has no use for the file afterwards: the file is inflated and fingerprinted first
/// and dropped before the document is built from the payload, so the two are never held with the document under construction
/// (a 39 MB file is 39 MB of the memory's high-water mark).
pub(crate) fn decode_piv_owned(ctx: &Ctx<'_>, source: Vec<u8>, source_path: &str, mode: FrameMode) -> PyResult<Decoded<'static>> {
    let source_len = source.len();
    let digest = v5::sha256_hex(&source);
    let payload = if (1..=5).contains(&source.first().copied().unwrap_or(0)) && source_len <= MAX_PAYLOAD_BYTES {
        // Stored uncompressed: the file is the payload.
        source
    } else {
        let (payload, _) = unpack_source(&source)?;
        let payload = payload.into_owned();
        drop(source);
        payload
    };
    decode_payload(ctx, Cow::Owned(payload), source_len, || digest, source_path, mode)
}

/// The report of a project file's payload, with the size and fingerprint of the file it came from.
fn decode_payload<'a>(ctx: &Ctx<'_>, payload: Cow<'a, [u8]>, source_len: usize, digest: impl FnOnce() -> String, source_path: &str, mode: FrameMode) -> PyResult<Decoded<'a>> {
    let version = Reader::new(&payload).u8()?;
    if version == 5 && mode == FrameMode::Build && ctx.fan().threads() > 1 {
        // The frames are built in pieces that share the payload; it is handed back as it was.
        let Cow::Owned(inflated) = payload else { return decode_v5(ctx, payload, source_len, digest, source_path, mode, version) };
        ctx.fan().mark("inflated");
        let shared = std::sync::Arc::new(inflated);
        let sharing = ctx.sharing(shared.clone());
        let mut decoded = v5::decode(&sharing, &shared, source_len, source_path, mode)?;
        drop(sharing);
        ctx.fan().mark("frames built");
        if let Some(object) = decoded.report.make_obj() {
            object.set("source_sha256", text(&digest()));
        }
        let payload = std::sync::Arc::try_unwrap(shared).unwrap_or_else(|shared| (*shared).clone());
        return Ok(Decoded { report: decoded.report, version, payload: Cow::Owned(payload) });
    }
    if version != 5 {
        let mut report = legacy::decode_legacy_payload(ctx, &payload, source_path)?;
        if let Some(object) = report.make_obj() {
            if !object.contains("source_size") {
                object.set("source_size", crate::ctx::int(source_len));
            }
            if !object.contains("payload_size") {
                object.set("payload_size", crate::ctx::int(payload.len()));
            }
            object.set("source_sha256", text(&digest()));
        }
        return Ok(Decoded { report, version, payload });
    }
    decode_v5(ctx, payload, source_len, digest, source_path, mode, version)
}

fn decode_v5<'a>(ctx: &Ctx<'_>, payload: Cow<'a, [u8]>, source_len: usize, digest: impl FnOnce() -> String, source_path: &str, mode: FrameMode, version: u8) -> PyResult<Decoded<'a>> {
    let mut decoded = v5::decode(ctx, &payload, source_len, source_path, mode)?;
    if let Some(object) = decoded.report.make_obj() {
        object.set("source_sha256", text(&digest()));
    }
    Ok(Decoded { report: decoded.report, version, payload })
}

#[cfg(test)]
mod unpack_tests {
    use super::*;

    /// The limits are the Python codec's (`codecs/piv_codec.py`, `_unpack_source`: `MAX_PAYLOAD_BYTES = 256 * 1024 * 1024`; a file longer than that is
    /// "Project exceeds size limit", a payload longer than that "Decompressed project exceeds size limit", one of exactly that length is read).
    #[test]
    fn the_size_limits_are_those_of_the_python_codec() {
        let mut payload = vec![0u8; MAX_PAYLOAD_BYTES + 1];
        payload[0] = 5;
        let message = |source: &[u8]| unpack_source(source).err().map(|error| error.msg.clone());
        let exact = crate::zlib::compress(&payload[..MAX_PAYLOAD_BYTES]);
        assert!(exact.len() < 1 << 20, "a payload of zeros is small once compressed");
        let (read, was_compressed) = unpack_source(&exact).expect("a payload of exactly the limit is read");
        assert!(was_compressed && read.len() == MAX_PAYLOAD_BYTES);
        drop(read);
        let over = crate::zlib::compress(&payload);
        assert_eq!(message(&over).as_deref(), Some("Decompressed project exceeds size limit"));
        // A file longer than the limit is refused before it is looked at, however it would inflate.
        let mut long = vec![5u8; MAX_PAYLOAD_BYTES];
        assert!(unpack_source(&long).is_ok(), "a file of exactly the limit, stored, is read");
        long.push(0);
        assert_eq!(message(&long).as_deref(), Some("Project exceeds size limit"));
    }

    /// The inflated payload is held while the document is built from it: it keeps no capacity it does not use.
    #[test]
    fn the_inflated_payload_keeps_no_spare_capacity() {
        let payload: Vec<u8> = std::iter::once(5u8).chain((0..1_000_003u32).map(|n| (n * 7 % 251) as u8)).collect();
        let compressed = crate::zlib::compress(&payload);
        let (unpacked, was_compressed) = unpack_source(&compressed).unwrap();
        assert!(was_compressed);
        assert_eq!(&*unpacked, &payload[..]);
        let Cow::Owned(owned) = unpacked else { panic!("a compressed project is inflated into a buffer of its own") };
        assert_eq!(owned.capacity(), owned.len());
    }
}
