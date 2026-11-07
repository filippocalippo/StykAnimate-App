//! What a pen-lab self-test measured, from the recorded samples, frames and push times.
//!
//! Everything here is arithmetic over recorded rows, so it is tested with made-up rows; the lab only feeds it.

use std::collections::HashSet;
use std::fmt::Write;
use styk_core::services::input::{PenButtons, Phase, SampleFlags, Script, Tool};
use styk_core::drawing::pad::{FrameRow, SampleRow};

/// Percentiles of a set of durations.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Percentiles {
    pub count: usize,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

impl Percentiles {
    pub fn of(mut values: Vec<f64>) -> Percentiles {
        if values.is_empty() {
            return Percentiles::default();
        }
        values.sort_by(|a, b| a.total_cmp(b));
        let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize];
        Percentiles { count: values.len(), p50: at(0.50), p95: at(0.95), p99: at(0.99), max: values[values.len() - 1] }
    }
}

/// The measured run.
#[derive(Clone, Debug, Default)]
pub struct Report {
    /// Samples the script pushed.
    pub injected: usize,
    pub delivered: usize,
    /// Samples in contact (press, drag, lift): the script's and the delivered.
    pub injected_contact: usize,
    pub delivered_contact: usize,
    /// Samples identical to an earlier one in pointer, time, position, pressure and phase: a re-delivery.
    pub duplicates: usize,
    /// Samples sharing a timestamp with an earlier, different one.
    pub same_stamp: usize,
    pub history_samples: usize,
    pub monotonic: bool,
    pub median_gap_ms: f64,
    pub aligned: bool,
    pub tool_mismatches: usize,
    pub barrel_mismatches: usize,
    pub phase_mismatches: usize,
    /// The largest tilt error in degrees, pressure error in 1/1024 and position error in pixels.
    pub max_tilt_error: f64,
    pub max_pressure_error: f64,
    pub max_position_error: f64,
    /// The push of the sample to the end of the `prepare` of the first frame showing it, milliseconds.
    pub preview_ms: Percentiles,
    pub exact_ms: Percentiles,
    /// The push to the sample's being read from the queue.
    pub delivery_ms: Percentiles,
    pub frame_period_ms: f64,
    pub frames: usize,
    pub frame_gaps_over_2x: usize,
}

