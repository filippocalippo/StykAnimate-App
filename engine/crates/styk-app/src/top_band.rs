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

use iced::advanced::widget::operate;
use iced::keyboard::{self, Key, key::Named};
use iced::{Event, Size, Subscription, Task, Widget as _, event, mouse, window};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use styk_core::automation::{self, Expect, MAX_SCRIPT_BYTES, Script, Step, Target};
use styk_core::documents::{DocumentId, Documents, DocumentsError, PreparedDocument, Value};
use styk_core::focus::FocusId;
use styk_core::shell::band::{Fold, Frame};
use styk_core::shell::session::{ExportLook, Session};
use styk_core::shell::strip::TabState;
use styk_core::shell::switcher::{self, BoardKey};
use styk_core::shell::workspace::{self, Workspace};
use styk_core::shell::{self, Effect, ids};
use styk_design::widgets::focus;
use styk_design::{Theme, warm_up};
use styk_engine::{Budgets, Engine};
use styk_services::Spawner;
use styk_services::clock::{Clock, FixedClock};
use styk_services::shell::Rect;
use styk_services::shell::chrome::MaxButtonState;
use styk_ui::shell as view;

/// Frames to let pass after a step so the window shows its result before the next step (and before a capture).
const SETTLE_FRAMES: u32 = 3;

/// A project opened on a worker, handed to the interface thread once. The mutex holds it until the message that
/// carries it is handled; the interface thread only moves it into the tab.
#[derive(Clone)]
pub struct Handoff(Arc<Mutex<Option<Result<PreparedDocument, String>>>>);

impl std::fmt::Debug for Handoff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Handoff")
    }
}

#[derive(Clone, Debug)]
pub enum Message {
    /// A message of the band's views.
    Ui(view::Message),
    /// A project finished opening.
    Opened(Handoff),
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
    pub documents: Documents,
    /// The shell.
    pub shell: shell::Shell,
    /// The projects in the order they were opened, which is how scripts number them.
    opened: Vec<DocumentId>,
    opening: usize,
    /// The one application clock: every deadline of the band and the automation's work read it.
    clock: Arc<dyn Clock>,
    /// The same clock when it is the fixed one, so a script can advance it.
    fixed: Option<FixedClock>,
    /// Where a project the tabs refused is disposed of: never on the interface thread.
    spawner: Arc<dyn Spawner>,
    /// Refused projects no worker could take yet; tried again on the next update.
    parked: Vec<PreparedDocument>,
    run: Option<Run>,
    /// The band's words are measured: the layout is the real one.
    measured: bool,
}

/// What the stand-in for the workspace sessions answers.
enum Answer {
    Report(workspace::Report),
    Session(Session),
}

/// The engine's clock for budgeted reads, in milliseconds: the application clock as the band last read it (`TopBand::now`),
/// so the engine runs on the one clock too. It is only ever stored by the interface thread.
static ENGINE_NOW_BITS: AtomicU64 = AtomicU64::new(0);

fn engine_clock() -> f64 {
    f64::from_bits(ENGINE_NOW_BITS.load(Ordering::Relaxed))
}

/// Opens a project file on a worker: the one stand-in for K-doc's files service and engine host. When that host merges,
/// this function is what is replaced (its call sites hold only the `Handoff` it returns).
async fn open_project(path: PathBuf) -> Handoff {
    let result = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display())).and_then(|bytes| {
        let name = path.file_name().map_or_else(|| "Untitled".to_string(), |name| name.to_string_lossy().into_owned());
        prepare(bytes, &name).map_err(|message| format!("{}: {message}", path.display()))
    });
    Handoff(Arc::new(Mutex::new(Some(result))))
}

/// A project's bytes made ready to become a tab.
fn prepare(bytes: Vec<u8>, name: &str) -> Result<PreparedDocument, String> {
    let engine = Engine::new(engine_clock, Budgets::for_device(None));
    PreparedDocument::open_bytes(&engine, Arc::from(bytes), name, &|| false).map_err(|error| error.message)
}

