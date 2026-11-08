use super::*;
use crate::commands::CommandId;
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
    menu::Entry::Item(menu::Item::new(CommandId::Undo, label))
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
        ..menu::Item::new(CommandId::Menu, "")
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
            ..menu::Item::new(CommandId::Menu, "")
        }),
        menu::Entry::Item(menu::Item {
            keep_open: true,
            checked: Some(false),
            command: CommandId::ToggleGrid,
            ..menu::Item::new(CommandId::Menu, "")
        }),
    ]);
    m.rtl = true;
    m.focus(0);
    assert_eq!(m.key(key("ArrowLeft"), 0), menu::Action::OpenSubmenu(0));
    m.hover(0, 10);
    assert_eq!(m.tick(159), menu::Action::Swallow);
    assert_eq!(m.tick(160), menu::Action::OpenSubmenuHover(0));
    m.focus(1);
    assert_eq!(
        m.activate(),
        menu::Action::Activate {
            index: 1,
            command: CommandId::ToggleGrid,
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
            ..menu::Item::new(CommandId::Menu, "")
        }),
        Item(menu::Item {
            submenu: Some(vec![]),
            ..menu::Item::new(CommandId::Menu, "")
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
        command: CommandId::Undo,
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
            ..Item::new(CommandId::ToggleGrid, "")
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
        ..Item::new(CommandId::ToggleGrid, "")
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
            ..menu::Item::new(CommandId::Menu, "")
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

#[test]
fn review_hover_submenu_keeps_parent_focus_and_allows_ancestor_navigation() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(
        Overlay::new(10, Kind::Menu),
        &mut f,
        vec![target(10), target(12)],
        None,
    )
    .unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    s.open_with_focus(child, &mut f, vec![target(20)], OpenFocus::Keep)
        .unwrap();
    assert_eq!(
        f.focused(),
        Some(FocusId(10)),
        "ui-menu hover uses focus:none"
    );
    assert_eq!(
        f.focus(FocusId(12)),
        Some(FocusId(12)),
        "another ancestor row stays focusable"
    );
    assert_eq!(f.depth(), 2, "the whole menu tree is one scope");
}
#[test]
fn review_keyboard_submenu_can_return_to_ancestor_rows() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(
        Overlay::new(10, Kind::Menu),
        &mut f,
        vec![target(10), target(12)],
        None,
    )
    .unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    s.open_with_focus(child, &mut f, vec![target(20)], OpenFocus::First)
        .unwrap();
    assert_eq!(f.focused(), Some(FocusId(20)));
    assert_eq!(
        f.focus(FocusId(12)),
        Some(FocusId(12)),
        "pointer can focus a parent while the child is open"
    );
}
#[test]
fn review_submenu_placement_keeps_natural_width_and_aligns_first_row() {
    use placement::{Rect, Size};
    let p = menu::Menu::place(
        menu::Anchor::Submenu(Rect {
            x: 180.,
            y: 100.,
            width: 80.,
            height: 28.,
        }),
        Size {
            width: 240.,
            height: 200.,
        },
        Size {
            width: 400.,
            height: 400.,
        },
        0.,
        false,
    );
    assert_eq!((p.rect.x, p.rect.y, p.rect.width), (152., 96., 240.));
}
#[test]
fn review_submenu_deadlines_drive_open_close_and_cancellation_without_polling() {
    use menu::{Action, Entry, Item, Menu};
    let mut m = Menu::new(vec![
        Entry::Item(Item {
            submenu: Some(vec![item("Child")]),
            ..Item::new(CommandId::Menu, "")
        }),
        item("Other"),
    ]);
    assert_eq!(m.deadline(), None);
    m.hover(0, 100);
    assert_eq!(m.deadline(), Some(250));
    let wake = m.deadline().unwrap();
    assert_eq!(m.tick(wake), Action::OpenSubmenuHover(0));
    assert_eq!(m.deadline(), None);
    m.submenu_opened(0);
    m.hover(1, 300);
    assert_eq!(m.deadline(), Some(550));
    m.cancel_hover();
    assert_eq!(m.deadline(), None);
    assert_eq!(m.tick(550), Action::Swallow);
    m.hover(1, 600);
    let wake = m.deadline().unwrap();
    assert_eq!(wake, 850);
    assert_eq!(m.tick(wake), Action::CloseChild);
    assert_eq!(m.deadline(), None);
    m.submenu_closed();
    assert_eq!(m.deadline(), None);
}

