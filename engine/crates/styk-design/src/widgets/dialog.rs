//! Dialogs, popovers and sheets (`dialog.css`, `popover.css`, `sheet.css`): the raised boxes that hold a task.
//!
//! The core's overlay stack owns their lifetimes (the modal stack, the close guard as an effect, Escape, outside presses,
//! focus restoration); these draw the box and its parts and report the close button. A dialog's content is the owner's:
//! it passes the body and the foot's buttons, built from the design system's controls.

use iced::Widget as _;
use super::button::{IconButton, IconSize};
use super::card::Card;
use super::control::words;
use super::enter::{Enter, blend};
use super::focus::Scope;
use super::layer::{Placed, Position};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::Palette;
use iced::widget::{Column, Row, Space, container};
use iced::{Alignment, Background, Element, Length, Padding, Size};
use styk_core::focus::{FocusArea, FocusId, ScopeId};

/// A dialog's width (`data-size`): 420, 640 or 880 px (the largest is also 540 px high at most).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DialogSize {
    Sm,
    #[default]
    Md,
    Lg,
}

impl DialogSize {
    pub fn width(self) -> f32 {
        match self {
            DialogSize::Sm => 420.0,
            DialogSize::Md => 640.0,
            DialogSize::Lg => 880.0,
        }
    }
}

/// What a dialog shows.
pub struct Dialog<'a, Message> {
    pub size: DialogSize,
    pub title: String,
    pub description: Option<String>,
    pub body: Element<'a, Message>,
    /// The foot's buttons, right-aligned in order.
    pub actions: Vec<Element<'a, Message>>,
    /// Quiet text at the foot's start (`.ui-dialog-meta`).
    pub meta: Option<String>,
    /// An error under the body (`.ui-dialog-error`).
    pub error: Option<String>,
    /// The close button's message, and its focus ID.
    pub close: Option<(FocusId, Message)>,
}

/// The dialog box (without its backdrop or position) for a window of `window` size.
pub fn dialog<'a, Message: Clone + 'a>(palette: &'static Palette, spec: Dialog<'a, Message>, window: Size) -> Element<'a, Message> {
    let Dialog { size, title, description, body, actions, meta, error, close } = spec;
    let width = size.width().min(window.width - 32.0).max(0.0);
    let mut heading: Vec<Element<'a, Message>> = vec![words(title, TextStyle::from_role(&scale::TYPE_TITLE).tracking_em(scale::TRACKING_TITLE_EM), palette.text_1)];
    if let Some(description) = description {
        heading.push(words(description, TextStyle::from_role(&scale::TYPE_BODY), palette.text_2));
    }
    let mut head: Vec<Element<'a, Message>> = vec![container(Column::with_children(heading).spacing(scale::SPACE_1)).width(Length::Fill).boxed()];
    if let Some((id, message)) = close {
        head.push(container(IconButton::new(id, FocusArea::Panels, palette, "close", message).into_element()).align_y(Alignment::Start).boxed());
    }
    let head = container(Row::with_children(head).spacing(scale::SPACE_3)).padding(Padding { top: scale::SPACE_5, right: scale::SPACE_4, bottom: scale::SPACE_2, left: scale::SPACE_6 });
    let mut inner: Vec<Element<'a, Message>> = vec![body];
    if let Some(error) = error {
        let soft = palette.danger_soft;
        inner.push(
            container(words(error, TextStyle::from_role(&scale::TYPE_SMALL), palette.danger_text))
                .padding(Padding { top: scale::SPACE_2, right: scale::SPACE_3, bottom: scale::SPACE_2, left: scale::SPACE_3 })
                .width(Length::Fill)
                .style(move |_| container::Style { background: Some(Background::Color(soft.into())), border: iced::Border { radius: scale::RADIUS_MD.into(), ..iced::Border::default() }, ..container::Style::default() })
                .boxed(),
        );
    }
    let body = container(Column::with_children(inner).spacing(scale::SPACE_3)).padding(Padding { top: scale::SPACE_2, right: scale::SPACE_6, bottom: scale::SPACE_5, left: scale::SPACE_6 }).width(Length::Fill);
    let mut foot: Vec<Element<'a, Message>> = vec![match meta {
        Some(meta) => words(meta, TextStyle::from_role(&scale::TYPE_SMALL), palette.text_3),
        None => Space::new().boxed(),
    }];
    foot.push(Space::new().width(Length::Fill).boxed());
    foot.extend(actions);
    let foot = container(Row::with_children(foot).spacing(scale::SPACE_2).align_y(Alignment::Center)).padding(Padding { top: scale::SPACE_3, right: scale::SPACE_5, bottom: scale::SPACE_5, left: scale::SPACE_6 }).width(Length::Fill);
    let content = Column::with_children(vec![head.boxed(), body.boxed(), foot.boxed()]).width(Length::Fill);
    // `border: 1px solid transparent` around the box: the content is 2 px narrower.
    Card::new(container(content).width(Length::Fixed(width - 2.0)))
        .fill(palette.surface_raised)
        .radius(scale::RADIUS_2XL)
        .shadows(palette.elevation_4)
        .padding(1.0)
        .clip(true)
        .boxed()
}

