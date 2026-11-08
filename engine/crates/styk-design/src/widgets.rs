#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types))]
//! The iced side of the design system: conversions, font handles and the icon widget.
//!
//! iced is built with its `web-colors` feature in this workspace, so a token passed through here blends in sRGB space
//! exactly as the browser does with the same CSS value.

use crate::{Rgba, fonts, icons};
use iced::widget::svg;
use iced::{Color, Font, Length, font};

impl From<Rgba> for Color {
    fn from(color: Rgba) -> Color {
        Color { r: f32::from(color.r) / 255.0, g: f32::from(color.g) / 255.0, b: f32::from(color.b) / 255.0, a: color.a }
    }
}

/// Inter at the regular weight. Other weights: `INTER.weight(..)`; the variable axis serves 100 to 900.
pub const INTER: Font = Font::new(fonts::INTER_FAMILY);

/// Inter Tight at the regular weight.
pub const INTER_TIGHT: Font = Font::new(fonts::INTER_TIGHT_FAMILY);

/// The weights the interface uses (`--weight-*`).
pub mod weight {
    use super::font::Weight;

    /// `--weight-regular` (400).
    pub const REGULAR: Weight = Weight::Normal;
    /// `--weight-medium` (500).
    pub const MEDIUM: Weight = Weight::Medium;
    /// `--weight-semibold` (600).
    pub const SEMIBOLD: Weight = Weight::Semibold;
    /// `--weight-bold` (700).
    pub const BOLD: Weight = Weight::Bold;
}

/// An icon by the name the JavaScript uses, `size` logical pixels square, drawn in `color`.
pub fn icon<'a>(name: &str, size: f32, color: impl Into<Color>) -> svg::Svg<'a> {
    let handle = svg::Handle::from_memory(icons::svg(name));
    let color = color.into();
    svg(handle).width(Length::Fixed(size)).height(Length::Fixed(size)).style(move |_, _| svg::Style { color: Some(color) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::primitives::BLUE_500;

    #[test]
    fn a_token_becomes_the_same_colour_the_css_names() {
        let color: Color = BLUE_500.into();
        assert_eq!(color.into_rgba8(), [0x0d, 0x99, 0xff, 255]);
        let translucent: Color = Rgba::new(12, 13, 18, 0.36).into();
        assert_eq!(translucent.a, 0.36);
    }
}

pub mod badge;
pub mod button;
pub mod color;
pub mod control;
pub mod dir;
pub mod field;
pub mod focus;
pub mod frame;
pub mod number_field;
pub mod roving;
pub mod segmented;
pub mod select;
pub mod slider;
pub mod surface;
pub mod toggle;
#[cfg(feature = "testing")]
#[path = "../tests/support/testing.rs"]
pub mod testing;
#[cfg(all(test, feature = "testing"))]
mod page_tests;

pub use dir::Dir;
