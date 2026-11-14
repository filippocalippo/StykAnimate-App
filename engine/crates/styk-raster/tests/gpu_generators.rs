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

/// A recorded scene's frame with its generated effects and without them.
fn lists(name: &str, tick: f64) -> (DrawList, DrawList) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../styk-eval/tests/fixtures/generators/{name}.json"));
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap());
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = generated::build(&prepared, &frame, &scene, Some(tick), Some(&Evaluate), 1.0).unwrap_or_else(|| panic!("{name} at tick {tick}"));
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

/// Both renderers draw a frame's generated effects alike: what they add over the frame without them
/// covers part of it, and the two pictures differ by little.
fn draws_alike(with: DrawList, without: DrawList) {
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

#[test]
fn particles_draw_on_the_gpu_and_the_cpu_alike() {
    let (with, without) = lists("explosions", 6.0);
    assert!(with.materials != 0 && with.prims.len() > without.prims.len() + 100);
    draws_alike(with, without);
}

/// Beams, their core, body, rim and glow, their charge and splash, and lightning along them.
#[test]
fn beams_draw_on_the_gpu_and_the_cpu_alike() {
    let (with, without) = lists("beams", 11.0);
    assert!(with.prims.iter().filter(|p| p.kind & 255 == styk_draw::K_BEAM).count() >= 2, "the recorded beams fire at tick 11");
    draws_alike(with, without);
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

/// A cartoon shadow side (`Cel`) on a crisp shape: the side away from the light (below, a little to the right in the
/// world, however the shape is turned) takes the shadow colour with a hard edge; the side toward it keeps its own.
#[test]
fn a_cartoon_shadow_darkens_the_side_away_from_the_light() {
    use styk_draw::*;
    for rotation in [0.0f32, 2.0] {
        let paints = vec![[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], [0.0, 1.0, 1.0, 0.0], [0.0; 4], [0.0, 0.0, 0.0, 1.0], [0.2, 0.4, 0.6, 0.3]];
        let prims = vec![
            Prim { kind: K_FILL_VIEW, group: 0, color: argb8(0xffffffff), paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] },
            Prim { kind: particle_kind(P_DISC), group: 0, color: 0, paint: 0, a: [32.0, 32.0, 24.0, rotation], b: [0.0; 4], c: [1.0, 0.8, 0.2, 1.0] },
        ];
        let list = DrawList { prims, paints, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end: 2 }], background_prims: 1, ..Default::default() };
        let (cpu, gpu) = both(&list, [64, 64]);
        let at = |pixels: &[u8], x: usize, y: usize| [pixels[(y * 64 + x) * 4], pixels[(y * 64 + x) * 4 + 1], pixels[(y * 64 + x) * 4 + 2]];
        for (who, pixels) in std::iter::once(("CPU", &cpu)).chain(gpu.as_ref().map(|g| ("GPU", g))) {
            // Toward the light (up and left of the centre): the shape's own colour.
            assert_eq!(at(pixels, 26, 20), [255, 204, 51], "{who}, rotation {rotation}");
            // Away from it, inside the edge: the shadow colour.
            assert_eq!(at(pixels, 40, 50), [51, 102, 153], "{who}, rotation {rotation}");
        }
        if let Some(gpu) = gpu {
            let (mean, strong) = difference(&gpu, &cpu, 32);
            assert!(mean < 0.6 && strong < 0.01, "GPU and CPU differ by {mean:.3} levels, {:.2} % by more than 32", strong * 100.0);
        }
    }
}

/// A beam's body turns to its rim colour toward its edge: a light beam keeps a darker edge on white, on both
/// renderers. Across a horizontal beam 16 wide: the white core, the light body, then the deep rim.
#[test]
fn a_beam_darkens_to_its_rim_toward_its_edge() {
    use styk_draw::*;
    let (core, body, rim) = ([1.0, 1.0, 1.0, 0.0], [0.3, 0.8, 1.0, 0.0], [0.0, 0.15, 0.55, 0.0]);
    let paints = vec![[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], core, body, [0.3, 0.8, 1.0, 1.0], [0.0; 4], rim];
    let prims = vec![
        Prim { kind: K_FILL_VIEW, group: 0, color: argb8(0xffffffff), paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] },
        Prim { kind: K_BEAM, group: 0, color: 0, paint: 0, a: [10.0, 32.0, 118.0, 32.0], b: [16.0, 0.0, 3.0, 0.0], c: [1.0, 0.0, 0.0, 0.0] },
    ];
    let list = DrawList { prims, paints, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end: 2 }], background_prims: 1, ..Default::default() };
    let (cpu, gpu) = both(&list, [128, 64]);
    for (name, picture) in [("CPU", Some(cpu)), ("GPU", gpu)] {
        let Some(picture) = picture else { continue };
        let at = |y: usize| {
            let o = (y * 128 + 90) * 4;
            [picture[o], picture[o + 1], picture[o + 2]]
        };
        let (centre, inside, edge) = (at(32), at(37), at(41));
        let sum = |c: [u8; 3]| c.iter().map(|&v| v as u32).sum::<u32>();
        assert!(centre.iter().all(|&v| v > 235), "{name}: a white core {centre:?}");
        assert!(inside[0] > 60 && inside[1] > 190 && inside[2] > 235, "{name}: the light body inside {inside:?}");
        assert!(sum(edge) + 150 < sum(inside) && edge[2] > edge[1] + 40 && edge[1] > edge[0], "{name}: a deep rim at the edge {edge:?}, inside {inside:?}");
    }
}
