#[test]
fn joined_spatial_target_and_feet_recordings_match_every_step() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["ik-spatial-joined-parent-sheet", "ik-spatial-joined-child-sheet", "ik-spatial-joined-free-sheet", "ik-spatial-joined-mirrored-sheet", "ik-spatial-joined-negative-sheet", "ik-spatial-joined-native", "ik-spatial-perspective-target-sheet", "ik-spatial-perspective-target-native"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
        println!("{name}: {} / {} steps matched", outcome.matched, outcome.steps);
    }
}

/// A bone of a figure with inverse-kinematics controllers, posed in perspective inside an open gesture: the pose is
/// part of the gesture, which cancels without a trace and commits as one entry. Joint 3 is a bone the editor does not
/// pose by pointing at it (`poseJoint` answers false and nothing changes).
#[test]
fn perspective_bones_pose_inside_the_open_gesture() {
    use styk_doc::Value;
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let name = "ik-spatial-perspective-target-sheet";
    let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let state = first.get("state").unwrap();
    let counter = |key| state.get(key).unwrap().as_f64().unwrap() as u64;
    for (joint, poses) in [(3.0, false), (6.0, true), (9.0, true)] {
        for commit in [false, true] {
            let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
            let original = editor.report_json();
            editor.call("select", &[Value::Num(1.0), Value::Num(joint)]).unwrap();
            editor.call("beginDrag", &[]).unwrap();
            editor.call("moveSelection", &[Value::Num(3.0), Value::Num(2.0)]).unwrap();
            editor.take_events();
            let before = (editor.report_json(), editor.state(), editor.draft_figures(), editor.drag_value());
            let label = format!("joint {joint}, {}", if commit { "committed" } else { "cancelled" });
            assert_eq!(editor.call("poseJoint", &[Value::Num(230.0), Value::Num(190.0)]).unwrap(), Value::Bool(poses), "{label}");
            if poses {
                assert_ne!(editor.draft_figures(), before.2, "{label}: the bone was not posed in the live frame");
                assert!(!editor.take_events().is_empty(), "{label}: the pose emitted no changes");
            } else {
                assert_eq!((editor.report_json(), editor.state(), editor.draft_figures(), editor.drag_value()), before, "{label}: the call changed the live pose");
                assert!(editor.take_events().is_empty(), "{label}: the call emitted changes");
            }
            assert_eq!(editor.report_json(), original, "{label}: the open gesture changed the document");
            if commit {
                assert_eq!(editor.call("commitDrag", &[]).unwrap(), Value::Bool(true), "{label}: the original gesture was lost");
                assert!(editor.state().can_undo, "{label}: the gesture left no history");
                assert_eq!(editor.call("undo", &[]).unwrap(), Value::Bool(true), "{label}");
            } else {
                assert_eq!(editor.call("cancelDrag", &[]).unwrap(), Value::Bool(true), "{label}: the original gesture was lost");
                assert!(!editor.state().can_undo, "{label}: the cancelled gesture committed history");
            }
            assert_eq!(editor.report_json(), original, "{label}: nothing is left of the gesture");
        }
    }
}
