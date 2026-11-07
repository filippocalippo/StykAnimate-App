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

mod headless;
mod screenshot;
mod window;

use iced::{Subscription, Task, window as iced_window};
use std::borrow::Cow;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use styk_core::Launch;
use styk_design::{Theme, fonts, widgets};
use styk_platform::unattended::{self, Strategy};
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
    Opened(iced_window::Id),
    Shown(Result<(), WindowError>),
    Frame,
    Captured(Result<Image, String>),
}

struct App {
    launch: Launch,
    theme: Theme,
    strategy: Option<Strategy>,
    window: Option<iced_window::Id>,
    /// Frames the event loop has started since the window was shown.
    frames: u32,
    capturing: bool,
    outcome: Arc<Mutex<Outcome>>,
}

impl App {
    fn new(launch: Launch, strategy: Option<Strategy>, outcome: Arc<Mutex<Outcome>>) -> App {
        App { launch, theme: Theme::default(), strategy, window: None, frames: 0, capturing: false, outcome }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Opened(id) => {
                self.window = Some(id);
                if window::shown_after_creation(self.strategy) {
                    iced_window::run(id, |window| platform::show_without_activation(window)).map(Message::Shown)
                } else {
                    Task::none()
                }
            }
            Message::Shown(Ok(())) => Task::none(),
            Message::Shown(Err(error)) => self.finish(Outcome::Failed(format!("could not show the window: {error}"))),
            Message::Frame => {
                self.frames += 1;
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

    fn finish(&mut self, outcome: Outcome) -> Task<Message> {
        *self.outcome.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = outcome;
        iced::exit()
    }

    fn view(&self) -> iced::Element<'_, Message> {
        styk_ui::view(self.theme)
    }

    fn subscription(&self) -> Subscription<Message> {
        let opened = iced_window::open_events().map(Message::Opened);
        if self.launch.screenshot.is_some() && !self.capturing {
            Subscription::batch([opened, iced_window::frames().map(|_| Message::Frame)])
        } else {
            opened
        }
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
        return run_headless(&launch);
    }
    let outcome = Arc::new(Mutex::new(Outcome::Running));
    if launch.screenshot.is_some() {
        watchdog(outcome.clone());
    }
    #[cfg(feature = "devtools")]
    let trace_path = launch.screenshot.as_ref().map(|path| path.with_extension("trace.txt"));
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let settings = window::settings(&launch, strategy);
    let app = Mutex::new(Some(App::new(launch, strategy, outcome.clone())));
    let result = iced::application(move || app.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().expect("the application starts once"), App::update, App::view)
        .subscription(App::subscription)
        .title("StykAnimate")
        .theme(|app: &App| styk_ui::base_theme(app.theme))
        .style(|app: &App, _| styk_ui::window_style(app.theme))
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

/// The pen lab (developer build, Windows): a drawing pad on the real input path, and its self-test.
#[cfg(all(feature = "devtools", windows))]
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
    let mut settings = window::settings(launch, strategy);
    if launch.inject_on_screen {
        // Injected pen input reaches the window under the pointer: the window sits, all but invisible, in the screen's corner.
        let (screen_w, screen_h) = styk_platform::windows::inject::primary_screen_size();
        settings.position = iced_window::Position::Specific(iced::Point::new((screen_w as f32 - settings.size.width).max(0.0), (screen_h as f32 - settings.size.height).max(0.0)));
    }
    let options = LabOptions { window: settings, invisible: launch.inject_on_screen, scale: launch.scale.unwrap_or(1.0) as f32, show_after_open: window::shown_after_creation(strategy), self_test, out_dir: launch.out.clone() };
    match pen_lab::run(options) {
        Ok(0) => ExitCode::SUCCESS,
        Ok(code) => ExitCode::from(code.clamp(1, 255) as u8),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(all(feature = "devtools", windows)))]
fn run_pen_lab(_: &Launch, _: Option<Strategy>) -> ExitCode {
    eprintln!("the pen lab is in the Windows developer build (cargo build --features devtools)");
    ExitCode::from(2)
}

/// An unattended run with no window: draws the interface offscreen into the `--screenshot` picture and exits.
fn run_headless(launch: &Launch) -> ExitCode {
    let Some(path) = &launch.screenshot else {
        eprintln!("an unattended run here opens no window, so it needs --screenshot <png> to produce anything");
        return ExitCode::from(2);
    };
    let size = launch.size.unwrap_or(window::DEFAULT_SIZE);
    let result = headless::screenshot(Theme::default(), size, launch.scale.unwrap_or(1.0) as f32).and_then(|image| {
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
