//! The pen lab's self-test: a scripted synthetic pen (or scripted queue input) through the whole path, and what it proved.

use super::report::{self, Report};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use styk_platform::windows::inject::PenInjector;
use styk_platform::windows::input::InputCounters;
use styk_services::input::{InputEvent, Phase, Script, ScriptSpec, ScriptStep, Tool};
use styk_ui::ink_pad::{PadCore, Switches, View};

/// Frames to let the window settle before the script starts.
const WARMUP_FRAMES: u32 = 60;
/// Frames to wait after the script for the last tiles to land.
const SETTLE_FRAMES: u32 = 90;
/// The forced interface-thread block of the history test, and how many there are.
const BLOCK_MS: u64 = 50;
const BLOCKS: u32 = 20;
/// How many times a refused injection starts the script again.
const MAX_RETRIES: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestKind {
    /// 240 Hz for the given seconds: fields, rate, latency, slices.
    Standard,
    /// The same, with the interface thread blocked for 50 ms twenty times: the history must recover every sample.
    Blocked,
    /// Hover over a toolkit widget, the barrel button, a 1.5 s stationary press.
    Behaviour,
    /// Worst inputs on the worker: a huge gap with a fine brush, deep zoom, a mirrored stroke.
    Stress,
}

#[derive(Clone, Debug)]
pub struct SelfTest {
    pub kind: TestKind,
    pub seconds: f64,
    pub rate_hz: f64,
}

impl SelfTest {
    /// Reads `kind[:seconds]`: `standard`, `blocked`, `behaviour` or `stress`, 240 Hz, five seconds unless said.
    pub fn parse(text: &str) -> Result<SelfTest, String> {
        let (kind, seconds) = text.split_once(':').map_or((text, None), |(k, s)| (k, Some(s)));
        let kind = match kind {
            "standard" => TestKind::Standard,
            "blocked" => TestKind::Blocked,
            "behaviour" => TestKind::Behaviour,
            "stress" => TestKind::Stress,
            other => return Err(format!("unknown self-test {other:?}: standard, blocked, behaviour or stress")),
        };
        let seconds = match seconds {
            None => 5.0,
            Some(s) => s.parse::<f64>().ok().filter(|s| *s > 0.0 && s.is_finite()).ok_or_else(|| format!("self-test seconds want a positive number, not {s:?}"))?,
        };
        Ok(SelfTest { kind, seconds, rate_hz: 240.0 })
    }
}

pub struct Context<'a> {
    pub core: &'a Arc<PadCore>,
    pub counters: Option<&'a Arc<InputCounters>>,
    pub refresh_hz: f64,
    pub out_dir: Option<&'a Path>,
    pub hover_enters: u64,
    pub client_origin: (i32, i32),
}

pub enum Step {
    Continue,
    Capture(PathBuf),
    Done(i32),
}

type Injection = Result<Vec<u64>, String>;

enum Phase_ {
    Warmup(u32),
    Injecting { thread: JoinHandle<Injection>, script: Script, blocks_done: u32, frames: u32 },
    Settling { script: Script, injected: Injection, frames: u32 },
    /// Waiting for the worker to finish the stress strokes.
    Stress { frames: u32 },
    Capturing,
    Done(i32),
}

pub struct Runner {
    test: SelfTest,
    phase: Phase_,
    result: Arc<Mutex<Option<Injection>>>,
    summary: String,
    failures: u32,
    behaviour: Option<Behaviour>,
    /// Times the system refused an injection and the script was started over.
    attempts: u32,
}

/// The behaviour test's three scripts run one after another; their results are read between them.
struct Behaviour {
    step: u32,
    hover_before: u64,
    palette_before: u64,
    menus_before: u64,
    strokes_before: u64,
}

impl Runner {
    pub fn new(test: SelfTest) -> Runner {
        Runner { test, phase: Phase_::Warmup(0), result: Arc::new(Mutex::new(None)), summary: String::new(), failures: 0, behaviour: None, attempts: 0 }
    }

