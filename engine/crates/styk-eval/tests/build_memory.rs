//! Building a frame over the build before it (`geometry::build_remembering`): the scene is the scene built whole, and an object
//! whose inputs did not change is not built again.
use std::path::Path;
use std::sync::Arc;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed, encode_composed_remembering, EncodeMemory, Overrides};
use styk_eval::eval::Frame;
use styk_eval::geometry::{self, BuildMemory};

const FIXTURES: [&str; 5] = ["eval/follow-figures.json", "eval/movieclip-joined.json", "eval/color-transitions.json", "eval/sticknodes-sprites.json", "eval/parallax-layers.json"];

fn prepared(name: &str) -> styk_eval::eval::Prepared {
    styk_eval::prepare(styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap())
}

/// `frame` with the first angle of object `slot` turned.
fn turned(frame: &Frame, slot: usize) -> Frame {
    let mut next = frame.clone();
    let mut object = (*next.objects[slot]).clone();
    let mut angles = object.angles.to_vec();
    angles[0] += 0.25;
    object.angles = angles.into();
    next.objects[slot] = Arc::new(object);
    next
}

/// The scenes are equal in everything but the bytes they account for (the capacity their buffers grew to).
fn same_scene(remembered: &geometry::Scene, whole: &geometry::Scene, what: &str) {
    let (mut remembered, mut whole) = (remembered.clone(), whole.clone());
    remembered.retained_bytes = 0;
    remembered.built_in.clear();
    whole.retained_bytes = 0;
    assert_eq!(format!("{remembered:?}"), format!("{whole:?}"), "{what}");
}

#[test]
fn a_build_over_the_last_is_the_build_whole() {
    for name in FIXTURES {
        let prepared = prepared(name);
        let mut memory = BuildMemory::default();
        let ticks = prepared.total_ticks.max(1);
        let mut last: Option<Frame> = None;
        for tick in (0..ticks).step_by(((ticks / 5).max(1)) as usize) {
            let frame = prepared.evaluate(tick as f64);
            same_scene(&geometry::build_remembering(&prepared.doc, &frame, &mut memory), &geometry::build_shapes(&prepared.doc, &frame, None), &format!("{name} tick {tick}"));
            // The same frame again: everything is kept.
            same_scene(&geometry::build_remembering(&prepared.doc, &frame, &mut memory), &geometry::build_shapes(&prepared.doc, &frame, None), &format!("{name} tick {tick} again"));
            // One object turned: the others are kept, and the scene is still the scene built whole.
            if let Some(slot) = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty()) {
                let next = turned(&frame, slot);
                same_scene(&geometry::build_remembering(&prepared.doc, &next, &mut memory), &geometry::build_shapes(&prepared.doc, &next, None), &format!("{name} tick {tick} turned"));
            }
            // The bounds of some of the objects are those of the whole scene's, and the others are not measured.
            let scene = geometry::build_remembering(&prepared.doc, &frame, &mut memory);
            let all = styk_eval::drawlist::app_bounds(&scene, prepared.doc.as_ref());
            let some: Vec<usize> = (0..frame.objects.len()).step_by(2).collect();
            let measured = styk_eval::drawlist::app_bounds_of(&scene, prepared.doc.as_ref(), &some);
            for slot in 0..frame.objects.len() {
                assert_eq!(measured[slot], if some.contains(&slot) { all[slot] } else { None }, "{name} tick {tick} slot {slot}: bounds");
            }
            last = Some(frame);
        }
        assert!(last.is_some(), "{name}: some frame was built");
    }
}

#[test]
fn only_what_changed_is_built_again() {
    let prepared = prepared("eval/follow-figures.json");
    let frame = prepared.evaluate(3.0);
    assert!(frame.objects.len() >= 2, "the fixture has figures to leave alone");
    let mut memory = BuildMemory::default();
    geometry::build_remembering(&prepared.doc, &frame, &mut memory);
    let first: Vec<u64> = (0..frame.objects.len()).map(|slot| memory.built_in(slot)).collect();
    assert!(first.iter().all(|&build| build == memory.serial()), "a first build builds every object: {first:?}");
    // The same frame builds nothing.
    geometry::build_remembering(&prepared.doc, &frame, &mut memory);
    assert_eq!((0..frame.objects.len()).map(|slot| memory.built_in(slot)).collect::<Vec<_>>(), first);
    // One object turned builds that object, and the objects that hang from it, and no other.
    let slot = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty() && frame.objects[slot].join.is_none()).expect("a loose figure to turn");
    let next = turned(&frame, slot);
    geometry::build_remembering(&prepared.doc, &next, &mut memory);
    let rebuilt: Vec<usize> = (0..frame.objects.len()).filter(|&at| memory.built_in(at) == memory.serial()).collect();
    assert!(rebuilt.contains(&slot), "the object turned is built again");
    assert!(rebuilt.len() < frame.objects.len(), "figures that did not change are not built again: {rebuilt:?}");
    for at in 0..frame.objects.len() {
        let hangs = frame.objects[at].join.is_some_and(|join| rebuilt.contains(&(join.slot as usize)));
        assert!(at == slot || hangs || memory.built_in(at) == first[at], "object {at} was built again though nothing it reads changed");
    }
}

