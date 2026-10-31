//! `styk raster-parity`: the CPU rasterizer (styk-raster) against the GPU renderer
//! (styk-render) on the same draw lists, by the app's pixel-parity rule (D13).
//!
//!   styk raster-parity <file>… [--list <paths.txt>]… [--sizes 320x192,512x288,96x54]
//!                      [--export] [--crisp] [--ticks N] [--library] [--census] [--repeat N]
//!                      [--out <dir>] [--json <file>]
//!
//! Frames come from the engine as the app's thumbnails and exports take them
//! (`styk_engine::export::ExportFrames`: effects drawn, the document's hidden layers hidden),
//! at up to `--ticks` frame starts spread over the timeline (five by default). Each frame is
//! drawn by both renderers from one draw list and one view:
//!
//! * `thumb-WxH`: a frame thumbnail card of each `--sizes` (`styk_engine::thumbnails::card`,
//!   the canvas fitted and centred on the `#f5f5f5` card through the scene camera);
//! * `export` (with `--export`): an export frame at the canvas size, Smooth edges
//!   (`styk_export::view::tile_view`);
//! * `export-crisp` (with `--crisp`): the same with No smoothing.
//!
//! With `--library` each file is a library file instead, opened as the asset library opens
//! it (`styk_engine::thumbnails::library`): `library-poster` (its poster) and `library-frame`
//! (hover frames at 0, 0.4 and 1.2 seconds), 320 pixels a side on transparency.
//!
//! `--census` instead counts the filter effects the files' frames draw, every tick of each
//! as the library opens it (a movieclip file's ticks run its clip), and the files with
//! generated effects.
//!
//! A step fails when a pixel differs by more than 32 levels together with all eight
//! neighbours (`solid`), or when the mean difference, not counting differences of two levels
//! or less, exceeds 0.25 (D13; the limits are fixed). Alpha counts
//! as a channel. The CPU time is the median of `--repeat` rasterizations (one by default), by
//! one CPU renderer per file and edge mode kept across its frames, as the app keeps one.
//! `--out` keeps both pictures and a difference picture of every failing step; `--json`
//! writes every step.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_engine::thumbnails::{card, CARD};
use styk_engine::{Budgets, Engine};
use styk_eval::drawlist::DrawList;
use styk_export::{GpuExport, Settings, Smoothing, Tile};
use styk_render::{wgpu, Edges, Renderer, ViewParams};

/// D13 (docs/engine/decisions/0013-app-parity-rule.md): never changed to pass.
const THRESHOLD: u8 = 32;
const MEAN: f64 = 0.25;
const QUANTUM: u8 = 2;

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn option<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).map(String::as_str)
}

/// One comparison: how many solid pixels, the mean beyond the quantum, the raw mean, the largest difference.
#[derive(Clone, Copy, Debug, Default)]
pub struct Difference {
    pub solid: usize,
    pub mean: f64,
    pub raw: f64,
    pub max: u8,
}

impl Difference {
    pub fn passes(&self) -> bool {
        self.solid == 0 && self.mean <= MEAN
    }
}

/// The D13 comparison of two straight RGBA pictures of `width` pixels a row, and each pixel's difference.
pub fn compare(a: &[u8], b: &[u8], width: usize) -> (Difference, Vec<u8>) {
    let n = a.len() / 4;
    let height = n / width.max(1);
    let d: Vec<u8> = (0..n).map(|i| (0..4).map(|k| a[i * 4 + k].abs_diff(b[i * 4 + k])).max().unwrap_or(0)).collect();
    let solid = solid_pixels(&d, width, height).count();
    let beyond: f64 = d.iter().filter(|&&v| v > QUANTUM).map(|&v| v as f64).sum();
    let raw: f64 = d.iter().map(|&v| v as f64).sum();
    let max = d.iter().copied().max().unwrap_or(0);
    // (An empty sum of floats is -0: adding 0 prints it as 0.)
    (Difference { solid, mean: beyond / n.max(1) as f64 + 0.0, raw: raw / n.max(1) as f64 + 0.0, max }, d)
}

/// Pixels differing by more than the threshold together with all eight neighbours.
fn solid_pixels(d: &[u8], width: usize, height: usize) -> impl Iterator<Item = usize> + '_ {
    (1..height.saturating_sub(1)).flat_map(move |y| (1..width.saturating_sub(1)).map(move |x| (x, y))).filter(move |&(x, y)| (0..9).all(|k| d[(y + k / 3 - 1) * width + x + k % 3 - 1] > THRESHOLD)).map(move |(x, y)| y * width + x)
}

