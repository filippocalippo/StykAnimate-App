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

/// The draw lists (and cameras) of ticks `0..=last` of `path`, each evaluated once.
fn lists(path: &str, last: u32) -> Vec<(std::sync::Arc<styk_draw::DrawList>, Option<styk_eval::doc::Camera>)> {
    let (_engine, frames) = open(path);
    (0..=last.min(frames.ticks() - 1)).map(|tick| { let frame = frames.take(tick).unwrap(); (frame.list.clone(), frame.camera) }).collect()
}

/// `order` (indexes into `lists`) drawn in turn by one exporter, as an export draws its frames: the pixels and the bytes of the effect
/// slots after each.
fn draw_in_turn(gpu: &Gpu, path: &str, settings: Settings, lists: &[(std::sync::Arc<styk_draw::DrawList>, Option<styk_eval::doc::Camera>)], order: &[usize]) -> Vec<(Vec<u8>, u64)> {
    // Opened afresh: an export takes the decoded pictures once.
    let (_engine, frames) = open(path);
    let generation = frames.generation().clone();
    let mut exporter = GpuExport::new(&gpu.device, &gpu.queue, settings, styk_export::TILE_SIDE);
    exporter.prepare_sprites(generation.lineage, &generation.assets);
    let images = frames.take_images(usize::MAX);
    exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
    order
        .iter()
        .map(|&index| {
            let (list, camera) = &lists[index];
            let pixels = exporter.frame_blocking(&generation.prepared.doc, list, camera.as_ref(), false).unwrap();
            (pixels, exporter.stats().effect_bytes)
        })
        .collect()
}

/// A frame must be the same whatever was drawn before it. The renderer used to keep the layer pages and effect slots at the
/// largest size any earlier frame had needed, and the effect passes address the slots by texel: a frame after a larger one
/// moved the last bit of the positions they sample, and some pixels by one level. Now each frame's sizes are its own. The same
/// draw lists are drawn alone, after the largest frame and after every frame before them.
#[test]
fn a_frame_is_the_same_alone_and_after_the_frames_before_it() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    for (path, last) in [
        ("engine/crates/styk-eval/tests/fixtures/generators/explosions.json", 14u32),
        ("engine/crates/styk-eval/tests/fixtures/vfx/scene-clips.json", 10),
        ("engine/crates/styk-eval/tests/fixtures/vfx/generators.json", 10),
        ("engine/crates/styk-eval/tests/fixtures/generators/auras.json", 10),
    ] {
        let lists = lists(path, last);
        let settings = Settings::new(640, 360, Smoothing::Edges, MAX_PIXELS).unwrap();
        let every: Vec<usize> = (0..lists.len()).collect();
        let together = draw_in_turn(&gpu, path, settings, &lists, &every);
        let alone: Vec<(Vec<u8>, u64)> = every.iter().map(|&index| draw_in_turn(&gpu, path, settings, &lists, &[index]).remove(0)).collect();
        let biggest = (0..alone.len()).max_by_key(|&i| alone[i].1).unwrap();
        for &index in &every {
            let after_biggest = draw_in_turn(&gpu, path, settings, &lists, &[biggest, index]).remove(1);
            // A frame without effects leaves the slots as they were; one with effects has the size its own effects ask for.
            if alone[index].1 > 0 && lists[index].0.layers.iter().any(|layer| layer.effects.is_some()) {
                assert_eq!(after_biggest.1, alone[index].1, "{path}: tick {index} has effect slots of its own size after tick {biggest}");
            }
            let (count, largest) = differing(&alone[index].0, &after_biggest.0);
            assert_eq!(count, 0, "{path}: tick {index} differs from the frame drawn alone in {count} pixels, by up to {largest}, after tick {biggest}");
            let (count, largest) = differing(&alone[index].0, &together[index].0);
            assert_eq!(count, 0, "{path}: tick {index} differs from the frame drawn alone in {count} pixels, by up to {largest}, after the ticks before it");
        }
    }
}


