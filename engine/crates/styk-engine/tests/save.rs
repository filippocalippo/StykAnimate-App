//! Writing a project from the document an edit session holds: the file reads back as that document, with the metadata every
//! project carries and the Pivot original stored first, the same document saves to the same bytes, and a stopped save writes
//! nothing. Byte identity with the JavaScript writer this replaced is checked on the repository's recorded files by
//! `tests/save-references.test.mjs`.
use sha2::{Digest, Sha256};
use std::sync::Arc;

use styk_doc::{Nums, Obj, Value, json};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::save::{ProjectRequest, SaveError, Source, save_figure_file, save_project};
use styk_engine::{Budgets, Engine};
use styk_formats::container;
use styk_formats::{Kind, files};

fn repo(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)
}

/// The tree the app's session holds of a repository document.
fn tree(path: &str) -> Value {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let text = std::fs::read(repo(path)).unwrap();
    engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, OpenOptions { layer_timeline: true }, &|| false).unwrap().tree
}

fn save(tree: &Value, name: Option<&str>, source: Option<Source>) -> Vec<u8> {
    save_project(std::slice::from_ref(tree), &[], ProjectRequest { name: name.map(str::to_string), source, reservation: None }, &|| false).unwrap().bytes
}

#[test]
fn a_project_reads_back_as_the_document_it_was_saved_from() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let bytes = save(&tree, Some("Saved"), None);
    let reopened = files::open_document(&bytes, Kind::Styk).unwrap();
    assert_eq!(reopened.path(&["_styk", "format"]).and_then(Value::as_str), Some("StykAnimate"));
    assert_eq!(reopened.path(&["_styk", "format_version"]).and_then(Value::as_f64), Some(1.0));
    assert_eq!(reopened.path(&["_styk", "name"]).and_then(Value::as_str), Some("Saved"));
    // Everything else is what the session held (the tree is shared, so the metadata is the only difference).
    let mut expected = tree.clone();
    let mut styk = expected.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("format", Value::str("StykAnimate"));
    styk.set("format_version", Value::Num(1.0));
    styk.set("name", Value::str("Saved"));
    expected.make_obj().unwrap().set("_styk", Value::object(styk));
    assert_eq!(json::to_string(&reopened), json::to_string(&expected));
    // The same document saves to the same bytes.
    assert_eq!(save(&tree, Some("Saved"), None), bytes);
}

#[test]
fn the_pivot_original_is_stored_first_and_checked_on_reading() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let original: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let digest: String = Sha256::digest(&original).iter().map(|byte| format!("{byte:02x}")).collect();
    let mut record = Obj::new();
    record.set("kind", Value::str("piv"));
    record.set("sha256", Value::str(&digest));
    let bytes = save(&tree, None, Some(Source { record: Value::object(record), bytes: original.clone() }));
    let opened = files::open_document(&bytes, Kind::Styk).expect("the fingerprint matches the stored original");
    let source = opened.get("_stykSource").unwrap();
    assert_eq!(source.get("kind").and_then(Value::as_str), Some("piv"));
    let Some(Value::Blob(blob)) = source.get("source_base64") else { panic!("the original is a payload") };
    assert_eq!(&*blob.bytes, &original[..]);
    let checked = container::check(&bytes, Kind::Styk).unwrap();
    let payloads = &checked.parts.sections.iter().find(|(kind, _)| *kind == 2).unwrap().1;
    assert!(payloads.starts_with(&original), "the original opens the payload section, as the app has always stored it");
    // A fingerprint that names other bytes is refused when the file is read.
    let mut wrong = Obj::new();
    wrong.set("sha256", Value::str(&"0".repeat(64)));
    let bad = save(&tree, None, Some(Source { record: Value::object(wrong), bytes: original }));
    assert!(files::open_document(&bad, Kind::Styk).is_err());
}

