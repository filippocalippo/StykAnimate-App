#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types))]
//! `stykanimate`: the StykAnimate program.
//!
//! ```text
//! stykanimate [file] [--automation <script>] [--screenshot <png>] [--size WxH] [--scale <factor>] [--shell-check]
//! ```
//!
//! This crate is the wiring: it reads the command line (`styk-core`), picks the platform services (`styk-platform`),
//! and runs the interface (`styk-ui`) in a window. Nothing here decides what the application does.
//!
//! `STYK_BACKGROUND_WINDOW=1` keeps a run off the desktop of the person at the computer, the way each platform allows
//! (`styk_platform::unattended`): Windows opens the window off-screen without focus or a taskbar entry, X11 opens an
//! override-redirect window off-screen, and Wayland and macOS open no window and draw offscreen ([`headless`]).
//! `STYK_BACKGROUND_WINDOW=headless` does that everywhere. `--screenshot` waits for the first complete frame, writes it
//! as a PNG and exits.
//!
//! The shell (`shell`, `docs/native/shell.md`): which instance this is, the frameless window's chrome, its saved frame,
//! and what later starts ask of it. `--shell-check` asks the real window about it, in process.

mod headless;
#[cfg(test)]
mod recovery_wiring_tests;
#[cfg(test)]
mod stage_widget_tests;
#[cfg(feature = "devtools")]
mod input_check;
use styk_platform::{screenshot, shell, shell_check};
mod top_band;
mod overlay_wake;
mod wakes;
mod window;

use iced::futures::StreamExt;
use iced::{Size, Subscription, Task, Widget, window as iced_window};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::mpsc::{self, SyncSender};
use std::time::Duration;
use styk_core::Launch;
use styk_design::{Theme, glyphs, warm_up, widgets};
use styk_platform::unattended::{self, Strategy};
use styk_platform::window::{self as platform, Image, WindowError};
use styk_services::shell::chrome::{MaxButtonState, band_regions};
use styk_trace::mark;
use styk_ui::component_sheet::{self, Sheet};
use styk_ui::screens::Screen;

/// How long `--screenshot` waits for a first frame before giving up. A window that never draws is a defect to report,
/// not a reason to hang a script.
const SCREENSHOT_DEADLINE: Duration = Duration::from_secs(30);

/// How long `--shell-check` waits for its steps before giving up.
const CHECK_DEADLINE: Duration = Duration::from_secs(60);

/// The frame at which `--shell-check` asks its synchronous questions, and how many frames it waits for the events the
/// DPI step causes.
const CHECK_AT_FRAME: u32 = 12;
const CHECK_SETTLE_FRAMES: u32 = 12;

/// How long `--automation` waits for its script before giving up.
const AUTOMATION_DEADLINE: Duration = Duration::from_secs(180);

#[global_allocator]
static ALLOCATOR: styk_core::engine::Counting = styk_core::engine::Counting;

/// How an unattended run ended, read after the event loop returns.
#[derive(Debug, Default)]
enum Outcome {
    #[default]
    Running,
    Done,
    Failed(String),
}

/// One answer of `--shell-check`: what was checked, and what was wrong if anything.
type CheckLine = (String, Option<String>);

#[derive(Debug, Clone)]
enum Message {
    Sheet(component_sheet::Message),
    #[cfg(feature = "devtools")]
    Check(input_check::Step),
    Window(iced_window::Id, iced_window::Event),
    Shown(Result<(), WindowError>),
    Attached(Result<shell::Attached, String>),
    Sampled(shell::Sample),
    Wake(shell::Wake),
    /// Translated by the platform window procedure, including a forced session end.
    SessionEnd,
    /// The top band: the projects, the shell and the automation (`top_band`).
    Band(top_band::Message),
    /// A screenshot of an automation step is written.
    StepSaved(Result<(), String>),
    Frame,
    /// The font system is built and holds the bundled fonts: text may be laid out.
    FontsReady(Result<(), String>),
    /// The glyph worker has completed a candidate frame.
    GlyphsReady,
    Captured(Result<Image, String>),
    OutputSaved(Result<(), String>),
    /// `--shell-check`'s synchronous answers, and what the DPI step needs afterwards.
    Checked(Vec<CheckLine>, Option<CheckedDpi>),
    /// `--shell-check` is over: the final report.
    CheckDone(Vec<CheckLine>),
}

/// The DPI step of `--shell-check`, between the message and its judgement.
#[derive(Debug, Clone, Copy)]
struct CheckedDpi {
    before: (i32, i32),
    after: (i32, i32),
    original: styk_services::shell::Rect,
}

