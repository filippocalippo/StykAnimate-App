//! Where a panel sits until the docking chunk lands: today's default right dock (the Properties panel's card, 320 px
//! wide, `.shell-panel`). A panel's view fills whatever bounds it is given; only this module decides them.

use iced::widget::container;
use iced::{Background, Border, Color, Element, Length, Widget as _};
use styk_design::{Theme, tokens};

/// The default panel width of today's right dock.
pub const DEFAULT_WIDTH: f32 = 320.0;

/// `content` in today's docked panel card, at the default width.
pub fn docked<'a, Message: 'a>(content: Element<'a, Message>, theme: Theme) -> Element<'a, Message> {
    let palette = theme.palette();
    container(content)
        .width(Length::Fixed(DEFAULT_WIDTH))
        .height(Length::Fill)
        .style(move |_| container::Style {
            background: Some(Background::Color(Color::from(palette.surface))),
            border: Border { color: palette.line_1.into(), width: 1.0, radius: tokens::scale::RADIUS_LG.into() },
            ..container::Style::default()
        })
        .boxed()
}
