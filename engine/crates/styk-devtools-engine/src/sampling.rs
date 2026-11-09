//! Worker-only reduction. All time is injected; absent producers stay absent.
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    sync::atomic::{AtomicUsize, Ordering},
};
use styk_trace::{Record, RecordKind};
const SCRATCH_BYTES: usize = styk_trace::MAX_SNAPSHOT_BYTES + 512 * 1024;
static SCRATCH_USED: AtomicUsize = AtomicUsize::new(0);
struct Scratch;
impl Drop for Scratch {
    fn drop(&mut self) {
        SCRATCH_USED.fetch_sub(SCRATCH_BYTES, Ordering::AcqRel);
    }
}
/// Reserve the snapshot and all reduction vectors before obtaining trace records.
pub fn capture(now_ns: u64) -> Result<Sample, String> {
    SCRATCH_USED
        .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            n.checked_add(SCRATCH_BYTES)
                .filter(|v| *v <= 2 * SCRATCH_BYTES)
        })
        .map_err(|_| "sampling scratch busy")?;
    let _scratch = Scratch;
    Ok(reduce(&styk_trace::snapshot(), now_ns))
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Timing {
    pub count: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub maximum_ms: f64,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sample {
    pub at_ns: u64,
    pub frames_ms: Vec<f64>,
    pub frame: Option<Timing>,
    pub interface: Option<Timing>,
    pub builder: Option<Timing>,
    pub painter: Option<Timing>,
    pub interface_stalls: usize,
    pub dropped: u64,
    pub truncated: bool,
}
fn timing(mut samples: Vec<f64>) -> Option<Timing> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(f64::total_cmp);
    let n = samples.len();
    Some(Timing {
        count: n,
        p50_ms: samples[(n - 1) / 2],
        p95_ms: samples[(n * 95).div_ceil(100) - 1],
        maximum_ms: samples[n - 1],
    })
}
pub fn reduce(records: &[Record], now_ns: u64) -> Sample {
    let mut out = Sample {
        at_ns: now_ns,
        dropped: styk_trace::dropped(),
        ..Sample::default()
    };
    let mut ui = Vec::new();
    let mut builder = Vec::new();
    let mut painter = Vec::new();
    let mut present = BinaryHeap::with_capacity(4096);
    for r in records {
        if r.start_ns > now_ns || now_ns - r.start_ns > 10_000_000_000 {
            continue;
        }
        if r.name == "stage.present" && matches!(r.kind, RecordKind::Mark) {
            if present.len() < 4096 {
                present.push(Reverse(r.start_ns));
            } else {
                out.truncated = true;
                if let Some(mut oldest) = present.peek_mut() {
                    if r.start_ns > oldest.0 {
                        *oldest = Reverse(r.start_ns);
                    }
                }
            }
        }
        let values = match r.name {
            "ui.dispatch" => &mut ui,
            "frame.prepare" => &mut builder,
            "stage.paint" => &mut painter,
            _ => continue,
        };
        if !matches!(r.kind, RecordKind::Span) {
            continue;
        }
        if values.len() < 4096 {
            values.push(r.duration_ns as f64 / 1e6);
        } else {
            out.truncated = true;
        }
    }
    let mut present = present.into_vec();
    present.sort_unstable_by_key(|time| time.0);
    present.dedup();
    let frames: Vec<_> = present
        .windows(2)
        .map(|w| (w[1].0 - w[0].0) as f64 / 1e6)
        .collect();
    out.frames_ms = frames.iter().rev().take(240).copied().collect();
    out.frames_ms.reverse();
    out.frame = timing(frames);
    out.interface_stalls = ui.iter().filter(|v| **v >= 50.).count();
    out.interface = timing(ui);
    out.builder = timing(builder);
    out.painter = timing(painter);
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_window_and_missing_producers() {
        let records: Vec<_> = (0..5000)
            .map(|n| Record {
                thread_name: "ui".into(),
                thread: 1,
                sequence: n,
                name: "stage.present",
                kind: RecordKind::Mark,
                start_ns: n * 1_000_000,
                duration_ns: 0,
            })
            .collect();
        let s = reduce(&records, 5_000_000_000);
        assert_eq!(s.frames_ms.len(), 240);
        assert!(s.truncated);
        assert!(s.interface.is_none());
        assert_eq!(s.frame.unwrap().p95_ms, 1.);
        assert!(reduce(&records, 20_000_000_000).frame.is_none());
    }
    #[test]
    fn newest_frames_survive_saturation_and_unordered_threads() {
        let mut records: Vec<_> = (0..5000)
            .map(|n| Record {
                thread_name: "ui".into(),
                thread: 1,
                sequence: n,
                name: "stage.present",
                kind: RecordKind::Mark,
                start_ns: n * 1_000_000,
                duration_ns: 0,
            })
            .collect();
        records[4999].start_ns += 20_000_000;
        for reverse in [false, true] {
            if reverse {
                records.reverse();
            }
            let sample = reduce(&records, 6_000_000_000);
            assert!(sample.truncated);
            assert_eq!(sample.frames_ms.len(), 240);
            assert_eq!(sample.frames_ms.last(), Some(&21.));
        }
    }
}
