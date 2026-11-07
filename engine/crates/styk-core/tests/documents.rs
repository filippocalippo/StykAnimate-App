//! Milestone 1's public seam, with real engine opens and sessions and no window.
use std::sync::Arc;

use styk_core::documents::{DocumentId, Documents, DocumentsError, MAX_OPEN_PROJECTS, PreparedDocument};
use styk_core::engine::{EditError, Value};
use styk_doc::json;
use styk_engine::{Budgets, Engine};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const CONTAINER: &[u8] = include_bytes!("../../../tests/containers/project-channels.styk");

fn engine() -> Engine { Engine::new(|| 0.0, Budgets::for_device(None)) }
fn prepared(engine: &Engine, bytes: &[u8], name: &str) -> PreparedDocument {
    PreparedDocument::open_bytes(engine, Arc::from(bytes), name, &|| false).unwrap()
}
fn install(documents: &mut Documents, prepared: PreparedDocument) -> DocumentId {
    documents.open(prepared).map_err(|(error, _)| error).unwrap()
}
fn call(documents: &mut Documents, id: DocumentId, name: &str, args: &str) -> Value {
    let args = json::parse(args.as_bytes()).unwrap();
    let args: Vec<Value> = args.elements().unwrap().iter().collect();
    documents.call(id, name, &args, &Value::Null).unwrap().result.unwrap()
}
fn root_x(documents: &Documents, id: DocumentId) -> f64 {
    documents.get(id).unwrap().frame_records().unwrap().get("objects").unwrap().item(0).unwrap().get("root_x").unwrap().as_f64().unwrap()
}

#[test]
fn open_bytes_reads_both_legacy_and_container_fixtures_without_a_second_document() {
    let engine = engine();
    let mut documents = Documents::new();
    let id = install(&mut documents, prepared(&engine, STARTUP, "Blue.STYK"));
    let document = documents.get(id).unwrap();
    assert_eq!(document.name(), "Blue");
    assert_eq!(document.source_kind(), "styk");
    assert_eq!(document.selection().unwrap().uid, Some(1));
    assert_eq!(document.selection().unwrap().uids, [1]);
    assert_eq!(document.selection().unwrap().joint, -1);
    assert!(!document.view().unwrap().dirty);
    assert_eq!(document.revision(), 1);
    assert_eq!(document.view().unwrap().history.undo, 0);
    document.with_document(|typed| {
        assert_eq!(typed.canvas, [960, 540]);
        assert_eq!(typed.fps, 24.0);
        assert_eq!(typed.figures[0].id, 1);
        assert_eq!(typed.figures[0].segments.len(), 10);
    }).unwrap();
    let figure = document.with_document(|typed| Arc::as_ptr(&typed.figures[0])).unwrap();
    assert_eq!(figure, document.with_document(|typed| Arc::as_ptr(&typed.figures[0])).unwrap());
    let frame = document.frame_records().unwrap();
    assert!(frame.same_node(&document.frame_records().unwrap()), "reads share the session's cached records");
    assert!(std::ptr::eq(document.selection().unwrap(), document.view().unwrap().selection), "selection is borrowed from its owner");
    let other = install(&mut documents, prepared(&engine, CONTAINER, "Channels.styk"));
    assert_eq!(documents.active().unwrap().id(), other);
    assert_eq!(documents.get(other).unwrap().name(), "Channels");
    assert_ne!(documents.get(other).unwrap().lineage(), documents.get(id).unwrap().lineage());
    assert!(documents.get(other).unwrap().with_document(|typed| !typed.figures.is_empty()).unwrap());
    assert!(documents.get(other).unwrap().frame_records().unwrap().get("objects").is_some());
    assert!(engine.generation().is_none(), "preparing/installing tabs does not publish a stage generation on the caller");
}