#[test]
fn review_menu_placement_edges_match_the_executed_javascript_place_method() {
    use menu::Anchor;
    use placement::{Rect, Size};
    // Evaluated from ui-menu.mjs #place with its placeFloating -> computePosition adapter.
    let cases = [
        (
            Anchor::Submenu(Rect {
                x: 180.,
                y: 100.,
                width: 80.,
                height: 28.,
            }),
            400.,
            400.,
            true,
            (8., 96., 140., 200.),
        ),
        (
            Anchor::Submenu(Rect {
                x: 1000.,
                y: 100.,
                width: 232.,
                height: 28.,
            }),
            1280.,
            720.,
            false,
            (758., 96., 240., 200.),
        ),
        (
            Anchor::Submenu(Rect {
                x: 8.,
                y: 100.,
                width: 80.,
                height: 28.,
            }),
            1280.,
            720.,
            true,
            (90., 96., 240., 200.),
        ),
        (
            Anchor::Submenu(Rect {
                x: 400.,
                y: 680.,
                width: 80.,
                height: 28.,
            }),
            1280.,
            720.,
            false,
            (482., 512., 240., 200.),
        ),
        (
            Anchor::Root(Rect {
                x: 1150.,
                y: 650.,
                width: 100.,
                height: 28.,
            }),
            1280.,
            720.,
            false,
            (1010., 444., 240., 200.),
        ),
        (
            Anchor::Point { x: 1270., y: 710. },
            1280.,
            720.,
            false,
            (1030., 508., 240., 200.),
        ),
        (
            Anchor::Root(Rect {
                x: 100.,
                y: 100.,
                width: 80.,
                height: 28.,
            }),
            1280.,
            720.,
            true,
            (100., 134., 240., 200.),
        ),
    ];
    for (anchor, w, h, rtl, expected) in cases {
        let p = menu::Menu::place(
            anchor,
            Size {
                width: 240.,
                height: 200.,
            },
            Size {
                width: w,
                height: h,
            },
            50.,
            rtl,
        );
        assert_eq!(
            (p.rect.x, p.rect.y, p.rect.width, p.rect.height),
            expected,
            "{anchor:?}, rtl={rtl}"
        );
    }
}

#[test]
fn review_tree_keys_follow_the_focused_ancestor_and_keep_the_page_out() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(
        Overlay::new(10, Kind::Menu),
        &mut f,
        vec![target(10), target(12)],
        None,
    )
    .unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    s.open_with_focus(child, &mut f, vec![target(20)], OpenFocus::Keep)
        .unwrap();
    let mut parent_model = menu::Menu::new(vec![item("First"), item("Other")]);
    s.menu_hover(10, 1, &mut parent_model, &mut f, 0);
    assert_eq!(s.active_menu(&f), Some(10));
    assert_eq!(
        s.menu_key(10, &mut parent_model, &mut f, key("ArrowUp"), 0),
        menu::Action::Move(0)
    );
    assert_eq!(f.focused(), Some(FocusId(10)));
    assert_eq!(
        f.focus(FocusId(1)),
        None,
        "the page still cannot take focus through the tree scope"
    );
    s.escape(false, &mut f);
    assert!(
        s.entries().is_empty(),
        "Escape on a parent row closes that menu, including its child"
    );
    assert_eq!(f.focused(), Some(FocusId(1)));
}
#[test]
fn review_refresh_and_hover_close_preserve_the_other_menus_focus() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(
        Overlay::new(10, Kind::Menu),
        &mut f,
        vec![target(10), target(12)],
        None,
    )
    .unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    s.open_with_focus(child, &mut f, vec![target(20)], OpenFocus::First)
        .unwrap();
    s.register_targets(10, vec![target(10), target(12), target(13)], &mut f);
    assert_eq!(f.focused(), Some(FocusId(20)));
    f.focus(FocusId(13));
    s.finish(20, Reason::Hover, &mut f);
    assert_eq!(
        f.focused(),
        Some(FocusId(13)),
        "hover-close must not restore the old parent row"
    );
    assert_eq!(
        f.focus(FocusId(20)),
        None,
        "closed rows leave the shared scope"
    );
    assert_eq!(f.depth(), 2);
}

