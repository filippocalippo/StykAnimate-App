//! Offline profiling entry point. Workers use the same engine open/evaluate operations as the tools.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::Arc, time::Duration};
use styk_devtools::{
    capture::{Capture, event},
    scenario::{self, Host, Step},
    stats,
};
use styk_services::clock::{Clock, SystemClock};

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
}
impl Host for EngineHost {
    fn step(&mut self, step: &Step, _: Duration) -> Result<(), String> {
        match step {
            Step::Open => {
                MEASUREMENT_CLOCK.with(|clock| *clock.borrow_mut() = Some(self.clock.clone()));
                let engine =
                    styk_engine::Engine::new(engine_clock, styk_engine::Budgets::for_device(None));
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
                let mut prepared = if path.extension().is_some_and(|s| s == "json") {
                    let opened = engine
                        .open_document(
                            styk_engine::document::OpenSource::Json {
                                bytes: &bytes,
                                name,
                            },
                            styk_engine::document::OpenOptions {
                                layer_timeline: true,
                            },
                            &|| false,
                        )
                        .map_err(|e| e.to_string())?;
                    styk_core::documents::PreparedDocument::from_opened(opened, &|| false)
                        .map_err(|e| e.to_string())?
                } else {
                    styk_core::documents::PreparedDocument::open_bytes(
                        &engine,
                        bytes.into(),
                        name,
                        &|| false,
                    )
                    .map_err(|e| e.to_string())?
                };
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
                return Err(
                    "export scenario awaits the core export adapter; use styk video or styk export"
                        .into(),
                );
            }
            Step::Advance(_) => {}
        }
        Ok(())
    }
}

fn error(what: &str) -> i32 {
    eprintln!(
        "{}",
        json!({"what":what,"where":"profile","hint":"profile <file> open|frame [--out <new-directory>]"})
    );
    2
}
fn read_json(path: &str) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("profile exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub fn compare(args: &[String]) -> i32 {
    if args.len() != 2 {
        return error("compare-profile needs two profile.json files");
    }
    match read_json(&args[0]).and_then(|a| read_json(&args[1]).and_then(|b| stats::compare(&a, &b)))
    {
        Ok(value) => {
            println!("{value}");
            i32::from(value["regression"] == true)
        }
        Err(e) => error(&e),
    }
}
pub fn run(args: &[String]) -> i32 {
    match profile(args) {
        Ok(()) => 0,
        Err(e) => error(&e),
    }
}
fn profile(args: &[String]) -> Result<(), String> {
    if args.len() != 2 && !(args.len() == 4 && args[2] == "--out") {
        return Err("invalid profile arguments".into());
    }
    let text = match args[1].as_str() {
        "open" => "styk-auto/1\nopen",
        "frame" => "styk-auto/1\nopen\nframe 0",
        _ => return Err("supported scenarios: open, frame".into()),
    };
    let out = Path::new(if args.len() == 4 {
        args[3].as_str()
    } else {
        "artifacts/profile/headless"
    });
    // Never replace an existing capture or create output beside a private input.
    std::fs::create_dir_all(out.parent().ok_or("output needs a parent directory")?)
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
    let mut samples = Vec::new();
    for _ in 0..3 {
        let done = scenario::start(
            &styk_platform::spawn::ThreadSpawner,
            clock.clone(),
            scenario::parse(text)?,
            EngineHost {
                path: args[0].clone(),
                documents: styk_core::documents::Documents::new(),
                clock: clock.clone(),
            },
        )?;
        // Offline CLI only. The shared runner never blocks an interface caller.
        loop {
            if let Some(result) = done
                .lock()
                .map_err(|_| "scenario completion poisoned")?
                .take()
            {
                samples.push(
                    result?
                        .iter()
                        .map(|s| s.elapsed.as_secs_f64() * 1000.0)
                        .sum::<f64>(),
                );
                break;
            }
            if clock.now() > Duration::from_secs(120) {
                return Err("scenario timed out".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let report = json!({"format":"stykprofile/1","scenario":args[1],"input_hash":format!("{:x}",hash.finalize()),"clock":"real","build_profile":env!("STYK_BUILD_PROFILE"),"samples_ms":samples,"summary":stats::summary(&samples)?,"scope":"core session open and frame evaluation; no presentation or GPU timing"});
    std::fs::write(out.join("profile.json"), report.to_string()).map_err(|e| e.to_string())?;
    let mut capture = Capture::new(8 * 1024 * 1024)?;
    for record in styk_trace_snapshot() {
        capture.push(&serde_json::to_vec(&record).map_err(|e| e.to_string())?)?;
    }
    capture
        .write(std::fs::File::create(out.join("trace.styktrace")).map_err(|e| e.to_string())?)?;
    capture.perfetto(
        std::fs::File::create(out.join("trace.perfetto.json")).map_err(|e| e.to_string())?,
    )?;
    std::fs::write(out.join("summary.txt"), report.to_string()).map_err(|e| e.to_string())?;
    println!("{report}");
    Ok(())
}
fn styk_trace_snapshot() -> Vec<Value> {
    styk_devtools::capture_events().iter().map(event).collect()
}
