#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types))]
//! The iced front end.
//!
//! It lays out and draws what the core holds and turns input into core commands (`docs/native/architecture.md`): the
//! shell, the docking widgets, the stage, the timeline, the inspector, panels, dialogs, Home, Settings, drawing,
//! build and text input will live here, built from `styk-design`'s tokens and widgets. It never computes a feature.
//!
//! It depends on the core, the design system and iced, and on nothing that touches the operating system.

pub mod band;
pub mod component_sheet;
pub mod inspector;
pub mod message;
pub mod screens;

pub use message::Message;

use iced::widget::{column, container, row, space, stack};
use iced::{Element, Fill, Length, Widget, theme};
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

/// The window as it is now: the top band holding the window controls at its right edge, and the field below. Every
/// other screen is built into this as it lands; the band's other clusters (the mark, the project tabs, the
/// workspaces, history, Save and Export) arrive with the shell chunk of the interface.
pub fn shell<'a, Message: 'a>(theme: Theme, _ready: Ready, band_height: f32, controls: Element<'a, Message>) -> Element<'a, Message> {
    let palette = theme.palette();
    let (surface, line) = (iced::Color::from(palette.surface), iced::Color::from(palette.line_1));
    let band = container(row![space().width(Fill), controls]).width(Fill).height(Length::Fixed(band_height)).style(move |_| container::Style::default().background(surface));
    // `box-shadow: inset 0 -1px 0 var(--line-1)`: a line over the band's last pixel row.
    let rule = container(container(space()).width(Fill).height(Length::Fixed(1.0)).style(move |_| container::Style::default().background(line))).width(Fill).height(Length::Fixed(band_height)).align_bottom(Length::Fixed(band_height));
    column![stack![band, rule].boxed(), loading(theme)].boxed()
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
