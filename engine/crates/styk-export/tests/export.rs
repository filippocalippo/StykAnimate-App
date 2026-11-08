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
    // Exact frame comparisons use Vulkan: docs/native/frame-parity.md#dx12-msaa-repeatability-driver-floor.
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
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
        eprintln!("skipped: no Vulkan adapter");
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
        eprintln!("skipped: no Vulkan adapter");
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
        eprintln!("skipped: no Vulkan adapter");
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
        eprintln!("skipped: no Vulkan adapter");
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
        eprintln!("skipped: no Vulkan adapter");
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
        eprintln!("skipped: no Vulkan adapter");
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


/// The drawing-cel fixture with `pictures` more pictures of 4,094² pixels: each takes a 4,096² page of its own, so the cel's page and
/// theirs compete for the layers of an export that keeps two.
fn cel_document(pictures: u32) -> Vec<u8> {
    use base64::Engine as _;
    let text = std::fs::read_to_string(repository("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json")).unwrap();
    let start = text.find("\"image_assets\":[").unwrap();
    let end = start + text[start..].find("}],\"text_assets\"").unwrap() + 1;
    let extra: String = (1..=pictures)
        .map(|i| {
            let mut png = Vec::new();
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4094, 4094, image::Rgba([(i * 70) as u8, 255 - (i * 70) as u8, 90, 255])))
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .unwrap();
            let url = base64::engine::general_purpose::STANDARD.encode(png);
            format!(
                ",{{\"kind\":\"image\",\"asset_index\":{i},\"table_index\":{i},\"mime_type\":\"image/png\",\"width\":4094,\"height\":4094,\"data_url\":\"data:image/png;base64,{url}\",\"anchor_start\":{{\"x\":0,\"y\":0}},\"anchor_end\":{{\"x\":256,\"y\":0}},\"anchor_length\":256,\"anchor_angle_rad\":0,\"display_width\":300,\"display_height\":300}}"
            )
        })
        .collect();
    format!("{}{}{}", &text[..end], extra, &text[end..]).into_bytes()
}

/// A list that draws only `picture` of the document's images (a record naming its place, as the encoder writes one).
fn picture_list(assets: &styk_eval::assets::Assets, picture: usize) -> std::sync::Arc<styk_draw::DrawList> {
    use styk_draw::{DrawList, Group, Pass, Prim, K_IMAGE, NO_LAYER, NO_PAINT};
    let entry = &assets.atlas[picture];
    let prim = Prim { kind: K_IMAGE, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0, 0.0, 10.0, 0.0], b: [0.0, 0.0, entry.layer as f32, 0.0], c: entry.uv() };
    let list = DrawList { prims: vec![prim], groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 960.0, 540.0], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end: 1 }], ..Default::default() };
    std::sync::Arc::new(list)
}

/// An export of the cel document in two layers, with the pictures and the cel it is driven by.
struct CelScene {
    engine: Engine,
    frames: styk_engine::export::ExportFrames,
    generation: std::sync::Arc<styk_engine::Generation>,
    exporter: GpuExport,
    resident: styk_export::resident::Resident,
    /// Two pictures on pages of their own, apart from the cel's.
    pictures: [std::sync::Arc<styk_draw::DrawList>; 2],
    cel: std::sync::Arc<styk_engine::FrameData>,
}

