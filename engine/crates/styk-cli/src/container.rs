//! `styk container …`: inspect and round-trip `.styk`, `.stkz` and `.stykmov` files.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use styk_doc::Value;
use styk_formats::container::{self, Kind, decode_parts};

fn kind_of(path: &str) -> Result<Kind, String> {
    let extension = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("");
    Kind::from_extension(extension).ok_or_else(|| format!("{path}: not a .styk, .stkz, .stykmov or .json file"))
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// The original Pivot source, which the app stores first in the payload section.
fn reserved_source(document: &Value) -> Vec<Arc<[u8]>> {
    match document.path(&["_stykSource", "source_base64"]) {
        Some(Value::Blob(blob)) if blob.prefix.is_empty() => vec![blob.bytes.clone()],
        _ => Vec::new(),
    }
}

/// Reads a file, writes it again and compares: the skeleton and both sections
/// must be identical, and so must the whole file when it was written with zstd.
/// Prints one JSON line. Exit code 1 when the uncompressed content differs.
pub fn roundtrip(path: &str, rest: &[String]) -> i32 {
    let run = || -> Result<(String, bool), String> {
        let kind = kind_of(path)?;
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let started = Instant::now();
        let parts = decode_parts(&bytes, kind).map_err(|e| format!("{path}: {e}"))?;
        let parts_ms = ms(started);
        let started = Instant::now();
        let decoded = container::decode(&bytes, kind).map_err(|e| format!("{path}: {e}"))?;
        let decode_ms = ms(started);
        if parts.version != 2 {
            // Older forms are read, never written: check that the JSON text survives the store.
            let text = styk_doc::json::to_string(&decoded.document);
            let reparsed = styk_doc::json::parse(text.as_bytes()).map_err(|e| e.to_string())?;
            let stable = reparsed == decoded.document;
            return Ok((format!("{{\"file\":{:?},\"version\":{},\"bytes\":{},\"decodeMs\":{decode_ms:.1},\"jsonStable\":{stable}}}", path, parts.version, bytes.len()), stable));
        }
        let started = Instant::now();
        // The app reserves the original source at the start of the payload section when it
        // saves a project whose source it still holds. Reproduce whichever layout the file has.
        let mut lifted = container::lift(&decoded.document, &reserved_source(&decoded.document)).map_err(|e| e.to_string())?;
        if lifted.payloads != parts.sections[1].1 {
            lifted = container::lift(&decoded.document, &[]).map_err(|e| e.to_string())?;
        }
        let lift_ms = ms(started);
        let started = Instant::now();
        let written = container::encode_v2(&lifted, kind).map_err(|e| e.to_string())?;
        let encode_ms = ms(started);
        let skeleton = lifted.skeleton == parts.skeleton;
        let arrays = lifted.arrays == parts.sections[0].1;
        let payloads = lifted.payloads == parts.sections[1].1;
        let file = written == bytes;
        if !skeleton && rest.iter().any(|a| a == "--dump") {
            std::fs::write("/tmp/styk-skeleton-original.json", &parts.skeleton).ok();
            std::fs::write("/tmp/styk-skeleton-written.json", &lifted.skeleton).ok();
        }
        if let Some(i) = rest.iter().position(|a| a == "--out") {
            std::fs::write(&rest[i + 1], &written).map_err(|e| e.to_string())?;
        }
        Ok((format!(
            "{{\"file\":{:?},\"version\":2,\"bytes\":{},\"written\":{},\"skeletonBytes\":{},\"arrayBytes\":{},\"payloadBytes\":{},\"unpackMs\":{parts_ms:.1},\"decodeMs\":{decode_ms:.1},\"liftMs\":{lift_ms:.1},\"encodeMs\":{encode_ms:.1},\"skeletonIdentical\":{skeleton},\"arraysIdentical\":{arrays},\"payloadsIdentical\":{payloads},\"fileIdentical\":{file},\"storeMiB\":{:.1}}}",
            path, bytes.len(), written.len(), parts.skeleton.len(), parts.sections[0].1.len(), parts.sections[1].1.len(), decoded.document.heap_bytes() as f64 / 1048576.0), skeleton && arrays && payloads))
    };
    match run() {
        Ok((line, ok)) => {
            println!("{line}");
            if ok { 0 } else { 1 }
        }
        Err(message) => {
            eprintln!("{message}");
            2
        }
    }
}

/// Writes the document of a file as the JSON `JSON.stringify` would produce.
pub fn json(path: &str, out: &str) -> i32 {
    let run = || -> Result<(), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let decoded = container::decode(&bytes, kind_of(path)?).map_err(|e| format!("{path}: {e}"))?;
        std::fs::write(out, styk_doc::json::to_string(&decoded.document)).map_err(|e| e.to_string())
    };
    match run() {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            2
        }
    }
}
