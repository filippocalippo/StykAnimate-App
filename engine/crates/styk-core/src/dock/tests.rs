use super::*;
use crate::layout::{Side, store::LayoutFile};
use std::sync::Arc;
use styk_services::{Cancel, storage::fake::MemoryStorage, worker::run_future};

const STAGE: GroupId = 1;
const PROPERTIES: GroupId = 2;
const TIMELINE: GroupId = 3;

fn dock(w: f64, h: f64) -> Dock {
    Dock::new(Size { w, h }, 1.0, "test")
}

fn panel(kind: &str) -> PanelId {
    PanelId::new(kind)
}

fn group_of(dock: &Dock, kind: &str) -> GroupId {
    dock.layout().groups().into_iter().find(|g| g.tabs.contains(&panel(kind))).map(|g| g.id).unwrap_or_else(|| panic!("{kind} is in no group"))
}

fn rect_of(dock: &Dock, kind: &str) -> Rect {
    let id = group_of(dock, kind);
    dock.solution().groups.get(&id).or(dock.solution().strips.get(&id)).copied().unwrap_or_else(|| panic!("{kind} has no rectangle"))
}

fn centre(r: Rect) -> (f64, f64) {
    (r.x + r.w / 2.0, r.y + r.h / 2.0)
}

/// Two presses on the empty part of `group`'s header: a double click.
fn double_click(dock: &mut Dock, group: GroupId, now: u64) -> Vec<Effect> {
    let at = dock.solution().headers[&group];
    let (x, y) = (at.x + at.w - 10.0, at.y + 20.0);
    let mut effects = Vec::new();
    for _ in 0..2 {
        effects = dock.handle(Event::HeaderPressed { group, tab: None, x, y }, now);
        dock.handle(Event::PointerReleased, now);
    }
    effects
}

/// Presses a tab of `group`, moves through `path` and lets go; returns the effects of the release.
fn drag(dock: &mut Dock, group: GroupId, tab: Option<usize>, path: &[(f64, f64)], now: u64) -> Vec<Effect> {
    let start = centre(dock.solution().headers[&group]);
    dock.handle(Event::HeaderPressed { group, tab, x: start.0, y: start.1 }, now);
    for (x, y) in path {
        dock.handle(Event::PointerMoved { x: *x, y: *y }, now);
    }
    dock.handle(Event::PointerReleased, now)
}

#[test]
fn the_default_window_is_todays_at_1560_and_1440() {
    // Rectangles measured in today's window (Chromium, the same sizes).
    let wide = dock(1560.0, 1000.0);
    let s = wide.solution();
    assert_eq!(s.groups[&STAGE], Rect { x: 8.0, y: 60.0, w: 1216.0, h: 646.0 });
    assert_eq!(s.groups[&PROPERTIES], Rect { x: 1232.0, y: 60.0, w: 320.0, h: 646.0 });
    assert_eq!(s.groups[&TIMELINE], Rect { x: 8.0, y: 712.0, w: 1544.0, h: 280.0 });
    let regular = dock(1440.0, 900.0);
    let s = regular.solution();
    assert_eq!(s.groups[&STAGE], Rect { x: 8.0, y: 60.0, w: 1096.0, h: 546.0 });
    assert_eq!(s.groups[&PROPERTIES], Rect { x: 1112.0, y: 60.0, w: 320.0, h: 546.0 });
    assert_eq!(s.groups[&TIMELINE], Rect { x: 8.0, y: 612.0, w: 1424.0, h: 280.0 });
    // 900 x 700: the timeline's 264.
    assert_eq!(dock(900.0, 700.0).solution().groups[&TIMELINE].h, 264.0);
}

#[test]
fn the_default_timeline_height_follows_the_window_height_as_today_does() {
    for (height, body) in [(1000.0, 264.0), (801.0, 264.0), (800.0, 248.0), (641.0, 248.0), (640.0, 224.0), (600.0, 224.0), (599.0, 196.0), (569.0, 196.0), (568.0, 40.0)] {
        assert_eq!(default_timeline_height(height), body + 16.0, "a window {height} tall");
    }
}

