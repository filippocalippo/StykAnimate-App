use super::*;

fn document() -> Value {
    styk_doc::json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-angle-lock-support-native.document.json")).unwrap()).unwrap()
}
fn snapshot(editor: &mut Editor) -> (String, Value, Value, Result<String, String>, Vec<Value>) {
    (editor.report_json(), editor.state_value(), editor.drag_value(), editor.shown_frame().map(|frame| styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&frame))).map_err(|error| error.to_string()), editor.take_events())
}
fn lock() -> Value { styk_doc::json::parse(br#"{"mode":"parent","angle":0.25,"multiplier":1,"reference":22,"restAngle":0.125,"figureRestAngle":0.75,"secondary":null}"#).unwrap() }

#[test]
fn unrecorded_and_malformed_origin_constraints_preserve_open_translation() {
    let calls = [
        ("setAngleLock", vec![Value::str("figure")]),
        ("setSecondaryAngleReference", vec![Value::Num(33.0)]),
        ("setRigBehavior", vec![styk_doc::json::parse(br#"{"angleLock":{"multiplier":0.5}}"#).unwrap()]),
    ];
    let mut refusals = 0;
    for feature in ["spatial", "weighted", "anglePath", "stretch", "poseChoices", "drawing", "movieclip", "missing-pivot", "malformed-mode", "malformed-reference", "malformed-multiplier", "ik", "join-cycle", "join-missing"] {
        let mut editor = Editor::new(document(), crate::Options::default());
        editor.call("select", &[Value::Num(1.0), Value::Num(3.0)]).unwrap();
        editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(5.125), Value::Num(-3.75)]).unwrap();
        // A mirrored source revision can replace the definition while a drag is open;
        // admission must validate that current raw view before committing the drag.
        let figure = editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
        match feature {
            "poseChoices" | "drawing" | "movieclip" => { figure.get_mut("_styk").unwrap().make_obj().unwrap().set(feature, Value::Bool(true)); }
            "missing-pivot" | "ik" | "join-cycle" | "join-missing" => {}
            _ => {
                let segment = figure.get_mut("segments").unwrap().make_arr().unwrap()[3].make_obj().unwrap();
                let mut rig = Obj::new();rig.set("angleLock", lock());
                match feature {
                    "malformed-mode" => { rig.get_mut("angleLock").unwrap().make_obj().unwrap().set("mode", Value::str("unrecorded")); }
                    "malformed-reference" => { rig.get_mut("angleLock").unwrap().make_obj().unwrap().set("reference", Value::str("22")); }
                    "malformed-multiplier" => { rig.get_mut("angleLock").unwrap().make_obj().unwrap().set("multiplier", Value::Num(11.0)); }
                    _ => { rig.set(feature, Value::Bool(true)); }
                }
                segment.set("_stykRig", Value::object(rig));
            }
        }
        if ["missing-pivot", "ik", "join-cycle", "join-missing"].contains(&feature) {
            let object = editor.report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
            match feature {
                "missing-pivot" => {object.remove("_stykAnimationOrigin");}
                "ik" => {object.set("_stykIK", styk_doc::json::parse(br#"{"55":{"enabled":true,"chainLength":2}}"#).unwrap());}
                "join-cycle" => {object.set("join", styk_doc::json::parse(br#"{"target_object_slot":1,"target_unique_id":2,"target_handle_id":55}"#).unwrap());}
                _ => {object.set("join", styk_doc::json::parse(br#"{"target_object_slot":999,"target_unique_id":999,"target_handle_id":55}"#).unwrap());}
            }
        }
        editor.take_events();let before = snapshot(&mut editor);
        for (method, args) in &calls {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call(method, args)));
            assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "{feature} {method}: {result:?}");
            assert_eq!(snapshot(&mut editor), before, "{feature} {method} changed the open translation");refusals += 1;
        }
    }
    assert_eq!(refusals, 42);
}

#[test]
fn unrecorded_origin_patches_gestures_metadata_and_pose_modes_stay_closed() {
    let mut editor = Editor::new(document(), crate::Options::default());
    editor.call("select", &[Value::Num(1.0), Value::Num(3.0)]).unwrap();
    editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(4.125), Value::Num(-2.75)]).unwrap();editor.take_events();
    let before = snapshot(&mut editor);
    for patch in [br#"{"stretch":{"min":0}}"#.as_slice(),br#"{"angleLock":null,"orientation":"world"}"#.as_slice(),br#"{}"#.as_slice()] {
        assert!(matches!(editor.call("setRigBehavior", &[styk_doc::json::parse(patch).unwrap()]), Err(EditError::Unported(_))));
        assert_eq!(snapshot(&mut editor), before);
    }
    editor.call("cancelDrag", &[]).unwrap();editor.call("beginDrag", &[Value::str("Foreign constraint gesture")]).unwrap();editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(editor.call("setAngleLock", &[Value::str("figure")]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut editor), before);
    editor.call("cancelDrag", &[]).unwrap();editor.call("setAngleLock", &[Value::str("figure")]).unwrap();editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(editor.call("rotateJoint", &[Value::Num(0.125)]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut editor), before);
    editor.set_selection_metadata(&styk_doc::json::parse(br#"{"segmentIds":[55,66]}"#).unwrap()).unwrap();editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(editor.call("setAngleLock", &[Value::str("off")]), Err(EditError::Unported(_))));assert_eq!(snapshot(&mut editor), before);
}
