// This private module is entered only through Worker::start/submit. Those entry
// points retain interface lints. Narrow exceptions below belong to worker tasks.
// The pen lab's self-test: scripted input through the pad's whole path, fed from an in-process thread.
//
// The feeder pushes samples into the pad's input queue as a platform source would (from a thread, stamped with the clock at
// the moment of the push, at the script's own pace). Nothing is injected into the operating system: no window is placed on
// the screen and no system input is synthesised (decision N6). What this does not exercise is the `WM_POINTER` subclass
// itself: its pure parts have unit tests in `styk-platform`, the rest needs a tablet.

use super::super::report::{self, Report};
use super::{SelfTest, TestKind};
use styk_core::services::Spawner;
use std::sync::mpsc::{self, SyncSender, TryRecvError};
use std::path::Path;
use std::sync::Arc;

use std::time::Duration;
use styk_core::services::input::{InputEvent, Modifiers, PenButtons, PenSample, Phase, Script, ScriptSpec, ScriptStep, Tool, Valid};
use styk_core::drawing::pad::{FrameRow, PadCore, Switches, View};

/// Frames to let the window settle before the script starts.
const WARMUP_FRAMES: u32 = 60;
/// Frames to wait after the script for the last tiles to land.
const SETTLE_FRAMES: u32 = 90;
/// The forced interface-thread block of the blocked test, and how many there are.
const BLOCKS: u32 = 20;

use styk_core::drawing::probe::{Context, Step, Completion};
macro_rules! line { ($out:expr, $($arg:tt)*) => {{ $out.push_str(&format!($($arg)*)); $out.push('\n'); }}; }

struct Request { context: Context, captured: bool, complete: Completion }
pub(super) struct Worker { sender: SyncSender<Request> }
impl Worker {
    pub(super) fn start(test: SelfTest, spawner: Arc<dyn Spawner>) -> Result<Self, String> {
        Self::start_runner(Runner::new(test, spawner.clone()), spawner.as_ref())
    }
    fn start_runner(runner: Runner, spawner: &dyn Spawner) -> Result<Self, String> {
        let (sender, requests) = mpsc::sync_channel::<Request>(1);
        spawner.spawn("styk-pen-probe", Box::new(move || run(runner, requests))).map_err(|error| error.to_string())?;
        Ok(Self { sender })
    }
    pub(super) fn submit(&self, context: Context, captured: bool, complete: Completion) -> Result<(), String> {
        self.sender.try_send(Request { context, captured, complete }).map_err(|error| error.to_string())
    }
}

