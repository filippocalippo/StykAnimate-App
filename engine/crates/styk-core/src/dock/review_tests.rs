//! Regressions for the dock integration, exercised at the layout, store and dispatch owners.
use super::*;
use crate::commands::{Command, CommandId};
use crate::layout::{Axis, Side, spec};
use styk_services::{Cancel, storage::fake::MemoryStorage, worker::run_future};
use std::sync::Arc;

fn dock(writer: &str) -> Dock { Dock::new(Size { w: 1440., h: 900. }, 1., writer) }
fn panel(kind: &str) -> PanelId { PanelId::new(kind) }
fn save(dock: &mut Dock, store: &crate::layout::LayoutStore, now: u64) {
    let file = dock.take_save(now).expect("due write");
    run_future(store.save(&file, now, &Cancel::new())).unwrap();
    dock.save_done(true, now);
}
fn load(store: &crate::layout::LayoutStore) -> LayoutFile { run_future(store.load()).unwrap().unwrap() }

#[test]
fn review_restart_new_edit_survives_real_store_merge() {
    let store = crate::layout::LayoutStore::new(Arc::new(MemoryStorage::default()));
    let mut first = dock("process-one");
    first.set_wall_time(1_800_000_600_000);
    first.handle(Event::Close(panel("vfx")), 600_000);
    save(&mut first, &store, 600_200);
    let mut second = dock("process-two");
    second.loaded(Stored::File(load(&store)), 0);
    second.set_wall_time(1_800_000_700_100);
    second.handle(Event::Close(panel("library")), 100);
    assert_eq!(second.file.workspaces["animate"].stamp.millis, 1_800_000_700_100);
    assert_eq!(second.file.workspaces["animate"].stamp.writer, "process-two");
    assert_eq!(second.deadline(), Some(300));
    let expected = second.layout().clone();
    save(&mut second, &store, 300);
    let mut third = dock("process-three");
    third.loaded(Stored::File(load(&store)), 0);
    assert_eq!(third.layout(), &expected, "an edit soon after restart must beat a previous process's uptime");
}

#[test]
fn review_late_load_then_other_workspace_edit_preserves_both() {
    let store = crate::layout::LayoutStore::new(Arc::new(MemoryStorage::default()));
    let mut old = dock("old");
    old.handle(Event::Close(panel("library")), 1);
    save(&mut old, &store, 201);
    let mut next = dock("new");
    next.handle(Event::Close(panel("vfx")), 500);
    let animate = next.layout().clone();
    next.loaded(Stored::File(load(&store)), 510);
    next.handle(Event::Workspace(Workspace::Draw), 520);
    next.handle(Event::Close(panel("properties")), 530);
    let draw = next.layout().clone();
    save(&mut next, &store, 730);
    let mut restarted = dock("restart");
    restarted.loaded(Stored::File(load(&store)), 0);
    assert_eq!(restarted.layout(), &animate);
    restarted.handle(Event::Workspace(Workspace::Draw), 1);
    assert_eq!(restarted.layout(), &draw);
}

#[test]
fn review_resize_preview_cannot_erase_a_later_edit_on_cancel() {
    let mut d = dock("test");
    let divider = d.dividers().into_iter().find(|d| d.axis == Axis::Horizontal).unwrap().clone();
    d.handle(Event::DividerPressed { split: divider.split, index: divider.index }, 1);
    d.handle(Event::DividerMoved(-50.), 2);
    d.handle(Event::Close(panel("vfx")), 3);
    d.handle(Event::Escape, 4);
    assert!(d.layout().closed.contains(&panel("vfx")), "a new edit ends the old preview first");
    d.handle(Event::Undo, 5);
    assert!(!d.can_undo());
    assert!(!d.modified());
}

#[test]
fn review_reset_uses_panel_preference_and_one_policy() {
    let mut d = dock("test");
    let divider = d.dividers().into_iter().find(|d| d.axis == Axis::Vertical).unwrap().clone();
    let mut direct = d.layout().clone();
    direct.apply(Operation::ResetDivider { split: divider.split, index: divider.index }, Workspace::Animate).unwrap();
    let solved = solve(&direct, &Env::new(1440., 900.));
    assert_eq!(solved.groups[&3].h, spec("timeline").unwrap().pref.h);
    d.handle(Event::DividerReset { split: divider.split, index: divider.index }, 1);
    assert_eq!(d.layout(), &direct, "mounted reset and Operation::ResetDivider share a policy");
}

