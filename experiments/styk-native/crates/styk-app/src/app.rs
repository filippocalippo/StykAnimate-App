//! The desktop shell: file list, stage, transport and performance panel.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crossbeam_channel::Receiver;
use egui::{Color32, CornerRadius, Pos2, Rect, RichText, Sense, Stroke, Vec2};
use styk_core::doc::Object;
use styk_core::edit::{self, Change, PoseRef};
use styk_core::geometry::Scene;
use styk_core::view::{apply, camera_matrix, invert};
use styk_render::ViewParams;

use crate::engine::{self, Engine, Loaded};
use crate::gpu::Stage;
use crate::theme;

const HANDLE_SEGMENT: Color32 = Color32::from_rgb(0xff, 0x00, 0x00);
const HANDLE_ORIGIN: Color32 = Color32::from_rgb(0xff, 0x88, 0x00);
const HANDLE_UNSELECTED: Color32 = Color32::from_rgb(0x00, 0x00, 0xff);
const HANDLE_UNSELECTED_ORIGIN: Color32 = Color32::from_rgb(0x00, 0x80, 0xff);

struct Drag {
    at: PoseRef,
    before: Arc<Object>,
    /// Segment index, or None for the origin.
    index: Option<usize>,
    start_world: [f64; 2],
    stretch: bool,
}

#[derive(Clone)]
struct Handle {
    uid: u32,
    slot: u32,
    index: Option<usize>,
    pos: Pos2,
    radius: f32,
    color: Color32,
}

pub struct App {
    pool: Arc<rayon::ThreadPool>,
    engine: Option<Engine>,
    loading: Option<(PathBuf, Receiver<Result<Loaded, String>>, Instant)>,
    error: Option<String>,
    files: Vec<(String, Vec<PathBuf>)>,
    gpu_name: String,
    // playback
    playing: bool,
    looping: bool,
    playhead: f64,
    tick: u32,
    last_instant: Option<Instant>,
    // view (points)
    zoom: f64,
    pan: Vec2,
    fit_pending: bool,
    /// One-shot: the next fit keeps the current zoom (100% view).
    zoom_one: bool,
    clip: bool,
    show_handles: bool,
    all_handles: bool,
    // editing
    selected: Option<u32>,
    drag: Option<Drag>,
    panning: bool,
    // stats
    frame_times: VecDeque<f32>,
    shown: u64,
    playback_misses: u64,
    last_frame_ms: f32,
    show_stats: bool,
    script: crate::Script,
    script_frames: u32,
    bench: Option<Bench>,
    /// Stage size in points, for scripted gestures.
    stage_size: Vec2,
}

/// Scripted measurements (`--bench`): playback, zoom, pan, zoom while playing.
struct Bench {
    /// Pose phase: the edited record, its original state and the segment turned.
    pose: Option<(PoseRef, Arc<Object>, usize)>,
    edit_ms: Vec<f32>,
    phase: usize,
    started: Option<Instant>,
    last: Option<Instant>,
    intervals: Vec<f32>,
    work: Vec<f32>,
    presented: Vec<(u32, Instant)>,
    sync_before: u64,
    misses_before: u64,
    fit: f64,
}

impl Bench {
    fn new() -> Bench {
        Bench { pose: None, edit_ms: vec![], phase: 0, started: None, last: None, intervals: vec![], work: vec![], presented: vec![], sync_before: 0, misses_before: 0, fit: 1.0 }
    }
}

