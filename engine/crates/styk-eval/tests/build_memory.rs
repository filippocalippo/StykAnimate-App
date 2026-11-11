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

/// A scene built over the one held, for a document published anew (`build_remembering_plain_over`): `None` only when the scene built
/// whole is the scene already held, and the scene built whole otherwise.
#[test]
fn a_scene_over_the_one_held_is_kept_only_when_a_build_would_give_it() {
    for name in FIXTURES {
        let prepared = prepared(name);
        let ticks = prepared.total_ticks.max(1);
        let mut kept = 0;
        for tick in (0..ticks).step_by(((ticks / 4).max(1)) as usize) {
            let frame = prepared.evaluate(tick as f64);
            let what = format!("{name} tick {tick}");
            let held_of = |frame: &Frame| {
                let mut memory = BuildMemory::default();
                let held = geometry::build_remembering_plain(&prepared.doc, frame, &mut memory);
                (memory, held)
            };
            // Nothing changed, and the document published anew with the same figures: the scene held is the scene.
            let (mut memory, held) = held_of(&frame);
            // (A movieclip instance joined to a figure is built every time: what it reads of its parent is not checked.)
            match geometry::build_remembering_plain_over(&prepared.doc, &frame, &mut memory, &held) {
                None => kept += 1,
                Some(rebuilt) => same_scene(&rebuilt, &geometry::build(&prepared.doc, &frame), &format!("{what}: built again, though nothing changed")),
            }
            // A scene that is not the last the memory built is not kept.
            let (mut memory, _) = held_of(&frame);
            let other = geometry::build_remembering_plain(&prepared.doc, &frame, &mut BuildMemory::default());
            same_scene(&geometry::build_remembering_plain_over(&prepared.doc, &frame, &mut memory, &other).expect("another scene is built over"), &geometry::build(&prepared.doc, &frame), &format!("{what}: another scene held"));
            // One object turned.
            if let Some(slot) = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty()) {
                let next = turned(&frame, slot);
                let (mut memory, held) = held_of(&frame);
                let rebuilt = geometry::build_remembering_plain_over(&prepared.doc, &next, &mut memory, &held).expect("a turned object is built");
                same_scene(&rebuilt, &geometry::build(&prepared.doc, &next), &format!("{what}: turned"));
                assert_ne!(rebuilt.stamp.get(), held.stamp.get(), "{what}: a new scene is another scene");
            }
            // The objects drawn in another order, and the scene seen another way.
            let mut reordered = frame.clone();
            reordered.draw_order.reverse();
            if reordered.draw_order != frame.draw_order {
                let (mut memory, held) = held_of(&frame);
                let rebuilt = geometry::build_remembering_plain_over(&prepared.doc, &reordered, &mut memory, &held).expect("another draw order is spliced");
                same_scene(&rebuilt, &geometry::build(&prepared.doc, &reordered), &format!("{what}: reordered"));
            }
            let mut flagged = frame.clone();
            flagged.export_vfx = vec![true; flagged.objects.len()];
            if flagged.export_vfx != frame.export_vfx {
                let (mut memory, held) = held_of(&frame);
                let rebuilt = geometry::build_remembering_plain_over(&prepared.doc, &flagged, &mut memory, &held).expect("other export flags are spliced");
                same_scene(&rebuilt, &geometry::build(&prepared.doc, &flagged), &format!("{what}: export flags"));
            }
            let mut moved = frame.clone();
            moved.background_color = Some(0xff102030).filter(|color| Some(*color) != frame.background_color).or(Some(0xff010203));
            let (mut memory, held) = held_of(&frame);
            let rebuilt = geometry::build_remembering_plain_over(&prepared.doc, &moved, &mut memory, &held).expect("another background colour is spliced");
            same_scene(&rebuilt, &geometry::build(&prepared.doc, &moved), &format!("{what}: background"));
            // A figure the document now defines another way: every object that is drawn with it is built again.
            let mut changed = (*prepared.doc).clone();
            let used: Vec<u32> = frame.objects.iter().map(|object| object.figure).collect();
            if let Some(at) = changed.figures.iter().position(|figure| used.contains(&figure.id) && !figure.segments.is_empty() && figure.movieclip.is_none()) {
                let mut figure = (*changed.figures[at]).clone();
                figure.segments[0].thickness += 3.0;
                changed.figures[at] = Arc::new(figure);
                let (mut memory, held) = held_of(&frame);
                let rebuilt = geometry::build_remembering_plain_over(&changed, &frame, &mut memory, &held).expect("a figure defined another way is built again");
                same_scene(&rebuilt, &geometry::build(&changed, &frame), &format!("{what}: figure"));
            }
        }
        if name == "eval/follow-figures.json" {
            assert!(kept > 0, "{name}: a frame of loose figures is kept");
        }
    }
}

