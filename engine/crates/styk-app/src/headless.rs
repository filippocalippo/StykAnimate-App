//! Drawing the interface without a window.
//!
//! Where an unattended run cannot keep a window off the person's desktop (Wayland, macOS: see
//! `styk_platform::unattended`) it opens none. The interface is built and drawn by the same `iced_wgpu` renderer a
//! window uses, into a picture of the requested size.

use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::{Pixels, Size, Widget as _, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use styk_design::{Theme, warm_up, widgets};
use styk_platform::window::Image;
use styk_ui::component_sheet::Sheet;
use styk_ui::screens::Screen;

/// Draws the interface in `theme`, `size` logical pixels at `scale`, and returns the picture (RGBA, top row first).
///
/// Fails when the machine has no graphics adapter the renderer can use.
/// A stage screen: its fixture's core, the toolkit's device handed to the painter by the widget, redrawn until the picture on
/// show answers the first demand (the paint worker finishes in its own time; nothing here waits for it).
pub fn stage_screenshot(screen: Screen, size: (u32, u32), scale: f32) -> Result<Image, String> {
    let clock: std::sync::Arc<dyn styk_services::Clock> = std::sync::Arc::new(styk_platform::clock::SystemClock::new());
    let core = styk_core::screens::stage(std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), clock, [f64::from(size.0), f64::from(size.1)])?;
    pollster::block_on(screenshot_async(screen.theme(), size, scale, None, None, None, Some(&core)))
}

pub fn screenshot(theme: Theme, size: (u32, u32), scale: f32, sheet: Option<&Sheet>, band: Option<Screen>) -> Result<Image, String> {
    pollster::block_on(screenshot_async(theme, size, scale, sheet, band, None, None))
}

/// A Properties panel screen: its fixture's core, refreshed (never waited on) until the facts lane made what it shows.
pub fn inspector_screenshot(screen: Screen, size: (u32, u32), scale: f32) -> Result<Image, String> {
    let Screen::Inspector(context, _) = screen else { return Err("not a Properties panel screen".into()) };
    let mut core = styk_core::screens::inspector(context, std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), std::sync::Arc::new(|| {}))?;
    pollster::block_on(async {
        // The frame on show, the views and the figures' bounds come from the facts lane: refresh until the panel is no
        // longer pending and what its context shows landed, at most two seconds.
        for _ in 0..400 {
            core.refresh();
            let panel = core.inspector();
            let ready = panel.model().is_some() && !panel.pending();
            if ready && (context != styk_core::screens::InspectorScreen::Figures || panel.shown().bounds.is_some()) {
                break;
            }
            pause().await?;
        }
        screenshot_async(screen.theme(), size, scale, None, None, Some(&core), None).await
    })
}

/// Five milliseconds, on the platform's timer.
async fn pause() -> Result<(), String> {
    let (send, receive) = iced::futures::channel::oneshot::channel();
    styk_platform::diagnostics::after(std::time::Duration::from_millis(5), move || {
        if send.send(()).is_err() { eprintln!("headless capture timer receiver closed"); }
    })?;
    receive.await.map_err(|error| error.to_string())
}

