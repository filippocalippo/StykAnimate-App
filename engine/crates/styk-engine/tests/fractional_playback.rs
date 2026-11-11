//! Fractional samples from the actual editor-built origin/rig layer-sheet fixture.
use styk_engine::{Budgets, Engine, FrameData};
use std::sync::Arc;

fn opened() -> Engine {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-rig-pose-support-sheet.document.json");
    engine.open(&std::fs::read(path).unwrap(), "json", "fractional playback").unwrap();
    engine
}
// The same request and readiness path used by fractional browser packets.
fn request_samples(engine: &Engine, playhead: f64, samples: &[f64]) {
    engine.request_samples(playhead, samples);
}
fn frame_at(engine: &Engine, sample: f64) -> Option<Arc<FrameData>> { engine.frame_at(sample) }

#[test]
fn fractional_3_5_is_distinct_from_integer_3_and_draws_the_same_prepared_owner_at_3_5() {
    let engine = opened();
    request_samples(&engine, 3.5, &[3.0, 3.5]);
    while engine.step() {}
    let actual = frame_at(&engine, 3.5).expect("sample ready");
    let integer = engine.frame(3).unwrap();
    let generation = engine.generation().unwrap();
    let expected_frame = generation.prepared.evaluate(3.5);
    let scene = styk_eval::geometry::build(&generation.prepared.doc, &expected_frame);
    let translations = expected_frame.parallax.as_ref().map(|parallax| parallax.translations(&[])).unwrap_or_default();
    let expected = styk_eval::drawlist::encode_with(&generation.prepared.doc, &generation.assets, &scene, &styk_eval::drawlist::Overrides { translations: &translations, ..Default::default() });
    assert_ne!(integer.list.prims, expected.prims, "the real fixture moves between 3 and 3.5");
    assert_eq!(actual.list.prims, expected.prims, "fractional input must not reuse the integer 3 list");
    assert_eq!(actual.camera, scene.camera);
    assert_eq!(actual.tick, 3.5);
    assert!(!Arc::ptr_eq(&actual, &integer));
    assert_eq!(engine.frame_stats().cached, 2, "both samples occupy the same bounded cache");
    assert_eq!(engine.frame_stats().inline, 0, "the worker queue prepared both samples");
}

#[test]
fn integer_playback_and_export_retain_exact_primitive_camera_and_background_values() {
    let engine = opened();
    engine.request(3, &[3]);
    while engine.step() {}
    let playback = engine.frame(3).unwrap();
    let export = engine.export_frames(0).unwrap().take(3).unwrap();
    assert_eq!(playback.list.prims, export.list.prims);
    assert_eq!(playback.list.points, export.list.points);
    assert_eq!(playback.camera, export.camera);
    assert_eq!(playback.background, export.background);
}

#[test]
fn finite_sample_keys_share_integer_zero_and_reject_invalid_times_without_preparing() {
    let engine = opened();
    request_samples(&engine, -0.0, &[-0.0, 0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 9.0]);
    // An invalid playhead cannot replace the accepted queue.
    request_samples(&engine, f64::NAN, &[3.5]);
    assert!(engine.frame_at(0.0).is_none(), "readiness must not prepare");
    assert_eq!(engine.frame_stats().prepared, 0);
    while engine.step() {}
    let zero = engine.frame_at(-0.0).unwrap();
    assert!(Arc::ptr_eq(&zero, &engine.frame(0).unwrap()));
    assert_eq!(zero.tick.to_bits(), 0, "negative zero is canonical");
    assert_eq!(engine.frame_stats().prepared, 1, "duplicates use the same in-flight identity");
    assert_eq!(engine.frame_stats().cached, 1);
    for tick in [f64::NAN, f64::INFINITY, -1.0, 9.0] {
        assert!(engine.frame_at(tick).is_none());
        assert!(engine.frame_now_at(tick).is_none());
    }
    assert_eq!(engine.frame_stats().inline, 0);
    let cold = opened();
    assert_eq!(cold.frame_now_at(-0.0).unwrap().tick.to_bits(), 0, "worker repair uses canonical zero too");
}

#[test]
fn replacement_requests_cancel_unselected_fractional_work_and_new_generation_retires_old_samples() {
    let engine = opened();
    request_samples(&engine, 3.5, &[3.5, 4.5]);
    request_samples(&engine, 5.5, &[5.5]);
    while engine.step() {}
    assert!(engine.frame_at(3.5).is_none());
    assert!(engine.frame_at(4.5).is_none());
    let old = engine.frame_at(5.5).unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-rig-pose-support-sheet.document.json");
    engine.open(&std::fs::read(path).unwrap(), "json", "replacement").unwrap();
    assert!(engine.frame_at(5.5).is_none());
    request_samples(&engine, 5.5, &[5.5]);
    while engine.step() {}
    let current = engine.frame_at(5.5).unwrap();
    assert_ne!(old.generation, current.generation);
    assert!(!Arc::ptr_eq(&old, &current));
    request_samples(&engine, 6.5, &[6.5]);
    request_samples(&engine, 6.5, &[]);
    while engine.step() {}
    assert!(engine.frame_at(6.5).is_none(), "empty request cancels pending samples");
}

#[test]
fn the_monitor_uses_the_actual_fractional_sample_and_reuses_the_same_cache() {
    let engine = opened();
    request_samples(&engine, 3.5, &[3.0, 3.5]);
    while engine.step() {}
    let frame = engine.frame_at(3.5).unwrap();
    let generation = engine.generation().unwrap();
    let mut monitor = styk_engine::thumbnails::monitor::MonitorFrame::prepared(engine.clone(), generation, frame.clone());
    let before = engine.frame_stats();
    let (list, camera) = monitor.prepare().unwrap().unwrap();
    assert!(Arc::ptr_eq(&list, &frame.list));
    assert_eq!(camera, frame.camera);
    assert_eq!(engine.frame_stats().prepared, before.prepared);
    assert_eq!(engine.frame_stats().inline, 0);
}

#[test]
fn threaded_workers_prepare_fractional_samples_once_and_projection_changes_invalidate_both_kinds() {
    let engine = opened();
    let workers: Vec<_> = (0..2).map(|_| {
        let engine = engine.clone();
        std::thread::spawn(move || engine.work())
    }).collect();
    request_samples(&engine, 3.5, &[3.5, 3.0, 3.5]);
    let started = std::time::Instant::now();
    while engine.frame_at(3.5).is_none() || engine.frame(3).is_none() {
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        std::thread::yield_now();
    }
    assert_eq!(engine.frame_stats().prepared, 2);
    assert_eq!(engine.frame_stats().inline, 0);
    // Stop the worker selection before changing projection so the refusal of old
    // cached entries is observed independently of new requests.
    engine.stop();
    for worker in workers { worker.join().unwrap(); }
    engine.set_effects(false);
    assert!(engine.frame_at(3.5).is_none());
    assert!(engine.frame(3).is_none());
    assert_eq!(engine.frame_stats().cached, 0);
}
