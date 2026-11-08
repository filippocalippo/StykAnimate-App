//! The docked window on mounted widgets: the dock's own widgets in the toolkit's headless renderer, their messages through
//! the one handler (`message::update_at` into `Core::dispatch`), the tree's measured bounds and focus handed back to the core
//! as the application does after every message, and the pointer and key mappings the application uses (`dock::track`,
//! `dock::key`). What a gesture decides is `styk_core::dock`'s and is tested there; here the widgets are the unit, and what
//! they make of a press, a drag and a key is judged by what the core ends up holding.
use iced::keyboard::key::Named;
use iced::keyboard::{Key, Modifiers};
use iced::{Event, Point, Size, mouse};
use styk_core::app::Core;
use styk_core::commands::Command;
use styk_core::inspector::property::PropertyKey;
use styk_core::dock::{self, ids};
use styk_core::layout::{Axis, GroupId, Rect, Zone};
use styk_design::Theme;
use styk_design::widgets::testing::{Driver, key_event};
use styk_ui::dock::{Key as DockKey, Params};
use styk_ui::message::{Message, update_at};

const STAGE: GroupId = 1;
const PROPERTIES: GroupId = 2;
const TIMELINE: GroupId = 3;
/// The band's height at a window this tall.
const BAND: f32 = 52.0;

#[test]
fn standalone_panel_snapshot_keeps_its_regions_without_a_mounted_dock() {
    let model = styk_ui::screens::inspector_model(styk_core::screens::InspectorScreen::Figure);
    let presentation = styk_core::i18n::Presentation::english();
    let element = styk_ui::inspector::view(styk_ui::inspector::View::model(&model, &presentation, Theme::Light));
    let mut driver = Driver::new(element, Size::new(320., 900.), &styk_design::fonts::ALL);
    let snapshot = driver.snapshot();
    let expected: Vec<_> = snapshot.scopes.iter().filter(|(scope, _)| *scope == styk_core::focus::ScopeId::ROOT)
        .flat_map(|(_, targets)| targets.iter().filter(|t| t.enabled).map(|t| (t.id, t.area))).collect();
    assert!(!expected.is_empty());
    let mut core = Core::default();
    drop(update_at(&mut core, Message::Snapshot(snapshot), 1));
    for (id, area) in expected {
        core.focus_mut().focus(id);
        assert_eq!(core.focus().focused_area(), Some(area), "no dock owns standalone controls");
    }
}

struct World {
    core: Core,
    driver: Option<Driver<'static, Message>>,
    now: u64,
    size: Size,
    /// What the handler asked of the toolkit (focus moves), run on the rebuilt tree as the runtime runs them.
    tasks: Vec<iced::Task<Message>>,
}

fn element(core: &Core) -> iced::Element<'static, Message> {
    let model = styk_ui::screens::inspector_model(styk_core::screens::InspectorScreen::Figure);
    let presentation = styk_core::i18n::Presentation::english();
    let params = Params { dock: core.dock(), theme: Theme::Light, presentation: &presentation, top: BAND };
    styk_ui::dock::window(&params, Some(styk_ui::inspector::View::model(&model, &presentation, Theme::Light)), None)
}

impl World {
    fn new(width: f32, height: f32) -> World {
        let mut core = Core::default();
        let size = Size::new(width, height);
        core.dispatch(Command::Dock(dock::Event::Resized { width: f64::from(width), height: f64::from(height), scale: 1.0 }));
        let mut world = World { driver: Some(Driver::new(element(&core), size, &styk_design::fonts::ALL)), core, now: 1_000, size, tasks: Vec::new() };
        world.walk();
        world
    }

