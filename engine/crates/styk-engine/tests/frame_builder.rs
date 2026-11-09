//! Native worker preparation must remain byte-for-byte the existing evaluator
//! and encoder, including across reused scenes and changed view settings.
use styk_engine::frame_builder::{FrameBuilder, Onion, Options};
use styk_engine::{Budgets, Engine};
use styk_eval::drawlist::{Overrides, encode_with};

#[path = "support/drawlist.rs"]
mod drawlist_payload;

#[test]
fn review_payload_comparison_detects_effect_parameter_bits() {
    use std::sync::Arc;
    use styk_eval::drawlist::{DrawList, EffectLayer, LayerKind};
    use styk_eval::vfx::{Effect, Kind, ParamValue, Params};
    let effect = Effect {
        id: Arc::from("parity-effect"),
        enabled: true,
        params: Params::defaults(Kind::Glow),
    };
    let mut changed = effect.clone();
    assert!(
        changed
            .params
            .set(0, &ParamValue::Num(f64::from_bits(1.0f64.to_bits() - 1)))
    );
    let list = |effect| DrawList {
        layers: vec![EffectLayer {
            effects: Some(Arc::new(vec![Arc::new(effect)])),
            kind: LayerKind::Raster {
                bounds: [0.0, 0.0, 20.0, 20.0],
            },
        }],
        ..DrawList::default()
    };
    let (original, changed) = (list(effect), list(changed));
    assert_ne!(
        drawlist_payload::payload(&original),
        drawlist_payload::payload(&changed),
        "a one-bit effect-parameter change must fail frame parity"
    );
}

fn open(name: &str) -> Engine {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../styk-eval/tests/fixtures")
        .join(name);
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine
        .open(&std::fs::read(path).unwrap(), "json", "worker fixture")
        .unwrap();
    engine
}

#[derive(Default)]
struct Exercised {
    anchors: usize,
    generated: usize,
    offsets: usize,
    parallax: usize,
    hidden: usize,
    culled: usize,
}

// The original produce pipeline, assembled independently from engine primitives.
// This oracle deliberately uses neither FrameBuilder nor frames::produce.
fn original(
    generation: &styk_engine::Generation,
    tick: f64,
    options: &Options,
) -> (styk_eval::drawlist::DrawList, Exercised) {
    use std::cell::Cell;
    use styk_eval::vfx::generated::anchors::{Sample, Sampler};
    struct CountSamples<'a>(&'a dyn Sampler, Cell<usize>);
    impl Sampler for CountSamples<'_> {
        fn sample(
            &self,
            prepared: &styk_eval::eval::Prepared,
            target: styk_eval::vfx::Target,
            tick: f64,
            attached: bool,
        ) -> Sample {
            self.1.set(self.1.get() + 1);
            self.0.sample(prepared, target, tick, attached)
        }
    }
    assert!(
        options.onions.is_empty(),
        "onions have their own independent oracle"
    );
    let mut exercised = Exercised::default();
    let prepared = &generation.prepared;
    let doc = &prepared.doc;
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(doc, &frame);
    let hidden: Vec<_> = frame
        .objects
        .iter()
        .map(|object| {
            options.hidden_uids.contains(&object.uid)
                || doc.layers.as_ref().is_some_and(|layers| {
                    layers
                        .hidden
                        .iter()
                        .any(|id| id == layers.layer_of(object.uid))
                })
        })
        .collect();
    exercised.hidden = hidden.iter().filter(|hidden| **hidden).count();
    let moved: Vec<_> = options
        .translations
        .iter()
        .filter_map(|(uid, offset)| {
            frame
                .objects
                .iter()
                .position(|object| object.uid == *uid)
                .map(|slot| (slot as u32, *offset))
        })
        .collect();
    let translations = if let Some(parallax) = frame.parallax.as_ref().filter(|_| options.camera) {
        exercised.parallax = parallax
            .translations(&[])
            .iter()
            .filter(|(_, offset)| *offset != [0.0; 2])
            .count();
        parallax.translations(&moved)
    } else {
        moved
    };
    let mut batch = generation
        .anchors
        .as_ref()
        .filter(|_| options.effects)
        .and_then(|anchors| {
            let sampler = anchors.sampler(|| 0.0, f64::INFINITY);
            let counted = CountSamples(&sampler, Cell::new(0));
            let batch = styk_eval::vfx::generated::build(
                prepared,
                &frame,
                &scene,
                Some(tick),
                Some(&counted),
                1.0,
            );
            exercised.anchors = counted.1.get();
            batch
        });
    if let Some(batch) = batch.as_mut() {
        assert!(!batch.incomplete);
        exercised.generated = batch.particles as usize;
        let before: Vec<_> = batch.draws.iter().map(|draw| batch.matrix(draw)).collect();
        batch.offset(|uid| {
            let mut offset = frame
                .parallax
                .as_ref()
                .filter(|_| options.camera)
                .zip(doc.layers.as_deref())
                .map_or([0.0; 2], |(p, l)| p.of_uid(l, uid));
            if let Some((_, movement)) = options.translations.iter().find(|(id, _)| *id == uid) {
                offset[0] += movement[0];
                offset[1] += movement[1];
            }
            Some(offset)
        });
        exercised.offsets = batch
            .draws
            .iter()
            .zip(before)
            .filter(|(draw, before)| {
                batch.matrix(draw).map(f64::to_bits) != before.map(f64::to_bits)
            })
            .count();
    }
    let mut list = encode_with(
        doc,
        &generation.assets,
        &scene,
        &Overrides {
            hidden: &hidden,
            translations: &translations,
            background: options.background,
            bypass_effects: !options.effects,
            generators: batch.as_ref(),
            ..Default::default()
        },
    );
    if options.clip_to_canvas {
        let before = list.prims.len();
        styk_eval::drawlist::cull_outside(&mut list, doc, scene.camera.as_ref());
        exercised.culled = before - list.prims.len();
    }
    (list, exercised)
}

