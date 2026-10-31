#[test]
fn native_builder_tokens_match_the_exported_editor_owner() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in [
        "native-builder-token-native",
        "native-builder-token-sheet",
        "native-builder-token-locked",
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

fn editor(name: &str, channels: bool) -> styk_edit::Editor {
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
            property_channels: channels,
            layer_timeline: name.ends_with("sheet"),
            auto_key: false,
        },
    );
    let state = first.get("state").unwrap();
    let counter = |key| state.get(key).unwrap().as_f64().unwrap() as u64;
    editor.set_counters(
        counter("layerRevision"),
        counter("nextFrameIdentity"),
        counter("nextUid"),
    );
    editor.set_view(
        0.0,
        0,
        styk_edit::Selection {
            uid: Some(1),
            uids: vec![1],
            joint: 1,
        },
    );
    editor
}

#[test]
fn unported_calls_preserve_the_native_token_and_its_identity() {
    use styk_doc::Value;
    let mut editor = editor("native-builder-token-native", false);
    let original = editor.report_json();
    let token = editor
        .call("beginNativePropertyEdit", &[Value::str("thickness")])
        .unwrap()
        .get("token")
        .unwrap()
        .clone();
    editor
        .call(
            "previewNativePropertyEdit",
            &[token.clone(), Value::Num(12.5)],
        )
        .unwrap();
    editor.take_events();
    let before = (editor.report_json(), editor.state(), editor.drag_value());
    let options = styk_doc::json::parse(b"{\"indices\":[0,1]}").unwrap();
    for (method, args) in [
        ("beginNativePropertyEdit", vec![Value::str("root_x")]),
        (
            "beginNativePropertyEdit",
            vec![Value::str("thickness"), options],
        ),
        (
            "updateObject",
            vec![styk_doc::json::parse(b"{\"root_x\":40}").unwrap()],
        ),
    ] {
        assert!(
            matches!(
                editor.call(method, &args),
                Err(styk_edit::EditError::Unported(_))
            ),
            "{method}"
        );
        assert_eq!(
            (editor.report_json(), editor.state(), editor.drag_value()),
            before
        );
        assert!(editor.take_events().is_empty());
    }
    assert_eq!(
        editor
            .call(
                "previewNativePropertyEdit",
                &[token.clone(), Value::Num(13.5)]
            )
            .unwrap(),
        Value::Bool(true)
    );
    assert_eq!(
        editor.call("cancelNativePropertyEdit", &[token]).unwrap(),
        Value::Bool(true)
    );
    assert_eq!(editor.report_json(), original);
    let next = editor
        .call("beginNativePropertyEdit", &[Value::str("outline_width")])
        .unwrap();
    assert_eq!(
        next.get("token"),
        Some(&Value::Num(2.0)),
        "a refused call consumed a token identity"
    );
    assert!(!editor.state().can_undo);
}

#[test]
fn refusing_an_unrecorded_token_keeps_the_changed_pose_gesture() {
    use styk_doc::Value;
    for (name, channels, key) in [
        ("native-builder-token-native", false, "root_x"),
        ("native-builder-token-sheet", true, "thickness"),
    ] {
        let mut editor = editor(name, channels);
        let original = editor.report_json();
        editor.call("beginDrag", &[]).unwrap();
        editor.call("rotateJoint", &[Value::Num(0.17)]).unwrap();
        editor.take_events();
        let before = (
            editor.report_json(),
            editor.state(),
            editor.draft_figures(),
            editor.drag_value(),
        );
        assert!(
            matches!(
                editor.call("beginNativePropertyEdit", &[Value::str(key)]),
                Err(styk_edit::EditError::Unported(_))
            ),
            "{name}"
        );
        assert_eq!(
            (
                editor.report_json(),
                editor.state(),
                editor.draft_figures(),
                editor.drag_value()
            ),
            before
        );
        assert!(editor.take_events().is_empty());
        assert_eq!(editor.call("cancelDrag", &[]).unwrap(), Value::Bool(true));
        assert_eq!(editor.report_json(), original);
        assert!(!editor.state().can_undo);
    }
}

#[test]
fn native_origin_tokens_are_not_admitted_by_the_builder_slice() {
    use styk_doc::Value;
    let mut editor = editor("native-builder-token-origin", false);
    let before = (editor.report_json(), editor.state());
    assert!(matches!(
        editor.call("beginNativePropertyEdit", &[Value::str("thickness")]),
        Err(styk_edit::EditError::Unported(_))
    ));
    assert_eq!((editor.report_json(), editor.state()), before);
    assert!(editor.take_events().is_empty());
}