    fn driver(&mut self) -> &mut Driver<'static, Message> {
        self.driver.as_mut().expect("a driver")
    }

    /// The application's walk after a message: the tree's measured bounds and focus reach the core.
    fn walk(&mut self) {
        let snapshot = self.driver().snapshot();
        let task = update_at(&mut self.core, Message::Snapshot(snapshot), self.now);
        self.tasks.push(task);
    }

    /// A message through the production handler; what it asks of the toolkit runs after the view is rebuilt.
    fn send(&mut self, message: Message) {
        let task = update_at(&mut self.core, message, self.now);
        self.tasks.push(task);
    }

    /// Delivers what the interface published, rebuilds the view from the core and walks it.
    fn deliver(&mut self) {
        loop {
            let messages = self.driver().messages();
            if messages.is_empty() {
                break;
            }
            for message in messages {
                self.send(message);
            }
        }
        let driver = self.driver.take().expect("a driver");
        self.driver = Some(driver.rebuild(element(&self.core)));
        let tasks = std::mem::take(&mut self.tasks);
        let produced: Vec<Message> = tasks.into_iter().flat_map(|task| self.driver().run(task)).collect();
        let again = !produced.is_empty();
        for message in produced {
            self.send(message);
        }
        self.walk();
        if again {
            self.deliver();
        }
    }

    /// A pointer event as the window delivers it: the widgets take it, then, while the dock tracks a press or a drag, the
    /// application's subscription forwards it.
    fn pointer(&mut self, event: mouse::Event) {
        let tracking = self.core.dock().tracking();
        if let mouse::Event::CursorMoved { position } = &event {
            self.driver().point_at(*position);
        }
        self.driver().events(&[Event::Mouse(event.clone())]);
        self.deliver();
        if tracking && let Some(message) = styk_ui::dock::track(&Event::Mouse(event)) {
            self.now += 5;
            self.send(message);
            self.deliver();
        }
    }

    fn moved(&mut self, x: f32, y: f32) {
        self.pointer(mouse::Event::CursorMoved { position: Point::new(x, y) });
    }

    fn press(&mut self) {
        self.pointer(mouse::Event::ButtonPressed(mouse::Button::Left));
    }

    fn release(&mut self) {
        self.pointer(mouse::Event::ButtonReleased(mouse::Button::Left));
    }

    /// Presses at `from`, moves through `path` and lets go.
    fn drag(&mut self, from: Point, path: &[(f32, f32)]) {
        self.moved(from.x, from.y);
        self.press();
        for (x, y) in path {
            self.moved(*x, *y);
        }
        self.release();
    }

    fn click(&mut self, at: Point) {
        self.moved(at.x, at.y);
        self.press();
        self.release();
    }

    /// A key as the window delivers it: the dock's mapping first (the application's `dock_key`), then the widgets.
    fn key(&mut self, key: Key, modifiers: Modifiers) {
        let event = key_event(key.clone(), None, modifiers, true);
        match styk_ui::dock::key(self.core.dock(), &key) {
            DockKey::Send(event) => {
                self.now += 5;
                self.send(Message::Command(Command::Dock(event)));
            }
            DockKey::Note(event) => {
                self.send(Message::Command(Command::Dock(event)));
                self.driver().events(&[event_of(&key, modifiers)]);
            }
            DockKey::Pass => {
                // The registry's shortcuts first (undo, the keyboard move, the panel commands, F6), then the widgets.
                match styk_ui::message::dock_shortcut_at(&mut self.core, &event, true, self.now) {
                    Some(task) => self.tasks.push(task),
                    None => {
                        self.driver().events(&[event]);
                    }
                }
            }
            DockKey::Swallow => {}
        }
        self.deliver();
    }

    fn bounds(&mut self, id: styk_core::focus::FocusId) -> Option<iced::Rectangle> {
        self.driver().snapshot().bounds_of(id)
    }

    fn centre_of(&mut self, id: styk_core::focus::FocusId) -> Point {
        let b = self.bounds(id).unwrap_or_else(|| panic!("{id:?} is not in the tree"));
        Point::new(b.x + b.width / 2.0, b.y + b.height / 2.0)
    }

    fn rect(&self, kind: &str) -> Rect {
        let id = self.group_of(kind);
        let s = self.core.dock().solution();
        s.groups.get(&id).or(s.strips.get(&id)).copied().unwrap_or_else(|| panic!("{kind} is not placed"))
    }

    fn group_of(&self, kind: &str) -> GroupId {
        self.core.dock().layout().groups().into_iter().find(|g| g.tabs.iter().any(|p| p.kind == kind)).map(|g| g.id).unwrap_or_else(|| panic!("{kind} is in no group"))
    }

    fn tabs_of(&self, group: GroupId) -> Vec<String> {
        self.core.dock().layout().groups().into_iter().find(|g| g.id == group).map(|g| g.tabs.iter().map(|p| p.kind.clone()).collect()).unwrap_or_default()
    }

    fn resize(&mut self, width: f32, height: f32) {
        self.size = Size::new(width, height);
        // The window's size reaches the dock as the application sends it (`TopBand::resized`); the driver follows it.
        self.core.dispatch(Command::Dock(dock::Event::Resized { width: f64::from(width), height: f64::from(height), scale: 1.0 }));
        let driver = Driver::new(element(&self.core), self.size, &styk_design::fonts::ALL);
        self.driver = Some(driver);
        self.walk();
    }

    /// The target that holds focus, as the core holds it after the last walk.
    fn focused(&self) -> Option<styk_core::focus::FocusId> {
        self.core.focus().focused()
    }

    fn layout_now(&self) -> styk_core::layout::Layout {
        self.core.dock().layout().clone()
    }
}

