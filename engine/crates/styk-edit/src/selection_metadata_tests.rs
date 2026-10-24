//! Optional selection is a prerequisite, not admission of unrecorded geometry commands.
use super::*;
fn fixture(name: &str) -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    styk_doc::json::parse(&std::fs::read(root.join(name)).unwrap()).unwrap()
}
#[test]
fn selection_sensitive_commands_refuse_atomically_with_changed_open_drags() {
    let mut count = 0;
    for mode in ["native", "sheet"] {
        let reference = fixture(&format!("selection-metadata-plain-{mode}.reference.json"));
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        for key in ["polygonSelection", "segmentIds", "branch"] {
            let state = steps.iter().find_map(|step| step.get("state").filter(|state| state.get(key).is_some())).unwrap();
            let options = crate::Options { property_channels: mode == "sheet", layer_timeline: mode == "sheet", auto_key: false };
            for (method, args) in [
                ("moveSelection", vec![Value::Num(3.0), Value::Num(2.0)]),
                ("rotateSelection", vec![Value::Num(0.2)]), ("scaleSelection", vec![Value::Num(1.2)]),
                ("mirrorSelection", vec![Value::str("horizontal")]), ("mirrorFigure", vec![]),
                ("poseJoint", vec![Value::Num(340.0), Value::Num(210.0)]),
                ("rotateJoint", vec![Value::Num(0.2)]), ("bendJoint", vec![Value::Num(350.0), Value::Num(200.0)]),
                ("deleteSelection", vec![]), ("deleteSegment", vec![]), ("mirrorSegmentBranch", vec![]),
                ("setBranchFill", vec![Value::str("#abcdef")]), ("updatePolygon", vec![Value::Num(0.0), Value::Null]),
                ("commitDrag", vec![]), ("cancelDrag", vec![]), ("joinTo", vec![Value::Num(2.0), Value::Num(11.0)]),
            ] {
                let report = styk_doc::json::parse(steps[0].get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
                let mut editor = Editor::new(report, options);
                editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
                editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();
                editor.set_view(0.0, 0, Selection { uid: state.get("selectedUid").and_then(Value::as_f64).map(|uid| uid as u32), uids: state.get("selectedUids").unwrap().numbers().unwrap().into_iter().map(|uid| uid as u32).collect(), joint: state.get("selectedJoint").unwrap().as_f64().unwrap() as i64 });
                editor.set_selection_metadata(state).unwrap();editor.take_events();
                let report = editor.report.clone();let bytes = editor.report_json();let shown = editor.shown_frame().unwrap();
                let state = editor.state_value();let drag = editor.drag_value();let draft = editor.draft_figures();let metadata = editor.selection_metadata.clone();let history = editor.selection_state().history_value();
                let result = editor.call(method, &args);
                assert!(matches!(result, Err(EditError::Unported(_))), "{mode}/{key}/{method}: {result:?}");
                assert!(report.same_node(&editor.report), "{mode}/{key}/{method}: report COW identity");
                assert_eq!(bytes, editor.report_json());assert_eq!(state, editor.state_value());assert_eq!(drag, editor.drag_value());assert_eq!(draft, editor.draft_figures());
                assert_eq!(metadata, editor.selection_metadata);assert_eq!(history, editor.selection_state().history_value());assert_eq!(shown, editor.shown_frame().unwrap());assert!(editor.take_events().is_empty());count += 1;
            }
        }
    }
    println!("{count} atomic optional-selection refusals with changed open drags");
}
#[test]
fn complex_selector_fallback_restores_metadata_cleared_before_validation() {
    let reference = fixture("selection-metadata-plain-native.reference.json");
    let steps = reference.get("steps").unwrap();
    let report = styk_doc::json::parse(steps.item(0).unwrap().get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut editor = Editor::new(report, crate::Options::default());
    editor.call("selectPolygon", &[Value::Num(1.0), Value::Num(0.0)]).unwrap();editor.take_events();
    let mut report = editor.report.clone();
    // The existing complex-definition guard's drawing family is already unrecorded.
    let figure = &mut report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0];
    let mut styk = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();styk.set("drawing", Value::Bool(true));figure.make_obj().unwrap().set("_styk", Value::object(styk));
    editor.report = report;let metadata = editor.selection_metadata.clone();let report = editor.report.clone();
    for method in ["toggleSegment", "selectBranch", "selectPolygon"] {
        let result = editor.call(method, &[Value::Num(1.0), Value::Num(0.0)]);
        assert!(matches!(result, Err(EditError::Unported(_))), "{method}: {result:?}");
        assert_eq!(metadata, editor.selection_metadata);assert!(report.same_node(&editor.report));assert!(editor.take_events().is_empty());
    }
}
