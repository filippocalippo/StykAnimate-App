use super::host::*;
use super::menu::{Anchor, Entry, Item, Key};
use super::placement::Rect;
use super::{Effect, Reason};
use crate::commands::CommandId;
use crate::focus::{FocusArea, FocusId, FocusState, FocusTarget, ScopeId, TargetKind};

const INVOKER: FocusId = FocusId(7);

fn page() -> FocusState {
    let mut focus = FocusState::new();
    focus.register(ScopeId::ROOT, vec![FocusTarget::new(7, FocusArea::TopBand, TargetKind::Control), FocusTarget::new(8, FocusArea::TopBand, TargetKind::Control)]);
    focus.focus(INVOKER);
    focus
}

fn row(command: CommandId, label: &str) -> Entry {
    Entry::Item(Item::new(command, label))
}

fn submenu(label: &str, children: Vec<Entry>) -> Entry {
    Entry::Item(Item { submenu: Some(children), ..Item::new(CommandId::Menu, label) })
}

fn root() -> Vec<Entry> {
    vec![
        row(CommandId::Undo, "Undo"),
        row(CommandId::Redo, "Redo"),
        Entry::Separator,
        submenu("More", vec![row(CommandId::Copy, "Copy"), row(CommandId::Paste, "Paste")]),
        Entry::Item(Item { disabled: true, reason: "Nothing selected".into(), ..Item::new(CommandId::Delete, "Delete") }),
    ]
}

fn bounds(_: FocusId) -> Option<Rect> {
    Some(Rect { x: 100., y: 80., width: 240., height: 32. })
}

fn key(name: &str) -> Key<'_> {
    Key { key: name, ..Key::default() }
}

fn anchor() -> Anchor {
    Anchor::Root(Rect { x: 10., y: 10., width: 60., height: 28. })
}

fn open(host: &mut Host, focus: &mut FocusState, keyboard: bool) -> u64 {
    let update = host.open(root(), anchor(), Purpose::Commands, Some(INVOKER), keyboard, None, focus);
    assert!(update.effects.contains(&Effect::ReleaseHeldKeys) && update.effects.contains(&Effect::Blocking(true)), "the hotkey gate closes and held keys release");
    host.menus()[0].id()
}

#[test]
fn arrows_wrap_over_the_items_and_a_disabled_row_stays_reachable_but_does_not_run() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, true);
    assert_eq!(focus.focused(), Some(row_id(id, 0)), "the first row takes focus");
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    assert_eq!(focus.focused(), Some(row_id(id, 3)), "Delete (disabled) is the fourth item and takes focus");
    assert_eq!(host.menus()[0].current(), Some(3));
    let update = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!(update.run, None, "a disabled row never runs");
    assert_eq!(host.menus().len(), 1, "and the menu stays");
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    assert_eq!(focus.focused(), Some(row_id(id, 0)), "arrows wrap");
    host.key(key("End"), &bounds, &mut focus, 0);
    assert_eq!(host.menus()[0].current(), Some(3));
    host.key(key("Home"), &bounds, &mut focus, 0);
    assert_eq!(host.menus()[0].current(), Some(0));
}

#[test]
fn typeahead_jumps_to_the_label_and_forgets_after_700_ms() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, true);
    host.key(key("m"), &bounds, &mut focus, 1000);
    assert_eq!(focus.focused(), Some(row_id(id, 2)), "M finds More");
    host.key(key("r"), &bounds, &mut focus, 1500);
    assert_eq!(focus.focused(), Some(row_id(id, 2)), "Mr matches nothing and stays");
    host.key(key("r"), &bounds, &mut focus, 2300);
    assert_eq!(focus.focused(), Some(row_id(id, 1)), "700 ms later R starts again and finds Redo");
}

#[test]
fn enter_runs_the_command_closes_the_tree_and_returns_focus_to_the_invoker() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, true);
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    let update = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!(update.run, Some(CommandId::Redo));
    assert!(host.menus().is_empty());
    assert!(update.effects.contains(&Effect::Closed { id, reason: Reason::Selected }));
    assert!(update.effects.contains(&Effect::Blocking(false)));
    assert_eq!(focus.focused(), Some(INVOKER));
}