#[test]
fn menu_tree_refresh_and_teardown_preserve_input_roles_and_history_owners() {
    use crate::focus::{HistoryOwner, InputRole};

    let mut s = Stack::default();
    let mut f = page();
    let mut select = target(10);
    select.input_role = InputRole::Select;
    s.open(Overlay::new(10, Kind::Menu), &mut f, vec![select], None).unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    let mut vfx = FocusTarget::new(20, FocusArea::Panels, TargetKind::TextEntry);
    vfx.history_owner = HistoryOwner::Vfx;
    s.open_with_focus(child, &mut f, vec![vfx], OpenFocus::First).unwrap();
    // Replacing the parent's rows keeps the child's complete focused target.
    s.register_targets(10, vec![select, target(12)], &mut f);
    assert_eq!(f.focused(), Some(FocusId(20)));
    assert_eq!(f.input_role(), InputRole::Text);
    assert_eq!(f.history_owner(), HistoryOwner::Vfx);
    s.register_targets(20, vec![vfx, target(21)], &mut f);
    assert_eq!(f.input_role(), InputRole::Text);
    assert_eq!(f.history_owner(), HistoryOwner::Vfx);
    f.focus(FocusId(10));
    assert_eq!(f.input_role(), InputRole::Select);
    assert_eq!(f.history_owner(), HistoryOwner::Field);
    // Removing a child uses remove_scope_targets without rebuilding the ancestor's role.
    s.finish(20, Reason::Hover, &mut f);
    assert_eq!(f.focused(), Some(FocusId(10)));
    assert_eq!(f.input_role(), InputRole::Select);
    // Removing the menu scope beneath a dialog preserves the original return chain.
    s.open(Overlay::new(30, Kind::Dialog), &mut f, vec![vfx], None).unwrap();
    s.finish(10, Reason::Removed, &mut f);
    assert_eq!(f.history_owner(), HistoryOwner::Vfx);
    s.finish(30, Reason::Removed, &mut f);
    assert_eq!(f.focused(), Some(FocusId(1)));
    assert_eq!(f.input_role(), InputRole::None);
}

#[test]
fn menu_shortcuts_follow_the_command_and_submenus_have_no_hint() {
    use crate::shortcuts::Platform;

    let mut row = menu::Item::new(CommandId::Undo, "Undo");
    assert_eq!(row.shortcuts(Platform::Control, true, &[]).text, "Ctrl+Z");
    row.command = CommandId::Redo;
    let hint = row.shortcuts(Platform::Control, true, &[]);
    assert_eq!(hint.text, "Ctrl+Shift+Z");
    assert_eq!(hint.keyshortcuts, "Control+Shift+Z Control+Y");
    row.submenu = Some(vec![item("Child")]);
    let model = menu::Menu::new(vec![menu::Entry::Item(row)]);
    assert_eq!(model.items().next().unwrap().shortcuts(Platform::Control, true, &[]), menu::ShortcutHint::default());
}
#[test]
fn review_keyboard_enters_an_existing_hover_child_and_escape_restores_its_row() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(Overlay::new(10, Kind::Menu), &mut f, vec![target(10)], None)
        .unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    s.open_with_focus(child, &mut f, vec![target(20)], OpenFocus::Keep)
        .unwrap();
    assert_eq!(
        s.focus_menu(20, &mut f),
        Some(Effect::Focus(Some(FocusId(20))))
    );
    assert_eq!(s.entries().len(), 2);
    let mut child_model = menu::Menu::new(vec![item("Child")]);
    assert_eq!(
        s.menu_key(20, &mut child_model, &mut f, key("ArrowLeft"), 0),
        menu::Action::CloseSubmenu
    );
    s.escape(false, &mut f);
    assert_eq!(s.entries().len(), 1);
    assert_eq!(f.focused(), Some(FocusId(10)));
}

#[test]
fn review_open_actions_carry_the_reference_focus_policy() {
    assert_eq!(
        menu::Action::OpenSubmenu(0).submenu_focus(),
        Some(OpenFocus::First)
    );
    assert_eq!(
        menu::Action::OpenSubmenuHover(0).submenu_focus(),
        Some(OpenFocus::Keep)
    );
}

#[test]
fn review_removed_menu_tree_preserves_a_dialogs_invoker_chain() {
    let mut s = Stack::default();
    let mut f = page();
    s.open(
        Overlay::new(10, Kind::Menu),
        &mut f,
        vec![target(10), target(12)],
        None,
    )
    .unwrap();
    let mut child = Overlay::new(20, Kind::Menu);
    child.parent = Some(10);
    child.anchor = Some(FocusId(10));
    s.open_with_focus(child, &mut f, vec![target(20)], OpenFocus::First)
        .unwrap();
    s.open(
        Overlay::new(30, Kind::Dialog),
        &mut f,
        vec![target(30)],
        None,
    )
    .unwrap();
    s.finish(10, Reason::Removed, &mut f);
    assert_eq!(f.focused(), Some(FocusId(30)));
    s.finish(30, Reason::Selected, &mut f);
    assert_eq!(
        f.focused(),
        Some(FocusId(1)),
        "the removed child hands back through its parent and the root invoker"
    );
}
