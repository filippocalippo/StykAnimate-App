//! References call the actual editor/canvas query owners before this port.
//! The same evaluated scene answers every option set without another build.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use styk_doc::Value;
use styk_eval::picking::{self, HandleOptions, PickOptions, Projection, QueryError, Rect, SpatialMode};

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/picking")
}

fn parse(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

fn number(value: &Value, key: &str, default: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn boolean(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn set(value: &Value, key: &str) -> Option<HashSet<u32>> {
    value.get(key).and_then(Value::elements).map(|values| values.iter().map(|v| v.as_f64().unwrap() as u32).collect())
}

fn point(value: &Value) -> [f64; 2] {
    let p = value.elements().unwrap();
    std::array::from_fn(|i| {
        let value = p.get(i).unwrap();
        value.as_f64().unwrap_or_else(|| match value.as_str().unwrap() {
            "NaN" => f64::NAN, "Infinity" => f64::INFINITY, "-Infinity" => f64::NEG_INFINITY, tag => panic!("unknown number {tag}"),
        })
    })
}

fn projection(value: &Value) -> Projection {
    Projection(std::array::from_fn(|i| value.elements().unwrap().get(i).unwrap().as_f64().unwrap()))
}

fn exact(actual: f64, expected: f64, label: &str) {
    assert_eq!(actual, expected, "{label}: {} vs {} (bits {:x}/{:x})", actual, expected, actual.to_bits(), expected.to_bits());
}

#[test]
fn editor_recorded_handles_picks_and_origin_marquees() {
    let mut files: Vec<_> = std::fs::read_dir(folder()).unwrap().filter_map(|entry| {
        let path = entry.ok()?.path();
        path.to_str()?.ends_with(".reference.json").then_some(path)
    }).collect();
    files.sort();
    assert_eq!(files.len(), 15);
    let mut queries = 0;
    let mut picks = 0;
    for reference in files {
        let name = reference.file_name().unwrap().to_str().unwrap().strip_suffix(".reference.json").unwrap();
        let project = folder().join(format!("{name}.json"));
        let prepared = styk_eval::prepare(styk_eval::open(&project).unwrap());
        let reference = parse(&reference);
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = number(&sample, "tick", 0.0);
            let frame = if boolean(&reference, "native", false) { prepared.native_at(tick) } else { prepared.evaluate(tick) };
            let scene = styk_eval::geometry::build(&prepared.doc, &frame);
            for query in sample.get("queries").unwrap().elements().unwrap() {
                let label = format!("{name}@{tick}/{}", query.get("name").unwrap().as_str().unwrap());
                let o = query.get("options").unwrap();
                let selected = set(o, "selectedUids");
                let handle_ids = set(o, "selectedHandleIds");
                let hidden = set(o, "hiddenUids");
                let locked = set(o, "lockedUids");
                let join_targets = set(o, "joinTargetUids");
                let options = HandleOptions {
                    selected_uid: o.get("selectedUid").and_then(Value::as_f64).map(|v| v as u32),
                    selected_uids: selected.as_ref(), selected_handle_ids: handle_ids.as_ref(), hidden_uids: hidden.as_ref(), locked_uids: locked.as_ref(), join_target_uids: join_targets.as_ref(),
                    selected_joint: number(o, "selectedJoint", -1.0) as i32,
                    selected_branch: boolean(o, "selectedBranch", false), builder: boolean(o, "builder", false),
                    show_unselected: boolean(o, "showUnselected", true), show_static: boolean(o, "showStatic", false),
                    attaching: boolean(o, "attaching", false), allow_static_manipulation: boolean(o, "allowStaticManipulation", false),
                    select_static: boolean(o, "selectStatic", false), show_detailed: boolean(o, "showDetailed", false),
                    spatial_mode: match o.get("spatialMode").and_then(Value::as_str) { Some("rotate") => SpatialMode::Rotate, Some("figure") => SpatialMode::Figure, _ => SpatialMode::Pose },
                    view_scale: number(o, "viewScale", 1.0), auto_size: boolean(o, "autoSize", true),
                    min_diameter: number(o, "minDiameter", 4.0), max_diameter: number(o, "maxDiameter", 10.0),
                };
                let batch = picking::handles(&scene, &frame, &options).unwrap_or_else(|e| panic!("{label}: {e:?}"));
                let expected = query.get("handles").unwrap().elements().unwrap();
                assert_eq!(batch.handles.len(), expected.len(), "{label}: handle count");
                for (index, (h, expected)) in batch.handles.iter().zip(expected).enumerate() {
                    let label = format!("{label}/handle{index}");
                    assert_eq!(h.uid as f64, number(&expected, "uid", -1.0), "{label}: uid");
                    assert_eq!(h.joint as f64, number(&expected, "joint", -2.0), "{label}: joint");
                    assert_eq!(h.id as f64, number(&expected, "id", -1.0), "{label}: id");
                    assert_eq!(h.kind.name(), expected.get("kind").unwrap().as_str().unwrap(), "{label}: kind");
                    assert_eq!(h.action.name(), expected.get("action").unwrap().as_str().unwrap(), "{label}: action");
                    for (key, actual) in [("selected", h.selected), ("joined", h.joined), ("static", h.is_static), ("ik", h.ik), ("connector", h.connector)] {
                        assert_eq!(actual, boolean(&expected, key, false), "{label}: {key}");
                    }
                    assert_eq!(format!("#{:02x}{:02x}{:02x}", h.color[0], h.color[1], h.color[2]), expected.get("color").unwrap().as_str().unwrap(), "{label}: color");
                    let p = point(expected.get("point").unwrap());
                    exact(h.point[0], p[0], &format!("{label}/x"));
                    exact(h.point[1], p[1], &format!("{label}/y"));
                    exact(h.screen_radius, number(&expected, "screenRadius", -1.0), &format!("{label}/screenRadius"));
                    exact(h.radius, number(&expected, "radius", -1.0), &format!("{label}/radius"));
                }
                let groups = query.get("groups").unwrap().elements().unwrap();
                assert_eq!(batch.groups.len(), groups.len(), "{label}: group count");
                for (actual, expected) in batch.groups.iter().zip(groups) {
                    assert_eq!(actual.uid as f64, number(&expected, "uid", -1.0), "{label}: group uid");
                    assert_eq!(actual.offset as f64, number(&expected, "offset", -1.0), "{label}: group offset");
                    assert_eq!(actual.count as f64, number(&expected, "count", -1.0), "{label}: group count");
                }
                for (index, pick) in query.get("picks").unwrap().elements().unwrap().iter().enumerate() {
                    let o = pick.get("options").unwrap();
                    let options = PickOptions { nearest: boolean(o, "nearest", false), preferred_uid: o.get("preferredUid").and_then(Value::as_f64).map(|v| v as u32), min_radius: number(o, "minRadius", 0.0), radius: o.get("radius").and_then(Value::as_f64), projection: pick.get("matrix").map(projection) };
                    let actual = picking::pick_handle(&batch.handles, point(pick.get("point").unwrap()), &options);
                    let expected = pick.get("result").unwrap();
                    if expected.is_null() {
                        assert!(actual.is_none(), "{label}/pick{index}: expected null, got {actual:?}");
                    } else {
                        let actual = actual.unwrap_or_else(|| panic!("{label}/pick{index}: missing hit"));
                        assert_eq!(actual.handle as f64, number(&expected, "handle", -1.0), "{label}/pick{index}: descriptor");
                        exact(actual.distance_squared, number(&expected, "distanceSquared", -1.0), &format!("{label}/pick{index}: distanceSquared"));
                    }
                    picks += 1;
                }
                queries += 1;
            }
            for marquee in sample.get("marquees").unwrap().elements().unwrap() {
                let uid = number(&marquee, "uid", -1.0) as u32;
                let slot = frame.objects.iter().position(|o| o.uid == uid).unwrap();
                let r = marquee.get("rect").unwrap();
                let rect = Rect { left: number(r, "left", 0.0), right: number(r, "right", 0.0), top: number(r, "top", 0.0), bottom: number(r, "bottom", 0.0) };
                let result = picking::origin_intersects_marquee(&scene, &frame, slot, rect, projection(marquee.get("matrix").unwrap())).unwrap();
                assert_eq!(result, boolean(&marquee, "result", false), "{name}@{tick}: marquee uid{uid}");
            }
            for invalid in sample.get("invalidPicks").unwrap().elements().unwrap() {
                assert!(invalid.get("result").unwrap().is_null());
                let batch = picking::handles(&scene, &frame, &HandleOptions::default()).unwrap();
                assert_eq!(picking::pick_handle(&batch.handles, point(invalid.get("point").unwrap()), &PickOptions {radius: Some(f64::INFINITY), ..Default::default()}), None);
            }
        }
    }
    println!("verified {queries} handle queries and {picks} picks against editor descriptors");
}

#[test]
fn filtered_snapshots_refuse_atomically_and_hidden_objects_need_no_geometry() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("native-order-static.json")).unwrap());
    let mut frame = prepared.native_at(0.0);
    let scene = styk_eval::geometry::build_only(&prepared.doc, &frame, &[0]);
    let before_items = scene.items.len();
    let before_resolved = scene.objects.iter().map(|g| g.resolved).collect::<Vec<_>>();
    let hidden = frame.objects.iter().skip(1).map(|o| o.uid).collect();
    assert!(matches!(picking::handles(&scene, &frame, &HandleOptions::default()), Err(QueryError::NotReady { .. })));
    let result = picking::handles(&scene, &frame, &HandleOptions { hidden_uids: Some(&hidden), ..Default::default() }).unwrap();
    assert!(result.handles.iter().all(|h| h.uid == frame.objects[0].uid));
    assert_eq!(scene.items.len(), before_items);
    assert_eq!(scene.objects.iter().map(|g| g.resolved).collect::<Vec<_>>(), before_resolved);
    assert_eq!(picking::origin_intersects_marquee(&scene, &frame, 1, Rect {left: 0.0, top: 0.0, right: 1000.0, bottom: 1000.0}, Projection::IDENTITY), Err(QueryError::NotReady {slot: 1}));
    frame.draw_order.push(999);
    assert_eq!(picking::handles(&scene, &frame, &HandleOptions {hidden_uids: Some(&hidden), ..Default::default()}), Err(QueryError::InvalidFrame {slot: 999}));
}

#[test]
fn nonfinite_pointer_input_has_no_hit_even_with_infinite_radius() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("native-order-static.json")).unwrap());
    let frame = prepared.native_at(0.0);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = picking::handles(&scene, &frame, &HandleOptions::default()).unwrap();
    for point in [[f64::NAN, 0.0], [0.0, f64::INFINITY], [f64::NEG_INFINITY, 0.0]] {
        assert_eq!(picking::pick_handle(&batch.handles, point, &PickOptions {radius: Some(f64::INFINITY), ..Default::default()}), None);
    }
    assert_eq!(picking::pick_handle(&batch.handles, batch.handles[0].point, &PickOptions {radius: Some(f64::NAN), ..Default::default()}), None);
}
