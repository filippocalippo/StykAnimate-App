//! Swatches and the colour field (`swatch.css`, `field.css`): a colour shown, and a field that opens the paint picker.
//!
//! The field reports a press; the picker is the owner's. Its role is [`InputRole::Other`], declared here: a native colour
//! input is an input to the shortcut routing.

use iced::Widget as _;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{self, Tree};
use iced::advanced::{Renderer as _, renderer};
use super::control::{FIELD_DISABLED, Preview, paint_ring, paint_shadows, words};
use super::focus::{Focusable, Keys, Ring};
use super::frame::{self, FieldFrame};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{BoxShadow, Palette, Rgba};
use iced::widget::{Row, Space, container};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Rectangle, Renderer, Size, Theme, mouse};
use styk_core::focus::{FocusArea, FocusId, InputRole};

/// A swatch's sizes (`data-size`): 16, 20 (the default), 24 (in a grid) and 28 px; `Chip` is the 16 px swatch of a list
/// row's actions (`.ui-list-row-actions > .ui-swatch`), which keeps the default radius.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SwatchSize {
    Sm,
    Chip,
    #[default]
    Md,
    Grid,
    Lg,
}

impl SwatchSize {
    pub fn side(self) -> f32 {
        match self {
            SwatchSize::Sm | SwatchSize::Chip => 16.0,
            SwatchSize::Md => 20.0,
            SwatchSize::Grid => 24.0,
            SwatchSize::Lg => 28.0,
        }
    }

    fn radius(self) -> f32 {
        match self {
            SwatchSize::Sm => scale::RADIUS_2XS,
            SwatchSize::Md | SwatchSize::Grid | SwatchSize::Chip => scale::RADIUS_SM,
            SwatchSize::Lg => scale::RADIUS_MD,
        }
    }
}

/// A colour in a rounded square with its hairline (`--swatch-ring`).
pub fn swatch<'a, Message: 'a>(palette: &'static Palette, rgb: [u8; 3], size: SwatchSize, opacity: f32) -> Element<'a, Message> {
    let side = size.side();
    let ring = palette.swatch_ring;
    container(Space::new().width(side).height(side))
        .style(move |_| container::Style {
            background: Some(Background::Color(Color { a: opacity, ..Color::from_rgb8(rgb[0], rgb[1], rgb[2]) })),
            border: Border { color: ring.faded(opacity).into(), width: 1.0, radius: size.radius().into() },
            ..container::Style::default()
        })
        .boxed()
}

/// How a gradient paint runs across a swatch (`paintCSS`): a diamond paints as a radial one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GradientKind {
    Linear,
    Radial,
    Angular,
}

/// One stop of a gradient swatch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwatchStop {
    /// 0 to 1.
    pub offset: f32,
    pub rgb: [u8; 3],
    /// 0 to 1.
    pub opacity: f32,
}

/// A gradient paint a swatch shows (`--swatch-paint`, `paintCSS`): the stops in order, the angle in degrees.
#[derive(Clone, Debug, PartialEq)]
pub struct SwatchPaint {
    pub kind: GradientKind,
    pub angle: f32,
    pub stops: Vec<SwatchStop>,
}

impl SwatchPaint {
    /// The colour, premultiplied, at `t` along the stops (CSS interpolates in premultiplied sRGB; before the first stop
    /// and after the last it holds their colour).
    fn at(&self, t: f32) -> [f32; 4] {
        let premultiplied = |stop: &SwatchStop| {
            let a = stop.opacity;
            [f32::from(stop.rgb[0]) * a, f32::from(stop.rgb[1]) * a, f32::from(stop.rgb[2]) * a, a]
        };
        let (Some(first), Some(last)) = (self.stops.first(), self.stops.last()) else { return [0.0; 4] };
        if t <= first.offset {
            return premultiplied(first);
        }
        for pair in self.stops.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if t < b.offset {
                let f = ((t - a.offset) / (b.offset - a.offset).max(f32::EPSILON)).clamp(0.0, 1.0);
                let (from, to) = (premultiplied(a), premultiplied(b));
                return [0, 1, 2, 3].map(|i| from[i] + (to[i] - from[i]) * f);
            }
        }
        premultiplied(last)
    }

    /// Where along the stops the point (`x`, `y`), measured from the centre of a square of `side`, falls.
    fn position(&self, x: f32, y: f32, side: f32) -> f32 {
        // `linear-gradient(<angle + 90>deg)` and `conic-gradient(from <angle + 90>deg)`: 0deg points up, clockwise.
        let turn = (self.angle + 90.0).to_radians();
        match self.kind {
            GradientKind::Linear => {
                let (sin, cos) = turn.sin_cos();
                let length = side * (sin.abs() + cos.abs());
                (x * sin - y * cos) / length + 0.5
            }
            // `radial-gradient(circle, ...)`: to the farthest corner.
            GradientKind::Radial => x.hypot(y) / (side * std::f32::consts::FRAC_1_SQRT_2),
            GradientKind::Angular => (x.atan2(-y) - turn).rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU,
        }
    }
}