#[test]
fn escape_closes_and_restores_focus() {
    let (mut host, mut focus) = (Host::default(), page());
    open(&mut host, &mut focus, true);
    let update = host.key(key("Escape"), &bounds, &mut focus, 0);
    assert!(host.menus().is_empty());
    assert!(update.effects.contains(&Effect::Blocking(false)));
    assert_eq!(focus.focused(), Some(INVOKER));
}

#[test]
fn right_arrow_opens_the_submenu_with_focus_and_escape_closes_only_it() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, true);
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    host.key(key("ArrowRight"), &bounds, &mut focus, 0);
    assert_eq!(host.menus().len(), 2, "the submenu is open");
    let child = host.menus()[1].id();
    assert_eq!(host.menus()[1].parent(), Some(id));
    assert!(matches!(host.menus()[1].anchor(), Anchor::Submenu(_)));
    assert_eq!(focus.focused(), Some(row_id(child, 0)), "keyboard opening enters the child");
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    assert_eq!(host.menus()[1].current(), Some(1));
    host.key(key("Escape"), &bounds, &mut focus, 0);
    assert_eq!(host.menus().len(), 1, "Escape closes the child only");
    assert_eq!(focus.focused(), Some(row_id(id, 2)), "focus returns to the row that opened it");
    host.key(key("ArrowRight"), &bounds, &mut focus, 0);
    host.key(key("ArrowLeft"), &bounds, &mut focus, 0);
    assert_eq!(host.menus().len(), 1, "ArrowLeft in a child closes it");
}

#[test]
fn a_submenu_item_runs_its_command_and_closes_the_whole_tree() {
    let (mut host, mut focus) = (Host::default(), page());
    open(&mut host, &mut focus, true);
    host.key(key("m"), &bounds, &mut focus, 0);
    host.key(key("Enter"), &bounds, &mut focus, 0);
    host.key(key("ArrowDown"), &bounds, &mut focus, 0);
    let update = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!(update.run, Some(CommandId::Paste));
    assert!(host.menus().is_empty());
    assert_eq!(focus.focused(), Some(INVOKER));
}

#[test]
fn hovering_a_submenu_row_opens_it_after_150_ms_without_taking_focus_and_leaving_closes_it_after_250() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    assert_eq!(host.next_deadline(), None, "nothing is scheduled at rest");
    host.hover(id, 2, &mut focus, 1000);
    assert_eq!(focus.focused(), Some(row_id(id, 2)));
    assert!(!focus.focus_visible(), "a hover shows no ring");
    assert_eq!(host.next_deadline(), Some(1150));
    let (update, expired) = host.tick(1149, &bounds, &mut focus);
    assert_eq!((update.consumed, expired, host.menus().len()), (false, None, 1), "not yet");
    host.tick(1150, &bounds, &mut focus);
    assert_eq!(host.menus().len(), 2);
    assert_eq!(focus.focused(), Some(row_id(id, 2)), "a hover-opened child leaves the parent's focus alone");
    assert_eq!(host.next_deadline(), None);
    host.hover(id, 0, &mut focus, 1400);
    assert_eq!(host.next_deadline(), Some(1650), "moving to another row schedules the child's closing");
    host.hover(id, 2, &mut focus, 1500);
    assert_eq!(host.next_deadline(), None, "coming back cancels it");
    host.hover(id, 1, &mut focus, 1600);
    host.tick(1850, &bounds, &mut focus);
    assert_eq!(host.menus().len(), 1, "the child closed");
    assert_eq!(focus.focused(), Some(row_id(id, 1)), "closing by hover restores nothing over the row the pointer is on");
}

#[test]
fn leaving_every_menu_cancels_a_pending_intent() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    host.hover(id, 2, &mut focus, 0);
    assert!(host.next_deadline().is_some());
    host.leave();
    assert_eq!(host.next_deadline(), None);
}

