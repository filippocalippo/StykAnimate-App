#![deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types)]
//! Developer-only catalogue host. It always renders without a window.
use std::process::ExitCode;
use styk_ui::{component_sheet::Sheet, screens::Screen};

fn run() -> Result<(), String> {
    let launch = styk_core::Launch::parse(std::env::args().skip(1)).map_err(|e| e.to_string())?;
    let screen = launch.screen.as_deref().and_then(Screen::from_id).ok_or_else(|| format!("--screen must name one of {}", Screen::ids()))?;
    let path = launch.screenshot.as_ref().ok_or("--screenshot <png> is required")?;
    if !launch.files.is_empty() || launch.automation.is_some() || launch.control || launch.pen_lab || launch.shell_check || launch.input_check.is_some() || launch.self_test.is_some() {
        return Err("styk-screens accepts catalogue captures only".into());
    }
    let sheet = (screen == Screen::ComponentSheet).then(|| Sheet::new(screen.theme(), styk_design::widgets::Dir::Ltr));
    let image = iced::futures::executor::block_on(styk_ui::headless::screenshot(
        screen.theme(), launch.size.unwrap_or((1560, 1000)), launch.scale.unwrap_or(1.0) as f32,
        sheet.as_ref(), screen.is_band().then_some(screen), styk_platform::font_smoothing::current(), iced::time::Instant::now(), async || {
            let (send, receive) = iced::futures::channel::oneshot::channel();
            styk_platform::diagnostics::after(std::time::Duration::from_millis(5), move || {
                if send.send(()).is_err() { eprintln!("headless capture timer receiver closed"); }
            })?;
            receive.await.map_err(|e| e.to_string())
        },
    ))?;
    styk_platform::screenshot::write(path, &styk_platform::window::Image { width: image.width, height: image.height, rgba: image.rgba })
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => { eprintln!("{error}"); ExitCode::FAILURE }
    }
}