// Only the injected worker enters this blocking receive loop.
#[allow(clippy::disallowed_methods, clippy::disallowed_types)]
fn run(mut runner: Runner, requests: mpsc::Receiver<Request>) {
    for request in requests {
        if request.captured { runner.captured(); }
        let step = runner.step(&request.context);
        (request.complete)(match runner.error.take() { Some(error) => Err(error), None => Ok(step) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_core::services::{ManualSpawner, SpawnError, Job};

    fn context(out_dir: Option<std::path::PathBuf>) -> Context {
        let clock: Arc<dyn styk_core::services::Clock> = Arc::new(styk_platform::clock::SystemClock::new());
        let host = ManualSpawner::new();
        let drawing = styk_core::drawing::worker::Worker::spawn(Vec::new(), Arc::new(|| {}), clock.clone(), &host).unwrap();
        Context { core: PadCore::new(styk_core::services::input::InputQueue::new(), drawing, clock), counters: None, refresh_hz: 60.0, out_dir }
    }

    #[test]
    fn behaviour_pause_runs_only_on_the_injected_worker_and_submit_never_waits() {
        let host = Arc::new(ManualSpawner::new());
        let mut runner = Runner::new(SelfTest::parse("behaviour").unwrap(), host.clone());
        runner.phase = Phase_::Behaviour { thread: None, frames: 4 };
        runner.step = 2; // The real 800 ms finger-after-pen wait.
        let worker = Worker::start_runner(runner, host.as_ref()).unwrap();
        let (sender, receiver) = mpsc::channel();
        let caller = std::thread::current().id();
        worker.submit(context(None), false, Box::new(move |result| sender.send((std::thread::current().id(), result)).unwrap())).unwrap();
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(host.names(), ["styk-pen-probe"]);
        drop(worker); // Closing never joins; the queued request still has a terminal reply.
        let job = std::thread::spawn(move || host.run_next());
        let (thread, result) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(thread, caller);
        assert!(matches!(result, Ok(Step::Continue)));
        assert!(job.join().unwrap());
    }

    #[test]
    fn report_and_csv_write_failures_are_reported() {
        let host = Arc::new(ManualSpawner::new());
        let path = std::env::temp_dir().join(format!("styk-pen-output-{}", std::process::id()));
        std::fs::write(&path, b"a file cannot be an output directory").unwrap();
        let mut runner = Runner::new(SelfTest::parse("standard").unwrap(), host.clone());
        runner.phase = Phase_::Done(0);
        let worker = Worker::start_runner(runner, host.as_ref()).unwrap();
        let (sender, receiver) = mpsc::channel();
        worker.submit(context(Some(path.clone())), false, Box::new(move |result| sender.send(result).unwrap())).unwrap();
        drop(worker);
        assert!(host.run_next());
        assert!(receiver.recv().unwrap().unwrap_err().contains("report.txt"));
        assert!(write_csvs(&path, &[], &[], &[]).unwrap_err().contains("samples.csv"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn spawn_and_feeder_failures_are_not_success() {
        struct Refused;
        impl Spawner for Refused { fn spawn(&self, _: &str, _: Job) -> Result<(), SpawnError> { Err(SpawnError("refused".into())) } }
        assert!(Worker::start(SelfTest::parse("standard").unwrap(), Arc::new(Refused)).is_err());
        assert!(feed(context(None).core, Script { pointer: 1, steps: vec![] }, &Refused).is_err());
    }

    #[test]
    fn only_the_explicit_blocked_test_requests_interface_disturbance() {
        for (kind, expected) in [("standard", false), ("blocked", true), ("behaviour", false)] {
            let host = Arc::new(ManualSpawner::new());
            let mut runner = Runner::new(SelfTest::parse(kind).unwrap(), host);
            let (_sender, thread) = mpsc::channel();
            runner.phase = Phase_::Feeding { thread, script: Script { pointer: 1, steps: vec![] }, blocks_done: 0, frames: 13 };
            assert_eq!(matches!(runner.step(&context(None)), Step::DisturbBlockedProbe), expected);
        }
    }
}


// Feeder receivers are owned and polled only by the diagnostic worker.
#[allow(clippy::disallowed_types)]
enum Phase_ {
    Warmup(u32),
    Feeding { thread: mpsc::Receiver<Vec<u64>>, script: Script, blocks_done: u32, frames: u32 },
    Settling { script: Script, pushed: Vec<u64>, frames: u32 },
    /// The behaviour test: scripts one after another.
    Behaviour { thread: Option<mpsc::Receiver<Vec<u64>>>, frames: u32 },
    /// The stress test: strokes queued, waiting for the worker to finish them.
    Stress { frames: u32, stage: u32 },
    Capturing,
    Done(i32),
}

struct Runner {
    spawner: Arc<dyn Spawner>,
    error: Option<String>,
    test: SelfTest,
    phase: Phase_,
    summary: String,
    failures: u32,
    step: u32,
    /// (strokes, touch samples, palette opens) when each behaviour step began.
    marks: Vec<(u64, u64, u64)>,
}

/// Sleeps until the clock reaches `target_ns`, spinning for the last stretch.
// Called only by the Spawner's feeder task.
#[allow(clippy::disallowed_methods)]
fn wait_until(core: &PadCore, target_ns: u64) {
    loop {
        let now = core.now_ns();
        if now >= target_ns {
            return;
        }
        let left = target_ns - now;
        if left > 2_000_000 {
            std::thread::sleep(Duration::from_nanos(left - 1_500_000));
        } else {
            std::hint::spin_loop();
        }
    }
}

/// Pushes a script into the queue at its own pace, each sample stamped with the clock at its push. Returns the push times.
#[allow(clippy::disallowed_types)] // The result is received only on the diagnostic worker.
fn feed(core: Arc<PadCore>, script: Script, spawner: &dyn Spawner) -> Result<mpsc::Receiver<Vec<u64>>, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    spawner.spawn("styk-pen-feeder", Box::new(move || {
        let start = core.now_ns();
        let mut times = Vec::with_capacity(script.steps.len());
        for step in &script.steps {
            wait_until(&core, start + step.t_ns);
            let now = core.now_ns();
            let mut sample = step.sample(script.pointer, 0);
            sample.time_ns = now;
            core.queue.push(InputEvent::Sample(sample));
            times.push(now);
        }
        // A closed receiver means that the diagnostic was stopped.
        if sender.send(times).is_err() { return; }
    })).map_err(|error| error.to_string())?;
    Ok(receiver)
}

fn step_of(t_ns: u64, x: f64, y: f64, tool: Tool, phase: Phase, pressure: u32, barrel: bool) -> ScriptStep {
    ScriptStep { t_ns, x, y, tool, phase, raw_pressure: pressure, tilt_x: 0, tilt_y: 0, barrel, modifiers: Modifiers::NONE }
}

impl Runner {
    fn new(test: SelfTest, spawner: Arc<dyn Spawner>) -> Runner {
        Runner { spawner, error: None, test, phase: Phase_::Warmup(0), summary: String::new(), failures: 0, step: 0, marks: Vec::new() }
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
        line!(self.summary, "{} {name}: {detail}", if pass { "PASS" } else { "FAIL" });
    }

    fn finish(&mut self, cx: &Context) -> Step {
        match cx.out_dir.as_deref() {
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

    fn fail(&mut self, error: String) -> Step { self.error = Some(error); Step::Done(1) }

    #[allow(clippy::disallowed_methods)] // Entered by run(); report output is worker-owned.
    fn step(&mut self, cx: &Context) -> Step {
        match &mut self.phase {
            Phase_::Warmup(frames) => {
                *frames += 1;
                let pad = cx.core.gpu_stats().pad_px;
                if *frames < WARMUP_FRAMES || pad.0 <= 0.0 || cx.counters.is_none() {
                    if *frames > WARMUP_FRAMES * 20 {
                        line!(self.summary, "FAIL setup: the window never drew a pad or the input source never attached");
                        self.failures += 1;
                        self.phase = Phase_::Done(2);
                    }
                    return Step::Continue;
                }
                match self.test.kind {
                    TestKind::Stress => return self.stress(cx),
                    TestKind::Behaviour => {
                        self.phase = Phase_::Behaviour { thread: None, frames: 0 };
                        return Step::Continue;
                    }
                    _ => {}
                }
                let script = Script::generate(&ScriptSpec::standard(self.test.rate_hz, self.test.seconds, pad.0 as f64, pad.1 as f64), 1);
                self.reset_maxima(cx);
                cx.core.set_recording(true);
                let thread = match feed(cx.core.clone(), script.clone(), self.spawner.as_ref()) { Ok(thread) => thread, Err(error) => return self.fail(error) };
                self.phase = Phase_::Feeding { thread, script, blocks_done: 0, frames: 0 };
                Step::Continue
            }
            Phase_::Feeding { thread, blocks_done, frames, .. } => {
                match thread.try_recv() {
                    Ok(pushed) => {
                        let Phase_::Feeding { script, .. } = std::mem::replace(&mut self.phase, Phase_::Capturing) else { return self.fail("invalid feeding phase".into()) };
                        self.phase = Phase_::Settling { script, pushed, frames: 0 };
                        return Step::Continue;
                    }
                    Err(TryRecvError::Disconnected) => return self.fail("pen feeder stopped without its result".into()),
                    Err(TryRecvError::Empty) => {}
                }
                *frames += 1;
                if self.test.kind == TestKind::Blocked {
                    // Spread the blocks over the script, none before it starts or after it ends.
                    let every = ((self.test.seconds * cx.refresh_hz.max(60.0)) / (BLOCKS as f64 + 1.0)).max(1.0) as u32;
                    if *blocks_done < BLOCKS && *frames % every == 0 {
                        *blocks_done += 1;
                        return Step::DisturbBlockedProbe;
                    }
                }
                Step::Continue
            }
            Phase_::Settling { frames, .. } => {
                *frames += 1;
                if *frames < SETTLE_FRAMES {
                    return Step::Continue;
                }
                let Phase_::Settling { script, pushed, .. } = std::mem::replace(&mut self.phase, Phase_::Capturing) else { unreachable!("the phase was Settling") };
                self.finish_scripted(cx, &script, &pushed)
            }
            Phase_::Behaviour { .. } => self.behaviour(cx),
            Phase_::Stress { frames, stage } => {
                let (frames, stage) = (*frames, *stage);
                self.stress_wait(cx, frames, stage)
            }
            Phase_::Capturing => Step::Continue,
            Phase_::Done(code) => {
                let code = *code;
                if let Some(dir) = cx.out_dir.as_deref() {
                    if let Err(error) = std::fs::write(dir.join("report.txt"), &self.summary) { return self.fail(format!("report.txt: {error}")); }
                }
                print!("{}", self.summary);
                Step::Done(code)
            }
        }
    }

    fn reset_maxima(&self, cx: &Context) {
        cx.core.with_inspector(|inspector| {
            inspector.update_max_us = 0;
            inspector.max_generate_ms = 0.0;
            inspector.max_raster_ms = 0.0;
        });
        cx.core.with_gpu(|gpu| {
            gpu.prepare_max_us = 0;
            gpu.own_max_us = 0;
            gpu.wgpu_max_us = 0;
        });
    }

    fn finish_scripted(&mut self, cx: &Context, script: &Script, pushed: &[u64]) -> Step {
        cx.core.set_recording(false);
        let (samples, frames) = cx.core.take_recording();
        let inspector = cx.core.inspector();
        let gpu = cx.core.gpu_stats();
        let present = std::env::var("ICED_PRESENT_MODE").unwrap_or_else(|_| "Fifo (iced AutoVsync)".into());
        let report = report::analyse(script, pushed, &samples, &frames, (0.0, 0.0));
        self.summary.push_str(&report.text(cx.refresh_hz, &present, (inspector.update_max_us, gpu.prepare_max_us)));
        self.judge(cx, &report);
        if let Some(dir) = cx.out_dir.as_deref() {
            if let Err(error) = write_csvs(dir, &samples, &frames, pushed) { return self.fail(error); }
        }
        self.finish(cx)
    }

    fn judge(&mut self, cx: &Context, report: &Report) {
        let inspector = cx.core.inspector();
        self.check("A2 every sample arrives", report.delivered == report.injected, format!("{} delivered of {} pushed", report.delivered, report.injected));
        self.check("A2 no duplicates", report.duplicates == 0, report.duplicates);
        self.check("A2 monotonic", report.monotonic, report.monotonic);
        self.check("A1 fields compared", report.aligned, report.aligned);
        if report.aligned {
            self.check("A1 tool, barrel, phase", report.tool_mismatches + report.barrel_mismatches + report.phase_mismatches == 0, format!("{}/{}/{} mismatches", report.tool_mismatches, report.barrel_mismatches, report.phase_mismatches));
            self.check("A1 tilt and pressure exact", report.max_tilt_error == 0.0 && report.max_pressure_error == 0.0, format!("tilt {:.1}, pressure {:.1}/1024", report.max_tilt_error, report.max_pressure_error));
            self.check("A3 position exact", report.max_position_error <= 0.5, format!("max {:.2} px", report.max_position_error));
        }
        self.check("queue never shed", inspector.queue.dropped_moves + inspector.queue.dropped_hover + inspector.queue.refused_downs == 0, format!("{:?}", inspector.queue));
        // The blocked test holds the interface thread on purpose; its own slices are the point of it.
        if self.test.kind == TestKind::Standard {
            self.check("A5 update slice under 4 ms", inspector.update_max_us < 4000, format!("{} us", inspector.update_max_us));
            let gpu = cx.core.gpu_stats();
            self.check("A5 prepare slice (the pad's own work) under 4 ms", gpu.own_max_us < 4000, format!("own {} us; whole {} us of which graphics API {} us", gpu.own_max_us, gpu.prepare_max_us, gpu.wgpu_max_us));
        }
    }

    /// The pad's gestures from scripted samples, one script after another.
    #[allow(clippy::disallowed_methods)] // The Behaviour pause and feeder wait run only in run().
    fn behaviour(&mut self, cx: &Context) -> Step {
        let Phase_::Behaviour { thread, frames } = &mut self.phase else { unreachable!("the phase is Behaviour") };
        *frames += 1;
        if let Some(handle) = thread {
            if *frames < 40 { return Step::Continue; }
            match handle.try_recv() {
                Ok(_) => { *thread = None; }
                Err(TryRecvError::Empty) => return Step::Continue,
                Err(TryRecvError::Disconnected) => return self.fail("pen feeder stopped without its result".into()),
            }
        } else if *frames < 5 {
            return Step::Continue;
        }
        *frames = 0;
        let pad = cx.core.gpu_stats().pad_px;
        let inspector = cx.core.inspector();
        self.marks.push((inspector.strokes, inspector.touch_samples, inspector.palette_opens));
        let period = 1_000_000_000u64 / self.test.rate_hz as u64;
        let (mid_x, mid_y) = (pad.0 as f64 / 2.0, pad.1 as f64 / 2.0);
        let at = |i: u64, x: f64, y: f64, tool, phase, pressure, barrel| step_of(i * period, x, y, tool, phase, pressure, barrel);
        let contact = |i: u64| if i == 0 { Phase::Down } else if i == 29 { Phase::Up } else { Phase::Move };
        let script = match self.step {
            0 => {
                // The barrel button pressed while hovering over the pad.
                let steps = (0..40).map(|i| at(i, mid_x, mid_y, Tool::Pen, Phase::Hover, 0, (10..30).contains(&i))).collect();
                Script { pointer: 1, steps }
            }
            1 => {
                // A pen press that begins over a control, in the panel beside the pad, and drags back over the pad.
                let steps = (0..30).map(|i| at(i, pad.0 as f64 + 60.0 - i as f64 * 8.0, 40.0, Tool::Pen, contact(i), 600, false)).collect();
                Script { pointer: 1, steps }
            }
            2 => {
                // A finger alone, once the setting says a finger draws; the pen was last used long ago.
                cx.core.set_switches(Switches { finger_draws: true, ..cx.core.switches() });
                std::thread::sleep(Duration::from_millis(800));
                let steps = (0..30).map(|i| at(i, mid_x + i as f64 * 3.0, mid_y, Tool::Touch, contact(i), 512, false)).collect();
                Script { pointer: 9, steps }
            }
            3 => {
                // A finger within 700 ms of the pen: the pen hovers, then the finger presses.
                let hover: Vec<ScriptStep> = (0..4).map(|i| at(i, mid_x - 40.0, mid_y - 40.0, Tool::Pen, Phase::Hover, 0, false)).collect();
                let hover = match feed(cx.core.clone(), Script { pointer: 7, steps: hover }, self.spawner.as_ref()) { Ok(hover) => hover, Err(error) => return self.fail(error) };
                if let Err(error) = hover.recv() { return self.fail(error.to_string()); }
                let steps = (0..30).map(|i| at(i, mid_x + i as f64 * 3.0, mid_y + 50.0, Tool::Touch, contact(i), 512, false)).collect();
                Script { pointer: 9, steps }
            }
            _ => {
                let d = |i: usize| (self.marks[i + 1].0 - self.marks[i].0, self.marks[i + 1].1 - self.marks[i].1, self.marks[i + 1].2 - self.marks[i].2);
                let (_, _, palette) = d(0);
                let (outside_strokes, ..) = d(1);
                let (finger_strokes, finger_touch, _) = d(2);
                let (palm_strokes, palm_touch, _) = d(3);
                self.check("A7 the barrel press over the pad opens the palette once", palette == 1, format!("{palette} palette actions"));
                self.check("A7 a press that begins on a control starts no stroke", outside_strokes == 0, format!("{outside_strokes} strokes"));
                self.check("A7 a finger alone draws when the setting says so", finger_strokes >= 1 && finger_touch > 0, format!("{finger_strokes} strokes, {finger_touch} touch samples"));
                self.check("A7 a finger within 700 ms of the pen is ignored", palm_strokes == 0 && palm_touch > 0, format!("{palm_strokes} strokes, {palm_touch} touch samples"));
                return self.finish(cx);
            }
        };
        self.step += 1;
        if let Phase_::Behaviour { thread, .. } = &mut self.phase {
            *thread = match feed(cx.core.clone(), script, self.spawner.as_ref()) { Ok(thread) => Some(thread), Err(error) => return self.fail(error) };
        }
        Step::Continue
    }

    /// Worst inputs for the worker: the interface thread must only queue them.
    fn stress(&mut self, cx: &Context) -> Step {
        let core = &cx.core;
        let mut brush = core.brush();
        brush.size = 2.0;
        core.set_brush(brush);
        core.set_view(View { zoom: 64.0, pan: (0.0, 0.0) });
        core.set_switches(Switches { mirror_x: true, ..core.switches() });
        self.reset_maxima(cx);
        core.set_recording(true);
        Self::push_stroke(core, 1, &[(100.0, 100.0), (900.0, 100.0), (100.0, 400.0), (900.0, 400.0)]);
        self.phase = Phase_::Stress { frames: 0, stage: 0 };
        Step::Continue
    }

    fn push_stroke(core: &Arc<PadCore>, pointer: u32, points: &[(f64, f64)]) {
        let now = core.now_ns();
        for (i, &(x, y)) in points.iter().enumerate() {
            let mut s = PenSample::at(now + i as u64 * 4_000_000, pointer, Tool::Pen, x, y);
            s.phase = if i == 0 { Phase::Down } else if i + 1 == points.len() { Phase::Up } else { Phase::Move };
            s.buttons = if s.phase == Phase::Up { PenButtons::NONE } else { PenButtons::TIP };
            s.pressure = 0.8;
            s.raw_pressure = 819;
            s.pressure_max = 1024;
            s.valid = Valid::PRESSURE;
            core.queue.push(InputEvent::Sample(s));
        }
    }

    fn stress_wait(&mut self, cx: &Context, frames: u32, stage: u32) -> Step {
        let core = &cx.core;
        let inspector = core.inspector();
        if stage == 0 {
            // The first stroke is the zoomed, mirrored one. Its mapping is captured when the pad reads its press; only then
            // may the view change for the second stroke (a view changed earlier would apply to both).
            if inspector.strokes < 1 {
                self.phase = Phase_::Stress { frames: frames + 1, stage: 0 };
                return Step::Continue;
            }
            core.set_view(View { zoom: 1.0, pan: (0.0, 0.0) });
            // One coordinate gap of 200,000 pixels with a 2 pixel brush: some 800,000 dabs from a single sample.
            Self::push_stroke(core, 2, &[(10.0, 200.0), (200_000.0, 200.0), (200_000.0, 200.0)]);
            self.phase = Phase_::Stress { frames: frames + 1, stage: 1 };
            return Step::Continue;
        }
        let limit = (cx.refresh_hz.max(60.0) * 90.0) as u32;
        if inspector.finished_strokes < 2 && frames < limit {
            self.phase = Phase_::Stress { frames: frames + 1, stage: 1 };
            return Step::Continue;
        }
        core.set_recording(false);
        let (_, rows) = core.take_recording();
        let gpu = core.gpu_stats();
        let mut periods: Vec<f64> = rows.windows(2).map(|p| p[1].prepare_start_ns.saturating_sub(p[0].prepare_start_ns) as f64 / 1e6).collect();
        periods.sort_by(|a, b| a.total_cmp(b));
        let median = periods.get(periods.len() / 2).copied().unwrap_or(0.0);
        let worst = periods.last().copied().unwrap_or(0.0);
        self.check("stress strokes finished", inspector.finished_strokes >= 2, format!("{} finished, {} refusals, {} worker errors", inspector.finished_strokes, inspector.worker_refusals, inspector.worker_errors.len()));
        self.check("A5 update slice under 4 ms", inspector.update_max_us < 4000, format!("{} us", inspector.update_max_us));
        self.check("A5 prepare slice (the pad's own work) under 4 ms", gpu.own_max_us < 4000, format!("own {} us; whole {} us of which graphics API {} us", gpu.own_max_us, gpu.prepare_max_us, gpu.wgpu_max_us));
        self.check("A5 no frame skipped while the worker works", worst < median * 2.5 + 2.0, format!("median frame {median:.2} ms, worst {worst:.2} ms over {} frames", rows.len()));
        line!(self.summary, "worker: longest dab generation {:.1} ms, longest raster {:.1} ms; display {:.0} Hz", inspector.max_generate_ms, inspector.max_raster_ms, cx.refresh_hz);
        line!(self.summary, "tiles: resident {}, evicted {}, refused {}, hidden {}, superseded {}, fetched {}; uniform writes skipped {}", gpu.tiles_resident, gpu.sync.evicted, gpu.sync.refused, gpu.sync.hidden, gpu.sync.superseded, gpu.sync.fetched, gpu.uniform_writes_skipped);
        self.long_frames(&rows, median);
        self.phase = Phase_::Done(i32::from(self.failures > 0));
        Step::Continue
    }

    /// What the long frames were: for each frame whose gap to the previous is over twice the median, where the time went.
    fn long_frames(&mut self, rows: &[FrameRow], median_ms: f64) {
        let mut long = 0;
        let (mut in_prepare, mut in_update, mut in_view, mut elsewhere) = (0, 0, 0, 0);
        for pair in rows.windows(2) {
            let gap_ms = pair[1].prepare_start_ns.saturating_sub(pair[0].prepare_start_ns) as f64 / 1e6;
            if gap_ms <= median_ms * 2.0 {
                continue;
            }
            long += 1;
            // Work the interface thread did in the frame that ended the gap, by part, against the gap itself.
            let row = &pair[1];
            let prepare_ms = (row.prepare_end_ns - row.prepare_start_ns) as f64 / 1e6;
            let (update_ms, view_ms) = (row.update_us as f64 / 1e3, row.view_us as f64 / 1e3);
            let explained = prepare_ms.max(update_ms).max(view_ms);
            if explained < gap_ms * 0.5 {
                elsewhere += 1;
            } else if prepare_ms >= update_ms && prepare_ms >= view_ms {
                in_prepare += 1;
            } else if update_ms >= view_ms {
                in_update += 1;
            } else {
                in_view += 1;
            }
        }
        line!(self.summary, "long frames (gap over twice the median): {long}: mostly in prepare {in_prepare}, in the pad update {in_update}, in the lab view {in_view}, outside all three (draw, GPU, present, other threads) {elsewhere}");
        let mut worst: Vec<&FrameRow> = rows.iter().collect();
        worst.sort_by_key(|r| std::cmp::Reverse(r.prepare_end_ns - r.prepare_start_ns));
        for row in worst.iter().take(3) {
            line!(
                self.summary,
                "slowest prepare: {:.2} ms = replies {:.2} + install {:.2} + preview {:.2} ms (graphics API calls inside: {:.2} ms), {} tiles written, {} wet dabs; update {} us, view {} us",
                (row.prepare_end_ns - row.prepare_start_ns) as f64 / 1e6,
                row.replies_us as f64 / 1e3,
                row.install_us as f64 / 1e3,
                row.wet_us as f64 / 1e3,
                row.wgpu_us as f64 / 1e3,
                row.tiles_uploaded,
                row.wet_dabs,
                row.update_us,
                row.view_us
            );
        }
    }
}

#[allow(clippy::disallowed_methods)] // Output belongs to the diagnostic worker, never its interface handle.
fn write_csvs(dir: &Path, samples: &[styk_core::drawing::pad::SampleRow], frames: &[FrameRow], pushed: &[u64]) -> Result<(), String> {
    let mut out = String::from("time_ns,pointer,tool,phase,x,y,pressure,raw_pressure,tilt_x,tilt_y,buttons,flags,modifiers,received_ns\n");
    for r in samples {
        let s = &r.sample;
        line!(out, "{},{},{:?},{:?},{},{},{},{},{},{},{},{},{},{}", s.time_ns, s.pointer, s.tool, s.phase, s.x, s.y, s.pressure, s.raw_pressure, s.tilt_x, s.tilt_y, s.buttons.0, s.flags.0, s.modifiers.0, r.received_ns);
    }
    std::fs::write(dir.join("samples.csv"), out).map_err(|error| format!("samples.csv: {error}"))?;
    let mut out = String::from("frame,prepare_start_ns,prepare_end_ns,newest_wet_ns,newest_exact_ns,wet_dabs,tiles_uploaded,replies_us,install_us,wet_us,wgpu_us,view_us,update_us\n");
    for f in frames {
        line!(out, "{},{},{},{},{},{},{},{},{},{},{},{},{}", f.frame, f.prepare_start_ns, f.prepare_end_ns, f.newest_wet_ns, f.newest_exact_ns, f.wet_dabs, f.tiles_uploaded, f.replies_us, f.install_us, f.wet_us, f.wgpu_us, f.view_us, f.update_us);
    }
    std::fs::write(dir.join("frames.csv"), out).map_err(|error| format!("frames.csv: {error}"))?;
    let mut out = String::from("step,pushed_ns\n");
    for (i, t) in pushed.iter().enumerate() {
        line!(out, "{i},{t}");
    }
    std::fs::write(dir.join("pushed.csv"), out).map_err(|error| format!("pushed.csv: {error}"))?;
    Ok(())
}
