//! Streaming, opt-in memory evidence. GPU reservation is distinct from live
//! allocations, Rust heap bytes and process private bytes (they overlap).
use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use serde_json::json;
use styk_render::wgpu;

pub struct Log(BufWriter<std::fs::File>);

impl Log {
    pub fn open(path: Option<&str>) -> Result<Option<Self>, String> {
        path.map(|path| {
            let _ = styk_trace::clock::install(Arc::new(styk_platform::clock::SystemClock::new()));
            std::fs::File::create(path).map(|f| Self(BufWriter::new(f))).map_err(|e| e.to_string())
        }).transpose()
    }

    pub fn sample(&mut self, phase: &str, tick: Option<u32>, device: Option<&wgpu::Device>, details: serde_json::Value) -> Result<(), String> {
        let private = styk_platform::diagnostics::private_bytes(None);
        let heap = styk_alloc::live_bytes();
        let allocator = device.and_then(wgpu::Device::generate_allocator_report);
        let mut owners = BTreeMap::<String, u64>::new();
        if let Some(report) = &allocator {
            for allocation in &report.allocations {
                *owners.entry(allocation.name.clone()).or_default() += allocation.size;
            }
        }
        styk_trace::counter!("memory.process.private", private);
        styk_trace::counter!("memory.rust.live", heap);
        styk_trace::counter!("memory.gpu.live", allocator.as_ref().map_or(0, |r| r.total_allocated_bytes));
        styk_trace::counter!("memory.gpu.reserved", allocator.as_ref().map_or(0, |r| r.total_reserved_bytes));
        let (tx, rx) = mpsc::sync_channel(1);
        styk_devtools_engine::memory::request(&styk_platform::diagnostics::NativeDiagnostics, Box::new(move |report| { let _ = tx.send(report); }))?;
        // Offline CLI only: UI users receive the same service asynchronously.
        let attribution = rx.recv().map_err(|e| e.to_string())??;
        let value = json!({"attribution":attribution,"phase":phase,"tick":tick,"private":private,"rust_live":heap,
            "rust_peak":styk_alloc::peak_bytes(),"gpu":allocator.as_ref().map(|r| json!({
                "allocated":r.total_allocated_bytes,"reserved":r.total_reserved_bytes,"owners":owners,
                "blocks":r.blocks.iter().map(|b| b.size).collect::<Vec<_>>()
            })),"details":details});
        serde_json::to_writer(&mut self.0, &value).map_err(|e| e.to_string())?;
        self.0.write_all(b"\n").and_then(|()| self.0.flush()).map_err(|e| e.to_string())
    }
}

pub fn sample(log: &mut Option<Log>, phase: &str, tick: Option<u32>, device: Option<&wgpu::Device>, details: impl FnOnce() -> serde_json::Value) -> Result<(), String> {
    if let Some(log) = log { log.sample(phase, tick, device, details())?; }
    Ok(())
}

pub fn renderer_device(renderer: &styk_export::FrameRenderer) -> Option<&wgpu::Device> {
    match renderer { styk_export::FrameRenderer::Gpu(gpu, _) => Some(gpu.device()), _ => None }
}

#[test]
fn disabled_memory_report_does_not_build_details() {
    let mut calls = 0;
    sample(&mut None, "frame", Some(181), None, || {
        calls += 1;
        json!({"frame_buffer":3840 * 2160 * 4})
    }).unwrap();
    assert_eq!(calls, 0, "disabled reporting must not construct diagnostic JSON");
}

struct Source(styk_engine::Engine);
impl Drop for Source { fn drop(&mut self) { self.0.stop(); } }
impl styk_core::frames::FrameDocument for Source {
    fn picture_engine(&self) -> Option<styk_engine::Engine> { Some(self.0.clone()) }
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<styk_engine::Generation>> {
        self.0.generation().filter(|g| g.revision == revision)
    }
}

/// Drives the production K-stage host using the shared automation parser. No
/// window, synthetic system input, alternate evaluator or alternate renderer.
pub fn stage(args: &[String]) -> i32 {
    match stage_run(args) {
        Ok(()) => 0,
        Err(e) => { eprintln!("{e}"); 1 }
    }
}

