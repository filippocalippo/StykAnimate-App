//! Generated effects on the GPU and the CPU (styk-draw `K_PARTICLE`, `K_BEAM`,
//! `F_ADD`; docs/engine/vfx.md): an editor-built document with every explosion
//! style draws its particles on both renderers, and the two pictures agree.
//! Skipped where no GPU adapter exists.

use std::path::Path;
use std::sync::Arc;

use styk_eval::drawlist::{encode_with, DrawList, Overrides};
use styk_eval::vfx::generated::{self, Evaluate};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

const SIZE: [u32; 2] = [480, 270];

fn lists() -> (DrawList, DrawList) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/generators/explosions.json");
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap());
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let frame = prepared.evaluate(6.0);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = generated::build(&prepared, &frame, &scene, Some(6.0), Some(&Evaluate), 1.0).expect("explosions at tick 6");
    let with = encode_with(&prepared.doc, &assets, &scene, &Overrides { generators: Some(&batch), ..Default::default() });
    let without = encode_with(&prepared.doc, &assets, &scene, &Overrides::default());
    (with, without)
}

fn view() -> ViewParams {
    // The 960×540 canvas at half size.
    ViewParams { matrix: [0.5, 0.0, 0.0, 0.5, 0.0, 0.0], artboard: [0.0, 0.0, 480.0, 270.0], clip_to_artboard: true, clear: [0.0; 4], zoom: 0.5, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT }
}

fn gpu(device: &wgpu::Device, queue: &wgpu::Queue, list: DrawList) -> Vec<u8> {
    let mut renderer = Renderer::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_list(&Arc::new(list));
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view(), SIZE);
    queue.submit([encoder.finish()]);
    read_frame(device, queue, renderer.frame_texture().expect("a frame")).2
}

fn cpu(list: &DrawList) -> Vec<u8> {
    styk_raster::render(list, &styk_raster::Images::default(), &view(), SIZE, styk_raster::Edges::Smooth).pixels
}

/// Mean absolute difference over channels (levels), and the share of pixels differing by more than `over`.
fn difference(a: &[u8], b: &[u8], over: u8) -> (f64, f64) {
    let (mut sum, mut many) = (0u64, 0usize);
    for (p, q) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0) {
        let d = (0..4).map(|k| p[k].abs_diff(q[k])).max().unwrap();
        sum += (0..4).map(|k| p[k].abs_diff(q[k]) as u64).sum::<u64>();
        many += usize::from(d > over);
    }
    (sum as f64 / a.len() as f64, many as f64 / (a.len() / 4) as f64)
}

#[test]
fn particles_draw_on_the_gpu_and_the_cpu_alike() {
    let (with, without) = lists();
    assert!(with.materials != 0 && with.prims.len() > without.prims.len() + 100);
    let (cpu_with, cpu_without) = (cpu(&with), cpu(&without));
    let (_, drawn) = difference(&cpu_with, &cpu_without, 8);
    assert!(drawn > 0.05, "the CPU draws the particles over {:.1} % of the frame", drawn * 100.0);
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped on the GPU: no adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let (gpu_with, gpu_without) = (gpu(&device, &queue, with), gpu(&device, &queue, without));
    let (_, drawn) = difference(&gpu_with, &gpu_without, 8);
    assert!(drawn > 0.05, "the GPU draws the particles over {:.1} % of the frame", drawn * 100.0);
    let (mean, strong) = difference(&gpu_with, &cpu_with, 32);
    assert!(mean < 0.5 && strong < 0.005, "GPU and CPU differ by {mean:.3} levels on average, {:.2} % of pixels by more than 32", strong * 100.0);
}
