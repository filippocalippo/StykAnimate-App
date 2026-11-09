//! The application menus against today's: every row of the mark's menu and the six menus it leads with, in three states, as
//! `src/application-menu.mjs` and `showMenu` build them (`tests/support/menus-reference.mjs` runs them in Node), and the way a
//! row reaches `Core::dispatch`.
#![cfg(feature = "engine")]
use std::process::Command;
use styk_core::app::Core;
use styk_core::commands::{Command as AppCommand, CommandId, Effect};
use styk_core::engine::{Value, json};
use styk_core::i18n::Presentation;
use styk_core::menus::{self, AppMenu, Desktop, Facts};
use styk_core::overlay::host::Event;
use styk_core::overlay::menu::{Entry, Item, RowAction};
use styk_core::shortcuts::{Platform, Scope};

fn reference() -> Value {
    let output = Command::new("node").arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/menus-reference.mjs")).output().expect("Node is a required source-parity prerequisite");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    json::parse(&output.stdout).unwrap()
}

/// One native entry list against today's rows: separators, commands, labels, glyphs, keys, states, submenus.
fn same(path: &str, native: &[Entry], today: &[Value]) {
    assert_eq!(native.len(), today.len(), "{path}: {} rows against today's {}", native.len(), today.len());
    for (at, (entry, row)) in native.iter().zip(today).enumerate() {
        let here = format!("{path}[{at}]");
        if matches!(row, Value::Null) {
            assert_eq!(entry, &Entry::Separator, "{here}: a separator");
            continue;
        }
        let Entry::Item(item) = entry else { panic!("{here}: an item, found {entry:?}") };
        let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        assert_eq!(item.label, text("label").unwrap(), "{here}: label");
        assert_eq!(item.icon, text("icon"), "{here}: glyph of {}", item.label);
        assert_eq!(item.disabled, row.get("disabled").and_then(Value::as_bool).unwrap(), "{here}: disabled, {}", item.label);
        assert_eq!(item.danger, row.get("danger").and_then(Value::as_bool).unwrap(), "{here}: red, {}", item.label);
        assert_eq!(item.checked, row.get("checked").and_then(Value::as_bool), "{here}: check, {}", item.label);
        match row.get("submenu").and_then(Value::as_arr) {
            Some(children) => same(&here, item.submenu.as_deref().unwrap_or_else(|| panic!("{here}: a submenu")), children),
            None => {
                assert!(item.submenu.is_none(), "{here}: no submenu");
                let RowAction::Command(command) = item.action else { panic!("{here}: a command row") };
                // Today's Panels rows run a closure, not a command: the native rows name the registry's panel commands (`menus` tests).
                if let Some(today) = text("command") {
                    assert_eq!(command.id(), today, "{here}: command of {}", item.label);
                }
                let hint = item.shortcuts(Platform::Control, true, &[Scope::Global]).text;
                assert_eq!(hint, text("shortcut").unwrap(), "{here}: key of {}", item.label);
            }
        }
    }
}

#[test]
fn every_row_of_every_menu_is_todays_in_three_states() {
    let today = reference();
    let english = Presentation::english();
    let states = [
        ("bare", Facts::default()),
        ("figure", Facts { figure: true, joint: true, ..Facts::default() }),
        ("web", Facts { desktop: Desktop::default(), ..Facts::default() }),
    ];
    for (name, facts) in states {
        let state = today.get(name).unwrap();
        let menus_today = state.get("menus").unwrap();
        for menu in AppMenu::ALL {
            let rows = menus_today.get(menu.id()).and_then(Value::as_arr).unwrap();
            same(&format!("{name}/{}", menu.id()), &menus::application(menu, &facts, &english), rows);
        }
        // The mark leads with the six menus as `{label, submenu}` rows (no command, no glyph), then today's rows.
        let mark = state.get("mark").and_then(Value::as_arr).unwrap();
        let native = menus::mark(&facts, &english);
        let (lead, rest) = (&native[..7], &native[7..]);
        for (at, (entry, menu)) in lead.iter().zip(AppMenu::ALL).enumerate() {
            let Entry::Item(item) = entry else { panic!("{name}: row {at} of the mark") };
            assert_eq!((item.label.as_str(), item.icon.as_deref()), (mark[at].get("label").and_then(Value::as_str).unwrap(), None));
            same(&format!("{name}/mark/{}", menu.id()), item.submenu.as_deref().unwrap(), mark[at].get("submenu").and_then(Value::as_arr).unwrap());
        }
        assert_eq!(lead[6], Entry::Separator);
        same(&format!("{name}/mark"), rest, &mark[7..]);
    }
}

