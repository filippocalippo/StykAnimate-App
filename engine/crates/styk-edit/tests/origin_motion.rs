//! Remote-time origin sheet gestures preserve both authoritative and displayed poses.
use std::path::Path;
use styk_doc::{Obj, Value};
use styk_edit::{EditError, Editor, Options};

fn document(name: &str) -> Value {
    styk_doc::json::parse(
        &std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../tests/edit/{name}.document.json")),
        )
        .unwrap(),
    )
    .unwrap()
}

fn target() -> Value {
    let mut target = Obj::new();
    target.set("kind", Value::str("node"));
    target.set("uid", Value::Num(1.0));
    target.set("handleId", Value::Num(44.0));
    target.set("joint", Value::Num(3.0));
    Value::object(target)
}

fn snapshot(editor: &mut Editor) -> (String, Value, Value, Vec<Value>) {
    (
        editor.report_json(),
        editor.state_value(),
        editor.drag_value(),
        editor.take_events(),
    )
}

#[test]
fn origin_sheet_motion_matches_both_recorded_views_at_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in [
        "layout",
        "offsets",
        "support",
        "support-pinned",
        "support-free",
        "saved-layout",
        "saved-support",
    ] {
        for mode in ["sheet", "autokey-sheet"] {
            let name = format!("origin-motion-{kind}-{mode}");
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
}

#[test]
fn unrecorded_complex_motion_refuses_without_committing_an_open_drag() {
    for kind in [
        "rig",
        "poseChoices",
        "spatialMesh",
        "drawing",
        "movieclip",
        "joinedRig",
        "poseChoiceSegment",
    ] {
        let mut report = document("origin-motion-layout-sheet");
        let index = usize::from(kind == "joinedRig");
        let figure = report
            .make_obj()
            .unwrap()
            .get_mut("figure_types")
            .unwrap()
            .make_arr()
            .unwrap()[index]
            .make_obj()
            .unwrap();
        if ["rig", "joinedRig", "poseChoiceSegment"].contains(&kind) {
            figure.get_mut("segments").unwrap().make_arr().unwrap()[0]
                .make_obj()
                .unwrap()
                .set(
                    if kind == "poseChoiceSegment" {
                        "_stykPoseChoice"
                    } else {
                        "_stykRig"
                    },
                    Value::object(Obj::new()),
                );
        } else {
            figure
                .get_mut("_styk")
                .unwrap()
                .make_obj()
                .unwrap()
                .set(kind, Value::object(Obj::new()));
        }
        let mut editor = Editor::new(
            report,
            Options {
                property_channels: true,
                layer_timeline: true,
                ..Options::default()
            },
        );
        editor
            .call("select", &[Value::Num(1.0), Value::Num(1.0)])
            .unwrap();
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(
            matches!(
                editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
                Err(EditError::Unported(_))
            ),
            "{kind} without live gesture"
        );
        assert_eq!(
            snapshot(&mut editor),
            before,
            "{kind} changed report/history/events"
        );
        editor.call("beginDrag", &[]).unwrap();
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(
            matches!(
                editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
                Err(EditError::Unported(_))
            ),
            "{kind}"
        );
        assert_eq!(
            snapshot(&mut editor),
            before,
            "{kind} changed report/history/events/open drag"
        );
    }
}

#[test]
fn native_motion_and_optional_selection_remain_atomic_refusals() {
    let mut native = Editor::new(document("origin-motion-support-native"), Options::default());
    native
        .call("select", &[Value::Num(1.0), Value::Num(1.0)])
        .unwrap();
    native.call("beginDrag", &[]).unwrap();
    native.take_events();
    let before = snapshot(&mut native);
    assert!(matches!(
        native.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut native), before);
    let mut sheet = Editor::new(
        document("origin-motion-layout-sheet"),
        Options {
            property_channels: true,
            layer_timeline: true,
            ..Options::default()
        },
    );
    sheet
        .call("select", &[Value::Num(1.0), Value::Num(1.0)])
        .unwrap();
    let mut selection = Obj::new();
    selection.set("polygonSelection", Value::object(Obj::new()));
    sheet
        .set_selection_metadata(&Value::object(selection))
        .unwrap();
    sheet.take_events();
    let before = snapshot(&mut sheet);
    assert!(matches!(
        sheet.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut sheet), before);
}

#[test]
fn remote_only_complex_targets_and_ancestors_refuse_before_live_commit() {
    for name in ["origin-future-rig-sheet", "origin-future-rig-joined-sheet"] {
        let mut editor = Editor::new(
            document(name),
            Options {
                property_channels: true,
                layer_timeline: true,
                ..Options::default()
            },
        );
        let mut remote = target().as_obj().unwrap().clone();
        remote.set("joint", Value::Num(2.0));
        if name == "origin-future-rig-sheet" {
            remote.set("uid", Value::Num(3.0));
            remote.set("handleId", Value::Num(22.0));
            remote.set("joint", Value::Num(1.0));
        }
        editor
            .call("select", &[Value::Num(1.0), Value::Num(1.0)])
            .unwrap();
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(
            matches!(
                editor.call(
                    "beginMotionPathEdit",
                    &[Value::object(remote.clone()), Value::Num(8.0)]
                ),
                Err(EditError::Unported(_))
            ),
            "{name} without live gesture"
        );
        assert_eq!(
            snapshot(&mut editor),
            before,
            "{name} changed remote-only state"
        );
        editor.call("beginDrag", &[]).unwrap();
        editor
            .call("moveSelection", &[Value::Num(7.125), Value::Num(-3.25)])
            .unwrap();
        editor.take_events();
        let before = snapshot(&mut editor);
        assert!(
            matches!(
                editor.call(
                    "beginMotionPathEdit",
                    &[Value::object(remote), Value::Num(8.0)]
                ),
                Err(EditError::Unported(_))
            ),
            "{name}"
        );
        assert_eq!(
            snapshot(&mut editor),
            before,
            "{name} changed the open drag/history/pose"
        );
    }
}

#[test]
fn motion_display_query_has_no_interface_session_dispatch() {
    let report = document("origin-motion-layout-sheet");
    let mut session = styk_edit::session::Session::start(
        report.clone(),
        "{\"propertyChannels\":true,\"layerTimeline\":true}",
    )
    .unwrap();
    let answer =
        styk_doc::json::parse(session.call("@motionFrame", "[]", "null").as_bytes()).unwrap();
    assert_eq!(
        answer.get("status").and_then(Value::as_str),
        Some("unported")
    );
    let mut editor = Editor::new(
        report,
        Options {
            property_channels: true,
            layer_timeline: true,
            ..Options::default()
        },
    );
    let before = snapshot(&mut editor);
    assert!(matches!(
        editor.call("@motionFrame", &[]),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut editor), before);
    assert!(editor.motion_display_frame_worker().unwrap().is_none());
    let mut camera = Obj::new();
    camera.set("kind", Value::str("camera"));
    assert!(matches!(
        editor.call(
            "beginMotionPathEdit",
            &[Value::object(camera), Value::Num(3.0)]
        ),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut editor), before);
}

#[test]
fn unrecorded_live_motion_begin_preserves_drag_and_property_previews() {
    let mut editor = Editor::new(
        document("origin-motion-layout-sheet"),
        Options {
            property_channels: true,
            layer_timeline: true,
            ..Options::default()
        },
    );
    editor
        .call("select", &[Value::Num(1.0), Value::Num(1.0)])
        .unwrap();
    editor.call("beginDrag", &[]).unwrap();
    editor
        .call("moveSelection", &[Value::Num(7.125), Value::Num(-3.25)])
        .unwrap();
    editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(
        editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut editor), before);
    editor.call("cancelDrag", &[]).unwrap();
    let mut figure = Obj::new();
    figure.set("kind", Value::str("figure"));
    figure.set("uid", Value::Num(1.0));
    editor
        .call(
            "beginAnimationEdit",
            &[Value::object(figure), Value::str("x")],
        )
        .unwrap();
    editor
        .call("previewAnimationEdit", &[Value::Num(420.125)])
        .unwrap();
    editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(
        editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]),
        Err(EditError::Unported(_))
    ));
    assert_eq!(snapshot(&mut editor), before);
    assert_eq!(
        editor.call("cancelAnimationEdit", &[]).unwrap(),
        Value::Bool(true)
    );
}
