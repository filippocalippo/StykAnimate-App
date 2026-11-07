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
#[cfg(feature = "devtools")]
mod input_check;
mod screenshot;
mod shell;
#[cfg(windows)]
mod shell_check;
mod window;

use iced::futures::StreamExt;
use iced::{Size, Subscription, Task, Widget, window as iced_window};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use styk_core::Launch;
use styk_design::{Theme, warm_up, widgets};
use styk_platform::unattended::{self, Strategy};
use styk_platform::window::{self as platform, Image, WindowError};
use styk_services::shell::chrome::{MaxButtonState, band_height, band_regions};
use styk_trace::mark;
use styk_ui::band::{Controls, Hot, window_controls};
use styk_ui::component_sheet::{self, Sheet};
use styk_ui::screens::Screen;

/// How long `--screenshot` waits for a first frame before giving up. A window that never draws is a defect to report,
/// not a reason to hang a script.
const SCREENSHOT_DEADLINE: Duration = Duration::from_secs(30);

/// How long `--shell-check` waits for its steps before giving up.
const CHECK_DEADLINE: Duration = Duration::from_secs(60);

/// The frame at which `--shell-check` asks its synchronous questions, and how many frames it waits for the events the
/// DPI step causes.
#[cfg_attr(not(windows), allow(dead_code))]
const CHECK_AT_FRAME: u32 = 12;
const CHECK_SETTLE_FRAMES: u32 = 12;

/// The window's height under which the chrome is compact (`layout-solver.mjs`: windows under 801 px tall).
const COMPACT_BELOW: f32 = 801.0;

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
    Minimize,
    CloseRequested,
    /// The window state is written: the program may end.
    Saved,
    /// The pointer is over a window control, or left it.
    Hover(Option<Hot>),
    Frame,
    /// The font system is built and holds the bundled fonts: text may be laid out.
    FontsReady,
    Captured(Result<Image, String>),
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
    outcome: Arc<Mutex<Outcome>>,
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
    wakes: shell::Wakes,
    chrome: Option<shell::Chrome>,
    max_button: MaxButtonState,
    hover: Option<Hot>,
    closing: bool,
    /// The window's logical size and scale factor, as the interface was last told.
    logical: Size,
    scale: f32,
    /// Every scale factor the window announced, for `--shell-check`.
    rescales: Vec<f32>,
    #[cfg_attr(not(windows), allow(dead_code))]
    foreground_before: isize,
    check: CheckStep,
}

/// Where `--shell-check` is.
#[derive(Debug)]
enum CheckStep {
    NotRunning,
    #[cfg_attr(not(windows), allow(dead_code))]
    Asked,
    #[cfg_attr(not(windows), allow(dead_code))]
    Settling { until_frame: u32, dpi: Option<CheckedDpi>, logical_before: (f32, f32), lines: Vec<CheckLine> },
}

