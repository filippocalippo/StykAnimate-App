//! The band's words, each at its single site, as catalogue labels (`styk_core::i18n::Label`) keyed as today's app keys them
//! (`chrome.*`, `projectTabs.*`, `app.*`, `common.*`, `commands.*`). A view formats them through the window's
//! `Presentation`; the band's measurement (`measure_labels`) formats the same labels, so the folds stay exact in every language.

use styk_core::i18n::{Label, Msg};

const fn key(key: &'static str) -> Label {
    Label::Msg(Msg::new(key))
}

/// The workspace names (`chrome.animate`, `chrome.draw`, `chrome.build`).
pub(crate) const ANIMATE: Label = key("chrome.animate");
pub(crate) const DRAW: Label = key("chrome.draw");
pub(crate) const BUILD: Label = key("chrome.build");
/// The buttons (`chrome.export`, `chrome.cancel`, `chrome.testRig`, `chrome.done`).
pub(crate) const EXPORT: Label = key("chrome.export");
pub(crate) const CANCEL: Label = key("chrome.cancel");
pub(crate) const TEST_RIG: Label = key("chrome.testRig");
pub(crate) const DONE: Label = key("chrome.done");
/// A card's state on the Ctrl+Tab board (`app.edited`, `app.saved`).
pub(crate) const EDITED: Label = key("app.edited");
pub(crate) const SAVED: Label = key("app.saved");
/// The board's hint (`projectTabs.switcherHint`).
pub(crate) const SWITCHER_HINT: Label = key("projectTabs.switcherHint");
/// The StykAnimate menu's leading rows: the six application menus (`chrome.file` and the others).
pub(crate) const APPLICATION_MENUS: [Label; 6] = [key("chrome.file"), key("chrome.edit"), key("chrome.view"), key("chrome.joint"), key("chrome.animation"), key("chrome.help")];
/// A project tab's menu: the one in front, and a resting one (`projectMenuItems` in `src/app.mjs`).
pub(crate) const TAB_MENU_FRONT: [Label; 5] = [key("common.save"), key("common.saveAs"), key("commands.rename"), key("commands.closeProject"), key("commands.closeSavedProjects")];
pub(crate) const TAB_MENU_RESTING: [Label; 2] = [key("projectTabs.switchToThisProject"), key("commands.closeProject")];

#[cfg(test)]
mod tests {
    use super::*;

    /// Every word of the band is in the catalogue, and English reads as the literals the band used to hold.
    #[test]
    fn every_key_is_in_the_catalogue_and_reads_as_before() {
        let english = styk_core::i18n::Presentation::english();
        let words = [
            (ANIMATE, "Animate"), (DRAW, "Draw"), (BUILD, "Build"), (EXPORT, "Export"), (CANCEL, "Cancel"), (TEST_RIG, "Test rig"), (DONE, "Done"),
            (EDITED, "Edited"), (SAVED, "Saved"), (SWITCHER_HINT, "Tab moves to the next project. Release to switch, Esc to stay."),
        ];
        for (label, expected) in words {
            assert_eq!(english.label(&label), expected);
        }
        let menus: Vec<String> = APPLICATION_MENUS.iter().map(|label| english.label(label)).collect();
        assert_eq!(menus, ["File", "Edit", "View", "Joint", "Animation", "Help"]);
        let front: Vec<String> = TAB_MENU_FRONT.iter().map(|label| english.label(label)).collect();
        assert_eq!(front, ["Save", "Save as\u{2026}", "Rename project\u{2026}", "Close project", "Close saved projects"]);
        let resting: Vec<String> = TAB_MENU_RESTING.iter().map(|label| english.label(label)).collect();
        assert_eq!(resting, ["Switch to this project", "Close project"]);
    }
}
