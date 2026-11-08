//! `styk video`: a video export of a document, headless, through the same planning, frame source, flow and encoder
//! services the app uses (`docs/native/video-export.md`).
//!
//!   styk video <file> <first-last> <out> [--format mp4|webm|avi|wmv|vfw] [--codec h264|mpeg4|ffv1|rawvideo|..]
//!              [--quality draft|great|max] [--bitrate MBPS] [--size WxH] [--smoothing edges|none|sprites]
//!              [--fps F] [--audio mix.f32] [--max-bytes N] [--cpu] [--ffmpeg PATH] [--json]
//!              [--vfw-arch x64|x86 --vfw-handler N [--vfw-quality] [--vfw-keyframes N] [--vfw-data-rate]]
//!   Hooks for the tests of the export path (they disturb it from outside, as a stalled program would):
//!              [--suspend-child-at-frame N --suspend-secs S] [--pause-producer-at-frame N --pause-secs S]
//!              [--transparent] [--ticker] [--cancel-at-frame N] [--cancel-after-ms N] [--sample-frames N,N,..] [--no-encode --frame-hashes FILE
//!              --order forward|reverse|shuffle|interleave [--with ANOTHER_DOCUMENT]]
//!
//! Ticks are 0-based and inclusive, as in `styk export`. One JSON line on standard output with `--json`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use styk_core::export::flow::{run_video_export, AudioSource, FrameProducer};
use styk_core::export::{plan_video, AudioClip, JobContext, VideoFields};
use styk_engine::{Budgets, Engine};
use styk_export::{CpuExport, FrameRenderer, GpuExport, Settings, Smoothing};
use styk_platform::video::{FfmpegVideoService, VfwVideoService};
use styk_render::wgpu;
use styk_services::video::{Arch, FrameLayout, VfwRequest, VideoError, VideoRequest, VideoService};
use styk_services::Cancel;

use styk_platform::diagnostics as win;

fn option<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).map(String::as_str)
}

fn flag(rest: &[String], name: &str) -> bool {
    rest.iter().any(|a| a == name)
}

fn number<T: std::str::FromStr>(rest: &[String], name: &str) -> Result<Option<T>, String> {
    option(rest, name).map(|v| v.parse::<T>().map_err(|_| format!("{name} needs a number, not {v:?}"))).transpose()
}

