//! The actual Editor/exportSVG branch records, including scopes which paint no effect.
use std::path::Path;
use styk_engine::{Budgets, Engine};
use styk_export::{CpuExport, Settings, Smoothing};

#[test]
fn export_mode_matches_every_editor_built_branch_record() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    let records = styk_doc::json::parse(&std::fs::read(root.join("reference.json")).unwrap()).unwrap();
    for record in records.elements().unwrap() {
        let name = record.get("name").unwrap().as_str().unwrap();
        let tick = record.get("tick").unwrap().as_f64().unwrap() as u32;
        let expected = record.get("composited").unwrap().as_bool().unwrap();
        let engine = Engine::new(|| 0.0, Budgets::for_device(None));
        engine.open(&std::fs::read(root.join(format!("{name}.json"))).unwrap(), "json", "policy").unwrap();
        let frames = engine.export_frames(0).unwrap();
        let frame = frames.take(tick).unwrap();
        assert_eq!(frame.list.composited_export, expected, "{name}@{tick}: actual exportSVG branch");
        assert_eq!(Smoothing::None.edges_for(&frame.list), if expected {styk_render::Edges::Smooth} else {styk_render::Edges::Crisp}, "{name}@{tick}");
        assert_eq!(Smoothing::Edges.edges_for(&frame.list), styk_render::Edges::Smooth);
        assert_eq!(Smoothing::Sprites.edges_for(&frame.list), styk_render::Edges::Smooth);
        if ["wildcard-unused-filter", "foreign-unused-filter", "timeline-wildcard-filter"].contains(&name) {
            let generation = frames.generation();
            let evaluated = generation.prepared.evaluate(tick as f64);
            assert!(evaluated.vfx.is_none(), "{name}: metadata must not retain otherwise-empty rendered effects");
            assert!(styk_eval::vfx::evaluate(&generation.prepared.doc, &evaluated).is_none(), "{name}: public VFX output stays unchanged");
        }
    }
}

#[test]
fn composited_frames_export_smooth_even_when_none_was_requested() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    for (name, tick) in [("wildcard-unused-filter", 0), ("figure-filter", 0), ("scene-filter", 0), ("timeline-wildcard-filter", 1), ("generator-zero-rate", 1), ("mesh", 0), ("depth-surface", 0), ("nested-filter", 0), ("nested-scene-filter", 0)] {
        let engine = Engine::new(|| 0.0, Budgets::for_device(None));
        engine.open(&std::fs::read(root.join(format!("{name}.json"))).unwrap(), "json", "policy").unwrap();
        let frames = engine.export_frames(0).unwrap();
        let frame = frames.take(tick).unwrap();
        let generation = frames.generation();
        let doc = &generation.prepared.doc;
        let settings = |smoothing| Settings::new(320, 240, smoothing, styk_export::settings::MAX_PIXELS).unwrap();
        let actual = CpuExport::new(settings(Smoothing::None), styk_export::cpu::TILE_SIDE).frame(doc, &frame.list, frame.camera.as_ref(), false).unwrap();
        let expected = CpuExport::new(settings(Smoothing::Edges), styk_export::cpu::TILE_SIDE).frame(doc, &frame.list, frame.camera.as_ref(), false).unwrap();
        assert!(actual == expected, "{name}: existing JS whole-frame Canvas export remains smooth ({} differing bytes)", actual.iter().zip(&expected).filter(|(a,b)| a != b).count());
    }
}

#[test]
fn alternating_export_modes_keep_decoded_drawing_images() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(&std::fs::read(root.join("alternating-drawing.json")).unwrap(), "json", "policy").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    assert!(!images.is_empty(), "the real drawing image is decoded");
    let generation = frames.generation();
    let settings = |smoothing| Settings::new(320, 240, smoothing, styk_export::settings::MAX_PIXELS).unwrap();
    let mut exporter = CpuExport::new(settings(Smoothing::None), styk_export::cpu::TILE_SIDE);
    exporter.upload_images(&generation.assets, images.iter().cloned());
    let image_bytes = exporter.bytes().0;
    assert!(image_bytes > 0);
    let mut first = None;
    for (tick, composited) in [(0, true), (2, false), (0, true)] {
        let frame = frames.take(tick).unwrap();
        assert_eq!(frame.list.composited_export, composited);
        let actual = exporter.frame(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();
        let mut fresh = CpuExport::new(settings(if composited {Smoothing::Edges} else {Smoothing::None}), styk_export::cpu::TILE_SIDE);
        fresh.upload_images(&generation.assets, images.iter().cloned());
        let expected = fresh.frame(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();
        assert_eq!(actual, expected, "tick {tick}: a mode change preserves the uploaded drawing");
        assert_eq!(exporter.bytes().0, image_bytes, "mode changes do not release decoded images");
        if tick == 0 {
            if let Some(ref first) = first { assert_eq!(&actual, first, "returning to the first mode gives identical pixels"); }
            else { first = Some(actual); }
        }
    }
}
