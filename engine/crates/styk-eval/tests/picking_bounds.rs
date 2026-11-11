//! Numeric bounds only: the references measure with the actual app/render owner
//! and call figureIntersectsMarquee. No second bounds/evaluation model lives here.
use std::path::{Path, PathBuf};

use styk_doc::Value;
use styk_eval::picking::{self, Projection, QueryError, Rect};

fn folder() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/picking-bounds") }

fn parse(path: &Path) -> Value { styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap() }

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or_else(|| match value.as_str() {
        Some("NaN") => f64::NAN, Some("Infinity") => f64::INFINITY, Some("-Infinity") => f64::NEG_INFINITY,
        _ => f64::NAN,
    })
}

fn rect(value: &Value) -> Rect {
    let n = |key| number(&value.get(key).unwrap());
    Rect {left: n("left"), top: n("top"), right: n("right"), bottom: n("bottom")}
}

fn projection(value: &Value) -> Projection {
    Projection(std::array::from_fn(|i| number(&value.elements().unwrap().get(i).unwrap())))
}

fn bounds(value: &Value) -> Rect {
    let values = value.elements().unwrap();
    Rect {left: number(&values.get(0).unwrap()), top: number(&values.get(1).unwrap()), right: number(&values.get(2).unwrap()), bottom: number(&values.get(3).unwrap())}
}

#[test]
fn editor_measured_bounds_four_corner_marquees_and_visibility_filters() {
    let mut references: Vec<_> = std::fs::read_dir(folder()).unwrap().filter_map(|entry| {
        let path = entry.ok()?.path();
        path.to_str()?.ends_with(".reference.json").then_some(path)
    }).collect();
    references.sort();
    assert_eq!(references.len(), 11);
    let mut predicates = 0;
    let mut filtered = 0;
    for reference in references {
        let name = reference.file_name().unwrap().to_str().unwrap().strip_suffix(".reference.json").unwrap();
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let reference = parse(&reference);
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = number(&sample.get("tick").unwrap());
            let frame = if reference.get("native").unwrap().as_bool().unwrap() { prepared.native_at(tick) } else { prepared.evaluate(tick) };
            let scene = styk_eval::geometry::build(&prepared.doc, &frame);
            for measurement in sample.get("measurements").unwrap().elements().unwrap() {
                let slot = number(&measurement.get("slot").unwrap()) as usize;
                let uid = number(&measurement.get("uid").unwrap()) as u32;
                assert_eq!(frame.objects[slot].uid, uid, "{name}@{tick}: measurement identity");
                let measured = bounds(&measurement.get("bounds").unwrap());
                for query in measurement.get("predicates").unwrap().elements().unwrap() {
                    let actual = picking::bounds_intersects_marquee(&scene, &frame, slot, Some(measured), rect(&query.get("rect").unwrap()), projection(&query.get("matrix").unwrap()));
                    assert_eq!(actual, Ok(query.get("result").unwrap().as_bool().unwrap()), "{name}@{tick}/uid{uid}/predicate{predicates}");
                    predicates += 1;
                }
            }
            // The recorded source loop is authoritative about filtering/order;
            // this test only answers its exact admitted per-object predicates.
            for selection in sample.get("selections").unwrap().elements().unwrap() {
                let hidden: Vec<_> = selection.get("hidden").unwrap().elements().unwrap().iter().map(|v| number(&v) as u32).collect();
                let locked: Vec<_> = selection.get("locked").unwrap().elements().unwrap().iter().map(|v| number(&v) as u32).collect();
                let mut selected = Vec::new();
                for call in selection.get("called").unwrap().elements().unwrap() {
                    let slot = number(&call.get("slot").unwrap()) as usize;
                    let uid = frame.objects[slot].uid;
                    assert!(!hidden.contains(&uid) && !locked.contains(&uid));
                    let actual = picking::bounds_intersects_marquee(&scene, &frame, slot, Some(bounds(&call.get("bounds").unwrap())), rect(&selection.get("rect").unwrap()), projection(&selection.get("matrix").unwrap())).unwrap();
                    assert_eq!(actual, call.get("result").unwrap().as_bool().unwrap(), "{name}@{tick}: filtered call");
                    if actual { selected.push(uid); }
                    filtered += 1;
                }
                let expected: Vec<_> = selection.get("selected").unwrap().elements().unwrap().iter().map(|v| number(&v) as u32).collect();
                assert_eq!(selected, expected, "{name}@{tick}: exact source filtered result");
            }
            for query in sample.get("invalid").unwrap().elements().unwrap() {
                let value = query.get("bounds").unwrap();
                if value.as_str().is_some() {
                    // Source callback null/undefined throws; the typed resource
                    // readiness API refuses before issuing such a callback.
                    assert_eq!(query.get("error").unwrap().as_str(), Some("TypeError"));
                    assert_eq!(picking::bounds_intersects_marquee(&scene, &frame, 0, None, rect(&query.get("rect").unwrap()), projection(&query.get("matrix").unwrap())), Err(QueryError::NotReady {slot: 0}));
                    continue;
                }
                let n = |key| value.get(key).map_or(f64::NAN, |v| number(&v));
                let measured = Rect {left: n("minX"), top: n("minY"), right: n("maxX"), bottom: n("maxY")};
                let actual = picking::bounds_intersects_marquee(&scene, &frame, 0, Some(measured), rect(&query.get("rect").unwrap()), projection(&query.get("matrix").unwrap())).unwrap();
                assert_eq!(actual, query.get("result").unwrap().as_bool().unwrap(), "{name}@{tick}: invalid numeric source outcome");
            }
        }
    }
    assert_eq!(predicates, 5490);
    assert!(filtered > 2000);
    eprintln!("bounds marquee: {predicates} exact predicates, {filtered} source-filtered object calls");
}

