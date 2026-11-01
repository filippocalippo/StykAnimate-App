//! Movieclips nest at most eight deep, counting the scene each retains, and a project beyond that is refused when it is saved. Making a
//! movieclip of a movieclip over and over reaches it in a few steps, so the step that would take a project there is refused instead, with
//! the project as it was: nothing is left that cannot be saved.

use styk_doc::Value;
use styk_edit::load::prepare_for_editor;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn read(path: &str) -> Value {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    json(std::str::from_utf8(&std::fs::read(folder.join(path)).unwrap()).unwrap())
}

const STATE: &str = r#"{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-1","nextFrameIdentity":100,"nextUid":60}"#;

fn call(session: &mut Session, method: &str, args: &str, selected: &[u32]) -> Value {
    let uuids: Vec<String> = (1..=24).map(|i| format!("[\"uuid\",\"00000000-0000-4000-8000-{i:012}\"]")).collect();
    let ids: Vec<String> = selected.iter().map(u32::to_string).collect();
    let first = selected.first().map_or("null".to_string(), u32::to_string);
    let view = format!(r#"{{"tick":0,"frameIndex":0,"selectedUid":{first},"selectedUids":[{}],"selectedJoint":-1,"activeLayerId":"layer-1","draws":[{}],"drawPool":true}}"#, ids.join(","), uuids.join(","));
    json(&session.call(method, args, &view))
}

#[test]
fn making_a_movieclip_of_a_movieclip_again_and_again_stops_before_the_project_cannot_be_saved() {
    let mut session = Session::start(read("tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    let mut clip = 4.0;
    let mut made = 0;
    let refusal = loop {
        let placed = call(&mut session, "addFigure", &format!("[{clip}]"), &[]);
        let instance = placed.get("result").and_then(|r| r.get("unique_id")).and_then(Value::as_f64).expect("the clip is placed") as u32;
        let before = styk_doc::json::to_string(session.report());
        let answer = call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[instance]);
        if answer.get("status").and_then(Value::as_str) != Some("ok") {
            // The refusal leaves the project as it was (the clip placed above is the one change made before it).
            assert_eq!(styk_doc::json::to_string(session.report()), before, "a refused movieclip changes nothing");
            break answer;
        }
        clip = answer.get("result").and_then(|r| r.get("figure_type_id")).and_then(Value::as_f64).unwrap();
        made += 1;
        prepare_for_editor(session.report().clone(), true).unwrap_or_else(|error| panic!("a project of {made} nested movieclips opens: {error:?}"));
        assert!(made < 20, "the nesting is limited");
    };
    assert!(made >= 2, "clips nest a few levels before the limit: {made}");
    let message = styk_doc::json::to_string(&refusal);
    assert!(message.contains("movieclipsContainACycleOrExceedEightNested"), "{message}");
}