async fn screenshot_async(theme: Theme, size: (u32, u32), scale: f32, sheet: Option<&Sheet>, band: Option<Screen>, inspector: Option<&styk_core::app::Core>, stage: Option<&styk_core::app::Core>) -> Result<Image, String> {
    let settings = iced::Settings { font: widgets::INTER, text_size: Pixels(16.0), ..iced::Settings::default() };
    let mut renderer = <iced::Renderer as Headless>::new(renderer::Settings::from(&settings), None).await.ok_or("no graphics adapter is available to draw offscreen")?;
    // Nothing here is an event loop to keep responsive: the font system is built and the bundled fonts installed in place.
    let ready = warm_up::install_bundled(styk_platform::font_smoothing::current());
    let bounds = Size::new(size.0 as f32, size.1 as f32);
    let style = styk_ui::window_style(theme);
    let iced_theme = styk_ui::base_theme(theme);
    // A band screen: the band over its window, laid out for this size with its words measured.
    let shell = band.map(|screen| styk_ui::screens::band_shell(screen, size, styk_ui::shell::measure_labels(ready)));
    let panel = inspector.and_then(|core| styk_ui::inspector::View::of(core, theme));
    let view: iced::Element<'_, ()> = match (sheet, shell.as_ref()) {
        _ if stage.is_some() => stage.and_then(|core| styk_ui::stage::view(core, theme)).map_or_else(|| styk_ui::loading(theme), |stage| stage.map(|_| ()).boxed()),
        _ if panel.is_some() => match panel {
            Some(panel) => styk_ui::dock::docked(styk_ui::inspector::view(panel), theme).map(|_| ()).boxed(),
            None => styk_ui::loading(theme),
        },
        (Some(sheet), _) => sheet.view().map(|_| ()).boxed(),
        (None, Some(shell)) => styk_ui::shell::window(styk_ui::shell::Params { shell, theme, ready, maximize: styk_services::shell::chrome::MaxButtonState::Idle }, styk_ui::loading(theme)).map(|_| ()).boxed(),
        (None, None) => styk_ui::view(theme, ready),
    };
    let mut interface: UserInterface<'_, (), iced::Theme, iced::Renderer> = UserInterface::build(view, bounds, Cache::default(), &mut renderer);
    // One redraw, so widgets that lay themselves out on their first frame have.
    let _ = interface.update(
        &window::Headless,
        &shell::Waker::noop(),
        &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))],
        mouse::Cursor::Unavailable,
        &mut renderer,
        &mut shell::Bus::new(),
    );
    let physical = Size::new((bounds.width * scale).round() as u32, (bounds.height * scale).round() as u32);
    // Glyphs a worker is drawing are left out of a frame, and such a frame is not the picture: draw again until one is
    // complete, or fail.
    for _ in 0..400 {
        interface.draw(&mut renderer, &iced_theme, &renderer::Style { text_color: style.text_color }, mouse::Cursor::Unavailable);
        let rgba = Headless::screenshot(&mut renderer, physical, scale, style.background_color);
        if !styk_design::glyphs::incomplete() && stage.is_none_or(|core| core.stage().is_some_and(|surface| surface.ready())) {
            return Ok(Image { width: physical.width, height: physical.height, rgba });
        }
        pause().await?;
    }
    Err("the text was still missing glyphs after 400 frames: the glyph worker did not deliver".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The picture, or nothing on a machine without a graphics adapter (a bare CI container), which cannot run this.
    fn picture(theme: Theme, size: (u32, u32), scale: f32) -> Option<Image> {
        match screenshot(theme, size, scale, None, None) {
            Ok(image) => Some(image),
            Err(error) if error.contains("no graphics adapter") => {
                eprintln!("skipped: {error}");
                None
            }
            Err(error) => panic!("{error}"),
        }
    }

    fn only_colour(image: &Image, rgba: [u8; 4]) -> bool {
        image.rgba.chunks_exact(4).all(|pixel| pixel == rgba)
    }

    #[test]
    fn the_interface_is_drawn_without_a_window_in_the_theme_s_field_colour() {
        let Some(light) = picture(Theme::Light, (64, 48), 1.0) else { return };
        assert_eq!((light.width, light.height), (64, 48));
        assert!(only_colour(&light, [0xec, 0xef, 0xf4, 255]), "the light window field, #eceff4");
        let Some(dark) = picture(Theme::Dark, (64, 48), 1.0) else { return };
        assert!(only_colour(&dark, [0x0a, 0x0b, 0x0f, 255]), "the dark window field, #0a0b0f");
    }

    #[test]
    fn the_scale_sets_the_pixel_size() {
        let Some(image) = picture(Theme::Light, (64, 48), 2.0) else { return };
        assert_eq!((image.width, image.height), (128, 96));
        assert_eq!(image.rgba.len(), 128 * 96 * 4);
    }
}