/// What a swatch face fills with.
#[derive(Clone, Debug, PartialEq)]
enum Fill {
    Solid([u8; 3]),
    Gradient(SwatchPaint),
}

/// A swatch face: a colour or a gradient in a rounded square with its hairline, the checkerboard showing through
/// transparency (`.ui-swatch`). A hovered one (`hover`) gains the outer rings of a pressable swatch
/// (`:is(button, input).ui-swatch:hover`).
struct Face {
    palette: &'static Palette,
    fill: Fill,
    side: f32,
    radius: f32,
    opacity: f32,
    hover: bool,
}

impl widget::Meta for Face {}

impl<Message> iced::advanced::Widget<Message, Theme, Renderer> for Face {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fixed(self.side), Length::Fixed(self.side))
    }

    fn layout(&mut self, tree: &mut Tree, _: &Renderer, _: &layout::Limits) {
        tree.size = Size::new(self.side, self.side);
    }

    fn draw(&self, _: &Tree, renderer: &mut Renderer, _: &Theme, _: &renderer::Style, layout: Layout, _: mouse::Cursor, _: &Rectangle) {
        let bounds = layout.bounds();
        let (palette, radius) = (self.palette, self.radius);
        if self.hover {
            // `0 0 0 2px var(--surface), 0 0 0 3px var(--line-3)`: the first listed is on top.
            let rings = [
                BoxShadow { inset: false, x: 0.0, y: 0.0, blur: 0.0, spread: 3.0, color: palette.line_3 },
                BoxShadow { inset: false, x: 0.0, y: 0.0, blur: 0.0, spread: 2.0, color: palette.surface },
            ];
            paint_shadows(renderer, bounds, radius, &rings, 1.0);
        }
        match &self.fill {
            Fill::Solid(rgb) => {
                let ring = palette.swatch_ring.faded(self.opacity);
                let color = Color { a: self.opacity, ..Color::from_rgb8(rgb[0], rgb[1], rgb[2]) };
                renderer.fill_quad(renderer::Quad { bounds, border: Border { color: ring.into(), width: 1.0, radius: radius.into() }, ..renderer::Quad::default() }, color);
            }
            Fill::Gradient(paint) => self.draw_gradient(renderer, bounds, paint),
        }
    }
}

impl Face {
    /// The gradient over the checkerboard, one logical pixel at a time (the toolkit draws no radial or conic gradient),
    /// the cells of a row that came out alike drawn as one, then the hairline.
    fn draw_gradient(&self, renderer: &mut Renderer, bounds: Rectangle, paint: &SwatchPaint) {
        let cells = self.side.round() as i32;
        let (left, top) = (bounds.x.round(), bounds.y.round());
        let radius = self.radius.min(self.side / 2.0);
        let half = self.side / 2.0;
        // The rounded square: a centre inside a corner's quarter circle, or anywhere along the straight sides.
        let inside = |x: f32, y: f32| {
            let (dx, dy) = ((x - half).abs() - (half - radius), (y - half).abs() - (half - radius));
            dx <= 0.0 || dy <= 0.0 || dx.hypot(dy) <= radius
        };
        for row in 0..cells {
            let mut open: Option<(i32, Color)> = None;
            let flush = |renderer: &mut Renderer, open: &mut Option<(i32, Color)>, end: i32| {
                if let Some((from, color)) = open.take() {
                    let at = Rectangle { x: left + from as f32, y: top + row as f32, width: (end - from) as f32, height: 1.0 };
                    renderer.fill_quad(renderer::Quad { bounds: at, snap: true, ..renderer::Quad::default() }, color);
                }
            };
            for column in 0..cells {
                let (x, y) = (column as f32 + 0.5, row as f32 + 0.5);
                if !inside(x, y) {
                    flush(renderer, &mut open, column);
                    continue;
                }
                let color = self.cell(paint, column, row, x - half, y - half);
                match open {
                    Some((_, held)) if held == color => {}
                    _ => {
                        flush(renderer, &mut open, column);
                        open = Some((column, color));
                    }
                }
            }
            flush(renderer, &mut open, cells);
        }
        paint_ring(renderer, bounds, self.radius, 1.0, self.palette.swatch_ring.faded(self.opacity));
    }