fn quantiles(mut v: Vec<f32>) -> String {
    if v.is_empty() {
        return "{}".into();
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let q = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    format!("{{\"n\":{},\"p50\":{:.2},\"p95\":{:.2},\"p99\":{:.2},\"max\":{:.2}}}", v.len(), q(0.5), q(0.95), q(0.99), v[v.len() - 1])
}

fn scan_files() -> Vec<(String, Vec<PathBuf>)> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut groups = Vec::new();
    for (label, dir) in [("Downloads", home.join("Downloads")), ("Downloads/pivs", home.join("Downloads/pivs")), ("Downloads/WafflesPack", home.join("Downloads/WafflesPack"))] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("piv" | "styk" | "stkz" | "stykmov")))
            .collect();
        files.sort();
        if !files.is_empty() {
            groups.push((label.to_string(), files));
        }
    }
    groups
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, initial: Option<PathBuf>, script: crate::Script) -> App {
        theme::apply(&cc.egui_ctx);
        let mut gpu_name = String::from("GPU unavailable");
        if let Some(rs) = &cc.wgpu_render_state {
            crate::gpu::GpuState::install(rs);
            let info = rs.adapter.get_info();
            gpu_name = format!("{} ({:?})", info.name, info.backend);
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads.saturating_sub(2).max(1))
                .thread_name(|i| format!("styk-prefetch-{i}"))
                // Background preparation yields to the UI and compositor threads.
                .start_handler(|_| lower_priority())
                .build()
                .expect("prefetch pool"),
        );
        let mut app = App {
            pool,
            engine: None,
            loading: None,
            error: None,
            files: scan_files(),
            gpu_name,
            playing: false,
            looping: true,
            playhead: 0.0,
            tick: 0,
            last_instant: None,
            zoom: 1.0,
            pan: Vec2::ZERO,
            fit_pending: true,
            zoom_one: false,
            clip: true,
            show_handles: true,
            all_handles: true,
            selected: None,
            drag: None,
            panning: false,
            frame_times: VecDeque::new(),
            shown: 0,
            playback_misses: 0,
            last_frame_ms: 0.0,
            show_stats: true,
            script,
            script_frames: 0,
            bench: None,
            stage_size: Vec2::new(1000.0, 700.0),
        };
        if app.script.no_handles {
            app.show_handles = false;
        }
        if let Some(path) = initial {
            app.open(path, &cc.egui_ctx);
        }
        app
    }

    fn open(&mut self, path: PathBuf, ctx: &egui::Context) {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let p = path.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(engine::load(&p));
            ctx.request_repaint();
        });
        self.loading = Some((path, rx, Instant::now()));
        self.error = None;
    }

    fn finish_loading(&mut self) {
        let Some((path, rx, _)) = &self.loading else { return };
        match rx.try_recv() {
            Ok(Ok(loaded)) => {
                self.engine = Some(Engine::new(loaded, self.pool.clone()));
                self.loading = None;
                self.playing = false;
                self.playhead = 0.0;
                self.tick = 0;
                self.fit_pending = true;
                self.selected = None;
                self.drag = None;
                self.shown = 0;
                self.playback_misses = 0;
                self.script_frames = 0;
                if let Some(t) = self.script.tick {
                    self.set_tick(t);
                }
                if let Some(z) = self.script.zoom {
                    self.zoom = z;
                    self.zoom_one = true;
                }
                self.selected = self.script.select;
                self.playing = self.script.play;
                self.bench = None;
            }
            Ok(Err(e)) => {
                self.error = Some(format!("{}: {e}", path.display()));
                self.loading = None;
            }
            Err(_) => {}
        }
    }

    fn set_tick(&mut self, tick: u32) {
        let total = self.engine.as_ref().map(|e| e.total_ticks()).unwrap_or(1).max(1);
        self.tick = tick.min(total - 1);
        self.playhead = self.tick as f64;
    }

    fn advance(&mut self) {
        let now = Instant::now();
        let Some(engine) = &self.engine else { return };
        let total = engine.total_ticks().max(1);
        if self.playing {
            let dt = self.last_instant.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0).min(0.25);
            self.playhead += dt * engine.doc().fps;
            if self.playhead >= total as f64 {
                if self.looping {
                    self.playhead %= total as f64;
                } else {
                    self.playhead = (total - 1) as f64;
                    self.playing = false;
                }
            }
            self.tick = (self.playhead.floor() as u32).min(total - 1);
        }
        self.last_instant = Some(now);
    }

    fn key_ticks(&self) -> Vec<u32> {
        self.engine.as_ref().map(|e| e.prepared.key_ticks()).unwrap_or_default()
    }

    fn step_key(&mut self, forward: bool) {
        let keys = self.key_ticks();
        let next = if forward { keys.iter().copied().find(|&k| k > self.tick) } else { keys.iter().rev().copied().find(|&k| k < self.tick) };
        if let Some(k) = next {
            self.playing = false;
            self.set_tick(k);
        }
    }

    fn shortcuts(&mut self, ctx: &egui::Context) {
        let (space, left, right, home, end, comma, period, undo, redo, open, fit, one, files) = ctx.input(|i| {
            let cmd = i.modifiers.command;
            (
                i.key_pressed(egui::Key::Space),
                i.key_pressed(egui::Key::ArrowLeft),
                i.key_pressed(egui::Key::ArrowRight),
                i.key_pressed(egui::Key::Home),
                i.key_pressed(egui::Key::End),
                i.key_pressed(egui::Key::Comma),
                i.key_pressed(egui::Key::Period),
                cmd && i.key_pressed(egui::Key::Z) && !i.modifiers.shift,
                cmd && (i.key_pressed(egui::Key::Y) || (i.key_pressed(egui::Key::Z) && i.modifiers.shift)),
                cmd && i.key_pressed(egui::Key::O),
                !cmd && i.key_pressed(egui::Key::F),
                !cmd && i.key_pressed(egui::Key::Num0),
                i.raw.dropped_files.clone(),
            )
        });
        if ctx.egui_wants_keyboard_input() {
            return;
        }
        if space && self.engine.is_some() {
            self.playing = !self.playing;
            self.last_instant = None;
        }
        if left {
            self.playing = false;
            self.set_tick(self.tick.saturating_sub(1));
        }
        if right {
            self.playing = false;
            self.set_tick(self.tick + 1);
        }
        if home {
            self.set_tick(0);
        }
        if end {
            self.set_tick(u32::MAX);
        }
        if comma {
            self.step_key(false);
        }
        if period {
            self.step_key(true);
        }
        if undo && let Some(e) = &mut self.engine {
            e.undo();
        }
        if redo && let Some(e) = &mut self.engine {
            e.redo();
        }
        if open {
            self.open_dialog(ctx);
        }
        if fit {
            self.fit_pending = true;
        }
        if one {
            self.zoom = 1.0;
            self.fit_pending = true;
            self.zoom_one = true;
        }
        if let Some(path) = files.first().map(|f| f.path().to_path_buf()) {
            self.open(path, ctx);
        }
    }

    fn open_dialog(&mut self, ctx: &egui::Context) {
        let mut dialog = rfd::FileDialog::new().add_filter("Animations", &["piv", "styk", "stkz", "stykmov"]);
        if let Some(home) = std::env::var_os("HOME") {
            dialog = dialog.set_directory(PathBuf::from(home).join("Downloads"));
        }
        if let Some(path) = dialog.pick_file() {
            self.open(path, ctx);
        }
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let started = Instant::now();
        self.finish_loading();
        self.shortcuts(&ctx);
        self.advance();
        if let Some(e) = &mut self.engine {
            e.poll();
        }
        self.top_bar(ui, &ctx);
        self.files_panel(ui, &ctx);
        if self.show_stats {
            self.stats_panel(ui);
        }
        self.transport(ui);
        egui::CentralPanel::no_frame().show(ui, |ui| self.stage(ui));
        let dt = ctx.input(|i| i.unstable_dt) * 1000.0;
        self.frame_times.push_back(dt);
        while self.frame_times.len() > 120 {
            self.frame_times.pop_front();
        }
        self.last_frame_ms = started.elapsed().as_secs_f32() * 1000.0;
        if self.playing || self.loading.is_some() {
            ctx.request_repaint();
        }
        self.run_script(&ctx);
    }
}