#[test]
fn every_row_names_a_command_whose_label_is_in_the_catalogue_and_never_a_second_command_table() {
    let english = Presentation::english();
    let facts = Facts { figure: true, joint: true, ..Facts::default() };
    fn walk(entries: &[Entry], seen: &mut Vec<CommandId>) {
        for entry in entries {
            if let Entry::Item(Item { action: RowAction::Command(command), submenu: None, .. }) = entry {
                seen.push(*command);
            }
            if let Entry::Item(Item { submenu: Some(children), .. }) = entry { walk(children, seen); }
        }
    }
    let mut seen = Vec::new();
    walk(&menus::mark(&facts, &english), &mut seen);
    assert!(seen.len() > 80, "{} rows", seen.len());
    assert!(seen.iter().all(|command| CommandId::from_id(command.id()) == Some(*command)));
}

/// Opens the mark's menu through the command the band's button sends, then runs the row `label` of the open menu.
fn open_mark(core: &mut Core) -> Vec<Effect> {
    core.dispatch(AppCommand::Run(CommandId::Menu))
}

fn press(core: &mut Core, label: &str) -> Vec<Effect> {
    let menu = core.overlays().menus().last().expect("a menu is open");
    let index = menu.entries().iter().filter_map(|entry| if let Entry::Item(item) = entry { Some(item) } else { None }).position(|item| item.label == label).unwrap_or_else(|| panic!("{label} is in the menu"));
    let id = menu.id();
    core.dispatch(AppCommand::Overlay { event: Event::Press { menu: id, index }, now: 10 })
}

#[test]
fn the_mark_command_opens_the_menu_and_a_row_runs_its_command_through_dispatch() {
    let mut core = Core::default();
    open_mark(&mut core);
    let menus: Vec<_> = core.overlays().menus().iter().map(|menu| menu.entries().len()).collect();
    assert_eq!(menus.len(), 1);
    assert!(core.overlays().menu_of(styk_core::shell::ids::MARK).is_some(), "the mark's menu is open from the mark");
    // A command whose feature is not ported answers NotAvailable, and the menu closes.
    let effects = press(&mut core, "Export…");
    assert!(effects.contains(&Effect::NotAvailable(CommandId::Export)), "{effects:?}");
    assert!(core.overlays().menus().is_empty());
}

#[test]
fn a_press_on_a_submenu_row_opens_it_and_runs_nothing() {
    let mut core = Core::default();
    open_mark(&mut core);
    let effects = press(&mut core, "Edit");
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::NotAvailable(_))));
    assert_eq!(core.overlays().menus().len(), 2, "the Edit menu opened beside its row");
    let effects = press(&mut core, "Select all");
    assert!(core.overlays().menus().is_empty(), "{effects:?}");
}

#[test]
fn the_menus_follow_the_loop_setting_and_the_projects_that_are_open() {
    let core = Core::default();
    let facts = core.menu_facts();
    assert!(facts.on.contains(&CommandId::ToggleLoop), "Loop is on as the settings start");
    assert!(facts.projects.is_empty() && facts.front.is_none() && !facts.figure && !facts.joint);
}

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

/// The facts lane's thread.
struct Threads;

impl styk_services::Spawner for Threads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.to_owned()).spawn(job).map(|_| ()).map_err(|error| styk_services::SpawnError(error.to_string()))
    }
}

fn with_project() -> Core {
    styk_core::testing::core_with_document(STARTUP, "One.styk", std::sync::Arc::new(Threads)).unwrap()
}

#[test]
fn edit_undo_from_the_menu_undoes_the_projects_last_edit_and_redo_brings_it_back() {
    use styk_core::testing;
    let mut core = with_project();
    testing::settle_facts(&mut core).unwrap();
    // An edit through the registry: rotate the selected figure.
    core.dispatch(AppCommand::Run(CommandId::Rotate));
    assert_eq!(testing::undo_depth(&core), 1);
    open_mark(&mut core);
    press(&mut core, "Edit");
    let effects = press(&mut core, "Undo");
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::NotAvailable(_))), "{effects:?}");
    assert_eq!(testing::undo_depth(&core), 0, "the row ran Undo through Core::dispatch");
    assert!(core.overlays().menus().is_empty(), "choosing a command closes the whole tree");
    open_mark(&mut core);
    press(&mut core, "Edit");
    press(&mut core, "Redo");
    assert_eq!(testing::undo_depth(&core), 1, "and Redo restored it");
}

