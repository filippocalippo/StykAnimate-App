use std::sync::Arc;
use styk_core::engine::SceneOptions;
use styk_core::frames::{Config, FrameDocument, Frames};
use styk_core::stage::{Host, View, Viewport, WheelZoom};
use styk_engine::{Budgets, Engine, Generation};
use styk_services::{FixedClock, ManualSpawner};

struct Source(Arc<Generation>);
impl FrameDocument for Source {
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<Generation>> {
        (revision == self.0.revision).then(|| self.0.clone())
    }
}
fn host() -> (Host, ManualSpawner) {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine
        .open(
            include_bytes!("../../styk-eval/tests/fixtures/eval/color-transitions.json"),
            "json",
            "stage",
        )
        .unwrap();
    let generation = engine.generation().unwrap();
    let revision = generation.revision;
    let canvas = generation.prepared.doc.canvas;
    let source: Arc<dyn FrameDocument> = Arc::new(Source(generation));
    let spawner = ManualSpawner::new();
    let frames = Frames::new(
        17,
        revision,
        0,
        &source,
        Config::default(),
        &spawner,
        Arc::new(FixedClock::default()),
        Arc::new(|| {}),
    )
    .unwrap();
    (
        Host::new(frames, canvas, Viewport::default()).unwrap(),
        spawner,
    )
}
fn near(a: [f64; 2], b: [f64; 2]) {
    for (a, b) in a.into_iter().zip(b) {
        assert!((a - b).abs() < 1e-8, "{a} != {b}");
    }
}

#[test]
fn logical_window_stage_and_document_round_trips_at_odd_dpi() {
    let camera = styk_core::engine::doc::Camera {
        x: 17.25,
        y: -48.5,
        scale: 0.75,
        angle: 0.31,
        is_default: false,
        motion_offset: None,
    };
    for dpr in [1.0, 1.25, 1.375, 1.5, 2.25] {
        let viewport = Viewport {
            origin: [13.25, 72.5],
            size: [833.3, 579.7],
            dpr,
            ..Default::default()
        };
        assert_eq!(
            viewport.backing_size(0.75).unwrap(),
            [
                (833.3 * dpr * 0.75_f64).round() as u32,
                (579.7 * dpr * 0.75_f64).round() as u32
            ]
        );
        for flip in [false, true] {
            let view = View {
                zoom: 2.3,
                pan: [-21.75, 47.25],
                rotation: 0.37,
                flip,
            };
            for point in [[0.0, 0.0], [320.25, 240.5], [-1000.25, 700.125]] {
                let stage = view.document_to_stage(point, [640, 480], Some(&camera));
                let window = viewport.stage_to_window(stage);
                near(
                    view.stage_to_document(
                        viewport.window_to_stage(window),
                        [640, 480],
                        Some(&camera),
                    ),
                    point,
                );
            }
        }
    }
}

#[test]
fn fit_and_zoom_use_the_reference_limits_margins_and_negative_rounding() {
    let viewport = Viewport {
        size: [1000.0, 800.0],
        ..Default::default()
    };
    let view = View::fit_canvas([640, 480], &viewport);
    assert_eq!(view.zoom, 944.0 / 640.0);
    assert_eq!(view.pan, [28.0, 46.0]);
    assert_eq!(View::fit_canvas([1, 1], &viewport).zoom, 2.0);
    assert_eq!(View::fit_canvas([u32::MAX, u32::MAX], &viewport).zoom, 0.01);
    let mut view = View::default();
    view.fit_selection([100.0, 50.0, 300.0, 150.0], [640, 480], None, &viewport);
    assert_eq!(view.zoom, 4.4);
    near(
        view.document_to_stage([200.0, 100.0], [640, 480], None),
        [500.0, 385.0],
    );
    let anchor = [227.25, 93.75];
    let point = view.stage_to_document(anchor, [640, 480], None);
    assert!(view.zoom_by(1e20, anchor));
    assert_eq!(view.zoom, 100.0);
    near(view.document_to_stage(point, [640, 480], None), anchor);
    assert!(view.zoom_by(1e-20, anchor));
    assert_eq!(view.zoom, 0.001);
    let before = view;
    assert!(!view.zoom_by(f64::NAN, anchor));
    assert_eq!(view, before);
}

