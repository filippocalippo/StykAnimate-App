//! The production paint worker and presenter on a real offscreen GPU target.
#[path = "../../styk-platform/src/spawn.rs"]
mod platform_spawn;
use std::sync::{Arc, mpsc};
use std::time::Duration;
use styk_core::{
    engine::{SceneOptions, wgpu},
    frames::{Config, FrameDocument, Frames},
    stage::{Host, PaintLimits, PaintStatus, Painter, View, Viewport},
};
use styk_engine::{Budgets, Engine, Generation};
use styk_services::{Clock, SystemClock};

struct Source(Engine);
impl Drop for Source {
    fn drop(&mut self) {
        self.0.stop();
    }
}
impl FrameDocument for Source {
    fn picture_engine(&self) -> Option<Engine> {
        Some(self.0.clone())
    }
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<Generation>> {
        self.0.generation().filter(|g| g.revision == revision)
    }
}
fn wait(
    host: &mut Host,
    painter: &mut Painter,
    wake: &mpsc::Receiver<()>,
    clock: &dyn Clock,
) -> PaintStatus {
    let start = clock.now();
    loop {
        host.frames_mut().flush();
        match painter.update() {
            PaintStatus::Pending => {}
            status => return status,
        }
        assert!(
            clock.now() - start < Duration::from_secs(45),
            "stage timed out"
        );
        match wake.recv_timeout(Duration::from_millis(10)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("{e}"),
        }
    }
}
fn gpu() -> styk_render::native_gpu::NativeGpu {
    styk_render::native_gpu::native_gpu(
        wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "stage test",
        |a| wgpu::Limits::default().using_resolution(a.limits()),
    )
    .expect("GPU required; do not silently pass a missing device")
}
fn setup(
    gpu: &styk_render::native_gpu::NativeGpu,
    limits: PaintLimits,
) -> (
    Host,
    Painter,
    Arc<Generation>,
    mpsc::Receiver<()>,
    Arc<SystemClock>,
) {
    setup_bytes(
        gpu,
        limits,
        include_bytes!("../../styk-eval/tests/fixtures/eval/color-transitions.json"),
        "json",
    )
}
fn setup_bytes(
    gpu: &styk_render::native_gpu::NativeGpu,
    limits: PaintLimits,
    bytes: &[u8],
    extension: &str,
) -> (
    Host,
    Painter,
    Arc<Generation>,
    mpsc::Receiver<()>,
    Arc<SystemClock>,
) {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(bytes, extension, "stage scenario").unwrap();
    let generation = engine.generation().unwrap();
    for _ in 0..2 {
        let worker = engine.clone();
        styk_services::Spawner::spawn(
            &platform_spawn::ThreadSpawner,
            "stage-test-pictures",
            Box::new(move || worker.work()),
        )
        .unwrap();
    }
    let source: Arc<dyn FrameDocument> = Arc::new(Source(engine));
    let (tx, rx) = mpsc::sync_channel(1);
    let wake: styk_core::frames::Wake = Arc::new(move || match tx.try_send(()) {
        Ok(()) | Err(mpsc::TrySendError::Full(())) | Err(mpsc::TrySendError::Disconnected(())) => {}
    });
    let clock = Arc::new(SystemClock::new());
    let frames = Frames::new(
        1,
        generation.revision,
        0,
        &source,
        Config::default(),
        &platform_spawn::ThreadSpawner,
        clock.clone(),
        wake.clone(),
    )
    .unwrap();
    let canvas = generation.prepared.doc.canvas;
    let mut host = Host::new(
        frames,
        canvas,
        Viewport {
            size: canvas.map(|x| x as f64),
            ..Default::default()
        },
    )
    .unwrap();
    host.set_view(View::default()).unwrap();
    let painter = Painter::new(
        &gpu.device,
        &gpu.queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &platform_spawn::ThreadSpawner,
        clock.clone(),
        wake,
        limits,
    )
    .unwrap();
    (host, painter, generation, rx, clock)
}
fn shutdown(host: &mut Host, painter: &mut Painter, wake: &mpsc::Receiver<()>, clock: &dyn Clock) {
    painter.close();
    host.close();
    let start = clock.now();
    while !painter.worker_exited() {
        assert!(
            clock.now() - start < Duration::from_secs(10),
            "stage worker did not reclaim its resources"
        );
        match wake.recv_timeout(Duration::from_millis(10)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("{e}"),
        }
    }
}

