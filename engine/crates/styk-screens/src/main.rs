#![deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types)]
//! Developer-only catalogue host. It always renders without a window.
use std::process::ExitCode;
use iced_wgpu::wgpu;
#[path = "../../../shared/native_gpu_policy.rs"]
mod gpu_policy;
use styk_ui::{component_sheet::Sheet, screens::Screen};

/// The exit status of a screen the preview does not draw (`Screen::app_only`).
const APP_ONLY: u8 = 3;

fn run() -> Result<ExitCode, String> {
    iced_wgpu::instance::install(gpu_policy::descriptors)
        .map_err(|_| "the preview GPU policy was already installed".to_string())?;
    let launch = styk_core::Launch::parse(std::env::args().skip(1)).map_err(|e| e.to_string())?;
    let screen = launch.screen.as_deref().and_then(Screen::from_id).ok_or_else(|| format!("--screen must name one of {}", Screen::ids()))?;
    if let Some(reason) = screen.app_only() {
        // Reported as a skip, not a failure: `cargo xtask check` accepts exactly this answer and compares nothing for the screen.
        eprintln!("app-only: {reason}");
        return Ok(ExitCode::from(APP_ONLY));
    }
    let path = launch.screenshot.as_ref().ok_or("--screenshot <png> is required")?;
    if !launch.files.is_empty() || launch.automation.is_some() || launch.control || launch.pen_lab || launch.shell_check || launch.input_check.is_some() || launch.self_test.is_some() {
        return Err("styk-screens accepts catalogue captures only".into());
    }
    let sheet = match screen {
        Screen::ComponentSheet => Some(Sheet::new(screen.theme(), styk_design::widgets::Dir::Ltr)),
        Screen::Controls(_) => Some(Sheet::controls_page(screen.theme())),
        _ => None,
    };
    let model = match screen { Screen::Inspector(context, _) => Some(styk_ui::screens::inspector_model(context)), _ => None };
    let presentation = styk_core::i18n::Presentation::english();
    let panel = model.as_ref().map(|model| styk_ui::inspector::View::model(model, &presentation, screen.theme()));
    let image = iced::futures::executor::block_on(styk_ui::headless::screenshot(
        screen.theme(), launch.size.unwrap_or((1560, 1000)), launch.scale.unwrap_or(1.0) as f32,
        sheet.as_ref(), screen.is_band().then_some(screen), panel, None, styk_platform::font_smoothing::current(), iced::time::Instant::now(), async || {
            let (send, receive) = iced::futures::channel::oneshot::channel();
            styk_platform::diagnostics::after(std::time::Duration::from_millis(5), move || {
                if send.send(()).is_err() { eprintln!("headless capture timer receiver closed"); }
            })?;
            receive.await.map_err(|e| e.to_string())
        },
    ))?;
    styk_platform::screenshot::write(path, &styk_platform::window::Image { width: image.width, height: image.height, rgba: image.rgba })?;
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => { eprintln!("{error}"); ExitCode::FAILURE }
    }
}
