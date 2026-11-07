//! Offline profiling entry point. Workers use the same engine open/evaluate operations as the tools.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::Arc, time::Duration};
use styk_devtools_engine::{
    drain::Drain,
    scenario::{self, Host, Step},
    stats,
};
use styk_services::clock::Clock;
use styk_platform::clock::SystemClock;

thread_local! {
    static MEASUREMENT_CLOCK: std::cell::RefCell<Option<Arc<dyn Clock>>> = const { std::cell::RefCell::new(None) };
}
fn engine_clock() -> f64 {
    MEASUREMENT_CLOCK.with(|clock| {
        clock
            .borrow()
            .as_ref()
            .map_or(0.0, |clock| clock.now().as_secs_f64() * 1000.0)
    })
}
struct EngineHost {
    path: String,
    documents: styk_core::documents::Documents,
    clock: Arc<dyn Clock>,
    engine: Option<styk_engine::Engine>,
    export_path: Option<std::path::PathBuf>,
    export_hash: Arc<std::sync::Mutex<Option<String>>>,
    budgets: styk_engine::Budgets,
}
impl Host for EngineHost {
    fn step(&mut self, step: &Step, _: Duration) -> Result<(), String> {
        match step {
            Step::Open => {
                MEASUREMENT_CLOCK.with(|clock| *clock.borrow_mut() = Some(self.clock.clone()));
                let engine = styk_engine::Engine::new(engine_clock, self.budgets);
                let size = std::fs::metadata(&self.path)
                    .map_err(|e| e.to_string())?
                    .len();
                styk_engine::document::admit_open(
                    usize::try_from(size).map_err(|_| "input exceeds address space")?,
                )
                .map_err(|e| e.to_string())?;
                let bytes = std::fs::read(&self.path).map_err(|e| e.to_string())?;
                let path = Path::new(&self.path);
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or("invalid file name")?;
                let source = if path.extension().is_some_and(|s| s == "json") {
                    styk_engine::document::OpenSource::Json {
                        bytes: &bytes,
                        name,
                    }
                } else {
                    styk_engine::document::OpenSource::File {
                        bytes: &bytes,
                        name,
                    }
                };
                let mut opened = engine
                    .open_document(
                        source,
                        styk_engine::document::OpenOptions {
                            layer_timeline: true,
                        },
                        &|| false,
                    )
                    .map_err(|e| e.to_string())?;
                if opened.source.is_some() {
                    opened
                        .attach_source(bytes.into())
                        .map_err(|e| e.to_string())?;
                }
                engine
                    .activate(&opened.typed, &opened.tree, 0)
                    .map_err(|e| e.to_string())?;
                let mut prepared =
                    styk_core::documents::PreparedDocument::from_opened(opened, &|| false)
                        .map_err(|e| e.to_string())?;
                self.engine = Some(engine);
                // This seam is the deadline clock for budgeted reads, not animation time.
                prepared.set_clock(engine_clock);
                self.documents
                    .open(prepared)
                    .map_err(|(e, _)| e.to_string())?;
            }
            Step::Frame(tick) => {
                let id = self
                    .documents
                    .active()
                    .ok_or("frame needs open first")?
                    .id();
                self.documents
                    .call(
                        id,
                        "seek",
                        &[styk_doc::Value::Num(*tick as f64)],
                        &styk_doc::Value::Null,
                    )
                    .map_err(|e| e.to_string())?
                    .result
                    .map_err(|e| e.to_string())?;
                let frame = self
                    .documents
                    .active()
                    .ok_or("document closed")?
                    .frame_records()
                    .map_err(|e| e.to_string())?;
                std::hint::black_box(frame);
            }
            Step::Export => {
                let document = self.documents.active().ok_or("export needs open first")?;
                let engine = self.engine.as_ref().ok_or("export needs engine")?;
                engine
                    .publish_tree(
                        document.lineage(),
                        document.records().clone(),
                        document.revision(),
                    )
                    .map_err(|e| e.to_string())?
                    .ok_or("export lost document lineage")?;
                let frames = engine.export_frames(document.revision())?;
                let generation = frames.generation();
                let doc = &generation.prepared.doc;
                let settings = styk_export::Settings::new(
                    doc.canvas[0],
                    doc.canvas[1],
                    styk_export::Smoothing::Edges,
                    styk_export::settings::MAX_PIXELS,
                )?;
                let mut renderer = styk_export::CpuExport::new(settings, styk_export::TILE_SIDE);
                renderer.use_assets(generation.assets.clone());
                frames.decode_images();
                while frames.images_pending() != 0 {
                    // Taking a batch releases pending-picture admission and schedules the next
                    // decodes. Do not wait for all decoding before consuming that bounded queue.
                    // The engine admits one oversized picture alone, as in the normal export path.
                    renderer.upload_images(&generation.assets, frames.take_images(4 * 1024 * 1024));
                    if frames.images_pending() != 0 && !engine.step() {
                        return Err("export picture decoding made no progress".into());
                    }
                }
                let tick = document.view().tick.max(0.) as u32;
                let frame = frames.take(tick).ok_or("export frame unavailable")?;
                let pixels = renderer.frame(doc, &frame.list, frame.camera.as_ref(), false)?;
                let hash = format!("{:x}", Sha256::digest(&pixels));
                if let Some(path) = self.export_path.take() {
                    image::save_buffer(
                        path,
                        &pixels,
                        settings.width,
                        settings.height,
                        image::ColorType::Rgba8,
                    )
                    .map_err(|e| e.to_string())?;
                }
                *self
                    .export_hash
                    .lock()
                    .map_err(|_| "export hash slot unavailable")? = Some(hash);
            }
            Step::Advance(_) => {}
        }
        Ok(())
    }
}

