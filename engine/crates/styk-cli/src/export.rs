//! `styk export`: export frames as the app's engine exports them (styk-export), natively,
//! with timings; `--cpu` rasterizes the same draw lists with styk-raster instead (the
//! app's path where no GPU device is available).
//!
//!   styk export <file> <tick | first-last> <out.png | folder> [--size WxH] [--smoothing edges|none|sprites]
//!               [--matte] [--tile N] [--cpu] [--repeat N]

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_engine::{Budgets, Engine};
use styk_export::{CpuExport, GpuExport, Settings, Smoothing};
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
    let engine = Engine::new(clock, Budgets::for_device(None));
    let name = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("export");
    engine.open(&bytes, &extension, name).map_err(|e| format!("{path}: {e}"))?;
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
    let repeat = option(rest, "--repeat").and_then(|n| n.parse::<usize>().ok()).unwrap_or(1).max(1);
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;

    // Pictures: decoded by the engine's tasks (here on this thread, there are no workers).
    let decoding = Instant::now();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let decode_ms = decoding.elapsed().as_secs_f64() * 1000.0;

    let cpu = rest.iter().any(|a| a == "--cpu");
    let tile = option(rest, "--tile").and_then(|n| n.parse::<u32>().ok()).unwrap_or(styk_export::TILE_SIDE);
    let mut gpu = None;
    let mut cpu_export = None;
    let adapter_name;
    if cpu {
        let mut exporter = CpuExport::new(settings, tile);
        exporter.upload_images(&generation.assets, images.iter().cloned());
        cpu_export = Some(exporter);
        adapter_name = "CPU (styk-raster)".to_string();
    } else {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| format!("No GPU adapter: {e}"))?;
        adapter_name = adapter.get_info().name;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("styk export"), required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()), ..Default::default() })).map_err(|e| e.to_string())?;
        let mut exporter = GpuExport::new(&device, &queue, settings, tile);
        exporter.prepare_sprites(generation.lineage, &generation.assets);
        exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
        gpu = Some(exporter);
    }

    let folder = !out.ends_with(".png");
    if folder {
        std::fs::create_dir_all(out).map_err(|e| format!("{out}: {e}"))?;
    }
    let (mut evaluate, mut draw) = (Vec::new(), Vec::new());
    for tick in first..=last {
        for round in 0..repeat {
            let t0 = Instant::now();
            let frame = frames.take(tick).ok_or("no frame")?;
            let t1 = Instant::now();
            let pixels = match (gpu.as_mut(), cpu_export.as_mut()) {
                (Some(exporter), _) => exporter.frame_blocking(doc, &frame.list, frame.camera.as_ref(), matte)?,
                (None, Some(exporter)) => exporter.frame(doc, &frame.list, frame.camera.as_ref(), matte)?,
                (None, None) => unreachable!("one renderer is set up"),
            };
            let t2 = Instant::now();
            evaluate.push((t1 - t0).as_secs_f64() * 1000.0);
            draw.push((t2 - t1).as_secs_f64() * 1000.0);
            if round == 0 {
                let file = if folder { format!("{out}/frame-{tick:06}.png") } else { out.to_string() };
                image::save_buffer(&file, &pixels, settings.width, settings.height, image::ColorType::Rgba8).map_err(|e| format!("{file}: {e}"))?;
            }
        }
    }
    let tiles = gpu.as_ref().map(|g| g.tiles().len()).or(cpu_export.as_ref().map(|c| c.tiles().len())).unwrap_or(1);
    let stats = gpu.as_ref().map(|g| {
        let s = g.stats();
        format!(", {} passes, {} rounds, layers {:.1} MiB, effect slots {:.1} MiB", s.passes, s.rounds, s.layer_bytes as f64 / 1048576.0, s.effect_bytes as f64 / 1048576.0)
    });
    println!(
        "{}: ticks {first}-{last}, {width}x{height} {smoothing:?}{}, {tiles} tile(s); opened {open_ms:.0} ms, {} pictures decoded in {decode_ms:.0} ms; per frame: evaluate p50 {:.2} ms, draw and read p50 {:.2} ms ({} frames) on {adapter_name}{}",
        doc.name,
        if matte { " over black" } else { "" },
        images.len(),
        median(&mut evaluate),
        median(&mut draw),
        draw.len(),
        stats.unwrap_or_default()
    );
    Ok(())
}