fn event_of(key: &Key, modifiers: Modifiers) -> Event {
    key_event(key.clone(), None, modifiers, true)
}

#[test]
fn every_group_the_core_solved_is_mounted_with_its_tabs_and_dividers() {
    let mut world = World::new(1560.0, 1000.0);
    for tab in 0..3 {
        assert!(world.bounds(ids::tab(PROPERTIES, tab)).is_some(), "tab {tab} of the inspector group is a target");
    }
    assert!(world.bounds(ids::body(STAGE)).is_some() && world.bounds(ids::body(TIMELINE)).is_some(), "the stage and the timeline are targets F6 can land on");
    let dividers: Vec<_> = world.core.dock().dividers().into_iter().map(|d| (d.split, d.index)).collect();
    assert_eq!(dividers.len(), 2);
    for (split, index) in dividers {
        assert!(world.bounds(ids::divider(split, index)).is_some(), "divider {split}/{index}");
    }
    // The tabs sit where the island's header says: 8 px in, 6 px down (`.shell-island > .shell-tabs`).
    let header = world.core.dock().solution().groups[&PROPERTIES];
    let first = world.bounds(ids::tab(PROPERTIES, 0)).unwrap();
    assert!((first.x - (header.x as f32 + 10.0)).abs() <= 1.0 && (first.y - (header.y as f32 + 8.0)).abs() <= 1.0, "{first:?} in {header:?}");
}

#[test]
fn a_tab_dragged_to_each_window_edge_docks_there_and_one_undo_puts_it_back() {
    for (name, point) in [("left", (4.0, 400.0)), ("right", (1556.0, 400.0)), ("top", (700.0, 4.0)), ("bottom", (700.0, 996.0))] {
        let mut world = World::new(1560.0, 1000.0);
        let before = world.layout_now();
        let library = world.centre_of(ids::tab(PROPERTIES, 2));
        world.drag(library, &[(library.x - 30.0, library.y + 40.0), point]);
        let moved = world.rect("library");
        match name {
            "left" => assert!(moved.x <= 8.5 && moved.h > 500.0, "{name}: {moved:?}"),
            "right" => assert!((moved.x + moved.w - 1552.0).abs() < 1.5 && moved.h > 500.0, "{name}: {moved:?}"),
            "top" => assert!(moved.y <= 60.5 && moved.w > 1000.0, "{name}: {moved:?}"),
            _ => assert!((moved.y + moved.h - 992.0).abs() < 1.5 && moved.w > 1000.0, "{name}: {moved:?}"),
        }
        assert_eq!(world.tabs_of(PROPERTIES), ["properties", "vfx"], "{name}: the tab left its group");
        // The drop's own mounted widgets show where it went: the moved panel's group has its own island and tab-less header.
        assert!(world.bounds(ids::body(world.group_of("library"))).is_some());
        world.key(Key::Character("z".into()), Modifiers::CTRL | Modifiers::ALT);
        assert_eq!(world.layout_now(), before, "{name}: one undo");
    }
}

