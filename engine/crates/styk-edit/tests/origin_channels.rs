//! Origin property edits and saved-channel gestures match the editor step by step.
use std::path::Path;

#[test]
fn origin_channel_edits_match_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support", "saved-layout", "saved-support"] {
        for mode in ["sheet", "autokey-sheet"] {
            let name = format!("origin-channels-{kind}-{mode}");
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
            assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
        }
    }
}

#[test]
fn unrecorded_saved_origin_channel_commands_refuse_atomically() {
    use styk_doc::Value;
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-channels-saved-support-sheet.document.json")).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
    editor.call("beginTranslationDrag", &[]).unwrap();
    editor.call("moveSelection", &[Value::Num(4.0), Value::Num(-2.0)]).unwrap();
    let before = (editor.report_json(), editor.state());
    for method in ["setOrigin", "mirrorSegment", "addSegment", "deleteSingleSegment", "applyFigureRange", "addFigureInFrames", "beginMotionPathEdit", "deleteFiguresInFrames", "duplicateFigure", "beginHandleEditDrag", "transformFigureHandle"] {
        assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))), "{method}");
        assert_eq!((editor.report_json(), editor.state()), before, "{method} changed state on refusal");
    }
}

#[test]
fn saved_native_origin_unrecorded_scalar_mutations_remain_refused() {
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/records/channels-origin-support-native/report.json")).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
    let before = (editor.report_json(), editor.state());
    // Recorded saved native motion admits selection/history. Its authored-pose
    // header does not admit these scalar or ordinary pose mutations.
    for method in ["moveSelection", "poseJoint", "beginAnimationEdit", "addAnimationKey", "addAnimationKeys"] {
        assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))), "{method}");
        assert_eq!((editor.report_json(), editor.state()), before, "{method} changed state on refusal");
    }
}

#[test]
fn unrecorded_origin_property_targets_refuse_before_committing_a_drag() {
    use styk_doc::{Obj, Value};
    let document = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-channels-support-sheet.document.json")).unwrap();
    let mut report = styk_doc::json::parse(&document).unwrap();
    report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[1].make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykRig", Value::object(Obj::new()));
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
    editor.call("beginDrag", &[]).unwrap();
    let before = (editor.report_json(), editor.state());
    for (kind, uid, property) in [("figure", 2.0, "rotation"), ("figure", 1.0, "opacity"), ("figure", 1.0, "color"), ("figure", 1.0, "zIndex"), ("camera", 1.0, "x"), ("scene", 1.0, "color"), ("segment", 1.0, "thickness"), ("layer", 1.0, "pose")] {
        let mut target = Obj::new(); target.set("kind", Value::str(kind)); target.set("uid", Value::Num(uid));
        let target = Value::object(target);
        let mut entry = Obj::new(); entry.set("target", target.clone()); entry.set("property", Value::str(property)); entry.set("tick", Value::Num(0.0)); entry.set("value", Value::Num(0.5));
        for (method, args) in [("beginAnimationEdit", vec![target.clone(), Value::str(property)]), ("addAnimationKey", vec![target.clone(), Value::str(property), Value::Num(0.0), Value::Num(0.5)]), ("addAnimationKeys", vec![Value::array(vec![Value::object(entry.clone())])])] {
            assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{kind} {uid} {property} {method}");
            assert_eq!((editor.report_json(), editor.state()), before, "{kind} {uid} {property} {method} changed state on refusal");
        }
    }
}

#[test]
fn future_only_complex_origin_property_targets_refuse_before_committing_a_drag() {
    use styk_doc::{Obj, Value};
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-future-rig-sheet.document.json")).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
    editor.call("beginTranslationDrag", &[]).unwrap();
    editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();
    let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
    let mut target = Obj::new();target.set("kind", Value::str("figure"));target.set("uid", Value::Num(3.0));let target = Value::object(target);
    let mut entry = Obj::new();entry.set("target", target.clone());entry.set("property", Value::str("rotation"));entry.set("tick", Value::Num(8.0));entry.set("value", Value::Num(0.47));
    for (method, args) in [("addAnimationKey", vec![target.clone(), Value::str("rotation"), Value::Num(8.0), Value::Num(0.47)]), ("addAnimationKeys", vec![Value::array(vec![Value::object(entry)])]), ("beginAnimationEdit", vec![target, Value::str("rotation")])] {
        assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{method} admitted the unrecorded future-only rig");
        assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before, "{method} changed document, state or live pose on refusal");
    }
}

#[test]
fn future_joined_property_position_guards_the_complex_root() {
    use styk_doc::{Obj, Value};
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-future-rig-joined-sheet.document.json")).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();
    let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
    let mut target = Obj::new();target.set("kind", Value::str("figure"));target.set("uid", Value::Num(2.0));let target = Value::object(target);
    let mut entry = Obj::new();entry.set("target", target.clone());entry.set("property", Value::str("x"));entry.set("tick", Value::Num(8.0));entry.set("value", Value::Num(410.75));
    for (method, args) in [("addAnimationKey", vec![target, Value::str("x"), Value::Num(8.0), Value::Num(410.75)]), ("addAnimationKeys", vec![Value::array(vec![Value::object(entry)])])] {
        assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{method} admitted the unrecorded future root");
        assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before, "{method} changed document, state or live pose on refusal");
    }
}

#[test]
fn future_only_plain_properties_match_recorded_steps() {
    let reference = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-channels-future-sheet.reference.json")).unwrap()).unwrap();
    let outcome = styk_edit::replay::replay(&reference).unwrap();
    assert!(outcome.passed(), "{:#?}", outcome.mismatches);
    assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None));
}

#[test]
fn same_uid_with_a_changed_future_definition_stays_refused() {
    use styk_doc::{Obj, Value};
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-changing-rig-sheet.document.json")).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();
    let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
    let mut target = Obj::new();target.set("kind", Value::str("figure"));target.set("uid", Value::Num(3.0));let target = Value::object(target);
    let mut entry = Obj::new();entry.set("target", target.clone());entry.set("property", Value::str("rotation"));entry.set("tick", Value::Num(8.0));entry.set("value", Value::Num(0.47));
    for (method, args) in [("addAnimationKey", vec![target, Value::str("rotation"), Value::Num(8.0), Value::Num(0.47)]), ("addAnimationKeys", vec![Value::array(vec![Value::object(entry)])])] {
        assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{method} trusted the current definition of a future UID");
        assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before, "{method} changed document, state or live pose on refusal");
    }
}
