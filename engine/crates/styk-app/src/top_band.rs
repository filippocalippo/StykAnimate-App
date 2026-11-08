//! The top band's wiring: the open projects, the shell core, the events the window sends it and the automation mode.
//!
//! Nothing here decides what the band does (`styk_core::shell` does) or how it looks (`styk_ui::shell`). This is the
//! one place that moves messages between them: it turns the window's keys and pointer into `shell::Event`s, runs the
//! effects the shell answers with (the focus moves; the workspace switch's asks are answered by the stand-in below
//! until the drawing and Build sessions exist), opens the projects the command line names, and runs `--automation`
//! scripts, step by step, on the frames the window draws.
//!
//! Stand-ins that go when their owners land, each marked where it is: the file open (K-doc's files service and engine
//! host), the workspace sessions (the Draw and Build chunks), and the commands the band's buttons ask for (K-cmd).

use styk_core::commands::CommandId;
use iced::advanced::widget::operate;
use iced::keyboard::{self, Key, key::Named};
use iced::{Event, Size, Subscription, Task, Widget as _, event, mouse, window};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use styk_core::automation::{self, Expect, MAX_SCRIPT_BYTES, Script, Step, Target};
use styk_core::documents::{DocumentId, Documents, Effect as Opened, HostError, HostOptions, Request as Ask};
use styk_core::focus::FocusId;
use styk_core::shell::band::{Fold, Frame};
use styk_core::shell::session::{ExportLook, Session};
use styk_core::shell::strip::TabState;
use styk_core::shell::switcher::{self, BoardKey};
use styk_core::shell::workspace::{self, Workspace};
use styk_core::shell::{self, Effect, ids};
use styk_design::widgets::focus;
use styk_design::{Theme, warm_up};
use styk_core::engine::{Budgets, Engine, Value, json};
use styk_services::Spawner;
use styk_services::clock::{Clock, FixedClock};
use styk_services::files::FileTarget;
use styk_services::shell::Rect;
use styk_services::shell::chrome::MaxButtonState;
use styk_ui::screens::Screen;
use styk_ui::shell as view;

/// Frames to let pass after a step so the window shows its result before the next step (and before a capture).
const SETTLE_FRAMES: u32 = 3;

#[derive(Clone, Debug)]
pub enum Message {
    Editor(styk_ui::message::Message),
    /// A message of the band's views.
    Ui(view::Message),
    /// A key, a button or the window losing focus; the flag says no widget used the event.
    Raw(Event, bool),
    /// The pointer moved to this window position while a tab is pressed.
    Cursor(f32, f32),
    /// The primary button came up while a tab is pressed.
    Released,
    /// The focus state of the tree after an update.
    Snapshot(focus::Snapshot),
    /// A frame was drawn: time passes for the strip and the automation.
    Frame,
    /// The documents host's workers have something (their wake), or the recovery lane's deadline is due: take it.
    Documents,
}

/// What the wiring asks of the window.
#[derive(Debug)]
pub enum Request {
    /// Minimize.
    Minimize,
    /// Close the window.
    Close,
    /// Resize to this logical size.
    Resize(Size),
    /// Capture the window into this file; `captured` follows.
    Capture(PathBuf),
    /// Switch the theme.
    Theme(Theme),
    /// The script ended: `None` when every expectation held.
    Finished(Option<String>),
    /// Every project is answered for and the recovery lane is done: the program may end.
    QuitReady,
    SessionCheckpointFinished,
}

/// A script being run.
struct Run {
    steps: Vec<(usize, Step)>,
    next: usize,
    settle: u32,
    base: PathBuf,
    failures: Vec<String>,
    capturing: bool,
}

pub struct TopBand {
    /// The open projects.
    pub core: styk_core::app::Core,
    /// The core's layout persistence service, ready for the docking view's host.
    #[expect(dead_code, reason = "The docking view host is a separate chunk; retain its injected service.")]
    pub layouts: styk_core::layout::LayoutStore,
    /// The shell.
    pub shell: shell::Shell,
    /// The projects in the order they were opened, which is how scripts number them.
    opened: Vec<DocumentId>,
    /// The opens asked for and not yet started, and whether the host is working on one: the host runs one at a time.
    requests: VecDeque<Ask>,
    busy: bool,
    /// The one application clock: every deadline of the band and the automation's work read it.
    clock: Arc<dyn Clock>,
    /// The same clock when it is the fixed one, so a script can advance it.
    fixed: Option<FixedClock>,
    run: Option<Run>,
    /// The band's words are measured: the layout is the real one.
    measured: bool,
    /// A band screen of the catalogue shown in place of the open projects (`--screen band`).
    screen: Option<Screen>,
}

/// What the stand-in for the workspace sessions answers.
enum Answer {
    Report(workspace::Report),
    Session(Session),
}

/// The startup document the host is given (see `TopBand::new`).
const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

/// The engine's clock for budgeted reads, in milliseconds: the application clock as the band last read it (`TopBand::now`),
/// so the engine runs on the one clock too. It is only ever stored by the interface thread.
static ENGINE_NOW_BITS: AtomicU64 = AtomicU64::new(0);

fn engine_clock() -> f64 {
    f64::from_bits(ENGINE_NOW_BITS.load(Ordering::Relaxed))
}

