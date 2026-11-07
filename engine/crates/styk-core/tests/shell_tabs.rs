//! The tab strip over real open projects: order, recency and the switcher's order in `Documents`, and the shell
//! driving them with the events the interface sends. No window.
use std::sync::Arc;

use styk_core::documents::{DocumentId, Documents, PreparedDocument, Value};
use styk_core::shell::band::{Item, Labels, Metrics};
use styk_core::shell::strip::TabState;
use styk_core::shell::workspace::{Effect as WorkspaceEffect, Report, Workspace};
use styk_core::shell::{Effect, Event, Shell, Window, switcher};
use styk_doc::json;
use styk_engine::{Budgets, Engine};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const LABELS: Labels = Labels { animate: 52.140625, draw: 32.8125, build: 31.453125, export: 38.875, cancel: 40.9375, test_rig: 43.375, done: 31.03125 };

fn engine() -> Engine {
    Engine::new(|| 0.0, Budgets::for_device(None))
}

fn open(documents: &mut Documents, engine: &Engine, name: &str) -> DocumentId {
    let prepared = PreparedDocument::open_bytes(engine, Arc::from(STARTUP), name, &|| false).expect("the fixture opens");
    documents.open(prepared).map_err(|(error, _)| error).expect("a tab opens")
}

fn call(documents: &mut Documents, id: DocumentId, name: &str, args: &str) {
    let args = json::parse(args.as_bytes()).expect("JSON");
    let args: Vec<Value> = args.elements().expect("an array").iter().collect();
    documents.call(id, name, &args, &Value::Null).expect("the project is in front").result.expect("the command runs");
}

fn order(documents: &Documents) -> Vec<DocumentId> {
    documents.tabs().iter().map(|tab| tab.id()).collect()
}

fn window(width: f32) -> Window {
    Window { width, height: 1000.0, ui_scale: 1.0, controls: true }
}

#[test]
fn recency_follows_the_project_in_front_and_the_successor_is_the_one_used_before() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let b = open(&mut documents, &engine, "B.styk");
    let c = open(&mut documents, &engine, "C.styk");
    assert_eq!(documents.recency(), [c, b, a], "a project opened is in front, then the ones before it");
    documents.activate(a).unwrap();
    assert_eq!(documents.recency(), [a, c, b]);
    assert_eq!(documents.successor(a), Some(c));
    assert_eq!(documents.successor(c), Some(a));
    documents.activate(b).unwrap();
    assert_eq!(documents.recency(), [b, a, c]);
    assert!(!documents.activate(b).unwrap());
    assert_eq!(documents.recency(), [b, a, c], "activating the project in front changes nothing");
}

#[test]
fn neighbour_goes_around_the_strip_and_move_reorders_without_changing_who_is_in_front() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let b = open(&mut documents, &engine, "B.styk");
    let c = open(&mut documents, &engine, "C.styk");
    assert_eq!(order(&documents), [a, b, c]);
    assert_eq!(documents.neighbour(1), Some(a), "around the end");
    assert_eq!(documents.neighbour(-1), Some(b));
    assert!(documents.move_tab(c, 0));
    assert_eq!(order(&documents), [c, a, b]);
    assert_eq!(documents.active().unwrap().id(), c, "moving a tab does not switch");
    assert!(!documents.move_tab(c, 0), "already there");
    assert!(documents.move_tab(c, 99), "past the end clamps to the end");
    assert_eq!(order(&documents), [a, b, c]);
    let mut one = Documents::new();
    open(&mut one, &engine, "Only.styk");
    assert_eq!(one.neighbour(1), None);
}

#[test]
fn ctrl_tab_held_shows_the_board_and_releasing_switches_to_the_project_used_before() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let b = open(&mut documents, &engine, "B.styk");
    let c = open(&mut documents, &engine, "C.styk");
    documents.activate(a).unwrap();
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    shell.sync(&documents);
    // Recency is a, c, b: the board starts on the project used before this one.
    shell.handle(&mut documents, Event::CtrlTab { backwards: false, held: true });
    let board = shell.board().expect("the board shows");
    assert_eq!(board.iter().map(|card| card.id).collect::<Vec<_>>(), [a, c, b]);
    assert_eq!(board.iter().position(|card| card.selected), Some(1));
    shell.handle(&mut documents, Event::CtrlTab { backwards: false, held: true });
    assert_eq!(shell.board().unwrap().iter().position(|card| card.selected), Some(2), "Tab moves along");
    let effects = shell.handle(&mut documents, Event::ModifierReleased);
    assert_eq!(effects, [Effect::Activated(b)]);
    assert_eq!(documents.active().unwrap().id(), b);
    assert!(shell.board().is_none());
    // Without a held modifier it switches at once, to the project used before: a, since b was in front.
    shell.handle(&mut documents, Event::CtrlTab { backwards: false, held: false });
    assert_eq!(documents.active().unwrap().id(), a);
}

#[test]
fn ctrl_page_down_and_up_step_through_the_tabs_around_the_ends() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let b = open(&mut documents, &engine, "B.styk");
    let c = open(&mut documents, &engine, "C.styk");
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    assert_eq!(shell.handle(&mut documents, Event::Neighbour(1)), [Effect::Activated(a)], "around the end");
    assert_eq!(shell.handle(&mut documents, Event::Neighbour(1)), [Effect::Activated(b)]);
    assert_eq!(shell.handle(&mut documents, Event::Neighbour(-1)), [Effect::Activated(a)]);
    assert_eq!(shell.handle(&mut documents, Event::Neighbour(-1)), [Effect::Activated(c)], "around the other end");
}

