use styk_export::{GpuExport, Settings, Smoothing, TILE_SIDE};
use styk_render::wgpu;

#[test]
fn native_readbacks_are_sized_for_the_single_inflight_tile() {
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "readback memory regression", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    for (width,height,slots) in [(1920,1080,1),(3840,2160,1)] {
        let settings = Settings::new(width,height,Smoothing::Edges,styk_export::settings::MAX_PIXELS).unwrap();
        let export = GpuExport::new(&gpu.device,&gpu.queue,settings,TILE_SIDE);
        assert_eq!(export.slots(),slots,"{width}x{height}: native tiles retire before the next begins");
        assert!(export.slots() <= export.tiles().len());
    }
}

#[test]
fn a_native_4k_export_keeps_only_one_tiles_transients_in_flight() {
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "tile lifetime regression", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    let settings = Settings::new(3840, 2160, Smoothing::Edges, styk_export::settings::MAX_PIXELS).unwrap();
    let export = GpuExport::new(&gpu.device, &gpu.queue, settings, TILE_SIDE);
    assert_eq!(export.tiles().len(), 4);
    assert_eq!(export.slots(), 1, "retire a tile's transient masks and replaced targets before drawing the next");
}