fn same_list(remembered: &styk_eval::drawlist::DrawList, whole: &styk_eval::drawlist::DrawList, what: &str) {
    assert_eq!(remembered.prims, whole.prims, "{what}: primitives");
    assert_eq!(remembered.paints, whole.paints, "{what}: paints");
    assert_eq!(remembered.points, whole.points, "{what}: points");
    assert_eq!((remembered.background_prims, remembered.groups.len(), remembered.passes.len()), (whole.background_prims, whole.groups.len(), whole.passes.len()), "{what}: structure");
}

#[test]
fn a_list_encoded_over_the_last_is_the_list_encoded_whole() {
    for name in FIXTURES {
        let prepared = prepared(name);
        let assets = Assets::build(&prepared.doc);
        let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
        let ticks = prepared.total_ticks.max(1);
        for tick in (0..ticks).step_by(((ticks / 5).max(1)) as usize) {
            let frame = prepared.evaluate(tick as f64);
            let mut frames = vec![frame.clone(), frame.clone()];
            if let Some(slot) = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty()) {
                frames.push(turned(&frame, slot));
            }
            for (n, frame) in frames.iter().enumerate() {
                let scene = geometry::build_remembering(&prepared.doc, frame, &mut built);
                for translations in [&[][..], &[(0u32, [3.5, -2.0])][..]] {
                    let overrides = Overrides { translations, ..Default::default() };
                    let remembered = encode_composed_remembering(&prepared.doc, &assets, &scene, &overrides, &[], None, &mut encoded);
                    let whole = encode_composed(&prepared.doc, &assets, &scene, &overrides, &[], None);
                    same_list(&remembered, &whole, &format!("{name} tick {tick} frame {n} moved {}", !translations.is_empty()));
                }
            }
        }
    }
}

/// An onion skin's scene is built plain (no shapes) over its own memory: the same scene as built whole, and an object that did not
/// change is not built again when the scene is built again (the document it is drawn against was published anew).
#[test]
fn a_plain_build_over_the_last_is_the_build_whole() {
    for name in FIXTURES {
        let prepared = prepared(name);
        let mut memory = BuildMemory::default();
        let frame = prepared.evaluate(0.0);
        same_scene(&geometry::build_remembering_plain(&prepared.doc, &frame, &mut memory), &geometry::build(&prepared.doc, &frame), &format!("{name}: first"));
        let first: Vec<u64> = (0..frame.objects.len()).map(|slot| memory.built_in(slot)).collect();
        same_scene(&geometry::build_remembering_plain(&prepared.doc, &frame, &mut memory), &geometry::build(&prepared.doc, &frame), &format!("{name}: again"));
        assert_eq!((0..frame.objects.len()).map(|slot| memory.built_in(slot)).collect::<Vec<_>>(), first, "{name}: nothing is built again");
        if let Some(slot) = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty()) {
            let next = turned(&frame, slot);
            same_scene(&geometry::build_remembering_plain(&prepared.doc, &next, &mut memory), &geometry::build(&prepared.doc, &next), &format!("{name}: turned"));
            assert_ne!(memory.built_in(slot), first[slot], "{name}: the object turned is built again");
        }
    }
}

/// What a scene holds, hashed: the splice that copies each object's items whole and moves their offsets in place makes the scene the earlier
/// splice made (one item at a time). The hashes were taken from the scenes that splice built.
fn scene_hash(scene: &geometry::Scene) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for text in [format!("{:?}", scene.items), format!("{:?}", scene.measured), format!("{:?}", scene.points), format!("{:?}", scene.objects), format!("{:?}", (&scene.owners, &scene.owner_scales, &scene.chains, &scene.depths, &scene.transitions, &scene.figure_of))] {
        text.hash(&mut hasher);
    }
    hasher.finish()
}

