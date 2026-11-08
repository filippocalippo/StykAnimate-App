use super::*;
use crate::focus::{FocusArea, TargetKind};
fn target(id: u64) -> FocusTarget {
    FocusTarget::new(id, FocusArea::Stage, TargetKind::Control)
}
fn page() -> FocusState {
    let mut f = FocusState::new();
    f.register(ScopeId::ROOT, vec![target(1), target(2)]);
    f.focus(FocusId(1));
    f
}
#[test]
fn stack_gate_passive_and_external_dialog() {
    let mut s = Stack::default();
    let mut f = page();
    for (i, k) in [Kind::Toast, Kind::Tooltip, Kind::Popover, Kind::Sheet]
        .into_iter()
        .enumerate()
    {
        s.open(Overlay::new(i as u64 + 10, k), &mut f, vec![], None)
            .unwrap();
        assert!(!s.blocks_hotkeys());
    }
    let effects = s
        .open(Overlay::new(20, Kind::Menu), &mut f, vec![target(20)], None)
        .unwrap();
    assert!(effects.contains(&Effect::ReleaseHeldKeys));
    s.finish(20, Reason::Selected, &mut f);
    assert!(!s.blocks_hotkeys());
    assert_eq!(
        s.external_dialog(true),
        vec![Effect::ReleaseHeldKeys, Effect::Blocking(true)]
    );
    assert_eq!(s.external_dialog(false), vec![Effect::Blocking(false)]);
}
#[test]
fn nested_focus_restore_and_removed_parent() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(
        Overlay::new(10, Kind::Dialog),
        &mut f,
        vec![target(10)],
        None,
    )
    .unwrap();
    let mut child = Overlay::new(11, Kind::Menu);
    child.parent = Some(10);
    s.open(child, &mut f, vec![target(11)], None).unwrap();
    s.finish(10, Reason::Removed, &mut f);
    assert_eq!(f.focused(), Some(FocusId(11)));
    s.escape(false, &mut f);
    assert_eq!(f.focused(), Some(FocusId(1)));
}
#[test]
fn removed_invoker_uses_s2a_nearest_target() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(Overlay::new(10, Kind::Menu), &mut f, vec![target(10)], None)
        .unwrap();
    f.register(ScopeId::ROOT, vec![target(2)]);
    s.escape(false, &mut f);
    assert_eq!(f.focused(), Some(FocusId(2)));
}
#[test]
fn guard_veto_duplicate_request_and_late_reply() {
    let mut s = Stack::default();
    let mut f = page();
    let mut e = Overlay::new(10, Kind::Dialog);
    e.guarded = true;
    s.open(e, &mut f, vec![target(10)], None).unwrap();
    assert_eq!(
        s.escape(false, &mut f),
        vec![Effect::CheckClose {
            id: 10,
            reason: Reason::Escape
        }]
    );
    assert!(s.escape(false, &mut f).is_empty());
    assert!(s.resolve_close(10, false, &mut f).is_empty());
    assert_eq!(s.entries().len(), 1);
    s.escape(false, &mut f);
    s.resolve_close(10, true, &mut f);
    assert!(s.entries().is_empty());
    assert!(s.resolve_close(10, true, &mut f).is_empty());
}
#[test]
fn context_release_composition_and_toggle() {
    let mut s = Stack::default();
    let mut f = page();
    let mut e = Overlay::new(10, Kind::Menu);
    e.anchor = Some(FocusId(1));
    s.open(e, &mut f, vec![target(10)], None).unwrap();
    assert!(s.pointer(false, false, None, &mut f).is_empty());
    assert!(s.escape(true, &mut f).is_empty());
    assert!(s.pointer(true, true, None, &mut f).is_empty());
    assert!(
        s.pointer(true, false, Some(FocusId(1)), &mut f)
            .contains(&Effect::Closed {
                id: 10,
                reason: Reason::Toggle
            })
    );
}
#[test]
fn close_all_stops_at_guard() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(Overlay::new(10, Kind::Menu), &mut f, vec![], None)
        .unwrap();
    let mut e = Overlay::new(11, Kind::Dialog);
    e.guarded = true;
    s.open(e, &mut f, vec![], None).unwrap();
    assert_eq!(
        s.close_all(&mut f),
        vec![Effect::CheckClose {
            id: 11,
            reason: Reason::CloseAll
        }]
    );
    s.resolve_close(11, false, &mut f);
    assert_eq!(s.entries().len(), 2);
}
fn item(label: &str) -> menu::Entry {
    menu::Entry::Item(menu::Item {
        label: label.into(),
        command: label.into(),
        ..Default::default()
    })
}
fn key(k: &str) -> menu::Key<'_> {
    menu::Key {
        key: k,
        ..Default::default()
    }
}
#[test]
fn menu_navigation_includes_disabled_rows_and_blocks_activation() {
    let mut disabled = menu::Item {
        label: "Disabled".into(),
        disabled: true,
        ..Default::default()
    };
    disabled.reason = "No document".into();
    let mut m = menu::Menu::new(vec![
        item("Alpha"),
        menu::Entry::Item(disabled),
        item("Beta"),
    ]);
    assert_eq!(m.key(key("ArrowUp"), 0), menu::Action::Move(2));
    assert_eq!(m.key(key("ArrowDown"), 0), menu::Action::Move(0));
    m.key(key("ArrowDown"), 0);
    assert_eq!(m.activate(), menu::Action::Swallow);
    assert_eq!(m.key(key("PageDown"), 0), menu::Action::Move(2));
    assert_eq!(m.key(key("PageUp"), 0), menu::Action::Move(0));
    assert_eq!(m.key(key("Tab"), 0), menu::Action::CloseTab);
    assert_eq!(
        m.key(
            menu::Key {
                composing: true,
                ..key("Escape")
            },
            0
        ),
        menu::Action::Swallow
    );
}
#[test]
fn menu_typeahead_repeats_and_expires_at_700() {
    let mut m = menu::Menu::new(vec![item("Alpha"), item("Another"), item("Beta")]);
    assert_eq!(m.key(key("a"), 0), menu::Action::Move(0));
    assert_eq!(m.key(key("a"), 1), menu::Action::Move(1));
    assert_eq!(m.key(key("b"), 701), menu::Action::Move(2));
    assert_eq!(m.key(key("e"), 702), menu::Action::Move(2));
    assert_eq!(
        m.key(
            menu::Key {
                ctrl: true,
                ..key("a")
            },
            703
        ),
        menu::Action::Swallow
    );
}
#[test]
fn menu_submenu_hover_rtl_and_keep_open() {
    let mut m = menu::Menu::new(vec![
        menu::Entry::Item(menu::Item {
            submenu: Some(vec![item("Child")]),
            ..Default::default()
        }),
        menu::Entry::Item(menu::Item {
            keep_open: true,
            checked: Some(false),
            command: "toggle".into(),
            ..Default::default()
        }),
    ]);
    m.rtl = true;
    m.focus(0);
    assert_eq!(m.key(key("ArrowLeft"), 0), menu::Action::OpenSubmenu(0));
    m.hover(0, 10);
    assert_eq!(m.tick(159), menu::Action::Swallow);
    assert_eq!(m.tick(160), menu::Action::OpenSubmenu(0));
    m.focus(1);
    assert_eq!(
        m.activate(),
        menu::Action::Activate {
            index: 1,
            command: "toggle".into(),
            close: false
        }
    );
    m.nested = true;
    assert_eq!(m.key(key("Escape"), 0), menu::Action::CloseSubmenu);
}
#[test]
fn normalized_menu_removes_hidden_empty_and_separators() {
    use menu::Entry::*;
    let out = menu::normalize(vec![
        Separator,
        Label("Group".into()),
        item("A"),
        Separator,
        Separator,
        Item(menu::Item {
            hidden: true,
            ..Default::default()
        }),
        Item(menu::Item {
            submenu: Some(vec![]),
            ..Default::default()
        }),
        Label("Empty".into()),
        Separator,
    ]);
    assert_eq!(out, vec![Label("Group".into()), item("A")]);
}
fn msg(id: u64, tone: messages::Tone) -> messages::Message {
    messages::Message::new(id, id.to_string(), tone, false, vec![])
}
#[test]
fn message_priorities_bounded_waiters_and_explicit_drops() {
    use messages::*;
    let mut q = Messages::default();
    q.push(msg(1, Tone::Error), 0);
    for id in 2..=4 {
        assert_eq!(q.push(msg(id, Tone::Info), 0).dropped, None);
    }
    assert_eq!(q.push(msg(5, Tone::Info), 0).dropped, Some(5));
    let mut recovery = msg(6, Tone::Info);
    recovery.priority = Priority::Recovery;
    assert_eq!(q.push(recovery, 0).dropped, Some(4));
    q.dismiss(1, 0);
    assert_eq!(q.current().unwrap().id, 6);
    assert_eq!(q.waiting().map(|r| r.id).collect::<Vec<_>>(), [2, 3]);
}
#[test]
fn displaced_persistent_waits_transient_drops() {
    use messages::*;
    let mut q = Messages::default();
    let mut persistent = msg(1, Tone::Info);
    persistent.timeout = 0;
    q.push(persistent, 0);
    assert_eq!(q.push(msg(2, Tone::Error), 1).dropped, None);
    q.dismiss(2, 2);
    assert_eq!(q.current().unwrap().id, 1);
    assert_eq!(q.tick(u64::MAX), None);
    q.dismiss(1, 3);
    q.push(msg(3, Tone::Info), 3);
    assert_eq!(q.push(msg(4, Tone::Error), 4).dropped, Some(3));
}
#[test]
fn message_timeout_duplicate_pause_and_focus() {
    use messages::*;
    let mut q = Messages::default();
    q.push(msg(1, Tone::Info), 0);
    assert_eq!(q.tick(3999), None);
    assert_eq!(q.push(msg(1, Tone::Info), 3999).duplicate, Some(1));
    assert_eq!(q.deadline(), Some(7999));
    q.interaction(true, false, 4999);
    q.interaction(false, true, 6000);
    assert_eq!(q.tick(10000), None);
    q.interaction(false, false, 10000);
    assert_eq!(q.deadline(), Some(13000));
    assert_eq!(q.tick(13000), Some(1));
}
#[test]
fn timeout_defaults_match_actions_not_waiting_count() {
    use messages::*;
    assert_eq!(msg(1, Tone::Warning).timeout, 6000);
    assert_eq!(msg(1, Tone::Success).timeout, 4000);
    assert_eq!(msg(1, Tone::Error).timeout, 0);
    let actions = vec![Action {
        command: "undo".into(),
        label: "Undo".into(),
        dismiss: true,
    }];
    assert_eq!(
        Message::new(1, "x", Tone::Info, false, actions.clone()).timeout,
        8000
    );
    assert_eq!(Message::new(1, "x", Tone::Info, true, actions).timeout, 0);
}
fn tip(id: u64) -> tooltip::Tip {
    tooltip::Tip {
        target: id,
        content: tooltip::Content {
            label: "Undo".into(),
            shortcut: "Ctrl+Z".into(),
        },
    }
}
#[test]
fn tooltip_delays_cancel_and_touch() {
    let mut t = tooltip::Tooltip::default();
    t.schedule(tip(1), 0, false, false);
    t.tick(499);
    assert!(t.visible().is_none());
    t.tick(500);
    assert_eq!(t.visible().unwrap().target, 1);
    t.hide(600);
    t.schedule(tip(2), 899, false, false);
    assert_eq!(t.visible().unwrap().target, 2);
    t.hide(900);
    t.schedule(tip(3), 1200, false, false);
    assert_eq!(t.deadline(), Some(1700));
    t.hide(1300);
    t.tick(2000);
    assert!(t.visible().is_none());
    t.schedule(tip(4), 2000, true, false);
    assert!(t.deadline().is_none());
    t.schedule(tip(4), 2000, true, true);
    t.tick(2500);
    assert!(t.visible().is_some());
}
#[test]
fn tooltip_content_suppression() {
    use tooltip::Content;
    assert!(Content::resolve(None, None, Some("Undo"), None, "Undo", "").is_none());
    assert!(Content::resolve(Some(""), None, Some("Undo"), None, "", "Ctrl+Z").is_none());
    assert_eq!(
        Content::resolve(None, Some(" Undo "), None, None, "Undo", " Ctrl+Z ")
            .unwrap()
            .shortcut,
        "Ctrl+Z"
    );
}
#[test]
fn tooltip_never_overlaps_invoker() {
    use placement::*;
    for height in [40., 340., 720.] {
        let anchor = Rect {
            x: 10.,
            y: 2.,
            width: 80.,
            height: 36.,
        };
        let p = tooltip::Tooltip::place(
            anchor,
            Size {
                width: 120.,
                height: 24.,
            },
            Size {
                width: 200.,
                height,
            },
            false,
            0.,
        );
        assert!(p.rect.y + p.rect.height <= anchor.y || p.rect.y >= anchor.y + anchor.height);
    }
}

