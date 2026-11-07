//! The screen catalogue: parts of the interface that can be shown on their own with `stykanimate --screen <id>`.
//!
//! A screen is how a part of the interface is looked at, tested and screenshotted without the rest of the application
//! (`docs/native/text-input.md` section 8). The catalogue grows with the interface.

use styk_core::documents::{DocumentId, Documents};
use styk_core::shell::band::Labels;
use styk_core::shell::session::Session;
use styk_core::shell::strip::TabState;
use styk_core::shell::workspace::{Report, Workspace};
use styk_core::shell::{Event, Shell, TabView, Window};
use styk_design::Theme;

/// A screen of the catalogue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    /// Every field role and every focusable control in its states, in both themes and directions.
    ComponentSheet,
    /// The top band at rest: three projects (the one in front has unsaved changes), light.
    Band,
    /// The same, dark.
    BandDark,
    /// The same, light, drawn at the width at which the band has folded (`--size`).
    BandFolded,
    /// The band while a figure is being built: Build is the workspace, Test rig and Done show, Export is quiet.
    BandBuild,
}

impl Screen {
    /// Every screen.
    pub const ALL: [Screen; 5] = [Screen::ComponentSheet, Screen::Band, Screen::BandDark, Screen::BandFolded, Screen::BandBuild];

    /// The ID the command line uses.
    pub const fn id(self) -> &'static str {
        match self {
            Screen::ComponentSheet => "component-sheet",
            Screen::Band => "band",
            Screen::BandDark => "band-dark",
            Screen::BandFolded => "band-folded",
            Screen::BandBuild => "band-build",
        }
    }

    /// The theme the screen is drawn in.
    pub const fn theme(self) -> Theme {
        match self {
            Screen::BandDark => Theme::Dark,
            _ => Theme::Light,
        }
    }

    /// Whether the screen is the top band over its window (the band screens need the shell's layout).
    pub const fn is_band(self) -> bool {
        !matches!(self, Screen::ComponentSheet)
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

/// The band of a band screen for a window of `size` logical pixels, with the projects it shows. `labels` are the band's words
/// as the font system measured them.
pub fn band_shell(screen: Screen, size: (u32, u32), labels: Labels) -> Shell {
    let window = Window { width: size.0 as f32, height: size.1 as f32, ui_scale: 1.0, controls: true };
    let mut shell = Shell::new(window, crate::shell::metrics(), labels);
    let names = ["Rooftop fight", "Chase", "Untitled animation"];
    let tabs = names
        .iter()
        .enumerate()
        .map(|(index, name)| TabView { id: DocumentId::preview(index as u64 + 1), name: (*name).to_string(), front: index == 1, state: (index == 1).then_some(TabState::Edited), dragging: false, drop: None })
        .collect();
    shell.preview(Some(tabs));
    if screen == Screen::BandBuild {
        let mut documents = Documents::new();
        // Build is entered and the band becomes its session, as the sessions will report.
        shell.handle(&mut documents, Event::Workspace(Workspace::Build));
        shell.handle(&mut documents, Event::Report(Report::BuildEntered));
        shell.handle(&mut documents, Event::Session(Session::Build));
    }
    shell
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
        assert_eq!(Screen::ids(), "component-sheet, band, band-dark, band-folded, band-build");
        assert!(Screen::BandDark.theme() == Theme::Dark && Screen::Band.theme() == Theme::Light);
        assert!(Screen::BandBuild.is_band() && !Screen::ComponentSheet.is_band());
    }
}
