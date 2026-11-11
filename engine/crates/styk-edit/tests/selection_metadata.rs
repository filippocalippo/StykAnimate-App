use styk_doc::Value;
fn reference(kind: &str, mode: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/selection-metadata-{kind}-{mode}.reference.json"));
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}
#[test]
fn optional_selection_metadata_matches_the_editor_at_every_step() {
    let mut total = 0;
    for kind in ["plain", "layout", "support", "saved-layout", "saved-support"] {
        let modes: &[&str] = if kind.starts_with("saved-") { &["sheet", "autokey-sheet"] } else { &["native", "sheet", "autokey-sheet"] };
        for mode in modes {
            let outcome = styk_edit::replay::replay(&reference(kind, mode)).unwrap();
            assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{kind}/{mode}: {outcome:#?}");
            total += outcome.steps;
        }
    }
    println!("selection metadata: {total} exact steps");
}
#[test]
fn session_start_preserves_optional_selection_metadata_before_a_call() {
    let reference = reference("plain", "native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let selected = reference.get("steps").unwrap().item(3).unwrap();
    let document = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let state = styk_doc::json::to_string(selected.get("state").unwrap());
    let mut session = styk_edit::session::Session::start(document, &state).unwrap();
    let answer = styk_doc::json::parse(session.call("setFPS", "[30]", "null").as_bytes()).unwrap();
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
    assert_eq!(answer.path(&["state", "polygonSelection"]), selected.path(&["state", "polygonSelection"]));
}

#[test]
fn recorded_selection_calls_round_trip_through_session_view_transport() {
    let mut total = 0;
    for kind in ["plain", "layout", "support", "saved-layout", "saved-support"] {
        let modes: &[&str] = if kind.starts_with("saved-") { &["sheet", "autokey-sheet"] } else { &["native", "sheet", "autokey-sheet"] };
        for mode in modes {
            let reference = reference(kind, mode);let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
            let report = styk_doc::json::parse(steps[0].get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
            let mut initial = steps[0].get("state").unwrap().as_obj().unwrap().clone();
            for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { initial.set(key, value.clone()); }
            let mut session = styk_edit::session::Session::start(report, &styk_doc::json::to_string(&Value::object(initial))).unwrap();
            let mut previous = steps[0].get("state").unwrap().clone();let mut canonical = Value::Null;
            for step in &steps[1..] {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();let method = call[0].as_str().unwrap();
                if method == "@selection" { canonical = styk_doc::json::parse(step.get("result").unwrap().as_str().unwrap().as_bytes()).unwrap(); }
                else if method == "@restoreSelection" { canonical = call[1].clone(); }
                else {
                    let mut view = previous.as_obj().unwrap().clone();
                    view.set("autoKey", Value::Bool(*mode == "autokey-sheet"));
                    for key in ["activeLayerId", "sheetSelection"] { if let Some(value) = canonical.get(key) { view.set(key, value.clone()); } }
                    let method = if method == "@select" { "select" } else if method == "@seek" { "seek" } else { method };
                    let answer = styk_doc::json::parse(session.call(method, &styk_doc::json::to_string(&Value::array(call[1..].to_vec())), &styk_doc::json::to_string(&Value::object(view))).as_bytes()).unwrap();
                    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{kind}/{mode}/{}: {answer}", step.get("step").unwrap());
                    assert_eq!(answer.get("state"), step.get("state"), "{kind}/{mode}/{method}/{}", step.get("step").unwrap());
                    assert_eq!(answer.get("events"), step.get("events"), "{kind}/{mode}/{method} events");total += 1;
                }
                previous = step.get("state").unwrap().clone();
            }
        }
    }
    println!("{total} recorded selection calls through Session view transport");
}