#[test]
fn a_tab_dropped_on_each_window_edge_docks_there_and_each_is_one_undo() {
    for (side, point) in [(Side::Left, (6.0, 400.0)), (Side::Right, (1553.0, 400.0)), (Side::Top, (700.0, 6.0)), (Side::Bottom, (700.0, 993.0))] {
        let mut d = dock(1560.0, 1000.0);
        let before = d.layout().clone();
        drag(&mut d, PROPERTIES, Some(1), &[(1300.0, 100.0), point], 10);
        let moved = rect_of(&d, "vfx");
        match side {
            Side::Left => assert!(moved.x <= 8.0 + 0.5 && moved.w > 0.0, "vfx at the left edge: {moved:?}"),
            Side::Right => assert!((moved.x + moved.w - 1552.0).abs() < 1.0, "vfx at the right edge: {moved:?}"),
            Side::Top => assert!(moved.y <= 60.5 && moved.w > 1000.0, "vfx across the top: {moved:?}"),
            Side::Bottom => assert!((moved.y + moved.h - 992.0).abs() < 1.0 && moved.w > 1000.0, "vfx across the bottom: {moved:?}"),
        }
        assert!(d.modified());
        d.handle(Event::Undo, 20);
        assert_eq!(*d.layout(), before, "one undo puts the arrangement back ({side:?})");
    }
}

#[test]
fn a_tab_dropped_on_the_bottom_quarter_of_the_stage_splits_it_below() {
    let mut d = dock(1560.0, 1000.0);
    let stage = d.solution().groups[&STAGE];
    drag(&mut d, PROPERTIES, Some(2), &[(stage.x + 400.0, stage.y + 300.0), (stage.x + stage.w / 2.0, stage.y + stage.h - 20.0)], 10);
    let (library, stage_after) = (rect_of(&d, "library"), rect_of(&d, "stage"));
    assert!((library.y - (stage_after.y + stage_after.h)).abs() <= 8.5, "library sits under the stage: {library:?} under {stage_after:?}");
    assert_eq!(library.x, stage_after.x);
    assert_eq!(library.w, stage_after.w);
}

#[test]
fn a_tab_dropped_on_another_group_joins_it_and_a_tab_dropped_in_its_own_header_reorders() {
    let mut d = dock(1560.0, 1000.0);
    // Dragging Library to the front of its own header.
    let header = d.solution().headers[&PROPERTIES];
    drag(&mut d, PROPERTIES, Some(2), &[(header.x + 120.0, header.y + 10.0), (header.x + 4.0, header.y + 10.0)], 10);
    let tabs: Vec<_> = d.layout().groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.tabs.iter().map(|p| p.kind.clone()).collect()).unwrap_or_default();
    assert_eq!(tabs, ["library", "properties", "vfx"]);
    // The stage's group takes a tab dropped on its middle.
    let stage = d.solution().groups[&STAGE];
    drag(&mut d, PROPERTIES, Some(0), &[(stage.x + 300.0, stage.y + 300.0), centre(stage)], 20);
    assert!(d.layout().groups().into_iter().any(|g| g.id == STAGE && g.tabs.contains(&panel("library"))), "library is a tab of the stage's group now");
}

