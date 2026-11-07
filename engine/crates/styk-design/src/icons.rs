//! The interface's icons.
//!
//! The same set, and the same names, as `src/icons.mjs` (Lucide, with the app's adaptations): the shapes and the
//! aliases the JavaScript resolves. Every SVG draws in black at 18 px on a 24 unit grid; tint it when drawing.

use crate::icon_table::{ALIASES, SHAPES};

pub use crate::icon_table::NAMES;

/// The shape every unknown name falls back to, as in the JavaScript.
const FALLBACK: &str = "file";

/// The SVG for an icon name or alias. An unknown name gives the `file` icon, as `icon()` in the JavaScript does.
pub fn svg(name: &str) -> &'static [u8] {
    lookup(name).unwrap_or_else(|| lookup(FALLBACK).expect("the icon set has a `file` icon"))
}

/// The SVG for a name or alias, or nothing when the set has no such icon.
pub fn lookup(name: &str) -> Option<&'static [u8]> {
    let name = match ALIASES.binary_search_by_key(&name, |(alias, _)| alias) {
        Ok(found) => ALIASES[found].1,
        Err(_) => name,
    };
    SHAPES.binary_search_by_key(&name, |(shape, _)| shape).ok().map(|found| SHAPES[found].1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve_to_standalone_svg() {
        let play = std::str::from_utf8(svg("play")).unwrap();
        assert!(play.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""), "{play}");
        assert!(play.contains("viewBox=\"0 0 24 24\""));
        assert!(!play.contains("currentColor") && !play.contains("class="));
    }

    #[test]
    fn aliases_resolve_to_their_shape() {
        assert_eq!(lookup("x"), lookup("close"));
        assert_eq!(lookup("window-minimize"), lookup("minus"));
        assert!(lookup("close").is_some());
    }

    #[test]
    fn an_unknown_name_falls_back_to_the_file_icon() {
        assert_eq!(lookup("no-such-icon"), None);
        assert_eq!(svg("no-such-icon"), svg("file"));
    }

    #[test]
    fn the_tables_are_sorted_for_lookup() {
        assert!(SHAPES.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(ALIASES.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert_eq!(NAMES.len(), SHAPES.len());
        for name in NAMES {
            assert!(lookup(name).is_some());
        }
    }
}
