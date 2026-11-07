//! The screen catalogue: parts of the interface that can be shown on their own with `stykanimate --screen <id>`.
//!
//! A screen is how a part of the interface is looked at, tested and screenshotted without the rest of the application
//! (`docs/native/text-input.md` section 8). The catalogue grows with the interface.

/// A screen of the catalogue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    /// Every field role and every focusable control in its states, in both themes and directions.
    ComponentSheet,
}

impl Screen {
    /// Every screen.
    pub const ALL: [Screen; 1] = [Screen::ComponentSheet];

    /// The ID the command line uses.
    pub const fn id(self) -> &'static str {
        match self {
            Screen::ComponentSheet => "component-sheet",
        }
    }

    /// The screen with this ID.
    pub fn from_id(id: &str) -> Option<Screen> {
        Screen::ALL.into_iter().find(|screen| screen.id() == id)
    }

    /// The IDs, for an error message.
    pub fn ids() -> String {
        Screen::ALL.iter().map(|screen| screen.id()).collect::<Vec<_>>().join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_screen_is_found_by_its_id() {
        for screen in Screen::ALL {
            assert_eq!(Screen::from_id(screen.id()), Some(screen));
        }
        assert_eq!(Screen::from_id("nope"), None);
        assert_eq!(Screen::ids(), "component-sheet");
    }
}
