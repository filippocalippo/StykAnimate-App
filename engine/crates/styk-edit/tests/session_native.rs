//! The native boundary runs today's frozen command tapes, including gesture/history transitions.
use styk_doc::{Value, json};
use styk_edit::{EditError, session::Session};

fn parse(text: &str) -> Value { json::parse(text.as_bytes()).unwrap() }

#[test]
fn native_commands_match_frozen_documents_selection_and_events() {
    let mut checked = 0;
    for name in ["gestures-sheet", "layers-sheet"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        let reference = json::parse(&std::fs::read(path).unwrap()).unwrap();
        let steps = reference.get("steps").unwrap().as_arr().unwrap();
        let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
        for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
        let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
        let mut session = Session::start(parse(&expected), &json::to_string(&Value::object(state))).unwrap();
        for step in &steps[1..] {
            let call = step.get("call").unwrap().as_arr().unwrap();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            let outcome = session.call_native(method, &call[1..], &Value::Null);
            assert!(outcome.result.is_ok(), "{name}/{method}: {:?}", outcome.result);
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
            assert_eq!(json::to_string(session.report()), expected, "{name}/{method}: exact stored document");
            assert_eq!(&Value::array(outcome.events), step.get("events").unwrap(), "{name}/{method}: events");
            let view = session.view();
            let state = step.get("state").unwrap();
            assert_eq!(Some(view.tick), state.get("tick").and_then(Value::as_f64));
            assert_eq!(Some(view.frame_index as f64), state.get("frameIndex").and_then(Value::as_f64));
            assert_eq!(view.selection.uid.map(f64::from), state.get("selectedUid").and_then(Value::as_f64));
            assert_eq!(view.selection.uids.iter().map(|uid| f64::from(*uid)).collect::<Vec<_>>(), state.get("selectedUids").unwrap().numbers().unwrap());
            assert_eq!(Some(view.selection.joint as f64), state.get("selectedJoint").and_then(Value::as_f64));
            assert_eq!(Value::Bool(view.history.undo > 0), *state.get("canUndo").unwrap());
            assert_eq!(Value::Bool(view.history.redo > 0), *state.get("canRedo").unwrap());
            assert_eq!(Some(view.undo_label), state.get("undoLabel").and_then(Value::as_str));
            assert_eq!(Some(view.redo_label), state.get("redoLabel").and_then(Value::as_str));
            assert_eq!(Value::Bool(view.dirty), *state.get("dirty").unwrap());
            checked += 1;
        }
    }
    assert!(checked >= 60, "the representative tapes must contain their commands: {checked}");
}

