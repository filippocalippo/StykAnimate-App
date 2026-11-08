//! The logs panel: the level, module and text filters, and the page of lines the worker made.

use super::chrome::{frame, padded, quiet};
use super::{Context, Message, icon_button, id, send};
use crate::panels::LogsModel;
use iced::widget::{Column, Row, container};
use iced::{Widget as _, Alignment, Element, Length, Padding};
use styk_core::dev_extension::{Event, Panel};
use styk_core::field::Role;
use styk_core::focus::FocusArea;
use styk_core::i18n::Msg;
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::widgets::badge::Chip;
use styk_design::widgets::control::words;
use styk_design::widgets::field::EditField;
use styk_design::widgets::parts::{empty_state, scroll};

/// The level control takes six consecutive ids from here.
pub const LEVEL: u64 = 1;
pub const MODULE: u64 = 10;
pub const TEXT: u64 = 11;
pub const PREVIOUS: u64 = 12;
pub const NEXT: u64 = 13;

/// The levels the filter offers, in the facade's order: 0 is every line, then error to trace.
const LEVELS: [&str; 6] = ["dev.level.all", "dev.level.error", "dev.level.warn", "dev.level.info", "dev.level.debug", "dev.level.trace"];

/// The same filter with one field changed, as the typed event that reaches the host. A new filter starts at the first page.
fn filter(model: &LogsModel, change: impl FnOnce(&mut Event)) -> Message {
    let mut event = Event::Filter { level: model.filter.level, module: model.filter.module.clone(), text: model.filter.text.clone() };
    change(&mut event);
    send(event)
}

fn page(_model: &LogsModel, offset: usize) -> Message {
    send(Event::LogsPage(offset))
}

pub fn view<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let model = context.logs;
    let chosen = usize::from(model.filter.level).min(LEVELS.len() - 1);
    let levels = Row::with_children(
        LEVELS
            .iter()
            .enumerate()
            .map(|(index, key)| {
                let model = model.clone();
                Chip::new(id(Panel::Logs, LEVEL + index as u64), FocusArea::Panels, palette, context.word(key), filter(&model, |event| if let Event::Filter { level, .. } = event { *level = index as u8 })).on(index == chosen).into_element()
            })
            .collect::<Vec<_>>(),
    )
    .spacing(scale::SPACE_1)
    .wrap()
    .vertical_spacing(scale::SPACE_1);
    let field = |slot: u64, placeholder: &'static str, value: &str, change: fn(&mut Event, String)| -> Element<'a, Message> {
        let model = model.clone();
        EditField::new(id(Panel::Logs, slot), FocusArea::Panels, Role::Search, value.to_string(), palette)
            .placeholder(context.word(placeholder))
            .composing(context.composing)
            .on_input(move |text| filter(&model, |event| change(event, text)))
            .on_compose(Message::Compose)
            .into_element()
    };
    let module = field(MODULE, "dev.logs.module", &model.filter.module, |event, text| {
        if let Event::Filter { module, .. } = event {
            *module = text;
        }
    });
    let text = field(TEXT, "dev.logs.text", &model.filter.text, |event, text| {
        if let Event::Filter { text: slot, .. } = event {
            *slot = text;
        }
    });
    let filters = Row::with_children(vec![container(module).width(Length::Fill).boxed(), container(text).width(Length::Fill).boxed()]).spacing(scale::SPACE_2);
    let lines: Element<'a, Message> = if model.page.lines.is_empty() {
        empty_state(palette, Some(Panel::Logs.icon()), context.word("dev.logs.empty"), None, None, false)
    } else {
        Column::with_children(model.page.lines.iter().map(|line| row(context, line)).collect::<Vec<_>>()).width(Length::Fill).boxed()
    };
    let content = Column::with_children(vec![
        padded(levels.boxed()),
        padded(filters.boxed()),
        container(scroll(palette, lines)).height(Length::Fill).padding(Padding { top: 0.0, right: scale::SPACE_1, bottom: 0.0, left: scale::SPACE_1 }).boxed(),
        padded(footer(context)),
    ])
    .spacing(scale::SPACE_1)
    .width(Length::Fill)
    .height(Length::Fill);
    frame(context, Panel::Logs, Vec::new(), content.boxed())
}

/// One line: its level, the time on the span clock, the module and the text.
fn row<'a>(context: &Context<'_>, line: &crate::logs::Line) -> Element<'a, Message> {
    let palette = context.palette();
    let small = TextStyle::from_role(&scale::TYPE_SMALL);
    let (name, ink) = match line.level {
        1 => (LEVELS[1], palette.danger_text),
        2 => (LEVELS[2], palette.warning_text),
        3 => (LEVELS[3], palette.text_2),
        4 => (LEVELS[4], palette.text_3),
        _ => (LEVELS[5], palette.text_3),
    };
    let seconds = (line.time_ns as f64 / 1e9 * 1000.0).round() / 1000.0;
    let mut text = line.text.clone();
    if line.truncated {
        text.push_str(" (");
        text.push_str(&context.word("dev.logs.truncated"));
        text.push(')');
    }
    let cells: Vec<Element<'a, Message>> = vec![
        container(words(context.word(name), TextStyle::from_role(&scale::TYPE_MICRO), ink)).width(Length::Fixed(40.0)).boxed(),
        container(words(context.presentation.number(seconds), small, palette.text_3)).width(Length::Fixed(56.0)).boxed(),
        container(words(line.module.clone(), small, palette.text_2)).width(Length::Fixed(150.0)).boxed(),
        container(words(text, small, palette.text_1)).width(Length::Fill).boxed(),
    ];
    container(Row::with_children(cells).spacing(scale::SPACE_2).align_y(Alignment::Start)).padding(Padding { top: scale::SPACE_0_5, right: scale::SPACE_2, bottom: scale::SPACE_0_5, left: scale::SPACE_2 }).width(Length::Fill).boxed()
}

/// The range shown, what the ring dropped, and the pager.
fn footer<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let model = context.logs;
    let shown = model.page.lines.len();
    let counts = context.say(
        Msg::new("dev.logs.counts")
            .with("from", if shown == 0 { 0.0 } else { (model.filter.offset + 1) as f64 })
            .with("to", (model.filter.offset + shown) as f64)
            .with("total", model.page.total as f64),
    );
    let mut note = counts;
    if model.page.dropped > 0 {
        note.push_str("  ");
        note.push_str(&context.say(Msg::new("dev.logs.dropped").with("count", model.page.dropped as f64)));
    }
    let previous = model.previous();
    let next = model.next();
    Row::with_children(vec![
        container(quiet(palette, note)).width(Length::Fill).boxed(),
        icon_button(context, PREVIOUS, Panel::Logs, "chevron-left", context.word("dev.page.previous"), previous.is_some(), page(model, previous.unwrap_or(0))),
        icon_button(context, NEXT, Panel::Logs, "chevron-right", context.word("dev.page.next"), next.is_some(), page(model, next.unwrap_or(0))),
    ])
    .spacing(scale::SPACE_1)
    .align_y(Alignment::Center)
    .boxed()
}
