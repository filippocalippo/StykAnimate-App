//! StykAnimate native containers (`.styk`, `.stkz`, `.stykmov`), versions 1 and 2
//! (see docs/native-file-format.md). Sections are inflated and checksummed in
//! parallel. Version-2 markers (`S2B`, `S2S`, `S2D`, `S2E`) are *not*
//! materialized into JSON: the loader resolves the ones it uses straight from
//! section bytes into typed arrays or raw image bytes.

use std::io::Read;
use std::sync::Arc;

use base64::Engine;
use rayon::prelude::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::Error;

const HEADER: usize = 56;
const SECTION: usize = 64;
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_SKELETON: usize = 384 * 1024 * 1024;

fn damaged(message: &str) -> Error {
    Error::Format(format!("The StykAnimate file is damaged: {message}"))
}

pub struct Section {
    pub kind: u8,
    pub bytes: Vec<u8>,
}

pub struct Container {
    pub json: Value,
    pub sections: Vec<Section>,
    pub version: u8,
}

fn unpack(codec: u8, stored: &[u8], raw: usize) -> Result<Vec<u8>, Error> {
    let out = match codec {
        0 => stored.to_vec(),
        1 => {
            let mut out = Vec::with_capacity(raw);
            flate2::read::ZlibDecoder::new(stored)
                .take(raw as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|e| damaged(&format!("invalid compressed data ({e})")))?;
            out
        }
        2 => zstd::bulk::decompress(stored, raw).map_err(|e| damaged(&format!("invalid zstd data ({e})")))?,
        _ => return Err(Error::Unsupported("Unsupported StykAnimate compression".into())),
    };
    if out.len() != raw {
        return Err(damaged("invalid payload length"));
    }
    Ok(out)
}

fn check(bytes: &[u8], digest: &[u8]) -> Result<(), Error> {
    if Sha256::digest(bytes).as_slice() != digest {
        return Err(damaged("checksum mismatch"));
    }
    Ok(())
}

pub fn decode(bytes: &[u8], kind: &str) -> Result<Container, Error> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::Format("The file exceeds the size limit".into()));
    }
    let trimmed = bytes.iter().position(|b| !matches!(b, 0xef | 0xbb | 0xbf | b' ' | b'\t' | b'\r' | b'\n')).unwrap_or(0);
    if kind == "styk" && bytes.get(trimmed) == Some(&b'{') {
        let json: Value = serde_json::from_slice(&bytes[trimmed..]).map_err(|e| Error::Format(format!("Invalid project JSON: {e}")))?;
        return Ok(Container { json: unwrap_wrapper(json), sections: vec![], version: 0 });
    }
    if bytes.len() < HEADER {
        return Err(damaged("truncated header"));
    }
    let magic = match kind {
        "stkz" => b"STKZ",
        "stykmov" => b"STMV",
        _ => b"STYK",
    };
    if &bytes[0..4] != magic {
        return Err(Error::Format("The file type does not match its extension".into()));
    }
    let version = bytes[4];
    let codec = bytes[5];
    let flags = u16::from_le_bytes([bytes[6], bytes[7]]);
    if !(1..=2).contains(&version) || codec > 2 || flags != 0 || (version == 1 && codec != 1) {
        return Err(Error::Unsupported("Unsupported StykAnimate file version".into()));
    }
    let raw = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
    let stored = u64::from_le_bytes(bytes[16..24].try_into().unwrap()) as usize;
    let digest = &bytes[24..56];
    if raw == 0 || raw > if version == 2 { MAX_SKELETON } else { MAX_BYTES } || stored > MAX_BYTES {
        return Err(Error::Format("The document exceeds the size limit".into()));
    }
    if version == 1 {
        if HEADER + stored != bytes.len() {
            return Err(damaged("truncated or trailing data"));
        }
        let payload = unpack(codec, &bytes[HEADER..], raw)?;
        check(&payload, digest)?;
        let json: Value = serde_json::from_slice(&payload).map_err(|e| Error::Format(format!("Invalid project JSON: {e}")))?;
        return Ok(Container { json: unwrap_wrapper(json), sections: vec![], version: 1 });
    }
    if bytes.len() < HEADER + 4 {
        return Err(damaged("truncated header"));
    }
    let count = u32::from_le_bytes(bytes[HEADER..HEADER + 4].try_into().unwrap()) as usize;
    let skeleton_end = HEADER + 4 + stored;
    if count > 64 || skeleton_end + count * SECTION > bytes.len() {
        return Err(damaged("truncated section table"));
    }
    struct Record {
        kind: u8,
        codec: u8,
        raw: usize,
        offset: usize,
        stored: usize,
        digest: [u8; 32],
    }
    let mut records = Vec::with_capacity(count);
    let mut pos = skeleton_end + count * SECTION;
    for i in 0..count {
        let r = &bytes[skeleton_end + i * SECTION..skeleton_end + (i + 1) * SECTION];
        let (kind, codec) = (r[0], r[1]);
        let raw = u64::from_le_bytes(r[8..16].try_into().unwrap()) as usize;
        let stored = u64::from_le_bytes(r[16..24].try_into().unwrap()) as usize;
        if !(1..=2).contains(&kind) || codec > 2 || r[2..8].iter().any(|&b| b != 0) || r[56..64].iter().any(|&b| b != 0) {
            return Err(Error::Unsupported("Unsupported StykAnimate section".into()));
        }
        if raw > MAX_BYTES || stored > bytes.len() - pos || (codec == 0 && raw != stored) {
            return Err(damaged("invalid section length"));
        }
        records.push(Record { kind, codec, raw, offset: pos, stored, digest: r[24..56].try_into().unwrap() });
        pos += stored;
    }
    if pos != bytes.len() {
        return Err(damaged("trailing data"));
    }
    // Skeleton and every section inflate + verify concurrently.
    let skeleton_job = || -> Result<Value, Error> {
        let skeleton = unpack(codec, &bytes[HEADER + 4..skeleton_end], raw)?;
        check(&skeleton, digest)?;
        serde_json::from_slice(&skeleton).map_err(|e| Error::Format(format!("Invalid project JSON: {e}")))
    };
    let sections_job = || -> Result<Vec<Section>, Error> {
        records
            .par_iter()
            .map(|r| {
                let data = unpack(r.codec, &bytes[r.offset..r.offset + r.stored], r.raw)?;
                check(&data, &r.digest)?;
                Ok(Section { kind: r.kind, bytes: data })
            })
            .collect()
    };
    let (json, sections) = rayon::join(skeleton_job, sections_job);
    Ok(Container { json: unwrap_wrapper(json?), sections: sections?, version: 2 })
}