#[test]
fn radio_activation_clears_only_its_group_and_plain_keep_open_closes() {
    use menu::{Action, Entry, Item, Menu};
    let radio = |group: &str, checked| {
        Entry::Item(Item {
            radio: true,
            checked: Some(checked),
            group: Some(group.into()),
            keep_open: true,
            ..Item::default()
        })
    };
    let mut m = Menu::new(vec![radio("a", true), radio("a", false), radio("b", true)]);
    m.focus(1);
    assert!(matches!(
        m.activate(),
        Action::Activate { close: false, .. }
    ));
    assert_eq!(
        m.items().map(|i| i.checked).collect::<Vec<_>>(),
        [Some(false), Some(true), Some(true)]
    );
    let mut m = Menu::new(vec![Entry::Item(Item {
        keep_open: true,
        ..Item::default()
    })]);
    m.focus(0);
    assert!(matches!(m.activate(), Action::Activate { close: true, .. }));
}

#[test]
fn stale_guard_reply_cannot_close_a_reused_identity() {
    let mut s = Stack::default();
    let mut f = page();
    let mut e = Overlay::new(10, Kind::Dialog);
    e.guarded = true;
    s.open(e.clone(), &mut f, vec![], None).unwrap();
    s.escape(false, &mut f);
    s.finish(10, Reason::Abort, &mut f);
    assert!(s.open(e, &mut f, vec![], None).is_err());
    s.open(Overlay::new(11, Kind::Dialog), &mut f, vec![], None)
        .unwrap();
    assert!(s.resolve_close(10, true, &mut f).is_empty());
    assert_eq!(s.entries().len(), 1);
}

