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
mod screenshot;
mod window;

use iced::{Subscription, Task, Widget as _, window as iced_window};
use std::borrow::Cow;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use styk_core::Launch;
use styk_design::{Theme, fonts, widgets};
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
    Captured(Result<Image, String>),
}

struct App {
    launch: Launch,
    theme: Theme,
    /// The screen of the catalogue being shown instead of the application, if any.
    sheet: Option<Sheet>,
    strategy: Option<Strategy>,
    window: Option<iced_window::Id>,
    /// What the input check has seen so far.
    report: Vec<String>,
    /// When each redraw started, for the check's latency figures.
    frame_times: Vec<std::time::Instant>,
    /// Frames the event loop has started since the window was shown.
    frames: u32,
    capturing: bool,
    outcome: Arc<Mutex<Outcome>>,
}

impl App {
    fn new(launch: Launch, screen: Option<Screen>, strategy: Option<Strategy>, outcome: Arc<Mutex<Outcome>>) -> App {
        let sheet = screen.map(|Screen::ComponentSheet| Sheet::new(Theme::default(), styk_design::widgets::Dir::Ltr));
        App { launch, theme: Theme::default(), sheet, strategy, window: None, report: Vec::new(), frame_times: Vec::new(), frames: 0, capturing: false, outcome }
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
                    let focus = Task::done(Message::Sheet(component_sheet::Message::Focus(styk_core::focus::FocusId(input_check::FIELD))));
                    return Task::batch([shown, focus.chain(input_check::script(id).map(Message::Check))]);
                }
                shown
            }
            Message::Shown(Ok(())) => Task::none(),
            Message::Shown(Err(error)) => self.finish(Outcome::Failed(format!("could not show the window: {error}"))),
            Message::Frame => {
                self.frames += 1;
                if self.launch.input_check.is_some() {
                    self.frame_times.push(std::time::Instant::now());
                }
                // The first frame's event arrives as it is about to be drawn; the second, once that draw is done.
                match self.window {
                    Some(id) if self.frames == 2 && self.launch.screenshot.is_some() && !self.capturing => {
                        self.capturing = true;
                        mark!("first-frame");
                        capture(id)
                    }
                    _ => Task::none(),
                }
            }
            Message::Captured(Ok(image)) => {
                let path = self.launch.screenshot.clone().expect("a capture is only requested with --screenshot");
                match screenshot::write(&path, &image) {
                    Ok(()) => self.finish(Outcome::Done),
                    Err(error) => self.finish(Outcome::Failed(error)),
                }
            }
            Message::Captured(Err(error)) => self.finish(Outcome::Failed(format!("could not capture the window: {error}"))),
        }
    }

    /// Records a step of the input check; the last step writes the report and ends the run.
    #[cfg(feature = "devtools")]
    fn check(&mut self, step: input_check::Step) -> Task<Message> {
        let sheet_state = |app: &App| {
            let sheet = app.sheet.as_ref();
            format!("name field {:?}, composing {}", sheet.map(|s| s.name.text()).unwrap_or(""), sheet.is_some_and(|s| s.focus.composing()))
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
            input_check::Step::Finish => {
                let latency = input_check::latency_summary(&self.frame_times);
                self.report.push(format!("keystroke to the start of the redraw that draws it: {latency}"));
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
        match &self.sheet {
            Some(sheet) => sheet.view().map(Message::Sheet).boxed(),
            None => styk_ui::view(self.theme),
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
    if strategy == Some(Strategy::Headless) {
        return run_headless(&launch, screen);
    }
    let outcome = Arc::new(Mutex::new(Outcome::Running));
    if launch.screenshot.is_some() {
        watchdog(outcome.clone());
    }
    #[cfg(feature = "devtools")]
    let trace_path = launch.screenshot.as_ref().map(|path| path.with_extension("trace.txt"));
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let settings = window::settings(&launch, strategy);
    let app = Mutex::new(Some(App::new(launch, screen, strategy, outcome.clone())));
    let result = iced::application(move || app.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().expect("the application starts once"), App::update, App::view)
        .subscription(App::subscription)
        .title("StykAnimate")
        .theme(|app: &App| styk_ui::base_theme(app.theme()))
        .style(|app: &App, _| styk_ui::window_style(app.theme()))
        .scale_factor(move |_| scale)
        .font(widgets::INTER)
        .fonts(fonts::ALL.iter().map(|font| Cow::Borrowed(*font)))
        .window(settings)
        .run();
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

/// Ends the process if a `--screenshot` run is still going after [`SCREENSHOT_DEADLINE`].
fn watchdog(outcome: Arc<Mutex<Outcome>>) {
    std::thread::spawn(move || {
        std::thread::sleep(SCREENSHOT_DEADLINE);
        if matches!(*outcome.lock().unwrap_or_else(|poisoned| poisoned.into_inner()), Outcome::Running) {
            eprintln!("--screenshot: the window drew no frame within {} s", SCREENSHOT_DEADLINE.as_secs());
            std::process::exit(1);
        }
    });
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
