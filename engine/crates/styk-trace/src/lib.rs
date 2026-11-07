//! The instrumentation layer (decision N4).
//!
//! Normal code carries named spans, counters and marks through three macros:
//!
//! ```
//! # use styk_trace::{counter, mark, span};
//! let _frame = span!("stage.frame");   // ends when the guard drops
//! counter!("frames.cached", 12);       // a value at this moment
//! mark!("first-frame");                // an instant
//! ```
//!
//! With the `enabled` feature off (every release build) the macros expand to a zero-sized guard and to nothing: no
//! timestamp, no memory, no code, and the arguments of `counter!` are type-checked but never evaluated. With it on,
//! each thread records its recent events in its own fixed-size ring, written without locks and without allocating
//! after the thread's first event; [`snapshot`] collects every thread's ring for a tool to show.
//!
//! With tracing off this crate has no dependencies. Enabled tracing reads the injected services clock: the engine crates instrument themselves with it, so it can
//! never depend on them, on the core or on a toolkit.

#[cfg(feature = "enabled")]
pub mod clock;
#[cfg(feature = "enabled")]
mod ring;

#[cfg(feature = "enabled")]
pub use ring::{
    ARCHIVE_CAPACITY, MAX_ARCHIVE_BYTES, MAX_RING_BYTES, MAX_SNAPSHOT_BYTES, OpenSpan, Record,
    RecordKind, Site, Span, Thread, capacity, counters, dropped, gauges, live_threads, now_ns,
    open_spans, ring_bytes, ring_snapshot, snapshot, threads,
};

/// The guard `span!` returns when instrumentation is off: it holds nothing and does nothing.
#[cfg(not(feature = "enabled"))]
#[derive(Clone, Copy, Debug, Default)]
pub struct Span;

/// Opens a span that ends when the returned guard drops.
#[cfg(feature = "enabled")]
#[macro_export]
macro_rules! span {
    ($name:expr) => {{
        static SITE: $crate::Site = $crate::Site::new($name);
        $crate::Span::enter(&SITE)
    }};
}

/// Opens a span that ends when the returned guard drops.
#[cfg(not(feature = "enabled"))]
#[macro_export]
macro_rules! span {
    ($name:expr) => {{
        if false {
            let _ = $name;
        }
        $crate::Span
    }};
}

/// Records a value at this moment, for example the entries in a cache.
#[cfg(feature = "enabled")]
#[macro_export]
macro_rules! counter {
    ($name:expr, $value:expr) => {{
        static SITE: $crate::Site = $crate::Site::new($name);
        SITE.counter(($value) as i64);
    }};
}

/// Records a value at this moment, for example the entries in a cache.
#[cfg(not(feature = "enabled"))]
#[macro_export]
macro_rules! counter {
    ($name:expr, $value:expr) => {{
        if false {
            let _ = $name;
        }
        if false {
            let _ = ($value) as i64;
        }
    }};
}

/// Records an instant, for example "first frame shown".
#[cfg(feature = "enabled")]
#[macro_export]
macro_rules! mark {
    ($name:expr) => {{
        static SITE: $crate::Site = $crate::Site::new($name);
        SITE.mark();
    }};
}

/// Records an instant, for example "first frame shown".
#[cfg(not(feature = "enabled"))]
#[macro_export]
macro_rules! mark {
    ($name:expr) => {{
        if false {
            let _ = $name;
        }
    }};
}

#[cfg(all(test, not(feature = "enabled")))]
mod tests_off {
    #[test]
    fn disabled_names_are_not_evaluated() {
        let mut calls = 0;
        let _guard = span!({
            calls += 1;
            "disabled"
        });
        counter!(
            {
                calls += 1;
                "disabled"
            },
            1
        );
        mark!({
            calls += 1;
            "disabled"
        });
        assert_eq!(calls, 0);
    }

    #[test]
    fn the_guard_is_zero_sized() {
        let guard = span!("never recorded");
        assert_eq!(std::mem::size_of_val(&guard), 0);
    }

    #[test]
    fn counter_arguments_are_never_evaluated() {
        let mut evaluated = false;
        counter!("never recorded", {
            evaluated = true;
            1
        });
        mark!("never recorded");
        assert!(!evaluated, "a disabled counter! must not run its argument");
    }
}

#[cfg(all(test, feature = "enabled"))]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(all(test, feature = "enabled"))]
mod tests_on {
    use super::*;
    fn init() {
        let _ = clock::install(std::sync::Arc::new(styk_services::clock::SystemClock::new()));
    }

    /// Tests that look at what finished threads left behind take turns: another test ending thousands of threads would
    /// push their events out of the bounded archive.