#[test]
fn original_pipeline_exercises_generated_anchors_parallax_hidden_and_culling() {
    let engine = open("generators/particles.json");
    let generation = engine.generation().unwrap();
    let frame = generation.prepared.evaluate(3.0);
    let options = Options {
        translations: frame
            .objects
            .iter()
            .map(|object| (object.uid, [17.0, -3.0]))
            .collect(),
        clip_to_canvas: false,
        ..Default::default()
    };
    let (expected, coverage) = original(&generation, 3.0, &options);
    assert!(coverage.generated > 0, "live generated particles");
    assert!(coverage.anchors > 0, "birth anchors sampled");
    assert!(coverage.offsets > 0, "generated anchor matrices moved");
    let mut builder = FrameBuilder::default();
    for tick in [3.0, 4.0, 3.0] {
        let actual = builder
            .prepare(&generation, tick, &options, || 0.0, || false)
            .unwrap();
        let (expected, _) = original(&generation, tick, &options);
        drawlist_payload::assert_lists(&actual.list, &expected);
    }
    let (unmoved, _) = original(
        &generation,
        3.0,
        &Options {
            translations: vec![],
            ..options
        },
    );
    assert_ne!(
        drawlist_payload::payload(&expected),
        drawlist_payload::payload(&unmoved)
    );

    let engine = open("eval/parallax-layers.json");
    let generation = engine.generation().unwrap();
    let options = Options {
        clip_to_canvas: false,
        ..Default::default()
    };
    let (expected, coverage) = original(&generation, 8.0, &options);
    assert!(coverage.parallax > 0, "nonzero layer offsets");
    let actual = builder
        .prepare(&generation, 8.0, &options, || 0.0, || false)
        .unwrap();
    drawlist_payload::assert_lists(&actual.list, &expected);
    let (without_camera, _) = original(
        &generation,
        8.0,
        &Options {
            camera: false,
            ..options.clone()
        },
    );
    assert_ne!(
        drawlist_payload::payload(&expected),
        drawlist_payload::payload(&without_camera)
    );

    let hidden = Options {
        hidden_uids: generation
            .prepared
            .evaluate(8.0)
            .objects
            .iter()
            .map(|object| object.uid)
            .collect(),
        ..options
    };
    let (expected_hidden, coverage) = original(&generation, 8.0, &hidden);
    assert!(coverage.hidden > 0, "resolved hidden figures");
    assert!(
        expected_hidden.prims.len() < expected.prims.len(),
        "hidden figures omit primitives"
    );
    let actual = builder
        .prepare(&generation, 8.0, &hidden, || 0.0, || false)
        .unwrap();
    drawlist_payload::assert_lists(&actual.list, &expected_hidden);

    let engine = open("eval/color-transitions.json");
    let generation = engine.generation().unwrap();
    let options = Options {
        effects: false,
        translations: generation
            .prepared
            .evaluate(0.0)
            .objects
            .iter()
            .map(|object| (object.uid, [1_000_000.0; 2]))
            .collect(),
        ..Default::default()
    };
    let (expected, coverage) = original(&generation, 0.0, &options);
    assert!(
        coverage.culled > 0,
        "off-canvas primitives actually removed"
    );
    let actual = builder
        .prepare(&generation, 0.0, &options, || 0.0, || false)
        .unwrap();
    drawlist_payload::assert_lists(&actual.list, &expected);
}

