//! The CPU rasterizer against the GPU renderer on the same draw lists, by the app's
//! pixel-parity rule (D13, docs/engine/decisions/0013-app-parity-rule.md; never changed to
//! pass): no pixel differing by more than 32 levels together with all eight neighbours,
//! and a mean difference, not counting differences of two levels or less, of at most 0.25.
//! Repository documents with text, 3D faces, filter and generated effects and drawing cels,
//! framed as frame thumbnails are. Skipped where no GPU adapter exists; `styk raster-parity`
//! runs the whole corpus.

use std::path::Path;
use std::sync::Arc;

use styk_eval::drawlist::{encode_with, DrawList, Overrides};
use styk_eval::vfx::generated::{self, Evaluate};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

struct Case {
    file: &'static str,
    tick: f64,
    size: [u32; 2],
}

const CASES: [Case; 6] = [
    Case { file: "engine/crates/styk-eval/tests/fixtures/spatial/mesh-instances.json", tick: 1.0, size: [512, 288] },
    Case { file: "engine/crates/styk-eval/tests/fixtures/drawlist/outlined-text.json", tick: 0.0, size: [320, 160] },
    Case { file: "engine/crates/styk-eval/tests/fixtures/generators/smoke.json", tick: 12.0, size: [512, 288] },
    Case { file: "engine/crates/styk-eval/tests/fixtures/vfx/pose-native.json", tick: 6.0, size: [320, 192] },
    Case { file: "engine/crates/styk-eval/tests/fixtures/generators/explosions.json", tick: 6.0, size: [512, 288] },
    Case { file: "engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json", tick: 0.0, size: [96, 54] },
];

/// The frame of `case` and the view a frame thumbnail card shows it with (the canvas fitted
/// and centred through the scene camera, `styk_engine::thumbnails::card`).
fn frame(case: &Case) -> (styk_eval::eval::Prepared, styk_eval::assets::Assets, DrawList, ViewParams) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(case.file);
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap_or_else(|e| panic!("{}: {e}", case.file)));
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let frame = prepared.evaluate(case.tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = generated::build(&prepared, &frame, &scene, Some(case.tick), Some(&Evaluate), 1.0);
    let list = encode_with(&prepared.doc, &assets, &scene, &Overrides { generators: batch.as_ref(), ..Default::default() });
    let (cw, ch) = (prepared.doc.canvas[0] as f64, prepared.doc.canvas[1] as f64);
    let [w, h] = case.size.map(|v| v as f64);
    let zoom = (w / cw).min(h / ch);
    let pan = [(w - cw * zoom) / 2.0, (h - ch * zoom) / 2.0];
    let view = ViewParams {
        matrix: styk_eval::view::camera_matrix(&prepared.doc, scene.camera.as_ref(), zoom, pan),
        artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
        clip_to_artboard: true,
        clear: [245.0 / 255.0, 245.0 / 255.0, 245.0 / 255.0, 1.0],
        zoom,
        pan,
        stretch: 1.0,
        camera_view: true,
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    (prepared, assets, list, view)
}

/// Solid pixels and the mean difference beyond two levels (D13).
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

#[test]
fn the_cpu_draws_what_the_gpu_draws() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: adapter.limits(), ..Default::default() })).expect("device");
    let mut failures = Vec::new();
    for case in &CASES {
        let (prepared, assets, list, view) = frame(case);
        let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        renderer.prepare_sprites(&assets);
        renderer.upload_images(&assets, &styk_render::decode_images(&prepared.doc, &assets));
        renderer.set_list(&Arc::new(list.clone()));
        let mut encoder = device.create_command_encoder(&Default::default());
        renderer.render(&mut encoder, &view, case.size);
        queue.submit([encoder.finish()]);
        let (_, _, gpu) = read_frame(&device, &queue, renderer.frame_texture().expect("a frame"));
        let cpu = styk_raster::render(&list, &styk_raster::decode_all(&prepared.doc, &assets), &view, case.size, styk_raster::Edges::Smooth).pixels;
        let (solid, mean) = d13(&gpu, &cpu, case.size[0] as usize);
        eprintln!("{} tick {} at {}×{}: {solid} solid pixels, mean {mean:.4}", case.file, case.tick, case.size[0], case.size[1]);
        if solid > 0 || mean > 0.25 {
            failures.push(format!("{} tick {}: {solid} solid pixels, mean {mean:.4}", case.file, case.tick));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
