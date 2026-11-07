#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods))]
//! `stykanimate`: the StykAnimate program.
//!
//! ```text
//! stykanimate [file] [--automation <script>] [--screenshot <png>] [--size WxH] [--scale <factor>]
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

#[cfg(feature = "devtools")]
mod input_check;
mod headless;
use styk_platform::screenshot;
mod window;

use iced::{Subscription, Task, Widget as _, window as iced_window};
use std::process::ExitCode;
use std::sync::mpsc::{self, SyncSender};
use std::time::Duration;
use styk_core::Launch;
use styk_design::{Theme, warm_up, widgets};
use styk_platform::unattended::{self, Strategy};
use styk_ui::component_sheet::{self, Sheet};
use styk_ui::screens::Screen;
use styk_platform::window::{self as platform, Image, WindowError};
use styk_trace::mark;

/// How long `--screenshot` waits for a first frame before giving up. A window that never draws is a defect to report,
/// not a reason to hang a script.
const SCREENSHOT_DEADLINE: Duration = Duration::from_secs(30);

/// How an unattended run ended, read after the event loop returns.
#[derive(Debug, Default)]
enum Outcome {
    #[default]
    Running,
    Done,
    Failed(String),
}

#[derive(Debug, Clone)]
enum Message {
    Sheet(component_sheet::Message),
    #[cfg(feature = "devtools")]
    Check(input_check::Step),
    Opened(iced_window::Id),
    Shown(Result<(), WindowError>),
    Frame,
    /// The font system is built and holds the bundled fonts: text may be laid out.
    FontsReady(Result<(), String>),
    Captured(Result<Image, String>),
    Saved(Result<(), String>),
}

struct App {
    launch: Launch,
    theme: Theme,
    /// The screen of the catalogue being shown instead of the application, if any.
    sheet: Option<Sheet>,
    strategy: Option<Strategy>,
    window: Option<iced_window::Id>,
    /// What the input check has seen so far.
    #[cfg(feature = "devtools")]
    report: Vec<String>,
    /// When each redraw started, for the check's latency figures.
    #[cfg(feature = "devtools")]
    frame_times: Vec<std::time::Instant>,
    /// The characters the field held when a latency run began.
    #[cfg(feature = "devtools")]
    latency_base: usize,
    /// Whether the font system is ready. Until it is, the view holds no text (`styk_design::warm_up`).
    fonts_ready: bool,
    /// Frames the event loop has started since the window was shown.
    frames: u32,
    capturing: bool,
    outcome: SyncSender<Outcome>,
}

impl App {
    fn new(launch: Launch, screen: Option<Screen>, strategy: Option<Strategy>, outcome: SyncSender<Outcome>) -> App {
        let sheet = screen.map(|Screen::ComponentSheet| {
            let mut sheet = Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr);
            sheet.button_probe = Some(styk_platform::input::primary_button_down);
            sheet
        });
        App {
            launch,
            theme: Theme::default(),
            sheet,
            strategy,
            window: None,
            #[cfg(feature = "devtools")]
            report: Vec::new(),
            #[cfg(feature = "devtools")]
            frame_times: Vec::new(),
            #[cfg(feature = "devtools")]
            latency_base: 0,
            fonts_ready: false,
            frames: 0,
            capturing: false,
            outcome,
        }
    }

    fn theme(&self) -> Theme {
        self.sheet.as_ref().map_or(self.theme, |sheet| sheet.theme)
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Sheet(message) => match self.sheet.as_mut() {
                Some(sheet) => sheet.update(message).map(Message::Sheet),
                None => Task::none(),
            },
            #[cfg(feature = "devtools")]
            Message::Check(step) => self.check(step),
            Message::Opened(id) => {
                self.window = Some(id);
                let shown = if window::shown_after_creation(self.strategy) {
                    iced_window::run(id, |window| platform::show_without_activation(window)).map(Message::Shown)
                } else {
                    Task::none()
                };
                #[cfg(feature = "devtools")]
                if self.launch.input_check.is_some() && self.sheet.is_some() {
                    return Task::batch([shown, input_check::script(id).map(Message::Check)]);
                }
                shown
            }
            Message::Shown(Ok(())) => Task::none(),
            Message::Shown(Err(error)) => self.finish(Outcome::Failed(format!("could not show the window: {error}"))),
            Message::FontsReady(Err(error)) => self.finish(Outcome::Failed(error)),
            Message::FontsReady(Ok(())) => {
                self.fonts_ready = true;
                Task::none()
            }
            Message::Frame => {
                self.frames += 1;
                #[cfg(feature = "devtools")]
                if self.launch.input_check.is_some() {
                    self.frame_times.push(std::time::Instant::now());
                }
                // The first frame's event arrives as it is about to be drawn; the second, once that draw is done and
                // the text it shows can be laid out.
                match self.window {
                    Some(id) if self.frames >= 2 && self.fonts_ready && self.launch.screenshot.is_some() && !self.capturing => {
                        self.capturing = true;
                        mark!("first-frame");
                        capture(id)
                    }
                    _ => Task::none(),
                }
            }
            Message::Captured(Ok(image)) => {
                let Some(path) = self.launch.screenshot.clone() else {
                    return self.finish(Outcome::Failed("capture has no output path".into()));
                };
                output_task(move || screenshot::write(&path, &image))
            }
            Message::Saved(Ok(())) => self.finish(Outcome::Done),
            Message::Saved(Err(error)) => self.finish(Outcome::Failed(error)),
            Message::Captured(Err(error)) => self.finish(Outcome::Failed(format!("could not capture the window: {error}"))),
        }
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
        match warm_up::proof() {
            Some(ready) => match &self.sheet {
                Some(sheet) => sheet.view().map(Message::Sheet).boxed(),
                None => styk_ui::view(self.theme, ready),
            },
            None => styk_ui::loading(self.theme),
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![iced_window::open_events().map(Message::Opened)];
        if let Some(sheet) = &self.sheet {
            subscriptions.push(sheet.subscription().map(Message::Sheet));
        }
        if (self.launch.screenshot.is_some() && !self.capturing) || self.launch.input_check.is_some() {
            subscriptions.push(iced_window::frames().map(|_| Message::Frame));
        }
        Subscription::batch(subscriptions)
    }
}