    /// One cell's colour: the paint at its centre (`x`, `y` from the swatch's centre) over the checkerboard (8 px squares
    /// from the swatch's corner: `repeating-conic-gradient(a 0 25%, b 0 50%)`, so the top right and bottom left are `a`).
    fn cell(&self, paint: &SwatchPaint, column: i32, row: i32, x: f32, y: f32) -> Color {
        let palette = self.palette;
        let (right, below) = (column.rem_euclid(8) >= 4, row.rem_euclid(8) >= 4);
        let checker = if right != below { palette.checker_a } else { palette.checker_b };
        let [r, g, b, a] = paint.at(paint.position(x, y, self.side));
        let behind = |over: f32, under: u8| (over + f32::from(under) * (1.0 - a)).clamp(0.0, 255.0) / 255.0;
        Color { r: behind(r, checker.r), g: behind(g, checker.g), b: behind(b, checker.b), a: self.opacity }
    }
}

fn face<'a, Message: 'a>(palette: &'static Palette, fill: Fill, size: SwatchSize, opacity: f32, hover: bool) -> Element<'a, Message> {
    Face { palette, fill, side: size.side(), radius: size.radius(), opacity, hover }.boxed()
}

/// A gradient in a rounded square with its hairline over the checkerboard (`--swatch-paint`).
pub fn swatch_paint<'a, Message: 'a>(palette: &'static Palette, paint: SwatchPaint, size: SwatchSize, opacity: f32) -> Element<'a, Message> {
    face(palette, Fill::Gradient(paint), size, opacity, false)
}

/// A swatch that is a button (a palette colour): a press publishes `on_press`; hovered, it gains its outer rings.
pub struct SwatchButton<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    rgb: [u8; 3],
    size: SwatchSize,
    on_press: Message,
    tab_stop: bool,
    keys: Keys<'a, Message>,
}

impl<'a, Message: Clone + 'a> SwatchButton<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, rgb: [u8; 3], size: SwatchSize, on_press: Message) -> Self {
        SwatchButton { id, area, palette, rgb, size, on_press, tab_stop: true, keys: Keys::Button }
    }

    /// Whether Tab stops here (a collection is one tab stop).
    pub fn tab_stop(mut self, tab_stop: bool) -> Self {
        self.tab_stop = tab_stop;
        self
    }

    /// The keys the swatch answers (Enter and Space press it; a collection adds its arrows).
    pub fn keys(mut self, keys: Keys<'a, Message>) -> Self {
        self.keys = keys;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let SwatchButton { id, area, palette, rgb, size, on_press, tab_stop, keys } = self;
        let rest = face(palette, Fill::Solid(rgb), size, 1.0, false);
        let hovered = face(palette, Fill::Solid(rgb), size, 1.0, true);
        let press = Surface::new(rest, move |_| Look::plain(size.radius())).hover_face(hovered).on_press_maybe(Some(on_press.clone()));
        // `.ui-swatch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px }`.
        Focusable::new(id, area, press.boxed(), Ring::of(palette, size.radius())).keys(keys).tab_stop(tab_stop).on_activate(on_press).boxed()
    }
}