impl App {
    /// `--screenshot`, `--measure`, `--exit` automation.
    fn run_script(&mut self, ctx: &egui::Context) {
        if self.engine.is_none() {
            return;
        }
        self.script_frames += 1;
        ctx.request_repaint();
        for event in ctx.input(|i| i.raw.events.clone()) {
            if let egui::Event::Screenshot { image, .. } = event
                && let Some(path) = self.script.screenshot.take()
            {
                let [w, h] = image.size;
                let _ = image::save_buffer(&path, image.as_raw(), w as u32, h as u32, image::ColorType::Rgba8);
                println!("screenshot {} ({w}x{h})", path.display());
                if self.script.exit && !self.script.bench {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
            }
        }
        if self.script.bench && self.script_frames > 20 {
            if self.bench.is_none() {
                self.bench = Some(Bench::new());
            }
            if self.step_bench() {
                self.script.bench = false;
                if self.script.exit && self.script.screenshot.is_none() {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
            }
        }
        if self.script.screenshot.is_some() && self.script_frames == 30 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
        }
        if self.script.exit && self.script.screenshot.is_none() && !self.script.bench && self.script_frames > 40 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }

    /// Advances the scripted benchmark; returns true when every phase is done.
    fn step_bench(&mut self) -> bool {
        let now = Instant::now();
        let work = self.last_frame_ms;
        let (cw, ch) = match &self.engine {
            Some(e) => (e.doc().canvas[0] as f64, e.doc().canvas[1] as f64),
            None => return true,
        };
        let name = self.engine.as_ref().unwrap().path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let size = self.stage_size;
        let mut b = self.bench.take().unwrap();
        let fit = ((size.x as f64 - 64.0) / cw).min((size.y as f64 - 64.0) / ch).max(0.01);
        // Centre the canvas at a zoom, keeping the stage centre fixed.
        let place = |app: &mut App, zoom: f64, shift: f64| {
            app.zoom = zoom;
            app.pan = Vec2::new(((size.x as f64 - cw * zoom) / 2.0 + shift) as f32, ((size.y as f64 - ch * zoom) / 2.0) as f32);
        };
        let mut done = false;
        let mut next = false;
        match b.phase {
            // 0: one full playback pass from the first frame.
            0 => {
                if b.started.is_none() {
                    b.started = Some(now);
                    b.fit = fit;
                    place(self, fit, 0.0);
                    self.set_tick(0);
                    self.looping = false;
                    self.playing = true;
                    self.last_instant = None;
                    let e = self.engine.as_ref().unwrap();
                    b.sync_before = e.stats.sync_frames;
                    b.misses_before = self.playback_misses;
                } else {
                    if b.presented.last().is_none_or(|p| p.0 != self.tick) {
                        b.presented.push((self.tick, now));
                    }
                    if !self.playing {
                        let e = self.engine.as_ref().unwrap();
                        let gaps: Vec<f32> = b.presented.windows(2).map(|w| w[1].1.duration_since(w[0].1).as_secs_f32() * 1000.0).collect();
                        let sequential = b.presented.windows(2).all(|w| w[1].0 == w[0].0 + 1);
                        let wall = b.presented.last().unwrap().1.duration_since(b.presented[0].1).as_secs_f64() * 1000.0;
                        let rss = std::fs::read_to_string("/proc/self/status")
                            .ok()
                            .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<u64>().ok()))
                            .unwrap_or(0)
                            / 1024;
                        println!("BENCH {{\"file\":{:?},\"phase\":\"memory\",\"rssMiB\":{rss},\"cachedFrames\":{},\"cachedMiB\":{}}}", name, e.cached_frames(), e.cached_bytes() / (1 << 20));
                        println!(
                            "BENCH {{\"file\":{:?},\"phase\":\"playback\",\"fps\":{},\"frames\":{},\"ticks\":{},\"sequential\":{},\"wallMs\":{:.0},\"gaps\":{},\"preparedOnUiThread\":{},\"misses\":{},\"prepareMsAvg\":{:.2},\"prepareMsWorst\":{:.2}}}",
                            name,
                            e.doc().fps,
                            b.presented.len(),
                            e.total_ticks(),
                            sequential,
                            wall,
                            quantiles(gaps),
                            e.stats.sync_frames - b.sync_before,
                            self.playback_misses - b.misses_before,
                            if e.stats.produced > 0 { e.stats.produce_ms_total / e.stats.produced as f64 } else { 0.0 },
                            e.stats.produce_ms_worst
                        );
                        next = true;
                    }
                }
            }
            // 1: zoom from fit to 11x and back (2.4 octaves), paused; 2: the same while playing.
            1 | 3 => {
                if b.started.is_none() {
                    b.started = Some(now);
                    self.playing = b.phase == 3;
                    self.looping = true;
                    self.last_instant = None;
                    if b.phase == 1 {
                        self.set_tick(self.script.tick.unwrap_or(0));
                    }
                } else {
                    let t = now.duration_since(b.started.unwrap()).as_secs_f64() / 4.0;
                    let tri = if t < 0.5 { t * 2.0 } else { 2.0 - t * 2.0 };
                    place(self, b.fit * (2.4 * tri.max(0.0)).exp(), 0.0);
                    if let Some(l) = b.last {
                        b.intervals.push(now.duration_since(l).as_secs_f32() * 1000.0);
                        b.work.push(work);
                    }
                    if t >= 1.0 {
                        println!(
                            "BENCH {{\"file\":{:?},\"phase\":\"{}\",\"intervals\":{},\"uiWorkMs\":{}}}",
                            name,
                            if b.phase == 1 { "zoom" } else { "zoom-while-playing" },
                            quantiles(std::mem::take(&mut b.intervals)),
                            quantiles(std::mem::take(&mut b.work))
                        );
                        next = true;
                    }
                }
            }
            // 2: pan back and forth at 8x zoom, paused.
            2 => {
                if b.started.is_none() {
                    b.started = Some(now);
                    self.playing = false;
                    self.set_tick(self.script.tick.unwrap_or(0));
                } else {
                    let t = now.duration_since(b.started.unwrap()).as_secs_f64();
                    place(self, b.fit * 8.0, 900.0 * (t * std::f64::consts::TAU / 1.5).sin());
                    if let Some(l) = b.last {
                        b.intervals.push(now.duration_since(l).as_secs_f32() * 1000.0);
                        b.work.push(work);
                    }
                    if t >= 3.0 {
                        println!(
                            "BENCH {{\"file\":{:?},\"phase\":\"pan\",\"intervals\":{},\"uiWorkMs\":{}}}",
                            name,
                            quantiles(std::mem::take(&mut b.intervals)),
                            quantiles(std::mem::take(&mut b.work))
                        );
                        next = true;
                    }
                }
            }
            // 4: posing — rotate one limb back and forth at a key for 3 s.
            4 => {
                if b.started.is_none() {
                    b.started = Some(now);
                    self.playing = false;
                    self.set_tick(0);
                    let engine = self.engine.as_mut().unwrap();
                    let (frame, scene) = engine.scene(0);
                    // The free figure with the most segments, turning its first dynamic limb.
                    let mut best: Option<(PoseRef, Arc<Object>, usize, usize)> = None;
                    for (slot, o) in frame.objects.iter().enumerate() {
                        let Some((frame_ref, src)) = frame.origins.get(slot).cloned().flatten() else { continue };
                        let Some(fig) = scene.figures.iter().find(|f| f.id == o.figure) else { continue };
                        if fig.movieclip.is_some() || o.join.is_some() {
                            continue;
                        }
                        let Some(i) = fig.segments.iter().position(|s| !s.is_static && s.parent != 0) else { continue };
                        if best.as_ref().is_none_or(|b| fig.segments.len() > b.3) {
                            let at = PoseRef { frame: frame_ref, slot: src };
                            if let Some(before) = engine.object(&at) {
                                best = Some((at, before, i, fig.segments.len()));
                            }
                        }
                    }
                    match best {
                        Some((at, before, i, _)) => b.pose = Some((at, before, i)),
                        None => next = true,
                    }
                } else if let Some((at, before, index)) = b.pose.clone() {
                    let t = now.duration_since(b.started.unwrap()).as_secs_f64();
                    let engine = self.engine.as_mut().unwrap();
                    let edit_start = Instant::now();
                    let base = before.angles.get(index).copied().unwrap_or(0.0);
                    let doc = engine.doc();
                    if let Some(obj) = edit::rotate(doc, &before, index, base + 0.6 * (t * std::f64::consts::TAU).sin())
                        && let Some(next_doc) = edit::replace(doc, &at, Arc::new(obj))
                    {
                        engine.publish(next_doc);
                        let _ = engine.frame(self.tick);
                        let _ = engine.scene(self.tick);
                    }
                    b.edit_ms.push(edit_start.elapsed().as_secs_f32() * 1000.0);
                    if let Some(l) = b.last {
                        b.intervals.push(now.duration_since(l).as_secs_f32() * 1000.0);
                    }
                    if t >= 3.0 {
                        if let Some(doc) = edit::replace(engine.doc(), &at, before) {
                            engine.publish(doc);
                        }
                        println!(
                            "BENCH {{\"file\":{:?},\"phase\":\"pose\",\"intervals\":{},\"editToFrameMs\":{}}}",
                            name,
                            quantiles(std::mem::take(&mut b.intervals)),
                            quantiles(std::mem::take(&mut b.edit_ms))
                        );
                        next = true;
                    }
                }
            }
            _ => done = true,
        }
        b.last = Some(now);
        if next {
            b.phase += 1;
            b.started = None;
            b.last = None;
            b.presented.clear();
        }
        self.bench = Some(b);
        done
    }

    fn top_bar(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        egui::Panel::top("top").frame(theme::bar()).exact_size(44.0).show(ui, |ui| {
            ui.horizontal_centered(|ui| {
                ui.label(RichText::new("StykAnimate").strong().size(15.0).color(theme::TEXT_1));
                ui.label(RichText::new("Native engine · experiment").size(12.0).color(theme::TEXT_3));
                ui.add_space(16.0);
                if ui.add(theme::button("Open…")).on_hover_text("Ctrl+O, or drop a file on the window").clicked() {
                    self.open_dialog(ctx);
                }
                if let Some(e) = &self.engine {
                    ui.add_space(8.0);
                    ui.label(RichText::new(e.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).color(theme::TEXT_1));
                    let d = e.doc();
                    ui.label(
                        RichText::new(format!("{}×{} · {} fps · {} ticks · v{}", d.canvas[0], d.canvas[1], d.fps, e.total_ticks(), d.version))
                            .color(theme::TEXT_3),
                    );
                    if !d.unsupported.is_empty() {
                        ui.add_space(8.0);
                        theme::chip(ui, "Partial", theme::WARNING)
                            .on_hover_text(format!("This prototype does not evaluate yet: {}", d.unsupported.join(", ")));
                    }
                }
                if let Some((path, _, since)) = &self.loading {
                    ui.add_space(8.0);
                    ui.spinner();
                    ui.label(
                        RichText::new(format!("Opening {} · {:.1} s", path.file_name().unwrap_or_default().to_string_lossy(), since.elapsed().as_secs_f32()))
                            .color(theme::TEXT_2),
                    );
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.toggle_value(&mut self.show_stats, "Performance");
                });
            });
        });
    }

    fn files_panel(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        egui::Panel::left("files").frame(theme::panel()).resizable(true).default_size(230.0).show(ui, |ui| {
            ui.label(RichText::new("Files").strong().color(theme::TEXT_1));
            ui.add_space(4.0);
            let mut open = None;
            egui::ScrollArea::vertical().show(ui, |ui| {
                for (label, files) in &self.files {
                    ui.add_space(6.0);
                    ui.label(RichText::new(label).size(11.0).color(theme::TEXT_3));
                    for path in files {
                        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        let current = self.engine.as_ref().is_some_and(|e| &e.path == path);
                        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                        let text = RichText::new(name).color(if current { theme::ACCENT_TEXT } else { theme::TEXT_1 });
                        if ui.add(egui::Button::selectable(current, text).right_text(RichText::new(human(size)).size(11.0).color(theme::TEXT_3))).clicked() {
                            open = Some(path.clone());
                        }
                    }
                }
                if self.files.is_empty() {
                    ui.label(RichText::new("No .piv or .styk files in Downloads.").color(theme::TEXT_3));
                }
            });
            if let Some(p) = open {
                self.open(p, ctx);
            }
        });
    }

    fn stats_panel(&mut self, ui: &mut egui::Ui) {
        egui::Panel::right("stats").frame(theme::panel()).resizable(true).default_size(260.0).show(ui, |ui| {
            ui.label(RichText::new("Performance").strong().color(theme::TEXT_1));
            ui.add_space(6.0);
            let mut times: Vec<f32> = self.frame_times.iter().copied().collect();
            times.sort_by(|a, b| a.total_cmp(b));
            let avg = if times.is_empty() { 0.0 } else { times.iter().sum::<f32>() / times.len() as f32 };
            let p95 = times.get(times.len().saturating_sub(1) * 95 / 100).copied().unwrap_or(0.0);
            row(ui, "Display rate", format!("{:.0} fps", if avg > 0.0 { 1000.0 / avg } else { 0.0 }));
            row(ui, "Frame interval p95", format!("{p95:.1} ms"));
            row(ui, "UI work this frame", format!("{:.2} ms", self.last_frame_ms));
            ui.separator();
            if let Some(e) = &self.engine {
                let s = &e.stats;
                row(ui, "Frames prepared", format!("{}", s.produced));
                row(ui, "Avg preparation", format!("{:.2} ms", if s.produced > 0 { s.produce_ms_total / s.produced as f64 } else { 0.0 }));
                row(ui, "Worst preparation", format!("{:.2} ms", s.produce_ms_worst));
                row(ui, "Prepared on UI thread", format!("{}", s.sync_frames));
                row(ui, "Playback misses", format!("{}", self.playback_misses));
                row(ui, "Cached frames", format!("{} ({})", e.cached_frames(), human(e.cached_bytes() as u64)));
                ui.separator();
                row(ui, "Opened in", format!("{:.0} ms", e.open_ms));
                row(ui, "Images decoded in", format!("{:.0} ms", e.assets_ms));
                let d = e.doc();
                row(ui, "Figures", format!("{} ({} segments)", d.figures.len(), d.segment_count()));
                row(ui, "Images", format!("{} in {} atlas pages", d.images.len(), e.assets.pages));
            }
            ui.separator();
            ui.label(RichText::new(&self.gpu_name).size(11.0).color(theme::TEXT_3));
            ui.add_space(8.0);
            ui.checkbox(&mut self.clip, "Clip to canvas");
            ui.checkbox(&mut self.show_handles, "Show handles when paused");
            ui.checkbox(&mut self.all_handles, "Handles on every figure");
            ui.add_space(8.0);
            ui.label(RichText::new("Space play · Left/Right step · ,/. keys · wheel zoom · middle/right drag pan · F fit · 0 100% · Ctrl+Z/Y undo/redo · Ctrl-drag stretch").size(11.0).color(theme::TEXT_3));
        });
    }

    fn transport(&mut self, ui: &mut egui::Ui) {
        egui::Panel::bottom("transport").frame(theme::bar()).exact_size(78.0).show(ui, |ui| {
            let Some(engine) = &self.engine else {
                ui.centered_and_justified(|ui| ui.label(RichText::new("Open a .piv or .styk file to begin.").color(theme::TEXT_3)));
                return;
            };
            let total = engine.total_ticks().max(1);
            let keys = engine.prepared.key_ticks();
            let fps = engine.doc().fps;
            ui.horizontal(|ui| {
                if ui.add(theme::icon_button("⏮")).on_hover_text("First frame (Home)").clicked() {
                    self.set_tick(0);
                }
                if ui.add(theme::icon_button("⏪")).on_hover_text("Previous key (,)").clicked() {
                    self.step_key(false);
                }
                let label = if self.playing { "⏸" } else { "▶" };
                if ui.add(theme::primary_button(label)).on_hover_text("Play/pause (Space)").clicked() {
                    self.playing = !self.playing;
                    self.last_instant = None;
                }
                if ui.add(theme::icon_button("⏩")).on_hover_text("Next key (.)").clicked() {
                    self.step_key(true);
                }
                if ui.add(theme::icon_button("⏭")).on_hover_text("Last frame (End)").clicked() {
                    self.set_tick(u32::MAX);
                }
                ui.toggle_value(&mut self.looping, "Loop");
                ui.add_space(12.0);
                ui.label(RichText::new(format!("{} / {}", self.tick + 1, total)).monospace().color(theme::TEXT_1));
                ui.label(RichText::new(format!("{:.2} s", self.tick as f64 / fps)).monospace().color(theme::TEXT_3));
                if self.playing {
                    ui.label(RichText::new("Playing").color(theme::ACCENT_TEXT));
                } else if keys.binary_search(&self.tick).is_ok() {
                    ui.label(RichText::new("Key · drag handles to pose").color(theme::TEXT_2));
                } else {
                    ui.label(RichText::new("In-between · go to a key (,/.) to pose").color(theme::TEXT_3));
                }
            });
            // Timeline strip.
            let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 26.0), Sense::click_and_drag());
            let painter = ui.painter_at(rect);
            painter.rect_filled(rect, CornerRadius::same(6), theme::SURFACE_SUNKEN);
            let x_of = |t: f64| rect.left() + 6.0 + (rect.width() - 12.0) * (t / total.max(1) as f64) as f32;
            for &k in &keys {
                let x = x_of(k as f64);
                painter.line_segment([Pos2::new(x, rect.top() + 5.0), Pos2::new(x, rect.bottom() - 5.0)], Stroke::new(1.0, theme::LINE_3));
            }
            let x = x_of(self.tick as f64 + 0.5);
            painter.rect_filled(Rect::from_center_size(Pos2::new(x, rect.center().y), Vec2::new(3.0, rect.height() - 4.0)), CornerRadius::same(2), theme::ACCENT);
            if (response.dragged() || response.clicked())
                && let Some(p) = response.interact_pointer_pos()
            {
                let t = ((p.x - rect.left() - 6.0) / (rect.width() - 12.0)).clamp(0.0, 1.0) as f64 * total as f64;
                self.playing = false;
                self.set_tick(t.floor() as u32);
            }
        });
    }

    fn stage(&mut self, ui: &mut egui::Ui) {
        let rect = ui.available_rect_before_wrap();
        self.stage_size = rect.size();
        let response = ui.allocate_rect(rect, Sense::click_and_drag());
        ui.painter().rect_filled(rect, CornerRadius::ZERO, theme::STAGE);
        let Some(engine) = &mut self.engine else {
            if let Some(err) = &self.error {
                ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, err, egui::FontId::proportional(14.0), theme::DANGER);
            }
            return;
        };
        let (cw, ch) = (engine.doc().canvas[0] as f64, engine.doc().canvas[1] as f64);
        if std::mem::take(&mut self.fit_pending) {
            if !std::mem::take(&mut self.zoom_one) {
                self.zoom = ((rect.width() as f64 - 64.0) / cw).min((rect.height() as f64 - 64.0) / ch).max(0.01);
            }
            self.pan = Vec2::new(((rect.width() as f64 - cw * self.zoom) / 2.0) as f32, ((rect.height() as f64 - ch * self.zoom) / 2.0) as f32);
        }
        let total = engine.total_ticks().max(1);
        self.tick = self.tick.min(total - 1);
        // Frame for this tick: from the prefetch cache when playing.
        let data = match engine.get(self.tick) {
            Some(d) => d,
            None => {
                if self.playing {
                    self.playback_misses += 1;
                }
                engine.frame(self.tick)
            }
        };
        self.shown += 1;
        let lookahead = (engine.doc().fps * 1.5).clamp(16.0, 240.0) as u32;
        if self.playing {
            let start = self.tick;
            engine.prefetch((1..=lookahead).map(|k| (start + k) % total));
        } else {
            let t = self.tick;
            engine.prefetch([t + 1, t.saturating_sub(1), t + 2, t + 3].into_iter().filter(|&x| x < total));
        }
        engine.after_tick(self.tick);

        // Input: zoom around the pointer, pan with middle/right drag (or Shift+scroll).
        let ppp = ui.ctx().pixels_per_point() as f64;
        let (scroll, zoom_delta, modifiers, pointer) = ui.input(|i| (i.smooth_scroll_delta, i.zoom_delta(), i.modifiers, i.pointer.hover_pos()));
        if response.hovered() {
            let mut factor = zoom_delta as f64;
            if modifiers.shift {
                self.pan += Vec2::new(scroll.y + scroll.x, 0.0);
            } else {
                factor *= (scroll.y as f64 * 0.0025).exp();
                self.pan.x += scroll.x;
            }
            if (factor - 1.0).abs() > 1e-6
                && let Some(p) = pointer
            {
                let new_zoom = (self.zoom * factor).clamp(0.001, 100.0);
                let local = p - rect.min;
                let f = (new_zoom / self.zoom) as f32;
                self.pan = local - (local - self.pan) * f;
                self.zoom = new_zoom;
            }
        }
        if response.drag_started_by(egui::PointerButton::Middle) || response.drag_started_by(egui::PointerButton::Secondary) {
            self.panning = true;
        }
        if self.panning {
            self.pan += response.drag_delta();
            if response.drag_stopped() {
                self.panning = false;
            }
        }

        // World ↔ screen.
        let pan_px = [(rect.min.x as f64 + self.pan.x as f64), (rect.min.y as f64 + self.pan.y as f64)];
        let to_points = camera_matrix(engine.doc(), data.camera.as_ref(), self.zoom, pan_px);
        let to_world = invert(to_points);
        let matrix = camera_matrix(engine.doc(), data.camera.as_ref(), self.zoom * ppp, [self.pan.x as f64 * ppp, self.pan.y as f64 * ppp]);
        let size = [(rect.width() as f64 * ppp).round() as u32, (rect.height() as f64 * ppp).round() as u32];
        let artboard = [self.pan.x as f64 * ppp, self.pan.y as f64 * ppp, (self.pan.x as f64 + cw * self.zoom) * ppp, (self.pan.y as f64 + ch * self.zoom) * ppp];
        let view = ViewParams { matrix, artboard, clip_to_artboard: self.clip, clear: theme::STAGE_LINEAR };
        let stage = Stage { list: data.list.clone(), view, size, sprites: (engine.assets.clone(), engine.images.clone()) };
        ui.painter().add(eframe::egui_wgpu::Callback::new_paint_callback(rect, stage));
        // Artboard frame.
        let a = Rect::from_min_size(rect.min + self.pan, Vec2::new((cw * self.zoom) as f32, (ch * self.zoom) as f32));
        ui.painter().rect_stroke(a, CornerRadius::ZERO, Stroke::new(1.0, theme::LINE_2), egui::StrokeKind::Outside);

        // Posing (paused only). Only exactly authored poses carry an origin.
        if self.playing || !self.show_handles {
            self.drag = None;
            return;
        }
        let (frame, scene) = engine.scene(self.tick);
        let handles = collect_handles(&scene, &frame, to_points, self.zoom, self.selected, self.all_handles);
        let painter = ui.painter_at(rect);
        for h in &handles {
            painter.circle(h.pos, h.radius, h.color, Stroke::new(1.0, Color32::from_black_alpha(160)));
        }
        let pointer_world = |p: Pos2| apply(to_world, [p.x as f64, p.y as f64]);
        if response.drag_started_by(egui::PointerButton::Primary)
            && let Some(p) = response.interact_pointer_pos()
        {
            let hit = handles.iter().rev().find(|h| h.pos.distance(p) <= h.radius.max(6.0)).cloned();
            match hit {
                Some(h) => {
                    self.selected = Some(h.uid);
                    let origin = frame.origins.get(h.slot as usize).cloned().flatten();
                    if let Some((frame_ref, slot)) = origin {
                        let at = PoseRef { frame: frame_ref, slot };
                        if let Some(before) = engine.object(&at) {
                            self.drag = Some(Drag { at, before, index: h.index, start_world: pointer_world(p), stretch: modifiers.command });
                        }
                    }
                }
                None => self.selected = pick_figure(&scene, pointer_world(p), 6.0 / self.zoom),
            }
        } else if response.clicked_by(egui::PointerButton::Primary)
            && let Some(p) = response.interact_pointer_pos()
        {
            let hit = handles.iter().rev().find(|h| h.pos.distance(p) <= h.radius.max(6.0));
            self.selected = match hit {
                Some(h) => Some(h.uid),
                None => pick_figure(&scene, pointer_world(p), 6.0 / self.zoom),
            };
        }
        if let Some(drag) = &self.drag
            && let Some(p) = response.interact_pointer_pos().or(pointer)
            && response.dragged_by(egui::PointerButton::Primary)
        {
            let w = pointer_world(p);
            let doc = engine.doc();
            let edited = match drag.index {
                None => Some(edit::translate(&drag.before, w[0] - drag.start_world[0], w[1] - drag.start_world[1])),
                Some(index) => {
                    let geom = scene.objects.iter().find(|g| g.uid == drag.before.uid && g.resolved);
                    geom.and_then(|g| {
                        let start = g.starts[index];
                        let fig = doc.figure(drag.before.figure)?;
                        let bend = drag.before.bends.as_ref().and_then(|b| b.get(index).copied()).unwrap_or(fig.segments[index].bend);
                        let angle = (w[1] - start[1]).atan2(w[0] - start[0]) - bend / 2.0;
                        let rotated = edit::rotate(doc, &drag.before, index, angle)?;
                        if drag.stretch {
                            let chord = (w[0] - start[0]).hypot(w[1] - start[1]);
                            // A bent segment's chord is length·sinc(bend/2).
                            let ratio = if bend.abs() > 1e-7 { (bend / 2.0).sin() / (bend / 2.0) } else { 1.0 };
                            let length = chord / ratio / drag.before.scale.abs().max(1e-9);
                            edit::stretch(doc, &rotated, index, length)
                        } else {
                            Some(rotated)
                        }
                    })
                }
            };
            if let Some(obj) = edited
                && let Some(next) = edit::replace(doc, &drag.at, Arc::new(obj))
            {
                engine.publish(next);
            }
        }
        if response.drag_stopped_by(egui::PointerButton::Primary)
            && let Some(drag) = self.drag.take()
            && let Some(after) = engine.object(&drag.at)
        {
            engine.history.record(Change { at: drag.at, before: drag.before, after });
        }
    }
}