/// Reads a script through its size limit (`diagnostics::read_file` reads one byte past it at most) and decodes it.
fn read_script(path: &Path) -> Result<String, String> {
    let bytes = styk_platform::diagnostics::read_file(path, Some(MAX_SCRIPT_BYTES))?;
    String::from_utf8(bytes).map_err(|_| format!("{}: the script is not UTF-8 text", path.display()))
}

fn fold_name(fold: Fold) -> &'static str {
    match fold {
        Fold::Tight => "tight",
        Fold::Name => "name",
        Fold::TestRig => "testrig",
        Fold::Save => "save",
        Fold::WinCtl => "winctl",
        Fold::Export2 => "export2",
        Fold::SwitchTight => "switchtight",
        Fold::Icons => "icons",
        Fold::Dot => "dot",
        Fold::Redo => "redo",
        Fold::Export2Out => "export2out",
        Fold::Primary => "primary",
    }
}

fn workspace_named(name: &str) -> Workspace {
    match name {
        "draw" => Workspace::Draw,
        "build" => Workspace::Build,
        _ => Workspace::Animate,
    }
}

impl TopBand {
    /// The band over a new, empty set of projects, with K-doc's document host attached: its worker, the local files and the
    /// one application clock.
    /// `notify` is the window's wake for the documents host's workers (it may be called from any thread); `recovery` is the
    /// store where the lane keeps this window's copies and lists the ones an earlier run left (`None`:
    /// no recovery, as in a run that must not touch the person's folders).
    pub fn new(window_size: Size, clock: Arc<dyn Clock>, fixed: Option<FixedClock>, spawner: Arc<dyn Spawner>, notify: Arc<dyn Fn() + Send + Sync>, recovery: Option<Arc<dyn styk_services::recovery::Recovery>>) -> Result<TopBand, String> {
        let window = shell::Window { width: window_size.width, height: window_size.height, ui_scale: 1.0, controls: !cfg!(target_os = "macos") };
        let unmeasured = shell::band::Labels { animate: 0.0, draw: 0.0, build: 0.0, export: 0.0, cancel: 0.0, test_rig: 0.0, done: 0.0 };
        let mut documents = Documents::new();
        let layouts = styk_core::layout::LayoutStore::new(Arc::new(
            styk_platform::storage::LocalStorage::for_user(spawner.as_ref())
                .map_err(|error| format!("the layout store did not start: {error}"))?,
        ));
        // The application's startup document, for New and for closing the last tab. Stand-in: the engine's startup fixture,
        // until the native startup document (Blue on the landscape canvas) has an owner. The band does not send New yet.
        let startup = json::parse(STARTUP).map_err(|error| format!("the startup document: {error:?}"))?;
        documents
            .attach_host(HostOptions {
                engine: Engine::new(engine_clock, Budgets::for_device(None)),
                spawner,
                files: Arc::new(styk_platform::files::LocalFiles),
                startup,
                clock: engine_clock,
                // The workers wake the window, which polls the host (`Message::Documents`).
                notify: notify.clone(),
            })
            .map_err(|error| format!("the document host did not start: {error}"))?;
        if let Some(store) = recovery {
            documents.attach_recovery(store, clock.clone()).map_err(|error| format!("recovery did not start: {error}"))?;
            // The first listing is queued by the first poll: ask for it.
            notify();
        }
        Ok(TopBand { core: styk_core::app::Core::new(documents), layouts, shell: shell::Shell::new(window, view::metrics(), unmeasured), opened: Vec::new(), requests: VecDeque::new(), busy: false, clock, fixed, run: None, measured: false, screen: None })
    }

    /// Starts the script the command line named.
    pub fn run_script(&mut self, path: &Path) -> Result<(), String> {
        let text = read_script(path)?;
        let script = Script::parse(&text).map_err(|error| format!("{}: {error}", path.display()))?;
        let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
        self.run = Some(Run { steps: script.steps, next: 0, settle: SETTLE_FRAMES, base, failures: Vec::new(), capturing: false });
        Ok(())
    }

    /// The projects the command line names, opened in order by the document host.
    pub fn open_all(&mut self, files: &[PathBuf]) {
        for file in files {
            self.requests.push_back(Ask::OpenFile(FileTarget::new(file.clone())));
        }
    }

    /// Nothing is opening, so what the window shows is complete.
    pub fn idle(&self) -> bool {
        self.requests.is_empty() && !self.busy
    }

    /// Shows a band screen of the catalogue (`--screen band`) instead of the open projects.
    pub fn show_screen(&mut self, screen: Option<Screen>) {
        self.screen = screen;
    }

    /// The fonts are ready: measure the band's words.
    pub fn fonts_ready(&mut self) {
        if let Some(ready) = warm_up::proof() {
            let labels = view::measure_labels(ready, self.core.presentation());
            match self.screen {
                Some(screen) => {
                    let window = *self.shell.window();
                    self.shell = styk_ui::screens::band_shell(screen, (window.width as u32, window.height as u32), labels);
                }
                None => drop(self.dispatch(shell::Event::Labels(labels))),
            }
            self.measured = true;
        }
    }

    /// The window's size changed.
    pub fn resized(&mut self, size: Size) {
        let controls = self.shell.window().controls;
        drop(self.dispatch(shell::Event::Resized(shell::Window { width: size.width, height: size.height, ui_scale: 1.0, controls })));
    }

