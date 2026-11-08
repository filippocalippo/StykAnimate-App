//! The recovery views headless: the application window is mounted in the harness (`Driver`) under `overlays::layer_of` with
//! the dialogs `recovery::owned` builds, every message a widget sends goes through `message::update_at` and from there
//! `Core::dispatch` as `TopBand::update` does, the documents host is polled as the frame loop polls it and its effects go to
//! `Core::document_effect`. The store is a private temporary directory read by the real local store.
//!
//! The interaction script (`recovery.auto`, the automation language) runs through the widgets: a button is a click at its
//! laid-out bounds, a pick is a press on the select and on the row of its list.

use iced::widget::{container, stack};
use iced::{Element, Event, Length, Point, Size, Widget as _, mouse};
use std::sync::Arc;
use styk_core::app::Core;
use styk_core::automation::{Expect, RecoveryExpect, RecoveryStep, Script, Step};
use styk_core::commands::Command;
use styk_core::focus::FocusId;
use styk_core::overlay::host::{message_button_id, row_id};
use styk_core::overlay::messages::Do;
use styk_core::recovery::model::{Choice, Event as Ask, ids};
use styk_core::services::Cancel;
use styk_core::services::recovery::{Recovery, Slot};
use styk_design::Theme;
use styk_design::widgets::testing::Driver;
use styk_ui::message::{self, Message};
use styk_ui::{overlays, recovery};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SCRIPT: &str = include_str!("recovery.auto");
const WINDOW: Size = Size::new(640.0, 420.0);