impl CelScene {
    fn new(gpu: &Gpu) -> CelScene {
        let engine = Engine::new(clock, Budgets::for_device(None));
        engine.open(&cel_document(3), "json", "test").unwrap();
        let frames = engine.export_frames(0).unwrap();
        let generation = frames.generation().clone();
        let settings = Settings::new(960, 540, Smoothing::Edges, MAX_PIXELS).unwrap();
        let mut exporter = GpuExport::new(&gpu.device, &gpu.queue, settings, styk_export::TILE_SIDE);
        let mut resident = styk_export::resident::Resident::begin_with_layers(&mut exporter, &frames, 2);
        let cel_pages: Vec<u32> = generation.assets.drawing.iter().filter(|entry| entry.valid).map(|entry| entry.layer).collect();
        let mut seen = Vec::new();
        let pictures: Vec<usize> = (0..generation.assets.atlas.len())
            .filter(|&index| {
                let entry = &generation.assets.atlas[index];
                let fresh = entry.valid && entry.w > 4000 && !cel_pages.contains(&entry.layer) && !seen.contains(&entry.layer);
                if fresh {
                    seen.push(entry.layer);
                }
                fresh
            })
            .collect();
        assert!(pictures.len() >= 2, "two pictures on pages of their own, apart from the cel's: {pictures:?} {cel_pages:?}");
        let cel = loop {
            resident.upload(&mut exporter, &frames, styk_export::resident::UPLOAD_BYTES);
            if let Some(frame) = frames.take(0) {
                break frame;
            }
            assert!(engine.step(), "tick 0 never came");
        };
        let index = styk_engine::PlaceIndex::new(&generation.assets);
        assert!(styk_engine::pictures_of(&cel.list, &index).is_empty(), "the cel's frame asks for no picture, so only the cel is decoded for it");
        let pictures = [picture_list(&generation.assets, pictures[0]), picture_list(&generation.assets, pictures[1])];
        CelScene { engine, frames, generation, exporter, resident, pictures, cel }
    }

    /// Asks once for what `list` draws (nothing is decoded).
    fn ask(&mut self, list: &std::sync::Arc<styk_draw::DrawList>) -> bool {
        self.resident.ready(&mut self.exporter, &self.frames, list, None, 0)
    }

    /// Runs one unit of the engine's work, with the memory unable to hold a cel's decode when `refuse`.
    fn step(&self, refuse: bool) {
        // Above what a picture's own work reserves in these documents is not needed: only the cel's three-fold reserve is over this.
        let work = if refuse { styk_alloc::with_limit(1 << 20, || self.engine.step()) } else { self.engine.step() };
        assert!(work, "there was work to run");
    }

    /// Asks for what `list` draws until it is all in; `refuse` as in [`CelScene::step`].
    fn settle(&mut self, list: &std::sync::Arc<styk_draw::DrawList>, refuse: bool) {
        for _ in 0..4000 {
            if self.ask(list) {
                return;
            }
            if refuse { styk_alloc::with_limit(1 << 20, || self.engine.step()) } else { self.engine.step() };
        }
        panic!("the frame never became ready");
    }

    /// The pictures take both layers, then the cel's page takes the layer of the one shown longest ago, which holds that picture's pixels.
    fn fill(&mut self) {
        let (a, b) = (self.pictures[0].clone(), self.pictures[1].clone());
        self.settle(&a, false);
        self.settle(&b, false);
    }

    fn draw(&mut self) -> Vec<u8> {
        self.exporter.frame_blocking(&self.generation.prepared.doc, &self.cel.list, self.cel.camera.as_ref(), false).unwrap()
    }
}

/// The frame of the cel after the layers were filled with the pictures' pixels and the cel was decoded `refused` (the memory cannot hold
/// its work) or not. With `again`, the pictures come back (the cel's page leaves) and the cel is asked for a second time, with the memory as it was.
fn cel_frame_in_two_layers(gpu: &Gpu, refused: bool, again: bool) -> Vec<u8> {
    let mut scene = CelScene::new(gpu);
    scene.fill();
    let (cel, a, b) = (scene.cel.list.clone(), scene.pictures[0].clone(), scene.pictures[1].clone());
    scene.settle(&cel, refused);
    if again {
        scene.settle(&a, false);
        scene.settle(&b, false);
        scene.settle(&cel, false);
    }
    scene.draw()
}

/// The frame of a document with nothing in the texture: what an export that could not decode the cel draws.
fn cel_frame_never_decoded(gpu: &Gpu) -> Vec<u8> {
    let mut scene = CelScene::new(gpu);
    scene.exporter = {
        let settings = Settings::new(960, 540, Smoothing::Edges, MAX_PIXELS).unwrap();
        let mut exporter = GpuExport::new(&gpu.device, &gpu.queue, settings, styk_export::TILE_SIDE);
        exporter.prepare_sprites(scene.generation.lineage, &scene.generation.assets);
        exporter
    };
    scene.draw()
}