#[test]
fn a_stopped_save_writes_nothing_and_an_invalid_document_is_written_with_a_warning() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let stopped = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &|| true);
    assert!(matches!(stopped, Err(SaveError::Cancelled)), "{stopped:?}");
    let mut broken = tree.clone();
    broken.make_obj().unwrap().set("figure_types", Value::Num(3.0));
    // What opening would refuse and nothing mends is still written (refusing leaves the person with nothing), and the save says so.
    let written = save_project(&[broken], &[], ProjectRequest { name: None, source: None, reservation: None }, &|| false).expect("written all the same");
    assert!(written.warning.is_some(), "the save says what opening refuses");
    let none = save_project(&[], &[], ProjectRequest { name: None, source: None, reservation: None }, &|| false);
    assert!(matches!(none, Err(SaveError::Refused(_))), "{none:?}");
}

#[test]
fn a_figure_file_is_checked_for_being_self_contained_before_it_is_written() {
    // A project is no figure file: the container's own check refuses it, with the message the interface shows.
    let tree = tree("engine/tests/edit/startup.document.json");
    let refused = save_figure_file(&tree, Kind::Stkz, &|| false).unwrap_err();
    let SaveError::File(error) = refused else { panic!("{refused:?}") };
    assert!(error.message_key.starts_with("errors.nativeContainer."), "{error:?}");
}

/// The tree of a repository document with a numeric array of `count` values (single precision, so it is stored as `f32`) added.
fn heavy_tree(count: usize) -> Value {
    let mut tree = tree("engine/tests/edit/startup.document.json");
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let values: Vec<f64> = (0..count)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            f64::from((state % 4096) as f32 / 8.0)
        })
        .collect();
    tree.make_obj().unwrap().set("heavy", Value::Nums(Arc::new(Nums::new(&values))));
    tree
}

#[test]
fn a_save_stops_at_the_question_that_says_so_wherever_it_is_asked_and_writes_nothing() {
    // The worker that runs a save is ended five seconds after it is told to stop, and must not be inside the engine then
    // (docs/engine/threading.md): the longest stretch between two questions is the lift of a few thousand values, the
    // preparation of the document, or hashing or compressing a few megabytes. Counting the questions shows the stretches are short
    // (hashing alone asks for every 4 MiB of a document of 32 MiB of numbers) and that a stop is obeyed by the very next question.
    let tree = heavy_tree(8 << 20);
    let asked = std::cell::Cell::new(0usize);
    let saved = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &|| { asked.set(asked.get() + 1); false }).unwrap();
    let total = asked.get();
    assert!(saved.raw_bytes >= 32 << 20, "{} raw bytes", saved.raw_bytes);
    assert!(total >= 32 / 4 + 2, "{total} questions for {} MiB", saved.raw_bytes >> 20);
    // Stopped at the start, in the preparation, in the lift, while hashing and while compressing: the same answer.
    for stop_at in [1, 2, 5, total / 4, total / 2, total * 3 / 4, total - 1, total] {
        let asked = std::cell::Cell::new(0usize);
        let stopped = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &|| { asked.set(asked.get() + 1); asked.get() >= stop_at });
        assert!(matches!(stopped, Err(SaveError::Cancelled)), "stopped at question {stop_at} of {total}: {:?}", stopped.map(|written| written.bytes.len()));
        assert_eq!(asked.get(), stop_at, "nothing is asked, and no work is started, after the question that said stop");
    }
}

#[test]
fn a_save_the_memory_cannot_hold_is_refused_before_it_starts() {
    let tree = tree("engine/tests/edit/startup.document.json");
    // The save reserves what its sections and the compressed file take; with the memory limited to 8 MiB it is refused whole.
    let refused = styk_alloc::with_limit(8 << 20, || save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &|| false));
    assert!(matches!(refused, Err(SaveError::OutOfMemory(_))), "{refused:?}");
    // The same document saves when the memory is there, and a refused save changed nothing of it.
    assert!(save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &|| false).is_ok());
    // The Pivot original counts twice: a document that fits alone does not fit with an original that takes most of the memory.
    let original = Source { record: Value::object(Obj::new()), bytes: vec![0; 100 << 20] };
    let refused = styk_alloc::with_limit(256 << 20, || save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: Some(original), reservation: None }, &|| false));
    assert!(matches!(refused, Err(SaveError::OutOfMemory(_))), "{:?}", refused.map(|written| written.bytes.len()));
}

