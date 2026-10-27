//! A 3D rig's perspective and part proportions in the session, on the
//! spatial mesh document: what each call stores, what it refuses and how history takes it back.

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

/// The document of the spatial mesh fixture: its first key shows the figure with a perspective of 0.5 at distance 300,
/// its key at tick 6 one of 0.9 with a proportion set for the bone 9. `plain` takes the first key's perspective away.
fn open(joint: i64, plain: bool) -> Session {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/spatial/mesh-sheet.json");
    let mut text = String::from_utf8(std::fs::read(path).unwrap()).unwrap();
    if plain {
        let own = r#","_stykSpatial":{"camera":{"strength":0.5,"distance":300,"centerX":320,"centerY":300}}"#;
        assert!(text.contains(own));
        text = text.replacen(own, "", 1);
    }
    let document = styk_doc::json::parse(text.as_bytes()).unwrap();
    let state = format!(r#"{{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":1,"selectedUids":[1],"selectedJoint":{joint}}}"#);
    Session::start(document, &state).unwrap()
}

fn session(joint: i64) -> Session { open(joint, true) }

fn answer(session: &mut Session, method: &str, args: &str) -> Value { json(&session.call(method, args, "null")) }

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

/// The refusal's message key.
fn refused(session: &mut Session, method: &str, args: &str) -> String {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{method} {args}: {answer:?}");
    answer.get("error").and_then(Value::as_str).unwrap().to_string()
}

/// The figure's record in the pose source the first key of its layer reads.
fn pose(session: &Session) -> Value {
    let report = session.report();
    let key = report.path(&["_styk", "layerSheet", "tracks", "layer-1", "keys"]).and_then(|keys| keys.item(0)).unwrap();
    let id = key.path(&["value", "frameId"]).and_then(Value::as_str).unwrap().to_string();
    report.path(&["_styk", "frameSources", &id]).and_then(|frame| frame.get("objects")).and_then(|objects| objects.item(0)).unwrap()
}

fn number(value: Option<&Value>) -> f64 { value.and_then(Value::as_f64).unwrap() }

fn label(session: &mut Session) -> String {
    answer(session, "seek", "[0]").path(&["state", "undoLabel"]).and_then(Value::as_str).unwrap_or("").to_string()
}

#[test]
fn the_perspective_is_stored_with_its_defaults_and_one_undo_takes_it_away() {
    let mut session = session(-1);
    assert!(pose(&session).get("_stykSpatial").is_none());
    assert_eq!(ok(&mut session, "setSpatialCamera", r#"[{"strength":0.4}]"#), Value::Bool(true));
    let camera = pose(&session).path(&["_stykSpatial", "camera"]).cloned().unwrap();
    assert_eq!(styk_doc::json::to_string(&camera), r#"{"strength":0.4,"distance":600,"centerX":320,"centerY":300}"#, "the centre defaults to the figure's root");
    assert_eq!(label(&mut session), "Adjust perspective");
    // The same values again change nothing and record nothing.
    assert_eq!(ok(&mut session, "setSpatialCamera", r#"[{"strength":0.4}]"#), Value::Bool(false));
    assert_eq!(ok(&mut session, "setSpatialCamera", r#"[{"distance":900}]"#), Value::Bool(true));
    assert_eq!(number(pose(&session).path(&["_stykSpatial", "camera", "distance"])), 900.0);
    ok(&mut session, "undo", "[]");
    assert_eq!(number(pose(&session).path(&["_stykSpatial", "camera", "distance"])), 600.0);
    ok(&mut session, "undo", "[]");
    assert!(pose(&session).get("_stykSpatial").is_none(), "the figure has no perspective settings again");
    assert!(!session.can_undo());
    ok(&mut session, "redo", "[]");
    assert_eq!(number(pose(&session).path(&["_stykSpatial", "camera", "strength"])), 0.4);
}

#[test]
fn the_perspective_keeps_the_settings_it_is_not_given() {
    let mut session = open(-1, false);
    assert_eq!(ok(&mut session, "setSpatialCamera", r#"[{"strength":0.25}]"#), Value::Bool(true));
    let camera = pose(&session).path(&["_stykSpatial", "camera"]).cloned().unwrap();
    assert_eq!(styk_doc::json::to_string(&camera), r#"{"strength":0.25,"distance":300,"centerX":320,"centerY":300}"#);
    assert_eq!(ok(&mut session, "setSpatialCamera", r#"[{"strength":0.25,"distance":300}]"#), Value::Bool(false), "unchanged values record nothing");
}

#[test]
fn a_perspective_outside_its_range_is_refused_and_changes_nothing() {
    let mut session = session(-1);
    let before = styk_doc::json::to_string(session.report());
    assert_eq!(refused(&mut session, "setSpatialCamera", r#"[{"strength":2}]"#), "errors.spatialProjection.perspectiveNeedsStrength01AndDistance10");
    assert_eq!(refused(&mut session, "setSpatialCamera", r#"[{"distance":5}]"#), "errors.spatialProjection.perspectiveNeedsStrength01AndDistance10");
    assert_eq!(refused(&mut session, "setSpatialCamera", r#"[{"depth":1}]"#), "errors.spatialProjection.perspectiveNeedsStrength01AndDistance10");
    assert_eq!(styk_doc::json::to_string(session.report()), before);
    assert!(!session.can_undo());
}

#[test]
fn a_figure_without_3d_bones_has_no_perspective() {
    let mut session = session(-1);
    ok(&mut session, "select", "[null]");
    assert_eq!(ok(&mut session, "setSpatialCamera", r#"[{"strength":0.5}]"#), Value::Bool(false), "nothing is selected");
    assert_eq!(ok(&mut session, "setSpatialProportions", r#"[{"width":2}]"#), Value::Bool(false));
    assert_eq!(ok(&mut session, "resetSpatialProportions", "[]"), Value::Bool(false));
}

fn shape(session: &Session, id: &str) -> Value { pose(session).path(&["_stykSpatial", "shape", id]).cloned().unwrap() }

#[test]
fn a_bones_width_and_taper_are_stored_beside_its_own_length() {
    let mut session = session(5);
    assert_eq!(ok(&mut session, "setSpatialProportions", r#"[{"width":2,"taper":0.5}]"#), Value::Bool(true));
    assert_eq!(styk_doc::json::to_string(&shape(&session, "6")), r#"{"width":2,"taper":0.5}"#);
    assert!(pose(&session).path(&["_stykSpatial", "shape", "9"]).is_none(), "the bone it carries is untouched");
    assert_eq!(label(&mut session), "Adjust rig proportions");
    // Half the bone's length: stored with the figure's lengths, the bone's own halved.
    assert_eq!(ok(&mut session, "setSpatialProportions", r#"[{"length":0.5}]"#), Value::Bool(true));
    let lengths = pose(&session).get("lengths").unwrap().numbers().unwrap();
    assert_eq!((lengths.len(), lengths[5], lengths[8]), (9, 30.0, 60.0));
    assert_eq!(number(pose(&session).get("len_flag")), 1.0);
    ok(&mut session, "undo", "[]");
    assert!(pose(&session).get("len_flag").is_none_or(|flag| !flag.truthy()));
    ok(&mut session, "undo", "[]");
    assert!(pose(&session).get("_stykSpatial").is_none());
}

#[test]
fn size_scales_the_bone_and_every_bone_it_carries() {
    let mut session = session(5);
    assert_eq!(ok(&mut session, "setSpatialProportions", r#"[{"size":2}]"#), Value::Bool(true));
    for id in ["6", "9"] {
        assert_eq!(number(shape(&session, id).get("width")), 2.0, "bone {id} is twice as wide");
    }
    let lengths = pose(&session).get("lengths").unwrap().numbers().unwrap();
    assert_eq!((lengths[5], lengths[8], lengths[1]), (120.0, 120.0, 30.0), "the bones it carries grow with it, the others stay");
    // Resetting returns the bone to the figure's own proportions.
    assert_eq!(ok(&mut session, "resetSpatialProportions", "[]"), Value::Bool(true));
    assert_eq!(styk_doc::json::to_string(&shape(&session, "6")), r#"{"width":1,"taper":0}"#);
    let lengths = pose(&session).get("lengths").unwrap().numbers().unwrap();
    assert_eq!((lengths[5], lengths[8]), (60.0, 120.0), "only the bone's own length resets");
}

#[test]
fn proportions_outside_the_control_range_are_refused() {
    let mut session = session(5);
    let before = styk_doc::json::to_string(session.report());
    for patch in [r#"{"width":0}"#, r#"{"width":6}"#, r#"{"taper":-1}"#, r#"{"taper":3.5}"#, r#"{"size":"2"}"#, r#"{"depth":1}"#, r#"{"length":null}"#] {
        assert_eq!(refused(&mut session, "setSpatialProportions", &format!("[{patch}]")), "errors.editorSpatialShape.chooseProportionsWithinTheControlRange", "{patch}");
    }
    assert_eq!(styk_doc::json::to_string(session.report()), before);
    assert!(!session.can_undo());
}

#[test]
fn a_joint_that_is_not_a_3d_bone_has_no_proportions() {
    let mut session = session(1);
    assert_eq!(ok(&mut session, "setSpatialProportions", r#"[{"width":2}]"#), Value::Bool(false));
    assert!(!session.can_undo());
}
