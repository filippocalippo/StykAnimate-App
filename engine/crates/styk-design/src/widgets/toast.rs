//! Messages (`toast.css`): the stage's one message slot, drawn from the core's `Messages`.
//!
//! The core holds one visible message, the waiting ones, the priority order and every timeout (`Messages::deadline`,
//! hover and focus pausing); this draws the visible one as the white pill and reports a click on an action or on the close
//! button. Hover and focus are reported through [`Event::Interaction`] so the core can pause and resume the timeout.

use iced::Widget as _;
use super::card::Card;
use super::control::{Interaction, pill, words};
use super::enter::Enter;
use super::focus::{Focusable, Ring};
use super::layer::{Placed, Position};
use super::progress::Bar;
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::advanced::layout::{Layout, Limits};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget, overlay, renderer};
use iced::widget::{Row, container};
use std::rc::Rc;
use iced::{Alignment, Element, Event as IcedEvent, Length, Padding, Rectangle, Renderer, Size, Theme, Vector, mouse};
use styk_core::focus::{FocusArea, FocusId};
use styk_core::overlay::messages::{self, Message as Toast, Priority, Tone};
use styk_core::overlay::placement::{Rect, Size as PlaceSize};

/// What a message reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// The `index`th action of message `id` was pressed (the owner runs its command, then dismisses it if the action does).
    Action { id: u64, index: usize },
    /// The close button of message `id`.
    Dismiss(u64),
    /// The pointer entered (`true`) or left the visible message: its timeout pauses and resumes (`Messages::interaction`).
    Hover(bool),
}

/// The focus target of a message's `slot`th button (its actions, then its close button): a message's buttons are reachable by
/// Tab, as today's are. The core derives "focus is on the message" from the focus walk with the same IDs, so a button
/// reports nothing about its own focus.
pub fn button_id(message: u64, slot: usize) -> FocusId {
    styk_core::overlay::host::message_button_id(message, slot)
}

/// Reports the pointer entering and leaving what it wraps.
struct Watch<'a, Message> {
    content: Element<'a, Message>,
    on_change: Box<dyn Fn(bool) -> Message + 'a>,
}

impl<Message> widget::Meta for Watch<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Watch<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<bool>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(false)
    }

    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &Limits) {
        self.content.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &IcedEvent, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
        let over = cursor.is_over(layout.bounds());
        let was = tree.state.downcast_mut::<bool>();
        if *was != over {
            *was = over;
            shell.publish((self.on_change)(over));
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}

/// How the message is dressed (`data-variant`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Variant {
    Pill,
    Task,
    /// A pick mode's instruction: tinted, no lift.
    Mode,
    /// The quiet readout: words on the header, no pill.
    Quiet,
}

fn variant(toast: &Toast) -> Variant {
    if toast.task {
        Variant::Task
    } else {
        match toast.priority {
            Priority::Mode => Variant::Mode,
            Priority::Hint => Variant::Quiet,
            _ => Variant::Pill,
        }
    }
}

fn tone_icon(tone: Tone) -> Option<&'static str> {
    match tone {
        Tone::Info => None,
        Tone::Success => Some("check"),
        Tone::Warning => Some("warning"),
        Tone::Error => Some("alert"),
    }
}

fn tone_ink(palette: &Palette, tone: Tone) -> Rgba {
    match tone {
        Tone::Info => palette.accent_text,
        Tone::Success => palette.success_text,
        Tone::Warning => palette.warning_text,
        Tone::Error => palette.danger_text,
    }
}

/// A pill-shaped press target with a hover fill and a focus ring: a toast's action and close button.
fn target<'a, Message: Clone + 'a>(palette: &'static Palette, id: FocusId, face: Element<'a, Message>, message: Message, width: Length, height: f32, outline: bool) -> Element<'a, Message> {
    let hover = palette.surface_hover;
    let line = palette.line_2;
    let look = move |interaction: Interaction| Look { fill: (interaction != Interaction::Rest).then_some(hover), border: 0.0, ring: outline.then_some((1.0, line)), shadows: &[], radius: pill(height), opacity: 1.0, scale: 1.0 };
    let surface = Surface::new(face, look).on_press_maybe(Some(message.clone())).width(width).height(Length::Fixed(height));
    Focusable::new(id, FocusArea::Stage, surface.boxed(), Ring::of(palette, pill(height))).on_activate(message).boxed()
}