#[test]
fn every_recorded_project_opens_and_saves_to_its_own_bytes() {
    // The files the repository records were written by the JavaScript writer; a document opened from one and not changed saves
    // to the same bytes, arrays several records share included (`project-shared-arrays.styk`). The app's side of this is
    // `tests/save-references.test.mjs`.
    let mut checked = Vec::new();
    for entry in std::fs::read_dir(repo("engine/tests/containers")).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".styk") || name.contains("version-1") {
            continue;
        }
        let recorded = std::fs::read(&path).unwrap();
        // As the app opens a file, except the one whose movieclip frames the open gives identities the file lacks: that one is the tree as stored.
        let tree = if name.contains("shared") {
            files::open_document(&recorded, Kind::Styk).unwrap()
        } else {
            let engine = Engine::new(|| 0.0, Budgets::for_device(None));
            engine.open_document(OpenSource::File { bytes: &recorded, name: &name }, OpenOptions { layer_timeline: false }, &|| false).unwrap().tree
        };
        let saved = save(&tree, None, None);
        assert!(saved == recorded, "{name}: {} bytes saved, {} recorded", saved.len(), recorded.len());
        checked.push(name);
    }
    assert!(checked.contains(&"project-shared-arrays.styk".to_string()) && checked.len() >= 5, "{checked:?}");
}

/// An engine with `workers` threads running its background work, stopped and joined when dropped.
struct Workers {
    engine: Engine,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Workers {
    fn start(workers: usize) -> Workers {
        let engine = Engine::new(|| 0.0, Budgets::for_device(None));
        let threads = (0..workers).map(|_| { let engine = engine.clone(); std::thread::spawn(move || engine.work()) }).collect();
        Workers { engine, threads }
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        self.engine.stop();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

#[test]
fn jobs_run_side_by_side_on_the_workers_and_the_caller_takes_what_no_worker_started() {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    for workers in [0usize, 3] {
        let pool = Workers::start(workers);
        let ran: Arc<Mutex<Vec<std::thread::ThreadId>>> = Arc::new(Mutex::new(Vec::new()));
        let jobs: Vec<styk_formats::files::Job> = (0..6)
            .map(|_| {
                let ran = ran.clone();
                Box::new(move |_: &dyn Fn() -> bool| {
                    std::thread::sleep(std::time::Duration::from_millis(60));
                    ran.lock().unwrap().push(std::thread::current().id());
                }) as styk_formats::files::Job
            })
            .collect();
        let started = std::time::Instant::now();
        pool.engine.run_together(jobs, &Arc::new(AtomicBool::new(false)), &|| false, 3).unwrap();
        let ids = ran.lock().unwrap().clone();
        assert_eq!(ids.len(), 6, "every job ran before run_together returned ({workers} workers)");
        let distinct: std::collections::HashSet<_> = ids.iter().collect();
        if workers == 0 {
            assert_eq!(distinct.len(), 1, "no workers: the caller ran them all");
        } else {
            assert!(distinct.len() > 1, "{workers} workers took part");
            assert!(started.elapsed() < std::time::Duration::from_millis(330), "side by side, not one after another: {:?}", started.elapsed());
        }
    }
}

/// A job that holds some bytes of its own, sleeps, then checks them and says so.
fn slow_reader(data: Arc<Vec<u8>>, started: Arc<std::sync::atomic::AtomicBool>, verdict: Arc<std::sync::Mutex<Option<bool>>>) -> styk_formats::files::Job {
    Box::new(move |_| {
        started.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(250));
        // Read after the caller has long returned, and dropped everything it held: the bytes are this job's own.
        *verdict.lock().unwrap() = Some(data.iter().all(|byte| *byte == 0xA5));
    })
}

#[test]
fn a_caller_that_fails_while_a_worker_is_in_a_job_leaves_the_worker_nothing_that_is_freed() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use styk_formats::files::JobsFailed;
    // The probe of the review: the job the caller runs panics while a worker is in another one. The jobs own their bytes, so the worker
    // reads valid memory, and run_together comes back with the failure instead of unwinding past a borrowed frame.
    let pool = Workers::start(3);
    for round in 0..12 {
        let started = Arc::new(AtomicBool::new(false));
        let verdict = Arc::new(Mutex::new(None));
        let data = Arc::new(vec![0xA5u8; 1 << 20]);
        let waiting = started.clone();
        let panicking: styk_formats::files::Job = Box::new(move |_| {
            while !waiting.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            panic!("the job of the caller fails");
        });
        let result = pool.engine.run_together(vec![slow_reader(data.clone(), started.clone(), verdict.clone()), panicking], &Arc::new(AtomicBool::new(false)), &|| false, 3);
        assert_eq!(result, Err(JobsFailed::Panicked), "round {round}");
        drop(data);
        let seen = (0..100).find_map(|_| { std::thread::sleep(std::time::Duration::from_millis(30)); *verdict.lock().unwrap() });
        assert_eq!(seen, Some(true), "round {round}: the worker's job finished on bytes that were still there");
    }
}

#[test]
fn a_job_that_panics_on_a_worker_ends_the_wait_with_an_error_and_the_next_run_works() {
    use std::sync::atomic::AtomicBool;
    use styk_formats::files::JobsFailed;
    let pool = Workers::start(3);
    let slow: styk_formats::files::Job = Box::new(|_| std::thread::sleep(std::time::Duration::from_millis(150)));
    let boom: styk_formats::files::Job = Box::new(|_| panic!("the job fails"));
    let started = std::time::Instant::now();
    let result = pool.engine.run_together(vec![slow, boom], &Arc::new(AtomicBool::new(false)), &|| false, 3);
    assert_eq!(result, Err(JobsFailed::Panicked));
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "it did not wait for ever: {:?}", started.elapsed());
    let fine: Vec<styk_formats::files::Job> = (0..4).map(|_| Box::new(|_: &dyn Fn() -> bool| {}) as styk_formats::files::Job).collect();
    assert_eq!(pool.engine.run_together(fine, &Arc::new(AtomicBool::new(false)), &|| false, 3), Ok(()), "the next run works");
}

