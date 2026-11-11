//! What the scene camera does to drawn frames: prepared frames are always shown
//! through it, edit frames only in the camera preview (docs/engine/evaluation.md).

use std::sync::OnceLock;
use std::time::Instant;

use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::{Budgets, Engine};
use styk_eval::drawlist::{encode_with, Overrides};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// The editor-built parallax fixture: a back layer (response 0.25, reference at
/// (60, -30)) and a front layer (1.5 across, 0.6 down, reference at (-40, 20)).
fn parallax_engine() -> Engine {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/parallax-layers.json");
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&std::fs::read(path).expect("fixture"), "json", "parallax-layers").expect("opens");
    engine
}

#[test]
fn prepared_frames_move_parallax_layers() {
    let engine = parallax_engine();
    let generation = engine.generation().unwrap();
    let prepared = &generation.prepared;
    for tick in [3u32, 11, 20] {
        let frame = prepared.evaluate(tick as f64);
        let parallax = frame.parallax.clone().expect("the camera has travelled: layers move");
        let scene = styk_eval::geometry::build(&prepared.doc, &frame);
        let translations = parallax.translations(&[]);
        let moved = encode_with(&prepared.doc, &generation.assets, &scene, &Overrides { translations: &translations, ..Default::default() });
        let still = encode_with(&prepared.doc, &generation.assets, &scene, &Overrides::default());
        let drawn = engine.frame_now(tick).expect("prepared");
        assert_eq!(drawn.list.prims, moved.prims, "tick {tick}: the prepared frame is drawn with its parallax");
        assert_ne!(drawn.list.prims, still.prims, "tick {tick}: parallax moves something");
    }
}

#[test]
fn edit_frames_move_parallax_layers_only_through_the_camera() {
    let engine = parallax_engine();
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    // The front figure (uid 2) alone, with the camera at (100, 0).
    let pose = r#"{"camera":{"is_default":false,"x":100,"y":0,"scale":1,"angle_rad":0},"objects":[{"unique_id":2,"figure_type_id":2,"root_x":300,"root_y":150,"scale":1,"angles":[0.8,2,0]}]}"#;
    scene.update(&generation, pose.as_bytes()).unwrap();
    let workspace = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
    let preview = scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap();
    let dragged = scene.draw_list(&generation, &EditOptions { camera: true, translations: &[(0, [5.0, 1.0])], ..Default::default() }).unwrap().unwrap();
    // (1 - 1.5) × (100 - -40) across and (1 - 0.6) × (0 - 20) down; a drag adds to it.
    let shift = |list: &styk_eval::drawlist::DrawList, d: [f32; 2]| list.prims.iter().zip(&workspace.prims).filter(|(_, w)| w.kind & 255 == styk_eval::drawlist::K_CAPSULE).all(|(p, w)| p.a == [w.a[0] + d[0], w.a[1] + d[1], w.a[2] + d[0], w.a[3] + d[1]]);
    assert!(workspace.prims.iter().filter(|p| p.kind & 255 == styk_eval::drawlist::K_CAPSULE).count() == 3, "three segments");
    assert!(shift(&preview, [-70.0, -8.0]), "the front layer moves against the camera in the preview");
    assert!(shift(&dragged, [-65.0, -7.0]), "a drag adds to the parallax");
}

