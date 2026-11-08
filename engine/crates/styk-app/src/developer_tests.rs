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
struct Memory;
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
    let clock = FixedClock::new();
    let spawner: Arc<dyn Spawner> = Arc::new(styk_platform::spawn::ThreadSpawner);
    let store = Arc::new(styk_services::storage::fake::MemoryStorage::default());
    let runtime = Runtime::start(
        Services {
            spawner: spawner.clone(),
            clock: runtime_clock.unwrap_or_else(|| Arc::new(clock.clone())),
            files: Arc::new(styk_services::files::fake::MemoryFiles::default()),
            output: Arc::new(styk_platform::files::LocalFiles),
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
    )
    .unwrap();
    top.layouts = Arc::new(styk_core::layout::LayoutStore::new(store));
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