/// Straight RGBA of premultiplied pixels (the export's rule, `styk_export::pixels::resolve`).
fn straight(premultiplied: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    styk_export::pixels::resolve(premultiplied, width as usize * 4, [width, height], 1, false, &mut out);
    out
}

/// A picture of where two pictures differ: the second faded, differences above 8 levels in
/// red, solid pixels in purple.
fn difference_picture(b: &[u8], d: &[u8], width: usize) -> Vec<u8> {
    let height = d.len() / width.max(1);
    let mut out = vec![0u8; d.len() * 4];
    for (i, &v) in d.iter().enumerate() {
        let fade = |c: u8| (255.0 - (255.0 - c as f64) * 0.25) as u8;
        let red = 255 - (v as u32 * 3).min(255) as u8;
        let px = if v > 8 { [255, red, red, 255] } else { [fade(b[i * 4]), fade(b[i * 4 + 1]), fade(b[i * 4 + 2]), 255] };
        out[i * 4..i * 4 + 4].copy_from_slice(&px);
    }
    for at in solid_pixels(d, width, height) {
        out[at * 4..at * 4 + 4].copy_from_slice(&[160, 0, 200, 255]);
    }
    out
}

/// The CPU rasterizer's picture of `list` seen through `view`, premultiplied RGBA, and its time.
fn cpu_frame(raster: &mut styk_raster::Raster, list: &DrawList, images: &styk_raster::Images, view: &ViewParams, size: [u32; 2]) -> (Vec<u8>, f64) {
    let started = clock();
    let frame = raster.render(list, images, view, size);
    let ms = clock() - started;
    (frame.pixels, ms)
}

struct Step {
    file: String,
    tick: u32,
    name: String,
    width: u32,
    height: u32,
    difference: Difference,
    cpu_ms: f64,
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    name: String,
}

fn gpu() -> Result<Gpu, String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| format!("No GPU adapter: {e}"))?;
    let name = adapter.get_info().name;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("styk raster parity"),
        required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
        ..Default::default()
    }))
    .map_err(|e| e.to_string())?;
    Ok(Gpu { device, queue, name })
}

/// Up to `count` frame starts spread over the timeline, as the app's previews pick them.
fn frame_starts(doc: &styk_eval::doc::Document, ticks: u32, count: usize) -> Vec<u32> {
    let mut starts = Vec::new();
    let mut at = 0u32;
    for keyframe in &doc.keyframes {
        starts.push(at);
        at += keyframe.duration.max(1);
    }
    if starts.is_empty() {
        starts.push(0);
    }
    let n = starts.len();
    let picks: Vec<usize> = match count {
        0 | 1 => vec![0],
        2 => vec![0, n - 1],
        3 => vec![0, n / 2, n - 1],
        4 | 5 => vec![0, n / 4, n / 2, 3 * n / 4, n - 1],
        // More: evenly spread.
        _ => (0..count).map(|i| i * (n - 1) / (count - 1)).collect(),
    };
    let mut list: Vec<u32> = picks.into_iter().map(|i| starts[i.min(n - 1)]).filter(|&t| t < ticks.max(1)).collect();
    list.dedup();
    list
}