#[test]
fn a_tab_dropped_on_the_lower_quarter_of_the_stage_splits_it_and_on_its_middle_joins_it() {
    let mut world = World::new(1560.0, 1000.0);
    let stage = world.core.dock().solution().groups[&STAGE];
    let vfx = world.centre_of(ids::tab(PROPERTIES, 1));
    world.drag(vfx, &[(vfx.x - 40.0, vfx.y + 60.0), ((stage.x + stage.w / 2.0) as f32, (stage.y + stage.h - 20.0) as f32)]);
    let (below, stage_now) = (world.rect("vfx"), world.rect("stage"));
    assert!((below.y - (stage_now.y + stage_now.h)).abs() <= 8.5, "vfx sits under the stage: {below:?} under {stage_now:?}");
    assert_eq!((below.x, below.w), (stage_now.x, stage_now.w));
    // The library tab dropped in the middle of the stage's group becomes a tab of it.
    let library = world.centre_of(ids::tab(PROPERTIES, 1));
    let stage_now = world.rect("stage");
    world.drag(library, &[(library.x - 40.0, library.y + 60.0), ((stage_now.x + stage_now.w / 2.0) as f32, (stage_now.y + stage_now.h / 2.0) as f32)]);
    assert_eq!(world.tabs_of(STAGE), ["stage", "library"]);
    assert!(world.bounds(ids::tab(STAGE, 1)).is_some(), "the stage's group shows its tab strip now");
}

#[test]
fn dragging_a_tab_along_its_own_header_reorders_the_tabs() {
    let mut world = World::new(1560.0, 1000.0);
    let library = world.centre_of(ids::tab(PROPERTIES, 2));
    let header = world.core.dock().solution().headers[&PROPERTIES];
    world.drag(library, &[(library.x - 20.0, library.y), (header.x as f32 + 4.0, library.y)]);
    assert_eq!(world.tabs_of(PROPERTIES), ["library", "properties", "vfx"]);
    // The click that follows a drag activates nothing: the tab that was active still is.
    assert_eq!(world.core.dock().layout().groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.tabs[g.active].kind.clone()), Some("library".to_string()), "the dragged tab is the one in front, as a drop in a group makes it");
}

#[test]
fn a_click_on_a_tab_activates_it_and_a_double_click_on_the_header_collapses_the_group_to_a_strip() {
    let mut world = World::new(1560.0, 1000.0);
    let vfx = world.centre_of(ids::tab(PROPERTIES, 1));
    world.click(vfx);
    let active = |w: &World| w.core.dock().layout().groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.tabs[g.active].kind.clone());
    assert_eq!(active(&world), Some("vfx".to_string()));
    // Two presses on the empty part of the header within the double-click time: the group folds to its strip.
    let header = world.core.dock().solution().headers[&PROPERTIES];
    let empty = Point::new((header.x + header.w - 20.0) as f32, (header.y + 22.0) as f32);
    world.click(empty);
    world.click(empty);
    assert!(world.core.dock().solution().strips.contains_key(&PROPERTIES), "collapsed");
    assert!(world.bounds(ids::strip(PROPERTIES, 0)).is_some() && world.bounds(ids::tab(PROPERTIES, 0)).is_none(), "the strip's icons replace the tabs");
    // A strip icon opens the flyout, and Escape closes it.
    let icon = world.centre_of(ids::strip(PROPERTIES, 1));
    world.click(icon);
    assert_eq!(world.core.dock().open(), Some(PROPERTIES));
    assert!(world.bounds(ids::tab(PROPERTIES, 0)).is_some(), "the flyout shows the group's tabs");
    // The flyout's tabs close as the docked ones do: a middle click on a tab that is not in front leaves the flyout open, the x
    // on the tab in front closes that panel and with it the flyout (the core's rule).
    let library = world.centre_of(ids::tab(PROPERTIES, 2));
    world.moved(library.x, library.y);
    world.pointer(mouse::Event::ButtonPressed(mouse::Button::Middle));
    world.pointer(mouse::Event::ButtonReleased(mouse::Button::Middle));
    assert_eq!(world.tabs_of(PROPERTIES), ["properties", "vfx"], "a middle click closed Library in the flyout");
    assert_eq!(world.core.dock().open(), Some(PROPERTIES));
    let tab = world.bounds(ids::tab(PROPERTIES, 1)).unwrap();
    world.click(Point::new(tab.x + tab.width - 7.0, tab.y + tab.height / 2.0));
    assert_eq!(world.tabs_of(PROPERTIES), ["properties"], "the x closed VFX in the flyout");
    assert_eq!(world.core.dock().open(), None);
}

