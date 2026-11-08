//! The raised box every overlay and island is: a fill, an optional hairline ring, a list of shadows (`--elevation-*`) and a
//! radius, around its content.
//!
//! It draws and lays out; it decides nothing. Menus, popovers, sheets, dialogs, toasts, tooltips and islands are built on it,
//! so a shadow, radius or fill is written once.

use iced::Widget as _;
use super::control::{paint_fill, paint_ring, paint_shadows};
use crate::{BoxShadow, Rgba};
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget, overlay, renderer};
use iced::{Element, Event, Length, Padding, Rectangle, Renderer, Size, Theme, Vector, mouse};

/// A box around a content.
pub struct Card<'a, Message> {
    content: Element<'a, Message>,
    fill: Option<Rgba>,
    radius: f32,
    shadows: &'static [BoxShadow],
    ring: Option<(f32, Rgba)>,
    underlay: Option<(f32, Rgba)>,
    halo: Option<Rgba>,
    width: Length,
    height: Length,
    padding: Padding,
    clip: bool,
}

impl<'a, Message: 'a> Card<'a, Message> {
    pub fn new(content: impl Widget<Message, Theme, Renderer> + 'a) -> Self {
        Card { content: content.boxed(), fill: None, radius: 0.0, shadows: &[], ring: None, underlay: None, halo: None, width: Length::Shrink, height: Length::Shrink, padding: Padding::ZERO, clip: false }
    }

    pub fn fill(mut self, fill: Rgba) -> Self {
        self.fill = Some(fill);
        self
    }

    pub fn radius(mut self, radius: f32) -> Self {
        self.radius = radius;
        self
    }

    /// `box-shadow: var(--elevation-*)`.
    pub fn shadows(mut self, shadows: &'static [BoxShadow]) -> Self {
        self.shadows = shadows;
        self
    }

    /// An inset hairline (`box-shadow: inset 0 0 0 1px`).
    pub fn ring(mut self, width: f32, color: Rgba) -> Self {
        self.ring = Some((width, color));
        self
    }

    /// A 3 px ring around the box, outside it and out of layout (`box-shadow: 0 0 0 3px var(--focus-halo)`).
    pub fn halo(mut self, color: Rgba) -> Self {
        self.halo = Some(color);
        self
    }

    /// A copy of the box `drop` pixels lower, behind it (`box-shadow: 0 1px 0 <colour>`).
    pub fn underlay(mut self, drop: f32, color: Rgba) -> Self {
        self.underlay = Some((drop, color));
        self
    }

    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    pub fn height(mut self, height: impl Into<Length>) -> Self {
        self.height = height.into();
        self
    }

    pub fn padding(mut self, padding: impl Into<Padding>) -> Self {
        self.padding = padding.into();
        self
    }

    /// The content is clipped to the box (`overflow: hidden`).
    pub fn clip(mut self, clip: bool) -> Self {
        self.clip = clip;
        self
    }
}

impl<Message> widget::Meta for Card<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Card<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::stateless()
    }

    fn state(&self) -> tree::State {
        tree::State::None
    }

    fn size(&self) -> Size<Length> {
        Size::new(self.width, self.height)
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        let content = &mut self.content;
        layout::padded(tree, limits, self.width, self.height, self.padding, |child, limits| {
            content.layout(child, renderer, limits);
            child.size
        });
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        operation.container(None, layout.bounds(), viewport);
        operation.traverse(&mut |operation| {
            if let Some((layout, tree)) = layout.iter_mut(&mut tree.children).next() {
                self.content.operate(tree, layout, viewport, renderer, operation);
            }
        });
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        if let Some((layout, tree)) = layout.iter_mut(&mut tree.children).next() {
            self.content.update(tree, event, layout, cursor, renderer, shell, viewport);
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        layout.iter(&tree.children).next().map_or(mouse::Interaction::None, |(layout, tree)| self.content.mouse_interaction(tree, layout, cursor, viewport, renderer))
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let bounds = layout.bounds();
        paint_shadows(renderer, bounds, self.radius, self.shadows, 1.0);
        if let Some(color) = self.halo {
            let grown = Rectangle { x: bounds.x - 3.0, y: bounds.y - 3.0, width: bounds.width + 6.0, height: bounds.height + 6.0 };
            paint_ring(renderer, grown, self.radius + 3.0, 3.0, color);
        }
        if let Some((drop, color)) = self.underlay {
            paint_fill(renderer, Rectangle { y: bounds.y + drop, ..bounds }, self.radius, color);
        }
        if let Some(fill) = self.fill {
            paint_fill(renderer, bounds, self.radius, fill);
        }
        if let Some((width, color)) = self.ring {
            paint_ring(renderer, bounds, self.radius, width, color);
        }
        if let Some((layout, tree)) = layout.iter(&tree.children).next() {
            if self.clip {
                if let Some(clip) = bounds.intersection(viewport) {
                    iced::advanced::Renderer::with_layer(renderer, clip, |renderer| self.content.draw(tree, renderer, theme, style, layout, cursor, &clip));
                }
            } else {
                self.content.draw(tree, renderer, theme, style, layout, cursor, viewport);
            }
        }
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        match layout.iter_mut(&mut tree.children).next() {
            Some((layout, tree)) => self.content.overlay(tree, layout, renderer, viewport, translation, window),
            None => Vec::new(),
        }
    }
}