pub fn run(args: &[String]) -> i32 {
    let mut files: Vec<String> = Vec::new();
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
        } else if ["--list", "--sizes", "--ticks", "--repeat", "--out", "--json"].contains(&arg.as_str()) {
            skip = true;
        } else if !arg.starts_with("--") {
            files.push(arg.clone());
        }
    }
    for list in args.windows(2).filter(|w| w[0] == "--list").map(|w| w[1].as_str()) {
        match std::fs::read_to_string(list) {
            Ok(text) => files.extend(text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from)),
            Err(e) => {
                eprintln!("{list}: {e}");
                return 2;
            }
        }
    }
    if args.iter().any(|a| a == "--census") {
        return census(&files);
    }
    let sizes: Vec<[u32; 2]> = option(args, "--sizes")
        .unwrap_or("320x192,512x288,96x54")
        .split(',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.split_once('x').and_then(|(a, b)| Some([a.parse().ok()?, b.parse().ok()?])))
        .collect();
    let export = args.iter().any(|a| a == "--export");
    let crisp = args.iter().any(|a| a == "--crisp");
    let as_library = args.iter().any(|a| a == "--library");
    let count = option(args, "--ticks").and_then(|n| n.parse().ok()).unwrap_or(5);
    let repeat = option(args, "--repeat").and_then(|n| n.parse::<usize>().ok()).unwrap_or(1).max(1);
    let out = option(args, "--out");
    if let Some(dir) = out
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        eprintln!("{dir}: {e}");
        return 2;
    }
    let gpu = match gpu() {
        Ok(gpu) => gpu,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let mut checker = Checker { repeat, out, steps: Vec::new() };
    let mut failed_files = Vec::new();
    for file in &files {
        let result = if as_library { library(&gpu, &mut checker, file) } else { document(&gpu, &mut checker, file, &sizes, export, crisp, count) };
        if let Err(e) = result {
            eprintln!("{file}: {e}");
            failed_files.push(file.clone());
        }
    }
    let steps = checker.steps;
    // Pass counts per rule and step kind.
    let mut kinds: Vec<String> = steps.iter().map(|s| s.name.clone()).collect();
    kinds.sort();
    kinds.dedup();
    println!("GPU: {}; {} files ({} could not be drawn), {} steps", gpu.name, files.len(), failed_files.len(), steps.len());
    for kind in &kinds {
        let of: Vec<&Step> = steps.iter().filter(|s| &s.name == kind).collect();
        let solid = of.iter().filter(|s| s.difference.solid == 0).count();
        let mean = of.iter().filter(|s| s.difference.mean <= MEAN).count();
        let both = of.iter().filter(|s| s.difference.passes()).count();
        let mut times: Vec<f64> = of.iter().map(|s| s.cpu_ms).collect();
        times.sort_by(|a, b| a.total_cmp(b));
        let pct = |p: f64| times.get(((times.len() as f64 - 1.0) * p).round() as usize).copied().unwrap_or(0.0);
        println!(
            "  {kind}: {both}/{n} pass (no solid pixel {solid}/{n}, mean {mean}/{n}); CPU raster p50 {:.1} ms, p90 {:.1} ms, max {:.1} ms",
            pct(0.5),
            pct(0.9),
            pct(1.0),
            n = of.len()
        );
    }
    if let Some(path) = option(args, "--json") {
        let mut text = String::from("[\n");
        for (i, s) in steps.iter().enumerate() {
            text.push_str(&format!(
                "  {{\"file\":{:?},\"tick\":{},\"step\":{:?},\"width\":{},\"height\":{},\"pass\":{},\"solid\":{},\"mean\":{:.4},\"raw\":{:.4},\"max\":{},\"cpuMs\":{:.2}}}{}\n",
                s.file,
                s.tick,
                s.name,
                s.width,
                s.height,
                s.difference.passes(),
                s.difference.solid,
                s.difference.mean,
                s.difference.raw,
                s.difference.max,
                s.cpu_ms,
                if i + 1 < steps.len() { "," } else { "" }
            ));
        }
        text.push_str("]\n");
        if let Err(e) = std::fs::write(path, text) {
            eprintln!("{path}: {e}");
            return 2;
        }
    }
    i32::from(steps.iter().any(|s| !s.difference.passes()) || !failed_files.is_empty())
}

/// Runs and records the comparisons of a run.
struct Checker<'a> {
    repeat: usize,
    out: Option<&'a str>,
    steps: Vec<Step>,
}

impl Checker<'_> {
    /// Compares the GPU's straight RGBA `gpu_pixels` with the CPU's picture (`cpu()`, run
    /// `repeat` times for its median time) and records the step.
    #[allow(clippy::too_many_arguments)]
    fn check(&mut self, file: &str, stem: &str, tick: u32, name: String, size: [u32; 2], gpu_pixels: &[u8], cpu: &mut dyn FnMut() -> (Vec<u8>, f64)) {
        let mut times = Vec::with_capacity(self.repeat);
        let mut cpu_pixels = Vec::new();
        for _ in 0..self.repeat {
            let (pixels, ms) = cpu();
            times.push(ms);
            cpu_pixels = pixels;
        }
        times.sort_by(|a, b| a.total_cmp(b));
        let cpu_straight = straight(&cpu_pixels, size[0], size[1]);
        let (difference, d) = compare(gpu_pixels, &cpu_straight, size[0] as usize);
        if let Some(dir) = self.out
            && !difference.passes()
        {
            let slug: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
            let base = format!("{dir}/{slug}-{tick}-{name}");
            let _ = image::save_buffer(format!("{base}-gpu.png"), gpu_pixels, size[0], size[1], image::ColorType::Rgba8);
            let _ = image::save_buffer(format!("{base}-cpu.png"), &cpu_straight, size[0], size[1], image::ColorType::Rgba8);
            let _ = image::save_buffer(format!("{base}-diff.png"), &difference_picture(&cpu_straight, &d, size[0] as usize), size[0], size[1], image::ColorType::Rgba8);
        }
        let cpu_ms = times[times.len() / 2];
        println!(
            "{} {stem} tick {tick} {name}: solid {}, mean {:.4} (raw {:.4}), max {}, CPU {cpu_ms:.1} ms",
            if difference.passes() { "ok  " } else { "FAIL" },
            difference.solid,
            difference.mean,
            difference.raw,
            difference.max,
        );
        self.steps.push(Step { file: file.to_string(), tick, name, width: size[0], height: size[1], difference, cpu_ms });
    }
}