#[test]
fn cold_missing_and_malformed_inputs_leave_scene_frame_and_measurement_unchanged() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("native-order-static.json")).unwrap());
    let mut frame = prepared.native_at(0.0);
    let scene = styk_eval::geometry::build_only(&prepared.doc, &frame, &[0]);
    let measured = Rect {left: 5.0, top: -3.0, right: 150.0, bottom: 250.0};
    let selection = Rect {left: -1000.0, top: -1000.0, right: 1000.0, bottom: 1000.0};
    let before_scene = format!("{scene:?}");
    let before_frame = format!("{frame:?}");
    let before_measured = measured;
    assert_eq!(picking::bounds_intersects_marquee(&scene, &frame, 0, None, selection, Projection::IDENTITY), Err(QueryError::NotReady {slot: 0}));
    assert_eq!(picking::bounds_intersects_marquee(&scene, &frame, 1, Some(measured), selection, Projection::IDENTITY), Err(QueryError::NotReady {slot: 1}));
    assert_eq!(picking::bounds_intersects_marquee(&scene, &frame, 999, Some(measured), selection, Projection::IDENTITY), Err(QueryError::InvalidFrame {slot: 999}));
    assert_eq!(format!("{scene:?}"), before_scene);
    assert_eq!(format!("{frame:?}"), before_frame);
    assert_eq!(measured, before_measured);
    std::sync::Arc::make_mut(&mut frame.objects[0]).uid += 999;
    let malformed = format!("{frame:?}");
    assert_eq!(picking::bounds_intersects_marquee(&scene, &frame, 0, Some(measured), selection, Projection::IDENTITY), Err(QueryError::NotReady {slot: 0}));
    assert_eq!(format!("{frame:?}"), malformed);
    assert_eq!(format!("{scene:?}"), before_scene);
    assert_eq!(measured, before_measured);
}

#[test]
fn app_bounds_are_what_the_editors_callback_measured_of_every_figure() {
    // The recorded measurements are the app's own `boundsOf` (`objectBounds` over a figure's
    // segments, polygons and mesh) with the app's resources as they stand once everything has
    // loaded: the `published` variant. The other variants stand for resources the engine does not own.
    let mut references: Vec<_> = std::fs::read_dir(folder()).unwrap().filter_map(|entry| {
        let path = entry.ok()?.path();
        path.to_str()?.ends_with(".reference.json").then_some(path)
    }).collect();
    references.sort();
    let mut compared = 0;
    for reference in references {
        let name = reference.file_name().unwrap().to_str().unwrap().strip_suffix(".reference.json").unwrap();
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let reference = parse(&reference);
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = number(&sample.get("tick").unwrap());
            let frame = if reference.get("native").unwrap().as_bool().unwrap() { prepared.native_at(tick) } else { prepared.evaluate(tick) };
            let slots: Vec<usize> = (0..frame.objects.len()).collect();
            let scene = styk_eval::geometry::build_only_measured(&prepared.doc, &frame, &slots);
            let measured = styk_eval::drawlist::app_bounds(&scene, prepared.doc.as_ref());
            for measurement in sample.get("measurements").unwrap().elements().unwrap() {
                if measurement.get("resource").unwrap().as_str() != Some("published") { continue; }
                let slot = number(&measurement.get("slot").unwrap()) as usize;
                let expected = bounds(&measurement.get("bounds").unwrap());
                let actual = measured[slot].unwrap_or_else(|| panic!("{name}@{tick}/slot{slot}: no bounds"));
                let bits = |b: [f64; 4]| b.map(f64::to_bits);
                assert_eq!(bits(actual), bits([expected.left, expected.top, expected.right, expected.bottom]), "{name}@{tick}/slot{slot}");
                compared += 1;
            }
        }
    }
    assert_eq!(compared, 61, "figures compared");
    eprintln!("app bounds: {compared} figures identical to the editor's");
}