#[test]
fn painter_presents_export_pixels_and_keeps_its_picture_through_pending_work() {
    let gpu = gpu();
    let (mut host, mut painter, generation, wake, clock) = setup(&gpu, PaintLimits::default());
    let size = host.canvas();
    host.request(0.0, 1.0, 4, SceneOptions::default()).unwrap();
    painter.request(&host).unwrap();
    assert_eq!(
        wait(&mut host, &mut painter, &wake, clock.as_ref()),
        PaintStatus::Ready
    );
    let mut builder = styk_engine::frame_builder::FrameBuilder::default();
    let frame = builder
        .prepare(&generation, 0.0, &SceneOptions::default(), || 0.0, || false)
        .unwrap();
    let settings = styk_export::Settings::new(
        size[0],
        size[1],
        styk_export::Smoothing::Edges,
        styk_export::settings::MAX_PIXELS,
    )
    .unwrap();
    let mut export = styk_export::GpuExport::new(&gpu.device, &gpu.queue, settings, 2048);
    export.prepare_sprites(generation.lineage, &generation.assets);
    let expected = export
        .frame_blocking(
            &generation.prepared.doc,
            &frame.list,
            frame.camera.as_ref(),
            false,
        )
        .unwrap();
    let target = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("host target"),
        size: wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        assert!(painter.present(&mut pass));
    }
    gpu.queue.submit([encoder.finish()]);
    let (_, _, premul) = styk_render::read_frame(&gpu.device, &gpu.queue, &target);
    let mut actual = Vec::new();
    styk_export::pixels::resolve(&premul, size[0] as usize * 4, size, 1, false, &mut actual);
    assert_eq!(
        actual, expected,
        "painter and styk export must produce the same frame"
    );
    assert!(
        actual
            .chunks_exact(4)
            .any(|p| p[3] > 0 && p[..3] != [0, 0, 0]),
        "fixture paints artwork"
    );
    println!(
        "stage painter/export: {} pixels byte-identical on {:?}",
        size[0] * size[1],
        gpu.adapter.get_info().backend
    );
    if let Ok(path) = std::env::var("STYK_STAGE_CAPTURE") {
        // Optional inspection artifact from this public fixture only; opaque
        // white matting makes transparent areas visible in a plain PPM viewer.
        let mut ppm = format!("P6\n{} {}\n255\n", size[0], size[1]).into_bytes();
        for pixel in actual.chunks_exact(4) {
            for &channel in &pixel[..3] {
                ppm.push(
                    ((u32::from(channel) * u32::from(pixel[3])
                        + 255 * (255 - u32::from(pixel[3]))
                        + 127)
                        / 255) as u8,
                );
            }
        }
        std::fs::write(path, ppm).expect("write fixture inspection artifact");
    }
    let original = styk_render::read_frame(&gpu.device, &gpu.queue, painter.texture().unwrap()).2;
    host.pan_by([19.25, -8.5]).unwrap();
    for x in 0..100 {
        host.set_view(View {
            pan: [x as f64, -8.5],
            rotation: 0.125,
            flip: true,
            ..View::default()
        })
        .unwrap();
        host.request(0.5, 0.75, 1, SceneOptions::default()).unwrap();
        painter.request(&host).unwrap();
    }
    // Before update accepts anything, the worker must not mutate the shown texture.
    assert_eq!(
        styk_render::read_frame(&gpu.device, &gpu.queue, painter.texture().unwrap()).2,
        original
    );
    assert_eq!(
        wait(&mut host, &mut painter, &wake, clock.as_ref()),
        PaintStatus::Ready
    );
    let key = painter.shown_key().unwrap();
    assert_eq!(key.view.pan, [99.0 * 0.75, -8.5 * 0.75]);
    assert!(key.view.flip);
    assert_eq!(key.view.rotation, 0.125);
    shutdown(&mut host, &mut painter, &wake, clock.as_ref());
}

