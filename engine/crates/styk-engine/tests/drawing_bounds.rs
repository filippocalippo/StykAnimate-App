//! Cold drawing resources may correct metadata that was already used by a frame.

use std::path::Path;
use std::sync::{Arc, Barrier, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use styk_doc::{json, Value};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine};

fn fixture(stale: bool) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let mut value = json::parse(&std::fs::read(path).unwrap()).unwrap();
    if stale {
        let figure = &mut value.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0];
        figure.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("drawing").unwrap().make_obj().unwrap().set("bounds", Value::Null);
    }
    let object = &mut value.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0];
    object.make_obj().unwrap().set("_stykVfx", json::parse(br#"{"figure":[{"version":2,"id":"ink-bounds-test","type":"outline","enabled":true,"params":{"width":2,"opacity":1,"mode":0}}]}"#).unwrap());
    value
}

fn open(value: &Value, clock: fn() -> f64) -> Engine {
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(json::to_string(value).as_bytes(), "json", "drawing bounds").unwrap();
    engine
}

fn cel(engine: &Engine) -> Arc<styk_eval::doc::DrawingTiles> {
    engine.generation().unwrap().assets.cels.values().next().unwrap().0.clone()
}

#[test]
fn decoding_stale_bounds_rebuilds_an_already_cached_effect_grid() {
    let engine = open(&fixture(true), || 0.0);
    let before = engine.frame_now(0).unwrap();
    let shown = engine.prepared_frame(0.0, None).unwrap();
    let mut monitor = styk_engine::thumbnails::monitor::MonitorFrame::prepared_ticket(engine.clone(), shown.generation.clone(), 0.0, shown.epoch);
    assert!(!before.list.layers.is_empty(), "a real effect grid must observe the correction");
    assert!(cel(&engine).decoded_bounds.get().is_none());
    assert!(engine.step(), "the existing queued PNG decoder runs");
    assert!(engine.frame(0).is_none(), "the obsolete cached grid was invalidated");
    while engine.step() {}
    let after = engine.frame(0).expect("the cached tick was requeued");
    assert!(!engine.frame_matches(0.0, shown.generation.id, shown.epoch));
    assert!(engine.prepared_frame(0.0, Some((shown.generation.id, shown.epoch))).is_none());
    assert!(monitor.prepare().unwrap().is_none(), "new resource bounds never replace the actual shown monitor source");
    assert!(!Arc::ptr_eq(&before, &after));
    assert_ne!(before.list.layers[0].kind, after.list.layers[0].kind, "the layer is anchored to decoded ink");
    assert_eq!(cel(&engine).bounds, None, "the file's metadata is preserved");
}

#[test]
fn matching_bounds_and_repeat_decodes_keep_the_prepared_frame() {
    let engine = open(&fixture(false), || 0.0);
    let frame = engine.frame_now(0).unwrap();
    while engine.step() {}
    assert!(Arc::ptr_eq(&frame, &engine.frame(0).unwrap()), "matching published bounds need no cache reset");
    engine.redecode_images();
    while engine.step() {}
    assert!(Arc::ptr_eq(&frame, &engine.frame(0).unwrap()), "atlas recovery does not change resolved bounds");
}

#[test]
fn an_earlier_revisions_decode_corrects_a_reused_cel_in_the_current_revision() {
    let value = fixture(true);
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let text = json::to_string(&value);
    let opened = engine.open_document(OpenSource::Json { bytes: text.as_bytes(), name: "drawing bounds" }, OpenOptions::default(), &|| false).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let previous = cel(&engine);
    let mut next = opened.tree.clone();
    next.make_obj().unwrap().set("fps", Value::Num(25.0));
    engine.publish_tree(opened.lineage(), next, 2).unwrap().expect("the document is the engine's");
    assert!(Arc::ptr_eq(&previous, &cel(&engine)), "unchanged typed records share drawing resources");
    let before = engine.frame_now(0).unwrap();
    while previous.decoded_bounds.get().is_none() {
        assert!(engine.step(), "the existing worker queue reaches the previous revision's decoder after retiring displaced heads");
    }
    assert!(engine.frame(0).is_none(), "the correction belongs to the shared cel, not just the old revision");
    while engine.step() {}
    let after = engine.frame(0).unwrap();
    assert_eq!(after.generation, engine.generation().unwrap().id);
    assert_ne!(before.list.layers[0].kind, after.list.layers[0].kind);
}

#[test]
fn inline_preparation_cannot_return_a_result_from_before_a_resource_change() {
    static BLOCK: AtomicBool = AtomicBool::new(false);
    static ENTER: OnceLock<Barrier> = OnceLock::new();
    static RELEASE: OnceLock<Barrier> = OnceLock::new();
    fn clock() -> f64 {
        if BLOCK.swap(false, Ordering::SeqCst) {
            ENTER.get().unwrap().wait();
            RELEASE.get().unwrap().wait();
        }
        0.0
    }
    let engine = open(&fixture(true), clock);
    ENTER.set(Barrier::new(2)).unwrap();
    RELEASE.set(Barrier::new(2)).unwrap();
    BLOCK.store(true, Ordering::SeqCst);
    let inline = engine.clone();
    let thread = std::thread::spawn(move || inline.frame_now(0));
    ENTER.get().unwrap().wait();
    engine.step();
    RELEASE.get().unwrap().wait();
    assert!(thread.join().unwrap().is_none(), "a changed epoch supersedes the inline request");
    assert!(engine.frame_now(0).is_some(), "the caller can retry without waiting on the interface");
}

#[test]
fn export_requests_wait_for_preloading_and_stay_bounded() {
    let mut value = fixture(true);
    let keys = value.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap();
    keys[0].make_obj().unwrap().set("duration_raw", Value::Num(20.0));
    keys.push(keys[0].clone());
    let engine = open(&value, || 0.0);
    let frames = engine.export_frames(0).unwrap();
    let before = frames.take(0).unwrap();
    frames.prefetch(0..20);
    frames.decode_images();
    assert!(frames.take(0).is_none());
    assert!(frames.ready(0).is_none());
    assert_eq!(frames.waiting(), styk_engine::export::AHEAD, "preloading cannot grow the frame queue");
    while engine.step() {}
    let after = frames.ready(0).expect("preloading completion schedules deferred requests");
    assert_ne!(before.list.layers[0].kind, after.list.layers[0].kind);
    assert!(frames.take_images(usize::MAX).len() > 1);
    assert_eq!(frames.images_pending(), 0);
}

#[test]
fn dropping_an_export_cancels_its_deferred_frames_and_picture_delivery() {
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    fn clock() -> f64 { CALLS.fetch_add(1, Ordering::SeqCst); 0.0 }
    let engine = open(&fixture(true), clock);
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    frames.prefetch([0]);
    CALLS.store(0, Ordering::SeqCst);
    drop(frames);
    while engine.step() {}
    assert_eq!(CALLS.load(Ordering::SeqCst), 0, "PNG decoding calls no clock; producing an abandoned frame would");
    assert!(engine.images_pending() > 0, "the independent stage decode still delivers its pictures");
}

#[test]
fn an_export_worker_started_before_preloading_cannot_replace_or_remove_its_new_request() {
    static BLOCK: AtomicBool = AtomicBool::new(false);
    static ENTER: OnceLock<Barrier> = OnceLock::new();
    static RELEASE: OnceLock<Barrier> = OnceLock::new();
    fn clock() -> f64 {
        if BLOCK.swap(false, Ordering::SeqCst) {
            ENTER.get().unwrap().wait();
            RELEASE.get().unwrap().wait();
        }
        0.0
    }
    ENTER.set(Barrier::new(2)).unwrap();
    RELEASE.set(Barrier::new(2)).unwrap();
    for current_finishes_first in [false, true] {
        let engine = open(&fixture(true), clock);
        while engine.step() {} // Finish the independent stage decode first.
        let frames = engine.export_frames(0).unwrap();
        frames.prefetch([0]);
        BLOCK.store(true, Ordering::SeqCst);
        let worker = engine.clone();
        let old = std::thread::spawn(move || worker.step());
        ENTER.get().unwrap().wait();
        frames.decode_images();
        frames.prefetch([0]);
        assert!(engine.step(), "the export preloads its cel and schedules the newer epoch");
        let current = if current_finishes_first {
            assert!(engine.step(), "the current request finishes before the old one");
            Some(frames.ready(0).unwrap())
        } else { None };
        RELEASE.get().unwrap().wait();
        assert!(old.join().unwrap());
        if let Some(current) = current {
            assert!(Arc::ptr_eq(&current, &frames.ready(0).unwrap()), "the old callback cannot replace the completed new frame");
        } else {
            assert!(frames.ready(0).is_none(), "the old frame cannot become ready");
            assert!(frames.take(0).is_none(), "the new same-tick request still owns its inflight slot");
            assert_eq!(frames.waiting(), 1);
            assert!(engine.step());
            assert!(frames.ready(0).is_some());
        }
    }
}
