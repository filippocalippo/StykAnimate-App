use super::*;
use styk_engine::{Budgets, Engine};
use styk_services::{FixedClock, Job, ManualSpawner};

#[path = "../../../styk-engine/tests/support/drawlist.rs"]
mod drawlist_payload;

struct Document {
    generation: Arc<Generation>,
    hook: Mutex<Option<Job>>,
    gone: Arc<AtomicBool>,
}
impl FrameDocument for Document {
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<Generation>> {
        let hook = self.hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        (self.generation.revision == revision).then(|| self.generation.clone())
    }
}
impl Drop for Document {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::SeqCst);
    }
}

fn engine(name: &str) -> Engine {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../styk-eval/tests/fixtures")
        .join(name);
    engine
        .open(&std::fs::read(path).unwrap(), "json", "scheduler fixture")
        .unwrap();
    engine
}

fn document() -> Arc<Document> {
    Arc::new(Document {
        generation: engine("eval/color-transitions.json").generation().unwrap(),
        hook: Mutex::new(None),
        gone: Arc::new(AtomicBool::new(false)),
    })
}

fn frames(source: Arc<dyn FrameDocument>, config: Config) -> (Frames, ManualSpawner) {
    let spawner = ManualSpawner::new();
    let frames = Frames::new(
        7,
        0,
        0,
        &source,
        config,
        &spawner,
        Arc::new(FixedClock::new()),
        Arc::new(|| {}),
    )
    .unwrap();
    (frames, spawner)
}

fn drain(frames: &Frames) {
    let mut builder = FrameBuilder::default();
    for _ in 0..SLOTS * 2 {
        if !frames.shared.step(&mut builder) {
            return;
        }
    }
    panic!("worker failed to drain bounded requests");
}

fn status(frames: &Frames, consumer: Consumer) -> Status {
    frames.with_ready(consumer, |_| {})
}

#[test]
fn scheduler_lists_equal_engine_for_repository_fixtures() {
    for name in [
        "eval/color-transitions.json",
        "eval/movieclip-joined.json",
        "eval/parallax-layers.json",
        "eval/follow-figures.json",
    ] {
        let engine = engine(name);
        let source = Arc::new(Document {
            generation: engine.generation().unwrap(),
            hook: Mutex::new(None),
            gone: Arc::new(AtomicBool::new(false)),
        });
        let (mut frames, spawner) = frames(source, Config::default());
        for tick in [0.0, 0.5, 1.0] {
            let expected = engine.frame_now_at(tick).unwrap();
            frames
                .request(Consumer::Stage, tick, Arc::new(View::default()))
                .unwrap();
            drain(&frames);
            assert_eq!(
                frames.with_ready(Consumer::Stage, |ready| {
                    drawlist_payload::assert_lists(ready.list, &expected.list);
                    assert_eq!(ready.camera, expected.camera);
                    assert_eq!(ready.background, expected.background);
                    assert_eq!(ready.key.tick, tick);
                }),
                Status::Ready
            );
        }
        drop(frames);
        while spawner.run_next() {}
    }
}

#[test]
fn one_thousand_views_while_a_worker_is_stalled_deliver_only_the_last() {
    let source = document();
    let (frames, spawner) = frames(source.clone(), Config::default());
    let owner = Arc::new(Mutex::new(frames));
    let view = Arc::new(View::default());
    owner
        .lock()
        .unwrap()
        .request(Consumer::Stage, 0.0, view.clone())
        .unwrap();
    let caller = owner.clone();
    *source.hook.lock().unwrap() = Some(Box::new(move || {
        // This callback runs inside the production snapshot/prepare path, with
        // the first request already in flight and no queue lock held.
        let mut frames = caller.lock().unwrap();
        for x in 1..=1000 {
            let mut view = View::default();
            view.pan[0] = x as f64;
            frames
                .request(Consumer::Stage, 0.0, Arc::new(view))
                .unwrap();
            let stats = frames.stats().unwrap();
            assert!(
                stats.queued <= 1
                    && stats.inflight <= 1
                    && stats.cached_bytes <= Config::default().cache_bytes
            );
        }
        assert_eq!(status(&frames, Consumer::Stage), Status::Pending);
    }));
    let shared = owner.lock().unwrap().shared.clone();
    assert!(shared.step(&mut FrameBuilder::default()));
    let frames = owner.lock().unwrap();
    assert_eq!(frames.stats().unwrap().discarded, 1);
    drain(&frames);
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| assert_eq!(
            ready.key.view.pan[0],
            1000.0
        )),
        Status::Ready
    );
    assert_eq!(frames.stats().unwrap().prepared, 1);
    drop(frames);
    drop(owner);
    while spawner.run_next() {}
}

