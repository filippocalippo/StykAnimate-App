//! `frame_into` draws the pixels of `frame_blocking` (GPU) and `frame` (CPU) into a buffer the caller owns, with tiles
//! drawn a batch at a time, and reuses that buffer: a frame is the same whatever the buffer held before.

use std::path::Path;

use styk_engine::{Budgets, Engine};
use styk_export::{CpuExport, GpuExport, Settings, Smoothing};
use styk_render::wgpu;

fn gpu() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()), ..Default::default() })).ok()
}

#[test]
fn a_frame_into_a_reused_buffer_equals_the_allocating_frame() {
    let Some((device, queue)) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(&std::fs::read(root.join("alternating-drawing.json")).unwrap(), "json", "policy").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let generation = frames.generation();
    for smoothing in [Smoothing::Edges, Smoothing::Sprites] {
        // 100-pixel tiles: a 320 x 240 frame is twelve of them, more than the read-back slots, so batches repeat.
        let settings = Settings::new(320, 240, smoothing, styk_export::settings::MAX_PIXELS).unwrap();
        let mut exporter = GpuExport::new(&device, &queue, settings, 100);
        exporter.prepare_sprites(generation.lineage, &generation.assets);
        exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
        let mut cpu = CpuExport::new(settings, 100);
        cpu.use_assets(generation.assets.clone());
        cpu.upload_images(&generation.assets, images.iter().cloned());
        let mut buffer = vec![0xAB; 17];
        for matte in [false, true] {
            for tick in [0, 2, 0] {
                let frame = frames.take(tick).unwrap();
                let expected = exporter.frame_blocking(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), matte).unwrap();
                exporter.frame_into(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), matte, &mut buffer).unwrap();
                assert_eq!(buffer, expected, "{smoothing:?} matte={matte} tick {tick}: GPU");
                let expected = cpu.frame(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), matte).unwrap();
                let mut cpu_buffer = vec![1; 3];
                cpu.frame_into(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), matte, &mut cpu_buffer).unwrap();
                assert_eq!(cpu_buffer, expected, "{smoothing:?} matte={matte} tick {tick}: CPU");
            }
        }
    }
}

/// Review finding 2: a frame waiting for the GPU could not be cancelled. An interrupt ends the frame in progress and
/// every later one; the wait is on the interrupt's condition variable, not on the GPU.
#[test]
fn an_interrupt_ends_the_frame_in_progress_and_every_later_one() {
    let Some((device, queue)) = gpu() else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(&std::fs::read(root.join("alternating-drawing.json")).unwrap(), "json", "policy").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let generation = frames.generation();
    let settings = Settings::new(2048, 2048, Smoothing::Edges, styk_export::settings::MAX_PIXELS).unwrap();
    let mut exporter = GpuExport::new(&device, &queue, settings, 512);
    exporter.prepare_sprites(generation.lineage, &generation.assets);
    exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
    let frame = frames.take(0).unwrap();
    let mut buffer = Vec::new();
    exporter.frame_into(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false, &mut buffer).expect("a frame before the interrupt");
    let interrupt = exporter.interrupt();
    // From another thread, while frames are being drawn: some frame must end with the interrupt, and none after it works.
    let stopper = std::thread::spawn({
        let interrupt = interrupt.clone();
        move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            interrupt.interrupt();
        }
    });
    let mut ended = None;
    for n in 0..10_000 {
        if let Err(error) = exporter.frame_into(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false, &mut buffer) {
            ended = Some((n, error));
            break;
        }
    }
    stopper.join().unwrap();
    let (_, error) = ended.expect("the frames went on after the interrupt");
    assert_eq!(error, styk_export::interrupt::INTERRUPTED);
    assert!(exporter.frame_into(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false, &mut buffer).is_err(), "later frames stay interrupted");
}
