//! Editor-built raw body picking and the actual construction index's gesture
//! sequences, including exclusion, latch release, ties and stored snap math.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use styk_doc::Value;
use styk_eval::picking::{self, ConstructionIndex, HandleOptions, QueryError, SegmentPickOptions, SnapPoint, SpatialMode};

fn folder() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/picking-construction") }
fn parse(path: &Path) -> Value { styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap() }
fn number(v: &Value) -> f64 { v.as_f64().unwrap_or_else(|| match v.as_str().unwrap() {"Infinity" => f64::INFINITY, "NaN" => f64::NAN, "-Infinity" => f64::NEG_INFINITY, s => panic!("bad numeric tag {s}")}) }
fn n(v: &Value, key: &str, default: f64) -> f64 { v.get(key).map(number).unwrap_or(default) }
fn b(v: &Value, key: &str) -> bool { v.get(key).and_then(Value::as_bool).unwrap_or(false) }
fn p(v: &Value) -> [f64; 2] { std::array::from_fn(|i| number(&v.elements().unwrap().get(i).unwrap())) }
fn set(v: &Value, key: &str) -> Option<HashSet<u32>> { v.get(key).and_then(Value::elements).map(|vs| vs.iter().map(|v| number(&v) as u32).collect()) }
fn same(actual: f64, expected: f64, label: &str) { assert_eq!(actual, expected, "{label}: numeric mismatch; bits{:x}/{:x}", actual.to_bits(), expected.to_bits()) }
fn snap(actual: Option<SnapPoint>, expected: &Value, label: &str) {
    if expected.is_null() { assert!(actual.is_none(), "{label}: expected null, got {actual:?}"); return; }
    let actual = actual.unwrap_or_else(|| panic!("{label}: missing snap point"));
    let expected_point = p(expected.get("point").unwrap());
    same(actual.point[0], expected_point[0], &format!("{label}/x")); same(actual.point[1], expected_point[1], &format!("{label}/y"));
    assert_eq!(actual.id, expected.get("id").and_then(Value::as_f64).map(|v| v as u32), "{label}: id");
    assert_eq!(actual.kind.map(|kind| kind.name()), expected.get("kind").and_then(Value::as_str), "{label}: kind");
}

