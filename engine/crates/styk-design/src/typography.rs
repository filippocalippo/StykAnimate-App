//! Type as the interface sets it: the roles of `tokens.css` as iced fonts, sizes and line heights.
//!
//! A [`TypeRole`] is what CSS sets with the `font` shorthand (`--type-ui`, `--type-heading`, ...). [`TextStyle`] adds
//! what the stylesheet sets beside it (`letter-spacing`, `font-feature-settings`, `font-variant-numeric`) and gives
//! the iced [`Font`], size and line height that reproduce the browser's text: the variable axes `wght` and `opsz`
//! (the optical size follows the text's size, as `font-optical-sizing: auto` does), tabular numerals, the tracking.
//! `font-feature-settings: "cv11", "ss01"` (Settings, the support dialog) is deliberately absent: the font subsets the
//! web build ships have lost those features, so the browser draws the plain letters and so does this. `docs/native/typography.md` is the contract.

use crate::fonts::{INTER_FAMILY, INTER_TIGHT_FAMILY};
use crate::tokens::scale;
use crate::TypeRole;
use iced::font::{Feature, OpticalSize, Weight};
use iced::widget::text::LineHeight;
use iced::{Font, Pixels};

/// `font-variant-numeric: tabular-nums`: every digit has the same advance, so a column of numbers aligns.
pub const TABULAR: &[Feature] = &[(*b"tnum", 1)];

/// A role's text: font, size and line height, with the tracking and features its rules add.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextStyle {
    /// The font: family, `wght`, optical size, features and tracking.
    pub font: Font,
    /// Size in logical pixels.
    pub size: f32,
    /// Line height in logical pixels.
    pub line_height: f32,
}

impl TextStyle {
    /// The style a role names. Inter follows the text's size for its optical size; Inter Tight has no such axis.
    pub fn from_role(role: &TypeRole) -> TextStyle {
        let display = role.family == scale::FONT_DISPLAY;
        let font = if display { Font::new(INTER_TIGHT_FAMILY) } else { Font::new(INTER_FAMILY).optical_size(OpticalSize::Auto) };
        TextStyle { font: font.weight(Weight::Value(role.weight.round() as u16)), size: role.size, line_height: role.line_height }
    }

    /// With `letter-spacing: <em>em` (rounded to a thousandth).
    pub fn tracking_em(mut self, em: f32) -> TextStyle {
        self.font = self.font.tracking((em * 1000.0).round() as i16);
        self
    }

    /// With the given OpenType features.
    pub const fn features(mut self, features: &'static [Feature]) -> TextStyle {
        self.font = self.font.features(features);
        self
    }

    /// With `font-variant-numeric: tabular-nums`.
    pub const fn tabular(self) -> TextStyle {
        self.features(TABULAR)
    }

    /// The size as iced's pixels.
    pub fn pixels(&self) -> Pixels {
        Pixels(self.size)
    }