#[test]
fn a_worker_reported_lost_ends_the_wait_for_its_job() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use styk_formats::files::JobsFailed;
    // A thread that traps cannot say so: the host reports it (the page saw the worker's error event), and the job it had never ends.
    let pool = Workers::start(3);
    let release = Arc::new(AtomicBool::new(false));
    let caller = std::thread::current().id();
    let stuck: styk_formats::files::Job = {
        let release = release.clone();
        Box::new(move |_| {
            if std::thread::current().id() == caller {
                return;
            }
            while !release.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        })
    };
    let busy: styk_formats::files::Job = Box::new(|_| std::thread::sleep(std::time::Duration::from_millis(100)));
    let engine = pool.engine.clone();
    let reporter = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        engine.note_worker_lost();
    });
    let started = std::time::Instant::now();
    let result = pool.engine.run_together(vec![busy, stuck], &Arc::new(AtomicBool::new(false)), &|| false, 3);
    reporter.join().unwrap();
    release.store(true, Ordering::SeqCst);
    // The caller ran `busy`; a worker took `stuck` almost surely, and then the wait ended with the report. (If the caller ran both, nothing
    // was lost to wait for.)
    if result.is_err() {
        assert_eq!(result, Err(JobsFailed::WorkerLost));
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
        assert_eq!(pool.engine.workers_lost(), 1);
    }
    let fine: Vec<styk_formats::files::Job> = (0..3).map(|_| Box::new(|_: &dyn Fn() -> bool| {}) as styk_formats::files::Job).collect();
    assert_eq!(pool.engine.run_together(fine, &Arc::new(AtomicBool::new(false)), &|| false, 3), Ok(()), "the report is about that wait: the next save works");
}

#[test]
fn a_save_whose_worker_failed_is_a_failed_save_that_the_next_save_survives() {
    use styk_engine::save::EngineHost;
    use styk_formats::files::JobsFailed;
    struct Failing;
    impl styk_formats::files::Host for Failing {
        fn cancelled(&self) -> bool {
            false
        }
        fn together(&self, _jobs: Vec<styk_formats::files::Job>, _stop: &Arc<std::sync::atomic::AtomicBool>) -> Result<(), JobsFailed> {
            Err(JobsFailed::WorkerLost)
        }
    }
    let tree = tree("engine/tests/edit/startup.document.json");
    let request = || ProjectRequest { name: None, source: None, reservation: None };
    let failed = save_project(std::slice::from_ref(&tree), &[], request(), &Failing);
    let Err(SaveError::File(error)) = failed else { panic!("{:?}", failed.map(|written| written.bytes.len())) };
    assert_eq!((error.code, error.message_key), (Some("worker_failed"), "errors.documentExport.documentExportFailed"));
    let pool = Workers::start(2);
    let host = EngineHost { engine: Some(&pool.engine), cancel: &|| false, clock: || 0.0, helpers: 2, aside: false };
    assert!(save_project(std::slice::from_ref(&tree), &[], request(), &host).is_ok(), "the tree is untouched by a failed save: it saves");
}

