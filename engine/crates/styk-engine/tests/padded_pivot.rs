//! Large and padded Pivot files on the engine's own path: a very compressible file opens and gives its memory back when the document
//! is closed, and a padded file edited once is exported as a Pivot file without the codec's request in between (whose size is twice
//! the padding, as the document holds it as hex text).
use std::sync::Arc;

use styk_doc::{Value, json};
use styk_edit::export::{FigureRequest, Format, Request};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::document_export::Output;
use styk_engine::{Budgets, Engine};
use styk_piv::{Codec, Limits};

fn clock() -> f64 {
    0.0
}

const APP: OpenOptions = OpenOptions { layer_timeline: true };
const STATE: &str = r#"{"propertyChannels":true,"layerTimeline":true,"tick":0,"frameIndex":0,"layerRevision":1,"nextFrameIdentity":2,"nextUid":2}"#;

/// The payload of a Pivot file of the fixtures, inflated.
fn project() -> Vec<u8> {
    let original = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-piv/tests/fixtures/modern-identities.piv")).unwrap();
    miniz_oxide::inflate::decompress_to_vec_zlib(&original).unwrap()
}

/// A Pivot file with `padding` bytes of noise after its project, stored as they are.
fn padded_with_noise(padding: usize) -> Vec<u8> {
    let mut payload = project();
    let mut state = 0x2545_f491_4f6c_dd1du64;
    payload.extend((0..padding).map(|_| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 24) as u8
    }));
    miniz_oxide::deflate::compress_to_vec_zlib(&payload, 0)
}

/// The engine of a padded file that was opened as the app opens one (the file kept as the document's original), and edited once.
fn edited(file: &[u8]) -> (Engine, u64) {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let mut opened = engine.open_document(OpenSource::File { bytes: file, name: "Padded.piv" }, APP, &|| false).unwrap();
    opened.attach_source(Arc::from(file)).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let mut session = opened.start_session(STATE).unwrap();
    let answer = json::parse(session.call("setFPS", "[30]", "null").as_bytes()).unwrap();
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer}");
    engine.publish_tree(opened.lineage(), session.report().clone(), session.revision()).unwrap().expect("nothing reads the document");
    let revision = session.revision();
    (engine, revision)
}

fn request() -> Request {
    Request { format: Format::Piv, name: Some("Padded".into()), figure: FigureRequest::default() }
}

/// What the codec service makes of the request an export sends it: the status and the bytes.
fn through_the_service(engine: &Engine, revision: u64, limits: Limits) -> (u16, Vec<u8>) {
    let body = engine.export_document(revision, &request(), &Output::CodecRequest { format: "piv".into() }, &|| false).unwrap().bytes;
    let headers = [("Content-Type".to_string(), "application/vnd.stykanimate.export".to_string())];
    let answer = Codec::new(limits).request("POST", "/api/export", &headers, &body, &|| false);
    (answer.status, answer.body)
}

fn pivot(engine: &Engine, revision: u64) -> Vec<u8> {
    engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false).unwrap().bytes
}

#[test]
fn an_edited_padded_file_exports_the_bytes_the_codec_service_writes() {
    let file = padded_with_noise(6 << 20);
    let (engine, revision) = edited(&file);
    let (status, expected) = through_the_service(&engine, revision, Limits::desktop());
    assert_eq!(status, 200);
    assert!(expected != file, "the edit is in the file");
    let written = pivot(&engine, revision);
    assert!(written == expected, "{} bytes written, {} by the service", written.len(), expected.len());
}

#[test]
fn an_edited_padded_file_is_exported_although_its_request_exceeds_the_codec_limit() {
    // The document holds the padding as hex text: its request is twice the padding. A codec that takes 16 MiB of document refuses the
    // request of 10 MiB of padding; the export that sends no request writes what the codec writes with room for it.
    let file = padded_with_noise(10 << 20);
    let (engine, revision) = edited(&file);
    let (refused, _) = through_the_service(&engine, revision, Limits { max_document: 16 << 20, ..Limits::desktop() });
    assert_eq!(refused, 413, "the request is too large for this codec");
    let (status, expected) = through_the_service(&engine, revision, Limits::desktop());
    assert_eq!(status, 200);
    let written = pivot(&engine, revision);
    assert!(written == expected, "{} bytes written, {} by the service", written.len(), expected.len());
}

#[test]
fn a_pivot_export_that_is_cancelled_writes_nothing() {
    let (engine, revision) = edited(&padded_with_noise(1 << 20));
    let refused = engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| true);
    assert!(matches!(refused, Err(styk_engine::document_export::DocumentExportError::Cancelled)), "{refused:?}");
}

#[test]
fn a_pivot_export_the_memory_cannot_hold_is_refused_before_it_writes_anything() {
    use styk_engine::document_export::DocumentExportError;
    use styk_engine::save::SaveError;
    let file = padded_with_noise(24 << 20);
    let (engine, revision) = edited(&file);
    let expected = pivot(&engine, revision);
    // The export asks for several times what the document retains (the padding, as hex and as bytes, the original, the file written):
    // a memory of 100 MiB does not have it, and says so with the message of a save that ran out of memory.
    let refused = styk_alloc::with_limit(100 << 20, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false));
    match refused {
        Err(DocumentExportError::Save(SaveError::OutOfMemory(memory))) => assert!(memory.requested > memory.available, "{memory:?}"),
        other => panic!("expected a refusal for lack of memory, got {:?}", other.map(|made| made.bytes.len())),
    }
    // A refusal holds nothing back: with room the same export writes the same file.
    let written = styk_alloc::with_limit(3 << 30, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false)).unwrap().bytes;
    assert!(written == expected);
    // The export in the codec's request form is not asked for the memory (the browser's path reserves nothing here).
    let request_body = styk_alloc::with_limit(100 << 20, || engine.export_document(revision, &request(), &Output::CodecRequest { format: "piv".into() }, &|| false));
    assert!(request_body.is_ok());
}