fn unwrap_wrapper(json: Value) -> Value {
    // `{format: 'stykanimate', version: 1, document: {...}}` wrapper of early saves.
    if json.get("format").and_then(Value::as_str) == Some("stykanimate")
        && let Some(Value::Object(_)) = json.get("document")
    {
        let mut json = json;
        return json["document"].take();
    }
    json
}

/// Resolves marker strings and inline values into typed data.
pub struct Resolver<'a> {
    pub sections: &'a [Section],
}

#[derive(Clone, Copy)]
enum NumType {
    U8,
    U16,
    U32,
    I32,
    F32,
    F64,
}

impl<'a> Resolver<'a> {
    pub fn new(sections: &'a [Section]) -> Self {
        Resolver { sections }
    }

    /// A numeric array, inline or `S2B:` lifted.
    pub fn numbers(&self, value: &Value) -> Option<Vec<f64>> {
        match value {
            Value::Array(items) => items.iter().map(Value::as_f64).collect(),
            Value::String(s) if s.starts_with("S2B:") => self.lifted_numbers(s),
            _ => None,
        }
    }

    fn lifted_numbers(&self, marker: &str) -> Option<Vec<f64>> {
        let mut parts = marker[4..].split(':');
        let ty = match parts.next()? {
            "u8" => NumType::U8,
            "u16" => NumType::U16,
            "u32" => NumType::U32,
            "i32" => NumType::I32,
            "f32" => NumType::F32,
            "f64" => NumType::F64,
            _ => return None,
        };
        let section: usize = parts.next()?.parse().ok()?;
        let offset: usize = parts.next()?.parse().ok()?;
        let count: usize = parts.next()?.parse().ok()?;
        let width = match ty {
            NumType::U8 => 1,
            NumType::U16 => 2,
            NumType::U32 | NumType::I32 | NumType::F32 => 4,
            NumType::F64 => 8,
        };
        let s = self.sections.get(section)?;
        if s.kind != 1 || offset % width != 0 || offset > s.bytes.len() || count > (s.bytes.len() - offset) / width {
            return None;
        }
        let b = &s.bytes[offset..offset + count * width];
        let out: Vec<f64> = match ty {
            NumType::U8 => b.iter().map(|&v| v as f64).collect(),
            NumType::U16 => b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]) as f64).collect(),
            NumType::U32 => b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap()) as f64).collect(),
            NumType::I32 => b.chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap()) as f64).collect(),
            NumType::F32 => b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap()) as f64).collect(),
            NumType::F64 => b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect(),
        };
        out.iter().all(|v| v.is_finite()).then_some(out)
    }

    /// Raw bytes behind a base64 field or a data URL (inline or lifted).
    pub fn bytes(&self, value: &Value) -> Option<Arc<[u8]>> {
        let s = value.as_str()?;
        if let Some(rest) = s.strip_prefix("S2S:") {
            return self.payload(rest.split(':').take(3));
        }
        if let Some(rest) = s.strip_prefix("S2D:") {
            return self.payload(rest.splitn(4, ':').take(3));
        }
        let s = s.strip_prefix("S2E:").unwrap_or(s);
        let encoded = match s.find(";base64,") {
            Some(i) if s.starts_with("data:") => &s[i + 8..],
            _ if s.starts_with("data:") => return None,
            _ => s,
        };
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .ok()
            .map(Arc::from)
    }

    fn payload<'s>(&self, mut parts: impl Iterator<Item = &'s str>) -> Option<Arc<[u8]>> {
        let section: usize = parts.next()?.parse().ok()?;
        let offset: usize = parts.next()?.parse().ok()?;
        let count: usize = parts.next()?.parse().ok()?;
        let s = self.sections.get(section)?;
        if s.kind != 2 || offset > s.bytes.len() || count > s.bytes.len() - offset {
            return None;
        }
        Some(Arc::from(&s.bytes[offset..offset + count]))
    }

    /// A plain string field (unescaping `S2E:`).
    pub fn string<'v>(&self, value: &'v Value) -> Option<&'v str> {
        let s = value.as_str()?;
        Some(s.strip_prefix("S2E:").unwrap_or(s))
    }
}
