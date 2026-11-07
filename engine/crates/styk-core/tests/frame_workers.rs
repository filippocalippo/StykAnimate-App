//! Native worker integration and an opt-in, in-place frame-readiness diagnostic.
//! Use the actual platform spawner without making core depend on the platform.
#[path = "../../styk-platform/src/spawn.rs"]
mod platform_spawn;

use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Duration;
use styk_core::frames::{Config, Consumer, FrameDocument, Frames, Status, View};
use styk_engine::{Budgets, Engine, Generation};
use styk_services::{Clock, SystemClock};

struct Source(Arc<Generation>);
impl FrameDocument for Source {
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<Generation>> {
        (revision == self.0.revision).then(|| self.0.clone())
    }
}

fn pool(
    source: &Arc<dyn FrameDocument>,
    revision: u64,
    clock: Arc<dyn Clock>,
) -> (Frames, mpsc::Receiver<()>) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let frames = Frames::new(
        1,
        revision,
        0,
        source,
        Config::default(),
        &platform_spawn::ThreadSpawner,
        clock,
        Arc::new(move || match sender.try_send(()) {
            Ok(())
            | Err(mpsc::TrySendError::Full(()))
            | Err(mpsc::TrySendError::Disconnected(())) => {}
        }),
    )
    .unwrap();
    (frames, receiver)
}

fn ready(frames: &mut Frames, wake: &mpsc::Receiver<()>, clock: &dyn Clock) {
    let start = clock.now();
    loop {
        frames.flush();
        match frames.with_ready(Consumer::Stage, |_| {}) {
            Status::Ready => return,
            Status::Pending | Status::Busy => {}
            status => panic!("stage failed: {status:?}"),
        }
        assert!(
            clock.now().saturating_sub(start) < Duration::from_secs(30),
            "frame worker timed out"
        );
        match wake.recv_timeout(Duration::from_millis(25)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("wake disconnected: {error}"),
        }
    }
}

#[test]
fn platform_workers_deliver_the_last_view_and_close_while_a_snapshot_is_stalled() {
    struct Stalled {
        generation: Arc<Generation>,
        entered: mpsc::SyncSender<()>,
        gate: Arc<(Mutex<bool>, Condvar)>,
    }
    impl FrameDocument for Stalled {
        fn snapshot(&self, _: u64, _: u64) -> Option<Arc<Generation>> {
            let (lock, changed) = &*self.gate;
            let mut open = lock.lock().unwrap();
            if !*open {
                self.entered.try_send(()).unwrap();
                while !*open {
                    open = changed.wait(open).unwrap();
                }
            }
            Some(self.generation.clone())
        }
    }
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine
        .open(
            include_bytes!("../../styk-eval/tests/fixtures/eval/color-transitions.json"),
            "json",
            "workers",
        )
        .unwrap();
    let generation = engine.generation().unwrap();
    drop(engine);
    let weak = Arc::downgrade(&generation);
    let clock = Arc::new(SystemClock::new());
    let (entered, waiting) = mpsc::sync_channel(1);
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let source: Arc<dyn FrameDocument> = Arc::new(Stalled {
        generation,
        entered,
        gate: gate.clone(),
    });
    let (mut frames, wake) = pool(&source, 0, clock.clone());
    drop(source);
    frames
        .request(Consumer::Stage, 0.0, Arc::new(View::default()))
        .unwrap();
    waiting.recv_timeout(Duration::from_secs(10)).unwrap();
    for x in 1..=1000 {
        let mut view = View::default();
        view.pan[0] = f64::from(x);
        frames
            .request(Consumer::Stage, 0.0, Arc::new(view))
            .unwrap();
    }
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    ready(&mut frames, &wake, clock.as_ref());
    assert_eq!(
        frames.with_ready(Consumer::Stage, |ready| assert_eq!(
            ready.key.view.pan[0],
            1000.0
        )),
        Status::Ready
    );
    while waiting.try_recv().is_ok() {}
    *gate.0.lock().unwrap() = false;
    let mut view = View::default();
    view.pan[0] = 2000.0;
    frames
        .request(Consumer::Stage, 0.5, Arc::new(view))
        .unwrap();
    frames.flush();
    waiting.recv_timeout(Duration::from_secs(10)).unwrap();
    frames.close();
    assert!(matches!(
        frames.with_ready(Consumer::Stage, |_| panic!("closed stage drawn")),
        Status::Failed(_)
    ));
    drop(frames);
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    let until = clock.now() + Duration::from_secs(10);
    while weak.upgrade().is_some() {
        assert!(
            clock.now() < until,
            "closed document retained after worker completed"
        );
        match wake.recv_timeout(Duration::from_millis(25)) {
            Ok(())
            | Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
        }
    }
}

/// This measures CPU request-to-ready, not GPU presentation or an iced gesture.
/// The file is read in place and its name is never printed. Missing input fails.
#[test]
#[ignore = "requires STYK_FRAME_MEASURE_FILE and a release build; diagnostic, not a performance gate"]
fn representative_native_frame_readiness() {
    let path = std::path::PathBuf::from(
        std::env::var_os("STYK_FRAME_MEASURE_FILE")
            .expect("STYK_FRAME_MEASURE_FILE must name an existing local document"),
    );
    let clock = Arc::new(SystemClock::new());
    let bytes = std::fs::read(&path).expect("read measurement input in place");
    let name = path.file_name().unwrap().to_str().unwrap();
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let opened = engine
        .open_document(
            styk_engine::document::OpenSource::File {
                bytes: &bytes,
                name,
            },
            styk_engine::document::OpenOptions {
                layer_timeline: true,
            },
            &|| false,
        )
        .unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let generation = engine.generation().unwrap();
    let uid = generation
        .prepared
        .evaluate(0.0)
        .objects
        .first()
        .expect("measurement needs an object")
        .uid;
    let source: Arc<dyn FrameDocument> = Arc::new(Source(generation));
    let (mut frames, wake) = pool(&source, 1, clock.clone());
    let mut view = View {
        size: [1600, 900],
        ..View::default()
    };
    view.scene.camera = false;
    let start = clock.now();
    frames
        .request(Consumer::Stage, 0.0, Arc::new(view.clone()))
        .unwrap();
    ready(&mut frames, &wake, clock.as_ref());
    let first = clock.now().saturating_sub(start).as_secs_f64() * 1000.0;
    let mut latencies = Vec::new();
    for step in 1..=40 {
        view.scene.translations = vec![(uid, [f64::from(step), f64::from(step) * 0.25])];
        let start = clock.now();
        let key = frames
            .request(Consumer::Stage, 0.0, Arc::new(view.clone()))
            .unwrap();
        ready(&mut frames, &wake, clock.as_ref());
        assert_eq!(
            frames.with_ready(Consumer::Stage, |ready| assert_eq!(*ready.key, key)),
            Status::Ready
        );
        latencies.push(clock.now().saturating_sub(start).as_secs_f64() * 1000.0);
    }
    latencies.sort_by(f64::total_cmp);
    let stats = loop {
        if let Some(stats) = frames.stats() {
            break stats;
        }
        match wake.recv_timeout(Duration::from_millis(25)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("wake disconnected: {error}"),
        }
    };
    assert!(stats.cached_bytes <= Config::default().cache_bytes);
    println!(
        "CPU readiness: first={first:.3} ms; move samples={}; p50={:.3} ms; p95={:.3} ms; max={:.3} ms; retained={} bytes",
        latencies.len(),
        latencies[19],
        latencies[37],
        latencies[39],
        stats.cached_bytes
    );
    frames.close();
}
