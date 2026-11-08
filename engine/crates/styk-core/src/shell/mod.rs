//! The shell's logic: the top band and what it does (`docs/native/shell-band.md`).
//!
//! The band shows the open projects as tabs, the workspace switch, history, Save and Export, and a session's buttons.
//! Everything it decides is here, tested without a window: the rules for changing workspace ([`workspace`]), what the
//! band shows, where and what folds ([`band`]), the tab strip's states, keys and drag ([`strip`]), the Ctrl+Tab board
//! ([`switcher`]) and the sessions ([`session`]). [`Shell`] puts them together: the interface sends it [`Event`]s,
//! it answers with [`Effect`]s for the owners of what it does not own (the drawing and Build sessions, closing and
//! saving, the menus), and the interface draws [`Shell::layout`] and [`Shell::tabs`].
//!
//! Tab order, recency and the switcher's order are the open projects' (`crate::documents`); the shell holds none of
//! them twice.

pub mod band;
pub mod session;
pub mod strip;
pub mod switcher;
pub mod workspace;

use crate::identity::DocumentId;
#[cfg(feature = "engine")]
use crate::documents::{Documents, DocumentsError};
use crate::commands::Command;
#[cfg(feature = "engine")]
use crate::commands::CommandId;
use crate::focus::{FocusArea, FocusId, FocusState};
use band::{Frame, Input, Item, Labels, Layout, Metrics, TabFacts};
use session::{Done, Session};
use strip::{Side, Strip, TabKey, TabState};
#[cfg(feature = "engine")]
use strip::{Dropped, KeyOutcome};
use workspace::{Workspace, Workspaces};

/// The band's focus targets. Everything but the tabs has a fixed number; a tab's follows its project.
pub mod ids {
    use super::{DocumentId, Workspace};
    use crate::focus::FocusId;

    /// The mark.
    pub const MARK: FocusId = FocusId(100);
    /// Home.
    pub const HOME: FocusId = FocusId(101);
    /// New animation.
    pub const ADD: FocusId = FocusId(102);
    /// Undo.
    pub const UNDO: FocusId = FocusId(120);
    /// Redo.
    pub const REDO: FocusId = FocusId(121);
    /// Save.
    pub const SAVE: FocusId = FocusId(122);
    /// The Properties sheet button.
    pub const PROPERTIES: FocusId = FocusId(123);
    /// Export.
    pub const EXPORT: FocusId = FocusId(124);
    /// A movieclip's Cancel.
    pub const CANCEL: FocusId = FocusId(125);
    /// Build's Test rig.
    pub const TEST_RIG: FocusId = FocusId(126);
    /// A session's Done.
    pub const DONE: FocusId = FocusId(127);

    /// A workspace segment.
    pub fn workspace(workspace: Workspace) -> FocusId {
        FocusId(110 + Workspace::ALL.iter().position(|w| *w == workspace).unwrap_or(0) as u64)
    }

    /// A project's tab.
    pub fn tab(id: DocumentId) -> FocusId {
        FocusId(1000 + id.get())
    }

    /// The project a tab's focus target belongs to, if it is one.
    pub fn tab_of(focus: FocusId) -> Option<u64> {
        focus.0.checked_sub(1000)
    }
}

/// A menu the band opened. Their contents come with the menu widget and the command registry; until then the
/// interface shows a placeholder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Menu {
    /// The StykAnimate menu behind the mark.
    Mark,
    /// A project tab's menu.
    Tab(DocumentId),
}

/// What the pointer is over, for the hover looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hover {
    /// The mark.
    Mark,
    /// Home.
    Home,
    /// New animation.
    AddTab,
    /// A workspace segment.
    Workspace(Workspace),
    /// Undo.
    Undo,
    /// Redo.
    Redo,
    /// Save.
    Save,
    /// The Properties sheet button.
    Properties,
    /// Export.
    Export,
    /// A movieclip's Cancel.
    Cancel,
    /// Build's Test rig.
    TestRig,
    /// A session's Done.
    Done(Done),
    /// A project's tab.
    Tab(DocumentId),
    /// A tab's Close button.
    TabClose(DocumentId),
    /// Minimize.
    Minimize,
    /// Close the window.
    Close,
    /// A card of the Ctrl+Tab board.
    Card(usize),
}

