//! `styk open <file> [--layer-timeline]`: opens a file into the engine as the app does (decode, load normalization,
//! typed views), publishes it and starts a session, timed. Exit code 1 when the open is refused (the line says why).

use std::time::Instant;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
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
