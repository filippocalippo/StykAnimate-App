//! Frames for an export: the revision it started from, evaluated as playback evaluates it
//! (effects drawn, the session's hidden figures not hidden), a bounded number ahead.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_engine::export::AHEAD;
use styk_engine::{Budgets, Engine};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Five figures and generated effects (particles of several shapes) over twenty-six ticks:
/// the effects an export draws and a preview can turn off.
const EFFECTS: &str = "engine/crates/styk-eval/tests/fixtures/generators/explosions.json";

fn open(path: &str) -> Engine {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path);
    let engine = Engine::new(clock, Budgets::for_device(None));
    let extension = file.extension().unwrap().to_str().unwrap().to_string();
    engine.open(&std::fs::read(&file).unwrap(), &extension, "test").unwrap();
    engine
}

#[test]
fn an_export_pins_the_revision_it_started_from() {
    let engine = open(EFFECTS);
    assert!(engine.export_frames(1).is_err(), "the engine holds revision 0");
    let frames = engine.export_frames(0).unwrap();
    assert_eq!(frames.ticks(), engine.generation().unwrap().playable_ticks());
}

#[test]
fn frames_prepared_ahead_are_the_frames_drawn_inline() {
    let engine = open(EFFECTS);
    let frames = engine.export_frames(0).unwrap();
    // Ask for more than may wait: only AHEAD are prepared, by the engine's tasks (run here).
    frames.prefetch(14..24);
    assert_eq!(frames.waiting(), AHEAD, "frames waiting or being prepared are bounded");
    while engine.step() {}
    assert_eq!(frames.waiting(), AHEAD);
    for tick in 14..24 {
        let ahead = frames.take(tick).unwrap();
        let inline = engine.export_frames(0).unwrap().take(tick).unwrap();
        assert_eq!(ahead.list.prims.len(), inline.list.prims.len(), "tick {tick}");
        assert_eq!(ahead.list.bytes(), inline.list.bytes(), "tick {tick}");
        assert_eq!(ahead.camera.map(|c| (c.x, c.y, c.scale)), inline.camera.map(|c| (c.x, c.y, c.scale)));
    }
    // A tick being prepared is not drawn twice: it is waited for.
    frames.prefetch([5]);
    assert!(frames.take(5).is_none(), "in progress on a worker");
    while engine.step() {}
    assert!(frames.take(5).is_some());
}

#[test]
fn exports_draw_figures_the_session_hides_and_effects_the_preview_turns_off() {
    let engine = open(EFFECTS);
    let generation = engine.generation().unwrap();
    let uids: Vec<u32> = generation.prepared.evaluate(9.0).objects.iter().map(|o| o.uid).collect();
    let full = engine.export_frames(0).unwrap().take(9).unwrap().list.prims.len();
    engine.set_effects(false);
    let without_effects = engine.frame_now(9).unwrap().list.prims.len();
    assert!(without_effects < full, "the preview's frame turns the effects off ({without_effects} against {full} records)");
    engine.set_hidden(&uids);
    let session = engine.frame_now(9).unwrap().list.prims.len();
    assert!(session < full, "the session's frame hides figures and effects ({session} against {full} records)");
    assert_eq!(engine.export_frames(0).unwrap().take(9).unwrap().list.prims.len(), full, "the export does not");
}

#[test]
fn an_export_decodes_its_own_pictures() {
    // A drawing layer: its cels are pictures the export's renderer needs.
    let engine = open("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    // The stage's decoding takes its pictures; the export's are decoded again for its own device.
    while engine.step() {}
    let _ = engine.take_images(usize::MAX);
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    assert!(frames.images_pending() > 0);
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    assert!(!images.is_empty());
    assert_eq!(frames.images_pending(), 0);
}
