//! V13: an onion skin kept across republished generations (memory + shared objects) draws what a scene that never saw
//! another generation draws.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_doc::Value;
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::edit::{EditOptions, EditScene, Onion};
use styk_engine::{Budgets, Engine, Generation};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

const STATE: &str = r#"{"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"layerTimeline":true,"propertyChannels":true}"#;
const REQUEST: &str = r##"{"onionMode":"frames","onionBefore":2,"onionAfter":2,"onionStep":1,"onionRangeBefore":10,"onionRangeAfter":10,"onionScope":"all","onionJoined":true,"onionOpacity":0.4,"onionFade":true,"onionTint":true,"onionBeforeColor":"#e76b70","onionAfterColor":"#549de7","onionShowOnTop":false,"hidden":[]}"##;

fn republished(generation: &Generation, id: u64) -> Generation {
    Generation { id, lineage: generation.lineage, revision: generation.revision, prepared: generation.prepared.clone(), assets: generation.assets.clone(), open_ms: 0.0, anchors: generation.anchors.clone() }
}

fn drawn(scene: &mut EditScene, generation: &Generation, ghosts: &[(u32, Value, f64, Option<[u8; 3]>)], on: bool) -> Arc<styk_eval::drawlist::DrawList> {
    for (id, record, ..) in ghosts {
        if !scene.has_ghost(*id, record) {
            scene.update_ghost(generation, *id, record).unwrap();
        }
    }
    let onions: Vec<Onion<'_>> = if on { ghosts.iter().map(|(id, _, opacity, tint)| Onion { id: *id, opacity: *opacity, tint: *tint, show_on_top: false, hidden: &[] }).collect() } else { Vec::new() };
    let options = EditOptions { onions: &onions, ..Default::default() };
    scene.draw_list(generation, &options).unwrap().unwrap()
}

#[test]
fn ghosts_kept_across_generations_draw_what_fresh_ghosts_draw() {
    for name in ["eval/follow-figures.json", "eval/parallax-layers.json", "vfx/clips.json"] {
        let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures").join(name)).unwrap();
        let engine = Engine::new(clock, Budgets::for_device(None));
        let opened = engine.open_document(OpenSource::Json { bytes: &bytes, name }, OpenOptions { layer_timeline: true }, &|| false).expect("opens");
        engine.activate(&opened.typed, &opened.tree, 1).unwrap();
        let mut session = opened.start_session(STATE).expect("a session");
        let base = engine.generation().unwrap();
        let mut kept = EditScene::default();
        let mut compared = 0;
        // Playheads that overlap (ids reused with other poses), a step with no onion skins (memory released), and a return.
        for (step, (tick, on)) in [(4u32, true), (5, true), (6, true), (6, false), (5, true), (4, true), (4, true)].into_iter().enumerate() {
            let generation = republished(&base, base.id + 1 + step as u64);
            let view = format!("{{\"tick\":{tick},\"frameIndex\":0}}");
            let shown = session.show(&view, false).unwrap();
            let set = session.onions(&view, REQUEST).unwrap();
            let ghosts: Vec<(u32, Value, f64, Option<[u8; 3]>)> = set.ghosts.iter().enumerate().map(|(at, g)| (at as u32, g.record.clone(), g.opacity, g.tint)).collect();
            assert!(kept.update_shown(&generation, &shown));
            let mine = drawn(&mut kept, &generation, &ghosts, on);
            let mut fresh = EditScene::default();
            assert!(fresh.update_shown(&generation, &shown));
            let whole = drawn(&mut fresh, &generation, &ghosts, on);
            assert_eq!(mine.prims, whole.prims, "{name} step {step} (tick {tick}, onions {on})");
            if on && !ghosts.is_empty() { compared += 1; }
        }
        assert!(compared > 0, "{name}: ghosts were exercised");
        let _ = Arc::strong_count(&base.prepared);
    }
}