#[test]
fn painter_uploads_complete_drawing_cels_and_effects_like_export() {
    let gpu = gpu();
    let cases: &[&[u8]] = &[
        include_bytes!("../../styk-export/tests/fixtures/policy/plain-drawing.json"),
        include_bytes!("../../styk-export/tests/fixtures/policy/scene-filter.json"),
    ];
    for &bytes in cases {
        let (mut host, mut painter, generation, wake, clock) =
            setup_bytes(&gpu, PaintLimits::default(), bytes, "json");
        let size = host.canvas();
        host.request(0.0, 1.0, 4, SceneOptions::default()).unwrap();
        painter.request(&host).unwrap();
        assert_eq!(
            wait(&mut host, &mut painter, &wake, clock.as_ref()),
            PaintStatus::Ready
        );
        let mut builder = styk_engine::frame_builder::FrameBuilder::default();
        let frame = builder
            .prepare(&generation, 0.0, &SceneOptions::default(), || 0.0, || false)
            .unwrap();
        let settings = styk_export::Settings::new(
            size[0],
            size[1],
            styk_export::Smoothing::Edges,
            styk_export::settings::MAX_PIXELS,
        )
        .unwrap();
        let mut export = styk_export::GpuExport::new(&gpu.device, &gpu.queue, settings, 2048);
        export.prepare_sprites(generation.lineage, &generation.assets);
        let decoded = styk_render::decode_images(&generation.prepared.doc, &generation.assets);
        export.upload_images(&generation.assets, decoded.iter());
        let expected = export
            .frame_blocking(
                &generation.prepared.doc,
                &frame.list,
                frame.camera.as_ref(),
                false,
            )
            .unwrap();
        let premul = styk_render::read_frame(&gpu.device, &gpu.queue, painter.texture().unwrap()).2;
        let mut actual = Vec::new();
        styk_export::pixels::resolve(&premul, size[0] as usize * 4, size, 1, false, &mut actual);
        assert!(
            actual.chunks_exact(4).any(|p| p[3] > 0),
            "fixture paints artwork"
        );
        assert_eq!(actual, expected);
        println!(
            "stage cel/effect export: {} pixels byte-identical, pages={}",
            size[0] * size[1],
            generation.assets.pages
        );
        shutdown(&mut host, &mut painter, &wake, clock.as_ref());
    }
    let (mut host, mut painter, _, wake, clock) = setup_bytes(
        &gpu,
        PaintLimits {
            sprite_bytes: 1,
            ..Default::default()
        },
        cases[0],
        "json",
    );
    host.request(0.0, 1.0, 4, SceneOptions::default()).unwrap();
    painter.request(&host).unwrap();
    assert!(matches!(
        wait(&mut host, &mut painter, &wake, clock.as_ref()),
        PaintStatus::Failed(styk_core::stage::PaintError::Budget { limit: 1, .. })
    ));
    assert!(painter.texture().is_none());
    shutdown(&mut host, &mut painter, &wake, clock.as_ref());
}

#[test]
fn output_budget_refuses_even_one_frame_and_close_reclaims_pending_work() {
    let gpu = gpu();
    let (mut host, mut painter, _, wake, clock) = setup(
        &gpu,
        PaintLimits {
            output_bytes: 1,
            ..Default::default()
        },
    );
    host.request(0.0, 1.0, 4, SceneOptions::default()).unwrap();
    painter.request(&host).unwrap();
    assert!(matches!(
        wait(&mut host, &mut painter, &wake, clock.as_ref()),
        PaintStatus::Failed(styk_core::stage::PaintError::Budget { .. })
    ));
    assert!(painter.texture().is_none());
    host.request(0.5, 1.0, 4, SceneOptions::default()).unwrap();
    painter.request(&host).unwrap();
    shutdown(&mut host, &mut painter, &wake, clock.as_ref());
    assert_eq!(painter.update(), PaintStatus::Closed);
}

#[test]
fn working_budget_refuses_before_overwriting_the_last_complete_frame() {
    let gpu = gpu();
    let (mut host, mut painter, _, wake, clock) = setup(
        &gpu,
        PaintLimits {
            working_bytes: 64 * 1024 * 1024,
            ..Default::default()
        },
    );
    host.request(0.0, 1.0, 4, SceneOptions::default()).unwrap();
    painter.request(&host).unwrap();
    assert_eq!(
        wait(&mut host, &mut painter, &wake, clock.as_ref()),
        PaintStatus::Ready
    );
    let previous = painter.shown_key().unwrap().clone();
    let pixels = styk_render::read_frame(&gpu.device, &gpu.queue, painter.texture().unwrap()).2;
    host.resize(Viewport {
        size: [3000.0, 3000.0],
        ..Default::default()
    })
    .unwrap();
    host.request(0.0, 1.0, 4, SceneOptions::default()).unwrap();
    painter.request(&host).unwrap();
    assert!(matches!(
        wait(&mut host, &mut painter, &wake, clock.as_ref()),
        PaintStatus::Failed(styk_core::stage::PaintError::Budget { .. })
    ));
    assert_eq!(painter.shown_key(), Some(&previous));
    assert_eq!(
        styk_render::read_frame(&gpu.device, &gpu.queue, painter.texture().unwrap()).2,
        pixels
    );
    shutdown(&mut host, &mut painter, &wake, clock.as_ref());
}

