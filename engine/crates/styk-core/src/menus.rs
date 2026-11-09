//! The application menus: the mark's StykAnimate menu and the menus it leads with (SH-057 to SH-065).
//!
//! What a menu holds and in which order is today's `src/application-menu.mjs` (`applicationMenuItems`) and the mark's
//! `showMenu` in `src/app.mjs`, row for row: the registry command a row runs, its glyph, its catalogue label, and when it is
//! disabled. Everything else a row shows comes from the one registry at display time (`overlay::menu::Item::shortcuts` reads
//! the user's first binding, `Info::danger` colours a delete). Nothing here runs a command: a row carries its `CommandId`
//! and the overlay host reports it to `Core::dispatch`, which answers `Effect::NotAvailable` for a feature not ported yet.
//!
//! [`Facts`] is the small state the rows depend on, read by the core from its owners (`Core::menu_facts`) and handed in, so the
//! rows are a pure function of it and the language.

use crate::commands::CommandId as C;
use crate::i18n::{Label, Presentation};
use crate::identity::DocumentId;
use crate::overlay::menu::{Entry, Item, RowAction};

/// The application menus, in the order the mark lists them (`data-app-menu`: `file`, `edit`, `view`, `editor`, `animation`, `help`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppMenu {
    File,
    Edit,
    View,
    /// The Joint menu (`editor`): the selected joint's segment and branch.
    Joint,
    Animation,
    Help,
}

impl AppMenu {
    pub const ALL: [AppMenu; 6] = [AppMenu::File, AppMenu::Edit, AppMenu::View, AppMenu::Joint, AppMenu::Animation, AppMenu::Help];

    /// Today's `data-app-menu` value.
    pub const fn id(self) -> &'static str {
        match self {
            AppMenu::File => "file",
            AppMenu::Edit => "edit",
            AppMenu::View => "view",
            AppMenu::Joint => "editor",
            AppMenu::Animation => "animation",
            AppMenu::Help => "help",
        }
    }

    /// The catalogue key of the menu's name (`chrome.*`).
    pub const fn label(self) -> &'static str {
        match self {
            AppMenu::File => "chrome.file",
            AppMenu::Edit => "chrome.edit",
            AppMenu::View => "chrome.view",
            AppMenu::Joint => "chrome.joint",
            AppMenu::Animation => "chrome.animation",
            AppMenu::Help => "chrome.help",
        }
    }
}

/// What the desktop shell can do (today's `desktop?.newWindow`, `listRecentFiles`, ...): a row it lacks is disabled or absent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Desktop {
    pub new_window: bool,
    pub recent_files: bool,
    pub feedback: bool,
    pub updates: bool,
    pub telemetry: bool,
}

impl Desktop {
    /// The desktop application with every capability (the packaged app).
    pub const FULL: Desktop = Desktop { new_window: true, recent_files: true, feedback: true, updates: true, telemetry: true };
}

/// A panel of the View > Panels submenu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Panel {
    Properties,
    Vfx,
    Library,
    Structure,
    Timeline,
}

/// One open project, as the open-projects submenu lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub id: DocumentId,
    /// Its name; empty for an untitled project.
    pub name: String,
}

/// The state the menus' rows depend on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    /// A figure is selected (`editor.object`).
    pub figure: bool,
    /// One joint of a figure that is not a movieclip is selected: the Joint menu works.
    pub joint: bool,
    pub desktop: Desktop,
    /// The view toggles that are on (a row of a toggle command shows a check).
    pub on: Vec<C>,
    /// The panels that show.
    pub panels: Vec<Panel>,
    /// The open projects, in tab order.
    pub projects: Vec<Project>,
    /// The project in front.
    pub front: Option<DocumentId>,
}

impl Facts {
    fn checked(&self, command: C) -> bool {
        self.on.contains(&command)
    }
}

impl Default for Facts {
    /// A window with no selection and nothing open, on the packaged desktop; the stage's overlay flags at their starting
    /// state (Joints, Onion skin and Loop on).
    fn default() -> Facts {
        Facts { figure: false, joint: false, desktop: Desktop::FULL, on: vec![C::ToggleHandles, C::ToggleOnion, C::ToggleLoop], panels: Vec::new(), projects: Vec::new(), front: None }
    }
}