impl App {
    fn new(launch: Launch, screen: Option<Screen>, strategy: Option<Strategy>, outcome: Arc<Mutex<Outcome>>, shell: Box<shell::Shell>, wakes: shell::Wakes, foreground_before: isize) -> App {
        let sheet = screen.map(|Screen::ComponentSheet| {
            let mut sheet = Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr);
            sheet.button_probe = Some(styk_platform::input::primary_button_down);
            sheet
        });
        App {
            sheet,
            #[cfg(feature = "devtools")]
            report: Vec::new(),
            #[cfg(feature = "devtools")]
            frame_times: Vec::new(),
            #[cfg(feature = "devtools")]
            latency_base: 0,
            launch,
            theme: Theme::default(),
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
            hover: None,
            closing: false,
            logical: Size::new(window::DEFAULT_SIZE.0 as f32, window::DEFAULT_SIZE.1 as f32),
            scale: 1.0,
            rescales: Vec::new(),
            foreground_before,
            check: CheckStep::NotRunning,
        }
    }

    fn theme(&self) -> Theme {
        self.sheet.as_ref().map_or(self.theme, |sheet| sheet.theme)
    }

    fn band_height(&self) -> f32 {
        band_height(1.0, self.logical.height < COMPACT_BELOW)
    }

    /// Tells the window where the band's controls are, in physical client pixels.
    fn publish_regions(&self) {
        if let Some(chrome) = &self.chrome {
            let width = (self.logical.width * self.scale).round() as i32;
            chrome.publish(band_regions(width, self.scale, self.band_height(), false, &[]));
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
                self.shell.changed(&self.wakes);
                Task::none()
            }
            Message::Wake(wake) => self.wake(wake),
            Message::Minimize => self.window.map_or_else(Task::none, |id| iced_window::minimize(id, true)),
            Message::CloseRequested => self.close(),
            Message::Saved => self.finish(Outcome::Done),
            Message::Hover(hot) => {
                self.hover = hot;
                Task::none()
            }
            Message::FontsReady => {
                self.fonts_ready = true;
                Task::none()
            }
            Message::Frame => self.frame(),
            Message::Captured(Ok(image)) => {
                let path = self.launch.screenshot.clone().expect("a capture is only requested with --screenshot");
                match screenshot::write(&path, &image) {
                    Ok(()) => self.finish(Outcome::Done),
                    Err(error) => self.finish(Outcome::Failed(error)),
                }
            }
            Message::Captured(Err(error)) => self.finish(Outcome::Failed(format!("could not capture the window: {error}"))),
            Message::Checked(lines, dpi) => {
                self.check = CheckStep::Settling { until_frame: self.frames + CHECK_SETTLE_FRAMES, dpi, logical_before: (self.logical.width, self.logical.height), lines };
                Task::none()
            }
            Message::CheckDone(lines) => self.report_check(lines),
        }
    }

    fn window_event(&mut self, id: iced_window::Id, event: iced_window::Event) -> Task<Message> {
        use iced_window::Event;
        match event {
            Event::Opened { size, scale_factor, .. } => {
                self.window = Some(id);
                self.logical = size;
                self.scale = scale_factor;
                let owns_show = window::shell_shows(self.strategy);
                let frame = self.shell.restore;
                let attach = iced_window::run(id, move |w| shell::attach(w, frame, owns_show)).map(Message::Attached);
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
    #[cfg(windows)]
    fn sample(&self, id: iced_window::Id) -> Task<Message> {
        if self.strategy.is_some() {
            return Task::none();
        }
        iced_window::run(id, |w| styk_platform::windows::monitors::hwnd_of(w).map(styk_platform::windows::monitors::sample)).and_then(|sample| Task::done(Message::Sampled(sample)))
    }

    #[cfg(not(windows))]
    fn sample(&self, _: iced_window::Id) -> Task<Message> {
        Task::none()
    }

    fn wake(&mut self, wake: shell::Wake) -> Task<Message> {
        match wake {
            shell::Wake::Chrome => {
                let Some(chrome) = &self.chrome else { return Task::none() };
                self.max_button = chrome.max_button();
                let toggles = chrome.take_toggles();
                match self.window {
                    Some(id) if toggles > 0 => Task::batch((0..toggles).map(|_| iced_window::toggle_maximize(id))),
                    _ => Task::none(),
                }
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
                self.shell.save_check(&self.wakes);
                Task::none()
            }
        }
    }

    fn close(&mut self) -> Task<Message> {
        // The core's close guard (unsaved work) decides here once documents exist; until then the program ends, once the
        // window state is written (by a worker: the interface thread does not wait for the disk).
        if std::mem::replace(&mut self.closing, true) {
            return Task::none();
        }
        match self.shell.save_for_close() {
            Some(done) => Task::perform(async move { let _ = done.await; }, |()| Message::Saved),
            None => self.finish(Outcome::Done),
        }
    }

    fn frame(&mut self) -> Task<Message> {
        self.frames += 1;
        #[cfg(feature = "devtools")]
        if self.launch.input_check.is_some() {
            self.frame_times.push(std::time::Instant::now());
        }
        let Some(id) = self.window else { return Task::none() };
        // The first frame's event arrives as it is about to be drawn; the second, once that draw is done and the text it
        // shows can be laid out.
        if self.frames >= 2 && self.fonts_ready && self.launch.screenshot.is_some() && !self.capturing {
            self.capturing = true;
            mark!("first-frame");
            return capture(id);
        }
        self.check_step(id)
    }

    #[cfg(windows)]
    fn check_step(&mut self, id: iced_window::Id) -> Task<Message> {
        if !self.launch.shell_check {
            return Task::none();
        }
        match &self.check {
            CheckStep::NotRunning if self.frames >= CHECK_AT_FRAME && self.chrome.is_some() && self.fonts_ready => {
                self.check = CheckStep::Asked;
                let chrome = self.chrome.clone().expect("checked above");
                let (scale, logical, foreground) = (self.scale, (self.logical.width, self.logical.height), self.foreground_before);
                iced_window::run(id, move |window| {
                    let original = styk_platform::windows::monitors::hwnd_of(window).and_then(styk_platform::windows::monitors::window_rect).unwrap_or(styk_services::shell::Rect::new(-20000, -20000, 1560, 1000));
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

    #[cfg(not(windows))]
    fn check_step(&mut self, _: iced_window::Id) -> Task<Message> {
        Task::none()
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
                let path = self.launch.input_check.clone().expect("the check only runs with --input-check");
                match std::fs::write(&path, json) {
                    Ok(()) => self.finish(Outcome::Done),
                    Err(error) => self.finish(Outcome::Failed(format!("{}: {error}", path.display()))),
                }
            }
        }
    }

    fn finish(&mut self, outcome: Outcome) -> Task<Message> {
        *self.outcome.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = outcome;
        iced::exit()
    }

    fn view(&self) -> iced::Element<'_, Message> {
        // Text is laid out only once the font system is ready: until then the view holds none.
        match warm_up::proof() {
            Some(_) if self.sheet.is_some() => self.sheet.as_ref().expect("checked").view().map(Message::Sheet).boxed(),
            Some(ready) => {
                let height = self.band_height();
                let controls: iced::Element<'_, Message> = if cfg!(target_os = "macos") {
                    iced::widget::space().boxed()
                } else {
                    window_controls(Controls { theme: self.theme, folded: false, height, maximize: self.max_button, hover: self.hover }, Message::Minimize, Message::CloseRequested, Message::Hover)
                };
                styk_ui::shell(self.theme, ready, height, controls)
            }
            None => styk_ui::loading(self.theme),
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![iced_window::events().map(|(id, event)| Message::Window(id, event)), Subscription::run(wake_stream)];
        if let Some(sheet) = &self.sheet {
            subscriptions.push(sheet.subscription().map(Message::Sheet));
        }
        if (!self.capturing && (self.launch.screenshot.is_some() || self.launch.shell_check)) || self.launch.input_check.is_some() {
            subscriptions.push(iced_window::frames().map(|_| Message::Frame));
        }
        Subscription::batch(subscriptions)
    }
}

/// The receiver of the wake-ups the window procedure, the pipe server and the save timer send.
static WAKES: Mutex<Option<iced::futures::channel::mpsc::Receiver<shell::Wake>>> = Mutex::new(None);

fn wake_stream() -> impl iced::futures::Stream<Item = Message> {
    let receiver = WAKES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    iced::futures::stream::iter(receiver).flatten().map(Message::Wake)
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
    mark!("startup");
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let launch = match Launch::parse(shell::without_links(&arguments)) {
        Ok(launch) => launch,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if launch.automation.is_some() {
        eprintln!("--automation is not available yet: the automation mode arrives with the stage");
        return ExitCode::from(2);
    }
    let strategy = match unattended::requested_by_environment() {
        Ok(strategy) => strategy,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
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
    let (wakes, receiver) = shell::Wakes::channel();
    *WAKES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(receiver);
    let shell = match shell::start(&arguments, strategy.is_some(), &wakes) {
        shell::Start::Run(shell) => shell,
        shell::Start::End(code) => return code,
    };
    #[cfg(windows)]
    let foreground_before = styk_platform::windows::probe::foreground();
    #[cfg(not(windows))]
    let foreground_before = 0;
    let outcome = Arc::new(Mutex::new(Outcome::Running));
    if launch.screenshot.is_some() {
        watchdog(outcome.clone(), "--screenshot: the window drew no frame", SCREENSHOT_DEADLINE);
    }
    if launch.shell_check {
        watchdog(outcome.clone(), "--shell-check: the checks did not finish", CHECK_DEADLINE);
    }
    #[cfg(feature = "devtools")]
    let trace_path = launch.screenshot.as_ref().map(|path| path.with_extension("trace.txt"));
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let settings = window::settings(&launch, strategy);
    let app = Mutex::new(Some(App::new(launch, screen, strategy, outcome.clone(), shell, wakes, foreground_before)));
    // The font system is built on a worker from the first moment (styk_design::warm_up); the bundled fonts are
    // loaded there, never through iced::Settings::fonts, which the runtime would load on the event loop.
    let result = iced::application(
        move || (app.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().expect("the application starts once"), warm_up::warm_up().map(|()| Message::FontsReady)),
        App::update,
        App::view,
    )
    .subscription(App::subscription)
    .title("StykAnimate")
    .theme(|app: &App| styk_ui::base_theme(app.theme()))
    .style(|app: &App, _| styk_ui::window_style(app.theme()))
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
        let _ = std::fs::write(path, styk_devtools::trace_report());
    }
    let outcome = std::mem::take(&mut *outcome.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
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

/// Ends the process if an unattended run is still going after `deadline`.
fn watchdog(outcome: Arc<Mutex<Outcome>>, what: &'static str, deadline: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(deadline);
        if matches!(*outcome.lock().unwrap_or_else(|poisoned| poisoned.into_inner()), Outcome::Running) {
            eprintln!("{what} within {} s", deadline.as_secs());
            std::process::exit(1);
        }
    });
}

/// The pen lab (developer build): a drawing pad on the real input path, and its self-test.
#[cfg(feature = "devtools")]
fn run_pen_lab(launch: &Launch, strategy: Option<Strategy>) -> ExitCode {
    use styk_devtools::pen_lab::{self, LabOptions, SelfTest};
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
        if let Err(error) = std::fs::create_dir_all(dir) {
            eprintln!("{}: {error}", dir.display());
            return ExitCode::from(2);
        }
    }
    let options = LabOptions { window: window::settings(launch, strategy), scale: launch.scale.unwrap_or(1.0) as f32, show_after_open: window::shown_after_creation(strategy), self_test, out_dir: launch.out.clone(), input: styk_platform::input::host(), spawner: std::sync::Arc::new(styk_platform::spawn::ThreadSpawner) };
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
    let sheet = screen.map(|Screen::ComponentSheet| Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr));
    let result = headless::screenshot(Theme::default(), size, launch.scale.unwrap_or(1.0) as f32, sheet.as_ref()).and_then(|image| {
        mark!("first-frame");
        screenshot::write(path, &image)
    });
    #[cfg(feature = "devtools")]
    let _ = std::fs::write(path.with_extension("trace.txt"), styk_devtools::trace_report());
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
