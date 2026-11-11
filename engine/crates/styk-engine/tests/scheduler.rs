//! The frame scheduler with real worker threads.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use styk_engine::{Budgets, Engine};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// A two-key walk of one three-segment figure: 21 ticks (the last key adds one).
fn project() -> Vec<u8> {
    let figure = r#"{"figure_type_id":1,"name":"walker","segments":[
        {"segment_id":1,"parent_id":0,"length":40,"angle_rad":0,"thickness":8,"primitive_code":0,"color_rgb":[0,0,0]},
        {"segment_id":2,"parent_id":1,"length":30,"angle_rad":0.5,"thickness":8,"primitive_code":0,"color_rgb":[200,0,0]},
        {"segment_id":3,"parent_id":2,"length":20,"angle_rad":0,"thickness":6,"primitive_code":1,"color_rgb":[0,0,200]}]}"#;
    let key = |x: f64, a: f64| format!(r#"{{"duration_raw":20,"objects":[{{"unique_id":7,"figure_type_id":1,"root_x":{x},"root_y":100,"scale":1,"angles":[{a},0.5,0]}}]}}"#);
    format!(r#"{{"version":5,"canvas_width":320,"canvas_height":200,"fps":20,"figure_types":[{figure}],"keyframes":[{},{}],"backgrounds":[]}}"#, key(60.0, 0.0), key(240.0, 1.5)).into_bytes()
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn with_workers(count: usize, run: impl FnOnce(&Engine)) {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let workers: Vec<_> = (0..count)
        .map(|_| {
            let engine = engine.clone();
            std::thread::spawn(move || engine.work())
        })
        .collect();
    run(&engine);
    engine.stop();
    for worker in workers {
        worker.join().unwrap();
    }
}

#[test]
fn workers_prepare_every_requested_tick() {
    with_workers(4, |engine| {
        let opened = engine.open(&project(), "styk", "walk").unwrap();
        assert_eq!((opened.ticks, opened.figures, opened.keyframes), (21, 1, 2));
        assert_eq!(opened.canvas, [320, 200]);
        let ticks: Vec<u32> = (0..opened.ticks).collect();
        engine.request(0, &ticks);
        wait_until("all frames", || ticks.iter().all(|&tick| engine.frame(tick).is_some()));
        let stats = engine.frame_stats();
        assert_eq!(stats.cached, 21);
        assert_eq!(stats.prepared, 21, "no tick is prepared twice");
        assert_eq!(stats.inline, 0);
        // The figure moves: a middle frame differs from the first.
        let first = engine.frame(0).unwrap();
        let middle = engine.frame(10).unwrap();
        assert!(!first.list.prims.is_empty());
        assert_ne!(first.list.prims, middle.list.prims);
        assert_eq!(middle.tick, 10.0);
    });
}

#[test]
fn a_new_document_drops_frames_of_the_old_one() {
    with_workers(2, |engine| {
        let first = engine.open(&project(), "styk", "one").unwrap();
        engine.request(0, &(0..21).collect::<Vec<_>>());
        wait_until("the first frames", || engine.frame(20).is_some());
        let second = engine.open(&project(), "styk", "two").unwrap();
        assert!(second.generation > first.generation);
        assert!(engine.frame(20).is_none(), "frames of the replaced document are gone");
        engine.request(5, &[5, 6]);
        wait_until("frames of the new document", || engine.frame(6).is_some());
        assert_eq!(engine.frame(6).unwrap().generation, second.generation);
        assert_eq!(engine.frame_stats().cached, 2);
    });
}

#[test]
fn a_frame_can_be_prepared_on_the_calling_thread_without_workers() {
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&project(), "styk", "walk").unwrap();
    assert!(engine.frame(3).is_none());
    let frame = engine.frame_now(3).unwrap();
    assert_eq!(frame.tick, 3.0);
    assert_eq!(engine.frame_stats().inline, 1);
    assert!(engine.frame_now(21).is_none(), "past the end");
    // A host without threads drives the same queue itself.
    engine.request(0, &[0, 1, 2]);
    while engine.step() {}
    assert!(engine.frame(2).is_some());
}

#[test]
fn the_cache_stays_within_its_budget_and_keeps_the_playhead() {
    let engine = Engine::new(clock, styk_engine::Budgets { frame_cache_bytes: 3000, ..styk_engine::Budgets::for_device(None) });
    engine.open(&project(), "styk", "walk").unwrap();
    for tick in 0..21 {
        engine.request(tick, &[tick]);
        while engine.step() {}
    }
    let stats = engine.frame_stats();
    assert!(stats.cached_bytes <= 3000, "{} bytes cached", stats.cached_bytes);
    assert!(stats.cached < 21);
    assert!(engine.frame(20).is_some(), "the frame on screen is never evicted");
}

#[test]
fn a_damaged_file_reports_what_is_wrong() {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let error = engine.open(b"STYK\x02\x02\x00\x00", "styk", "broken").unwrap_err().to_string();
    assert!(error.contains("header"), "{error}");
    assert!(engine.generation().is_none());
}