    pub fn captured(&mut self) {
        if matches!(self.phase, Phase_::Capturing) {
            self.phase = Phase_::Done(i32::from(self.failures > 0));
        }
    }

    fn check(&mut self, name: &str, pass: bool, detail: impl std::fmt::Display) {
        if !pass {
            self.failures += 1;
        }
        let _ = writeln!(self.summary, "{} {name}: {detail}", if pass { "PASS" } else { "FAIL" });
    }

    fn spawn_injection(&self, script: Script, origin: (i32, i32)) -> JoinHandle<Injection> {
        let result = self.result.clone();
        std::thread::Builder::new()
            .name("styk-pen-inject".into())
            .spawn(move || {
                let outcome: Injection = (|| {
                    let mut injector = PenInjector::new(script.pointer).map_err(|e| e.to_string())?;
                    injector.play(&script, origin, |_| {}).map_err(|e| e.to_string())
                })();
                *result.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome.clone());
                outcome
            })
            .expect("the injection thread starts")
    }

    pub fn step(&mut self, cx: &Context) -> Step {
        match &mut self.phase {
            Phase_::Warmup(frames) => {
                *frames += 1;
                let pad = cx.core.gpu_stats().pad_px;
                if *frames < WARMUP_FRAMES || pad.0 <= 0.0 || cx.counters.is_none() {
                    if *frames > WARMUP_FRAMES * 20 {
                        let _ = writeln!(self.summary, "FAIL setup: the window never drew a pad or the input source never attached");
                        self.failures += 1;
                        self.phase = Phase_::Done(2);
                    }
                    return Step::Continue;
                }
                match self.test.kind {
                    TestKind::Stress => return self.stress(cx),
                    TestKind::Behaviour => return self.behaviour_step(cx),
                    _ => {}
                }
                let mut script = Script::generate(&ScriptSpec::standard(self.test.rate_hz, self.test.seconds, pad.0 as f64, pad.1 as f64), 1);
                // A synthetic pen has no eraser end (see `inject`): the second stroke is injected with the tip.
                for step in &mut script.steps {
                    step.tool = Tool::Pen;
                }
                cx.core.with_inspector(|inspector| {
                    inspector.update_max_us = 0;
                    inspector.max_generate_ms = 0.0;
                    inspector.max_raster_ms = 0.0;
                });
                cx.core.with_gpu(|gpu| gpu.prepare_max_us = 0);
                cx.core.set_recording(true);
                let thread = self.spawn_injection(script.clone(), cx.client_origin);
                self.phase = Phase_::Injecting { thread, script, blocks_done: 0, frames: 0 };
                Step::Continue
            }
            Phase_::Injecting { thread, blocks_done, frames, .. } => {
                *frames += 1;
                if self.test.kind == TestKind::Blocked {
                    // Spread the blocks over the script, none before it starts or after it ends.
                    let every = ((self.test.seconds * cx.refresh_hz.max(60.0)) / (BLOCKS as f64 + 1.0)).max(1.0) as u32;
                    if *blocks_done < BLOCKS && *frames % every == 0 {
                        std::thread::sleep(std::time::Duration::from_millis(BLOCK_MS));
                        *blocks_done += 1;
                    }
                }
                if !thread.is_finished() {
                    return Step::Continue;
                }
                let injected = match std::mem::replace(&mut self.phase, Phase_::Capturing) {
                    Phase_::Injecting { thread, script, .. } => (thread.join().unwrap_or_else(|_| Err("the injection thread panicked".into())), script),
                    _ => unreachable!("the phase was Injecting"),
                };
                self.phase = Phase_::Settling { script: injected.1, injected: injected.0, frames: 0 };
                Step::Continue
            }
            Phase_::Settling { frames, .. } => {
                *frames += 1;
                if *frames < SETTLE_FRAMES {
                    return Step::Continue;
                }
                let Phase_::Settling { script, injected, .. } = std::mem::replace(&mut self.phase, Phase_::Capturing) else { unreachable!("the phase was Settling") };
                if self.test.kind == TestKind::Behaviour {
                    // The next script of the behaviour test, or its verdicts.
                    match injected {
                        Err(error) if self.attempts >= MAX_RETRIES => {
                            self.check("injection", false, error);
                            self.phase = Phase_::Done(3);
                        }
                        Err(error) => {
                            self.attempts += 1;
                            let _ = writeln!(self.summary, "injection refused ({error}); starting the step again ({} of {MAX_RETRIES})", self.attempts);
                            if let Some(state) = self.behaviour.as_mut() {
                                state.step = state.step.saturating_sub(1);
                            }
                            self.phase = Phase_::Warmup(WARMUP_FRAMES);
                        }
                        Ok(_) => self.phase = Phase_::Warmup(WARMUP_FRAMES),
                    }
                    return Step::Continue;
                }
                self.finish_scripted(cx, &script, injected)
            }
            Phase_::Stress { frames } => {
                let frames = *frames;
                self.stress_wait(cx, frames)
            }
            Phase_::Capturing => Step::Continue,
            Phase_::Done(code) => {
                let code = *code;
                if let Some(dir) = cx.out_dir {
                    let _ = std::fs::write(dir.join("report.txt"), &self.summary);
                }
                print!("{}", self.summary);
                Step::Done(code)
            }
        }
    }

    fn finish_scripted(&mut self, cx: &Context, script: &Script, injected: Injection) -> Step {
        cx.core.set_recording(false);
        let (samples, frames) = cx.core.take_recording();
        let inspector = cx.core.inspector();
        let gpu = cx.core.gpu_stats();
        let present = std::env::var("ICED_PRESENT_MODE").unwrap_or_else(|_| "Fifo (iced AutoVsync)".into());
        let injected_ns = match injected {
            Ok(times) => times,
            Err(error) if self.attempts < MAX_RETRIES => {
                // The system sometimes refuses a report of a script (error 87) for a reason it does not give; the script starts over.
                self.attempts += 1;
                let _ = writeln!(self.summary, "injection refused ({error}); starting the script again ({} of {MAX_RETRIES})", self.attempts);
                self.phase = Phase_::Warmup(WARMUP_FRAMES);
                return Step::Continue;
            }
            Err(error) => {
                self.check("injection", false, error);
                self.phase = Phase_::Done(3);
                return Step::Continue;
            }
        };
        let report = report::analyse(script, &injected_ns, &samples, &frames, (0.0, 0.0));
        self.summary.push_str(&report.text(cx.refresh_hz, &present, (inspector.update_max_us, gpu.prepare_max_us)));
        self.judge(cx, &report, script);
        if let Some(dir) = cx.out_dir {
            write_csvs(dir, &samples, &frames, &injected_ns);
        }
        match cx.out_dir {
            Some(dir) => {
                self.phase = Phase_::Capturing;
                Step::Capture(dir.join("screenshot.png"))
            }
            None => {
                self.phase = Phase_::Done(i32::from(self.failures > 0));
                Step::Continue
            }
        }
    }

    fn judge(&mut self, cx: &Context, report: &Report, script: &Script) {
        let expected = script.steps.len() as f64;
        let counters = cx.counters.expect("the source is attached");
        let inspector = cx.core.inspector();
        self.check("A2 count", (report.delivered as f64 - expected).abs() <= 2.0, format!("{} delivered of {} injected", report.delivered, report.injected));
        self.check("A2 no duplicates", report.duplicates == 0, report.duplicates);
        self.check("A2 monotonic", report.monotonic, report.monotonic);
        if self.test.kind == TestKind::Standard {
            self.check("A2 median gap 4.17 +/- 0.3 ms", (report.median_gap_ms - 1000.0 / self.test.rate_hz).abs() <= 0.3, format!("{:.3} ms", report.median_gap_ms));
        } else {
            self.check("A2 history recovered samples", report.history_samples > 0, format!("{} flagged", report.history_samples));
        }
        self.check("A1 fields compared", report.aligned, report.aligned);
        if report.aligned {
            self.check("A1 tool, barrel, phase", report.tool_mismatches + report.barrel_mismatches + report.phase_mismatches == 0, format!("{}/{}/{} mismatches", report.tool_mismatches, report.barrel_mismatches, report.phase_mismatches));
            self.check("A1 tilt within 1 deg", report.max_tilt_error <= 1.0, format!("max {:.1}", report.max_tilt_error));
            self.check("A1 pressure within 1/1024", report.max_pressure_error <= 1.0, format!("max {:.1}/1024", report.max_pressure_error));
            self.check("A3 position within 0.5 px", report.max_position_error <= 0.5, format!("max {:.2} px", report.max_position_error));
        }
        self.check("A7 no mouse stroke from a pen", inspector.mouse_contact_samples == 0, format!("{} mouse strokes ({} hover samples from the system), {} promoted mouse messages ignored", inspector.mouse_contact_samples, inspector.mouse_samples, counters.promoted_mouse_messages.load(Relaxed)));
        self.check("A7 promotion reaches the toolkit", counters.promoted_mouse_messages.load(Relaxed) > 0, counters.promoted_mouse_messages.load(Relaxed));
        self.check("A5 update slice under 4 ms", inspector.update_max_us < 4000 || self.test.kind == TestKind::Blocked, format!("{} us", inspector.update_max_us));
        self.check("A5 prepare slice under 4 ms", cx.core.gpu_stats().prepare_max_us < 4000, format!("{} us", cx.core.gpu_stats().prepare_max_us));
    }

    fn behaviour_step(&mut self, cx: &Context) -> Step {
        let pad = cx.core.gpu_stats().pad_px;
        let counters = cx.counters.expect("the source is attached");
        let inspector = cx.core.inspector();
        let state = self.behaviour.get_or_insert(Behaviour { step: 0, hover_before: cx.hover_enters, palette_before: inspector.palette_opens, menus_before: counters.context_menus.load(Relaxed), strokes_before: inspector.strokes });
        // The script of the current step, or the verdict of the previous one once its injection has finished.
        if matches!(self.phase, Phase_::Injecting { .. }) {
            return Step::Continue;
        }
        let at = |t: u64, x: f64, y: f64, phase: Phase, barrel: bool, pressure: u32| ScriptStep { t_ns: t, x, y, tool: Tool::Pen, phase, raw_pressure: pressure, tilt_x: 0, tilt_y: 0, barrel, modifiers: styk_services::input::Modifiers::NONE };
        let period = 1_000_000_000u64 / self.test.rate_hz as u64;
        let script = match state.step {
            0 => {
                // Hover from the pad over the toolkit's hover box in the panel.
                let steps = (0..60).map(|i| at(i * period, pad.0 as f64 / 2.0 + (i as f64 / 59.0) * (pad.0 as f64 / 2.0 + 100.0), 40.0 + 0.0 * i as f64, Phase::Hover, false, 0)).collect();
                Script { pointer: 1, steps }
            }
            1 => {
                // The barrel button pressed while hovering over the pad.
                let steps = (0..40).map(|i| at(i * period, pad.0 as f64 / 2.0, pad.1 as f64 / 2.0, Phase::Hover, (10..30).contains(&i), 0)).collect();
                Script { pointer: 1, steps }
            }
            2 => {
                // A stationary press for 1.5 seconds.
                let held = (1.5 * self.test.rate_hz) as u64;
                let mut steps = vec![at(0, pad.0 as f64 / 3.0, pad.1 as f64 / 3.0, Phase::Down, false, 600)];
                steps.extend((1..held).map(|i| at(i * period, pad.0 as f64 / 3.0, pad.1 as f64 / 3.0, Phase::Move, false, 600)));
                steps.push(at(held * period, pad.0 as f64 / 3.0, pad.1 as f64 / 3.0, Phase::Up, false, 0));
                Script { pointer: 1, steps }
            }
            _ => {
                let enters = cx.hover_enters - state.hover_before;
                let palette = inspector.palette_opens - state.palette_before;
                let menus = counters.context_menus.load(Relaxed) - state.menus_before;
                let strokes = inspector.strokes - state.strokes_before;
                self.check("A7 pen hover reaches a toolkit widget", enters >= 1, format!("{enters} enter events"));
                self.check("A7 barrel press opens the palette once", palette == 1, format!("{palette} palette actions"));
                self.check("A7 a 1.5 s stationary press raises no menu", menus == 0 && strokes >= 1, format!("{menus} context menus, {strokes} strokes"));
                self.phase = Phase_::Capturing;
                return match cx.out_dir {
                    Some(dir) => Step::Capture(dir.join("screenshot.png")),
                    None => {
                        self.phase = Phase_::Done(i32::from(self.failures > 0));
                        Step::Continue
                    }
                };
            }
        };
        // The verdicts are taken after every injection has been seen by the pad: a few frames after the thread ends.
        state.step += 1;
        let thread = self.spawn_injection(script.clone(), cx.client_origin);
        self.phase = Phase_::Injecting { thread, script, blocks_done: 0, frames: 0 };
        Step::Continue
    }

    /// Worst inputs for the worker: the interface thread must only queue them.
    fn stress(&mut self, cx: &Context) -> Step {
        let core = cx.core;
        let mut brush = core.brush();
        brush.size = 2.0;
        core.set_brush(brush);
        core.set_view(View { zoom: 64.0, pan: (0.0, 0.0) });
        core.set_switches(Switches { mirror_x: true, ..core.switches() });
        let now = core.now_ns();
        let sample = |i: u64, x: f64, y: f64, phase: Phase| {
            let mut s = styk_services::input::PenSample::at(now + i * 4_000_000, 1, Tool::Pen, x, y);
            s.phase = phase;
            s.pressure = 0.8;
            s.raw_pressure = 819;
            s.pressure_max = 1024;
            s.valid = styk_services::input::Valid::PRESSURE;
            s
        };
        let started = std::time::Instant::now();
        // A coordinate gap of 100,000 window pixels at 64x is 1,500 cel pixels; the second gap is the huge one at 1x below.
        for (i, (x, y, phase)) in [(100.0, 100.0, Phase::Down), (900.0, 100.0, Phase::Move), (100.0, 400.0, Phase::Move), (900.0, 400.0, Phase::Up)].into_iter().enumerate() {
            core.queue.push(InputEvent::Sample(sample(i as u64, x, y, phase)));
        }
        let pushed = started.elapsed();
        self.check("A5 queueing the stress input", pushed.as_millis() < 4, format!("{:?}", pushed));
        core.set_view(View { zoom: 1.0, pan: (0.0, 0.0) });
        // One coordinate gap of 200,000 pixels with a 2 pixel brush: some 800,000 dabs from a single sample.
        let huge = |i: u64, x: f64, phase: Phase| sample(10 + i, x, 200.0, phase);
        core.queue.push(InputEvent::Sample(huge(0, 10.0, Phase::Down)));
        core.queue.push(InputEvent::Sample(huge(1, 200_000.0, Phase::Move)));
        core.queue.push(InputEvent::Sample(huge(2, 200_000.0, Phase::Up)));
        core.set_recording(true);
        self.phase = Phase_::Stress { frames: 0 };
        Step::Continue
    }

    fn stress_wait(&mut self, cx: &Context, frames: u32) -> Step {
        let inspector = cx.core.inspector();
        let limit = (cx.refresh_hz.max(60.0) * 60.0) as u32;
        if inspector.finished_strokes < 2 && frames < limit {
            self.phase = Phase_::Stress { frames: frames + 1 };
            return Step::Continue;
        }
        cx.core.set_recording(false);
        let (_, rows) = cx.core.take_recording();
        let gpu = cx.core.gpu_stats();
        let mut periods: Vec<f64> = rows.windows(2).map(|p| (p[1].prepare_start_ns.saturating_sub(p[0].prepare_start_ns)) as f64 / 1e6).collect();
        periods.sort_by(|a, b| a.total_cmp(b));
        let median = periods.get(periods.len() / 2).copied().unwrap_or(0.0);
        let worst = periods.last().copied().unwrap_or(0.0);
        self.check("stress strokes finished", inspector.finished_strokes >= 2, format!("{} finished, {} failed", inspector.finished_strokes, inspector.worker_errors.len()));
        self.check("A5 update slice under 4 ms", inspector.update_max_us < 4000, format!("{} us", inspector.update_max_us));
        self.check("A5 prepare slice under 4 ms", gpu.prepare_max_us < 4000, format!("{} us", gpu.prepare_max_us));
        self.check("A5 no frame skipped while the worker works", worst < median * 2.5 + 2.0, format!("median frame {median:.2} ms, worst {worst:.2} ms over {} frames", rows.len()));
        let _ = writeln!(self.summary, "worker: longest dab generation {:.1} ms, longest raster {:.1} ms (display {:.0} Hz)", inspector.max_generate_ms, inspector.max_raster_ms, cx.refresh_hz);
        self.phase = Phase_::Done(i32::from(self.failures > 0));
        Step::Continue
    }
}