#[test]
fn fitted_resizes_follow_until_manual_navigation_and_every_view_input_keys_the_request() {
    let (mut host, spawner) = host();
    let options = SceneOptions::default();
    let first = host.request(0.0, 1.0, 4, options.clone()).unwrap();
    host.pan_by([0.25, -0.25]).unwrap();
    assert!(
        host.fitted(),
        "reference fitted snapshot keeps sub-half-pixel offsets"
    );
    host.resize(Viewport {
        size: [1000.0, 800.0],
        dpr: 1.375,
        ..Default::default()
    })
    .unwrap();
    assert!(host.fitted());
    let second = host.request(0.0, 1.0, 4, options.clone()).unwrap();
    assert_ne!(first, second);
    host.pan_by([13.5, -4.25]).unwrap();
    let manual = host.view();
    host.resize(Viewport {
        size: [800.0, 600.0],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(host.view(), manual);
    host.set_view(View {
        rotation: 0.5,
        flip: true,
        ..manual
    })
    .unwrap();
    let turned = host.request(0.0, 0.75, 1, options).unwrap();
    assert_eq!(turned.view.rotation, 0.5);
    assert!(turned.view.flip);
    assert_eq!(turned.view.size, [600, 450]);
    assert_eq!(turned.view.zoom, manual.zoom * 0.75);
    assert_eq!(turned.view.samples, 1);
    host.close();
    drop(host);
    while spawner.run_next() {}
}

#[test]
fn wheel_pan_swaps_axes_and_settles_after_the_reference_idle_interval() {
    let (mut host, spawner) = host();
    let start = host.view().pan;
    host.wheel_pan([3.0, 7.0], true, 100.0).unwrap();
    assert_eq!(host.view().pan, [start[0] - 7.0, start[1] - 3.0]);
    assert!(host.interacting());
    assert!(!host.advance(199.0).unwrap());
    assert!(host.advance(200.0).unwrap());
    assert!(!host.interacting());
    host.close();
    drop(host);
    while spawner.run_next() {}
}

#[test]
fn scene_resize_follows_a_fit_and_preserves_manual_navigation() {
    let (mut host, spawner) = host();
    host.set_canvas([320, 240]).unwrap();
    assert_eq!(host.view(), View::fit_canvas([320, 240], &host.viewport()));
    host.pan_by([100.0, -15.0]).unwrap();
    let manual = host.view();
    host.set_canvas([640, 480]).unwrap();
    assert_eq!(host.view(), manual);
    assert!(host.set_canvas([0, 480]).is_err());
    assert_eq!(host.canvas(), [640, 480]);
    host.close();
    drop(host);
    while spawner.run_next() {}
}

#[test]
fn wheel_glide_uses_reference_steps_and_cancels_on_external_zoom() {
    let mut wheel = WheelZoom::default();
    let mut view = View::default();
    wheel.wheel(&mut view, -100.0, [100.0, 80.0], 0.0, true, false);
    let expected = (0.3_f64 * (1.0 - (-0.4_f64).exp())).exp();
    assert!((view.zoom - expected).abs() < 1e-14);
    wheel.advance(&mut view, 500.0); // capped at 64 ms
    assert!(view.zoom < 0.3_f64.exp());
    for time in [516.0, 532.0, 548.0, 564.0, 580.0, 596.0, 612.0] {
        wheel.advance(&mut view, time);
    }
    assert_eq!(view.zoom, 0.3_f64.exp());
    assert!(!wheel.interacting());
    wheel.wheel(&mut view, 100.0, [100.0, 80.0], 700.0, true, false);
    view.zoom_by(1.2, [100.0, 80.0]);
    let manual = view;
    assert!(wheel.advance(&mut view, 716.0));
    assert_eq!(view, manual);
}

#[test]
fn pointer_and_pen_share_navigation_without_losing_terminal_events_or_pressure() {
    use styk_core::stage::input::{Button, InputResult, Navigation, Pointer, PointerPhase};
    use styk_services::input::{InputEvent, Modifiers, PenSample, Phase, Tool};
    let (mut host, spawner) = host();
    host.resize(Viewport {
        origin: [11.0, 70.0],
        dpr: 1.375,
        ..Default::default()
    })
    .unwrap();
    let start = host.view().pan;
    let mut pointer = Pointer {
        id: 9,
        phase: PointerPhase::Down,
        point: [100.0, 100.0],
        button: Button::Middle,
        modifiers: Modifiers::NONE,
    };
    assert_eq!(
        host.pointer(pointer, Navigation::default()).unwrap(),
        InputResult::Captured
    );
    pointer.phase = PointerPhase::Move;
    pointer.point = [114.0, 97.0];
    assert_eq!(
        host.pointer(pointer, Navigation::default()).unwrap(),
        InputResult::ViewChanged
    );
    assert_eq!(host.view().pan, [start[0] + 14.0, start[1] - 3.0]);
    pointer.phase = PointerPhase::Up;
    host.pointer(pointer, Navigation::default()).unwrap();
    pointer.phase = PointerPhase::Move;
    assert!(matches!(
        host.pointer(pointer, Navigation::default()).unwrap(),
        InputResult::Route(_)
    ));
    let mut sample = PenSample::at(123, 7, Tool::Eraser, 101.5, 90.25);
    sample.pressure = 0.73;
    sample.tilt_x = 31.0;
    sample.phase = Phase::Up;
    let InputEvent::Sample(physical) = host.automation_pen(sample) else {
        panic!("sample");
    };
    let mapped = host.pen_sample(physical, None);
    near(mapped.stage, [101.5, 90.25]);
    assert_eq!(mapped.original.pressure, 0.73);
    assert_eq!(mapped.original.tool, Tool::Eraser);
    assert_eq!(mapped.original.phase, Phase::Up);
    assert_eq!(mapped.original.time_ns, 123);
    host.close();
    drop(host);
    while spawner.run_next() {}
}

#[test]
fn picking_calls_the_engine_with_the_frozen_browser_answers() {
    use styk_core::engine::picking::{self, HandleOptions, PickOptions, Projection};
    use styk_doc::Value;
    let num = |v: &Value, k: &str, d: f64| v.get(k).and_then(Value::as_f64).unwrap_or(d);
    let yes = |v: &Value, k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let prepared = styk_eval::prepare(
        styk_eval::open_bytes(
            include_bytes!("../../styk-eval/tests/fixtures/picking/native-order-static.json"),
            "json",
            "picking",
        )
        .unwrap(),
    );
    let reference = styk_doc::json::parse(include_bytes!(
        "../../styk-eval/tests/fixtures/picking/native-order-static.reference.json"
    ))
    .unwrap();
    let sample = reference
        .get("frames")
        .unwrap()
        .elements()
        .unwrap()
        .get(0)
        .unwrap();
    let frame = prepared.native_at(0.0);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let handles = picking::handles(&scene, &frame, &HandleOptions::default()).unwrap();
    let queries = styk_core::stage::picking::Prepared {
        scene: &scene,
        frame: &frame,
        handles: &handles.handles,
    };
    let query = sample
        .get("queries")
        .unwrap()
        .elements()
        .unwrap()
        .get(0)
        .unwrap();
    let mut checked = 0;
    for pick in query.get("picks").unwrap().elements().unwrap() {
        let p = pick.get("point").unwrap().elements().unwrap();
        let o = pick.get("options").unwrap();
        let matrix = pick
            .get("matrix")
            .and_then(Value::elements)
            .map(|m| Projection(std::array::from_fn(|i| m.get(i).unwrap().as_f64().unwrap())));
        let actual = queries.handle(
            [
                p.get(0).unwrap().as_f64().unwrap(),
                p.get(1).unwrap().as_f64().unwrap(),
            ],
            &PickOptions {
                nearest: yes(o, "nearest"),
                preferred_uid: o
                    .get("preferredUid")
                    .and_then(Value::as_f64)
                    .map(|x| x as u32),
                min_radius: num(o, "minRadius", 0.0),
                radius: o.get("radius").and_then(Value::as_f64),
                projection: matrix,
            },
        );
        let expected = pick.get("result").unwrap();
        if expected.is_null() {
            assert!(actual.is_none());
        } else {
            let hit = actual.unwrap();
            assert_eq!(hit.handle as f64, num(expected, "handle", -1.0));
            assert_eq!(hit.distance_squared, num(expected, "distanceSquared", -1.0));
        }
        checked += 1;
    }
    assert!(checked > 20);
    println!("stage picking: {checked} frozen browser answers matched");
}
