//! Core-stage integration: real handler, effect tasks, deadline widget and worker wake stream.
use super::*;
use iced::futures::Stream;
use std::{
    pin::Pin,
    sync::mpsc,
    task::{Context, Poll, Wake, Waker},
    time::Duration,
};
use styk_core::{
    commands::{Command, CommandId},
    dev_extension::{Event as Dev, Value as Param},
};
use styk_design::widgets::testing::{Driver, key_event};
use styk_devtools::{
    ParameterValue,
    runtime::{Runtime, Services, Startup},
};
#[path = "developer_view_tests.rs"]
mod views;
struct Memory;
fn registered() -> (TopBand, FixedClock, Runtime, Driver<'static, Message>) {
    use styk_devtools::params::Registry;
    registered_with(Registry::default())
}
/// The harness with the owner's explicit registrations (and the standard test parameters added to `registry`).
fn registered_with(mut registry: styk_devtools::params::Registry) -> (TopBand, FixedClock, Runtime, Driver<'static, Message>) {
    use styk_devtools::params::{Descriptor, Kind};
    let (mut top, clock, _, driver) = setup();
    for (name, kind, default) in [
        (
            "a.integer",
            Kind::Integer { min: 0, max: 100 },
            ParameterValue::from(8),
        ),
        ("b.bool", Kind::Bool, ParameterValue::from(false)),
        (
            "c.enum",
            Kind::Enum(vec!["a".into(), "b".into()]),
            ParameterValue::from("a"),
        ),
    ] {
        registry
            .register(
                Descriptor {
                    name: name.into(),
                    kind,
                    default,
                    unit: String::new(),
                    restart: true,
                },
                |_| Ok(()),
            )
            .unwrap();
    }
    for i in 0..100 {
        registry
            .register(
                Descriptor {
                    name: format!("z{i:03}"),
                    kind: Kind::Integer { min: 0, max: 10 },
                    default: ParameterValue::from(0),
                    unit: String::new(),
                    restart: false,
                },
                |_| Ok(()),
            )
            .unwrap();
    }
    let runtime = Runtime::start_registered(
        Services {
            spawner: Arc::new(styk_platform::spawn::ThreadSpawner),
            clock: Arc::new(clock.clone()),
            files: Arc::new(styk_services::files::fake::MemoryFiles::default()),
            output: Arc::new(ExportProbe::default()),
            storage: Arc::new(styk_services::storage::fake::MemoryStorage::default()),
            memory: Arc::new(Memory),
        },
        Startup {
            profiles: vec![],
            overrides: vec![],
        },
        registry,
    )
    .unwrap();
    top.attach_developer(runtime.clone());
    (top, clock, runtime, driver)
}
#[test]
fn owner_pending_edits_and_export_draft() {
    let (mut top, _, _, mut driver) = registered();
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        true,
    );
    settle(&mut top, &mut driver);
    send(
        &mut top,
        &mut driver,
        Dev::Input(Some(CommandId::DevCaptureExport)),
    );
    send(&mut top, &mut driver, Dev::Draft("keep.json".into()));
    for _ in 0..2 {
        send(
            &mut top,
            &mut driver,
            Dev::Step {
                name: "a.integer".into(),
                direction: 1,
            },
        );
        settle(&mut top, &mut driver);
    }
    let host = top.developer.as_ref().unwrap();
    assert_eq!(
        host.parameters.rows[0].pending,
        Some(ParameterValue::from(10))
    );
    assert_eq!(host.input, Some(CommandId::DevCaptureExport));
    assert_eq!(host.draft, "keep.json");
    for expected in [true, false] {
        send(&mut top, &mut driver, Dev::Toggle("b.bool".into()));
        settle(&mut top, &mut driver);
        assert_eq!(
            top.developer.as_ref().unwrap().parameters.rows[1].pending,
            Some(ParameterValue::from(expected))
        );
    }
    send(
        &mut top,
        &mut driver,
        Dev::Choose {
            name: "c.enum".into(),
            index: 1,
        },
    );
    settle(&mut top, &mut driver);
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows[2].pending,
        Some(ParameterValue::from("b"))
    );
}
#[test]
fn owner_parameter_page_round_trip() {
    let (mut top, _, _, mut driver) = registered();
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        true,
    );
    settle(&mut top, &mut driver);
    let mut starts = vec![0];
    while let Some(next) = top.developer.as_ref().unwrap().parameters.next {
        starts.push(next);
        send(&mut top, &mut driver, Dev::ParametersPage(next));
        settle(&mut top, &mut driver);
    }
    assert!(starts.len() > 2);
    starts.pop();
    for previous in starts.into_iter().rev() {
        assert_eq!(
            top.developer.as_ref().unwrap().parameters.previous(),
            Some(previous)
        );
        send(&mut top, &mut driver, Dev::ParametersPage(previous));
        settle(&mut top, &mut driver);
    }
    assert_eq!(top.developer.as_ref().unwrap().parameters.previous(), None);
}
fn log_page(top: &mut TopBand, clock: &FixedClock, driver: &mut Driver<'static, Message>) {
    deadline(top, clock, driver);
    for _ in 0..16 {
        if !top.developer.as_ref().unwrap().logs.page.lines.is_empty() {
            return;
        }
        let m = wake_message(top);
        deliver(top, driver, m);
    }
    panic!("log page missing");
}
#[test]
fn owner_log_round_trips_and_filter_during_sample() {
    for bytes in [10, 2048] {
        let (mut top, clock, runtime, mut driver) = setup();
        for i in 0..120 {
            runtime
                .logs
                .record(i, 3, "owner", format_args!("{}", "x".repeat(bytes)));
        }
        send(
            &mut top,
            &mut driver,
            Dev::Filter {
                level: 3,
                module: "owner".into(),
                text: String::new(),
            },
        );
        panel(
            &mut top,
            &mut driver,
            styk_core::dev_extension::Panel::Logs,
            true,
        );
        log_page(&mut top, &clock, &mut driver);
        let mut starts = vec![0];
        while let Some(next) = top.developer.as_ref().unwrap().logs.next() {
            starts.push(next);
            send(&mut top, &mut driver, Dev::LogsPage(next));
            log_page(&mut top, &clock, &mut driver);
        }
        starts.pop();
        for previous in starts.into_iter().rev() {
            assert_eq!(
                top.developer.as_ref().unwrap().logs.previous(),
                Some(previous)
            );
            send(&mut top, &mut driver, Dev::LogsPage(previous));
            log_page(&mut top, &clock, &mut driver);
        }
        let next = top.developer.as_ref().unwrap().logs.next().unwrap();
        send(&mut top, &mut driver, Dev::LogsPage(next));
        deadline(&mut top, &clock, &mut driver); // leave the old sample pending
        send(
            &mut top,
            &mut driver,
            Dev::Filter {
                level: 3,
                module: "owner".into(),
                text: "x".into(),
            },
        );
        assert_eq!(top.developer.as_ref().unwrap().logs.filter.offset, 0);
        assert!(top.developer.as_ref().unwrap().logs.page.lines.is_empty());
        log_page(&mut top, &clock, &mut driver);
        assert_eq!(
            top.developer.as_ref().unwrap().logs.page.lines[0].time_ns,
            0
        );
        assert_eq!(top.developer.as_ref().unwrap().logs.previous(), None);
    }
}
// Captures share trace admission; keep these lifetime tests deterministic without timing thresholds.
static CAPTURE_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Default)]
struct ExportProbe {
    fail: std::sync::atomic::AtomicBool,
    bytes: std::sync::Mutex<Vec<u8>>,
}
impl styk_services::files::StreamFiles for ExportProbe {
    fn replace_stream<'a>(
        &'a self,
        _: &'a styk_services::files::FileTarget,
        body: styk_services::files::StreamBody<'a>,
        _: &'a styk_services::Cancel,
    ) -> styk_services::files::FileFuture<'a, ()> {
        Box::pin(async move {
            if self.fail.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(styk_services::files::FileError::Full);
            }
            let mut bytes = Vec::new();
            body(&mut bytes)?;
            *self.bytes.lock().unwrap() = bytes;
            Ok(())
        })
    }
}
struct PausedStore(Arc<styk_services::storage::fake::MemoryStorage>);
impl Drop for PausedStore {
    fn drop(&mut self) {
        self.0.fail(styk_services::storage::fake::Failure::None);
    }
}
fn pause_save(
    top: &mut TopBand,
    driver: &mut Driver<'static, Message>,
    store: Arc<styk_services::storage::fake::MemoryStorage>,
) -> PausedStore {
    store.fail(styk_services::storage::fake::Failure::PauseBeforeCommit);
    let pause = PausedStore(store);
    send(top, driver, Dev::SaveProfile("delayed".into()));
    let until = std::time::Instant::now() + Duration::from_secs(30);
    while !pause.0.staged() {
        assert!(
            std::time::Instant::now() < until,
            "save reached the storage boundary"
        );
        std::thread::yield_now();
    }
    pause
}
fn panel(
    top: &mut TopBand,
    driver: &mut Driver<'static, Message>,
    panel: styk_core::dev_extension::Panel,
    open: bool,
) {
    send(top, driver, Dev::Panel { panel, open });
}
fn deadline(top: &mut TopBand, clock: &FixedClock, driver: &mut Driver<'static, Message>) {
    clock.advance(Duration::from_millis(50));
    let mut wake = Driver::new(top.developer_wake(), Size::new(1., 1.), &[]);
    wake.redraw();
    for message in wake.messages() {
        deliver(top, driver, message);
    }
}
fn stopped(top: &mut TopBand, clock: &FixedClock, driver: &mut Driver<'static, Message>) {
    let until = std::time::Instant::now() + Duration::from_secs(30);
    while !top.developer.as_ref().unwrap().profiler.can_export {
        assert!(
            std::time::Instant::now() < until,
            "stop reaches its terminal reply"
        );
        if top.developer.as_ref().unwrap().busy() {
            let message = wake_message(top);
            deliver(top, driver, message);
        } else {
            assert!(
                top.developer.as_ref().unwrap().deadline().is_some(),
                "stop intent retained"
            );
            deadline(top, clock, driver);
        }
    }
}
fn retained_capture(failed_export: bool, protocol: bool) {
    let _serial = CAPTURE_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let output = Arc::new(ExportProbe::default());
    let (mut a, clock, runtime, mut driver) =
        setup_with_services(None, Arc::new(Default::default()), output.clone());
    panel(
        &mut a,
        &mut driver,
        styk_core::dev_extension::Panel::Profiler,
        true,
    );
    send(&mut a, &mut driver, Dev::Start);
    settle(&mut a, &mut driver);
    assert!(a.developer.as_ref().unwrap().profiler.recording);
    send(&mut a, &mut driver, Dev::Stop);
    stopped(&mut a, &clock, &mut driver);
    if failed_export {
        output
            .fail
            .store(true, std::sync::atomic::Ordering::Relaxed);
        send(
            &mut a,
            &mut driver,
            Dev::Export(styk_services::files::FileTarget::new("capture.json")),
        );
        settle(&mut a, &mut driver);
        assert!(a.developer.as_ref().unwrap().error.is_some());
        assert!(a.developer.as_ref().unwrap().profiler.can_export);
        output
            .fail
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
    if protocol {
        // The same production runtime handler used by the control protocol, with a distinct lease.
        let client = runtime.client();
        let answer = client
            .submit(
                styk_devtools::runtime::Request::Protocol {
                    op: "trace.start".into(),
                    args: ParameterValue::Null,
                },
                Arc::new(|| {}),
            )
            .unwrap()
            .wait();
        assert!(answer.unwrap_err().contains("another developer client"));
    } else {
        let (mut b, _, _, mut other_driver) = setup();
        b.attach_developer(runtime.clone());
        panel(
            &mut b,
            &mut other_driver,
            styk_core::dev_extension::Panel::Profiler,
            true,
        );
        send(&mut b, &mut other_driver, Dev::Start);
        settle(&mut b, &mut other_driver);
        assert!(
            !b.developer.as_ref().unwrap().profiler.recording,
            "another client cannot replace the retained capture"
        );
        assert!(b.developer.as_ref().unwrap().error.is_some());
    }
    send(
        &mut a,
        &mut driver,
        Dev::Export(styk_services::files::FileTarget::new("capture.json")),
    );
    settle(&mut a, &mut driver);
    assert!(a.developer.as_ref().unwrap().error.is_none());
    assert!(
        output
            .bytes
            .lock()
            .unwrap()
            .starts_with(b"{\"traceEvents\":")
    );
    panel(
        &mut a,
        &mut driver,
        styk_core::dev_extension::Panel::Profiler,
        false,
    );
    // Explicit release permits a new owner.
    let next = runtime.client();
    next.submit(styk_devtools::runtime::Request::Start, Arc::new(|| {}))
        .unwrap()
        .wait()
        .unwrap();
    next.clear_capture();
}
#[test]
fn review_capture_lease_after_stop() {
    retained_capture(false, false);
}
#[test]
fn review_capture_lease_after_failed_export() {
    retained_capture(true, false);
}
#[test]
fn review_protocol_capture_lease_after_stop() {
    retained_capture(false, true);
}
#[test]
fn review_protocol_capture_lease_after_failed_export() {
    retained_capture(true, true);
}
#[test]
fn review_stop_survives_delayed_save_and_full_ordinary_admission() {
    let _serial = CAPTURE_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let store = Arc::new(styk_services::storage::fake::MemoryStorage::default());
    let (mut top, clock, runtime, mut driver) =
        setup_with_services(None, store.clone(), Arc::new(ExportProbe::default()));
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Profiler,
        true,
    );
    send(&mut top, &mut driver, Dev::Start);
    settle(&mut top, &mut driver);
    assert!(top.developer.as_ref().unwrap().profiler.recording);
    let pause = pause_save(&mut top, &mut driver, store.clone());
    let held: Vec<_> = (0..7)
        .map(|_| {
            runtime
                .submit(styk_devtools::runtime::Request::Parameters, Arc::new(|| {}))
                .unwrap()
        })
        .collect();
    assert!(
        runtime
            .submit(styk_devtools::runtime::Request::Parameters, Arc::new(|| {}))
            .is_err()
    );
    let available = top.developer.as_ref().unwrap().availability().stop;
    send(&mut top, &mut driver, Dev::Stop);
    assert!(
        top.developer.as_ref().unwrap().profiler.stopping,
        "Stop survives the busy gate"
    );
    assert!(available, "ordinary work never disables Stop");
    drop(pause);
    stopped(&mut top, &clock, &mut driver);
    settle(&mut top, &mut driver);
    assert!(store.get("delayed.json").is_some());
    assert!(!top.developer.as_ref().unwrap().profiler.recording);
    drop(held);
}
#[test]
fn review_parameter_reopen_survives_delayed_save() {
    let store = Arc::new(styk_services::storage::fake::MemoryStorage::default());
    let (mut top, _, _, mut driver) =
        setup_with_services(None, store.clone(), Arc::new(ExportProbe::default()));
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        true,
    );
    settle(&mut top, &mut driver);
    assert_eq!(top.developer.as_ref().unwrap().parameters.rows.len(), 1);
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        false,
    );
    let pause = pause_save(&mut top, &mut driver, store);
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        true,
    );
    assert!(top.developer.as_ref().unwrap().parameters.rows.is_empty());
    drop(pause);
    settle(&mut top, &mut driver);
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows.len(),
        1,
        "reopen retains its first-page intent"
    );
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows[0].effective,
        ParameterValue::from(24)
    );
}
#[test]
fn review_refresh_pressure_retries_current_page() {
    let (mut top, clock, runtime, mut driver) = setup();
    let held: Vec<_> = (0..8)
        .map(|_| {
            let p = runtime
                .submit(styk_devtools::runtime::Request::Parameters, Arc::new(|| {}))
                .unwrap();
            p.wait().unwrap();
            p
        })
        .collect();
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        true,
    );
    send(&mut top, &mut driver, Dev::ParametersPage(1));
    send(&mut top, &mut driver, Dev::ParametersPage(0));
    assert!(top.developer.as_ref().unwrap().parameters.rows.is_empty());
    assert!(
        top.developer.as_ref().unwrap().deadline().is_some(),
        "refused refresh keeps its retry intent"
    );
    drop(held);
    deadline(&mut top, &clock, &mut driver);
    settle(&mut top, &mut driver);
    assert_eq!(top.developer.as_ref().unwrap().parameters.rows.len(), 1);
    assert_eq!(top.developer.as_ref().unwrap().parameters.offset, 0);
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        false,
    );
    assert_eq!(top.developer.as_ref().unwrap().deadline(), None);
}
#[test]
fn review_control_pressure_retains_stop() {
    let _serial = CAPTURE_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (mut top, clock, runtime, mut driver) = setup();
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Profiler,
        true,
    );
    send(&mut top, &mut driver, Dev::Start);
    settle(&mut top, &mut driver);
    let occupied = runtime
        .submit(styk_devtools::runtime::Request::Stop, Arc::new(|| {}))
        .unwrap();
    assert!(
        occupied
            .wait()
            .unwrap_err()
            .contains("another developer client")
    );
    send(&mut top, &mut driver, Dev::Stop);
    assert!(
        top.developer.as_ref().unwrap().profiler.stopping,
        "Stop intent survives reserved-slot pressure"
    );
    assert!(top.developer.as_ref().unwrap().deadline().is_some());
    drop(occupied);
    deadline(&mut top, &clock, &mut driver);
    stopped(&mut top, &clock, &mut driver);
    assert!(!top.developer.as_ref().unwrap().profiler.recording);
    assert!(
        top.developer.as_ref().unwrap().error.is_none(),
        "admitted Stop retires its admission refusal"
    );
}
#[test]
fn review_refresh_retry_waits_for_pending_worker_wake() {
    let store = Arc::new(styk_services::storage::fake::MemoryStorage::default());
    let (mut top, clock, runtime, mut driver) =
        setup_with_services(None, store.clone(), Arc::new(ExportProbe::default()));
    let held: Vec<_> = (0..8)
        .map(|_| {
            let p = runtime
                .submit(styk_devtools::runtime::Request::Parameters, Arc::new(|| {}))
                .unwrap();
            p.wait().unwrap();
            p
        })
        .collect();
    panel(
        &mut top,
        &mut driver,
        styk_core::dev_extension::Panel::Parameters,
        true,
    );
    assert!(top.developer.as_ref().unwrap().deadline().is_some());
    drop(held);
    let pause = pause_save(&mut top, &mut driver, store);
    assert_eq!(
        top.developer.as_ref().unwrap().deadline(),
        None,
        "a pending worker resumes through its wake, not refresh redraws"
    );
    drop(pause);
    settle(&mut top, &mut driver);
    // Admission retry may still be in the future; its deadline is exposed again after the worker settles.
    deadline(&mut top, &clock, &mut driver);
    settle(&mut top, &mut driver);
    assert_eq!(top.developer.as_ref().unwrap().parameters.rows.len(), 1);
}
impl styk_services::diagnostics::MemoryDiagnostics for Memory {
    fn memory(
        &self,
        complete: Box<dyn FnOnce(Result<styk_services::diagnostics::MemoryReport, String>) + Send>,
    ) -> Result<(), String> {
        complete(Ok(styk_services::diagnostics::MemoryReport {
            private_before: 100,
            private_after: 110,
            ..Default::default()
        }));
        Ok(())
    }
}
fn setup() -> (TopBand, FixedClock, Runtime, Driver<'static, Message>) {
    setup_with_runtime_clock(None)
}
fn setup_with_runtime_clock(
    runtime_clock: Option<Arc<dyn styk_services::Clock>>,
) -> (TopBand, FixedClock, Runtime, Driver<'static, Message>) {
    setup_with_services(
        runtime_clock,
        Arc::new(styk_services::storage::fake::MemoryStorage::default()),
        Arc::new(styk_platform::files::LocalFiles),
    )
}
fn setup_with_services(
    runtime_clock: Option<Arc<dyn styk_services::Clock>>,
    store: Arc<styk_services::storage::fake::MemoryStorage>,
    output: Arc<dyn styk_services::files::StreamFiles>,
) -> (TopBand, FixedClock, Runtime, Driver<'static, Message>) {
    let clock = FixedClock::new();
    let spawner: Arc<dyn Spawner> = Arc::new(styk_platform::spawn::ThreadSpawner);
    let runtime = Runtime::start(
        Services {
            spawner: spawner.clone(),
            clock: runtime_clock.unwrap_or_else(|| Arc::new(clock.clone())),
            files: Arc::new(styk_services::files::fake::MemoryFiles::default()),
            output,
            storage: store.clone(),
            memory: Arc::new(Memory),
        },
        Startup {
            profiles: vec![],
            overrides: vec!["capture.cap_mb=24".into()],
        },
    )
    .unwrap();
    let mut top = TopBand::new(
        Size::new(1560., 900.),
        Arc::new(clock.clone()),
        Some(clock.clone()),
        spawner,
        styk_platform::shell::Wakes(Arc::new(|_| {})),
        None,
        Some(Arc::new(styk_core::layout::LayoutStore::new(store))),
        None,
    )
    .unwrap();
    top.attach_developer(runtime.clone());
    let driver = Driver::new(
        iced::widget::space().width(10).height(10).boxed(),
        Size::new(1560., 900.),
        &styk_design::fonts::ALL,
    );
    (top, clock, runtime, driver)
}
fn deliver(top: &mut TopBand, driver: &mut Driver<'static, Message>, message: Message) {
    let mut messages = VecDeque::from([message]);
    let mut n = 0;
    while let Some(message) = messages.pop_front() {
        n += 1;
        assert!(n < 100, "message route must settle");
        let (requests, task) = top.update(message);
        assert!(requests.is_empty());
        messages.extend(driver.run(task));
    }
}
fn send(top: &mut TopBand, driver: &mut Driver<'static, Message>, event: Dev) {
    deliver(
        top,
        driver,
        Message::Editor(styk_ui::Message::Command(Command::Developer(event))),
    );
}
struct Signal(mpsc::SyncSender<()>);
impl Wake for Signal {
    fn wake(self: Arc<Self>) {
        let _ = self.0.try_send(());
    }
    fn wake_by_ref(self: &Arc<Self>) {
        let _ = self.0.try_send(());
    }
}
fn wake_message(top: &TopBand) -> Message {
    let mut stream = Box::pin(developer_stream(&DeveloperWatch(
        top.developer_progress.clone(),
    )));
    let (send, receive) = mpsc::sync_channel(1);
    let waker = Waker::from(Arc::new(Signal(send)));
    let mut cx = Context::from_waker(&waker);
    for _ in 0..16 {
        match Pin::new(&mut stream).poll_next(&mut cx) {
            Poll::Ready(Some(message)) => return message,
            Poll::Ready(None) => panic!("wake stream ended"),
            Poll::Pending => receive
                .recv_timeout(Duration::from_secs(30))
                .expect("real worker notification"),
        }
    }
    panic!("spurious wake loop")
}
fn settle(top: &mut TopBand, driver: &mut Driver<'static, Message>) {
    for _ in 0..16 {
        if !top.developer.as_ref().unwrap().busy() {
            return;
        }
        let message = wake_message(top);
        deliver(top, driver, message);
    }
    panic!("developer action did not settle")
}
#[test]
fn logs_alone_do_not_sample_overlay_timings() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Reads(AtomicUsize);
    impl styk_services::Clock for Reads {
        fn now(&self) -> Duration {
            self.0.fetch_add(1, Ordering::Relaxed);
            Duration::from_secs(1)
        }
    }
    let probe = Arc::new(Reads(AtomicUsize::new(0)));
    let (mut top, _, runtime, mut driver) = setup_with_runtime_clock(Some(probe.clone()));
    runtime
        .logs
        .record(0, 1, "test", format_args!("visible log"));
    deliver(
        &mut top,
        &mut driver,
        Message::Editor(styk_ui::Message::Command(Command::Run(CommandId::DevLogs))),
    );
    let mut wake_driver = Driver::new(top.developer_wake(), Size::new(1., 1.), &[]);
    wake_driver.redraw();
    for message in wake_driver.messages() {
        deliver(&mut top, &mut driver, message);
    }
    for _ in 0..16 {
        if top.developer.as_ref().unwrap().logs.page.total == 1 {
            break;
        }
        let message = wake_message(&top);
        deliver(&mut top, &mut driver, message);
    }
    let host = top.developer.as_ref().unwrap();
    assert_eq!(
        host.logs.page.total, 1,
        "the real worker delivered the log page"
    );
    assert!(!host.overlay.visible);
    assert_eq!(
        probe.0.load(Ordering::Relaxed),
        0,
        "closed overlay must not sample trace timings"
    );
}
#[test]
fn developer_payloads_reach_dispatch_worker_and_real_wake() {
    let (mut top, _, runtime, mut driver) = setup();
    send(
        &mut top,
        &mut driver,
        Dev::Input(Some(CommandId::DevParameterSet)),
    );
    assert_eq!(
        top.developer.as_ref().unwrap().input,
        Some(CommandId::DevParameterSet)
    );
    send(
        &mut top,
        &mut driver,
        Dev::Set {
            name: "capture.cap_mb".into(),
            value: Param::Integer(64),
        },
    );
    assert!(
        top.developer.as_ref().unwrap().busy(),
        "typed payload reached the extension effect"
    );
    settle(&mut top, &mut driver);
    assert_eq!(
        top.developer.as_ref().unwrap().input,
        None,
        "accepted arguments retire the input request"
    );
    send(
        &mut top,
        &mut driver,
        Dev::Input(Some(CommandId::DevProfileLoad)),
    );
    send(&mut top, &mut driver, Dev::Input(None));
    assert_eq!(top.developer.as_ref().unwrap().input, None);
    assert!(
        !top.developer.as_ref().unwrap().busy(),
        "cancelling arguments submits no work"
    );
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows[0].effective,
        ParameterValue::from(64)
    );
    send(&mut top, &mut driver, Dev::Reset("capture.cap_mb".into()));
    settle(&mut top, &mut driver);
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows[0].effective,
        ParameterValue::from(8)
    );
    // A profiler close retires only that panel's work, never a shared parameter acknowledgement.
    send(
        &mut top,
        &mut driver,
        Dev::Panel {
            panel: styk_core::dev_extension::Panel::Profiler,
            open: true,
        },
    );
    send(
        &mut top,
        &mut driver,
        Dev::Set {
            name: "capture.cap_mb".into(),
            value: Param::Integer(80),
        },
    );
    send(
        &mut top,
        &mut driver,
        Dev::Panel {
            panel: styk_core::dev_extension::Panel::Profiler,
            open: false,
        },
    );
    assert!(top.developer.as_ref().unwrap().busy());
    settle(&mut top, &mut driver);
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows[0].effective,
        ParameterValue::from(80)
    );
    send(
        &mut top,
        &mut driver,
        Dev::Panel {
            panel: styk_core::dev_extension::Panel::Parameters,
            open: true,
        },
    );
    settle(&mut top, &mut driver);
    // The real current-user pipe, protocol proxy, Core route and worker share the setter.
    use styk_services::control::Transport;
    let _reader = styk_devtools::channel::runtime_reader(runtime.clone()).unwrap();
    send(
        &mut top,
        &mut driver,
        Dev::Input(Some(CommandId::DevProfileSave)),
    );
    let peer = styk_platform::LocalControl
        .request(
            &styk_platform::spawn::ThreadSpawner,
            &format!("stykanimate-dev-{}", std::process::id()),
            br#"{"id":1,"op":"param.set","args":{"name":"capture.cap_mb","value":96}}"#.to_vec(),
        )
        .unwrap();
    let message = wake_message(&top);
    deliver(&mut top, &mut driver, message);
    settle(&mut top, &mut driver);
    let until = std::time::Instant::now() + Duration::from_secs(30);
    let answer = loop {
        if let Some(answer) = peer.take() {
            break answer.unwrap();
        }
        assert!(std::time::Instant::now() < until);
        std::thread::yield_now();
    };
    let answer = json::parse(&answer).unwrap();
    assert_eq!(
        answer.get("result").unwrap().get("value").unwrap().as_f64(),
        Some(96.)
    );
    assert_eq!(
        top.developer.as_ref().unwrap().parameters.rows[0].effective,
        ParameterValue::from(96),
        "the visible parameter model follows the channel acknowledgement"
    );
    assert_eq!(
        top.developer.as_ref().unwrap().input,
        Some(CommandId::DevProfileSave),
        "a channel setter and page refresh preserve an unrelated argument request"
    );
    send(&mut top, &mut driver, Dev::Input(None));
    let pending = runtime
        .submit(styk_devtools::runtime::Request::Parameters, Arc::new(|| {}))
        .unwrap();
    let styk_devtools::runtime::Reply::Parameters(rows) = pending.wait().unwrap() else {
        panic!()
    };
    assert_eq!(rows[0].effective, ParameterValue::from(96));
    drop(top);
    let pending = runtime
        .submit(
            styk_devtools::runtime::Request::Set {
                name: "capture.cap_mb".into(),
                value: ParameterValue::from(128),
            },
            Arc::new(|| {}),
        )
        .unwrap();
    let styk_devtools::runtime::Reply::ParameterPage { rows, .. } = pending.wait().unwrap() else {
        panic!()
    };
    assert_eq!(rows[0].effective, ParameterValue::from(128));
}
#[test]
fn developer_overlay_uses_stage_bounds_and_injected_deadline_widget() {
    let (mut top, clock, _, mut driver) = setup();
    assert_eq!(top.developer.as_ref().unwrap().deadline(), None);
    let key = key_event(
        Key::Named(Named::F11),
        None,
        keyboard::Modifiers::empty(),
        true,
    );
    deliver(&mut top, &mut driver, Message::Raw(key, true));
    let host = top.developer.as_ref().unwrap();
    assert!(host.overlay.visible, "F11 is registered and routed");
    let stage = top.core.dock().solution().stages.values().next().unwrap();
    let bounds = host.overlay.bounds.unwrap();
    assert_eq!(bounds.x, stage.x);
    assert_eq!(bounds.y, stage.y + f64::from(top.height()));
    let mut wake_driver = Driver::new(top.developer_wake(), Size::new(1., 1.), &[]);
    wake_driver.redraw();
    for message in wake_driver.messages() {
        deliver(&mut top, &mut driver, message);
    }
    assert_eq!(top.developer.as_ref().unwrap().deadline(), Some(250));
    // Miss many periods: one request and the next deadline is based on now, not a catch-up loop.
    clock.advance(Duration::from_millis(1000));
    wake_driver = wake_driver.rebuild(top.developer_wake());
    wake_driver.redraw();
    let messages = wake_driver.messages();
    assert_eq!(messages.len(), 1);
    for message in messages {
        deliver(&mut top, &mut driver, message);
    }
    assert_eq!(top.developer.as_ref().unwrap().deadline(), Some(1250));
    send(&mut top, &mut driver, Dev::Overlay(false));
    assert_eq!(top.developer.as_ref().unwrap().deadline(), None);
    assert!(
        !top.core
            .dock()
            .layout()
            .panels()
            .iter()
            .any(|p| p.kind == "dev.overlay")
    );
}
#[test]
fn developer_panel_close_and_layout_undo_reconcile_lifecycle() {
    let (mut top, _, _, mut driver) = setup();
    deliver(
        &mut top,
        &mut driver,
        Message::Editor(styk_ui::Message::Command(Command::Run(CommandId::DevLogs))),
    );
    assert!(
        top.developer
            .as_ref()
            .unwrap()
            .is_open(styk_core::dev_extension::Panel::Logs)
    );
    assert!(top.developer.as_ref().unwrap().deadline().is_some());
    deliver(
        &mut top,
        &mut driver,
        Message::Editor(styk_ui::Message::Command(Command::Run(
            CommandId::LayoutUndo,
        ))),
    );
    assert!(
        !top.developer
            .as_ref()
            .unwrap()
            .is_open(styk_core::dev_extension::Panel::Logs)
    );
    assert_eq!(top.developer.as_ref().unwrap().deadline(), None);
}