fn write_csvs(dir: &Path, samples: &[styk_ui::ink_pad::SampleRow], frames: &[styk_ui::ink_pad::FrameRow], injected: &[u64]) {
    let mut out = String::from("time_ns,pointer,tool,phase,x,y,pressure,raw_pressure,tilt_x,tilt_y,buttons,flags,modifiers,received_ns\n");
    for r in samples {
        let s = &r.sample;
        let _ = writeln!(out, "{},{},{:?},{:?},{},{},{},{},{},{},{},{},{},{}", s.time_ns, s.pointer, s.tool, s.phase, s.x, s.y, s.pressure, s.raw_pressure, s.tilt_x, s.tilt_y, s.buttons.0, s.flags.0, s.modifiers.0, r.received_ns);
    }
    let _ = std::fs::write(dir.join("samples.csv"), out);
    let mut out = String::from("frame,prepare_start_ns,prepare_end_ns,newest_wet_ns,newest_exact_ns,wet_dabs,tiles_uploaded\n");
    for f in frames {
        let _ = writeln!(out, "{},{},{},{},{},{},{}", f.frame, f.prepare_start_ns, f.prepare_end_ns, f.newest_wet_ns, f.newest_exact_ns, f.wet_dabs, f.tiles_uploaded);
    }
    let _ = std::fs::write(dir.join("frames.csv"), out);
    let mut out = String::from("step,inject_ns\n");
    for (i, t) in injected.iter().enumerate() {
        let _ = writeln!(out, "{i},{t}");
    }
    let _ = std::fs::write(dir.join("inject.csv"), out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_self_test_names_its_kind_and_seconds() {
        let t = SelfTest::parse("blocked:7.5").unwrap();
        assert_eq!((t.kind, t.seconds, t.rate_hz), (TestKind::Blocked, 7.5, 240.0));
        assert_eq!(SelfTest::parse("standard").unwrap().seconds, 5.0);
        assert!(SelfTest::parse("fast").unwrap_err().contains("unknown self-test"));
        assert!(SelfTest::parse("standard:0").unwrap_err().contains("positive"));
    }
}