/// What a tab shows.
#[derive(Clone, Debug, PartialEq)]
pub struct TabView {
    /// The project.
    pub id: DocumentId,
    /// Its name.
    pub name: String,
    /// It is in front.
    pub front: bool,
    /// Its dot.
    pub state: Option<TabState>,
    /// It is being dragged.
    pub dragging: bool,
    /// A line shows on this side of it: the dragged tab would land there.
    pub drop: Option<Side>,
}

/// A card of the Ctrl+Tab board.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    /// The project.
    pub id: DocumentId,
    /// Its name.
    pub name: String,
    /// "Edited" or "Saved".
    pub edited: bool,
    /// The selected card.
    pub selected: bool,
}

/// The window the band lives in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
    /// Logical width.
    pub width: f32,
    /// Logical height.
    pub height: f32,
    /// The interface scale (`--ui-scale`).
    pub ui_scale: f32,
    /// The band draws its own window controls (everywhere but macOS).
    pub controls: bool,
}

/// What the history buttons can do.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct History {
    /// A project is in front.
    pub open: bool,
    /// Undo has something to undo.
    pub undo: bool,
    /// Redo has something to redo.
    pub redo: bool,
}

/// What the interface tells the shell.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The pointer is over something, or over nothing.
    Hover(Option<Hover>),
    /// The mark: opens the StykAnimate menu, or closes it.
    Mark,
    /// Home.
    Home,
    /// New animation.
    New,
    /// The primary button went down on a tab.
    TabPressed(DocumentId),
    /// The pointer moved to window position (x, y) while a tab is pressed.
    PointerMoved(f32, f32),
    /// The primary button came up while a tab is pressed.
    PointerReleased,
    /// The drag was given up.
    DragCancelled,
    /// A key on a focused tab.
    TabKey(DocumentId, TabKey),
    /// Close a project: its Close button, the middle button or Delete.
    TabClose(DocumentId),
    /// Rename a project: a double click or F2.
    TabRename(DocumentId),
    /// A project's menu: a right click or the Menu key.
    TabMenu(DocumentId),
    /// A workspace segment, or Build's Done.
    Workspace(Workspace),
    /// What the sessions that the workspace switch asked of report.
    Report(workspace::Report),
    /// Undo.
    Undo,
    /// Redo.
    Redo,
    /// Save.
    Save,
    /// Export.
    Export,
    /// The Properties sheet button.
    Properties,
    /// A movieclip's Cancel.
    Cancel,
    /// Build's Test rig.
    TestRig,
    /// A session's Done.
    Done(Done),
    /// The band is a session of this, or none.
    Session(Session),
    /// The window changed size or scale.
    Resized(Window),
    /// The band's words were measured.
    Labels(Labels),
    /// Ctrl+Tab (Shift for backwards); `held` says the modifier is still down.
    CtrlTab {
        /// Shift+Ctrl+Tab.
        backwards: bool,
        /// The modifier is down.
        held: bool,
    },
    /// A key on the open board.
    SwitcherKey(switcher::Key),
    /// A card was clicked.
    SwitcherPick(usize),
    /// The modifier of the board was released.
    ModifierReleased,
    /// Ctrl+Page Up and Ctrl+Page Down: the tab this many places from the one in front comes to the front.
    Neighbour(isize),
    /// The window lost focus.
    Blurred,
    /// A menu was dismissed.
    CloseMenu,
    /// Time passed (milliseconds on the application's clock).
    Tick(u64),
    /// A save of a project began.
    SaveStarted(DocumentId),
    /// A save landed.
    SaveLanded(DocumentId, u64),
    /// A save ended without landing (failed or cancelled): the error policy says why, the tab shows what it showed.
    SaveEnded(DocumentId),
    /// A project opened as a tab (it is in front).
    Opened(DocumentId),
    /// A project closed.
    Closed(DocumentId),
}

