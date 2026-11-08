//! Drive App::close/update, returned tasks, the real wake stream and mounted controls.
//! Never inject Documents ticks: missing production scheduling must strand the test.
use super::*;
use iced::{Point, Widget as _};
use iced::futures::{Stream, task::{ArcWake, waker}};
use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};
use styk_core::documents::{Effect as Doc, Request};
use styk_core::focus::FocusId;
use styk_core::recovery::model::ids;
use styk_design::widgets::testing::Driver;
use styk_services::{FixedClock, Cancel};
use styk_services::recovery::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct Gate { fail: AtomicBool, pause: AtomicBool, ignore_cancel: AtomicBool, after_commit: AtomicBool, read_only: AtomicBool, observer: std::sync::Mutex<Option<mpsc::SyncSender<()>>>, wake: iced::futures::task::AtomicWaker }
impl Gate { fn release(&self) { self.pause.store(false, Ordering::SeqCst); self.wake.wake(); } }
struct Store { local: styk_platform::recovery::LocalRecovery, gate: Arc<Gate> }
impl Recovery for Store {
    fn list<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, Vec<Record>> {
        Box::pin(async move { let mut records = self.local.list(cancel).await?; if self.gate.read_only.load(Ordering::SeqCst) { for record in &mut records { record.read_only = true; } } Ok(records) })
    }
    fn create<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> {
        Box::pin(async move { Ok(Arc::new(Copy { local: self.local.create(cancel).await?, gate: self.gate.clone() }) as Arc<dyn RecoveryCopy>) })
    }
    fn claim<'a>(&'a self, record: &'a Record, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> { self.local.claim(record, cancel) }
}
struct Copy { local: Arc<dyn RecoveryCopy>, gate: Arc<Gate> }
impl RecoveryCopy for Copy {
    fn slot(&self) -> &Slot { self.local.slot() }
    fn read<'a>(&'a self, record: &'a Record, max: usize, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<[u8]>> { self.local.read(record, max, cancel) }
    fn remove<'a>(&'a self, record: &'a Record, cancel: &'a Cancel) -> RecoveryFuture<'a, ()> { self.local.remove(record, cancel) }
    fn write<'a>(&'a self, previous: Option<&'a Record>, bytes: &'a [u8], name: &'a str, cancel: &'a Cancel) -> RecoveryFuture<'a, Record> {
        Box::pin(async move {
            let gate = self.gate.clone(); cancel.on_cancel(move || gate.wake.wake());
            let notify = || { if let Some(send) = &*self.gate.observer.lock().unwrap() { send.try_send(()).unwrap(); } };
            let after_commit = self.gate.after_commit.load(Ordering::SeqCst);
            let committed = if after_commit { Some(self.local.write(previous, bytes, name, cancel).await) } else { None };
            notify();
            iced::futures::future::poll_fn(|cx| {
                self.gate.wake.register(cx.waker());
                if self.gate.pause.load(Ordering::SeqCst) && (self.gate.ignore_cancel.load(Ordering::SeqCst) || !cancel.is_cancelled()) { Poll::Pending } else { Poll::Ready(()) }
            }).await;
            if self.gate.fail.load(Ordering::SeqCst) { return Err(styk_services::files::FileError::Full.into()); }
            let result = match committed { Some(result) => result, None => self.local.write(previous, bytes, name, cancel).await };
            notify();
            result
        })
    }
}
const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const WINDOW: Size = Size::new(900.0, 600.0);