/// Captures the window through the operating system's compositor; where the platform has none, from iced's own
/// renderer.
fn capture(id: iced_window::Id) -> Task<Message> {
    iced_window::run(id, |window| platform::capture(window)).then(move |result| match result {
        Ok(image) => Task::done(Message::Captured(Ok(image))),
        Err(WindowError::Unsupported) => iced_window::screenshot(id).map(|shot| {
            Message::Captured(Ok(Image { width: shot.size.width, height: shot.size.height, rgba: shot.rgba.to_vec() }))
        }),
        Err(error) => Task::done(Message::Captured(Err(error.to_string()))),
    })
}

fn main() -> ExitCode {
    mark!("startup");
    let launch = match Launch::parse(std::env::args().skip(1)) {
        Ok(launch) => launch,
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
    if launch.pen_lab {
        return run_pen_lab(&launch, strategy);
    }
    if strategy == Some(Strategy::Headless) {
        return run_headless(&launch, screen);
    }
    let (outcome, receiver) = mpsc::sync_channel(1);
    let _deadline = if launch.screenshot.is_some() {
        match styk_platform::diagnostics::deadline(SCREENSHOT_DEADLINE) {
            Ok(deadline) => Some(deadline),
            Err(error) => { eprintln!("{error}"); return ExitCode::FAILURE; }
        }
    } else { None };
    #[cfg(feature = "devtools")]
    let trace_path = launch.screenshot.as_ref().map(|path| path.with_extension("trace.txt"));
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let settings = window::settings(&launch, strategy);
    // The font system is built on a worker from the first moment (styk_design::warm_up); the bundled fonts are
    // loaded there, never through iced::Settings::fonts, which the runtime would load on the event loop.
    let result = iced::application(
        move || (App::new(launch.clone(), screen, strategy, outcome.clone()), warm_up::warm_up(std::sync::Arc::new(styk_platform::spawn::ThreadSpawner)).map(Message::FontsReady)),
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
    let options = LabOptions { window: window::settings(launch, strategy), scale: launch.scale.unwrap_or(1.0) as f32, show_after_open: window::shown_after_creation(strategy), self_test: self_test.map(|test| Box::new(Runner::new(test)) as Box<dyn styk_core::drawing::probe::PenProbe>), out_dir: launch.out.clone(), input: styk_platform::input::host(), spawner: std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), diagnostics: std::sync::Arc::new(styk_platform::diagnostics::NativeDiagnostics) };
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

fn output_task(job: impl FnOnce() -> Result<(), String> + Send + 'static) -> Task<Message> {
    Task::perform(async move {
        let (sender, receiver) = iced::futures::channel::oneshot::channel();
        styk_platform::diagnostics::spawn(move || {
            if sender.send(job()).is_err() { eprintln!("diagnostic output receiver was closed"); }
        })?;
        receiver.await.map_err(|error| error.to_string())?
    }, Message::Saved)
}
