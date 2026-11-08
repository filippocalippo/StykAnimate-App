//! Swatches and the colour field (`swatch.css`, `field.css`): a colour shown, and a field that opens the paint picker.
//!
//! The field reports a press; the picker is the owner's. Its role is [`InputRole::Other`], declared here: a native colour
//! input is an input to the shortcut routing.

use iced::Widget as _;
use super::control::{FIELD_DISABLED, Preview, words};
use super::focus::{Focusable, Keys, Ring};
use super::frame::{self, FieldFrame};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::widget::{Row, Space, container};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding};
use styk_core::focus::{FocusArea, FocusId, InputRole};

/// A swatch's sizes (`data-size`): 16, 20 (the default), 24 (in a grid) and 28 px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SwatchSize {
    Sm,
    #[default]
    Md,
    Grid,
    Lg,
}

impl SwatchSize {
    pub fn side(self) -> f32 {
        match self {
            SwatchSize::Sm => 16.0,
            SwatchSize::Md => 20.0,
            SwatchSize::Grid => 24.0,
            SwatchSize::Lg => 28.0,
        }
    }

    fn radius(self) -> f32 {
        match self {
            SwatchSize::Sm => scale::RADIUS_2XS,
            SwatchSize::Md | SwatchSize::Grid => scale::RADIUS_SM,
            SwatchSize::Lg => scale::RADIUS_MD,
        }
    }
}

/// A colour in a rounded square with its hairline (`--swatch-ring`).
pub fn swatch<'a, Message: 'a>(palette: &'static Palette, rgb: [u8; 3], size: SwatchSize) -> Element<'a, Message> {
    let side = size.side();
    let ring = palette.swatch_ring;
    container(Space::new().width(side).height(side))
        .style(move |_| container::Style {
            background: Some(Background::Color(Color::from_rgb8(rgb[0], rgb[1], rgb[2]))),
            border: Border { color: ring.into(), width: 1.0, radius: size.radius().into() },
            ..container::Style::default()
        })
        .boxed()
}

/// The colour field: a 16 px swatch drawn 2 px into the padding and the hex (or a caption), in the field box.
pub struct ColorField<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    rgb: [u8; 3],
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
        ColorField { id, area, palette, rgb, caption: caption.into(), centered: false, in_grid: false, disabled: false, on_press, preview: None, _marker: std::marker::PhantomData }
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
        let ColorField { id, area, palette, rgb, caption, centered, in_grid, disabled, on_press, preview, .. } = self;
        let gap = if in_grid { scale::SPACE_1 } else { scale::SPACE_2 };
        let ink: Rgba = if disabled { palette.text_1.faded(FIELD_DISABLED) } else { palette.text_1 };
        let hex = words(caption, TextStyle::from_role(&scale::TYPE_VALUE).tabular().tracking_em(0.01), ink);
        let line = Row::with_children([swatch(palette, rgb, SwatchSize::Sm), hex]).spacing(gap).align_y(Alignment::Center);
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