#[test]
fn a_press_that_stays_inside_the_slop_is_a_click_and_never_a_drag() {
    let mut d = dock(1560.0, 1000.0);
    let (x, y) = centre(d.solution().headers[&PROPERTIES]);
    d.handle(Event::HeaderPressed { group: PROPERTIES, tab: Some(1), x, y }, 5);
    d.handle(Event::PointerMoved { x: x + 3.0, y: y + 2.0 }, 5);
    assert!(d.drag().is_none() && d.tracking(), "3.6 px is inside the 4 px slop");
    d.handle(Event::PointerReleased, 6);
    d.handle(Event::TabSelected { group: PROPERTIES, index: 1 }, 6);
    assert!(!d.dragging() && !d.tracking());
    assert_eq!(d.layout().groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.active), Some(1), "the click activated the tab");
    // Past the slop it is a drag, and the click that follows its release activates nothing.
    d.handle(Event::HeaderPressed { group: PROPERTIES, tab: Some(1), x, y }, 2_000);
    d.handle(Event::PointerMoved { x: x + 4.0, y }, 2_000);
    assert!(d.drag().is_some(), "4 px is a drag");
    d.handle(Event::PointerReleased, 2_001);
    d.handle(Event::TabSelected { group: PROPERTIES, index: 2 }, 2_001);
    assert_eq!(d.layout().groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.active), Some(1), "the click after a drag was swallowed");
}

#[test]
fn escape_and_blur_cancel_a_drag_and_leave_the_arrangement_as_it_was() {
    for cancel in [Event::Escape, Event::Blur] {
        let mut d = dock(1560.0, 1000.0);
        let before = d.layout().clone();
        let start = centre(d.solution().headers[&PROPERTIES]);
        d.handle(Event::HeaderPressed { group: PROPERTIES, tab: Some(1), x: start.0, y: start.1 }, 1);
        d.handle(Event::PointerMoved { x: 400.0, y: 300.0 }, 1);
        assert!(d.drag().is_some_and(|v| v.preview.is_some()), "the preview shows while the pointer is over a place");
        d.handle(cancel.clone(), 2);
        assert!(d.drag().is_none() && !d.tracking());
        d.handle(Event::PointerReleased, 3);
        assert_eq!(*d.layout(), before, "{cancel:?} cancelled the drop");
        assert!(!d.modified() && !d.can_undo());
    }
}

#[test]
fn shift_forces_float_and_part_one_refuses_it_visibly() {
    let mut d = dock(1560.0, 1000.0);
    let before = d.layout().clone();
    let start = centre(d.solution().headers[&PROPERTIES]);
    d.handle(Event::Shift(true), 1);
    d.handle(Event::HeaderPressed { group: PROPERTIES, tab: Some(1), x: start.0, y: start.1 }, 1);
    d.handle(Event::PointerMoved { x: 400.0, y: 300.0 }, 1);
    assert_eq!(d.drag().map(|v| v.label), Some("Float here"));
    let effects = d.handle(Event::PointerReleased, 2);
    assert!(effects.iter().any(|e| matches!(e, Effect::Message(text) if text.contains("not available yet"))), "{effects:?}");
    assert_eq!(*d.layout(), before);
    // Dropped outside every window the same refusal answers, with or without Shift.
    d.handle(Event::Shift(false), 3);
    d.handle(Event::HeaderPressed { group: PROPERTIES, tab: Some(1), x: start.0, y: start.1 }, 3);
    d.handle(Event::PointerMoved { x: 400.0, y: 20.0 }, 3);
    assert_eq!(d.drag().and_then(|v| v.zone).map(|z| matches!(z, Zone::Float { .. })), Some(true));
    let effects = d.handle(Event::PointerReleased, 4);
    assert!(effects.iter().any(|e| matches!(e, Effect::Message(_))));
    assert_eq!(*d.layout(), before);
}

#[test]
fn a_double_click_on_a_header_collapses_the_group_to_a_strip_and_again_expands_it() {
    let mut d = dock(1560.0, 1000.0);
    double_click(&mut d, PROPERTIES, 1);
    assert!(d.solution().strips.contains_key(&PROPERTIES), "a collapsed group at the window's edge is a strip");
    assert!(!d.solution().groups.contains_key(&PROPERTIES));
    assert!(d.solution().groups[&STAGE].w > 1216.0, "the stage took its room");
    // A collapsed group has no header: its strip opens a flyout, and the flyout's pin expands it.
    d.handle(Event::Open { group: PROPERTIES, tab: 0 }, 2);
    d.handle(Event::Pin(PROPERTIES), 3);
    assert!(d.solution().groups.contains_key(&PROPERTIES));
    // The stage cannot collapse: the core refuses and the dock says so.
    let effects = double_click(&mut d, STAGE, 4);
    assert!(effects.iter().any(|e| matches!(e, Effect::Message(_))) && d.solution().groups.contains_key(&STAGE));
}

