use styk_doc::Value;

fn reference(mode: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/edit/connected-selection-{mode}.reference.json"));
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn connected_selection_matches_editor_documents_state_events_and_history() {
    for mode in ["native", "sheet", "autokey-sheet"] {
        let outcome = styk_edit::replay::replay(&reference(mode)).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{mode}: {outcome:#?}");
    }
}

#[test]
fn connected_selection_runs_through_the_session_api() {
    for mode in ["native", "sheet", "autokey-sheet"] {
        let reference = reference(mode);
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let first = &steps[0];
        let document = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
        for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
            state.set(key, value.clone());
        }
        let mut session = styk_edit::session::Session::start(document, &styk_doc::json::to_string(&Value::object(state))).unwrap();
        let mut previous = first.get("state").unwrap().clone();
        let mut expected = first.get("document").unwrap().as_str().unwrap().to_string();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap();
            let mut view = previous.as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(mode == "autokey-sheet"));
            let answer = styk_doc::json::parse(session.call(method,
                &styk_doc::json::to_string(&Value::array(call[1..].to_vec())),
                &styk_doc::json::to_string(&Value::object(view))).as_bytes()).unwrap();
            assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{mode}/{method}: {answer}");
            assert_eq!(answer.get("state"), step.get("state"), "{mode}/{method} state");
            assert_eq!(answer.get("events"), step.get("events"), "{mode}/{method} events");
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
            assert_eq!(styk_doc::json::to_string(session.report()), expected, "{mode}/{method} document");
            previous = step.get("state").unwrap().clone();
        }
    }
}

#[test]
fn cyclic_and_dangling_joins_are_bounded_without_changing_the_document() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0]
        .make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    // 1 -> 2 -> 1 is a cycle; 3 joins 2; 4 has a missing target.
    objects[0].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":1,"target_handle_id":22}"#).unwrap());
    objects[3].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":99,"target_handle_id":22}"#).unwrap());
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.call("selectConnected", &[Value::Num(1.0)]).unwrap();
    assert_eq!(editor.state_value().get("selectedUids").unwrap().numbers().unwrap(), vec![1.0, 2.0, 3.0]);
    editor.call("selectConnected", &[Value::Num(4.0)]).unwrap();
    assert_eq!(editor.state_value().get("selectedUids").unwrap().numbers().unwrap(), vec![4.0]);
    assert!(report.same_node(editor.report()), "selection must not replace the document");
    assert_eq!(editor.state_value().get("canUndo"), Some(&Value::Bool(false)));
}

#[test]
fn unsupported_candidate_transport_refuses_without_mutating_selection_or_document() {
    let reference = reference("native");
    let document = reference.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
    let report = styk_doc::json::parse(document.as_bytes()).unwrap();
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.call("select", &[Value::Num(4.0)]).unwrap();
    editor.take_events();
    let before = editor.state_value();
    let result = editor.call("selectConnected", &[Value::Num(1.0), styk_doc::json::parse(br#"{"candidates":null}"#).unwrap()]);
    assert!(matches!(result, Err(styk_edit::EditError::Unported(_))));
    assert_eq!(editor.state_value(), before);
    assert!(report.same_node(editor.report()));
    assert!(editor.take_events().is_empty());
}

#[test]
fn invalid_join_slots_do_not_connect_unrelated_figures() {
    let reference = reference("native");
    let text = reference.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
    for target in ["-1", "0.5", "99", "\"0\"", "null"] {
        let mut report = styk_doc::json::parse(text.as_bytes()).unwrap();
        let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0]
            .make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
        objects[3].make_obj().unwrap().set("join", styk_doc::json::parse(format!(r#"{{"target_object_slot":{target},"target_handle_id":22}}"#).as_bytes()).unwrap());
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
        editor.call("selectConnected", &[Value::Num(4.0)]).unwrap();
        assert_eq!(editor.state().selected_uids, vec![4], "target {target}");
    }
}
