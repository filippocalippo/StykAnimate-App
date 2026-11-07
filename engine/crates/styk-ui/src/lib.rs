//! The iced front end.
//!
//! It lays out and draws what the core holds and turns input into core commands (`docs/native/architecture.md`): the
//! shell, the docking widgets, the stage, the timeline, the inspector, panels, dialogs, Home, Settings, drawing,
//! build and text input will live here, built from `styk-design`'s tokens and widgets. It never computes a feature.
//!
//! It depends on the core, the design system and iced, and on nothing that touches the operating system.

pub mod component_sheet;
pub mod inspector;
pub mod message;
pub mod screens;

pub use message::Message;

use iced::widget::{container, space};
use iced::{Element, Fill, Widget, theme};
use styk_design::Theme;
use styk_design::warm_up::Ready;

/// The window's colours: the field the panels will float on, and the default text.
pub fn window_style(theme: Theme) -> theme::Style {
    let palette = theme.palette();
    theme::Style { background_color: palette.surface_field.into(), text_color: palette.text_1.into() }
}

/// The iced theme the toolkit's own widgets start from, matching the design theme.
pub fn base_theme(theme: Theme) -> iced::Theme {
    match theme {
        Theme::Light => iced::Theme::Light,
        Theme::Dark => iced::Theme::Dark,
    }
}

/// What the window shows until the font system is ready: the window field, filling it, and no text.
///
/// Nothing here may reach the font system (any text widget would): the first layout of text builds it on the calling
/// thread if the warm-up worker has not, and the window would freeze for the scan (`styk_design::warm_up`).
pub fn loading<'a, Message: 'a>(theme: Theme) -> Element<'a, Message> {
    let field = theme.palette().surface_field;
    container(space()).width(Fill).height(Fill).style(move |_| container::Style::default().background(iced::Color::from(field))).boxed()
}

/// What the window shows once the fonts are ready, which the `Ready` proves: for now only the window field. Every
/// screen that sets text is built here or below, never in [`loading`].
pub fn view<'a, Message: 'a>(theme: Theme, _ready: Ready) -> Element<'a, Message> {
    loading(theme)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_the_themes_field_with_its_text_colour() {
        let light = window_style(Theme::Light);
        assert_eq!(light.background_color.into_rgba8(), [0xec, 0xef, 0xf4, 255]);
        assert_eq!(light.text_color.into_rgba8(), [0x0c, 0x0d, 0x12, 255]);
        assert_ne!(window_style(Theme::Dark).background_color, light.background_color);
    }
}

pub mod ink_pad;