#[test]
fn a_click_runs_a_row_and_a_press_outside_closes_without_running() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    let update = host.press(id, 1, &bounds, &mut focus, 0);
    assert_eq!(update.run, Some(CommandId::Redo));
    assert!(host.menus().is_empty());

    let id = open(&mut host, &mut focus, false);
    let release = host.pointer(false, false, None, &mut focus);
    assert!(release.effects.is_empty() && host.menus().len() == 1, "a release never dismisses a menu opened under the press");
    let update = host.pointer(true, false, None, &mut focus);
    assert!(update.effects.contains(&Effect::Closed { id, reason: Reason::OutsidePress }));
    assert!(host.menus().is_empty());
    assert_eq!(focus.focused(), Some(INVOKER), "an invoker that is still there keeps focus");
}

#[test]
fn a_press_on_the_anchor_toggles_the_menu_closed() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    let update = host.pointer(true, false, Some(INVOKER), &mut focus);
    assert!(update.effects.contains(&Effect::Closed { id, reason: Reason::Toggle }));
}

#[test]
fn keep_open_rows_toggle_in_place_and_a_plain_row_closes() {
    let (mut host, mut focus) = (Host::default(), page());
    let entries = vec![
        Entry::Item(Item { checked: Some(false), keep_open: true, ..Item::new(CommandId::ToggleGrid, "Grid") }),
        row(CommandId::Undo, "Undo"),
    ];
    host.open(entries, anchor(), Purpose::Commands, Some(INVOKER), true, None, &mut focus);
    let update = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!(update.run, Some(CommandId::ToggleGrid));
    assert_eq!(host.menus().len(), 1, "a check row keeps the menu open");
    let Entry::Item(item) = &host.menus()[0].entries()[0] else { panic!("a row") };
    assert_eq!(item.checked, Some(true), "and shows its new state");
}

#[test]
fn a_select_reports_the_chosen_index_not_a_command_and_returns_focus() {
    let (mut host, mut focus) = (Host::default(), page());
    let rows = option_rows([("Linear", false), ("Hold", true), ("Ease", false)]);
    host.open(rows, Anchor::Root(Rect { x: 10., y: 10., width: 132., height: 32. }), Purpose::Select { invoker: INVOKER }, Some(INVOKER), true, Some(2), &mut focus);
    let id = host.menus()[0].id();
    assert_eq!(focus.focused(), Some(row_id(id, 2)), "the list opens on the chosen option");
    assert_eq!(host.menus()[0].current(), Some(2));
    host.key(key("ArrowUp"), &bounds, &mut focus, 0);
    assert_eq!(host.menus()[0].current(), Some(1), "a disabled option is reachable and shown, as in a native list");
    let refused = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!((refused.chose, refused.run), (None, None));
    host.key(key("ArrowUp"), &bounds, &mut focus, 0);
    let update = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!((update.chose, update.run), (Some(0), None));
    assert!(host.menus().is_empty());
    assert_eq!(focus.focused(), Some(INVOKER));
}

#[test]
fn a_selects_rows_keep_the_select_input_role_so_editor_keys_stay_out() {
    let (mut host, mut focus) = (Host::default(), page());
    host.open(option_rows([("A", false)]), anchor(), Purpose::Select { invoker: INVOKER }, Some(INVOKER), true, None, &mut focus);
    assert_eq!(focus.input_role(), crate::focus::InputRole::Select);
}

#[test]
fn shortcut_hints_come_from_the_registry_and_a_submenu_row_has_none() {
    let (mut host, mut focus) = (Host::default(), page());
    open(&mut host, &mut focus, true);
    let menu = &host.menus()[0];
    assert_eq!(menu.hint(0).text, "Ctrl+Z");
    assert_eq!(menu.hint(2).text, "", "More has a submenu");
}

#[test]
fn the_next_deadline_is_the_earliest_of_menus_messages_and_the_tooltip() {
    use super::messages::{Message, Tone};
    use super::tooltip::{Content, Tip};
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    host.hover(id, 2, &mut focus, 100);
    host.messages_mut().push(Message::new(1, "saved", Tone::Success, false, vec![]), 100);
    assert_eq!(host.next_deadline(), Some(250), "the hover intent (150 ms) comes before the 4 s message");
    host.tick(250, &bounds, &mut focus);
    assert_eq!(host.next_deadline(), Some(4100));
    host.tooltip_mut().schedule(Tip { target: 1, content: Content { label: "Undo".into(), shortcut: "Ctrl+Z".into() } }, 300, false, false);
    assert_eq!(host.next_deadline(), Some(800), "the tooltip's 500 ms delay");
    let (_, expired) = host.tick(4100, &bounds, &mut focus);
    assert_eq!(expired, Some(1), "the message goes at its timeout");
    assert!(host.tooltip().visible().is_some(), "and the tooltip is up by then");
}

