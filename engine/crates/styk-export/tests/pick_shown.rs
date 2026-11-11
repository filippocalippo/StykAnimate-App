//! A pick of the frame on show (`pick::shown`, what the stage asks on every pointer move) answers what a pick that works the whole
//! frame out again answers (`pick::artwork`): on ordinary documents (figures, movieclips, meshes, effects) and on a dense frame of
//! hundreds of overlapping figures, at points on artwork and beside it, with figures hidden and locked, asked again and again of one
//! picker, with the session's scene of the frame given or built by the pick, and across frames.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use styk_engine::{Budgets, Engine};
use styk_eval::geometry::build_shapes;
use styk_export::pick::{Picker, artwork, shown};

fn clock() -> f64 {
    0.0
}

fn open_bytes(bytes: &[u8], extension: &str) -> Engine {
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(bytes, extension, "test").unwrap();
    engine
}

fn open(path: &str) -> Engine {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path);
    open_bytes(&std::fs::read(&file).unwrap(), file.extension().unwrap().to_str().unwrap())
}

/// A frame of `count` figures, each a chain of `segments` lines, crowded into a few hundred units so that they overlap; every
/// seventh is translucent and every fifth has thin lines.
fn dense(count: usize, segments: usize) -> Vec<u8> {
    let mut figures = Vec::new();
    for kind in 0..3 {
        let segs: Vec<String> = (0..segments).map(|i| {
            let thickness = if kind == 2 { 0.6 } else { 4.0 - i as f64 * 0.02 };
            format!(r#"{{"segment_id":{},"parent_id":{},"length":{},"angle_rad":0,"thickness":{thickness},"bend_rad":0,"primitive_code":0,"aux_code":0,"flags":0,"segment_type":"line","segment_kind":"line","color_rgb":[{},43,43],"transparency":0,"visible":true,"z_order":{}}}"#, i + 1, i, 6.0 + (i % 3) as f64, 40 * kind, i + 1)
        }).collect();
        figures.push(format!(r#"{{"figure_type_id":{},"name":"F{kind}","segment_count":{segments},"segments":[{}],"polyfills":[],"image_assets":[],"text_assets":[]}}"#, kind + 1, segs.join(",")));
    }
    let objects: Vec<String> = (0..count).map(|n| {
        let kind = if n % 5 == 0 { 2 } else { n % 2 };
        let angles: Vec<String> = (0..segments).map(|i| format!("{:.3}", ((n * 7 + i * 3) % 23) as f64 * 0.11 - 1.2)).collect();
        let transparency = if n % 7 == 0 { 120 } else { 0 };
        format!(r#"{{"object_slot":{n},"unique_id":{},"figure_type_id":{},"root_x":{:.2},"root_y":{:.2},"scale":1,"color_override_raw":0,"field28":{transparency},"transparency":{transparency},"angles":[{}],"len_flag":0,"lengths":[],"bend_flag":0,"bends":[],"join":null}}"#,
            n + 1, kind + 1, 200.0 + ((n * 37) % 300) as f64, 150.0 + ((n * 53) % 260) as f64, angles.join(","))
    }).collect();
    let order: Vec<String> = (0..count).map(|n| n.to_string()).collect();
    format!(r#"{{"version":5,"canvas_width":800,"canvas_height":600,"fps":24,"backgrounds":[],"figure_types":[{}],"keyframes":[{{"duration_raw":10,"background_id":0,"background_id_b":0,"background_mix":0,"camera":{{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0}},"objects":[{}],"object_draw_order":[{}]}}]}}"#,
        figures.join(","), objects.join(","), order.join(",")).into_bytes()
}

/// Points over a frame's figures: along each figure's bones, over the items it draws (a movieclip's contents too), and beside
/// everything.
fn points(scene: &styk_eval::geometry::Scene, per_figure: usize) -> Vec<[f64; 2]> {
    let mut points = vec![[-100_000.0, -100_000.0]];
    for item in scene.items.iter().step_by((scene.items.len() / 200).max(1)) {
        points.push([(item.start[0] + item.end[0]) / 2.0, (item.start[1] + item.end[1]) / 2.0]);
    }
    for geometry in scene.objects.iter().filter(|g| g.resolved) {
        let mut at = geometry.root;
        for end in geometry.ends.iter().take(per_figure) {
            points.push([(at[0] + end[0]) / 2.0, (at[1] + end[1]) / 2.0]);
            // Just beside the line too: a pixel or two off, where antialiasing reaches or does not.
            points.push([(at[0] + end[0]) / 2.0 + 1.7, (at[1] + end[1]) / 2.0 - 2.3]);
            at = *end;
        }
    }
    points
}

/// Every point picked by `shown` (one picker for all, the frame's scene given or not) and by `artwork`, with nothing, the topmost
/// hits and some others hidden or locked.
fn agree(engine: &Engine, tick: f64, per_figure: usize, with_scene: bool) -> usize {
    let generation = engine.generation().unwrap();
    let doc = &generation.prepared.doc;
    let frame = Arc::new(generation.prepared.evaluate(tick));
    let scene = Arc::new(build_shapes(doc, &frame, None));
    let given = with_scene.then_some(&scene);
    let mut kept = Picker::default();
    let none = HashSet::new();
    let mut hits = 0;
    let points = points(&scene, per_figure);
    let mut tops = Vec::new();
    for &point in &points {
        for scale in [1.0, 4.0] {
            let fast = shown(&mut kept, doc, &generation.assets, generation.id, &frame, given, point, scale, &none, &none).unwrap();
            let whole = artwork(&mut Picker::default(), doc, &generation.assets, &frame, point, scale, &none, &none).unwrap();
            assert_eq!(fast, whole, "tick {tick} point {point:?} scale {scale}");
            if let Some(hit) = fast {
                hits += 1;
                tops.push(hit.uid);
            }
        }
    }
    // The topmost figures hidden, then locked: what lies under them is picked alike.
    let some: HashSet<u32> = tops.iter().step_by(2).copied().collect();
    for &point in points.iter().step_by(3) {
        for (hidden, locked) in [(&some, &none), (&none, &some)] {
            let fast = shown(&mut kept, doc, &generation.assets, generation.id, &frame, given, point, 1.0, hidden, locked).unwrap();
            let whole = artwork(&mut Picker::default(), doc, &generation.assets, &frame, point, 1.0, hidden, locked).unwrap();
            assert_eq!(fast, whole, "tick {tick} point {point:?} with figures passed over");
        }
    }
    hits
}

#[test]
fn a_pick_of_the_frame_on_show_is_the_pick_of_the_whole_frame_on_ordinary_documents() {
    for (path, tick) in [
        ("engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json", 0.0),
        ("engine/crates/styk-eval/tests/fixtures/spatial/mesh-instances.json", 1.0),
        ("engine/crates/styk-eval/tests/fixtures/eval/movieclip-joined.json", 2.0),
        ("engine/crates/styk-eval/tests/fixtures/eval/movieclip-break-apart.json", 1.0),
        ("engine/crates/styk-eval/tests/fixtures/vfx/movieclip.json", 3.0),
        ("engine/crates/styk-eval/tests/fixtures/vfx/clips.json", 2.0),
        ("engine/crates/styk-eval/tests/fixtures/picking/virtual-clip.json", 0.0),
    ] {
        let engine = open(path);
        let hits = agree(&engine, tick, 12, false) + agree(&engine, tick, 12, true);
        assert!(hits > 0, "{path}: some point is on artwork");
    }
}

#[test]
fn a_pick_of_the_frame_on_show_is_the_pick_of_the_whole_frame_on_a_dense_frame() {
    let engine = open_bytes(&dense(240, 24), "json");
    let generation = engine.generation().unwrap();
    assert_eq!(generation.prepared.evaluate(0.0).objects.len(), 240);
    let hits = agree(&engine, 0.0, 2, true);
    assert!(hits > 100, "the crowded figures are hit ({hits})");
    assert!(agree(&engine, 0.0, 1, false) > 50);
}

#[test]
fn what_a_pick_keeps_follows_the_frame_on_show() {
    // One picker across two frames of one document and across documents: each answers as a pick of its own frame does.
    let painted = open("engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json");
    let crowded = open_bytes(&dense(60, 12), "json");
    let mut kept = Picker::default();
    let none = HashSet::new();
    for _ in 0..2 {
        for engine in [&painted, &crowded] {
            let generation = engine.generation().unwrap();
            let doc = &generation.prepared.doc;
            for tick in [0.0, 1.0] {
                let frame = Arc::new(generation.prepared.evaluate(tick));
                let scene = build_shapes(doc, &frame, None);
                for point in points(&scene, 4) {
                    let fast = shown(&mut kept, doc, &generation.assets, generation.id, &frame, None, point, 1.0, &none, &none).unwrap();
                    assert_eq!(fast, artwork(&mut Picker::default(), doc, &generation.assets, &frame, point, 1.0, &none, &none).unwrap(), "tick {tick} point {point:?}");
                }
            }
        }
    }
}

#[test]
fn a_pick_of_the_frame_on_show_reads_the_scene_it_is_given() {
    // The scene of the frame on show is not built again: given another tick's scene, the pick answers from that scene's artwork.
    let engine = open_bytes(&dense(60, 12), "json");
    let generation = engine.generation().unwrap();
    let doc = &generation.prepared.doc;
    let frame = Arc::new(generation.prepared.evaluate(0.0));
    let mut moved = (*frame).clone();
    for object in &mut moved.objects {
        let mut shifted = (**object).clone();
        shifted.root = [shifted.root[0] + 5000.0, shifted.root[1]];
        *object = Arc::new(shifted);
    }
    let away = Arc::new(build_shapes(doc, &moved, None));
    let here = build_shapes(doc, &frame, None);
    let none = HashSet::new();
    let on_artwork: Vec<[f64; 2]> = points(&here, 2).into_iter().filter(|&point| artwork(&mut Picker::default(), doc, &generation.assets, &frame, point, 1.0, &none, &none).unwrap().is_some()).collect();
    assert!(!on_artwork.is_empty());
    let mut kept = Picker::default();
    for point in on_artwork {
        assert_eq!(shown(&mut kept, doc, &generation.assets, generation.id, &frame, Some(&away), point, 1.0, &none, &none).unwrap(), None, "{point:?}: the figures of the scene given are elsewhere");
        let shifted = [point[0] + 5000.0, point[1]];
        assert!(shown(&mut kept, doc, &generation.assets, generation.id, &frame, Some(&away), shifted, 1.0, &none, &none).unwrap().is_some(), "{shifted:?}: where the scene given draws them");
    }
}

#[test]
fn a_pick_prepared_on_a_worker_answers_as_the_pick_of_the_whole_frame() {
    let engine = open_bytes(&dense(80, 12), "json");
    let generation = engine.generation().unwrap();
    let doc = &generation.prepared.doc;
    let none = HashSet::new();
    let frame = Arc::new(generation.prepared.evaluate(0.0));
    let scene = Arc::new(build_shapes(doc, &frame, None));
    // Worked out on another thread, taken by the picker: it holds the frame, and answers what a whole pick answers.
    let (doc_w, frame_w, scene_w, id) = (generation.prepared.clone(), frame.clone(), scene.clone(), generation.id);
    let prepared = std::thread::spawn(move || styk_export::pick::prepare(&doc_w.doc, id, &frame_w, &scene_w)).join().unwrap();
    let mut kept = Picker::default();
    assert!(kept.take(prepared).is_none());
    assert!(kept.holds(generation.id, &frame));
    for point in points(&scene, 3) {
        let fast = shown(&mut kept, doc, &generation.assets, generation.id, &frame, Some(&scene), point, 1.0, &none, &none).unwrap();
        assert_eq!(fast, artwork(&mut Picker::default(), doc, &generation.assets, &frame, point, 1.0, &none, &none).unwrap(), "{point:?}");
    }
    // Prepared for another frame, it is not used: the frame on show is worked out again.
    let mut moved = (*frame).clone();
    for object in &mut moved.objects {
        let mut shifted = (**object).clone();
        shifted.root = [shifted.root[0] + 5000.0, shifted.root[1]];
        *object = Arc::new(shifted);
    }
    let moved = Arc::new(moved);
    let elsewhere = Arc::new(build_shapes(doc, &moved, None));
    drop(kept.take(styk_export::pick::prepare(doc, generation.id, &moved, &elsewhere)));
    assert!(!kept.holds(generation.id, &frame));
    for point in points(&scene, 2) {
        let fast = shown(&mut kept, doc, &generation.assets, generation.id, &frame, Some(&scene), point, 1.0, &none, &none).unwrap();
        assert_eq!(fast, artwork(&mut Picker::default(), doc, &generation.assets, &frame, point, 1.0, &none, &none).unwrap(), "{point:?} after a stale preparation");
    }
}