#[test]
fn a_strip_opens_a_flyout_that_escape_closes_and_pin_expands_the_group() {
    let mut d = dock(1560.0, 1000.0);
    double_click(&mut d, PROPERTIES, 1);
    d.handle(Event::Open { group: PROPERTIES, tab: 1 }, 2);
    assert_eq!(d.open(), Some(PROPERTIES));
    assert!(d.solution().sheets.contains_key(&PROPERTIES), "the flyout is placed");
    let focus = d.handle(Event::Escape, 3);
    assert_eq!(d.open(), None);
    assert!(focus.iter().any(|e| matches!(e, Effect::Focus(p) if p.kind == "vfx")), "focus returns to the group's tab: {focus:?}");
    d.handle(Event::Open { group: PROPERTIES, tab: 0 }, 4);
    d.handle(Event::Pin(PROPERTIES), 5);
    assert_eq!(d.open(), None);
    assert!(d.solution().groups.contains_key(&PROPERTIES), "pinned: expanded again");
}

#[test]
fn a_divider_resizes_live_as_one_history_entry_and_escape_restores_the_start() {
    let mut d = dock(1560.0, 1000.0);
    let divider = d.solution().dividers.iter().find(|x| x.axis == crate::layout::Axis::Horizontal).cloned().expect("the stage and the inspector are split");
    let before = d.layout().clone();
    d.handle(Event::DividerPressed { split: divider.split, index: divider.index }, 1);
    d.handle(Event::DividerMoved(-40.0), 1);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 360.0, "the inspector grew by 40 with the pointer");
    d.handle(Event::DividerMoved(-90.0), 1);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 410.0);
    d.handle(Event::DividerReleased, 2);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 410.0);
    d.handle(Event::Undo, 3);
    assert_eq!(*d.layout(), before, "the whole drag was one undo");
    // Escape in the middle of a drag.
    d.handle(Event::DividerPressed { split: divider.split, index: divider.index }, 4);
    d.handle(Event::DividerMoved(-40.0), 4);
    d.handle(Event::Escape, 5);
    d.handle(Event::DividerReleased, 5);
    assert_eq!(*d.layout(), before);
    assert!(!d.can_undo());
    // Past its limits the divider stops at the group's largest limit.
    d.handle(Event::DividerPressed { split: divider.split, index: divider.index }, 6);
    d.handle(Event::DividerMoved(-900.0), 6);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 460.0, "the largest of its panels' limits: Library's");
    d.handle(Event::DividerReleased, 7);
}

#[test]
fn a_double_click_on_a_divider_resets_to_todays_default_sizes() {
    let mut d = dock(1560.0, 1000.0);
    let vertical = d.solution().dividers.iter().find(|x| x.axis == crate::layout::Axis::Vertical).cloned().expect("the timeline is under the stage");
    d.handle(Event::DividerPressed { split: vertical.split, index: vertical.index }, 1);
    d.handle(Event::DividerMoved(-100.0), 1);
    d.handle(Event::DividerReleased, 1);
    assert_eq!(d.solution().groups[&TIMELINE].h, 380.0);
    d.handle(Event::DividerReset { split: vertical.split, index: vertical.index }, 2);
    assert_eq!(d.solution().groups[&TIMELINE].h, 280.0, "the timeline's default height, not the column default");
    let horizontal = d.solution().dividers.iter().find(|x| x.axis == crate::layout::Axis::Horizontal).cloned().expect("a column divider");
    d.handle(Event::DividerStep { split: horizontal.split, index: horizontal.index, direction: -1, shift: false }, 3);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 332.0, "an arrow key moves 12 px");
    d.handle(Event::DividerStep { split: horizontal.split, index: horizontal.index, direction: -1, shift: true }, 4);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 372.0, "with Shift 40");
    d.handle(Event::DividerReset { split: horizontal.split, index: horizontal.index }, 5);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 320.0);
}

