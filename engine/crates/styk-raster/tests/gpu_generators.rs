//! Generated effects on the GPU and the CPU (styk-draw `K_PARTICLE`, `K_BEAM`;
//! docs/engine/vfx.md): both renderers draw the same particles, shapes, materials
//! and light.
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

/// Renders `list` of `size` at one pixel a world unit on both renderers (`None` for the GPU without an adapter).
fn both(list: &DrawList, size: [u32; 2]) -> (Vec<u8>, Option<Vec<u8>>) {
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, size[0] as f64, size[1] as f64], clip_to_artboard: true, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    let cpu = styk_raster::render(list, &styk_raster::Images::default(), &view, size, styk_raster::Edges::Smooth).pixels;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else { return (cpu, None) };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_list(&Arc::new(list.clone()));
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, size);
    queue.submit([encoder.finish()]);
    (cpu, Some(read_frame(&device, &queue, renderer.frame_texture().expect("a frame")).2))
}

/// Every particle shape and material at three sizes, painted and as light, on white and on dark: the two renderers
/// draw the same picture (the shapes are distances and the materials density fields, shaded alike).
#[test]
fn every_shape_and_material_draws_alike_on_both_renderers() {
    generated::atlas::prepare();
    for background in [0xffffffffu32, 0xff14161cu32] {
        let (list, size) = generated::stage::specimens(background, &[5.0, 18.0, 60.0], 8);
        let (cpu, gpu) = both(&list, size);
        let blank = generated::stage::specimens(background, &[], 8).0;
        let (empty, _) = both(&DrawList { prims: blank.prims[..1].to_vec(), passes: vec![styk_draw::Pass { depth: 0, start: 0, end: 1 }], ..list.clone() }, size);
        let (_, drawn) = difference(&cpu, &empty, 16);
        assert!(drawn > 0.08, "the CPU draws the specimens over {:.1} % of the sheet", drawn * 100.0);
        let Some(gpu) = gpu else {
            eprintln!("skipped on the GPU: no adapter");
            return;
        };
        let (mean, strong) = difference(&gpu, &cpu, 32);
        assert!(mean < 0.6 && strong < 0.004, "background {background:08x}: GPU and CPU differ by {mean:.3} levels on average, {:.3} % of pixels by more than 32", strong * 100.0);
    }
}

/// Paint covers what is under it on any page; light adds to it: lost on white, shining on black; over
/// transparency it is kept, as colour beyond its coverage (exports keep it as a translucent colour).
#[test]
fn paint_covers_and_light_adds_on_any_background() {
    use styk_draw::*;
    let draw = |background: Option<u32>, emissive: f32| -> [u8; 4] {
        let mut prims = Vec::new();
        if let Some(argb) = background {
            prims.push(Prim { kind: K_FILL_VIEW, group: 0, color: argb8(argb), paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] });
        }
        let paints = vec![[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], [0.0, 1.0, 1.0, 0.0], [0.0; 4], [0.0; 4], [0.0; 4]];
        prims.push(Prim { kind: particle_kind(P_DISC), group: 0, color: 0, paint: 0, a: [16.0, 16.0, 12.0, 0.0], b: [0.0, 0.0, emissive, 0.0], c: [1.0, 0.5, 0.0, 1.0] });
        let end = prims.len() as u32;
        let list = DrawList { prims, paints, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end }], background_prims: u32::from(background.is_some()), ..Default::default() };
        let (cpu, gpu) = both(&list, [32, 32]);
        let at = (16 * 32 + 16) * 4;
        if let Some(gpu) = gpu {
            assert!((0..4).all(|c| gpu[at + c].abs_diff(cpu[at + c]) <= 2), "GPU {:?} CPU {:?}", &gpu[at..at + 4], &cpu[at..at + 4]);
        }
        [cpu[at], cpu[at + 1], cpu[at + 2], cpu[at + 3]]
    };
    let (white, black) = (Some(0xffffffff), Some(0xff000000));
    // Paint: orange on both.
    assert_eq!(draw(white, 0.0), [255, 128, 0, 255]);
    assert_eq!(draw(black, 0.0), [255, 128, 0, 255]);
    // Light: nothing on white, orange light on black.
    assert_eq!(draw(white, 1.0), [255, 255, 255, 255]);
    assert_eq!(draw(black, 1.0), [255, 128, 0, 255]);
    // Half and half: paint enough to be seen on white, light enough to glow.
    let half = draw(white, 0.5);
    assert!(half[2] < 140 && half[1] > 180, "{half:?}");
    // Over transparency, light is colour beyond its coverage; paint covers.
    assert_eq!(draw(None, 1.0), [255, 128, 0, 0]);
    assert_eq!(draw(None, 0.0), [255, 128, 0, 255]);
}
