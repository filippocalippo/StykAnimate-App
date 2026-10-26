use styk_doc::Value;

fn reference(mode: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/edit/selection-sets-{mode}.reference.json"));
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn selection_set_commands_match_the_editor_step_for_step() {
    for mode in ["native", "sheet", "autokey-sheet"] {
        let outcome = styk_edit::replay::replay(&reference(mode)).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{mode}: {outcome:#?}");
    }
}

fn editor() -> styk_edit::Editor {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    styk_edit::Editor::new(report, styk_edit::Options::default())
}

fn args(text: &str) -> Vec<Value> {
    styk_doc::json::parse(text.as_bytes()).unwrap().elements().unwrap().iter().collect()
}

#[test]
fn selection_set_commands_preserve_document_identity_and_history() {
    let mut editor = editor();
    editor.call("selectMany", &args("[[5,1]]")).unwrap();
    editor.take_events();
    let report = editor.report().clone();
    let before = editor.state();
    for (method, text) in [
        ("selectSameDefinition", "[]"), ("invertSelection", "[[2,3,2,999]]"),
        ("selectMarquee", "[[4,1],{\"mode\":\"toggle\",\"initial\":[1,5]}]"),
    ] {
        editor.call(method, &args(text)).unwrap();
        assert!(report.same_node(editor.report()), "{method}: document identity");
        assert_eq!(editor.state().can_undo, before.can_undo);
        assert_eq!(editor.state().can_redo, before.can_redo);
        assert_eq!(editor.state().dirty, before.dirty);
    }
}

#[test]
fn unsupported_id_transport_refuses_atomically_with_optional_selection_metadata() {
    for (method, text) in [
        ("selectSameDefinition", "[{\"candidates\":null}]"),
        ("selectSameDefinition", "[null]"),
        ("invertSelection", "[null]"), ("invertSelection", "[\"12\"]"),
        ("selectMarquee", "[null]"), ("selectMarquee", "[[1],null]"),
        ("selectMarquee", "[[1],{\"mode\":\"add\",\"initial\":null}]"),
    ] {
        let mut editor = editor();
        editor.call("selectBranch", &args("[1,1]")).unwrap();
        editor.take_events();
        let before = editor.state_value();
        let report = editor.report().clone();
        assert!(matches!(editor.call(method, &args(text)), Err(styk_edit::EditError::Unported(_))), "{method}/{text}");
        assert_eq!(editor.state_value(), before, "{method}: selection/history");
        assert!(report.same_node(editor.report()), "{method}: document identity");
        assert!(editor.take_events().is_empty());
    }
}

#[test]
fn invalid_marquee_modes_raise_the_editor_error_without_mutation() {
    for mode in ["null", "false", "\"invalid\""] {
        let mut editor = editor();
        editor.call("selectBranch", &args("[1,1]")).unwrap();
        editor.take_events();
        let before = editor.state_value();
        let report = editor.report().clone();
        let result = editor.call("selectMarquee", &args(&format!("[[1],{{\"mode\":{mode}}}]")));
        assert!(matches!(result, Err(styk_edit::EditError::Invalid(ref key)) if key == "errors.editorSelection.chooseAValidMarqueeSelectionMode"));
        assert_eq!(editor.state_value(), before);
        assert!(report.same_node(editor.report()));
        assert!(editor.take_events().is_empty());
    }
}

#[test]
fn session_selection_commands_do_not_advance_the_document_revision() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut session = styk_edit::session::Session::start(report.clone(), &styk_doc::json::to_string(first.get("state").unwrap())).unwrap();
    let revision = session.revision();
    for (method, arguments) in [
        ("selectMarquee", "[[5,1]]"), ("selectSameDefinition", "[]"), ("invertSelection", "[[2,3]]"),
    ] {
        let answer = styk_doc::json::parse(session.call(method, arguments, "null").as_bytes()).unwrap();
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        assert_eq!(session.revision(), revision, "{method}");
        assert!(report.same_node(session.report()));
        assert!(!session.can_undo());
    }
}

/// Explicit command expectations supplement the frozen pre-cutover recordings.
#[test]
fn selection_modes_preserve_order_active_uid_and_fixed_drag_origin() {
    let mut editor = editor();
    editor.call("selectMany", &args("[[5,1]]")).unwrap();
    for (method, text, expected, active) in [
        ("selectSameDefinition", "[]", vec![1,3,5], Some(1)),
        ("invertSelection", "[[1,2]]", vec![3,5,2], Some(2)),
        ("selectMarquee", "[[1,3],{\"mode\":\"replace\"}]", vec![1,3], Some(3)),
        ("selectMarquee", "[[1,3],{\"mode\":\"add\",\"initial\":[5,1] }]", vec![5,1,3], Some(3)),
        ("selectMarquee", "[[1,3],{\"mode\":\"toggle\",\"initial\":[5,1] }]", vec![5,3], Some(3)),
        ("selectMarquee", "[[1,3],{\"mode\":\"toggle\",\"initial\":[5,1] }]", vec![5,3], Some(3)),
        ("selectMarquee", "[[1,3],{\"mode\":\"subtract\",\"initial\":[5,1] }]", vec![5], Some(5)),
    ] {
        editor.call(method, &args(text)).unwrap();
        let state = editor.state();
        assert_eq!(state.selected_uids, expected, "{method}/{text}");
        assert_eq!(state.selected_uid, active, "{method}/{text}");
        assert_eq!(state.selected_joint, -1);
        assert!(!state.can_undo);
    }
}