#[test]
fn submenu_pointer_intent_closes_after_250_ms_and_cancels_on_return() {
    let mut m = menu::Menu::new(vec![
        menu::Entry::Item(menu::Item {
            submenu: Some(vec![item("Child")]),
            ..Default::default()
        }),
        item("Plain"),
    ]);
    m.submenu_opened(0);
    m.hover(1, 0);
    assert_eq!(m.tick(249), menu::Action::Swallow);
    m.hover(0, 249);
    assert_eq!(m.tick(250), menu::Action::Swallow);
    m.hover(1, 300);
    assert_eq!(m.tick(550), menu::Action::CloseChild);
    m.submenu_closed();
    m.hover(1, 600);
    assert_eq!(m.tick(1000), menu::Action::Swallow);
}

#[test]
fn outside_press_closes_the_whole_menu_tree_but_escape_only_the_child() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(Overlay::new(10, Kind::Menu), &mut f, vec![target(10)], None)
        .unwrap();
    let mut child = Overlay::new(11, Kind::Menu);
    child.parent = Some(10);
    s.open(child, &mut f, vec![target(11)], None).unwrap();
    s.escape(false, &mut f);
    assert_eq!(s.entries().len(), 1);
    let mut child = Overlay::new(12, Kind::Menu);
    child.parent = Some(10);
    s.open(child, &mut f, vec![target(12)], None).unwrap();
    s.pointer(true, false, None, &mut f);
    assert!(s.entries().is_empty());
    assert_eq!(f.focused(), Some(FocusId(1)));
}

