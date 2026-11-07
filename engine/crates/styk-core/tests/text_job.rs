//! The text job: revisions, latest draft wins, cancellation, the bounded command queue and the face limits.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use styk_core::text::{
    Busy, CancelToken, CompileRequest, FontSource, JobEvent, TextCompiler, TextError, TextJob, MAX_FACES,
};
use styk_doc::{json, Obj, Value};

fn noto(style: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../../vendor/text/NotoSans-{style}.ttf"))).unwrap()
}

fn compiler() -> TextCompiler {
    TextCompiler::new(Arc::new(|style| {
        let name = ["Regular", "Bold", "Italic", "BoldItalic"][style];
        Some(Arc::from(noto(name).into_boxed_slice()))
    }))
}

fn options(text: &str, size: f64) -> Value {
    let mut o = Obj::new();
    o.set("text", Value::str(text));
    o.set("fontSize", Value::Num(size));
    Value::object(o)
}

fn request(revision: u64, text: &str) -> CompileRequest {
    CompileRequest { revision, font: FontSource::Bundled, options: options(text, 40.0) }
}

/// Every distinct character of a long text, so a compile takes a while.
fn long_text() -> String {
    let distinct: String = (0x21u8..0x7f).map(|b| b as char).chain((0xa1u32..0x100).filter_map(char::from_u32)).collect();
    distinct.chars().cycle().take(16384).collect()
}