#[test]
fn commands_refusals_revision_and_undo_redo_use_the_same_owner() {
    let engine = engine();
    let mut documents = Documents::new();
    let id = install(&mut documents, prepared(&engine, STARTUP, "Blue.styk"));
    let original = json::to_string(documents.get(id).unwrap().records().unwrap());
    assert!(matches!(documents.call(id, "copySelection", &[], &Value::Null), Err(DocumentsError::ServicesRequired)), "clipboard retirement requires its worker service");
    assert_eq!(call(&mut documents, id, "setFPS", "[30]"), Value::Bool(true));
    let after = documents.get(id).unwrap();
    let revision = after.revision();
    assert!(revision > 1);
    assert!(after.view().unwrap().dirty);
    assert_eq!(after.with_document(|typed| typed.fps).unwrap(), 30.0, "views follow edits");
    let edited = json::to_string(after.records().unwrap());
    let refused = documents.call(id, "setFPS", &[Value::Num(0.0)], &Value::Null).unwrap();
    assert!(matches!(refused.result, Err(EditError::Invalid(_))));
    let unknown = documents.call(id, "noSuchCommand", &[], &Value::Null).unwrap();
    assert!(matches!(unknown.result, Err(EditError::Unported(_))));
    assert_eq!(documents.get(id).unwrap().revision(), revision);
    assert_eq!(json::to_string(documents.get(id).unwrap().records().unwrap()), edited);
    assert_eq!(documents.undo(id).unwrap().result.unwrap(), Value::Bool(true));
    assert_eq!(json::to_string(documents.get(id).unwrap().records().unwrap()), original);
    assert_eq!(documents.get(id).unwrap().with_document(|typed| typed.fps).unwrap(), 24.0);
    assert_eq!(documents.get(id).unwrap().revision(), 1);
    assert!(!documents.get(id).unwrap().view().unwrap().dirty);
    assert_eq!(documents.redo(id).unwrap().result.unwrap(), Value::Bool(true));
    assert_eq!(json::to_string(documents.get(id).unwrap().records().unwrap()), edited);
    assert_eq!(documents.get(id).unwrap().revision(), revision);
    assert_eq!(documents.get(id).unwrap().with_document(|typed| typed.fps).unwrap(), 30.0);
}

#[test]
fn gesture_samples_are_one_history_entry_and_cancel_leaves_none() {
    let engine = engine();
    let mut documents = Documents::new();
    let id = install(&mut documents, prepared(&engine, STARTUP, "Blue.styk"));
    let before = root_x(&documents, id);
    call(&mut documents, id, "beginTranslationDrag", "[]");
    call(&mut documents, id, "moveSelection", "[10,0,{\"fromStart\":true}]");
    call(&mut documents, id, "moveSelection", "[25,0,{\"fromStart\":true}]");
    assert_eq!(root_x(&documents, id), before + 25.0, "reads see the live draft before commit");
    assert_eq!(documents.get(id).unwrap().view().unwrap().history.undo, 0);
    assert!(documents.get(id).unwrap().view().unwrap().dirty);
    call(&mut documents, id, "commitDrag", "[]");
    assert_eq!(documents.get(id).unwrap().view().unwrap().history.undo, 1);
    assert_eq!(root_x(&documents, id), before + 25.0);
    documents.undo(id).unwrap().result.unwrap();
    assert_eq!(root_x(&documents, id), before);
    documents.redo(id).unwrap().result.unwrap();
    assert_eq!(root_x(&documents, id), before + 25.0);
    let revision = documents.get(id).unwrap().revision();
    call(&mut documents, id, "beginTranslationDrag", "[]");
    call(&mut documents, id, "moveSelection", "[50,0,{\"fromStart\":true}]");
    call(&mut documents, id, "cancelDrag", "[]");
    assert_eq!(root_x(&documents, id), before + 25.0);
    assert_eq!(documents.get(id).unwrap().revision(), revision);
    assert_eq!(documents.get(id).unwrap().view().unwrap().history.undo, 1);
}