#[test]
fn message_position_prefers_modal_then_slot_and_avoids_stage_controls() {
    use messages::{Position, position};
    use placement::{Rect, Size};
    let size = Size {
        width: 200.,
        height: 30.,
    };
    let stage = Some(Rect {
        x: 0.,
        y: 100.,
        width: 600.,
        height: 400.,
    });
    let slot = Some(Position { x: 300., top: 50. });
    assert_eq!(position(size, 720., stage, None, slot, &[], 50.), slot);
    assert_eq!(
        position(size, 720., stage, None, None, &[], 50.),
        Some(Position { x: 300., top: 462. })
    );
    let obstacle = Rect {
        x: 350.,
        y: 460.,
        width: 200.,
        height: 40.,
    };
    assert_eq!(
        position(size, 720., stage, None, None, &[obstacle], 50.),
        Some(Position { x: 242., top: 462. })
    );
    let obstacle = Rect {
        x: 50.,
        y: 460.,
        width: 500.,
        height: 40.,
    };
    assert_eq!(
        position(size, 720., stage, None, None, &[obstacle], 50.),
        Some(Position { x: 300., top: 422. })
    );
    let modal = Some(Rect {
        x: 100.,
        y: 200.,
        width: 300.,
        height: 300.,
    });
    assert_eq!(
        position(size, 720., stage, modal, slot, &[], 50.),
        Some(Position { x: 250., top: 162. })
    );
    let modal = Some(Rect {
        x: 100.,
        y: 55.,
        width: 300.,
        height: 300.,
    });
    assert_eq!(
        position(size, 720., stage, modal, slot, &[], 50.),
        Some(Position { x: 250., top: 363. })
    );
}