/// A frame of `count` lone glyphs (styk-draw `K_GLYPH`) built here, no document: each glyph is a blob of its own (so each has a
/// mask of its own) at a fractional place, size and angle of the 640×360 view, the places and sizes drawn from `seed`.
fn glyph_frame(seed: u32, count: usize, scale: f64) -> (std::sync::Arc<styk_draw::DrawList>, Option<styk_eval::doc::Camera>) {
    use styk_draw::{DrawList, GlyphInstance, GlyphMask, Group, Pass, Prim, K_GLYPH, NO_LAYER, NO_PAINT};
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(12345);
    let mut next = move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (state >> 8) as f64 / (1u32 << 24) as f64
    };
    let mut list = DrawList::default();
    for index in 0..count {
        // A fan of triangles round a centre, the radius of each spoke its own.
        let spokes = 9;
        let ring: Vec<[f32; 2]> = (0..spokes).map(|k| {
            let angle = k as f64 / spokes as f64 * std::f64::consts::TAU;
            let radius = 30.0 + 20.0 * next();
            [(50.0 + radius * angle.cos()) as f32, (50.0 + radius * angle.sin()) as f32]
        }).collect();
        let triangles: Vec<[f32; 2]> = (0..spokes).flat_map(|k| [[50.0, 50.0], ring[k], ring[(k + 1) % spokes]]).collect();
        let size = scale * (0.6 + 0.8 * next());
        let mask = GlyphMask { bounds: [0.0, 0.0, 100.0, 100.0], origin: [20.0 + 560.0 * next(), 20.0 + 300.0 * next()], angle: 0.4 * next(), scale: [size, size], offset: [0.0, 0.0] };
        list.glyphs.push(GlyphInstance { mask, triangles: triangles.into() });
        list.prims.push(Prim { kind: K_GLYPH, group: 0, color: 0xff20_40c0 + index as u32 * 0x0001_0100, paint: NO_PAINT, a: [0.0; 4], b: [f32::from_bits(index as u32), 0.0, 0.0, 0.0], c: [0.0; 4] });
    }
    list.groups.push(Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 640.0, 360.0], layer: NO_LAYER });
    list.passes.push(Pass { depth: 0, start: 0, end: count as u32 });
    (std::sync::Arc::new(list), None)
}

/// A frame must be the same whatever was drawn before it. A lone glyph's mask is kept in an atlas and sampled at the place it was
/// given, `(place + position in the mask) / atlas side`: the sum rounds with the size of the place, and the bilinear weights of a
/// few pixels at the masks' edges change by a level, so a glyph drawn after others (which took the first places) differed from the
/// same glyph drawn alone. An export now places the masks of each frame afresh.
#[test]
fn a_frame_of_glyphs_is_the_same_alone_and_after_other_frames() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    // Any document does: the lists are made here and only the view's size is the document's.
    let path = "engine/crates/styk-eval/tests/fixtures/eval/sticknodes-sprites.json";
    let lists = [glyph_frame(1, 6, 0.9), glyph_frame(2, 150, 0.7), glyph_frame(3, 40, 1.4)];
    let settings = Settings::new(640, 360, Smoothing::Edges, MAX_PIXELS).unwrap();
    let alone: Vec<Vec<u8>> = (0..lists.len()).map(|index| draw_in_turn(&gpu, path, settings, &lists, &[index]).remove(0).0).collect();
    assert!(alone.iter().all(|pixels| pixels.chunks(4).any(|p| p[..3] != alone[0][..3])), "the glyphs are drawn");
    for order in [[0usize, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]] {
        let drawn = draw_in_turn(&gpu, path, settings, &lists, &order);
        for (turn, &index) in order.iter().enumerate() {
            let (count, largest) = differing(&alone[index], &drawn[turn].0);
            assert_eq!(count, 0, "glyph frame {index} differs from the frame drawn alone in {count} pixels, by up to {largest}, in the order {order:?}");
        }
    }
}

