//! Animation-origin commands are opened only with editor recordings (D15).
use std::path::Path;

const RECORDINGS: &[&str] = &[
    "origin-gestures-layout-native", "origin-gestures-layout-sheet",
    "origin-gestures-offsets-native", "origin-gestures-offsets-sheet",
    "origin-gestures-support-native", "origin-gestures-support-sheet", "origin-gestures-support-autokey-sheet",
];

#[test]
fn origin_gestures_match_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in RECORDINGS {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}

#[test]
fn unproven_origin_commands_refuse_atomically_during_a_gesture() {
    let reference = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-gestures-support-native.reference.json")).unwrap()).unwrap();
    let report = styk_doc::json::parse(reference.path(&["steps"]).unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
    editor.call("select", &[styk_doc::Value::Num(1.0), styk_doc::Value::Num(-1.0)]).unwrap();
    editor.call("beginTranslationDrag", &[]).unwrap();
    editor.call("moveSelection", &[styk_doc::Value::Num(4.0), styk_doc::Value::Num(-2.0)]).unwrap();
    let before = (editor.report_json(), editor.state());
    for method in ["applyFigureRange", "moveSelectionInFrames", "beginMotionPathEdit", "duplicateFigure", "deleteSelection"] {
        assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))), "{method}");
        assert_eq!((editor.report_json(), editor.state()), before, "{method} changed state on refusal");
    }
    // A selected joint must not route either mirror call into a topology command.
    editor.call("select", &[styk_doc::Value::Num(1.0), styk_doc::Value::Num(0.0)]).unwrap();
    let before = (editor.report_json(), editor.state());
    for method in ["mirrorSelection", "mirrorFigure"] {
        assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))));
        assert_eq!((editor.report_json(), editor.state()), before);
    }
}

#[test]
fn malformed_origin_documents_with_saved_property_channels_remain_refused() {
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-gestures-layout-sheet.document.json")).unwrap();
    let mut report = styk_doc::json::parse(&bytes).unwrap();
    let mut animation = styk_doc::Obj::new();
    animation.set("channels", styk_doc::Value::array(vec![styk_doc::Value::Null]));
    report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("layerSheet").unwrap().make_obj().unwrap().set("legacyAnimation", styk_doc::Value::object(animation));
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    let before = (editor.report_json(), editor.state());
    assert!(matches!(editor.call("moveSelection", &[styk_doc::Value::Num(1.0), styk_doc::Value::Num(2.0)]), Err(styk_edit::EditError::Unported(_))));
    assert_eq!((editor.report_json(), editor.state()), before);
}
