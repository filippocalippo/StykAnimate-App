use styk_export::{GpuExport, Settings, Smoothing, TILE_SIDE};
use styk_render::wgpu;

#[test]
fn native_readbacks_are_sized_for_the_tiles_of_one_frame() {
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "readback memory regression", |a| wgpu::Limits::default().using_resolution(a.limits())).expect("GPU required");
    for (width,height,slots) in [(1920,1080,1),(3840,2160,4)] {
        let settings = Settings::new(width,height,Smoothing::Edges,styk_export::settings::MAX_PIXELS).unwrap();
        let export = GpuExport::new(&gpu.device,&gpu.queue,settings,TILE_SIDE);
        assert_eq!(export.slots(),slots,"{width}x{height}: do not retain slots no tile can occupy");
        assert!(export.slots() <= export.tiles().len());
    }
}
