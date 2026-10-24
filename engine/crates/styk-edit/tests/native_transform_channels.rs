use styk_doc::Value;
use styk_edit::{EditError, Editor, Options};

fn reference(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../tests/edit/native-transform-channels-{name}.reference.json"
    ));
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

fn document(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../tests/edit/native-transform-channels-{name}.document.json"
    ));
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

fn json(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).unwrap()
}

#[test]
fn native_scalar_preview_and_cancel_share_untouched_document_heads() {
    let mut editor = Editor::new(document("support-saved"), Options::default());
    let before = editor.report().clone();
    editor
        .call("select", &[Value::Num(1.0), Value::Num(-1.0)])
        .unwrap();
    editor
        .call(
            "beginAnimationEdit",
            &[json(r#"{"kind":"figure","uid":1}"#), Value::str("x")],
        )
        .unwrap();
    editor
        .call("previewAnimationEdit", &[Value::Num(341.25)])
        .unwrap();
    for path in [
        vec!["figure_types"],
        vec!["keyframes"],
        vec!["_styk", "layers"],
    ] {
        assert!(
            editor
                .report()
                .path(&path)
                .unwrap()
                .same_node(before.path(&path).unwrap()),
            "{path:?}"
        );
    }
    let old_channels = before.path(&["_styk", "animation", "channels"]).unwrap();
    let new_channels = editor
        .report()
        .path(&["_styk", "animation", "channels"])
        .unwrap();
    for index in 1..old_channels.array_len().unwrap() {
        assert!(
            new_channels
                .item(index)
                .unwrap()
                .same_node(&old_channels.item(index).unwrap()),
            "untouched channel {index}"
        );
    }
    assert_eq!(
        editor
            .report()
            .path(&["_styk", "animation", "futureNativeAnimation"]),
        before.path(&["_styk", "animation", "futureNativeAnimation"])
    );
    editor.call("cancelAnimationEdit", &[]).unwrap();
    assert!(
        editor
            .report()
            .path(&["_styk", "animation"])
            .unwrap()
            .same_node(before.path(&["_styk", "animation"]).unwrap())
    );
}

#[test]
fn unrecorded_native_targets_refuse_before_committing_an_open_gesture() {
    let mut count = 0;
    for kind in ["future-rig", "future-rig-joined"] {
        let mut editor = Editor::new(document(kind), Options::default());
        editor
            .call("select", &[Value::Num(1.0), Value::Num(-1.0)])
            .unwrap();
        editor.call("beginTranslationDrag", &[]).unwrap();
        editor
            .call("moveSelection", &[Value::Num(2.125), Value::Num(-1.25)])
            .unwrap();
        editor.take_events();
        let before = (
            editor.report_json(),
            editor.state_value(),
            editor.drag_value(),
            editor.draft_figures(),
        );
        for (uid, property) in [
            (3, "x"),
            (2, "x"),
            (1, "rotation"),
            (999, "x"),
            (1, "opacity"),
        ] {
            if kind == "future-rig" && [(2, "x"), (1, "rotation")].contains(&(uid, property)) {
                continue;
            }
            if kind == "future-rig-joined" && (uid, property) == (1, "rotation") {
                continue;
            }
            let target = json(&format!(r#"{{"kind":"figure","uid":{uid}}}"#));
            let entry = json(&format!(
                r#"{{"target":{{"kind":"figure","uid":{uid}}},"property":"{property}","tick":8,"value":401.25}}"#
            ));
            for (method, args) in [
                (
                    "addAnimationKey",
                    vec![
                        target.clone(),
                        Value::str(property),
                        Value::Num(8.0),
                        Value::Num(401.25),
                    ],
                ),
                ("addAnimationKeys", vec![Value::array(vec![entry])]),
            ] {
                assert!(
                    matches!(editor.call(method, &args), Err(EditError::Unported(_))),
                    "{kind} {uid} {property} {method}"
                );
                assert_eq!(
                    (
                        editor.report_json(),
                        editor.state_value(),
                        editor.drag_value(),
                        editor.draft_figures()
                    ),
                    before,
                    "{kind} {uid} {property} {method}"
                );
                assert!(editor.take_events().is_empty());
                count += 1;
            }
        }
    }
    assert_eq!(count, 14);
}

#[test]
fn native_scalar_scope_keeps_projection_pose_style_and_optional_selection_refused() {
    let target = json(r#"{"kind":"figure","uid":1}"#);
    for options in [
        Options {
            property_channels: true,
            layer_timeline: false,
            auto_key: false,
        },
        Options {
            property_channels: false,
            layer_timeline: true,
            auto_key: false,
        },
    ] {
        let mut editor = Editor::new(document("plain-new"), options);
        let before = (editor.report_json(), editor.state_value());
        for method in ["beginAnimationEdit", "addAnimationKey", "addAnimationKeys"] {
            assert!(
                matches!(
                    editor.call(method, &[target.clone(), Value::str("x")]),
                    Err(EditError::Unported(_))
                ),
                "{method}"
            );
            assert_eq!((editor.report_json(), editor.state_value()), before);
            assert!(editor.take_events().is_empty());
        }
    }
    let mut editor = Editor::new(document("support-saved"), Options::default());
    editor
        .call("select", &[Value::Num(1.0), Value::Num(-1.0)])
        .unwrap();
    editor
        .call("beginAnimationEdit", &[target.clone(), Value::str("x")])
        .unwrap();
    editor
        .call("previewAnimationEdit", &[Value::Num(332.125)])
        .unwrap();
    editor.take_events();
    let before = (editor.report_json(), editor.state_value());
    for method in [
        "moveSelection",
        "setOrigin",
        "moveSelectionInFrames",
        "beginMotionPathEdit",
        "poseJoint",
        "updateFigureStyle",
    ] {
        assert!(
            matches!(editor.call(method, &[]), Err(EditError::Unported(_))),
            "{method}"
        );
        assert_eq!((editor.report_json(), editor.state_value()), before);
        assert!(editor.take_events().is_empty());
    }
    editor
        .set_selection_metadata(&json(
            r#"{"polygonSelection":{"uid":1,"index":0,"id":31,"typeId":1,"unknown":true}}"#,
        ))
        .unwrap();
    let before = (editor.report_json(), editor.state_value());
    assert!(matches!(
        editor.call("commitAnimationEdit", &[]),
        Err(EditError::Unported(_))
    ));
    assert_eq!((editor.report_json(), editor.state_value()), before);
    assert!(editor.take_events().is_empty());
    editor
        .set_selection_metadata(&json(r#"{"branch":{"uid":2,"joint":1,"unknown":true}}"#))
        .unwrap();
    let before = (editor.report_json(), editor.state_value());
    assert!(matches!(
        editor.call("commitAnimationEdit", &[]),
        Err(EditError::Unported(_))
    ));
    assert_eq!((editor.report_json(), editor.state_value()), before);
    assert!(editor.take_events().is_empty());
}

#[test]
fn unavailable_native_channel_tables_refuse_without_committing_a_drag() {
    for malformed in [
        Value::array(vec![Value::str("keep unknown raw item")]),
        json(r#"{"channels":17,"future":true}"#),
    ] {
        let mut report = document("plain-new");
        report
            .make_obj()
            .unwrap()
            .get_mut("_styk")
            .unwrap()
            .make_obj()
            .unwrap()
            .set("animation", malformed);
        let mut editor = Editor::new(report, Options::default());
        editor
            .call("select", &[Value::Num(1.0), Value::Num(-1.0)])
            .unwrap();
        editor.call("beginTranslationDrag", &[]).unwrap();
        editor
            .call("moveSelection", &[Value::Num(2.125), Value::Num(-1.25)])
            .unwrap();
        editor.take_events();
        let before = (
            editor.report_json(),
            editor.state_value(),
            editor.drag_value(),
        );
        assert!(matches!(
            editor.call(
                "beginAnimationEdit",
                &[json(r#"{"kind":"figure","uid":1}"#), Value::str("x")]
            ),
            Err(EditError::Unported(_))
        ));
        assert_eq!(
            (
                editor.report_json(),
                editor.state_value(),
                editor.drag_value()
            ),
            before
        );
        assert!(editor.take_events().is_empty());
    }
    for invalid_id in [Value::Null, Value::str("unrecorded noncanonical id")] {
        let mut report = document("support-saved");
        report
            .make_obj()
            .unwrap()
            .get_mut("_styk")
            .unwrap()
            .make_obj()
            .unwrap()
            .get_mut("animation")
            .unwrap()
            .make_obj()
            .unwrap()
            .get_mut("channels")
            .unwrap()
            .make_arr()
            .unwrap()[0]
            .make_obj()
            .unwrap()
            .set("id", invalid_id);
        let mut editor = Editor::new(report, Options::default());
        let before = (editor.report_json(), editor.state_value());
        assert!(matches!(
            editor.call(
                "beginAnimationEdit",
                &[json(r#"{"kind":"figure","uid":1}"#), Value::str("x")]
            ),
            Err(EditError::Unported(_))
        ));
        assert_eq!((editor.report_json(), editor.state_value()), before);
        assert!(editor.take_events().is_empty());
    }
}

#[test]
fn unrecorded_invalid_key_side_effects_keep_an_open_property_gesture_intact() {
    let mut editor = Editor::new(document("support-saved"), Options::default());
    let target = json(r#"{"kind":"figure","uid":1}"#);
    editor
        .call("select", &[Value::Num(1.0), Value::Num(-1.0)])
        .unwrap();
    editor
        .call("beginAnimationEdit", &[target.clone(), Value::str("x")])
        .unwrap();
    editor
        .call("previewAnimationEdit", &[Value::Num(332.125)])
        .unwrap();
    editor.take_events();
    let before = (editor.report_json(), editor.state_value());
    for (tick, value, options) in [
        (Value::Num(0.0), Value::str("invalid"), Value::Null),
        (Value::Num(3.5), Value::Num(1.25), Value::Null),
        (
            Value::Num(0.0),
            Value::Num(1.25),
            json(r#"{"exactTarget":"invalid"}"#),
        ),
    ] {
        assert!(matches!(
            editor.call(
                "addAnimationKey",
                &[target.clone(), Value::str("y"), tick, value, options]
            ),
            Err(EditError::Unported(_))
        ));
        assert_eq!((editor.report_json(), editor.state_value()), before);
        assert!(editor.take_events().is_empty());
    }
    let entries = json(
        r#"[{"target":{"kind":"figure","uid":2},"property":"scale","tick":0,"value":1.05},{"target":{"kind":"figure","uid":1},"property":"y","tick":0,"value":"invalid"}]"#,
    );
    assert!(matches!(
        editor.call("addAnimationKeys", &[entries]),
        Err(EditError::Unported(_))
    ));
    assert_eq!((editor.report_json(), editor.state_value()), before);
    assert!(editor.take_events().is_empty());
    editor
        .call("previewAnimationEdit", &[Value::Num(333.25)])
        .unwrap();
    assert_ne!(
        (editor.report_json(), editor.state_value()),
        before,
        "refusal must preserve the existing editable gesture"
    );
}

#[test]
fn native_saved_transform_channels_match_every_editor_step() {
    let mut total = 0;
    for kind in ["plain", "layout", "offsets", "support"] {
        for mode in ["new", "saved"] {
            let outcome = styk_edit::replay::replay(&reference(&format!("{kind}-{mode}"))).unwrap();
            assert!(
                outcome.passed() && outcome.unported.is_none() && outcome.matched == outcome.steps,
                "{kind}/{mode}: {outcome:#?}"
            );
            total += outcome.steps;
        }
    }
    let outcome = styk_edit::replay::replay(&reference("future-plain")).unwrap();
    assert!(
        outcome.passed() && outcome.unported.is_none() && outcome.matched == outcome.steps,
        "future ordinary: {outcome:#?}"
    );
    total += outcome.steps;
    println!("native transform channels: {total} exact steps");
}
