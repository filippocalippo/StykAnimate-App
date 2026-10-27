//! Malformed nested rig data is refused before touching the current gesture.
use super::*;
use styk_doc::Value;

fn mutated(mut figure: Value, test: &Value) -> Value {
    let path: Vec<_> = test.get("path").unwrap().elements().unwrap().iter().collect();
    let mut at = &mut figure;
    for key in &path[..path.len() - 1] {
        at = if let Some(key) = key.as_str() { at.make_obj().unwrap().get_mut(key).unwrap() }
            else { &mut at.make_arr().unwrap()[key.as_f64().unwrap() as usize] };
    }
    let key = path.last().unwrap().as_str().unwrap();
    if test.get("remove") == Some(&Value::Bool(true)) { at.make_obj().unwrap().remove(key); }
    else {
        let raw = test.get("value").unwrap();
        let value = match raw.get("specialNumber").and_then(Value::as_str) {
            Some("NaN") => Value::Num(f64::NAN), Some("Infinity") => Value::Num(f64::INFINITY), Some("-Infinity") => Value::Num(f64::NEG_INFINITY), _ => raw.clone(),
        };
        at.make_obj().unwrap().set(key, value);
    }
    figure
}

#[test]
fn malformed_nested_origin_rigs_refuse_atomically_during_native_and_sheet_drags() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let oracle = styk_doc::json::parse(&std::fs::read(root.join("../styk-eval/tests/fixtures/origin-invalid-rig.json")).unwrap()).unwrap();
    let mut count = 0;
    for (name, path, options) in [
        ("native", "../../tests/edit/origin-rig-pose-support-native.document.json", crate::Options::default()),
        ("sheet", "../../tests/edit/origin-rig-pose-support-sheet.document.json", crate::Options { property_channels: true, layer_timeline: true, auto_key: false }),
    ] {
        let bytes = std::fs::read(root.join(path)).unwrap();
        for test in oracle.get("cases").unwrap().elements().unwrap().iter().filter(|test| test.get("refused") == Some(&Value::Bool(true))) {
            let mut editor = Editor::new(styk_doc::json::parse(&bytes).unwrap(), options);
            editor.call("select", &[Value::Num(1.0), Value::Num(2.0)]).unwrap();
            editor.call("beginTranslationDrag", &[]).unwrap();
            editor.call("moveSelection", &[Value::Num(5.125), Value::Num(-2.75)]).unwrap();
            let figure = editor.report().get("figure_types").unwrap().item(0).unwrap();
            editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0] = mutated(figure, &test);
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            editor.take_events();let before = snapshot(&editor);let node = editor.report().clone();
            for (method, args) in [("poseJoint", vec![Value::Num(400.25), Value::Num(200.125)]), ("rotateJoint", vec![Value::Num(0.17)]), ("bendJoint", vec![Value::Num(400.25), Value::Num(200.125)]),
                ("beginFigureHandleDrag", vec![]), ("transformFigureHandle", vec![Value::Num(400.25), Value::Num(200.125)]), ("commitFigureHandleDrag", vec![]), ("cancelFigureHandleDrag", vec![]),
                ("beginRigDrag", vec![]), ("editRigJoint", vec![Value::Num(400.25), Value::Num(200.125)]), ("commitRigDrag", vec![]), ("cancelRigDrag", vec![]), ("slideConnector", vec![Value::Num(400.25), Value::Num(200.125)]), ("setConnectorPosition", vec![Value::Num(0.65)])] {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call(method, &args)));
                assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "{name} {} {method}: {result:?}", test.get("name").unwrap().as_str().unwrap());
                assert_eq!(snapshot(&editor), before);assert!(editor.report().same_node(&node));assert!(editor.take_events().is_empty());count += 1;
            }
        }
    }
    assert_eq!(count, 2652);
    println!("{count} malformed-rig calls preserved document/view/open drag/COW/events");
}