/// Drawing cels held live no longer turn the memory off: the objects that draw no cel are kept, the object that draws one is encoded
/// again each frame from the slots as they are, and every list is the list encoded whole.
#[test]
fn objects_that_draw_no_live_cel_are_kept_and_the_one_that_does_is_not() {
    use styk_eval::live::{LiveCels, LiveView};
    // A document of plain figures, with an unrelated cel held live: everything is kept.
    let document = prepared("eval/follow-figures.json");
    let assets = Assets::build(&document.doc);
    let frame = document.evaluate(0.0);
    let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
    let mut live = LiveCels::default();
    live.update("elsewhere", false, vec![((0, 0), Some(vec![255u8; styk_eval::live::TILE_BYTES]))]).expect("room");
    live.show("elsewhere", true, false);
    for round in 0..3 {
        let scene = geometry::build_remembering(&document.doc, &frame, &mut built);
        let overrides = Overrides { live: Some(LiveView { cels: &live, base: assets.pages }), ..Default::default() };
        let remembered = encode_composed_remembering(&document.doc, &assets, &scene, &overrides, &[], None, &mut encoded);
        let whole = encode_composed(&document.doc, &assets, &scene, &overrides, &[], None);
        same_list(&remembered, &whole, &format!("follow-figures with a live cel elsewhere, round {round}"));
    }
    assert!(encoded.kept() > 0, "the objects are kept while a cel is held live");

    // A document whose object draws the cel: it is encoded from the live slots every frame.
    let document = prepared("drawlist/drawing-cel.json");
    let assets = Assets::build(&document.doc);
    let id = document.doc.figures[0].images.iter().find_map(|image| image.cel.as_ref()).expect("a cel").id.clone();
    let frame = document.evaluate(0.0);
    let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
    let mut live = LiveCels::default();
    let tile = |value: u8| Some(vec![value; styk_eval::live::TILE_BYTES]);
    live.update(&id, false, vec![((0, 0), tile(200))]).expect("room");
    live.show(&id, true, false);
    for (round, value) in [(0, 200u8), (1, 90), (2, 40)] {
        live.update(&id, false, vec![((0, 0), tile(value)), ((round + 1, 0), tile(value))]).expect("room");
        let scene = geometry::build_remembering(&document.doc, &frame, &mut built);
        let overrides = Overrides { live: Some(LiveView { cels: &live, base: assets.pages }), ..Default::default() };
        let remembered = encode_composed_remembering(&document.doc, &assets, &scene, &overrides, &[], None, &mut encoded);
        let whole = encode_composed(&document.doc, &assets, &scene, &overrides, &[], None);
        same_list(&remembered, &whole, &format!("drawing-cel, round {round}: the slots as they are now"));
        assert_eq!(encoded.kept(), 0, "the object that draws the live cel is not kept");
    }
}

/// `frame` with the first bend of object `slot` changed, when it has bends: a curve of another length holds another count of points.
fn bent(frame: &Frame, slot: usize) -> Option<Frame> {
    let mut object = (*frame.objects[slot]).clone();
    let mut bends = object.bends.as_deref()?.to_vec();
    *bends.first_mut()? += 2.5;
    object.bends = Some(bends.into());
    let mut next = frame.clone();
    next.objects[slot] = Arc::new(object);
    Some(next)
}

