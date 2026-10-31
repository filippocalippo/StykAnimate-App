//! The pieces of a topology edit that are plain functions of a record: what a copy of a 3D joint
//! names, what a pose keeps of the lengths it only held in its derived cache.

use styk_doc::Value;

use super::{remap_rig_references, retain_runtime_pose};

fn parse(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).unwrap()
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    value.and_then(Value::elements).map(|e| e.iter().map(|v| v.as_f64().unwrap()).collect()).unwrap_or_default()
}

#[test]
fn a_copied_bone_names_the_copies_of_the_joints_it_names() {
    let mut bone = parse(
        r#"{"segment_id":7,"parent_id":0,"_stykRig":{"spatial":{"parent":4,"turn":5,"pitch":6,"origin":[0,0,0],"tip":[0,0,10],
            "motion":{"type":"hinge","axis":[0,0,1],"driver":{"joint":4,"gain":1}}}}}"#,
    );
    remap_rig_references(&mut bone, &[(4.0, 14.0), (5.0, 15.0), (6.0, 16.0)]).unwrap();
    let spatial = bone.path(&["_stykRig", "spatial"]).unwrap();
    assert_eq!([spatial.get("parent"), spatial.get("turn"), spatial.get("pitch")].map(|v| v.and_then(Value::as_f64)), [Some(14.0), Some(15.0), Some(16.0)]);
    assert_eq!(spatial.path(&["motion", "driver", "joint"]).and_then(Value::as_f64), Some(14.0));
    assert_eq!(spatial.path(&["motion", "driver", "gain"]).and_then(Value::as_f64), Some(1.0), "what is not a joint stays");
    assert_eq!(numbers(spatial.get("tip")), [0.0, 0.0, 10.0]);
}

#[test]
fn a_copied_skin_point_binds_the_copies_of_its_bones() {
    let mut point = parse(r#"{"segment_id":8,"_stykRig":{"spatial":{"point":[1,2,3],"bindings":[{"joint":4,"weight":0.25},{"joint":9,"weight":0.75}],"extra":true}}}"#);
    remap_rig_references(&mut point, &[(4.0, 14.0)]).unwrap();
    let spatial = point.path(&["_stykRig", "spatial"]).unwrap();
    let joints: Vec<f64> = spatial.get("bindings").and_then(Value::elements).unwrap().iter().map(|b| b.get("joint").and_then(Value::as_f64).unwrap()).collect();
    assert_eq!(joints, [14.0, 9.0]);
    assert_eq!(numbers(spatial.get("point")), [1.0, 2.0, 3.0]);
    // A skin keeps its point, bindings and view points only.
    assert!(spatial.get("extra").is_none());
}

#[test]
fn a_pose_keeps_the_lengths_and_bends_only_its_cache_held() {
    let segments = [parse(r#"{"segment_id":1,"length":30}"#), parse(r#"{"segment_id":2,"length":40,"bend_rad":0}"#)];
    let mut pose = parse(r#"{"angles":[0,0],"runtime_segments":[{"length":30,"bend_rad":0},{"length":41,"bend_rad":0.2}]}"#);
    retain_runtime_pose(&mut pose, &segments);
    assert_eq!(pose.get("len_flag").and_then(Value::as_f64), Some(1.0));
    assert_eq!(numbers(pose.get("lengths")), [30.0, 41.0]);
    assert_eq!(pose.get("bend_flag").and_then(Value::as_f64), Some(1.0));
    assert_eq!(numbers(pose.get("bends")), [0.0, 0.2]);

    // Lengths the pose holds itself are not replaced, and a cache that agrees with the definition changes nothing.
    let mut own = parse(r#"{"angles":[0,0],"len_flag":1,"lengths":[1,2],"runtime_segments":[{"length":9},{"length":9}]}"#);
    retain_runtime_pose(&mut own, &segments);
    assert_eq!(numbers(own.get("lengths")), [1.0, 2.0]);
    assert!(own.get("bend_flag").is_none());
    let mut same = parse(r#"{"angles":[0,0],"runtime_segments":[{"length":30},{"length":40}]}"#);
    retain_runtime_pose(&mut same, &segments);
    assert!(same.get("len_flag").is_none() && same.get("bend_flag").is_none());
}

#[test]
fn the_poses_a_movieclip_retains_are_places_of_the_document() {
    use super::{Place, frame_at, frame_mut, places};
    let mut report = parse(
        r#"{"keyframes":[{"id":"a"}],"_styk":{"frameSources":{"s1":{"id":"b"}},"movieclipSource":{"document":{"keyframes":[{"id":"c"},{"id":"d"}],
            "_styk":{"frameSources":{"s2":{"id":"e"}},"movieclipSource":{"document":{"keyframes":[{"id":"f"}]}}}}}}}"#,
    );
    let all = places(&report);
    let ids: Vec<&str> = all.iter().map(|place| frame_at(&report, place).and_then(|frame| frame.get("id")).and_then(Value::as_str).unwrap()).collect();
    assert_eq!(ids, ["a", "b", "c", "d", "e", "f"], "the document's frames, then those of each retained source in turn");
    assert_eq!(all[3], Place::Retained(1, Box::new(Place::Keyframe(1))));
    assert_eq!(all[4], Place::Retained(1, Box::new(Place::Source("s2".into()))));
    assert_eq!(all[5], Place::Retained(2, Box::new(Place::Keyframe(0))));
    assert_eq!(all[4].source_id(), Some("s2"));
    assert_eq!(all[2].source_id(), None);

    // The way a history entry says where poses are: `sourceDepth` only below the document.
    let located = |place: &Place| {
        let mut entry = styk_doc::Obj::new();
        place.locate(&mut entry);
        styk_doc::json::to_string(&Value::object(entry))
    };
    assert_eq!(located(&all[1]), r#"{"index":-1,"sourceId":"s1"}"#);
    assert_eq!(located(&all[3]), r#"{"index":1,"sourceDepth":1}"#);
    assert_eq!(located(&all[4]), r#"{"index":-1,"sourceId":"s2","sourceDepth":1}"#);

    frame_mut(&mut report, &all[5]).unwrap().set("id", Value::str("changed"));
    assert_eq!(frame_at(&report, &all[5]).and_then(|frame| frame.get("id")).and_then(Value::as_str), Some("changed"));
    assert_eq!(frame_at(&report, &all[0]).and_then(|frame| frame.get("id")).and_then(Value::as_str), Some("a"));
    assert!(frame_at(&report, &Place::Retained(3, Box::new(Place::Keyframe(0)))).is_none(), "no source three levels down");
}