    /// The line height as iced's.
    pub fn line(&self) -> LineHeight {
        LineHeight::Absolute(Pixels(self.line_height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts;
    use iced::advanced::graphics::text::{self as graphics_text, Paragraph};
    use iced::advanced::graphics::text::cosmic_text::{CacheKey, OpticalSize as CosmicOpticalSize, SwashCache};
    use iced::advanced::text::{Alignment, Ellipsis, Paragraph as _, Shaping, Text, Wrapping};
    use iced::{alignment, Size};

    /// Puts the bundled fonts in iced's global font system, as the application does at start.
    fn load_fonts() {
        crate::warm_up::install_bundled();
    }

    fn paragraph(content: &str, font: Font, size: f32) -> Paragraph {
        load_fonts();
        Paragraph::with_text(Text {
            content,
            bounds: Size::new(f32::INFINITY, f32::INFINITY),
            size: Pixels(size),
            line_height: LineHeight::Absolute(Pixels(size * 1.4)),
            font,
            align_x: Alignment::Default,
            align_y: alignment::Vertical::Top,
            shaping: Shaping::Advanced,
            wrapping: Wrapping::None,
            ellipsis: Ellipsis::None,
            hint_factor: None,
        })
    }

    fn width(content: &str, font: Font, size: f32) -> f32 {
        paragraph(content, font, size).min_width()
    }

    fn inter() -> Font {
        Font::new(fonts::INTER_FAMILY)
    }

    #[test]
    fn an_arbitrary_weight_is_the_variable_axis_not_the_nearest_named_stop() {
        let text = "Rotation 45.25° Zoom";
        let [w400, w450, w500, w650, w700] = [400, 450, 500, 650, 700].map(|weight| width(text, inter().weight(Weight::Value(weight)), 13.0));
        assert!(w400 < w450 && w450 < w500 && w500 < w650 && w650 < w700, "{w400} {w450} {w500} {w650} {w700}");
        // 500 is the named Medium stop: the value form and the named form are one font.
        assert_eq!(w500, width(text, inter().weight(Weight::Medium), 13.0));
    }

    #[test]
    fn the_optical_size_follows_the_text_size_and_is_clamped_to_the_axis() {
        let text = "Position Rotation";
        let auto = |size| width(text, inter().optical_size(OpticalSize::Auto), size);
        let plain = |size| width(text, inter(), size);
        // 11 to 14 px are below the axis (14): the default coordinate, the same font.
        for size in [11.0, 12.0, 13.0, 14.0] {
            assert_eq!(auto(size), plain(size), "{size}");
        }
        // Above it the glyphs and spacing change: Inter's display cut is tighter.
        for size in [16.0, 20.0, 24.0, 28.0] {
            assert!(auto(size) < plain(size), "{size}: {} against {}", auto(size), plain(size));
        }
    }

    #[test]
    fn one_string_drawn_at_two_sizes_at_once_keeps_each_optical_size() {
        // The same text at 14 and 28 px in one paragraph's cache lifetime: widths scale by 2 only if opsz were
        // ignored; with the axis followed, the 28 px text is narrower than twice the 14 px one.
        let font = inter().optical_size(OpticalSize::Auto);
        let small = width("Position Rotation", font, 14.0);
        let large = width("Position Rotation", font, 28.0);
        assert!(large < small * 2.0 - 0.5, "{small} {large}");
        assert_eq!(small, width("Position Rotation", font, 14.0));
    }

    #[test]
    fn the_glyph_cache_and_the_rasterizer_carry_the_optical_size() {
        let font = inter().weight(Weight::Value(450)).optical_size(OpticalSize::Auto);
        let small = paragraph("Rg", font, 28.0);
        let key = |paragraph: &Paragraph, opsz: Option<CosmicOpticalSize>| {
            let glyph = paragraph.buffer().layout_runs().next().expect("a run").glyphs[0].clone();
            let mut physical = glyph.physical((0.0, 0.0), 1.0).cache_key;
            if let Some(opsz) = opsz {
                physical.font_optical_size = opsz;
            }
            physical
        };
        let shaped: CacheKey = key(&small, None);
        // Shaped at 28 px, the glyph says so.
        assert_eq!(shaped.font_optical_size, CosmicOpticalSize::from_pixels(28.0));
        let other = key(&small, Some(CosmicOpticalSize::from_pixels(14.0)));
        assert_ne!(shaped, other, "the glyph cache must tell the optical sizes apart");
        // And the rasterizer draws the instance the key names, not the default one.
        let mut system = graphics_text::font_system().write().expect("the font system");
        let mut cache = SwashCache::new();
        let mut pixels = |key: CacheKey| cache.get_image_uncached(system.raw(), key).expect("an image").data;
        assert_ne!(pixels(shaped), pixels(other));
    }

    #[test]
    fn tabular_numerals_make_every_digit_the_same_width() {
        let digit = |features: &'static [Feature], digit: &str| width(digit, inter().weight(Weight::Value(450)).features(features), 13.0);
        let tabular: Vec<f32> = "0123456789".chars().map(|c| digit(TABULAR, &c.to_string())).collect();
        assert!(tabular.windows(2).all(|pair| pair[0] == pair[1]), "{tabular:?}");
        let proportional: Vec<f32> = "0123456789".chars().map(|c| digit(&[], &c.to_string())).collect();
        assert!(proportional.windows(2).any(|pair| pair[0] != pair[1]), "{proportional:?}");
    }


    #[test]
    #[cfg(windows)]
    fn scripts_inter_lacks_come_from_the_stylesheets_families_at_the_nearest_weight() {
        // The stylesheet lists Segoe UI after Inter and Segoe UI has no weight 500: the browser still uses it (its
        // Semibold), where the text stack alone chose Arial for Arabic and Hebrew.
        let paragraph = paragraph("مرحبا שלום", inter().weight(Weight::Value(500)), 13.0);
        let mut system = graphics_text::font_system().write().expect("the font system");
        let database = system.raw().db();
        let families: std::collections::BTreeSet<String> = paragraph
            .buffer()
            .layout_runs()
            .flat_map(|run| run.glyphs.iter().map(|glyph| database.face(glyph.font_id).map(|face| face.families[0].0.clone()).unwrap_or_default()).collect::<Vec<_>>())
            .collect();
        if database.faces().any(|face| face.families.iter().any(|(name, _)| name == "Segoe UI")) {
            assert!(families.contains("Segoe UI") && !families.contains("Arial"), "{families:?}");
        }
    }

    #[test]
    fn tracking_adds_its_share_of_an_em_after_every_glyph() {
        let font = Font::new(fonts::INTER_TIGHT_FAMILY).weight(Weight::Value(700));
        let text = "Export";
        let plain = width(text, font, 20.0);
        let tracked = width(text, font.tracking(-20), 20.0);
        let expected = plain - 6.0 * 0.02 * 20.0;
        assert!((tracked - expected).abs() < 0.01, "{tracked} against {expected}");
    }

    #[test]
    fn a_role_becomes_the_font_the_stylesheet_names() {
        let value = TextStyle::from_role(&scale::TYPE_VALUE);
        assert_eq!(value.font.family, iced::font::Family::Name("Inter"));
        assert_eq!(value.font.weight, Weight::Value(450));
        assert_eq!((value.size, value.line_height), (13.0, 18.0));
        assert_eq!(value.font.optical_size, OpticalSize::Auto);
        let display = TextStyle::from_role(&scale::TYPE_DISPLAY).tracking_em(scale::TRACKING_DISPLAY_EM);
        assert_eq!(display.font.family, iced::font::Family::Name("Inter Tight"));
        assert_eq!(display.font.weight, Weight::Value(760));
        assert_eq!(display.font.tracking, -30);
        assert_eq!(display.font.optical_size, OpticalSize::Default);
        assert_eq!(TextStyle::from_role(&scale::TYPE_UI).tabular().font.features, TABULAR);
    }
}
