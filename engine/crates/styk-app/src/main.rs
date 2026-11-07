//! `stykanimate`: the StykAnimate program.
//!
//! ```text
//! stykanimate [file] [--automation <script>] [--screenshot <png>] [--size WxH] [--scale <factor>]
//! ```
//!
//! This crate is the wiring: it reads the command line (`styk-core`), picks the platform services (`styk-platform`),
//! and runs the interface (`styk-ui`) in a window. Nothing here decides what the application does.
//!
//! `STYK_BACKGROUND_WINDOW=1` opens the window off-screen, without focus and without a taskbar entry. `--screenshot`
//! waits for the window's first complete frame, writes it as a PNG and exits.

mod screenshot;
mod window;

use iced::{Subscription, Task, window as iced_window};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use styk_core::Launch;
use styk_design::{Theme, warm_up, widgets};
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
    /// The font system is built and holds the bundled fonts: text may be laid out.
    FontsReady,
    Captured(Result<Image, String>),
}

struct App {
    launch: Launch,
    theme: Theme,
    background: bool,
    window: Option<iced_window::Id>,
    /// Whether the font system is ready. Until it is, the view holds no text (`styk_design::warm_up`).
    fonts_ready: bool,
    /// Frames the event loop has started since the window was shown.
    frames: u32,
    capturing: bool,
    outcome: Arc<Mutex<Outcome>>,
}

impl App {
    fn new(launch: Launch, background: bool, outcome: Arc<Mutex<Outcome>>) -> App {
        App { launch, theme: Theme::default(), background, window: None, fonts_ready: false, frames: 0, capturing: false, outcome }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Opened(id) => {
                self.window = Some(id);
                if window::shown_after_creation(self.background) {
                    iced_window::run(id, |window| platform::show_without_activation(window)).map(Message::Shown)
                } else {
                    Task::none()
                }
            }
            Message::Shown(Ok(())) => Task::none(),
            Message::Shown(Err(error)) => self.finish(Outcome::Failed(format!("could not show the window: {error}"))),
            Message::FontsReady => {
                self.fonts_ready = true;
                Task::none()
            }
            Message::Frame => {
                self.frames += 1;
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
    let background = window::background_requested();
    let outcome = Arc::new(Mutex::new(Outcome::Running));
    if launch.screenshot.is_some() {
        watchdog(outcome.clone());
    }
    #[cfg(feature = "devtools")]
    let trace_path = launch.screenshot.as_ref().map(|path| path.with_extension("trace.txt"));
    let scale = launch.scale.unwrap_or(1.0) as f32;
    let settings = window::settings(&launch, background);
    let app = Mutex::new(Some(App::new(launch, background, outcome.clone())));
    // The font system is built on a worker from the first moment (`styk_design::warm_up`); the bundled fonts are
    // loaded there, never through `iced::Settings::fonts`, which the runtime would load on the event loop.
    let result = iced::application(
        move || (app.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().expect("the application starts once"), warm_up::warm_up().map(|()| Message::FontsReady)),
        App::update,
        App::view,
    )
        .subscription(App::subscription)
        .title("StykAnimate")
        .theme(|app: &App| styk_ui::base_theme(app.theme))
        .style(|app: &App, _| styk_ui::window_style(app.theme))
        .scale_factor(move |_| scale)
        .font(widgets::INTER)
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
