#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types))]
//! The developer tools.
//!
//! Compiled only into the app's `devtools` build, which has the same optimisation as release but records the
//! instrumentation of `styk-trace`. The first tool is the plainest: [`trace_report`] turns the recent spans, counters
//! and marks of every thread into text. The profiler, the performance overlay, the logs view, live parameters and the
//! control channel come in their own chunks (`docs/native/devtools.md`).
//!
//! It may depend on the core, the interface, the design system and `styk-trace`; nothing else may depend on it.

pub mod pen_lab;

use styk_trace::{RecordKind, snapshot};

/// The recent events of every thread, one per line: when, which thread, what and (for spans) how long.
pub fn trace_report() -> String {
    format_records(&snapshot())
}

fn format_records(records: &[styk_trace::Record]) -> String {
    let mut out = String::new();
    for record in records {
        let when = record.start_ns as f64 / 1e6;
        let what = match record.kind {
            RecordKind::Span => format!("span {:.3} ms", record.duration_ns as f64 / 1e6),
            RecordKind::Counter(value) => format!("counter {value}"),
            RecordKind::Mark => "mark".to_string(),
        };
        out.push_str(&format!("{when:>10.3} ms  {:<16} {:<24} {what}\n", record.thread_name, record.name));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_trace::{counter, mark, span};

    #[test]
    fn the_report_names_each_event_on_its_thread() {
        let report = std::thread::Builder::new()
            .name("report-test".into())
            .spawn(|| {
                {
                    let _span = span!("report.span");
                    counter!("report.counter", 3);
                }
                mark!("report.mark");
                trace_report()
            })
            .unwrap()
            .join()
            .unwrap();
        let lines: Vec<&str> = report.lines().filter(|line| line.contains("report-test")).collect();
        assert_eq!(lines.len(), 3, "{report}");
        assert!(lines.iter().any(|line| line.contains("report.span") && line.contains("span ") && line.ends_with(" ms")));
        assert!(lines.iter().any(|line| line.contains("report.counter") && line.ends_with("counter 3")));
        assert!(lines.iter().any(|line| line.contains("report.mark") && line.ends_with("mark")));
    }
}
