//! The camera worker captures the displayed pose without preparing it on the interface.

use std::sync::Arc;

use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::thumbnails::monitor::MonitorFrame;
use styk_engine::{Budgets, Engine};

fn clock() -> f64 { 0.0 }

fn engine() -> Engine {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/parallax-layers.json");
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&std::fs::read(path).unwrap(), "json", "monitor").unwrap();
    engine
}

const POSE: &[u8] = br#"{"camera":{"is_default":false,"x":100,"y":0,"scale":1,"angle_rad":0},"objects":[{"unique_id":2,"figure_type_id":2,"root_x":300,"root_y":150,"scale":1,"angles":[0.8,2,0]}]}"#;

#[test]
fn monitor_captures_the_edit_pose_and_prepares_camera_parallax_only_on_its_worker() {
    let engine = engine();
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    scene.update(&generation, POSE).unwrap();
    let retained = Arc::strong_count(&generation);
    let mut request = MonitorFrame::edit(engine.clone(), generation.clone(), &scene, vec![], vec![(0, [5.0, 1.0])], true);
    assert_eq!(Arc::strong_count(&generation), retained + 1);
    // Capture does not draw or evaluate: the preparation cache is untouched.
    assert_eq!(engine.frame_stats().prepared, 0);
    let expected = scene.draw_list(&generation, &EditOptions { camera: true, translations: &[(0, [5.0, 1.0])], ..Default::default() }).unwrap().unwrap();
    // Another live edit cannot change the old request's shared, immutable pose.
    scene.update(&generation, &String::from_utf8(POSE.to_vec()).unwrap().replace("300", "500").into_bytes()).unwrap();
    let (captured, camera) = request.prepare().unwrap().unwrap();
    assert_eq!(captured.prims, expected.prims);
    assert_eq!(camera.unwrap().x, 100.0);
    assert_ne!(captured.prims, scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap().prims);
    drop(request);
    assert_eq!(Arc::strong_count(&generation), retained, "a cancelled or disposed request releases its pin");
}

#[test]
fn monitor_captures_prepared_frames_by_reference_without_requesting_another_frame() {
    let engine = engine();
    let generation = engine.generation().unwrap();
    let frame = engine.frame_now(11).unwrap();
    let prepared = engine.frame_stats().prepared;
    let mut request = MonitorFrame::prepared(engine.clone(), generation, frame.clone());
    let (list, camera) = request.prepare().unwrap().unwrap();
    assert!(Arc::ptr_eq(&list, &frame.list), "the cached camera frame needs no re-encoding");
    assert_eq!(camera, frame.camera);
    assert_eq!(engine.frame_stats().prepared, prepared);
}

#[test]
fn cancelled_monitor_requests_drop_their_generation_without_preparing_artwork() {
    let engine = engine();
    let generation = engine.generation().unwrap();
    let retained = Arc::strong_count(&generation);
    let mut scene = EditScene::default();
    scene.update(&generation, POSE).unwrap();
    for _ in 0..50 {
        drop(MonitorFrame::edit(engine.clone(), generation.clone(), &scene, vec![], vec![], true));
    }
    assert_eq!(Arc::strong_count(&generation), retained);
    assert_eq!(engine.frame_stats().prepared, 0);
}

fn drawing_engine(stale: bool) -> (Engine, Vec<u8>) {
    use styk_doc::{json, Value};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let mut value = json::parse(&std::fs::read(path).unwrap()).unwrap();
    if stale {
        let figure = &mut value.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0];
        figure.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("drawing").unwrap().make_obj().unwrap().set("bounds", Value::Null);
    }
    let frame = &mut value.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0];
    let object = &mut frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0];
    object.make_obj().unwrap().set("_stykVfx", json::parse(br#"{"figure":[{"version":2,"id":"monitor-ink-bounds","type":"outline","enabled":true,"params":{"width":2,"opacity":1,"mode":0}}]}"#).unwrap());
    let pose = json::to_string(frame).into_bytes();
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(json::to_string(&value).as_bytes(), "json", "monitor drawing bounds").unwrap();
    (engine, pose)
}

#[test]
fn a_prepared_monitor_ticket_rejects_the_grid_from_before_cold_cel_decode() {
    let (engine, _) = drawing_engine(true);
    let generation = engine.generation().unwrap();
    let before = engine.frame_now(0).unwrap();
    let mut request = MonitorFrame::prepared(engine.clone(), generation, before.clone());
    let prepared = engine.frame_stats().prepared;
    assert_eq!(prepared, 1, "capture must not prepare another frame");
    assert!(engine.step());
    assert!(engine.frame(0).is_none(), "the cel correction invalidates the old grid");
    let (after, _) = request.prepare().unwrap().expect("only the monitor worker repairs its missing list");
    assert!(!Arc::ptr_eq(&before.list, &after));
    assert_ne!(before.list.layers[0].kind, after.layers[0].kind);
    assert_eq!(engine.frame_stats().prepared, prepared + 1);
    assert!(Arc::ptr_eq(&engine.frame(0).unwrap().list, &after), "the monitor uses the existing frame cache");
}

#[test]
fn an_edit_snapshot_reuses_geometry_but_reads_corrected_cel_bounds_when_encoding() {
    let (engine, pose) = drawing_engine(true);
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    scene.update(&generation, &pose).unwrap();
    let before = scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap();
    let mut request = MonitorFrame::edit(engine.clone(), generation.clone(), &scene, vec![], vec![], true);
    assert!(engine.step());
    let (after, _) = request.prepare().unwrap().unwrap();
    let fresh = scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap();
    assert_ne!(before.layers[0].kind, after.layers[0].kind, "the shared drawing reads decoded artwork_bounds");
    assert_eq!(after.layers[0].kind, fresh.layers[0].kind);
    assert_eq!(after.prims, fresh.prims);
    assert_eq!(engine.frame_stats().prepared, 0, "an edit snapshot never prepares a stored frame");
    engine.redecode_images();
    while engine.step() {}
    let (again, _) = request.prepare().unwrap().unwrap();
    assert_eq!(again.layers[0].kind, after.layers[0].kind, "atlas recovery must not preserve or restore stale rectangles");
    assert_eq!(again.prims, after.prims);
}

#[test]
fn matching_cel_bounds_and_redecode_keep_the_monitor_list_in_the_engine_cache() {
    let (engine, _) = drawing_engine(false);
    let generation = engine.generation().unwrap();
    let frame = engine.frame_now(0).unwrap();
    let mut request = MonitorFrame::prepared(engine.clone(), generation, frame.clone());
    while engine.step() {}
    let (first, _) = request.prepare().unwrap().unwrap();
    assert!(Arc::ptr_eq(&frame.list, &first));
    engine.redecode_images();
    while engine.step() {}
    let (again, _) = request.prepare().unwrap().unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    assert_eq!(engine.frame_stats().prepared, 1);
}