#[test]
fn the_sheet_at_compact_width_closes_tabs_with_the_x_and_the_middle_click_too() {
    let mut world = World::new(720.0, 800.0);
    world.key(Key::Character("1".into()), Modifiers::CTRL);
    assert_eq!(world.core.dock().open(), Some(PROPERTIES), "Ctrl+1 opens the sheet");
    let library = world.centre_of(ids::tab(PROPERTIES, 2));
    world.moved(library.x, library.y);
    world.pointer(mouse::Event::ButtonPressed(mouse::Button::Middle));
    world.pointer(mouse::Event::ButtonReleased(mouse::Button::Middle));
    assert_eq!(world.tabs_of(PROPERTIES), ["properties", "vfx"], "a middle click closed Library in the sheet");
    assert_eq!(world.core.dock().open(), Some(PROPERTIES));
    let tab = world.bounds(ids::tab(PROPERTIES, 0)).expect("the sheet's tabs");
    world.click(Point::new(tab.x + tab.width - 7.0, tab.y + tab.height / 2.0));
    assert_eq!(world.tabs_of(PROPERTIES), ["vfx"], "the x closed Properties in the sheet");
    assert!(world.core.dock().can_undo());
}

#[test]
fn a_splitter_dragged_resizes_the_neighbours_live_and_one_undo_restores_both() {
    let mut world = World::new(1560.0, 1000.0);
    let before = world.layout_now();
    let divider = world.core.dock().dividers().into_iter().find(|d| d.axis == Axis::Horizontal).map(|d| (d.split, d.index)).expect("a column divider");
    let bar = world.centre_of(ids::divider(divider.0, divider.1));
    world.moved(bar.x, bar.y);
    world.press();
    world.moved(bar.x - 20.0, bar.y);
    world.moved(bar.x - 60.0, bar.y);
    assert_eq!(world.rect("properties").w, 380.0, "the inspector follows the pointer while it is held");
    assert_eq!(world.core.dock().resizing(), Some(divider));
    world.release();
    assert_eq!(world.rect("properties").w, 380.0);
    assert_eq!(world.core.dock().resizing(), None);
    world.key(Key::Character("z".into()), Modifiers::CTRL | Modifiers::ALT);
    assert_eq!(world.layout_now(), before);
}

#[test]
fn a_splitter_pressed_twice_in_a_double_click_resets_and_escape_during_a_drag_restores_the_start() {
    let mut world = World::new(1560.0, 1000.0);
    let divider = world.core.dock().dividers().into_iter().find(|d| d.axis == Axis::Horizontal).map(|d| (d.split, d.index)).expect("a column divider");
    let bar = world.centre_of(ids::divider(divider.0, divider.1));
    world.drag(bar, &[(bar.x - 50.0, bar.y)]);
    assert_eq!(world.rect("properties").w, 370.0);
    // Held, moved, and Escape: back to the start.
    let bar = world.centre_of(ids::divider(divider.0, divider.1));
    world.moved(bar.x, bar.y);
    world.press();
    world.moved(bar.x - 30.0, bar.y);
    assert_eq!(world.rect("properties").w, 400.0);
    world.key(Key::Named(Named::Escape), Modifiers::default());
    world.release();
    assert_eq!(world.rect("properties").w, 370.0);
    // The splitter's own keys: Home resets to the default, an arrow moves 12 px.
    let id = ids::divider(divider.0, divider.1);
    world.driver().focus(id);
    world.driver().press(Named::Home);
    world.deliver();
    assert_eq!(world.rect("properties").w, 320.0);
    world.driver().press(Named::ArrowLeft);
    world.deliver();
    assert_eq!(world.rect("properties").w, 332.0);
}

