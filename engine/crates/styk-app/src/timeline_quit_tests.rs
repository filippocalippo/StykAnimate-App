//! Settings joins the recovery harness's real App, mounted prompt and subscription streams.
use super::*;
use styk_core::{commands::{Command, CommandId}, engine::{Value, json}, settings::{Event as SettingsEvent, SettingId}};
use styk_services::{Clock, storage::{Storage, Update}};

struct SettingsStorage {
    local: styk_platform::storage::LocalStorage,
    gate: Arc<Gate>,
    receipt: mpsc::SyncSender<()>,
}
impl Storage for SettingsStorage {
    fn load<'a>(&'a self, name: &'a str, max: usize) -> styk_services::files::FileFuture<'a, Option<Arc<[u8]>>> {
        self.local.load(name, max)
    }
    fn update<'a>(&'a self, name: &'a str, max: usize, update: Update, cancel: &'a Cancel) -> styk_services::files::FileFuture<'a, ()> {
        Box::pin(async move {
            let gate = self.gate.clone(); cancel.on_cancel(move || gate.wake.wake());
            self.receipt.try_send(()).unwrap();
            iced::futures::future::poll_fn(|cx| {
                self.gate.wake.register(cx.waker());
                if self.gate.pause.load(Ordering::SeqCst) && !cancel.is_cancelled() { Poll::Pending } else { Poll::Ready(()) }
            }).await;
            let result = if self.gate.fail.load(Ordering::SeqCst) {
                Err(styk_services::files::FileError::Full)
            } else { self.local.update(name, max, update, cancel).await };
            self.receipt.try_send(()).unwrap();
            result
        })
    }
}

#[test]
fn dirty_quit_discards_then_drains_settings_and_layout_under_the_same_fence_and_session_bound() {
    use styk_services::storage::fake::{Failure, MemoryStorage};
    use styk_core::layout::{PanelId, store::LayoutFile};
    for (session_end, refuse_settings) in [(false, false), (false, true), (true, false)] {
        let root = Root::new();
        let previous = br#"{"schema":1,"values":{"loopPlayback":true,"unknown":7},"view":{"unknownView":8}}"#;
        let settings_path = root.0.join(styk_core::settings::persistence::FILE);
        std::fs::write(&settings_path, previous).unwrap();
        let gate = Arc::new(Gate::default());
        let (settings_receipt, settings_receive) = mpsc::sync_channel(4);
        let settings = Arc::new(SettingsStorage {
            local: styk_platform::storage::LocalStorage::new(&root.0, &styk_platform::spawn::ThreadSpawner).unwrap(),
            gate: gate.clone(), receipt: settings_receipt,
        });
        let (layout_receipt, layout_receive) = mpsc::sync_channel(4);
        let layouts = Arc::new(LayoutStorage { inner: MemoryStorage::default(), paused: layout_receipt, load_gate: None });
        let old_layout = LayoutFile::default().encode().unwrap();
        layouts.inner.put("layouts.json", old_layout.clone());
        let mut rt = Runtime::with_preferences(Some(layouts.clone()), Some(settings));
        rt.settled(); rt.until(|app| app.band.core.settings_idle());
        let load = rt.app.band.load_layouts(); rt.task(load.map(Message::Band));
        rt.until(|app| app.band.layouts_idle()); rt.dirty(true);
        gate.pause.store(true, Ordering::SeqCst); gate.fail.store(refuse_settings, Ordering::SeqCst);
        layouts.inner.fail(Failure::PauseBeforeCommit);
        rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(Command::Settings(SettingsEvent::Set {
            id: SettingId::LoopPlayback, value: Value::Bool(false), now: rt.clock.now().as_millis() as u64,
        })))));
        rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(Command::Dock(styk_core::dock::Event::Close(PanelId::new("vfx")))))));
        assert!(!rt.app.band.core.settings_idle()); assert!(rt.app.band.core.dock().save_pending());
        rt.close(); rt.prompt();
        assert!(!rt.app.quit_cleared && !rt.app.closing);
        assert!(rt.click(ids::DONT_SAVE) > 0, "the mounted Discard control must route its command");
        rt.until(|app| app.quit_cleared);
        settings_receive.recv_timeout(Duration::from_secs(30)).expect("final Settings write starts through the quit fence");
        layout_receive.recv_timeout(Duration::from_secs(30)).expect("layout flush starts beside Settings");
        assert!(!rt.app.closing);
        let revision = rt.app.band.core.documents.active().unwrap().revision();
        rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(Command::Run(CommandId::Undo)))));
        rt.message(Message::Band(top_band::Message::Editor(styk_ui::Message::Command(Command::Settings(SettingsEvent::Set {
            id: SettingId::LoopPlayback, value: Value::Bool(true), now: rt.clock.now().as_millis() as u64,
        })))));
        assert_eq!(rt.app.band.core.documents.active().unwrap().revision(), revision);
        assert!(!rt.app.band.core.settings().animation().loop_playback, "input remains fenced while maintenance runs");
        if session_end {
            let before = rt.clock.now();
            rt.message(Message::SessionEnd);
            rt.until(|app| app.closing);
            assert!(rt.clock.now() <= before + shell::session_end_timeout(), "preference work cannot extend the session bound");
            assert!(rt.app.band.core.settings_idle(), "session end detached Settings");
            gate.release(); layouts.inner.fail(Failure::None);
        } else {
            gate.release();
            rt.until(|app| app.band.core.settings_idle());
            assert!(!rt.app.closing, "Settings completion cannot bypass the pending layout receipt");
            layouts.inner.fail(Failure::None);
            rt.until(|app| app.closing);
        }
        settings_receive.recv_timeout(Duration::from_secs(30)).expect("Settings completed or acknowledged cancellation");
        layout_receive.recv_timeout(Duration::from_secs(30)).expect("layout completed or acknowledged cancellation");
        rt.drain();
        let saved = std::fs::read(&settings_path).unwrap();
        if session_end || refuse_settings { assert_eq!(saved, previous); }
        else {
            let saved = json::parse(&saved).unwrap();
            assert_eq!(saved.path(&["values", "loopPlayback"]), Some(&Value::Bool(false)));
            assert_eq!(saved.path(&["values", "unknown"]), Some(&Value::Num(7.)));
            assert_eq!(saved.path(&["view", "unknownView"]), Some(&Value::Num(8.)));
        }
        let saved_layout = layouts.inner.get("layouts.json").unwrap();
        if session_end { assert_eq!(saved_layout, old_layout); }
        else {
            let file = LayoutFile::decode(&saved_layout).unwrap();
            let state = styk_core::layout::store::state_from_value(&file.workspaces["animate"].value, styk_core::layout::Workspace::Animate).unwrap();
            assert!(state.current.closed.contains(&PanelId::new("vfx")));
        }
        assert_eq!(std::fs::read(rt.root.0.join("Project.styk")).unwrap(), STARTUP, "Discard never saves the dirty edit");
    }
}