/// `offset` is where the script's origin sits in the client area (the pad's top-left), physical pixels.
pub fn analyse(script: &Script, injected_ns: &[u64], samples: &[SampleRow], frames: &[FrameRow], offset: (f64, f64)) -> Report {
    // Only the pen's samples: a real mouse used meanwhile has its own pointer and clock.
    let pen: Vec<SampleRow> = samples.iter().filter(|row| matches!(row.sample.tool, Tool::Pen | Tool::Eraser)).copied().collect();
    let samples = &pen[..];
    let mut report = Report { injected: script.steps.len(), delivered: samples.len(), frames: frames.len(), ..Report::default() };
    let times: Vec<u64> = samples.iter().map(|s| s.sample.time_ns).collect();
    report.monotonic = times.windows(2).all(|pair| pair[1] >= pair[0]);
    let mut seen = HashSet::new();
    report.duplicates = samples.iter().filter(|s| !seen.insert((s.sample.pointer, s.sample.time_ns, s.sample.x.to_bits(), s.sample.y.to_bits(), s.sample.raw_pressure, s.sample.phase as u8))).count();
    let mut stamps = HashSet::new();
    report.same_stamp = samples.iter().filter(|s| !stamps.insert((s.sample.pointer, s.sample.time_ns))).count();
    report.history_samples = samples.iter().filter(|s| s.sample.flags.contains(SampleFlags::HISTORY)).count();
    let mut gaps: Vec<f64> = times.windows(2).filter(|p| p[1] > p[0]).map(|p| (p[1] - p[0]) as f64 / 1e6).collect();
    gaps.sort_by(|a, b| a.total_cmp(b));
    report.median_gap_ms = gaps.get(gaps.len() / 2).copied().unwrap_or(0.0);

    // The fields are compared on the contact runs (a press to its lift): hover reports are partly the system's own (it
    // reports a pen entering or leaving range itself), so only the contact samples pair one to one with the script.
    let contact = |phase: Phase| matches!(phase, Phase::Down | Phase::Move | Phase::Up);
    let pairs: Vec<(usize, usize)> = {
        let steps = script.steps.iter().enumerate().filter(|(_, s)| contact(s.phase)).map(|(i, _)| i);
        let delivered = samples.iter().enumerate().filter(|(_, s)| contact(s.sample.phase)).map(|(j, _)| j);
        steps.zip(delivered).collect()
    };
    let contact_steps = script.steps.iter().filter(|s| contact(s.phase)).count();
    let contact_samples = samples.iter().filter(|s| contact(s.sample.phase)).count();
    report.injected_contact = contact_steps;
    report.delivered_contact = contact_samples;
    report.aligned = contact_steps == contact_samples && report.duplicates == 0;
    if report.aligned {
        for &(k, j) in &pairs {
            let (step, s) = (&script.steps[k], &samples[j].sample);
            if s.tool != step.tool {
                report.tool_mismatches += 1;
            }
            if s.buttons.contains(PenButtons::BARREL) != step.barrel {
                report.barrel_mismatches += 1;
            }
            if s.phase != step.phase {
                report.phase_mismatches += 1;
            }
            report.max_tilt_error = report.max_tilt_error.max((s.tilt_x as f64 - step.tilt_x as f64).abs()).max((s.tilt_y as f64 - step.tilt_y as f64).abs());
            report.max_pressure_error = report.max_pressure_error.max((s.raw_pressure as f64 - step.raw_pressure as f64).abs());
            let (ex, ey) = (step.x + offset.0, step.y + offset.1);
            report.max_position_error = report.max_position_error.max(((s.x - ex).powi(2) + (s.y - ey).powi(2)).sqrt());
        }
    }

    // The frame period: the median gap between the starts of consecutive frames.
    let mut periods: Vec<f64> = frames.windows(2).map(|p| (p[1].prepare_start_ns.saturating_sub(p[0].prepare_start_ns)) as f64 / 1e6).filter(|p| *p > 0.0).collect();
    periods.sort_by(|a, b| a.total_cmp(b));
    report.frame_period_ms = periods.get(periods.len() / 2).copied().unwrap_or(0.0);
    report.frame_gaps_over_2x = periods.iter().filter(|p| **p > report.frame_period_ms * 2.0).count();

    if report.aligned && injected_ns.len() == script.steps.len() {
        let (mut preview, mut exact, mut delivery) = (Vec::new(), Vec::new(), Vec::new());
        // Later samples are never shown before earlier ones, so each scan only moves forward.
        let (mut wet_at, mut exact_at) = (0usize, 0usize);
        for &(k, j) in &pairs {
            let (step, row) = (&script.steps[k], &samples[j]);
            delivery.push(row.received_ns.saturating_sub(injected_ns[k]) as f64 / 1e6);
            if step.phase == Phase::Up {
                continue;
            }
            // The device times are the system's and the injection times the injector's: a few microseconds apart.
            let needed = row.sample.time_ns.saturating_sub(50_000);
            if step.tool == Tool::Pen {
                while wet_at < frames.len() && !(frames[wet_at].newest_wet_ns >= needed && frames[wet_at].prepare_end_ns >= injected_ns[k]) {
                    wet_at += 1;
                }
                if let Some(frame) = frames.get(wet_at) {
                    preview.push((frame.prepare_end_ns - injected_ns[k]) as f64 / 1e6);
                }
            }
            while exact_at < frames.len() && !(frames[exact_at].newest_exact_ns >= needed && frames[exact_at].prepare_end_ns >= injected_ns[k]) {
                exact_at += 1;
            }
            if let Some(frame) = frames.get(exact_at) {
                exact.push((frame.prepare_end_ns - injected_ns[k]) as f64 / 1e6);
            }
        }
        report.preview_ms = Percentiles::of(preview);
        report.exact_ms = Percentiles::of(exact);
        report.delivery_ms = Percentiles::of(delivery);
    }
    report
}

fn row(out: &mut String, name: &str, p: &Percentiles, period_ms: f64) {
    let frames = |ms: f64| if period_ms > 0.0 { format!("{:.2}", ms / period_ms) } else { "-".into() };
    let _ = writeln!(
        out,
        "{name:<28} n={:<5} p50 {:>7.2} ms ({} fr)  p95 {:>7.2} ms ({} fr)  p99 {:>7.2} ms ({} fr)  max {:>7.2} ms ({} fr)",
        p.count,
        p.p50,
        frames(p.p50),
        p.p95,
        frames(p.p95),
        p.p99,
        frames(p.p99),
        p.max,
        frames(p.max)
    );
}

