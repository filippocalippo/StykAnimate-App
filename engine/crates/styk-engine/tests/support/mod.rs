//! What the tests of Pivot exports share: a fixture project padded and edited as the app opens and edits one, and the two routes an export
//! takes (the codec's request and the tree).
#![allow(dead_code)]

use std::sync::Arc;

use styk_doc::{Value, json};
use styk_edit::export::{FigureRequest, Format, Request};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::document_export::Output;
use styk_engine::{Budgets, Engine};
use styk_piv::{Codec, Limits};

pub fn clock() -> f64 {
    0.0
}

pub const APP: OpenOptions = OpenOptions { layer_timeline: true };
pub const STATE: &str = r#"{"propertyChannels":true,"layerTimeline":true,"tick":0,"frameIndex":0,"layerRevision":1,"nextFrameIdentity":2,"nextUid":2}"#;

/// The payload of a Pivot file of the fixtures, inflated.
pub fn project() -> Vec<u8> {
    let original = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-piv/tests/fixtures/modern-identities.piv")).unwrap();
    miniz_oxide::inflate::decompress_to_vec_zlib(&original).unwrap()
}

/// A Pivot file with `padding` bytes of noise after its project, stored as they are.
pub fn padded_with_noise(padding: usize) -> Vec<u8> {
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
pub fn edited(file: &[u8]) -> (Engine, u64) {
    edited_then(file, |tree| tree.clone())
}

/// `edited`, and the edited document replaced by `change` of it: the document of a person whose edits left numbers the file never had.
pub fn edited_then(file: &[u8], change: impl Fn(&Value) -> Value) -> (Engine, u64) {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let mut opened = engine.open_document(OpenSource::File { bytes: file, name: "Padded.piv" }, APP, &|| false).unwrap();
    opened.attach_source(Arc::from(file)).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let mut session = opened.start_session(STATE).unwrap();
    let answer = json::parse(session.call("setFPS", "[30]", "null").as_bytes()).unwrap();
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer}");
    engine.publish_tree(opened.lineage(), change(session.report()), session.revision()).unwrap().expect("nothing reads the document");
    (engine, session.revision())
}

pub fn request() -> Request {
    Request { format: Format::Piv, name: Some("Padded".into()), figure: FigureRequest::default() }
}

/// What the codec service makes of the request an export sends it: the status and the bytes.
pub fn through_the_service(engine: &Engine, revision: u64, limits: Limits) -> (u16, Vec<u8>) {
    let body = engine.export_document(revision, &request(), &Output::CodecRequest { format: "piv".into() }, &|| false).unwrap().bytes;
    let headers = [("Content-Type".to_string(), "application/vnd.stykanimate.export".to_string())];
    let answer = Codec::new(limits).request("POST", "/api/export", &headers, &body, &|| false);
    (answer.status, answer.body)
}

pub fn pivot(engine: &Engine, revision: u64) -> Vec<u8> {
    engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false).unwrap().bytes
}


/// \`value\` with \`change\` applied to every number of it, the numbers of packed arrays included, and \`edge\` put in the place of every
/// value of the field called \`key\` (a number or the first of a packed array).
pub fn with_numbers(value: &Value, change: &dyn Fn(f64) -> f64, key: Option<(&str, f64)>) -> Value {
    match value {
        Value::Num(n) => Value::Num(change(*n)),
        Value::Nums(numbers) => Value::nums(&numbers.iter().map(change).collect::<Vec<f64>>()),
        Value::Arr(items) => Value::Arr(Arc::new(items.iter().map(|item| with_numbers(item, change, key)).collect())),
        Value::Obj(object) => {
            let mut copy = (**object).clone();
            for (name, item) in object.iter() {
                let replaced = match (key, item) {
                    (Some((wanted, edge)), Value::Num(_)) if &**name == wanted => Value::Num(edge),
                    (Some((wanted, edge)), Value::Nums(numbers)) if &**name == wanted => {
                        let mut all = numbers.to_vec();
                        all[0] = edge;
                        Value::nums(&all)
                    }
                    _ => with_numbers(item, change, key),
                };
                copy.set(name, replaced);
            }
            Value::object(copy)
        }
        other => other.clone(),
    }
}

/// What an export of the document makes, by the codec's route (the request, parsed) and by the tree: the file or the refusal.
pub fn both_routes(engine: &Engine, revision: u64) -> (Result<Vec<u8>, String>, Result<Vec<u8>, String>) {
    // The document the export makes is the same for both; a document it refuses is refused before either route is reached.
    let service = match engine.export_document(revision, &request(), &Output::CodecRequest { format: "piv".into() }, &|| false) {
        Err(error) => Err(error.to_string()),
        Ok(request) => {
            let headers = [("Content-Type".to_string(), "application/vnd.stykanimate.export".to_string())];
            let answer = Codec::new(Limits::desktop()).request("POST", "/api/export", &headers, &request.bytes, &|| false);
            if answer.status == 200 { Ok(answer.body) } else { Err(String::from_utf8_lossy(&answer.body).into_owned()) }
        }
    };
    let tree = engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false).map(|made| made.bytes).map_err(|error| error.to_string());
    (service, tree)
}