/// Reads at most `MAX_SCRIPT_BYTES + 1` bytes of a script and refuses one that is longer, so a huge file is never read
/// whole.
fn read_script(reader: impl Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader.take(MAX_SCRIPT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SCRIPT_BYTES {
        return Err(format!("the script is longer than {MAX_SCRIPT_BYTES} bytes"));
    }
    String::from_utf8(bytes).map_err(|_| "the script is not UTF-8 text".to_string())
}

/// Gives a project to a tab. A refused project is handed to a worker to be disposed of: dropping a large session on
/// the interface thread would stall it (D7). If no worker can take it, it is kept for the next try, never dropped here.
fn install(documents: &mut Documents, prepared: PreparedDocument, spawner: &dyn Spawner, parked: &mut Vec<PreparedDocument>) -> Result<DocumentId, DocumentsError> {
    match documents.open(prepared) {
        Ok(id) => Ok(id),
        Err((error, refused)) => {
            dispose(refused, spawner, parked);
            Err(error)
        }
    }
}

fn dispose(prepared: PreparedDocument, spawner: &dyn Spawner, parked: &mut Vec<PreparedDocument>) {
    let cell = Arc::new(Mutex::new(Some(prepared)));
    let job_cell = cell.clone();
    let job: styk_services::Job = Box::new(move || drop(job_cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()));
    if spawner.spawn("dispose project", job).is_err()
        && let Some(prepared) = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    {
        parked.push(prepared);
    }
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
    pub fn new(window_size: Size, clock: Arc<dyn Clock>, fixed: Option<FixedClock>, spawner: Arc<dyn Spawner>) -> TopBand {
        let window = shell::Window { width: window_size.width, height: window_size.height, ui_scale: 1.0, controls: !cfg!(target_os = "macos") };
        let unmeasured = shell::band::Labels { animate: 0.0, draw: 0.0, build: 0.0, export: 0.0, cancel: 0.0, test_rig: 0.0, done: 0.0 };
        TopBand { documents: Documents::new(), shell: shell::Shell::new(window, view::metrics(), unmeasured), opened: Vec::new(), opening: 0, clock, fixed, spawner, parked: Vec::new(), run: None, measured: false }
    }

    /// Starts the script the command line named.
    pub fn run_script(&mut self, path: &Path) -> Result<(), String> {
        let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let text = read_script(file).map_err(|error| format!("{}: {error}", path.display()))?;
        let script = Script::parse(&text).map_err(|error| format!("{}: {error}", path.display()))?;
        let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
        self.run = Some(Run { steps: script.steps, next: 0, settle: SETTLE_FRAMES, base, failures: Vec::new(), capturing: false });
        Ok(())
    }

    /// The projects the command line names, opened in order.
    pub fn open_all(&mut self, files: &[PathBuf]) -> Task<Message> {
        let mut task = Task::none();
        for file in files {
            self.opening += 1;
            task = task.chain(Task::perform(open_project(file.clone()), Message::Opened));
        }
        task
    }

    /// Nothing is opening, so what the window shows is complete.
    pub fn idle(&self) -> bool {
        self.opening == 0
    }

    /// The fonts are ready: measure the band's words.
    pub fn fonts_ready(&mut self) {
        if let Some(ready) = warm_up::proof() {
            drop(self.dispatch(shell::Event::Labels(view::measure_labels(ready))));
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
        view::window(view::Params { shell: &self.shell, theme, ready, maximize }, content).map(Message::Ui).boxed()
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![event::listen_with(|event, status, _| match &event {
            Event::Keyboard(keyboard::Event::KeyPressed { .. } | keyboard::Event::KeyReleased { .. }) | Event::Mouse(mouse::Event::ButtonPressed(_)) | Event::Window(window::Event::Unfocused) => Some(Message::Raw(event.clone(), status == event::Status::Ignored)),
            _ => None,
        })];
        if self.shell.tracking() {
            subscriptions.push(event::listen_with(|event, _, _| match event {
                Event::Mouse(mouse::Event::CursorMoved { position }) => Some(Message::Cursor(position.x, position.y)),
                Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => Some(Message::Released),
                _ => None,
            }));
        }
        if self.run.is_some() || self.shell.next_deadline().is_some() {
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
            for effect in self.shell.handle(&mut self.documents, event) {
                match effect {
                    Effect::Workspace(ask) => queue.extend(Self::sessions(ask).into_iter().map(|answer| match answer {
                        Answer::Report(report) => shell::Event::Report(report),
                        Answer::Session(session) => shell::Event::Session(session),
                    })),
                    Effect::FocusTab(id) => tasks.push(TopBand::focus(ids::tab(id))),
                    Effect::Activated(_) | Effect::Moved(..) | Effect::Edited | Effect::Command(_) | Effect::Refused(_) => {}
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
        let reads_focus = !matches!(message, Message::Cursor(..) | Message::Frame | Message::Snapshot(_));
        let (requests, task) = match message {
            Message::Ui(view::Message::Shell(event)) => (Vec::new(), self.dispatch(event)),
            Message::Ui(view::Message::Minimize) => (vec![Request::Minimize], Task::none()),
            Message::Ui(view::Message::CloseWindow) => (vec![Request::Close], Task::none()),
            Message::Opened(handoff) => {
                self.opening = self.opening.saturating_sub(1);
                let result = handoff.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
                let mut task = Task::none();
                match result {
                    Some(Ok(prepared)) => match install(&mut self.documents, prepared, self.spawner.as_ref(), &mut self.parked) {
                        Ok(id) => {
                            self.opened.push(id);
                            task = self.dispatch(shell::Event::Opened(id));
                        }
                        Err(error) => self.fail(format!("a project could not be opened as a tab: {error}")),
                    },
                    Some(Err(error)) => self.fail(error),
                    None => {}
                }
                self.retry_disposals();
                self.shell.sync(&self.documents);
                (Vec::new(), task)
            }
            Message::Raw(event, ignored) => (Vec::new(), self.raw(&event, ignored)),
            Message::Cursor(x, y) => (Vec::new(), self.dispatch(shell::Event::PointerMoved(x, y))),
            Message::Released => (Vec::new(), self.dispatch(shell::Event::PointerReleased)),
            Message::Snapshot(snapshot) => {
                let synced = focus::sync(&mut self.shell.focus, &snapshot);
                let task = if synced.unfocus.is_some() { operate(focus::unfocus()).discard().chain(TopBand::snapshot()) } else { Task::none() };
                (Vec::new(), task)
            }
            Message::Frame => self.frame(),
        };
        let task = if reads_focus { Task::batch([task, TopBand::snapshot()]) } else { task };
        (requests, task)
    }

    /// Hands the refused projects no worker could take to a worker again.
    fn retry_disposals(&mut self) {
        for prepared in std::mem::take(&mut self.parked) {
            dispose(prepared, self.spawner.as_ref(), &mut self.parked);
        }
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
    fn frame(&mut self) -> (Vec<Request>, Task<Message>) {
        let now = self.now();
        let tick = self.dispatch(shell::Event::Tick(now));
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
        let Some(run) = &mut self.run else { return none };
        if run.capturing || !self.measured || self.opening > 0 {
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
                    self.opening += 1;
                    (Vec::new(), Task::perform(open_project(resolved(path)), Message::Opened))
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
                    let id = self.documents.active().map(|document| document.id()).ok_or("no project is open")?;
                    let answer = self.documents.call(id, "setFPS", &[Value::Num(f64::from(fps))], &Value::Null).map_err(|error| error.to_string())?;
                    answer.result.map_err(|error| error.to_string())?;
                    self.shell.sync(&self.documents);
                    (Vec::new(), Task::none())
                }
                Step::Advance(nanos) => {
                    let Some(fixed) = &self.fixed else { return Err("advance needs --clock fixed: the system clock cannot be moved".to_string()) };
                    fixed.advance(std::time::Duration::from_nanos(nanos));
                    // The strip's deadlines follow the clock at once, not at the next frame.
                    let now = self.now();
                    (Vec::new(), self.dispatch(E::Tick(now)))
                }
                Step::SaveLanded => {
                    let id = self.documents.active().map(|document| document.id()).ok_or("no project is open")?;
                    let now = self.now();
                    (Vec::new(), self.dispatch(E::SaveLanded(id, now)))
                }
                Step::Expect(expectation) => {
                    self.expect(&expectation)?;
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
            Target::New => vec![E::New],
            Target::Home => vec![E::Home],
            Target::Mark => vec![E::Mark],
            Target::Undo => vec![E::Undo],
            Target::Redo => vec![E::Redo],
            Target::Save => vec![E::Save],
            Target::Export => vec![E::Export],
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

    fn expect(&self, expectation: &Expect) -> Result<(), String> {
        let number_of = |id: DocumentId| self.opened.iter().position(|opened| *opened == id).map_or(0, |at| at + 1);
        let same = |what: &str, wanted: String, found: String| if wanted == found { Ok(()) } else { Err(format!("expected {what} {wanted}, found {found}")) };
        match expectation {
            Expect::Front(n) => same("the tab in front", n.to_string(), self.documents.active().map_or(0, |d| number_of(d.id())).to_string()),
            Expect::Order(order) => same("the tabs' order", format!("{order:?}"), format!("{:?}", self.documents.tabs().iter().map(|d| number_of(d.id())).collect::<Vec<_>>())),
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
    use styk_services::{Job, SpawnError};

    const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

    /// A spawner that keeps the jobs it was given (or refuses them), so a test sees where work would run.
    #[derive(Default)]
    struct Recording {
        jobs: Mutex<Vec<(String, Job)>>,
        refuse: bool,
    }

    impl Spawner for Recording {
        fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
            if self.refuse {
                return Err(SpawnError("no worker".into()));
            }
            self.jobs.lock().unwrap().push((name.to_string(), job));
            Ok(())
        }
    }

    fn prepared(name: &str) -> PreparedDocument {
        prepare(STARTUP.to_vec(), name).expect("the fixture opens")
    }

    fn band(spawner: Arc<dyn Spawner>) -> (TopBand, FixedClock) {
        let fixed = FixedClock::new();
        (TopBand::new(Size::new(1560.0, 900.0), Arc::new(fixed.clone()), Some(fixed.clone()), spawner), fixed)
    }

    fn open(top: &mut TopBand, name: &str) {
        let handoff = Handoff(Arc::new(Mutex::new(Some(Ok(prepared(name))))));
        top.opening += 1;
        let _ = top.update(Message::Opened(handoff));
    }

    #[test]
    fn a_refused_project_goes_to_a_worker_to_be_dropped_not_dropped_on_the_interface_thread() {
        let spawner = Arc::new(Recording::default());
        let mut documents = Documents::new();
        let mut parked = Vec::new();
        for n in 0..styk_core::documents::MAX_OPEN_PROJECTS {
            install(&mut documents, prepared(&format!("{n}.styk")), spawner.as_ref(), &mut parked).expect("room for twelve");
        }
        assert!(spawner.jobs.lock().unwrap().is_empty(), "an accepted project needs no disposal");
        let refused = install(&mut documents, prepared("Thirteenth.styk"), spawner.as_ref(), &mut parked);
        assert_eq!(refused, Err(DocumentsError::TabLimit));
        let jobs: Vec<(String, Job)> = std::mem::take(&mut *spawner.jobs.lock().unwrap());
        assert_eq!(jobs.len(), 1, "the refused session was handed to a worker");
        assert!(parked.is_empty());
        // Running the job is what drops it, on whichever thread the spawner chose.
        std::thread::spawn(move || {
            for (_, job) in jobs {
                job();
            }
        })
        .join()
        .unwrap();
    }

    #[test]
    fn when_no_worker_can_take_a_refused_project_it_is_kept_not_dropped_and_tried_again() {
        let spawner = Arc::new(Recording { refuse: true, ..Recording::default() });
        let mut documents = Documents::new();
        let mut parked = Vec::new();
        for n in 0..styk_core::documents::MAX_OPEN_PROJECTS {
            install(&mut documents, prepared(&format!("{n}.styk")), spawner.as_ref(), &mut parked).unwrap();
        }
        assert!(install(&mut documents, prepared("Thirteenth.styk"), spawner.as_ref(), &mut parked).is_err());
        assert_eq!(parked.len(), 1, "kept, to be handed over later");
    }

    #[test]
    fn a_script_over_the_limit_is_refused_after_reading_one_byte_past_it() {
        struct Counting(usize, std::cell::Cell<usize>);
        impl Read for &Counting {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let left = self.0 - self.1.get();
                let n = left.min(buffer.len());
                buffer[..n].fill(b'#');
                self.1.set(self.1.get() + n);
                Ok(n)
            }
        }
        let huge = Counting(10 * MAX_SCRIPT_BYTES, std::cell::Cell::new(0));
        let error = read_script(&huge).unwrap_err();
        assert!(error.contains("longer than"), "{error}");
        assert_eq!(huge.1.get(), MAX_SCRIPT_BYTES + 1, "no more than one byte past the limit was read");
        let exact = Counting(MAX_SCRIPT_BYTES, std::cell::Cell::new(0));
        assert_eq!(read_script(&exact).unwrap().len(), MAX_SCRIPT_BYTES);
        assert!(read_script(&b"\xff\xfe"[..]).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn every_deadline_runs_on_the_one_injected_clock_and_only_a_fixed_clock_can_be_advanced() {
        let (mut top, fixed) = band(Arc::new(Recording::default()));
        open(&mut top, "A.styk");
        open(&mut top, "B.styk");
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
        let mut real = TopBand::new(Size::new(1560.0, 900.0), Arc::new(styk_services::clock::SystemClock::new()), None, Arc::new(Recording::default()));
        real.run = Some(Run { steps: Vec::new(), next: 0, settle: 0, base: PathBuf::new(), failures: Vec::new(), capturing: false });
        let _ = real.execute(7, Step::Advance(1));
        assert!(real.run.as_ref().unwrap().failures[0].contains("--clock fixed"));
    }

    fn arrow(named: Named, modifiers: Modifiers) -> Event {
        Event::Keyboard(keyboard::Event::KeyPressed { key: Key::Named(named), modified_key: Key::Named(named), physical_key: Physical::Unidentified(NativeCode::Unidentified), location: Location::Standard, modifiers, text: None, repeat: false })
    }

    #[test]
    fn arrows_step_the_board_whether_control_is_held_or_not() {
        let (mut top, _) = band(Arc::new(Recording::default()));
        for name in ["A.styk", "B.styk", "C.styk", "D.styk"] {
            open(&mut top, name);
        }
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