/// The view toggles whose rows show a check (today's `TOGGLE_STATES`, the ones the menus carry).
pub const TOGGLES: [C; 5] = [C::ToggleHandles, C::ToggleMotionPaths, C::ToggleGrid, C::ToggleOnion, C::ToggleLoop];

struct Builder<'a> {
    presentation: &'a Presentation,
    facts: &'a Facts,
}

impl Builder<'_> {
    fn text(&self, key: &'static str) -> String {
        self.presentation.label(&Label::key(key))
    }

    /// A row of a command: glyph, catalogue label and (when it applies) the disabled state.
    fn row(&self, command: C, icon: &str, key: &'static str, disabled: bool) -> Entry {
        let checked = TOGGLES.contains(&command).then(|| self.facts.checked(command));
        Entry::Item(Item { icon: Some(icon.to_owned()), checked, disabled, danger: command.info().danger, ..Item::new(command, self.text(key)) })
    }

    fn on(&self, command: C, icon: &str, key: &'static str) -> Entry {
        self.row(command, icon, key, false)
    }

    /// A row that needs a selected figure.
    fn figure(&self, command: C, icon: &str, key: &'static str) -> Entry {
        self.row(command, icon, key, !self.facts.figure)
    }

    /// A row that needs one joint of a figure.
    fn segment(&self, command: C, icon: &str, key: &'static str) -> Entry {
        self.row(command, icon, key, !self.facts.joint)
    }

    /// A row that opens a submenu: it names no command (the host never reports it).
    fn submenu(&self, label: String, icon: Option<&str>, disabled: bool, children: Vec<Entry>) -> Entry {
        Entry::Item(Item { icon: icon.map(str::to_owned), disabled, submenu: Some(children), ..Item::new(C::Menu, label) })
    }

    fn menu(&self, menu: AppMenu) -> Vec<Entry> {
        use Entry::Separator as Rule;
        let desktop = self.facts.desktop;
        match menu {
            AppMenu::File => vec![
                self.on(C::Home, "home", "commands.home"),
                Rule,
                self.on(C::New, "plus", "applicationMenu.newAnimation"),
                self.row(C::NewWindow, "plus", "applicationMenu.newWindow", !desktop.new_window),
                self.on(C::Open, "folder", "applicationMenu.openProject"),
                self.row(C::OpenRecent, "clock", "applicationMenu.openRecent", !desktop.recent_files),
                Rule,
                self.on(C::Save, "save", "common.save"),
                self.on(C::SaveAs, "save", "common.saveAs"),
                self.on(C::Rename, "file", "applicationMenu.renameProject"),
                self.on(C::CloseProject, "close", "commands.closeProject"),
                Rule,
                self.submenu(self.text("applicationMenu.import"), Some("import"), false, vec![
                    self.on(C::Import, "import", "applicationMenu.importFigures"),
                    self.on(C::ImportSprite, "image", "applicationMenu.importSpriteImage"),
                    self.on(C::ImportBackground, "image", "applicationMenu.importBackground"),
                ]),
                self.figure(C::ExportStkz, "person", "applicationMenu.saveFigure"),
                self.on(C::Export, "export", "common.export"),
            ],
            AppMenu::Edit => vec![
                self.on(C::Undo, "undo", "common.undo"),
                self.on(C::Redo, "redo", "common.redo"),
                Rule,
                self.figure(C::Copy, "duplicate", "common.copy"),
                self.on(C::Paste, "clipboard", "common.paste"),
                self.on(C::PasteInPlace, "clipboard", "applicationMenu.pasteInPlace"),
                self.figure(C::Duplicate, "duplicate", "applicationMenu.duplicateSelection"),
                self.figure(C::Delete, "trash", "applicationMenu.deleteSelection"),
                Rule,
                self.on(C::SelectAll, "cursor", "applicationMenu.selectAll"),
                self.on(C::SelectInvert, "cursor", "applicationMenu.invertSelection"),
                Rule,
                self.on(C::Settings, "settings", "applicationMenu.preferences"),
            ],
            AppMenu::View => vec![
                self.on(C::ZoomIn, "plus", "applicationMenu.zoomIn"),
                self.on(C::ZoomOut, "minus", "applicationMenu.zoomOut"),
                self.on(C::ZoomReset, "frame", "applicationMenu.fitCanvas"),
                self.figure(C::ZoomSelection, "center", "applicationMenu.fitSelection"),
                Rule,
                self.on(C::ToggleHandles, "joints", "applicationMenu.joints"),
                self.on(C::ToggleMotionPaths, "motion-path", "applicationMenu.motionPaths"),
                self.on(C::ToggleOnion, "onion", "applicationMenu.onionSkin"),
                self.on(C::ToggleGrid, "grid", "applicationMenu.grid"),
                Rule,
                self.on(C::SceneSettings, "scene", "applicationMenu.sceneProperties"),
                Rule,
                self.panels(),
                self.on(C::LayoutFocus, "maximize", "applicationMenu.focusMode"),
                self.on(C::LayoutMenu, "layout", "applicationMenu.layout"),
            ],
            AppMenu::Joint => vec![
                self.segment(C::SegmentValues, "sliders", "applicationMenu.exactValues"),
                Rule,
                self.segment(C::SplitSegment, "split", "applicationMenu.splitSegment"),
                self.segment(C::UnsplitSegment, "builder-unsplit", "applicationMenu.removeJointKeepEnds"),
                self.segment(C::OriginSegment, "origin", "applicationMenu.setAsOrigin"),
                Rule,
                self.submenu(self.text("common.duplicate"), Some("duplicate"), !self.facts.joint, vec![
                    self.segment(C::DuplicateSegment, "duplicate", "applicationMenu.duplicateSegment"),
                    self.segment(C::DuplicateBranch, "duplicate", "applicationMenu.duplicateBranch"),
                ]),
                self.submenu(self.text("applicationMenu.flip"), Some("flip"), !self.facts.joint, vec![
                    self.segment(C::MirrorSegment, "flip", "applicationMenu.flipSegmentHorizontally"),
                    self.segment(C::MirrorSegmentVertical, "flip-vertical", "applicationMenu.flipSegmentVertically"),
                    Rule,
                    self.segment(C::MirrorBranch, "flip", "applicationMenu.flipBranchHorizontally"),
                    self.segment(C::MirrorBranchVertical, "flip-vertical", "applicationMenu.flipBranchVertically"),
                ]),
                self.submenu(self.text("applicationMenu.arrange"), Some("layers"), !self.facts.joint, vec![
                    self.segment(C::SegmentOrderFront, "bring-to-front", "applicationMenu.bringSegmentToFront"),
                    self.segment(C::SegmentOrderUp, "up", "applicationMenu.bringSegmentForward"),
                    self.segment(C::SegmentOrderDown, "down", "applicationMenu.sendSegmentBackward"),
                    self.segment(C::SegmentOrderBack, "send-to-back", "applicationMenu.sendSegmentToBack"),
                ]),
                Rule,
                self.segment(C::DeleteSingleSegment, "trash", "applicationMenu.deleteSegment"),
                self.segment(C::DeleteSegment, "trash", "applicationMenu.deleteBranch"),
            ],
            AppMenu::Animation => vec![
                self.on(C::Play, "play", "applicationMenu.playPause"),
                self.on(C::ToggleLoop, "loop", "applicationMenu.loop"),
                Rule,
                self.on(C::FirstFrame, "first", "applicationMenu.firstFrame"),
                self.on(C::PreviousFrame, "previous", "applicationMenu.previousFrame"),
                self.on(C::NextFrame, "next", "applicationMenu.nextFrame"),
                self.on(C::LastFrame, "last", "applicationMenu.lastFrame"),
                Rule,
                self.on(C::AddFrame, "plus", "applicationMenu.addFrame"),
                Rule,
                self.submenu(self.text("applicationMenu.movieclip"), Some("frame"), false, vec![
                    self.on(C::MovieclipNew, "frame", "applicationMenu.newMovieclip"),
                    self.figure(C::MovieclipCreate, "frame", "applicationMenu.movieclipFromSelection"),
                    self.on(C::MovieclipRange, "frame", "applicationMenu.movieclipFromFrameRange"),
                ]),
                Rule,
                self.on(C::DeleteFrame, "trash", "applicationMenu.deleteKeyframe"),
            ],
            AppMenu::Help => {
                let mut rows = vec![self.on(C::Help, "help", "applicationMenu.keyboardShortcuts"), self.on(C::Tutorials, "learn", "commands.tutorials"), self.on(C::Performance, "activity", "applicationMenu.performance")];
                if desktop.feedback {
                    rows.extend([Rule, self.on(C::Feedback, "help", "applicationMenu.sendFeedbackReportABug")]);
                }
                if desktop.updates {
                    rows.extend([Rule, self.on(C::CheckUpdates, "import", "applicationMenu.checkForUpdates"), self.on(C::ReleaseNotes, "file", "applicationMenu.whatSNew"), self.on(C::Donate, "help", "applicationMenu.supportDevelopment")]);
                }
                if desktop.telemetry {
                    rows.extend([Rule, self.on(C::Privacy, "settings", "applicationMenu.privacyDiagnostics"), self.on(C::Website, "help", "applicationMenu.stykanimateWebsite")]);
                }
                rows
            }
        }
    }

    /// View > Panels: each panel checked while it shows.
    fn panels(&self) -> Entry {
        let panel = |command: C, shown: Panel, icon: &str, label: Label| {
            Entry::Item(Item { icon: Some(icon.to_owned()), checked: Some(self.facts.panels.contains(&shown)), ..Item::new(command, self.presentation.label(&label)) })
        };
        self.submenu(self.text("app.panels"), Some("layout"), false, vec![
            panel(C::PanelToggleProperties, Panel::Properties, "inspector", Label::key("app.properties")),
            panel(C::PanelToggleVfx, Panel::Vfx, "fx", Label::plain("VFX")),
            panel(C::PanelToggleLibrary, Panel::Library, "library", Label::key("app.library")),
            panel(C::PanelToggleStructure, Panel::Structure, "structure", Label::key("app.structure")),
            panel(C::PanelToggleTimeline, Panel::Timeline, "timeline", Label::key("app.timeline")),
        ])
    }

    /// The open projects as a submenu, for two or more (`openProjectsMenu`).
    fn projects(&self) -> Vec<Entry> {
        if self.facts.projects.len() < 2 {
            return Vec::new();
        }
        let rows = self.facts.projects.iter().map(|project| {
            let name = if project.name.is_empty() { self.text("app.untitled") } else { project.name.clone() };
            Entry::Item(Item { checked: Some(self.facts.front == Some(project.id)), ..Item::new(RowAction::Document(project.id), name) })
        });
        vec![self.submenu(self.text("projectTabs.openProjects"), Some("layers"), false, rows.collect()), Entry::Separator]
    }

    fn mark(&self) -> Vec<Entry> {
        use Entry::Separator as Rule;
        let mut rows: Vec<Entry> = AppMenu::ALL.iter().map(|menu| self.submenu(self.text(menu.label()), None, false, self.menu(*menu))).collect();
        rows.push(Rule);
        rows.extend(self.projects());
        rows.extend([
            // The palette's row shows its first key only (Ctrl+P), from the registry.
            self.on(C::CommandPalette, "search", "overlays.palette.open"),
            Rule,
            self.on(C::New, "plus", "app.newAnimation"),
            self.on(C::Open, "folder", "app.openProject"),
            self.row(C::OpenRecent, "clock", "app.openRecent", !self.facts.desktop.recent_files),
            self.on(C::Save, "save", "common.save"),
            self.on(C::SaveAs, "save", "common.saveAs"),
            Rule,
            self.on(C::Undo, "undo", "common.undo"),
            self.on(C::Redo, "redo", "common.redo"),
            Rule,
            self.on(C::Import, "import", "app.importFigures"),
            self.on(C::ImportSprite, "frame", "app.importSpriteImage"),
            self.on(C::ImportBackground, "frame", "app.importBackgroundImage"),
            self.on(C::AddText, "text", "app.createText"),
            self.on(C::Export, "export", "common.export"),
            Rule,
            self.on(C::Settings, "settings", "app.settings"),
            self.on(C::Help, "help", "app.keyboardShortcuts"),
            self.on(C::Performance, "activity", "app.performance"),
        ]);
        rows
    }
}