/// A private store root, emptied of the files this test wrote when it ends.
struct Root(std::path::PathBuf);
impl Root {
    fn new(label: &str) -> Root {
        static SERIAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("styk-recovery-views-{label}-{}-{}", std::process::id(), SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&path).unwrap();
        Root(path)
    }
    /// The copies' data files in the store.
    fn copies(&self) -> usize {
        std::fs::read_dir(&self.0).unwrap().filter_map(Result::ok).filter(|entry| entry.file_name().to_string_lossy().ends_with(".styk")).count()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        if let Ok(entries) = std::fs::read_dir(&self.0) {
            for entry in entries.filter_map(Result::ok) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// Writes a copy of the startup project, as an earlier run's autosave would have left it.
fn seed(store: &styk_platform::recovery::LocalRecovery, name: &str) {
    let cancel = Cancel::new();
    pollster::block_on(async {
        let lease = store.create(&cancel).await.unwrap();
        lease.write(None, STARTUP, name, &cancel).await.unwrap();
    });
}

struct App {
    core: Core,
    driver: Option<Driver<'static, Message>>,
    now: u64,
}

impl App {
    fn new(root: &Root, names: &[&str]) -> App {
        let store = styk_platform::recovery::LocalRecovery::new(root.0.clone());
        for name in names {
            seed(&store, name);
            // The copies are told apart by the second they were saved in.
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let mut core = styk_core::testing::core_with_document(STARTUP, "Front.styk", Arc::new(styk_platform::spawn::ThreadSpawner)).unwrap();
        styk_core::testing::attach_recovery(&mut core, Arc::new(store)).unwrap();
        let mut app = App { core, driver: None, now: 0 };
        app.rebuild();
        app.walk();
        app
    }

    fn view(&self) -> Element<'static, Message> {
        let palette = Theme::Light.palette();
        let host: &'static styk_core::overlay::host::Host = Box::leak(Box::new(self.core.overlays().clone()));
        let owned = recovery::owned(&self.core, palette, WINDOW);
        let page = container(iced::widget::Space::new()).width(Length::Fill).height(Length::Fill);
        stack![page.boxed(), overlays::layer_of(host, self.core.focus().focus_visible(), palette, 0.0, None, owned)].boxed()
    }

    fn rebuild(&mut self) {
        let view = self.view();
        self.driver = Some(match self.driver.take() {
            Some(driver) => driver.rebuild(view),
            None => Driver::new(view, WINDOW, &styk_design::fonts::ALL),
        });
        self.driver().redraw();
    }

    fn driver(&mut self) -> &mut Driver<'static, Message> {
        self.driver.as_mut().expect("the driver exists")
    }

    /// The core's focus state follows the toolkit's walk, as the application forwards it.
    fn walk(&mut self) {
        let snapshot = self.driver().snapshot();
        self.run(Message::Snapshot(snapshot));
    }

    /// What `TopBand::update` does with a message of the editor: the core decides, the tasks run on the rebuilt tree.
    fn run(&mut self, message: Message) {
        let task = message::update_at(&mut self.core, message, self.now);
        self.rebuild();
        let _ = self.driver().run(task);
        self.rebuild();
    }

    /// Delivers what the widgets published.
    fn deliver(&mut self) {
        for _ in 0..16 {
            let messages = self.driver().messages();
            if messages.is_empty() {
                self.walk();
                return;
            }
            for message in messages {
                self.run(message);
            }
        }
        panic!("the widgets kept publishing");
    }

    /// What the frame loop does: the documents host's finished work reaches the core and its views are brought up to date.
    fn frame(&mut self, done: impl Fn(&Core) -> bool) {
        let effects = styk_core::testing::poll_until(&mut self.core, done).unwrap();
        self.rebuild();
        let _ = self.driver().run(message::run(effects));
        self.rebuild();
        self.walk();
    }

    fn centre(&mut self, id: FocusId) -> Point {
        let bounds = self.driver().snapshot().bounds_of(id).unwrap_or_else(|| panic!("{id:?} is in the tree"));
        Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0)
    }

    /// A press and a release at the centre of a control, as a hand does it. What the widgets published is returned before
    /// it is delivered.
    fn click_messages(&mut self, id: FocusId) -> Vec<Message> {
        let at = self.centre(id);
        self.driver().point_at(at);
        self.driver().events(&[Event::Mouse(mouse::Event::CursorMoved { position: at })]);
        self.driver().events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
        self.driver().events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
        self.driver().messages()
    }

    /// The messages of a click that are commands for the core (the pointer's own reports for the overlays go with them).
    fn commands(sent: &[Message]) -> Vec<Message> {
        sent.iter().filter(|message| matches!(message, Message::Command(Command::Recovery(_)))).cloned().collect()
    }

    fn click(&mut self, id: FocusId) {
        for message in self.click_messages(id) {
            self.run(message);
        }
        self.deliver();
    }

    /// The offer's button for this event.
    fn offer_button(&self, event: Ask) -> FocusId {
        let message = self.core.overlays().messages().current().expect("the offer shows");
        let index = message.actions.iter().position(|action| action.command == Do::Recovery(event.clone())).unwrap_or_else(|| panic!("the offer has {event:?}"));
        message_button_id(message.id, index)
    }

    /// Opens the select's list and presses the row of the `n`th copy (from 1).
    fn pick(&mut self, n: usize) {
        self.click(ids::SELECT);
        let menu = self.core.overlays().menus().first().expect("the select's list opened").id();
        self.click(row_id(menu, n - 1));
        assert!(self.core.overlays().menus().is_empty(), "choosing closed the list");
    }

    fn recovery_view(&self) -> styk_core::documents::recovery::View {
        self.core.documents.recovery_view().expect("recovery is attached").clone()
    }
}

#[test]
fn the_interaction_script_runs_through_the_widgets() {
    let root = Root::new("script");
    let mut app = App::new(&root, &["Rooftop fight", "Chase"]);
    let script = Script::parse(SCRIPT).unwrap();
    for (line, step) in script.steps {
        match step {
            Step::Recovery(RecoveryStep::Manage) => {
                let id = app.offer_button(Ask::Manage);
                app.click(id);
            }
            Step::Recovery(RecoveryStep::NotNow) => {
                let id = app.offer_button(Ask::NotNow);
                app.click(id);
            }
            Step::Recovery(RecoveryStep::OfferRestore) => {
                let id = app.offer_button(Ask::Restore);
                app.click(id);
            }
            Step::Recovery(RecoveryStep::Pick(n)) => app.pick(n),
            Step::Recovery(RecoveryStep::Restore) => app.click(ids::RESTORE),
            Step::Recovery(RecoveryStep::Discard) => app.click(ids::DISCARD),
            Step::Recovery(RecoveryStep::Cancel) => app.click(ids::CANCEL),
            Step::Recovery(RecoveryStep::Settle) => app.frame(|core| core.documents.recovery_view().is_some_and(|view| !view.busy)),
            Step::Expect(Expect::Recovery(expect)) => {
                let view = app.recovery_view();
                match expect {
                    RecoveryExpect::Offer(shown) => assert_eq!(app.core.overlays().messages().current().is_some_and(|message| message.key == "recovery"), shown, "line {line}: the offer"),
                    RecoveryExpect::Chooser(open) => assert_eq!(app.core.recovery().chooser_overlay().is_some(), open, "line {line}: the chooser"),
                    RecoveryExpect::Prompt(open) => assert_eq!(app.core.recovery().closing().is_some(), open, "line {line}: the close prompt"),
                    RecoveryExpect::Copies(count) => assert_eq!(view.copies.len(), count, "line {line}: the copies"),
                    RecoveryExpect::Selected(n) => assert_eq!(view.copies.iter().position(|copy| Some(&copy.slot) == view.selected.as_ref()), Some(n - 1), "line {line}: the selected copy"),
                    RecoveryExpect::Error(shown) => assert_eq!(view.error.is_some(), shown, "line {line}: the error"),
                    other => panic!("line {line}: the runner has no {other:?}"),
                }
            }
            other => panic!("line {line}: the recovery runner has no {other:?}"),
        }
    }
    assert_eq!(app.core.documents.tabs().len(), 2, "the restored copy is a project of its own beside the first");
}

/// Restore and Discard in the mounted chooser reach `Core::dispatch` as the recovery commands and the documents host does what
/// each asks: a discard removes the file, a restore opens the selected copy as an edited project.
#[test]
fn restore_and_discard_in_the_mounted_chooser_reach_the_core() {
    let root = Root::new("buttons");
    let mut app = App::new(&root, &["Rooftop fight", "Chase", "Dock"]);
    assert_eq!(root.copies(), 3);
    let manage = app.offer_button(Ask::Manage);
    app.click(manage);
    assert!(app.core.recovery().chooser_overlay().is_some(), "Manage copies opened the chooser");

    let selected = app.recovery_view().selected.expect("a copy is selected");
    let sent = app.click_messages(ids::DISCARD);
    assert_eq!(App::commands(&sent), [Message::Command(Command::Recovery(Ask::DiscardChosen))], "the button sends the core's discard command");
    for message in sent {
        app.run(message);
    }
    assert!(app.recovery_view().busy, "the host is working: Discard and Restore are busy");
    app.frame(|core| core.documents.recovery_view().is_some_and(|view| !view.busy));
    assert_eq!(app.recovery_view().copies.len(), 2);
    assert!(app.recovery_view().copies.iter().all(|copy| copy.slot != selected), "the discarded copy left the list");
    assert_eq!(root.copies(), 2, "its file was removed");

    let tabs = app.core.documents.tabs().len();
    let target: Slot = app.recovery_view().selected.expect("the next copy is selected");
    let sent = app.click_messages(ids::RESTORE);
    assert_eq!(App::commands(&sent), [Message::Command(Command::Recovery(Ask::RestoreChosen))], "the button sends the core's restore command");
    for message in sent {
        app.run(message);
    }
    app.frame(|core| core.recovery().chooser_overlay().is_none());
    assert_eq!(app.core.documents.tabs().len(), tabs + 1);
    assert!(app.core.documents.active().unwrap().dirty(), "it opens as an edited project");
    assert!(app.recovery_view().copies.iter().all(|copy| copy.slot != target), "the restored copy left the list");
}

/// The close prompt is mounted by the window and its buttons answer the host: Cancel keeps the project.
#[test]
fn the_close_prompt_is_mounted_and_its_buttons_answer_the_host() {
    let root = Root::new("prompt");
    let mut app = App::new(&root, &[]);
    let id = app.core.documents.active().unwrap().id();
    styk_core::testing::call(&mut app.core, "setFPS", "[30]").unwrap();
    app.core.documents.dispatch(styk_core::documents::Request::Close(id)).map_err(|(error, _)| error).unwrap();
    app.frame(|core| core.recovery().closing().is_some());
    let sent = app.click_messages(ids::KEEP_EDITING);
    assert_eq!(App::commands(&sent), [Message::Command(Command::Recovery(Ask::Respond(Choice::Cancel)))]);
    for message in sent {
        app.run(message);
    }
    assert!(app.core.recovery().closing().is_none(), "Cancel closed the prompt");
    assert_eq!(app.core.documents.tabs().len(), 1, "the project stays open");
}
