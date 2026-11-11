//! References execute the exact app closestHandle owner over real editor
//! geometry, including live incremental order and the separately reopened case.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use styk_doc::Value;
use styk_eval::picking::{self, ClosestJointOptions, JointOrder, QueryError};

fn folder() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/picking-joints") }
fn parse(path: &Path) -> Value { styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap() }
fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or_else(|| match value.as_str() {
        Some("NaN") => f64::NAN, Some("Infinity") => f64::INFINITY, Some("-Infinity") => f64::NEG_INFINITY, other => panic!("invalid numeric tag {other:?}"),
    })
}
fn point(value: &Value) -> [f64; 2] { std::array::from_fn(|i| number(&value.elements().unwrap().get(i).unwrap())) }
fn set(value: &Value, key: &str) -> HashSet<u32> { value.get(key).unwrap().elements().unwrap().iter().filter_map(|v| v.as_f64().map(|v| v as u32)).collect() }

#[test]
fn editor_all_joint_queries_preserve_explicit_live_and_reopened_order() {
    let mut references: Vec<_> = std::fs::read_dir(folder()).unwrap().filter_map(|entry| {
        let path = entry.ok()?.path(); path.to_str()?.ends_with(".reference.json").then_some(path)
    }).collect(); references.sort();
    assert_eq!(references.len(), 20);
    let mut queries = 0;
    for file in references {
        let name = file.file_name().unwrap().to_str().unwrap().strip_suffix(".reference.json").unwrap();
        let reference = parse(&file);
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let suffix = sample.get("stage").unwrap().as_str().map_or(String::new(), |stage| format!("-{stage}"));
            let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}{suffix}.json"))).unwrap());
            let tick = number(&sample.get("tick").unwrap());
            let frame = if let Some(pose) = sample.get("pose") {
                styk_eval::load::Loader::new().edit_frame(&pose, None, &prepared.doc).unwrap()
            } else if reference.get("native").unwrap().as_bool().unwrap() { prepared.native_at(tick) } else { prepared.evaluate(tick) };
            let expected_uids: Vec<_> = sample.get("frameUids").unwrap().elements().unwrap().iter().map(|v| number(&v) as u32).collect();
            assert_eq!(frame.objects.iter().map(|o| o.uid).collect::<Vec<_>>(), expected_uids, "{name}{suffix}@{tick}: exact source slot identity");
            let scene = styk_eval::geometry::build(&prepared.doc, &frame);
            let slots: Vec<_> = sample.get("order").unwrap().elements().unwrap().iter().map(|v| number(&v) as u32).collect();
            let order = JointOrder::new(&scene, &frame, &slots).unwrap();
            for call in sample.get("calls").unwrap().elements().unwrap() {
                let hidden = set(&call, "hidden"); let locked = set(&call, "locked");
                let options = ClosestJointOptions {uid: call.get("uid").unwrap().as_f64().map(|v| v as u32),
                    excluded_uid: call.get("excludedUid").unwrap().as_f64().map(|v| v as u32),
                    hidden_uids: Some(&hidden), locked_uids: Some(&locked), view_scale: number(&call.get("scale").unwrap())};
                let actual = picking::closest_joint(&order, point(&call.get("point").unwrap()), &options).unwrap();
                let expected = call.get("result").unwrap();
                let label = format!("{name}{suffix}@{tick}/query{queries}");
                if matches!(expected, Value::Null) { assert_eq!(actual, None, "{label}"); }
                else {
                    let hit = actual.unwrap_or_else(|| panic!("{label}: missing hit"));
                    assert_eq!(hit.slot, number(&expected.get("slot").unwrap()) as u32, "{label}/slot");
                    assert_eq!(hit.uid, number(&expected.get("uid").unwrap()) as u32, "{label}/uid");
                    assert_eq!(hit.id, number(&expected.get("id").unwrap()) as u32, "{label}/id");
                    assert_eq!(hit.joint, number(&expected.get("joint").unwrap()) as i32, "{label}/joint");
                    assert_eq!(hit.point, point(&expected.get("point").unwrap()), "{label}/point");
                }
                queries += 1;
            }
        }
    }
    assert_eq!(queries, 201_792);
    eprintln!("all-joint picking: {queries} exact source queries, including six live/reopened stages");
}

#[test]
fn malformed_orders_and_cold_queried_slots_refuse_without_partial_hit_or_mutation() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("native-order-static.json")).unwrap());
    let frame = prepared.native_at(0.0);
    let scene = styk_eval::geometry::build_only(&prepared.doc, &frame, &[0]);
    let before_scene = format!("{scene:?}"); let before_frame = format!("{frame:?}");
    for slots in [&[][..], &[0, 1][..], &[0, 0, 2][..], &[0, 1, 999][..], &[0, 1, 2, 3][..]] {
        assert!(matches!(JointOrder::new(&scene, &frame, slots), Err(QueryError::InvalidOrder)));
    }
    let slots = [0, 1, 2];
    let order = JointOrder::new(&scene, &frame, &slots).unwrap();
    let point = scene.objects[0].root;
    // The first ready object already supplies a hit; a later cold object must
    // refuse the entire result rather than publish that incomplete hit.
    assert_eq!(picking::closest_joint(&order, point, &ClosestJointOptions::default()), Err(QueryError::NotReady {slot: 1}));
    let uid = frame.objects[0].uid;
    assert_eq!(picking::closest_joint(&order, point, &ClosestJointOptions {uid: Some(uid), ..Default::default()}).unwrap().unwrap().uid, uid);
    let hidden = frame.objects.iter().skip(1).map(|o| o.uid).collect();
    assert_eq!(picking::closest_joint(&order, point, &ClosestJointOptions {hidden_uids: Some(&hidden), ..Default::default()}).unwrap().unwrap().uid, uid);
    assert_eq!(picking::closest_joint(&order, point, &ClosestJointOptions {locked_uids: Some(&hidden), excluded_uid: Some(uid), ..Default::default()}).unwrap(), None);
    assert_eq!(slots, [0, 1, 2]);
    assert_eq!(format!("{scene:?}"), before_scene);
    assert_eq!(format!("{frame:?}"), before_frame);
}
