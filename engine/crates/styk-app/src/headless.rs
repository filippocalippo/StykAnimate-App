//! Drawing the interface without a window.
//!
//! Where an unattended run cannot keep a window off the person's desktop (Wayland, macOS: see
//! `styk_platform::unattended`) it opens none. The interface is built and drawn by the same `iced_wgpu` renderer a
//! window uses, into a picture of the requested size.

use styk_design::Theme;
use styk_platform::window::Image;
use styk_ui::component_sheet::Sheet;
use styk_ui::screens::Screen;

/// Draws the interface in `theme`, `size` logical pixels at `scale`, and returns the picture (RGBA, top row first).
///
/// Fails when the machine has no graphics adapter the renderer can use.
pub fn screenshot(theme: Theme, size: (u32, u32), scale: f32, sheet: Option<&Sheet>, band: Option<Screen>) -> Result<Image, String> {
    pollster::block_on(screenshot_async(theme, size, scale, sheet, band, None))
}

/// A Properties panel screen: its fixture's core, refreshed (never waited on) until the facts lane made what it shows.
pub fn inspector_screenshot(screen: Screen, size: (u32, u32), scale: f32) -> Result<Image, String> {
    let Screen::Inspector(context, _) = screen else { return Err("not a Properties panel screen".into()) };
    let core = pollster::block_on(prepared_core(context))?;
    pollster::block_on(screenshot_async(screen.theme(), size, scale, None, None, Some(&core)))
}

pub async fn prepared_core(context: styk_core::screens::InspectorScreen) -> Result<styk_core::app::Core, String> {
    let mut core = styk_core::screens::inspector(context, std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), std::sync::Arc::new(|| {}))?;
    for _ in 0..400 {
        core.refresh();
        let panel = core.inspector();
        if panel.model().is_some() && !panel.pending() && (context != styk_core::screens::InspectorScreen::Figures || panel.shown().bounds.is_some()) { return Ok(core); }
        pause().await?;
    }
    Err("Inspector facts were not ready after 400 refreshes".into())
}

/// Five milliseconds, on the platform's timer.
async fn pause() -> Result<(), String> {
    let (send, receive) = iced::futures::channel::oneshot::channel();
    styk_platform::diagnostics::after(std::time::Duration::from_millis(5), move || {
        if send.send(()).is_err() { eprintln!("headless capture timer receiver closed"); }
    })?;
    receive.await.map_err(|error| error.to_string())
}

async fn screenshot_async(theme: Theme, size: (u32, u32), scale: f32, sheet: Option<&Sheet>, band: Option<Screen>, inspector: Option<&styk_core::app::Core>) -> Result<Image, String> {
    let image = styk_ui::headless::screenshot(theme, size, scale, sheet, band, inspector.and_then(|core| styk_ui::inspector::View::of(core, theme)), styk_platform::font_smoothing::current(), iced::time::Instant::now(), pause).await?;
    Ok(Image { width: image.width, height: image.height, rgba: image.rgba })
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
