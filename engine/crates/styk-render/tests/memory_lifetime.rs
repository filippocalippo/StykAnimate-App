//! Regressions exercise real render/submit/readback and the retained owners.
use std::sync::Arc;
use styk_draw::{DrawList, Group, Pass, Prim, K_COMPOSITE, K_TRI, NO_LAYER, NO_PAINT};
use styk_render::{Renderer, ViewParams, read_frame, wgpu};

const SIZE: [u32; 2] = [256, 256];
fn scene(count: u32) -> Arc<DrawList> {
    let mut list = DrawList::default();
    list.groups.push(Group { parent:0, depth:0, opacity:1., bounds:[0.,0.,256.,256.], layer:NO_LAYER });
    for g in 1..=count {
        list.groups.push(Group { parent:0, depth:1, opacity:0.5, bounds:[0.,0.,256.,256.], layer:NO_LAYER });
        list.prims.push(Prim { kind:K_COMPOSITE, group:0, color:0x80ffffff, paint:NO_PAINT,
            a:[0.;4], b:[f32::from_bits(g),0.,0.,0.], c:[0.;4] });
    }
    list.passes.push(Pass { depth:0, start:0, end:count });
    for g in 1..=count {
        list.prims.push(Prim { kind:K_TRI, group:g, color:0xff204080, paint:NO_PAINT,
            a:[0.,0.,255.,0.], b:[0.,255.,0.,0.], c:[0.;4] });
    }
    Arc::new(list)
}
fn draw(renderer: &mut Renderer, list: &Arc<DrawList>) -> Vec<u8> {
    renderer.set_list(list);
    let mut encoder = renderer.device().create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &ViewParams { matrix:[1.,0.,0.,1.,0.,0.], artboard:[0.,0.,256.,256.],
        clip_to_artboard:false, clear:[0.;4], zoom:1., pan:[0.;2], stretch:1., camera_view:false,
        camera_limit:styk_render::CAMERA_PREVIEW_LIMIT }, SIZE);
    renderer.queue().submit([encoder.finish()]);
    read_frame(renderer.device(), renderer.queue(), renderer.frame_texture().unwrap()).2
}
/// A renderer on this machine's adapter, or `None` where there is none (a Linux runner): the test then has nothing to measure.
fn make_renderer() -> Option<Renderer> {
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "memory regression", |a| wgpu::Limits::default().using_resolution(a.limits())).ok()?;
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_exact_sizes(true);
    Some(renderer)
}
#[test]
fn exact_layers_keep_capacity_for_the_document_lifetime() {
    let Some(mut renderer) = make_renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let pixels = draw(&mut renderer, &scene(8));
    assert!(pixels.iter().any(|&b| b != 0), "real isolated artwork was rendered");
    assert!(renderer.stats.layer_bytes >= 8 * 256 * 256 * 4);
    let held = renderer.stats.layer_bytes;
    let one = draw(&mut renderer, &scene(1));
    assert_eq!(renderer.stats.layer_bytes, held, "smaller frames reuse capacity");
    assert_eq!(one, draw(&mut make_renderer().unwrap(), &scene(1)));
}
#[test]
fn a_plain_frame_keeps_isolation_and_its_multisampled_target() {
    let Some(mut renderer) = make_renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    draw(&mut renderer, &scene(8));
    let held = (renderer.stats.layer_bytes, renderer.target_bytes());
    let empty = draw(&mut renderer, &scene(0));
    assert!(empty.iter().all(|&b| b == 0));
    assert_eq!((renderer.stats.layer_bytes, renderer.target_bytes()), held,
        "unused capacity stays available to the next frame");
}

#[test]
fn exact_primitive_capacity_keeps_the_high_water_mark() {
    let Some(mut renderer) = make_renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let bytes = |r: &Renderer| r.device().generate_allocator_report().unwrap().allocations.iter()
        .filter(|a| a.name == "styk prims").map(|a| a.size).sum::<u64>();
    let mut large = (*scene(1)).clone();
    large.prims = vec![large.prims[1]; 131_073];
    renderer.set_list(&Arc::new(large));
    renderer.queue().submit([]);
    renderer.device().poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(bytes(&renderer) >= 8 << 20);
    let held = bytes(&renderer);
    assert!(draw(&mut renderer, &scene(0)).iter().all(|&b| b == 0));
    assert_eq!(bytes(&renderer), held, "empty artwork keeps capacity until close");
}

/// Effect textures follow the frames that use them: a frame of the same sizes reuses the textures of the frame before, a frame
/// that needs none (no effect drawn, another zoom level) releases them, and closing frees them all (docs/engine/memory.md).
#[test]
fn effect_textures_are_reused_released_and_freed() {
    use styk_eval::vfx::registry::{Blur, Params, Tint};
    use styk_eval::vfx::{Color, Effect};
    use styk_render::effects::recipe::{record, Frame};
    let Some(renderer) = make_renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let (device, queue) = (renderer.device(), renderer.queue());
    let slots = || {
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        device.generate_allocator_report().unwrap().allocations.iter().filter(|a| a.name == "styk effect slot").map(|a| a.size).sum::<u64>()
    };
    let stack = |radius: f64| vec![
        Arc::new(Effect { id: Arc::from("t"), enabled: true, params: Params::Tint(Tint { color: Color::Rgb(0x0000ff), mix: 0.5, ..Default::default() }) }),
        Arc::new(Effect { id: Arc::from("b"), enabled: true, params: Params::Blur(Blur { radius, ..Default::default() }) }),
    ];
    let frame = |size: [u32; 2], radius: f64| {
        let mut records = Vec::new();
        let run = record(&mut records, &stack(radius), Frame { scale: 1.0, origin: [0.0; 2], output_size: size.map(|n| n as f64) }, size);
        (records, run)
    };
    let mut effects = styk_render::effects::executor::Executor::new(device, true);
    let (records, run) = frame([256, 256], 30.0);
    effects.prepare(device, queue, records, &[&run]);
    let held = effects.stats.slot_bytes;
    assert!(held > 0 && slots() >= held, "the frame's textures exist");
    for _ in 0..3 {
        let (records, run) = frame([256, 256], 30.0);
        effects.prepare(device, queue, records, &[&run]);
        assert_eq!(effects.stats.slot_bytes, held, "the same frame again creates nothing");
    }
    // A close-up: larger layers. The smaller textures are released, then destroyed by the frame after.
    let (records, run) = frame([1024, 1024], 30.0);
    effects.prepare(device, queue, records, &[&run]);
    let (records, run) = frame([1024, 1024], 30.0);
    effects.prepare(device, queue, records, &[&run]);
    let large = effects.stats.slot_bytes;
    assert!(large > held);
    let (records, run) = frame([256, 256], 30.0);
    effects.prepare(device, queue, records, &[&run]);
    effects.prepare(device, queue, Vec::new(), &[]);
    effects.prepare(device, queue, Vec::new(), &[]);
    assert_eq!(effects.stats.slot_bytes, 0, "frames without effects keep no effect texture");
    assert_eq!(slots(), 0, "and the GPU holds none");
    let (records, run) = frame([256, 256], 30.0);
    effects.prepare(device, queue, records, &[&run]);
    assert!(slots() > 0);
    drop(effects);
    assert_eq!(slots(), 0, "closing frees every effect texture");
}
