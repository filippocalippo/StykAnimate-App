//! Generated effects in the engine: the anchor cache gives the batches an
//! uncached evaluation gives, prepared frames and edit frames draw them, and an
//! edit frame whose budget runs out refines over the next frames.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::{Budgets, Engine};
use styk_eval::drawlist::{K_BEAM, K_PARTICLE};
use styk_eval::vfx::generated::{self, Evaluate};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/generators").join(format!("{name}.json"))).unwrap()
}

fn open(name: &str) -> Engine {
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&fixture(name), "json", name).unwrap();
    engine
}

#[test]
fn cached_anchors_give_the_uncached_batches() {
    for name in ["auras", "smoke", "particles", "movieclip"] {
        let engine = open(name);
        let generation = engine.generation().unwrap();
        let anchors = generation.anchors.as_ref().expect("a document with generated effects has an anchor cache");
        let prepared = &generation.prepared;
        // Consecutive ticks, as playback asks for them: later ones reuse earlier anchors.
        for tick in 0..prepared.total_ticks.min(20) {
            let frame = prepared.evaluate(tick as f64);
            let scene = styk_eval::geometry::build(&prepared.doc, &frame);
            let cached = generated::build(prepared, &frame, &scene, Some(tick as f64), Some(&anchors.sampler(clock, f64::INFINITY)), 1.0);
            let fresh = generated::build(prepared, &frame, &scene, Some(tick as f64), Some(&Evaluate), 1.0);
            assert_eq!(cached, fresh, "{name} tick {tick}");
        }
        assert!(!anchors.is_empty(), "{name}: nothing was cached");
    }
}

#[test]
fn documents_without_generated_effects_have_no_cache() {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let doc = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/vfx/clips.json")).unwrap();
    engine.open(&doc, "json", "clips").unwrap();
    assert!(engine.generation().unwrap().anchors.is_none());
}

fn generated_prims(list: &styk_eval::drawlist::DrawList) -> usize {
    list.prims.iter().filter(|p| matches!(p.kind & 255, K_PARTICLE | K_BEAM)).count()
}

#[test]
fn prepared_frames_draw_generated_effects_unless_effects_are_off() {
    let engine = open("explosions");
    let frame = engine.frame_now(6).unwrap();
    assert!(generated_prims(&frame.list) > 100, "explosions draw at tick 6");
    assert!(frame.list.materials != 0, "sprites name their material rows");
    engine.set_effects(false);
    let plain = engine.frame_now(6).unwrap();
    assert_eq!(generated_prims(&plain.list), 0);
}

#[test]
fn an_edit_frame_refines_trails_its_budget_left_out() {
    let engine = open("auras");
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    // A pose of the document sent as the edit frame, composed at tick 13 of the effects timeline.
    let document = styk_doc::json::parse(&fixture("auras")).unwrap();
    let mut text = styk_doc::json::to_string(&document.get("keyframes").and_then(|k| k.item(0)).unwrap());
    text.insert_str(text.len() - 1, r#","_vfxTimelineTick":13"#);
    scene.update(&generation, text.as_bytes()).unwrap();
    // A clock that moves a millisecond each time it is read, and no budget: every earlier
    // anchor is left for later frames.
    fn ticking() -> f64 {
        static NOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        NOW.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as f64
    }
    let options = EditOptions { clock: Some(ticking), anchor_budget_ms: 0.0, ..Default::default() };
    let first = scene.draw_list(&generation, &options).unwrap().unwrap();
    assert!(generated_prims(&first) > 0 && scene.refining(), "an incomplete batch draws and asks for another frame");
    let options = EditOptions { clock: Some(clock), anchor_budget_ms: 1e9, ..Default::default() };
    let second = scene.draw_list(&generation, &options).unwrap().unwrap();
    assert!(!scene.refining(), "the next frame completes the batch");
    assert!(generated_prims(&second) > 0);
    // Dragging the first figure moves its effects with it (`offsetGeneratorBatch`), no other.
    let translations = [(0u32, [12.0, -5.0])];
    let dragged = scene.draw_list(&generation, &EditOptions { translations: &translations, ..options }).unwrap().unwrap();
    let origins = |list: &styk_eval::drawlist::DrawList| -> Vec<[f32; 2]> {
        list.prims.iter().filter(|p| p.kind & 255 == K_PARTICLE).map(|p| [list.paints[p.paint as usize + 1][0], list.paints[p.paint as usize + 1][1]]).collect()
    };
    let (still, moved) = (origins(&second), origins(&dragged));
    assert_eq!(still.len(), moved.len());
    let shifted = still.iter().zip(&moved).filter(|(a, b)| a != b).count();
    assert!(shifted > 0 && shifted < still.len(), "{shifted} of {} particles moved", still.len());
    assert!(still.iter().zip(&moved).all(|(a, b)| a == b || (b[0] - a[0] == 12.0 && b[1] - a[1] == -5.0)));
}
