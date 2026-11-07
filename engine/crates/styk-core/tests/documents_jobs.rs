use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Poll, Waker};
use std::time::{Duration, Instant};
use styk_core::documents::*;
use styk_engine::{Budgets, Engine};
use styk_services::{Cancel, Job, SpawnError, Spawner};
use styk_services::files::{FileError, FileFuture, FileTarget, Files};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
struct Threads;
impl Spawner for Threads {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
        std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|error| SpawnError(error.to_string()))
    }
}
#[derive(Default)]
struct Gate { released: AtomicBool, wake: Mutex<Option<Waker>> }
impl Gate {
    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        if let Some(waker) = self.wake.lock().unwrap().take() { waker.wake(); }
    }
}
struct SlowFiles {
    gate: Arc<Gate>,
    entered: mpsc::SyncSender<std::thread::ThreadId>,
    dropped: mpsc::SyncSender<std::thread::ThreadId>,
}
impl Drop for SlowFiles { fn drop(&mut self) { let _ = self.dropped.try_send(std::thread::current().id()); } }
impl Files for SlowFiles {
    fn read<'a>(&'a self, _: &'a FileTarget, _: usize, cancel: &'a Cancel) -> FileFuture<'a, Arc<[u8]>> {
        Box::pin(async move {
            let mut registered = false;
            std::future::poll_fn(move |context| {
                if cancel.is_cancelled() { return Poll::Ready(Err(FileError::Cancelled)); }
                if self.gate.released.load(Ordering::SeqCst) { return Poll::Ready(Ok(Arc::from(STARTUP))); }
                *self.gate.wake.lock().unwrap() = Some(context.waker().clone());
                if !registered {
                    registered = true;
                    let wake = context.waker().clone(); cancel.on_cancel(move || wake.wake());
                    self.entered.try_send(std::thread::current().id()).unwrap();
                }
                Poll::Pending
            }).await
        })
    }
    fn replace<'a>(&'a self, _: &'a FileTarget, _: &'a [u8], _: &'a Cancel) -> FileFuture<'a, ()> {
        Box::pin(async { Err(FileError::ReadOnly) })
    }
}
fn next(docs: &mut Documents) -> Effect {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(effect) = docs.poll() { return effect; }
        assert!(Instant::now() < deadline, "operation must finish");
        std::thread::yield_now();
    }
}

#[test]
fn long_open_returns_while_pending_cancel_wakes_it_and_drop_reclaims_off_the_interface() {
    let interface = std::thread::current().id();
    let gate = Arc::new(Gate::default());
    let (entered, entry) = mpsc::sync_channel(1); let (dropped, drop_notice) = mpsc::sync_channel(1);
    let mut docs = Documents::new();
    docs.attach_host(HostOptions {
        engine: Engine::new(|| 0.0, Budgets::for_device(None)), spawner: Arc::new(Threads),
        files: Arc::new(SlowFiles { gate: gate.clone(), entered, dropped }),
        startup: styk_doc::json::parse(STARTUP).unwrap(), clock: || 0.0, notify: Arc::new(|| {}),
    }).unwrap();
    // The gate is only released after dispatch returned. On a blocking implementation the watchdog
    // releases it so this test fails its assertion instead of stranding a process.
    let (sent, received) = mpsc::sync_channel(1);
    let caller = std::thread::spawn(move || {
        let effect = docs.dispatch(Request::OpenFile(FileTarget::new("Slow.styk"))).map_err(|(error, _)| error).unwrap();
        sent.send((docs, effect)).map_err(|_| ()).unwrap();
    });
    let returned = received.recv_timeout(Duration::from_secs(1));
    if returned.is_err() { gate.release(); }
    caller.join().unwrap();
    let (mut docs, Effect::Started(job)) = returned.unwrap() else { panic!("start") };
    assert_ne!(entry.recv_timeout(Duration::from_secs(5)).unwrap(), interface);
    assert!(!gate.released.load(Ordering::SeqCst));
    assert!(matches!(docs.dispatch(Request::New), Err((HostError::Documents(DocumentsError::Busy), Request::New))));
    assert!(matches!(docs.dispatch(Request::Cancel(job)), Ok(Effect::Cancelled(id)) if id == job));
    assert!(matches!(next(&mut docs), Effect::Cancelled(id) if id == job));
    assert!(docs.tabs().is_empty());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop { match docs.dispatch(Request::OpenBytes { bytes: Arc::from(STARTUP), name: "Clean.styk".into() }) {
        Ok(Effect::Started(_)) => break,
        Err((HostError::Documents(DocumentsError::Busy), _)) => { assert!(Instant::now() < deadline); std::thread::yield_now(); }
        _ => panic!("clean retry"),
    } }
    assert!(matches!(next(&mut docs), Effect::Opened(_)));
    assert!(docs.active().unwrap().frame_records().is_ok());
    drop(docs);
    assert_ne!(drop_notice.recv_timeout(Duration::from_secs(5)).unwrap(), interface);
}

#[test]
fn dropping_an_owner_cancels_a_file_future_and_does_not_join_it() {
    let interface = std::thread::current().id();
    let (entered, entry) = mpsc::sync_channel(1); let (dropped, drop_notice) = mpsc::sync_channel(1);
    let mut docs = Documents::new();
    docs.attach_host(HostOptions {
        engine: Engine::new(|| 0.0, Budgets::for_device(None)), spawner: Arc::new(Threads),
        files: Arc::new(SlowFiles { gate: Arc::new(Gate::default()), entered, dropped }),
        startup: styk_doc::json::parse(STARTUP).unwrap(), clock: || 0.0, notify: Arc::new(|| {}),
    }).unwrap();
    assert!(matches!(docs.dispatch(Request::OpenFile(FileTarget::new("Slow.styk"))), Ok(Effect::Started(_))));
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(docs);
    assert_ne!(drop_notice.recv_timeout(Duration::from_secs(5)).unwrap(), interface);
}