#[test]
fn review_solver_places_open_flyouts_at_each_strip_edge() {
    for side in [Side::Left, Side::Right, Side::Top, Side::Bottom] {
        let mut l = crate::layout::essentials(Workspace::Animate);
        l.apply(Operation::Move(panel("properties"), Zone::WindowEdge { side }), Workspace::Animate).unwrap();
        let id = l.groups().into_iter().find(|g| g.tabs.contains(&panel("properties"))).unwrap().id;
        l.apply(Operation::Collapse(id, true), Workspace::Animate).unwrap();
        let mut env = Env::new(1440., 900.);
        env.open = Some(id);
        let s = solve(&l, &env);
        let strip = s.strips[&id];
        let r = s.sheets[&id];
        match side {
            Side::Left => assert_eq!(r.x, strip.x + strip.w + 8., "left flyout"),
            Side::Right => assert_eq!(r.x + r.w, strip.x - 8., "right flyout"),
            Side::Top => assert_eq!(r.y, strip.y + strip.h + 8., "top flyout"),
            Side::Bottom => assert_eq!(r.y + r.h, strip.y - 8., "bottom flyout"),
        }
        assert!(r.x >= 0. && r.y >= 0. && r.x + r.w <= 1440. && r.y + r.h <= 900.);
        // A sheet (no strip) anchors at the same side of the main content rectangle.
        l.apply(Operation::Collapse(id, false), Workspace::Animate).unwrap();
        env.previous.folded.insert(id, crate::layout::Fold::Sheet);
        env.previous.release.insert(id, Size { w: 1600., h: 1000. });
        let sheet = solve(&l, &env);
        assert!(!sheet.strips.contains_key(&id));
        let r = sheet.sheets[&id];
        match side {
            Side::Left => assert_eq!(r.x, 8.),
            Side::Right => assert_eq!(r.x + r.w, 1432.),
            Side::Top => assert_eq!(r.y, 60.),
            Side::Bottom => assert_eq!(r.y + r.h, 892.),
        }
        assert!(r.w > 0. && r.h > 0.);
    }
}

#[test]
fn review_compact_folds_bottom_without_changing_stored_layout() {
    let mut d = dock("test");
    let before = d.layout().clone();
    d.handle(Event::Resized { width: 720., height: 800., scale: 1. }, 0);
    assert!(d.solution().strips.contains_key(&3));
    assert_eq!(d.layout(), &before);
}

#[test]
fn review_layout_commands_are_registered_and_dispatch_to_dock() {
    let undo = CommandId::from_id("layout-undo").expect("layout undo has registry metadata");
    let mut core = crate::app::Core::default();
    core.dispatch(Command::Dock(Event::Close(panel("vfx"))));
    core.dispatch(Command::Run(undo));
    assert!(!core.dock().layout().closed.contains(&panel("vfx")));
    core.focus_mut().register(crate::focus::ScopeId::ROOT, vec![crate::focus::FocusTarget::new(ids::tab(2, 0).0, crate::focus::FocusArea::Panels, crate::focus::TargetKind::Control)]);
    core.focus_mut().focus(ids::tab(2, 0));
    core.dispatch(Command::Run(CommandId::LayoutArrange));
    assert!(core.dock().moving());
}

#[test]
fn review_registered_panel_commands_open_toggle_and_close_sheets() {
    let mut core = crate::app::Core::default();
    core.dispatch(Command::Dock(Event::Resized { width: 720., height: 800., scale: 1. }));
    core.dispatch(Command::Run(CommandId::PanelToggleProperties));
    assert_eq!(core.dock().open(), Some(2));
    core.dispatch(Command::Run(CommandId::PanelHideProperties));
    assert_eq!(core.dock().open(), None);
    assert!(core.dock().layout().closed.contains(&panel("properties")));
    core.dispatch(Command::Run(CommandId::PanelToggleProperties));
    assert!(core.dock().solution().visible.contains(&panel("properties")));
}

#[test]
fn review_panel_titles_use_catalogue_keys() {
    let en = crate::i18n::Presentation::english();
    let de = crate::i18n::Presentation::new("de").unwrap();
    for kind in ["stage", "layers", "tools"] {
        let key = Dock::title_key(kind).expect("all built-in panel titles are messages");
        let msg = crate::i18n::Msg::new(key);
        assert_ne!(en.text(&msg), key);
        assert_ne!(de.text(&msg), key);
    }
}

#[test]
fn review_focus_region_commands_reach_focus_owner() {
    use crate::focus::{FocusArea, FocusTarget, ScopeId, TargetKind};
    let mut core = crate::app::Core::default();
    core.focus_mut().register(ScopeId::ROOT, vec![FocusTarget::new(1, FocusArea::TopBand, TargetKind::Control), FocusTarget::new(ids::body(1).0, FocusArea::Stage, TargetKind::Control)]);
    core.focus_mut().focus(crate::focus::FocusId(1));
    core.dispatch(Command::Run(CommandId::FocusNextRegion));
    assert_eq!(core.focus().focused(), Some(ids::body(1)));
}

