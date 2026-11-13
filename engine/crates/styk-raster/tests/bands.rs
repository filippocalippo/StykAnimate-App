//! A frame drawn in bands of rows ([`styk_raster::Raster::bands`], as the stage draws it on the engine's workers without a
//! graphics card) is the frame drawn whole: repository documents with text, 3D faces, filter and generated effects and a
//! drawing cel, upright and on a turned and mirrored view, cut into bands of several heights. Where a band's moved view
//! rounds a vertex or a pixel centre differently in single precision, an edge pixel may differ by a level or two; nothing
//! else may (no pixel beyond two levels, no seam along a band's edge). And the turned view against the GPU renderer.
//! The first test takes about ten seconds: the filter-effect document runs its effects again in every band.

use std::path::Path;
use std::sync::Arc;

use styk_eval::drawlist::{encode_with, DrawList, Overrides};
use styk_eval::vfx::generated::{self, Evaluate};
use styk_raster::{Edges, Images, Raster, ViewParams};

const FILES: [(&str, f64); 7] = [
    ("engine/crates/styk-eval/tests/fixtures/spatial/mesh-instances.json", 1.0),
    ("engine/crates/styk-eval/tests/fixtures/drawlist/outlined-text.json", 0.0),
    ("engine/crates/styk-eval/tests/fixtures/generators/smoke.json", 12.0),
    ("engine/crates/styk-eval/tests/fixtures/vfx/pose-native.json", 6.0),
    ("engine/crates/styk-eval/tests/fixtures/generators/explosions.json", 6.0),
    ("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json", 0.0),
    ("engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json", 0.0),
];

struct Case {
    list: DrawList,
    images: Images,
    doc: Arc<styk_eval::doc::Document>,
    camera: Option<styk_eval::doc::Camera>,
}

fn case(file: &str, tick: f64) -> Option<Case> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(file);
    if !path.exists() {
        return None;
    }
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap_or_else(|e| panic!("{file}: {e}")));
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = generated::build(&prepared, &frame, &scene, Some(tick), Some(&Evaluate), 1.0);
    let list = encode_with(&prepared.doc, &assets, &scene, &Overrides { generators: batch.as_ref(), ..Default::default() });
    let images = styk_raster::decode_all(&prepared.doc, &assets);
    Some(Case { list, images, camera: scene.camera, doc: prepared.doc.clone() })
}

/// The stage's view of `case` at `size`: the canvas fitted with a margin, through the scene camera, turned by `turn` radians
/// and mirrored with `flip` about the artboard's centre (`Stage::draw` in styk-wasm), and that orientation.
fn view(case: &Case, size: [u32; 2], turn: f64, flip: bool) -> (ViewParams, Option<[f64; 6]>) {
    let (cw, ch) = (case.doc.canvas[0] as f64, case.doc.canvas[1] as f64);
    let [w, h] = size.map(|v| v as f64);
    let zoom = (w / cw).min(h / ch) * 0.8;
    let pan = [(w - cw * zoom) / 2.0 + 3.25, (h - ch * zoom) / 2.0 - 1.5];
    let orientation = styk_eval::view::orientation(turn, flip, [pan[0] + cw * zoom / 2.0, pan[1] + ch * zoom / 2.0]);
    let upright = styk_eval::view::camera_matrix(&case.doc, case.camera.as_ref(), zoom, pan);
    let view = ViewParams {
        matrix: orientation.map_or(upright, |o| styk_eval::view::compose(o, upright)),
        artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
        clip_to_artboard: true,
        clear: [0.0; 4],
        zoom,
        pan,
        stretch: 1.0,
        camera_view: case.camera.is_some(),
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    (view, orientation)
}

/// The frame drawn in bands of `rows`, put together.
fn banded(raster: &mut Raster, case: &Case, view: &ViewParams, size: [u32; 2], rows: u32) -> Vec<u8> {
    let bands = raster.bands(&case.list, view, &|| false).expect("not cancelled");
    let mut out = Vec::new();
    let mut y0 = 0;
    while y0 < size[1] {
        let height = rows.min(size[1] - y0);
        let (band, _) = bands.render(&case.list, &case.images, view, size, y0, height, &|| false).expect("not cancelled");
        assert_eq!([band.width, band.height], [size[0], height]);
        out.extend_from_slice(&band.pixels);
        y0 += height;
    }
    out
}

#[test]
fn a_frame_drawn_in_bands_is_the_frame_drawn_whole() {
    let size = [301, 173];
    let mut compared = 0;
    for (file, tick) in FILES {
        let Some(case) = case(file, tick) else { continue };
        for (turn, flip) in [(0.0, false), (0.6, true)] {
            let (view, orientation) = view(&case, size, turn, flip);
            let mut raster = Raster::new(Edges::Smooth);
            raster.set_drawing_grid(styk_raster::DrawingGrid::Destination);
            raster.set_orientation(orientation);
            let whole = raster.render(&case.list, &case.images, &view, size).pixels;
            for rows in [64, 23] {
                let bands = banded(&mut raster, &case, &view, size, rows);
                let worst = whole.iter().zip(&bands).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
                let differ = whole.chunks(4).zip(bands.chunks(4)).filter(|(a, b)| a != b).count();
                eprintln!("{file} turned {turn} in bands of {rows}: {differ} pixels differ, by {worst} levels at most");
                assert!(worst <= 2, "{file} turned {turn}, bands of {rows}: a pixel differs by {worst} levels");
                compared += 1;
            }
        }
    }
    assert!(compared >= 20, "the repository documents are there");
}

#[test]
fn a_turned_view_clips_the_scene_to_the_turned_artboard() {
    // One opaque stroke across the whole view, on a white artboard turned by 30°: inside the artboard's quad the stroke, outside
    // it (but inside the box around it) nothing, and the artboard's fill is the turned quad, not the box.
    use styk_draw::{Group, Pass, Prim, K_CAPSULE, K_FILL_VIEW, NO_LAYER, NO_PAINT};
    let prims = vec![
        Prim { kind: K_FILL_VIEW, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] },
        Prim { kind: K_CAPSULE, group: 0, color: 0xff00_00ff, paint: NO_PAINT, a: [-100.0, 50.0, 300.0, 50.0], b: [8.0, 0.0, 0.0, 0.0], c: [0.0; 4] },
    ];
    let list = DrawList { prims, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end: 2 }], background_prims: 1, ..Default::default() };
    let size = [240, 160];
    let artboard = [70.0, 30.0, 170.0, 130.0];
    let o = styk_eval::view::orientation(30f64.to_radians(), false, [120.0, 80.0]);
    let view = ViewParams { matrix: styk_eval::view::compose(o.unwrap(), [1.0, 0.0, 0.0, 1.0, 70.0, 30.0]), artboard, clip_to_artboard: true, clear: [0.0; 4], zoom: 1.0, pan: [70.0, 30.0], stretch: 1.0, camera_view: false, camera_limit: 2048.0 };
    let mut raster = Raster::new(Edges::Smooth);
    raster.set_orientation(o);
    let pixels = raster.render(&list, &Images::default(), &view, size).pixels;
    let at = |x: usize, y: usize| &pixels[(y * size[0] as usize + x) * 4..][..4];
    // The artboard's centre: the stroke (scene y 50 is the centre row, turned with it).
    assert_eq!(at(120, 80), [255, 0, 0, 255], "the stroke inside the artboard");
    // The upright box's corner, outside the turned quad: neither the fill nor the stroke.
    assert_eq!(at(72, 32), [0, 0, 0, 0], "outside the turned artboard nothing is drawn");
    // Along the stroke's line far beyond the artboard's quad but inside the view: clipped.
    let (s, c) = 30f64.to_radians().sin_cos();
    let beyond = [120.0 + c * 95.0, 80.0 + s * 95.0];
    assert_eq!(at(beyond[0] as usize, beyond[1] as usize), [0, 0, 0, 0], "the stroke stops at the artboard's edge");
}