/// What the shell asks of the rest of the application.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// Ask the owner of the drawing and Build sessions; they answer with [`Event::Report`].
    Workspace(workspace::Effect),
    /// Move keyboard focus to a tab, without switching.
    FocusTab(DocumentId),
    /// A project came to the front.
    Activated(DocumentId),
    /// A project's tab moved to this place.
    Moved(DocumentId, usize),
    /// The front project's document changed (Undo or Redo ran).
    Edited,
    /// A command the shell does not own. The document commands answer it.
    Command(Command),
    /// A command targeted at a tab, such as closing or renaming it.
    DocumentCommand { command: Command, document: DocumentId },
    /// Finish Build's workspace operation (not an appendix-A command).
    FinishBuild,
    /// A project cannot be switched to, as `Documents` says.
    #[cfg(feature = "engine")]
    Refused(DocumentsError),
}

/// The registry identity of what an event does, for the events that are commands (`data-action` of the
/// band's buttons). The workspace switch and Build's Done are not commands there (`changeMode`), and neither are the
/// tabs' own clicks: they do not run it.
#[cfg(feature = "engine")]
fn command_id(event: &Event) -> Option<CommandId> {
    Some(match event {
        Event::Home => CommandId::Home,
        Event::Mark => CommandId::Menu,
        Event::New => CommandId::New,
        Event::Undo => CommandId::Undo,
        Event::Redo => CommandId::Redo,
        Event::Save => CommandId::Save,
        Event::Export => CommandId::Export,
        Event::Properties => CommandId::PanelToggleProperties,
        Event::Cancel => CommandId::MovieclipCancel,
        Event::TestRig => CommandId::RigTest,
        Event::Done(Done::Movieclip) => CommandId::MovieclipDone,
        Event::Done(Done::Camera) => CommandId::CameraDone,
        Event::TabClose(_) => CommandId::CloseProject,
        Event::TabRename(_) => CommandId::Rename,
        _ => return None,
    })
}

/// The shell.
#[derive(Debug)]
pub struct Shell {
    /// The workspace switch.
    pub workspaces: Workspaces,
    /// The keyboard focus.
    pub focus: FocusState,
    session: Session,
    home: bool,
    strip: Strip,
    switcher: switcher::Switcher,
    menu: Option<Menu>,
    hover: Option<Hover>,
    window: Window,
    metrics: Metrics,
    labels: Labels,
    history: History,
    layout: Layout,
    tabs: Vec<TabView>,
    preview: Option<Vec<TabView>>,
}

impl Shell {
    /// A shell for a window, with the band's tokens and the width of its words.
    pub fn new(window: Window, metrics: Metrics, labels: Labels) -> Shell {
        let mut shell = Shell {
            workspaces: Workspaces::new(),
            focus: FocusState::new(),
            session: Session::None,
            home: false,
            strip: Strip::default(),
            switcher: switcher::Switcher::new(),
            menu: None,
            hover: None,
            window,
            metrics,
            labels,
            history: History::default(),
            layout: Layout { height: 0.0, folds: Vec::new(), items: Vec::new(), track: Frame::default(), strip: Frame::default(), min_width: 0.0, segments: band::SegmentContent::DotAndName, pad_start: 0.0 },
            tabs: Vec::new(),
            preview: None,
        };
        shell.layout_tabs(Vec::new());
        shell
    }

    /// The band, laid out.
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// The tabs in the strip's order.
    pub fn tabs(&self) -> &[TabView] {
        &self.tabs
    }

    /// The window.
    pub fn window(&self) -> &Window {
        &self.window
    }

