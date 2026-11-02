//! A drawing layer holds only drawing cels. A movieclip placed while one was active was assigned to it (by replacements, which are not checked
//! as a key's frame is), and a movieclip made of that figure afterwards held a figure on a drawing layer in its own timeline: the file it was
//! saved in was refused when it opened (`errors.drawingModel.drawingLayersMustContainOneDrawingCelPer…`).

use styk_doc::Value;
use styk_edit::load::prepare_for_editor;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn read(path: &str) -> Value {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    json(std::str::from_utf8(&std::fs::read(folder.join(path)).unwrap()).unwrap())
}

const STATE: &str = r#"{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-1","nextFrameIdentity":100,"nextUid":60}"#;

fn call(session: &mut Session, method: &str, args: &str, selected: &[u32], active: &str) -> Value {
    let uuids: Vec<String> = (1..=24).map(|i| format!("[\"uuid\",\"00000000-0000-4000-8000-{i:012}\"]")).collect();
    let ids: Vec<String> = selected.iter().map(u32::to_string).collect();
    let first = selected.first().map_or("null".to_string(), u32::to_string);
    let view = format!(r#"{{"tick":0,"frameIndex":0,"selectedUid":{first},"selectedUids":[{}],"selectedJoint":-1,"activeLayerId":"{active}","draws":[{}],"drawPool":true}}"#, ids.join(","), uuids.join(","));
    json(&session.call(method, args, &view))
}

fn started() -> (Session, String) {
    let mut session = Session::start(read("tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    let layer = call(&mut session, "createDrawingLayer", r#"["Ink"]"#, &[], "layer-1");
    assert_eq!(layer.get("status").and_then(Value::as_str), Some("ok"), "{layer:?}");
    let id = layer.path(&["result", "id"]).and_then(Value::as_str).expect("the layer has an identity").to_string();
    (session, id)
}

#[test]
fn a_movieclip_is_not_placed_while_a_drawing_layer_is_active() {
    let (mut session, layer) = started();
    let answer = call(&mut session, "addFigure", "[4]", &[], &layer);
    assert_ne!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    assert!(json_text(&answer).contains("drawingLayersAcceptOneDrawingCelAtA"), "{answer:?}");
}

fn json_text(value: &Value) -> String { styk_doc::json::to_string(value) }

#[test]
fn a_movieclip_made_of_a_figure_a_project_assigned_to_a_drawing_layer_keeps_it_off_the_clips_drawing_layers() {
    let (session, layer) = started();
    // The project as builds that placed the movieclip on a drawing layer left it: the figure is assigned to the drawing layer.
    let mut report = session.report().clone();
    let styk = report.make_obj().unwrap().get_mut("_styk").unwrap();
    let layers = styk.make_obj().unwrap().get_mut("layers").unwrap();
    layers.make_obj().unwrap().get_mut("assignments").unwrap().make_obj().unwrap().set("1", Value::str(&layer));
    let mut session = Session::start(report, STATE).unwrap();
    let made = call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[1], "layer-1");
    assert_eq!(made.get("status").and_then(Value::as_str), Some("ok"), "{made:?}");
    prepare_for_editor(session.report().clone(), true).expect("the project opens after it is saved");
}

/// A figure with an animation origin, broken out of a movieclip, is posed with one in the poses the layer sheet retains: they were left
/// without the pivot's position, and the file saved afterwards was refused when it opened (`errors.animationOriginValidation…mustBeFinite`).
#[test]
fn figures_with_an_animation_origin_broken_out_of_a_movieclip_open_in_the_saved_file() {
    let mut session = Session::start(read("tests/edit/origin-future-rig-joined-sheet.document.json"), STATE).unwrap();
    let made = call(&mut session, "createMovieclip", r#"[{"start":0,"end":4}]"#, &[1, 2], "layer-1");
    assert_eq!(made.get("status").and_then(Value::as_str), Some("ok"), "{made:?}");
    let clip: Vec<u32> = made.path(&["state", "selectedUids"]).and_then(Value::elements).map(|e| e.iter().filter_map(|v| v.as_f64()).map(|n| n as u32).collect()).unwrap_or_default();
    assert!(!clip.is_empty(), "the clip is selected: {made:?}");
    let broken = call(&mut session, "breakApartMovieclip", "[]", &clip, "layer-1");
    assert_eq!(broken.get("status").and_then(Value::as_str), Some("ok"), "{broken:?}");
    let opened = prepare_for_editor(session.report().clone(), true).expect("the project opens after it is saved");
    assert_eq!(opened.repairs, 0, "nothing needed mending");
}
