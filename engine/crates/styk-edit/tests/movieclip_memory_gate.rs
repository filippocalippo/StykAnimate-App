//! A movieclip too large for the host is refused before it is made, and nothing changes (`Editor::admit`, docs/engine/editing.md,
//! "Making a clip"): the host's memory gate is asked how much the clip will copy, and a refusal is an ordinary error of the call.
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use styk_doc::{Value, json};
use styk_edit::session::Session;

fn started() -> Session {
    let reference = json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/clip-create-definition-sheet.reference.json")).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap(), &json::to_string(&Value::object(state))).unwrap()
}

fn call(session: &mut Session, method: &str, args: &str) -> Value {
    session.call_values(method, &json::parse(args.as_bytes()).unwrap(), &Value::Null)
}

const CREATE: &str = r#"[{"start":2,"end":6,"replace":true,"name":"Motion"}]"#;

static ASKED: AtomicUsize = AtomicUsize::new(0);
fn records_what_is_asked(bytes: usize) -> bool {
    ASKED.store(bytes, Ordering::Relaxed);
    true
}

#[test]
fn a_clip_the_host_cannot_take_is_refused_with_nothing_changed() {
    let mut session = started();
    call(&mut session, "@select", "[1,-1]");
    let before = json::to_string(session.report());
    let depths = session.history_marks();
    session.set_memory_gate(|_| false);
    let refused = call(&mut session, "createMovieclip", CREATE);
    assert_eq!(refused.get("status").and_then(Value::as_str), Some("error"), "{refused:?}");
    assert_eq!(refused.get("error").and_then(Value::as_str), Some("errors.engine.outOfMemory"));
    assert_eq!(json::to_string(session.report()), before, "the document is as it was");
    assert_eq!(session.history_marks(), depths, "no entry was made");
    assert_eq!(refused.get("events").unwrap().array_len(), Some(0), "nothing was announced");
    // The session is alive: the same call runs once the host can take it.
    session.set_memory_gate(|_| true);
    let made = call(&mut session, "createMovieclip", CREATE);
    assert_eq!(made.get("status").and_then(Value::as_str), Some("ok"), "{made:?}");
    assert_ne!(json::to_string(session.report()), before);
    assert_eq!(session.history_marks().undo, depths.undo + 1);
}

#[test]
fn the_gate_is_asked_for_the_records_the_clip_copies() {
    let mut session = started();
    session.set_memory_gate(records_what_is_asked);
    call(&mut session, "@select", "[1,-1]");
    ASKED.store(0, Ordering::Relaxed);
    let made = call(&mut session, "createMovieclip", r#"[{"start":2,"end":6,"replace":false,"name":"Motion"}]"#);
    assert_eq!(made.get("status").and_then(Value::as_str), Some("ok"), "{made:?}");
    let one_figure = ASKED.load(Ordering::Relaxed);
    assert!(one_figure > 0, "the gate was asked");
    let everything = {
        let mut session = started();
        session.set_memory_gate(records_what_is_asked);
        ASKED.store(0, Ordering::Relaxed);
        call(&mut session, "createMovieclip", r#"[{"start":2,"end":6,"replace":false,"uids":[],"name":"All"}]"#);
        ASKED.load(Ordering::Relaxed)
    };
    assert!(everything >= one_figure, "a clip of every figure asks for at least as much as one of a figure: {everything} against {one_figure}");
}
