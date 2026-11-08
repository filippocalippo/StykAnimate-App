//! The platform adapter for the shared headless renderer.
use styk_design::Theme;
use styk_platform::window::Image;
use styk_ui::{component_sheet::Sheet, screens::Screen};

pub fn screenshot(theme: Theme, size: (u32, u32), scale: f32, sheet: Option<&Sheet>, band: Option<Screen>) -> Result<Image, String> {
    let image = pollster::block_on(styk_ui::headless::screenshot(theme, size, scale, sheet, band, styk_platform::font_smoothing::current(), iced::time::Instant::now(), async || {
        let (send, receive) = iced::futures::channel::oneshot::channel();
        styk_platform::diagnostics::after(std::time::Duration::from_millis(5), move || {
            if send.send(()).is_err() { eprintln!("headless capture timer receiver closed"); }
        })?;
        receive.await.map_err(|error| error.to_string())
    }))?;
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
