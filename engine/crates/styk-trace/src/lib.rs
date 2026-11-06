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
//! This crate depends on nothing and must stay that way: the engine crates instrument themselves with it, so it can
//! never depend on them, on the core or on a toolkit.

#[cfg(feature = "enabled")]
mod ring;

#[cfg(feature = "enabled")]
pub use ring::{Record, RecordKind, Site, Span, capacity, now_ns, snapshot};

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
        let _ = $name;
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
        let _ = $name;
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
        let _ = $name;
    }};
}

#[cfg(all(test, not(feature = "enabled")))]
mod tests_off {
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
mod tests_on {
    use super::*;

    fn on_thread<T: Send + 'static>(name: &str, work: impl FnOnce() + Send + 'static, pick: impl FnOnce(Vec<Record>) -> T + Send + 'static) -> T {
        let thread = name.to_string();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                work();
                pick(snapshot().into_iter().filter(|record| record.thread_name == thread).collect())
            })
            .unwrap()
            .join()
            .unwrap()
    }

    #[test]
    fn spans_counters_and_marks_are_recorded_on_their_thread() {
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
        assert_eq!(kinds, [("test.span", RecordKind::Span), ("test.counter", RecordKind::Counter(7)), ("test.mark", RecordKind::Mark)]);
        let span = &records[0];
        let mark = &records[2];
        assert!(span.start_ns <= mark.start_ns, "the span began before the mark inside it");
        assert!(span.start_ns + span.duration_ns >= mark.start_ns, "and ended after it");
    }

    #[test]
    fn the_ring_keeps_only_the_most_recent_events() {
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
        assert!(values.windows(2).all(|pair| pair[1] == pair[0] + 1), "the newest events, in order");
    }

    #[test]
    fn a_thread_that_ended_stays_visible_and_threads_do_not_mix() {
        let one = std::thread::Builder::new().name("trace-test-one".into()).spawn(|| mark!("test.one")).unwrap();
        let two = std::thread::Builder::new().name("trace-test-two".into()).spawn(|| mark!("test.two")).unwrap();
        one.join().unwrap();
        two.join().unwrap();
        let records = snapshot();
        let of = |thread: &str| records.iter().filter(|r| r.thread_name == thread).map(|r| r.name).collect::<Vec<_>>();
        assert_eq!(of("trace-test-one"), ["test.one"]);
        assert_eq!(of("trace-test-two"), ["test.two"]);
    }

    #[test]
    fn the_snapshot_is_ordered_by_time() {
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
