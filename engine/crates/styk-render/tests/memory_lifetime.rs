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
fn exact_layers_keep_capacity_for_the_document_lifetime() {
    let mut renderer = make_renderer();
    let pixels = draw(&mut renderer, &scene(8));
    assert!(pixels.iter().any(|&b| b != 0), "real isolated artwork was rendered");
    assert!(renderer.stats.layer_bytes >= 8 * 256 * 256 * 4);
    let held = renderer.stats.layer_bytes;
    let one = draw(&mut renderer, &scene(1));
    assert_eq!(renderer.stats.layer_bytes, held, "smaller frames reuse capacity");
    assert_eq!(one, draw(&mut make_renderer(), &scene(1)));
}
#[test]
fn a_plain_frame_keeps_isolation_and_its_multisampled_target() {
    let mut renderer = make_renderer();
    draw(&mut renderer, &scene(8));
    let held = (renderer.stats.layer_bytes, renderer.target_bytes());
    let empty = draw(&mut renderer, &scene(0));
    assert!(empty.iter().all(|&b| b == 0));
    assert_eq!((renderer.stats.layer_bytes, renderer.target_bytes()), held,
        "unused capacity stays available to the next frame");
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
fn a_large_transient_target_returns_its_allocator_reservation() {
    // The headless video path uses wgpu's default backend choice.
    let gpu = styk_render::native_gpu::native_gpu(false,
        "transient reservation", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    let reserved = || gpu.device.generate_allocator_report().unwrap().total_reserved_bytes;
    let before = reserved();
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("transient 32 MiB target"),
        size: wgpu::Extent3d { width:4096, height:2048, depth_or_array_layers:1 },
        mip_level_count:1, sample_count:1, dimension:wgpu::TextureDimension::D2,
        format:wgpu::TextureFormat::Rgba8Unorm,
        usage:wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats:&[],
    });
    assert!(reserved() >= before + (32 << 20));
    texture.destroy();
    drop(texture);
    gpu.queue.submit([]);
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert_eq!(reserved(), before, "a retired large target must not leave a pooled allocation behind");
}

#[test]
fn small_native_owners_do_not_grow_large_allocator_blocks() {
    let gpu = styk_render::native_gpu::native_gpu(false,
        "pooled reservation", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    let buffers: Vec<_> = (0..32).map(|_| gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label:Some("small pooled owner"), size:2 << 20,
        usage:wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation:false,
    })).collect();
    let report = gpu.device.generate_allocator_report().unwrap();
    assert!(report.total_allocated_bytes >= 64 << 20);
    assert!(report.blocks.iter().all(|b| b.size <= 16 << 20),
        "small owners must share blocks no larger than 16 MiB: {:?}", report.blocks.iter().map(|b| b.size).collect::<Vec<_>>());
    drop(buffers);
}

#[test]
fn exact_primitive_capacity_keeps_the_high_water_mark() {
    let mut renderer = make_renderer();
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
    let renderer = make_renderer();
    let mut effects = styk_render::effects::executor::Executor::new(renderer.device());
    effects.set_exact(true);
    effects.prepare(renderer.device(), renderer.queue(), [256, 256]);
    let slot = effects.slot_texture(renderer.device(), 0).clone();
    assert_eq!(effects.stats.slot_bytes, 256 * 256 * 4);
    for size in [[256,256],[0,0],[256,256]] {
        effects.begin();
        effects.prepare(renderer.device(), renderer.queue(), size);
        assert_eq!(effects.stats.slot_bytes, 256 * 256 * 4);
        assert_eq!(effects.slot_texture(renderer.device(), 0), &slot);
    }
    drop((slot,effects));
    renderer.device().poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(!renderer.device().generate_allocator_report().unwrap().allocations.iter().any(|a| a.name == "styk effect slot"));
}