fn clock() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// `WxH` with whole pixel counts: anything else is refused with a message (never replaced by the canvas size).
fn parse_size(text: &str) -> Result<(u32, u32), String> {
    let bad = || format!("--size is WxH in whole pixels (for example 1920x1080), not {text:?}");
    let (width, height) = text.split_once('x').ok_or_else(bad)?;
    let whole = |part: &str| part.parse::<u32>().ok().filter(|n| *n > 0 && part.bytes().all(|b| b.is_ascii_digit()));
    Ok((whole(width).ok_or_else(bad)?, whole(height).ok_or_else(bad)?))
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// What a drawn frame goes through before it is handed to the session: the mapping of today's canvas step when the layout asks
/// for it (WebM with transparency; see `styk_export::legacy_canvas`).
fn finish_frame(layout: &FrameLayout, frame: &mut Vec<u8>) {
    if layout.legacy_canvas {
        styk_export::legacy_canvas::apply(frame);
    }
}

/// Entry of `styk video` (built with the `app-tools` feature).
pub fn video(path: &str, ticks: &str, out: &str, rest: &[String]) -> i32 {
    match run(path, ticks, out, rest) {
        Ok(summary) => {
            println!("{summary}");
            0
        }
        Err(summary) => {
            println!("{summary}");
            1
        }
    }
}

/// What the producer measures while it draws.
#[derive(Default)]
struct Timings {
    evaluate_ms: f64,
    draw_ms: f64,
    /// (frame, this process, the encoder), private bytes.
    samples: Vec<(u32, usize, usize)>,
}

struct Producer {
    engine: Engine,
    frames: styk_engine::export::ExportFrames,
    renderer: FrameRenderer,
    order: Vec<u32>,
    pause: Option<(u32, f64)>,
    cancel_at: Option<(u32, Cancel, Arc<Mutex<Option<Instant>>>)>,
    sample: Vec<u32>,
    child: Arc<AtomicU32>,
    timings: Arc<Mutex<Timings>>,
    transparent: bool,
    memory: Option<crate::memory::Log>,
}

impl FrameProducer for Producer {
    fn frame_into(&mut self, index: u32, layout: &FrameLayout, out: &mut Vec<u8>) -> Result<(), String> {
        if let Some((at, cancel, when)) = &self.cancel_at
            && *at == index
        {
            *when.lock().unwrap() = Some(Instant::now());
            cancel.cancel();
        }
        if let Some((at, seconds)) = self.pause
            && at == index
        {
            std::thread::sleep(Duration::from_secs_f64(seconds));
        }
        let tick = self.order[index as usize];
        let started = Instant::now();
        let frame = self.frames.take(tick).ok_or("no frame")?;
        let drawing = Instant::now();
        let list = if self.transparent { styk_export::without_background(&frame.list) } else { frame.list.clone() };
        self.renderer.prepare_frame(&self.engine, &self.frames, &list)?;
        let next_tick = self.order.get(index as usize + 1).copied();
        let interrupt = self.renderer.interrupt();
        self.renderer.frame_with_prefetch(&self.engine, &self.frames, &list, frame.camera.as_ref(), layout.matte, out, || {
            let Some(tick) = next_tick else { return Ok(None) };
            self.frames.prefetch([tick]);
            loop {
                if interrupt.is_interrupted() { return Err(styk_export::interrupt::INTERRUPTED.into()); }
                if let Some(next) = self.frames.ready(tick) {
                    return Ok(Some(if self.transparent { styk_export::without_background(&next.list) } else { next.list.clone() }));
                }
                if !self.engine.step() { return Err("next export frame has no runnable preparation".into()); }
            }
        })?;
        finish_frame(layout, out);
        let mut timings = self.timings.lock().unwrap();
        timings.evaluate_ms += (drawing - started).as_secs_f64() * 1000.0;
        timings.draw_ms += drawing.elapsed().as_secs_f64() * 1000.0;
        crate::memory::sample(&mut self.memory, "frame", Some(tick), crate::memory::renderer_device(&self.renderer), serde_json::json!({"frame_buffer":out.capacity(),"draw_ms":drawing.elapsed().as_secs_f64()*1000.}))?;
        if self.sample.contains(&index) {
            let child = self.child.load(Ordering::Relaxed);
            timings.samples.push((index, win::private_bytes(None), if child != 0 { win::private_bytes(Some(child)) } else { 0 }));
        }
        Ok(())
    }
}

/// The sound as 250 ms chunks of a raw f32le stereo file.
struct MixFile {
    samples: Vec<f32>,
    at: usize,
}

impl AudioSource for MixFile {
    fn next_chunk(&mut self, out: &mut Vec<f32>) -> Result<bool, String> {
        if self.at >= self.samples.len() {
            return Ok(false);
        }
        let end = (self.at + 24_000).min(self.samples.len());
        out.extend_from_slice(&self.samples[self.at..end]);
        self.at = end;
        Ok(true)
    }
}

fn find_ffmpeg(rest: &[String]) -> PathBuf {
    if let Some(path) = option(rest, "--ffmpeg") {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::var("FFMPEG_PATH") {
        return PathBuf::from(path);
    }
    let mut here = std::env::current_dir().unwrap_or_default();
    loop {
        let candidate = here.join("build/video-encoder/ffmpeg.exe");
        if candidate.is_file() {
            return candidate;
        }
        if !here.pop() {
            return PathBuf::from("ffmpeg");
        }
    }
}

fn find_helper(arch: &str) -> PathBuf {
    let mut here = std::env::current_dir().unwrap_or_default();
    loop {
        let candidate = here.join(format!("native/bin/{arch}/styk-vfw.exe"));
        if candidate.is_file() {
            return candidate;
        }
        if !here.pop() {
            return PathBuf::from(format!("native/bin/{arch}/styk-vfw.exe"));
        }
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn fail(message: impl std::fmt::Display) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", json_string(&message.to_string()))
}

/// The folders left over by a job beside `destination`: staging directories that should not outlive it.
fn leftovers(destination: &Path) -> Vec<String> {
    let folder = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::read_dir(folder)
        .map(|entries| entries.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with('.') && n.ends_with(".stage")).collect())
        .unwrap_or_default()
}

/// A renderer for `generation`'s pictures: decoded by the engine's tasks (here on this thread), uploaded, and the decoded
/// copies dropped (the exporter holds what it needs).
fn make_renderer(engine: &Engine, frames: &styk_engine::export::ExportFrames, settings: Settings, cpu: bool, tile: u32, memory: &mut Option<crate::memory::Log>) -> Result<(FrameRenderer, String), String> {
    if cpu {
        let mut renderer = FrameRenderer::Cpu(CpuExport::new(settings, tile));
        renderer.load_images(engine, frames).map_err(fail)?;
        Ok((renderer, "CPU (styk-raster)".to_string()))
    } else {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| fail(format!("No GPU adapter: {e}")))?;
        let adapter_name = adapter.get_info().name;
        crate::memory::sample(memory, "adapter", None, None, serde_json::json!({"backend":format!("{:?}",adapter.get_info().backend)})).map_err(fail)?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("styk video export"), required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()), memory_hints: styk_render::native_gpu::memory_hints(), ..Default::default() })).map_err(|e| fail(e.to_string()))?;
        crate::memory::sample(memory, "device", None, Some(&device), serde_json::json!({})).map_err(fail)?;
        let exporter = GpuExport::new(&device, &queue, settings, tile);
        crate::memory::sample(memory, "exporter", None, Some(&device), serde_json::json!({})).map_err(fail)?;
        let mut renderer = FrameRenderer::Gpu(exporter, None);
        renderer.load_images(engine, frames).map_err(fail)?;
        crate::memory::sample(memory, "uploaded", None, Some(&device), serde_json::json!({})).map_err(fail)?;
        Ok((renderer, adapter_name))
    }
}