impl Report {
    /// The report as text, with the conditions it was measured under.
    pub fn text(&self, refresh_hz: f64, present_mode: &str, slices_us: (u64, u64)) -> String {
        let mut out = String::new();
        let _ = writeln!(out, "display {refresh_hz:.0} Hz, present mode {present_mode}, measured frame period {:.2} ms, frames {}, frame gaps over 2x {}", self.frame_period_ms, self.frames, self.frame_gaps_over_2x);
        let _ = writeln!(out, "injected {} delivered {} (in contact: {} of {}) re-delivered {} same-timestamp {} history-recovered {} monotonic {} median gap {:.3} ms", self.injected, self.delivered, self.delivered_contact, self.injected_contact, self.duplicates, self.same_stamp, self.history_samples, self.monotonic, self.median_gap_ms);
        if self.aligned {
            let _ = writeln!(
                out,
                "fields: tool mismatches {} barrel mismatches {} phase mismatches {} max tilt error {:.1} deg max pressure error {:.1}/1024 max position error {:.2} px",
                self.tool_mismatches, self.barrel_mismatches, self.phase_mismatches, self.max_tilt_error, self.max_pressure_error, self.max_position_error
            );
        } else {
            let _ = writeln!(out, "fields: not compared (contact runs differ in length, or re-delivered samples)");
        }
        let period = if self.frame_period_ms > 0.0 { self.frame_period_ms } else { 1000.0 / refresh_hz.max(1.0) };
        row(&mut out, "push -> queue read", &self.delivery_ms, period);
        row(&mut out, "push -> preview frame", &self.preview_ms, period);
        row(&mut out, "push -> exact tiles frame", &self.exact_ms, period);
        let _ = writeln!(out, "interface-thread slices: update max {} us, prepare max {} us", slices_us.0, slices_us.1);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_core::services::input::ScriptSpec;

    fn script() -> Script {
        Script::generate(&ScriptSpec::standard(240.0, 1.0, 400.0, 300.0), 1)
    }

    fn rows(script: &Script, base: u64, offset: (f64, f64)) -> Vec<SampleRow> {
        script
            .steps
            .iter()
            .map(|step| {
                let mut sample = step.sample(1, base);
                sample.x = step.x + offset.0;
                sample.y = step.y + offset.1;
                SampleRow { sample, received_ns: base + step.t_ns + 300_000 }
            })
            .collect()
    }

    #[test]
    fn percentiles_pick_the_ranked_values() {
        let p = Percentiles::of((1..=100).map(|v| v as f64).collect());
        assert_eq!((p.count, p.p50, p.p99, p.max), (100, 51.0, 99.0, 100.0));
        assert_eq!(Percentiles::of(Vec::new()), Percentiles::default());
    }

    #[test]
    fn a_faithful_delivery_reports_no_mismatch_and_the_expected_rate() {
        let script = script();
        let injected: Vec<u64> = script.steps.iter().map(|s| 10_000 + s.t_ns).collect();
        let report = analyse(&script, &injected, &rows(&script, 10_000, (5.0, 7.0)), &[], (5.0, 7.0));
        assert!(report.aligned && report.monotonic);
        assert_eq!((report.tool_mismatches, report.barrel_mismatches, report.phase_mismatches, report.duplicates), (0, 0, 0, 0));
        assert_eq!((report.max_tilt_error, report.max_pressure_error, report.max_position_error), (0.0, 0.0, 0.0));
        assert!((report.median_gap_ms - 4.1667).abs() < 0.01, "{}", report.median_gap_ms);
        assert!((report.delivery_ms.p50 - 0.3).abs() < 1e-9);
    }

    #[test]
    fn a_wrong_tool_barrel_or_tilt_is_counted_and_a_missing_sample_stops_the_comparison() {
        let script = script();
        let injected: Vec<u64> = script.steps.iter().map(|s| s.t_ns).collect();
        let mut delivered = rows(&script, 0, (0.0, 0.0));
        delivered[100].sample.tool = Tool::Eraser;
        delivered[30].sample.buttons = delivered[30].sample.buttons | PenButtons::BARREL;
        delivered[50].sample.tilt_x += 3.0;
        let report = analyse(&script, &injected, &delivered, &[], (0.0, 0.0));
        assert_eq!((report.tool_mismatches, report.barrel_mismatches), (1, 1));
        assert_eq!(report.max_tilt_error, 3.0);
        delivered.pop();
        assert!(!analyse(&script, &injected, &delivered, &[], (0.0, 0.0)).aligned);
    }

    #[test]
    fn latency_is_injection_to_the_end_of_the_first_frame_that_shows_the_sample() {
        let script = script();
        let injected: Vec<u64> = script.steps.iter().map(|s| 1_000_000 + s.t_ns).collect();
        let delivered = rows(&script, 1_000_000, (0.0, 0.0));
        // A frame every 6.94 ms; each shows the newest sample received before the frame started.
        let mut frames = Vec::new();
        let mut t = 1_000_000u64;
        for n in 0..200u64 {
            t += 6_944_444;
            let newest = delivered.iter().filter(|r| r.received_ns < t).map(|r| r.sample.time_ns).max().unwrap_or(0);
            frames.push(FrameRow { frame: n, prepare_start_ns: t, prepare_end_ns: t + 400_000, newest_wet_ns: newest, newest_exact_ns: newest.saturating_sub(5_000_000), ..FrameRow::default() });
        }
        let report = analyse(&script, &injected, &delivered, &frames, (0.0, 0.0));
        assert!((report.frame_period_ms - 6.944).abs() < 0.01);
        assert!(report.preview_ms.count > 0 && report.exact_ms.count > 0);
        assert!(report.preview_ms.p50 > 0.0 && report.preview_ms.p50 < 8.0, "{:?}", report.preview_ms);
        assert!(report.exact_ms.p50 > report.preview_ms.p50, "exact pixels trail the preview");
        assert!(report.text(144.0, "Fifo", (10, 20)).contains("display 144 Hz, present mode Fifo"));
    }
}
