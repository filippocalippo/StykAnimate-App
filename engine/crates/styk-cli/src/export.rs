//! `styk export`: export frames as the app's engine exports them (styk-export), natively,
//! with timings; `--cpu` rasterizes the same draw lists with styk-raster instead (the
//! app's path where no GPU device is available).
//!
//!   styk export <file> <tick | first-last> <out.png | folder> [--size WxH] [--smoothing edges|none|sprites]
//!               [--matte] [--transparent] [--tile N] [--cpu] [--repeat N] [--verify N]
//!
//! `--verify N` draws the whole range N times in a row and reports every frame whose pixels differ from the first pass (the same
//! input must give the same bytes); the exit code is 1 when any does. Use WGPU_BACKEND=vulkan for a repeatability gate;
//! DX12 is a diagnostic of the floor in docs/native/frame-parity.md#dx12-msaa-repeatability-driver-floor.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_engine::{Budgets, Engine};
use styk_export::{CpuExport, FrameRenderer, GpuExport, Settings, Smoothing};
use styk_render::wgpu;

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn option<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).map(String::as_str)
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.total_cmp(b));
    if values.is_empty() { 0.0 } else { values[values.len() / 2] }
}

pub fn export(path: &str, ticks: &str, out: &str, rest: &[String]) -> i32 {
    match run(path, ticks, out, rest) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

fn run(path: &str, ticks: &str, out: &str, rest: &[String]) -> Result<(), String> {
    let started = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let extension = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("styk").to_ascii_lowercase();
    let engine = Engine::for_export(clock, Budgets { picture_bytes: 32 << 20, ..Budgets::for_device(None) });
    let name = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("export");
    engine.open(&bytes, &extension, name).map_err(|e| format!("{path}: {e}"))?;
    drop(bytes);
    let frames = engine.export_frames(0)?;
    let generation = frames.generation().clone();
    let doc = &generation.prepared.doc;
    let (first, last) = match ticks.split_once('-') {
        Some((a, b)) => (a.parse::<u32>().map_err(|e| e.to_string())?, b.parse::<u32>().map_err(|e| e.to_string())?),
        None => {
            let tick = ticks.parse::<u32>().map_err(|e| e.to_string())?;
            (tick, tick)
        }
    };
    let last = last.min(frames.ticks().saturating_sub(1));
    let (width, height) = option(rest, "--size")
        .and_then(|s| s.split_once('x'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        .unwrap_or((doc.canvas[0], doc.canvas[1]));
    let smoothing = Smoothing::parse(option(rest, "--smoothing").unwrap_or("edges")).ok_or("--smoothing is edges, none or sprites")?;
    let settings = Settings::new(width, height, smoothing, styk_export::settings::MAX_PIXELS)?;
    let matte = rest.iter().any(|a| a == "--matte");
    let transparent = rest.iter().any(|a| a == "--transparent");
    let repeat = option(rest, "--repeat").and_then(|n| n.parse::<usize>().ok()).unwrap_or(1).max(1);
    let verify = option(rest, "--verify").and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;

    let cpu = rest.iter().any(|a| a == "--cpu");
    let tile = option(rest, "--tile").and_then(|n| n.parse::<u32>().ok()).unwrap_or(styk_export::TILE_SIDE);
    let mut renderer;
    let adapter_name;
    if cpu {
        renderer = FrameRenderer::Cpu(CpuExport::new(settings, tile));
        adapter_name = "CPU (styk-raster)".to_string();
    } else {
        let native = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12), "styk export", |adapter| wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()))?;
        adapter_name = format!("{} ({:?}, {})", native.adapter.get_info().name, native.adapter.get_info().backend, native.attempt.name);
        if verify > 0 && native.adapter.get_info().backend == wgpu::Backend::Dx12 {
            eprintln!("DX12 exact-repeat diagnostic on {adapter_name}: the MSAA driver floor may fail this check (docs/native/frame-parity.md#dx12-msaa-repeatability-driver-floor). Use WGPU_BACKEND=vulkan for the repeatability gate; differences still fail without tolerance.");
        }
        let (device, queue) = (native.device, native.queue);
        renderer = FrameRenderer::Gpu(GpuExport::new(&device, &queue, settings, tile), None);
    }

    let decoding = Instant::now();
    let image_count = renderer.load_images(&engine, &frames)?;
    let decode_ms = decoding.elapsed().as_secs_f64() * 1000.0;

    let folder = !out.ends_with(".png");
    if folder {
        std::fs::create_dir_all(out).map_err(|e| format!("{out}: {e}"))?;
    }
    if verify > 0 {
        return verify_runs(&engine, &frames, doc, (first, last), matte, verify, &mut renderer);
    }
    let (mut evaluate, mut draw) = (Vec::new(), Vec::new());
    let mut pixels = Vec::new();
    for tick in first..=last {
        for round in 0..repeat {
            let t0 = Instant::now();
            let frame = frames.take(tick).ok_or("no frame")?;
            let t1 = Instant::now();
            let list = if transparent { styk_export::without_background(&frame.list) } else { frame.list.clone() };
            renderer.prepare_frame(&engine, &frames, &list)?;
            renderer.frame_into(doc, &list, frame.camera.as_ref(), matte, &mut pixels)?;
            let t2 = Instant::now();
            evaluate.push((t1 - t0).as_secs_f64() * 1000.0);
            draw.push((t2 - t1).as_secs_f64() * 1000.0);
            if round == 0 {
                let file = if folder { format!("{out}/frame-{tick:06}.png") } else { out.to_string() };
                image::save_buffer(&file, &pixels, settings.width, settings.height, image::ColorType::Rgba8).map_err(|e| format!("{file}: {e}"))?;
            }
        }
    }
    let tiles = match &renderer { FrameRenderer::Gpu(g, _) => g.tiles().len(), FrameRenderer::Cpu(c) => c.tiles().len() };
    let stats = match &renderer { FrameRenderer::Gpu(g, _) => Some({
        let s = g.stats();
        format!(", {} passes, {} rounds, layers {:.1} MiB, effect slots {:.1} MiB", s.passes, s.rounds, s.layer_bytes as f64 / 1048576.0, s.effect_bytes as f64 / 1048576.0)
    }), FrameRenderer::Cpu(_) => None };
    println!(
        "{}: ticks {first}-{last}, {width}x{height} {smoothing:?}{}, {tiles} tile(s); opened {open_ms:.0} ms, {} initial picture uploads in {decode_ms:.0} ms; per frame: evaluate p50 {:.2} ms, draw and read p50 {:.2} ms ({} frames) on {adapter_name}{}",
        doc.name,
        if matte { " over black" } else { "" },
        image_count,
        median(&mut evaluate),
        median(&mut draw),
        draw.len(),
        stats.unwrap_or_default()
    );
    Ok(())
}