#[test]
fn a_turned_view_draws_what_the_gpu_draws() {
    use styk_render::{read_frame, wgpu, Renderer};
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: adapter.limits(), ..Default::default() })).expect("device");
    let size = [320, 192];
    let mut failures = Vec::new();
    for (file, tick) in FILES {
        let Some(case) = case(file, tick) else { continue };
        let prepared = styk_eval::prepare(styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(file)).unwrap());
        let assets = styk_eval::assets::Assets::build(&prepared.doc);
        for (turn, flip) in [(0.6, true), (-1.1, false)] {
            let (view, orientation) = view(&case, size, turn, flip);
            let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
            renderer.prepare_sprites(&assets);
            renderer.upload_images(&assets, &styk_render::decode_images(&prepared.doc, &assets));
            renderer.set_orientation(orientation);
            renderer.set_list(&Arc::new(case.list.clone()));
            let mut encoder = device.create_command_encoder(&Default::default());
            renderer.render(&mut encoder, &view, size);
            queue.submit([encoder.finish()]);
            let (_, _, gpu) = read_frame(&device, &queue, renderer.frame_texture().expect("a frame"));
            let mut raster = Raster::new(Edges::Smooth);
            raster.set_orientation(orientation);
            let cpu = raster.render(&case.list, &case.images, &view, size).pixels;
            let (solid, mean) = d13(&gpu, &cpu, size[0] as usize);
            eprintln!("{file} tick {tick} turned {turn}{}: {solid} solid pixels, mean {mean:.4}", if flip { " and mirrored" } else { "" });
            if solid > 0 || mean > 0.25 {
                failures.push(format!("{file} turned {turn}: {solid} solid pixels, mean {mean:.4}"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Solid pixels and the mean difference beyond two levels (D13, as `gpu_parity.rs`).
fn d13(a: &[u8], b: &[u8], width: usize) -> (usize, f64) {
    let n = a.len() / 4;
    let height = n / width;
    let d: Vec<u8> = (0..n).map(|i| (0..4).map(|k| a[i * 4 + k].abs_diff(b[i * 4 + k])).max().unwrap()).collect();
    let mut solid = 0;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            solid += usize::from((0..9).all(|k| d[(y + k / 3 - 1) * width + x + k % 3 - 1] > 32));
        }
    }
    (solid, d.iter().filter(|&&v| v > 2).map(|&v| v as f64).sum::<f64>() / n as f64 + 0.0)
}