#[test]
fn revision_change_in_flight_rejects_old_result_and_retires_idle_cache() {
    let source = document();
    let (mut frames, spawner) = frames(source.clone(), Config::default());
    frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    drain(&frames);
    assert!(frames.stats().unwrap().cached_bytes > 0);
    frames.revise(1, 0).unwrap();
    drain(&frames);
    assert_eq!(
        frames.stats().unwrap().cached_bytes,
        0,
        "revision change with no new request frees the old cache"
    );
    frames.revise(0, 0).unwrap();
    frames
        .request(Consumer::Stage, 0.5, Arc::new(View::default()))
        .unwrap();
    let owner = Arc::new(Mutex::new(frames));
    let caller = owner.clone();
    *source.hook.lock().unwrap() = Some(Box::new(move || {
        caller.lock().unwrap().revise(2, 0).unwrap()
    }));
    let shared = owner.lock().unwrap().shared.clone();
    assert!(shared.step(&mut FrameBuilder::default()));
    assert_eq!(owner.lock().unwrap().stats().unwrap().discarded, 1);
    assert_eq!(
        status(&owner.lock().unwrap(), Consumer::Stage),
        Status::Pending
    );
    drop(owner);
    while spawner.run_next() {}
}

#[test]
fn contended_queue_admission_and_readiness_never_wait_and_keep_latest_stage() {
    let (mut frames, spawner) = frames(document(), Config::default());
    let shared = frames.shared.clone();
    let held = shared.state.lock().unwrap();
    for tick in [0.0, 0.5, 1.0] {
        frames
            .request(Consumer::Stage, tick, Arc::new(View::default()))
            .unwrap();
    }
    assert_eq!(status(&frames, Consumer::Stage), Status::Busy);
    assert!(!frames.flush());
    assert!(frames.stats().is_none());
    frames.revise(0, 1).unwrap();
    frames
        .request(Consumer::Stage, 1.0, Arc::new(View::default()))
        .unwrap();
    drop(held);
    assert!(frames.flush());
    drain(&frames);
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| {
            assert_eq!(ready.key.tick, 1.0);
            assert_eq!(ready.key.resource_epoch, 1);
        }),
        Status::Ready
    );
    assert_eq!(frames.stats().unwrap().prepared, 1);
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn close_while_preparing_cancels_and_releases_document_and_cache() {
    let source = document();
    let gone = source.gone.clone();
    let weak_generation = Arc::downgrade(&source.generation);
    let (mut frames, spawner) = frames(source.clone(), Config::default());
    frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    drain(&frames);
    frames
        .request(Consumer::Stage, 0.5, Arc::new(View::default()))
        .unwrap();
    let owner = Arc::new(Mutex::new(frames));
    let caller = owner.clone();
    *source.hook.lock().unwrap() = Some(Box::new(move || caller.lock().unwrap().close()));
    drop(source);
    let shared = owner.lock().unwrap().shared.clone();
    assert!(shared.step(&mut FrameBuilder::default()));
    while spawner.run_next() {}
    assert!(gone.load(Ordering::SeqCst));
    assert!(weak_generation.upgrade().is_none());
    assert_eq!(owner.lock().unwrap().stats().unwrap().cached_bytes, 0);
    assert_eq!(
        status(&owner.lock().unwrap(), Consumer::Stage),
        Status::Failed(Error::Closed)
    );
}