/// In the camera preview an edit frame is seen through the camera at its time on the
/// camera-motion clips (`cameraAtTime`: follow travel, then impulses), the same camera
/// a prepared frame of that tick has; without that time it is the authored camera.
#[test]
fn edit_frames_in_the_preview_follow_and_shake() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/follow-figures.json");
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&std::fs::read(path).expect("fixture"), "json", "follow-figures").expect("opens");
    let generation = engine.generation().unwrap();
    let shot = generation.prepared.evaluate(14.0).camera.expect("a camera");
    let mut scene = EditScene::default();
    let pose = |time: &str| format!(r#"{{{time}"camera":{{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0}},"objects":[{{"unique_id":1,"figure_type_id":1,"root_x":300,"root_y":150,"scale":1,"angles":[0.8,2,0]}}]}}"#);
    scene.update(&generation, pose(r#""_cameraMotionTick":14,"#).as_bytes()).unwrap();
    scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap();
    let camera = scene.camera().expect("a camera");
    assert!(!camera.is_default && camera.x != 0.0, "the follow clip and the shake move the camera");
    assert_eq!([camera.x, camera.y, camera.scale, camera.angle], [shot.x, shot.y, shot.scale, shot.angle], "the camera of the prepared frame");
    scene.update(&generation, pose("").as_bytes()).unwrap();
    scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap();
    assert!(scene.camera().unwrap().is_default, "without a camera-motion time, the authored camera");
}

fn follow_engine(duration: Option<f64>) -> Engine {
    use styk_doc::{json, Value};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/follow-figures.json");
    let mut value = json::parse(&std::fs::read(path).unwrap()).unwrap();
    if let Some(duration) = duration {
        let clips = value.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("cameraMotion").unwrap().make_obj().unwrap().get_mut("clips").unwrap().make_arr().unwrap();
        for clip in clips { if clip.get("type").and_then(Value::as_str) == Some("follow") { clip.make_obj().unwrap().set("duration", Value::Num(duration)); } }
    }
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(json::to_string(&value).as_bytes(), "json", "cold follow").unwrap();
    engine
}

fn follow_pose(tick: f64) -> Vec<u8> {
    format!(r#"{{"_cameraMotionTick":{tick},"camera":{{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0}},"objects":[{{"unique_id":1,"figure_type_id":1,"root_x":300,"root_y":150,"scale":1,"angles":[0.8,2,0]}}]}}"#).into_bytes()
}

#[test]
fn cold_edit_follow_reads_do_not_prepare_a_late_path_or_use_the_authored_camera() {
    let engine = follow_engine(Some(100_000.0));
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    scene.update(&generation, &follow_pose(90_000.0)).unwrap();
    let authored = scene.camera();
    assert!(generation.prepared.travel_ready(authored, 90_000.0).is_none());
    for _ in 0..100 {
        assert!(scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().is_none());
        assert_eq!(scene.camera_pending(), Some(90_000.0));
    }
    assert!(generation.prepared.travel_ready(authored, 90_000.0).is_none(), "only workers may extend the same path");
    assert_eq!(scene.camera(), authored, "the undrawn pose is never presented as an authored-camera approximation");
    assert_eq!(engine.frame_stats().prepared, 0);
}

#[test]
fn existing_worker_frame_tickets_warm_the_exact_edit_and_monitor_prepared_owner() {
    use styk_engine::thumbnails::monitor::MonitorFrame;
    let engine = follow_engine(None);
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    scene.update(&generation, &follow_pose(14.0)).unwrap();
    assert!(scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().is_none());
    // A ready tick in another engine/generation projection cannot make this path ready.
    let other = follow_engine(None);
    other.frame_now(14).unwrap();
    assert!(generation.prepared.travel_ready(scene.camera(), 14.0).is_none());
    engine.request(14, &[14]);
    while engine.step() {}
    let drawn = scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().unwrap();
    assert_eq!(scene.camera_pending(), None);
    assert_eq!(scene.camera(), engine.frame(14).unwrap().camera);
    let mut monitor = MonitorFrame::edit(engine.clone(), generation, &scene, vec![], vec![], true);
    let (snapshot, camera) = monitor.prepare().unwrap().unwrap();
    assert_eq!(camera, scene.camera());
    assert_eq!(snapshot.prims, drawn.prims);
}

#[test]
fn floor_ticket_warms_a_fractional_pose_when_the_ceil_ticket_is_past_a_follow_clip() {
    let engine = follow_engine(Some(15.0));
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    scene.update(&generation, &follow_pose(16.75)).unwrap();
    assert!(scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().is_none());
    engine.request(16, &[17, 16]);
    while engine.step() {}
    let ready = generation.prepared.travel_ready(scene.camera(), 16.75);
    assert!(ready.is_some(), "the floor ticket warms the exact shared path at its fractional end");
    assert!(scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().is_some());
    assert_eq!(scene.camera_pending(), None);
}

#[test]
fn definitions_only_follow_waits_for_its_complete_target_owner() {
    use std::sync::Arc;
    use styk_engine::Generation;
    use styk_eval::eval::Prepared;
    let engine = follow_engine(None);
    let complete = engine.generation().unwrap();
    let mut definitions = (*complete.prepared.doc).clone();
    definitions.keyframes.clear();
    let generation = Generation { id: complete.id + 1, lineage: complete.lineage, revision: 2,
        prepared: Arc::new(Prepared::new(Arc::new(definitions))), assets: complete.assets.clone(), open_ms: 0.0, anchors: None };
    assert_eq!(generation.playable_ticks(), 0);
    assert_eq!(generation.prepared.total_ticks, 1, "the empty definitions projection has no playable target timeline");
    let mut scene = EditScene::default();
    scene.update(&generation, &follow_pose(14.0)).unwrap();
    for _ in 0..100 {
        assert!(scene.draw_list(&generation, &EditOptions { camera: true, ..Default::default() }).unwrap().is_none());
    }
    assert!(generation.prepared.travel_ready(scene.camera(), 14.0).is_none());
    engine.request(14, &[14]);
    while engine.step() {}
    assert!(generation.prepared.travel_ready(scene.camera(), 14.0).is_none(), "a different complete owner's warm path cannot certify this empty projection");
    assert!(scene.draw_list(&complete, &EditOptions { camera: true, ..Default::default() }).unwrap().is_some());
    assert_eq!(scene.camera(), engine.frame(14).unwrap().camera);
}