/// The same styk-auto/1 steps as the app; paths remain private runner bindings.
#[test]
#[ignore = "in-place stage benchmark; requires STYK_STAGE_INPUT_A and STYK_STAGE_INPUT_B"]
fn stage_benchmark_scenario() {
    use styk_core::automation::{Script, Step};
    let paths = [
        std::env::var("STYK_STAGE_INPUT_A").expect("scene_a required"),
        std::env::var("STYK_STAGE_INPUT_B").expect("scene_b required"),
    ];
    let script = Script::parse(include_str!(
        "../../../../docs/native/scenarios/stage.styk-auto"
    ))
    .unwrap();
    let gpu = gpu();
    let measured = SystemClock::new();
    let fixed = styk_services::FixedClock::new();
    let mut current: Option<(
        Host,
        Painter,
        Arc<Generation>,
        mpsc::Receiver<()>,
        Arc<SystemClock>,
    )> = None;
    let mut label = String::new();
    let mut opened = Duration::ZERO;
    let mut cold = true;
    let mut operation = "frame";
    let mut samples = std::collections::BTreeMap::<&str, Vec<f64>>::new();
    for (line, step) in script.steps {
        if let Step::Open(input) = step {
            if let Some((mut host, mut painter, _, wake, clock)) = current.take() {
                shutdown(&mut host, &mut painter, &wake, clock.as_ref());
            }
            let index = match input.to_str().unwrap() {
                "scene_a" => 0,
                "scene_b" => 1,
                _ => panic!("unknown input"),
            };
            opened = measured.now();
            let bytes = std::fs::read(&paths[index]).expect("read input in place");
            let extension = std::path::Path::new(&paths[index])
                .extension()
                .and_then(|x| x.to_str())
                .unwrap();
            let mut state = setup_bytes(&gpu, PaintLimits::default(), &bytes, extension);
            state
                .0
                .resize(Viewport {
                    size: [1280.0, 720.0],
                    ..Default::default()
                })
                .unwrap();
            state.0.fit_canvas().unwrap();
            current = Some(state);
            label = input.to_str().unwrap().to_owned();
            cold = true;
            operation = "frame";
            samples.clear();
            continue;
        }
        let (host, painter, generation, wake, clock) = current.as_mut().expect("open before input");
        match step {
            Step::Advance(ns) => {
                fixed.advance(Duration::from_nanos(ns));
                host.advance(fixed.now().as_secs_f64() * 1000.0).unwrap();
            }
            Step::Pan(delta) => {
                host.pan_by(delta).unwrap();
                operation = "pan";
            }
            Step::Zoom { factor, at } => {
                host.zoom_by(factor, Some(at)).unwrap();
                operation = "zoom";
            }
            Step::Pointer(pointer) => {
                host.pointer(pointer, Default::default()).unwrap();
                operation = "pointer";
            }
            Step::Pen(mut sample) => {
                sample.time_ns = fixed.now().as_nanos() as u64;
                let event = host.automation_pen(sample);
                host.pen_navigation(event, Default::default()).unwrap();
            }
            Step::Frame(_) | Step::Play { .. } => {
                let (from, count) = match step {
                    Step::Frame(tick) => (tick, 1),
                    Step::Play { from, frames } => {
                        operation = "play";
                        (from, frames)
                    }
                    _ => unreachable!(),
                };
                for offset in 0..count {
                    let tick = (from + f64::from(offset)) % f64::from(generation.playable_ticks());
                    let start = measured.now();
                    host.request(tick, 1.0, 4, SceneOptions::default()).unwrap();
                    painter.request(host).unwrap();
                    assert_eq!(
                        wait(host, painter, wake, clock.as_ref()),
                        PaintStatus::Ready
                    );
                    let elapsed = measured.now().saturating_sub(start).as_secs_f64() * 1000.0;
                    if cold {
                        println!(
                            "styk-auto/1 {label}: cold_request_ms={elapsed:.3}, open_to_first_ms={:.3}",
                            measured.now().saturating_sub(opened).as_secs_f64() * 1000.0
                        );
                        cold = false;
                    } else {
                        let values = samples.entry(operation).or_default();
                        values.push(elapsed);
                        println!(
                            "styk-auto/1 {label}: line={line}, step={operation}, sample={}, tick={tick}, request_to_ready_ms={elapsed:.3}",
                            values.len()
                        );
                    }
                }
            }
            Step::Measure(metric) => {
                assert_eq!(metric, "frame_time");
                for (operation, values) in &samples {
                    let mut ordered = values.clone();
                    ordered.sort_by(f64::total_cmp);
                    if *operation != "pointer" {
                        assert!(ordered.len() >= 100, "enough steady samples for p95");
                    }
                    println!(
                        "styk-auto/1 {label}: step={operation}, steady_samples={}, p50_ms={:.3}, p95_ms={:.3}, profile={}",
                        ordered.len(),
                        ordered[ordered.len() / 2],
                        ordered[(ordered.len() * 95).div_ceil(100) - 1],
                        if cfg!(debug_assertions) {
                            "test (directional)"
                        } else {
                            "release (directional)"
                        }
                    );
                }
                println!(
                    "styk-auto/1 {label}: prepared={}",
                    host.frames().stats().unwrap().prepared
                );
            }
            _ => panic!("unsupported benchmark step on line {line}"),
        }
    }
    let (mut host, mut painter, _, wake, clock) = current.unwrap();
    shutdown(&mut host, &mut painter, &wake, clock.as_ref());
}
