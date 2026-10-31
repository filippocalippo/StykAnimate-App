//! The figure-bounds callbacks of alignment and camera centering, recorded in the actual editor
//! command path: the app's callback is measured by the engine and must give the editor's result
//! at every step; measurements a callback already made are replayed (and refused when they do not
//! fit the call).
#[test]
fn measured_bounds_recordings_match_every_step() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["camera-center-measured-sheet", "figure-align-measured-sheet", "figure-align-measured-native", "camera-center-media-sheet"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
        println!("{name}: {} / {} steps matched", outcome.matched, outcome.steps);
    }
}

#[test]
fn missing_or_different_recorded_measurements_refuse_atomically_with_open_gesture() {
    use styk_doc::Value;
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let reference = styk_doc::json::parse(&std::fs::read(folder.join("camera-center-measured-sheet.reference.json")).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let step = reference.get("steps").unwrap().item(2).unwrap();
    // What a shadowing facade hands over for that call of the app's callback: the measurements it
    // made, figure by figure, in the order the editor asked for them.
    let recorded = styk_doc::json::parse(br#"{"@measuredBounds":{"version":1,"method":"centerCamera","input":["both",[0,1]],"options":{"boundsOf":null},"tick":0,"frameIndex":0,"selectedUids":[2,3],"samples":[{"uid":3,"bounds":{"minX":474,"minY":224,"maxX":549,"maxY":383}},{"uid":2,"bounds":{"minX":194,"minY":270,"maxX":269,"maxY":429}},{"uid":3,"bounds":{"minX":439,"minY":264,"maxX":514,"maxY":423}},{"uid":2,"bounds":{"minX":224,"minY":255,"maxX":299,"maxY":414}}]}}"#).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let state = first.get("state").unwrap();
    for variant in ["missing", "uid", "extra", "tick", "input", "options"] {
        let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
        let counter = |key| state.get(key).unwrap().as_f64().unwrap() as u64;
        editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
        editor.call("selectMany", &[Value::array(vec![Value::Num(2.0), Value::Num(3.0)])]).unwrap();
        editor.call("beginDrag", &[]).unwrap(); editor.call("moveSelection", &[Value::Num(5.0), Value::Num(3.0)]).unwrap();
        editor.take_events();
        let before = (editor.report_json(), editor.state());
        let mut args: Vec<Value> = step.get("boundsArgs").unwrap().elements().unwrap().iter().collect();
        args[2].make_obj().unwrap().set("boundsOf", recorded.clone());
        let data = args[2].make_obj().unwrap().get_mut("boundsOf").unwrap().make_obj().unwrap().get_mut("@measuredBounds").unwrap().make_obj().unwrap();
        match variant {
            "missing" => data.set("samples", Value::array(Vec::new())),
            "uid" => data.get_mut("samples").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("uid", Value::Num(99.0)),
            "extra" => { let samples = data.get_mut("samples").unwrap().make_arr().unwrap(); samples.push(samples[0].clone()); },
            "tick" => data.set("tick", Value::Num(1.0)),
            "input" => data.set("input", Value::array(vec![Value::str("x"), Value::array(vec![Value::Num(0.0)])])),
            "options" => data.get_mut("options").unwrap().make_obj().unwrap().set("ticks", Value::array(vec![Value::Num(1.0)])),
            _ => unreachable!(),
        }
        assert!(matches!(editor.call("centerCamera", &args), Err(styk_edit::EditError::Unported(_))), "{variant}");
        assert_eq!((editor.report_json(), editor.state()), before, "{variant}: partial gesture publication");
        assert!(editor.take_events().is_empty(), "{variant}: leaked change events");
        assert_eq!(editor.call("cancelDrag", &[]).unwrap(), Value::Bool(true), "{variant}: gesture lost");
    }
}