struct LayoutStorage {
    inner: styk_services::storage::fake::MemoryStorage,
    paused: mpsc::SyncSender<()>,
    load_gate: Option<Arc<Gate>>,
}
impl styk_services::storage::Storage for LayoutStorage {
    fn load<'a>(&'a self, name: &'a str, max: usize) -> styk_services::files::FileFuture<'a, Option<Arc<[u8]>>> {
        Box::pin(async move {
            if let Some(gate) = &self.load_gate {
                iced::futures::future::poll_fn(|cx| {
                    gate.wake.register(cx.waker());
                    if gate.pause.load(Ordering::SeqCst) { Poll::Pending } else { Poll::Ready(()) }
                }).await;
            }
            self.inner.load(name, max).await
        })
    }
    fn update<'a>(&'a self, name: &'a str, max: usize, update: styk_services::storage::Update, cancel: &'a Cancel) -> styk_services::files::FileFuture<'a, ()> {
        let mut work = self.inner.update(name, max, update, cancel);
        let mut notified = false;
        Box::pin(iced::futures::future::poll_fn(move |cx| {
            let result = work.as_mut().poll(cx);
            if result.is_pending() && self.inner.staged() && !notified {
                self.paused.try_send(()).unwrap(); notified = true;
            }
            if result.is_ready() && notified { self.paused.try_send(()).unwrap(); }
            result
        }))
    }
}
struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        static SERIAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("styk-b3-{}-{}", std::process::id(), SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Root { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
struct Signal(mpsc::SyncSender<()>);
impl ArcWake for Signal { fn wake_by_ref(this: &Arc<Self>) { let _ = this.0.try_send(()); } }
struct Runtime {
    app: App,
    root: Root,
    clock: FixedClock,
    gate: Arc<Gate>,
    checkpoint_finished: bool,
    stream: Pin<Box<dyn Stream<Item = Message>>>,
    messages: VecDeque<Message>,
    signal: std::task::Waker,
    ready: mpsc::Receiver<()>,
    _outcome: mpsc::Receiver<Outcome>,
}
impl Runtime {
    fn new() -> Self {
        Self::with_layouts(None)
    }
    fn with_layouts(layouts: Option<Arc<dyn styk_services::storage::Storage>>) -> Self {
        let root = Root::new(); let wakes = wakes::Wakes::new();
        let shell::Start::Run(shell) = shell::start(&[], true, &wakes.callback()) else { panic!("sandbox shell") };
        let (outcome, receive) = mpsc::sync_channel(1);
        let mut app = App::new(Launch::default(), None, Some(Strategy::HiddenWindow), outcome, shell, wakes.clone(), 0).unwrap();
        let clock = FixedClock::new(); let callback = wakes.callback();
        let gate = Arc::new(Gate::default());
        let store = Arc::new(Store { local: styk_platform::recovery::LocalRecovery::new(root.0.clone()), gate: gate.clone() });
        app.band = top_band::TopBand::new(WINDOW, Arc::new(clock.clone()), None, Arc::new(styk_platform::spawn::ThreadSpawner), callback, Some(store), layouts.map(|store| Arc::new(styk_core::layout::LayoutStore::new(store)))).unwrap();
        app.band.core.documents.set_autosave_seconds(0.0);
        app.strategy = None; // Test the interactive guard without a real profile or a visible window.
        let (signal, ready) = mpsc::sync_channel(1);
        Self { app, root, clock, gate, checkpoint_finished: false, stream: Box::pin(wake_stream(&wakes)), messages: VecDeque::new(), signal: waker(Arc::new(Signal(signal))), ready, _outcome: receive }
    }
    fn task(&mut self, task: Task<Message>) {
        let view = iced::widget::stack![self.app.band.wake_widget(), self.app.band.overlay_layer(Theme::Light)].map(Message::Band).boxed();
        let mut driver = Driver::new(view, WINDOW, &styk_design::fonts::ALL);
        self.messages.extend(driver.run(task));
    }
    fn message(&mut self, message: Message) {
        if matches!(&message, Message::Band(top_band::Message::Editor(styk_ui::message::Message::SessionCheckpointFinished))) { self.checkpoint_finished = true; }
        let task = self.app.update(message); self.task(task); }
    fn next(&mut self) -> bool {
        let message = self.messages.pop_front().or_else(|| match self.stream.as_mut().poll_next(&mut Context::from_waker(&self.signal)) {
            Poll::Ready(message) => message, Poll::Pending => None,
        });
        if let Some(message) = message { self.message(message); true } else { false }
    }
    #[track_caller]
    fn until(&mut self, done: impl Fn(&App) -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !done(&self.app) || !self.messages.is_empty() {
            if !self.next() { self.ready.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).expect("production tasks/wakes stranded the requested transition"); }
            assert!(std::time::Instant::now() < deadline, "production tasks spun without settling");
        }
    }
    fn drain(&mut self) {
        for _ in 0..128 { if !self.next() { return; } }
        panic!("the idle app kept scheduling work");
    }
    fn advance_deadline(&mut self) {
        let due = self.app.band.core.documents.recovery_deadline().expect("a real recovery deadline");
        use styk_services::Clock;
        self.clock.advance(due.saturating_sub(self.clock.now()));
        let sent = {
            let mut driver = Driver::new(self.app.band.wake_widget().map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
            driver.redraw(); driver.messages()
        };
        assert!(!sent.is_empty(), "the mounted deadline adapter must publish the wake");
        for message in sent { self.message(message); }
    }
    fn settle_prompt_animation(&mut self) {
        use styk_services::Clock;
        let overlay = self.app.band.core.recovery().closing().unwrap().0;
        for _ in 0..128 {
            if self.app.band.core.overlays().phase(overlay) >= 1.0 { return; }
            let due = Duration::from_millis(self.app.band.core.overlay_deadline().expect("prompt animation deadline"));
            self.clock.advance(due.saturating_sub(self.clock.now()));
            let sent = {
                let mut driver = Driver::new(self.app.band.wake_widget().map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
                driver.redraw(); driver.messages()
            };
            assert!(!sent.is_empty(), "the mounted animation wake must advance the prompt");
            for message in sent { self.message(message); }
            self.drain();
        }
        panic!("prompt animation did not settle");
    }
    fn settled(&mut self) {
        // Consume the initial wake before waiting for the listing's completion.
        assert!(self.next());
        self.until(|app| app.band.core.documents.recovery_view().is_some_and(|view| !view.busy));
        self.drain();
    }
    fn close(&mut self) { let task = self.app.close(); self.task(task); }
    fn click(&mut self, id: FocusId) -> usize {
        let sent = {
            let mut driver = Driver::new(self.app.band.overlay_layer(Theme::Light).map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
            let bounds = driver.snapshot().bounds_of(id).expect("mounted control");
            let at = Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0);
            driver.point_at(at); driver.events(&[iced::Event::Mouse(iced::mouse::Event::CursorMoved { position: at })]); driver.click(at); driver.messages()
        };
        let count = sent.iter().filter(|message| matches!(message, Message::Band(top_band::Message::Editor(styk_ui::message::Message::Command(styk_core::commands::Command::Recovery(_)))))).count();
        for message in sent { self.message(message); } count
    }
    fn dirty(&mut self, titled: bool) {
        let ask = if titled {
            let file = self.root.0.join("Project.styk"); std::fs::write(&file, STARTUP).unwrap();
            Request::OpenFile(styk_services::files::FileTarget::new(file))
        } else { Request::New };
        assert!(matches!(self.app.band.core.documents.dispatch(ask), Ok(Doc::Started(_))));
        self.until(|app| app.band.core.documents.active().is_some() && app.band.core.documents.published().is_some());
        self.drain();
        let id = self.app.band.core.documents.active().unwrap().id();
        self.app.band.core.documents.call(id, "setFPS", &[styk_core::engine::Value::Num(30.0)], &styk_core::engine::Value::Null).unwrap().result.unwrap();
    }
    fn prompt(&mut self) { self.until(|app| app.band.core.recovery().closing().is_some()); }
}
#[test]
fn settled_idle_app_close_gets_its_first_poll() {
    let mut rt = Runtime::new(); rt.settled(); rt.close(); rt.until(|app| app.closing);
}
#[test]
fn busy_app_close_is_coalesced_and_retried_on_host_progress() {
    let mut rt = Runtime::new(); rt.settled();
    assert!(matches!(rt.app.band.core.documents.dispatch(Request::New), Ok(Doc::Started(_))));
    rt.close(); rt.close(); rt.until(|app| app.closing);
}
#[test]
fn dirty_cancel_and_discard_run_from_mounted_buttons_with_autosave_off() {
    for titled in [false, true] {
        let mut rt = Runtime::new(); rt.settled(); rt.dirty(titled); rt.close(); rt.prompt(); rt.click(ids::KEEP_EDITING);
        rt.until(|app| app.band.core.recovery().closing().is_none());
        assert!(rt.app.band.core.documents.active().unwrap().dirty()); assert!(!rt.app.closing);
        rt.close(); rt.prompt(); rt.click(ids::DONT_SAVE); rt.until(|app| app.closing);
    }
}
#[test]
fn untitled_save_keeps_an_actionable_close_prompt() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(false); rt.close(); rt.prompt();
    assert_eq!(rt.click(ids::SAVE), 0, "the unavailable Save control sends no answer");
    rt.drain();
    assert!(rt.app.band.core.recovery().closing().is_some(), "no file-dialog consumer: keep Discard and Cancel actionable");
    assert!(!rt.app.band.core.recovery().closing().unwrap().1.save_available);
    rt.settle_prompt_animation();
    {
        // Inspectable evidence of the existing prompt, with only its unavailable Save state changed.
        let mut driver = Driver::new(rt.app.band.overlay_layer(Theme::Light).map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
        let (rgba, size) = driver.render(&styk_ui::base_theme(Theme::Light), iced::Color::WHITE, 1.0);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../artifacts/b3/untitled.png");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        styk_platform::screenshot::write(&path, &Image { rgba, width: size.width, height: size.height }).unwrap();
    }
    rt.click(ids::KEEP_EDITING); rt.drain();
    assert!(rt.app.band.core.recovery().closing().is_none());
    assert!(rt.app.band.core.documents.active().unwrap().dirty());
    rt.close(); rt.prompt();
}
#[test]
fn titled_save_completes_quit_and_writes_current_bytes() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(true); rt.close(); rt.prompt(); rt.click(ids::SAVE); rt.until(|app| app.closing);
    assert!(!rt.app.band.core.documents.active().unwrap().dirty());
    assert_ne!(std::fs::read(rt.root.0.join("Project.styk")).unwrap(), STARTUP);
}

#[test]
fn retry_with_autosave_off_starts_without_an_unrelated_frame() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(true);
    rt.gate.fail.store(true, Ordering::SeqCst); rt.close(); rt.prompt();
    assert!(rt.app.band.core.recovery().closing().unwrap().1.retry());
    rt.gate.fail.store(false, Ordering::SeqCst); rt.click(ids::RETRY);
    rt.prompt(); assert!(!rt.app.band.core.recovery().closing().unwrap().1.retry());
    rt.click(ids::DONT_SAVE); rt.until(|app| app.closing);
}
#[test]
fn session_end_retains_the_checkpoint_and_quit_until_the_worker_answers() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(false);
    rt.gate.pause.store(true, Ordering::SeqCst);
    rt.message(Message::SessionEnd);
    rt.until(|app| app.band.core.documents.recovery_view().unwrap().busy);
    rt.drain();
    assert!(!rt.app.closing && !rt.checkpoint_finished);
    assert!(rt.app.band.core.recovery().closing().is_none());
    rt.gate.release(); rt.prompt(); rt.drain();
    assert!(rt.checkpoint_finished, "the OS block reason must be released after the checkpoint");
    assert_eq!(rt.app.band.core.session_end_deadline(), None, "a completed checkpoint retires its timer");
    rt.click(ids::KEEP_EDITING); rt.drain();
    assert!(rt.app.band.core.documents.active().unwrap().dirty()); assert!(!rt.app.closing);
    assert!(!rt.app.band.core.session_end_requested(), "Cancel also retires the OS quit intent");
}
#[test]
fn stalled_session_checkpoint_expires_through_the_mounted_wake_and_ignores_late_completion() {
    for after_commit in [false, true] {
        let mut rt = Runtime::new(); rt.settled(); rt.dirty(false);
        rt.app.band.core.documents.set_autosave_seconds(2.5);
        rt.advance_deadline();
        rt.until(|app| app.band.core.documents.recovery_view().unwrap().busy);
        rt.until(|app| !app.band.core.documents.recovery_view().unwrap().busy); rt.drain();
        let id = rt.app.band.core.documents.active().unwrap().id();
        rt.app.band.core.documents.call(id, "setFPS", &[styk_core::engine::Value::Num(31.0)], &styk_core::engine::Value::Null).unwrap().result.unwrap();
        let (send, receive) = mpsc::sync_channel(2);
        *rt.gate.observer.lock().unwrap() = Some(send);
        rt.gate.ignore_cancel.store(true, Ordering::SeqCst);
        rt.gate.after_commit.store(after_commit, Ordering::SeqCst);
        rt.gate.pause.store(true, Ordering::SeqCst);
        rt.advance_deadline();
        receive.recv_timeout(Duration::from_secs(15)).expect("the recovery write entered its gate");
        let committed: Vec<_> = std::fs::read_dir(&rt.root.0).unwrap().filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "styk"))
            .map(|entry| (entry.path(), std::fs::read(entry.path()).unwrap())).collect();
        assert!(!committed.is_empty());
        rt.message(Message::SessionEnd); rt.drain();
        assert!(!rt.app.closing && !rt.checkpoint_finished);
        assert!(rt.app.band.core.recovery().closing().is_none());
        rt.clock.advance(shell::session_end_timeout() + Duration::from_millis(1));
        // No gate release, notification or manual Documents tick can supply the missing wake.
        let sent = {
            let mut driver = Driver::new(rt.app.band.wake_widget().map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
            driver.redraw(); driver.messages()
        };
        assert!(!sent.is_empty(), "session-end must schedule a bounded wake even while recovery is pending");
        for message in sent { rt.message(message); } rt.drain();
        assert!(rt.checkpoint_finished, "release the shutdown block reason");
        assert!(rt.app.closing, "QuitReady must follow without waiting for the gate");
        assert!(matches!(rt._outcome.try_recv(), Ok(Outcome::Done)), "exit must not wait for another disk save");
        for (path, bytes) in &committed { assert_eq!(&std::fs::read(path).unwrap(), bytes); }
        rt.gate.release();
        receive.recv_timeout(Duration::from_secs(15)).expect("the late checkpoint completed");
        rt.drain();
        for (path, bytes) in &committed { assert_eq!(&std::fs::read(path).unwrap(), bytes); }
        assert!(rt._outcome.try_recv().is_err(), "a late reply cannot finish the window twice");
        assert!(rt.app.band.core.recovery().closing().is_none());
    }
}

