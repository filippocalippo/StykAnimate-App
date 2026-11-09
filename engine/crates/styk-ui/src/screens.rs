//! The screen catalogue: parts of the interface that can be shown on their own with `stykanimate --screen <id>`.
//!
//! A screen is how a part of the interface is looked at, tested and screenshotted without the rest of the application
//! (`docs/native/text-input.md` section 8). The catalogue grows with the interface.

use styk_core::identity::DocumentId;
use styk_core::shell::band::Labels;
use styk_core::shell::session::Session;
use styk_core::shell::strip::TabState;
use styk_core::shell::workspace::{Report, Workspace};
use styk_core::shell::{Shell, TabView, Window};
use styk_core::screens::InspectorScreen;
use styk_design::Theme;
use styk_core::menus::AppMenu;
use crate::overlay_sheet::OverlayScreen;
use crate::recovery_sheet::RecoveryScreen;

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
    /// The design system's controls in every state (`styk_ui::controls_sheet`); dark when `true`.
    Controls(bool),
    /// An overlay or panel-parts screen (`crate::overlay_sheet`); dark when `true`.
    Overlay(OverlayScreen, bool),
    /// A recovery screen (`crate::recovery_sheet`): the offer, the chooser, the close prompt; dark when `true`.
    Recovery(RecoveryScreen, bool),
    /// The Properties panel in a context (`styk_core::screens`), docked at today's default size; dark when `true`.
    Inspector(InspectorScreen, bool),
    /// The stage: a repository fixture fitted into the stage region at tick 0; dark when `true`.
    Stage(bool),
    /// The main window: the band over the docked default layout in a window of this size (`styk_core::dock`); dark when `true`.
    Dock(DockScreen, bool),
}

/// The sizes the docked window is a screen at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DockScreen {
    /// 1560 x 1000.
    Wide,
    /// 1440 x 900.
    Regular,
    /// 720 x 800: the right dock folded to a sheet.
    Folded,
}