    /// The session the band is of.
    pub fn session(&self) -> Session {
        self.session
    }

    /// Whether Home shows (it is the pressed item and no workspace is).
    pub fn home(&self) -> bool {
        self.home
    }

    /// The workspace pressed in the switch: the current one, unless Home shows.
    pub fn pressed(&self) -> Option<Workspace> {
        (!self.home).then(|| self.workspaces.current())
    }

    /// The menu that is open, if any.
    pub fn menu(&self) -> Option<Menu> {
        self.menu
    }

    /// What the pointer is over.
    pub fn hover(&self) -> Option<Hover> {
        self.hover
    }

    /// What the history buttons can do.
    pub fn history(&self) -> History {
        self.history
    }

    /// The board of the Ctrl+Tab switcher, if it shows.
    pub fn board(&self) -> Option<Vec<Card>> {
        let (order, selected) = self.switcher.board()?;
        Some(order.iter().enumerate().filter_map(|(index, id)| self.tabs.iter().find(|tab| tab.id == *id).map(|tab| Card { id: *id, name: tab.name.clone(), edited: matches!(tab.state, Some(TabState::Edited | TabState::Saving)), selected: index == selected })).collect())
    }

    /// Whether a tab is pressed, which means the pointer is followed anywhere in the window until it is released.
    pub fn tracking(&self) -> bool {
        self.strip.pressed()
    }

    /// Whether the Ctrl+Tab board shows: every key belongs to it.
    pub fn board_open(&self) -> bool {
        self.switcher.is_open()
    }

    /// When the strip next changes by itself, on the application's clock (a "Saved" ends).
    pub fn next_deadline(&self) -> Option<u64> {
        self.strip.saves.next_deadline()
    }

    /// Shows these tabs in place of the open projects': a band for the screen catalogue and for the views' tests, which
    /// have no engine to open projects with. `sync` keeps them until the next call to this with `None`.
    pub fn preview(&mut self, tabs: Option<Vec<TabView>>) {
        self.preview = tabs;
        self.history = History::default();
        self.layout_tabs(self.preview.clone().unwrap_or_default());
    }

    /// Select a catalogue session without opening an engine document.
    pub fn preview_session(&mut self, session: Session) {
        self.session = session;
        self.layout_tabs(self.preview.clone().unwrap_or_default());
    }

    /// Takes the open projects' state into the band and lays it out. Call after any event, and after the documents
    /// change (an edit, a save, a rename).
    #[cfg(feature = "engine")]
    pub fn sync(&mut self, documents: &Documents) {
        let front = documents.active().map(|document| document.id());
        let tabs: Vec<TabView> = documents
            .tabs()
            .iter()
            .map(|document| {
                let id = document.id();
                let drag = self.strip.drag();
                TabView {
                    id,
                    name: document.name().to_string(),
                    front: Some(id) == front,
                    state: self.strip.saves.state(id, document.dirty()),
                    dragging: drag.is_some_and(|d| d.moving && d.id == id),
                    drop: drag.and_then(|d| d.over).filter(|(over, _)| *over == id).map(|(_, side)| side),
                }
            })
            .collect();
        let tabs = self.preview.clone().unwrap_or(tabs);
        self.history = match documents.active() {
            // A project on its worker (`Busy`) shows no history until its session is back.
            Some(document) => document.view().map_or(History { open: true, undo: false, redo: false }, |view| History { open: true, undo: view.history.undo > 0, redo: view.history.redo > 0 }),
            None => History::default(),
        };
        self.layout_tabs(tabs);
    }

    fn layout_tabs(&mut self, tabs: Vec<TabView>) {
        let facts: Vec<TabFacts> = tabs.iter().map(|tab| TabFacts { id: tab.id, front: tab.front, marked: tab.state.is_some() }).collect();
        self.layout = band::solve(&Input {
            width: self.window.width,
            height: self.window.height,
            ui_scale: self.window.ui_scale,
            tabs: &facts,
            session: self.session,
            window_controls: self.window.controls,
            properties: self.window.width <= band::SHEET_UP_TO,
            metrics: self.metrics,
            labels: self.labels,
        });
        self.tabs = tabs;
    }