/// Draws `list` with the GPU renderer `renderer` under `view` at `size`: straight RGBA.
fn gpu_frame(gpu: &Gpu, renderer: &mut Renderer, list: &Arc<DrawList>, view: &ViewParams, size: [u32; 2]) -> Vec<u8> {
    renderer.set_list(list);
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, view, size);
    gpu.queue.submit([encoder.finish()]);
    let (_, _, pixels) = styk_render::read_frame(&gpu.device, &gpu.queue, renderer.frame_texture().expect("a frame"));
    straight(&pixels, size[0], size[1])
}

/// A document's frame thumbnails and export frames.
fn document(gpu: &Gpu, checker: &mut Checker, file: &str, sizes: &[[u32; 2]], export: bool, crisp: bool, count: usize) -> Result<(), String> {
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let extension = Path::new(file).extension().and_then(|e| e.to_str()).unwrap_or("styk").to_ascii_lowercase();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let stem = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or("document").to_string();
    engine.open(&bytes, &extension, &stem).map_err(|e| e.to_string())?;
    let frames = engine.export_frames(0)?;
    let generation = frames.generation().clone();
    let doc = &generation.prepared.doc;
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let mut cpu_images = styk_raster::Images::default();
    for image in &images {
        cpu_images.add(&generation.assets, image);
    }
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.prepare_sprites(&generation.assets);
    renderer.upload_images(&generation.assets, images.iter().map(|image| &**image));
    // One CPU renderer per edge mode for the document, kept across its frames as the app keeps one.
    let (mut smooth_raster, mut crisp_raster) = (styk_raster::Raster::new(Edges::Smooth), styk_raster::Raster::new(Edges::Crisp));
    for tick in frame_starts(doc, frames.ticks(), count) {
        let frame = loop {
            if let Some(frame) = frames.take(tick) {
                break frame;
            }
            if !engine.step() {
                return Err(format!("tick {tick} was not prepared"));
            }
        };
        for &size in sizes {
            let framing = card(doc, frame.camera.as_ref(), size[0], size[1]);
            let view = ViewParams {
                matrix: framing.matrix,
                artboard: framing.artboard,
                clip_to_artboard: true,
                clear: CARD,
                zoom: framing.zoom,
                pan: framing.pan,
                stretch: 1.0,
                camera_view: true,
                camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
            };
            let gpu_pixels = gpu_frame(gpu, &mut renderer, &frame.list, &view, size);
            checker.check(file, &stem, tick, format!("thumb-{}x{}", size[0], size[1]), size, &gpu_pixels, &mut || cpu_frame(&mut smooth_raster, &frame.list, &cpu_images, &view, size));
        }
        let kinds: Vec<(&str, Smoothing)> = [(export, ("export", Smoothing::Edges)), (crisp, ("export-crisp", Smoothing::None))].into_iter().filter(|k| k.0).map(|k| k.1).collect();
        for (name, smoothing) in kinds {
            let settings = Settings::new(doc.canvas[0].max(1), doc.canvas[1].max(1), smoothing, styk_export::settings::MAX_PIXELS)?;
            let size = settings.render_size();
            let mut exporter = GpuExport::new(&gpu.device, &gpu.queue, settings, styk_export::TILE_SIDE);
            exporter.prepare_sprites(generation.lineage, &generation.assets);
            exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
            let gpu_pixels = exporter.frame_blocking(doc, &frame.list, frame.camera.as_ref(), false)?;
            let tile = Tile { x: 0, y: 0, size, valid: size };
            let view = styk_export::view::tile_view(doc, frame.camera.as_ref(), &settings, &tile);
            let raster = if smoothing.edges_for(&frame.list) == Edges::Crisp { &mut crisp_raster } else { &mut smooth_raster };
            checker.check(file, &stem, tick, name.to_string(), size, &gpu_pixels, &mut || cpu_frame(raster, &frame.list, &cpu_images, &view, size));
        }
    }
    Ok(())
}