impl Screen {
    /// Every screen.
    pub const ALL: [Screen; 77] = [
        Screen::ComponentSheet,
        Screen::Band,
        Screen::BandDark,
        Screen::BandFolded,
        Screen::BandBuild,
        Screen::Inspector(InspectorScreen::Scene, false),
        Screen::Inspector(InspectorScreen::Scene, true),
        Screen::Inspector(InspectorScreen::Figure, false),
        Screen::Inspector(InspectorScreen::Figure, true),
        Screen::Inspector(InspectorScreen::Joint, false),
        Screen::Inspector(InspectorScreen::Joint, true),
        Screen::Inspector(InspectorScreen::Figures, false),
        Screen::Inspector(InspectorScreen::Figures, true),
        Screen::Inspector(InspectorScreen::Text, false),
        Screen::Inspector(InspectorScreen::Text, true),
        Screen::Inspector(InspectorScreen::Image, false),
        Screen::Inspector(InspectorScreen::Image, true),
        Screen::Inspector(InspectorScreen::Camera, false),
        Screen::Inspector(InspectorScreen::Camera, true),
        Screen::Inspector(InspectorScreen::Layer, false),
        Screen::Inspector(InspectorScreen::Layer, true),
        Screen::Inspector(InspectorScreen::Frame, false),
        Screen::Inspector(InspectorScreen::Frame, true),
        Screen::Inspector(InspectorScreen::JointGradient, false),
        Screen::Inspector(InspectorScreen::JointGradient, true),
        Screen::Inspector(InspectorScreen::Colours, false),
        Screen::Inspector(InspectorScreen::Colours, true),
        Screen::Stage(false),
        Screen::Stage(true),
        Screen::Controls(false),
        Screen::Controls(true),
        Screen::Overlay(OverlayScreen::MenuRoot, false),
        Screen::Overlay(OverlayScreen::MenuRoot, true),
        Screen::Overlay(OverlayScreen::MenuSubmenu, false),
        Screen::Overlay(OverlayScreen::MenuSubmenu, true),
        Screen::Overlay(OverlayScreen::MenuContext, false),
        Screen::Overlay(OverlayScreen::MenuContext, true),
        Screen::Overlay(OverlayScreen::SelectOpen, false),
        Screen::Overlay(OverlayScreen::SelectOpen, true),
        Screen::Overlay(OverlayScreen::Tooltip, false),
        Screen::Overlay(OverlayScreen::Tooltip, true),
        Screen::Overlay(OverlayScreen::Toasts, false),
        Screen::Overlay(OverlayScreen::Toasts, true),
        Screen::Overlay(OverlayScreen::Dialog, false),
        Screen::Overlay(OverlayScreen::Dialog, true),
        Screen::Overlay(OverlayScreen::Parts, false),
        Screen::Overlay(OverlayScreen::Parts, true),
        Screen::Overlay(OverlayScreen::AppMenu(None), false),
        Screen::Overlay(OverlayScreen::AppMenu(None), true),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::File)), false),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::File)), true),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Edit)), false),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Edit)), true),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::View)), false),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::View)), true),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Joint)), false),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Joint)), true),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Animation)), false),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Animation)), true),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Help)), false),
        Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Help)), true),
        Screen::Recovery(RecoveryScreen::Offer, false),
        Screen::Recovery(RecoveryScreen::Offer, true),
        Screen::Recovery(RecoveryScreen::Chooser, false),
        Screen::Recovery(RecoveryScreen::Chooser, true),
        Screen::Recovery(RecoveryScreen::Busy, false),
        Screen::Recovery(RecoveryScreen::Busy, true),
        Screen::Recovery(RecoveryScreen::Error, false),
        Screen::Recovery(RecoveryScreen::Error, true),
        Screen::Recovery(RecoveryScreen::ClosePrompt, false),
        Screen::Recovery(RecoveryScreen::ClosePrompt, true),
        Screen::Dock(DockScreen::Wide, false),
        Screen::Dock(DockScreen::Wide, true),
        Screen::Dock(DockScreen::Regular, false),
        Screen::Dock(DockScreen::Regular, true),
        Screen::Dock(DockScreen::Folded, false),
        Screen::Dock(DockScreen::Folded, true),
    ];

    /// The ID the command line uses.
    pub const fn id(self) -> &'static str {
        match self {
            Screen::ComponentSheet => "component-sheet",
            Screen::Band => "band",
            Screen::BandDark => "band-dark",
            Screen::BandFolded => "band-folded",
            Screen::BandBuild => "band-build",
            Screen::Controls(false) => "controls",
            Screen::Controls(true) => "controls-dark",
            Screen::Overlay(OverlayScreen::MenuRoot, false) => "menu-root",
            Screen::Overlay(OverlayScreen::MenuRoot, true) => "menu-root-dark",
            Screen::Overlay(OverlayScreen::MenuSubmenu, false) => "menu-submenu",
            Screen::Overlay(OverlayScreen::MenuSubmenu, true) => "menu-submenu-dark",
            Screen::Overlay(OverlayScreen::MenuContext, false) => "menu-context",
            Screen::Overlay(OverlayScreen::MenuContext, true) => "menu-context-dark",
            Screen::Overlay(OverlayScreen::SelectOpen, false) => "select-open",
            Screen::Overlay(OverlayScreen::SelectOpen, true) => "select-open-dark",
            Screen::Overlay(OverlayScreen::Tooltip, false) => "tooltip",
            Screen::Overlay(OverlayScreen::Tooltip, true) => "tooltip-dark",
            Screen::Overlay(OverlayScreen::Toasts, false) => "toasts",
            Screen::Overlay(OverlayScreen::Toasts, true) => "toasts-dark",
            Screen::Overlay(OverlayScreen::Dialog, false) => "dialog",
            Screen::Overlay(OverlayScreen::Dialog, true) => "dialog-dark",
            Screen::Overlay(OverlayScreen::Parts, false) => "parts",
            Screen::Overlay(OverlayScreen::Parts, true) => "parts-dark",
            Screen::Overlay(OverlayScreen::AppMenu(None), false) => "app-menu",
            Screen::Overlay(OverlayScreen::AppMenu(None), true) => "app-menu-dark",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::File)), false) => "app-menu-file",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::File)), true) => "app-menu-file-dark",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Edit)), false) => "app-menu-edit",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Edit)), true) => "app-menu-edit-dark",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::View)), false) => "app-menu-view",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::View)), true) => "app-menu-view-dark",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Joint)), false) => "app-menu-joint",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Joint)), true) => "app-menu-joint-dark",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Animation)), false) => "app-menu-animation",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Animation)), true) => "app-menu-animation-dark",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Help)), false) => "app-menu-help",
            Screen::Overlay(OverlayScreen::AppMenu(Some(AppMenu::Help)), true) => "app-menu-help-dark",
            Screen::Recovery(RecoveryScreen::Offer, false) => "recovery-offer",
            Screen::Recovery(RecoveryScreen::Offer, true) => "recovery-offer-dark",
            Screen::Recovery(RecoveryScreen::Chooser, false) => "recovery-chooser",
            Screen::Recovery(RecoveryScreen::Chooser, true) => "recovery-chooser-dark",
            Screen::Recovery(RecoveryScreen::Busy, false) => "recovery-busy",
            Screen::Recovery(RecoveryScreen::Busy, true) => "recovery-busy-dark",
            Screen::Recovery(RecoveryScreen::Error, false) => "recovery-error",
            Screen::Recovery(RecoveryScreen::Error, true) => "recovery-error-dark",
            Screen::Recovery(RecoveryScreen::ClosePrompt, false) => "close-prompt",
            Screen::Recovery(RecoveryScreen::ClosePrompt, true) => "close-prompt-dark",
            Screen::Inspector(InspectorScreen::Scene, false) => "inspector-scene",
            Screen::Inspector(InspectorScreen::Scene, true) => "inspector-scene-dark",
            Screen::Inspector(InspectorScreen::Figure, false) => "inspector-figure",
            Screen::Inspector(InspectorScreen::Figure, true) => "inspector-figure-dark",
            Screen::Inspector(InspectorScreen::Joint, false) => "inspector-joint",
            Screen::Inspector(InspectorScreen::Joint, true) => "inspector-joint-dark",
            Screen::Inspector(InspectorScreen::Figures, false) => "inspector-figures",
            Screen::Inspector(InspectorScreen::Figures, true) => "inspector-figures-dark",
            Screen::Inspector(InspectorScreen::Text, false) => "inspector-text",
            Screen::Inspector(InspectorScreen::Text, true) => "inspector-text-dark",
            Screen::Inspector(InspectorScreen::Image, false) => "inspector-image",
            Screen::Inspector(InspectorScreen::Image, true) => "inspector-image-dark",
            Screen::Inspector(InspectorScreen::Camera, false) => "inspector-camera",
            Screen::Inspector(InspectorScreen::Camera, true) => "inspector-camera-dark",
            Screen::Inspector(InspectorScreen::Layer, false) => "inspector-layer",
            Screen::Inspector(InspectorScreen::Layer, true) => "inspector-layer-dark",
            Screen::Inspector(InspectorScreen::Frame, false) => "inspector-frame",
            Screen::Inspector(InspectorScreen::Frame, true) => "inspector-frame-dark",
            Screen::Inspector(InspectorScreen::JointGradient, false) => "inspector-joint-gradient",
            Screen::Inspector(InspectorScreen::JointGradient, true) => "inspector-joint-gradient-dark",
            Screen::Inspector(InspectorScreen::Colours, false) => "inspector-colours",
            Screen::Inspector(InspectorScreen::Colours, true) => "inspector-colours-dark",
            Screen::Stage(false) => "stage-fit",
            Screen::Stage(true) => "stage-fit-dark",
            Screen::Dock(DockScreen::Wide, false) => "dock",
            Screen::Dock(DockScreen::Wide, true) => "dock-dark",
            Screen::Dock(DockScreen::Regular, false) => "dock-1440",
            Screen::Dock(DockScreen::Regular, true) => "dock-1440-dark",
            Screen::Dock(DockScreen::Folded, false) => "dock-folded",
            Screen::Dock(DockScreen::Folded, true) => "dock-folded-dark",
        }
    }

    /// Why the engine-free preview (`styk-screens`) does not draw this screen, for the screens that show a frame the engine
    /// makes: only the app does (`None`: the preview draws it, and `cargo xtask check` compares both captures).
    pub const fn app_only(self) -> Option<&'static str> {
        match self {
            Screen::Stage(_) => Some("a stage screen shows a frame the engine draws, and the preview is built without the engine"),
            _ => None,
        }
    }

    /// The theme the screen is drawn in.
    pub const fn theme(self) -> Theme {
        match self {
            Screen::BandDark | Screen::Controls(true) | Screen::Inspector(_, true) | Screen::Stage(true) | Screen::Overlay(_, true) | Screen::Recovery(_, true) | Screen::Dock(_, true) => Theme::Dark,
            _ => Theme::Light,
        }
    }

    /// Whether the screen is the top band over its window (the band screens need the shell's layout).
    pub const fn is_band(self) -> bool {
        !matches!(self, Screen::ComponentSheet | Screen::Controls(_) | Screen::Overlay(..) | Screen::Recovery(..) | Screen::Dock(..) | Screen::Inspector(..) | Screen::Stage(..))
    }

    /// Whether the screen is the main window: the band over the docked layout.
    pub const fn is_dock(self) -> bool {
        matches!(self, Screen::Dock(..))
    }

    /// Whether the screen shows the window's band (a band screen, or the docked window).
    pub const fn has_band(self) -> bool {
        self.is_band() || self.is_dock()
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
    // The window's screens show the one project today's window opens with; the band's own screens show three.
    let (names, front, edited): (&[&str], usize, bool) = if screen.is_dock() { (&["Untitled animation"], 0, false) } else { (&["Rooftop fight", "Chase", "Untitled animation"], 1, true) };
    let tabs = names
        .iter()
        .enumerate()
        .map(|(index, name)| TabView { id: DocumentId::preview(index as u64 + 1), name: (*name).to_string(), front: index == front, state: (index == front && edited).then_some(TabState::Edited), dragging: false, drop: None })
        .collect();
    shell.preview(Some(tabs));
    if screen == Screen::BandBuild {
        // Build is entered and the band becomes its session, as the sessions will report.
        shell.workspaces.choose(Workspace::Build);
        shell.workspaces.report(Report::BuildEntered);
        shell.preview_session(Session::Build);
    }
    shell
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_fixture_matches_document_shell_events() {
        let labels = Labels { animate: 52.0, draw: 32.0, build: 31.0, export: 38.0, cancel: 40.0, test_rig: 43.0, done: 31.0 };
        let fixture = band_shell(Screen::BandBuild, (1000, 900), labels);
        let mut original = band_shell(Screen::Band, (1000, 900), labels);
        let mut documents = styk_core::documents::Documents::new();
        use styk_core::shell::Event;
        original.handle(&mut documents, Event::Workspace(Workspace::Build));
        original.handle(&mut documents, Event::Report(Report::BuildEntered));
        original.handle(&mut documents, Event::Session(Session::Build));
        assert_eq!(fixture.tabs(), original.tabs());
        assert_eq!(fixture.session(), original.session());
        assert_eq!(fixture.pressed(), original.pressed());
        assert_eq!(fixture.history(), original.history());
        assert_eq!(fixture.layout(), original.layout());
    }

    #[test]
    fn every_screen_is_found_by_its_id() {
        for screen in Screen::ALL {
            assert_eq!(Screen::from_id(screen.id()), Some(screen));
        }
        assert_eq!(Screen::from_id("nope"), None);
        assert!(Screen::ids().starts_with("component-sheet, band, band-dark, band-folded, band-build, inspector-scene, inspector-scene-dark"));
        assert_eq!(Screen::from_id("inspector-text-dark"), Some(Screen::Inspector(InspectorScreen::Text, true)));
        assert!(Screen::Inspector(InspectorScreen::Camera, true).theme() == Theme::Dark && !Screen::Inspector(InspectorScreen::Camera, false).is_band());
        assert!(Screen::BandDark.theme() == Theme::Dark && Screen::Band.theme() == Theme::Light);
        assert!(Screen::BandBuild.is_band() && !Screen::ComponentSheet.is_band());
    }
}