#[test]
fn a_save_on_the_workers_writes_the_bytes_of_a_save_on_one_thread_and_a_cancel_reaches_the_workers() {
    use styk_engine::save::EngineHost;
    let tree = heavy_tree(2 << 20);
    let request = || ProjectRequest { name: Some("Side by side".into()), source: None, reservation: None };
    let alone = save_project(std::slice::from_ref(&tree), &[], request(), &|| false).unwrap();
    let pool = Workers::start(3);
    let host = EngineHost { engine: Some(&pool.engine), cancel: &|| false, clock: || 0.0, helpers: 3, aside: false };
    let together = save_project(std::slice::from_ref(&tree), &[], request(), &host).unwrap();
    assert!(together.bytes == alone.bytes, "{} bytes on workers, {} on one thread", together.bytes.len(), alone.bytes.len());
    // Stopped once the preparation is over (it asks four times in the preparation): the jobs on the workers end without a container.
    let asked = std::cell::Cell::new(0usize);
    let stopping = EngineHost { engine: Some(&pool.engine), cancel: &|| { asked.set(asked.get() + 1); asked.get() > 4 }, clock: || 0.0, helpers: 3, aside: false };
    let stopped = save_project(std::slice::from_ref(&tree), &[], request(), &stopping);
    assert!(matches!(stopped, Err(SaveError::Cancelled)), "{:?}", stopped.map(|written| written.bytes.len()));
}

#[test]
fn a_save_tells_where_its_time_went() {
    struct Ticking;
    impl styk_formats::files::Host for Ticking {
        fn cancelled(&self) -> bool {
            false
        }
        fn clock(&self) -> fn() -> f64 {
            || {
                thread_local!(static NOW: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) });
                NOW.with(|now| { now.set(now.get() + 1.0); now.get() })
            }
        }
    }
    let tree = tree("engine/tests/edit/startup.document.json");
    let written = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &Ticking).unwrap();
    let t = written.timings;
    assert!(t.prepare_ms > 0.0 && t.lift_ms > 0.0 && t.frames_ms > 0.0 && t.total_ms >= t.prepare_ms + t.lift_ms, "{t:?}");
    assert_eq!(t.frames.iter().map(|frame| frame.raw_bytes).sum::<usize>(), written.raw_bytes);
}

#[test]
fn a_save_reserves_its_memory_under_the_name_it_is_given_and_gives_it_back_itself() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let token = 4_100_001;
    let request = || ProjectRequest { name: None, source: None, reservation: Some(token) };
    assert!(save_project(std::slice::from_ref(&tree), &[], request(), &|| false).is_ok());
    assert_eq!(styk_alloc::release_named(token), 0, "a finished save has nothing left for the host to release");
    let stopped = save_project(std::slice::from_ref(&tree), &[], request(), &|| true);
    assert!(matches!(stopped, Err(SaveError::Cancelled)));
    assert_eq!(styk_alloc::release_named(token), 0, "nor a stopped one");
}


