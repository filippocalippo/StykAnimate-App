//! The entry of a box (`opacity` and `translate` over `--dur-base` for menus and popovers, `--dur-slow` for dialogs, toasts and
//! sheets): it fades in and rises from `rise` px below its place.
//!
//! The phase is the core's (`Host::phase`, 0 to 1 through the entry); this only draws it and keeps no clock. iced has no group
//! opacity, so the fade is the page's colour laid over the box at the remaining opacity: the box is drawn settled, over a
//! page that is one colour behind it, which is what every overlay here is over.

use super::control::{cubic_bezier, paint_fill};
use crate::tokens::scale;
use crate::Rgba;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{self, Operation, Tree};
use iced::advanced::{Renderer as _, Shell, Widget, overlay, renderer};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector, mouse};

/// `top` laid over `base` (the page under the dialog's veil).
pub fn blend(top: Rgba, base: Rgba) -> Rgba {
    let mix = |t: u8, b: u8| (f32::from(t) * top.a + f32::from(b) * (1.0 - top.a)).round() as u8;
    Rgba::new(mix(top.r, base.r), mix(top.g, base.g), mix(top.b, base.b), 1.0)
}

/// A box entering at `phase`.
pub struct Enter<'a, Message> {
    content: Element<'a, Message>,
    phase: f32,
    rise: f32,
    veil: Rgba,
    radius: f32,
}

impl<'a, Message: 'a> Enter<'a, Message> {
    /// `veil` is the colour behind the box; `radius` its corner.
    pub fn new(content: Element<'a, Message>, phase: f32, rise: f32, veil: Rgba, radius: f32) -> Self {
        Enter { content, phase, rise, veil, radius }
    }
}

impl<Message> widget::Meta for Enter<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Enter<'a, Message> {
    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        if self.phase >= 1.0 {
            self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
            return;
        }
        let eased = cubic_bezier(scale::EASE_OUT, self.phase.clamp(0.0, 1.0));
        let rise = (1.0 - eased) * self.rise;
        renderer.with_translation(Vector::new(0.0, rise), |renderer| self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport));
        let bounds = layout.bounds();
        let veil = self.veil.faded(1.0 - eased);
        let at = Rectangle { y: bounds.y + rise, ..bounds };
        renderer.with_layer(at, |renderer| paint_fill(renderer, at, self.radius, veil));
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}
