//! `styk video`: a video export of a document, headless, through the same planning, frame source, flow and encoder
//! services the app uses (`docs/native/video-export.md`).
//!
//!   styk video <file> <first-last> <out> [--format mp4|webm|avi|wmv|vfw] [--codec h264|mpeg4|ffv1|rawvideo|..]
//!              [--quality draft|great|max|0..1] [--bitrate MBPS] [--size WxH] [--smoothing edges|none|sprites]
//!              [--fps F] [--audio mix.f32] [--max-bytes N] [--cpu] [--ffmpeg PATH] [--json]
//!              [--vfw-arch x64|x86 --vfw-handler N [--vfw-quality] [--vfw-keyframes N] [--vfw-data-rate]]
//!   Hooks for the tests of the export path (they disturb it from outside, as a stalled program would):
//!              [--suspend-child-at-frame N --suspend-secs S] [--pause-producer-at-frame N --pause-secs S]
//!              [--cancel-at-frame N] [--cancel-after-ms N] [--sample-frames N,N,..] [--no-encode --frame-hashes FILE
//!              --order forward|reverse|shuffle]
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
use styk_services::video::{Arch, VfwRequest, VideoError, VideoRequest, VideoService};
use styk_services::Cancel;

use crate::win;

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
    samples: Vec<(u32, usize)>,
}

struct Producer {
    frames: styk_engine::export::ExportFrames,
    generation: Arc<styk_engine::Generation>,
    renderer: FrameRenderer,
    order: Vec<u32>,
    pause: Option<(u32, f64)>,
    cancel_at: Option<(u32, Cancel, Arc<Mutex<Option<Instant>>>)>,
    sample: Vec<u32>,
    child: Arc<AtomicU32>,
    timings: Arc<Mutex<Timings>>,
}

