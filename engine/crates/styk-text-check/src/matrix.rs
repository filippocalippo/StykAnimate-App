//! The type matrix: every role, weight and script the interface sets, and the file format both renderers read.
//!
//! Rows sit on a fixed grid (`ROW_HEIGHT` logical pixels, `PAGE_ROWS` rows per page, `LEFT` pixels in) so the
//! native sheet and Chromium's lay over the same pixels. The file is tab-separated text: `#theme` lines with the
//! colours, then one row per item (id, family, weight, size, line height, tracking in thousandths of an em, features,
//! text).

use std::fmt::Write as _;
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::{Theme, TypeRole};

/// Height of a row, in logical pixels: the tallest line height the matrix sets is 32.
pub const ROW_HEIGHT: f32 = 40.0;
/// Rows on one page (one screenshot).
pub const PAGE_ROWS: usize = 22;
/// Width of a page, in logical pixels.
pub const PAGE_WIDTH: f32 = 960.0;
/// Where the text starts, in logical pixels.
pub const LEFT: f32 = 16.0;

/// Which of the two families a row is set in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    /// `--font-ui`: Inter first.
    Ui,
    /// `--font-display`: Inter Tight first.
    Display,
}

impl Family {
    fn name(self) -> &'static str {
        match self {
            Family::Ui => "ui",
            Family::Display => "display",
        }
    }
}

/// One line of text in one style.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// A stable name, used to pair the two renderers' results and in the report.
    pub id: String,
    pub family: Family,
    pub weight: u16,
    pub size: f32,
    pub line_height: f32,
    /// `letter-spacing` in thousandths of an em.
    pub tracking: i16,
    /// OpenType feature tags that are on (`tnum`, `cv11`, `ss01`).
    pub features: Vec<[u8; 4]>,
    pub text: String,
}

impl Item {
    /// The iced style that reproduces the row.
    pub fn style(&self) -> TextStyle {
        let role = TypeRole {
            weight: f32::from(self.weight),
            size: self.size,
            line_height: self.line_height,
            family: match self.family {
                Family::Ui => scale::FONT_UI,
                Family::Display => scale::FONT_DISPLAY,
            },
        };
        let style = TextStyle::from_role(&role);
        let mut style = if self.tracking == 0 { style } else { style.tracking_em(f32::from(self.tracking) / 1000.0) };
        style = style.features(features_static(&self.features));
        style
    }

    /// The row's class in the report: what decides how closely it must match.
    pub fn class(&self) -> &'static str {
        let first = self.text.chars().find(|c| !c.is_ascii_punctuation() && !c.is_whitespace() && !c.is_ascii_digit());
        match first {
            Some('\u{0600}'..='\u{06ff}') => "Arabic",
            Some('\u{0590}'..='\u{05ff}') => "Hebrew",
            Some('\u{3040}'..='\u{30ff}') | Some('\u{4e00}'..='\u{9fff}') => "CJK",
            _ => "Inter",
        }
    }
}

/// The feature sets the matrix requests, as the `'static` slices iced's `Font` holds. Only `tnum` has a native counterpart:
/// the brand features (`cv11`, `ss01`) are requested of Chromium as Settings requests them, but the font subsets the
/// web build ships have no such features (`cargo xtask fonts verify`), so the browser draws plain letters and the
/// native text, which asks for nothing, must match it.
fn features_static(tags: &[[u8; 4]]) -> &'static [([u8; 4], u32)] {
    if tags.contains(b"tnum") { styk_design::typography::TABULAR } else { &[] }
}