#[test]
fn the_splice_builds_the_scenes_it_always_built() {
    const GOLDEN: &[(&str, u64)] = &[
        ("eval/follow-figures.json@0/shapes", 9260092647048683142),
        ("eval/follow-figures.json@0/plain", 3877823771807028660),
        ("eval/follow-figures.json@10/shapes", 4527983015965267547),
        ("eval/follow-figures.json@10/plain", 2423068542283550744),
        ("eval/follow-figures.json@20/shapes", 11751969934320958837),
        ("eval/follow-figures.json@20/plain", 1751786692682100179),
        ("eval/follow-figures.json@30/shapes", 13134133317579003660),
        ("eval/follow-figures.json@30/plain", 7477376613737881651),
        ("eval/movieclip-joined.json@0/shapes", 12379828606899932695),
        ("eval/movieclip-joined.json@0/plain", 12379828606899932695),
        ("eval/movieclip-joined.json@1/shapes", 12855078733131791230),
        ("eval/movieclip-joined.json@1/plain", 12855078733131791230),
        ("eval/movieclip-joined.json@2/shapes", 10512748651274421293),
        ("eval/movieclip-joined.json@2/plain", 10512748651274421293),
        ("eval/movieclip-joined.json@3/shapes", 247246952413319544),
        ("eval/movieclip-joined.json@3/plain", 247246952413319544),
        ("eval/movieclip-joined.json@4/shapes", 13996485741383948181),
        ("eval/movieclip-joined.json@4/plain", 6266595525932977566),
        ("eval/movieclip-joined.json@5/shapes", 16135691631065022092),
        ("eval/movieclip-joined.json@5/plain", 16135691631065022092),
        ("eval/movieclip-joined.json@6/shapes", 15281548501367868946),
        ("eval/movieclip-joined.json@6/plain", 15281548501367868946),
        ("eval/color-transitions.json@0/shapes", 11434378900019083131),
        ("eval/color-transitions.json@0/plain", 13973462044609293519),
        ("eval/color-transitions.json@3/shapes", 14538475209792665042),
        ("eval/color-transitions.json@3/plain", 4875774806482542132),
        ("eval/color-transitions.json@6/shapes", 539366277391803682),
        ("eval/color-transitions.json@6/plain", 1782342150844229138),
        ("eval/color-transitions.json@9/shapes", 11333163457216990354),
        ("eval/color-transitions.json@9/plain", 16697256795446478891),
        ("eval/sticknodes-sprites.json@0/shapes", 13694648791568547398),
        ("eval/sticknodes-sprites.json@0/plain", 15501212961990661765),
        ("eval/sticknodes-sprites.json@2/shapes", 15299346410127301693),
        ("eval/sticknodes-sprites.json@2/plain", 10535019158841128425),
        ("eval/sticknodes-sprites.json@4/shapes", 8736498597345174227),
        ("eval/sticknodes-sprites.json@4/plain", 16877293253935330938),
        ("eval/sticknodes-sprites.json@6/shapes", 166393210005915849),
        ("eval/sticknodes-sprites.json@6/plain", 9159775129360116274),
        ("eval/sticknodes-sprites.json@8/shapes", 12647380790195072779),
        ("eval/sticknodes-sprites.json@8/plain", 1802653519631060341),
        ("eval/parallax-layers.json@0/shapes", 16038176137667970195),
        ("eval/parallax-layers.json@0/plain", 12208599958250421371),
        ("eval/parallax-layers.json@6/shapes", 16038176137667970195),
        ("eval/parallax-layers.json@6/plain", 12208599958250421371),
        ("eval/parallax-layers.json@12/shapes", 16038176137667970195),
        ("eval/parallax-layers.json@12/plain", 12208599958250421371),
        ("eval/parallax-layers.json@18/shapes", 16038176137667970195),
        ("eval/parallax-layers.json@18/plain", 12208599958250421371),
    ];
    let mut seen = Vec::new();
    for name in FIXTURES {
        let prepared = prepared(name);
        let ticks = prepared.total_ticks.max(1);
        for tick in (0..ticks).step_by(((ticks / 4).max(1)) as usize) {
            let frame = prepared.evaluate(tick as f64);
            seen.push((format!("{name}@{tick}"), scene_hash(&geometry::build_shapes(&prepared.doc, &frame, None)), scene_hash(&geometry::build(&prepared.doc, &frame))));
        }
    }
    if std::env::var_os("STYK_PRINT_HASHES").is_some() {
        for (key, shapes, plain) in &seen {
            println!("GOLDEN {key} {shapes} {plain}");
        }
    }
    for (key, shapes, plain) in &seen {
        if let Some(&(_, expected)) = GOLDEN.iter().find(|(k, _)| *k == format!("{key}/shapes")) {
            assert_eq!(*shapes, expected, "{key}: shapes scene");
        }
        if let Some(&(_, expected)) = GOLDEN.iter().find(|(k, _)| *k == format!("{key}/plain")) {
            assert_eq!(*plain, expected, "{key}: plain scene");
        }
    }
    assert!(GOLDEN.len() >= 2 * seen.len(), "every scene has its hash ({} of {})", GOLDEN.len(), 2 * seen.len());
}
