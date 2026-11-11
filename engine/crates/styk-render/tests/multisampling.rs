//! The preview's quality ladder lowers the samples per pixel of edges (`Renderer::set_multisampled`):
//! a polygon's slanted edge has partly covered pixels with four samples and none with one, and the
//! frame is drawn again either way without a new renderer. Skipped where no GPU adapter exists.

use std::sync::Arc;
use styk_draw::*;
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

fn scene() -> DrawList {
    // One triangle whose hypotenuse crosses pixels at every angle.
    let triangle = Prim { kind: K_TRI, group: 0, color: 0xff00_00ff, paint: NO_PAINT, a: [2.0, 2.0, 61.0, 5.0], b: [3.0, 61.0, 0.0, 0.0], c: [0.0, 0.0, 10.0, 0.0] };
    DrawList {
        prims: vec![triangle],
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 64.0, 64.0], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end: 1 }],
        background_prims: 0,
        ..Default::default()
    }
}

/// How many pixels of the frame are neither empty nor fully covered.
fn partial_pixels(renderer: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue) -> usize {
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, [64, 64]);
    queue.submit([encoder.finish()]);
    let (_, _, pixels) = read_frame(device, queue, renderer.frame_texture().expect("a frame"));
    pixels.chunks_exact(4).filter(|p| p[3] != 0 && p[3] != 255).count()
}

#[test]
fn one_sample_covers_edges_fully_or_not_at_all_and_four_cover_them_in_part() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_list(&Arc::new(scene()));
    assert!(renderer.multisampled());
    assert!(partial_pixels(&mut renderer, &device, &queue) > 20, "four samples leave partly covered edge pixels");
    renderer.set_multisampled(false);
    assert!(!renderer.multisampled());
    assert_eq!(partial_pixels(&mut renderer, &device, &queue), 0, "one sample leaves none");
    renderer.set_multisampled(true);
    assert!(partial_pixels(&mut renderer, &device, &queue) > 20, "and four are restored");
}