#[test]
fn closing_the_window_around_a_menu_does_not_steal_focus_back() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    let update = host.environment(Reason::Resize, &mut focus);
    assert!(update.effects.contains(&Effect::Closed { id, reason: Reason::Resize }));
    assert!(host.menus().is_empty());
}

#[test]
fn menu_row_ids_never_collide_across_menus_or_with_page_targets() {
    assert_ne!(row_id(1, 0), row_id(2, 0));
    assert_ne!(row_id(1, 4095), row_id(2, 0));
    assert_eq!(row_index(3, row_id(3, 17)), Some(17));
    assert_eq!(row_index(3, row_id(4, 17)), None);
    assert_eq!(row_index(3, FocusId(7)), None);
}

#[test]
fn only_a_hovered_row_or_a_keyboard_focused_one_takes_the_fill() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    assert_eq!(host.menus()[0].current(), Some(0), "the pointer-opened menu focuses its first row");
    assert_eq!(host.menus()[0].hovered(), None, "but the pointer is not on it, so nothing is filled until it is");
    host.hover(id, 1, &mut focus, 0);
    assert_eq!(host.menus()[0].hovered(), Some(1));
    host.leave();
    assert_eq!(host.menus()[0].hovered(), None, "leaving the menus clears it");
}

#[test]
fn opener_activation_and_outside_press_are_one_toggle() {
    let (mut host, mut focus) = (Host::default(), page());
    let select = |press| Event::Select { invoker: INVOKER, anchor: Rect::default(), options: vec![("A".into(), false)], chosen: None, keyboard: false, press };
    host.event(select(1), &mut focus, 0);
    assert_eq!(host.menus().len(), 1);
    host.event(Event::Pointer { pressed: true, inside: false, anchor: Some(INVOKER), press: 2 }, &mut focus, 10);
    host.event(select(2), &mut focus, 10);
    assert!(host.menus().is_empty(), "the opener event must not reopen the list closed by the same press");
    host.event(select(3), &mut focus, 20);
    host.event(Event::Pointer { pressed: true, inside: false, anchor: Some(INVOKER), press: 3 }, &mut focus, 20);
    assert_eq!(host.menus().len(), 1, "reverse event order also applies only once");
}

#[test]
fn departure_cancels_intent_even_when_a_deadline_is_already_queued() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    host.event(Event::Hover { menu: id, index: 2 }, &mut focus, 0);
    host.event(Event::Leave { menu: Some(id), row: None }, &mut focus, 100);
    host.event(Event::Tick, &mut focus, 150);
    assert_eq!(host.menus().len(), 1);
    assert_eq!(host.menus()[0].hovered(), None);
}

#[test]
fn normalized_choices_keep_original_identity_and_have_no_command_hint() {
    let (mut host, mut focus) = (Host::default(), page());
    let mut rows = option_rows([("hidden", false), ("B", false)]);
    if let Entry::Item(item) = &mut rows[0] { item.hidden = true; }
    host.open(rows, anchor(), Purpose::Select { invoker: INVOKER }, Some(INVOKER), true, None, &mut focus);
    assert_eq!(host.menus()[0].hint(0).text, "");
    let update = host.key(key("Enter"), &bounds, &mut focus, 0);
    assert_eq!(update.chose, Some(1));
    assert_eq!(update.run, None);
}