/// The colour field: a 16 px swatch drawn 2 px into the padding and the hex (or a caption), in the field box.
pub struct ColorField<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    rgb: [u8; 3],
    paint: Option<SwatchPaint>,
    caption: String,
    centered: bool,
    in_grid: bool,
    disabled: bool,
    on_press: Message,
    preview: Option<Preview>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a, Message: Clone + 'a> ColorField<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, rgb: [u8; 3], caption: impl Into<String>, on_press: Message) -> Self {
        ColorField { id, area, palette, rgb, paint: None, caption: caption.into(), centered: false, in_grid: false, disabled: false, on_press, preview: None, _marker: std::marker::PhantomData }
    }

    /// The swatch shows a gradient (a segment painted with one) instead of the colour.
    pub fn paint(mut self, paint: Option<SwatchPaint>) -> Self {
        self.paint = paint;
        self
    }

    /// The swatch and caption sit in the middle of the field (a paint picker that is a button in a grid cell).
    pub fn centered(mut self, centered: bool) -> Self {
        self.centered = centered;
        self
    }

    pub fn in_grid(mut self, in_grid: bool) -> Self {
        self.in_grid = in_grid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let ColorField { id, area, palette, rgb, paint, caption, centered, in_grid, disabled, on_press, preview, .. } = self;
        let gap = if in_grid { scale::SPACE_1 } else { scale::SPACE_2 };
        let ink: Rgba = if disabled { palette.text_1.faded(FIELD_DISABLED) } else { palette.text_1 };
        let hex = words(caption, TextStyle::from_role(&scale::TYPE_VALUE).tabular().tracking_em(0.01), ink);
        let opacity = if disabled { FIELD_DISABLED } else { 1.0 };
        let chip = match paint {
            Some(paint) => swatch_paint(palette, paint, SwatchSize::Sm, opacity),
            None => swatch(palette, rgb, SwatchSize::Sm, opacity),
        };
        let line = Row::with_children([chip, hex]).spacing(gap).align_y(Alignment::Center);
        let line: Element<'a, Message> = if centered { container(line).center_x(Length::Fill).boxed() } else { line.boxed() };
        let line = container(line).center_y(Length::Fill).boxed();
        let press = Surface::new(line, |_| Look::plain(0.0)).on_press_maybe((!disabled).then(|| on_press.clone())).width(Length::Fill).height(Length::Fill);
        let no_ring = Ring { color: Color::TRANSPARENT, width: 0.0, offset: 0.0, radius: 0.0 };
        let target = Focusable::new(id, area, press.boxed(), no_ring).input_role(InputRole::Other).keys(Keys::Button).on_activate(on_press).enabled(!disabled);
        // `.ui-field[data-color] > .ui-swatch { margin-inline-start: -2px }`: the swatch starts 2 px into the padding.
        let (left, right) = frame::padding(in_grid);
        FieldFrame::new(target.boxed(), palette, Length::Fill, frame::HEIGHT, Padding { top: 0.0, right, bottom: 0.0, left: left - scale::SPACE_0_5 }).disabled(disabled).preview(preview).boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paint(kind: GradientKind, angle: f32) -> SwatchPaint {
        SwatchPaint { kind, angle, stops: vec![SwatchStop { offset: 0.0, rgb: [255, 0, 0], opacity: 1.0 }, SwatchStop { offset: 1.0, rgb: [0, 0, 255], opacity: 0.0 }] }
    }

    #[test]
    fn stops_interpolate_premultiplied_and_hold_beyond_their_ends() {
        let paint = paint(GradientKind::Linear, 0.0);
        assert_eq!(paint.at(-1.0), [255.0, 0.0, 0.0, 1.0]);
        // Halfway to a transparent blue: the transparent stop adds no colour, as CSS premultiplies.
        assert_eq!(paint.at(0.5), [127.5, 0.0, 0.0, 0.5]);
        assert_eq!(paint.at(2.0), [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_linear_gradient_runs_the_way_css_angles_it() {
        // `linear-gradient(90deg)` (angle 0): left to right across the box.
        let across = paint(GradientKind::Linear, 0.0);
        assert!((across.position(-8.0, 0.0, 16.0) - 0.0).abs() < 1e-5 && (across.position(8.0, 0.0, 16.0) - 1.0).abs() < 1e-5);
        // `linear-gradient(180deg)` (angle 90): top to bottom.
        let down = paint(GradientKind::Linear, 90.0);
        assert!(down.position(0.0, -8.0, 16.0) < 1e-5 && (down.position(0.0, 8.0, 16.0) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn radial_and_angular_gradients_start_where_css_starts_them() {
        let radial = paint(GradientKind::Radial, 0.0);
        assert!(radial.position(0.0, 0.0, 16.0) < 1e-5);
        assert!((radial.position(8.0, 8.0, 16.0) - 1.0).abs() < 1e-4, "the farthest corner is the end");
        // `conic-gradient(from 90deg)` (angle 0): starts at the right and goes clockwise, so just below it is early.
        let angular = paint(GradientKind::Angular, 0.0);
        assert!(angular.position(8.0, 0.0, 16.0) < 1e-5 || angular.position(8.0, 0.0, 16.0) > 0.999);
        assert!((angular.position(0.0, 8.0, 16.0) - 0.25).abs() < 1e-4);
    }
}
