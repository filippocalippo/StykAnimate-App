//! The pen lab: a drawing pad on the real input path and a live sample inspector (`docs/native/input.md` 3.6).
//!
//! The pad draws what the platform source reports: samples flow from the window's pointer messages through the bounded
//! queue and the stroke rules to the drawing worker, whose tiles and wet ink the pad shows. The inspector beside it shows
//! the newest sample's fields, the sample rate, the history and drop counters, the worker's batch times and the frame
//! and slice times. It becomes the developer tools' Input panel.
//!
//! `self_test` drives scripted input through the pad's queue from an in-process thread (no system-level injection: decision
//! N6) and writes what it measured; the operating system's own path (`WM_POINTER`) is covered by the platform crate's tests of
//! its pure parts and by hand with a tablet.

pub mod report;
mod self_test;

pub use self_test::{SelfTest, TestKind};

use iced::widget::{button, column, container, mouse_area, row, slider, text};
use iced::{Element, Font, Length, Subscription, Task, Widget, window};
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use styk_core::drawing::worker::{HistoryOp, Worker};
use styk_platform::windows::input::{InputCounters, WindowsInput, refresh_hz};
use styk_platform::windows::qpc::QpcClock;
use styk_ui::ink_pad::{PadCore, ink_pad};
use styk_services::input::InputQueue;

/// The inspector's width in logical pixels.
pub const PANEL_WIDTH: f32 = 360.0;

/// What the lab is started with.
pub struct LabOptions {
    pub window: window::Settings,
    pub scale: f32,
    /// The window is created hidden and shown without activation (an unattended run on Windows).
    pub show_after_open: bool,
    pub self_test: Option<SelfTest>,
    pub out_dir: Option<PathBuf>,
}

#[derive(Clone)]
pub enum Message {
    Opened(window::Id),
    Attached(Attached),
    Frame,
    Brush(BrushChange),
    Switch(SwitchChange),
    Clear,
    Undo,
    Redo,
    ToggleRecording,
    HoverEnter,
    HoverExit,
    Finished,
}

/// The result of hooking the window, handed from the window closure (which runs on the interface thread) to the lab.
#[derive(Clone)]
pub struct Attached(Arc<Mutex<Option<Result<(Arc<InputCounters>, f64), String>>>>);

thread_local! {
    /// The source stays on the interface thread: it is dropped there, and nothing else touches it.
    static SOURCE: RefCell<Option<WindowsInput>> = const { RefCell::new(None) };
}

impl std::fmt::Debug for Attached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Attached")
    }
}

#[derive(Clone, Copy, Debug)]
pub enum BrushChange {
    Size(f64),
    Hardness(f64),
    Stabilization(f64),
    Zoom(f64),
}

#[derive(Clone, Copy, Debug)]
pub enum SwitchChange {
    WetInk,
    Prediction,
    EraseTool,
    Mirror,
}

struct Lab {
    core: Arc<PadCore>,
    counters: Option<Arc<InputCounters>>,
    window: Option<window::Id>,
    refresh_hz: f64,
    show_after_open: bool,
    out_dir: Option<PathBuf>,
    test: Option<self_test::Runner>,
    hover_target: bool,
    hover_enters: u64,
    frames: u64,
    error: Option<String>,
    exit_code: Arc<Mutex<i32>>,
}

