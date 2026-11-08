//! Progress and spinner (`progress.css`): a 6 px track filled to a fraction, or an indeterminate bar that sweeps across it
//! (a 1.3 s loop), and the 14 px ring that turns (0.8 s).
//!
//! A loop is state with a deadline, and the core owns it (`Host::phase`, started by `Event::Animate` or by a task message
//! showing): these draw the phase they are given, 0 to 1 through the loop, and keep no clock and no redraw of their own.
//! Nothing here decides when work is done; the fraction is the owner's.

use super::control::{cubic_bezier, paint_fill, pill};
use crate::tokens::scale;
use crate::Palette;
use iced::advanced::layout::{self, Layout};
use iced::advanced::svg::{Renderer as _, Svg};
use iced::advanced::widget;
use iced::advanced::{Renderer as _, Widget, renderer};
use iced::{Color, Length, Radians, Rectangle, Renderer, Size, Theme, mouse};

/// A progress bar: `fraction` of its track filled, or `None` for the sweep at `phase` of its loop.
pub struct Bar {
    palette: &'static Palette,
    fraction: Option<f32>,
    width: Length,
    danger: bool,
    phase: f32,
}

impl Bar {
    pub fn new(palette: &'static Palette, fraction: Option<f32>) -> Bar {
        Bar { palette, fraction: fraction.map(|fraction| fraction.clamp(0.0, 1.0)), width: Length::Fill, danger: false, phase: 0.0 }
    }

    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    /// `data-tone="danger"`.
    pub fn danger(mut self, danger: bool) -> Self {
        self.danger = danger;
        self
    }

    /// Where the sweep is in its loop (`Host::phase`), 0 to 1.
    pub fn phase(mut self, phase: f32) -> Self {
        self.phase = phase;
        self
    }
}

impl widget::Meta for Bar {}

impl<Message> Widget<Message, Theme, Renderer> for Bar {
    fn size(&self) -> Size<Length> {
        Size::new(self.width, Length::Fixed(6.0))
    }

    fn layout(&mut self, tree: &mut widget::Tree, _renderer: &Renderer, limits: &layout::Limits) {
        tree.size = layout::atomic(limits, self.width, Length::Fixed(6.0));
    }

    fn draw(&self, _tree: &widget::Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let bounds = layout.bounds();
        let radius = pill(bounds.height);
        paint_fill(renderer, bounds, radius, self.palette.surface_well);
        let fill = if self.danger { self.palette.danger_dot } else { self.palette.accent_strong };
        match self.fraction {
            Some(fraction) if fraction > 0.0 => paint_fill(renderer, Rectangle { width: bounds.width * fraction, ..bounds }, radius, fill),
            Some(_) => {}
            None => {
                // `inline-size: 32%` travelling from -100 % to 320 % of its own width.
                let bar = bounds.width * 0.32;
                let x = bounds.x + bar * (-1.0 + 4.2 * cubic_bezier(scale::EASE_IN_OUT, self.phase.clamp(0.0, 1.0)));
                // Not yet (or no longer) over the track: nothing to draw.
                if x + bar > bounds.x && x < bounds.x + bounds.width {
                    renderer.with_layer(bounds, |renderer| paint_fill(renderer, Rectangle { x, width: bar, ..bounds }, radius, fill));
                }
            }
        }
    }
}

/// `.ui-spinner`: three quarters of a 2 px ring in the ink, 80 % opaque, turning once in 0.8 s.
const RING: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path d="M11.243 2.757A6 6 0 1 0 11.243 11.243" fill="none" stroke="black" stroke-width="2"/></svg>"#;

/// The spinner, at `phase` of its turn.
pub struct Spinner {
    ink: Color,
    phase: f32,
}

impl Spinner {
    pub fn new(ink: impl Into<Color>) -> Spinner {
        Spinner { ink: ink.into(), phase: 0.0 }
    }

    /// Where the ring is in its turn (`Host::phase`), 0 to 1.
    pub fn phase(mut self, phase: f32) -> Self {
        self.phase = phase;
        self
    }
}

impl widget::Meta for Spinner {}

impl<Message> Widget<Message, Theme, Renderer> for Spinner {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fixed(14.0), Length::Fixed(14.0))
    }

    fn layout(&mut self, tree: &mut widget::Tree, _renderer: &Renderer, limits: &layout::Limits) {
        tree.size = layout::atomic(limits, Length::Fixed(14.0), Length::Fixed(14.0));
    }

    fn draw(&self, _tree: &widget::Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let handle = iced::widget::svg::Handle::from_memory(RING);
        let svg = Svg::new(handle).color(Color { a: 1.0, ..self.ink }).opacity(0.8 * self.ink.a).rotation(Radians(self.phase * std::f32::consts::TAU));
        renderer.draw_svg(svg, layout.bounds(), layout.bounds());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ease_runs_from_zero_to_one_and_is_slow_at_both_ends() {
        let ease = |x| cubic_bezier(scale::EASE_IN_OUT, x);
        assert!(ease(0.0).abs() < 1e-3 && (ease(1.0) - 1.0).abs() < 1e-3);
        assert!((ease(0.5) - 0.5).abs() < 1e-3);
        assert!(ease(0.1) < 0.1 && ease(0.9) > 0.9);
    }
}