/// A shared build (`build_remembering_shared`) writes the scene two builds back in place when nothing else holds it and its objects lie where
/// the new build's do; whether it does or not, the scene is the scene built whole (and its objects' spans read their own parts).
#[test]
fn a_shared_build_over_an_earlier_scene_is_the_build_whole() {
    for name in FIXTURES {
        let prepared = prepared(name);
        let ticks = prepared.total_ticks.max(1);
        let mut memory = BuildMemory::default();
        let mut frames = Vec::new();
        for tick in (0..ticks).step_by(((ticks / 4).max(1)) as usize) {
            let frame = prepared.evaluate(tick as f64);
            frames.push((format!("tick {tick}"), frame.clone()));
            frames.push((format!("tick {tick} again"), frame.clone()));
            for slot in (0..frame.objects.len()).filter(|&slot| !frame.objects[slot].angles.is_empty()).take(2) {
                let next = turned(&frame, slot);
                frames.push((format!("tick {tick} slot {slot} turned"), next.clone()));
                frames.push((format!("tick {tick} slot {slot} turned twice"), turned(&next, slot)));
                if let Some(bent) = bent(&next, slot) {
                    frames.push((format!("tick {tick} slot {slot} bent"), bent));
                }
            }
        }
        let mut held = None;
        for (n, (what, frame)) in frames.iter().enumerate() {
            // Every third scene is still held when the next builds are made: those are not written over.
            let scene = geometry::build_remembering_shared(&prepared.doc, frame, &mut memory);
            same_scene(&scene, &geometry::build_shapes(&prepared.doc, frame, None), &format!("{name} {what}"));
            for slot in 0..frame.objects.len() {
                let items: Vec<String> = scene.items.iter().filter(|item| item.slot as usize == slot).map(|item| format!("{item:?}")).collect();
                assert_eq!(scene.items_of(slot).expect("a built scene has spans").iter().map(|item| format!("{item:?}")).collect::<Vec<_>>(), items, "{name} {what}: the items of slot {slot}");
            }
            if n % 3 == 0 {
                held = Some(scene);
            }
        }
        drop(held);
        // In a frame of loose figures, a turned object is written over the scene before last.
        if name == "eval/follow-figures.json" {
            assert!(memory.written_over() > 0, "{name}: some builds were written over an earlier scene");
        }
    }
}

/// A scene still held elsewhere is never written over, and one the memory let go of ([`BuildMemory::rest`]) cannot be.
#[test]
fn a_scene_held_elsewhere_or_let_go_of_is_not_written_over() {
    let prepared = prepared("eval/follow-figures.json");
    let frame = prepared.evaluate(3.0);
    let slot = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty()).expect("a figure to turn");
    let frames = [frame.clone(), turned(&frame, slot), turned(&turned(&frame, slot), slot), frame.clone()];
    // Every scene held: nothing is written over, and each is unchanged by the builds after it.
    let mut memory = BuildMemory::default();
    let scenes: Vec<Arc<geometry::Scene>> = frames.iter().map(|frame| geometry::build_remembering_shared(&prepared.doc, frame, &mut memory)).collect();
    assert_eq!(memory.written_over(), 0);
    for (scene, frame) in scenes.iter().zip(&frames) {
        same_scene(scene, &geometry::build_shapes(&prepared.doc, frame, None), "a scene held is not changed");
    }
    // None held: from the third build on each is written over the scene before last.
    let mut memory = BuildMemory::default();
    for frame in &frames {
        geometry::build_remembering_shared(&prepared.doc, frame, &mut memory);
    }
    assert_eq!(memory.written_over(), 2);
    // Let go of between builds: there is nothing to write over.
    let mut memory = BuildMemory::default();
    for frame in &frames {
        geometry::build_remembering_shared(&prepared.doc, frame, &mut memory);
        memory.rest();
    }
    assert_eq!(memory.written_over(), 0);
}

/// What a renderer that holds `since` writes when told how `list` differs from it: `since`'s primitives with the changed ranges taken from
/// `list`.
fn applied(changes: &styk_eval::drawlist::ListChanges, list: &styk_eval::drawlist::DrawList) -> Vec<styk_draw::Prim> {
    let mut prims = changes.since.prims.clone();
    assert_eq!(prims.len(), list.prims.len(), "a list that differs in ranges holds as many primitives");
    let mut end = 0;
    for &(a, b) in &changes.prims {
        assert!(a >= end && a < b, "ranges are in order and not empty: {:?}", changes.prims);
        prims[a as usize..b as usize].copy_from_slice(&list.prims[a as usize..b as usize]);
        end = b;
    }
    prims
}