#[test]
fn merged_quit_guards_documents_then_flushes_or_abandons_layout_without_exceeding_session_end() {
    use styk_services::storage::fake::{Failure, MemoryStorage};
    use styk_core::layout::{PanelId, store::LayoutFile};
    for (failure, session_first) in [(Failure::None, false), (Failure::Stage, false), (Failure::PauseBeforeCommit, false), (Failure::PauseBeforeCommit, true)] {
        let (paused, receive) = mpsc::sync_channel(1);
        let store = Arc::new(LayoutStorage { inner: MemoryStorage::default(), paused, load_gate: None });
        let committed = LayoutFile::default().encode().unwrap();
        store.inner.put("layouts.json", committed.clone());
        let mut rt = Runtime::with_layouts(Some(store.clone())); rt.settled();
        let load = rt.app.band.load_layouts(); rt.task(load.map(Message::Band));
        rt.until(|app| app.band.layouts_idle());
        rt.dirty(true);
        rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(styk_core::commands::Command::Dock(styk_core::dock::Event::Close(PanelId::new("vfx")))))));
        assert!(rt.app.band.core.dock().save_pending());
        store.inner.fail(failure);
        if session_first { rt.message(Message::SessionEnd); } else { rt.close(); }
        rt.prompt(); rt.drain();
        assert!(!rt.app.quit_cleared && !rt.app.closing, "a pending layout must not bypass the document prompt");
        rt.click(ids::DONT_SAVE);
        rt.until(|app| app.quit_cleared);
        if failure == Failure::PauseBeforeCommit && !session_first {
            receive.recv_timeout(Duration::from_secs(15)).expect("the final layout write is paused");
            assert!(!rt.app.closing, "ordinary quit waits for the final layout receipt");
            let revision = rt.app.band.core.documents.active().unwrap().revision();
            rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(styk_core::commands::Command::Run(styk_core::commands::CommandId::Undo)))));
            assert_eq!(rt.app.band.core.documents.active().unwrap().revision(), revision, "document clearance fences edits while preferences drain");
            rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(styk_core::commands::Command::Dock(styk_core::dock::Event::Close(PanelId::new("library")))))));
            assert!(!rt.app.band.core.dock().layout().closed.contains(&PanelId::new("library")), "the final layout is also frozen");
            // The documents already granted QuitReady. A later OS session request
            // must abandon this stalled preference write without another prompt.
            rt.message(Message::SessionEnd); rt.drain();
            rt.clock.advance(shell::session_end_timeout() + Duration::from_millis(1));
        }
        rt.until(|app| app.closing);
        assert!(rt.app.quit_cleared, "only document QuitReady authorizes the window to end");
        assert!(!rt.app.band.core.dock().save_pending());
        let saved = store.inner.get("layouts.json").unwrap();
        if failure == Failure::None {
            let file = LayoutFile::decode(&saved).unwrap();
            let entry = file.workspaces.get("animate").expect("quit must flush the queued layout before ending");
            let state = styk_core::layout::store::state_from_value(&entry.value, styk_core::layout::Workspace::Animate).unwrap();
            assert!(state.current.closed.contains(&PanelId::new("vfx")));
        } else {
            assert_eq!(saved, committed, "refusal and session-end cancellation preserve the committed file");
        }
        store.inner.fail(Failure::None);
        if failure == Failure::PauseBeforeCommit && !session_first { receive.recv_timeout(Duration::from_secs(15)).expect("the detached layout write completed"); }
        rt.drain();
        assert_eq!(store.inner.get("layouts.json").unwrap(), saved, "late completion cannot replace the preserved file");
    }
}

