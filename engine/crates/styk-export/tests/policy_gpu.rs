//! Real export mode changes retain the same atlas and drawing image uploads.
use std::{path::Path, time::Instant};
use styk_engine::{Budgets, Engine};
use styk_export::{GpuExport, Settings, Smoothing};
use styk_render::wgpu;

#[test]
fn alternating_gpu_export_modes_keep_the_sprite_atlas() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    eprintln!("adapter: {:?}", adapter.get_info());
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
        ..Default::default()
    })).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(&std::fs::read(root.join("alternating-drawing.json")).unwrap(), "json", "policy").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    assert!(!images.is_empty());
    let generation = frames.generation();
    let settings = |smoothing| Settings::new(320, 240, smoothing, styk_export::settings::MAX_PIXELS).unwrap();
    let mut exporter = GpuExport::new(&device, &queue, settings(Smoothing::None), styk_export::TILE_SIDE);
    assert!(exporter.prepare_sprites(generation.lineage, &generation.assets));
    exporter.upload_images(&generation.assets, images.iter().map(|image| &**image));
    let mut first = None;
    for (tick, composited) in [(0, true), (2, false), (0, true)] {
        let frame = frames.take(tick).unwrap();
        assert_eq!(frame.list.composited_export, composited);
        let start = Instant::now();
        let actual = exporter.frame_blocking(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();
        eprintln!("mode {composited} tick {tick}: {:.3} ms (diagnostic, includes mode preparation/draw/readback)", start.elapsed().as_secs_f64() * 1000.0);
        assert!(!exporter.prepare_sprites(generation.lineage, &generation.assets), "mode changes keep the allocated atlas");
        let mut fresh = GpuExport::new(&device, &queue, settings(if composited {Smoothing::Edges} else {Smoothing::None}), styk_export::TILE_SIDE);
        fresh.prepare_sprites(generation.lineage, &generation.assets);
        fresh.upload_images(&generation.assets, images.iter().map(|image| &**image));
        let expected = fresh.frame_blocking(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();
        assert_eq!(actual, expected, "tick {tick}: a mode change preserves the uploaded drawing");
        if tick == 0 {
            if let Some(ref first) = first { assert_eq!(&actual, first); }
            else { first = Some(actual); }
        }
    }
    // Actual Editor-built depth and additive records require the lazily built
    // sample-dependent pipelines too, including after the crisp middle frame.
    let plain_engine = Engine::new(|| 0.0, Budgets::for_device(None));
    plain_engine.open(&std::fs::read(root.join("plain-vector.json")).unwrap(), "json", "policy").unwrap();
    let plain_frames = plain_engine.export_frames(0).unwrap();
    let plain = plain_frames.take(0).unwrap();
    for (name, tick, flag) in [("depth-surface", 0, styk_draw::F_DEPTH), ("generator-additive", 1, styk_draw::F_ADD)] {
        let engine = Engine::new(|| 0.0, Budgets::for_device(None));
        engine.open(&std::fs::read(root.join(format!("{name}.json"))).unwrap(), "json", "policy").unwrap();
        let frames = engine.export_frames(0).unwrap();
        let frame = frames.take(tick).unwrap();
        assert!(frame.list.composited_export);
        assert!(frame.list.prims.iter().any(|p| p.kind & flag != 0), "{name} exercises the actual pipeline");
        let mut exporter = GpuExport::new(&device, &queue, settings(Smoothing::None), styk_export::TILE_SIDE);
        let mut first = None;
        for (current, generation, smoothing) in [(&frame, frames.generation(), Smoothing::Edges), (&plain, plain_frames.generation(), Smoothing::None), (&frame, frames.generation(), Smoothing::Edges)] {
            let actual = exporter.frame_blocking(&generation.prepared.doc, &current.list, current.camera.as_ref(), false).unwrap();
            let expected = GpuExport::new(&device, &queue, settings(smoothing), styk_export::TILE_SIDE).frame_blocking(&generation.prepared.doc, &current.list, current.camera.as_ref(), false).unwrap();
            assert_eq!(actual, expected, "{name}: smooth/crisp/smooth matches fresh pipelines");
            if current.list.composited_export {
                if let Some(ref first) = first { assert_eq!(&actual, first); }
                else { first = Some(actual); }
            }
        }
    }
}
