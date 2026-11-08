use super::*;
use styk_services::{FixedClock, files::fake::MemoryFiles, storage::fake::MemoryStorage};
struct Output;
impl StreamFiles for Output {
    fn replace_stream<'a>(
        &'a self,
        _: &'a FileTarget,
        body: styk_services::files::StreamBody<'a>,
        cancel: &'a Cancel,
    ) -> styk_services::files::FileFuture<'a, ()> {
        Box::pin(async move {
            let mut bytes = Vec::new();
            if cancel.is_cancelled() {
                return Err(FileError::Cancelled);
            }
            body(&mut bytes)?;
            assert!(bytes.starts_with(b"{\"traceEvents\":["));
            Ok(())
        })
    }
}
struct Memory;
impl styk_services::diagnostics::MemoryDiagnostics for Memory {
    fn memory(
        &self,
        complete: Box<dyn FnOnce(Result<styk_services::diagnostics::MemoryReport, String>) + Send>,
    ) -> Result<(), String> {
        complete(Ok(styk_services::diagnostics::MemoryReport {
            private_before: 123,
            private_after: 456,
            ..Default::default()
        }));
        Ok(())
    }
}
fn setup(startup: Startup) -> (Runtime, Arc<MemoryStorage>) {
    let storage = Arc::new(MemoryStorage::default());
    let runtime = Runtime::start(
        Services {
            spawner: Arc::new(styk_platform::spawn::ThreadSpawner),
            clock: Arc::new(FixedClock::new()),
            files: Arc::new(MemoryFiles::default()),
            output: Arc::new(Output),
            storage: storage.clone(),
            memory: Arc::new(Memory),
        },
        startup,
    )
    .unwrap();
    (runtime, storage)
}
fn ask(r: &Runtime, q: Request) -> Result<Reply, String> {
    r.submit(q, Arc::new(|| {})).unwrap().wait()
}
#[test]
fn capture_ownership_stop_export_and_close() {
    let _serial = crate::TRACE_TEST_LOCK.lock().unwrap();
    let (r, _) = setup(Startup {
        profiles: vec![],
        overrides: vec![],
    });
    let owner = r.client();
    let other = r.client();
    let Reply::Value(start) = ask(
        &owner,
        Request::Protocol {
            op: "trace.start".into(),
            args: json!({"cap_mb":1}),
        },
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(start["cap_bytes"], 1024 * 1024);
    assert!(
        ask(&other, Request::Stop)
            .unwrap_err()
            .contains("another developer client")
    );
    let until = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        match ask(&owner, Request::Stop).unwrap() {
            Reply::Stopped { summary, .. } => {
                assert_eq!(summary["truncated"], false);
                break;
            }
            Reply::Value(v) => assert_eq!(v["pending"], true),
            _ => panic!(),
        };
        assert!(std::time::Instant::now() < until);
        std::thread::yield_now();
    }
    ask(
        &owner,
        Request::Export(FileTarget::new("test.perfetto.json")),
    )
    .unwrap();
    owner.clear_capture();
    // The request is FIFO after the lifecycle wake; closing this client frees its capture.
    assert!(
        ask(
            &owner,
            Request::Export(FileTarget::new("test.perfetto.json"))
        )
        .is_err()
    );
    ask(&other, Request::Start).unwrap();
    other.clear_capture();
    ask(&other, Request::Start).unwrap();
    owner.clear_capture();
    // Another client's close cannot discard the new capture.
    assert!(
        ask(&other, Request::Start)
            .unwrap_err()
            .contains("already active")
    );
    other.clear_capture();
}
#[test]
fn worker_keeps_parameters_after_a_client_closes_and_profiles_roundtrip() {
    let (r, storage) = setup(Startup {
        profiles: vec![],
        overrides: vec!["capture.cap_mb=20".into(), "capture.cap_mb=30".into()],
    });
    let client = r.client();
    ask(
        &client,
        Request::Set {
            name: "capture.cap_mb".into(),
            value: json!(40),
        },
    )
    .unwrap();
    ask(&client, Request::SaveProfile("test".into())).unwrap();
    assert!(storage.get("test.json").is_some());
    drop(client);
    ask(&r, Request::Reset("capture.cap_mb".into())).unwrap();
    ask(&r, Request::LoadProfile("test".into())).unwrap();
    let Reply::Parameters(rows) = ask(&r, Request::Parameters).unwrap() else {
        panic!()
    };
    assert_eq!(rows[0].effective, json!(40));
    storage.fail(styk_services::storage::fake::Failure::Stage);
    let before = storage.get("test.json");
    assert!(ask(&r, Request::SaveProfile("test".into())).is_err());
    assert_eq!(storage.get("test.json"), before);
    assert!(ask(&r, Request::SaveProfile("../escape".into())).is_err());
}
#[test]
fn completed_unread_replies_retain_admission_and_wake() {
    let (r, _) = setup(Startup {
        profiles: vec![],
        overrides: vec![],
    });
    let (send, receive) = mpsc::sync_channel(8);
    let mut handles = Vec::new();
    for _ in 0..8 {
        let send = send.clone();
        let p = r
            .submit(
                Request::Parameters,
                Arc::new(move || {
                    send.try_send(()).unwrap();
                }),
            )
            .unwrap();
        p.wait().unwrap();
        handles.push(p);
    }
    for _ in 0..8 {
        receive.recv_timeout(Duration::from_secs(30)).unwrap();
    }
    assert!(r.submit(Request::Parameters, Arc::new(|| {})).is_err());
    drop(handles);
    assert!(ask(&r, Request::Parameters).is_ok());
    assert!(
        r.submit(Request::Reset("x".repeat(8192)), Arc::new(|| {}))
            .is_err()
    );
}
#[test]
fn memory_is_the_service_report_and_invalid_startup_is_visible() {
    let (r, _) = setup(Startup {
        profiles: vec![],
        overrides: vec![],
    });
    let Reply::Memory(m) = ask(&r, Request::Memory).unwrap() else {
        panic!()
    };
    assert_eq!((m.private_before, m.private_after), (123, 456));
    let (bad, _) = setup(Startup {
        profiles: vec![],
        overrides: vec!["unknown=1".into()],
    });
    assert!(
        ask(&bad, Request::Parameters)
            .unwrap_err()
            .contains("unknown parameter")
    );
}
#[test]
fn cancelled_memory_retains_admission_until_callback_finishes() {
    type Complete =
        Box<dyn FnOnce(Result<styk_services::diagnostics::MemoryReport, String>) + Send>;
    struct Delayed(mpsc::SyncSender<Complete>);
    impl styk_services::diagnostics::MemoryDiagnostics for Delayed {
        fn memory(&self, complete: Complete) -> Result<(), String> {
            self.0.send(complete).map_err(|e| e.to_string())
        }
    }
    let (send, receive) = mpsc::sync_channel(1);
    let r = Runtime::start(
        Services {
            spawner: Arc::new(styk_platform::spawn::ThreadSpawner),
            clock: Arc::new(FixedClock::new()),
            files: Arc::new(MemoryFiles::default()),
            output: Arc::new(Output),
            storage: Arc::new(MemoryStorage::default()),
            memory: Arc::new(Delayed(send)),
        },
        Startup {
            profiles: vec![],
            overrides: vec![],
        },
    )
    .unwrap();
    let pending = r
        .submit(
            Request::Memory,
            Arc::new(|| panic!("cancelled reply woke the interface")),
        )
        .unwrap();
    let complete = receive.recv_timeout(Duration::from_secs(30)).unwrap();
    drop(pending);
    let mut kept = Vec::new();
    for _ in 0..7 {
        let p = r.submit(Request::Parameters, Arc::new(|| {})).unwrap();
        p.wait().unwrap();
        kept.push(p);
    }
    assert!(r.submit(Request::Parameters, Arc::new(|| {})).is_err());
    complete(Ok(Default::default()));
    assert!(ask(&r, Request::Parameters).is_ok());
}