/// The modal layer: the veil over the whole window of `window` size and the dialog centred on it, in the focus scope of
/// overlay `id`.
/// `phase` is the dialog's entry (`Host::phase`, 240 ms).
pub fn modal<'a, Message: Clone + 'a>(palette: &'static Palette, id: u64, spec: Dialog<'a, Message>, window: Size, phase: f32) -> Placed<'a, Message> {
    let veil = palette.surface_backdrop;
    let veiled = blend(palette.surface_backdrop, palette.surface);
    let entering = Enter::new(dialog(palette, spec, window), phase, scale::SPACE_2, veiled, scale::RADIUS_2XL);
    let centred = container(Scope::new(ScopeId(id), entering.boxed()))
        .center_x(Length::Fill)
        .center_y(Length::Fill)
        .style(move |_| container::Style { background: Some(Background::Color(veil.into())), ..container::Style::default() });
    Placed::new(centred, |_, _| Position::at(0.0, 0.0))
}

/// A popover: a non-modal panel anchored to its opener, with a title, a close button and a body.
/// `phase` is its entry (`Host::phase`, 160 ms).
pub fn popover<'a, Message: Clone + 'a>(palette: &'static Palette, title: String, body: Element<'a, Message>, foot: Option<Element<'a, Message>>, close: Option<(FocusId, Message)>, phase: f32) -> Element<'a, Message> {
    let mut head: Vec<Element<'a, Message>> = vec![container(words(title, TextStyle::from_role(&scale::TYPE_UI_STRONG), palette.text_1)).width(Length::Fill).boxed()];
    if let Some((id, message)) = close {
        head.push(IconButton::new(id, FocusArea::Panels, palette, "close", message).size(IconSize::Sm).into_element());
    }
    let head = container(Row::with_children(head).spacing(scale::SPACE_2).align_y(Alignment::Center)).height(Length::Fixed(scale::CONTROL_2XL)).center_y(Length::Fixed(scale::CONTROL_2XL)).padding(Padding { top: 0.0, right: scale::SPACE_1_5, bottom: 0.0, left: scale::SPACE_4 });
    let body = container(body).padding(Padding { top: scale::SPACE_0_5, right: scale::SPACE_4, bottom: scale::SPACE_4, left: scale::SPACE_4 });
    // `min-inline-size: 248px` and a 1 px transparent border.
    let mut column: Vec<Element<'a, Message>> = vec![Space::new().width(Length::Fixed(248.0 - 2.0)).height(Length::Fixed(0.0)).boxed(), head.boxed(), body.boxed()];
    if let Some(foot) = foot {
        let line = palette.line_1;
        column.push(container(Space::new()).width(Length::Fill).height(1.0).style(move |_| container::Style { background: Some(Background::Color(line.into())), ..container::Style::default() }).boxed());
        column.push(container(foot).padding(Padding { top: scale::SPACE_2_5, right: scale::SPACE_3, bottom: scale::SPACE_3, left: scale::SPACE_3 }).align_right(Length::Fill).boxed());
    }
    let card = Card::new(Column::with_children(column)).fill(palette.surface_raised).radius(scale::RADIUS_XL).shadows(palette.elevation_3).padding(1.0);
    Enter::new(card.boxed(), phase, scale::SPACE_1, palette.surface, scale::RADIUS_XL).boxed()
}

/// A sheet: a raised island over the stage, 320 px wide at most, anchored at the top right under the band.
/// `phase` is its entry (`Host::phase`, 240 ms).
pub fn sheet<'a, Message: Clone + 'a>(palette: &'static Palette, content: Element<'a, Message>, top: f32, phase: f32) -> Placed<'a, Message> {
    let card = Card::new(container(content).width(Length::Fixed(320.0 - 2.0))).fill(palette.surface_raised).radius(scale::RADIUS_XL).shadows(palette.elevation_3).padding(1.0);
    let card = Enter::new(card.boxed(), phase, scale::SPACE_1, palette.surface, scale::RADIUS_XL);
    Placed::new(card, move |natural: Size, viewport: Size| Position { x: viewport.width - 8.0 - natural.width, y: top, max_width: Some(viewport.width - 16.0), max_height: Some(viewport.height - top - 16.0) })
}
