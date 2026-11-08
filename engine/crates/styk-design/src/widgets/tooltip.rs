//! Tooltip (`tooltip.css`): the one ink pill with a name and, after a middle dot, the shortcut as plain text ("Undo · Ctrl+Z").
//!
//! Never interactive and never over its invoker. The core's `Tooltip` decides when it shows (a 500 ms delay, an immediate
//! switch within 300 ms of hiding, keyboard focus, no hover on touch); this draws the content it holds and places it with
//! `Tooltip::place`. Nothing here keeps a timer.

use iced::Widget as _;
use super::card::Card;
use super::control::words;
use super::layer::{Placed, Position};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::Palette;
use iced::widget::{Row, container};
use iced::{Alignment, Element, Length, Padding, Rectangle, Size};
use styk_core::overlay::placement::{Rect, Size as PlaceSize};
pub use styk_core::overlay::tooltip::Content;
use styk_core::overlay::tooltip::Tooltip;

/// What a target with a tooltip reports: the pointer or keyboard focus reached it (it shows after the core's delay), or the
/// pointer left, focus left, or a press, scroll or Escape ended it.
#[derive(Clone, Debug, PartialEq)]
pub enum TipEvent {
    Show { target: styk_core::focus::FocusId, content: Content, touch: bool, keyboard: bool },
    Hide,
}

/// The tooltip pill for `content`.
pub fn tooltip<'a, Message: 'a>(palette: &'static Palette, content: &Content) -> Element<'a, Message> {
    let style = TextStyle::from_role(&scale::TYPE_SMALL);
    let mut parts: Vec<Element<'a, Message>> = vec![words(content.label.clone(), style, palette.text_inverse)];
    if !content.shortcut.is_empty() {
        if !content.label.is_empty() {
            parts.push(words("\u{b7}", style, palette.text_inverse_2));
        }
        parts.push(words(content.shortcut.clone(), style, palette.text_inverse_2));
    }
    let line = Row::with_children(parts).spacing(scale::SPACE_1_5).align_y(Alignment::Center);
    // `max-inline-size: 280px`; the pill is its words and 10 px either side.
    let pill = container(line);
    Card::new(pill).fill(palette.surface_inverse).radius(scale::RADIUS_MD).padding(Padding { top: scale::SPACE_1, right: scale::SPACE_2_5, bottom: scale::SPACE_1, left: scale::SPACE_2_5 }).width(Length::Shrink).boxed()
}

/// The tooltip as a child of the overlay layer, placed by the core against `anchor` (the invoker's rectangle).
pub fn placed<'a, Message: 'a>(palette: &'static Palette, content: &Content, anchor: Rectangle, vertical_rail: bool, top_inset: f32) -> Placed<'a, Message> {
    let anchor = Rect { x: f64::from(anchor.x), y: f64::from(anchor.y), width: f64::from(anchor.width), height: f64::from(anchor.height) };
    Placed::new(tooltip(palette, content), move |natural: Size, viewport: Size| {
        let at = Tooltip::place(anchor, PlaceSize { width: f64::from(natural.width), height: f64::from(natural.height) }, PlaceSize { width: f64::from(viewport.width), height: f64::from(viewport.height) }, vertical_rail, f64::from(top_inset));
        Position::at(at.rect.x as f32, at.rect.y as f32)
    })
    .passive()
}