#[test]
fn priority_is_stage_then_playback_onion_preview_thumbnail() {
    let (mut frames, spawner) = frames(document(), Config::default());
    for consumer in [
        Consumer::Thumbnail(0),
        Consumer::Preview(0),
        Consumer::Onion(0),
        Consumer::Playback(0),
        Consumer::Stage,
    ] {
        frames
            .request(consumer, 0.0, Arc::new(View::default()))
            .unwrap();
    }
    let mut builder = FrameBuilder::default();
    for consumer in [
        Consumer::Stage,
        Consumer::Playback(0),
        Consumer::Onion(0),
        Consumer::Preview(0),
        Consumer::Thumbnail(0),
    ] {
        assert_eq!(status(&frames, consumer), Status::Pending);
        assert!(frames.shared.step(&mut builder));
        assert_eq!(status(&frames, consumer), Status::Ready);
    }
    assert_eq!(frames.stats().unwrap().prepared, 1);
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn an_oversized_frame_is_refused_even_when_cache_is_empty() {
    let (mut frames, spawner) = frames(
        document(),
        Config {
            cache_bytes: 1,
            ..Default::default()
        },
    );
    frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    drain(&frames);
    assert!(matches!(
        status(&frames, Consumer::Stage),
        Status::Failed(Error::Budget { limit: 1, .. })
    ));
    assert_eq!(frames.stats().unwrap().cached_bytes, 0);
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn review_lookahead_keeps_the_two_nearest_requested_ticks() {
    let source = document();
    let view = Arc::new(View::default());
    let (mut sizing, jobs) = frames(source.clone(), Config::default());
    sizing.request(Consumer::Stage, 0.0, view.clone()).unwrap();
    drain(&sizing);
    let charge = sizing.stats().unwrap().cached_bytes;
    drop(sizing);
    while jobs.run_next() {}
    let (mut frames, jobs) = frames(
        source,
        Config {
            cache_bytes: 2 * charge,
            lookahead_bytes: 2 * charge,
            ..Config::default()
        },
    );
    frames
        .lookahead(0, 0..3, false, 3, 2 * charge, view)
        .unwrap();
    drain(&frames);
    assert_eq!(
        status(&frames, Consumer::Playback(0)),
        Status::Ready,
        "the next tick must not be evicted for farther speculation"
    );
    assert_eq!(status(&frames, Consumer::Playback(1)), Status::Ready);
    assert!(matches!(
        status(&frames, Consumer::Playback(2)),
        Status::Failed(Error::Budget { .. })
    ));
    drop(frames);
    while jobs.run_next() {}
}

#[test]
fn review_readiness_does_no_full_view_comparison_for_dense_same_tick_views() {
    let (mut frames, jobs) = frames(document(), Config::default());
    for index in 0..20 {
        let mut view = View::default();
        view.scene.translations = vec![(u32::MAX, [0.0, 0.0]); 65_536];
        view.scene.translations.last_mut().unwrap().1[0] = f64::from(index);
        frames
            .request(Consumer::Stage, 0.0, Arc::new(view))
            .unwrap();
        drain(&frames);
    }
    assert_eq!(frames.stats().unwrap().cached_frames, 20);
    FULL_KEY_COMPARISONS.with(|count| count.set(0));
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| {
            assert_eq!(ready.key.view.scene.translations.last().unwrap().1[0], 19.0);
        }),
        Status::Ready
    );
    assert_eq!(
        FULL_KEY_COMPARISONS.with(|count| count.get()),
        0,
        "readiness must resolve a scalar ticket, not compare translation arrays"
    );
    drop(frames);
    while jobs.run_next() {}
}