    /// The places in the band that keep the pointer, in physical pixels (`scale` physical pixels per logical one).
    pub fn no_drag(&self, scale: f32) -> Vec<Rect> {
        let physical = |value: f32| (value * scale).round() as i32;
        self.shell.layout().no_drag().into_iter().map(|f| Rect::new(physical(f.x), physical(f.y), physical(f.width), physical(f.height))).collect()
    }

    /// Whether the band folded its window controls to the narrow width.
    pub fn controls_folded(&self) -> bool {
        self.shell.layout().folds.contains(&Fold::WinCtl)
    }

    /// The band's height in logical pixels.
    pub fn height(&self) -> f32 {
        self.shell.layout().height
    }

    pub fn view<'a>(&'a self, theme: Theme, ready: warm_up::Ready, maximize: MaxButtonState, content: iced::Element<'a, view::Message>) -> iced::Element<'a, Message> {
        view::window(view::Params { shell: &self.shell, theme, ready, presentation: self.core.presentation(), maximize }, content).map(Message::Ui).boxed()
    }

    /// The overlay layer over the band: menus, lists, the stage's message and a tooltip, drawn from the Core-owned host. The band
    /// is the only content the window shows until the docking view lands; the layer is mounted and answers regardless, and every
    /// message it sends reaches `Core::dispatch` through `update_at`. A panel or button that opens a menu shows it by sending
    /// `Command::Overlay { event: OpenMenu .. }`; none does yet, so today only a message pushed with `ShowMessage` (and the
    /// Inspector's selects, once docked) show something.
    pub fn overlay_layer(&self, theme: Theme) -> iced::Element<'_, Message> {
        let window = self.shell.window();
        let owned = styk_ui::recovery::owned(&self.core, theme.palette(), Size::new(window.width, window.height));
        styk_ui::overlays::layer(&self.core, theme.palette(), self.height() + 6.0, None, owned).map(Message::Editor).boxed()
    }

    /// The runtime maps the core's injected deadline onto iced's one scheduled redraw.
    pub fn overlay_wake(&self) -> iced::Element<'_, Message> {
        crate::overlay_wake::element(self.core.overlay_deadline().filter(|_| self.fixed.is_none()), self.clock.clone(), |now| {
            Message::Editor(styk_ui::message::Message::Command(styk_core::commands::Command::Overlay {
                event: styk_core::overlay::host::Event::Tick, now,
            }))
        })
    }

    /// The recovery lane's deadline (an autosave, a resting project's copy, a retry) mapped onto the same scheduled redraw: when it
    /// is due the window polls the documents host. Nothing is scheduled while the lane has no deadline, and a run on the fixed clock
    /// is advanced by its script, which polls.
    pub fn recovery_wake(&self) -> iced::Element<'_, Message> {
        let deadline = self.core.documents.recovery_deadline().map(|due| due.as_millis().min(u128::from(u64::MAX)) as u64);
        crate::overlay_wake::element(deadline.filter(|_| self.fixed.is_none()), self.clock.clone(), |_| Message::Documents)
    }

    /// The window was asked to close. The documents host answers: nothing to ask (the program may end), or a confirmation for the
    /// projects with unsaved work (the close prompt, with its recovery copy's retry) and `Request::QuitReady` once every project is
    /// answered for and the recovery lane has finished.
    pub fn ask_to_quit(&mut self) -> Task<Message> {
        styk_ui::message::run(self.core.request_quit(false)).map(Message::Editor)
    }

    pub fn session_end(&mut self) -> Task<Message> {
        styk_ui::message::run(self.core.request_quit(true)).map(Message::Editor)
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![event::listen_with(|event, status, _| match &event {
            Event::Keyboard(keyboard::Event::KeyPressed { .. } | keyboard::Event::KeyReleased { .. }) | Event::Mouse(mouse::Event::ButtonPressed(_) | mouse::Event::ButtonReleased(_)) | Event::Window(window::Event::Unfocused) => Some(Message::Raw(event.clone(), status == event::Status::Ignored)),
            _ => None,
        })];
        if self.shell.tracking() {
            subscriptions.push(event::listen_with(|event, _, _| match event {
                Event::Mouse(mouse::Event::CursorMoved { position }) => Some(Message::Cursor(position.x, position.y)),
                Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => Some(Message::Released),
                _ => None,
            }));
        }
        if self.run.is_some() || self.shell.next_deadline().is_some() || !self.idle() {
            subscriptions.push(window::frames().map(|_| Message::Frame));
        }
        Subscription::batch(subscriptions)
    }

    /// The application clock in milliseconds; the engine's clock follows it.
    fn now(&self) -> u64 {
        let millis = self.clock.now().as_millis() as u64;
        ENGINE_NOW_BITS.store((millis as f64).to_bits(), Ordering::Relaxed);
        millis
    }

    fn snapshot() -> Task<Message> {
        operate(focus::snapshot()).map(Message::Snapshot)
    }

    fn focus(id: FocusId) -> Task<Message> {
        operate(focus::focus(id)).discard().chain(TopBand::snapshot())
    }

    /// Gives the shell an event and runs what it answers. The workspace switch's asks are answered here by a stand-in
    /// for the drawing and Build sessions: they succeed at once, and Build brings its session's buttons with it. The
    /// commands the band's buttons ask for (Save, Export, Close, Rename, New, Done...) are K-cmd's and K-doc's: they are
    /// dropped here.
    fn dispatch(&mut self, event: shell::Event) -> Task<Message> {
        let mut tasks = Vec::new();
        let mut queue = vec![event];
        while let Some(event) = queue.pop() {
            for effect in self.shell.handle(&mut self.core.documents, event) {
                match effect {
                    Effect::Workspace(ask) => queue.extend(Self::sessions(ask).into_iter().map(|answer| match answer {
                        Answer::Report(report) => shell::Event::Report(report),
                        Answer::Session(session) => shell::Event::Session(session),
                    })),
                    Effect::FocusTab(id) => tasks.push(TopBand::focus(ids::tab(id))),
                    Effect::Activated(_) | Effect::Moved(..) | Effect::Edited | Effect::Command(_)
                    | Effect::DocumentCommand { .. } | Effect::FinishBuild | Effect::Refused(_) => {}
                }
            }
        }
        Task::batch(tasks)
    }

    /// The stand-in for the drawing and Build sessions: what they report when asked.
    fn sessions(ask: workspace::Effect) -> Vec<Answer> {
        use workspace::{Effect as Ask, Report};
        match ask {
            Ask::EnterDrawing => vec![Answer::Report(Report::DrawingEntered)],
            Ask::ExitDrawing => vec![Answer::Report(Report::DrawingExited(true))],
            Ask::EnterBuild => vec![Answer::Report(Report::BuildEntered), Answer::Session(Session::Build)],
            Ask::RequestBuildExit => vec![Answer::Report(Report::BuildActive(false)), Answer::Session(Session::None)],
        }
    }

    pub fn update(&mut self, message: Message) -> (Vec<Request>, Task<Message>) {
        // The tree's focus state is read after anything that can change the tree.
        let reads_focus = !matches!(message, Message::Cursor(..) | Message::Frame | Message::Snapshot(_) | Message::Editor(_));
        let (requests, task) = match message {
            Message::Editor(styk_ui::message::Message::PollDocuments) => (Vec::new(), self.pump()),
            Message::Editor(styk_ui::message::Message::QuitReady) => (vec![Request::QuitReady], Task::none()),
            Message::Editor(styk_ui::message::Message::SessionCheckpointFinished) => (vec![Request::SessionCheckpointFinished], Task::none()),
            Message::Editor(message) => {
                let now = self.now();
                // The focus tasks the core asks for run on the tree this message built, then the walk reads it back.
                (Vec::new(), styk_ui::message::update_at(&mut self.core, message, now).map(Message::Editor).chain(TopBand::snapshot()))
            }
            Message::Ui(view::Message::Shell(event)) => (Vec::new(), self.dispatch(event)),
            Message::Ui(view::Message::Minimize) => (vec![Request::Minimize], Task::none()),
            Message::Ui(view::Message::CloseWindow) => (vec![Request::Close], Task::none()),
            Message::Raw(event, ignored) => (Vec::new(), self.raw(&event, ignored)),
            Message::Cursor(x, y) => (Vec::new(), self.dispatch(shell::Event::PointerMoved(x, y))),
            Message::Released => (Vec::new(), self.dispatch(shell::Event::PointerReleased)),
            Message::Snapshot(snapshot) => {
                // The core's own focus state follows the same walk: the host's focus decisions (a menu's rows, a dialog's scope, a
                // message's buttons) read it.
                let now = self.now();
                let overlays = styk_ui::message::update_at(&mut self.core, styk_ui::message::Message::Snapshot(snapshot.clone()), now).map(Message::Editor);
                let synced = focus::sync(&mut self.shell.focus, &snapshot);
                let task = if synced.unfocus.is_some() { operate(focus::unfocus()).discard().chain(TopBand::snapshot()) } else { Task::none() };
                (Vec::new(), Task::batch([task, overlays]))
            }
            Message::Frame => self.frame(),
            Message::Documents => (Vec::new(), self.pump()),
        };
        let task = if reads_focus { Task::batch([task, TopBand::snapshot()]) } else { task };
        (requests, task)
    }

    fn fail(&mut self, message: String) {
        match &mut self.run {
            Some(run) => run.failures.push(message),
            None => eprintln!("{message}"),
        }
    }

    /// A key, a button or the window losing focus, as the window reports it.
    fn raw(&mut self, event: &Event, ignored: bool) -> Task<Message> {
        use shell::Event as E;
        // The overlays take the inputs that are theirs first (a dialog's keys, a button's release).
        let now = self.now();
        if let Some(task) = styk_ui::message::raw_at(&mut self.core, event, ignored, now) {
            return task.map(Message::Editor).chain(TopBand::snapshot());
        }
        match event {
            Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                if self.shell.board_open() {
                    // While the board shows, every key belongs to it: Tab and the arrows step with or without Control.
                    let board_key = match key.as_ref() {
                        Key::Named(Named::Tab) => Some(BoardKey::Tab),
                        Key::Named(Named::ArrowRight | Named::ArrowDown) => Some(BoardKey::Forward),
                        Key::Named(Named::ArrowLeft | Named::ArrowUp) => Some(BoardKey::Back),
                        Key::Named(Named::Enter | Named::Space) => Some(BoardKey::Commit),
                        Key::Named(Named::Escape) => Some(BoardKey::Escape),
                        _ => None,
                    };
                    return match board_key.and_then(|key| switcher::board_key(key, modifiers.shift())) {
                        Some(key) => self.dispatch(E::SwitcherKey(key)),
                        None => Task::none(),
                    };
                }
                match key.as_ref() {
                    Key::Named(Named::Tab) if modifiers.control() => self.dispatch(E::CtrlTab { backwards: modifiers.shift(), held: true }),
                    Key::Named(Named::PageDown) if modifiers.control() => self.dispatch(E::Neighbour(1)),
                    Key::Named(Named::PageUp) if modifiers.control() => self.dispatch(E::Neighbour(-1)),
                    Key::Named(Named::Escape) if self.shell.tracking() => self.dispatch(E::DragCancelled),
                    Key::Named(Named::Escape) if self.shell.menu().is_some() => self.dispatch(E::CloseMenu),
                    _ if ignored => focus::navigate(&mut self.shell.focus, event).map_or_else(Task::none, TopBand::focus),
                    _ => Task::none(),
                }
            }
            Event::Keyboard(keyboard::Event::KeyReleased { key: Key::Named(Named::Control), .. }) if self.shell.board_open() => self.dispatch(E::ModifierReleased),
            Event::Mouse(mouse::Event::ButtonPressed(_)) => {
                self.shell.focus.pointer_pressed();
                Task::none()
            }
            Event::Window(window::Event::Unfocused) => self.dispatch(E::Blurred),
            _ => Task::none(),
        }
    }

    /// A frame was drawn.
    /// Starts the next queued open when the host is free, and takes what the host has finished (`poll`, nonblocking). A
    /// project the tabs refuse (the thirteenth) is the host's to dispose of on its worker, and comes back as a failure.
    fn pump(&mut self) -> Task<Message> {
        let mut tasks = Vec::new();
        if let Some(effect) = self.core.documents.poll() {
            // One completion per update. A real transition can queue the next stage without
            // starting a worker; give it one poll, then follow notifications/deadlines.
            if !matches!(effect, Opened::None) { tasks.push(Task::done(Message::Documents)); }
            // A close that needs an answer, the recovery lane's events: the core's views take them.
            tasks.push(styk_ui::message::run(self.core.document_effect(&effect)).map(Message::Editor));
            match effect {
                Opened::Opened(id) => {
                    self.busy = false;
                    self.opened.push(id);
                    tasks.push(self.dispatch(shell::Event::Opened(id)));
                }
                Opened::Failed { error, .. } => {
                    self.busy = false;
                    self.fail(error.to_string());
                }
                Opened::Stale(_) | Opened::Cancelled(_) => self.busy = false,
                _ => {}
            }
        }
        tasks.push(styk_ui::message::run(self.core.documents_progress()).map(Message::Editor));
        if !self.busy
            && let Some(request) = self.requests.pop_front()
        {
            match self.core.documents.dispatch(request) {
                Ok(Opened::Started(_)) => self.busy = true,
                Ok(_) => {}
                // The host is not ready for another request yet: ask again next frame.
                Err((HostError::Documents(styk_core::documents::DocumentsError::Busy), request)) => self.requests.push_front(request),
                Err((error, _)) => self.fail(error.to_string()),
            }
        }
        self.shell.sync(&self.core.documents);
        Task::batch(tasks)
    }

    fn frame(&mut self) -> (Vec<Request>, Task<Message>) {
        let now = self.now();
        let pumped = self.pump();
        let tick = Task::batch([pumped, self.dispatch(shell::Event::Tick(now))]);
        let (requests, step) = self.step();
        (requests, Task::batch([tick, step]))
    }

    /// The window was captured for a step.
    pub fn captured(&mut self, result: Result<(), String>) {
        if let Some(run) = &mut self.run {
            run.capturing = false;
            run.settle = 1;
            if let Err(error) = result {
                run.failures.push(error);
            }
        }
    }

    /// Runs the next step of the script when the window has settled and the band is measured.
    fn step(&mut self) -> (Vec<Request>, Task<Message>) {
        let none = (Vec::new(), Task::none());
        let waiting = !self.measured || !self.idle();
        let Some(run) = &mut self.run else { return none };
        if run.capturing || waiting {
            return none;
        }
        if run.settle > 0 {
            run.settle -= 1;
            return none;
        }
        let Some((line, step)) = run.steps.get(run.next).cloned() else {
            let failures = std::mem::take(&mut run.failures);
            self.run = None;
            return (vec![Request::Finished(if failures.is_empty() { None } else { Some(failures.join("\n")) })], Task::none());
        };
        run.next += 1;
        run.settle = SETTLE_FRAMES;
        self.execute(line, step)
    }

    fn id_of(&self, number: usize) -> Result<DocumentId, String> {
        self.opened.get(number - 1).copied().ok_or_else(|| format!("tab {number} was never opened"))
    }

    fn tab_frame(&self, id: DocumentId) -> Result<Frame, String> {
        self.shell.layout().tabs().find(|(tab, _, _)| *tab == id).map(|(_, _, frame)| frame).ok_or_else(|| "that tab is not in the band".to_string())
    }

    fn execute(&mut self, line: usize, step: Step) -> (Vec<Request>, Task<Message>) {
        use shell::Event as E;
        let base = self.run.as_ref().map(|run| run.base.clone()).unwrap_or_default();
        let resolved = |path: PathBuf| if path.is_absolute() { path } else { base.join(path) };
        let outcome: Result<(Vec<Request>, Task<Message>), String> = (|| {
            Ok(match step {
                Step::Open(path) => {
                    self.requests.push_back(Ask::OpenFile(FileTarget::new(resolved(path))));
                    (Vec::new(), Task::none())
                }
                Step::Wait(frames) => {
                    if let Some(run) = &mut self.run {
                        run.settle = frames;
                    }
                    (Vec::new(), Task::none())
                }
                Step::Resize(width, height) => (vec![Request::Resize(Size::new(width as f32, height as f32))], Task::none()),
                Step::Theme(name) => (vec![Request::Theme(if name == "dark" { Theme::Dark } else { Theme::Light })], Task::none()),
                Step::Session(name) => {
                    let session = match name.as_str() {
                        "build" => Session::Build,
                        "movieclip" => Session::Movieclip,
                        "camera" => Session::Camera,
                        _ => Session::None,
                    };
                    (Vec::new(), self.dispatch(E::Session(session)))
                }
                Step::Click(target) => (Vec::new(), self.click(target)?),
                Step::Key(key) => (Vec::new(), self.key(key)),
                Step::DragTab { from, to, after } => {
                    let (from, to) = (self.id_of(from)?, self.id_of(to)?);
                    let (a, b) = (self.tab_frame(from)?, self.tab_frame(to)?);
                    let x0 = a.x + a.width / 2.0;
                    let x1 = if after { b.right() - 3.0 } else { b.x + 3.0 };
                    let y = a.y + a.height / 2.0;
                    let tasks: Vec<Task<Message>> = [E::TabPressed(from), E::PointerMoved(x0, y), E::PointerMoved(x1, y), E::PointerReleased].into_iter().map(|event| self.dispatch(event)).collect();
                    (Vec::new(), Task::batch(tasks))
                }
                Step::Edit(fps) => {
                    let id = self.core.documents.active().map(|document| document.id()).ok_or("no project is open")?;
                    let answer = self.core.documents.call(id, "setFPS", &[Value::Num(f64::from(fps))], &Value::Null).map_err(|error| error.to_string())?;
                    answer.result.map_err(|error| error.to_string())?;
                    self.shell.sync(&self.core.documents);
                    (Vec::new(), Task::none())
                }
                Step::Advance(nanos) => {
                    let Some(fixed) = &self.fixed else { return Err("advance needs --clock fixed: the system clock cannot be moved".to_string()) };
                    fixed.advance(std::time::Duration::from_nanos(nanos));
                    // The strip's deadlines follow the clock at once, not at the next frame.
                    let now = self.now();
                    (Vec::new(), Task::batch([self.dispatch(E::Tick(now)), styk_ui::message::update_at(&mut self.core,
                        styk_ui::message::Message::Command(styk_core::commands::Command::Overlay { event: styk_core::overlay::host::Event::Tick, now }), now).map(Message::Editor)]))
                }
                Step::SaveLanded => {
                    let id = self.core.documents.active().map(|document| document.id()).ok_or("no project is open")?;
                    let now = self.now();
                    (Vec::new(), self.dispatch(E::SaveLanded(id, now)))
                }
                Step::Expect(expectation) => {
                    self.check_expectation(&expectation)?;
                    (Vec::new(), Task::none())
                }
                Step::Screenshot(path) => {
                    if let Some(run) = &mut self.run {
                        run.capturing = true;
                    }
                    (vec![Request::Capture(resolved(path))], Task::none())
                }
                other => return Err(format!("this build cannot run the step {other:?}")),
            })
        })();
        outcome.unwrap_or_else(|message| {
            self.fail(format!("line {line}: {message}"));
            (Vec::new(), Task::none())
        })
    }

    fn click(&mut self, target: Target) -> Result<Task<Message>, String> {
        use shell::Event as E;
        let events = match target {
            Target::Tab(number) => {
                let id = self.id_of(number)?;
                let frame = self.tab_frame(id)?;
                vec![E::TabPressed(id), E::PointerMoved(frame.x + frame.width / 2.0, frame.y + frame.height / 2.0), E::PointerReleased]
            }
            Target::Command(CommandId::New) => vec![E::New],
            Target::Command(CommandId::Home) => vec![E::Home],
            Target::Command(CommandId::Menu) => vec![E::Mark],
            Target::Command(CommandId::Undo) => vec![E::Undo],
            Target::Command(CommandId::Redo) => vec![E::Redo],
            Target::Command(CommandId::Save) => vec![E::Save],
            Target::Command(CommandId::Export) => vec![E::Export],
            Target::Workspace(name) => vec![E::Workspace(workspace_named(&name))],
            other => return Err(format!("this build cannot click {other:?}")),
        };
        Ok(Task::batch(events.into_iter().map(|event| self.dispatch(event)).collect::<Vec<_>>()))
    }

    fn key(&mut self, key: automation::Key) -> Task<Message> {
        use shell::Event as E;
        let event = match key {
            automation::Key::CtrlTab { backwards, held } => E::CtrlTab { backwards, held },
            automation::Key::ReleaseCtrl => E::ModifierReleased,
            automation::Key::Tab { backwards } => E::SwitcherKey(switcher::Key::Step(if backwards { -1 } else { 1 })),
            automation::Key::Escape if self.shell.board_open() => E::SwitcherKey(switcher::Key::Escape),
            automation::Key::Escape => E::CloseMenu,
            automation::Key::Neighbour(by) => E::Neighbour(by),
            _ => return Task::none(),
        };
        self.dispatch(event)
    }

    fn check_expectation(&self, expectation: &Expect) -> Result<(), String> {
        let number_of = |id: DocumentId| self.opened.iter().position(|opened| *opened == id).map_or(0, |at| at + 1);
        let same = |what: &str, wanted: String, found: String| if wanted == found { Ok(()) } else { Err(format!("expected {what} {wanted}, found {found}")) };
        match expectation {
            Expect::Front(n) => same("the tab in front", n.to_string(), self.core.documents.active().map_or(0, |d| number_of(d.id())).to_string()),
            Expect::Order(order) => same("the tabs' order", format!("{order:?}"), format!("{:?}", self.core.documents.tabs().iter().map(|d| number_of(d.id())).collect::<Vec<_>>())),
            Expect::Tabs(count) => same("the tabs in the band", count.to_string(), self.shell.layout().tabs().count().to_string()),
            Expect::Workspace(name) => {
                let found = match self.shell.pressed() {
                    None => "home",
                    Some(Workspace::Animate) => "animate",
                    Some(Workspace::Draw) => "draw",
                    Some(Workspace::Build) => "build",
                };
                same("the pressed workspace", name.clone(), found.to_string())
            }
            Expect::Folds(names) => {
                let found: Vec<String> = self.shell.layout().folds.iter().map(|fold| fold_name(*fold).to_string()).collect();
                same("the folds", format!("{names:?}"), format!("{found:?}"))
            }
            Expect::Board(open) => same("the board", open.to_string(), self.shell.board_open().to_string()),
            Expect::Dirty(n, dirty) => {
                let id = self.id_of(*n)?;
                let found = self.shell.tabs().iter().find(|tab| tab.id == id).is_some_and(|tab| matches!(tab.state, Some(TabState::Edited)));
                same(&format!("tab {n} unsaved"), dirty.to_string(), found.to_string())
            }
            Expect::Tab(n, state) => {
                let id = self.id_of(*n)?;
                let found = match self.shell.tabs().iter().find(|tab| tab.id == id).and_then(|tab| tab.state) {
                    None => "none",
                    Some(TabState::Edited) => "edited",
                    Some(TabState::Saving) => "saving",
                    Some(TabState::Saved) => "saved",
                };
                same(&format!("tab {n}'s dot"), state.clone(), found.to_string())
            }
            Expect::Width(width) => same("the window width", width.to_string(), format!("{}", self.shell.window().width.round() as u32)),
            Expect::Export(look) => {
                let found = self.shell.layout().items.iter().find_map(|p| match p.item {
                    shell::band::Item::Export(look, _) => Some(if look == ExportLook::Primary { "primary" } else { "ghost" }),
                    _ => None,
                });
                same("Export", look.clone(), found.unwrap_or("hidden").to_string())
            }
            other => Err(format!("this build cannot check {other:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::keyboard::{Location, Modifiers, key::{NativeCode, Physical}};
    use std::time::Duration;
    use styk_core::shell::strip::TabState;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/startup.document.json")
    }

    fn band() -> (TopBand, FixedClock) {
        let fixed = FixedClock::new();
        let top = match TopBand::new(Size::new(1560.0, 900.0), Arc::new(fixed.clone()), Some(fixed.clone()), Arc::new(styk_platform::spawn::ThreadSpawner), Arc::new(|| {}), None) {
            Ok(top) => top,
            Err(error) => panic!("{error}"),
        };
        (top, fixed)
    }

    /// Runs the frames until the host has nothing left to open.
    fn settle(top: &mut TopBand) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !top.idle() {
            assert!(std::time::Instant::now() < deadline, "the opens must finish");
            let _ = top.update(Message::Frame);
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn open(top: &mut TopBand, count: usize) {
        top.open_all(&vec![fixture(); count]);
        settle(top);
    }

    #[test]
    fn the_overlay_messages_reach_the_core_through_the_window_and_the_deadline_it_asks_for_ends_them() {
        use styk_core::commands::Command;
        use styk_core::overlay::host::Event as Overlay;
        use styk_core::overlay::messages::{Message as Toast, Tone};
        let (mut top, _) = band();
        let show = Overlay::ShowMessage(Toast::new(1, "saved", Tone::Success, false, vec![]));
        let _ = top.update(Message::Editor(styk_ui::message::Message::Command(Command::Overlay { event: show, now: 100 })));
        assert!(top.core.overlays().messages().current().is_some(), "the window routed the message to the core's host");
        assert!(top.core.overlay_deadline().is_some(), "the core asks the runtime for a wake");
        // The runtime wakes at each deadline the core gives (frames while the entry animates, then the message's end).
        let mut wakes = 0;
        while let Some(deadline) = top.core.overlay_deadline() {
            wakes += 1;
            assert!(wakes < 2000, "the deadlines end");
            let _ = top.update(Message::Editor(styk_ui::message::Message::Command(Command::Overlay { event: Overlay::Tick, now: deadline })));
        }
        assert!(top.core.overlays().messages().current().is_none(), "the wake at the deadline the core gave ended the message");
        assert_eq!(top.core.overlay_deadline(), None, "and nothing is scheduled any more");
    }

    #[test]
    fn projects_open_through_the_document_host_in_order_and_the_thirteenth_is_refused_by_it() {
        let (mut top, _) = band();
        open(&mut top, 12);
        assert_eq!(top.core.documents.tabs().len(), 12);
        assert_eq!(top.opened.len(), 12, "one tab per open, numbered in the order they opened");
        assert_eq!(top.shell.tabs().len(), 12);
        // The thirteenth comes back from the host as a failure; its prepared session was the host's to dispose of on its
        // worker, so the interface thread never drops it, and the tabs are as they were.
        let ids: Vec<DocumentId> = top.core.documents.tabs().iter().map(|tab| tab.id()).collect();
        top.open_all(&[fixture()]);
        settle(&mut top);
        assert_eq!(top.core.documents.tabs().iter().map(|tab| tab.id()).collect::<Vec<_>>(), ids);
        assert_eq!(top.opened.len(), 12);
    }

    #[test]
    fn a_script_over_the_limit_is_refused_before_it_is_decoded_or_parsed() {
        let dir = std::env::temp_dir().join(format!("styk-script-limit-{}", std::process::id()));
        styk_platform::diagnostics::create_output_directory(&dir).unwrap();
        let big = dir.join("big.script");
        styk_platform::diagnostics::write_report(&big, &"wait 1\n".repeat(MAX_SCRIPT_BYTES / 7 + 1)).unwrap();
        assert!(read_script(&big).unwrap_err().contains("longer than"), "refused by size");
        let exact = dir.join("exact.script");
        styk_platform::diagnostics::write_report(&exact, &"#".repeat(MAX_SCRIPT_BYTES)).unwrap();
        assert_eq!(read_script(&exact).unwrap().len(), MAX_SCRIPT_BYTES);
        assert!(read_script(&dir.join("missing.script")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_deadline_runs_on_the_one_injected_clock_and_only_a_fixed_clock_can_be_advanced() {
        let (mut top, fixed) = band();
        open(&mut top, 2);
        assert_eq!(top.opened.len(), 2);
        assert!(matches!(top.execute(2, Step::SaveLanded), (requests, _) if requests.is_empty()));
        assert_eq!(top.shell.tabs()[1].state, Some(TabState::Saved), "a save landed at the clock's time");
        // Nothing moves until the script moves the clock: a frame does not.
        let _ = top.update(Message::Frame);
        assert_eq!(top.shell.tabs()[1].state, Some(TabState::Saved));
        let _ = top.execute(3, Step::Advance(2_199_999_999));
        assert_eq!(top.shell.tabs()[1].state, Some(TabState::Saved), "2.2 s less a nanosecond");
        let _ = top.execute(4, Step::Advance(1));
        assert_eq!(top.shell.tabs()[1].state, None, "2.2 s on the clock the script holds");
        assert_eq!(fixed.now(), Duration::from_millis(2200));
        assert_eq!(engine_clock(), 2200.0, "the engine reads the same clock");
        // With the real clock there is nothing to advance, and saying so is a failure, not a no-op.
        let mut real = match TopBand::new(Size::new(1560.0, 900.0), Arc::new(styk_platform::clock::SystemClock::new()), None, Arc::new(styk_platform::spawn::ThreadSpawner), Arc::new(|| {}), None) {
            Ok(top) => top,
            Err(error) => panic!("{error}"),
        };
        real.run = Some(Run { steps: Vec::new(), next: 0, settle: 0, base: PathBuf::new(), failures: Vec::new(), capturing: false });
        let _ = real.execute(7, Step::Advance(1));
        assert!(real.run.as_ref().unwrap().failures[0].contains("--clock fixed"));
    }

    fn arrow(named: Named, modifiers: Modifiers) -> Event {
        Event::Keyboard(keyboard::Event::KeyPressed { key: Key::Named(named), modified_key: Key::Named(named), physical_key: Physical::Unidentified(NativeCode::Unidentified), location: Location::Standard, modifiers, text: None, repeat: false })
    }

    #[test]
    fn arrows_step_the_board_whether_control_is_held_or_not() {
        let (mut top, _) = band();
        open(&mut top, 4);
        let _ = top.dispatch(shell::Event::CtrlTab { backwards: false, held: true });
        let selected = |top: &TopBand| top.shell.board().and_then(|cards| cards.iter().position(|card| card.selected));
        assert_eq!(selected(&top), Some(1));
        // The modifier is still down as the arrow is pressed: today's switcher steps anyway.
        let _ = top.raw(&arrow(Named::ArrowRight, Modifiers::CTRL), true);
        assert_eq!(selected(&top), Some(2));
        let _ = top.raw(&arrow(Named::ArrowLeft, Modifiers::CTRL), true);
        assert_eq!(selected(&top), Some(1));
        let _ = top.raw(&arrow(Named::ArrowDown, Modifiers::default()), true);
        assert_eq!(selected(&top), Some(2));
    }
}
