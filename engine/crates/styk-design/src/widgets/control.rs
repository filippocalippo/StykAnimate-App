//! What the design system's controls share: the states a control draws, how a disabled one fades, the shadows a CSS
//! `box-shadow` list becomes, and the one pressable surface the buttons, chips and segmented items are built on.
//!
//! A control draws one of four looks: rest, hover, pressed and (for the focus ring, which `focus::Focusable` draws) keyboard
//! focus. The pointer decides the first three; a component sheet or a test holds one fixed with [`Preview`], so every state
//! can be looked at at once without a hovering pointer.

use iced::Widget as _;
use crate::{BoxShadow, Rgba};
use iced::advanced::renderer::Quad;
use iced::advanced::Renderer as _;
use iced::{Border, Color, Rectangle, Shadow, Vector};

/// `:disabled { opacity: 0.42 }`: buttons, switches, checks, radios, sliders, chips and segmented items.
pub const DISABLED: f32 = 0.42;

/// `opacity: 0.5`: a disabled field or select.
pub const FIELD_DISABLED: f32 = 0.5;

/// The interaction a control is drawn in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Interaction {
    #[default]
    Rest,
    /// The pointer is over it (`:hover`).
    Hover,
    /// The pointer went down on it and is still down (`:active`; it is hovered too).
    Pressed,
}

/// A state held fixed whatever the pointer does, for the component sheet and tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preview {
    Hover,
    Pressed,
    /// The focus ring shows (`:focus-visible`).
    Focus,
}

impl Preview {
    /// The interaction this holds, if it is one (a focus preview leaves the pointer's).
    pub fn interaction(self) -> Option<Interaction> {
        match self {
            Preview::Hover => Some(Interaction::Hover),
            Preview::Pressed => Some(Interaction::Pressed),
            Preview::Focus => None,
        }
    }
}

/// Draws a CSS `box-shadow` list around `bounds`. An outer shadow is a blurred quad (`spread` grows it); an inset one with
/// no blur is a ring drawn inside the edge (what `inset 0 0 0 1px` is), and a blurred inset shadow is not drawn.
pub fn paint_shadows(renderer: &mut iced::Renderer, bounds: Rectangle, radius: f32, shadows: &[BoxShadow], opacity: f32) {
    for shadow in shadows.iter().filter(|shadow| !shadow.inset) {
        let grown = Rectangle { x: bounds.x - shadow.spread, y: bounds.y - shadow.spread, width: (bounds.width + 2.0 * shadow.spread).max(0.0), height: (bounds.height + 2.0 * shadow.spread).max(0.0) };
        let color: Color = shadow.color.faded(opacity).into();
        let outer = Quad { bounds: grown, border: Border { radius: (radius + shadow.spread).max(0.0).into(), ..Border::default() }, shadow: Shadow { color, offset: Vector::new(shadow.x, shadow.y), blur_radius: shadow.blur }, snap: false };
        if shadow.blur == 0.0 && shadow.x == 0.0 && shadow.y == 0.0 {
            // A hairline ring around the box: the border of a quad that surrounds it (a blurless shadow has no fill of its own).
            renderer.fill_quad(Quad { shadow: Shadow::default(), border: Border { color, width: shadow.spread, radius: (radius + shadow.spread).into() }, ..outer }, Color::TRANSPARENT);
        } else {
            // A transparent quad draws only its shadow; the control lays its own background over it.
            renderer.fill_quad(outer, Color::TRANSPARENT);
        }
    }
}

/// An inset ring: `box-shadow: inset 0 0 0 {width}px {color}`.
pub fn paint_ring(renderer: &mut iced::Renderer, bounds: Rectangle, radius: f32, width: f32, color: Rgba) {
    renderer.fill_quad(Quad { bounds, border: Border { color: color.into(), width, radius: radius.into() }, shadow: Shadow::default(), snap: false }, Color::TRANSPARENT);
}

/// A filled rounded rectangle.
pub fn paint_fill(renderer: &mut iced::Renderer, bounds: Rectangle, radius: f32, color: Rgba) {
    renderer.fill_quad(Quad { bounds, border: Border { radius: radius.into(), ..Border::default() }, shadow: Shadow::default(), snap: false }, Color::from(color));
}

/// The radius a pill has on a box this high.
pub fn pill(height: f32) -> f32 {
    height / 2.0
}

/// A line of text in `style` and `color`, as the Inspector's kit draws its labels.
pub fn words<'a, Message: 'a>(value: impl Into<String>, style: crate::typography::TextStyle, color: Rgba) -> iced::Element<'a, Message> {
    iced::widget::text(value.into()).font(style.font).size(style.size).line_height(style.line()).color(Color::from(color)).boxed()
}
