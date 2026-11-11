//! Picking artwork: the figure whose painted pixels lie under a point, topmost first, skipping the hidden
//! and the locked. The documents are opened by the engine as the app opens them.

use std::collections::HashSet;
use std::path::Path;

use styk_engine::{Budgets, Engine};
use styk_eval::geometry::build_shapes;
use styk_export::pick::{Hit, Picker, artwork};

fn clock() -> f64 {
    0.0
}

/// `path` open: its engine, so the generation (the document, its pictures) stays alive.
fn open(path: &str) -> Engine {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path);
    let bytes = std::fs::read(&file).unwrap();
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&bytes, file.extension().unwrap().to_str().unwrap(), "test").unwrap();
    engine
}

/// Where each figure's first segment lies: the middle of the line from the figure's root to its joint.
fn midpoints(engine: &Engine) -> Vec<(u32, [f64; 2])> {
    let generation = engine.generation().unwrap();
    let frame = generation.prepared.evaluate(0.0);
    let scene = build_shapes(&generation.prepared.doc, &frame, None);
    frame
        .objects
        .iter()
        .zip(&scene.objects)
        .filter(|(_, geometry)| geometry.resolved && geometry.ends.len() >= 2)
        .map(|(object, geometry)| (object.uid, [(geometry.root[0] + geometry.ends[0][0]) / 2.0, (geometry.root[1] + geometry.ends[0][1]) / 2.0]))
        .collect()
}

fn pick(engine: &Engine, point: [f64; 2], hidden: &[u32], locked: &[u32]) -> Option<Hit> {
    let generation = engine.generation().unwrap();
    let frame = generation.prepared.evaluate(0.0);
    let mut picker = Picker::default();
    artwork(&mut picker, &generation.prepared.doc, &generation.assets, &frame, point, 1.0, &hidden.iter().copied().collect::<HashSet<_>>(), &locked.iter().copied().collect::<HashSet<_>>()).unwrap()
}

const PAINTED: &str = "engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json";

#[test]
fn a_point_on_a_limb_picks_the_figure_and_a_point_beside_everything_picks_nothing() {
    let engine = open(PAINTED);
    let figures = midpoints(&engine);
    assert!(!figures.is_empty());
    for &(uid, point) in &figures {
        let hit = pick(&engine, point, &[], &[]).unwrap_or_else(|| panic!("figure {uid} at {point:?}"));
        // Figures may overlap: the one picked is one that is painted there.
        assert!(figures.iter().any(|&(other, _)| other == hit.uid));
    }
    assert_eq!(pick(&engine, [-100_000.0, -100_000.0], &[], &[]), None);
    assert_eq!(pick(&engine, [f64::NAN, 0.0], &[], &[]), None);
}

#[test]
fn hidden_and_locked_figures_are_passed_over() {
    let engine = open(PAINTED);
    let (uid, point) = midpoints(&engine)[0];
    let top = pick(&engine, point, &[], &[]).unwrap();
    let others: Vec<u32> = midpoints(&engine).iter().map(|&(other, _)| other).collect();
    // Every figure hidden, or every figure locked: nothing is picked.
    assert_eq!(pick(&engine, point, &others, &[]), None);
    assert_eq!(pick(&engine, point, &[], &others), None);
    // The one that was picked is passed over, and what lies under it (if anything) is picked instead.
    let under = pick(&engine, point, &[top.uid], &[]);
    assert_ne!(under.map(|hit| hit.uid), Some(top.uid));
    assert_eq!(pick(&engine, point, &[], &[top.uid]).map(|hit| hit.uid), under.map(|hit| hit.uid));
    let _ = uid;
}

#[test]
fn a_face_of_a_3d_figure_is_picked_where_it_is_painted() {
    // The figure's artwork is a mesh: the groups of the interface carry no drawables for it, the painted pixels do.
    let engine = open("engine/crates/styk-eval/tests/fixtures/spatial/mesh-instances.json");
    let generation = engine.generation().unwrap();
    let frame = generation.prepared.evaluate(1.0);
    let scene = build_shapes(&generation.prepared.doc, &frame, None);
    let mut picker = Picker::default();
    let mut found = false;
    // Scan the figure's bounds for a painted point.
    let bounds = styk_eval::drawlist::app_bounds(&scene, generation.prepared.doc.as_ref());
    for [min_x, min_y, max_x, max_y] in bounds.into_iter().flatten().filter(|b| b[2] > b[0] && b[3] > b[1]) {
        for i in 0..8 {
            for j in 0..8 {
                let point = [min_x + (max_x - min_x) * (i as f64 + 0.5) / 8.0, min_y + (max_y - min_y) * (j as f64 + 0.5) / 8.0];
                if artwork(&mut picker, &generation.prepared.doc, &generation.assets, &frame, point, 1.0, &HashSet::new(), &HashSet::new()).unwrap().is_some() {
                    found = true;
                }
            }
        }
    }
    assert!(found, "a mesh figure paints somewhere inside its bounds");
}