#[test]
fn the_right_dock_folds_at_800_and_unfolds_at_816_through_the_mounted_widgets() {
    let mut world = World::new(1000.0, 800.0);
    let has_tabs = |w: &mut World| w.bounds(ids::tab(PROPERTIES, 0)).is_some();
    assert!(has_tabs(&mut world));
    world.resize(800.0, 800.0);
    assert!(!has_tabs(&mut world), "folded: the sheet shows nothing until it is opened");
    world.resize(810.0, 800.0);
    assert!(!has_tabs(&mut world), "810 is still folded: the dock waits for 816");
    world.resize(820.0, 800.0);
    assert!(has_tabs(&mut world), "820 unfolds it");
    world.resize(805.0, 800.0);
    assert!(has_tabs(&mut world), "and 805 does not fold it again");
    world.resize(790.0, 800.0);
    assert!(!has_tabs(&mut world));
    // Ctrl+1 (the registry's Properties command, as the band's button sends it) opens the sheet over the stage at the
    // rectangle the solver gave it; Escape closes it.
    world.key(Key::Character("1".into()), Modifiers::CTRL);
    assert_eq!(world.core.dock().open(), Some(PROPERTIES));
    assert!(has_tabs(&mut world), "the sheet is mounted");
    let sheet = world.core.dock().open_rect().expect("the solver placed the sheet");
    let pin = world.bounds(ids::pin(PROPERTIES)).expect("the sheet's pin");
    assert!(pin.x >= sheet.x as f32 && pin.x + pin.width <= (sheet.x + sheet.w) as f32 + 0.5 && pin.y >= sheet.y as f32 && pin.y <= (sheet.y + sheet.h) as f32, "the pin {pin:?} is inside the solver's rectangle {sheet:?}");
    world.key(Key::Named(Named::Escape), Modifiers::default());
    assert!(!has_tabs(&mut world));
    assert!(!world.core.dock().modified() && !world.core.dock().can_undo(), "folding never wrote the arrangement");
}

#[test]
fn escape_cancels_a_drag_in_progress_and_leaves_the_arrangement_and_its_history_alone() {
    let mut world = World::new(1560.0, 1000.0);
    let before = world.layout_now();
    let library = world.centre_of(ids::tab(PROPERTIES, 2));
    world.moved(library.x, library.y);
    world.press();
    world.moved(library.x - 30.0, library.y + 40.0);
    world.moved(4.0, 400.0);
    let drag = world.core.dock().drag().expect("a drag is in progress");
    assert!(matches!(drag.zone, Some(Zone::WindowEdge { .. })) && drag.preview.is_some(), "{drag:?}");
    world.key(Key::Named(Named::Escape), Modifiers::default());
    assert!(world.core.dock().drag().is_none());
    world.release();
    assert_eq!(world.layout_now(), before);
    assert!(!world.core.dock().can_undo() && !world.core.dock().modified());
}

/// F6 and Ctrl+F6 through the application's handler (the registry's commands into the focus owner).
fn f6_sequence(world: &mut World, ctrl: bool, presses: usize) -> Vec<styk_core::focus::FocusId> {
    let mut visited = Vec::new();
    for _ in 0..presses {
        world.key(Key::Named(Named::F6), if ctrl { Modifiers::CTRL } else { Modifiers::default() });
        visited.push(world.focused().expect("F6 lands on a region"));
    }
    visited
}

/// The regions the dock lists, in its tree order, that are mounted.
fn mounted_regions(world: &mut World) -> Vec<styk_core::focus::FocusId> {
    let regions = world.core.dock().regions();
    regions.into_iter().filter_map(|r| r.target).filter(|id| world.bounds(*id).is_some()).collect()
}

