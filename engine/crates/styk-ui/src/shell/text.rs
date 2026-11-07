//! The band's words, each at its single site.
//!
//! English literals until the localisation chunk: when the reference slice merges `styk_core::i18n::Label`, the band
//! moves to labels and this module is what changes (nothing else in the band holds a word).

// TODO(i18n): each constant below becomes a `styk_core::i18n::Label` (today's `chrome.*`, `projectTabs.*` and `app.*` keys).

/// The workspace names (`chrome.animate`, `chrome.draw`, `chrome.build`).
pub(crate) const ANIMATE: &str = "Animate";
pub(crate) const DRAW: &str = "Draw";
pub(crate) const BUILD: &str = "Build";
/// The buttons (`chrome.export`, `chrome.cancel`, `chrome.testRig`, `chrome.done`).
pub(crate) const EXPORT: &str = "Export";
pub(crate) const CANCEL: &str = "Cancel";
pub(crate) const TEST_RIG: &str = "Test rig";
pub(crate) const DONE: &str = "Done";
/// A card's state on the Ctrl+Tab board (`app.edited`, `app.saved`).
pub(crate) const EDITED: &str = "Edited";
pub(crate) const SAVED: &str = "Saved";
/// The board's hint (`projectTabs.switcherHint`).
pub(crate) const SWITCHER_HINT: &str = "Tab moves to the next project. Release to switch, Esc to stay.";
/// The StykAnimate menu's leading rows: the six application menus (`chrome.file` and the others).
pub(crate) const APPLICATION_MENUS: [&str; 6] = ["File", "Edit", "View", "Joint", "Animation", "Help"];
/// A project tab's menu: the one in front, and a resting one (`projectMenuItems` in `src/app.mjs`).
pub(crate) const TAB_MENU_FRONT: [&str; 5] = ["Save", "Save as…", "Rename", "Close project", "Close saved projects"];
pub(crate) const TAB_MENU_RESTING: [&str; 2] = ["Switch to this project", "Close project"];