/// Prepared by the real Core (the app's prepare_inspector example), never hand-written.
pub fn inspector_model(context: InspectorScreen) -> styk_core::inspector::model::Inspector {
    match context {
        InspectorScreen::Scene => include!("screens/models/scene.rs"),
        InspectorScreen::Figure => include!("screens/models/figure.rs"),
        InspectorScreen::Joint => include!("screens/models/joint.rs"),
        InspectorScreen::Figures => include!("screens/models/figures.rs"),
        InspectorScreen::Text => include!("screens/models/text.rs"),
        InspectorScreen::Image => include!("screens/models/image.rs"),
        InspectorScreen::Camera => include!("screens/models/camera.rs"),
        InspectorScreen::Layer => include!("screens/models/layer.rs"),
        InspectorScreen::Frame => include!("screens/models/frame.rs"),
        InspectorScreen::JointGradient => include!("screens/models/joint-gradient.rs"),
        InspectorScreen::Colours => include!("screens/models/colours.rs"),
    }
}

impl DockScreen {
    /// The window size the screen is at, in logical pixels.
    pub const fn size(self) -> (u32, u32) {
        match self {
            DockScreen::Wide => (1560, 1000),
            DockScreen::Regular => (1440, 900),
            DockScreen::Folded => (720, 800),
        }
    }
}