/// Another document open beside the first, drawn between its frames: the check that a frame does not depend on what was
/// drawn before it, by this or another document.
struct Other {
    _engine: Engine,
    frames: styk_engine::export::ExportFrames,
    generation: Arc<styk_engine::Generation>,
    renderer: FrameRenderer,
}

fn open_other(path: &str, settings: Settings, cpu: bool) -> Result<Other, String> {
    let bytes = std::fs::read(path).map_err(|e| fail(format!("{path}: {e}")))?;
    let extension = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("styk").to_ascii_lowercase();
    let engine = Engine::for_export(clock, Budgets { picture_bytes: 32 << 20, ..Budgets::for_device(None) });
    engine.open(&bytes, &extension, "other").map_err(|e| fail(format!("{path}: {e}")))?;
    drop(bytes);
    let frames = engine.export_frames(0).map_err(fail)?;
    let generation = frames.generation().clone();
    let (renderer, _) = make_renderer(&engine, &frames, settings, cpu, styk_export::TILE_SIDE, &mut None)?;
    Ok(Other { _engine: engine, frames, generation, renderer })
}

fn run(path: &str, ticks: &str, out: &str, rest: &[String]) -> Result<String, String> {
    let mut memory = crate::memory::Log::open(option(rest, "--memory-report")).map_err(fail)?;
    crate::memory::sample(&mut memory, "start", None, None, serde_json::json!({})).map_err(fail)?;
    let baseline = win::private_bytes(None);
    let started = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| fail(format!("{path}: {e}")))?;
    let extension = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("styk").to_ascii_lowercase();
    let engine = Engine::for_export(clock, Budgets { picture_bytes: 32 << 20, ..Budgets::for_device(None) });
    let name = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("export").to_string();
    engine.open(&bytes, &extension, &name).map_err(|e| fail(format!("{path}: {e}")))?;
    let frames = engine.export_frames(0).map_err(fail)?;
    let generation = frames.generation().clone();
    let after_open = win::private_bytes(None);
    crate::memory::sample(&mut memory, "document", None, None, serde_json::json!({"input_bytes":bytes.len()})).map_err(fail)?;
    drop(bytes);
    let doc = &generation.prepared.doc;
    let (first, last) = match ticks.split_once('-') {
        Some((a, b)) => (a.parse::<u32>().map_err(fail)?, b.parse::<u32>().map_err(fail)?),
        None => {
            let tick = ticks.parse::<u32>().map_err(fail)?;
            (tick, tick)
        }
    };
    let last = last.min(frames.ticks().saturating_sub(1));
    let count = last + 1 - first;
    let (width, height) = match option(rest, "--size") {
        Some(size) => parse_size(size).map_err(fail)?,
        None => (doc.canvas[0], doc.canvas[1]),
    };
    let smoothing_name = option(rest, "--smoothing").unwrap_or("edges");
    let fps: f64 = number(rest, "--fps").map_err(fail)?.unwrap_or(24.0);
    let format = option(rest, "--format").unwrap_or("mp4");
    let cancel = Cancel::new();

    // The request: the core plans it exactly as the dialog's choices would be planned.
    let (service, request): (Box<dyn VideoService>, VideoRequest) = if format == "vfw" {
        let arch = if option(rest, "--vfw-arch").unwrap_or("x64") == "x86" { Arch::X86 } else { Arch::X64 };
        let request = VfwRequest {
            arch,
            handler: number(rest, "--vfw-handler").map_err(fail)?.unwrap_or(0),
            width,
            height,
            fps,
            total_frames: count,
            quality: number(rest, "--vfw-quality-value").map_err(fail)?.unwrap_or(0.9),
            keyframe_every: number(rest, "--vfw-keyframes").map_err(fail)?.unwrap_or(0),
            bitrate: number(rest, "--vfw-bitrate").map_err(fail)?.unwrap_or(0),
            supports_quality: flag(rest, "--vfw-quality"),
            supports_keyframes: option(rest, "--vfw-keyframes").is_some(),
            supports_data_rate: option(rest, "--vfw-bitrate").is_some(),
            state_file: option(rest, "--vfw-state").map(PathBuf::from),
        };
        let service = VfwVideoService::new(find_helper("x64"), find_helper("x86"));
        (Box::new(service), VideoRequest::Vfw(request))
    } else {
        let preset = match option(rest, "--quality").unwrap_or("great") {
            "draft" => "small",
            "great" => "recommended",
            "max" => "high",
            other => return Err(fail(format!("--quality is draft, great or max, not {other}"))),
        };
        let bitrate_mbps: Option<f64> = number(rest, "--bitrate").map_err(fail)?;
        let codec = option(rest, "--codec").unwrap_or("").to_string();
        let fields = VideoFields {
            format: format.to_string(),
            width: width as f64,
            height: height as f64,
            from: first as f64 + 1.0,
            to: last as f64 + 1.0,
            smoothing: smoothing_name.to_string(),
            video_quality: preset.to_string(),
            bitrate_mode: if bitrate_mbps.is_some() { "manual" } else { "auto" }.to_string(),
            bitrate_mbps: bitrate_mbps.unwrap_or(8.0),
            codec_mp4: codec.clone(),
            codec_avi: codec,
            audio: option(rest, "--audio").is_some(),
            name: None,
        };
        let mut context = JobContext::new(frames.ticks() as f64, fps, &name);
        if option(rest, "--audio").is_some() {
            context.audio_clips.push(AudioClip { start: 0.0, duration: 1.0e6 });
        }
        let job = plan_video(&fields, &context).map_err(|e| fail(format!("{e}")))?;
        let mut encode = job.encode.clone();
        if let Some(max) = number::<u64>(rest, "--max-bytes").map_err(fail)? {
            encode.max_bytes = max;
        }
        let service = FfmpegVideoService::new(find_ffmpeg(rest));
        (Box::new(service), VideoRequest::Ffmpeg(encode))
    };

    let smoothing = Smoothing::parse(smoothing_name).ok_or_else(|| fail("--smoothing is edges, none or sprites"))?;
    let settings = Settings::new(width, height, smoothing, styk_export::settings::MAX_PIXELS).map_err(fail)?;

    let (renderer, adapter_name) = make_renderer(&engine, &frames, settings, flag(rest, "--cpu"), number(rest, "--tile").map_err(fail)?.unwrap_or(styk_export::TILE_SIDE), &mut memory)?;
    crate::memory::sample(&mut memory, "ready", None, crate::memory::renderer_device(&renderer), serde_json::json!({})).map_err(fail)?;
    let after_renderer = win::private_bytes(None);
    // A cancel also ends a wait for the GPU.
    {
        let interrupt = renderer.interrupt();
        cancel.on_cancel(move || interrupt.interrupt());
    }
    let opened_ms = started.elapsed().as_secs_f64() * 1000.0;

    // The order the frames are drawn in (the video is only valid in order; other orders are for the hash check).
    let mut order: Vec<u32> = (first..=last).collect();
    match option(rest, "--order").unwrap_or("forward") {
        "forward" | "interleave" => {}
        "reverse" => order.reverse(),
        "shuffle" => {
            let mut seed = 0x9E3779B97F4A7C15u64;
            for i in (1..order.len()).rev() {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                order.swap(i, (seed >> 33) as usize % (i + 1));
            }
        }
        other => return Err(fail(format!("--order is forward, reverse, shuffle or interleave, not {other}"))),
    }

    let child = Arc::new(AtomicU32::new(0));
    let timings = Arc::new(Mutex::new(Timings::default()));
    let cancel_when = Arc::new(Mutex::new(None::<Instant>));
    let sample: Vec<u32> = option(rest, "--sample-frames").map(|s| s.split(',').filter_map(|n| n.parse().ok()).collect()).unwrap_or_default();
    let mut producer = Producer {
        engine: engine.clone(),
        frames,
        renderer,
        order,
        pause: number(rest, "--pause-producer-at-frame").map_err(fail)?.zip(number(rest, "--pause-secs").map_err(fail)?),
        cancel_at: number(rest, "--cancel-at-frame").map_err(fail)?.map(|at| (at, cancel.clone(), cancel_when.clone())),
        sample,
        child: child.clone(),
        timings: timings.clone(),
        transparent: flag(rest, "--transparent"),
        memory,
    };

    if flag(rest, "--no-encode") {
        let hashes = option(rest, "--frame-hashes").ok_or_else(|| fail("--no-encode needs --frame-hashes FILE"))?;
        let mut lines = vec![String::new(); count as usize];
        let mut buffer = Vec::new();
        let layout = FrameLayout { width, height, bytes: 0, matte: !flag(rest, "--straight"), legacy_canvas: false, encoded: (width, height), edge: None };
        let mut other = match (option(rest, "--order"), option(rest, "--with")) {
            (Some("interleave"), Some(with)) => Some(open_other(with, settings, flag(rest, "--cpu"))?),
            (Some("interleave"), None) => return Err(fail("--order interleave needs --with <another document>")),
            _ => None,
        };
        let mut scratch = Vec::new();
        for index in 0..count {
            producer.frame_into(index, &layout, &mut buffer).map_err(fail)?;
            if let Some(other) = other.as_mut() {
                // A frame of the other document between this document's frames.
                let tick = (index * 7 + 3) % other.frames.ticks();
                let frame = other.frames.take(tick).ok_or_else(|| fail("no frame of the other document"))?;
                other.renderer.prepare_frame(&other._engine, &other.frames, &frame.list).map_err(fail)?;
                other.renderer.frame_into(&other.generation.prepared.doc, &frame.list, frame.camera.as_ref(), layout.matte, &mut scratch).map_err(fail)?;
            }
            let tick = producer.order[index as usize];
            let digest: String = Sha256::digest(&buffer).iter().map(|b| format!("{b:02x}")).collect();
            lines[(tick - first) as usize] = format!("{tick} {digest}");
        }
        std::fs::write(hashes, lines.join("\n") + "\n").map_err(|e| fail(e.to_string()))?;
        return Ok(format!("{{\"ok\":true,\"hashed\":{count},\"adapter\":{}}}", json_string(&adapter_name)));
    }

    // Disturbances and measurements, from outside the export path.
    let done = Arc::new(AtomicBool::new(false));
    // (peak of this process + the encoder together, peak of this process, peak of the encoder), private bytes.
    let peak = Arc::new(Mutex::new((0usize, 0usize, 0usize)));
    let before_export = win::private_bytes(None);
    {
        let (child, done, peak) = (child.clone(), done.clone(), peak.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let pid = child.load(Ordering::Relaxed);
                let (own, encoder) = (win::private_bytes(None), if pid != 0 { win::private_bytes(Some(pid)) } else { 0 });
                let mut peak = peak.lock().unwrap();
                *peak = (peak.0.max(own + encoder), peak.1.max(own), peak.2.max(encoder));
                drop(peak);
                std::thread::sleep(Duration::from_millis(50));
            }
        });
    }
    // A 1 ms ticker: the longest gap between its wake-ups says what a thread that must not stall would have seen.
    let ticker_gap = Arc::new(AtomicU32::new(0));
    if flag(rest, "--ticker") {
        let (done, gap) = (done.clone(), ticker_gap.clone());
        std::thread::spawn(move || {
            let mut last = Instant::now();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(1));
                let now = Instant::now();
                gap.fetch_max((now - last).as_micros() as u32, Ordering::Relaxed);
                last = now;
            }
        });
    }
    let suspend: Option<(u32, f64)> = number(rest, "--suspend-child-at-frame").map_err(fail)?.zip(number(rest, "--suspend-secs").map_err(fail)?);
    let cancel_after: Option<u64> = number(rest, "--cancel-after-ms").map_err(fail)?;
    let on_start = {
        let (child, done, cancel, cancel_when) = (child.clone(), done.clone(), cancel.clone(), cancel_when.clone());
        move |session: &dyn styk_services::video::VideoSession| {
            let pid = session.encoder_pid().unwrap_or(0);
            child.store(pid, Ordering::Relaxed);
            let progress = session.progress();
            if let Some((at, seconds)) = suspend {
                let done = done.clone();
                std::thread::spawn(move || {
                    while progress.snapshot().submitted < at as u64 && !done.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    if done.load(Ordering::Relaxed) {
                        return;
                    }
                    win::suspend(pid);
                    std::thread::sleep(Duration::from_secs_f64(seconds));
                    win::resume(pid);
                });
            }
            if let Some(ms) = cancel_after {
                let (cancel, cancel_when) = (cancel.clone(), cancel_when.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ms));
                    *cancel_when.lock().unwrap() = Some(Instant::now());
                    cancel.cancel();
                });
            }
        }
    };

    let mut mix = match option(rest, "--audio") {
        Some(file) => {
            let raw = std::fs::read(file).map_err(|e| fail(format!("{file}: {e}")))?;
            Some(MixFile { samples: raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(), at: 0 })
        }
        None => None,
    };
    let exporting = Instant::now();
    let result = run_video_export(&*service, Path::new(out), &request, &mut producer, mix.as_mut().map(|m| m as &mut dyn AudioSource), &cancel, &on_start);
    let finished = Instant::now();
    done.store(true, Ordering::Relaxed);
    crate::memory::sample(&mut producer.memory, "end", None, crate::memory::renderer_device(&producer.renderer), serde_json::json!({})).map_err(fail)?;
    let export_ms = (finished - exporting).as_secs_f64() * 1000.0;
    let cancel_latency = cancel_when.lock().unwrap().map(|at| (finished - at).as_secs_f64() * 1000.0);
    let timings = timings.lock().unwrap();
    let (peak_private, peak_own, peak_encoder) = *peak.lock().unwrap();
    let samples = timings.samples.iter().map(|(frame, own, encoder)| format!("[{frame},{own},{encoder}]")).collect::<Vec<_>>().join(",");
    let common = format!(
        "\"adapter\":{},\"opened_ms\":{opened_ms:.0},\"export_ms\":{export_ms:.0},\"evaluate_ms\":{:.0},\"draw_ms\":{:.0},\"baseline_private\":{baseline},\"after_open_private\":{after_open},\"after_renderer_private\":{after_renderer},\"before_export_private\":{before_export},\"peak_private\":{peak_private},\"peak_own_private\":{peak_own},\"peak_encoder_private\":{peak_encoder},\"private_at_frames\":[{samples}],\"cancel_latency_ms\":{},\"stage_leftovers\":{},\"ticker_max_gap_ms\":{:.2}",
        json_string(&adapter_name),
        timings.evaluate_ms,
        timings.draw_ms,
        cancel_latency.map_or("null".to_string(), |ms| format!("{ms:.1}")),
        leftovers(Path::new(out)).len(),
        ticker_gap.load(Ordering::Relaxed) as f64 / 1000.0,
    );
    match result {
        Ok(done) => {
            let sha = sha256_file(&done.path).map_err(fail)?;
            Ok(format!("{{\"ok\":true,\"frames\":{},\"bytes\":{},\"sha256\":\"{sha}\",\"fps\":{:.2},{common}}}", done.frames, done.bytes, done.frames as f64 / (export_ms / 1000.0)))
        }
        Err(error) => {
            let kind = match &error {
                VideoError::Cancelled => "cancelled",
                VideoError::CommitFailed { .. } => "commit-failed",
                VideoError::Destination { .. } => "destination",
                _ => "failed",
            };
            Err(format!("{{\"ok\":false,\"kind\":\"{kind}\",\"error\":{},{common}}}", json_string(&error.to_string())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;
    use styk_core::export::flow::run_video_export;
    use styk_services::video::{Codec, Container, FfmpegRequest, Rate};

    #[test]
    fn a_size_is_whole_pixels_or_it_is_refused() {
        assert_eq!(parse_size("1920x1080"), Ok((1920, 1080)));
        assert_eq!(parse_size("1x1"), Ok((1, 1)));
        for bad in ["1.5x2", "1920", "x1080", "1920x", "0x10", "-3x4", "axb", "1920X1080", "+5x5", "1920x1080x3", ""] {
            let message = parse_size(bad).expect_err(bad);
            assert!(message.contains("--size") && message.contains("WxH"), "{bad}: {message}");
        }
    }

    /// The bundled encoder; a missing one fails the test with what to do (it is git-ignored).
    fn ffmpeg() -> PathBuf {
        let mut here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        loop {
            let candidate = here.join("build/video-encoder/ffmpeg.exe");
            if candidate.is_file() {
                return candidate;
            }
            assert!(here.pop(), "build/video-encoder/ffmpeg.exe was not found: copy the bundled encoder into this checkout (it is git-ignored) to run the video tests");
        }
    }

    /// Translucent frames: every alpha level, with colours that vary across the frame and with the frame.
    fn translucent(index: u32, width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let alpha = ((x * 256 / width + y * 5 + index * 17) % 256) as u8;
                out.extend_from_slice(&[(x * 4 + index * 9) as u8, (255 - y * 7) as u8, (x * y + index * 31) as u8, alpha]);
            }
        }
        out
    }

    struct Frames;

    impl FrameProducer for Frames {
        fn frame_into(&mut self, index: u32, layout: &FrameLayout, out: &mut Vec<u8>) -> Result<(), String> {
            out.extend(translucent(index, layout.width, layout.height));
            finish_frame(layout, out);
            Ok(())
        }
    }

    use styk_core::export::flow::FrameProducer;

    /// The 8 random bytes of a WebM's TrackUID and of its Tags/Targets TagTrackUID: the fields that differ between two runs of
    /// today's exporter on identical input.
    fn without_random_uids(mut file: Vec<u8>) -> Vec<u8> {
        for id in [[0x73, 0xc5, 0x88], [0x63, 0xc5, 0x88]] {
            let mut at = 0;
            while at + 11 <= file.len() {
                if file[at..at + 3] == id {
                    file[at + 3..at + 11].fill(0);
                    at += 11;
                } else {
                    at += 1;
                }
            }
        }
        file
    }

    /// Real documents only exercise opaque WebM frames, so this is where translucent colour is held to today's bytes: the
    /// frames of today's app pass through the canvas (the measured mapping of `legacy_canvas`) and reach FFmpeg as PNG
    /// images; the native session must give the same file from the same translucent frames, and the file made without the
    /// mapping must differ (the mapping is what keeps the bytes).
    #[test]
    fn translucent_webm_equals_the_file_made_from_the_canvas_pngs_of_todays_app() {
        use std::io::Write;
        let ffmpeg = ffmpeg();
        let dir = std::env::temp_dir().join(format!("styk-translucent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (width, height, frames) = (64u32, 36u32, 5u32);
        let request = FfmpegRequest { container: Container::Webm, codec: Codec::Vp9, width, height, fps: 24.0, total_frames: frames, rate: Rate { quality: 0.8, bitrate: None }, max_bytes: 1 << 30, audio: false };

        // The native export, through the same flow and frame policy as `styk video`.
        let service = FfmpegVideoService::new(&ffmpeg);
        let native = dir.join("native.webm");
        run_video_export(&service, &native, &VideoRequest::Ffmpeg(request.clone()), &mut Frames, None, &Cancel::new(), &|session| {
            assert!(session.layout().legacy_canvas && !session.layout().matte, "WebM with transparency is straight RGBA through the canvas mapping");
        })
        .unwrap();

        // Today's: PNG images of the canvas-mapped frames, fed to FFmpeg with today's arguments.
        let from_pngs = |name: &str, map: bool| {
            let out = dir.join(name);
            let mut child = std::process::Command::new(&ffmpeg).args(styk_platform::video::args::encoder_args(&request, &out.to_string_lossy())).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
            let mut stdin = child.stdin.take().unwrap();
            for index in 0..frames {
                let mut pixels = translucent(index, width, height);
                if map {
                    for pixel in pixels.chunks_exact_mut(4) {
                        let alpha = pixel[3];
                        for c in 0..3 {
                            pixel[c] = styk_export::legacy_canvas::map(pixel[c], alpha);
                        }
                    }
                }
                let mut png = Vec::new();
                image::codecs::png::PngEncoder::new(&mut png).write_image(&pixels, width, height, image::ExtendedColorType::Rgba8).unwrap();
                stdin.write_all(&png).unwrap();
            }
            drop(stdin);
            assert!(child.wait().unwrap().success());
            without_random_uids(std::fs::read(out).unwrap())
        };
        let todays = from_pngs("todays.webm", true);
        let unmapped = from_pngs("unmapped.webm", false);
        let native_bytes = without_random_uids(std::fs::read(&native).unwrap());
        assert!(native_bytes == todays, "the native file differs from today's in {} bytes", native_bytes.iter().zip(&todays).filter(|(a, b)| a != b).count());
        assert!(native_bytes != unmapped, "without the canvas mapping the file would be the same: the frames have no translucent colour that it changes");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