#[test]
fn tabs_keep_their_sessions_and_refuse_switching_a_live_gesture() {
    let engine = engine();
    let mut documents = Documents::new();
    let first = install(&mut documents, prepared(&engine, STARTUP, "First.styk"));
    call(&mut documents, first, "setFPS", "[30]");
    call(&mut documents, first, "seek", "[3]");
    let first_selection = documents.get(first).unwrap().selection().unwrap() as *const _;
    let second = install(&mut documents, prepared(&engine, STARTUP, "Second.styk"));
    assert_ne!(first, second);
    assert_eq!(documents.get(second).unwrap().view().unwrap().history.undo, 0);
    assert_eq!(documents.call(first, "setFPS", &[Value::Num(60.0)], &Value::Null).unwrap_err(), DocumentsError::NotActive);
    assert!(documents.activate(first).unwrap());
    assert!(!documents.activate(first).unwrap());
    assert_eq!(documents.get(first).unwrap().selection().unwrap() as *const _, first_selection);
    assert_eq!(documents.get(first).unwrap().view().unwrap().tick, 3.0);
    assert_eq!(documents.get(first).unwrap().view().unwrap().history.undo, 1);
    call(&mut documents, first, "beginTranslationDrag", "[]");
    assert_eq!(documents.activate(second), Err(DocumentsError::FinishEdit));
    let ready = prepared(&engine, STARTUP, "Third.styk");
    let (error, ready) = documents.open(ready).err().unwrap();
    assert_eq!(error, DocumentsError::FinishEdit);
    call(&mut documents, first, "cancelDrag", "[]");
    let third = install(&mut documents, ready);
    assert_eq!(documents.tabs().iter().map(|tab| tab.id()).collect::<Vec<_>>(), [first, third, second]);
    documents.activate(first).unwrap();
    documents.undo(first).unwrap().result.unwrap();
    assert_eq!(documents.get(first).unwrap().with_document(|typed| typed.fps).unwrap(), 24.0);
    documents.activate(second).unwrap();
    assert_eq!(documents.undo(second).unwrap().result.unwrap(), Value::Bool(false));
}

#[test]
fn bad_and_cancelled_opens_and_the_thirteenth_tab_leave_the_owner_unchanged() {
    let engine = engine();
    let mut documents = Documents::new();
    let first = install(&mut documents, prepared(&engine, STARTUP, "First.styk"));
    call(&mut documents, first, "setFPS", "[30]");
    let before = json::to_string(documents.get(first).unwrap().records().unwrap());
    assert!(PreparedDocument::open_bytes(&engine, Arc::from(&b"broken"[..]), "Broken.styk", &|| false).is_err());
    let cancelled = PreparedDocument::open_bytes(&engine, Arc::from(STARTUP), "Cancelled.styk", &|| true).err().unwrap();
    assert_eq!(cancelled.code.as_deref(), Some("cancelled"));
    assert_eq!(documents.active().unwrap().id(), first);
    assert_eq!(json::to_string(documents.get(first).unwrap().records().unwrap()), before);
    for _ in 1..MAX_OPEN_PROJECTS { install(&mut documents, prepared(&engine, STARTUP, "Another.styk")); }
    let active = documents.active().unwrap().id();
    let (error, ready) = documents.open(prepared(&engine, STARTUP, "Thirteenth.styk")).err().unwrap();
    assert_eq!(error, DocumentsError::TabLimit);
    assert_eq!(documents.tabs().len(), 12);
    assert_eq!(documents.active().unwrap().id(), active);
    assert_eq!(documents.get(first).unwrap().view().unwrap().history.undo, 1);
    // Refused installation returns ownership, so the same prepared session is usable elsewhere.
    let mut another = Documents::new();
    let id = install(&mut another, ready);
    assert_eq!(another.get(id).unwrap().name(), "Thirteenth");
}