#[test]
fn the_right_dock_folds_to_a_sheet_at_800_and_unfolds_only_past_the_hysteresis() {
    let at = |d: &mut Dock, width: f64| {
        d.handle(Event::Resized { width, height: 800.0, scale: 1.0 }, 1);
        d.solution().groups.contains_key(&PROPERTIES)
    };
    let mut d = dock(1000.0, 800.0);
    assert!(at(&mut d, 1000.0));
    assert!(!at(&mut d, 800.0), "800 and under folds the right dock");
    assert!(d.solution().sheets.contains_key(&PROPERTIES), "to a sheet");
    assert!(!at(&mut d, 810.0), "810 is still folded: the dock waits for 816");
    assert!(at(&mut d, 820.0), "820 unfolds it");
    assert!(at(&mut d, 805.0), "and 805 does not fold it again until 800");
    assert!(!at(&mut d, 790.0));
    // The stored arrangement was never touched by the fitting.
    assert!(!d.modified() && !d.can_undo());
}

#[test]
fn a_sheet_opens_over_the_stage_and_closes_with_escape() {
    let mut d = dock(720.0, 800.0);
    assert!(d.solution().sheets.contains_key(&PROPERTIES) || d.solution().strips.contains_key(&PROPERTIES));
    d.handle(Event::Open { group: PROPERTIES, tab: 0 }, 1);
    assert_eq!(d.open(), Some(PROPERTIES));
    let sheet = d.solution().sheets[&PROPERTIES];
    assert!(sheet.w > 0.0 && sheet.h > 0.0);
    d.handle(Event::Escape, 2);
    assert_eq!(d.open(), None);
}

#[test]
fn the_keyboard_move_steps_through_places_the_core_accepts_and_escape_leaves_the_panel() {
    let mut d = dock(1560.0, 1000.0);
    let before = d.layout().clone();
    d.handle(Event::MoveByKeyboard(panel("vfx")), 1);
    let first = d.drag().expect("a place is shown");
    assert!(first.preview.is_some() && !first.label.is_empty());
    d.handle(Event::MoveStep(1), 2);
    let second = d.drag().expect("the next place");
    assert_ne!(first.zone, second.zone);
    d.handle(Event::MoveStep(-1), 3);
    assert_eq!(d.drag().map(|v| v.zone), Some(first.zone.clone()));
    d.handle(Event::Escape, 4);
    assert!(d.drag().is_none());
    assert_eq!(*d.layout(), before);
    d.handle(Event::MoveByKeyboard(panel("vfx")), 5);
    d.handle(Event::MoveCommit, 6);
    assert_ne!(*d.layout(), before, "Enter moved it");
    d.handle(Event::Undo, 7);
    assert_eq!(*d.layout(), before);
}

#[test]
fn a_closed_panel_comes_back_where_it_was_and_the_last_stage_stays() {
    let mut d = dock(1560.0, 1000.0);
    let before = d.layout().clone();
    d.handle(Event::Close(panel("vfx")), 1);
    assert!(!d.layout().groups().iter().any(|g| g.tabs.contains(&panel("vfx"))));
    d.handle(Event::Reopen(panel("vfx")), 2);
    assert_eq!(group_of(&d, "vfx"), PROPERTIES);
    assert_eq!(d.layout().groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.tabs.clone()), before.groups().into_iter().find(|g| g.id == PROPERTIES).map(|g| g.tabs.clone()));
    let effects = d.handle(Event::Close(panel("stage")), 3);
    assert!(effects.iter().any(|e| matches!(e, Effect::Message(text) if text.contains("last stage"))), "{effects:?}");
}

