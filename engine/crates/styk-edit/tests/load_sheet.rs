//! The layer sheet the app's editor gives a document when it opens it (`initializeLayerSheet`,
//! src/editor-layer-sheet.mjs), as `styk_edit::load::prepare_for_editor` builds it. The expected sheets are
//! worked out by hand from that function: one track per permanent and user layer, a key at every native
//! keyframe that lasts, at tick 0 and at the ticks of the authored animation's visible keys.
use std::path::Path;

use styk_doc::{Value, json};
use styk_edit::load::prepare_for_editor;

fn startup() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/startup.document.json");
    json::parse(&std::fs::read(path).unwrap()).unwrap()
}

/// The startup document as the file stores it, without its layer sheet and with `frames` keyframes of the
/// given durations (copies of its pose; the second one on has no figures).
fn without_sheet(durations: &[f64]) -> Value {
    let mut document = startup();
    let frame = document.get("keyframes").unwrap().elements().unwrap().get(0).unwrap();
    let mut frames = Vec::new();
    for (index, duration) in durations.iter().enumerate() {
        let mut copy = frame.as_obj().unwrap().clone();
        copy.set("duration_raw", Value::Num(*duration));
        if index > 0 {
            copy.set("objects", Value::array(vec![]));
            copy.set("object_draw_order", Value::array(vec![]));
            copy.set("object_draw_order_unique_ids", Value::array(vec![]));
            copy.remove("_styk");
        }
        frames.push(Value::object(copy));
    }
    document.make_obj().unwrap().set("keyframes", Value::array(frames));
    document.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().remove("layerSheet");
    document
}

fn text(value: &Value) -> String {
    json::to_string(value)
}

#[test]
fn a_document_without_a_layer_sheet_gets_the_editors() {
    let prepared = prepare_for_editor(without_sheet(&[10.0]), true).unwrap();
    let sheet = prepared.report.path(&["_styk", "layerSheet"]).expect("a layer sheet");
    // The last keyframe of a version 5 document lasts one tick; the startup document's hold is the sheet's to set.
    assert_eq!(
        text(sheet),
        r#"{"version":1,"duration":1,"nextId":4,"tracks":{"scene":{"end":1,"keys":[{"id":"cell-1","tick":0,"sourceTick":0,"interpolation":"constant"}]},"camera":{"end":1,"keys":[{"id":"cell-2","tick":0,"sourceTick":0,"interpolation":"constant"}]},"layer-1":{"end":1,"keys":[{"id":"cell-3","tick":0,"sourceTick":0,"interpolation":"constant","empty":false}]}}}"#
    );
}

#[test]
fn without_a_layer_timeline_the_document_stays_as_the_load_leaves_it() {
    let prepared = prepare_for_editor(without_sheet(&[10.0]), false).unwrap();
    assert!(prepared.report.path(&["_styk", "layerSheet"]).is_none());
}

#[test]
fn keys_follow_the_native_timeline_and_the_figures_on_each_layer() {
    // Rows start at 0, 2 and 5 (2 + 3 ticks); the last lasts one tick, so the sheet is 6 ticks long.
    let prepared = prepare_for_editor(without_sheet(&[2.0, 3.0, 1.0]), true).unwrap();
    let sheet = prepared.report.path(&["_styk", "layerSheet"]).unwrap();
    assert_eq!(sheet.get("duration").and_then(Value::as_f64), Some(6.0));
    assert_eq!(sheet.get("nextId").and_then(Value::as_f64), Some(10.0));
    let keys = |track: &str| -> Vec<String> {
        sheet.path(&["tracks", track, "keys"]).unwrap().elements().unwrap().iter().map(|key| text(&key)).collect()
    };
    // Frames without easing take the version 5 default: linear.
    assert_eq!(
        keys("layer-1"),
        [
            r#"{"id":"cell-7","tick":0,"sourceTick":0,"interpolation":"constant","empty":false}"#,
            r#"{"id":"cell-8","tick":2,"sourceTick":2,"interpolation":"linear","empty":true}"#,
            r#"{"id":"cell-9","tick":5,"sourceTick":5,"interpolation":"linear","empty":true}"#,
        ]
    );
    // The permanent tracks have no emptiness.
    assert_eq!(keys("scene")[1], r#"{"id":"cell-2","tick":2,"sourceTick":2,"interpolation":"linear"}"#);
    assert_eq!(sheet.path(&["tracks", "camera", "end"]).and_then(Value::as_f64), Some(6.0));
}

#[test]
fn the_authored_animation_moves_into_the_sheet_and_adds_its_key_ticks() {
    let mut document = without_sheet(&[1.0]);
    let animation = json::parse(
        br#"{"version":1,"nextKeyId":2,"channels":[{"id":"figure:1:pose","target":{"kind":"figure","uid":1},"property":"pose","source":"authored","keys":[{"id":"native:pose:frame-1","tick":0,"value":{"frameId":"frame-1"},"interpolation":"linear"},{"id":"key-1","tick":4,"value":{"frameId":"frame-1"},"interpolation":"linear"}],"nativeProperties":true}]}"#,
    )
    .unwrap();
    document.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("animation", animation.clone());
    let Ok(prepared) = prepare_for_editor(document, true) else { panic!("the document opens") };
    let styk = prepared.report.get("_styk").unwrap();
    assert!(styk.get("animation").is_none(), "the animation is the sheet's now");
    let sheet = styk.get("layerSheet").unwrap();
    assert_eq!(text(sheet.get("legacyAnimation").unwrap()), text(&animation));
    // The animation lasts five ticks (its last key and the tick it shows), which the sheet lasts too. Its
    // channel belongs to the figure, so the figure's layer gets a key at tick 4 and the permanent tracks none.
    assert_eq!(sheet.get("duration").and_then(Value::as_f64), Some(5.0));
    let ticks = |track: &str| -> Vec<f64> { sheet.path(&["tracks", track, "keys"]).unwrap().elements().unwrap().iter().map(|key| key.get("tick").and_then(Value::as_f64).unwrap()).collect() };
    assert_eq!(ticks("layer-1"), [0.0, 4.0]);
    assert_eq!(ticks("camera"), [0.0]);
    assert_eq!(ticks("scene"), [0.0]);
    // A document with an animation never marks a layer key empty.
    assert!(sheet.path(&["tracks", "layer-1", "keys"]).unwrap().elements().unwrap().get(0).unwrap().get("empty").is_none());
}

#[test]
fn a_document_that_already_has_a_sheet_keeps_it() {
    let before = startup();
    let sheet = text(before.path(&["_styk", "layerSheet"]).unwrap());
    let prepared = prepare_for_editor(before, true).unwrap();
    assert_eq!(text(prepared.report.path(&["_styk", "layerSheet"]).unwrap()), sheet);
}
