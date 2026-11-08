//! The live-parameters panel: every registered value with a control of its type, its default, and a reset.

use super::chrome::{frame, padded, quiet};
use super::{Context, Message, icon_button, id, send};
use crate::params::{Kind, Parameter};
use iced::widget::{Column, Row, container};
use iced::{Widget as _, Alignment, Element, Length};
use styk_core::dev_extension::{Event, Panel, Value};
use styk_core::focus::{FocusArea, FocusId};
use styk_core::i18n::Msg;
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::widgets::control::words;
use styk_design::widgets::parts::{empty_state, scroll, stepper};
use styk_design::widgets::badge::Chip;
use styk_design::widgets::toggle::Switch;

pub const PREVIOUS: u64 = 1;
pub const NEXT: u64 = 2;
/// A row's controls take ids from here, `ROW` apart: the control, then the reset.
pub const ROWS: u64 = 16;
const ROW: u64 = 64;

/// The id of the control of row `index` of the page, and of its reset.
pub fn control(index: usize) -> u64 {
    ROWS + index as u64 * ROW
}
pub fn reset(index: usize) -> u64 {
    control(index) + ROW - 1
}

fn page(offset: usize) -> Message {
    send(Event::ParametersPage(offset))
}

pub fn view<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let model = context.parameters;
    let rows: Element<'a, Message> = if model.rows.is_empty() {
        empty_state(palette, Some(Panel::Parameters.icon()), context.word("dev.params.empty"), None, None, false)
    } else {
        Column::with_children(model.rows.iter().enumerate().map(|(index, row)| parameter(context, index, row)).collect::<Vec<_>>()).spacing(scale::SPACE_3).width(Length::Fill).boxed()
    };
    let shown = model.rows.len();
    let counts = context.say(
        Msg::new("dev.params.counts")
            .with("from", if shown == 0 { 0.0 } else { (model.offset + 1) as f64 })
            .with("to", (model.offset + shown) as f64)
            .with("total", model.total as f64),
    );
    let previous = model.previous();
    let footer = Row::with_children(vec![
        container(quiet(palette, counts)).width(Length::Fill).boxed(),
        icon_button(context, PREVIOUS, Panel::Parameters, "chevron-left", context.word("dev.page.previous"), previous.is_some(), page(previous.unwrap_or(0))),
        icon_button(context, NEXT, Panel::Parameters, "chevron-right", context.word("dev.page.next"), model.next.is_some(), page(model.next.unwrap_or(0))),
    ])
    .spacing(scale::SPACE_1)
    .align_y(Alignment::Center);
    let content = Column::with_children(vec![container(scroll(palette, padded(rows))).height(Length::Fill).boxed(), padded(footer.boxed())]).width(Length::Fill).height(Length::Fill);
    frame(context, Panel::Parameters, Vec::new(), content.boxed())
}

/// A value as the panel writes it, with its unit.
fn shown(context: &Context<'_>, parameter: &Parameter, value: &crate::ParameterValue) -> String {
    let number = |value: f64| context.presentation.number((value * 1000.0).round() / 1000.0);
    let text = match &parameter.descriptor.kind {
        Kind::Float { .. } | Kind::Integer { .. } => value.as_f64().map(number).unwrap_or_default(),
        Kind::Bool => value.as_bool().map(|on| context.word(if on { "dev.on" } else { "dev.off" })).unwrap_or_default(),
        Kind::Enum(_) => value.as_str().unwrap_or_default().to_string(),
    };
    if parameter.descriptor.unit.is_empty() || matches!(parameter.descriptor.kind, Kind::Bool | Kind::Enum(_)) { text } else { format!("{text} {}", parameter.descriptor.unit) }
}

fn parameter<'a>(context: &Context<'_>, index: usize, row: &Parameter) -> Element<'a, Message> {
    let palette = context.palette();
    let name = row.descriptor.name.clone();
    let enabled = context.availability.parameters;
    let first = id(Panel::Parameters, control(index));
    let area = FocusArea::Panels;
    let set = {
        let name = name.clone();
        std::rc::Rc::new(move |value: Value| send(Event::Set { name: name.clone(), value }))
    };
    let control: Element<'a, Message> = match &row.descriptor.kind {
        // One press is one request: a drag would send a request per move, and the host refuses while one is pending.
        Kind::Float { min, max } => {
            let step = if max > min { (max - min) / 100.0 } else { 1.0 };
            let value = row.effective.as_f64().unwrap_or(*min);
            stepper(palette, first, area, context.presentation.number((value * 1000.0).round() / 1000.0), !enabled, false, move |direction| set(Value::Float(value + step * f64::from(direction))))
        }
        Kind::Integer { min, max } => {
            let value = row.effective.as_i64().unwrap_or(*min).clamp(*min, *max);
            stepper(palette, first, area, context.presentation.number(value as f64), !enabled, false, move |direction| set(Value::Integer(value.saturating_add(i64::from(direction)))))
        }
        Kind::Bool => Switch::new(first, area, palette, row.effective.as_bool().unwrap_or(false), move |on| set(Value::Bool(on))).disabled(!enabled).into_element(),
        Kind::Enum(options) => {
            let chosen = row.effective.as_str().and_then(|current| options.iter().position(|option| option == current));
            Row::with_children(
                options
                    .iter()
                    .enumerate()
                    .map(|(position, option)| {
                        let set = set.clone();
                        Chip::new(FocusId(first.0 + position as u64), area, palette, option.clone(), set(Value::Enum(option.clone()))).on(chosen == Some(position)).disabled(!enabled).into_element()
                    })
                    .collect::<Vec<_>>(),
            )
            .spacing(scale::SPACE_1)
            .wrap()
            .vertical_spacing(scale::SPACE_1)
            .boxed()
        }
    };
    let head: Vec<Element<'a, Message>> = vec![
        container(words(name.clone(), TextStyle::from_role(&scale::TYPE_UI_STRONG), palette.text_1)).width(Length::Fill).boxed(),
        words(shown(context, row, &row.effective), TextStyle::from_role(&scale::TYPE_VALUE), palette.text_2),
        icon_button(context, reset(index), Panel::Parameters, "reset", context.word("dev.reset"), enabled && row.modified, send(Event::Reset(name))),
    ];
    let mut notes: Vec<String> = vec![context.say(Msg::new("dev.params.default").with("value", shown(context, row, &row.descriptor.default)))];
    if row.modified {
        notes.push(context.word("dev.params.modified"));
    }
    if let Some(pending) = &row.pending {
        notes.push(context.say(Msg::new("dev.params.pending").with("value", shown(context, row, pending))));
    }
    if row.descriptor.restart {
        notes.push(context.word("dev.params.restart"));
    }
    Column::with_children(vec![Row::with_children(head).spacing(scale::SPACE_2).align_y(Alignment::Center).boxed(), control, quiet(palette, notes.join("  "))]).spacing(scale::SPACE_1).width(Length::Fill).boxed()
}
