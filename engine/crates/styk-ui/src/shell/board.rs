//! The Ctrl+Tab board (`components/project-tabs.css`, `src/shell/project-switcher.mjs`): the open projects as cards under
//! the tabs, most recently used first, in a popover. A card is a picture of the stage (a placeholder until the stage
//! has drawn one), the name and whether the project is edited.

use super::controls::{color, elevation};
use super::{Message, Params, controls, text as words};
use iced::advanced::text::{Ellipsis, Wrapping};
use iced::widget::{column, container, mouse_area, pin, row, space, text};
use iced::{Alignment, Border, Color, Element, Length, Padding, Widget as _};
use styk_core::shell::switcher::board_columns;
use styk_core::shell::{Card, Event, Hover};
use styk_design::typography::TextStyle;
use styk_design::tokens;

/// The popover's widest, and what the window keeps clear (`min(716px, 100vw - space-4)`).
const WIDEST: f32 = 716.0;
/// The popover opens this far under the tab strip.
const OFFSET: f32 = 6.0;

pub(crate) fn view(params: &Params<'_>, cards: &[Card]) -> Element<'static, Message> {
    let shell = params.shell;
    let palette = params.theme.palette();
    let layout = shell.layout();
    let window = shell.window().width;
    let width = WIDEST.min(window - tokens::scale::SPACE_4);
    let padding = tokens::scale::SPACE_4;
    let inner = width - 2.0 * padding;
    let columns = board_columns(inner);
    let gap = tokens::scale::SPACE_1;
    let card_width = (inner - gap * (columns as f32 - 1.0)) / columns as f32;

    let selected_fill = color(palette.surface_selected);
    let selection_line = color(palette.selection_line);
    let hover_fill = color(palette.surface_hover);
    let hover = shell.hover();
    let name_style = TextStyle::from_role(&tokens::scale::TYPE_UI_STRONG);
    let state_style = TextStyle::from_role(&tokens::scale::TYPE_SMALL);
    let card_pad = tokens::scale::SPACE_1_5;
    let art_height = (card_width - 2.0 * card_pad) * 9.0 / 16.0;
    let placeholder = color(palette.artboard_placeholder);
    let ring = color(palette.swatch_ring);

    let rows: Vec<Element<'static, Message>> = cards
        .chunks(columns)
        .enumerate()
        .map(|(row_index, chunk)| {
            let cells: Vec<Element<'static, Message>> = chunk
                .iter()
                .enumerate()
                .map(|(column_index, card)| {
                    let index = row_index * columns + column_index;
                    let art = container(space()).width(Length::Fill).height(art_height).style(move |_| container::Style::default().background(placeholder).border(Border { color: ring, width: 1.0, radius: tokens::scale::RADIUS_SM.into() }));
                    let name = text(card.name.clone()).font(name_style.font).size(name_style.size).line_height(name_style.line()).color(color(palette.text_1)).wrapping(Wrapping::None).ellipsis(Ellipsis::End).width(Length::Fill);
                    let state = text(if card.edited { words::EDITED } else { words::SAVED }).font(state_style.font).size(state_style.size).line_height(state_style.line()).color(color(palette.text_3));
                    let body = column![art, space().height(tokens::scale::SPACE_1 - tokens::scale::SPACE_0_5), name, state].spacing(tokens::scale::SPACE_0_5);
                    let selected = card.selected;
                    let hot = hover == Some(Hover::Card(index));
                    let face = container(body)
                        .padding(Padding { top: card_pad, left: card_pad, right: card_pad, bottom: tokens::scale::SPACE_2 })
                        .width(Length::Fixed(card_width))
                        .style(move |_| {
                            let background = if selected { Some(selected_fill) } else if hot { Some(hover_fill) } else { None };
                            container::Style {
                                background: background.map(iced::Background::Color),
                                border: Border { color: if selected { selection_line } else { Color::TRANSPARENT }, width: if selected { 2.0 } else { 0.0 }, radius: tokens::scale::RADIUS_LG.into() },
                                ..container::Style::default()
                            }
                        });
                    mouse_area(face).on_press(Message::Shell(Event::SwitcherPick(index))).on_enter(controls::hover(Hover::Card(index))).on_exit(controls::unhover()).boxed()
                })
                .collect();
            row(cells).spacing(gap).boxed()
        })
        .collect();

    let grid = column(rows).spacing(gap);
    let hint = text(words::SWITCHER_HINT).font(state_style.font).size(state_style.size).line_height(state_style.line()).color(color(palette.text_3));
    let line = color(palette.line_1);
    let foot = container(row![space().width(Length::Fill), hint]).padding(Padding { top: tokens::scale::SPACE_2_5, left: tokens::scale::SPACE_3, right: tokens::scale::SPACE_3, bottom: tokens::scale::SPACE_3 }).width(Length::Fill);
    let rule = container(space()).width(Length::Fill).height(1.0).style(move |_| container::Style::default().background(line));
    let raised = color(palette.surface_raised);
    let lift = elevation(palette.elevation_3).1;
    let popover = container(column![container(grid).padding(padding).width(Length::Fill), rule, foot].align_x(Alignment::Start))
        .width(Length::Fixed(width))
        .style(move |_| container::Style { background: Some(iced::Background::Color(raised)), border: Border { radius: tokens::scale::RADIUS_XL.into(), ..Border::default() }, shadow: lift, ..container::Style::default() });
    let strip = layout.strip;
    // Opens at the strip's start, kept inside the window.
    let x = strip.x.min(window - width - tokens::scale::SPACE_2).max(tokens::scale::SPACE_2);
    pin(popover).x(x).y(strip.y + strip.height + OFFSET).boxed()
}
