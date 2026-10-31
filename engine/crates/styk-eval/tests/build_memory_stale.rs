//! A scene built over the build before it must not keep a picture of an object that changed: every object whose geometry differs from
//! the last build's says so (`Scene::built_in`, what the interface reads and the encoder keeps objects by), whatever moved it.
use std::path::Path;
use std::sync::Arc;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed, encode_composed_remembering, EncodeMemory, Overrides};
use styk_eval::eval::Frame;
use styk_eval::geometry::{self, BuildMemory, Scene};

/// Fixtures with joined figures, a movieclip instance joined to a figure (with meshes of its own) and plain loose figures.
const FIXTURES: [&str; 6] = [
    "eval/follow-figures.json",
    "eval/movieclip-joined.json",
    "eval/sticknodes-sprites.json",
    "eval/color-transitions.json",
    "picking/virtual-spatial-clip.json",
    "spatial/rotated-drawings.json",
];

fn prepared(name: &str) -> styk_eval::eval::Prepared {
    styk_eval::prepare(styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap())
}

/// What a scene holds of object `slot`: its geometry and the points of its items.
fn fingerprint(scene: &Scene, slot: usize) -> String {
    let mut text = format!("{:?}", scene.objects[slot]);
    for item in scene.items.iter().filter(|item| item.slot as usize == slot) {
        text += &format!("|{:?}", scene.points_of(item));
    }
    text
}

/// `frame` with object `slot` changed by `change`.
fn changed(frame: &Frame, slot: usize, change: impl Fn(&mut styk_eval::doc::Object)) -> Frame {
    let mut next = frame.clone();
    let mut object = (*next.objects[slot]).clone();
    change(&mut object);
    next.objects[slot] = Arc::new(object);
    next
}

fn variants(frame: &Frame, slot: usize) -> Vec<(&'static str, Frame)> {
    vec![
        ("turned", changed(frame, slot, |o| {
            let mut angles = o.angles.to_vec();
            if let Some(first) = angles.first_mut() {
                *first += 0.3;
            }
            o.angles = angles.into();
        })),
        ("moved", changed(frame, slot, |o| o.root[0] += 17.0)),
        ("scaled", changed(frame, slot, |o| o.scale *= 1.1)),
        ("unjoined", changed(frame, slot, |o| o.join = None)),
    ]
}

#[test]
fn every_object_that_changed_says_so() {
    let (mut exercised, mut stale) = (0, Vec::new());
    for name in FIXTURES {
        let prepared = prepared(name);
        let ticks = prepared.total_ticks.max(1);
        for tick in (0..ticks).step_by(((ticks / 3).max(1)) as usize) {
            let frame = prepared.evaluate(tick as f64);
            for slot in 0..frame.objects.len() {
                for (what, next) in variants(&frame, slot) {
                    let mut memory = BuildMemory::default();
                    geometry::build_remembering(&prepared.doc, &frame, &mut memory);
                    let before = memory.serial();
                    let (whole_before, whole_after) = (geometry::build_shapes(&prepared.doc, &frame, None), geometry::build_shapes(&prepared.doc, &next, None));
                    let remembered = geometry::build_remembering(&prepared.doc, &next, &mut memory);
                    for at in 0..frame.objects.len() {
                        assert_eq!(fingerprint(&remembered, at), fingerprint(&whole_after, at), "{name} tick {tick}: object {at} after object {slot} {what} is not the object built whole");
                        if fingerprint(&whole_before, at) != fingerprint(&whole_after, at) {
                            exercised += 1;
                            if remembered.built_in[at] <= before {
                                stale.push(format!("{name} tick {tick}: object {at} changed when object {slot} was {what} but is not marked as built again (build {} of {before})", remembered.built_in[at]));
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(exercised > 0);
    assert!(stale.is_empty(), "{} changes the scene does not mark, for example:
{}", stale.len(), stale.iter().take(6).cloned().collect::<Vec<_>>().join("
"));
}

#[test]
fn a_figure_that_joins_or_leaves_a_parent_is_encoded_again() {
    let mut exercised = 0;
    for name in FIXTURES {
        let prepared = prepared(name);
        let assets = Assets::build(&prepared.doc);
        let frame = prepared.evaluate(0.0);
        for slot in (0..frame.objects.len()).filter(|&slot| frame.objects[slot].join.is_some()) {
            let loose = changed(&frame, slot, |o| o.join = None);
            let parent = frame.objects[slot].join.unwrap().slot as usize;
            let moved_parent = changed(&frame, parent, |o| o.root[0] += 25.0);
            let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
            // Loose, then joined, then the parent moved, then loose again: each list is the list encoded whole.
            for (n, next) in [&frame, &loose, &frame, &moved_parent, &loose, &moved_parent].into_iter().enumerate() {
                let scene = geometry::build_remembering(&prepared.doc, next, &mut built);
                let remembered = encode_composed_remembering(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None, &mut encoded);
                let whole = encode_composed(&prepared.doc, &assets, &geometry::build_shapes(&prepared.doc, next, None), &Overrides::default(), &[], None);
                // Compared as printed: a primitive may hold a NaN.
                assert_eq!(format!("{:?}", remembered.prims), format!("{:?}", whole.prims), "{name} slot {slot} step {n}: primitives");
                assert_eq!(format!("{:?}", remembered.points), format!("{:?}", whole.points), "{name} slot {slot} step {n}: points");
                exercised += 1;
            }
        }
    }
    assert!(exercised > 0);
}
