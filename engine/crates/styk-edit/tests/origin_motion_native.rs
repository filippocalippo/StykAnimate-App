//! Native remote-time poses use the same motion, frame and history owners.
use std::path::Path;

#[test]
fn native_origin_motion_matches_the_five_recorded_unanimated_documents() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support", "support-pinned", "support-free"] {
        let name = format!("origin-motion-{kind}-native");
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
        println!("{name}: {} / {} exact steps", outcome.matched, outcome.steps);
    }
}

fn report(name: &str) -> styk_doc::Value {
    styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.document.json"))).unwrap()).unwrap()
}

fn target() -> styk_doc::Value {
    styk_doc::json::parse(br#"{"kind":"node","uid":1,"handleId":44,"joint":3}"#).unwrap()
}

fn snapshot(editor: &mut styk_edit::Editor) -> (String, styk_doc::Value, styk_doc::Value, Vec<styk_doc::Value>) {
    (editor.report_json(), editor.state_value(), editor.drag_value(), editor.take_events())
}

#[test]
fn native_property_projection_camera_and_optional_metadata_remain_atomic_refusals() {
    use styk_edit::{EditError, Editor, Options};
    use styk_doc::Value;
    for name in ["origin-motion-saved-layout-native", "origin-motion-saved-support-native"] {
        let mut editor = Editor::new(report(name), Options { property_channels: true, ..Options::default() });
        editor.take_events(); let before = snapshot(&mut editor);
        assert!(matches!(editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]), Err(EditError::Unported(_))));
        assert_eq!(snapshot(&mut editor), before);
    }
    let mut editor = Editor::new(report("origin-motion-layout-native"), Options::default());
    editor.call("select", &[Value::Num(1.0)]).unwrap(); editor.call("beginDrag", &[]).unwrap();
    editor.take_events(); let before = snapshot(&mut editor);
    assert!(matches!(editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]), Err(EditError::Unported(_))));
    assert_eq!(snapshot(&mut editor), before);
    editor.call("cancelDrag", &[]).unwrap(); editor.take_events();
    let before = snapshot(&mut editor);
    assert!(matches!(editor.call("beginMotionPathEdit", &[styk_doc::json::parse(br#"{"kind":"camera"}"#).unwrap(), Value::Num(3.0)]), Err(EditError::Unported(_))));
    assert_eq!(snapshot(&mut editor), before);
    editor.set_selection_metadata(&styk_doc::json::parse(br#"{"polygonSelection":{"uid":1,"index":0}}"#).unwrap()).unwrap();
    editor.take_events(); let before = snapshot(&mut editor);
    assert!(matches!(editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]), Err(EditError::Unported(_))));
    assert_eq!(snapshot(&mut editor), before);
}

#[test]
fn native_remote_complex_definitions_refuse_before_idle_or_live_commit() {
    use styk_edit::{EditError, Editor, Options}; use styk_doc::{Obj, Value};
    for kind in ["rig", "drawing", "spatialMesh", "poseChoices", "movieclip"] {
        let mut document = report("origin-motion-layout-native");
        let mut future = document.get("figure_types").unwrap().item(0).unwrap().as_obj().unwrap().clone();
        future.set("figure_type_id", Value::Num(9.0));
        if kind == "rig" { future.get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykRig", Value::object(Obj::new())); }
        else { future.get_mut("_styk").unwrap().make_obj().unwrap().set(kind, Value::object(Obj::new())); }
        document.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap().push(Value::object(future));
        document.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[1].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("figure_type_id", Value::Num(9.0));
        let future_document = document.clone();
        let mut editor = Editor::new(document, Options::default());
        editor.call("select", &[Value::Num(1.0)]).unwrap(); editor.take_events();
        let before = snapshot(&mut editor);
        assert!(matches!(editor.call("beginMotionPathEdit", &[target(), Value::Num(8.0)]), Err(EditError::Unported(_))), "{kind}: idle");
        assert_eq!(snapshot(&mut editor), before);
        let mut live = Editor::new(future_document, Options::default());
        live.call("select", &[Value::Num(1.0)]).unwrap();
        live.call("beginDrag", &[]).unwrap();
        live.call("moveSelection", &[Value::Num(3.125), Value::Num(-1.25)]).unwrap();
        live.take_events(); let before = snapshot(&mut live);
        assert!(matches!(live.call("beginMotionPathEdit", &[target(), Value::Num(8.0)]), Err(EditError::Unported(_))), "{kind}: open");
        assert_eq!(snapshot(&mut live), before);
    }
}

#[test]
fn native_split_identity_capacity_refuses_without_losing_the_open_preview() {
    use styk_edit::{EditError, Editor, Options}; use styk_doc::Value;
    let mut editor = Editor::new(report("origin-motion-layout-native"), Options::default());
    editor.call("select", &[Value::Num(1.0), Value::Num(1.0)]).unwrap();
    editor.call("seek", &[Value::Num(3.5)]).unwrap();
    editor.call("beginMotionPathEdit", &[target(), Value::Num(3.0)]).unwrap();
    editor.call("updateMotionPathEdit", &[styk_doc::json::parse(br#"{"x":239.5039520263672,"y":246.41033935546875}"#).unwrap()]).unwrap();
    let state = editor.state();
    editor.set_counters(state.layer_revision, 9_007_199_254_740_992, state.next_uid);
    editor.take_events();
    let display = editor.motion_display_frame_worker().unwrap();
    let before = snapshot(&mut editor);
    assert!(matches!(editor.call("commitMotionPathEdit", &[]), Err(EditError::Unported(_))));
    assert_eq!(snapshot(&mut editor), before);
    assert_eq!(editor.motion_display_frame_worker().unwrap(), display);
}

#[test]
fn unrecorded_ordinary_native_targets_refuse_in_mixed_and_plain_documents() {
    use styk_edit::{EditError, Editor, Options}; use styk_doc::Value;
    for plain in [false, true] {
        let mut document = report("origin-motion-layout-native");
        if plain {
            for figure in document.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap() {
                if let Some(fields) = figure.make_obj().unwrap().get_mut("_styk").and_then(Value::make_obj) { fields.remove("animationOrigin"); }
            }
            for frame in document.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap() {
                for object in frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap() {
                    object.make_obj().unwrap().remove("_stykAnimationOrigin");
                }
            }
        }
        let mut editor = Editor::new(document, Options::default());
        editor.call("select", &[Value::Num(3.0)]).unwrap(); editor.take_events();
        let ordinary = styk_doc::json::parse(br#"{"kind":"node","uid":3,"handleId":22,"joint":1}"#).unwrap();
        let before = snapshot(&mut editor);
        assert!(matches!(editor.call("beginMotionPathEdit", &[ordinary.clone(), Value::Num(3.0)]), Err(EditError::Unported(_))), "plain={plain}: idle ordinary target");
        assert_eq!(snapshot(&mut editor), before);
        editor.call("beginDrag", &[]).unwrap();
        editor.call("moveSelection", &[Value::Num(3.125), Value::Num(-1.25)]).unwrap();
        editor.take_events(); let before = snapshot(&mut editor);
        assert!(matches!(editor.call("beginMotionPathEdit", &[ordinary, Value::Num(3.0)]), Err(EditError::Unported(_))), "plain={plain}: live ordinary target");
        assert_eq!(snapshot(&mut editor), before);
    }
}