struct App {
    launch: Launch,
    theme: Theme,
    strategy: Option<Strategy>,
    window: Option<iced_window::Id>,
    /// Whether the font system is ready. Until it is, the view holds no text (`styk_design::warm_up`).
    fonts_ready: bool,
    /// Frames the event loop has started since the window was shown.
    frames: u32,
    capturing: bool,
    outcome: SyncSender<Outcome>,
    /// The screen of the catalogue being shown instead of the application, if any.
    sheet: Option<Sheet>,
    /// What the input check has seen so far.
    #[cfg(feature = "devtools")]
    report: Vec<String>,
    /// When each redraw started, for the check's latency figures.
    #[cfg(feature = "devtools")]
    frame_times: Vec<std::time::Instant>,
    /// The characters the field held when a latency run began.
    #[cfg(feature = "devtools")]
    latency_base: usize,
    shell: Box<shell::Shell>,
    wakes: wakes::Wakes,
    chrome: Option<shell::Chrome>,
    max_button: MaxButtonState,
    band: top_band::TopBand,
    /// Where the window is captured to for the automation, while it is.
    capture_path: Option<std::path::PathBuf>,
    closing: bool,
    /// The documents host has answered for every project: closing no longer asks.
    quit_cleared: bool,
    /// The window's logical size and scale factor, as the interface was last told.
    logical: Size,
    scale: f32,
    /// Every scale factor the window announced, for `--shell-check`.
    rescales: Vec<f32>,
    foreground_before: isize,
    check: CheckStep,
}

/// Where `--shell-check` is.
#[derive(Debug)]
enum CheckStep {
    NotRunning,
    Asked,
    Settling { until_frame: u32, dpi: Option<CheckedDpi>, logical_before: (f32, f32), lines: Vec<CheckLine> },
}