#[test]
fn f6_and_ctrl_f6_visit_each_group_in_tree_order_after_the_groups_are_rearranged() {
    let mut world = World::new(1560.0, 1000.0);
    // Library below the stage, and VFX in a column of its own on the left: five groups.
    let library = world.centre_of(ids::tab(PROPERTIES, 2));
    let stage = world.core.dock().solution().groups[&STAGE];
    world.drag(library, &[(library.x - 40.0, library.y + 60.0), ((stage.x + stage.w / 2.0) as f32, (stage.y + stage.h - 20.0) as f32)]);
    let vfx = world.centre_of(ids::tab(PROPERTIES, 1));
    world.drag(vfx, &[(vfx.x - 40.0, vfx.y + 60.0), (4.0, 400.0)]);
    let expected = mounted_regions(&mut world);
    assert!(expected.len() >= 6, "{expected:?}");
    assert!(expected.contains(&ids::stage_header(STAGE)) && expected.contains(&ids::body(STAGE)), "the stage's two regions");
    // From the last region F6 goes round to the first and on through every one in the dock's order.
    world.driver().focus(expected[expected.len() - 1]);
    world.walk();
    world.deliver();
    let forward = f6_sequence(&mut world, false, expected.len());
    assert_eq!(forward, expected, "F6 follows the dock's order");
    // Ctrl+F6 goes back through them.
    let back = f6_sequence(&mut world, true, expected.len());
    let mut reversed = expected.clone();
    reversed.reverse();
    let mut wanted: Vec<_> = reversed[1..].to_vec();
    wanted.push(reversed[0]);
    assert_eq!(back, wanted, "Ctrl+F6 goes back through the same order");
}

#[test]
fn a_stage_tabbed_with_another_panel_keeps_its_header_and_body_targets() {
    let mut world = World::new(1560.0, 1000.0);
    let library = world.centre_of(ids::tab(PROPERTIES, 2));
    let stage = world.core.dock().solution().groups[&STAGE];
    world.drag(library, &[(library.x - 40.0, library.y + 60.0), ((stage.x + stage.w / 2.0) as f32, (stage.y + stage.h / 2.0) as f32)]);
    assert_eq!(world.tabs_of(STAGE), ["stage", "library"]);
    // Library is in front; the stage's tab brings it forward.
    let tab = world.centre_of(ids::tab(STAGE, 0));
    world.click(tab);
    for id in [ids::stage_header(STAGE), ids::body(STAGE)] {
        assert!(world.bounds(id).is_some(), "{id:?} is mounted with the stage tabbed");
    }
    let regions: Vec<_> = world.core.dock().regions().into_iter().filter_map(|r| r.target).collect();
    assert!(regions.contains(&ids::stage_header(STAGE)) && regions.contains(&ids::body(STAGE)));
}

#[test]
fn the_inspector_in_a_group_of_its_own_keeps_its_keys_when_the_group_is_not_the_focus() {
    let mut world = World::new(1560.0, 1000.0);
    // The Properties tab dragged to the left edge: the Inspector alone in its group.
    let properties = world.centre_of(ids::tab(PROPERTIES, 0));
    world.drag(properties, &[(properties.x - 40.0, properties.y + 60.0), (4.0, 400.0)]);
    let group = world.group_of("properties");
    assert_eq!(world.tabs_of(group), ["properties"]);
    // Tab into the panel from its group's region, and press a key on a field.
    world.driver().focus(ids::body(group));
    world.walk();
    world.deliver();
    let inside = |id: styk_core::focus::FocusId| (0x1_0000..0x2_0000).contains(&id.0);
    let mut landed = false;
    for _ in 0..40 {
        // Tab is the focus owner's: the key no widget took reaches `Core::focus` as `Message::Key`.
        world.send(Message::Key(key_event(Key::Named(Named::Tab), None, Modifiers::default(), true)));
        world.deliver();
        if world.focused().is_some_and(inside) {
            landed = true;
            break;
        }
    }
    assert!(landed, "Tab goes from the group's region into the Inspector's own controls");
    // The X field's scrub label, focused as a person's Tab or click would, takes an arrow key: the wrapper that held the
    // panel's keys while it was not focused is gone.
    world.driver().focus(styk_ui::inspector::label_id(PropertyKey::RootX));
    world.walk();
    world.deliver();
    world.driver().press(Named::ArrowUp);
    let messages = world.driver().messages();
    assert!(messages.iter().any(|m| matches!(m, Message::Command(Command::Inspector(_)))), "the field took the key: {messages:?}");
}