impl Lab {
    fn new(options: &LabOptions, exit_code: Arc<Mutex<i32>>) -> Lab {
        let queue = InputQueue::new();
        let worker = Worker::spawn(Vec::new(), Arc::new(|| {}));
        let core = PadCore::new(queue, worker, Arc::new(QpcClock));
        Lab {
            core,
            counters: None,
            window: None,
            refresh_hz: 0.0,
            show_after_open: options.show_after_open,
            out_dir: options.out_dir.clone(),
            test: options.self_test.clone().map(self_test::Runner::new),
            hover_target: false,
            hover_enters: 0,
            frames: 0,
            error: None,
            exit_code,
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Opened(id) => {
                self.window = Some(id);
                let queue = self.core.queue.clone();
                let show_after_open = self.show_after_open;
                let attached = Attached(Arc::new(Mutex::new(None)));
                let slot = attached.clone();
                let show = styk_platform::window::show_without_activation;
                window::run(id, move |window| {
                    if show_after_open {
                        let _ = show(window);
                    }
                    let result = WindowsInput::attach(window, queue)
                        .map(|source| {
                            let counters = source.counters();
                            SOURCE.with(|cell| *cell.borrow_mut() = Some(source));
                            (counters, refresh_hz(window))
                        })
                        .map_err(|e| e.to_string());
                    *slot.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
                    Message::Attached(slot)
                })
            }
            Message::Attached(slot) => {
                match slot.0.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    Some(Ok((counters, hz))) => {
                        self.counters = Some(counters);
                        self.refresh_hz = hz;
                    }
                    Some(Err(error)) => self.error = Some(error),
                    None => {}
                }
                Task::none()
            }
            Message::Frame => {
                self.frames += 1;
                let Some(runner) = self.test.as_mut() else { return Task::none() };
                let context = self_test::Context {
                    core: &self.core,
                    counters: self.counters.as_ref(),
                    refresh_hz: self.refresh_hz,
                    out_dir: self.out_dir.as_deref(),
                };
                match runner.step(&context) {
                    self_test::Step::Continue => Task::none(),
                    self_test::Step::Capture(path) => {
                        let id = self.window;
                        match id {
                            Some(id) => window::run(id, move |w| styk_platform::window::capture(w).map_err(|e| e.to_string())).map(move |result| {
                                if let Ok(image) = result {
                                    let _ = write_png(&path, &image);
                                }
                                Message::Finished
                            }),
                            None => Task::done(Message::Finished),
                        }
                    }
                    self_test::Step::Done(code) => {
                        *self.exit_code.lock().unwrap_or_else(|p| p.into_inner()) = code;
                        iced::exit()
                    }
                }
            }
            Message::Finished => {
                if let Some(runner) = self.test.as_mut() {
                    runner.captured();
                }
                Task::none()
            }
            Message::Brush(change) => {
                let mut brush = self.core.brush();
                match change {
                    BrushChange::Size(v) => brush.size = v,
                    BrushChange::Hardness(v) => brush.hardness = v,
                    BrushChange::Stabilization(v) => brush.stabilization = v,
                    BrushChange::Zoom(v) => {
                        let mut view = self.core.view();
                        view.zoom = v;
                        self.core.set_view(view);
                    }
                }
                self.core.set_brush(brush);
                Task::none()
            }
            Message::Switch(change) => {
                let mut switches = self.core.switches();
                match change {
                    SwitchChange::WetInk => switches.wet_ink = !switches.wet_ink,
                    SwitchChange::Prediction => switches.prediction = !switches.prediction,
                    SwitchChange::EraseTool => switches.erase_tool = !switches.erase_tool,
                    SwitchChange::Mirror => switches.mirror_x = !switches.mirror_x,
                }
                self.core.set_switches(switches);
                Task::none()
            }
            Message::Clear => {
                self.core.history(HistoryOp::Clear);
                Task::none()
            }
            Message::Undo => {
                self.core.history(HistoryOp::Undo);
                Task::none()
            }
            Message::Redo => {
                self.core.history(HistoryOp::Redo);
                Task::none()
            }
            Message::ToggleRecording => {
                self.core.set_recording(!self.core.recording());
                Task::none()
            }
            Message::HoverEnter => {
                self.hover_target = true;
                self.hover_enters += 1;
                Task::none()
            }
            Message::HoverExit => {
                self.hover_target = false;
                Task::none()
            }
        }
    }

    fn view(&self) -> Element<'_, Message> {
        let built = self.core.now_ns();
        let inspector = self.core.inspector();
        let gpu = self.core.gpu_stats();
        let brush = self.core.brush();
        let switches = self.core.switches();
        let view = self.core.view();
        let mono = Font::MONOSPACE;
        let line = |s: String| text(s).size(12).font(mono);
        let mut lines = column![].spacing(2);
        if let Some(error) = &self.error {
            lines = lines.push(line(format!("input source: {error}")));
        }
        match &inspector.last {
            Some(s) => {
                lines = lines
                    .push(line(format!("tool {:?}  phase {:?}  pointer {}", s.tool, s.phase, s.pointer)))
                    .push(line(format!("x {:.2}  y {:.2}", s.x, s.y)))
                    .push(line(format!("pressure {:.4} ({}/{})  valid {:?}", s.pressure, s.raw_pressure, s.pressure_max, s.valid.0)))
                    .push(line(format!("tilt {:.0} {:.0}  twist {:.0}", s.tilt_x, s.tilt_y, s.twist)))
                    .push(line(format!("buttons {:?}  flags {:?}  mods {:?}", s.buttons.0, s.flags.0, s.modifiers.0)))
                    .push(line(format!("time {:.3} ms", s.time_ns as f64 / 1e6)));
            }
            None => lines = lines.push(line("no sample yet".into())),
        }
        let median = inspector.median_gap_ns().map_or("-".to_string(), |g| format!("{:.3} ms ({:.0} Hz)", g as f64 / 1e6, 1e9 / g as f64));
        lines = lines
            .push(line(String::new()))
            .push(line(format!("samples {}  hover {}  contact {}  history {}", inspector.samples, inspector.hover_samples, inspector.contact_samples, inspector.history_samples)))
            .push(line(format!("duplicates {}  touch {}  mouse {}", inspector.duplicates, inspector.touch_samples, inspector.mouse_samples)))
            .push(line(format!("median gap {median}")))
            .push(line(format!("queue {} (high {})  dropped hover {} moves {} downs {}  overflows {}", inspector.queue.queued, inspector.queue.high_water, inspector.queue.dropped_hover, inspector.queue.dropped_moves, inspector.queue.refused_downs, inspector.queue.overflows)))
            .push(line(format!("strokes {}  interrupted {}  palette {}  pick {}  resize {}", inspector.strokes, inspector.interrupts, inspector.palette_opens, inspector.color_picks, inspector.resizes)))
            .push(line(String::new()))
            .push(line(format!("worker queue {}  generate {:.2} ms (max {:.2})  raster {:.2} ms (max {:.2})", inspector.worker_queued, inspector.last_generate_ms, inspector.max_generate_ms, inspector.last_raster_ms, inspector.max_raster_ms)))
            .push(line(format!("tiles resident {}  uploaded {}  batches waiting {}  evicted {}  refused {}  hidden {}  superseded {}", gpu.tiles_resident, gpu.tiles_uploaded, gpu.batches_waiting, gpu.sync.evicted, gpu.sync.refused, gpu.sync.hidden, gpu.sync.superseded)))
            .push(line(format!("wet dabs {}  batches retired {} by tiles {} by age  dropped {}  stale {}", gpu.wet_instances, gpu.ledger.retired_by_tiles, gpu.ledger.retired_by_age, gpu.ledger.dropped, gpu.ledger.stale)))
            .push(line(format!("frames {}  prepare {} us (max {}) of which graphics API {} us (max {})  update {} us (max {})", gpu.frames, gpu.prepare_last_us, gpu.prepare_max_us, gpu.wgpu_last_us, gpu.wgpu_max_us, inspector.update_last_us, inspector.update_max_us)))
            .push(line(format!("display {:.0} Hz  recording {}", self.refresh_hz, self.core.recording())));
        if let Some(counters) = &self.counters {
            use std::sync::atomic::Ordering::Relaxed;
            lines = lines.push(line(format!(
                "pen messages {}  promoted mouse {}  real mouse {}  context menus {}",
                counters.pen_messages.load(Relaxed),
                counters.promoted_mouse_messages.load(Relaxed),
                counters.real_mouse_messages.load(Relaxed),
                counters.context_menus.load(Relaxed)
            )));
        }
        for error in inspector.worker_errors.iter().rev().take(3) {
            lines = lines.push(line(format!("worker: {error}")));
        }
        let slider_row = |label: &str, value: f64, range: std::ops::RangeInclusive<f64>, change: fn(f64) -> BrushChange| {
            row![text(label.to_string()).size(12).width(Length::Fixed(90.0)), slider(range, value, move |v| Message::Brush(change(v))).step(0.01)].spacing(8)
        };
        let toggle = |label: &str, on: bool, change: SwitchChange| button(text(format!("{label}: {}", if on { "on" } else { "off" })).size(12)).on_press(Message::Switch(change));
        let target = mouse_area(container(text(if self.hover_target { "pen/mouse over this box: hover on" } else { "hover target" }).size(12)).padding(12).width(Length::Fill).style(move |_| {
            container::Style::default().background(iced::Color::from_rgb(if self.hover_target { 0.75 } else { 0.9 }, 0.9, 0.9))
        }))
        .on_enter(Message::HoverEnter)
        .on_exit(Message::HoverExit);
        let controls = column![
            target,
            slider_row("size", brush.size, 1.0..=200.0, BrushChange::Size),
            slider_row("hardness", brush.hardness, 0.0..=1.0, BrushChange::Hardness),
            slider_row("stabilise", brush.stabilization, 0.0..=0.95, BrushChange::Stabilization),
            slider_row("zoom", view.zoom, 0.25..=16.0, BrushChange::Zoom),
            row![toggle("wet ink", switches.wet_ink, SwitchChange::WetInk), toggle("predict", switches.prediction, SwitchChange::Prediction)].spacing(6),
            row![toggle("eraser", switches.erase_tool, SwitchChange::EraseTool), toggle("mirror", switches.mirror_x, SwitchChange::Mirror)].spacing(6),
            row![
                button(text("clear").size(12)).on_press(Message::Clear),
                button(text("undo").size(12)).on_press(Message::Undo),
                button(text("redo").size(12)).on_press(Message::Redo),
                button(text(if self.core.recording() { "stop recording" } else { "record" }).size(12)).on_press(Message::ToggleRecording),
            ]
            .spacing(6),
        ]
        .spacing(8);
        let panel = container(column![controls, lines].spacing(14)).padding(12).width(Length::Fixed(PANEL_WIDTH)).height(Length::Fill);
        let element = row![ink_pad(self.core.clone()), panel].boxed();
        self.core.set_view_us((self.core.now_ns() - built) / 1000);
        element
    }

    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([window::open_events().map(Message::Opened), window::frames().map(|_| Message::Frame)])
    }
}

fn write_png(path: &std::path::Path, image: &styk_platform::window::Image) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&image.rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())
}

/// Runs the lab until its window closes (or its self-test ends). Returns the process exit code.
pub fn run(options: LabOptions) -> Result<i32, String> {
    let exit_code = Arc::new(Mutex::new(0));
    let lab = Mutex::new(Some(Lab::new(&options, exit_code.clone())));
    let scale = options.scale;
    iced::application(move || lab.lock().unwrap_or_else(|p| p.into_inner()).take().expect("the lab starts once"), Lab::update, Lab::view)
        .subscription(Lab::subscription)
        .title("StykAnimate pen lab")
        .scale_factor(move |_| scale)
        .font(styk_design::widgets::INTER)
        .fonts(styk_design::fonts::ALL.iter().map(|font| std::borrow::Cow::Borrowed(*font)))
        .window(options.window)
        .run()
        .map_err(|error| format!("the window failed: {error}"))?;
    let code = *exit_code.lock().unwrap_or_else(|p| p.into_inner());
    Ok(code)
}