/// Draws ticks `range` `runs` times and compares each frame with the first pass, by hash.
fn verify_runs(engine: &Engine, frames: &styk_engine::export::ExportFrames, doc: &styk_eval::doc::Document, range: (u32, u32), matte: bool, runs: usize, renderer: &mut FrameRenderer) -> Result<(), String> {
    use std::hash::{Hash, Hasher};
    let mut first: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut differing = 0;
    for run in 0..runs {
        for tick in range.0..=range.1 {
            let frame = frames.take(tick).ok_or("no frame")?;
            let mut pixels = Vec::new();
            renderer.prepare_frame(engine, frames, &frame.list)?;
            renderer.frame_into(doc, &frame.list, frame.camera.as_ref(), matte, &mut pixels)?;
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            pixels.hash(&mut hasher);
            let hash = hasher.finish();
            if run == 0 {
                first.push((hash, pixels));
                continue;
            }
            let (expected, reference) = &first[(tick - range.0) as usize];
            if *expected != hash {
                differing += 1;
                let changed = reference.chunks_exact(4).zip(pixels.chunks_exact(4)).filter(|(a, b)| a != b).count();
                let largest = reference.iter().zip(&pixels).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
                println!("run {run} tick {tick}: {changed} pixels differ from the first pass, by {largest} levels at most");
            }
        }
    }
    println!("{} frames x {runs} runs: {differing} differing frames", range.1 - range.0 + 1);
    if differing > 0 { Err("the export is not deterministic".into()) } else { Ok(()) }
}
