//! The performance overlay (design 3.5.2): a non-interactive card over the stage with the frame-time sparkline, the
//! timings of the interface, the frame builder and the painter, and the memory figures. It is drawn at the rectangle
//! and visibility the host supplies, takes no pointer, and decides nothing about when its figures are sampled.

use super::chrome::quiet;
use super::{Context, Message, origin};
use crate::sampling::{Sample, Timing};
use iced::widget::{Column, Row, Space, container};
use iced::{Widget as _, Alignment, Background, Element, Length, Padding};
use styk_core::i18n::Msg;
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::widgets::card::Card;
use styk_design::widgets::control::words;
use styk_design::widgets::layer::{Layer, Placed, Position};

/// The overlay's width.
pub const WIDTH: f32 = 272.0;
/// How far it sits from the stage's top left corner.
const INSET: f32 = 12.0;
/// The sparkline's height, the width of one frame's bar and the gap between bars.
const SPARK_HEIGHT: f32 = 36.0;
const BAR: f32 = 2.0;
const GAP: f32 = 1.0;
/// The frame budget the sparkline draws a line at: 60 frames a second (design 3.5.1).
const BUDGET_MS: f64 = 1000.0 / 60.0;
/// A frame this many budgets long is late (design 3.5.1: more than 1.5 intervals).
const LATE: f64 = 1.5;

pub fn view<'a>(context: &Context<'_>) -> Element<'a, Message> {
    let model = context.overlay;
    let Some(bounds) = model.bounds.filter(|_| model.visible) else {
        return Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(0.0)).boxed();
    };
    let (x, y) = origin(bounds);
    let card = card(context);
    Layer::new(vec![Placed::new(card, move |_, _| Position::at(x + INSET, y + INSET)).passive()]).boxed()
}

fn card<'a>(context: &Context<'_>) -> Card<'a, Message> {
    let palette = context.palette();
    let sample = &context.overlay.sample;
    let mut rows: Vec<Element<'a, Message>> = vec![label(context, "dev.overlay.frame"), sparkline(context, sample), timing(context, sample.frame.as_ref())];
    rows.push(label(context, "dev.overlay.interface"));
    rows.push(timing(context, sample.interface.as_ref()));
    rows.push(label(context, "dev.overlay.builder"));
    rows.push(timing(context, sample.builder.as_ref()));
    rows.push(label(context, "dev.overlay.painter"));
    rows.push(timing(context, sample.painter.as_ref()));
    if sample.interface_stalls > 0 {
        rows.push(quiet(palette, context.say(Msg::new("dev.overlay.stalls").with("count", sample.interface_stalls as f64))));
    }
    if sample.dropped > 0 {
        rows.push(quiet(palette, context.say(Msg::new("dev.overlay.dropped").with("count", sample.dropped as f64))));
    }
    if sample.truncated {
        rows.push(quiet(palette, context.word("dev.overlay.truncated")));
    }
    if let Some(memory) = &context.overlay.memory {
        rows.push(label(context, "dev.overlay.private"));
        rows.push(value(context, megabytes(context, memory.private_after)));
        for (adapter, segment, usage, _budget) in memory.video.iter().take(4) {
            rows.push(quiet(palette, context.say(Msg::new("dev.overlay.video").with("adapter", adapter.as_str()).with("segment", segment.as_str()))));
            rows.push(value(context, megabytes(context, *usage)));
        }
    }
    Card::new(container(Column::with_children(rows).spacing(scale::SPACE_0_5)).padding(Padding { top: scale::SPACE_2, right: scale::SPACE_3, bottom: scale::SPACE_2, left: scale::SPACE_3 }))
        .fill(palette.surface_raised)
        .ring(1.0, palette.line_1)
        .radius(scale::RADIUS_MD)
        .shadows(palette.elevation_2)
        .width(Length::Fixed(WIDTH))
}

fn label<'a>(context: &Context<'_>, key: &'static str) -> Element<'a, Message> {
    words(context.word(key), TextStyle::from_role(&scale::TYPE_MICRO), context.palette().text_3)
}

fn value<'a>(context: &Context<'_>, text: String) -> Element<'a, Message> {
    words(text, TextStyle::from_role(&scale::TYPE_SMALL), context.palette().text_1)
}

fn megabytes(context: &Context<'_>, bytes: u64) -> String {
    context.say(Msg::new("dev.overlay.megabytes").with("value", (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0))
}

/// A timing's quantiles; a producer with no records shows as unavailable, never as zero.
fn timing<'a>(context: &Context<'_>, timing: Option<&Timing>) -> Element<'a, Message> {
    let tenth = |ms: f64| (ms * 10.0).round() / 10.0;
    match timing {
        Some(t) => value(context, context.say(Msg::new("dev.overlay.timing").with("p50", tenth(t.p50_ms)).with("p95", tenth(t.p95_ms)).with("max", tenth(t.maximum_ms)))),
        None => quiet(context.palette(), context.word("dev.unavailable")),
    }
}

/// The frame intervals as bars, the newest at the right, with the budget as a line. A late frame reads in the
/// danger colour.
fn sparkline<'a>(context: &Context<'_>, sample: &Sample) -> Element<'a, Message> {
    let palette = context.palette();
    if sample.frames_ms.is_empty() {
        return quiet(palette, context.word("dev.overlay.waiting"));
    }
    let fits = ((WIDTH - 2.0 * scale::SPACE_3 + GAP) / (BAR + GAP)) as usize;
    let frames = &sample.frames_ms[sample.frames_ms.len().saturating_sub(fits)..];
    let top = frames.iter().copied().fold(2.0 * BUDGET_MS, f64::max);
    let height = |ms: f64| ((ms / top) as f32 * SPARK_HEIGHT).clamp(1.0, SPARK_HEIGHT);
    let bars: Vec<Element<'a, Message>> = frames
        .iter()
        .map(|&ms| {
            let ink = if ms > BUDGET_MS * LATE { palette.danger_dot } else { palette.accent };
            container(Space::new()).width(Length::Fixed(BAR)).height(Length::Fixed(height(ms))).style(move |_| container::Style { background: Some(Background::Color(ink.into())), ..container::Style::default() }).boxed()
        })
        .collect();
    let row = Row::with_children(bars).spacing(GAP).align_y(Alignment::End).width(Length::Fill).height(Length::Fixed(SPARK_HEIGHT));
    let line_at = height(BUDGET_MS);
    let slate = palette.text_3;
    let rule = Column::with_children(vec![
        Space::new().width(Length::Fill).height(Length::Fixed(SPARK_HEIGHT - line_at)).boxed(),
        container(Space::new().width(Length::Fill).height(Length::Fixed(1.0))).style(move |_| container::Style { background: Some(Background::Color(slate.into())), ..container::Style::default() }).boxed(),
    ]);
    iced::widget::stack![row, rule].height(Length::Fixed(SPARK_HEIGHT)).boxed()
}