#[test]
fn the_workspace_switch_shows_its_own_arrangement() {
    let mut d = dock(1560.0, 1000.0);
    d.handle(Event::Close(panel("vfx")), 1);
    d.handle(Event::Workspace(Workspace::Draw), 2);
    assert!(d.layout().groups().iter().any(|g| g.tabs.contains(&panel("vfx"))), "Draw has its own arrangement");
    d.handle(Event::Workspace(Workspace::Animate), 3);
    assert!(!d.layout().groups().iter().any(|g| g.tabs.contains(&panel("vfx"))));
}

fn saved_through(storage: &Arc<MemoryStorage>, dock: &mut Dock, now: u64) {
    let store = crate::layout::LayoutStore::new(storage.clone());
    let file = dock.take_save(now).expect("a write is due");
    run_future(store.save(&file, now, &Cancel::new())).expect("the write lands");
    dock.save_done(true, now);
}

#[test]
fn a_change_is_saved_after_the_debounce_on_the_injected_clock_and_reloads_as_it_was() {
    let storage = Arc::new(MemoryStorage::default());
    let store = crate::layout::LayoutStore::new(storage.clone());
    let mut d = dock(1560.0, 1000.0);
    assert_eq!(d.deadline(), None, "nothing is written for a window nobody changed");
    drag(&mut d, PROPERTIES, Some(1), &[(1300.0, 100.0), (6.0, 400.0)], 1_000);
    assert_eq!(d.deadline(), Some(1_200), "200 ms after the change");
    assert!(d.take_save(1_199).is_none(), "not before the debounce");
    // A second change within the window moves the deadline and coalesces into one write.
    let library = group_of(&d, "library");
    double_click(&mut d, library, 1_100);
    assert_eq!(d.deadline(), Some(1_300));
    saved_through(&storage, &mut d, 1_300);
    assert_eq!(d.deadline(), None);
    let expected = d.layout().clone();
    let mut again = dock(1560.0, 1000.0);
    let file = run_future(store.load()).expect("readable").expect("stored");
    again.loaded(Stored::File(file), 2_000);
    assert_eq!(*again.layout(), expected, "the stored arrangement is the one that was saved");
    assert_eq!(again.deadline(), None, "loading writes nothing");
    // The other workspaces were not written, and keep their defaults.
    again.handle(Event::Workspace(Workspace::Draw), 2_001);
    assert_eq!(*again.layout(), dock(1560.0, 1000.0).states[1].current);
}

#[test]
fn a_failed_write_is_retried_and_a_newer_file_is_never_overwritten() {
    let mut d = dock(1560.0, 1000.0);
    double_click(&mut d, PROPERTIES, 1_000);
    assert!(d.take_save(1_200).is_some());
    d.save_done(false, 1_200);
    assert_eq!(d.deadline(), Some(1_400), "retried after the backoff");
    assert!(d.take_save(1_400).is_some());
    d.save_done(true, 1_400);
    assert_eq!(d.deadline(), None);
    let mut newer = dock(1560.0, 1000.0);
    let effects = newer.loaded(Stored::Newer, 5);
    assert!(effects.iter().any(|e| matches!(e, Effect::Message(_))));
    double_click(&mut newer, PROPERTIES, 10);
    assert_eq!(newer.deadline(), None, "a newer file is read-only");
    assert!(newer.take_save(10_000).is_none());
}

