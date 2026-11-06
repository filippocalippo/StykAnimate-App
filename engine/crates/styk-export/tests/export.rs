//! Export frames on the GPU: tiles draw the pixels of the whole frame, No smoothing has
//! hard edges, Smooth sprites is the 2×2 average of a frame drawn twice as large, video
//! without alpha is over black. Documents are opened and evaluated by the engine as the
//! app's export opens them. Skipped where no GPU adapter exists.

use std::path::Path;

use styk_engine::{Budgets, Engine};
use styk_export::settings::MAX_PIXELS;
use styk_export::{GpuExport, Settings, Smoothing};
use styk_render::wgpu;

fn clock() -> f64 {
    0.0
}

fn repository(path: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

fn gpu() -> Option<Gpu> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()), ..Default::default() })).ok()?;
    Some(Gpu { device, queue })
}

/// The engine with `path` open, its pictures decoded.
fn open(path: &str) -> (Engine, styk_engine::export::ExportFrames) {
    let file = repository(path);
    let bytes = std::fs::read(&file).unwrap();
    let extension = file.extension().unwrap().to_str().unwrap().to_string();
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&bytes, &extension, "test").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    (engine, frames)
}

/// Frame `tick` of `path` exported as `settings` in tiles of at most `tile` pixels.
fn export(gpu: &Gpu, frames: &styk_engine::export::ExportFrames, settings: Settings, tile: u32, tick: u32, matte: bool) -> (Vec<u8>, usize) {
    export_with(gpu, frames, settings, tile, tick, matte, |_| {})
}

/// [`export`] of the frame's draw list after `edit`.
fn export_with(gpu: &Gpu, frames: &styk_engine::export::ExportFrames, settings: Settings, tile: u32, tick: u32, matte: bool, edit: impl Fn(&mut styk_draw::DrawList)) -> (Vec<u8>, usize) {
    let generation = frames.generation().clone();
    let mut exporter = GpuExport::new(&gpu.device, &gpu.queue, settings, tile);
    exporter.prepare_sprites(generation.lineage, &generation.assets);
    let images = frames.take_images(usize::MAX);
    exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
    // Pictures are taken once: keep them for the next exporter of the same test.
    let frame = frames.take(tick).unwrap();
    let mut list = (*frame.list).clone();
    edit(&mut list);
    let pixels = exporter.frame_blocking(&generation.prepared.doc, &std::sync::Arc::new(list), frame.camera.as_ref(), matte).unwrap();
    (pixels, exporter.tiles().len())
}

/// Takes the scene's background out of a draw list (its first records), leaving the figures on transparency.
fn clear_background(list: &mut styk_draw::DrawList) {
    let background = list.background_prims as usize;
    list.prims[..background].iter_mut().for_each(|p| p.kind = 0);
}

fn difference(a: &[u8], b: &[u8], at: usize) -> u8 {
    (0..4).map(|k| a[at * 4 + k].abs_diff(b[at * 4 + k])).max().unwrap()
}

/// The app-parity rule (D13): pixels differing by more than 32
/// levels together with all eight neighbours, and the mean difference not counting
/// differences of two levels or less.
fn d13(a: &[u8], b: &[u8], width: usize) -> (usize, f64) {
    let n = a.len() / 4;
    let height = n / width;
    let d: Vec<u8> = (0..n).map(|i| difference(a, b, i)).collect();
    let mut solid = 0;
    for y in 1..height.saturating_sub(1) {
        for x in 1..width - 1 {
            if (0..9).all(|k| d[(y + k / 3 - 1) * width + x + k % 3 - 1] > 32) {
                solid += 1;
            }
        }
    }
    let sum: f64 = d.iter().filter(|&&v| v > 2).map(|&v| v as f64).sum();
    (solid, sum / n as f64)
}

/// The tile side of an export of `settings` in tiles of at most `max` rendered pixels.
fn tiled_side(settings: &Settings, max: u32) -> u32 {
    styk_export::tiles::tiles(settings.render_size(), max, settings.smoothing.factor())[0].size[0]
}

/// Pixels on either side of a vertical tile edge (output columns every `side`), and how many
/// of them differ by more than two levels.
fn seams(a: &[u8], b: &[u8], width: usize, side: usize) -> (usize, usize) {
    let height = a.len() / 4 / width;
    let (mut band, mut differ) = (0, 0);
    for edge in (side..width).step_by(side) {
        for y in 0..height {
            for x in [edge - 1, edge] {
                band += 1;
                differ += (difference(a, b, y * width + x) > 2) as usize;
            }
        }
    }
    (band, differ)
}

fn differing(a: &[u8], b: &[u8]) -> (usize, u8) {
    let mut count = 0;
    let mut largest = 0;
    for (p, q) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0.iter()) {
        let d = (0..4).map(|k| p[k].abs_diff(q[k])).max().unwrap();
        largest = largest.max(d);
        count += (d > 0) as usize;
    }
    (count, largest)
}

