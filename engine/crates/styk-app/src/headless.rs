//! Drawing the interface without a window.
//!
//! Where an unattended run cannot keep a window off the person's desktop (Wayland, macOS: see
//! `styk_platform::unattended`) it opens none. The interface is built and drawn by the same `iced_wgpu` renderer a
//! window uses, into a picture of the requested size.

use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::{Pixels, Size, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use styk_design::{Theme, fonts, widgets};
use styk_platform::window::Image;

/// Draws the interface in `theme`, `size` logical pixels at `scale`, and returns the picture (RGBA, top row first).
///
/// Fails when the machine has no graphics adapter the renderer can use.
pub fn screenshot(theme: Theme, size: (u32, u32), scale: f32) -> Result<Image, String> {
    let settings = iced::Settings { font: widgets::INTER, text_size: Pixels(16.0), ..iced::Settings::default() };
    let mut renderer = pollster::block_on(<iced::Renderer as Headless>::new(renderer::Settings::from(&settings), None)).ok_or("no graphics adapter is available to draw offscreen")?;
    {
        let mut system = iced::advanced::graphics::text::font_system().write().map_err(|_| "the font system is poisoned")?;
        for font in fonts::ALL {
            system.load_font(std::borrow::Cow::Borrowed(font));
        }
    }
    let bounds = Size::new(size.0 as f32, size.1 as f32);
    let style = styk_ui::window_style(theme);
    let iced_theme = styk_ui::base_theme(theme);
    let mut interface: UserInterface<'_, (), iced::Theme, iced::Renderer> = UserInterface::build(styk_ui::view(theme), bounds, Cache::default(), &mut renderer);
    // One redraw, so widgets that lay themselves out on their first frame have.
    let _ = interface.update(
        &window::Headless,
        &shell::Waker::noop(),
        &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))],
        mouse::Cursor::Unavailable,
        &mut renderer,
        &mut shell::Bus::new(),
    );
    interface.draw(&mut renderer, &iced_theme, &renderer::Style { text_color: style.text_color }, mouse::Cursor::Unavailable);
    let physical = Size::new((bounds.width * scale).round() as u32, (bounds.height * scale).round() as u32);
    let rgba = Headless::screenshot(&mut renderer, physical, scale, style.background_color);
    Ok(Image { width: physical.width, height: physical.height, rgba })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The picture, or nothing on a machine without a graphics adapter (a bare CI container), which cannot run this.
    fn picture(theme: Theme, size: (u32, u32), scale: f32) -> Option<Image> {
        match screenshot(theme, size, scale) {
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
