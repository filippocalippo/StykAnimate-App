//! The field box (`.ui-field`, `field.css`): a sunken rounded box that holds a field's parts and draws its states around
//! them: a hairline on hover, the accent ring and halo while anything inside holds focus (`:focus-within`) or a scrub is
//! under way, the danger ring while invalid, and half opacity while disabled.
//!
//! The frame finds out for itself that something inside is focused (it asks the tree), so the number field, the select and
//! the colour field need no focus message to look focused.

use iced::Widget as _;
use super::control::{FIELD_DISABLED, Preview, paint_fill, paint_ring};
use crate::{Palette, Rgba, tokens};
use iced::advanced::layout::{self, Layout};
use iced::advanced::{overlay, renderer};
use iced::advanced::widget::operation::{self, Outcome};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::widget::container;
use iced::{Alignment, Element, Event, Length, Padding, Rectangle, Renderer, Size, Theme, Vector, mouse};

/// The frame's height at the default size (`--control-lg`).
pub const HEIGHT: f32 = tokens::scale::CONTROL_LG;

/// The padding of a field in a grid of fields (`.ui-field-grid > .ui-field`) and outside one, as the content sits inside
/// the 1 px transparent border: (left, right).
pub fn padding(in_grid: bool) -> (f32, f32) {
    let (left, right) = if in_grid { (tokens::scale::SPACE_1_5, tokens::scale::SPACE_1) } else { (tokens::scale::SPACE_2_5, tokens::scale::SPACE_2) };
    (left + 1.0, right + 1.0)
}

#[derive(Default)]
struct State {
    focused: bool,
}

/// Whether anything in a subtree holds focus.
struct AnyFocused(bool);

impl Operation for AnyFocused {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<()>)) {
        operate(self);
    }

    fn focusable(&mut self, _id: Option<&widget::Id>, _bounds: Rectangle, state: &mut dyn operation::Focusable) {
        self.0 |= state.is_focused();
    }

    fn finish(&self) -> Outcome<()> {
        Outcome::None
    }
}

/// The frame around a field's parts.
pub struct FieldFrame<'a, Message> {
    inner: Element<'a, Message>,
    palette: &'static Palette,
    disabled: bool,
    invalid: bool,
    engaged: bool,
    preview: Option<Preview>,
}

impl<'a, Message: 'a> FieldFrame<'a, Message> {
    /// `content` in a frame `height` high and `width` wide with `padding` around it, centred vertically.
    pub fn new(content: Element<'a, Message>, palette: &'static Palette, width: Length, height: f32, padding: Padding) -> Self {
        let inner = container(content).width(width).height(Length::Fixed(height)).align_y(Alignment::Center).padding(padding);
        FieldFrame { inner: inner.boxed(), palette, disabled: false, invalid: false, engaged: false, preview: None }
    }

    /// The field is disabled (half opacity, no states).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The field holds an invalid value (the danger ring).
    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// The field is being scrubbed (`[data-scrubbing]`): it draws as focused.
    pub fn engaged(mut self, engaged: bool) -> Self {
        self.engaged = engaged;
        self
    }

    /// Holds a state fixed: hover or focus (the component sheet and tests).
    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }
}

impl<Message> widget::Meta for FieldFrame<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for FieldFrame<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        self.inner.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.inner));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.inner.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.inner.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.inner.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
        let mut any = AnyFocused(false);
        self.inner.operate(&mut tree.children[0], layout, viewport, renderer, &mut any);
        let state = tree.state.downcast_mut::<State>();
        if state.focused != any.0 {
            state.focused = any.0;
            shell.request_redraw();
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.inner.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let palette = self.palette;
        let bounds = layout.bounds();
        let radius = tokens::scale::RADIUS_MD;
        let opacity = if self.disabled { FIELD_DISABLED } else { 1.0 };
        let live = !self.disabled;
        let focused = live && (tree.state.downcast_ref::<State>().focused || self.engaged || self.preview == Some(Preview::Focus));
        let hovered = live && (self.preview == Some(Preview::Hover) || cursor.is_over(bounds));
        let fill = if focused { palette.surface } else { palette.surface_sunken };
        paint_fill(renderer, bounds, radius, fill.faded(opacity));
        // `.ui-field:focus-within`: the accent ring and a 3 px halo outside it; `:has([aria-invalid])`: the danger pair.
        let (ring, halo): (Option<(f32, Rgba)>, Option<Rgba>) = if self.invalid && live {
            (Some((1.5, palette.danger_text)), Some(palette.danger_soft))
        } else if focused {
            (Some((1.5, palette.accent_line)), Some(palette.focus_halo))
        } else if hovered {
            (Some((1.0, palette.line_3)), None)
        } else {
            (None, None)
        };
        if let Some(halo) = halo {
            let grown = Rectangle { x: bounds.x - 3.0, y: bounds.y - 3.0, width: bounds.width + 6.0, height: bounds.height + 6.0 };
            paint_ring(renderer, grown, radius + 3.0, 3.0, halo);
        }
        if let Some((width, color)) = ring {
            // The ring is `box-shadow: inset`, so it sits inside the 1 px transparent border.
            let inner = Rectangle { x: bounds.x + 1.0, y: bounds.y + 1.0, width: bounds.width - 2.0, height: bounds.height - 2.0 };
            paint_ring(renderer, inner, radius - 1.0, width, color.faded(opacity));
        }
        // A disabled field's parts fade themselves (`FIELD_DISABLED`): the frame cannot fade what other widgets draw.
        self.inner.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.inner.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}