#[test]
fn editor_raw_body_and_gesture_construction_queries() {
    let mut files: Vec<_> = std::fs::read_dir(folder()).unwrap().filter_map(|entry| {let p = entry.ok()?.path();p.to_str()?.ends_with(".reference.json").then_some(p)}).collect();files.sort();
    assert_eq!(files.len(), 18);
    let (mut bodies, mut nearest, mut snaps) = (0, 0, 0);
    for file in files {
        let name = file.file_name().unwrap().to_str().unwrap().strip_suffix(".reference.json").unwrap();
        let reference = parse(&file);
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = n(&sample, "tick", 0.0);
            let frame = if b(&reference, "native") {prepared.native_at(tick)} else {prepared.evaluate(tick)};
            let scene = styk_eval::geometry::build(&prepared.doc, &frame);
            for query in sample.get("body").unwrap().elements().unwrap() {
                let label = format!("{name}@{tick}/{}", query.get("name").unwrap().as_str().unwrap());
                let o = query.get("options").unwrap();
                let selected = set(o, "selectedUids");let hidden = set(o, "hiddenUids");let locked = set(o, "lockedUids");
                let options = HandleOptions {selected_uid:o.get("selectedUid").and_then(Value::as_f64).map(|v| v as u32), selected_uids:selected.as_ref(), hidden_uids:hidden.as_ref(), locked_uids:locked.as_ref(),
                    show_static:b(o,"showStatic"),allow_static_manipulation:b(o,"allowStaticManipulation"),selected_joint:n(o,"selectedJoint",-1.0) as i32,builder:b(o,"builder"),selected_branch:b(o,"selectedBranch"),
                    spatial_mode:if o.get("spatialMode").and_then(Value::as_str)==Some("rotate"){SpatialMode::Rotate}else{SpatialMode::Pose}, ..Default::default()};
                let batch = picking::handles(&scene,&frame,&options).unwrap();
                let expected = query.get("handles").unwrap().elements().unwrap();
                assert_eq!(batch.handles.len(),expected.len(),"{label}: descriptors");
                for (actual,expected) in batch.handles.iter().zip(expected) {
                    assert_eq!(actual.uid as f64,n(&expected,"uid",-1.0),"{label}: uid");assert_eq!(actual.id as f64,n(&expected,"id",-1.0),"{label}: id");assert_eq!(actual.joint as f64,n(&expected,"joint",-2.0),"{label}: joint");
                    assert_eq!(frame.objects[actual.slot as usize].uid,actual.uid,"{label}: slot routing");
                }
                for (index,pick) in query.get("picks").unwrap().elements().unwrap().iter().enumerate() {
                    let o = pick.get("options").unwrap();
                    let options = SegmentPickOptions {uid:o.get("uid").and_then(Value::as_f64).map(|v|v as u32),scale:n(o,"scale",1.0),padding:n(o,"padding",8.0)};
                    let actual=picking::pick_segment(&scene,&frame,&batch.handles,p(pick.get("point").unwrap()),&options).unwrap();
                    let expected=pick.get("result").unwrap();
                    if expected.is_null(){assert!(actual.is_none(),"{label}/body{index}: expected null, got{actual:?}");}
                    else {let actual=actual.unwrap_or_else(||panic!("{label}/body{index}: missing hit"));assert_eq!(actual.handle as f64,n(expected,"handle",-1.0),"{label}/body{index}: priority");assert_eq!(expected.get("kind").unwrap().as_str(),Some("segment-body"));same(actual.distance_squared,n(expected,"distanceSquared",-1.0),&format!("{label}/body{index}: distance"));}
                    bodies+=1;
                }
            }
            for query in sample.get("construction").unwrap().elements().unwrap() {
                let uid=n(&query,"uid",-1.0) as u32;let slot=frame.objects.iter().position(|o|o.uid==uid).unwrap();
                let excluded=set(&query,"excluded").unwrap();let mut index=ConstructionIndex::new(&scene,&frame,slot,&excluded).unwrap();
                let label=format!("{name}@{tick}/uid{uid}/exclude{excluded:?}");
                for (i,q) in query.get("nearest").unwrap().elements().unwrap().iter().enumerate(){
                    snap(index.nearest(p(q.get("point").unwrap()),n(&q,"radius",8.0),b(&q,"jointsOnly")),q.get("result").unwrap(),&format!("{label}/nearest{i}"));nearest+=1;
                }
                for (i,q) in query.get("sequence").unwrap().elements().unwrap().iter().enumerate(){
                    let o=q.get("options").unwrap();
                    snap(Some(index.snap(p(q.get("point").unwrap()),n(o,"radius",8.0),o.get("origin").map(p),b(o,"disabled"))),q.get("result").unwrap(),&format!("{label}/snap{i}"));snaps+=1;
                }
            }
        }
    }
    println!("verified{bodies} raw body picks,{nearest} nearest queries,{snaps} gesture snaps exactly");
}

#[test]
fn raw_queries_refuse_missing_or_invalid_ranges_without_building_geometry() {
    let prepared=styk_eval::prepare(styk_eval::open(&folder().join("body-curves.json")).unwrap());let frame=prepared.native_at(0.0);let mut scene=styk_eval::geometry::build(&prepared.doc,&frame);
    let batch=picking::handles(&scene,&frame,&HandleOptions::default()).unwrap();let before=scene.items.len();
    scene.objects[0].raw_segments.clear();
    assert!(matches!(ConstructionIndex::new(&scene,&frame,0,&HashSet::new()),Err(QueryError::NotReady{slot:0})));
    assert_eq!(picking::pick_segment(&scene,&frame,&batch.handles,[0.0,0.0],&SegmentPickOptions{uid:Some(frame.objects[0].uid),..Default::default()}),Err(QueryError::NotReady{slot:0}));
    assert_eq!(scene.items.len(),before);
    assert_eq!(picking::pick_segment(&scene,&frame,&batch.handles,[f64::NAN,0.0],&SegmentPickOptions::default()),Ok(None));
    let mut scene=styk_eval::geometry::build(&prepared.doc,&frame);scene.objects[0].raw_segments[0].points=(u32::MAX,u32::MAX);
    assert!(matches!(ConstructionIndex::new(&scene,&frame,0,&HashSet::new()),Err(QueryError::NotReady{slot:0})));
}