/// A library file's previews as the asset library shows them: its poster, then hover frames
/// at 0, 0.4 and 1.2 seconds, 320 pixels a side on transparency.
fn library(gpu: &Gpu, checker: &mut Checker, file: &str) -> Result<(), String> {
    use styk_engine::thumbnails::library::{fitted, LibraryPreview, SIZE};
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let extension = Path::new(file).extension().and_then(|e| e.to_str()).unwrap_or("stkz").to_ascii_lowercase();
    let stem = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or("library").to_string();
    let mut preview = LibraryPreview::open(&bytes, &extension)?;
    let images = preview.images();
    let mut cpu_images = styk_raster::Images::default();
    for image in &images {
        cpu_images.add(preview.assets(), image);
    }
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.prepare_sprites(preview.assets());
    renderer.upload_images(preview.assets(), images.iter());
    let size = [SIZE, SIZE];
    let view_of = |bounds: [f64; 4]| {
        let framing = fitted(bounds, SIZE);
        ViewParams {
            matrix: framing.matrix,
            artboard: framing.artboard,
            clip_to_artboard: false,
            clear: [0.0; 4],
            zoom: framing.zoom,
            pan: framing.pan,
            stretch: 1.0,
            camera_view: false,
            camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
        }
    };
    let (poster, bounds) = preview.poster(clock);
    let view = view_of(bounds);
    let gpu_pixels = gpu_frame(gpu, &mut renderer, &poster.list, &view, size);
    let mut smooth = styk_raster::Raster::new(Edges::Smooth);
    checker.check(file, &stem, 0, "library-poster".into(), size, &gpu_pixels, &mut || cpu_frame(&mut smooth, &poster.list, &cpu_images, &view, size));
    preview.begin(clock);
    for elapsed in [0.0, 0.4, 1.2] {
        let (sample, bounds, tick) = preview.frame(elapsed, clock);
        let view = view_of(bounds);
        let gpu_pixels = gpu_frame(gpu, &mut renderer, &sample.list, &view, size);
        checker.check(file, &stem, tick as u32, "library-frame".into(), size, &gpu_pixels, &mut || cpu_frame(&mut smooth, &sample.list, &cpu_images, &view, size));
    }
    Ok(())
}

/// Which filter effects the frames of `files` draw: for each effect, the files and the
/// frames (file ticks) whose draw lists hold it, active, in an effect layer's stack.
fn census(files: &[String]) -> i32 {
    use std::collections::BTreeMap;
    use styk_eval::drawlist::{K_BEAM, K_PARTICLE};
    let mut documents: BTreeMap<&'static str, (usize, usize)> = BTreeMap::new();
    let (mut generated, mut frames_total, mut filtered_frames, mut opened) = (0usize, 0usize, 0usize, 0usize);
    for file in files {
        let result = (|| -> Result<(), String> {
            let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
            let extension = Path::new(file).extension().and_then(|e| e.to_str()).unwrap_or("styk").to_ascii_lowercase();
            // Opened as the library opens it: a movieclip file's ticks run its clip.
            let preview = styk_engine::thumbnails::library::LibraryPreview::open(&bytes, &extension)?;
            let mut seen: BTreeMap<&'static str, usize> = BTreeMap::new();
            let mut particles = false;
            for tick in 0..(preview.duration.ceil() as u32).min(5000) {
                let frame = preview.sample(tick as f64, clock);
                frames_total += 1;
                particles |= frame.list.prims.iter().any(|p| matches!(p.kind & 255, K_PARTICLE | K_BEAM));
                let mut here: Vec<&'static str> = frame.list.layers.iter().flat_map(styk_eval::drawlist::layer_effects).filter(|e| styk_eval::vfx::is_active(e)).map(|e| e.params.kind().name()).collect();
                here.sort();
                here.dedup();
                filtered_frames += usize::from(!here.is_empty());
                for name in here {
                    *seen.entry(name).or_default() += 1;
                }
            }
            opened += 1;
            generated += usize::from(particles);
            for (name, count) in seen {
                let entry = documents.entry(name).or_default();
                entry.0 += 1;
                entry.1 += count;
            }
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("{file}: {e}");
        }
    }
    let mut rows: Vec<_> = documents.into_iter().collect();
    rows.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(b.1.1.cmp(&a.1.1)));
    println!("{opened} files, {frames_total} frames, {filtered_frames} frames with filter effects, {generated} files with generated effects");
    for (name, (docs, frames)) in rows {
        println!("  {name}: {docs} files, {frames} frames");
    }
    0
}
