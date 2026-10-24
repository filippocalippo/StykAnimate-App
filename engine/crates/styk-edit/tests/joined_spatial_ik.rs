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

#[test]
fn unrecorded_perspective_bones_keep_the_open_gesture() {
    use styk_doc::Value;
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for (name, joint, method, arguments) in [
        ("ik-spatial-perspective-target-sheet", 3.0, "poseJoint", "[230,190]"),
    ] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        let sheet = name.ends_with("sheet");
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: sheet, layer_timeline: sheet, auto_key: false });
        let state = first.get("state").unwrap();
        let counter = |key| state.get(key).unwrap().as_f64().unwrap() as u64;
        editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
        editor.call("select", &[Value::Num(1.0), Value::Num(joint)]).unwrap();
        editor.call("beginDrag", &[]).unwrap();
        editor.call("moveSelection", &[Value::Num(3.0), Value::Num(2.0)]).unwrap();
        editor.take_events();
        let before = (editor.report_json(), editor.state(), editor.draft_figures(), editor.drag_value());
        let args = styk_doc::json::parse(arguments.as_bytes()).unwrap();
        let args: Vec<Value> = args.elements().unwrap().iter().collect();
        assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{name}: {method}");
        assert_eq!((editor.report_json(), editor.state(), editor.draft_figures(), editor.drag_value()), before, "{name}: the refusal changed the live pose");
        assert!(editor.take_events().is_empty(), "{name}: the refusal emitted changes");
        assert_eq!(editor.call("cancelDrag", &[]).unwrap(), Value::Bool(true), "{name}: the original gesture was lost");
        assert!(!editor.state().can_undo, "{name}: the refusal committed history");
    }
}
