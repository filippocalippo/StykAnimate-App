//! Where a panel sits until the docking chunk lands: today's default right dock (the Properties panel, 320 px wide,
//! `.shell-panel`). A panel's view fills whatever bounds it is given; only this module decides them.

use iced::widget::{Space, container, stack};
use iced::{Background, Color, Element, Length, Widget as _};
use styk_design::Theme;

/// The default panel width of today's right dock.
pub const DEFAULT_WIDTH: f32 = 320.0;

/// A hairline over the top edge of `content`, taking no room (`box-shadow: inset 0 1px 0 var(--line-1)`).
pub fn hairline_over<'a, Message: 'a>(content: Element<'a, Message>, theme: Theme) -> Element<'a, Message> {
    let palette = theme.palette();
    let line = container(Space::new().width(Length::Fill).height(1.0))
        .width(Length::Fill)
        .style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.line_1))), ..container::Style::default() });
    stack![content, line].boxed()
}

/// `content` as today's docked panel, at the default width: the surface edge to edge under a hairline. The dock's own
/// rounded container (its corners) is the docking chunk's.
pub fn docked<'a, Message: 'a>(content: Element<'a, Message>, theme: Theme) -> Element<'a, Message> {
    let palette = theme.palette();
    let panel = container(content)
        .width(Length::Fixed(DEFAULT_WIDTH))
        .height(Length::Fill)
        .style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.surface))), ..container::Style::default() });
    hairline_over(panel.boxed(), theme)
}