#[test]
fn animation_phases_and_deadlines_stop_at_unmount_or_completion() {
    let (mut host, mut focus) = (Host::default(), page());
    assert_eq!(host.next_deadline(), None);
    for (id, kind, half) in [(1, Animation::Progress, 650), (2, Animation::Spinner, 400), (3, Animation::Entry(super::Kind::Menu), 80), (4, Animation::Entry(super::Kind::Dialog), 120), (5, Animation::Entry(super::Kind::Popover), 80), (6, Animation::Entry(super::Kind::Toast), 120), (7, Animation::Entry(super::Kind::Sheet), 120)] {
        host.event(Event::Animate { id, kind: Some(kind) }, &mut focus, 0);
        host.event(Event::Tick, &mut focus, half);
        assert_eq!(host.phase(id), 0.5);
        assert!(host.next_deadline().is_some());
        host.event(Event::Animate { id, kind: None }, &mut focus, half);
        assert_eq!(host.next_deadline(), None);
    }
    host.event(Event::Animate { id: 8, kind: Some(Animation::Entry(super::Kind::Dialog)) }, &mut focus, 0);
    host.event(Event::Tick, &mut focus, 240);
    assert_eq!(host.phase(8), 1.0);
    assert_eq!(host.next_deadline(), None);
}

#[test]
fn message_action_lookup_dismissal_and_keyboard_pause_belong_to_host() {
    use super::messages::{Message, Tone, Action};
    let (mut host, mut focus) = (Host::default(), page());
    let action = message_button_id(9, 0);
    focus.register(ScopeId::ROOT, vec![FocusTarget::new(INVOKER.0, FocusArea::TopBand, TargetKind::Control), FocusTarget::new(action.0, FocusArea::TopBand, TargetKind::Control)]);
    host.event(Event::ShowMessage(Message::new(9, "save", Tone::Info, false, vec![Action { command: CommandId::Save, label: "Save".into(), dismiss: true }])), &mut focus, 0);
    assert_eq!(focus.tab(true), Some(action));
    host.event(Event::FocusChanged, &mut focus, 100);
    assert_eq!(host.messages().deadline(), None);
    host.event(Event::Tick, &mut focus, 9000);
    assert!(host.messages().current().is_some());
    assert_eq!(host.event(Event::MessageAction { id: 8, index: 0 }, &mut focus, 9000).run, None);
    let out = host.event(Event::MessageAction { id: 9, index: 0 }, &mut focus, 9000);
    assert_eq!(out.run, Some(CommandId::Save));
    assert_eq!(out.dismissed, Some(9));
    assert!(host.messages().current().is_none());
}

#[test]
fn unrelated_input_does_not_postpone_an_animation_wake() {
    let (mut host, mut focus) = (Host::default(), page());
    host.event(Event::Animate { id: 3, kind: Some(Animation::Spinner) }, &mut focus, 0);
    host.event(Event::Time, &mut focus, 15);
    assert_eq!(host.next_deadline(), Some(16));
}

#[test]
fn a_dialog_opens_on_the_stack_enters_for_240_ms_and_escape_asks_its_guard() {
    use super::Kind;
    let (mut host, mut focus) = (Host::default(), page());
    let ok = FocusId(60);
    let out = host.event(Event::OpenOverlay { kind: Kind::Dialog, guarded: true, targets: vec![FocusTarget::new(ok.0, FocusArea::Panels, TargetKind::Control)], initial: Some(ok) }, &mut focus, 1000);
    assert!(out.effects.contains(&Effect::Blocking(true)));
    let id = host.stack().entries()[0].id;
    assert_eq!(host.phase(id), 0.0, "it enters at its start");
    host.event(Event::Tick, &mut focus, 1120);
    assert_eq!(host.phase(id), 0.5, "over 240 ms");
    let out = host.event(Event::Escape, &mut focus, 1130);
    assert_eq!(out.effects, vec![Effect::CheckClose { id, reason: Reason::Escape }]);
    host.event(Event::ResolveClose { id, allow: true }, &mut focus, 1140);
    assert!(host.stack().entries().is_empty());
    assert_eq!(host.next_deadline(), None, "nothing runs once it is gone");
}

