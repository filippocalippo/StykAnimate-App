//! Depth runs on the GPU (styk-draw `K_DEPTH_RESET`, `F_DEPTH`; docs/engine/spatial.md):
//! within a run the nearer face shows whatever the order, a run sits at its place in
//! painter order, and each run starts from a fresh depth. Skipped where no GPU adapter
//! exists. styk-raster's tests draw the same scene on the CPU.

#[path = "support/depth_scene.rs"]
mod depth_scene;

use depth_scene::{scene, EXPECTED};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

#[test]
fn depth_runs_hide_faces_behind_and_keep_painter_order() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_list(&std::sync::Arc::new(scene()));
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, [64, 64]);
    queue.submit([encoder.finish()]);
    let (w, _, pixels) = read_frame(&device, &queue, renderer.frame_texture().expect("a frame"));
    for (x, y, rgb, why) in EXPECTED {
        let i = ((y * w + x) * 4) as usize;
        assert_eq!([pixels[i], pixels[i + 1], pixels[i + 2]], rgb, "{why}");
    }
}