/// The rows of one application menu.
pub fn application(menu: AppMenu, facts: &Facts, presentation: &Presentation) -> Vec<Entry> {
    Builder { presentation, facts }.menu(menu)
}

/// The mark's StykAnimate menu: the six application menus as submenus, the open projects when two or more are open, Search
/// commands, then the file, history, import and settings rows.
pub fn mark(facts: &Facts, presentation: &Presentation) -> Vec<Entry> {
    Builder { presentation, facts }.mark()
}

#[cfg(feature = "engine")]
impl crate::app::Core {
    /// The state the menus' rows depend on, read from the owners that hold it: the selection of the project in front (only the
    /// reads that never evaluate), the settings, the dock's visible panels and the open projects.
    ///
    /// Opening a menu never evaluates or scans a frame: the selection is read from the session, and what kind of figure it is from
    /// the Inspector's resolved instance facts ([`crate::inspector::Panel::instance_of`]). While those are pending the Joint rows are
    /// disabled, as the Inspector's own controls are (today's menu always has the frame at hand; the other answer, no selection,
    /// would be wrong for a figure that is selected).
    ///
    /// The stage's overlay flags (Joints, Motion paths, Onion skin, Grid) have no owner in the core yet: the menu shows their
    /// starting state until the stage owns them.
    pub fn menu_facts(&self) -> Facts {
        use crate::inspector::facts;
        let mut on: Vec<C> = Facts::default().on.into_iter().filter(|command| *command != C::ToggleLoop).collect();
        if self.settings().animation().loop_playback {
            on.push(C::ToggleLoop);
        }
        let panels = [(Panel::Properties, "properties"), (Panel::Vfx, "vfx"), (Panel::Library, "library"), (Panel::Structure, "structure"), (Panel::Timeline, "timeline")];
        let visible = &self.dock().solution().visible;
        let (mut figure, mut joint) = (false, false);
        if let Some(document) = self.documents.active() {
            let selection = facts::selection(document);
            figure = selection.uid.is_some() || !selection.uids.is_empty();
            // The Joint menu needs one joint of one figure that is not a movieclip (`noJoint`). Whether it is a movieclip comes from
            // the resolved instance facts the worker made for exactly this revision and selection; while they are pending the
            // Joint rows are disabled until they land: nothing is evaluated or scanned here.
            let instance = selection.uid.or_else(|| selection.uids.first().copied()).and_then(|uid| self.inspector().instance_of(document, uid));
            joint = figure && selection.joint >= 0 && selection.uids.len() <= 1 && instance.is_some_and(|figure| figure.movieclip.is_none());
        }
        Facts {
            figure,
            joint,
            desktop: Desktop::FULL,
            on,
            panels: panels.into_iter().filter(|(_, kind)| visible.contains(&crate::layout::PanelId::new(kind))).map(|(panel, _)| panel).collect(),
            projects: self.documents.tabs().iter().map(|document| Project { id: document.id(), name: document.name().to_owned() }).collect(),
            front: self.documents.active().map(|document| document.id()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(entries: &[Entry]) -> Vec<&Item> {
        entries.iter().filter_map(|entry| if let Entry::Item(item) = entry { Some(item) } else { None }).collect()
    }

    #[test]
    fn the_mark_leads_with_the_six_menus_then_search_and_the_file_rows() {
        let english = Presentation::english();
        let rows = mark(&Facts::default(), &english);
        let labels: Vec<&str> = items(&rows).iter().map(|item| item.label.as_str()).collect();
        assert_eq!(labels[..6], ["File", "Edit", "View", "Joint", "Animation", "Help"]);
        assert!(items(&rows)[..6].iter().all(|item| item.submenu.is_some() && item.icon.is_none()));
        assert_eq!(labels[6], "Search commands…", "no open-projects row below two projects");
        assert_eq!(rows.len(), 6 + 1 + 1 + 1 + 5 + 1 + 2 + 1 + 5 + 1 + 3);
    }

    #[test]
    fn two_projects_add_the_open_projects_submenu_and_choosing_one_names_its_document() {
        let english = Presentation::english();
        let a = DocumentId::preview(1);
        let b = DocumentId::preview(2);
        let facts = Facts { projects: vec![Project { id: a, name: "One".into() }, Project { id: b, name: String::new() }], front: Some(b), ..Facts::default() };
        let rows = mark(&facts, &english);
        let open = items(&rows)[6];
        assert_eq!(open.label, "Open projects");
        let children = items(open.submenu.as_deref().unwrap());
        assert_eq!(children.iter().map(|child| (child.label.as_str(), child.checked)).collect::<Vec<_>>(), [("One", Some(false)), ("Untitled", Some(true))]);
        assert_eq!(children[0].action, RowAction::Document(a));
    }

    #[test]
    fn rows_that_need_a_figure_or_a_joint_are_disabled_without_one() {
        let english = Presentation::english();
        let bare = |menu| application(menu, &Facts::default(), &english);
        let disabled = |entries: &[Entry]| items(entries).iter().filter(|item| item.disabled).map(|item| item.label.clone()).collect::<Vec<_>>();
        assert_eq!(disabled(&bare(AppMenu::Edit)), ["Copy", "Duplicate selection", "Delete selection"]);
        assert!(items(&bare(AppMenu::Joint)).iter().all(|item| item.disabled));
        let with = Facts { figure: true, joint: true, ..Facts::default() };
        assert!(application(AppMenu::Edit, &with, &english).iter().all(|entry| !matches!(entry, Entry::Item(item) if item.disabled)));
        assert!(items(&application(AppMenu::Joint, &with, &english)).iter().all(|item| !item.disabled));
    }

    #[test]
    fn view_toggles_show_their_state_and_delete_rows_are_red() {
        let english = Presentation::english();
        let facts = Facts { on: vec![C::ToggleGrid], ..Facts::default() };
        let view = application(AppMenu::View, &facts, &english);
        let checked: Vec<(&str, Option<bool>)> = items(&view).iter().filter(|item| item.checked.is_some() && item.submenu.is_none()).map(|item| (item.label.as_str(), item.checked)).collect();
        assert_eq!(checked, [("Joints", Some(false)), ("Motion paths", Some(false)), ("Onion skin", Some(false)), ("Grid", Some(true))]);
        let edit = application(AppMenu::Edit, &Facts::default(), &english);
        assert!(items(&edit).iter().all(|item| item.danger == (item.label == "Delete selection")));
    }

    #[test]
    fn panels_are_a_submenu_of_view_ahead_of_focus_mode_and_check_what_shows() {
        let english = Presentation::english();
        let facts = Facts { panels: vec![Panel::Library, Panel::Timeline], ..Facts::default() };
        let view = application(AppMenu::View, &facts, &english);
        let labels: Vec<&str> = items(&view).iter().map(|item| item.label.as_str()).collect();
        let at = labels.iter().position(|label| *label == "Panels").unwrap();
        assert_eq!(labels[at + 1], "Focus mode");
        let panels = items(items(&view)[at].submenu.as_deref().unwrap()).iter().map(|item| (item.label.clone(), item.checked)).collect::<Vec<_>>();
        assert_eq!(panels.iter().map(|(_, checked)| *checked).collect::<Vec<_>>(), [Some(false), Some(false), Some(true), Some(false), Some(true)]);
        assert_eq!(panels[1].0, "VFX");
        let commands: Vec<C> = items(items(&view)[at].submenu.as_deref().unwrap()).iter().map(|item| match item.action { RowAction::Command(command) => command, _ => unreachable!() }).collect();
        assert_eq!(commands, [C::PanelToggleProperties, C::PanelToggleVfx, C::PanelToggleLibrary, C::PanelToggleStructure, C::PanelToggleTimeline]);
    }

    #[test]
    fn the_desktop_decides_new_window_recent_files_and_the_help_groups() {
        let english = Presentation::english();
        let web = Facts { desktop: Desktop::default(), ..Facts::default() };
        let file = application(AppMenu::File, &web, &english);
        let disabled: Vec<&str> = items(&file).iter().filter(|item| item.disabled).map(|item| item.label.as_str()).collect();
        assert_eq!(disabled, ["New window", "Open recent…", "Save figure…"]);
        assert_eq!(items(&application(AppMenu::Help, &web, &english)).len(), 3);
        assert_eq!(items(&application(AppMenu::Help, &Facts::default(), &english)).len(), 3 + 1 + 3 + 2);
    }
}
