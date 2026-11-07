//! The top band's window controls, drawn as `topbar.css` draws them.
//!
//! Minimize, maximize and close sit flush with the window's right edge and fill the band's height: 44 px wide, 36 px
//! once the band folds `winctl`, 16 px glyphs, `surface-hover` on hover, and `danger-soft` with `danger-text` for
//! close. Minimize and close are ordinary buttons. Maximize is a non-client area (the window answers `HTMAXBUTTON` for
//! it, which is what makes Windows 11 show its snap layouts), so the pointer never reaches it as a client event: its
//! hover and press are drawn from the state the window reports.

use iced::widget::{button, container, row};
use iced::{Alignment, Background, Border, Color, Element, Length, Shadow, Theme as IcedTheme, Widget};
use styk_design::Theme;
use styk_design::widgets::icon;
use styk_services::shell::chrome::{CONTROL_GLYPH, MaxButtonState, control_width};

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
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Plain,
    Close,
}

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

/// A control that is an iced button: minimize and close.
fn control<'a, M: Clone + 'a>(controls: Controls, name: &'static str, kind: Kind, message: M) -> Element<'a, M> {
    let (width, height, theme) = (control_width(controls.folded) as f32, controls.height, controls.theme);
    let (_, resting) = colors(theme, kind, false);
    button(container(glyph::<M>(name, resting)).center_x(Length::Fill).center_y(Length::Fill))
        .width(Length::Fixed(width))
        .height(Length::Fixed(height))
        .padding(0)
        .on_press(message)
        .style(move |_: &IcedTheme, status| {
            let hot = matches!(status, button::Status::Hovered | button::Status::Pressed);
            let (background, text) = colors(theme, kind, hot);
            button::Style { background: background.map(Background::Color), text_color: text, border: Border::default(), shadow: Shadow::default(), snap: true }
        })
        .boxed()
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

/// The three window controls, minimize, maximize, close, in a row.
pub fn window_controls<'a, M: Clone + 'a>(controls: Controls, on_minimize: M, on_close: M) -> Element<'a, M> {
    row![control(controls, "window-minimize", Kind::Plain, on_minimize), maximize(controls), control(controls, "close", Kind::Close, on_close)].align_y(Alignment::Start).boxed()
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
    fn the_controls_build_at_both_widths_in_every_state() {
        for folded in [false, true] {
            for state in [MaxButtonState::Idle, MaxButtonState::Hover, MaxButtonState::Pressed { armed: true }, MaxButtonState::Pressed { armed: false }] {
                let controls = Controls { theme: Theme::Dark, folded, height: 52.0, maximize: state };
                let _: Element<'_, ()> = window_controls(controls, (), ());
            }
        }
    }
}