/// Evaluation, not drawing: the draw list of a tick after the ticks before it against its draw list in a fresh engine.
/// Printed, not asserted: what it finds is in the notes of docs/engine/rendering.md.
#[test]
fn probe_evaluation_history() {
    for (path, last) in [
        ("engine/crates/styk-eval/tests/fixtures/generators/explosions.json", 14u32),
        ("engine/crates/styk-eval/tests/fixtures/vfx/scene-clips.json", 10),
        ("engine/crates/styk-eval/tests/fixtures/vfx/generators.json", 10),
        ("engine/crates/styk-eval/tests/fixtures/generators/auras.json", 10),
    ] {
        let text = |frame: &styk_engine::FrameData| format!("{:?}{:?}", frame.list, frame.camera);
        let (_e, after) = open(path);
        let last = last.min(after.ticks() - 1);
        let sequential: Vec<String> = (0..=last).map(|tick| text(&after.take(tick).unwrap())).collect();
        let (_e2, fresh) = open(path);
        let differ: Vec<u32> = (0..=last).filter(|&tick| text(&fresh.take(tick).unwrap()) != sequential[tick as usize]).collect();
        eprintln!("PROBE {path}: draw lists that differ between a fresh engine and one that evaluated the ticks before: {differ:?}");
    }
}

/// The engine with `path` open and nothing decoded: an export that asks for its pictures decodes the cels, then what its frames draw.
fn open_bare(path: &str) -> (Engine, styk_engine::export::ExportFrames) {
    let file = repository(path);
    let bytes = std::fs::read(&file).unwrap();
    let extension = file.extension().unwrap().to_str().unwrap().to_string();
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&bytes, &extension, "test").unwrap();
    let frames = engine.export_frames(0).unwrap();
    (engine, frames)
}

/// A document of many pages is exported with the pictures its frames draw in a few layers of the sprite texture
/// (`styk_export::resident`). Whatever the layers hold, a frame has to be the frame the whole layout gives, to the byte: the
/// fixtures here have pictures and a drawing cel but few pages, so what this tests is that every picture a frame draws is asked
/// for, uploaded, mapped and waited for before the frame is drawn; the pages that leave are tested by exporting a document of
/// twenty pages in the app (scripts/smoke-export-determinism.mjs --file).
#[test]
fn pictures_asked_for_as_frames_need_them_draw_the_frames_the_whole_layout_draws() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    for (path, last) in [
        ("engine/crates/styk-eval/tests/fixtures/eval/sticknodes-sprites.json", 5u32),
        ("engine/crates/styk-eval/tests/fixtures/clip-paint/image-identity.json", 3),
        ("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json", 3),
    ] {
        let settings = Settings::new(640, 360, Smoothing::Edges, MAX_PIXELS).unwrap();
        let (_, whole) = open(path);
        let last = last.min(whole.ticks() - 1);
        let expected: Vec<Vec<u8>> = (0..=last).map(|tick| export(&gpu, &open(path).1, settings, styk_export::TILE_SIDE, tick, false).0).collect();

        let (engine, frames) = open_bare(path);
        let generation = frames.generation().clone();
        let mut exporter = GpuExport::new(&gpu.device, &gpu.queue, settings, styk_export::TILE_SIDE);
        let mut resident = styk_export::resident::Resident::begin(&mut exporter, &frames);
        for tick in 0..=last {
            let frame = loop {
                resident.upload(&mut exporter, &frames, styk_export::resident::UPLOAD_BYTES);
                if let Some(frame) = frames.take(tick) {
                    break frame;
                }
                assert!(engine.step(), "{path}: tick {tick} never came");
            };
            let mut waited = 0;
            while !resident.ready(&mut exporter, &frames, &frame.list, Some(tick), last) {
                assert!(engine.step() || waited < 1000, "{path}: the pictures of tick {tick} never landed");
                waited += 1;
            }
            let pixels = exporter.frame_blocking(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();
            let (count, largest) = differing(&pixels, &expected[tick as usize]);
            assert_eq!(count, 0, "{path}: tick {tick} differs from the frame the whole layout draws in {count} pixels, by up to {largest}");
        }
    }
}
