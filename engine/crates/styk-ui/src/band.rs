//! The top band's window controls, drawn as `topbar.css` draws them.
//!
//! Minimize, maximize and close sit flush with the window's right edge and fill the band's height: 44 px wide, 36 px
//! once the band folds `winctl`, 16 px glyphs, `surface-hover` on hover, and `danger-soft` with `danger-text` for
//! close. Minimize and close are ordinary buttons. Maximize is a non-client area (the window answers `HTMAXBUTTON` for
//! it, which is what makes Windows 11 show its snap layouts), so the pointer never reaches it as a client event: its
//! hover and press are drawn from the state the window reports.

use iced::widget::{button, container, mouse_area, row};
use iced::{Alignment, Border, Color, Element, Length, Shadow, Theme as IcedTheme, Widget};
use styk_design::Theme;
use styk_design::widgets::icon;
use styk_core::services::shell::chrome::{CONTROL_GLYPH, MaxButtonState, control_width};

/// Which of the two clickable controls the pointer is over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hot {
    /// Minimize.
    Minimize,
    /// Close.
    Close,
}

/// What the controls need to be drawn.
#[derive(Clone, Copy, Debug)]
pub struct Controls {
    /// The design theme.
    pub theme: Theme,
    /// The band folded its window controls to the narrow width.
    pub folded: bool,
    /// The band's height in logical pixels (`--topbar-h`).
    pub height: f32,
    /// How the maximize button looks now.
    pub maximize: MaxButtonState,
    /// The control the pointer is over, if one.
    pub hover: Option<Hot>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Plain,
    Close,
}

/// The background and the glyph colour of a control at rest or hot. The glyph is part of the hover look: Close's goes
/// from `text-2` to `danger-text` with its background.
fn colors(theme: Theme, kind: Kind, hot: bool) -> (Option<Color>, Color) {
    let palette = theme.palette();
    match (kind, hot) {
        (_, false) => (None, palette.text_2.into()),
        (Kind::Plain, true) => (Some(palette.surface_hover.into()), palette.text_1.into()),
        (Kind::Close, true) => (Some(palette.danger_soft.into()), palette.danger_text.into()),
    }
}

fn glyph<'a, M: 'a>(name: &str, color: Color) -> Element<'a, M> {
    icon(name, CONTROL_GLYPH as f32, color).boxed()
}

/// A control that is an iced button: minimize and close. The hover look comes from the state the application keeps (the
/// pointer entering and leaving), not from the button's own status, because an svg inside a button does not follow the
/// button's text colour.
fn control<'a, M: Clone + 'a>(controls: Controls, name: &'static str, kind: Kind, hot: Hot, message: M, on_hover: fn(Option<Hot>) -> M) -> Element<'a, M> {
    let (width, height, theme) = (control_width(controls.folded) as f32, controls.height, controls.theme);
    let (background, glyph_color) = colors(theme, kind, controls.hover == Some(hot));
    let face = container(glyph::<M>(name, glyph_color))
        .center_x(Length::Fixed(width))
        .center_y(Length::Fixed(height))
        .style(move |_| container::Style::default().background(background.unwrap_or(Color::TRANSPARENT)));
    let clickable = button(face)
        .width(Length::Fixed(width))
        .height(Length::Fixed(height))
        .padding(0)
        .on_press(message)
        .style(|_: &IcedTheme, _| button::Style { background: None, text_color: Color::TRANSPARENT, border: Border::default(), shadow: Shadow::default(), snap: true });
    mouse_area(clickable).on_enter(on_hover(Some(hot))).on_exit(on_hover(None)).boxed()
}

/// The maximize control: drawn from the reported state, since the pointer is in the non-client area over it.
fn maximize<'a, M: 'a>(controls: Controls) -> Element<'a, M> {
    let hot = !matches!(controls.maximize, MaxButtonState::Idle);
    let (background, text) = colors(controls.theme, Kind::Plain, hot);
    container(glyph::<M>("window-maximize", text))
        .width(Length::Fixed(control_width(controls.folded) as f32))
        .height(Length::Fixed(controls.height))
        .center_x(Length::Fixed(control_width(controls.folded) as f32))
        .center_y(Length::Fixed(controls.height))
        .style(move |_| container::Style::default().background(background.unwrap_or(Color::TRANSPARENT)))
        .boxed()
}

/// The three window controls, minimize, maximize, close, in a row. `on_hover` is told when the pointer enters or leaves
/// minimize or close; the application keeps it and passes it back in `controls.hover`.
pub fn window_controls<'a, M: Clone + 'a>(controls: Controls, on_minimize: M, on_close: M, on_hover: fn(Option<Hot>) -> M) -> Element<'a, M> {
    row![
        control(controls, "window-minimize", Kind::Plain, Hot::Minimize, on_minimize, on_hover),
        maximize(controls),
        control(controls, "close", Kind::Close, Hot::Close, on_close, on_hover)
    ]
    .align_y(Alignment::Start)
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_is_the_only_control_that_goes_red_and_hover_is_the_themes_hover() {
        for theme in [Theme::Light, Theme::Dark] {
            let palette = theme.palette();
            let (plain_bg, plain_text) = colors(theme, Kind::Plain, true);
            assert_eq!((plain_bg, plain_text), (Some(palette.surface_hover.into()), palette.text_1.into()));
            let (close_bg, close_text) = colors(theme, Kind::Close, true);
            assert_eq!((close_bg, close_text), (Some(palette.danger_soft.into()), palette.danger_text.into()));
            let (rest_bg, rest_text) = colors(theme, Kind::Close, false);
            assert_eq!((rest_bg, rest_text), (None, palette.text_2.into()), "at rest every control is transparent with text-2");
        }
    }

    #[test]
    fn closes_glyph_turns_with_its_background_when_the_pointer_is_over_it() {
        for theme in [Theme::Light, Theme::Dark] {
            let (_, resting) = colors(theme, Kind::Close, false);
            let (background, hot) = colors(theme, Kind::Close, true);
            assert_ne!(resting, hot, "the glyph colour changes with hover");
            assert_eq!(hot, Color::from(theme.palette().danger_text));
            assert_eq!(background, Some(Color::from(theme.palette().danger_soft)));
        }
    }

    #[test]
    fn the_controls_build_at_both_widths_in_every_state() {
        for folded in [false, true] {
            for state in [MaxButtonState::Idle, MaxButtonState::Hover, MaxButtonState::Pressed { armed: true }, MaxButtonState::Pressed { armed: false }] {
                for hover in [None, Some(Hot::Minimize), Some(Hot::Close)] {
                    let controls = Controls { theme: Theme::Dark, folded, height: 52.0, maximize: state, hover };
                    let _: Element<'_, ()> = window_controls(controls, (), (), |_| ());
                }
            }
        }
    }
}
