//! The session's JSON interface (what `src/engine/engine-owner.mjs` drives)
//! answers a recorded scenario as the editor did: state and events at every step,
//! and the published sheet in the document the editor ended with.

use std::path::Path;

use styk_doc::Value;
use styk_edit::session::Session;

fn report_sheet(step: &Value) -> Value {
    let document = styk_doc::json::parse(step.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    document.path(&["_styk", "layerSheet"]).cloned().unwrap_or(Value::Null)
}

#[test]
fn a_recording_through_the_session_interface() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/layers-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let report = styk_doc::json::parse(steps[0].get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    // The editor's options and its state after loading, in one object.
    let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
        state.set(key, value.clone());
    }
    let mut session = Session::start(report, &styk_doc::json::to_string(&Value::object(state))).unwrap();
    let json = styk_doc::json::to_string;
    let mut published = 0;
    // The sheet as the facade holds it: an answer replaces the tracks it carries.
    let mut current = report_sheet(&steps[0]);
    for step in &steps[1..] {
        let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
        let method = call[0].as_str().unwrap().trim_start_matches('@');
        let answer = styk_doc::json::parse(session.call(method, &json(&Value::array(call[1..].to_vec())), "null").as_bytes()).unwrap();
        let number = json(step.get("step").unwrap());
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "step {number}");
        assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "step {number} state");
        assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "step {number} events");
        if let (Some(sheet), Some(document)) = (answer.get("sheet"), step.get("document").and_then(Value::as_str)) {
            let expected = styk_doc::json::parse(document.as_bytes()).unwrap();
            let mut adopted = sheet.as_obj().unwrap().clone();
            let replaced = sheet.get("tracks").unwrap().as_obj().unwrap();
            let mut tracks = styk_doc::Obj::new();
            for id in answer.get("trackOrder").unwrap().elements().unwrap().iter() {
                let id = id.as_str().unwrap().to_string();
                tracks.set(&id, replaced.get(&id).or_else(|| current.path(&["tracks", &id])).cloned().unwrap());
            }
            adopted.set("tracks", Value::object(tracks));
            let adopted = Value::object(adopted);
            assert_eq!(json(&adopted), json(expected.path(&["_styk", "layerSheet"]).unwrap()), "step {number} sheet");
            current = adopted;
            for (id, source) in answer.get("sources").unwrap().as_obj().unwrap().iter() {
                assert_eq!(json(source), expected.path(&["_styk", "frameSources", id]).map(json).unwrap_or_else(|| "null".into()), "step {number} source {id}");
            }
            published += 1;
        } else if let Some(document) = step.get("document").and_then(Value::as_str) {
            // A step that changed the document without publishing (history): follow it.
            current = styk_doc::json::parse(document.as_bytes()).unwrap().path(&["_styk", "layerSheet"]).cloned().unwrap_or(Value::Null);
        }
    }
    assert!(published >= 10, "{published} steps published a sheet");
}