#[test]
fn tiles_draw_the_pixels_of_the_whole_frame() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    // Generated effects; 3D faces; text; scene effects through the camera.
    for (path, tick) in [
        ("engine/crates/styk-eval/tests/fixtures/generators/explosions.json", 9),
        ("engine/crates/styk-eval/tests/fixtures/spatial/mesh-instances.json", 1),
        ("engine/crates/styk-eval/tests/fixtures/drawlist/outlined-text.json", 0),
        ("engine/crates/styk-eval/tests/fixtures/vfx/scene-clips.json", 6),
    ] {
        for smoothing in [Smoothing::Edges, Smoothing::Sprites] {
            let settings = Settings::new(1280, 720, smoothing, MAX_PIXELS).unwrap();
            let (whole, one) = export(&gpu, &open(path).1, settings, styk_export::TILE_SIDE, tick, false);
            let (tiled, many) = export(&gpu, &open(path).1, settings, 400, tick, false);
            assert_eq!(one, if smoothing == Smoothing::Sprites { 2 } else { 1 });
            assert!(many >= 4, "{path}: {many} tiles");
            // Layers drawn on a grid of their own (text, 3D faces, effects) are cropped to each tile on
            // that grid and placed elsewhere in the atlas: their vertices go through other
            // single-precision translations, so a sample on an edge, or a tie between faces at one
            // depth, may fall the other way, as when the stage pans. The pictures must be the same
            // picture by the app-parity rule (D13), and no seam may run along a tile's edge.
            let (count, largest) = differing(&whole, &tiled);
            let (solid, mean) = d13(&whole, &tiled, settings.width as usize);
            assert!(solid == 0 && mean <= 0.25, "{path} {smoothing:?}: {solid} solid pixels, mean {mean:.4} between the whole frame and {many} tiles");
            let (band, seams) = seams(&whole, &tiled, settings.width as usize, (tiled_side(&settings, 400) / smoothing.factor()) as usize);
            assert!(seams * 100 <= band, "{path} {smoothing:?}: {seams} of {band} pixels along tile edges differ by more than 2 levels");
            eprintln!("{path} {smoothing:?}: {count} pixels differ, by up to {largest}; mean {mean:.4}; {seams} of {band} along tile edges ({many} tiles)");
        }
    }
}

#[test]
fn no_smoothing_draws_hard_edges_and_keeps_opacity() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    // Painted limbs, their background taken away: smooth edges leave partly covered pixels, crisp ones do not.
    let path = "engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json";
    let partial = |pixels: &[u8]| pixels.as_chunks::<4>().0.iter().filter(|p| p[3] != 0 && p[3] != 255).count();
    let (_engine, frames) = open(path);
    let settings = |smoothing| Settings::new(800, 600, smoothing, MAX_PIXELS).unwrap();
    let (smooth, _) = export_with(&gpu, &frames, settings(Smoothing::Edges), styk_export::TILE_SIDE, 0, false, clear_background);
    let (_engine, frames) = open(path);
    let (crisp, _) = export_with(&gpu, &frames, settings(Smoothing::None), styk_export::TILE_SIDE, 0, false, clear_background);
    let drawn = crisp.as_chunks::<4>().0.iter().filter(|p| p[3] != 0).count();
    assert!(drawn > 1000, "the figure is drawn ({drawn} pixels)");
    assert!(partial(&smooth) > 100, "smooth edges are antialiased ({} partial pixels)", partial(&smooth));
    let opaque_figure = smooth.as_chunks::<4>().0.iter().filter(|p| p[3] == 255).count();
    assert!(opaque_figure > 0);
    assert_eq!(partial(&crisp), 0, "no smoothing: every pixel is in or out");
}

#[test]
fn smooth_sprites_average_a_frame_drawn_twice_as_large() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    // Sprites of generated effects, and additive, translucent particles.
    for (path, tick) in [("engine/crates/styk-eval/tests/fixtures/generators/smoke.json", 12), ("engine/crates/styk-eval/tests/fixtures/generators/explosions.json", 9)] {
        let (_engine, frames) = open(path);
        let (sprites, _) = export(&gpu, &frames, Settings::new(640, 360, Smoothing::Sprites, MAX_PIXELS).unwrap(), styk_export::TILE_SIDE, tick, false);
        let (_engine, frames) = open(path);
        let (large, _) = export(&gpu, &frames, Settings::new(1280, 720, Smoothing::Edges, MAX_PIXELS).unwrap(), styk_export::TILE_SIDE, tick, false);
        // The large frame's straight pixels, premultiplied again and averaged by the JavaScript rule.
        let mut expected = vec![0u8; 640 * 360 * 4];
        for y in 0..360 {
            for x in 0..640 {
                let at = |dx: usize, dy: usize| &large[((2 * y + dy) * 1280 + 2 * x + dx) * 4..][..4];
                let block = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
                let alpha: f64 = block.iter().map(|p| p[3] as f64).sum();
                let out = &mut expected[(y * 640 + x) * 4..][..4];
                out[3] = (alpha / 4.0).round() as u8;
                if alpha > 0.0 {
                    for c in 0..3 {
                        out[c] = (block.iter().map(|p| p[c] as f64 * p[3] as f64).sum::<f64>() / alpha).round() as u8;
                    }
                }
            }
        }
        // Unpremultiplied once more in the large frame, a translucent colour moves by a level.
        let (count, largest) = differing(&sprites, &expected);
        assert!(largest <= 1, "{path}: {count} pixels differ by up to {largest}");
    }
}

#[test]
fn video_without_alpha_is_over_black() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let path = "engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json";
    let (_engine, frames) = open(path);
    let settings = Settings::new(400, 300, Smoothing::Edges, MAX_PIXELS).unwrap();
    let (clear, _) = export_with(&gpu, &frames, settings, styk_export::TILE_SIDE, 0, false, clear_background);
    let (_engine, frames) = open(path);
    let (matte, _) = export_with(&gpu, &frames, settings, styk_export::TILE_SIDE, 0, true, clear_background);
    assert!(clear.as_chunks::<4>().0.iter().any(|p| p[3] > 0 && p[3] < 255), "edges are translucent on transparency");
    for (p, q) in clear.as_chunks::<4>().0.iter().zip(matte.as_chunks::<4>().0.iter()) {
        assert_eq!(q[3], 255);
        for c in 0..3 {
            let over_black = (p[c] as u32 * p[3] as u32 + 127) / 255;
            assert!((q[c] as i32 - over_black as i32).abs() <= 1, "{p:?} over black is {q:?}");
        }
    }
}
