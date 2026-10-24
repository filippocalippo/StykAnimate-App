//! Saved native origin gestures keep the canonical and actual displayed views exact.
use std::path::Path;

#[test]
fn saved_native_origin_motion_matches_both_original_recorded_tapes() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "support"] {
        let name = format!("origin-motion-saved-{kind}-native");
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
            "{name}: {} / {} exact steps",
            outcome.matched, outcome.steps
        );
    }
}

fn document() -> styk_doc::Value {
    styk_doc::json::parse(
        &std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/edit/origin-motion-saved-layout-native.document.json"),
        )
        .unwrap(),
    )
    .unwrap()
}
fn target() -> styk_doc::Value {
    styk_doc::json::parse(br#"{"kind":"node","uid":1,"handleId":44,"joint":3}"#).unwrap()
}
fn snapshot(
    editor: &mut styk_edit::Editor,
) -> (
    String,
    styk_doc::Value,
    styk_doc::Value,
    Option<styk_doc::Value>,
    Vec<styk_doc::Value>,
) {
    (
        editor.report_json(),
        editor.state_value(),
        editor.drag_value(),
        editor.motion_display_frame_worker().unwrap(),
        editor.take_events(),
    )
}
#[test]
fn saved_native_unrecorded_projection_metadata_and_headers_refuse_atomically() {
    use styk_doc::Value;
    use styk_edit::{EditError, Editor, Options};
    for options in [
        Options {
            property_channels: true,
            ..Options::default()
        },
        Options {
            layer_timeline: true,
            ..Options::default()
        },
    ] {
        let mut editor = Editor::new(document(), options);
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(matches!(
            editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
            Err(EditError::Unported(_))
        ));
        assert_eq!(snapshot(&mut editor), before);
    }
    for metadata in [
        br#"{"polygonSelection":{"uid":1,"index":0}}"#.as_slice(),
        br#"{"segmentIds":[22,44]}"#.as_slice(),
        br#"{"branch":true}"#.as_slice(),
    ] {
        let mut editor = Editor::new(document(), Options::default());
        editor
            .call("select", &[Value::Num(1.0), Value::Num(0.0)])
            .unwrap();
        editor
            .set_selection_metadata(&styk_doc::json::parse(metadata).unwrap())
            .unwrap();
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(matches!(
            editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
            Err(EditError::Unported(_))
        ));
        assert_eq!(snapshot(&mut editor), before);
    }
    for property in ["opacity", "turn", "native-unrecorded"] {
        let mut report = document();
        let channel = &mut report
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
            .unwrap()[1];
        channel
            .make_obj()
            .unwrap()
            .set("property", Value::str(property));
        channel
            .make_obj()
            .unwrap()
            .set("id", Value::str(&format!("figure:1:{property}")));
        let mut editor = Editor::new(report, Options::default());
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(matches!(
            editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
            Err(EditError::Unported(_))
        ));
        assert_eq!(snapshot(&mut editor), before);
    }
}
#[test]
fn saved_native_live_invalid_and_unrecorded_calls_preserve_both_views() {
    use styk_doc::Value;
    use styk_edit::{EditError, Editor, Options};
    let mut editor = Editor::new(document(), Options::default());
    editor
        .call("select", &[Value::Num(1.0), Value::Num(1.0)])
        .unwrap();
    editor.call("seek", &[Value::Num(3.5)]).unwrap();
    editor
        .call("beginMotionPathEdit", &[target(), Value::Num(3.0)])
        .unwrap();
    editor
        .call(
            "updateMotionPathEdit",
            &[
                styk_doc::json::parse(br#"{"x":239.5039520263672,"y":246.41033935546875}"#)
                    .unwrap(),
            ],
        )
        .unwrap();
    editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(
        editor.call(
            "updateMotionPathEdit",
            &[styk_doc::json::parse(br#"{"x":"invalid","y":0}"#).unwrap()]
        ),
        Err(EditError::Invalid(_))
    ));
    assert_eq!(snapshot(&mut editor), before);
    for method in ["moveSelection", "setOrigin", "addAnimationKey", "beginDrag"] {
        assert!(
            matches!(editor.call(method, &[]), Err(EditError::Unported(_))),
            "{method}"
        );
        assert_eq!(snapshot(&mut editor), before);
    }
}
#[test]
fn saved_native_future_retained_complex_poses_refuse_before_live_commit() {
    use styk_doc::Value;
    use styk_edit::{EditError, Editor, Options};
    for kind in ["rig", "drawing", "spatialMesh", "poseChoices", "movieclip"] {
        let mut report = document();
        let mut figure = report.get("figure_types").unwrap().item(0).unwrap();
        figure
            .make_obj()
            .unwrap()
            .set("figure_type_id", Value::Num(9.0));
        if kind == "rig" {
            figure
                .make_obj()
                .unwrap()
                .get_mut("segments")
                .unwrap()
                .make_arr()
                .unwrap()[0]
                .make_obj()
                .unwrap()
                .set("_stykRig", Value::object(styk_doc::Obj::new()));
        } else {
            figure
                .make_obj()
                .unwrap()
                .get_mut("_styk")
                .unwrap()
                .make_obj()
                .unwrap()
                .set(kind, Value::object(styk_doc::Obj::new()));
        }
        report
            .make_obj()
            .unwrap()
            .get_mut("figure_types")
            .unwrap()
            .make_arr()
            .unwrap()
            .push(figure);
        report
            .make_obj()
            .unwrap()
            .get_mut("_styk")
            .unwrap()
            .make_obj()
            .unwrap()
            .get_mut("frameSources")
            .unwrap()
            .make_obj()
            .unwrap()
            .get_mut("frame-6")
            .unwrap()
            .make_obj()
            .unwrap()
            .get_mut("objects")
            .unwrap()
            .make_arr()
            .unwrap()[0]
            .make_obj()
            .unwrap()
            .set("figure_type_id", Value::Num(9.0));
        let mut editor = Editor::new(report, Options::default());
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(
            matches!(
                editor.call("beginMotionPathEdit", &[target(), Value::Num(9.0)]),
                Err(EditError::Unported(_))
            ),
            "{kind}"
        );
        assert_eq!(snapshot(&mut editor), before);
    }
}
#[test]
fn saved_native_unrecorded_pose_modifiers_refuse_atomically() {
    use styk_doc::Value;
    use styk_edit::{EditError, Editor, Options};
    for field in ["useBasePose", "maskedRanges", "orderAnchor", "clipEnd"] {
        let mut report = document();
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
            .set(field, Value::Bool(true));
        let mut editor = Editor::new(report, Options::default());
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(
            matches!(
                editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
                Err(EditError::Unported(_))
            ),
            "{field}"
        );
        assert_eq!(snapshot(&mut editor), before);
    }
}
#[test]
fn saved_native_motion_begin_preserves_an_open_scalar_preview() {
    use styk_doc::Value;
    use styk_edit::{EditError, Editor, Options};
    // The scalar-only owner is independently recorded; this motion combination
    // stays refused until its own native capture recording exists.
    let mut report = document();
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
        .unwrap()
        .retain(|channel| channel.get("property").and_then(Value::as_str) != Some("pose"));
    let mut editor = Editor::new(report, Options::default());
    editor.call("select", &[Value::Num(1.0)]).unwrap();
    let figure = styk_doc::json::parse(br#"{"kind":"figure","uid":1}"#).unwrap();
    editor
        .call("beginAnimationEdit", &[figure, Value::str("x")])
        .unwrap();
    editor
        .call("previewAnimationEdit", &[Value::Num(345.125)])
        .unwrap();
    editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(
        editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut editor), before);
}