#[test]
fn wrapped_lookahead_moves_forward_and_a_smaller_budget_keeps_the_nearest() {
    let source = document();
    let view = Arc::new(View::default());
    let (mut sizing, jobs) = frames(source.clone(), Config::default());
    sizing.request(Consumer::Stage, 0.0, view.clone()).unwrap();
    drain(&sizing);
    let charge = sizing.stats().unwrap().cached_bytes;
    drop(sizing);
    while jobs.run_next() {}
    let (mut frames, jobs) = frames(
        source,
        Config {
            cache_bytes: 2 * charge,
            lookahead_bytes: 2 * charge,
            ..Config::default()
        },
    );
    for start in [2, 0, 1] {
        frames
            .lookahead(start, 0..3, true, 3, 2 * charge, view.clone())
            .unwrap();
        drain(&frames);
        for rank in 0..2 {
            assert_eq!(
                frames.with_ready(Consumer::Playback(rank), |ready| {
                    assert_eq!(ready.key.tick, f64::from((start + u32::from(rank)) % 3));
                }),
                Status::Ready
            );
        }
        assert!(matches!(
            status(&frames, Consumer::Playback(2)),
            Status::Failed(Error::Budget { .. })
        ));
    }
    frames.lookahead(1, 0..3, true, 3, charge, view).unwrap();
    drain(&frames);
    assert_eq!(
        frames.with_ready(Consumer::Playback(0), |ready| assert_eq!(
            ready.key.tick,
            1.0
        )),
        Status::Ready
    );
    assert_eq!(frames.stats().unwrap().cached_frames, 1);
    drop(frames);
    while jobs.run_next() {}
}

#[test]
fn ready_tickets_survive_compaction_and_reject_a_reused_cache_slot() {
    let source = document();
    let (mut sizing, jobs) = frames(source.clone(), Config::default());
    sizing
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    drain(&sizing);
    let charge = sizing.stats().unwrap().cached_bytes;
    drop(sizing);
    while jobs.run_next() {}
    let (mut frames, jobs) = frames(
        source,
        Config {
            cache_bytes: 2 * charge,
            ..Config::default()
        },
    );
    for index in 0..3 {
        let mut view = View::default();
        view.pan[0] = f64::from(index);
        frames
            .request(Consumer::Preview(index), 0.0, Arc::new(view))
            .unwrap();
        drain(&frames);
    }
    FULL_KEY_COMPARISONS.with(|count| count.set(0));
    assert_eq!(
        frames.with_ready(Consumer::Preview(0), |_| panic!(
            "retired ticket aliased another entry"
        )),
        Status::Evicted
    );
    for index in 1..3 {
        assert_eq!(
            frames.with_ready(Consumer::Preview(index), |ready| assert_eq!(
                ready.key.view.pan[0],
                f64::from(index)
            )),
            Status::Ready
        );
    }
    assert_eq!(FULL_KEY_COMPARISONS.with(|count| count.get()), 0);
    drop(frames);
    while jobs.run_next() {}
}

#[test]
fn a_key_hash_collision_is_resolved_on_the_worker() {
    let (mut frames, jobs) = frames(document(), Config::default());
    frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    drain(&frames);
    let mut view = View::default();
    view.pan[0] = 1.0;
    let wanted = frames
        .request(Consumer::Stage, 0.0, Arc::new(view))
        .unwrap();
    // Force an adversarial equal hash without replacing the first entry's key.
    frames.shared.state.lock().unwrap().cache[0].fingerprint = wanted.fingerprint();
    FULL_KEY_COMPARISONS.with(|count| count.set(0));
    drain(&frames);
    assert!(FULL_KEY_COMPARISONS.with(|count| count.get()) > 0);
    assert_eq!(frames.stats().unwrap().prepared, 2);
    FULL_KEY_COMPARISONS.with(|count| count.set(0));
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| assert_eq!(
            ready.key.view.pan[0],
            1.0
        )),
        Status::Ready
    );
    assert_eq!(FULL_KEY_COMPARISONS.with(|count| count.get()), 0);
    drop(frames);
    while jobs.run_next() {}
}

#[test]
fn signed_zero_keys_share_a_fingerprint() {
    let (mut frames, jobs) = frames(document(), Config::default());
    let first = frames
        .request(Consumer::Stage, -0.0, Arc::new(View::default()))
        .unwrap();
    let view = View {
        pan: [-0.0; 2],
        ..View::default()
    };
    let second = frames
        .request(Consumer::Stage, 0.0, Arc::new(view))
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.fingerprint(), second.fingerprint());
    drop(frames);
    while jobs.run_next() {}
}

