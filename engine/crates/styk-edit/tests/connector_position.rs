//! A connector's position on a layer-sheet document: the figure's own lengths seed the figure's per-frame lengths, whatever the
//! native keyframe at the playhead holds (a sheet document leaves it empty). The document is a one-line figure with a connector
//! (a slider from the line's origin to its end) as the builder makes it.

use styk_doc::Value;
use styk_edit::session::Session;

const DOCUMENT: &str = r#"{"version":5,"canvas_width":960,"canvas_height":540,"fps":24,"figure_types":[{"figure_type_id":2,"name":"Line","segment_count":2,"segments":[{"segment_id":1,"parent_id":0,"length":180,"angle_rad":0,"thickness":0,"bend_rad":0,"primitive_code":0,"aux_code":0,"flags":0,"segment_type":"line","segment_kind":"line","color_rgb":[106,77,234],"transparency":0,"visible":false,"z_order":1,"is_static":false,"flag_bits":{"is_static":false}},{"segment_id":2,"bend_rad":0,"thickness":6,"primitive_code":0,"aux_code":0,"flags":0,"segment_type":"line","segment_kind":"line","color_rgb":[13,153,255],"transparency":0,"visible":true,"z_order":2,"parent_id":0,"length":0.5,"angle_rad":0,"_stykRig":{"connector":{"start":0,"end":1,"restLength":180}},"is_static":false,"flag_bits":{"is_static":false}}],"polyfills":[],"image_assets":[],"text_assets":[]}],"keyframes":[{"duration_raw":1,"background_id":0,"background_id_b":0,"background_mix":0,"camera":{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0},"objects":[],"object_draw_order":[],"object_draw_order_unique_ids":[],"_styk":{"easing":{"interpolation":"hold"},"frameId":"frame-1"},"inbetweens":0,"hidden":false}],"_styk":{"format":"StykAnimate","format_version":1,"name":"Untitled animation","layers":{"version":1,"nextId":2,"order":["layer-1"],"byId":{"layer-1":{"name":"Layer 1","visible":true,"locked":false}},"assignments":{"1":"layer-1"},"defaultLayerId":"layer-1","activeId":"layer-1","fixed":{"scene":{"visible":true,"locked":false},"camera":{"visible":true,"locked":false}}},"layerSheet":{"version":1,"duration":1,"nextId":4,"tracks":{"scene":{"end":1,"keys":[{"id":"cell-1","tick":0,"sourceTick":0,"interpolation":"hold"}]},"camera":{"end":1,"keys":[{"id":"cell-2","tick":0,"sourceTick":0,"interpolation":"hold"}]},"layer-1":{"end":1,"keys":[{"id":"cell-3","tick":0,"interpolation":"constant","empty":false,"value":{"frameId":"frame-2"}}]}}},"frameSources":{"frame-2":{"duration_raw":1,"background_id":0,"background_id_b":0,"background_mix":0,"camera":{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0},"objects":[{"object_slot":0,"unique_id":1,"figure_type_id":2,"root_x":480,"root_y":270,"scale":1,"color_override_raw":0,"field28":0,"angles":[0,0],"len_flag":0,"lengths":[],"bend_flag":0,"bends":[],"join":null}],"object_draw_order":[0],"object_draw_order_unique_ids":[1],"_styk":{"easing":{"interpolation":"hold"},"frameId":"frame-2"},"object_count":1}}}}"#;
const STATE: &str = r#"{"tick":0,"frameIndex":0,"selectedUid":1,"selectedUids":[1],"selectedJoint":1,"layerRevision":3,"nextFrameIdentity":4,"nextUid":2,"layerTimeline":true,"propertyChannels":true}"#;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn session() -> Session { Session::start(json(DOCUMENT), STATE).unwrap() }

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = json(&session.call(method, args, "null"));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

/// The lengths the sheet's only frame source stores for the figure, with its flag.
fn stored_lengths(session: &Session) -> (f64, Vec<Option<f64>>) {
    let report = session.report();
    let sources = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).unwrap();
    let object = sources.values().iter().filter_map(|frame| frame.get("objects").and_then(|o| o.item(0))).last().unwrap();
    let lengths = object.get("lengths").and_then(Value::elements).unwrap().iter().map(|v| v.as_f64()).collect();
    (object.get("len_flag").and_then(Value::as_f64).unwrap(), lengths)
}

#[test]
fn a_connector_position_keeps_the_figures_own_lengths() {
    let mut session = session();
    assert_eq!(ok(&mut session, "setConnectorPosition", "[0]"), Value::Bool(true));
    // The line keeps its 180, the connector sits at the start: the same as an editor that read the figure's definition.
    assert_eq!(stored_lengths(&session), (1.0, vec![Some(180.0), Some(0.0)]));
    ok(&mut session, "undo", "[]");
    assert_eq!(stored_lengths(&session), (0.0, vec![]));
}

#[test]
fn sliding_a_connector_keeps_the_figures_own_lengths() {
    let mut session = session();
    // The pointer at the line's origin: the connector's start.
    assert_eq!(ok(&mut session, "slideConnector", "[480,270]"), Value::Bool(true));
    assert_eq!(stored_lengths(&session), (1.0, vec![Some(180.0), Some(0.0)]));
}
