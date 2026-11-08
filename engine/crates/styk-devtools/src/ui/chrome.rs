//! What every developer panel shares: the header with the developer mark, error line, and the section frame.

use super::{Context, Message};
use crate::panels::DESCRIPTORS;
use iced::widget::{Column, Row, Space, container};
use iced::{Alignment, Background, Border, Element, Length, Padding, Widget as _};
use styk_core::dev_extension::Panel;
use styk_design::Palette;
use styk_design::tokens::{primitives::VIOLET_500, scale};
use styk_design::typography::TextStyle;
use styk_design::widgets::control::words;
use styk_design::widgets::parts::island_head;

/// The single hue product chrome does not use: the developer accent (`dev.accent`, aliasing `--violet-500`).
pub const ACCENT: styk_design::Rgba = VIOLET_500;

/// The developer mark: a neutral "Dev" tile on the well with the accent's dot (design 3.4).
pub fn mark<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let dot = container(Space::new())
        .width(Length::Fixed(6.0))
        .height(Length::Fixed(6.0))
        .style(|_| container::Style { background: Some(Background::Color(ACCENT.into())), border: Border { radius: 3.0.into(), ..Border::default() }, ..container::Style::default() });
    let label = words(context.word("dev.mark"), TextStyle::from_role(&scale::TYPE_MICRO), palette.text_2);
    let row = Row::with_children(vec![dot.boxed(), label]).spacing(scale::SPACE_1).align_y(Alignment::Center);
    let well = palette.surface_well;
    container(row)
        .padding(Padding { top: 0.0, right: scale::SPACE_1_5, bottom: 0.0, left: scale::SPACE_1_5 })
        .height(Length::Fixed(20.0))
        .center_y(Length::Fixed(20.0))
        .style(move |_| container::Style { background: Some(Background::Color(well.into())), border: Border { radius: scale::RADIUS_XS.into(), ..Border::default() }, ..container::Style::default() })
        .boxed()
}

/// The panel's header: its name, then the mark, and `actions` after it.
pub fn header<'a>(context: &Context<'_>, panel: Panel, mut actions: Vec<Element<'a, Message>>) -> Element<'a, Message> {
    let title = DESCRIPTORS.iter().find(|descriptor| descriptor.panel == panel).map_or(panel.id(), |descriptor| descriptor.title);
    let mut parts = vec![mark(context)];
    parts.append(&mut actions);
    island_head(context.palette(), context.say(styk_core::i18n::Msg::new(title)), parts)
}

/// A panel body: the header, the host's error line when there is one, then the content, each on the panel's padding.
pub fn frame<'a>(context: &Context<'_>, panel: Panel, actions: Vec<Element<'a, Message>>, content: Element<'a, Message>) -> Element<'a, Message> {
    let palette = context.palette();
    let mut column: Vec<Element<'a, Message>> = vec![header(context, panel, actions)];
    if let Some(error) = context.error {
        column.push(container(words(context.presentation.text(error), TextStyle::from_role(&scale::TYPE_SMALL), palette.danger_text)).padding(Padding { top: 0.0, right: scale::SPACE_3, bottom: scale::SPACE_1_5, left: scale::ISLAND_PAD }).width(Length::Fill).boxed());
    }
    column.push(container(content).width(Length::Fill).height(Length::Fill).boxed());
    Column::with_children(column).width(Length::Fill).height(Length::Fill).boxed()
}

/// A quiet line of text under a heading.
pub fn quiet<'a>(palette: &'static Palette, text: String) -> Element<'a, Message> {
    words(text, TextStyle::from_role(&scale::TYPE_SMALL), palette.text_3)
}

/// The panel's side padding.
pub fn padded<'a>(content: Element<'a, Message>) -> Element<'a, Message> {
    container(content).width(Length::Fill).padding(Padding { top: 0.0, right: scale::SPACE_3, bottom: scale::SPACE_2, left: scale::ISLAND_PAD }).boxed()
}