#[test]
fn reused_builds_equal_the_original_evaluate_build_encode_path() {
    for name in [
        "eval/color-transitions.json",
        "eval/movieclip-joined.json",
        "eval/parallax-layers.json",
        "eval/follow-figures.json",
        "vfx/clips.json",
        "eval/sticknodes-sprites.json",
    ] {
        let engine = open(name);
        let generation = engine.generation().unwrap();
        let mut builder = FrameBuilder::default();
        for tick in [0.0, 0.5, 1.0, 1.0, 0.0] {
            for camera in [true, false] {
                for effects in [true, false] {
                    let options = Options {
                        camera,
                        effects,
                        clip_to_canvas: false,
                        ..Default::default()
                    };
                    let actual = builder
                        .prepare(&generation, tick, &options, || 0.0, || false)
                        .unwrap();
                    let frame = generation.prepared.evaluate(tick);
                    let scene = styk_eval::geometry::build(&generation.prepared.doc, &frame);
                    let (expected, _) = original(&generation, tick, &options);
                    drawlist_payload::assert_lists(&actual.list, &expected);
                    assert_eq!(actual.camera, scene.camera);
                    assert_eq!(actual.background, scene.background);
                }
            }
        }
    }
}

#[test]
fn onions_equal_the_edit_scene_composer_and_camera_hides_them() {
    let engine = open("eval/color-transitions.json");
    let generation = engine.generation().unwrap();
    let mut builder = FrameBuilder::default();
    let options = Options {
        camera: false,
        clip_to_canvas: false,
        onions: vec![Onion {
            tick: 0.0,
            opacity: 0.3,
            tint: Some([255, 0, 0]),
            on_top: false,
            hidden_uids: Vec::new(),
        }],
        ..Default::default()
    };
    let actual = builder
        .prepare(&generation, 1.0, &options, || 0.0, || false)
        .unwrap();
    let frame = generation.prepared.evaluate(1.0);
    let scene = styk_eval::geometry::build(&generation.prepared.doc, &frame);
    let mut ghost = generation.prepared.evaluate(0.0);
    ghost.vfx = None;
    let ghost_scene = styk_eval::geometry::build(&generation.prepared.doc, &ghost);
    let order = styk_eval::onion::compose(
        generation.prepared.doc.layers.as_deref(),
        &frame,
        &scene,
        &[styk_eval::onion::GhostPlace {
            frame: &ghost,
            scene: &ghost_scene,
            hidden: &[],
            show_on_top: false,
        }],
    );
    let expected = styk_eval::drawlist::encode_composed(
        &generation.prepared.doc,
        &generation.assets,
        &scene,
        &Overrides::default(),
        &[styk_eval::drawlist::Ghost {
            scene: &ghost_scene,
            opacity: 0.3,
            tint: Some([255, 0, 0]),
            hidden: &[],
        }],
        Some(&order),
    );
    drawlist_payload::assert_lists(&actual.list, &expected);
    let camera = builder
        .prepare(
            &generation,
            1.0,
            &Options {
                camera: true,
                ..options
            },
            || 0.0,
            || false,
        )
        .unwrap();
    let plain = builder
        .prepare(
            &generation,
            1.0,
            &Options {
                clip_to_canvas: false,
                ..Default::default()
            },
            || 0.0,
            || false,
        )
        .unwrap();
    drawlist_payload::assert_lists(&camera.list, &plain.list);
    assert_ne!(
        actual.list.prims, plain.list.prims,
        "the fixture must actually draw an onion"
    );
}

#[test]
fn cancellation_is_checked_between_the_real_preparation_phases() {
    let engine = open("eval/color-transitions.json");
    let generation = engine.generation().unwrap();
    for after in 0..5 {
        let calls = std::cell::Cell::new(0);
        let result = FrameBuilder::default().prepare(
            &generation,
            0.0,
            &Options::default(),
            || 0.0,
            || {
                let count = calls.get();
                calls.set(count + 1);
                count >= after
            },
        );
        assert!(result.is_none(), "cancel after phase {after}");
    }
}

#[test]
fn figure_drag_and_scoped_onions_use_the_existing_overrides() {
    let engine = open("eval/color-transitions.json");
    let generation = engine.generation().unwrap();
    let frame = generation.prepared.evaluate(0.0);
    let uid = frame.objects[0].uid;
    let scene = styk_eval::geometry::build(&generation.prepared.doc, &frame);
    let options = Options {
        camera: false,
        clip_to_canvas: false,
        translations: vec![(uid, [17.0, -3.0])],
        ..Default::default()
    };
    let actual = FrameBuilder::default()
        .prepare(&generation, 0.0, &options, || 0.0, || false)
        .unwrap();
    let expected = encode_with(
        &generation.prepared.doc,
        &generation.assets,
        &scene,
        &Overrides {
            translations: &[(0, [17.0, -3.0])],
            ..Default::default()
        },
    );
    drawlist_payload::assert_lists(&actual.list, &expected);
    let all_hidden = frame.objects.iter().map(|object| object.uid).collect();
    let hidden_onion = Options {
        onions: vec![Onion {
            tick: 0.0,
            opacity: 0.4,
            tint: None,
            on_top: true,
            hidden_uids: all_hidden,
        }],
        ..options.clone()
    };
    let hidden = FrameBuilder::default()
        .prepare(&generation, 0.0, &hidden_onion, || 0.0, || false)
        .unwrap();
    drawlist_payload::assert_lists(&actual.list, &hidden.list);
}
