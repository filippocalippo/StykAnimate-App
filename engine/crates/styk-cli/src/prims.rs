//! `styk prims <file> [tick…]`: what a frame's draw list is made of, and how much of it the artboard clips away.
//! Without ticks, every tick is encoded and the densest are listed.

use std::collections::BTreeMap;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{F_GLYPH_VECTOR, K_ARC, K_BEAM, K_BOX, K_CAPSULE, K_COMPOSITE, K_DISC, K_IMAGE, K_PARTICLE, K_RING, K_TRI};
use styk_eval::geometry::build;

fn kind_name(kind: u32) -> String {
    let name = match kind & 255 {
        K_CAPSULE => "capsule".to_string(),
        K_ARC => "arc".to_string(),
        K_DISC => "disc".to_string(),
        K_RING => "ring".to_string(),
        K_TRI => "tri".to_string(),
        K_IMAGE => "image".to_string(),
        K_COMPOSITE => "composite".to_string(),
        K_BOX => "box".to_string(),
        K_PARTICLE => format!("particle/shape {}", kind >> 16 & 7),
        K_BEAM => "beam".to_string(),
        other => format!("kind {other}"),
    };
    if kind & F_GLYPH_VECTOR != 0 { format!("{name} (glyph outline)") } else { name }
}

pub fn run(args: &[String]) -> i32 {
    let Some(path) = args.first() else {
        eprintln!("usage: styk prims <file> [tick…]");
        return 2;
    };
    let (p, _) = match crate::load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let assets = Assets::build(&p.doc);
    let ticks: Vec<f64> = if args.len() > 1 { args[1..].iter().filter_map(|t| t.parse().ok()).collect() } else { (0..p.total_ticks).map(f64::from).collect() };
    let mut sizes: Vec<(usize, f64)> = Vec::new();
    for &tick in &ticks {
        let frame = p.evaluate(tick);
        let scene = build(&p.doc, &frame);
        let list = crate::encode_frame(&p, &assets, tick, &frame, &scene, false, true);
        sizes.push((list.prims.len(), tick));
        if args.len() > 1 {
            let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
            for prim in &list.prims {
                *kinds.entry(kind_name(prim.kind)).or_default() += 1;
            }
            let mut culled = list.clone();
            let started = std::time::Instant::now();
            let dropped = styk_eval::drawlist::cull_outside(&mut culled, &p.doc, scene.camera.as_ref());
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            println!("tick {tick}: {} prims in {} groups, {} bytes; {} effect layers; canvas {}x{}; camera {:?}", list.prims.len(), list.groups.len(), list.prims.len() * 64, list.layers.len(), p.doc.canvas[0], p.doc.canvas[1], scene.camera.map(|c| (c.x, c.y, c.scale, c.angle)));
            for (name, count) in &kinds {
                println!("  {name:>24}: {count:>8}");
            }
            println!("  left out outside the artboard: {dropped} ({:.1}%) in {ms:.2} ms, {} stay ({} bytes)", dropped as f64 * 100.0 / list.prims.len().max(1) as f64, culled.prims.len(), culled.prims.len() * 64);
        }
    }
    if args.len() == 1 {
        sizes.sort_by(|a, b| b.0.cmp(&a.0));
        let mut by_count: Vec<usize> = sizes.iter().map(|s| s.0).collect();
        by_count.sort_unstable();
        println!("{} ticks; median {} prims; densest:", ticks.len(), by_count[by_count.len() / 2]);
        for (count, tick) in sizes.iter().take(10) {
            println!("  tick {tick}: {count} prims");
        }
    }
    0
}