    /// Handles one event, then lays the band out again.
    #[cfg(feature = "engine")]
    pub fn handle(&mut self, documents: &mut Documents, event: Event) -> Vec<Effect> {
        let mut effects = Vec::new();
        // The one place Home is sent away by a command (`home.before` in `src/app.mjs`'s command wrapper).
        if let Some(command) = command_id(&event) {
            self.before_command(command);
        }
        let keeps_menu = matches!(event, Event::Hover(_) | Event::Mark | Event::TabMenu(_) | Event::Tick(_) | Event::Resized(_) | Event::Labels(_) | Event::PointerMoved(..) | Event::SaveStarted(_) | Event::SaveLanded(..) | Event::SaveEnded(_) | Event::Report(_) | Event::Session(_));
        if !keeps_menu {
            self.menu = None;
        }
        match event {
            Event::Hover(hover) => self.hover = hover,
            Event::Mark => self.menu = if self.menu == Some(Menu::Mark) { None } else { Some(Menu::Mark) },
            Event::Home => self.home = !self.home,
            Event::New => {
                effects.push(Effect::Command(Command::Run(CommandId::New)));
            }
            Event::TabPressed(id) => self.strip.press(id),
            Event::PointerMoved(x, y) => self.strip.moved(x, y, &self.layout),
            Event::PointerReleased => {
                let order: Vec<DocumentId> = documents.tabs().iter().map(|document| document.id()).collect();
                match self.strip.released(&self.layout, &order) {
                    Dropped::Click(id) => self.activate(documents, id, &mut effects),
                    Dropped::Move(id, to) => {
                        if documents.reorder(id, to) {
                            effects.push(Effect::Moved(id, to));
                        }
                    }
                    Dropped::None => {}
                }
            }
            Event::DragCancelled => self.strip.cancel(),
            Event::TabKey(id, key) => {
                let order: Vec<DocumentId> = documents.tabs().iter().map(|document| document.id()).collect();
                match strip::key(&order, id, key) {
                    KeyOutcome::Focus(next) => effects.push(Effect::FocusTab(next)),
                    KeyOutcome::Activate(next) => self.activate(documents, next, &mut effects),
                    KeyOutcome::Close(next) => effects.push(Effect::DocumentCommand { command: Command::Run(CommandId::CloseProject), document: next }),
                    KeyOutcome::Rename(next) => effects.push(Effect::DocumentCommand { command: Command::Run(CommandId::Rename), document: next }),
                    KeyOutcome::Menu(next) => self.menu = Some(Menu::Tab(next)),
                    KeyOutcome::None => {}
                }
            }
            Event::TabClose(id) => effects.push(Effect::DocumentCommand { command: Command::Run(CommandId::CloseProject), document: id }),
            Event::TabRename(id) => effects.push(Effect::DocumentCommand { command: Command::Run(CommandId::Rename), document: id }),
            Event::TabMenu(id) => self.menu = Some(Menu::Tab(id)),
            Event::Workspace(workspace) => {
                effects.extend(self.workspaces.choose(workspace).into_iter().map(Effect::Workspace));
            }
            Event::Report(report) => effects.extend(self.workspaces.report(report).into_iter().map(Effect::Workspace)),
            Event::Undo | Event::Redo => {
                if let Some(id) = documents.active().map(|document| document.id()) {
                    let can = if event == Event::Undo { self.history.undo } else { self.history.redo };
                    if can {
                        let answer = if event == Event::Undo { documents.undo(id) } else { documents.redo(id) };
                        match answer {
                            Ok(_) => effects.push(Effect::Edited),
                            Err(error) => effects.push(Effect::Refused(error)),
                        }
                    }
                }
            }
            Event::Save => effects.push(Effect::Command(Command::Run(CommandId::Save))),
            Event::Export => effects.push(Effect::Command(Command::Run(CommandId::Export))),
            Event::Properties => effects.push(Effect::Command(Command::Run(CommandId::PanelToggleProperties))),
            Event::Cancel => effects.push(Effect::Command(Command::Run(CommandId::MovieclipCancel))),
            Event::TestRig => effects.push(Effect::Command(Command::Run(CommandId::RigTest))),
            Event::Done(Done::Build) => {
                // Build's Done is a workspace button too: it returns to Animate.
                effects.extend(self.workspaces.choose(Workspace::Animate).into_iter().map(Effect::Workspace));
                effects.push(Effect::FinishBuild);
            }
            Event::Done(Done::Movieclip) => effects.push(Effect::Command(Command::Run(CommandId::MovieclipDone))),
            Event::Done(Done::Camera) => effects.push(Effect::Command(Command::Run(CommandId::CameraDone))),
            Event::Session(session) => self.session = session,
            Event::Resized(window) => self.window = window,
            Event::Labels(labels) => self.labels = labels,
            Event::CtrlTab { backwards, held } => {
                let outcome = self.switcher.open(documents.recency().map(|document| document.id()).collect(), backwards, held);
                self.switched(documents, outcome, &mut effects);
            }
            Event::SwitcherKey(key) => {
                let outcome = self.switcher.key(key);
                self.switched(documents, outcome, &mut effects);
            }
            Event::SwitcherPick(index) => {
                let outcome = self.switcher.pick(index);
                self.switched(documents, outcome, &mut effects);
            }
            Event::Neighbour(by) => {
                if let Some(id) = documents.neighbour(by) {
                    self.activate(documents, id, &mut effects);
                }
            }
            Event::ModifierReleased => {
                let outcome = self.switcher.released();
                self.switched(documents, outcome, &mut effects);
            }
            Event::Blurred => {
                self.strip.cancel();
                self.switcher.blur();
            }
            Event::CloseMenu => {}
            Event::Tick(now) => self.strip.saves.tick(now),
            Event::SaveStarted(id) => self.strip.saves.started(id),
            Event::SaveLanded(id, now) => self.strip.saves.landed(id, now),
            Event::SaveEnded(id) => self.strip.saves.ended(id),
            Event::Opened(_) => self.home = false,
            Event::Closed(id) => self.strip.forget(id),
        }
        self.sync(documents);
        effects
    }

