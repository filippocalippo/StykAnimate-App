//! A bounded scroll viewport (`.ui-menu { max-block-size; overflow-y: auto }`): a column taller than the room it is given
//! scrolls by the wheel, shows a 6 px thumb in the padding beside it and fades its last 12 px while more is below
//! (`[data-more-below]`), and brings the row the keyboard moved to into view (`scrollIntoView({block: 'nearest'})`).
//!
//! The scroll offset is widget state (what the toolkit scrolled, never the core's). Which row to reveal is the core's: the
//! caller names the focus target of the row the keyboard holds, and the viewport moves only when that changes, so a wheel
//! scroll is not undone by the next redraw.

use super::control::paint_fill;
use super::focus::Meta;
use crate::Rgba;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Renderer as _, Shell, Widget, overlay, renderer};
use iced::{Background, Color, Element, Event, Length, Radians, Rectangle, Renderer, Size, Theme, Vector, mouse};
use std::any::Any;
use styk_core::focus::FocusId;

/// One wheel line, in logical pixels.
const LINE: f32 = 48.0;
/// The thumb's width, and the fade's height.
const THUMB: f32 = 6.0;
const FADE: f32 = 12.0;

#[derive(Default)]
struct State {
    offset: f32,
    revealed: Option<FocusId>,
}

/// The viewport.
pub struct Viewport<'a, Message> {
    content: Element<'a, Message>,
    reveal: Option<FocusId>,
    thumb: Rgba,
    fade: Rgba,
}

impl<'a, Message: 'a> Viewport<'a, Message> {
    /// `thumb` is `--scrollbar-thumb-hover`; `fade` the box's fill, which the last 12 px fade into.
    pub fn new(content: Element<'a, Message>, thumb: Rgba, fade: Rgba) -> Self {
        Viewport { content, reveal: None, thumb, fade }
    }

    /// The row the keyboard holds: it is brought into view when it changes.
    pub fn reveal(mut self, target: Option<FocusId>) -> Self {
        self.reveal = target;
        self
    }
}

/// Finds where one focus target is.
struct Find {
    target: FocusId,
    found: Option<Rectangle>,
}

impl Operation for Find {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<()>)) {
        operate(self);
    }

    fn custom(&mut self, _id: Option<&widget::Id>, bounds: Rectangle, state: &mut dyn Any) {
        if let Some(meta) = state.downcast_ref::<Meta>()
            && meta.id == self.target
        {
            self.found = Some(bounds);
        }
    }
}

/// The pointer as the rows see it: only inside the visible bounds. A row scrolled out of view is drawn clipped, so it must
/// not be hovered, pressed or given an interaction either.
fn within(cursor: mouse::Cursor, view: Rectangle) -> mouse::Cursor {
    match cursor.position_over(view) {
        Some(at) => mouse::Cursor::Available(at),
        None => mouse::Cursor::Unavailable,
    }
}

fn max_offset(content: f32, view: f32) -> f32 {
    (content - view).max(0.0)
}

impl<Message> widget::Meta for Viewport<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Viewport<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Shrink, Length::Shrink)
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(&mut tree.children[0], renderer, &layout::Limits::new(Size::ZERO, Size::new(limits.max.width, f32::INFINITY)));
        let content = tree.children[0].size;
        let view = Size::new(content.width, content.height.min(limits.max.height));
        // The layer lays a box out once at its natural size to place it, then again in the room it was given: only the
        // offset this pass uses is clamped, never the one kept, or the first pass would cut it short.
        let offset = tree.state.downcast_ref::<State>().offset.min(max_offset(content.height, view.height));
        tree.children[0].translation = Vector::new(0.0, -offset);
        tree.size = view;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        if let Some((layout, state)) = layout.iter_mut(&mut tree.children).next() {
            self.content.operate(state, layout, viewport, renderer, operation);
        }
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let view = layout.bounds();
        let content_height = tree.children[0].size.height;
        let room = max_offset(content_height, view.height);
        let mut offset = tree.state.downcast_ref::<State>().offset;
        // The keyboard moved to another row: bring it into view, as `scrollIntoView({block: 'nearest'})` does.
        if tree.state.downcast_ref::<State>().revealed != self.reveal {
            tree.state.downcast_mut::<State>().revealed = self.reveal;
            if let Some(target) = self.reveal
                && room > 0.0
            {
                let mut find = Find { target, found: None };
                if let Some((child, state)) = layout.iter_mut(&mut tree.children).next() {
                    self.content.operate(state, child, viewport, renderer, &mut find);
                }
                if let Some(row) = find.found {
                    if row.y < view.y {
                        offset -= view.y - row.y;
                    } else if row.y + row.height > view.y + view.height {
                        offset += row.y + row.height - (view.y + view.height);
                    }
                }
            }
        }
        if let Event::Mouse(mouse::Event::WheelScrolled { delta }) = event
            && room > 0.0
            && cursor.is_over(view)
        {
            let lines = match delta {
                mouse::ScrollDelta::Lines { y, .. } => y * LINE,
                mouse::ScrollDelta::Pixels { y, .. } => *y,
            };
            offset -= lines;
            shell.capture_event();
        }
        let offset = offset.clamp(0.0, room);
        if (offset - tree.state.downcast_ref::<State>().offset).abs() > f32::EPSILON {
            tree.state.downcast_mut::<State>().offset = offset;
            tree.children[0].translation = Vector::new(0.0, -offset);
            shell.invalidate_layout();
            shell.request_redraw();
        }
        if let Some((child, state)) = layout.iter_mut(&mut tree.children).next() {
            self.content.update(state, event, child, within(cursor, view), renderer, shell, viewport);
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        layout.iter(&tree.children).next().map_or(mouse::Interaction::None, |(child, state)| self.content.mouse_interaction(state, child, within(cursor, layout.bounds()), viewport, renderer))
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let view = layout.bounds();
        let content_height = tree.children[0].size.height;
        let room = max_offset(content_height, view.height);
        let offset = tree.state.downcast_ref::<State>().offset;
        if let Some((child, state)) = layout.iter(&tree.children).next() {
            let clip = view.intersection(viewport).unwrap_or(view);
            renderer.with_layer(clip, |renderer| {
                self.content.draw(state, renderer, theme, style, child, within(cursor, view), &clip);
                // `mask-image: linear-gradient(to bottom, black calc(100% - 12px), transparent)`: the last 12 px fade into the box.
                if room > 0.0 && offset < room - 1.0 {
                    let at = Rectangle { y: view.y + view.height - FADE, height: FADE, ..view };
                    let clear = Color { a: 0.0, ..Color::from(self.fade) };
                    let gradient = iced::gradient::Linear::new(Radians(std::f32::consts::FRAC_PI_2)).add_stop(0.0, clear).add_stop(1.0, Color::from(self.fade));
                    renderer.fill_quad(renderer::Quad { bounds: at, ..renderer::Quad::default() }, Background::Gradient(iced::Gradient::Linear(gradient)));
                }
            });
        }
        if room > 0.0 {
            let height = (view.height * view.height / content_height).max(THUMB * 2.0);
            let top = view.y + (view.height - height) * (offset / room);
            paint_fill(renderer, Rectangle { x: view.x + view.width, y: top, width: THUMB, height }, THUMB / 2.0, self.thumb);
        }
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        match layout.iter_mut(&mut tree.children).next() {
            Some((child, state)) => self.content.overlay(state, child, renderer, viewport, translation, window),
            None => Vec::new(),
        }
    }
}