#[test]
fn a_playback_cache_hit_promoted_to_stage_cannot_be_evicted_by_lookahead() {
    let source = document();
    let (mut frames, spawner) = frames(source.clone(), Config::default());
    let view = Arc::new(View::default());
    frames
        .request(Consumer::Playback(0), 0.0, view.clone())
        .unwrap();
    drain(&frames);
    let charge = frames.stats().unwrap().cached_bytes;
    drop(frames);
    while spawner.run_next() {}
    let (mut frames, spawner) = self::frames(
        source,
        Config {
            cache_bytes: charge,
            lookahead_bytes: charge,
            ..Default::default()
        },
    );
    frames
        .request(Consumer::Playback(0), 0.0, view.clone())
        .unwrap();
    drain(&frames);
    frames.request(Consumer::Stage, 0.0, view.clone()).unwrap();
    drain(&frames);
    frames.request(Consumer::Playback(1), 0.5, view).unwrap();
    drain(&frames);
    assert_eq!(status(&frames, Consumer::Stage), Status::Ready);
    assert!(frames.stats().unwrap().cached_bytes <= charge);
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn lookahead_wraps_half_open_range_and_actual_bytes_are_bounded() {
    let (mut frames, spawner) = frames(document(), Config::default());
    let view = Arc::new(View::default());
    assert_eq!(
        frames
            .lookahead(9, 2..10, true, 48, 4096, view.clone())
            .unwrap(),
        8
    );
    let ticks: Vec<_> = frames
        .wanted
        .iter()
        .skip(1)
        .take(8)
        .map(|r| r.as_ref().unwrap().key.tick)
        .collect();
    assert_eq!(ticks, [9., 2., 3., 4., 5., 6., 7., 8.]);
    drain(&frames);
    assert!(frames.stats().unwrap().cached_bytes <= 4096);
    assert_eq!(
        frames
            .lookahead(9, 2..10, false, 48, 4096, view.clone())
            .unwrap(),
        1
    );
    assert_eq!(frames.lookahead(2, 2..10, false, 48, 0, view).unwrap(), 0);
    drain(&frames);
    assert_eq!(
        frames.stats().unwrap().cached_bytes,
        0,
        "zero lookahead budget retires cached speculative frames"
    );
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn every_presentation_input_changes_the_key_and_invalid_requests_are_visible() {
    let (mut frames, spawner) = frames(document(), Config::default());
    let base = frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    let mut variants = vec![View::default(); 12];
    variants[0].size[0] += 1;
    variants[1].zoom = 2.0;
    variants[2].pan[0] = 1.0;
    variants[3].quality = 0.5;
    variants[4].scene.camera = false;
    variants[5].scene.effects = false;
    variants[6].scene.clip_to_canvas = false;
    variants[7].scene.background = Some(0xff123456);
    variants[8].scene.hidden_uids.push(1);
    variants[9].scene.onions.push(Onion {
        tick: 1.0,
        opacity: 0.3,
        tint: Some([0, 128, 255]),
        on_top: true,
        hidden_uids: vec![1],
    });
    variants[10].scene.translations.push((1, [10.0, 20.0]));
    variants[11].samples = 1;
    for view in variants {
        assert_ne!(
            base,
            frames
                .request(Consumer::Stage, 0.0, Arc::new(view))
                .unwrap()
        );
    }
    assert_eq!(
        frames.request(Consumer::Stage, f64::NAN, base.view.clone()),
        Err(Error::InvalidRequest)
    );
    assert_eq!(
        frames.request(Consumer::Thumbnail(255), 0.0, base.view),
        Err(Error::InvalidRequest)
    );
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn spawn_failure_is_reported_and_started_workers_reclaim() {
    struct FailSecond {
        manual: ManualSpawner,
        count: AtomicUsize,
    }
    impl Spawner for FailSecond {
        fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
            if self.count.fetch_add(1, Ordering::SeqCst) == 1 {
                Err(SpawnError("injected failure".into()))
            } else {
                self.manual.spawn(name, job)
            }
        }
    }
    let source = document();
    let gone = source.gone.clone();
    let spawner = FailSecond {
        manual: ManualSpawner::new(),
        count: AtomicUsize::new(0),
    };
    let source: Arc<dyn FrameDocument> = source;
    assert!(
        Frames::new(
            1,
            0,
            0,
            &source,
            Config::default(),
            &spawner,
            Arc::new(FixedClock::new()),
            Arc::new(|| {})
        )
        .is_err()
    );
    drop(source);
    assert!(spawner.manual.run_next());
    assert!(gone.load(Ordering::SeqCst));
}

#[test]
fn latency_uses_the_injected_clock() {
    let spawner = ManualSpawner::new();
    let clock = Arc::new(FixedClock::new());
    let source = document();
    let work_clock = clock.clone();
    *source.hook.lock().unwrap() = Some(Box::new(move || {
        work_clock.advance(Duration::from_millis(7))
    }));
    let source: Arc<dyn FrameDocument> = source;
    let mut frames = Frames::new(
        1,
        0,
        0,
        &source,
        Config::default(),
        &spawner,
        clock.clone(),
        Arc::new(|| {}),
    )
    .unwrap();
    frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    clock.advance(Duration::from_millis(3));
    drain(&frames);
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| assert_eq!(
            ready.latency,
            Duration::from_millis(10)
        )),
        Status::Ready
    );
    drop(frames);
    while spawner.run_next() {}
}