fn stage_run(args: &[String]) -> Result<(), String> {
    use styk_core::frames::{Config, FrameDocument, Frames};
    use styk_core::stage::{Host, PaintLimits, PaintStatus, Painter, Viewport};
    use styk_services::Spawner;
    if args.len() != 4 { return Err("styk stage-memory <input> <script.styk-auto> <WxH> <report.jsonl>".into()); }
    let (w, h) = args[2].split_once('x').ok_or("size must be WxH")?;
    let size = [w.parse::<u32>().map_err(|e| e.to_string())?, h.parse::<u32>().map_err(|e| e.to_string())?];
    if size.contains(&0) { return Err("size must be positive".into()); }
    let mut log = Log::open(Some(&args[3]))?;
    sample(&mut log, "start", None, None, || json!({}))?;
    let engine = styk_engine::Engine::new(|| 0., styk_engine::Budgets::for_device(None));
    let input = std::fs::read(&args[0]).map_err(|e| e.to_string())?;
    let extension = std::path::Path::new(&args[0]).extension().and_then(|s| s.to_str()).unwrap_or("styk");
    engine.open(&input, extension, "memory scenario").map_err(|e| e.to_string())?;
    drop(input);
    let generation = engine.generation().ok_or("no generation")?;
    sample(&mut log, "document", None, None, || json!({}))?;
    let gpu = styk_render::native_gpu::native_gpu(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        "stage memory", |a| wgpu::Limits::default().using_resolution(a.limits()))?;
    sample(&mut log, "device", None, Some(&gpu.device), || json!({"backend":format!("{:?}",gpu.adapter.get_info().backend)}))?;
    let source: Arc<dyn FrameDocument> = Arc::new(Source(engine.clone()));
    for _ in 0..2 {
        let engine = engine.clone();
        styk_platform::spawn::ThreadSpawner.spawn("stage-memory-pictures", Box::new(move || engine.work())).map_err(|e| format!("{e:?}"))?;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let wake: styk_core::frames::Wake = Arc::new(move || { let _ = tx.try_send(()); });
    let clock = Arc::new(styk_platform::clock::SystemClock::new());
    let frames = Frames::new(1, generation.revision, 0, &source, Config::default(), &styk_platform::spawn::ThreadSpawner, clock.clone(), wake.clone()).map_err(|e| format!("{e:?}"))?;
    let mut host = Host::new(frames, generation.prepared.doc.canvas, Viewport { size:size.map(f64::from), ..Default::default() }).map_err(|e| format!("{e:?}"))?;
    let mut painter = Painter::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm, &styk_platform::spawn::ThreadSpawner, clock, wake, PaintLimits::default()).map_err(|e| format!("{e:?}"))?;
    let script = std::fs::read_to_string(&args[1]).map_err(|e| e.to_string())?;
    let script = styk_core::automation::Script::parse(&script).map_err(|e| format!("{e:?}"))?;
    let result = (|| {
        for (_, step) in script.steps {
            let tick = match step {
                styk_core::automation::Step::Frame(tick) => tick,
                _ => return Err("stage-memory accepts frame steps only".into()),
            };
            let started = Instant::now();
            host.request(tick, 1., 4, Default::default()).map_err(|e| format!("{e:?}"))?;
            painter.request(&host).map_err(|e| format!("{e:?}"))?;
            loop {
                host.frames_mut().flush();
                match painter.update() {
                    PaintStatus::Ready => break,
                    PaintStatus::Pending => {},
                    status => return Err(format!("stage: {status:?}")),
                }
                if started.elapsed() > Duration::from_secs(120) { return Err("stage timeout".into()); }
                let _ = rx.recv_timeout(Duration::from_millis(2));
            }
            sample(&mut log, "frame", Some(tick as u32), Some(&gpu.device), || json!({"frame_ms":started.elapsed().as_secs_f64()*1000.}))?;
        }
        Ok(())
    })();
    painter.close();
    host.close();
    engine.stop();
    let deadline = Instant::now();
    while !painter.worker_exited() {
        if deadline.elapsed() > Duration::from_secs(120) { return Err("stage teardown timeout".into()); }
        let _ = rx.recv_timeout(Duration::from_millis(2));
    }
    drop(painter);
    drop(host);
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
    sample(&mut log, "closed", None, Some(&gpu.device), || json!({}))?;
    result?;
    println!("stage memory: complete");
    Ok(())
}

/// Offline entry point for the developer engine's one-shot process capture.
pub fn capture(args: &[String]) -> i32 {
    let result = (|| -> Result<(), String> {
        if args.len() != 1 { return Err("styk memory-capture <new.styktrace>".into()); }
        let (tx, rx) = mpsc::sync_channel(1);
        styk_devtools_engine::memory::request_capture(&styk_platform::diagnostics::NativeDiagnostics, 2 * 1024 * 1024, Box::new(move |report| { let _ = tx.send(report); }))?;
        let capture = rx.recv().map_err(|e| e.to_string())??;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&args[0]).map_err(|e| e.to_string())?;
        capture.write(&mut file)
    })();
    match result { Ok(()) => 0, Err(e) => { eprintln!("{e}"); 1 } }
}
