//! External playback tickets must identify the actual ready native frame.

use std::sync::Arc;
use styk_engine::{Budgets, Engine};
use styk_engine::thumbnails::monitor::MonitorFrame;

const DOCUMENT: &[u8] = br#"{"version":5,"canvas_width":320,"canvas_height":200,"fps":24,"backgrounds":[],"figure_types":[{"figure_type_id":1,"segments":[{"segment_id":1,"parent_id":0,"length":40,"angle_rad":0,"thickness":8,"primitive_code":0,"color_rgb":[0,0,0]}]}],"keyframes":[{"duration_raw":10,"objects":[{"unique_id":7,"figure_type_id":1,"root_x":10,"root_y":100,"scale":1,"angles":[0]}]},{"duration_raw":1,"objects":[{"unique_id":7,"figure_type_id":1,"root_x":20,"root_y":100,"scale":1,"angles":[0]}]}]}"#;

fn engine() -> Engine {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(DOCUMENT, "json", "ticket").unwrap();
    engine
}

#[test]
fn same_tick_publication_never_substitutes_a_new_generation_for_an_old_ticket() {
    let engine = engine();
    let first = engine.frame_now_at(3.5).unwrap();
    let shown = engine.prepared_frame(3.5, None).unwrap();
    assert!(Arc::ptr_eq(&shown.frame, &first));
    assert!(Arc::ptr_eq(&shown.generation, &engine.generation().unwrap()));
    assert_eq!(shown.frame.generation, shown.generation.id);
    assert_eq!(shown.frame.tick, 3.5);
    assert!(engine.frame_matches(3.5, shown.generation.id, shown.epoch));
    engine.open(DOCUMENT, "json", "replacement").unwrap();
    let replacement = engine.frame_now_at(3.5).unwrap();
    assert_ne!(replacement.generation, shown.generation.id);
    assert!(!engine.frame_matches(3.5, shown.generation.id, shown.epoch));
    assert!(engine.prepared_frame(3.5, Some((shown.generation.id, shown.epoch))).is_none());
    assert!(Arc::ptr_eq(&engine.prepared_frame(3.5, None).unwrap().frame, &replacement));
}

#[test]
fn hidden_and_effect_changes_supersede_even_restored_same_tick_readiness() {
    let engine = engine();
    engine.frame_now_at(3.5).unwrap();
    let before = engine.prepared_frame(3.5, None).unwrap();
    engine.set_hidden(&[7]);
    assert!(engine.prepared_frame(3.5, None).is_none());
    engine.frame_now_at(3.5).unwrap();
    let hidden = engine.prepared_frame(3.5, None).unwrap();
    assert_eq!(hidden.generation.id, before.generation.id);
    assert_ne!(hidden.epoch, before.epoch);
    assert!(!engine.frame_matches(3.5, before.generation.id, before.epoch));
    engine.set_hidden(&[]);
    engine.frame_now_at(3.5).unwrap();
    let visible = engine.prepared_frame(3.5, None).unwrap();
    assert!(!engine.frame_matches(3.5, before.generation.id, before.epoch), "restoring settings does not revive an old identity");
    engine.set_effects(false);
    engine.frame_now_at(3.5).unwrap();
    assert!(!engine.frame_matches(3.5, visible.generation.id, visible.epoch));
    let no_effects = engine.prepared_frame(3.5, None).unwrap();
    engine.set_effects(true);
    engine.frame_now_at(3.5).unwrap();
    assert!(!engine.frame_matches(3.5, no_effects.generation.id, no_effects.epoch));
}

#[test]
fn cold_and_invalid_ticket_reads_do_not_prepare_or_change_native_state() {
    let engine = engine();
    let before = engine.frame_stats();
    for time in [0.0, 3.5, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        assert!(engine.prepared_frame(time, None).is_none());
        assert!(!engine.frame_matches(time, engine.generation().unwrap().id, 0));
    }
    let after = engine.frame_stats();
    assert_eq!((after.prepared, after.inline, after.cached, after.cached_bytes), (before.prepared, before.inline, before.cached, before.cached_bytes));
    engine.frame_now_at(0.0).unwrap();
    let zero = engine.prepared_frame(-0.0, None).unwrap();
    assert!(engine.frame_matches(0.0, zero.generation.id, zero.epoch));
}

#[test]
fn explicit_worker_wait_keeps_the_produced_snapshot_when_a_tiny_cache_evicts_it() {
    let engine = Engine::new(|| 0.0, Budgets { frame_cache_bytes: 0, ..Budgets::for_device(None) });
    engine.open(DOCUMENT, "json", "zero-budget").unwrap();
    engine.request_samples(0.0, &[]);
    let produced = engine.prepared_frame_now_at(3.5).unwrap();
    assert_eq!(produced.frame.tick, 3.5);
    assert_eq!(produced.generation.id, produced.frame.generation);
    assert!(Arc::ptr_eq(&produced.generation, &engine.generation().unwrap()));
    assert!(engine.frame_epoch_current(produced.generation.id, produced.epoch));
    assert!(engine.frame_at(3.5).is_none(), "non-playhead frame was actually evicted");
    assert!(!engine.frame_matches(3.5, produced.generation.id, produced.epoch));
    assert_eq!(engine.frame_now_at(3.5).unwrap().tick, 3.5, "legacy worker API still returns its uncached result");
    assert_eq!(engine.frame_stats().inline, 2);
}

#[test]
fn an_actual_shown_monitor_ticket_cannot_repair_a_newer_hidden_or_effect_scene() {
    let engine = engine();
    engine.frame_now_at(3.5).unwrap();
    let shown = engine.prepared_frame(3.5, None).unwrap();
    let mut monitor = MonitorFrame::prepared_ticket(engine.clone(), shown.generation.clone(), 3.5, shown.epoch);
    let (list, camera) = monitor.prepare().unwrap().unwrap();
    assert!(Arc::ptr_eq(&list, &shown.frame.list));
    assert_eq!(camera.map(|c| (c.x, c.y, c.scale, c.angle, c.is_default)), shown.frame.camera.map(|c| (c.x, c.y, c.scale, c.angle, c.is_default)));
    engine.set_hidden(&[7]);
    engine.frame_now_at(3.5).unwrap();
    let before = engine.frame_stats();
    assert!(monitor.prepare().unwrap().is_none());
    let after = engine.frame_stats();
    assert_eq!((after.prepared, after.inline), (before.prepared, before.inline));
    let hidden = engine.prepared_frame(3.5, None).unwrap();
    let mut next = MonitorFrame::prepared_ticket(engine.clone(), hidden.generation, 3.5, hidden.epoch);
    engine.set_effects(false);
    assert!(next.prepare().unwrap().is_none());
    assert!(engine.frame_at(3.5).is_none(), "a stale monitor never prepares its replacement");
}