impl App {
    fn new(launch: Launch, screen: Option<Screen>, strategy: Option<Strategy>, outcome: SyncSender<Outcome>, shell: Box<shell::Shell>, wakes: wakes::Wakes, foreground_before: isize) -> Result<App, String> {
        let sheet = screen.filter(|screen| matches!(screen, Screen::ComponentSheet | Screen::Controls(_) | Screen::Overlay(..) | Screen::Recovery(..))).map(|screen| {
            let mut sheet = if let Screen::ComponentSheet = screen { Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr) } else { Sheet::for_screen(screen).unwrap_or_else(|| Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr)) };
            sheet.button_probe = Some(styk_platform::input::primary_button_down);
            sheet
        });
        let band_screen = screen.filter(|screen| screen.has_band());
        let clock_mode = launch.clock;
        // The one application clock: the real one, or the fixed one a script advances (`--clock fixed`).
        let (clock, fixed): (Arc<dyn styk_services::clock::Clock>, Option<styk_services::clock::FixedClock>) = match clock_mode {
            styk_core::ClockMode::Fixed => {
                let fixed = styk_services::clock::FixedClock::new();
                (Arc::new(fixed.clone()), Some(fixed))
            }
            styk_core::ClockMode::System => (Arc::new(styk_platform::clock::SystemClock::new()), None),
        };
        // Recovery belongs to a real run: a screen, a script or an unattended test never lists or writes the person's copies. The
        // primary window keeps them in the profile, an independent one in its workspace (`docs/native/recovery.md`).
        let recovery = (screen.is_none() && strategy.is_none() && launch.automation.is_none()).then(|| shell.recovery_directory()).flatten();
        let recovery = recovery.map(|path| Arc::new(styk_platform::recovery::LocalRecovery::new(path)) as Arc<dyn styk_services::recovery::Recovery>);
        let spawner: Arc<dyn styk_services::Spawner> = Arc::new(styk_platform::spawn::ThreadSpawner);
        // Screens and unattended runs never read or change the person's preferences.
        let preferences: Option<Arc<dyn styk_services::storage::Storage>> = if screen.is_none() && strategy.is_none() && launch.automation.is_none() {
            Some(Arc::new(styk_platform::storage::LocalStorage::for_user(spawner.as_ref()).map_err(|error| error.to_string())?))
        } else { None };
        let layouts = preferences.clone().map(|store| Arc::new(styk_core::layout::LayoutStore::new(store)));
        let mut band = top_band::TopBand::new(Size::new(window::DEFAULT_SIZE.0 as f32, window::DEFAULT_SIZE.1 as f32), clock, fixed, spawner, wakes.callback(), recovery, layouts, preferences)?;
        band.show_screen(band_screen);
        Ok(App {
            sheet,
            #[cfg(feature = "devtools")]
            report: Vec::new(),
            #[cfg(feature = "devtools")]
            frame_times: Vec::new(),
            #[cfg(feature = "devtools")]
            latency_base: 0,
            launch,
            theme: band_screen.map_or(Theme::default(), Screen::theme),
            strategy,
            window: None,
            fonts_ready: false,
            frames: 0,
            capturing: false,
            outcome,
            shell,
            wakes,
            chrome: None,
            max_button: MaxButtonState::Idle,
            band,
            capture_path: None,
            closing: false,
            quit_cleared: false,
            logical: Size::new(window::DEFAULT_SIZE.0 as f32, window::DEFAULT_SIZE.1 as f32),
            scale: 1.0,
            rescales: Vec::new(),
            foreground_before,
            check: CheckStep::NotRunning,
        })
    }

    fn theme(&self) -> Theme {
        self.sheet.as_ref().map_or(self.theme, |sheet| sheet.theme)
    }

    /// Tells the window where the band's controls are, in physical client pixels.
    fn publish_regions(&self) {
        if let Some(chrome) = &self.chrome {
            let width = (self.logical.width * self.scale).round() as i32;
            chrome.publish(band_regions(width, self.scale, self.band.height(), self.band.controls_folded(), &self.band.no_drag(self.scale)));
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Sheet(message) => match self.sheet.as_mut() {
                Some(sheet) => sheet.update(message).map(Message::Sheet),
                None => Task::none(),
            },
            #[cfg(feature = "devtools")]
            Message::Check(step) => self.check(step),
            Message::Window(id, event) => self.window_event(id, event),
            Message::Shown(Ok(())) => Task::none(),
            Message::Shown(Err(error)) => self.finish(Outcome::Failed(format!("could not show the window: {error}"))),
            Message::Attached(Ok(attached)) => {
                let wakes = self.wakes.clone();
                attached.chrome.on_change(move || wakes.send(shell::Wake::Chrome));
                self.chrome = Some(attached.chrome);
                if let Some(frame) = attached.applied {
                    self.shell.assume(&frame);
                }
                self.shell.observe(attached.sample);
                self.publish_regions();
                Task::none()
            }
            Message::Attached(Err(error)) => self.finish(Outcome::Failed(format!("could not attach the window's chrome: {error}"))),
            Message::Sampled(sample) => {
                self.shell.observe(sample);
                self.shell.changed(&self.wakes.callback());
                Task::none()
            }
            Message::Wake(wake) => self.wake(wake),
            Message::SessionEnd if self.quit_cleared => self.finish_session_quit(),
            Message::SessionEnd => self.band.session_end().map(Message::Band),
            Message::Band(message) => self.band_update(message),
            Message::StepSaved(result) => {
                self.band.captured(result);
                Task::none()
            }
            Message::FontsReady(Err(error)) => self.finish(Outcome::Failed(error)),
            Message::FontsReady(Ok(())) => {
                self.fonts_ready = true;
                self.band.fonts_ready();
                self.publish_regions();
                // Loading frames cannot satisfy the two-frame wait for rendered content.
                self.frames = 0;
                Task::none()
            }
            Message::GlyphsReady => Task::none(),
            Message::Frame => self.frame(),
            Message::Captured(Ok(image)) => {
                if let Some(path) = self.capture_path.take() {
                    // A step of the automation: the script goes on, and records a failure rather than ending the run.
                    return step_output_task(move || screenshot::write(&path, &image));
                }
                let Some(path) = self.launch.screenshot.clone() else {
                    return self.finish(Outcome::Failed("capture has no output path".into()));
                };
                output_task(move || screenshot::write(&path, &image))
            }
            Message::OutputSaved(Ok(())) => self.finish(Outcome::Done),
            Message::OutputSaved(Err(error)) => self.finish(Outcome::Failed(error)),
            Message::Captured(Err(error)) => {
                if self.capture_path.take().is_some() {
                    self.band.captured(Err(format!("could not capture the window: {error}")));
                    return Task::none();
                }
                self.finish(Outcome::Failed(format!("could not capture the window: {error}")))
            }
            Message::Checked(lines, dpi) => {
                self.check = CheckStep::Settling { until_frame: self.frames + CHECK_SETTLE_FRAMES, dpi, logical_before: (self.logical.width, self.logical.height), lines };
                Task::none()
            }
            Message::CheckDone(lines) => self.report_check(lines),
        }
    }

    /// A message of the top band, and what it asks of the window.
    fn band_update(&mut self, message: top_band::Message) -> Task<Message> {
        // Document clearance is final: edits during the preference flush would
        // otherwise acquire unsaved work after the person's Save/Discard answer.
        // Worker receipts and deadlines still run until the window has ended.
        if self.quit_cleared && !matches!(&message,
            top_band::Message::Layouts | top_band::Message::Deadline | top_band::Message::Documents | top_band::Message::Progress
            | top_band::Message::Editor(styk_ui::Message::PollDocuments | styk_ui::Message::QuitReady | styk_ui::Message::SessionCheckpointFinished)
        ) { return Task::none(); }
        let (requests, task) = self.band.update(message);
        let mut tasks = vec![task.map(Message::Band)];
        for request in requests {
            match request {
                top_band::Request::Minimize => tasks.extend(self.window.map(|id| iced_window::minimize(id, true))),
                top_band::Request::Close => tasks.push(self.close()),
                top_band::Request::QuitReady => {
                    self.quit_cleared = true;
                    tasks.push(self.close());
                }
                top_band::Request::SessionCheckpointFinished => {
                    if let Some(chrome) = &self.chrome { chrome.finish_session_checkpoint(); }
                }
                top_band::Request::PreferencesProgress => {
                    if self.quit_cleared { tasks.push(self.close()); }
                },
                top_band::Request::Resize(size) => tasks.extend(self.window.map(|id| iced_window::resize(id, size))),
                top_band::Request::Capture(path) => {
                    self.capture_path = Some(path);
                    tasks.extend(self.window.map(capture));
                }
                top_band::Request::Theme(theme) => self.theme = theme,
                top_band::Request::Finished(None) => tasks.push(self.finish(Outcome::Done)),
                top_band::Request::Finished(Some(failures)) => {
                    eprintln!("{failures}");
                    tasks.push(self.finish(Outcome::Failed("the automation script failed".into())));
                }
            }
        }
        self.publish_regions();
        Task::batch(tasks)
    }

    fn window_event(&mut self, id: iced_window::Id, event: iced_window::Event) -> Task<Message> {
        use iced_window::Event;
        match event {
            Event::Opened { size, scale_factor, .. } => {
                self.window = Some(id);
                self.logical = size;
                self.scale = scale_factor;
                self.band.resized(size, scale_factor);
                let owns_show = window::shell_shows(self.strategy);
                let frame = self.shell.restore;
                let shutdown_reason = self.band.core.presentation().text(&styk_core::i18n::Msg::new("common.saving"));
                let attach = iced_window::run(id, move |w| shell::attach(w, frame, owns_show, &shutdown_reason)).map(Message::Attached);
                let shown = if window::shown_after_creation(self.strategy) {
                    Task::batch([iced_window::run(id, |w| platform::show_without_activation(w)).map(Message::Shown), attach])
                } else {
                    attach
                };
                #[cfg(feature = "devtools")]
                if self.launch.input_check.is_some() && self.sheet.is_some() {
                    return Task::batch([shown, input_check::script(id).map(Message::Check)]);
                }
                shown
            }
            Event::Resized(size) => {
                self.logical = size;
                self.band.resized(size, self.scale);
                self.publish_regions();
                self.sample(id)
            }
            Event::Rescaled(scale) => {
                self.scale = scale;
                self.rescales.push(scale);
                self.publish_regions();
                Task::none()
            }
            Event::Moved(_) => self.sample(id),
            Event::CloseRequested => self.close(),
            _ => Task::none(),
        }
    }

    /// Looks at the window on its thread, for the frame to save.
    fn sample(&self, id: iced_window::Id) -> Task<Message> {
        if self.strategy.is_some() {
            return Task::none();
        }
        iced_window::run(id, |w| shell::sample(w)).and_then(|sample| Task::done(Message::Sampled(sample)))
    }


    fn wake(&mut self, wake: shell::Wake) -> Task<Message> {
        match wake {
            shell::Wake::Chrome => {
                let Some(chrome) = &self.chrome else { return Task::none() };
                self.max_button = chrome.max_button();
                let toggles = chrome.take_toggles();
                let session_end = chrome.take_session_end();
                let mut tasks = Vec::new();
                if let Some(id) = self.window { tasks.extend((0..toggles).map(|_| iced_window::toggle_maximize(id))); }
                if session_end { tasks.push(Task::done(Message::SessionEnd)); }
                Task::batch(tasks)
            }

            shell::Wake::Instance => {
                if !self.shell.collect_requests() {
                    return Task::none();
                }
                mark!("launch-request");
                // A later start asked for this program: bring it forward. What the requests mean (opening files, the
                // library link) is the core's, which takes them from `shell.pending` when it exists.
                self.window.map_or_else(Task::none, |id| Task::batch([iced_window::minimize(id, false), iced_window::gain_focus(id)]))
            }
            shell::Wake::SaveCheck => {
                self.shell.save_check(&self.wakes.callback());
                Task::none()
            }
            shell::Wake::Documents => self.band_update(top_band::Message::Documents),
            shell::Wake::Layouts => self.band_update(top_band::Message::Layouts),
        }
    }

    fn close(&mut self) -> Task<Message> {
        // The core's close guard (unsaved work) decides here once documents exist; until then the program ends, once the
        // window state is written (by a worker: the interface thread does not wait for the disk).
        if self.closing {
            return Task::none();
        }
        // The documents host decides first: unsaved projects are asked about (the close prompt) and the recovery lane finishes
        // its copies; an unattended run has no one to ask.
        if self.strategy.is_none() && !self.quit_cleared {
            return self.band.ask_to_quit().map(Message::Band);
        }
        if self.band.core.session_end_requested() { return self.finish_session_quit(); }
        // Documents granted QuitReady. Start both maintenance lanes, even if one is busy.
        // Their receipts continue this same quit sequence; neither admits input.
        let layouts_pending = self.band.flush_layouts();
        let settings_pending = self.band.flush_settings();
        if layouts_pending || settings_pending { return Task::none(); }
        self.closing = true;
        match self.shell.save_for_close() {
            Some(job) => Task::perform(async move {
                let (send, receive) = iced::futures::channel::oneshot::channel();
                job(Box::new(move |result| { if send.send(result).is_err() { eprintln!("window save receiver closed"); } }));
                receive.await.map_err(|error| error.to_string())?
            }, Message::OutputSaved),
            None => self.finish(Outcome::Done),
        }
    }

    fn finish_session_quit(&mut self) -> Task<Message> {
        // Document clearance still comes first. Preferences must never extend
        // an OS shutdown: cancellation leaves the last atomic commit intact.
        self.band.abandon_layouts();
        self.band.abandon_settings();
        self.closing = true;
        if let Some(chrome) = &self.chrome { chrome.allow_session_end(); }
        self.finish(Outcome::Done)
    }

    fn frame(&mut self) -> Task<Message> {
        // A frame that lacks glyphs the worker is still drawing is not the one to capture.
        if glyphs::incomplete() {
            self.frames = 0;
            return Task::none();
        }
        self.frames += 1;
        #[cfg(feature = "devtools")]
        if self.launch.input_check.is_some() {
            self.frame_times.push(std::time::Instant::now());
        }
        let Some(id) = self.window else { return Task::none() };
        // The first frame's event arrives as it is about to be drawn; the second, once that draw is done and the text it
        // shows can be laid out.
        if self.frames >= 2 && self.fonts_ready && self.band.idle() && self.launch.screenshot.is_some() && !self.capturing {
            self.capturing = true;
            mark!("first-frame");
            return capture(id);
        }
        self.check_step(id)
    }

    fn check_step(&mut self, id: iced_window::Id) -> Task<Message> {
        if !self.launch.shell_check {
            return Task::none();
        }
        match &self.check {
            CheckStep::NotRunning if self.frames >= CHECK_AT_FRAME && self.chrome.is_some() && self.fonts_ready => {
                self.check = CheckStep::Asked;
                let Some(chrome) = self.chrome.clone() else { return Task::none() };
                let (scale, logical, foreground) = (self.scale, (self.logical.width, self.logical.height), self.foreground_before);
                iced_window::run(id, move |window| {
                    let original = shell::window_rect(window).unwrap_or(styk_services::shell::Rect::new(-20000, -20000, 1560, 1000));
                    let (lines, dpi) = shell_check::run(window, &chrome, scale, logical, foreground);
                    (lines.into_iter().map(|line| (line.name, line.failure)).collect::<Vec<_>>(), dpi.map(|d| CheckedDpi { before: d.before, after: d.after, original }))
                })
                .map(|(lines, dpi)| Message::Checked(lines, dpi))
            }
            CheckStep::Settling { until_frame, .. } if self.frames >= *until_frame => {
                let CheckStep::Settling { dpi, logical_before, mut lines, .. } = std::mem::replace(&mut self.check, CheckStep::NotRunning) else { unreachable!() };
                let Some(dpi) = dpi else { return self.report_check(lines) };
                let probe = shell_check::DpiProbe { before: dpi.before, after: dpi.after, logical_before };
                lines.extend(shell_check::judge_dpi(probe, (self.logical.width, self.logical.height), &self.rescales).into_iter().map(|line| (line.name, line.failure)));
                let original = dpi.original;
                iced_window::run(id, move |window| {
                    shell_check::restore_dpi(window, 96, original);
                    lines
                })
                .map(Message::CheckDone)
            }
            _ => Task::none(),
        }
    }


    /// Prints the check's results and ends with their status.
    fn report_check(&mut self, lines: Vec<CheckLine>) -> Task<Message> {
        let failed = lines.iter().filter(|(_, failure)| failure.is_some()).count();
        for (name, failure) in &lines {
            match failure {
                None => println!("PASS {name}"),
                Some(why) => println!("FAIL {name}: {why}"),
            }
        }
        println!("shell-check: {} passed, {failed} failed", lines.len() - failed);
        self.finish(if failed == 0 { Outcome::Done } else { Outcome::Failed(format!("{failed} shell checks failed")) })
    }

    /// Records a step of the input check; the last step writes the report and ends the run.
    #[cfg(feature = "devtools")]
    fn check(&mut self, step: input_check::Step) -> Task<Message> {
        let sheet_state = |app: &App| {
            let sheet = app.sheet.as_ref();
            let bounds = sheet.and_then(|s| s.snapshot.bounds_of(styk_ui::component_sheet::ids::NAME));
            let text = sheet.map_or(String::new(), |s| {
                let name: String = s.name.text().chars().take(24).collect();
                format!("{name:?} ({} characters), notes {} characters", s.name.text().chars().count(), s.notes.text().chars().count())
            });
            format!("name field {text}, focused {:?}, composing {}, field bounds {:?}", sheet.and_then(|s| s.focus.focused()), sheet.is_some_and(|s| s.focus.composing()), bounds)
        };
        match step {
            input_check::Step::Probe { label } => {
                let line = format!("{label}: {}", sheet_state(self));
                self.report.push(line);
                Task::none()
            }
            input_check::Step::Result { label, detail } => {
                self.report.push(format!("{label}: {detail}"));
                Task::none()
            }
            input_check::Step::Sheet(message) => Task::done(Message::Sheet(message)),
            input_check::Step::LatencyStart { field } => {
                input_check::latency_start();
                self.frame_times.clear();
                self.latency_base = self.sheet.as_ref().map_or(0, |sheet| sheet.field_len(field));
                Task::none()
            }
            input_check::Step::LatencyEnd { label, field } => {
                let now = self.sheet.as_ref().map_or(0, |sheet| sheet.field_len(field));
                let latency = input_check::latency_summary(&self.frame_times, &input_check::presents(), now.saturating_sub(self.latency_base));
                self.report.push(format!("{label}: {latency}"));
                Task::none()
            }
            input_check::Step::Finish => {
                let body: Vec<String> = self.report.iter().map(|line| format!("  {:?}", line)).collect();
                let json = format!("[\n{}\n]\n", body.join(",\n"));
                let Some(path) = self.launch.input_check.clone() else {
                    return self.finish(Outcome::Failed("input check has no output path".into()));
                };
                output_task(move || styk_platform::diagnostics::write_report(&path, &json))
            }
        }
    }

    fn finish(&mut self, outcome: Outcome) -> Task<Message> {
        if self.outcome.try_send(outcome).is_err() {
            eprintln!("application outcome receiver was closed");
        }
        iced::exit()
    }

    fn view(&self) -> iced::Element<'_, Message> {
        // Text is laid out only once the font system is ready: until then the view holds none.
        match (warm_up::proof(), self.sheet.as_ref()) {
            (Some(_), Some(sheet)) => sheet.view().map(Message::Sheet).boxed(),
            (Some(ready), None) => {
                // The docked window fills the window under the band; the band's own area holds nothing below it.
                let below_band = iced::widget::space().width(iced::Length::Fill).height(iced::Length::Fill).boxed();
                iced::widget::stack![self.band.dock_view(self.theme), self.band.view(self.theme, ready, self.max_button, below_band), self.band.wake_widget(), self.band.overlay_layer(self.theme)].map(Message::Band).boxed()
            }
            (None, _) => styk_ui::prepaint(),
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![iced_window::events().map(|(id, event)| Message::Window(id, event)), Subscription::run_with(self.wakes.clone(), wake_stream), glyphs::ready().map(|()| Message::GlyphsReady)];
        if let Some(sheet) = &self.sheet {
            subscriptions.push(sheet.subscription().map(Message::Sheet));
        } else {
            subscriptions.push(self.band.subscription().map(Message::Band));
        }
        if (!self.capturing && (self.launch.screenshot.is_some() || self.launch.shell_check)) || self.launch.input_check.is_some() {
            subscriptions.push(iced_window::frames().map(|_| Message::Frame));
        }
        Subscription::batch(subscriptions)
    }
}

