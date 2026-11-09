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
use styk_core::engine::{Budgets, Engine, json};
use styk_services::Spawner;
use styk_services::{Cancel, worker::{Worker, run_future}};
use styk_services::clock::{Clock, FixedClock, WallClock};
use styk_services::files::{FileTarget, Files as _};
use styk_services::shell::Rect;
use styk_services::shell::chrome::MaxButtonState;
use styk_ui::screens::Screen;
use styk_ui::shell as view;

/// Frames to let pass after a step so the window shows its result before the next step (and before a capture).
const SETTLE_FRAMES: u32 = 3;

#[derive(Clone, Debug)]
pub enum Message {
    Progress,
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
    /// The layout lane has a reply in its bounded exchange.
    Layouts,
    /// The earliest core deadline is due, on the application's injected clock.
    Deadline,
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
    PreferencesProgress,
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
    /// The layout persistence service: the stored arrangements load through it and the dock's writes go through it.
    layouts: Option<Worker<LayoutWork, LayoutReply>>,
    layout_pending: Option<Cancel>,
    /// The shell.
    pub shell: shell::Shell,
    /// The projects in the order they were opened, which is how scripts number them.
    opened: Vec<DocumentId>,
    /// The opens asked for and not yet started, and whether the host is working on one: the host runs one at a time.
    requests: VecDeque<Ask>,
    busy: bool,
    /// The one application clock: every deadline of the band and the automation's work read it.
    clock: Arc<dyn Clock>,
    wall: Arc<dyn WallClock>,
    /// The same clock when it is the fixed one, so a script can advance it.
    fixed: Option<FixedClock>,
    run: Option<Run>,
    /// The band's words are measured: the layout is the real one.
    measured: bool,
    /// A band screen of the catalogue shown in place of the open projects (`--screen band`).
    screen: Option<Screen>,
    /// The Properties panel's prepared model while a window screen of the catalogue shows (`--screen dock`).
    fixture: Option<styk_core::inspector::model::Inspector>,
    progress: ProgressWatch,
}
#[derive(Clone)]
struct ProgressWatch(Arc<styk_core::stage::Progress>);
impl std::hash::Hash for ProgressWatch {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) { std::hash::Hash::hash(&Arc::as_ptr(&self.0), state); }
}
fn progress_stream(watch: &ProgressWatch) -> impl iced::futures::Stream<Item = Message> + use<> {
    iced::futures::stream::unfold(watch.0.clone(), |progress| async move {
        iced::futures::future::poll_fn(|cx| if progress.poll(cx.waker()) { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }).await;
        Some((Message::Progress, progress))
    })
}

/// What the stand-in for the workspace sessions answers.
enum Answer {
    Report(workspace::Report),
    Session(Session),
}

enum LayoutWork { Load, Save(styk_core::layout::store::LayoutFile, u64, Cancel) }
enum LayoutReply { Loaded(styk_core::dock::Stored), Saved(bool) }

fn load_layouts(store: &styk_core::layout::LayoutStore) -> styk_core::dock::Stored {
    use styk_core::{dock::Stored, layout::LayoutError};
    match run_future(store.load()) {
        Ok(Some(file)) => Stored::File(file),
        Err(LayoutError::FutureVersion) => Stored::Newer,
        Err(error) => Stored::Unreadable(format!("{error:?}")),
        Ok(None) => {
            let target = FileTarget::new(styk_platform::shell::profile_dir().join("workspace-preferences.json"));
            match run_future(styk_platform::files::LocalFiles.read(&target, 256 * 1024, &Cancel::new())) {
                Ok(bytes) => json::parse(&bytes).map_or(Stored::Nothing, Stored::Legacy),
                Err(_) => Stored::Nothing,
            }
        }
    }
}

