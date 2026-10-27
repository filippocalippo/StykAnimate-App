#[test]
fn sprite_attachment_matches_the_editor_topology_owner() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in [
        "sprite-segment-native",
        "sprite-segment-sheet",
        "sprite-segment-retained-native",
        "sprite-segment-sparse-native",
        "sprite-segment-locked-sheet",
        "sprite-segment-origin-sheet",
        "sprite-segment-origin-native",
    ] {
        let reference = styk_doc::json::parse(
            &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
        )
        .unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(
            outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(),
            "{name}: {outcome:#?}"
        );
        println!(
            "{name}: {} / {} steps matched",
            outcome.matched, outcome.steps
        );
    }
}

fn setup(name: &str) -> (styk_edit::Editor, styk_doc::Value) {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let reference = styk_doc::json::parse(
        &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
    )
    .unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report =
        styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut editor = styk_edit::Editor::new(
        report,
        styk_edit::Options {
            property_channels: name.ends_with("sheet"),
            layer_timeline: name.ends_with("sheet"),
            auto_key: false,
        },
    );
    editor.set_view(
        0.0,
        0,
        styk_edit::Selection {
            uid: Some(1),
            uids: vec![1],
            joint: 2,
        },
    );
    let source = reference
        .get("steps")
        .unwrap()
        .item(2)
        .unwrap()
        .get("call")
        .unwrap()
        .item(1)
        .unwrap();
    (editor, source)
}

#[test]
fn a_sprite_attached_over_derived_runtime_pose_keeps_its_lengths_and_bends() {
    use styk_doc::Value;
    let (editor, source) = setup("sprite-segment-native");
    let mut report = styk_doc::json::parse(editor.report_json().as_bytes()).unwrap();
    let frame = report
        .make_obj()
        .unwrap()
        .get_mut("keyframes")
        .unwrap()
        .make_arr()
        .unwrap()
        .get_mut(0)
        .unwrap()
        .make_obj()
        .unwrap();
    let object = frame
        .get_mut("objects")
        .unwrap()
        .make_arr()
        .unwrap()
        .get_mut(0)
        .unwrap()
        .make_obj()
        .unwrap();
    object.set("len_flag", Value::Num(0.0));
    object.set("bend_flag", Value::Num(0.0));
    object.set(
        "runtime_segments",
        styk_doc::json::parse(b"[{\"length\":123.5,\"bend_rad\":0.15}]").unwrap(),
    );
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
    editor.set_view(
        0.0,
        0,
        styk_edit::Selection {
            uid: Some(1),
            uids: vec![1],
            joint: 2,
        },
    );
    editor.call("addSpriteSegment", &[source]).unwrap();
    // The lengths and bends the pose only held in its derived cache become its own, ahead of the sprite's.
    let after = styk_doc::json::parse(editor.report_json().as_bytes()).unwrap();
    let object = after.path(&["keyframes"]).unwrap().item(0).unwrap().get("objects").unwrap().item(0).unwrap();
    assert!(object.get("runtime_segments").is_none());
    assert_eq!(object.get("len_flag").and_then(Value::as_f64), Some(1.0));
    assert_eq!(object.get("lengths").unwrap().item(0).and_then(|v| v.as_f64()), Some(123.5));
    assert_eq!(object.get("bend_flag").and_then(Value::as_f64), Some(1.0));
    assert_eq!(object.get("bends").unwrap().item(0).and_then(|v| v.as_f64()), Some(0.15));
}
