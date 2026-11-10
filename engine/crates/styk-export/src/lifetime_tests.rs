use super::*;
use crate::{Settings,Smoothing};
use std::sync::mpsc;
struct Finished(mpsc::Sender<()>);
impl Drop for Finished { fn drop(&mut self) { let _ = self.0.send(()); } }

#[test]
fn readbacks_reuse_buffers_and_release_at_export_end() {
    // A machine without a graphics adapter (a Linux runner) has no readbacks to test.
    let Ok(gpu) = styk_render::native_gpu::native_gpu(false,"readback lifetime",|a| wgpu::Limits::default().using_resolution(a.limits())) else { eprintln!("skipped: no graphics adapter"); return; };
    let engine = styk_engine::Engine::for_export(||0.,styk_engine::Budgets::for_device(None));
    engine.open(include_bytes!("../../styk-eval/tests/fixtures/drawlist/drawing-cel.json"),"json","reuse").unwrap();
    let frames = engine.export_frames(0).unwrap();
    let settings = Settings::new(128,128,Smoothing::Edges,crate::settings::MAX_PIXELS).unwrap();
    let mut source = crate::FrameRenderer::Gpu(GpuExport::new(&gpu.device,&gpu.queue,settings,64),None);
    source.load_images(&engine,&frames).unwrap();
    let crate::FrameRenderer::Gpu(export,_) = &source else { unreachable!() };
    let buffers = export.readbacks.to_vec();
    let frame = frames.take(0).unwrap();
    let mut pixels = Vec::new();
    for _ in 0..3 {
        source.prepare_frame(&engine,&frames,&frame.list).unwrap();
        source.frame_into(&frames.generation().prepared.doc,&frame.list,frame.camera.as_ref(),false,&mut pixels).unwrap();
        let crate::FrameRenderer::Gpu(export,_) = &source else { unreachable!() };
        assert_eq!(&*export.readbacks,&buffers);
    }
    drop(buffers);
    let (tx,rx) = mpsc::channel();
    let crate::FrameRenderer::Gpu(export,_) = &mut source else { unreachable!() };
    export.retain(Box::new(Finished(tx)));
    drop(source);
    rx.recv_timeout(std::time::Duration::from_secs(30)).expect("export disposer finished");
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(!gpu.device.generate_allocator_report().unwrap().allocations.iter().any(|a| a.name == "styk export read-back" || a.name == "styk sprites"));
}