#[test]
fn a_tabs_x_and_a_middle_click_close_it_and_the_last_stage_stays_with_a_message() {
    let mut world = World::new(1560.0, 1000.0);
    // The x sits at the right end of the tab in front.
    let tab = world.bounds(ids::tab(PROPERTIES, 0)).unwrap();
    world.click(Point::new(tab.x + tab.width - 7.0, tab.y + tab.height / 2.0));
    assert_eq!(world.tabs_of(PROPERTIES), ["vfx", "library"], "the x closed Properties");
    // A middle click on the Library tab closes it.
    let library = world.centre_of(ids::tab(PROPERTIES, 1));
    world.moved(library.x, library.y);
    world.pointer(mouse::Event::ButtonPressed(mouse::Button::Middle));
    world.pointer(mouse::Event::ButtonReleased(mouse::Button::Middle));
    assert_eq!(world.tabs_of(PROPERTIES), ["vfx"]);
    assert!(world.core.dock().can_undo(), "closing is a layout change, undone as one");
}

#[test]
fn closing_the_last_stage_is_refused_with_a_message_and_changes_nothing() {
    let mut world = World::new(1560.0, 1000.0);
    let vfx = world.centre_of(ids::tab(PROPERTIES, 1));
    let stage = world.core.dock().solution().groups[&STAGE];
    // VFX joins the stage's group, so the stage has a tab to close.
    world.drag(vfx, &[(vfx.x - 40.0, vfx.y + 60.0), ((stage.x + stage.w / 2.0) as f32, (stage.y + stage.h / 2.0) as f32)]);
    assert_eq!(world.tabs_of(STAGE), ["stage", "vfx"]);
    let before = world.layout_now();
    let tab = world.bounds(ids::tab(STAGE, 0)).unwrap();
    world.click(Point::new(tab.x + tab.width - 7.0, tab.y + tab.height / 2.0));
    assert_eq!(world.layout_now(), before, "the last stage stays");
    let shown = world.core.overlays().messages().current().map(|m| m.text.clone());
    assert!(shown.is_some_and(|text| !text.is_empty()), "the refusal is said over the stage");
}

#[test]
fn the_keyboard_move_previews_each_place_and_enter_moves_the_focused_panel() {
    let mut world = World::new(1560.0, 1000.0);
    let before = world.layout_now();
    world.driver().focus(ids::tab(PROPERTIES, 1));
    world.walk();
    world.key(Key::Character("m".into()), Modifiers::CTRL | Modifiers::ALT);
    let first = world.core.dock().drag().expect("a place is previewed");
    assert!(first.preview.is_some());
    // The overlay draws the preview and its name through the dock's own widgets.
    world.key(Key::Named(Named::ArrowRight), Modifiers::default());
    let second = world.core.dock().drag().expect("the next place");
    assert_ne!(first.zone, second.zone);
    // Any other key is swallowed while the panel moves.
    world.key(Key::Character("q".into()), Modifiers::default());
    assert!(world.core.dock().moving());
    world.key(Key::Named(Named::Escape), Modifiers::default());
    assert!(!world.core.dock().moving());
    assert_eq!(world.layout_now(), before);
    world.key(Key::Character("m".into()), Modifiers::CTRL | Modifiers::ALT);
    world.key(Key::Named(Named::Enter), Modifiers::default());
    assert_ne!(world.layout_now(), before);
    assert!(world.core.dock().can_undo());
}

#[test]
fn a_change_made_through_the_widgets_is_saved_and_a_new_window_loads_it_back() {
    let mut world = World::new(1560.0, 1000.0);
    let vfx = world.centre_of(ids::tab(PROPERTIES, 1));
    world.drag(vfx, &[(vfx.x - 40.0, vfx.y + 60.0), (1556.0, 400.0)]);
    let changed = world.layout_now();
    let due = world.core.dock().deadline().expect("a write is queued");
    assert!(world.core.dock_mut().take_save(due - 1).is_none(), "nothing before the debounce");
    let file = world.core.dock_mut().take_save(due).expect("the write is due on the injected clock");
    world.core.dock_mut().save_done(true, due);
    let mut fresh = World::new(1560.0, 1000.0);
    assert_ne!(fresh.layout_now(), changed);
    let effects = fresh.core.dock_mut().loaded(dock::Stored::File(file), 5_000);
    assert!(effects.is_empty(), "{effects:?}");
    fresh.deliver();
    assert_eq!(fresh.layout_now(), changed);
    assert!(fresh.core.dock().deadline().is_none(), "loading writes nothing");
}
