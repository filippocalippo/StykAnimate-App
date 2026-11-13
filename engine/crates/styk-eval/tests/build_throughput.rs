//! A whole frame made with fewer copies and allocations is the frame made before (docs/engine/evaluation.md, "Building a whole frame"):
//! the build made one object at a time in draw order (`build_streamed`, the WebAssembly build's), the build over the last one in the
//! buffers of the objects built again (`BuildMemory`, a seek), and the scene that reads a figure's items for its measured primitives
//! (`SPAN_MEASURED_ITEMS`) give the scenes, draw lists and reads the plain builds give, on figures, joined figures, rigs, 3D poses,
//! movieclips, Stick Nodes shapes, colour transitions and effects.
use std::path::Path;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed, Overrides};
use styk_eval::geometry::{self, BuildMemory, Scene, SPAN_MEASURED_ITEMS};

const FIXTURES: &[&str] = &[
    "eval/follow-figures.json", "eval/follow-missing.json", "eval/movieclip-joined.json", "eval/movieclip-break-apart.json", "eval/movieclip-loose-child.json",
    "eval/movieclip-replacement.json", "eval/color-transitions.json", "eval/sticknodes-sprites.json", "eval/parallax-layers.json", "eval/parallax-baked-motion.json",
    "eval/sheet-mixed-keys.json", "spatial/clip-mesh.json", "spatial/mesh-in-movieclip.json", "spatial/mesh-instances.json", "spatial/mesh-perspective.json",
    "rig/curved-connector-polygon.json", "ik/bent.json", "ik/chain-long.json", "ik/joined-stretch.json", "picking-construction/body-curves.json",
    "picking-construction/connector-curved.json", "picking-construction/joined-rig.json", "picking-construction/joined-ik.json", "vfx/attached.json", "vfx/movieclip.json",
    "drawlist/painted-limbs.json", "drawlist/outlined-text.json",
];

fn prepared(name: &str) -> styk_eval::eval::Prepared {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    styk_eval::prepare(styk_eval::open(&path).unwrap_or_else(|error| panic!("{name}: {error:?}")))
}

/// Every tick of a fixture, or a sample of a long one.
fn ticks(prepared: &styk_eval::eval::Prepared) -> Vec<f64> {
    let total = prepared.total_ticks.max(1);
    (0..total).step_by((total / 12).max(1) as usize).map(f64::from).collect()
}

/// What a scene gives its readers: every buffer, each object's parts as the scene says where they lie, its measured primitives as they are
/// read, and its warnings. Not the bytes it accounts for (the room its buffers grew to), nor what its builds were numbered.
fn readout(scene: &Scene) -> String {
    let parts: Vec<_> = (0..scene.objects.len()).map(|slot| (scene.items_of(slot).map(<[_]>::to_vec), scene.measured_of(slot).map(<[_]>::to_vec))).collect();
    format!("{:?} {:?}", (&scene.items, scene.measured_items().collect::<Vec<_>>(), &scene.points, &scene.objects, &scene.figure_of, &scene.owners, &scene.owner_scales, &scene.chains),
        (&scene.depths, &scene.transitions, &scene.warnings, &scene.camera, &scene.background, &scene.background_color, scene.spanned(), parts))
}

fn same(a: &Scene, b: &Scene, what: &str) {
    assert_eq!(readout(a), readout(b), "{what}");
}

#[test]
fn a_frame_built_one_object_at_a_time_is_the_frame_built_in_parallel() {
    let mut streamed_any = false;
    for name in FIXTURES {
        let prepared = prepared(name);
        let assets = Assets::build(&prepared.doc);
        for tick in ticks(&prepared) {
            let frame = prepared.evaluate(tick);
            let whole = geometry::build(&prepared.doc, &frame);
            let streamed = geometry::build_streamed(&prepared.doc, &frame, false);
            same(&streamed, &whole, &format!("{name}@{tick}"));
            same(&geometry::build_streamed(&prepared.doc, &frame, true), &geometry::build_shapes(&prepared.doc, &frame, None), &format!("{name}@{tick}: shapes"));
            // What is drawn of it, byte for byte.
            let (a, b) = (encode_composed(&prepared.doc, &assets, &streamed, &Overrides::default(), &[], None), encode_composed(&prepared.doc, &assets, &whole, &Overrides::default(), &[], None));
            assert_eq!(format!("{:?}", a.prims), format!("{:?}", b.prims), "{name}@{tick}: draw list");
            streamed_any |= frame.objects.iter().all(|object| object.join.is_none()) && !frame.objects.is_empty();
        }
    }
    assert!(streamed_any, "some frame has no joins (the streamed build is the one made)");
}