#[test]
fn a_project_with_a_big_array_is_lifted_in_pieces_on_the_workers_into_the_same_bytes() {
    use styk_engine::save::EngineHost;
    let mut tree = heavy_tree(1 << 16);
    let records: Vec<Value> = (0..300)
        .map(|i| {
            let mut record = Obj::new();
            record.set("n", Value::Num(i as f64));
            record.set("v", Value::Nums(Arc::new(Nums::new(&(0..40).map(|k| (i + k) as f64 * 0.5).collect::<Vec<_>>()))));
            Value::object(record)
        })
        .collect();
    tree.make_obj().unwrap().set("padding", Value::array(records));
    let request = || ProjectRequest { name: Some("In pieces".into()), source: None, reservation: None };
    let alone = save_project(std::slice::from_ref(&tree), &[], request(), &|| false).unwrap();
    let pool = Workers::start(3);
    let host = EngineHost { engine: Some(&pool.engine), cancel: &|| false, clock: || 0.0, helpers: 3, aside: false };
    let in_pieces = save_project(std::slice::from_ref(&tree), &[], request(), &host).unwrap();
    assert!(in_pieces.bytes == alone.bytes, "{} bytes in pieces, {} whole", in_pieces.bytes.len(), alone.bytes.len());
    // A stop at any question of a save in pieces, the batches of the lift included, is a stop and writes nothing.
    for stop_at in [3, 5, 8, 12] {
        let asked = std::cell::Cell::new(0usize);
        let stopping = EngineHost { engine: Some(&pool.engine), cancel: &|| { asked.set(asked.get() + 1); asked.get() >= stop_at }, clock: || 0.0, helpers: 3, aside: false };
        let stopped = save_project(std::slice::from_ref(&tree), &[], request(), &stopping);
        assert!(matches!(stopped, Err(SaveError::Cancelled)) || stopped.is_ok(), "stopped at question {stop_at}: {:?}", stopped.as_ref().map(|written| written.bytes.len()));
    }
}

#[test]
fn a_started_job_runs_beside_the_caller_on_a_worker_or_on_the_caller_when_it_is_waited_for() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use styk_formats::files::JobsFailed;
    for workers in [0usize, 3] {
        let pool = Workers::start(workers);
        let on = Arc::new(std::sync::Mutex::new(None));
        let (slot, caller) = (on.clone(), std::thread::current().id());
        let ran = Arc::new(AtomicUsize::new(0));
        let counter = ran.clone();
        let job: styk_formats::files::Job = Box::new(move |_| {
            *slot.lock().unwrap() = Some(std::thread::current().id());
            std::thread::sleep(std::time::Duration::from_millis(50));
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let cancel = || false;
        let waiting = pool.engine.start_later(job, &Arc::new(AtomicBool::new(false)), &cancel);
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(waiting(), Ok(()));
        assert_eq!(ran.load(Ordering::SeqCst), 1, "it ran once");
        let thread = on.lock().unwrap().expect("it ran");
        assert_eq!(thread == caller, workers == 0, "{workers} workers: on a worker when there is one, else on the caller at the wait");
    }
    // A job that panics, or a worker reported lost, ends the wait with the error.
    let pool = Workers::start(2);
    let boom: styk_formats::files::Job = Box::new(|_| panic!("the job fails"));
    let cancel = || false;
    let waiting = pool.engine.start_later(boom, &Arc::new(AtomicBool::new(false)), &cancel);
    assert_eq!(waiting(), Err(JobsFailed::Panicked));
}

#[test]
fn the_scene_check_starts_on_a_worker_only_where_the_interface_lends_one_aside() {
    use std::sync::atomic::AtomicBool;
    use styk_engine::save::EngineHost;
    use styk_formats::files::Host;
    let pool = Workers::start(3);
    for aside in [false, true] {
        let ran_on = Arc::new(std::sync::Mutex::new(None));
        let (slot, caller) = (ran_on.clone(), std::thread::current().id());
        let host = EngineHost { engine: Some(&pool.engine), cancel: &|| false, clock: || 0.0, helpers: 3, aside };
        let job: styk_formats::files::Job = Box::new(move |_| *slot.lock().unwrap() = Some(std::thread::current().id()));
        let waiting = host.start(job, &Arc::new(AtomicBool::new(false)));
        std::thread::sleep(std::time::Duration::from_millis(200));
        let before_wait = *ran_on.lock().unwrap();
        waiting().unwrap();
        let after_wait = ran_on.lock().unwrap().expect("it ran");
        if aside {
            assert!(before_wait.is_some_and(|thread| thread != caller), "a worker took it while the caller did something else");
        } else {
            assert_eq!(before_wait, None, "nothing ran before the wait");
            assert_eq!(after_wait, caller, "it ran on the caller, when it was waited for");
        }
    }
}
