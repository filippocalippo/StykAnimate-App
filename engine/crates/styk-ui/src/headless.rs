//! Shared catalogue renderer; hosts supply platform text settings and the asynchronous retry timer.
use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::{Pixels, Size, Widget as _, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use styk_design::{Theme, warm_up, widgets};

use crate::component_sheet::Sheet;
use crate::screens::Screen;


/// A screen whose content is built by the host (the stage: a widget that needs the engine, which this module does not link):
/// its view, and whether what it shows is complete (a picture the paint worker is still making is not).
pub struct Scene<'a> { pub view: iced::Element<'a, ()>, pub ready: Box<dyn Fn() -> bool + 'a> }

/// An RGBA capture, top row first.
pub struct Image { pub width: u32, pub height: u32, pub rgba: Vec<u8> }

pub async fn screenshot(theme: Theme, size: (u32, u32), scale: f32, sheet: Option<&Sheet>, band: Option<Screen>, panel: Option<crate::inspector::View<'_>>, scene: Option<Scene<'_>>, smoothing: styk_core::services::text_environment::FontSmoothing, now: iced::time::Instant, mut pause: impl AsyncFnMut() -> Result<(), String>) -> Result<Image, String> {
    let settings = iced::Settings { font: widgets::INTER, text_size: Pixels(16.0), ..iced::Settings::default() };
    let mut renderer = <iced::Renderer as Headless>::new(renderer::Settings::from(&settings), None).await.ok_or("no graphics adapter is available to draw offscreen")?;
    // Nothing here is an event loop to keep responsive: the font system is built and the bundled fonts installed in place.
    let ready = warm_up::install_bundled(smoothing);
    let bounds = Size::new(size.0 as f32, size.1 as f32);
    let style = crate::window_style(theme);
    let iced_theme = crate::base_theme(theme);
    // A band screen: the band over its window, laid out for this size with its words measured.
    let english = styk_core::i18n::Presentation::english();
    let shell = band.map(|screen| crate::screens::band_shell(screen, size, crate::shell::measure_labels(ready, &english)));
    let (scene_view, scene_ready) = match scene { Some(scene) => (Some(scene.view), Some(scene.ready)), None => (None, None) };
    let view: iced::Element<'_, ()> = match (sheet, shell.as_ref()) {
        _ if scene_view.is_some() => scene_view.unwrap_or_else(|| crate::loading(theme)),
        _ if panel.is_some() => match panel { Some(panel) => crate::dock::docked(crate::inspector::view(panel), theme).map(|_| ()).boxed(), None => crate::loading(theme) },
        (Some(sheet), _) => sheet.view().map(|_| ()).boxed(),
        (None, Some(shell)) => crate::shell::window(crate::shell::Params { shell, theme, ready, presentation: &english, maximize: styk_core::services::shell::chrome::MaxButtonState::Idle }, crate::loading(theme)).map(|_| ()).boxed(),
        (None, None) => crate::view(theme, ready),
    };
    let mut interface: UserInterface<'_, (), iced::Theme, iced::Renderer> = UserInterface::build(view, bounds, Cache::default(), &mut renderer);
    // One redraw, so widgets that lay themselves out on their first frame have.
    let _ = interface.update(
        &window::Headless,
        &shell::Waker::noop(),
        &[iced::event::Event::Window(window::Event::RedrawRequested(now))],
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
        if !styk_design::glyphs::incomplete() && scene_ready.as_ref().is_none_or(|ready| ready()) {
            return Ok(Image { width: physical.width, height: physical.height, rgba });
        }
        pause().await?;
    }
    Err("the text was still missing glyphs after 400 frames: the glyph worker did not deliver".to_string())
}