#[test]
fn the_selection_decides_which_rows_are_disabled_when_the_menu_opens() {
    use styk_core::testing;
    let mut core = with_project();
    testing::settle_facts(&mut core).unwrap();
    testing::call(&mut core, "select", "[null,-1]").unwrap();
    assert!(!core.menu_facts().figure, "nothing is selected");
    testing::select_all(&mut core).unwrap();
    testing::settle_facts(&mut core).unwrap();
    let facts = core.menu_facts();
    assert!(facts.figure, "selecting figures enables the rows that need one");
    assert!(!facts.joint, "a figure without a joint keeps the Joint menu off");
    open_mark(&mut core);
    let edit = core.overlays().menus()[0].entries().iter().find_map(|entry| match entry { Entry::Item(item) if item.label == "Edit" => item.submenu.clone(), _ => None }).unwrap();
    assert!(edit.iter().all(|entry| !matches!(entry, Entry::Item(item) if item.disabled)));
}

#[test]
fn two_open_projects_list_in_the_menu_and_choosing_one_brings_it_to_the_front() {
    use styk_core::testing;
    let mut core = with_project();
    let first = core.documents.active().unwrap().id();
    let second = testing::open_document(&mut core, STARTUP, "Two.styk").unwrap();
    assert_eq!(core.documents.active().map(|document| document.id()), Some(second));
    open_mark(&mut core);
    let rows = core.overlays().menus()[0].entries().iter().find_map(|entry| match entry { Entry::Item(item) if item.label == "Open projects" => item.submenu.clone(), _ => None }).expect("two projects add the submenu");
    let names: Vec<_> = rows.iter().filter_map(|entry| if let Entry::Item(item) = entry { Some((item.label.clone(), item.checked)) } else { None }).collect();
    assert_eq!(names, [("One".to_owned(), Some(false)), ("Two".to_owned(), Some(true))]);
    press(&mut core, "Open projects");
    press(&mut core, "One");
    assert_eq!(core.documents.active().map(|document| document.id()), Some(first), "the row switched the project");
    assert!(core.overlays().menus().is_empty());
}

#[test]
fn opening_the_menu_scans_no_frame_and_the_joint_rows_wait_for_the_prepared_model() {
    use styk_core::testing;
    let mut core = with_project();
    testing::settle_facts(&mut core).unwrap();
    testing::call(&mut core, "select", "[1,0]").unwrap();
    let before = testing::frame_scans();
    let facts = core.menu_facts();
    open_mark(&mut core);
    assert_eq!(testing::frame_scans(), before, "reading the facts and opening the menu walked no frame (a count, not a time)");
    assert!(facts.figure && facts.joint, "a joint of a figure is selected and the model is ready: the Joint menu works");
    press(&mut core, "Joint");
    let joint = core.overlays().menus().last().unwrap().entries().iter().filter_map(|entry| if let Entry::Item(item) = entry { Some(item.disabled) } else { None }).collect::<Vec<_>>();
    assert!(joint.iter().all(|disabled| !disabled), "{joint:?}");
    core.dispatch(AppCommand::Overlay { event: Event::Escape, now: 20 });
    core.dispatch(AppCommand::Overlay { event: Event::Escape, now: 21 });
    assert!(core.overlays().menus().is_empty());
    // An edit makes the frame on show wait for its worker: until the model is prepared again the Joint rows stay disabled.
    core.dispatch(AppCommand::Run(CommandId::Rotate));
    assert!(core.inspector().pending(), "the frame on show is being made on a worker");
    let before = testing::frame_scans();
    let pending = core.menu_facts();
    assert_eq!(testing::frame_scans(), before, "and still nothing is scanned while it waits");
    assert!(pending.figure && !pending.joint, "the selection is known, the kind of figure is not yet");
    testing::settle_facts(&mut core).unwrap();
    assert!(core.menu_facts().joint, "the prepared model enables them again");
}