#[test]
fn escape_keeps_the_project_in_front_and_a_card_click_switches() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let b = open(&mut documents, &engine, "B.styk");
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    shell.handle(&mut documents, Event::CtrlTab { backwards: false, held: true });
    assert!(shell.handle(&mut documents, Event::SwitcherKey(switcher::Key::Escape)).is_empty());
    assert_eq!(documents.active().unwrap().id(), b);
    shell.handle(&mut documents, Event::CtrlTab { backwards: false, held: true });
    assert_eq!(shell.handle(&mut documents, Event::SwitcherPick(1)), [Effect::Activated(a)]);
    assert_eq!(documents.active().unwrap().id(), a);
}

#[test]
fn dragging_a_tab_across_another_reorders_the_strip_and_a_click_switches() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let b = open(&mut documents, &engine, "B.styk");
    let c = open(&mut documents, &engine, "C.styk");
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    shell.sync(&documents);
    let frames: Vec<_> = shell.layout().tabs().map(|(_, _, frame)| frame).collect();
    // A click on the first tab switches to it.
    let x = frames[0].x + 20.0;
    shell.handle(&mut documents, Event::TabPressed(a));
    assert!(shell.tracking());
    shell.handle(&mut documents, Event::PointerMoved(x));
    assert_eq!(shell.handle(&mut documents, Event::PointerReleased), [Effect::Activated(a)]);
    assert!(!shell.tracking());
    // A drag of the first tab onto the far half of the last one puts it last, and the line shows on the way.
    shell.handle(&mut documents, Event::TabPressed(a));
    shell.handle(&mut documents, Event::PointerMoved(x));
    shell.handle(&mut documents, Event::PointerMoved(frames[2].right() - 4.0));
    assert!(shell.tabs()[0].dragging);
    assert_eq!(shell.tabs()[2].drop, Some(styk_core::shell::strip::Side::After));
    let effects = shell.handle(&mut documents, Event::PointerReleased);
    assert_eq!(effects, [Effect::Moved(a, 2)]);
    assert_eq!(order(&documents), [b, c, a]);
    assert_eq!(shell.tabs().iter().map(|tab| tab.id).collect::<Vec<_>>(), [b, c, a], "the strip follows");
    assert!(shell.tabs()[2].drop.is_none() && !shell.tabs()[2].dragging);
    assert_eq!(documents.active().unwrap().id(), a, "a drag does not switch");
}

#[test]
fn a_tab_shows_unsaved_changes_and_undo_and_redo_run_on_the_project_in_front() {
    let engine = engine();
    let mut documents = Documents::new();
    let a = open(&mut documents, &engine, "A.styk");
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    shell.sync(&documents);
    assert!(shell.history().open && !shell.history().undo && !shell.history().redo);
    assert_eq!(shell.tabs()[0].state, None);
    assert!(shell.handle(&mut documents, Event::Undo).is_empty(), "nothing to undo");
    call(&mut documents, a, "setFPS", "[30]");
    shell.sync(&documents);
    assert_eq!(shell.tabs()[0].state, Some(TabState::Edited));
    assert!(shell.history().undo);
    assert_eq!(shell.handle(&mut documents, Event::Undo), [Effect::Edited]);
    assert_eq!(documents.get(a).unwrap().with_document(|typed| typed.fps).unwrap(), 24.0);
    assert_eq!(shell.tabs()[0].state, None, "undone to the saved state");
    assert!(shell.history().redo && !shell.history().undo);
    assert_eq!(shell.handle(&mut documents, Event::Redo), [Effect::Edited]);
    assert_eq!(documents.get(a).unwrap().with_document(|typed| typed.fps).unwrap(), 30.0);
    // A save in progress, then landed for a moment, then quiet.
    shell.handle(&mut documents, Event::SaveStarted(a));
    assert_eq!(shell.tabs()[0].state, Some(TabState::Saving));
    shell.handle(&mut documents, Event::SaveFailed(a));
    assert!(shell.tabs()[0].failed);
    assert_eq!(shell.tabs()[0].state, Some(TabState::Edited), "the project is still unsaved");
}

#[test]
fn the_workspace_switch_follows_the_sessions_reports_and_draw_waits_for_its_commit_on_the_way_out() {
    let engine = engine();
    let mut documents = Documents::new();
    open(&mut documents, &engine, "A.styk");
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    assert_eq!(shell.handle(&mut documents, Event::Workspace(Workspace::Draw)), [Effect::Workspace(WorkspaceEffect::EnterDrawing)]);
    shell.handle(&mut documents, Event::Report(Report::DrawingEntered));
    assert_eq!(shell.pressed(), Some(Workspace::Draw));
    assert_eq!(shell.handle(&mut documents, Event::Workspace(Workspace::Animate)), [Effect::Workspace(WorkspaceEffect::ExitDrawing)]);
    assert_eq!(shell.pressed(), Some(Workspace::Draw), "still Draw until the drawing commits");
    shell.handle(&mut documents, Event::Report(Report::DrawingExited(true)));
    assert_eq!(shell.pressed(), Some(Workspace::Animate));
}

#[test]
fn the_band_lays_out_one_tab_per_open_project_and_none_beyond_the_dot_step() {
    let engine = engine();
    let mut documents = Documents::new();
    for name in ["A.styk", "B.styk", "C.styk"] {
        open(&mut documents, &engine, name);
    }
    let mut shell = Shell::new(window(1560.0), Metrics::TODAY, LABELS);
    shell.sync(&documents);
    assert_eq!(shell.layout().tabs().count(), 3);
    shell.handle(&mut documents, Event::Resized(window(520.0)));
    assert_eq!(shell.layout().tabs().count(), 1);
    assert!(shell.layout().find(|item| matches!(item, Item::AddTab)).is_none());
}