#[test]
fn a_tooltip_shows_after_its_delay_at_its_target_and_hides_on_a_press() {
    use super::tooltip::Content;
    let (mut host, mut focus) = (Host::default(), page());
    let content = Content { label: "Undo".into(), shortcut: "Ctrl+Z".into() };
    host.event(Event::Bounds(vec![(FocusId(7), Rect { x: 10.0, y: 10.0, width: 32.0, height: 32.0 })]), &mut focus, 0);
    host.event(Event::TooltipShow { target: FocusId(7), content: content.clone(), touch: false, keyboard: false }, &mut focus, 100);
    assert_eq!(host.next_deadline(), Some(600));
    host.event(Event::Tick, &mut focus, 600);
    let (tip, at) = host.tooltip_anchor().expect("visible");
    assert_eq!((tip.content.clone(), at.x), (content.clone(), 10.0));
    host.event(Event::Pointer { pressed: true, inside: false, anchor: None, press: 1 }, &mut focus, 700);
    assert!(host.tooltip_anchor().is_none(), "a press hides it");
    host.event(Event::TooltipShow { target: FocusId(7), content, touch: true, keyboard: false }, &mut focus, 800);
    assert_eq!(host.next_deadline(), None, "touch hover shows nothing");
}

#[test]
fn a_task_message_loops_its_progress_and_stops_with_the_message() {
    use super::messages::{Message, Tone};
    let (mut host, mut focus) = (Host::default(), page());
    host.event(Event::ShowMessage(Message::new(4, "export", Tone::Info, true, vec![])), &mut focus, 0);
    let progress = message_progress_id(4);
    host.event(Event::Tick, &mut focus, 650);
    assert_eq!(host.phase(progress), 0.5);
    assert!(host.next_deadline().is_some(), "a loop keeps asking for frames");
    host.event(Event::MessageDismiss(4), &mut focus, 700);
    assert_eq!(host.next_deadline(), None);
}

#[test]
fn leaving_a_row_clears_its_fill_and_leaving_the_tree_cancels_what_was_pending() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    host.event(Event::Hover { menu: id, index: 1 }, &mut focus, 0);
    assert_eq!(host.menus()[0].hovered(), Some(1));
    host.event(Event::Leave { menu: Some(id), row: None }, &mut focus, 10);
    assert_eq!(host.menus()[0].hovered(), None);
    host.event(Event::Hover { menu: id, index: 2 }, &mut focus, 20);
    host.event(Event::Leave { menu: None, row: None }, &mut focus, 30);
    assert_eq!(host.next_deadline(), None, "the submenu's hover intent died with the pointer");
}

#[test]
fn a_leave_naming_a_row_that_is_no_longer_hovered_is_stale_and_changes_nothing() {
    let (mut host, mut focus) = (Host::default(), page());
    let id = open(&mut host, &mut focus, false);
    host.event(Event::Hover { menu: id, index: 2 }, &mut focus, 0);
    host.event(Event::Hover { menu: id, index: 1 }, &mut focus, 10);
    host.event(Event::Leave { menu: Some(id), row: Some(2) }, &mut focus, 10);
    assert_eq!(host.menus()[0].hovered(), Some(1), "the row just reached keeps its fill");
    host.event(Event::Hover { menu: id, index: 2 }, &mut focus, 20);
    host.event(Event::Leave { menu: Some(id), row: Some(1) }, &mut focus, 20);
    assert_eq!(host.menus()[0].hovered(), Some(2));
    assert!(host.next_deadline().is_some(), "and its submenu intent is still pending");
    host.event(Event::Leave { menu: Some(id), row: Some(2) }, &mut focus, 30);
    assert_eq!(host.menus()[0].hovered(), None, "the leave of the hovered row clears it");
}

#[test]
fn the_press_that_closed_an_openers_menu_does_not_open_it_again_on_release() {
    let (mut host, mut focus) = (Host::default(), page());
    let open = || Event::OpenMenu { entries: vec![row(CommandId::Undo, "Undo")], anchor: anchor(), invoker: Some(INVOKER), keyboard: false };
    host.event(open(), &mut focus, 0);
    assert_eq!(host.menus().len(), 1);
    host.event(Event::Pointer { pressed: true, inside: false, anchor: Some(INVOKER), press: host.press_sequence() }, &mut focus, 10);
    assert!(host.menus().is_empty(), "the press on the opener closed it");
    host.event(open(), &mut focus, 20);
    assert!(host.menus().is_empty(), "the release of that press did not reopen it");
    host.event(Event::Pointer { pressed: false, inside: false, anchor: None, press: 0 }, &mut focus, 30);
    host.event(open(), &mut focus, 40);
    assert_eq!(host.menus().len(), 1, "a new press opens it again");
}
