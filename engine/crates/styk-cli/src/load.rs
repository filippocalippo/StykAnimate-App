//! `styk load <file> [--layer-timeline] [--input out.json] [--output out.json] [--indexes out.json]`: decode a document
//! and run the editor's load normalization on it (`styk_edit::load`), as the editor's `prepareEditorLoad`
//! does. `--input` writes the decoded document as JSON (what the editor's load receives), `--output` the
//! normalized report and `--indexes` the indexes the editor builds from it; `--layer-timeline` gives the
//! document the layer sheet the app's editor gives it when it publishes it; `engine/tools/load-private.mjs`
//! compares them with the JavaScript's on private documents. Prints one JSON line with the timings and the
//! SHA-256 of the output. Exit code 1 when the load is refused (the line says with which message key).

use std::time::Instant;

use sha2::{Digest, Sha256};
use styk_doc::{Value, json};

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn decode(path: &str) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if path.to_ascii_lowercase().ends_with(".json") {
        return json::parse(&bytes).map_err(|e| format!("{path}: {e}"));
    }
    let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("document");
    styk_piv::decode_document(&bytes, name, &|| false).map(|decoded| decoded.document).map_err(|e| format!("{path}: {e}"))
}

pub fn load(path: &str, rest: &[String]) -> i32 {
    let option = |name: &str| rest.iter().position(|a| a == name).and_then(|at| rest.get(at + 1)).cloned();
    let run = || -> Result<(String, bool), String> {
        let started = Instant::now();
        let document = decode(path)?;
        let decode_ms = ms(started);
        if let Some(out) = option("--input") {
            std::fs::write(&out, json::to_string(&document)).map_err(|e| format!("{out}: {e}"))?;
        }
        let started = Instant::now();
        let prepared = match styk_edit::load::prepare_for_editor(document, rest.iter().any(|a| a == "--layer-timeline")) {
            Ok(prepared) => prepared,
            Err(error) => return Ok((format!("{{\"file\":{path:?},\"decodeMs\":{decode_ms:.1},\"loadMs\":{:.1},\"refused\":{:?}}}", ms(started), error.to_string()), false)),
        };
        let load_ms = ms(started);
        let started = Instant::now();
        let text = json::to_string(&prepared.report);
        let indexes = json::to_string(&prepared.indexes());
        let write_ms = ms(started);
        if let Some(out) = option("--output") {
            std::fs::write(&out, &text).map_err(|e| format!("{out}: {e}"))?;
        }
        if let Some(out) = option("--indexes") {
            std::fs::write(&out, &indexes).map_err(|e| format!("{out}: {e}"))?;
        }
        let digest: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        Ok((format!("{{\"file\":{path:?},\"decodeMs\":{decode_ms:.1},\"loadMs\":{load_ms:.1},\"serializeMs\":{write_ms:.1},\"bytes\":{},\"sha256\":\"{digest}\",\"nextFrameIdentity\":{},\"nextUid\":{}}}", text.len(), prepared.next_frame_identity, prepared.next_uid), true))
    };
    match run() {
        Ok((line, accepted)) => {
            println!("{line}");
            i32::from(!accepted)
        }
        Err(message) => {
            eprintln!("{message}");
            2
        }
    }
}

fn clock() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// `styk open <file> [--layer-timeline]`: opens a file into the engine as the app does (decode, load
/// normalization, typed views), publishes it, and prints the time each stage took as one JSON line.
pub fn open(path: &str, rest: &[String]) -> i32 {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("{path}: {error}");
            return 2;
        }
    };
    let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("document");
    let engine = styk_engine::Engine::new(clock, styk_engine::Budgets::for_device(None));
    let options = styk_engine::document::OpenOptions { layer_timeline: rest.iter().any(|a| a == "--layer-timeline") };
    let started = Instant::now();
    let opened = match engine.open_document(styk_engine::document::OpenSource::File { bytes: &bytes, name }, options, &|| false) {
        Ok(opened) => opened,
        Err(error) => {
            println!("{{\"file\":{path:?},\"error\":{}}}", error.to_json());
            return 1;
        }
    };
    let open_ms = ms(started);
    let started = Instant::now();
    if let Err(error) = engine.activate(&opened.typed, &opened.tree, 1) {
        println!("{{\"file\":{path:?},\"error\":{}}}", error.to_json());
        return 1;
    }
    let install_ms = ms(started);
    let started = Instant::now();
    let session = opened.start_session("{\"propertyChannels\":true,\"layerTimeline\":true}");
    let session_ms = ms(started);
    println!("{{\"file\":{path:?},\"openMs\":{open_ms:.1},\"installMs\":{install_ms:.1},\"sessionMs\":{session_ms:.1},\"sessionStarted\":{}}}", session.is_ok());
    0
}