fn row(ui: &mut egui::Ui, label: &str, value: String) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).color(theme::TEXT_2));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(value).monospace().color(theme::TEXT_1));
        });
    });
}

fn human(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1e9 {
        format!("{:.1} GB", b / 1e9)
    } else if b >= 1e6 {
        format!("{:.1} MB", b / 1e6)
    } else if b >= 1e3 {
        format!("{:.0} KB", b / 1e3)
    } else {
        format!("{bytes} B")
    }
}

/// Pivot's handles: an origin per free figure, a node per dynamic segment.
fn collect_handles(scene: &Scene, frame: &styk_core::eval::Frame, to_points: [f64; 6], zoom: f64, selected: Option<u32>, all: bool) -> Vec<Handle> {
    let mut out = Vec::new();
    for &slot in &frame.draw_order {
        let Some(g) = scene.objects.get(slot as usize).filter(|g| g.resolved) else { continue };
        let is_selected = selected == Some(g.uid);
        if !all && !is_selected {
            continue;
        }
        let object = &frame.objects[slot as usize];
        let Some(fig) = scene.figures.iter().find(|f| f.id == g.figure) else { continue };
        if fig.movieclip.is_some() {
            continue;
        }
        let point = |p: [f64; 2]| {
            let s = apply(to_points, p);
            Pos2::new(s[0] as f32, s[1] as f32)
        };
        let radius = |len: f64| (0.5 * (0.7 * len * object.scale.abs() * zoom).clamp(4.0, 10.0)).clamp(2.0, 5.0) as f32;
        if object.join.is_none() {
            out.push(Handle {
                uid: g.uid,
                slot,
                index: None,
                pos: point(g.root),
                radius: 4.0,
                color: if is_selected { HANDLE_ORIGIN } else { HANDLE_UNSELECTED_ORIGIN },
            });
        }
        for (i, seg) in fig.segments.iter().enumerate() {
            if seg.is_static || g.ends[i][0].is_nan() {
                continue;
            }
            let len = object.lengths.as_ref().and_then(|l| l.get(i).copied()).unwrap_or(seg.length).abs();
            out.push(Handle {
                uid: g.uid,
                slot,
                index: Some(i),
                pos: point(g.ends[i]),
                radius: radius(len),
                color: if is_selected { HANDLE_SEGMENT } else { HANDLE_UNSELECTED },
            });
        }
    }
    out
}

/// The topmost figure with a stroke near `p` (world units).
fn pick_figure(scene: &Scene, p: [f64; 2], tolerance: f64) -> Option<u32> {
    for it in scene.items.iter().rev() {
        let (a, b) = (it.start, it.end);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
        let d = (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy);
        if d <= it.thickness / 2.0 + tolerance {
            return scene.objects.get(it.slot as usize).map(|g| g.uid);
        }
    }
    None
}

/// Lowers the calling thread's scheduling priority (Linux nice +10).
fn lower_priority() {
    #[cfg(target_os = "linux")]
    unsafe {
        unsafe extern "C" {
            fn setpriority(which: i32, who: u32, prio: i32) -> i32;
            fn gettid() -> i32;
        }
        let _ = setpriority(0, gettid() as u32, 10);
    }
}
