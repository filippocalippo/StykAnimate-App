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

#[test]
fn exact_effect_slots_reuse_after_quiet_frames_and_release_at_close() {
    let Some(renderer) = make_renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let mut effects = styk_render::effects::executor::Executor::new(renderer.device());
    effects.set_exact(true);
    effects.prepare(renderer.device(), renderer.queue(), [256, 256]);
    let slot = effects.slot_texture(renderer.device(), 0).clone();
    assert_eq!(effects.stats.slot_bytes, 256 * 256 * 4);
    for _ in 0..241 {
        effects.begin();
        effects.prepare(renderer.device(), renderer.queue(), [0,0]);
        assert_eq!(effects.stats.slot_bytes, 256 * 256 * 4);
    }
    effects.begin();
    effects.prepare(renderer.device(), renderer.queue(), [256,256]);
    assert_eq!(effects.slot_texture(renderer.device(), 0), &slot);
    drop((slot,effects));
    renderer.device().poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(!renderer.device().generate_allocator_report().unwrap().allocations.iter().any(|a| a.name == "styk effect slot"));
}