/// `flex-wrap: wrap` with the text at `flex: 1 1 160px`, as a message with actions is laid out: the box is as wide as its items
/// side by side; the text's 160 px base size does not leave room for the actions on its line, so they wrap onto a line below
/// it, and the text grows to fill the first line.
struct Wrap<'a, Message> {
    children: Vec<Element<'a, Message>>,
    /// The item that grows (the text) and its base size.
    grow: (usize, f32),
    gap: f32,
}

impl<Message> widget::Meta for Wrap<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Wrap<'a, Message> {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Shrink, Length::Shrink)
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(&mut self.children);
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &Limits) {
        let unbounded = Limits::new(Size::ZERO, Size::new(f32::INFINITY, f32::INFINITY));
        for (child, state) in self.children.iter_mut().zip(&mut tree.children) {
            child.layout(state, renderer, &unbounded);
        }
        let natural: Vec<Size> = tree.children.iter().map(|state| state.size).collect();
        let width = (natural.iter().map(|size| size.width).sum::<f32>() + self.gap * natural.len().saturating_sub(1) as f32).min(limits.max.width);
        // Break lines on base sizes: the text counts as 160 px whatever its words need.
        let mut lines: Vec<Vec<usize>> = vec![Vec::new()];
        let mut used = 0.0;
        for (index, size) in natural.iter().enumerate() {
            let base = if index == self.grow.0 { self.grow.1 } else { size.width };
            let current = lines.last_mut().map(|line| line.len()).unwrap_or(0);
            if current > 0 && used + self.gap + base > width {
                lines.push(Vec::new());
                used = 0.0;
            }
            used += if lines.last().is_some_and(|line| !line.is_empty()) { self.gap } else { 0.0 } + base;
            if let Some(line) = lines.last_mut() {
                line.push(index);
            }
        }
        let mut y = 0.0;
        for (at, line) in lines.iter().enumerate() {
            let others: f32 = line.iter().filter(|index| **index != self.grow.0).map(|index| natural[*index].width).sum::<f32>() + self.gap * line.len().saturating_sub(1) as f32;
            if line.contains(&self.grow.0) {
                let room = (width - others).max(0.0);
                self.children[self.grow.0].layout(&mut tree.children[self.grow.0], renderer, &Limits::new(Size::new(room, 0.0), Size::new(room, f32::INFINITY)));
            }
            let height = line.iter().map(|index| tree.children[*index].size.height).fold(0.0, f32::max);
            let mut x = 0.0;
            for index in line {
                let state = &mut tree.children[*index];
                state.translation = Vector::new(x, y + (height - state.size.height) / 2.0);
                x += state.size.width + self.gap;
            }
            y += height + if at + 1 < lines.len() { self.gap } else { 0.0 };
        }
        tree.size = Size::new(width, y);
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        operation.container(None, layout.bounds(), viewport);
        operation.traverse(&mut |operation| {
            for (child, (layout, state)) in self.children.iter_mut().zip(layout.iter_mut(&mut tree.children)) {
                child.operate(state, layout, viewport, renderer, operation);
            }
        });
    }

    fn update(&mut self, tree: &mut Tree, event: &IcedEvent, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        for (child, (layout, state)) in self.children.iter_mut().zip(layout.iter_mut(&mut tree.children)) {
            child.update(state, event, layout, cursor, renderer, shell, viewport);
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.children
            .iter()
            .zip(layout.iter(&tree.children))
            .map(|(child, (layout, state))| child.mouse_interaction(state, layout, cursor, viewport, renderer))
            .find(|interaction| *interaction != mouse::Interaction::None)
            .unwrap_or_default()
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        for (child, (layout, state)) in self.children.iter().zip(layout.iter(&tree.children)) {
            child.draw(state, renderer, theme, style, layout, cursor, viewport);
        }
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        overlay::from_children(&mut self.children, tree, layout, renderer, viewport, translation, window)
    }
}

