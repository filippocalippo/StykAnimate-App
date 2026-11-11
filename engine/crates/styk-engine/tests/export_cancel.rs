//! A cancelled Pivot export of a large padded file is seen at once, at whichever step it is: the interface that cancels an export waits for
//! the worker to say so. This binary times a cancel, so it holds one test.
mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use styk_engine::document_export::{DocumentExportError, Output};
use support::*;

/// What a cancel may take to be seen. The export's own polls are tens of milliseconds apart (4 MiB of hashing, a megabyte of text, 4096 nodes).
const SEEN_WITHIN: Duration = Duration::from_millis(100);

#[test]
fn a_cancel_a_tenth_of_a_second_in_is_seen_within_a_tenth_of_a_second() {
    let file = padded_with_noise(60 << 20);
    let (engine, revision) = edited(&file);
    for cancel_after in [100] {
        let cancelled = AtomicBool::new(false);
        let at = std::sync::Mutex::new(None);
        let started = Instant::now();
        let (made, returned) = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(cancel_after));
                *at.lock().unwrap() = Some(Instant::now());
                cancelled.store(true, Ordering::Relaxed);
            });
            let made = engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| cancelled.load(Ordering::Relaxed));
            (made, Instant::now())
        });
        let asked = at.lock().unwrap().expect("the cancel was asked");
        assert!(matches!(made, Err(DocumentExportError::Cancelled)), "the export ended before the cancel at {cancel_after} ms ({:?} in): {:?}", started.elapsed(), made.map(|made| made.bytes.len()));
        let seen = returned.duration_since(asked);
        eprintln!("cancel {cancel_after} ms in: seen after {seen:?}");
        assert!(seen < SEEN_WITHIN, "a cancel {cancel_after} ms in was seen after {seen:?}");
    }
}