/// Each shell owns its wake stream; no process-global receiver or blocking lock.
fn wake_stream(wakes: &wakes::Wakes) -> impl iced::futures::Stream<Item = Message> + use<> {
    wakes.clone().stream().map(Message::Wake)
}

/// Captures the window through the operating system's compositor; where the platform has none, from iced's own
/// renderer.
fn capture(id: iced_window::Id) -> Task<Message> {
    iced_window::run(id, |window| platform::capture(window)).then(move |result| match result {
        Ok(image) => Task::done(Message::Captured(Ok(image))),
        Err(WindowError::Unsupported) => iced_window::screenshot(id).map(|shot| Message::Captured(Ok(Image { width: shot.size.width, height: shot.size.height, rgba: shot.rgba.to_vec() }))),
        Err(error) => Task::done(Message::Captured(Err(error.to_string()))),
    })
}

fn main() -> ExitCode {
    styk_core::engine::set_memory_limit(styk_platform::memory::document_memory_limit());
    if iced_wgpu::instance::install(styk_core::stage::gpu_instances).is_err() {
        eprintln!("the application's GPU policy was already installed");
        return ExitCode::FAILURE;
    }
    #[cfg(feature = "devtools")]
    styk_devtools::initialize();
    mark!("startup");
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let launch = match Launch::parse(shell::without_links(&arguments)) {
        Ok(launch) => launch,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let strategy = match unattended::requested_by_environment() {
        Ok(strategy) => strategy,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    #[cfg(feature = "devtools")]
    let _control = if launch.control {
        match styk_devtools::channel::shell_reader() {
            Ok(reader) => Some(reader),
            Err(error) => {
                eprintln!("control channel: {error}");
                return ExitCode::from(2);
            }
        }
    } else {
        None
    };
    #[cfg(not(feature = "devtools"))]
    if launch.control {
        eprintln!("--control requires a developer build");
        return ExitCode::from(2);
    }
    let screen = match launch.screen.as_deref().map(|id| (id, Screen::from_id(id))) {
        Some((id, None)) => {
            eprintln!("unknown screen {id:?}: the catalogue has {}", Screen::ids());
            return ExitCode::from(2);
        }
        Some((_, Some(screen))) => Some(screen),
        None => None,
    };
    if launch.input_check.is_some() && !cfg!(feature = "devtools") {
        eprintln!("--input-check is only in the developer build (--features devtools)");
        return ExitCode::from(2);
    }
    if launch.input_check.is_some() && screen.is_none() {
        eprintln!("--input-check needs --screen component-sheet");
        return ExitCode::from(2);
    }
    if launch.pen_lab {
        return run_pen_lab(&launch, strategy);
    }
    if launch.shell_check && !matches!(strategy, Some(Strategy::HiddenWindow)) {
        eprintln!("--shell-check works on the real window of an unattended Windows run: set STYK_BACKGROUND_WINDOW=1");
        return ExitCode::from(2);
    }
    if strategy == Some(Strategy::Headless) {
        return run_headless(&launch, screen);
    }
    let wakes = wakes::Wakes::new();
    let shell = match shell::start(&arguments, strategy.is_some(), &wakes.callback()) {
        shell::Start::Run(shell) => shell,
        shell::Start::End(code) => return code,
    };
    let foreground_before = shell::foreground();
    let (outcome, receiver) = mpsc::sync_channel(1);
    let _deadline = if launch.screenshot.is_some() || launch.shell_check {
        match styk_platform::diagnostics::deadline(if launch.shell_check { CHECK_DEADLINE } else { SCREENSHOT_DEADLINE }) {
            Ok(deadline) => Some(deadline),
            Err(error) => { eprintln!("{error}"); return ExitCode::FAILURE; }
        }
    } else { None };
    #[cfg(feature = "devtools")]
    let trace_path = launch.screenshot.as_ref().map(|path| path.with_extension("trace.txt"));
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let settings = window::settings(&launch, strategy);
    let files = launch.files.clone();
    let mut built = match App::new(launch, screen, strategy, outcome.clone(), shell, wakes, foreground_before) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let _automation_deadline = match built.launch.automation.clone() {
        Some(script) => {
            if let Err(error) = built.band.run_script(&script) {
                eprintln!("{error}");
                return ExitCode::from(2);
            }
            match styk_platform::diagnostics::deadline(AUTOMATION_DEADLINE) {
                Ok(deadline) => Some(deadline),
                Err(error) => {
                    eprintln!("{error}");
                    return ExitCode::FAILURE;
                }
            }
        }
        None => None,
    };
    let app = std::cell::RefCell::new(Some(built));
    // The font system is built on a worker from the first moment (styk_design::warm_up); the bundled fonts are
    // loaded there, never through iced::Settings::fonts, which the runtime would load on the event loop.
    let result = iced::application(
        move || {
            let mut app = match app.borrow_mut().take() { Some(app) => app, None => unreachable!("iced initializes once") };
            app.band.open_all(&files);
            let layouts = app.band.load_layouts().map(Message::Band);
            (app, Task::batch([layouts, warm_up::warm_up(std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), std::sync::Arc::new(styk_platform::clock::SystemClock::new()), std::sync::Arc::new(styk_platform::font_smoothing::NativeTextEnvironment)).map(Message::FontsReady)]))
        },
        App::update,
        App::view,
    )
    .subscription(App::subscription)
    .title("StykAnimate")
    .theme(|app: &App| styk_ui::base_theme(app.theme()))
    .style(|app: &App, _| if app.fonts_ready { styk_ui::window_style(app.theme()) } else { styk_ui::prepaint_style() })
    .scale_factor(move |_| scale)
    .font(widgets::INTER)
    .window(settings)
    .run();
    if warm_up::built_early() {
        eprintln!("the interface thread built the font system before the warm-up worker did: a text widget was laid out before the fonts were ready");
        return ExitCode::FAILURE;
    }
    #[cfg(feature = "devtools")]
    if let Some(path) = trace_path {
        if let Err(error) = styk_platform::diagnostics::write_report(&path, &styk_devtools::trace_report()) {
            eprintln!("{error}"); return ExitCode::FAILURE;
        }
    }
    let outcome = receiver.try_recv().unwrap_or(Outcome::Running);
    match (result, outcome) {
        (Err(error), _) => {
            eprintln!("the window failed: {error}");
            ExitCode::FAILURE
        }
        (Ok(()), Outcome::Failed(error)) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
        (Ok(()), _) => ExitCode::SUCCESS,
    }
}

/// The pen lab (developer build): a drawing pad on the real input path, and its self-test.
#[cfg(feature = "devtools")]
fn run_pen_lab(launch: &Launch, strategy: Option<Strategy>) -> ExitCode {
    use styk_devtools::pen_lab::{self, LabOptions};
    use styk_text_check::pen_lab::self_test::{SelfTest, Runner};
    if strategy == Some(Strategy::Headless) {
        eprintln!("the pen lab needs a window; it cannot run headless");
        return ExitCode::from(2);
    }
    let self_test = match launch.self_test.as_deref().map(SelfTest::parse).transpose() {
        Ok(test) => test,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if let Some(dir) = &launch.out {
        if let Err(error) = styk_platform::diagnostics::create_output_directory(dir) {
            eprintln!("{}: {error}", dir.display());
            return ExitCode::from(2);
        }
    }
    let self_test = match self_test.map(|test| Runner::new(test, std::sync::Arc::new(styk_platform::spawn::ThreadSpawner))).transpose() {
        Ok(probe) => probe.map(|probe| Box::new(probe) as Box<dyn styk_core::drawing::probe::PenProbe>),
        Err(error) => { eprintln!("{error}"); return ExitCode::FAILURE; }
    };
    let options = LabOptions { window: window::settings(launch, strategy), scale: launch.scale.unwrap_or(1.0) as f32, show_after_open: window::shown_after_creation(strategy), self_test, out_dir: launch.out.clone(), input: styk_platform::input::host(), spawner: std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), diagnostics: std::sync::Arc::new(styk_platform::diagnostics::NativeDiagnostics) };
    match pen_lab::run(options) {
        Ok(0) => ExitCode::SUCCESS,
        Ok(code) => ExitCode::from(code.clamp(1, 255) as u8),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(feature = "devtools"))]
fn run_pen_lab(_: &Launch, _: Option<Strategy>) -> ExitCode {
    eprintln!("the pen lab is in the developer build (cargo build --features devtools)");
    ExitCode::from(2)
}

/// An unattended run with no window: draws the interface offscreen into the `--screenshot` picture and exits.
fn run_headless(launch: &Launch, screen: Option<Screen>) -> ExitCode {
    let Some(path) = &launch.screenshot else {
        eprintln!("an unattended run here opens no window, so it needs --screenshot <png> to produce anything");
        return ExitCode::from(2);
    };
    let size = launch.size.unwrap_or(window::DEFAULT_SIZE);
    let sheet = screen.and_then(|screen| match screen {
        Screen::ComponentSheet => Some(Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr)),
        _ => Sheet::for_screen(screen),
    });
    let theme = screen.map_or(Theme::default(), Screen::theme);
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let result = match screen {
        Some(screen @ Screen::Inspector(..)) => headless::inspector_screenshot(screen, size, scale),
        Some(screen @ Screen::Stage(..)) => headless::stage_screenshot(screen, size, scale),
        _ => headless::screenshot(theme, size, scale, sheet.as_ref(), screen.filter(|screen| screen.has_band())),
    }
    .and_then(|image| {
        mark!("first-frame");
        screenshot::write(path, &image)
    });
    #[cfg(feature = "devtools")]
    if let Err(error) = styk_platform::diagnostics::write_report(&path.with_extension("trace.txt"), &styk_devtools::trace_report()) {
        eprintln!("{error}"); return ExitCode::FAILURE;
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

/// The same as `output_task` for a screenshot an automation step takes: its result goes to the script, not the exit.
fn step_output_task(job: impl FnOnce() -> Result<(), String> + Send + 'static) -> Task<Message> {
    Task::perform(
        async move {
            let (sender, receiver) = iced::futures::channel::oneshot::channel();
            styk_platform::diagnostics::spawn(move || {
                if sender.send(job()).is_err() {
                    eprintln!("diagnostic output receiver was closed");
                }
            })?;
            receiver.await.map_err(|error| error.to_string())?
        },
        Message::StepSaved,
    )
}

fn output_task(job: impl FnOnce() -> Result<(), String> + Send + 'static) -> Task<Message> {
    Task::perform(async move {
        let (sender, receiver) = iced::futures::channel::oneshot::channel();
        styk_platform::diagnostics::spawn(move || {
            if sender.send(job()).is_err() { eprintln!("diagnostic output receiver was closed"); }
        })?;
        receiver.await.map_err(|error| error.to_string())?
    }, Message::OutputSaved)
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    #[test]
    fn capture_waits_for_a_frame_drawn_after_font_readiness() {
        let wakes = wakes::Wakes::new();
        let shell::Start::Run(shell) = shell::start(&[], true, &wakes.callback()) else { panic!("unattended run") };
        let (outcome, _receiver) = mpsc::sync_channel(1);
        let launch = Launch { screenshot: Some("unused-test-output.png".into()), ..Launch::default() };
        let Ok(mut app) = App::new(launch, None, Some(Strategy::HiddenWindow), outcome, shell, wakes, 0) else { panic!("the app starts") };
        app.window = Some(iced_window::Id::unique());
        app.frames = 20; // Loading frames must not count as a completed content frame.
        drop(app.update(Message::FontsReady(Ok(()))));
        drop(app.frame());
        assert!(!app.capturing, "the first frame after fonts-ready has not been drawn yet");
        drop(app.frame());
        assert!(app.capturing, "the existing two-frame wait should now be complete");
    }
}