impl FrameProducer for Producer {
    fn frame_into(&mut self, index: u32, matte: bool, out: &mut Vec<u8>) -> Result<(), String> {
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
        let doc = &self.generation.prepared.doc;
        self.renderer.frame_into(doc, &frame.list, frame.camera.as_ref(), matte, out)?;
        let mut timings = self.timings.lock().unwrap();
        timings.evaluate_ms += (drawing - started).as_secs_f64() * 1000.0;
        timings.draw_ms += drawing.elapsed().as_secs_f64() * 1000.0;
        if self.sample.contains(&index) {
            let child = self.child.load(Ordering::Relaxed);
            let bytes = win::private_bytes(None) + if child != 0 { win::private_bytes(Some(child)) } else { 0 };
            timings.samples.push((index, bytes));
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

fn run(path: &str, ticks: &str, out: &str, rest: &[String]) -> Result<String, String> {
    let baseline = win::private_bytes(None);
    let started = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| fail(format!("{path}: {e}")))?;
    let extension = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("styk").to_ascii_lowercase();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let name = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("export").to_string();
    engine.open(&bytes, &extension, &name).map_err(|e| fail(format!("{path}: {e}")))?;
    let frames = engine.export_frames(0).map_err(fail)?;
    let generation = frames.generation().clone();
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
    let (width, height) = option(rest, "--size")
        .and_then(|s| s.split_once('x'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        .unwrap_or((doc.canvas[0], doc.canvas[1]));
    let smoothing_name = option(rest, "--smoothing").unwrap_or("edges");
    let fps: f64 = number(rest, "--fps").map_err(fail)?.unwrap_or(24.0);
    let format = option(rest, "--format").unwrap_or("mp4");
    let cancel = Cancel::new();

    // The request: the core plans it exactly as the dialog's choices would be planned.
    let (service, request, total_frames): (Box<dyn VideoService>, VideoRequest, u32) = if format == "vfw" {
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
        (Box::new(service), VideoRequest::Vfw(request), count)
    } else {
        let (preset, quality_value) = match option(rest, "--quality").unwrap_or("great") {
            "draft" => ("small", None),
            "great" => ("recommended", None),
            "max" => ("high", None),
            other => ("recommended", Some(other.parse::<f64>().map_err(|_| fail("--quality is draft, great, max or a number"))?)),
        };
        let _ = quality_value;
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
        (Box::new(service), VideoRequest::Ffmpeg(encode), job.encode.total_frames)
    };

    let smoothing = Smoothing::parse(smoothing_name).ok_or_else(|| fail("--smoothing is edges, none or sprites"))?;
    let settings = Settings::new(width, height, smoothing, styk_export::settings::MAX_PIXELS).map_err(fail)?;

    // Pictures: decoded by the engine's tasks (here on this thread).
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let tile = styk_export::TILE_SIDE;
    let (renderer, adapter_name) = if flag(rest, "--cpu") {
        let mut exporter = CpuExport::new(settings, tile);
        exporter.use_assets(generation.assets.clone());
        exporter.upload_images(&generation.assets, images.iter().cloned());
        (FrameRenderer::Cpu(exporter), "CPU (styk-raster)".to_string())
    } else {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| fail(format!("No GPU adapter: {e}")))?;
        let adapter_name = adapter.get_info().name;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("styk video export"), required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()), ..Default::default() })).map_err(|e| fail(e.to_string()))?;
        let mut exporter = GpuExport::new(&device, &queue, settings, tile);
        exporter.prepare_sprites(generation.lineage, &generation.assets);
        exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
        (FrameRenderer::Gpu(exporter), adapter_name)
    };
    let opened_ms = started.elapsed().as_secs_f64() * 1000.0;

    // The order the frames are drawn in (the video is only valid in order; other orders are for the hash check).
    let mut order: Vec<u32> = (first..=last).collect();
    match option(rest, "--order").unwrap_or("forward") {
        "forward" => {}
        "reverse" => order.reverse(),
        "shuffle" => {
            let mut seed = 0x9E3779B97F4A7C15u64;
            for i in (1..order.len()).rev() {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                order.swap(i, (seed >> 33) as usize % (i + 1));
            }
        }
        other => return Err(fail(format!("--order is forward, reverse or shuffle, not {other}"))),
    }

    let child = Arc::new(AtomicU32::new(0));
    let timings = Arc::new(Mutex::new(Timings::default()));
    let cancel_when = Arc::new(Mutex::new(None::<Instant>));
    let sample: Vec<u32> = option(rest, "--sample-frames").map(|s| s.split(',').filter_map(|n| n.parse().ok()).collect()).unwrap_or_default();
    let mut producer = Producer {
        frames,
        generation: generation.clone(),
        renderer,
        order,
        pause: number(rest, "--pause-producer-at-frame").map_err(fail)?.zip(number(rest, "--pause-secs").map_err(fail)?),
        cancel_at: number(rest, "--cancel-at-frame").map_err(fail)?.map(|at| (at, cancel.clone(), cancel_when.clone())),
        sample,
        child: child.clone(),
        timings: timings.clone(),
    };

    if flag(rest, "--no-encode") {
        let hashes = option(rest, "--frame-hashes").ok_or_else(|| fail("--no-encode needs --frame-hashes FILE"))?;
        let mut lines = vec![String::new(); count as usize];
        let mut buffer = Vec::new();
        let matte = !flag(rest, "--straight");
        for index in 0..count {
            producer.frame_into(index, matte, &mut buffer).map_err(fail)?;
            let tick = producer.order[index as usize];
            let digest: String = Sha256::digest(&buffer).iter().map(|b| format!("{b:02x}")).collect();
            lines[(tick - first) as usize] = format!("{tick} {digest}");
        }
        std::fs::write(hashes, lines.join("\n") + "\n").map_err(|e| fail(e.to_string()))?;
        return Ok(format!("{{\"ok\":true,\"hashed\":{count},\"adapter\":{}}}", json_string(&adapter_name)));
    }

    // Disturbances and measurements, from outside the export path.
    let done = Arc::new(AtomicBool::new(false));
    let peak = Arc::new(Mutex::new(0usize));
    {
        let (child, done, peak) = (child.clone(), done.clone(), peak.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let pid = child.load(Ordering::Relaxed);
                let bytes = win::private_bytes(None) + if pid != 0 { win::private_bytes(Some(pid)) } else { 0 };
                let mut peak = peak.lock().unwrap();
                *peak = (*peak).max(bytes);
                drop(peak);
                std::thread::sleep(Duration::from_millis(50));
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
    let result = run_video_export(&*service, Path::new(out), &request, total_frames, &mut producer, mix.as_mut().map(|m| m as &mut dyn AudioSource), &cancel, &on_start);
    let finished = Instant::now();
    done.store(true, Ordering::Relaxed);
    let export_ms = (finished - exporting).as_secs_f64() * 1000.0;
    let cancel_latency = cancel_when.lock().unwrap().map(|at| (finished - at).as_secs_f64() * 1000.0);
    let timings = timings.lock().unwrap();
    let peak_private = *peak.lock().unwrap();
    let samples = timings.samples.iter().map(|(frame, bytes)| format!("[{frame},{bytes}]")).collect::<Vec<_>>().join(",");
    let common = format!(
        "\"adapter\":{},\"opened_ms\":{opened_ms:.0},\"export_ms\":{export_ms:.0},\"evaluate_ms\":{:.0},\"draw_ms\":{:.0},\"baseline_private\":{baseline},\"peak_private\":{peak_private},\"private_at_frames\":[{samples}],\"cancel_latency_ms\":{},\"stage_leftovers\":{}",
        json_string(&adapter_name),
        timings.evaluate_ms,
        timings.draw_ms,
        cancel_latency.map_or("null".to_string(), |ms| format!("{ms:.1}")),
        leftovers(Path::new(out)).len(),
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
