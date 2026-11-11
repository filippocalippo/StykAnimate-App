//! `styk stepbench <file> <tick> [steps]`: what one step of a drag costs natively, by phase, on a document: the frame with one object's
//! first angle turned a little further each step, built over the step before (as the session shows it) and encoded over the step before.

use std::sync::Arc;
use std::time::Instant;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed_remembering, EncodeMemory, Ghost, Overrides};
use styk_eval::onion::{compose, GhostPlace};
use styk_eval::geometry::{build_remembering, BuildMemory};

pub fn run(args: &[String]) -> i32 {
    let (Some(path), Some(tick)) = (args.first(), args.get(1).and_then(|t| t.parse::<f64>().ok())) else {
        eprintln!("usage: styk stepbench <file> <tick> [steps]");
        return 2;
    };
    let steps: usize = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(200);
    let (p, _) = match crate::load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let assets = Assets::build(&p.doc);
    let frame = p.evaluate(tick);
    // The object a drag turns: a loose one with the most segments.
    let slot = (0..frame.objects.len()).filter(|&s| !frame.objects[s].angles.is_empty() && frame.objects[s].join.is_none()).max_by_key(|&s| frame.objects[s].angles.len()).expect("a loose figure with angles");
    let turned = |step: usize| {
        let mut next = frame.clone();
        let mut object = (*next.objects[slot]).clone();
        let mut angles = object.angles.to_vec();
        angles[0] += 0.002 * step as f64;
        object.angles = angles.into();
        next.objects[slot] = Arc::new(object);
        next
    };
    let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
    let overrides = Overrides::default();
    let first = turned(0);
    let scene = build_remembering(&p.doc, &first, &mut built);
    let _ = encode_composed_remembering(&p.doc, &assets, &scene, &overrides, &[], None, &mut encoded);
    // Three onion skins, other ticks of the document, built once as the stage keeps them while a gesture goes on.
    let skins: Vec<(styk_eval::eval::Frame, styk_eval::geometry::Scene)> = [tick - 12.0, tick - 6.0, tick + 6.0].into_iter().filter(|t| *t >= 0.0).map(|t| {
        let frame = p.evaluate(t);
        let scene = styk_eval::geometry::build(&p.doc, &frame);
        (frame, scene)
    }).collect();
    let hidden: Vec<Vec<bool>> = skins.iter().map(|(frame, _)| vec![false; frame.objects.len()]).collect();
    let (mut build_ms, mut encode_ms, mut clone_ms, mut prims) = (0.0, 0.0, 0.0, 0);
    let (mut compose_ms, mut skins_ms, mut skin_prims) = (0.0, 0.0, 0);
    let mut skin_encoded = EncodeMemory::default();
    let mut last = scene;
    for step in 1..=steps {
        let next = turned(step);
        let t0 = Instant::now();
        let scene = build_remembering(&p.doc, &next, &mut built);
        let t1 = Instant::now();
        let list = encode_composed_remembering(&p.doc, &assets, &scene, &overrides, &[], None, &mut encoded);
        let t2 = Instant::now();
        // With the skins: the painter order, then the frame encoded with them.
        let places: Vec<GhostPlace<'_>> = skins.iter().zip(&hidden).map(|((frame, scene), hidden)| GhostPlace { frame, scene, hidden, show_on_top: false }).collect();
        let t4 = Instant::now();
        let order = compose(p.doc.layers.as_deref(), &next, &scene, &places);
        let t5 = Instant::now();
        let ghosts: Vec<Ghost<'_>> = skins.iter().zip(&hidden).map(|((_, scene), hidden)| Ghost { scene, opacity: 0.3, tint: Some([200, 60, 60]), hidden }).collect();
        let with = encode_composed_remembering(&p.doc, &assets, &scene, &overrides, &ghosts, Some(&order), &mut skin_encoded);
        let t6 = Instant::now();
        compose_ms += (t5 - t4).as_secs_f64() * 1000.0;
        skins_ms += (t6 - t5).as_secs_f64() * 1000.0;
        skin_prims = with.prims.len();
        let t7 = Instant::now();
        let copy = scene.clone();
        let t3 = Instant::now();
        drop(copy);
        build_ms += (t1 - t0).as_secs_f64() * 1000.0;
        encode_ms += (t2 - t1).as_secs_f64() * 1000.0;
        clone_ms += (t3 - t7).as_secs_f64() * 1000.0;
        prims = list.prims.len();
        last = scene;
    }
    let n = steps as f64;
    println!("  with {} onion skins ({skin_prims} prims): order {:.3} ms, encode+place {:.3} ms", skins.len(), compose_ms / steps as f64, skins_ms / steps as f64);
    println!(
        "{}: tick {tick}, {} objects, {} items, {} measured, {} points, {prims} prims; drag object slot {slot}",
        p.doc.name,
        last.objects.len(),
        last.items.len(),
        last.measured.len(),
        last.points.len()
    );
    println!("  per step: build {:.3} ms, encode+place {:.3} ms; (a clone of the whole scene: {:.3} ms; size of Item {} bytes)", build_ms / n, encode_ms / n, clone_ms / n, std::mem::size_of::<styk_eval::geometry::Item>());
    0
}