#[test]
fn native_answers_refusals_and_view_inputs_match_the_json_host() {
    let report = json::parse(include_bytes!("../../../tests/edit/startup.document.json")).unwrap();
    let state = r#"{"propertyChannels":true,"layerTimeline":true,"nextUid":2,"nextFrameIdentity":2}"#;
    let mut native = Session::start(report.clone(), state).unwrap();
    let mut legacy = Session::start(report, state).unwrap();
    for (method, args, view) in [
        ("select", "[1,-1]", "null"),
        ("setFPS", "[30]", "null"),
        ("setFPS", "[30]", "null"),
        ("setFPS", "[0]", "null"),
        ("noSuchCommand", "[]", "null"),
        ("copySelection", "[]", "null"),
        ("undo", "[]", "null"),
        ("redo", "[]", "null"),
        ("moveSelection", "[5,2]", r#"{"tick":0,"frameIndex":0,"selectedUid":1,"selectedUids":[1],"selectedJoint":-1,"autoKey":true}"#),
    ] {
        let old = parse(&legacy.call(method, args, view));
        let args: Vec<Value> = parse(args).elements().unwrap().iter().collect();
        let new = native.call_native(method, &args, &parse(view));
        match &new.result {
            Ok(result) => {
                assert_eq!(old.get("status").and_then(Value::as_str), Some("ok"));
                assert_eq!(Some(result), old.get("result"), "{method}");
            }
            Err(EditError::Invalid(message)) => {
                assert_eq!(old.get("status").and_then(Value::as_str), Some("error"));
                assert_eq!(old.get("error").and_then(Value::as_str), Some(styk_edit::error_key(message)));
                assert_eq!(old.get("errorParams").cloned(), styk_edit::error_params(message));
            }
            Err(EditError::Unported(message)) => {
                assert_eq!(old.get("status").and_then(Value::as_str), Some("unported"));
                assert_eq!(old.get("reason").and_then(Value::as_str), Some(message.as_str()));
            }
        }
        assert_eq!(Some(&Value::array(new.events)), old.get("events"), "{method}");
        assert_eq!(json::to_string(native.report()), json::to_string(legacy.report()), "{method}");
        assert_eq!(native.revision(), legacy.revision());
        assert_eq!(native.view().selection, legacy.view().selection);
        if method == "copySelection" {
            let (kind, data) = new.clipboard.unwrap();
            assert_eq!(old.path(&["clipboard", "kind"]).and_then(Value::as_str), Some(kind));
            assert_eq!(old.path(&["clipboard", "data"]), Some(&data));
        }
    }
}

#[test]
fn native_worker_bake_restores_all_heads_when_commit_is_refused() {
    let report = json::parse(include_bytes!("../../../tests/edit/startup.document.json")).unwrap();
    let mut session = Session::start(report, r#"{"propertyChannels":true,"layerTimeline":true,"nextUid":2,"nextFrameIdentity":2,"selectedUid":1,"selectedUids":[1],"selectedJoint":-1}"#).unwrap();
    session.call_native("createMovieclip", &[parse(r#"{"start":0,"end":4,"replace":true,"name":"Clip"}"#)], &Value::Null).result.unwrap();
    let report = session.report().clone();
    let revision = session.revision(); let history = session.view().history;
    let selection = session.view().selection.clone();
    let frame = session.frame_records().unwrap();
    let mut worker = session.into_worker();
    let mut checks = 0;
    let refused = worker.call_native_long("bakeMovieclip", &[], &Value::Null, &mut || { checks += 1; Ok(()) }, || Err(EditError::Invalid("cancelled at commit".into())));
    assert!(matches!(refused, Err(EditError::Invalid(ref error)) if error == "cancelled at commit"));
    assert!(checks > 4, "cancellation crosses the real sampling/publication path");
    let session = worker.into_session();
    assert!(session.report().same_node(&report)); assert_eq!(session.revision(), revision);
    assert_eq!(session.view().history, history); assert_eq!(session.view().selection, &selection);
    assert!(session.frame_records().unwrap().same_node(&frame));
    let mut worker = session.into_worker(); let mut checks = 0;
    let interrupted = worker.call_native_long("bakeMovieclip", &[], &Value::Null, &mut || {
        checks += 1; if checks == 5 { Err(EditError::Invalid("one-shot budget refusal".into())) } else { Ok(()) }
    }, || panic!("a one-shot refusal must not commit"));
    assert!(matches!(interrupted, Err(EditError::Invalid(ref error)) if error == "one-shot budget refusal"));
    let mut session = worker.into_session();
    assert!(session.report().same_node(&report)); assert_eq!(session.view().history, history);
    // A refused copy and invalid handoff retain the previous typed clipboard by move.
    session.call_native("copySelection", &[], &Value::Null).result.unwrap();
    let clipboard = session.clipboard("figures").unwrap();
    let bad = session.call_native("@setClipboard", &[Value::str("figures"), Value::Num(1.0)], &Value::Null);
    assert!(bad.result.is_err()); assert!(bad.retired_clipboard.is_none());
    assert_eq!(session.clipboard("figures").unwrap(), clipboard);
    session.call_native("select", &[Value::Null, Value::Num(-1.0)], &Value::Null).result.unwrap();
    let empty = session.call_native("copySelection", &[], &Value::Null);
    assert!(empty.retired_clipboard.is_none()); assert_eq!(session.clipboard("figures").unwrap(), clipboard);
}