    /// `home.before(command)`: a command that works on the animation sends Home away; the registry marks the commands that leave it visible.
    #[cfg(feature = "engine")]
    fn before_command(&mut self, command: CommandId) {
        if !command.info().stays_on_home {
            self.home = false;
        }
    }

    #[cfg(feature = "engine")]
    fn activate(&mut self, documents: &mut Documents, id: DocumentId, effects: &mut Vec<Effect>) {
        match documents.activate(id) {
            Ok(true) => {
                // A project brought to the front is what Home's page gives way to.
                self.home = false;
                effects.push(Effect::Activated(id));
            }
            Ok(false) => {}
            Err(error) => effects.push(Effect::Refused(error)),
        }
    }

    #[cfg(feature = "engine")]
    fn switched(&mut self, documents: &mut Documents, outcome: switcher::Outcome, effects: &mut Vec<Effect>) {
        if let switcher::Outcome::Activate(id) = outcome {
            // The project may have closed while the board showed.
            if documents.get(id).is_some() {
                self.activate(documents, id, effects);
            }
        }
    }

    /// The focus target of a placed item, if it takes focus.
    pub fn focus_of(&self, item: &Item) -> Option<FocusId> {
        match item {
            Item::Mark => Some(ids::MARK),
            Item::Home => Some(ids::HOME),
            Item::Tab(id, _) => Some(ids::tab(*id)),
            Item::AddTab => Some(ids::ADD),
            Item::Workspace(workspace) => Some(ids::workspace(*workspace)),
            Item::Undo => Some(ids::UNDO),
            Item::Redo => Some(ids::REDO),
            Item::Save => Some(ids::SAVE),
            Item::Properties => Some(ids::PROPERTIES),
            Item::Export(..) => Some(ids::EXPORT),
            Item::Cancel => Some(ids::CANCEL),
            Item::TestRig(_) => Some(ids::TEST_RIG),
            Item::Done(..) => Some(ids::DONE),
            Item::Minimize | Item::Maximize | Item::Close => None,
        }
    }