/// The visible message as a pill. `send` turns what the person pressed into the owner's message.
/// `enter` is the message's entry phase and `progress` its task bar's loop phase, both the core's (`Host::phase`).
pub fn toast<'a, Message: Clone + 'a>(palette: &'static Palette, message: &Toast, enter: f32, progress: f32, send: impl Fn(Event) -> Message + 'a) -> Element<'a, Message> {
    let send: Rc<dyn Fn(Event) -> Message + 'a> = Rc::new(send);
    let kind = variant(message);
    let ink = TextStyle::from_role(&scale::TYPE_UI);
    let mut parts: Vec<Element<'a, Message>> = Vec::new();
    if let Some(icon) = message.icon.as_deref().or(tone_icon(message.tone)) {
        parts.push(super::icon(icon, scale::ICON_MD, tone_ink(palette, message.tone)).boxed());
    }
    // `<b>title</b> text`: the title in semibold ink, then the words, wrapping past the window.
    let mut text = Row::new().spacing(scale::SPACE_1);
    if !message.title.is_empty() {
        text = text.push(words(message.title.clone(), TextStyle::from_role(&scale::TYPE_UI_STRONG), palette.text_1));
    }
    if !message.text.is_empty() {
        text = text.push(words(message.text.clone(), ink, palette.text_2));
    }
    let text_at = parts.len();
    parts.push(container(text).padding(Padding { top: scale::SPACE_1, bottom: scale::SPACE_1, ..Padding::ZERO }).boxed());
    if message.task {
        parts.push(Bar::new(palette, None).phase(progress).width(Length::Fixed(96.0)).boxed());
    }
    for (index, action) in message.actions.iter().enumerate() {
        let label = container(words(action.label.clone(), TextStyle::from_role(&scale::TYPE_SMALL_STRONG), palette.accent_text)).padding(Padding { top: 0.0, right: scale::SPACE_2_5, bottom: 0.0, left: scale::SPACE_2_5 }).center_y(Length::Fixed(scale::CONTROL_MD));
        parts.push(target(palette, button_id(message.id, index), label.boxed(), send(Event::Action { id: message.id, index }), Length::Shrink, scale::CONTROL_MD, action.outline));
    }
    if message.dismissible {
        let glyph = container(super::icon("close", scale::ICON_SM, palette.text_3)).center_x(Length::Fixed(scale::CONTROL_SM)).center_y(Length::Fixed(scale::CONTROL_SM));
        parts.push(target(palette, button_id(message.id, 15), glyph.boxed(), send(Event::Dismiss(message.id)), Length::Fixed(scale::CONTROL_SM), scale::CONTROL_SM, false));
    }
    let buttons = message.actions.len() + usize::from(message.dismissible);
    let gap = if kind == Variant::Task { scale::SPACE_2_5 } else { scale::SPACE_2 };
    let line: Element<'a, Message> = if message.actions.is_empty() { Row::with_children(parts).spacing(gap).align_y(Alignment::Center).boxed() } else { Wrap { children: parts, grow: (text_at, 160.0), gap }.boxed() };
    let height = scale::CONTROL_LG;
    let right = if buttons == 0 { scale::SPACE_3 } else { scale::SPACE_1 };
    let radius = if message.actions.is_empty() { pill(height) } else { scale::RADIUS_XL };
    let padding = Padding { top: 1.0, right: right + 1.0, bottom: 1.0, left: scale::SPACE_3 + 1.0 };
    // One line is `min-block-size: 36px` with its words centred; wrapped lines take the room they need.
    let body = if message.actions.is_empty() { container(line).center_y(Length::Fixed(height)).padding(padding) } else { container(line).padding(padding) };
    let card = Card::new(body).radius(radius);
    let card = match kind {
        Variant::Pill | Variant::Task => card.fill(palette.surface_raised).shadows(palette.elevation_1),
        Variant::Mode => card.fill(palette.accent_soft),
        Variant::Quiet => card,
    };
    let hover = send.clone();
    let watched = Watch { content: card.boxed(), on_change: Box::new(move |hovered| hover(Event::Hover(hovered))) };
    // It enters over `--dur-slow`, rising 4 px as it fades in.
    Enter::new(watched.boxed(), enter, 4.0, palette.surface_stage, radius).boxed()
}

/// The visible message as a child of the overlay layer: centred on `x`, its top at `top` (from `messages::position`).
pub fn placed<'a, Message: Clone + 'a>(palette: &'static Palette, message: &Toast, enter: f32, progress: f32, stage: Option<Rectangle>, send: impl Fn(Event) -> Message + 'a) -> Placed<'a, Message> {
    let stage = stage.map(|stage| Rect { x: f64::from(stage.x), y: f64::from(stage.y), width: f64::from(stage.width), height: f64::from(stage.height) });
    Placed::new(toast(palette, message, enter, progress, send), move |natural: Size, viewport: Size| {
        let at = messages::position(PlaceSize { width: f64::from(natural.width), height: f64::from(natural.height) }, f64::from(viewport.height), stage, None, None, &[], 0.0);
        match at {
            Some(at) => Position::at(at.x as f32 - natural.width / 2.0, at.top as f32),
            None => Position::at((viewport.width - natural.width) / 2.0, viewport.height - natural.height - scale::SPACE_6),
        }
    })
}