#[test]
fn a_change_made_before_the_stored_layout_arrives_is_kept() {
    let storage = Arc::new(MemoryStorage::default());
    let store = crate::layout::LayoutStore::new(storage.clone());
    let mut first = dock(1560.0, 1000.0);
    first.handle(Event::Close(panel("library")), 1);
    saved_through(&storage, &mut first, 300);
    let mut d = dock(1560.0, 1000.0);
    double_click(&mut d, PROPERTIES, 5);
    let mine = d.layout().clone();
    let file = run_future(store.load()).expect("readable").expect("stored");
    d.loaded(Stored::File(file), 10);
    assert_eq!(*d.layout(), mine, "the person's own change wins over the arrival");
}

fn legacy(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).expect("test profile parses")
}

#[test]
fn the_first_launch_imports_todays_layout_and_keeps_its_saved_layouts() {
    // Today's workspace-preferences: Animate with Library hidden, the right dock 360 wide, the timeline 300 tall.
    let profile = legacy(
        r#"{"version":2,"shared":{"stamp":1,"sizes":{"right":360,"bottom":300,"left":232}},
        "modes":{"animate":{"stamp":1,"preset":"animate","rail":"left","bottomSpan":"full","panels":[
          {"id":"properties","dock":"right","order":0,"active":true},
          {"id":"vfx","dock":"right","order":1},
          {"id":"library","dock":"hidden","order":2},
          {"id":"timeline","dock":"bottom","order":3}]}},
        "saved":[{"id":"u1","name":"My review","mode":"animate","stamp":2,"arrangement":{"rail":"left","bottomSpan":"full","panels":[
          {"id":"properties","dock":"right","order":0},{"id":"timeline","dock":"bottom","order":1}]}}]}"#,
    );
    let mut d = dock(1560.0, 1000.0);
    let effects = d.loaded(Stored::Legacy(profile), 100);
    assert!(!effects.iter().any(|e| matches!(e, Effect::Message(text) if text.contains("could not"))), "{effects:?}");
    assert_eq!(rect_of(&d, "properties").w, 360.0, "the stored right width");
    assert_eq!(rect_of(&d, "timeline").h, 300.0, "the stored timeline height");
    assert!(d.layout().closed.contains(&panel("library")), "the hidden panel is closed, not lost");
    assert_eq!(d.deadline(), Some(300), "the import is written once");
    let file = d.take_save(300).expect("the import is queued");
    assert!(file.user.values().any(|e| e.value.get("name").and_then(Value::as_str) == Some("My review")), "the saved layout came across");
    assert!(file.workspaces.contains_key("animate") && file.workspaces.contains_key("draw") && file.workspaces.contains_key("rig"));
}

