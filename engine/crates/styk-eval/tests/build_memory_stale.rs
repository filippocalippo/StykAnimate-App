//! A list encoded over the last frame is the list encoded whole when a figure joins a parent, leaves it, or its parent moves.
use std::path::Path;
use std::sync::Arc;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed, encode_composed_remembering, EncodeMemory, Overrides};
use styk_eval::eval::Frame;
use styk_eval::geometry::{self, BuildMemory};

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

/// `frame` with object `slot` changed by `change`.
fn changed(frame: &Frame, slot: usize, change: impl Fn(&mut styk_eval::doc::Object)) -> Frame {
    let mut next = frame.clone();
    let mut object = (*next.objects[slot]).clone();
    change(&mut object);
    next.objects[slot] = Arc::new(object);
    next
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