/// A shared encoding (`encode_composed_shared`) writes the list two frames back in place when nothing else holds it and it is laid out as the
/// new one; the list is the list encoded whole either way, with and without onion skins, and the changes it reports, applied to the list before
/// it, give it.
#[test]
fn a_list_encoded_over_an_earlier_one_is_the_list_encoded_whole() {
    use styk_eval::drawlist::{encode_composed_shared, Ghost, Layer};
    let mut written = 0;
    for name in FIXTURES {
        let prepared = prepared(name);
        let assets = Assets::build(&prepared.doc);
        let ticks = prepared.total_ticks.max(1);
        for ghosts in [false, true] {
            let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
            let mut held = None;
            let mut steps = 0;
            for tick in (0..ticks).step_by(((ticks / 4).max(1)) as usize) {
                let frame = prepared.evaluate(tick as f64);
                let ghost_scene = geometry::build(&prepared.doc, &prepared.evaluate(((tick + 1) % ticks) as f64));
                let hidden = vec![false; ghost_scene.objects.len()];
                let layers: Vec<Layer> = (0..ghost_scene.objects.len() as u32).map(|slot| Layer::Ghost(0, slot)).chain((0..frame.objects.len() as u32).map(Layer::Current)).collect();
                let mut frames = vec![frame.clone(), frame.clone()];
                if let Some(slot) = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty()) {
                    frames.push(turned(&frame, slot));
                    frames.push(turned(&turned(&frame, slot), slot));
                    frames.push(turned(&turned(&turned(&frame, slot), slot), slot));
                }
                for (n, frame) in frames.iter().enumerate() {
                    let scene = geometry::build_remembering_shared(&prepared.doc, frame, &mut built);
                    for translations in [&[][..], &[(0u32, [3.5, -2.0])][..]] {
                        let what = format!("{name} tick {tick} frame {n} moved {} ghosts {ghosts}", !translations.is_empty());
                        let overrides = Overrides { translations, ..Default::default() };
                        let ghost = [Ghost { scene: &ghost_scene, opacity: 0.3, tint: Some([200, 10, 10]), hidden: &hidden }];
                        let (ghost, order) = if ghosts { (&ghost[..], Some(&layers[..])) } else { (&[][..], None) };
                        let (list, changes) = encode_composed_shared(&prepared.doc, &assets, &scene, &overrides, ghost, order, &mut encoded);
                        let whole = encode_composed(&prepared.doc, &assets, &scene, &overrides, ghost, order);
                        same_list(&list, &whole, &what);
                        assert_eq!(format!("{:?}", (&list.groups, &list.passes, &list.layers.len(), &list.glyphs.len())), format!("{:?}", (&whole.groups, &whole.passes, &whole.layers.len(), &whole.glyphs.len())), "{what}: groups and passes");
                        if let Some(changes) = &changes {
                            assert_eq!(applied(changes, &list), list.prims, "{what}: the changes reported give the list");
                        }
                        // Every third list is still held when the next ones are encoded: it is not written over.
                        steps += 1;
                        if steps % 3 == 0 {
                            held = Some((list.clone(), whole));
                        }
                        if let Some((list, whole)) = &held {
                            same_list(list, whole, &format!("{what}: a list held is not changed"));
                        }
                    }
                }
            }
            written += encoded.written_over();
        }
    }
    assert!(written > 0, "some lists were written over an earlier one");
}

/// One figure moved of many: the list reports the primitives of that figure as changed, and no other.
#[test]
fn a_list_encoded_over_another_reports_the_figure_that_changed() {
    use styk_eval::drawlist::encode_composed_shared;
    let prepared = prepared("eval/follow-figures.json");
    let assets = Assets::build(&prepared.doc);
    let frame = prepared.evaluate(3.0);
    let slot = (0..frame.objects.len()).find(|&slot| !frame.objects[slot].angles.is_empty() && frame.objects[slot].join.is_none()).expect("a loose figure");
    let (mut built, mut encoded) = (BuildMemory::default(), EncodeMemory::default());
    let mut next = frame.clone();
    let mut changes = None;
    let mut list = None;
    for _ in 0..4 {
        // What the last step reported holds the list before it: let go of, as a renderer does once it has written the changes.
        changes = None;
        next = turned(&next, slot);
        let scene = geometry::build_remembering_shared(&prepared.doc, &next, &mut built);
        let (encoded_list, reported) = encode_composed_shared(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None, &mut encoded);
        changes = reported;
        list = Some((encoded_list, scene));
    }
    let (list, scene) = list.unwrap();
    let changes = changes.expect("a list laid out as the one before it says how it differs");
    let changed: usize = changes.prims.iter().map(|(a, b)| (b - a) as usize).sum();
    assert!(changed > 0, "the turned figure's primitives changed");
    assert!(changed < list.prims.len() - list.background_prims as usize, "the other figures' primitives did not: {changed} of {}", list.prims.len());
    let items = scene.items_of(slot).unwrap().len();
    assert!(changed <= 2 * items, "no more than the turned figure's primitives (its items and their outline): {changed} for {items} items");
    assert!(encoded.written_over() >= 2, "the lists from the third on are written over the one before last");
    // At rest the list before the last is let go of: the next list has nothing to be written over.
    drop(changes);
    encoded.rest();
    let written = encoded.written_over();
    let scene = geometry::build_remembering_shared(&prepared.doc, &turned(&next, slot), &mut built);
    let (after_rest, _) = encode_composed_shared(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None, &mut encoded);
    assert_eq!(encoded.written_over(), written, "a list after a rest is encoded whole");
    same_list(&after_rest, &encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None), "after a rest");
}