#[test]
fn review_close_tab_already_protects_last_stage_atomically() {
    let mut l = crate::layout::essentials(Workspace::Animate);
    let original = l.clone();
    assert_eq!(l.apply(Operation::Close(panel("stage")), Workspace::Animate), Err(LayoutError::LastStage));
    assert_eq!(l, original);
    l.apply(Operation::NewStage, Workspace::Animate).unwrap();
    l.apply(Operation::Close(panel("stage")), Workspace::Animate).unwrap();
    assert!(l.closed.contains(&panel("stage")));
    l.validate(Workspace::Animate).unwrap();
}

#[test]
fn review_stamps_order_same_millisecond_edits_and_clock_rollback() {
    let store = crate::layout::LayoutStore::new(Arc::new(MemoryStorage::default()));
    let mut d = dock("writer");
    d.set_wall_time(1_800_000_000_000);
    for (now, kind) in [(1, "vfx"), (202, "library"), (403, "properties")] {
        if now == 403 { d.set_wall_time(1_799_000_000_000); }
        d.handle(Event::Close(panel(kind)), now);
        save(&mut d, &store, now + 200);
    }
    let persisted = load(&store);
    assert_eq!(persisted.workspaces["animate"].stamp.millis, 1_800_000_000_002);
    assert_eq!(state_from_value(&persisted.workspaces["animate"].value, Workspace::Animate).unwrap().current, *d.layout());
    assert_eq!(d.deadline(), None);
}

#[test]
fn review_layout_shortcuts_use_exact_shared_bindings_and_field_gates() {
    use crate::shortcuts::{Input, Platform, Scope, resolve};
    use crate::text_entry::Chord;
    for (code, command) in [("KeyZ", CommandId::LayoutUndo), ("KeyM", CommandId::LayoutArrange)] {
        let chord = Chord::new(code, true, true, false);
        for scope in Scope::ALL {
            assert_eq!(resolve(&chord, &[scope], Platform::Control, true).map(|a| a.command), Some(command));
        }
        for (shift, meta, alt_graph) in [(true, false, false), (false, true, false), (false, false, true)] {
            let extra = Chord { shift, meta, alt_graph, ..chord.clone() };
            assert!(resolve(&extra, &Scope::ALL, Platform::Control, true).is_none(), "extra modifiers must not arrange/undo");
        }
    }
    let mut core = crate::app::Core::default();
    core.dispatch(Command::Dock(Event::Close(panel("vfx"))));
    let chord = Chord::new("KeyZ", true, true, false);
    assert!(core.dock_shortcut(&chord, Input::default()).is_some());
    assert!(!core.dock().can_undo());
    use crate::focus::{FocusArea, FocusTarget, ScopeId, TargetKind};
    core.focus_mut().register(ScopeId::ROOT, vec![FocusTarget::new(ids::tab(2, 0).0, FocusArea::DockGroup(2), TargetKind::TextEntry)]);
    core.focus_mut().focus(ids::tab(2, 0));
    assert!(core.dock_shortcut(&chord, Input::default()).is_none(), "layout undo does not steal field history");
    assert!(core.dock_shortcut(&Chord::new("KeyM", true, true, false), Input::default()).is_some());
    assert!(core.dock().moving());
}

#[test]
fn review_regions_follow_tree_order_and_keep_tabbed_stage_body() {
    use crate::focus::{FocusArea as A, FocusState, FocusTarget, ScopeId, TargetKind};
    let mut d = dock("test");
    let mut next = d.layout().clone();
    next.apply(Operation::Move(panel("library"), Zone::WindowEdge { side: Side::Left }), Workspace::Animate).unwrap();
    next.apply(Operation::Move(panel("vfx"), Zone::Tab { group: 1, index: 0 }), Workspace::Animate).unwrap();
    next.apply(Operation::Activate(1, 1), Workspace::Animate).unwrap();
    d.commit(next, &mut Vec::new());
    let library = d.layout().groups().into_iter().find(|g| g.tabs.contains(&panel("library"))).unwrap().id;
    assert!(library > 3, "new group has a later identity but comes first in tree order");
    let regions = d.regions();
    let areas: Vec<_> = regions.iter().map(|r| r.area).collect();
    assert_eq!(areas, [A::TopBand, A::Tools, A::DockGroup(library), A::DockGroup(1), A::DockGroup(2), A::DockGroup(3), A::StageHeader(1), A::StageBody(1)]);
    assert_eq!(d.focus_target(&panel("stage")), Some(ids::body(1)), "a tabbed stage still gets body input");
    let expected: Vec<_> = regions.iter().filter_map(|r| r.target).collect();
    // Registration/identity order is deliberately different; active tab wins over earlier roving children.
    let mut targets: Vec<_> = regions.iter().rev().filter_map(|r| r.target.map(|id| FocusTarget::new(id.0, r.area, TargetKind::Control))).collect();
    targets.insert(0, FocusTarget::new(ids::tab(1, 0).0, A::DockGroup(1), TargetKind::Control));
    let mut f = FocusState::new();
    f.register(ScopeId::ROOT, targets);
    f.set_regions(regions);
    let visited: Vec<_> = (0..expected.len()).map(|_| f.cycle_area(true).unwrap()).collect();
    assert_eq!(visited, expected);
    let back: Vec<_> = (0..expected.len()).map(|_| f.cycle_area(false).unwrap()).collect();
    // We started at the last body: previous regions then a wrap back to that body.
    assert_eq!(back, expected[..expected.len()-1].iter().rev().copied().chain(expected.last().copied()).collect::<Vec<_>>());
    d.handle(Event::Close(panel("library")), 1);
    assert!(!d.regions().iter().any(|r| r.area == A::DockGroup(library)));
    d.handle(Event::Open { group: 2, tab: 0 }, 2);
    d.handle(Event::Resized { width: 720., height: 800., scale: 1. }, 3);
    assert!(d.regions().iter().any(|r| r.area == A::DockStrip(3)));
    assert!(!d.regions().iter().any(|r| r.area == A::DockGroup(3)));
}