impl Drop for TopBand {
    fn drop(&mut self) { self.abandon_layouts(); self.abandon_settings(); }
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
    /// `wakes` carries layout receipts; the shared Progress subscription carries document, frame and Settings work. `recovery` is the
    /// store where the lane keeps this window's copies and lists the ones an earlier run left (`None`:
    /// no recovery, as in a run that must not touch the person's folders). `storage` is also absent for unattended runs.
    pub fn new(window_size: Size, clock: Arc<dyn Clock>, fixed: Option<FixedClock>, spawner: Arc<dyn Spawner>, wakes: styk_platform::shell::Wakes, recovery: Option<Arc<dyn styk_services::recovery::Recovery>>, layouts: Option<Arc<styk_core::layout::LayoutStore>>, storage: Option<Arc<dyn styk_services::storage::Storage>>) -> Result<TopBand, String> {
        let window = shell::Window { width: window_size.width, height: window_size.height, ui_scale: 1.0, controls: !cfg!(target_os = "macos") };
        let unmeasured = shell::band::Labels { animate: 0.0, draw: 0.0, build: 0.0, export: 0.0, cancel: 0.0, test_rig: 0.0, done: 0.0 };
        let mut documents = Documents::new();
        let progress = styk_core::stage::Progress::new();
        let notify = progress.wake();
        let layouts = layouts.map(|store| Worker::start(spawner.as_ref(), "styk-layouts", move |work| match work {
            LayoutWork::Load => LayoutReply::Loaded(load_layouts(&store)),
            LayoutWork::Save(file, wall, cancel) => LayoutReply::Saved(run_future(store.save(&file, wall, &cancel)).is_ok()),
        }, Arc::new(move || wakes.send(styk_platform::shell::Wake::Layouts))))
            .transpose().map_err(|error| format!("the layout lane did not start: {error}"))?;
        // The application's startup document, for New and for closing the last tab. Stand-in: the engine's startup fixture,
        // until the native startup document (Blue on the landscape canvas) has an owner. The band does not send New yet.
        let startup = json::parse(STARTUP).map_err(|error| format!("the startup document: {error:?}"))?;
        documents
            .attach_host(HostOptions {
                engine: Engine::new(engine_clock, Budgets::for_device(None)),
                spawner: spawner.clone(),
                files: Arc::new(styk_platform::files::LocalFiles),
                startup,
                clock: engine_clock,
                // The shared Progress subscription polls the exclusive document lane.
                notify: notify.clone(),
            })
            .map_err(|error| format!("the document host did not start: {error}"))?;
        if let Some(store) = recovery {
            documents.attach_recovery(store, clock.clone()).map_err(|error| format!("recovery did not start: {error}"))?;
            // The first listing is queued by the first poll: ask for it.
            notify();
        }
        let mut core = styk_core::app::Core::new(documents);
        core.start_runtime(spawner.clone(), clock.clone(), progress.clone()).map_err(|e| e.to_string())?;
        if let Some(storage) = storage { core.start_settings(spawner.as_ref(), storage, progress.wake()).map_err(|e| e.to_string())?; }
        let audio_spawner = spawner.clone();
        let audio_wake = progress.wake();
        core.start_audio(spawner.as_ref(), move || {
            let output = styk_platform::audio::WasapiOutput::new().map_err(|e| e.to_string())?;
            let decoder = styk_platform::audio::FfmpegAudioDecoder::native();
            styk_core::audio::AudioTransport::new_notifying(audio_spawner, Box::new(output), Arc::new(styk_platform::audio::QpcClock::new()), Arc::new(decoder), styk_core::audio::CACHE_BYTES, audio_wake).map_err(|e| e.to_string())
        }, progress.wake()).map_err(|e| e.to_string())?;
        let wall: Arc<dyn WallClock> = Arc::new(styk_platform::clock::SystemWallClock::default());
        core.dock_mut().set_writer(wall.writer());
        core.dock_mut().set_wall_time(wall.unix_millis());
        core.dock_mut().handle(styk_core::dock::Event::Resized { width: f64::from(window_size.width), height: f64::from(window_size.height), scale: 1.0 }, 0);
        Ok(TopBand { core, layouts, layout_pending: None, progress: ProgressWatch(progress), fixture: None, shell: shell::Shell::new(window, view::metrics(), unmeasured), opened: Vec::new(), requests: VecDeque::new(), busy: false, clock, wall, fixed, run: None, measured: false, screen: None })
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
        self.requests.is_empty() && !self.busy && (self.core.documents.active().is_none() || (!self.core.timeline().model().pending && self.core.stage().is_some()))
    }
    /// Final maintenance after QuitReady, through the same core dispatch fence.
    pub fn flush_settings(&mut self) -> bool {
        let now = self.now();
        // A final failure settles the lane. The last committed settings remain intact.
        drop(self.core.dispatch(styk_core::commands::Command::Settings(styk_core::settings::Event::Finish { now })));
        !self.core.settings_idle()
    }
    pub fn abandon_settings(&mut self) {
        drop(self.core.dispatch(styk_core::commands::Command::Settings(styk_core::settings::Event::Abandon)));
    }
    #[cfg(test)]
    fn with_storage(window_size: Size, clock: Arc<dyn Clock>, fixed: Option<FixedClock>, spawner: Arc<dyn Spawner>, storage: Arc<dyn styk_services::storage::Storage>) -> Result<TopBand, String> {
        Self::new(window_size, clock, fixed, spawner, styk_platform::shell::Wakes(Arc::new(|_| {})), None, None, Some(storage))
    }

