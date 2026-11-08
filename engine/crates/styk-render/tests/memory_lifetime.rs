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
fn make_renderer() -> Renderer {
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "memory regression", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_exact_sizes(true);
    renderer
}
#[test]
fn exact_layers_release_pages_no_longer_used() {
    let mut renderer = make_renderer();
    let pixels = draw(&mut renderer, &scene(8));
    assert!(pixels.iter().any(|&b| b != 0), "real isolated artwork was rendered");
    assert!(renderer.stats.layer_bytes >= 8 * 256 * 256 * 4);
    let one = draw(&mut renderer, &scene(1));
    assert_eq!(renderer.stats.layer_bytes, 2 * 256 * 256 * 4 + 8,
        "one active parity needs two array layers; the other is a placeholder");
    assert_eq!(one, draw(&mut make_renderer(), &scene(1)));
}
#[test]
fn a_plain_frame_releases_isolation_and_its_multisampled_target() {
    let mut renderer = make_renderer();
    draw(&mut renderer, &scene(8));
    let empty = draw(&mut renderer, &scene(0));
    assert!(empty.iter().all(|&b| b == 0));
    assert_eq!(renderer.stats.layer_bytes, 16, "only two placeholder arrays remain");
    assert_eq!(renderer.target_bytes(), 256 * 256 * 4 * 5,
        "only output and main MSAA remain");
}

#[test]
fn a_native_device_reserves_small_memory_blocks_for_small_work() {
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "allocator regression", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor { label:Some("small workload"), size:1<<20,
        usage:wgpu::BufferUsages::VERTEX|wgpu::BufferUsages::COPY_DST, mapped_at_creation:false });
    gpu.queue.write_buffer(&buffer,0,&[0;256]);
    gpu.queue.submit([]);
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let report = gpu.device.generate_allocator_report().expect("allocator report required");
    // MemoryUsage's documented maximum device/host block sizes: 64 + 32 MiB.
    // This device has only a 1 MiB buffer and wgpu's small initial resources.
    assert!(report.total_reserved_bytes <= 96 << 20,
        "small work reserved {} bytes", report.total_reserved_bytes);
}

#[test]
fn exact_primitive_capacity_follows_the_current_frame() {
    let mut renderer = make_renderer();
    let bytes = |r: &Renderer| r.device().generate_allocator_report().unwrap().allocations.iter()
        .filter(|a| a.name == "styk prims").map(|a| a.size).sum::<u64>();
    // Reports include backend allocation alignment (DX12 adds padding). Compare
    // the real empty owner's allocation, rather than assuming zero padding.
    let empty_bytes = bytes(&renderer);
    let mut large = (*scene(1)).clone();
    large.prims = vec![large.prims[1]; 131_073];
    renderer.set_list(&Arc::new(large));
    renderer.queue().submit([]);
    renderer.device().poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(bytes(&renderer) >= 8 << 20);
    assert!(draw(&mut renderer, &scene(0)).iter().all(|&b| b == 0));
    assert_eq!(bytes(&renderer), empty_bytes, "empty artwork must return to a fresh owner's capacity");
}

#[test]
fn exact_effect_slots_leave_with_the_last_filtered_frame() {
    let renderer = make_renderer();
    let mut effects = styk_render::effects::executor::Executor::new(renderer.device());
    effects.set_exact(true);
    effects.prepare(renderer.device(), renderer.queue(), [256, 256]);
    effects.slot_texture(renderer.device(), 0);
    assert_eq!(effects.stats.slot_bytes, 256 * 256 * 4);
    effects.begin();
    effects.prepare(renderer.device(), renderer.queue(), [0, 0]);
    assert_eq!(effects.stats.slot_bytes, 0, "an exact frame without effects retains no working slots");
}