/// A worker builds frame after frame in the buffers of the scene before (`build_reusing`): the same scenes as a fresh build, whatever the
/// spares held (more parts or fewer, another document's figures), and the spares hold what the last scene had room for.
#[test]
fn a_frame_built_in_the_buffers_of_the_scene_before_it_is_the_frame_built_fresh() {
    let mut spares = geometry::SceneSpares::default();
    let mut lent = 0;
    // One worker for every document in turn: a document's first frame is built in the last one's buffers.
    for name in FIXTURES {
        let prepared = prepared(name);
        let assets = Assets::build(&prepared.doc);
        let mut sequence = ticks(&prepared);
        sequence.extend(ticks(&prepared).into_iter().rev());
        for (step, tick) in sequence.into_iter().enumerate() {
            let frame = prepared.evaluate(tick);
            let what = format!("{name}@{tick} (step {step})");
            let whole = geometry::build(&prepared.doc, &frame);
            lent += usize::from(!spares.is_empty());
            for stream in [true, false] {
                let reused = geometry::build_spared(&prepared.doc, &frame, &mut spares, stream);
                same(&reused, &whole, &format!("{what}, streamed {stream}"));
                let (a, b) = (encode_composed(&prepared.doc, &assets, &reused, &Overrides::default(), &[], None), encode_composed(&prepared.doc, &assets, &whole, &Overrides::default(), &[], None));
                assert_eq!(format!("{:?}", a.prims), format!("{:?}", b.prims), "{what}, streamed {stream}: draw list");
                spares.recycle(reused);
                assert!(spares.bytes() > 0 || frame.objects.is_empty(), "{what}: the spares hold the scene's buffers");
            }
        }
    }
    assert!(lent > 0, "frames were built in lent buffers");
}

#[test]
fn a_seek_builds_every_figure_again_in_the_buffers_of_its_last_build() {
    let mut recycled = 0;
    for name in FIXTURES {
        let prepared = prepared(name);
        let mut memory = BuildMemory::default();
        let mut shared = BuildMemory::default();
        let mut plain = BuildMemory::default();
        // Forward, back and forward again: an object's buffers held more, or fewer, parts than it now has.
        let mut sequence = ticks(&prepared);
        sequence.extend(ticks(&prepared).into_iter().rev());
        sequence.extend(ticks(&prepared));
        let mut scenes = Vec::new();
        for (step, tick) in sequence.into_iter().enumerate() {
            let frame = prepared.evaluate(tick);
            let what = format!("{name}@{tick} (step {step})");
            same(&geometry::build_remembering(&prepared.doc, &frame, &mut memory), &geometry::build_shapes(&prepared.doc, &frame, None), &what);
            let scene = geometry::build_remembering_shared(&prepared.doc, &frame, &mut shared);
            same(&scene, &geometry::build_shapes(&prepared.doc, &frame, None), &format!("{what}: shared"));
            // The scene on show stays held while the next is built, as the session holds it.
            scenes.push(scene);
            if scenes.len() > 1 {
                scenes.remove(0);
            }
            same(&geometry::build_remembering_plain(&prepared.doc, &frame, &mut plain), &geometry::build(&prepared.doc, &frame), &format!("{what}: plain"));
        }
        recycled += memory.recycled() + shared.recycled() + plain.recycled();
    }
    assert!(recycled > 0, "objects were built again in their last build's buffers");
}

#[test]
fn a_figure_of_segments_alone_reads_its_items_for_its_measured_primitives() {
    let prepared = prepared("eval/follow-figures.json");
    let frame = prepared.evaluate(0.0);
    let scene = geometry::build_shapes(&prepared.doc, &frame, None);
    let shared: Vec<usize> = (0..scene.objects.len()).filter(|&slot| scene.spans[slot].flags & SPAN_MEASURED_ITEMS != 0).collect();
    assert!(!shared.is_empty(), "plain figures share their items");
    for &slot in &shared {
        let span = scene.spans[slot];
        assert_eq!(span.measured.0, span.measured.1, "slot {slot}: nothing of it is copied to the measured primitives");
        assert_eq!(format!("{:?}", scene.measured_of(slot)), format!("{:?}", scene.items_of(slot)), "slot {slot}");
        let read: Vec<_> = scene.measured_items().filter(|item| item.slot as usize == slot).collect();
        assert_eq!(read.len(), scene.items_of(slot).unwrap().len(), "slot {slot}: every item is read once as a measured primitive");
    }
    // The bounds the interface reads, of every object and of a few, are those of the primitives as measured.
    let all = styk_eval::drawlist::app_bounds(&scene, prepared.doc.as_ref());
    let some = styk_eval::drawlist::app_bounds_of(&scene, prepared.doc.as_ref(), &shared[..1]);
    assert_eq!(some[shared[0]], all[shared[0]]);
    assert!(all[shared[0]].is_some());
}

/// A figure whose segments are made in another order than the figure's (its plan: roots, then the segments of each in turn) shares its
/// items too, and reads them back in the order they were made, which the scenes these hashes were taken of held
/// (`build_memory.rs`, `the_splice_builds_the_scenes_it_always_built`).
#[test]
fn a_figure_made_out_of_its_order_reads_its_measured_primitives_in_the_order_they_were_made() {
    let mut seen = false;
    for name in FIXTURES {
        let prepared = prepared(name);
        let frame = prepared.evaluate(0.0);
        let scene = geometry::build_shapes(&prepared.doc, &frame, None);
        for slot in (0..scene.objects.len()).filter(|&slot| scene.spans.get(slot).is_some_and(|span| span.flags & SPAN_MEASURED_ITEMS != 0)) {
            let order = &scene.figure_for(slot).unwrap().plan.order;
            let items = scene.items_of(slot).unwrap();
            let read: Vec<u32> = scene.measured_in_order(slot).map(|item| item.index).collect();
            assert_eq!(&read, order, "{name} slot {slot}: in the order they were made");
            assert!(items.iter().enumerate().all(|(at, item)| item.index as usize == at), "{name} slot {slot}: drawn in the figure's order");
            seen |= order.iter().enumerate().any(|(at, &index)| index as usize != at);
        }
    }
    assert!(seen, "some figure is made out of its order");
}