    /// Shows a band screen of the catalogue (`--screen band`) instead of the open projects.
    pub fn show_screen(&mut self, screen: Option<Screen>) {
        self.screen = screen;
        self.fixture = screen.filter(|screen| screen.is_dock()).map(|_| styk_ui::screens::inspector_model(styk_core::screens::InspectorScreen::Figure));
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
    pub fn resized(&mut self, size: Size, scale: f32) {
        let controls = self.shell.window().controls;
        drop(self.dispatch(shell::Event::Resized(shell::Window { width: size.width, height: size.height, ui_scale: 1.0, controls })));
        let now = self.now();
        drop(self.dock(styk_core::dock::Event::Resized { width: f64::from(size.width), height: f64::from(size.height), scale: f64::from(scale) }, now));
    }

    /// An event of the dock, through the one handler every view's message reaches.
    fn dock(&mut self, event: styk_core::dock::Event, now: u64) -> Task<Message> {
        styk_ui::message::update_at(&mut self.core, styk_ui::message::Message::Command(styk_core::commands::Command::Dock(event)), now).map(Message::Editor).chain(TopBand::snapshot())
    }

    /// Reads the stored layouts: the dock's own file, or today's `workspace-preferences.json` on a first launch. Nothing is
    /// written by reading.
    pub fn load_layouts(&mut self) -> Task<Message> {
        let Some(worker) = &self.layouts else { return Task::none() };
        if self.layout_pending.is_some() { return Task::none(); }
        if worker.submit(LayoutWork::Load).is_ok() {
            self.layout_pending = Some(Cancel::new());
            Task::none()
        } else {
            let now = self.now();
            let asked = self.core.dock_mut().loaded(styk_core::dock::Stored::Unreadable("layout worker refused the load".into()), now);
            styk_ui::message::run(self.core.dock_effects(asked)).map(Message::Editor)
        }
    }

    /// Submit one due layout write. SaveQueue keeps its bytes until the receipt;
    /// a refused submission goes through the same completion bookkeeping.
    fn save_layouts(&mut self, now: u64) {
        if self.layout_pending.is_some() { return; }
        let Some(worker) = &self.layouts else { return };
        let Some(file) = self.core.dock_mut().take_save(now) else { return };
        let cancel = Cancel::new();
        if worker.submit(LayoutWork::Save(file, self.wall.unix_millis(), cancel.clone())).is_ok() {
            self.layout_pending = Some(cancel);
        } else {
            self.core.dock_mut().save_done(false, now);
        }
    }

    fn poll_layouts(&mut self) -> Task<Message> {
        let reply = self.layouts.as_ref().and_then(Worker::take);
        let now = self.now();
        let mut effects = Vec::new();
        if let Some(reply) = reply {
            self.layout_pending = None;
            match reply {
                LayoutReply::Loaded(stored) => {
                    let asked = self.core.dock_mut().loaded(stored, now);
                    effects = self.core.dock_effects(asked);
                }
                LayoutReply::Saved(landed) => self.core.dock_mut().save_done(landed, now),
            }
        }
        self.save_layouts(now);
        styk_ui::message::run(effects).map(Message::Editor)
    }

    /// Flush after document clearance. The queue owns coalescing and the final
    /// attempt; a failed final write abandons only proposed bytes, never disk data.
    pub fn flush_layouts(&mut self) -> bool {
        if self.layouts.is_none() { return false; }
        let now = self.now();
        self.core.dock_mut().flush_save(now);
        self.save_layouts(now);
        !self.layouts_idle() || self.core.dock().save_pending()
    }

    pub fn layouts_idle(&self) -> bool { self.layout_pending.is_none() }

    pub fn abandon_layouts(&mut self) {
        if let Some(cancel) = self.layout_pending.take() { cancel.cancel(); }
        if let Some(worker) = self.layouts.take() { worker.shutdown(Box::new(())); }
        self.core.dock_mut().abandon_save();
    }

    /// The docked window under the band: every group at its rectangle, the Properties panel and the stage in theirs.
    pub fn dock_view<'a>(&'a self, theme: Theme) -> iced::Element<'a, Message> {
        let params = styk_ui::dock::Params { dock: self.core.dock(), theme, presentation: self.core.presentation(), top: self.height() };
        let presentation = self.core.presentation();
        let (inspector, stage) = match &self.fixture {
            Some(model) => (Some(styk_ui::inspector::View::model(model, presentation, theme)), None),
            None => (styk_ui::inspector::View::of(&self.core, theme), self.core.stage().map(|surface| styk_ui::stage::stage(surface, theme, |event| styk_ui::Message::Command(styk_core::commands::Command::Stage(event))))),
        };
        styk_ui::dock::window(&params, inspector, stage).map(Message::Editor).boxed()
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
        view::window(view::Params { shell: &self.shell, theme, ready, presentation: self.core.presentation(), mark_open: self.core.overlays().menu_of(shell::ids::MARK).is_some(), maximize }, content).map(Message::Ui).boxed()
    }

    /// The overlay layer over the band and dock: menus, lists, the stage's message,
    /// tooltips and recovery dialogs, drawn from the core-owned host. Every message
    /// reaches `Core::dispatch` through the same interface adapter.
    pub fn overlay_layer(&self, theme: Theme) -> iced::Element<'_, Message> {
        let window = self.shell.window();
        let owned = styk_ui::recovery::owned(&self.core, theme.palette(), Size::new(window.width, window.height));
        styk_ui::overlays::layer(&self.core, theme.palette(), self.height() + 6.0, None, owned).map(Message::Editor).boxed()
    }

    /// One runtime adapter for all core deadlines; it owns no timer or decision.
    pub fn wake_widget(&self) -> iced::Element<'_, Message> {
        // A load occupies the same lane as a save. Its receipt schedules the
        // pending save; an expired save deadline cannot make that load progress.
        crate::overlay_wake::element(self.core.wake_deadline(self.layouts.is_some() && self.layouts_idle()).filter(|_| self.fixed.is_none()), self.clock.clone(), |_| Message::Deadline)
    }

    fn deadline(&mut self) -> Task<Message> {
        let now = self.now();
        let documents = self.pump();
        if self.core.session_end_expired() { return documents; }
        let overlays = styk_ui::message::update_at(&mut self.core, styk_ui::Message::Command(styk_core::commands::Command::Wake { now }), now).map(Message::Editor);
        let layouts = self.poll_layouts();
        Task::batch([documents, overlays, layouts])
    }

    /// The window was asked to close. The documents host answers: nothing to ask (the program may end), or a confirmation for the
    /// projects with unsaved work (the close prompt, with its recovery copy's retry) and `Request::QuitReady` once every project is
    /// answered for and the recovery lane has finished.
    pub fn ask_to_quit(&mut self) -> Task<Message> {
        styk_ui::message::run(self.core.request_quit()).map(Message::Editor)
    }

    pub fn session_end(&mut self) -> Task<Message> {
        styk_ui::message::run(self.core.request_session_end(self.clock.now(), styk_platform::shell::session_end_timeout())).map(Message::Editor)
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![event::listen_with(|event, status, _| match &event {
            Event::Keyboard(keyboard::Event::KeyPressed { .. } | keyboard::Event::KeyReleased { .. }) | Event::Mouse(mouse::Event::ButtonPressed(_) | mouse::Event::ButtonReleased(_)) | Event::Window(window::Event::Unfocused) => Some(Message::Raw(event.clone(), status == event::Status::Ignored)),
            _ => None,
        })];
        subscriptions.push(Subscription::run_with(self.progress.clone(), progress_stream));
        if self.shell.tracking() {
            subscriptions.push(event::listen_with(|event, _, _| match event {
                Event::Mouse(mouse::Event::CursorMoved { position }) => Some(Message::Cursor(position.x, position.y)),
                Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => Some(Message::Released),
                _ => None,
            }));
        }
        if self.core.dock().tracking() {
            subscriptions.push(event::listen_with(|event, _, _| styk_ui::dock::track(&event).map(Message::Editor)));
        }
        // Readiness gates automation, not redraws. Slow workers wake this subscription
        // through Progress; a script samples its finite settling frames only when ready.
        if (self.run.is_some() && self.idle()) || self.shell.next_deadline().is_some() || self.core.timeline().playing() {
            subscriptions.push(window::frames().map(|_| Message::Frame));
        }
        Subscription::batch(subscriptions)
    }

    /// The application clock in milliseconds; the engine's clock follows it.
    fn now(&mut self) -> u64 {
        let millis = self.clock.now().as_millis() as u64;
        self.core.dock_mut().set_wall_time(self.wall.unix_millis());
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
        use shell::Event as E;
        if matches!(event, E::PointerReleased | E::TabKey(..) | E::TabClose(_) | E::Workspace(_) | E::Undo | E::Redo | E::Save | E::Export | E::Cancel | E::Done(_) | E::CtrlTab { .. } | E::SwitcherKey(_) | E::SwitcherPick(_) | E::ModifierReleased | E::Neighbour(_) | E::Home | E::New) {
            let effects = self.core.dispatch(styk_core::commands::Command::Shell(event));
            let tasks: Vec<_> = effects.into_iter().map(|effect| match effect {
                styk_core::commands::Effect::ShellReady(event) => self.dispatch_ready(event),
                effect => styk_ui::message::effect(effect).map(Message::Editor),
            }).collect();
            return Task::batch(tasks);
        }
        self.dispatch_ready(event)
    }

    fn dispatch_ready(&mut self, event: shell::Event) -> Task<Message> {
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
                    Effect::Activated(_) | Effect::Edited => tasks.push(styk_ui::message::run(self.core.refresh()).map(Message::Editor)),
                    Effect::Command(command) => tasks.push(styk_ui::message::update(&mut self.core, command.into()).map(Message::Editor)),
                    Effect::DocumentCommand { command, document } => {
                        tasks.push(styk_ui::message::update(&mut self.core, styk_core::commands::Command::Activate(document).into()).map(Message::Editor));
                        tasks.push(styk_ui::message::update(&mut self.core, command.into()).map(Message::Editor));
                    }
                    Effect::Refused(error) => self.fail(error.to_string()),
                    Effect::Moved(..) | Effect::FinishBuild => {}
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
            Message::Progress => {
                let now = self.now();
                let task = self.pump();
                let wake = styk_ui::message::update(&mut self.core, styk_core::commands::Command::Wake { now }.into()).map(Message::Editor);
                (vec![Request::PreferencesProgress], Task::batch([task, wake]))
            }
            Message::Editor(styk_ui::message::Message::ShellReady(event)) => (Vec::new(), self.dispatch_ready(event)),
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
            Message::Documents => {
                let task = self.pump();
                let now = self.now();
                let wake = styk_ui::message::update_at(&mut self.core, styk_core::commands::Command::Wake { now }.into(), now).map(Message::Editor);
                (vec![Request::PreferencesProgress], Task::batch([task, wake]))
            },
            Message::Layouts => (vec![Request::PreferencesProgress], self.poll_layouts()),
            Message::Deadline => (vec![Request::PreferencesProgress], self.deadline()),
        };
        let task = if reads_focus { Task::batch([task, TopBand::snapshot()]) } else { task };
        (requests, Task::batch([task, self.follow_workspace()]))
    }

    /// The workspace the band pressed is the arrangement the dock shows (Build is the layout's `rig`); Home keeps the last.
    fn follow_workspace(&mut self) -> Task<Message> {
        use styk_core::layout::Workspace as Arrangement;
        let wanted = match self.shell.pressed() {
            Some(Workspace::Animate) => Arrangement::Animate,
            Some(Workspace::Draw) => Arrangement::Draw,
            Some(Workspace::Build) => Arrangement::Rig,
            None => return Task::none(),
        };
        if self.core.dock().workspace() == wanted {
            return Task::none();
        }
        let now = self.now();
        self.dock(styk_core::dock::Event::Workspace(wanted), now)
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
                if let Some(task) = self.dock_key(key) {
                    return task;
                }
                if let Some(task) = styk_ui::message::dock_shortcut_at(&mut self.core, event, ignored, now) {
                    return task.map(Message::Editor).chain(TopBand::snapshot());
                }
                match key.as_ref() {
                    Key::Named(Named::Tab) if modifiers.control() => self.dispatch(E::CtrlTab { backwards: modifiers.shift(), held: true }),
                    Key::Named(Named::PageDown) if modifiers.control() => self.dispatch(E::Neighbour(1)),
                    Key::Named(Named::PageUp) if modifiers.control() => self.dispatch(E::Neighbour(-1)),
                    Key::Named(Named::Escape) if self.shell.tracking() => self.dispatch(E::DragCancelled),
                    Key::Named(Named::Escape) if self.shell.menu().is_some() => self.dispatch(E::CloseMenu),
                    _ => {
                        let navigation = if ignored { focus::navigate(&mut self.shell.focus, event).map_or_else(Task::none, TopBand::focus) } else { Task::none() };
                        let key = styk_ui::message::editor_key(event, ignored).map_or_else(Task::none, |message| styk_ui::message::update_at(&mut self.core, message, now).map(Message::Editor));
                        Task::batch([navigation, key])
                    }
                }
            }
            Event::Keyboard(keyboard::Event::KeyReleased { key: Key::Named(Named::Control), .. }) if self.shell.board_open() => self.dispatch(E::ModifierReleased),
            Event::Keyboard(keyboard::Event::KeyReleased { .. }) => {
                let shift = matches!(event, Event::Keyboard(keyboard::Event::KeyReleased { key: Key::Named(Named::Shift), .. }));
                let key = styk_ui::message::editor_key(event, ignored).map_or_else(Task::none, |message| styk_ui::message::update_at(&mut self.core, message, now).map(Message::Editor));
                if shift { Task::batch([key, self.dock(styk_core::dock::Event::Shift(false), now)]) } else { key }
            }
            Event::Mouse(mouse::Event::ButtonPressed(_)) => {
                self.shell.focus.pointer_pressed();
                Task::none()
            }
            Event::Window(window::Event::Unfocused) => {
                let shell = self.dispatch(E::Blurred);
                Task::batch([shell, self.dock(styk_core::dock::Event::Blur, now), styk_ui::message::update_at(&mut self.core, styk_core::commands::Command::Blur.into(), now).map(Message::Editor)])
            }
            _ => Task::none(),
        }
    }

    /// A key that belongs to the dock (`styk_ui::dock::key`): what the dock sends it is sent, what it only notes is noted.
    fn dock_key(&mut self, key: &Key) -> Option<Task<Message>> {
        let now = self.now();
        match styk_ui::dock::key(self.core.dock(), key) {
            styk_ui::dock::Key::Pass => None,
            styk_ui::dock::Key::Swallow => Some(Task::none()),
            styk_ui::dock::Key::Send(event) => Some(self.dock(event, now)),
            styk_ui::dock::Key::Note(event) => {
                drop(self.dock(event, now));
                None
            }
        }
    }

    /// A frame was drawn.
    /// Starts the next queued open when the host is free, and takes what the host has finished (`poll`, nonblocking). A
    /// project the tabs refuse (the thirteenth) is the host's to dispose of on its worker, and comes back as a failure.
    fn pump(&mut self) -> Task<Message> {
        let expired = self.core.session_end_tick(self.clock.now());
        if self.core.session_end_expired() { return styk_ui::message::run(expired).map(Message::Editor); }
        let mut tasks = Vec::new();
        if let Some(effect) = self.core.poll_document() {
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
            match self.core.dispatch_document(request) {
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
        let wake = styk_ui::message::update(&mut self.core, styk_core::commands::Command::Wake { now }.into()).map(Message::Editor);
        let tick = Task::batch([pumped, wake, self.dispatch(shell::Event::Tick(now))]);
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
                    if self.core.documents.active().is_none() { return Err("no project is open".into()); }
                    let now = self.now();
                    let command = styk_core::commands::Command::Timeline(styk_core::timeline::Event::Action { id: styk_core::commands::CommandId::TimelineSetFps, payload: styk_core::timeline::Payload::Number(f64::from(fps)), now });
                    (Vec::new(), styk_ui::message::update(&mut self.core, command.into()).map(Message::Editor))
                }
                Step::Advance(nanos) => {
                    let Some(fixed) = &self.fixed else { return Err("advance needs --clock fixed: the system clock cannot be moved".to_string()) };
                    fixed.advance(std::time::Duration::from_nanos(nanos));
                    // The strip's deadlines follow the clock at once, not at the next frame.
                    let now = self.now();
                    let wake = styk_ui::message::update_at(&mut self.core, styk_core::commands::Command::Wake { now }.into(), now).map(Message::Editor);
                    (Vec::new(), Task::batch([wake, self.dispatch(E::Tick(now)), styk_ui::message::update_at(&mut self.core,
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
                Step::Dock(step) => (Vec::new(), self.dock_step(step)?),
                Step::Menu(step) => (Vec::new(), self.menu_step(step)?),
                Step::Screenshot(path) => {
                    if let Some(run) = &mut self.run {
                        run.capturing = true;
                    }
                    (vec![Request::Capture(resolved(path))], Task::none())
                }
                other => {
                    let event = styk_core::stage::Event::from_step(&other).ok_or_else(|| format!("this build cannot run the step {other:?}"))?;
                    (Vec::new(), styk_ui::message::update(&mut self.core, styk_core::commands::Command::Stage(event).into()).map(Message::Editor))
                }
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
            Expect::Menus(count) => same("the open menus", count.to_string(), self.core.overlays().menus().len().to_string()),
            Expect::History(depth) => same("the undo history", depth.to_string(), self.core.documents.active().and_then(|document| document.view().ok()).map_or(0, |view| view.history.undo).to_string()),
            Expect::Dock(expectation) => self.check_dock(expectation),
            other => Err(format!("this build cannot check {other:?}")),
        }
    }

    /// A step in an open menu: the overlay host's own hover or press on the row `label` names in the menu opened last.
    fn menu_step(&mut self, step: automation::MenuStep) -> Result<Task<Message>, String> {
        use styk_core::overlay::{host::Event as Overlay, menu::Entry};
        let now = self.now();
        let (label, press) = match &step {
            automation::MenuStep::Hover(label) => (label.clone(), false),
            automation::MenuStep::Press(label) => (label.clone(), true),
            _ => return Err("this build cannot run that menu step".to_string()),
        };
        let open = self.core.overlays().menus().last().ok_or("no menu is open")?;
        let index = open.entries().iter().filter_map(|entry| if let Entry::Item(item) = entry { Some(item) } else { None }).position(|item| item.label == label).ok_or_else(|| format!("the open menu has no row {label}"))?;
        let menu = open.id();
        let event = if press { Overlay::Press { menu, index } } else { Overlay::Hover { menu, index } };
        Ok(styk_ui::message::update_at(&mut self.core, styk_ui::Message::Command(styk_core::commands::Command::Overlay { event, now }), now).map(Message::Editor))
    }

    /// A step in the docked window: the presses, moves and releases a person's pointer makes, sent through the same handler
    /// the widgets' messages reach.
    fn dock_step(&mut self, step: automation::DockStep) -> Result<Task<Message>, String> {
        use automation::DockStep;
        use styk_core::dock::Event as D;
        use styk_core::layout::Rect as Place;
        let now = self.now();
        let (window, solution) = (self.core.dock().window(), self.core.dock().solution().clone());
        let group_of = |kind: &str| -> Result<(styk_core::layout::GroupId, usize), String> {
            self.core.dock().layout().groups().into_iter().find_map(|g| g.tabs.iter().position(|p| p.kind == kind).map(|tab| (g.id, tab))).ok_or_else(|| format!("{kind} is in no group"))
        };
        let rect_of = |group: styk_core::layout::GroupId| -> Result<Place, String> { solution.groups.get(&group).copied().ok_or_else(|| "that group is not shown".to_string()) };
        let events: Vec<D> = match step {
            DockStep::Drag { panel, to } => {
                let (group, tab) = group_of(&panel)?;
                let header = solution.headers.get(&group).copied().ok_or("that panel has no header")?;
                let (x, y) = (header.x + 24.0, header.y + 22.0);
                let target = match to.as_str() {
                    "edge-left" => (4.0, window.h / 2.0),
                    "edge-right" => (window.w - 4.0, window.h / 2.0),
                    "edge-top" => (window.w / 2.0, 4.0),
                    "edge-bottom" => (window.w / 2.0, window.h - 4.0),
                    other => {
                        let (kind, side) = other.split_once(':').map_or((other, None), |(kind, side)| (kind, Some(side)));
                        let r = rect_of(group_of(kind)?.0)?;
                        match side {
                            None => (r.x + r.w / 2.0, r.y + r.h / 2.0),
                            Some("left") => (r.x + r.w * 0.1, r.y + r.h / 2.0),
                            Some("right") => (r.x + r.w * 0.9, r.y + r.h / 2.0),
                            Some("above") => (r.x + r.w / 2.0, r.y + r.h * 0.1),
                            Some("below") => (r.x + r.w / 2.0, r.y + r.h * 0.9),
                            Some(side) => return Err(format!("{side:?} is not a side: left, right, above or below")),
                        }
                    }
                };
                vec![D::HeaderPressed { group, tab: Some(tab), x, y }, D::PointerMoved { x: x + 12.0, y: y + 12.0 }, D::PointerMoved { x: target.0, y: target.1 }, D::PointerReleased]
            }
            DockStep::Resize(delta) => {
                let divider = self.core.dock().dividers().into_iter().find(|d| d.axis == styk_core::layout::Axis::Horizontal).ok_or("there is no column divider")?;
                vec![D::DividerPressed { split: divider.split, index: divider.index }, D::DividerMoved(delta), D::DividerReleased]
            }
            DockStep::Collapse(panel) => {
                let (group, _) = group_of(&panel)?;
                let header = solution.headers.get(&group).copied().ok_or("that panel has no header")?;
                let (x, y) = (header.x + header.w - 12.0, header.y + 22.0);
                vec![D::HeaderPressed { group, tab: None, x, y }, D::PointerReleased, D::HeaderPressed { group, tab: None, x, y }, D::PointerReleased]
            }
            DockStep::Undo => vec![D::Undo],
            other => return Err(format!("this build cannot run the dock step {other:?}")),
        };
        Ok(Task::batch(events.into_iter().map(|event| self.dock(event, now)).collect::<Vec<_>>()))
    }

    fn check_dock(&self, expectation: &automation::DockExpect) -> Result<(), String> {
        use automation::DockExpect;
        let dock = self.core.dock();
        let group_of = |kind: &str| dock.layout().groups().into_iter().find(|g| g.tabs.iter().any(|p| p.kind == kind)).ok_or_else(|| format!("{kind} is in no group"));
        match expectation {
            DockExpect::Rect { panel, rect } => {
                let group = group_of(panel)?;
                let found = dock.solution().groups.get(&group.id).or(dock.solution().strips.get(&group.id)).copied().ok_or("that group is not shown")?;
                let (a, b) = ([found.x, found.y, found.w, found.h], rect.map(f64::from));
                if a.iter().zip(b).all(|(a, b)| (a - b).abs() <= 1.0) { Ok(()) } else { Err(format!("expected {panel}'s group at {b:?}, found {a:?}")) }
            }
            DockExpect::Modified(wanted) => if dock.modified() == *wanted { Ok(()) } else { Err(format!("expected the layout modified {wanted}, found {}", dock.modified())) },
            DockExpect::Tabs { panel, count } => {
                let found = group_of(panel)?.tabs.len();
                if found == *count { Ok(()) } else { Err(format!("expected {count} tabs with {panel}, found {found}")) }
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
        let top = match TopBand::with_storage(Size::new(1560.0, 900.0), Arc::new(fixed.clone()), Some(fixed.clone()), Arc::new(styk_platform::spawn::ThreadSpawner), Arc::new(styk_services::storage::fake::MemoryStorage::default())) {
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
        let mut real = match TopBand::with_storage(Size::new(1560.0, 900.0), Arc::new(styk_platform::clock::SystemClock::new()), None, Arc::new(styk_platform::spawn::ThreadSpawner), Arc::new(styk_services::storage::fake::MemoryStorage::default())) {
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

    /// The docked window's interaction script, run step by step through the dock's handler: the drag of a tab, the held
    /// divider, the undo.
    #[test]
    fn the_dock_interaction_script_runs_through_the_one_handler() {
        let (mut top, _) = band();
        top.run = Some(Run { steps: Vec::new(), next: 0, settle: 0, base: PathBuf::new(), failures: Vec::new(), capturing: false });
        let script = Script::parse(include_str!("../automation/dock-interaction.script")).unwrap();
        for (line, step) in script.steps {
            match step {
                Step::Resize(width, height) => top.resized(Size::new(width as f32, height as f32), 1.0),
                Step::Wait(_) | Step::Screenshot(_) => {}
                step => drop(top.execute(line, step)),
            }
        }
        let failures = top.run.as_ref().unwrap().failures.clone();
        assert!(failures.is_empty(), "{failures:#?}");
    }

    /// Mounts the window as `window.rs` stacks it (the band, then the overlay layer) and lets `act` drive it; every message that
    /// came out goes through the production update, then the walk of the tree reaches the core as the runtime's task does.
    fn drive(top: &mut TopBand, act: impl FnOnce(&mut styk_design::widgets::testing::Driver<'_, Message>)) {
        fn mount(top: &TopBand) -> iced::Element<'_, Message> {
            let ready = warm_up::install_bundled(Default::default());
            iced::widget::stack![top.view(Theme::Light, ready, MaxButtonState::Idle, iced::widget::Space::new().boxed()), top.overlay_layer(Theme::Light)].boxed()
        }
        let messages = {
            let mut driver = styk_design::widgets::testing::Driver::new(mount(top), Size::new(1560.0, 900.0), &styk_design::fonts::ALL);
            act(&mut driver);
            let mut messages = driver.messages();
            messages.extend(driver.run(TopBand::snapshot()));
            messages
        };
        // The tasks the updates ask for (focus moves) run on the tree the new state mounts, as the runtime does.
        let tasks: Vec<Task<Message>> = messages.into_iter().map(|message| top.update(message).1).collect();
        let messages = {
            let mut driver = styk_design::widgets::testing::Driver::new(mount(top), Size::new(1560.0, 900.0), &styk_design::fonts::ALL);
            let mut messages = Vec::new();
            for task in tasks { messages.extend(driver.run(task)); }
            messages.extend(driver.run(TopBand::snapshot()));
            messages
        };
        for message in messages {
            let _ = top.update(message);
        }
    }

    fn click_focus(top: &mut TopBand, id: styk_core::focus::FocusId) {
        drive(top, |driver| {
            let at = driver.snapshot().bounds_of(id).unwrap_or_else(|| panic!("{id:?} is mounted")).center();
            driver.click(at);
        });
    }

    /// Clicks the row `label` of the menu opened last, where the mounted layer drew it.
    fn click_row(top: &mut TopBand, label: &str) {
        use styk_core::overlay::menu::Entry;
        let open = top.core.overlays().menus().last().expect("a menu is open");
        let index = open.entries().iter().filter_map(|entry| if let Entry::Item(item) = entry { Some(item) } else { None }).position(|item| item.label == label).unwrap_or_else(|| panic!("a row {label}"));
        let id = styk_core::overlay::host::row_id(open.id(), index);
        // The rows are measured by a walk before they can be pointed at.
        drive(top, |_| {});
        click_focus(top, id);
    }

    #[test]
    fn the_mounted_mark_opens_its_menu_a_clicked_row_runs_its_command_and_a_second_press_closes_it() {
        let (mut top, _) = band();
        open(&mut top, 1);
        let _ = top.execute(1, Step::Edit(30));
        settle_from_workers(&mut top);
        assert_eq!(styk_core::testing::undo_depth(&top.core), 1);
        drive(&mut top, |_| {});
        click_focus(&mut top, ids::MARK);
        assert!(top.core.overlays().menu_of(ids::MARK).is_some(), "a click on the mounted mark opened the menu");
        click_row(&mut top, "Edit");
        assert_eq!(top.core.overlays().menus().len(), 2, "a click on a submenu row opened its menu");
        click_row(&mut top, "Undo");
        assert_eq!(styk_core::testing::undo_depth(&top.core), 0, "a click on Undo ran it on the project in front, through Core::dispatch");
        assert!(top.core.overlays().menus().is_empty(), "choosing a command closed the tree");
        // The second press of the mark closes the menu, and the release that follows does not open it again.
        click_focus(&mut top, ids::MARK);
        assert_eq!(top.core.overlays().menus().len(), 1);
        click_focus(&mut top, ids::MARK);
        assert!(top.core.overlays().menus().is_empty(), "the mark's second click closes its menu");
    }

    /// The application menus' interaction script, run step by step through the handlers the widgets reach: the mark opens its
    /// menu, a hover opens a submenu, rows run Undo and Redo on the project in front, an unported row closes the menu, and the
    /// mark's second press closes it.
    #[test]
    fn the_menu_interaction_script_runs_through_the_one_handler() {
        let (mut top, _) = band();
        top.run = Some(Run { steps: Vec::new(), next: 0, settle: 0, base: PathBuf::new(), failures: Vec::new(), capturing: false });
        let script = Script::parse(include_str!("../automation/menu-interaction.script")).unwrap();
        for (line, step) in script.steps {
            match step {
                Step::Open(_) => open(&mut top, 1),
                Step::Resize(width, height) => top.resized(Size::new(width as f32, height as f32), 1.0),
                Step::Wait(_) | Step::Screenshot(_) => {}
                step @ Step::Edit(_) => {
                    drop(top.execute(line, step));
                    settle_from_workers(&mut top);
                }
                step => drop(top.execute(line, step)),
            }
        }
        let failures = top.run.as_ref().unwrap().failures.clone();
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn the_dock_shows_the_arrangement_of_the_workspace_the_band_presses() {
        use styk_core::layout::Workspace as Arrangement;
        let (mut top, _) = band();
        assert_eq!(top.core.dock().workspace(), Arrangement::Animate);
        for (name, wanted) in [("draw", Arrangement::Draw), ("build", Arrangement::Rig), ("animate", Arrangement::Animate)] {
            let _ = top.click(Target::Workspace(name.to_string())).unwrap();
            let _ = top.update(Message::Frame);
            assert_eq!(top.core.dock().workspace(), wanted, "{name}");
        }
    }

    #[test]
    fn the_band_properties_command_reaches_the_dock_sheet() {
        let (mut top, _) = band();
        let size = Size::new(720., 800.);
        top.resized(size, 1.);
        let ready = warm_up::install_bundled(Default::default());
        assert_eq!(top.core.dock().open(), None);
        for wanted in [Some(2), None] {
            let messages = {
                let element = top.view(Theme::Light, ready, MaxButtonState::Idle, iced::widget::Space::new().boxed());
                let mut driver = styk_design::widgets::testing::Driver::new(element, size, &styk_design::fonts::ALL);
                let bounds = driver.snapshot().bounds_of(ids::PROPERTIES).expect("the mounted Properties opener");
                driver.click(bounds.center());
                driver.messages()
            };
            assert!(messages.iter().any(|m| matches!(m, Message::Ui(view::Message::Shell(shell::Event::Properties)))));
            for message in messages { drop(top.update(message)); }
            assert_eq!(top.core.dock().open(), wanted, "mounted opener reaches Shell, TopBand and Core");
            if wanted.is_some() { assert!(top.core.dock().solution().visible.contains(&styk_core::layout::PanelId::new("properties"))); }
        }
    }

    #[test]
    fn production_layout_stamps_use_wall_time_and_distinct_session_writers() {
        let (mut first, _) = band();
        let (mut second, _) = band();
        let mut stamps = Vec::new();
        for top in [&mut first, &mut second] {
            let before = top.wall.unix_millis();
            drop(top.update(Message::Editor(styk_ui::Message::Command(styk_core::commands::Command::Dock(styk_core::dock::Event::Close(styk_core::layout::PanelId::new("vfx")))))));
            let after = top.wall.unix_millis();
            let file = top.core.dock_mut().take_save(200).expect("fixed monotonic clock's 200ms debounce");
            let stamp = file.workspaces["animate"].stamp.clone();
            assert!(stamp.millis >= before && stamp.millis <= after);
            assert!(stamp.millis > 1_600_000_000_000, "Unix epoch time, not process elapsed time");
            stamps.push(stamp);
        }
        assert_ne!(stamps[0].writer, stamps[1].writer);
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
    // The same stream subscribed by the window, with a generous hang guard instead of synthetic frame polls.
    fn worker_message(top: &TopBand) -> Message {
        use iced::futures::Stream;
        struct Wake(std::sync::mpsc::SyncSender<()>);
        impl std::task::Wake for Wake { fn wake(self: Arc<Self>) { let _ = self.0.try_send(()); } }
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let waker = std::task::Waker::from(Arc::new(Wake(send)));
        let mut stream = std::pin::pin!(progress_stream(&top.progress));
        loop {
            if let std::task::Poll::Ready(Some(message)) = stream.as_mut().poll_next(&mut std::task::Context::from_waker(&waker)) { return message; }
            receive.recv_timeout(Duration::from_secs(30)).expect("production worker must wake the subscribed window");
        }
    }
    fn settle_from_workers(top: &mut TopBand) {
        let until = std::time::Instant::now() + Duration::from_secs(30);
        while !top.idle() {
            assert!(std::time::Instant::now() < until, "worker completions must settle through the real handler");
            let message = worker_message(top);
            let _ = top.update(message);
        }
    }
    #[test]
    fn pending_document_work_keeps_progress_subscription_without_polling_frames() {
        use iced::{advanced::subscription::{into_recipes, Event as SubscriptionEvent}, futures::{StreamExt, task::noop_waker}};
        use styk_services::Spawner;
        #[derive(Default)]
        struct HeldDocuments(std::sync::Mutex<Option<styk_services::Job>>);
        impl Spawner for HeldDocuments {
            fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
                if name == "styk-documents" { assert!(self.0.lock().unwrap().replace(job).is_none()); Ok(()) }
                else { styk_platform::spawn::ThreadSpawner.spawn(name, job) }
            }
        }
        struct Release(Arc<HeldDocuments>);
        impl Drop for Release {
            fn drop(&mut self) {
                if let Some(job) = self.0.0.lock().unwrap().take() {
                    styk_platform::spawn::ThreadSpawner.spawn("styk-documents", job).unwrap();
                }
            }
        }
        // Feed one real redraw to the installed recipes. Inspect emitted messages,
        // not their number: additional worker subscriptions must remain harmless.
        let redraw = |top: &TopBand| {
            let waker = noop_waker();
            let mut context = std::task::Context::from_waker(&waker);
            into_recipes(top.subscription()).into_iter().filter_map(|recipe| {
                let event = SubscriptionEvent::Interaction {
                    window: window::Id::unique(),
                    event: Event::Window(window::Event::RedrawRequested(std::time::Instant::now())),
                    status: iced::event::Status::Ignored,
                };
                let input = iced::futures::stream::iter([event]).chain(iced::futures::stream::pending());
                let mut stream = recipe.stream(Box::pin(input));
                match stream.as_mut().poll_next(&mut context) {
                    std::task::Poll::Ready(Some(message)) => Some(message), _ => None,
                }
            }).collect::<Vec<_>>()
        };
        let held = Arc::new(HeldDocuments::default());
        let release = Release(held.clone());
        let clock = FixedClock::new();
        let mut top = TopBand::with_storage(Size::new(1560., 900.), Arc::new(clock.clone()), Some(clock), held, Arc::new(styk_services::storage::fake::MemoryStorage::default())).unwrap();
        top.open_all(&[fixture()]);
        let _ = top.pump();
        assert!(!top.idle(), "automation must still wait for the pending document");
        let mut messages = redraw(&top);
        assert!(!messages.iter().any(|message| matches!(message, Message::Frame)), "pending workers must not poll frames on redraw");
        top.run = Some(Run { steps: Vec::new(), next: 0, settle: 0, base: PathBuf::new(), failures: Vec::new(), capturing: false });
        messages.extend(redraw(&top));
        assert!(!messages.iter().any(|message| matches!(message, Message::Frame)), "automation also waits for Progress during work");
        top.run = None;
        // Preserve any actual worker message consumed while inspecting the subscriptions.
        for message in messages { let _ = top.update(message); }
        drop(release);
        settle_from_workers(&mut top);
        assert!(top.core.stage().is_some(), "the production Progress handler completes opening without frame polling");
    }

    #[test]
    fn mounted_stage_keyboard_uses_registry_and_worker_wake_without_frame_polling() {
        use styk_design::widgets::testing::Driver;
        let (mut top, _) = band();
        top.open_all(&[fixture()]); let _ = top.pump(); settle_from_workers(&mut top);
        let element = styk_ui::stage::view(&top.core, Theme::Light).expect("published document has the real stage widget");
        let mut driver = Driver::new(element, Size::new(960.,540.), &styk_design::fonts::ALL);
        driver.point_at((300.,200.));
        let mut event = arrow(Named::ArrowRight, Modifiers::default());
        if let Event::Keyboard(keyboard::Event::KeyPressed { physical_key, key, modified_key, .. }) = &mut event {
            *physical_key = Physical::Code(iced::keyboard::key::Code::Period);
            *key = Key::Character(".".into()); *modified_key = key.clone();
        }
        let statuses = driver.events(&[event.clone()]);
        for message in driver.messages() { let _ = top.update(Message::Editor(message)); }
        let _ = top.update(Message::Raw(event.clone(), statuses[0] == iced::event::Status::Ignored));
        assert!(top.core.timeline().model().pending, "native command runs on the document worker");
        settle_from_workers(&mut top);
        assert_eq!(top.core.documents.active().unwrap().view().unwrap().tick, 1., "physical Period traversed the production adapter, registry, Core and completion handler");
        assert_eq!(top.core.timeline().model().tick, 1.);
        // A child that handled its input keeps it: the global adapter must not execute it again.
        let _ = top.update(Message::Raw(event, false));
        assert!(!top.core.timeline().model().pending);
        assert_eq!(top.core.timeline().model().tick, 1.);
        let _ = top.execute(1, Step::Edit(31)); settle_from_workers(&mut top);
        assert_eq!(top.core.timeline().model().fps, 31.);
        assert_eq!(styk_core::testing::undo_depth(&top.core), 1);
        let _ = top.execute(2, Step::Frame(4.)); settle_from_workers(&mut top);
        assert_eq!(top.core.documents.active().unwrap().view().unwrap().tick, 4., "automation uses the same session playhead");
    }

}
