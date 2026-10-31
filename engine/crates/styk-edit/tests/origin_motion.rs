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

/// What a motion-path edit of a figure with a rig does, from the first begin to the last undo: the edit opens and
/// cancels without a trace, and a pose gesture that is open when it begins is committed first, as the editor does.
fn rigged_motion_ends_cleanly(editor: &mut Editor, remote: &Value, tick: f64, name: &str) {
    let original = editor.report_json();
    let point = || styk_doc::json::parse(br#"{"x":239.5,"y":246.4}"#).unwrap();
    editor.call("select", &[Value::Num(1.0), Value::Num(1.0)]).unwrap();
    assert_eq!(editor.call("beginMotionPathEdit", &[remote.clone(), Value::Num(tick)]).unwrap(), Value::Bool(true), "{name}: idle");
    assert_eq!(editor.call("updateMotionPathEdit", &[point()]).unwrap(), Value::Bool(true), "{name}");
    assert_eq!(editor.call("cancelMotionPathEdit", &[]).unwrap(), Value::Bool(true), "{name}");
    assert_eq!(editor.report_json(), original, "{name}: a cancelled edit leaves the document as it was");
    assert!(!editor.state().can_undo, "{name}: a cancelled edit leaves no history");
    editor.call("beginDrag", &[]).unwrap();
    editor.call("moveSelection", &[Value::Num(7.125), Value::Num(-3.25)]).unwrap();
    assert_eq!(editor.call("beginMotionPathEdit", &[remote.clone(), Value::Num(tick)]).unwrap(), Value::Bool(true), "{name}: open drag");
    assert_eq!(editor.state().undo_label, "Pose figure", "{name}: the open drag was committed first");
    assert_eq!(editor.call("updateMotionPathEdit", &[point()]).unwrap(), Value::Bool(true), "{name}");
    assert_eq!(editor.call("commitMotionPathEdit", &[]).unwrap(), Value::Bool(true), "{name}");
    assert_eq!(editor.state().undo_label, "Edit motion path", "{name}");
    for _ in 0..2 {
        assert_eq!(editor.call("undo", &[]).unwrap(), Value::Bool(true), "{name}");
    }
    assert_eq!(editor.report_json(), original, "{name}: both entries undone");
    assert!(!editor.state().can_undo, "{name}");
}

/// `origin-motion-layout-sheet` with one feature the motion-path edit cannot pose on an animation-origin figure.
fn with_feature(kind: &str) -> Value {
    let mut report = document("origin-motion-layout-sheet");
    let figure = report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[usize::from(kind == "joinedRig")].make_obj().unwrap();
    if ["rig", "joinedRig"].contains(&kind) {
        figure.get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykRig", Value::object(Obj::new()));
    } else {
        figure.get_mut("_styk").unwrap().make_obj().unwrap().set(kind, Value::object(Obj::new()));
    }
    report
}

fn sheet_options() -> Options {
    Options {
        property_channels: true,
        layer_timeline: true,
        ..Options::default()
    }
}

#[test]
fn origin_figures_with_meshes_movieclips_or_drawings_refuse_without_committing_an_open_drag() {
    for kind in ["spatialMesh", "drawing", "movieclip"] {
        let mut editor = Editor::new(with_feature(kind), sheet_options());
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
fn origin_figures_with_rigs_edit_their_motion_paths() {
    for kind in ["rig", "joinedRig"] {
        rigged_motion_ends_cleanly(&mut Editor::new(with_feature(kind), sheet_options()), &target(), 3.0, kind);
    }
}

#[test]
fn native_motion_begun_during_a_live_gesture_remains_an_atomic_refusal() {
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
}

#[test]
fn a_selected_fill_does_not_stop_a_motion_path_edit() {
    let mut sheet = Editor::new(document("origin-motion-layout-sheet"), sheet_options());
    sheet
        .call("select", &[Value::Num(1.0), Value::Num(1.0)])
        .unwrap();
    let mut selection = Obj::new();
    selection.set("polygonSelection", Value::object(Obj::new()));
    sheet
        .set_selection_metadata(&Value::object(selection))
        .unwrap();
    sheet.take_events();
    let original = sheet.report_json();
    assert_eq!(
        sheet.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]).unwrap(),
        Value::Bool(true)
    );
    assert_eq!(sheet.call("cancelMotionPathEdit", &[]).unwrap(), Value::Bool(true));
    assert_eq!(sheet.report_json(), original);
    assert!(!sheet.state().can_undo);
}

#[test]
fn remote_only_rigged_targets_and_ancestors_edit_their_motion_paths() {
    for name in ["origin-future-rig-sheet", "origin-future-rig-joined-sheet"] {
        let mut editor = Editor::new(document(name), sheet_options());
        let mut remote = target().as_obj().unwrap().clone();
        remote.set("joint", Value::Num(2.0));
        if name == "origin-future-rig-sheet" {
            remote.set("uid", Value::Num(3.0));
            remote.set("handleId", Value::Num(22.0));
            remote.set("joint", Value::Num(1.0));
        }
        rigged_motion_ends_cleanly(&mut editor, &Value::object(remote), 8.0, name);
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