#[test]
fn review_inner_panel_fields_get_group_regions_without_losing_input_roles() {
    use crate::focus::{FocusArea as A, FocusId, FocusTarget, ScopeId, TargetKind};
    let mut core = crate::app::Core::default();
    let rect = core.dock().solution().groups[&2];
    let mut field = FocusTarget::new(99, A::Panels, TargetKind::TextEntry);
    field.area = core.dock().focus_area(field.id, Some(Rect { x: rect.x + 8., y: rect.y + 60., w: 80., h: 24. }), field.area);
    assert_eq!(field.area, A::DockGroup(2));
    core.focus_mut().register(ScopeId::ROOT, vec![field]);
    core.focus_mut().focus(FocusId(99));
    assert_eq!(core.focus().text_entry(), Some(FocusId(99)));
    core.dispatch(Command::Run(CommandId::LayoutArrange));
    assert_eq!(core.dock().drag().unwrap().source, panel("properties"));
}

#[test]
fn review_messages_keep_parameters_until_presentation_and_reuse_translations() {
    let mut d = dock("test");
    let effects = d.loaded(Stored::Unreadable("damaged".into()), 0);
    let Effect::Message(msg) = &effects[0] else { panic!("message"); };
    assert_eq!(msg.key, "dock.layoutsUnreadable");
    assert_eq!(msg.params, vec![("reason".into(), "damaged".into())]);
    let en = crate::i18n::Presentation::english();
    assert_eq!(en.text(msg), "Your saved layouts could not be read (damaged); the defaults are shown.");
    let de = crate::i18n::Presentation::new("de").unwrap();
    let left = zone_label(&Zone::WindowEdge { side: Side::Left });
    assert_eq!(left.key, "dockKeyboard.dockLeft");
    assert_ne!(en.text(&left), de.text(&left));
    for side in [Side::Left, Side::Right, Side::Top, Side::Bottom] {
        let label = zone_label(&Zone::Split { group: 1, side });
        assert_ne!(en.text(&label), label.key);
    }
}

#[test]
fn review_layout_owns_divider_history_limit_cancel_and_noop() {
    let mut state = LayoutState::new(crate::layout::essentials(Workspace::Animate));
    let base = state.current.clone();
    for _ in 0..24 {
        let solution = solve(&state.current, &Env::new(1440., 900.));
        let divider = solution.dividers.iter().find(|d| d.axis == Axis::Horizontal).unwrap();
        let mut drag = crate::layout::DividerDrag::new(&state.current, &solution, divider.split, divider.index);
        drag.moved(-1., Workspace::Animate).unwrap();
        drag.moved(-2., Workspace::Animate).unwrap();
        assert!(drag.release(&mut state, Workspace::Animate).unwrap());
    }
    assert_eq!(state.history.len(), 20);
    assert!(state.dirty);
    let before = state.current.clone();
    let solution = solve(&state.current, &Env::new(1440., 900.));
    let divider = &solution.dividers[0];
    let mut cancelled = crate::layout::DividerDrag::new(&state.current, &solution, divider.split, divider.index);
    cancelled.moved(20., Workspace::Animate).unwrap();
    drop(cancelled);
    assert_eq!(state.current, before);
    assert_eq!(state.history.len(), 20);
    let noop = crate::layout::DividerDrag::new(&state.current, &solution, divider.split, divider.index);
    assert!(!noop.release(&mut state, Workspace::Animate).unwrap());
    assert_eq!(state.history.len(), 20);
    for _ in 0..20 { assert!(state.undo()); }
    assert!(!state.undo());
    assert_ne!(state.current, base, "four oldest completed edits were evicted");
}