    fn on_thread<T: Send + 'static>(
        name: &str,
        work: impl FnOnce() + Send + 'static,
        pick: impl FnOnce(Vec<Record>) -> T + Send + 'static,
    ) -> T {
        let thread = name.to_string();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                work();
                pick(
                    snapshot()
                        .into_iter()
                        .filter(|record| record.thread_name.as_ref() == thread)
                        .collect(),
                )
            })
            .unwrap()
            .join()
            .unwrap()
    }

    #[test]
    fn spans_counters_and_marks_are_recorded_on_their_thread() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        init();
        let records = on_thread(
            "trace-test-records",
            || {
                let _span = span!("test.span");
                counter!("test.counter", 7);
                mark!("test.mark");
            },
            |records| records,
        );
        // The span is written when its guard drops, after the counter and the mark inside it.
        let kinds: Vec<(&str, RecordKind)> = records.iter().map(|r| (r.name, r.kind)).collect();
        assert_eq!(
            kinds,
            [
                ("test.span", RecordKind::Span),
                ("test.counter", RecordKind::Counter(7)),
                ("test.mark", RecordKind::Mark)
            ]
        );
        let span = &records[0];
        let mark = &records[2];
        assert!(
            span.start_ns <= mark.start_ns,
            "the span began before the mark inside it"
        );
        assert!(
            span.start_ns + span.duration_ns >= mark.start_ns,
            "and ended after it"
        );
    }

    #[test]
    fn the_ring_keeps_only_the_most_recent_events() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        init();
        let values = on_thread(
            "trace-test-ring",
            || {
                for value in 0..capacity() * 3 + 5 {
                    counter!("test.ring", value);
                }
            },
            |records| {
                records
                    .iter()
                    .map(|r| match r.kind {
                        RecordKind::Counter(value) => value,
                        other => panic!("unexpected {other:?}"),
                    })
                    .collect::<Vec<i64>>()
            },
        );
        assert_eq!(values.len(), capacity());
        let last = (capacity() * 3 + 4) as i64;
        assert_eq!(*values.last().unwrap(), last);
        assert_eq!(values[0], last - capacity() as i64 + 1);
        assert!(
            values.windows(2).all(|pair| pair[1] == pair[0] + 1),
            "the newest events, in order"
        );
    }

    #[test]
    fn a_thread_that_ended_stays_visible_and_threads_do_not_mix() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        init();

        let one = std::thread::Builder::new()
            .name("trace-test-one".into())
            .spawn(|| mark!("test.one"))
            .unwrap();
        let two = std::thread::Builder::new()
            .name("trace-test-two".into())
            .spawn(|| mark!("test.two"))
            .unwrap();
        one.join().unwrap();
        two.join().unwrap();
        let records = snapshot();
        let of = |thread: &str| {
            records
                .iter()
                .filter(|r| r.thread_name.as_ref() == thread)
                .map(|r| r.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(of("trace-test-one"), ["test.one"]);
        assert_eq!(of("trace-test-two"), ["test.two"]);
    }

    #[test]
    fn finished_threads_release_their_rings_and_their_events_stay_bounded() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        init();

        let before = live_threads();
        let threads = 2000;
        let events = 10;
        for batch in 0..threads / 100 {
            let handles: Vec<_> = (0..100)
                .map(|i| {
                    std::thread::Builder::new()
                        .name(format!("trace-test-many-{}", batch * 100 + i))
                        .spawn(move || {
                            for value in 0..events {
                                counter!("test.many", value);
                            }
                        })
                        .unwrap()
                })
                .collect();
            for handle in handles {
                handle.join().unwrap();
            }
        }
        // Every one of the 2000 threads has exited: their rings (about 128 KiB each) are gone, not merely idle.
        assert!(
            live_threads() <= before + 8,
            "{} rings are still registered after {threads} threads ended",
            live_threads()
        );
        let kept = snapshot()
            .into_iter()
            .filter(|record| record.thread_name.starts_with("trace-test-many-"))
            .count();
        assert!(
            kept > 0,
            "the newest finished threads' events remain visible"
        );
        assert!(
            kept <= ARCHIVE_CAPACITY,
            "{kept} events kept of {} recorded",
            threads * events as usize
        );
    }

    #[test]
    fn the_snapshot_is_ordered_by_time() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        init();
        let starts = on_thread(
            "trace-test-order",
            || {
                for _ in 0..20 {
                    mark!("test.order");
                }
            },
            |records| records.iter().map(|r| r.start_ns).collect::<Vec<_>>(),
        );
        assert_eq!(starts.len(), 20);
        assert!(starts.windows(2).all(|pair| pair[0] <= pair[1]));
    }
}