/// The matrix.
pub fn items() -> Vec<Item> {
    let mut items = Vec::new();
    let mut add = |id: String, family: Family, weight: u16, size: f32, line_height: f32, tracking: i16, features: &[&[u8; 4]], text: &str| {
        items.push(Item { id, family, weight, size, line_height, tracking, features: features.iter().map(|tag| **tag).collect(), text: text.to_string() });
    };

    // Every role of tokens.css with three strings: Latin with numerals, Cyrillic and Greek, Vietnamese and French.
    let roles: [(&str, Family, &TypeRole, f32); 16] = [
        ("micro", Family::Ui, &scale::TYPE_MICRO, 0.0),
        ("small", Family::Ui, &scale::TYPE_SMALL, 0.0),
        ("small-strong", Family::Ui, &scale::TYPE_SMALL_STRONG, 0.0),
        ("ui", Family::Ui, &scale::TYPE_UI, 0.0),
        ("ui-strong", Family::Ui, &scale::TYPE_UI_STRONG, 0.0),
        ("value", Family::Ui, &scale::TYPE_VALUE, 0.0),
        ("body", Family::Ui, &scale::TYPE_BODY, 0.0),
        ("emphasis", Family::Ui, &scale::TYPE_EMPHASIS, 0.0),
        ("numeral", Family::Display, &scale::TYPE_NUMERAL, 0.0),
        ("heading", Family::Display, &scale::TYPE_HEADING, scale::TRACKING_HEADING_EM),
        ("title", Family::Display, &scale::TYPE_TITLE, scale::TRACKING_TITLE_EM),
        ("display", Family::Display, &scale::TYPE_DISPLAY, scale::TRACKING_DISPLAY_EM),
        ("button", Family::Display, &scale::TYPE_BUTTON, 0.0),
        ("panel-title", Family::Display, &scale::TYPE_PANEL_TITLE, 0.0),
        ("section", Family::Display, &scale::TYPE_SECTION, 0.0),
        ("eyebrow", Family::Ui, &scale::TYPE_EYEBROW, 0.0),
    ];
    let strings = [("latin", "Position  Rotation 45.25°  Zoom 100%"), ("cyrillic-greek", "Привет мир  Γειά σου κόσμε"), ("vietnamese-french", "Tiếng Việt  Ça va très bien")];
    for (name, family, role, tracking) in roles {
        for (kind, text) in strings {
            add(format!("role/{name}/{kind}"), family, role.weight as u16, role.size, role.line_height, (tracking * 1000.0).round() as i16, &[], text);
        }
    }

    // Every weight the stylesheets use, in both families.
    for (family, label) in [(Family::Ui, "inter"), (Family::Display, "inter-tight")] {
        for weight in [400, 450, 500, 600, 650, 700, 760, 800] {
            add(format!("weight/{label}/{weight}"), family, weight, 13.0, 18.0, 0, &[], "Position Rotation  45.25° AVATAR To");
        }
    }

    // Sizes 11 to 24: the optical size follows from 14 up.
    for (family, label, weight) in [(Family::Ui, "inter", 500), (Family::Display, "inter-tight", 650)] {
        for size in [11.0, 12.0, 13.0, 14.0, 16.0, 18.0, 20.0, 22.0, 24.0] {
            add(format!("size/{label}/{size}"), family, weight, size, (size * 1.4).round(), 0, &[], "Position Rotation  45.25° AVATAR To");
        }
    }

    // Scripts Inter lacks: the fallback fonts.
    for (family, label) in [(Family::Ui, "ui"), (Family::Display, "display")] {
        for (script, text) in [("arabic", "مرحبا بالعالم 123"), ("hebrew", "שלום עולם 123"), ("japanese", "日本語のテキスト"), ("chinese", "简体中文")] {
            add(format!("fallback/{label}/{script}"), family, 500, 13.0, 18.0, 0, &[], text);
        }
    }

    // Numerals: tabular and the brand set.
    let digits = "0123456789  1111  0000  6 9 Data";
    add("numerals/default".into(), Family::Ui, 450, 13.0, 18.0, 0, &[], digits);
    add("numerals/tnum".into(), Family::Ui, 450, 13.0, 18.0, 0, &[b"tnum"], digits);
    add("numerals/brand".into(), Family::Ui, 450, 13.0, 18.0, 0, &[b"cv11", b"ss01"], digits);
    add("numerals/brand-tnum".into(), Family::Ui, 450, 13.0, 18.0, 0, &[b"cv11", b"ss01", b"tnum"], digits);
    add("numerals/tnum-12".into(), Family::Ui, 500, 12.0, 16.0, 0, &[b"tnum"], digits);

    // Tracking beyond the role-bound values.
    add("tracking/-0.005".into(), Family::Ui, 600, 12.0, 16.0, -5, &[], "Position Rotation");
    add("tracking/+0.01".into(), Family::Ui, 600, 12.0, 16.0, 10, &[], "Position Rotation");
    add("tracking/+0.04-caps".into(), Family::Ui, 600, 11.0, 14.0, 40, &[], "KIND TAG ROTATION");
    items
}

/// Writes the matrix file for both themes.
pub fn to_tsv(items: &[Item]) -> String {
    let mut out = String::new();
    for (name, theme) in [("light", Theme::Light), ("dark", Theme::Dark)] {
        let palette = theme.palette();
        let _ = writeln!(out, "#theme\t{name}\t{}\t{}", palette.surface_field.to_hex(), palette.text_1.to_hex());
    }
    for item in items {
        let features = if item.features.is_empty() { "-".to_string() } else { item.features.iter().map(|tag| String::from_utf8_lossy(tag).into_owned()).collect::<Vec<_>>().join(",") };
        let _ = writeln!(out, "{}\t{}\t{}\t{}\t{}\t{}\t{features}\t{}", item.id, item.family.name(), item.weight, item.size, item.line_height, item.tracking, item.text);
    }
    out
}

/// Reads the items back from the matrix file.
pub fn from_tsv(tsv: &str) -> Result<Vec<Item>, String> {
    tsv.lines().filter(|line| !line.is_empty() && !line.starts_with('#')).map(|line| {
        let cells: Vec<&str> = line.splitn(8, '\t').collect();
        if cells.len() != 8 {
            return Err(format!("not a matrix row: {line}"));
        }
        let number = |cell: &str| cell.parse::<f32>().map_err(|error| format!("{cell}: {error}"));
        Ok(Item {
            id: cells[0].to_string(),
            family: if cells[1] == "display" { Family::Display } else { Family::Ui },
            weight: number(cells[2])? as u16,
            size: number(cells[3])?,
            line_height: number(cells[4])?,
            tracking: number(cells[5])? as i16,
            features: if cells[6] == "-" { Vec::new() } else { cells[6].split(',').filter_map(|tag| <[u8; 4]>::try_from(tag.as_bytes()).ok()).collect() },
            text: cells[7].to_string(),
        })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_matrix_survives_its_file_format() {
        let items = items();
        assert!(items.len() >= 98, "{}", items.len());
        let tsv = to_tsv(&items);
        assert_eq!(from_tsv(&tsv).unwrap(), items);
        assert_eq!(tsv.lines().filter(|line| line.starts_with("#theme")).count(), 2);
    }

    #[test]
    fn every_weight_the_stylesheets_use_is_in_the_matrix() {
        let weights: std::collections::BTreeSet<u16> = items().iter().map(|item| item.weight).collect();
        for weight in [400, 450, 500, 600, 650, 700, 760, 800] {
            assert!(weights.contains(&weight), "{weight}");
        }
    }

    #[test]
    fn row_ids_are_unique() {
        let items = items();
        let ids: std::collections::BTreeSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids.len(), items.len());
    }

    #[test]
    fn a_row_fits_its_grid_row() {
        assert!(items().iter().all(|item| item.line_height <= ROW_HEIGHT), "the tallest line must fit a row");
    }
}