#[test]
fn decoded_resource_bounds_replace_every_retained_frame_of_the_old_epoch() {
    let mut value = styk_doc::json::parse(include_bytes!(
        "../../../styk-eval/tests/fixtures/drawlist/drawing-cel.json"
    ))
    .unwrap();
    let figure = &mut value
        .make_obj()
        .unwrap()
        .get_mut("figure_types")
        .unwrap()
        .make_arr()
        .unwrap()[0];
    figure
        .make_obj()
        .unwrap()
        .get_mut("_styk")
        .unwrap()
        .make_obj()
        .unwrap()
        .get_mut("drawing")
        .unwrap()
        .make_obj()
        .unwrap()
        .set("bounds", styk_doc::Value::Null);
    let object = &mut value
        .make_obj()
        .unwrap()
        .get_mut("keyframes")
        .unwrap()
        .make_arr()
        .unwrap()[0]
        .make_obj()
        .unwrap()
        .get_mut("objects")
        .unwrap()
        .make_arr()
        .unwrap()[0];
    object.make_obj().unwrap().set("_stykVfx", styk_doc::json::parse(br#"{"figure":[{"version":2,"id":"bounds","type":"outline","enabled":true,"params":{"width":2,"opacity":1,"mode":0}}]}"#).unwrap());
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine
        .open(
            styk_doc::json::to_string(&value).as_bytes(),
            "json",
            "bounds",
        )
        .unwrap();
    let source = Arc::new(Document {
        generation: engine.generation().unwrap(),
        hook: Mutex::new(None),
        gone: Arc::new(AtomicBool::new(false)),
    });
    let (mut frames, spawner) = frames(source, Config::default());
    let mut builder = FrameBuilder::default();
    let view = Arc::new(View::default());
    frames.request(Consumer::Stage, 0.0, view.clone()).unwrap();
    assert!(frames.shared.step(&mut builder));
    let mut before = Vec::new();
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| before =
            drawlist_payload::payload(ready.list)),
        Status::Ready
    );
    while engine.step() {}
    let expected = engine.frame_now(0).unwrap();
    assert_ne!(
        before,
        drawlist_payload::payload(&expected.list),
        "the decoder must change the actual effect grid"
    );
    frames.revise(0, 1).unwrap();
    frames.request(Consumer::Stage, 0.0, view).unwrap();
    assert!(frames.shared.step(&mut builder));
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| drawlist_payload::assert_lists(
            ready.list,
            &expected.list
        )),
        Status::Ready
    );
    drop(builder);
    drop(frames);
    while spawner.run_next() {}
}
