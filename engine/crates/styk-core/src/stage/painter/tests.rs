use super::*;
use styk_services::{FixedClock, ManualSpawner};

struct Unavailable;
impl frames::FrameDocument for Unavailable {
    fn snapshot(&self, _: u64, _: u64) -> Option<Arc<styk_engine::Generation>> {
        None
    }
}

#[test]
fn a_failure_cancelled_before_handoff_never_reaches_the_interface() {
    let source: Arc<dyn frames::FrameDocument> = Arc::new(Unavailable);
    let spawner = ManualSpawner::new();
    let mut frames = frames::Frames::new(
        1,
        0,
        0,
        &source,
        frames::Config::default(),
        &spawner,
        Arc::new(FixedClock::new()),
        Arc::new(|| {}),
    )
    .unwrap();
    frames
        .request(
            frames::Consumer::Stage,
            0.0,
            Arc::new(frames::View::default()),
        )
        .unwrap();
    let ticket = frames.stage_ticket().unwrap();
    let shared = Arc::new(Shared {
        request: Slot::new(),
        ready: Slot::new(),
        returned: Slot::new(),
        shutdown_frame: Slot::new(),
        closed: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        changed: Condvar::new(),
        idle: Mutex::new(()),
        wake: Arc::new(|| {}),
    });
    let mut painter = Painter {
        shared: shared.clone(),
        shown: None,
        requested: Some(ticket.identity()),
        status: PaintStatus::Pending,
    };
    publish(&shared, ticket, Err(PaintError::Decode));
    frames.cancel(frames::Consumer::Stage).unwrap();
    assert_eq!(painter.update(), PaintStatus::Pending);
    assert!(painter.texture().is_none());
    painter.close();
    frames.close();
    while spawner.run_next() {}
}
