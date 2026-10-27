//! Native movieclip commands through the interface-thread Session (D19): the owned
//! session runs them with the implementation worker preparation uses and answers as the
//! recorded editor did. Documents with IK controllers refuse atomically, before any
//! change; native tools and worker preparation keep one owner.
use std::path::Path;
use styk_doc::{Value, json};
use styk_edit::{HistoryLimits, session::Session};
fn fixture(folder: &str, name: &str) -> Value {
    json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests").join(folder).join(format!("{name}.reference.json"))).unwrap()).unwrap()
}
fn start(reference: &Value) -> Session {
    let first = reference.get("steps").unwrap().item(0).unwrap();
    Session::start(json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap(), &json::to_string(first.get("state").unwrap())).unwrap()
}
fn call(session: &mut Session, method: &str, args: &str) -> Value {
    session.call_values(method, &json::parse(args.as_bytes()).unwrap(), &Value::Null)
}
#[test]
fn native_movie_calls_on_ik_documents_refuse_atomically_and_preserve_live_gestures() {
    let methods = ["createEmptyMovieclip", "createMovieclip", "makeMovieclipUnique", "placeMovieclip", "splitMovieclip", "breakApartMovieclip", "renameMovieclip", "restartMovieclip", "removeMovieclipRestart", "setMovieclipPlayback", "setMovieclipDrawing", "addMovieclipToNextKeyframes", "bakeMovieclip"];
    for name in ["native-ik-shown", "native-ik-future", "native-ik-source", "native-ik-asset"] {
        let reference = fixture("movieclip-admission", name);
        for method in methods {
            let mut session = start(&reference);
            let before = json::to_string(session.report());
            let refused = call(&mut session, method, "[]");
            assert_eq!(refused.get("status").and_then(Value::as_str), Some("unported"), "{name} {method}");
            assert!(refused.get("reason").and_then(Value::as_str).is_some_and(|reason| reason.contains("native movieclip edits with IK")), "{name} {method}: {refused:?}");
            assert_eq!(json::to_string(session.report()), before, "{name} {method}");
            assert_eq!(refused.get("events").unwrap().array_len(), Some(0));
        }
    }
    let reference = fixture("movieclip-admission", "native-ik-shown");
    for method in methods.into_iter().chain(["addFigure"]) {
        let mut guarded = start(&reference);
        let mut control = start(&reference);
        let original = json::to_string(guarded.report());
        for (method, args) in [("select", "[3,-1]"), ("beginTranslationDrag", "[\"Guarded movie\"]"), ("moveSelection", "[4.5,-2.25]"), ("select", "[2,-1]")] {
            assert_eq!(call(&mut guarded, method, args), call(&mut control, method, args), "{method} setup");
        }
        let before = json::to_string(guarded.report());
        let state = call(&mut control, "select", "[2,-1]").get("state").unwrap().clone();
        let refused = call(&mut guarded, method, "[4]");
        assert_eq!(refused.get("status").and_then(Value::as_str), Some("unported"), "{method}");
        assert_eq!(refused.get("state"), Some(&state), "{method} state");
        assert_eq!(refused.get("events").unwrap().array_len(), Some(0), "{method} events");
        assert_eq!(json::to_string(guarded.report()), before, "{method} report");
        for (method, args) in [("moveSelection", "[2,1]"), ("cancelDrag", "[]")] {
            assert_eq!(call(&mut guarded, method, args), call(&mut control, method, args));
        }
        assert_eq!(json::to_string(guarded.report()), original, "{method}: the gesture cancels as if the call never happened");
    }
}
/// One recorded tape through the Session, as the owner replays it: every call answers
/// `ok` (or the recorded error) with the editor's state, events and document.
fn replay(folder: &str, name: &str) {
    let reference = fixture(folder, name);
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
    let mut session = Session::start(json::parse(expected.as_bytes()).unwrap(), &json::to_string(&Value::object(state))).unwrap();
    for step in &steps[1..] {
        let recorded: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
        let method = recorded[0].as_str().unwrap();
        let answer = session.call_values(method, &Value::array(recorded[1..].to_vec()), &Value::Null);
        let label = format!("{folder}/{name} step {} ({method})", step.get("step").unwrap());
        match step.get("error").filter(|error| !error.is_null()) {
            Some(error) => {
                assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{label}: {answer:?}");
                assert_eq!(answer.get("error").and_then(Value::as_str), error.get("key").or_else(|| error.get("message")).and_then(Value::as_str), "{label}");
            }
            None => assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{label}: {answer:?}"),
        }
        assert_eq!(answer.get("state"), step.get("state"), "{label}: state");
        assert_eq!(answer.get("events"), step.get("events"), "{label}: events");
        if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
        assert_eq!(json::to_string(session.report()), expected, "{label}: document");
    }
}
#[test]
fn native_movie_tapes_replay_through_the_session_as_the_recorded_editor() {
    for name in [
        "clip-break-active-layer-native", "clip-break-native", "clip-break-presence-continuation-native", "clip-break-presence-gaps-native",
        "clip-break-presence-live-native", "clip-break-presence-native", "clip-break-presence-once-native", "clip-capture-active-anchor-native",
        "clip-capture-active-cancel-native", "clip-capture-active-layer-native", "clip-capture-active-plain-native", "clip-capture-joined-channel-uid2",
        "clip-capture-joined-channel-uid3", "clip-create-definition-native", "clip-create-joined-native", "clip-create-native", "clip-empty-native",
        "clip-native-batch-cancel", "clip-native-extended-bounds", "clip-place-legacy-native", "clip-placement-native", "clip-playback-all-native",
        "clip-playback-live-native", "clip-playback-presence-native", "clip-playback-sources-native", "clip-split-legacy-native", "clip-unique-legacy-native",
    ] { replay("edit", name); }
    // Library insertion, also around a live gesture, and the next-keyframe extension.
    for name in [
        "insert-native", "insert-native-empty", "insert-native-fraction", "insert-native-layer2", "insert-native-live", "insert-native-locked",
        "insert-native-repeat", "insert-native-saved-fraction", "insert-native-saved-layer2", "insert-native-slow", "insert-native-triple",
    ] { replay("movieclip-insertion", name); }
    for name in [
        "extend-continuations", "extend-hidden", "extend-imported", "extend-joined-live", "extend-joined", "extend-layer2",
        "extend-live-errors", "extend-locked", "extend-noop", "extend-presence",
    ] { replay("movieclip-native-extension", name); }
    for name in [
        "capacity-double-collision", "capacity-existing-key", "capacity-last-safe-fractional", "capacity-last-safe",
        "capacity-maximum-fractional", "capacity-maximum", "capacity-near-collision", "capacity-single-collision",
    ] { replay("movieclip-key-capacity", name); }
}
#[test]
fn worker_movie_insertion_matches_recorded_editor_and_stays_immutable_until_guarded_commit() {
    let reference = fixture("movieclip-insertion", "insert-native");
    let mut session = start(&reference);
    call(&mut session, "select", "[1,-1]");
    session.prepare_worker_history(HistoryLimits::default(), 0.0, || Ok(())).unwrap();
    let before = json::to_string(session.report());
    let prepared = session.prepare_worker_call_values("addFigure", &json::parse(b"[4]").unwrap(), &Value::Null, || Ok(())).unwrap();
    assert_eq!(prepared.result().get("status").and_then(Value::as_str), Some("ok"));
    let expected = reference.get("steps").unwrap().item(2).unwrap();
    assert_eq!(json::to_string(prepared.report()), expected.get("document").unwrap().as_str().unwrap());
    assert_eq!(json::to_string(session.report()), before);
    drop(prepared); // cancelled worker preparation never publishes its sources.
    assert_eq!(json::to_string(session.report()), before);
    let prepared = session.prepare_worker_call_values("addFigure", &json::parse(b"[4]").unwrap(), &Value::Null, || Ok(())).unwrap();
    let after = json::to_string(prepared.report());
    let guarded = match session.guard_worker_publication_checked(prepared, || Ok(())) { Ok(guarded) => guarded, Err((error, _)) => panic!("{error:?}") };
    let retired = guarded.commit();
    assert_eq!(json::to_string(session.report()), after);
    drop(retired); // displaced heads are retired on this worker, after publication.
}