/// A drawing cel the engine refused to decode (its memory could not hold the work) is not shown, as a picture that cannot be decoded is not:
/// its places in the texture are written over, because the layer its page took held another page's pixels (a frame was drawn from the
/// stale texels). Asked for again once the memory is there, the cel is drawn as if it had never failed.
#[test]
fn a_cel_the_engine_refused_to_decode_is_blank_not_the_pixels_its_layer_held_before() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no Vulkan adapter");
        return;
    };
    let shown = cel_frame_in_two_layers(&gpu, false, false);
    let blank = cel_frame_never_decoded(&gpu);
    assert!(differing(&shown, &blank).0 > 100, "the cel is drawn when it is decoded");
    let refused = cel_frame_in_two_layers(&gpu, true, false);
    let (count, largest) = differing(&refused, &blank);
    assert_eq!(count, 0, "a refused cel draws nothing, not its layer's earlier pixels: {count} pixels differ, by up to {largest}");
    let again = cel_frame_in_two_layers(&gpu, true, true);
    let (count, largest) = differing(&again, &shown);
    assert_eq!(count, 0, "asked for again with the memory there, the cel is drawn whole: {count} pixels differ, by up to {largest}");
}

/// The cel is asked for, its page leaves its layer, and it is asked for again before the first attempt has ended: the first attempt
/// ends (refused or not) with the second's tiles and slots in the texture or on their way, and uploads both completions together. What the
/// older attempt brings, tiles or a refusal, is not the second attempt's: the cel is what the second attempt made of it.
fn cel_frame_after_two_overlapping_attempts(gpu: &Gpu, first_refused: bool, second_refused: bool) -> Vec<u8> {
    let mut scene = CelScene::new(gpu);
    scene.fill();
    let (cel, a, b) = (scene.cel.list.clone(), scene.pictures[0].clone(), scene.pictures[1].clone());
    // The cel's page takes the layer of picture `a`'s page; attempt 1 waits in the engine's queue.
    assert!(!scene.ask(&cel));
    // Picture `b` is shown, then `a` is wanted again: the page that was shown longest ago, the cel's, leaves.
    assert!(scene.ask(&b));
    assert!(!scene.ask(&a));
    // The cel is wanted again, still before a decode has run: its page takes the layer of `b`'s page; attempt 2 waits behind `a`.
    assert!(!scene.ask(&cel));
    // Attempt 1, then the picture, then attempt 2 end; the work is uploaded all at once.
    scene.step(first_refused);
    scene.step(false);
    scene.step(second_refused);
    scene.resident.upload(&mut scene.exporter, &scene.frames, styk_export::resident::UPLOAD_BYTES);
    scene.settle(&cel, false);
    scene.draw()
}

#[test]
fn an_older_attempt_to_decode_a_cel_never_touches_a_newer_ones_tiles_or_makes_it_refused() {
    let Some(gpu) = gpu() else {
        eprintln!("skipped: no Vulkan adapter");
        return;
    };
    let shown = cel_frame_in_two_layers(&gpu, false, false);
    let blank = cel_frame_never_decoded(&gpu);
    let mut wrong = Vec::new();
    for (first_refused, second_refused) in [(true, false), (false, false), (true, true), (false, true)] {
        let drawn = cel_frame_after_two_overlapping_attempts(&gpu, first_refused, second_refused);
        let expected = if second_refused { &blank } else { &shown };
        let (count, largest) = differing(&drawn, expected);
        if count != 0 {
            wrong.push(format!(
                "attempt 1 {}, attempt 2 {}: the cel is {} but {count} pixels differ, by up to {largest}",
                if first_refused { "refused" } else { "decoded" },
                if second_refused { "refused" } else { "decoded" },
                if second_refused { "blank" } else { "whole" }
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("
"));
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
        eprintln!("skipped: no Vulkan adapter");
        return;
    };
    for (path, last) in [
        ("engine/crates/styk-eval/tests/fixtures/eval/sticknodes-sprites.json", 5u32),
        ("engine/crates/styk-eval/tests/fixtures/clip-paint/image-identity.json", 3),
        ("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json", 3),
    ] {
        let settings = Settings::new(960, 540, Smoothing::Edges, MAX_PIXELS).unwrap();
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
