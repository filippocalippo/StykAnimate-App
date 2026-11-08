//! Progress and spinner (`progress.css`): a 6 px track filled to a fraction, or an indeterminate bar that sweeps across it
//! (a 1.3 s loop), and the 14 px ring that turns (0.8 s).
//!
//! The loops are drawing, not behaviour: their phase is the time since the widget's first frame, taken from the redraw
//! the toolkit delivers, and they ask for the next frame only while they are on screen. Nothing here decides when work is
//! done; the fraction is the owner's.

use super::control::{paint_fill, pill};
use crate::tokens::scale;
use crate::Palette;
use iced::advanced::layout::{self, Layout};
use iced::advanced::svg::{Renderer as _, Svg};
use iced::advanced::widget::{self, tree};
use iced::advanced::{Renderer as _, Shell, Widget, renderer};
use iced::{Color, Event, Length, Radians, Rectangle, Renderer, Size, Theme, mouse, window};
use iced::time::Duration;

/// `--ease-in-out`: `cubic-bezier(.65, 0, .35, 1)`.
fn ease_in_out(x: f32) -> f32 {
    const P: [f32; 4] = scale::EASE_IN_OUT;
    let at = |t: f32, a: f32, b: f32| 3.0 * (1.0 - t) * (1.0 - t) * t * a + 3.0 * (1.0 - t) * t * t * b + t * t * t;
    let (mut low, mut high) = (0.0_f32, 1.0_f32);
    for _ in 0..24 {
        let mid = (low + high) / 2.0;
        if at(mid, P[0], P[2]) < x { low = mid } else { high = mid }
    }
    at((low + high) / 2.0, P[1], P[3])
}

#[derive(Default)]
struct Clock {
    origin: Option<iced::time::Instant>,
    /// 0 to 1 through the loop.
    phase: f32,
}

impl Clock {
    fn advance(&mut self, now: iced::time::Instant, period: Duration) {
        let origin = *self.origin.get_or_insert(now);
        self.phase = (now.saturating_duration_since(origin).as_secs_f32() / period.as_secs_f32()).fract();
    }
}

/// A progress bar: `fraction` of its track filled, or `None` for the sweep.
pub struct Bar {
    palette: &'static Palette,
    fraction: Option<f32>,
    width: Length,
    danger: bool,
}

impl Bar {
    pub fn new(palette: &'static Palette, fraction: Option<f32>) -> Bar {
        Bar { palette, fraction: fraction.map(|fraction| fraction.clamp(0.0, 1.0)), width: Length::Fill, danger: false }
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
}

impl widget::Meta for Bar {}

impl<Message> Widget<Message, Theme, Renderer> for Bar {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Clock>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(Clock::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(self.width, Length::Fixed(6.0))
    }

    fn layout(&mut self, tree: &mut widget::Tree, _renderer: &Renderer, limits: &layout::Limits) {
        tree.size = layout::atomic(limits, self.width, Length::Fixed(6.0));
    }

    fn update(&mut self, tree: &mut widget::Tree, event: &Event, _layout: Layout, _cursor: mouse::Cursor, _renderer: &Renderer, shell: &mut Shell<'_, Message>, _viewport: &Rectangle) {
        if self.fraction.is_none()
            && let Event::Window(window::Event::RedrawRequested(now)) = event
        {
            tree.state.downcast_mut::<Clock>().advance(*now, Duration::from_millis(1300));
            shell.request_redraw();
        }
    }

    fn draw(&self, tree: &widget::Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle) {
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
                let phase = tree.state.downcast_ref::<Clock>().phase;
                let x = bounds.x + bar * (-1.0 + 4.2 * ease_in_out(phase));
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

/// The spinner.
pub struct Spinner {
    ink: Color,
}

impl Spinner {
    pub fn new(ink: impl Into<Color>) -> Spinner {
        Spinner { ink: ink.into() }
    }
}

impl widget::Meta for Spinner {}

impl<Message> Widget<Message, Theme, Renderer> for Spinner {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Clock>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(Clock::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fixed(14.0), Length::Fixed(14.0))
    }

    fn layout(&mut self, tree: &mut widget::Tree, _renderer: &Renderer, limits: &layout::Limits) {
        tree.size = layout::atomic(limits, Length::Fixed(14.0), Length::Fixed(14.0));
    }

    fn update(&mut self, tree: &mut widget::Tree, event: &Event, _layout: Layout, _cursor: mouse::Cursor, _renderer: &Renderer, shell: &mut Shell<'_, Message>, _viewport: &Rectangle) {
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            tree.state.downcast_mut::<Clock>().advance(*now, Duration::from_millis(800));
            shell.request_redraw();
        }
    }

    fn draw(&self, tree: &widget::Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let phase = tree.state.downcast_ref::<Clock>().phase;
        let handle = iced::widget::svg::Handle::from_memory(RING);
        let svg = Svg::new(handle).color(Color { a: 1.0, ..self.ink }).opacity(0.8 * self.ink.a).rotation(Radians(phase * std::f32::consts::TAU));
        renderer.draw_svg(svg, layout.bounds(), layout.bounds());
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ease_runs_from_zero_to_one_and_is_slow_at_both_ends() {
        assert!(ease_in_out(0.0).abs() < 1e-3 && (ease_in_out(1.0) - 1.0).abs() < 1e-3);
        assert!((ease_in_out(0.5) - 0.5).abs() < 1e-3);
        assert!(ease_in_out(0.1) < 0.1 && ease_in_out(0.9) > 0.9);
    }

    #[test]
    fn the_phase_loops_from_the_first_frame() {
        let mut clock = Clock::default();
        let start = iced::time::Instant::now();
        clock.advance(start, Duration::from_millis(800));
        assert_eq!(clock.phase, 0.0);
        clock.advance(start + Duration::from_millis(200), Duration::from_millis(800));
        assert!((clock.phase - 0.25).abs() < 1e-4);
        clock.advance(start + Duration::from_millis(900), Duration::from_millis(800));
        assert!((clock.phase - 0.125).abs() < 1e-4, "a loop starts over");
    }
}
