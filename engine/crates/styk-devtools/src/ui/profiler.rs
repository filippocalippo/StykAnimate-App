//! The profiler panel: start and stop a capture, its summary, and saving it as a Perfetto file.

use super::chrome::{frame, padded, quiet};
use super::{Context, Message, button, id, run, send};
use iced::widget::{Column, Row, Space, container};
use iced::{Widget as _, Alignment, Element, Length, Padding};
use styk_core::dev_extension::{CommandId, Event, Panel};
use styk_core::field::Role;
use styk_core::focus::FocusArea;
use styk_core::i18n::Msg;
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::widgets::button::Variant;
use styk_design::widgets::control::words;
use styk_design::widgets::field::EditField;
use styk_design::widgets::parts::scroll;

pub const START: u64 = 1;
pub const STOP: u64 = 2;
pub const EXPORT: u64 = 3;
pub const PATH: u64 = 4;
pub const CONFIRM: u64 = 5;
pub const CANCEL: u64 = 6;

pub fn view<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let model = context.profiler;
    let available = context.availability;
    let actions = Row::with_children(vec![
        button(context, START, Panel::Profiler, context.word("dev.start"), "play", available.start, run(CommandId::DevCaptureStart)).variant(Variant::Primary).into_element(),
        button(context, STOP, Panel::Profiler, context.word("dev.stop"), "stop", available.stop, run(CommandId::DevCaptureStop)).into_element(),
        button(context, EXPORT, Panel::Profiler, context.word("dev.export"), "export", available.export, run(CommandId::DevCaptureExport)).into_element(),
    ])
    .spacing(scale::SPACE_2)
    .align_y(Alignment::Center);
    let status = if model.recording && model.stopping {
        "dev.profiler.stopping"
    } else if model.recording {
        "dev.profiler.recording"
    } else if model.can_export {
        "dev.profiler.stopped"
    } else {
        "dev.profiler.idle"
    };
    let mut body: Vec<Element<'a, Message>> = vec![
        padded(actions.boxed()),
        padded(words(context.word(status), TextStyle::from_role(&scale::TYPE_UI_STRONG), palette.text_1)),
    ];
    if model.can_export {
        let size = context.say(Msg::new("dev.profiler.size").with("bytes", model.bytes as f64));
        let dropped = context.say(Msg::new("dev.profiler.dropped").with("count", model.dropped as f64));
        body.push(padded(quiet(palette, format!("{size}  {dropped}"))));
    }
    if context.input == Some(CommandId::DevCaptureExport) {
        body.push(padded(export_row(context)));
    }
    body.push(padded(summary(context)));
    frame(context, Panel::Profiler, Vec::new(), scroll(palette, Column::with_children(body).spacing(scale::SPACE_1_5).width(Length::Fill).boxed()))
}

/// The argument of the export: the file the capture is written to, and its confirmation.
fn export_row<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let field = EditField::new(id(Panel::Profiler, PATH), FocusArea::Panels, Role::SingleLine, context.draft.to_string(), palette)
        .placeholder(context.word("dev.export.path"))
        .composing(context.composing)
        .on_input(|text| send(Event::Draft(text)))
        .on_enter(send(Event::Export(styk_core::services::files::FileTarget::new(context.draft))))
        .on_escape(send(Event::Input(None)))
        .on_compose(Message::Compose);
    let confirm = button(context, CONFIRM, Panel::Profiler, context.word("dev.export.confirm"), "export", context.availability.export, send(Event::Export(styk_core::services::files::FileTarget::new(context.draft)))).variant(Variant::Primary).into_element();
    let cancel = button(context, CANCEL, Panel::Profiler, context.word("dev.cancel"), "close", true, send(Event::Input(None))).into_element();
    Row::with_children(vec![container(field.into_element()).width(Length::Fill).boxed(), confirm, cancel]).spacing(scale::SPACE_2).align_y(Alignment::Center).boxed()
}

/// The capture's statistics over every captured duration span.
fn summary<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let palette = context.palette();
    let Some(summary) = context.profiler.summary.as_ref() else {
        return quiet(palette, context.word("dev.profiler.noSummary"));
    };
    let figure = |key: &str| summary.get(key).and_then(|v| v.as_f64());
    let rows: [(&'static str, Option<f64>, bool); 6] = [
        ("dev.stat.n", figure("n"), false),
        ("dev.stat.mean", figure("mean"), true),
        ("dev.stat.p50", figure("p50"), true),
        ("dev.stat.p95", figure("p95"), true),
        ("dev.stat.p99", figure("p99"), true),
        ("dev.stat.max", figure("max"), true),
    ];
    let mut column: Vec<Element<'a, Message>> = vec![words(context.word("dev.profiler.summary"), TextStyle::from_role(&scale::TYPE_SMALL_STRONG), palette.text_3)];
    for (key, value, milliseconds) in rows {
        let Some(value) = value else { continue };
        // A duration is shown to the nearest microsecond: the capture's own resolution.
        let shown = if milliseconds { (value * 1000.0).round() / 1000.0 } else { value };
        let line = Row::with_children(vec![
            container(words(context.word(key), TextStyle::from_role(&scale::TYPE_SMALL), palette.text_2)).width(Length::Fixed(64.0)).boxed(),
            words(context.presentation.number(shown), TextStyle::from_role(&scale::TYPE_VALUE), palette.text_1),
        ])
        .spacing(scale::SPACE_2);
        column.push(line.boxed());
    }
    if summary.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false) {
        column.push(quiet(palette, context.word("dev.profiler.truncated")));
    }
    column.push(Space::new().height(Length::Fixed(scale::SPACE_2)).boxed());
    container(Column::with_children(column).spacing(scale::SPACE_0_5)).padding(Padding::ZERO).boxed()
}