fn wait_for(job: &TextJob, done: impl Fn(&[JobEvent]) -> bool) -> Vec<JobEvent> {
    let started = Instant::now();
    let mut seen = Vec::new();
    while started.elapsed() < Duration::from_secs(60) {
        seen.extend(job.take_events());
        if done(&seen) {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("the job did not finish: {} events", seen.len());
}

fn compiled_revisions(events: &[JobEvent]) -> Vec<u64> {
    events.iter().filter_map(|e| if let JobEvent::Compiled(c) = e { Some(c.revision) } else { None }).collect()
}

#[test]
fn the_latest_draft_wins_and_every_result_carries_its_revision() {
    let job = TextJob::spawn(compiler(), || {});
    job.compile(request(1, &long_text()));
    for revision in 2..=6 {
        job.compile(request(revision, &format!("Draft {revision}")));
    }
    let events = wait_for(&job, |events| compiled_revisions(events).contains(&6));
    let revisions = compiled_revisions(&events);
    assert_eq!(*revisions.last().unwrap(), 6);
    assert!(revisions.windows(2).all(|w| w[0] < w[1]), "results arrive in revision order: {revisions:?}");
    let JobEvent::Compiled(last) = events.last().unwrap() else { panic!("last event is the newest compile") };
    let figure = last.result.as_ref().unwrap();
    assert_eq!(figure.path(&["text_assets"]).and_then(|a| a.item(0)).and_then(|a| a.get("text").cloned()), Some(Value::str("Draft 6")));
}

#[test]
fn a_running_compile_stops_when_a_newer_draft_arrives() {
    let job = TextJob::spawn(compiler(), || {});
    job.compile(request(1, &long_text()));
    // Give the thread time to start the long compile, then supersede it.
    std::thread::sleep(Duration::from_millis(30));
    let superseded_at = Instant::now();
    job.compile(request(2, "short"));
    let events = wait_for(&job, |events| compiled_revisions(events).contains(&2));
    let after = superseded_at.elapsed();
    assert!(!compiled_revisions(&events).contains(&1) || compiled_revisions(&events)[0] == 1, "revision 1 is either done before 2 or dropped");
    assert!(after < Duration::from_secs(20), "the newer draft waited {after:?}");
}

#[test]
fn a_cancelled_token_ends_a_compile_with_cancelled_after_its_glyphs_are_read() {
    let mut compiler = compiler();
    let token = CancelToken::new();
    token.cancel();
    let result = compiler.compile(&request(1, &long_text()), &token);
    assert_eq!(result, Err(TextError::Cancelled));
}

#[test]
fn cancel_forgets_the_waiting_draft_and_the_running_one_delivers_nothing() {
    let job = TextJob::spawn(compiler(), || {});
    job.compile(request(1, &long_text()));
    job.cancel();
    std::thread::sleep(Duration::from_millis(500));
    let events = job.take_events();
    assert!(compiled_revisions(&events).is_empty(), "{events:?}");
}

#[test]
fn a_full_command_queue_says_busy_and_every_accepted_command_is_answered() {
    // The thread is stuck in `notify` after the first answer, so the queue fills.
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let job = {
        let gate = gate.clone();
        TextJob::spawn(compiler(), move || {
            let (open, changed) = &*gate;
            let mut open = open.lock().unwrap();
            while !*open {
                open = changed.wait(open).unwrap();
            }
        })
    };
    let (mut accepted, mut busy) = (0, 0);
    for _ in 0..60 {
        match job.set_source(None) {
            Ok(()) => accepted += 1,
            Err(Busy) => busy += 1,
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(busy > 0, "the queue never filled");
    assert!((16..=17).contains(&accepted), "{accepted} commands were accepted");
    {
        let (open, changed) = &*gate;
        *open.lock().unwrap() = true;
        changed.notify_all();
    }
    let events = wait_for(&job, |events| events.len() == accepted);
    assert!(events.iter().all(|e| matches!(e, JobEvent::Source(Ok(None)))));
}

#[test]
fn dropping_the_job_stops_the_thread_even_in_the_middle_of_a_compile() {
    let job = TextJob::spawn(compiler(), || {});
    job.compile(request(1, &long_text()));
    std::thread::sleep(Duration::from_millis(20));
    let started = Instant::now();
    drop(job);
    assert!(started.elapsed() < Duration::from_secs(20), "drop waited {:?}", started.elapsed());
}

#[test]
fn faces_are_limited_in_number_and_size_and_must_parse() {
    let mut compiler = compiler();
    let regular = noto("Regular");
    for i in 0..MAX_FACES {
        let info = compiler.load_font(regular.clone(), &format!("face-{i}")).unwrap();
        assert_eq!(info.id, format!("font-{}", i + 1));
        assert_eq!(info.family, "Noto Sans");
    }
    let refused = compiler.load_font(regular.clone(), "ninth").unwrap_err();
    assert!(matches!(refused, TextError::Message { key: "errors.textAuthoringWorker.thisSessionHasEnoughFontsLoadedCloseAnd", .. }));
    compiler.clear_fonts();
    assert!(matches!(compiler.load_font(Vec::new(), "empty"), Err(TextError::Message { key: "errors.textAuthoringWorker.chooseATtfOrOtfFontSmallerThan", .. })));
    assert!(matches!(
        compiler.load_font(vec![0u8; 100], "garbage"),
        Err(TextError::Message { key: "errors.textAuthoring.couldNotReadChooseATruetypeTtfOr", .. })
    ));
    assert!(compiler.load_font(regular, "after clearing").is_ok());
    let unknown = CompileRequest { revision: 0, font: FontSource::Loaded("font-99".into()), options: options("x", 20.0) };
    assert!(matches!(compiler.compile(&unknown, &CancelToken::new()), Err(TextError::Message { key: "errors.textAuthoringWorker.chooseAFontAgain", .. })));
    let embedded = CompileRequest { revision: 0, font: FontSource::Embedded, options: options("x", 20.0) };
    assert!(matches!(compiler.compile(&embedded, &CancelToken::new()), Err(TextError::Message { key: "errors.textAuthoringWorker.thereIsNoEmbeddedTextToEdit", .. })));
    let _ = json::to_string(&Value::Null);
}

#[test]
fn dropping_the_job_does_not_wait_for_a_worker_stuck_in_its_notification() {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let entered = Arc::new(AtomicBool::new(false));
    let job = {
        let (gate, entered) = (gate.clone(), entered.clone());
        TextJob::spawn(compiler(), move || {
            entered.store(true, Ordering::Release);
            let (open, changed) = &*gate;
            let mut open = open.lock().unwrap();
            while !*open {
                open = changed.wait(open).unwrap();
            }
        })
    };
    job.set_source(None).unwrap();
    let started = Instant::now();
    while !entered.load(Ordering::Acquire) {
        assert!(started.elapsed() < Duration::from_secs(10), "the worker never answered");
        std::thread::sleep(Duration::from_millis(2));
    }
    let (done, returned) = mpsc::channel();
    std::thread::spawn(move || {
        drop(job);
        let _ = done.send(());
    });
    let dropped = returned.recv_timeout(Duration::from_secs(2)).is_ok();
    // Whatever happened, let the worker go so the test leaves no thread behind.
    let (open, changed) = &*gate;
    *open.lock().unwrap() = true;
    changed.notify_all();
    assert!(dropped, "dropping the job waited for its worker");
}

#[test]
fn closing_the_job_hands_the_thread_to_the_caller_to_join_off_the_interface_thread() {
    let job = TextJob::spawn(compiler(), || {});
    job.compile(request(1, "done soon"));
    let thread = job.close().expect("the thread is still there");
    thread.join().expect("the worker ends cleanly");
}

#[test]
fn replies_nobody_takes_are_counted_with_the_commands_and_stay_bounded() {
    let job = TextJob::spawn(compiler(), || {});
    let (mut accepted, mut busy) = (0, 0);
    for _ in 0..300 {
        match job.set_source(None) {
            Ok(()) => accepted += 1,
            Err(Busy) => busy += 1,
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(busy > 0, "{accepted} commands were accepted without a single reply being taken");
    assert!(accepted <= 17, "{accepted} commands were accepted");
    std::thread::sleep(Duration::from_millis(100));
    let events = job.take_events();
    assert_eq!(events.len(), accepted);
    // Taking the replies frees the room.
    assert_eq!(job.set_source(None), Ok(()));
}

#[test]
fn queued_payload_bytes_are_bounded_too() {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let job = {
        let gate = gate.clone();
        TextJob::spawn(compiler(), move || {
            let (open, changed) = &*gate;
            let mut open = open.lock().unwrap();
            while !*open {
                open = changed.wait(open).unwrap();
            }
        })
    };
    job.set_source(None).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    // Fonts of 32 MiB each: a handful fill the byte allowance long before the count does.
    let big = vec![0u8; 32 * 1024 * 1024];
    let accepted = (0..10).filter(|_| job.load_font(big.clone(), "big").is_ok()).count();
    let (open, changed) = &*gate;
    *open.lock().unwrap() = true;
    changed.notify_all();
    assert!((1..=4).contains(&accepted), "{accepted} fonts of 32 MiB were queued");
}