fn error(what: &str) -> i32 {
    let error = styk_devtools_engine::answer::error(
        "developer command failed",
        "profile",
        Value::Null,
        what,
        "profile <file> open|frame|export|scenario.styk-auto [--out new-directory] [--runs 3..32]",
    );
    eprintln!("{error}");
    println!("Developer command failed; see the JSON error on stderr.");
    2
}
fn read_json(path: &str) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(1024 * 1024 + 1);
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("profile exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub fn compare(args: &[String]) -> i32 {
    let paths: Vec<_> = args
        .iter()
        .filter(|s| !matches!(s.as_str(), "--json" | "--full"))
        .collect();
    if paths.len() != 2 {
        return error("compare-profile needs two profile.json files");
    }
    match read_json(paths[0]).and_then(|a| read_json(paths[1]).and_then(|b| stats::compare(&a, &b)))
    {
        Ok(value) => {
            println!("{value}");
            i32::from(value["regression"] == true)
        }
        Err(e) => {
            let incomparable =
                e.starts_with("incomparable") || e.starts_with("comparison requires");
            error(&e);
            if incomparable { 3 } else { 2 }
        }
    }
}
pub fn run(args: &[String]) -> i32 {
    match profile(args) {
        Ok(missed) => i32::from(missed),
        Err(e) => error(&e),
    }
}
fn profile(args: &[String]) -> Result<bool, String> {
    if args.len() < 2 {
        return Err("file and scenario required".into());
    }
    let mut out = "artifacts/profile/headless";
    let mut runs = 3usize;
    let mut at = 2;
    while at < args.len() {
        match args[at].as_str() {
            "--out" => {
                at += 1;
                out = args.get(at).ok_or("--out needs a directory")?;
            }
            "--runs" => {
                at += 1;
                runs = args
                    .get(at)
                    .ok_or("--runs needs a count")?
                    .parse()
                    .map_err(|_| "invalid run count")?;
            }
            "--json" | "--full" => {}
            _ => return Err("unknown profile option".into()),
        }
        at += 1;
    }
    if !(3..=32).contains(&runs) {
        return Err("profile needs 3..32 runs".into());
    }
    let text = match args[1].as_str() {
        "open" => "styk-auto/1\nopen".into(),
        "frame" => "styk-auto/1\nopen\nframe 0".into(),
        "export" => "styk-auto/1\nopen\nexport".into(),
        path if path.ends_with(".styk-auto") => {
            let mut text = String::with_capacity(65537);
            std::fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take(65537)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
            text
        }
        _ => return Err("supported scenarios: open, frame, export, or .styk-auto script".into()),
    };
    let script = scenario::parse_script(&text)?;
    let out = Path::new(out);
    std::fs::create_dir_all(out.parent().ok_or("output needs parent")?)
        .map_err(|e| e.to_string())?;
    std::fs::create_dir(out).map_err(|e| format!("output must be a new directory: {e}"))?;
    let mut input = std::fs::File::open(&args[0]).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut scratch = [0; 65536];
    loop {
        let n = input.read(&mut scratch).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&scratch[..n]);
    }
    let clock: Arc<dyn Clock> = Arc::new(SystemClock::new());
    styk_devtools_engine::initialize_with(clock.clone());
    let drain = Drain::start(
        &styk_platform::spawn::ThreadSpawner,
        clock.clone(),
        8 * 1024 * 1024,
    )?;
    let mut samples = Vec::with_capacity(runs);
    let mut metrics = Vec::with_capacity(runs);
    let mut export_hashes = Vec::with_capacity(runs);
    for run in 0..runs {
        let export_hash = Arc::new(std::sync::Mutex::new(None));
        let done = scenario::start(
            &styk_platform::spawn::ThreadSpawner,
            clock.clone(),
            script.steps.clone(),
            EngineHost {
                path: args[0].clone(),
                documents: styk_core::documents::Documents::new(),
                clock: clock.clone(),
                engine: None,
                export_path: (run == 0).then(|| out.join("export.png")),
                export_hash: export_hash.clone(),
                budgets: styk_engine::Budgets::for_device(None),
            },
        )?;
        let deadline = clock.now() + Duration::from_secs(120);
        loop {
            if let Some(result) = done.try_lock().ok().and_then(|mut slot| slot.take()) {
                let result = result?;
                let mut open = 0.;
                let mut frame = 0.;
                let mut export = 0.;
                for sample in &result {
                    let ms = sample.elapsed.as_secs_f64() * 1000.;
                    match sample.step {
                        Step::Open => open += ms,
                        Step::Frame(_) => frame += ms,
                        Step::Export => export += ms,
                        Step::Advance(_) => {}
                    }
                }
                samples.push(open + frame + export);
                metrics.push(json!({"scenario":{"ms":open+frame+export},"open":{"ms":open},"frame":{"ms":frame},"export":{"ms":export}}));
                if let Some(hash) = export_hash
                    .lock()
                    .map_err(|_| "export completion unavailable")?
                    .take()
                {
                    export_hashes.push(hash);
                }
                break;
            }
            if clock.now() > deadline {
                return Err("scenario timed out".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    if export_hashes.windows(2).any(|pair| pair[0] != pair[1]) {
        return Err("export pixels differ between runs".into());
    }
    drain.stop();
    let deadline = clock.now() + Duration::from_secs(5);
    let capture = loop {
        if let Some(result) = drain.take() {
            break result?;
        }
        if clock.now() > deadline {
            return Err("capture drain timed out".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    let budgets: Vec<_> = script
        .budgets
        .iter()
        .map(|budget| budget.judge(&metrics))
        .collect::<Result<_, _>>()?;
    let missed = budgets.iter().any(|b| b["met"] == false);
    let scenario = if args[1].ends_with(".styk-auto") {
        "script"
    } else {
        args[1].as_str()
    };
    let machine = json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"logical_cpus":std::thread::available_parallelism().map(|n|n.get()).unwrap_or(1),"host_hash":format!("{:x}",Sha256::digest(std::env::var("COMPUTERNAME").unwrap_or_default().as_bytes()))});
    let report = json!({"machine":machine,"measurement_environment":"shared heavy queue; diagnostic smoke, not a performance gate","format":"stykprofile/1","scenario":scenario,"scenario_hash":format!("{:x}",Sha256::digest(text.as_bytes())),"input_hash":format!("{:x}",hash.finalize()),"clock":"real","logical_clock":"fixed","build_profile":env!("STYK_BUILD_PROFILE"),"samples_ms":samples,"summary":stats::summary(&samples)?,"metrics":metrics,"budgets":budgets,"export_hashes":export_hashes,"capture":{"bytes":capture.bytes(),"dropped":capture.dropped},"scope":"core session open and evaluation; CPU export; no presentation or GPU timing"});
    std::fs::write(out.join("profile.json"), report.to_string()).map_err(|e| e.to_string())?;
    capture
        .write(std::fs::File::create(out.join("trace.styktrace")).map_err(|e| e.to_string())?)?;
    capture.perfetto(
        std::fs::File::create(out.join("trace.perfetto.json")).map_err(|e| e.to_string())?,
    )?;
    let mut short = report.clone();
    short
        .as_object_mut()
        .ok_or("invalid report")?
        .remove("metrics");
    short
        .as_object_mut()
        .ok_or("invalid report")?
        .remove("export_hashes");
    short["truncated"] = json!(true);
    short["more"] = json!("profile.json");
    let bytes=styk_devtools_engine::answer::encode(&short,styk_devtools_engine::answer::SHORT_BYTES).unwrap_or_else(|_|json!({"format":"stykprofile/1","summary":report["summary"],"budget_missed":missed,"truncated":true,"more":"profile.json"}).to_string().into_bytes());
    std::fs::write(out.join("summary.txt"), &bytes).map_err(|e| e.to_string())?;
    if args.iter().any(|s| s == "--full") {
        let full = styk_devtools_engine::answer::encode(&report, styk_devtools_engine::answer::FULL_BYTES)?;
        println!("{}", String::from_utf8_lossy(&full));
    } else {
        println!("{}", String::from_utf8_lossy(&bytes));
    }
    for budget in budgets.iter().filter(|b| b["met"] == false) {
        eprintln!(
            "{}",
            styk_devtools_engine::answer::error(
                "BUDGET missed",
                "scenario",
                json!({"line":budget["line"],"metric":budget["metric"]}),
                &format!(
                    "median {} {} {} ({} runs)",
                    budget["median"], budget["op"], budget["limit"], runs
                ),
                "inspect profile.json; thresholds were not changed"
            )
        );
    }
    Ok(missed)
}

pub fn schema(args: &[String]) -> i32 {
    let check = args.iter().any(|a| a == "--check");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for (name, value) in [
        ("devtools-protocol.json", styk_devtools_engine::schema::protocol()),
        ("devtools-profile.json", styk_devtools_engine::schema::profile()),
    ] {
        let path = root.join("docs/native").join(name);
        let bytes = styk_devtools_engine::schema::bytes(&value);
        if check {
            if std::fs::read(&path).ok().as_ref() != Some(&bytes) {
                return error("developer schema is stale");
            }
        } else if let Err(e) = std::fs::write(path, bytes) {
            return error(&e.to_string());
        }
    }
    println!("schemas: protocol and profile are current");
    0
}
pub fn attach(args: &[String]) -> i32 {
    use styk_services::control::Transport;
    if args.len() != 2 {
        return error("attach <pid> '<JSON request>'");
    }
    let Ok(pid) = args[0].parse::<u32>() else {
        return error("invalid pid");
    };
    let operation = match styk_platform::LocalControl.request(
        &styk_platform::spawn::ThreadSpawner,
        &format!("stykanimate-dev-{pid}"),
        args[1].as_bytes().to_vec(),
    ) {
        Ok(operation) => operation,
        Err(e) => return error(&e),
    };
    let clock = SystemClock::new();
    loop {
        if let Some(result) = operation.take() {
            return match result {
                Ok(bytes) => {
                    let ok = serde_json::from_slice::<Value>(&bytes)
                        .ok()
                        .is_some_and(|value| value["ok"] == true);
                    println!("{}", String::from_utf8_lossy(&bytes));
                    if ok { 0 } else { 2 }
                }
                Err(e) => error(&e),
            };
        }
        if clock.now() > Duration::from_secs(5) {
            return error("attach timed out");
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
pub fn doctor() -> i32 {
    let disk = match styk_platform::LocalControl::free_disk_bytes() {
        Ok(bytes) => bytes,
        Err(e) => return error(&e),
    };
    let instance = styk_render::wgpu::Instance::new(
        styk_render::wgpu::InstanceDescriptor::new_without_display_handle_from_env(),
    );
    let adapter = pollster::block_on(
        instance.request_adapter(&styk_render::wgpu::RequestAdapterOptions::default()),
    );
    let gpu = match adapter {
        Ok(adapter) => {
            json!({"name":adapter.get_info().name,"timestamp_query":adapter.features().contains(styk_render::wgpu::Features::TIMESTAMP_QUERY)})
        }
        Err(e) => json!({"unavailable":e.to_string()}),
    };
    let tools = std::env::var_os("USERPROFILE")
        .map(|home| Path::new(&home).join(".styk-tools/env.sh").is_file())
        .unwrap_or(false);
    println!(
        "{}",
        json!({"disk_free_bytes":disk,"disk_warning":disk<15*1024*1024*1024,"gpu":gpu,"tool_environment":tools,"renderdoc":"run renderdoccmd --version to verify an optional install","pix":"capture integration deferred to K-stage","process_cleanup":"never stops or deletes other tasks' processes or targets"})
    );
    if disk < 15 * 1024 * 1024 * 1024 { 1 } else { 0 }
}
pub fn png_compare(args: &[String]) -> i32 {
    fn run(args: &[String]) -> Result<bool, String> {
        if args.len() != 3 {
            return Err("devtools-png-compare <A.png> <B.png> <new-diff.png>".into());
        }
        let load = |path: &str| -> Result<image::RgbaImage, String> {
            let mut reader = image::ImageReader::open(path).map_err(|e| e.to_string())?;
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(64 * 1024 * 1024);
            reader.limits(limits);
            reader
                .decode()
                .map(|image| image.to_rgba8())
                .map_err(|e| e.to_string())
        };
        let a = load(&args[0])?;
        let b = load(&args[1])?;
        if a.dimensions() != b.dimensions() {
            return Err("screenshot dimensions differ".into());
        }
        let mut diff = image::RgbaImage::new(a.width(), a.height());
        let mut changed = 0u64;
        for ((a, b), out) in a.pixels().zip(b.pixels()).zip(diff.pixels_mut()) {
            let differs = a != b;
            changed += u64::from(differs);
            *out = if differs {
                image::Rgba([255, 0, 64, 255])
            } else {
                image::Rgba([0, 0, 0, 255])
            };
        }
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&args[2])
            .map_err(|e| e.to_string())?;
        image::DynamicImage::ImageRgba8(diff)
            .write_to(&mut std::io::BufWriter::new(file), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        println!(
            "{}",
            json!({"pixels":a.width() as u64*a.height() as u64,"differing":changed,"differing_percent":changed as f64*100./(a.width() as f64*a.height() as f64),"rule":"exact RGBA bytes; no tuned threshold"})
        );
        Ok(changed > 0)
    }
    match run(args) {
        Ok(changed) => i32::from(changed),
        Err(e) => error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiled_export_drains_pictures_under_pressure() {
        fn export(budget: usize) -> String {
            let clock: Arc<dyn Clock> = Arc::new(SystemClock::new());
            let hash = Arc::new(std::sync::Mutex::new(None));
            let mut host = EngineHost {
                path: Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/data/profile-pictures.json")
                    .to_str()
                    .unwrap()
                    .to_owned(),
                documents: styk_core::documents::Documents::new(),
                clock,
                engine: None,
                export_path: None,
                export_hash: hash.clone(),
                budgets: styk_engine::Budgets {
                    picture_bytes: budget,
                    ..styk_engine::Budgets::for_device(None)
                },
            };
            host.step(&Step::Open, Duration::ZERO).unwrap();
            let generation = host.engine.as_ref().unwrap().generation().unwrap();
            assert_eq!(generation.prepared.doc.images.len(), 3);
            let decoded: Vec<_> = generation
                .prepared
                .doc
                .images
                .iter()
                .map(|picture| {
                    image::load_from_memory(&picture.bytes)
                        .unwrap()
                        .to_rgba8()
                        .as_raw()
                        .len()
                })
                .collect();
            assert!(decoded.iter().all(|bytes| *bytes <= 512));
            assert!(
                decoded.iter().sum::<usize>() > 512,
                "fixture must exceed the pressure budget"
            );
            host.step(&Step::Export, Duration::ZERO).unwrap();
            let result = hash.lock().unwrap().take().unwrap();
            result
        }
        // Three 8x8 RGBA pictures exceed 512 bytes; each fits individually.
        let first = export(4096);
        assert_eq!(first, export(4096), "old-versus-old pixel baseline");
        assert_eq!(
            first,
            export(512),
            "all pictures must survive bounded handoff"
        );
    }
}