#[test]
fn a_pending_layout_load_waits_for_its_receipt_without_spinning_the_save_deadline() {
    use styk_services::{Clock, storage::fake::MemoryStorage};
    use styk_core::layout::{PanelId, store::LayoutFile};
    let gate = Arc::new(Gate::default()); gate.pause.store(true, Ordering::SeqCst);
    let (paused, _receive) = mpsc::sync_channel(1);
    let store = Arc::new(LayoutStorage { inner: MemoryStorage::default(), paused, load_gate: Some(gate.clone()) });
    store.inner.put("layouts.json", LayoutFile::default().encode().unwrap());
    let mut rt = Runtime::with_layouts(Some(store.clone())); rt.settled();
    let load = rt.app.band.load_layouts(); rt.task(load.map(Message::Band));
    rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(styk_core::commands::Command::Dock(styk_core::dock::Event::Close(PanelId::new("vfx")))))));
    rt.drain();
    let due = rt.app.band.core.dock().deadline().unwrap();
    rt.clock.advance(Duration::from_millis(due).saturating_sub(rt.clock.now()));
    let mut driver = Driver::new(rt.app.band.wake_widget().map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
    driver.redraw();
    assert!(driver.messages().is_empty(), "an occupied load lane cannot service a save deadline; wait for its real receipt");
    drop(driver);
    gate.release(); rt.until(|app| app.band.layouts_idle());
    // The late load reconciles the edit and queues its normal debounce.
    let due = rt.app.band.core.dock().deadline().unwrap();
    rt.clock.advance(Duration::from_millis(due).saturating_sub(rt.clock.now()));
    let sent = {
        let mut driver = Driver::new(rt.app.band.wake_widget().map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
        driver.redraw(); driver.messages()
    };
    assert!(!sent.is_empty()); for message in sent { rt.message(message); }
    rt.until(|app| !app.band.core.dock().save_pending());
    let file = LayoutFile::decode(&store.inner.get("layouts.json").unwrap()).unwrap();
    let state = styk_core::layout::store::state_from_value(&file.workspaces["animate"].value, styk_core::layout::Workspace::Animate).unwrap();
    assert!(state.current.closed.contains(&PanelId::new("vfx")), "the late load cannot lose the edit");
}

#[test]
fn the_unified_deadline_wakes_layout_before_recovery_without_periodic_polls() {
    use styk_services::{Clock, storage::fake::MemoryStorage};
    use styk_core::layout::{PanelId, store::LayoutFile};
    let store = Arc::new(MemoryStorage::default());
    store.put("layouts.json", LayoutFile::default().encode().unwrap());
    let mut rt = Runtime::with_layouts(Some(store.clone())); rt.settled(); rt.dirty(false);
    rt.app.band.core.documents.set_autosave_seconds(2.5);
    rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(styk_core::commands::Command::Dock(styk_core::dock::Event::Close(PanelId::new("vfx")))))));
    let due = rt.app.band.core.wake_deadline(true).unwrap();
    assert_eq!(Some(due), rt.app.band.core.dock().deadline());
    assert!(Duration::from_millis(due) < rt.app.band.core.documents.recovery_deadline().unwrap());
    rt.clock.advance(Duration::from_millis(due).saturating_sub(rt.clock.now()));
    let sent = {
        let mut driver = Driver::new(rt.app.band.wake_widget().map(Message::Band).boxed(), WINDOW, &styk_design::fonts::ALL);
        driver.redraw(); driver.messages()
    };
    assert!(!sent.is_empty());
    for message in sent { rt.message(message); }
    rt.until(|app| !app.band.core.dock().save_pending());
    assert!(LayoutFile::decode(&store.get("layouts.json").unwrap()).unwrap().workspaces.contains_key("animate"));
    rt.advance_deadline();
    let root = rt.root.0.clone();
    // A fast write may finish within the returned tasks; wait for the durable
    // outcome, not a busy state that can already have passed.
    rt.until(|app| !app.band.core.documents.recovery_view().unwrap().busy && std::fs::read_dir(&root).unwrap().filter_map(Result::ok).any(|entry| entry.path().extension().is_some_and(|ext| ext == "styk")));
}
#[test]
fn self_check_invalidated_checkpoint_allows_another_quit() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(false);
    rt.gate.pause.store(true, Ordering::SeqCst); rt.message(Message::SessionEnd);
    rt.until(|app| app.band.core.documents.recovery_view().unwrap().busy);
    rt.until(|app| app.band.core.documents.published().is_some()); rt.drain();
    let id = rt.app.band.core.documents.active().unwrap().id();
    rt.app.band.core.documents.call(id, "setFPS", &[styk_core::engine::Value::Num(31.0)], &styk_core::engine::Value::Null).unwrap().result.unwrap();
    rt.until(|app| !app.band.core.documents.recovery_view().unwrap().busy); rt.drain();
    assert!(rt.checkpoint_finished && !rt.app.closing);
    rt.gate.release(); rt.close(); rt.prompt();
}
#[test]
fn self_check_stale_answer_reports_the_refusal_through_returned_tasks() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(true); rt.close(); rt.prompt();
    let id = rt.app.band.core.documents.active().unwrap().id();
    rt.app.band.core.documents.call(id, "setFPS", &[styk_core::engine::Value::Num(31.0)], &styk_core::engine::Value::Null).unwrap().result.unwrap();
    rt.click(ids::DONT_SAVE); rt.drain();
    assert!(rt.app.band.core.recovery().closing().is_none());
    assert!(rt.app.band.core.documents.active().unwrap().dirty());
    let notice = rt.app.band.core.overlays().messages().current().expect("a refused answer must reach a visible owner");
    assert_eq!(notice.text, rt.app.band.core.presentation().text(&styk_core::i18n::Msg::new("privacyUi.operationFailedPleaseTryAgain")));
}
#[test]
fn autosave_uses_the_mounted_deadline_and_worker_notifications() {
    let mut rt = Runtime::new(); rt.settled(); rt.dirty(false);
    rt.app.band.core.documents.set_autosave_seconds(2.5);
    rt.advance_deadline();
    rt.until(|app| app.band.core.documents.recovery_view().unwrap().busy);
    rt.until(|app| !app.band.core.documents.recovery_view().unwrap().busy);
    assert!(std::fs::read_dir(&rt.root.0).unwrap().filter_map(Result::ok).any(|entry| entry.path().extension().is_some_and(|ext| ext == "styk")));
}
#[test]
fn legacy_restore_from_mounted_offer_adopts_only_an_orphan() {
    for read_only in [true, false] {
        let mut rt = Runtime::new();
        std::fs::write(rt.root.0.join("recovery.styk"), STARTUP).unwrap();
        rt.gate.read_only.store(read_only, Ordering::SeqCst);
        rt.settled();
        let offer = rt.app.band.core.overlays().messages().current().unwrap();
        let restore = offer.actions.iter().position(|action| action.command == styk_core::overlay::messages::Do::Recovery(styk_core::recovery::model::Event::Restore)).unwrap();
        let button = styk_core::overlay::host::message_button_id(offer.id, restore);
        rt.click(button); rt.until(|app| app.band.core.documents.active().is_some()); rt.drain();
        assert!(rt.app.band.core.documents.active().unwrap().dirty());
        rt.close(); rt.prompt();
        assert!(!rt.app.band.core.recovery().closing().unwrap().1.retry(), "a restored read-only source checkpoints into a new writable slot");
        rt.click(ids::DONT_SAVE); rt.until(|app| app.closing);
        assert_eq!(rt.root.0.join("recovery.styk").exists(), read_only, "read-only restore must own a new copy, never the legacy source");
        if read_only { assert_eq!(std::fs::read(rt.root.0.join("recovery.styk")).unwrap(), STARTUP); }
    }
}
