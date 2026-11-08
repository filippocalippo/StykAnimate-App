//! The live-parameters panel: every registered value with a control of its type, its default, and a reset.

use super::chrome::{frame, padded, quiet};
use super::{Context, Message, icon_button, id, send};
use crate::params::{Kind, Parameter};
use iced::widget::{Column, Row, container};
use iced::{Widget as _, Alignment, Element, Length};
use styk_core::dev_extension::{Event, Panel};
use styk_core::focus::FocusArea;
use styk_core::i18n::Msg;
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::widgets::control::words;
use styk_design::widgets::parts::{empty_state, scroll, stepper};
use styk_design::widgets::badge::Chip;
use styk_design::widgets::toggle::Switch;

pub const PREVIOUS: u64 = 1;
pub const NEXT: u64 = 2;
/// The most choices an enum shows: the registry's own limit (`styk_devtools_engine::params`, 64 choices per enum).
pub const CHOICES: usize = 64;
/// The most rows a page draws. Rows past it are not drawn, so the id spaces below cannot overlap by construction.
pub const ROWS: usize = 256;
/// A row's control (and, for an enum, each of its choices) takes consecutive ids from here, `CHOICES` apart per row...
const CONTROLS: u64 = 16;
/// ...and every reset has its own id in a range after all the controls'.
const RESETS: u64 = CONTROLS + (ROWS * CHOICES) as u64;

/// The id of control `choice` of row `index` of the page (a stepper's two ends are choices 0 and 1).
pub fn control(index: usize, choice: usize) -> u64 {
    CONTROLS + (index.min(ROWS - 1) * CHOICES + choice.min(CHOICES - 1)) as u64
}
/// The id of the reset of row `index`.
pub fn reset(index: usize) -> u64 {
    RESETS + index.min(ROWS - 1) as u64
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
        Column::with_children(model.rows.iter().take(ROWS).enumerate().map(|(index, row)| parameter(context, index, row)).collect::<Vec<_>>()).spacing(scale::SPACE_3).width(Length::Fill).boxed()
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
    let first = id(Panel::Parameters, control(index, 0));
    // What the host holds for the value: the pending one where an edit waits for a restart, else the acknowledged one.
    let current = row.pending.as_ref().unwrap_or(&row.effective);
    let area = FocusArea::Panels;
    let set = {
        let name = name.clone();
        std::rc::Rc::new(move |step: Option<i32>, choice: Option<usize>| send(match (step, choice) { (Some(direction), _) => Event::Step { name: name.clone(), direction }, (_, Some(index)) => Event::Choose { name: name.clone(), index }, _ => Event::Toggle(name.clone()) }))
    };
    let control: Element<'a, Message> = match &row.descriptor.kind {
        // One press is one request: a drag would send a request per move, and the host refuses while one is pending.
        Kind::Float { min, .. } => {
            let value = current.as_f64().unwrap_or(*min);
            stepper(palette, first, area, context.presentation.number((value * 1000.0).round() / 1000.0), !enabled, false, move |direction| set(Some(direction), None))
        }
        Kind::Integer { min, max } => {
            let value = current.as_i64().unwrap_or(*min).clamp(*min, *max);
            stepper(palette, first, area, context.presentation.number(value as f64), !enabled, false, move |direction| set(Some(direction), None))
        }
        Kind::Bool => Switch::new(first, area, palette, current.as_bool().unwrap_or(false), move |_| set(None, None)).disabled(!enabled).into_element(),
        Kind::Enum(options) => {
            let chosen = current.as_str().and_then(|current| options.iter().position(|option| option == current));
            Row::with_children(
                options
                    .iter()
                    .take(CHOICES)
                    .enumerate()
                    .map(|(position, option)| {
                        let set = set.clone();
                        Chip::new(id(Panel::Parameters, control(index, position)), area, palette, option.clone(), set(None, Some(position))).on(chosen == Some(position)).disabled(!enabled).into_element()
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