#[test]
fn an_imported_profile_without_a_stored_timeline_height_gets_todays_default_for_the_window() {
    let profile = legacy(r#"{"version":2,"modes":{"animate":{"stamp":1,"preset":"animate","rail":"left","bottomSpan":"full","panels":[{"id":"properties","dock":"right","order":0},{"id":"timeline","dock":"bottom","order":1}]}}}"#);
    let mut d = dock(1440.0, 900.0);
    d.loaded(Stored::Legacy(profile), 1);
    assert_eq!(rect_of(&d, "timeline").h, 280.0);
}

#[test]
fn nothing_stored_and_nothing_to_import_leaves_the_defaults_and_writes_nothing() {
    let mut d = dock(1560.0, 1000.0);
    let before = d.layout().clone();
    assert!(d.loaded(Stored::Nothing, 1).is_empty());
    assert_eq!(*d.layout(), before);
    assert_eq!(d.deadline(), None);
    let unreadable = d.loaded(Stored::Unreadable("damaged".into()), 2);
    assert!(unreadable.iter().any(|e| matches!(e, Effect::Message(_))));
    assert_eq!(*d.layout(), before);
}

#[test]
fn a_damaged_workspace_entry_falls_back_to_the_default_and_says_so() {
    let mut d = dock(1560.0, 1000.0);
    let before = d.layout().clone();
    let mut file = LayoutFile::default();
    file.workspaces.insert("animate".into(), Entry { stamp: Stamp { millis: 1, writer: "x".into() }, value: styk_doc::json::parse(b"{\"current\":{}}").expect("parses") });
    let effects = d.loaded(Stored::File(file), 3);
    assert!(effects.iter().any(|e| matches!(e, Effect::Message(_))), "{effects:?}");
    assert_eq!(*d.layout(), before);
}

#[test]
fn dock_effects_become_core_effects() {
    let mut core = crate::app::Core::default();
    let effects = core.dock_effects(vec![Effect::Focus(panel("vfx")), Effect::Message("hello".into())]);
    assert!(effects.iter().any(|e| matches!(e, crate::commands::Effect::FocusTarget(id) if *id == ids::tab(PROPERTIES, 1))));
    assert_eq!(core.overlays().messages().current().map(|m| m.text.as_str()), Some("hello"));
}

#[test]
fn the_dock_is_reached_through_the_one_dispatch_and_follows_the_window() {
    let mut core = crate::app::Core::default();
    let effects = core.dispatch(crate::commands::Command::Dock(Event::Resized { width: 1440.0, height: 900.0, scale: 1.0 }));
    assert!(effects.is_empty());
    assert_eq!(core.dock().solution().groups[&STAGE].w, 1096.0);
    let at = core.dock().solution().headers[&PROPERTIES];
    for _ in 0..2 {
        core.dispatch(crate::commands::Command::Dock(Event::HeaderPressed { group: PROPERTIES, tab: None, x: at.x + at.w - 10.0, y: at.y + 20.0 }));
        core.dispatch(crate::commands::Command::Dock(Event::PointerReleased));
    }
    assert!(core.dock().solution().strips.contains_key(&PROPERTIES));
}


#[test]
fn the_compact_window_folds_the_right_dock_to_a_sheet_and_keeps_the_timeline_docked_as_today_does() {
    // Today's window at 720 x 800: the stage over the timeline's island, the inspector a sheet behind the band's button.
    let d = dock(720.0, 800.0);
    let s = d.solution();
    assert_eq!(s.groups[&STAGE], Rect { x: 8.0, y: 50.0, w: 704.0, h: 478.0 });
    assert_eq!(s.groups[&TIMELINE], Rect { x: 8.0, y: 528.0, w: 704.0, h: 264.0 });
    assert!(s.sheets.contains_key(&PROPERTIES) && !s.groups.contains_key(&PROPERTIES));
    // The divider beside the sheet has nothing to resize; the one between the stage and the timeline does.
    let usable = d.dividers();
    assert_eq!(usable.len(), 1);
    assert_eq!(usable[0].axis, crate::layout::Axis::Vertical);
    // A low window folds the timeline to its strip.
    assert!(dock(1000.0, 560.0).solution().strips.contains_key(&TIMELINE));
}

#[test]
fn two_presses_on_a_divider_in_a_double_click_reset_it_and_a_drag_between_them_does_not() {
    let mut d = dock(1560.0, 1000.0);
    let divider = d.dividers().into_iter().find(|x| x.axis == crate::layout::Axis::Horizontal).cloned().expect("a column divider");
    let (split, index) = (divider.split, divider.index);
    d.handle(Event::DividerPressed { split, index }, 100);
    d.handle(Event::DividerMoved(-60.0), 100);
    d.handle(Event::DividerReleased, 101);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 380.0);
    // The press that began a drag is not the first click of a double click.
    d.handle(Event::DividerPressed { split, index }, 200);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 380.0);
    d.handle(Event::DividerReleased, 201);
    d.handle(Event::DividerPressed { split, index }, 300);
    d.handle(Event::DividerReleased, 301);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 320.0, "the second press within 500 ms reset it");
    d.handle(Event::DividerPressed { split, index }, 5_000);
    d.handle(Event::DividerMoved(-10.0), 5_000);
    d.handle(Event::DividerReleased, 5_001);
    assert_eq!(d.solution().groups[&PROPERTIES].w, 330.0, "a press long after the last is a new first click");
}