    /// The area the band's targets belong to.
    pub const AREA: FocusArea = FocusArea::TopBand;
}

#[cfg(all(test, feature = "engine"))]
mod tests {
    use super::*;

    const LABELS: Labels = Labels { animate: 52.140625, draw: 32.8125, build: 31.453125, export: 38.875, cancel: 40.9375, test_rig: 43.375, done: 31.03125 };

    fn shell(width: f32) -> Shell {
        Shell::new(Window { width, height: 1000.0, ui_scale: 1.0, controls: true }, Metrics::TODAY, LABELS)
    }

    #[test]
    fn a_new_shell_has_the_workspace_switch_on_animate_and_nothing_open() {
        let shell = shell(1560.0);
        assert_eq!(shell.pressed(), Some(Workspace::Animate));
        assert!(shell.tabs().is_empty());
        assert!(shell.menu().is_none() && !shell.board_open() && !shell.tracking());
        assert!(!shell.history().open);
        assert_eq!(shell.layout().height, 52.0);
    }

    #[test]
    fn home_is_the_pressed_item_and_no_workspace_is_while_it_shows() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        shell.handle(&mut documents, Event::Home);
        assert!(shell.home());
        assert_eq!(shell.pressed(), None);
        // A workspace change is not a command in today's wrapper: Home stays (and no workspace is pressed).
        shell.handle(&mut documents, Event::Workspace(Workspace::Draw));
        assert!(shell.home());
        assert_eq!(shell.pressed(), None);
        // A command that works on the animation sends it away.
        shell.handle(&mut documents, Event::Export);
        assert!(!shell.home());
        assert_eq!(shell.pressed(), Some(Workspace::Animate), "Draw was asked for, not yet entered");
    }

    #[test]
    fn feature_requests_keep_the_shared_command_and_target_document() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        for (event, command) in [
            (Event::New, CommandId::New), (Event::Save, CommandId::Save),
            (Event::Export, CommandId::Export), (Event::Properties, CommandId::PanelToggleProperties),
            (Event::TestRig, CommandId::RigTest), (Event::Cancel, CommandId::MovieclipCancel),
            (Event::Done(Done::Movieclip), CommandId::MovieclipDone), (Event::Done(Done::Camera), CommandId::CameraDone),
        ] {
            assert_eq!(shell.handle(&mut documents, event), [Effect::Command(Command::Run(command))]);
        }
        let id = DocumentId::preview(7);
        for (event, command) in [(Event::TabClose(id), CommandId::CloseProject), (Event::TabRename(id), CommandId::Rename)] {
            assert_eq!(shell.handle(&mut documents, event), [Effect::DocumentCommand { command: Command::Run(command), document: id }]);
        }
    }

    /// `HOME_COMMANDS` and `home.before` in `src/home/home.mjs`: a command that works on the animation sends Home away,
    /// and the ones that open something of their own or act on the window leave it.
    #[test]
    fn export_and_the_session_commands_send_home_away_and_save_and_the_workspaces_leave_it() {
        let mut documents = Documents::new();
        for (event, clears) in [
            (Event::Export, true),
            (Event::Properties, true),
            (Event::Cancel, true),
            (Event::TestRig, true),
            (Event::Done(Done::Movieclip), true),
            (Event::Done(Done::Camera), true),
            (Event::Undo, true),
            (Event::Redo, true),
            (Event::New, true),
            (Event::Save, false),
            (Event::Mark, false),
            (Event::Workspace(Workspace::Draw), false),
            (Event::Done(Done::Build), false),
        ] {
            let mut shell = shell(1560.0);
            shell.handle(&mut documents, Event::Home);
            assert!(shell.home());
            shell.handle(&mut documents, event.clone());
            assert_eq!(shell.home(), !clears, "{event:?}");
        }
    }

    #[test]
    fn choosing_a_workspace_asks_the_owner_and_the_owner_report_makes_it_current() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        let effects = shell.handle(&mut documents, Event::Workspace(Workspace::Draw));
        assert_eq!(effects, vec![Effect::Workspace(workspace::Effect::EnterDrawing)]);
        shell.handle(&mut documents, Event::Report(workspace::Report::DrawingEntered));
        assert_eq!(shell.pressed(), Some(Workspace::Draw));
        // Build's Done returns to Animate through the same rules: Draw commits first.
        let effects = shell.handle(&mut documents, Event::Done(Done::Build));
        assert_eq!(effects, vec![Effect::Workspace(workspace::Effect::ExitDrawing), Effect::FinishBuild]);
    }

    #[test]
    fn the_mark_opens_its_menu_and_a_second_press_closes_it() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        shell.handle(&mut documents, Event::Mark);
        assert_eq!(shell.menu(), Some(Menu::Mark));
        shell.handle(&mut documents, Event::Mark);
        assert_eq!(shell.menu(), None);
        shell.handle(&mut documents, Event::Mark);
        shell.handle(&mut documents, Event::CloseMenu);
        assert_eq!(shell.menu(), None, "a press elsewhere dismisses it");
    }

    #[test]
    fn a_session_changes_what_the_band_places_and_export_turns_quiet() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        shell.handle(&mut documents, Event::Session(Session::Movieclip));
        let layout = shell.layout();
        assert!(layout.find(|item| matches!(item, Item::Cancel)).is_some());
        assert!(layout.find(|item| matches!(item, Item::Done(Done::Movieclip, _))).is_some());
        assert!(layout.find(|item| matches!(item, Item::Export(session::ExportLook::Ghost, _))).is_some());
        shell.handle(&mut documents, Event::Session(Session::None));
        assert!(shell.layout().find(|item| matches!(item, Item::Export(session::ExportLook::Primary, _))).is_some());
    }

    #[test]
    fn the_properties_button_shows_when_the_window_is_narrow_enough_for_the_sheet() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        assert!(shell.layout().find(|item| matches!(item, Item::Properties)).is_none());
        shell.handle(&mut documents, Event::Resized(Window { width: 800.0, height: 1000.0, ui_scale: 1.0, controls: true }));
        assert!(shell.layout().find(|item| matches!(item, Item::Properties)).is_some());
    }

    #[test]
    fn resizing_narrower_folds_the_band_and_wider_unfolds_it() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        assert!(shell.layout().folds.is_empty());
        shell.handle(&mut documents, Event::Resized(Window { width: 700.0, height: 1000.0, ui_scale: 1.0, controls: true }));
        assert!(!shell.layout().folds.is_empty());
        shell.handle(&mut documents, Event::Resized(Window { width: 1560.0, height: 1000.0, ui_scale: 1.0, controls: true }));
        assert!(shell.layout().folds.is_empty());
    }

    #[test]
    fn every_placed_item_that_takes_focus_has_its_own_target() {
        let mut documents = Documents::new();
        let mut shell = shell(1560.0);
        shell.handle(&mut documents, Event::Session(Session::Build));
        let mut seen = Vec::new();
        for placed in &shell.layout().items {
            if let Some(id) = shell.focus_of(&placed.item) {
                assert!(!seen.contains(&id), "{id:?} is used twice");
                seen.push(id);
            }
        }
        assert!(seen.len() >= 8);
    }
}
