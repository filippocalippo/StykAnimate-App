//! The bundled fonts: Inter (the interface) and Inter Tight (display and buttons), both under the SIL Open Font
//! License (`assets/fonts/OFL-Inter.txt`, `assets/fonts/OFL-InterTight.txt`).
//!
//! Each is one variable TrueType file covering every script the app ships subsets of (Latin, Latin Extended,
//! Cyrillic, Greek, Vietnamese), at exactly the version the app's WOFF2 subsets in `assets/fonts/` were cut from:
//! Inter 4.001 (git 66647c0bb, axes `opsz` and `wght`) and Inter Tight 3.004 (axis `wght`). `fonts/README.md` says
//! where they came from. The text stack (cosmic-text) reads TrueType, not WOFF2, which is why these exist.

/// Inter, variable: weights 100 to 900, optical size 14 to 32.
pub const INTER: &[u8] = include_bytes!("../fonts/Inter.ttf");

/// Inter Tight, variable: weights 100 to 900.
pub const INTER_TIGHT: &[u8] = include_bytes!("../fonts/InterTight.ttf");

/// The family name Inter registers under.
pub const INTER_FAMILY: &str = "Inter";

/// The family name Inter Tight registers under.
pub const INTER_TIGHT_FAMILY: &str = "Inter Tight";

/// Every bundled font file, for loading into a text system.
pub const ALL: [&[u8]; 2] = [INTER, INTER_TIGHT];

#[cfg(test)]
mod tests {
    use super::*;

    /// The names in a TrueType file's `name` table (Windows, Unicode), by name id.
    fn names(font: &[u8]) -> Vec<(u16, String)> {
        let u16_at = |at: usize| u16::from_be_bytes([font[at], font[at + 1]]) as usize;
        let u32_at = |at: usize| u32::from_be_bytes([font[at], font[at + 1], font[at + 2], font[at + 3]]) as usize;
        let table = (0..u16_at(4)).map(|i| 12 + 16 * i).find(|&at| &font[at..at + 4] == b"name").expect("a name table");
        let offset = u32_at(table + 8);
        let name = &font[offset..];
        let (count, storage) = (u16_at(offset + 2), u16_at(offset + 4));
        (0..count)
            .filter_map(|i| {
                let record = 6 + 12 * i;
                let at = |field: usize| u16::from_be_bytes([name[record + field], name[record + field + 1]]) as usize;
                (at(0) == 3).then(|| {
                    let units: Vec<u16> = name[storage + at(10)..storage + at(10) + at(8)].chunks(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
                    (at(6) as u16, String::from_utf16_lossy(&units))
                })
            })
            .collect()
    }

    fn tables(font: &[u8]) -> Vec<String> {
        let count = u16::from_be_bytes([font[4], font[5]]) as usize;
        (0..count).map(|i| String::from_utf8_lossy(&font[12 + 16 * i..16 + 16 * i]).into_owned()).collect()
    }

    fn name(font: &[u8], id: u16) -> String {
        names(font).into_iter().find(|(found, _)| *found == id).map(|(_, text)| text).unwrap_or_default()
    }

    #[test]
    fn the_families_and_versions_are_the_ones_the_app_ships() {
        assert_eq!(name(INTER, 1), INTER_FAMILY);
        assert_eq!(name(INTER, 5), "Version 4.001;git-66647c0bb");
        assert_eq!(name(INTER_TIGHT, 1), INTER_TIGHT_FAMILY);
        assert_eq!(name(INTER_TIGHT, 5), "Version 3.004");
    }

    #[test]
    fn both_are_variable_fonts() {
        for font in ALL {
            let tables = tables(font);
            assert!(tables.contains(&"fvar".to_string()) && tables.contains(&"gvar".to_string()), "{tables:?}");
        }
    }
}
