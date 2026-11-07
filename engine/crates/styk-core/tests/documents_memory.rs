#[global_allocator]
static ALLOCATOR: styk_alloc::Counting = styk_alloc::Counting;

use std::sync::Arc;
use styk_core::documents::{Documents, PreparedDocument};
use styk_core::engine::{Budgets, Engine, Value};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

#[test]
fn counted_native_memory_refusal_keeps_the_open_project_and_allows_a_clean_retry() {
    styk_alloc::set_limit(256 << 20);
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let prepared = PreparedDocument::open_bytes(&engine, Arc::from(STARTUP), "Current.styk", &|| false).unwrap();
    let mut documents = Documents::new();
    let id = documents.open(prepared).map_err(|(error, _)| error).unwrap();
    let before = documents.get(id).unwrap().records().clone();
    assert!(styk_alloc::live_bytes() > STARTUP.len());
    let opening = engine.clone();
    let error = std::thread::spawn(move || styk_alloc::with_limit(1, || {
        PreparedDocument::open_bytes(&opening, Arc::from(STARTUP), "Refused.styk", &|| false).err().expect("refuse before copying the decoded tree")
    })).join().unwrap();
    assert_eq!(error.code.as_deref(), Some("out_of_memory"));
    assert_eq!(documents.active().unwrap().id(), id);
    assert!(documents.active().unwrap().records().same_node(&before));
    // Allocation admission belongs to operations that reserve work; a tiny metadata edit such as
    // setFPS intentionally does not refuse just because the process is above its admission limit.
    let options = styk_doc::json::parse(br#"{"start":0,"end":1,"replace":true,"name":"Memory clip"}"#).unwrap();
    let answer = styk_alloc::with_limit(1, || documents.call(id, "createMovieclip", std::slice::from_ref(&options), &Value::Null).unwrap());
    assert_eq!(answer.result.unwrap_err().to_string(), "errors.engine.outOfMemory");
    assert!(documents.active().unwrap().records().same_node(&before));
    documents.call(id, "createMovieclip", &[options], &Value::Null).unwrap().result.unwrap();
    assert!(!documents.active().unwrap().records().same_node(&before));
    let prepared = std::thread::spawn(move || PreparedDocument::open_bytes(&engine, Arc::from(STARTUP), "Retry.styk", &|| false)).join().unwrap().unwrap();
    let retry = documents.open(prepared).map_err(|(error, _)| error).unwrap();
    assert_ne!(retry, id);
    assert!(documents.active().unwrap().frame_records().is_ok());
}
