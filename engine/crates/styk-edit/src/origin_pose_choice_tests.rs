use super::*;
fn fixture(name: &str) -> Value {
    styk_doc::json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}"))).unwrap()).unwrap()
}
// JSON cannot represent Infinity. Rehydrate exactly the raw binding exercised
// by the editor load oracle instead of comparing its serialized null surrogate.
fn choice_figure(case: &Value) -> Value {
    let mut figure = case.get("figure").unwrap().clone();
    if case.get("specialNumber").and_then(Value::as_str) == Some("Infinity") {
        assert_eq!(case.get("name").and_then(Value::as_str), Some("choice-value-nonfinite"));
        figure.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("poseChoices").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("choices").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("angles").unwrap().make_arr().unwrap()[0].make_arr().unwrap()[1] = Value::Num(f64::INFINITY);
    }
    figure
}
fn document(joined: bool) -> Value {
    fixture(if joined { "origin-pose-choice-mixed-support-native-joined.document.json" } else { "origin-pose-choice-mixed-support-native.document.json" })
}
fn snapshot(editor: &mut Editor) -> (Value, String, Value, Value, crate::select::SelectionMetadata, Result<String, String>, Vec<Value>) {
    (editor.report.clone(), editor.report_json(), editor.state_value(), editor.drag_value(), editor.selection_metadata.clone(), editor.shown_frame().map(|frame| styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&frame))).map_err(|error| error.to_string()), editor.take_events())
}
fn editor(joined: bool) -> Editor {
    let mut editor = Editor::new(document(joined), crate::Options::default());editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
    editor.call("beginDrag", &[Value::str("Choice live")]).unwrap();editor.call("setPoseChoice", &[Value::str("Expression"), Value::Num(2.0)]).unwrap();editor.take_events();editor
}
#[test]
fn choice_schema_matches_every_actual_editor_load_outcome() {
    let cases = fixture("origin-pose-choice.validation.json");let mut checked = 0;
    for case in cases.elements().unwrap().iter() {
        let figure = choice_figure(&case);let segments = crate::topology::validate_definition(&figure).unwrap();
        let actual = crate::pose_choice::validate_choices(&figure, &segments).err();let expected = case.get("error").and_then(Value::as_str);
        assert_eq!(actual, expected, "{}", case.get("name").unwrap().as_str().unwrap());checked += 1;
    }
    assert_eq!(checked, 31);
}
#[test]
fn malformed_choice_schema_preserves_a_changed_open_pose() {
    let cases = fixture("origin-pose-choice.validation.json");let mut refused = 0;
    for case in cases.elements().unwrap().iter().filter(|case| case.get("error").is_some_and(|error| !error.is_null())) {
        let mut editor = editor(false);editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0] = choice_figure(&case);editor.take_events();
        let before = snapshot(&mut editor);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call("setPoseChoice", &[Value::str("Expression"), Value::Num(1.0)])));
        assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "{}: {result:?}", case.get("name").unwrap().as_str().unwrap());
        assert_eq!(snapshot(&mut editor), before);refused += 1;
    }
    assert_eq!(refused, 26);
}
#[test]
fn unrecorded_choice_combinations_preserve_live_document_shown_history_and_metadata() {
    for feature in ["skin", "motion", "weighted", "stretch", "spatialMesh", "drawing", "movieclip", "ik", "malformed-ik", "projection", "missing-pivot", "cyclic-join", "missing-join", "invalid-id", "duplicate-id", "invalid-parent", "complex-ancestor", "same-definition-ancestor", "same-definition-follower"] {
        let mut editor = editor(["complex-ancestor", "same-definition-ancestor", "same-definition-follower"].contains(&feature));
        let index = if feature == "complex-ancestor" { 1 } else { 0 };
        let figure = editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[index].make_obj().unwrap();
        match feature {
            "spatialMesh" | "drawing" | "movieclip" => {figure.get_mut("_styk").unwrap().make_obj().unwrap().set(feature, Value::Bool(true));}
            "complex-ancestor" => {figure.set("_styk", styk_doc::json::parse(br#"{"drawing":{"version":1}}"#).unwrap());}
            "skin" | "motion" | "weighted" | "stretch" | "invalid-id" | "duplicate-id" | "invalid-parent" => {
                let segments = figure.get_mut("segments").unwrap().make_arr().unwrap();
                let segment = segments.iter_mut().find(|segment| num(segment, "segment_id") == Some(4.0)).unwrap().make_obj().unwrap();
                match feature {
                    "invalid-id" => {segment.set("segment_id", Value::Num(4.5));}
                    "duplicate-id" => {segment.set("segment_id", Value::Num(7.0));}
                    "invalid-parent" => {segment.set("parent_id", Value::Num(999.0));}
                    _ => {
                        let rig = segment.get_mut("_stykRig").unwrap().make_obj().unwrap();
                        match feature {
                            "skin" => {rig.get_mut("spatial").unwrap().make_obj().unwrap().set("bindings", Value::array(vec![]));}
                            "motion" => {rig.get_mut("spatial").unwrap().make_obj().unwrap().set("motion", Value::Null);}
                            _ => {rig.set(feature, Value::Bool(true));}
                        }
                    }
                }
            }
            _ => {}
        }
        if ["ik", "malformed-ik", "projection", "missing-pivot", "cyclic-join", "missing-join"].contains(&feature) {
            let object = editor.report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
            match feature {
                "ik" => {object.set("_stykIK", styk_doc::json::parse(br#"{"4":{"enabled":true,"chainLength":2}}"#).unwrap());}
                "malformed-ik" => {object.set("_stykIK", Value::Bool(true));}
                "projection" => {object.set("_stykSpatial", Value::Bool(true));}
                "missing-pivot" => {object.remove("_stykAnimationOrigin");}
                "cyclic-join" => {object.set("join", styk_doc::json::parse(br#"{"target_object_slot":0,"target_unique_id":1,"target_handle_id":4}"#).unwrap());}
                _ => {object.set("join", styk_doc::json::parse(br#"{"target_object_slot":999,"target_unique_id":999,"target_handle_id":4}"#).unwrap());}
            }
        }
        if ["same-definition-ancestor", "same-definition-follower"].contains(&feature) {
            let objects = editor.report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
            let target = if feature == "same-definition-ancestor" { 1 } else { 2 };
            let mut replacement = objects[0].clone();let record = replacement.make_obj().unwrap();
            record.set("unique_id", Value::Num(if target == 1 { 2.0 } else { 3.0 }));record.remove("join");
            if target == 1 {
                objects[0].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":1,"target_unique_id":2,"target_handle_id":4}"#).unwrap());
            } else {
                record.set("join", styk_doc::json::parse(br#"{"target_object_slot":0,"target_unique_id":1,"target_handle_id":4}"#).unwrap());
            }
            objects[target] = replacement;
        }
        editor.take_events();let before = snapshot(&mut editor);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call("setPoseChoice", &[Value::str("Expression"), Value::Num(1.0)])));
        assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "{feature}: {result:?}");assert_eq!(snapshot(&mut editor), before, "{feature}");
    }
}
#[test]
fn choice_projection_selection_metadata_and_other_spatial_commands_remain_atomic() {
    for options in [crate::Options {property_channels: true, ..crate::Options::default()}, crate::Options {layer_timeline: true, ..crate::Options::default()}] {
        let mut unopened = Editor::new(document(false), options.clone());unopened.take_events();let before = snapshot(&mut unopened);
        assert!(matches!(unopened.call("select", &[Value::Num(1.0), Value::Num(-1.0)]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut unopened), before);
        // The owning selection gate currently refuses first. Test choice readiness
        // independently on an already changed live pose without relaxing that gate.
        let mut editor = editor(false);editor.options = options;editor.take_events();let before = snapshot(&mut editor);
        assert!(matches!(editor.call("setPoseChoice", &[Value::str("Expression"), Value::Num(2.0)]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut editor), before);
    }
    let mut foreign = editor(false);foreign.drag.as_mut().unwrap().translation = true;foreign.take_events();let before = snapshot(&mut foreign);
    assert!(matches!(foreign.call("setPoseChoice", &[Value::str("Expression"), Value::Num(1.0)]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut foreign), before);
    let mut editor = editor(false);editor.set_selection_metadata(&styk_doc::json::parse(br#"{"branch":{"uid":1,"joint":3,"futureHiddenChoiceMetadata":[4,2]}}"#).unwrap()).unwrap();editor.take_events();let before = snapshot(&mut editor);
    assert!(matches!(editor.call("setPoseChoice", &[Value::str("Expression"), Value::Num(1.0)]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut editor), before);
    editor.set_selection_metadata(&Value::object(Obj::new())).unwrap();editor.take_events();let before = snapshot(&mut editor);
    for (method, args) in [("setSpatialPose", vec![styk_doc::json::parse(br#"{"turn":0.2}"#).unwrap()]), ("setSpatialFeetPinned", vec![Value::Bool(false)]), ("poseJoint", vec![Value::Num(200.0), Value::Num(200.0)]), ("rotateJoint", vec![Value::Num(0.2)]), ("beginRigDrag", vec![]), ("beginFigureHandleDrag", vec![])] {
        assert!(matches!(editor.call(method, &args), Err(EditError::Unported(_))), "{method}");assert_eq!(snapshot(&mut editor), before, "{method}");
    }
}
