//! Native worker preparation must remain byte-for-byte the existing evaluator
//! and encoder, including across reused scenes and changed view settings.
use styk_engine::frame_builder::{FrameBuilder, Onion, Options};
use styk_engine::{Budgets, Engine};
use styk_eval::drawlist::{Overrides, encode_with};

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
                    let hidden: Vec<_> = frame
                        .objects
                        .iter()
                        .map(|object| {
                            generation
                                .prepared
                                .doc
                                .layers
                                .as_ref()
                                .is_some_and(|layers| {
                                    layers
                                        .hidden
                                        .iter()
                                        .any(|id| id == layers.layer_of(object.uid))
                                })
                        })
                        .collect();
                    let translations = frame
                        .parallax
                        .as_ref()
                        .filter(|_| camera)
                        .map(|p| p.translations(&[]))
                        .unwrap_or_default();
                    let mut batch =
                        generation
                            .anchors
                            .as_ref()
                            .filter(|_| effects)
                            .and_then(|anchors| {
                                let sampler = anchors.sampler(|| 0.0, f64::INFINITY);
                                styk_eval::vfx::generated::build(
                                    &generation.prepared,
                                    &frame,
                                    &scene,
                                    Some(tick),
                                    Some(&sampler),
                                    1.0,
                                )
                            });
                    if let (Some(batch), Some(parallax), Some(layers)) = (
                        batch.as_mut(),
                        frame.parallax.as_ref().filter(|_| camera),
                        generation.prepared.doc.layers.as_deref(),
                    ) {
                        batch.offset(|uid| Some(parallax.of_uid(layers, uid)));
                    }
                    let expected = encode_with(
                        &generation.prepared.doc,
                        &generation.assets,
                        &scene,
                        &Overrides {
                            hidden: &hidden,
                            translations: &translations,
                            bypass_effects: !effects,
                            generators: batch.as_ref(),
                            ..Default::default()
                        },
                    );
                    assert_eq!(
                        format!("{:?}", actual.list),
                        format!("{expected:?}"),
                        "{name} tick {tick} camera {camera} effects {effects}"
                    );
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
    assert_eq!(format!("{:?}", actual.list), format!("{expected:?}"));
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
    assert_eq!(format!("{:?}", camera.list), format!("{:?}", plain.list));
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
    assert_eq!(format!("{:?}", actual.list), format!("{expected:?}"));
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
    assert_eq!(
        format!("{:?}", actual.list),
        format!("{:?}", hidden.list),
        "a scope that excludes every ghost figure must add no artwork"
    );
}
