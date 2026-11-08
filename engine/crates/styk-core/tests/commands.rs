//! Behavioural checks of K-cmd's independent modules, with today's JS as the oracle.
use std::collections::BTreeSet;
use std::process::Command;
use styk_core::command_queue::{self, Activity, GestureQueue, Invocation, Next, Phase, Settlement, Submitted};
use styk_core::commands::{CommandId, Gates as Context, Disabled, Info, History, Mode, Polygon, Requirement};
use styk_core::documents::DocumentId;
use styk_core::engine::{Value, json};
use styk_core::error_policy::{classify, Kind, Lifetime, Operation, Tone};
use styk_core::focus::{FocusArea, FocusId, FocusState, FocusTarget, ScopeId, TargetKind};
use styk_core::shortcuts::{self, Activation, Input, Platform, Press, Release, Scope, Shortcuts};
use styk_core::text_entry::Chord;

fn entry(id: &str) -> &'static Info { CommandId::from_id(id).unwrap().info() }
fn text<'a>(value: &'a Value, key: &str) -> &'a str { value.get(key).and_then(Value::as_str).unwrap_or("") }
fn flag(value: &Value, key: &str) -> bool { value.get(key).and_then(Value::as_bool).unwrap_or(false) }
fn strings(value: &Value, key: &str) -> Vec<String> {
    value.get(key).and_then(Value::as_arr).unwrap_or(&[]).iter().map(|v| v.as_str().unwrap().to_string()).collect()
}
fn field(kind: TargetKind) -> FocusState {
    let mut focus = FocusState::new();
    focus.register(ScopeId::ROOT, vec![FocusTarget::new(1, FocusArea::Panels, kind)]);
    focus.reconcile(Some(FocusId(1)));
    focus
}
fn action(id: &str) -> Invocation { Invocation::action(entry(id).id, Some(DocumentId::preview(1))) }
fn activation(id: &str, key: &'static str) -> Activation { Activation { command: entry(id).id, key, shift: false, continued: false } }
fn busy() -> Activity { Activity { stroke: true, ..Activity::default() } }
fn next(queue: &mut GestureQueue) -> Next { queue.next(Some(DocumentId::preview(1)), Activity::default(), Settlement::Ready) }

#[test]
fn registry_is_appendix_a_plus_the_native_layout_undo_command() {
    let appendix = include_str!("../../../../docs/native/INVENTORY.md").split("## Appendix A:").nth(1).unwrap().split("## Appendix B:").next().unwrap();
    let mut expected: BTreeSet<_> = appendix.lines().filter(|line| line.starts_with("| CMD-")).map(|line| line.split('`').nth(1).unwrap()).collect();
    expected.insert("layout-undo"); // Design 3.12 adds independent layout history to the native command set.
    let actual: BTreeSet<_> = CommandId::ALL.iter().map(|id| id.id()).collect();
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), CommandId::ALL.len());
    assert_eq!(actual.len(), 277);
    for entry in CommandId::ALL.iter().map(|id| id.info()) {
        assert_eq!(CommandId::from_id(entry.id.id()), Some(entry.id));
        assert!(!entry.label.is_empty(), "{}", entry.id.id());
        for alias in [entry.alias_of, entry.display_hotkey].into_iter().flatten() { assert!(CommandId::from_id(alias.id()).is_some(), "{} -> {}", entry.id.id(), alias.id()); }
    }
}

#[test]
fn all_unported_commands_dispatch_the_typed_not_available_effect() {
    use styk_core::app::Core;
    use styk_core::commands::{Command as AppCommand, Effect, Owner};
    let mut core = Core::default();
    for &id in CommandId::ALL {
        assert_eq!(id.info().id, id, "each variant must own its metadata");
        if id.info().owner == Owner::NotYet {
            assert_eq!(core.dispatch(AppCommand::Run(id)), [Effect::NotAvailable(id)], "{}", id.id());
        }
    }
    assert_eq!(CommandId::from_id("not-a-command"), None);
    assert_eq!(CommandId::from_id("Undo"), None, "serialised identities keep the exact inventory spelling");
}

#[test]
fn menu_and_message_actions_reach_dispatch_with_their_registry_identity() {
    use styk_core::app::Core;
    use styk_core::commands::{Command as AppCommand, Effect};
    use styk_core::overlay::{menu, messages};

    let mut core = Core::default();
    let mut menu = menu::Menu::new(vec![menu::Entry::Item(menu::Item::new(CommandId::Save, "Save"))]);
    menu.focus(0);
    let menu::Action::Activate { action: menu::RowAction::Command(command), close: true, .. } = menu.activate() else { panic!("menu activation"); };
    assert_eq!(core.dispatch(AppCommand::Run(command)), [Effect::NotAvailable(CommandId::Save)]);

    let mut slot = messages::Messages::default();
    slot.push(messages::Message::new(1, "save-again", messages::Tone::Warning, false, vec![messages::Action {
        command: CommandId::Save.into(), label: "Retry".into(), dismiss: true, outline: false,
    }]), 0);
    let messages::Do::Command(command) = slot.current().unwrap().actions[0].command.clone() else { panic!("a registry action") };
    assert_eq!(core.dispatch(AppCommand::Run(command)), [Effect::NotAvailable(CommandId::Save)]);
}

#[test]
fn executable_reference_matches_metadata_every_shortcut_and_both_polygon_gates() {
    let output = Command::new("node").arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/command-reference.mjs")).output().expect("Node is a required source-parity prerequisite");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let reference = json::parse(&output.stdout).unwrap();
    let commands = reference.get("commands").unwrap().as_arr().unwrap();
    assert_eq!(commands.len() + 1, CommandId::ALL.len());
    let native_only: BTreeSet<_> = CommandId::ALL.iter().map(|id| id.id()).filter(|id| !commands.iter().any(|c| text(c, "id") == *id)).collect();
    assert_eq!(native_only, BTreeSet::from(["layout-undo"]));
    let safe = strings(&reference, "polygonActions");
    let keys = strings(&reference, "polygonKeys");
    let home = strings(&reference, "homeActions");
    let field_keys = strings(&reference, "fieldCommands");
    for command in commands {
        let id = text(command, "id");
        let native = entry(id);
        if !id.starts_with("zoom-") || !id[5..].bytes().all(|c| c.is_ascii_digit()) {
            assert_eq!(native.label, text(command, "labelKey"), "{id}: label");
        }
        assert_eq!(native.icon, command.get("icon").and_then(Value::as_str), "{id}: icon");
        assert_eq!(native.category, text(command, "category"), "{id}: category");
        assert_eq!(native.keywords, strings(command, "keywords"), "{id}: keywords");
        assert_eq!(native.requires.iter().map(|r| r.name()).collect::<Vec<_>>(), strings(command, "requires"), "{id}: requirements");
        let modes: Vec<_> = strings(command, "modes").iter().map(|m| match m.as_str() { "draw" => Mode::Draw, "rig" => Mode::Build, "animate" => Mode::Animate, _ => panic!("unknown mode") }).collect();
        assert_eq!(native.modes, modes, "{id}: modes");
        assert_eq!(native.toggle, flag(command, "toggle"), "{id}: toggle");
        assert_eq!(native.danger, flag(command, "danger"), "{id}: danger");
        assert_eq!(native.palette, command.get("palette").and_then(Value::as_bool).unwrap_or(true), "{id}: palette");
        assert_eq!(native.alias_of.map(CommandId::id), command.get("aliasOf").and_then(Value::as_str), "{id}: alias");
        assert_eq!(native.display_hotkey.map(CommandId::id), command.get("hotkey").and_then(Value::as_str), "{id}: hint alias");
        if let Some(params) = command.get("labelParams") {
            assert_eq!(native.label_number, Some(("percent", params.get("percent").unwrap().as_f64().unwrap() as u16)));
        }
        assert_eq!(native.stays_on_home, home.iter().any(|s| s == id), "{id}: Home");
        assert_eq!(native.key_on_home, home.iter().any(|s| s == id) || matches!(id, "new" | "next-project" | "previous-project" | "recent-project"), "{id}: Home keys");
        assert_eq!(native.field_key, field_keys.iter().any(|s| s == id), "{id}: field gate");
        assert_eq!(native.polygon_key, keys.iter().any(|s| s == id), "{id}: polygon keyboard gate");
        let cancel = matches!(id, "new" | "open" | "open-recent" | "close" | "close-project" | "close-saved-projects" | "next-project" | "previous-project" | "recent-project");
        let expected = if cancel { Polygon::CancelDraft } else if safe.iter().any(|s| s == id) || id.starts_with("zoom-") || id.starts_with("toggle-") { Polygon::Allow } else { Polygon::Refuse };
        assert_eq!(native.polygon, expected, "{id}: polygon action gate");
        if command.get("keys").is_none() { assert!(native.shortcut.is_none(), "{id}: unexpected shortcut"); continue; }
        let binding = native.shortcut.unwrap();
        assert_eq!(binding.keys, strings(command, "keys"), "{id}: Windows keys");
        assert_eq!(binding.mac_keys, strings(command, "macKeys"), "{id}: Command modifier keys");
        assert_eq!(binding.scope.name(), text(command, "scope"), "{id}: scope");
        assert_eq!(binding.order as f64, command.get("hotkeyOrder").unwrap().as_f64().unwrap(), "{id}: order");
        assert_eq!(binding.hold, flag(command, "hold"), "{id}: held");
        assert_eq!(binding.repeat, flag(command, "repeat"), "{id}: repeats");
        assert_eq!(binding.extra_shift, flag(command, "extraShift"), "{id}: extra Shift");
        assert_eq!(binding.desktop_only, flag(command, "desktop"), "{id}: desktop default");
    }
    let cases = reference.get("cases").unwrap().as_arr().unwrap();
    assert!(cases.len() > 200);
    for case in cases {
        let event = case.get("event").unwrap();
        let chord = Chord { key: text(event, "code").to_owned(), ctrl: flag(event, "ctrlKey"), alt: flag(event, "altKey"), shift: flag(event, "shiftKey"), meta: flag(event, "metaKey"), alt_graph: false };
        let scope = Scope::parse(text(case, "scope")).unwrap();
        let platform = if flag(case, "mac") { Platform::Command } else { Platform::Control };
        let actual = shortcuts::resolve(&chord, &[scope], platform, true).unwrap();
        assert_eq!(actual.command.id(), text(case, "id"), "{case:?}");
        assert_eq!(actual.shift, flag(case, "shift"), "{case:?}");
        // Repeat suppression is part of dispatch, not just the metadata comparison.
        let mut router = Shortcuts::new(platform, true);
        let repeat = router.press(&FocusState::new(), &chord, &[scope], Input { repeat: true, ..Input::default() }, |_| true);
        assert_eq!(matches!(repeat, Press::Run(_)), actual.command.info().shortcut.unwrap().repeat, "{} repeat", actual.command.id());
    }
    let hints = reference.get("hints").unwrap().as_arr().unwrap();
    for hint in hints {
        let row = styk_core::overlay::menu::Item::new(CommandId::from_id(text(hint, "id")).unwrap(), "localized label");
        let platform = if flag(hint, "mac") { Platform::Command } else { Platform::Control };
        let scopes: Vec<_> = strings(hint, "scopes").iter().map(|s| Scope::parse(s).unwrap()).collect();
        let actual = row.shortcuts(platform, true, &scopes);
        assert_eq!(actual.text, text(hint, "text"), "{hint:?}");
        assert_eq!(actual.keyshortcuts, text(hint, "aria"), "{hint:?}");
    }
    eprintln!("source parity: {} registry entries, {} shortcut cases, {} menu hints", commands.len(), cases.len(), hints.len());
}

#[test]
fn availability_uses_current_feature_facts_and_unknown_handlers_stay_typed() {
    let mut context = Context::default();
    assert_eq!(entry("rotate").availability(&context, false).disabled, Some(Disabled::NotAvailable));
    assert_eq!(entry("rotate").availability(&context, true).disabled, Some(Disabled::Requirement(Requirement::Figure)));
    context.figure = true;
    assert_eq!(entry("rotate").availability(&context, true).disabled, None);
    assert_eq!(entry("align-left").availability(&context, true).disabled, Some(Disabled::Requirement(Requirement::Figures)));
    context.selection_count = 2;
    assert_eq!(entry("align-left").availability(&context, true).disabled, None);
    context.mode = Some(Mode::Animate);
    assert_eq!(entry("split-segment").availability(&context, true).disabled, Some(Disabled::Mode(Mode::Build)));
    assert!(entry("split-segment").availability(&context, true).hidden);
    context.mode = Some(Mode::Build);
    context.selected_joint = true;
    assert!(!context.satisfies(Requirement::Joint), "multiple figures cannot edit a joint");
    context.selection_count = 1;
    assert!(context.satisfies(Requirement::Joint));
    context.movieclip = true;
    assert!(!context.satisfies(Requirement::Joint));
    assert_eq!(entry("paste-builder-appearance").requires, &[Requirement::Joint, Requirement::Appearance]);
    assert_eq!(entry("rotate").history, History::Edit);
    assert_eq!(entry("handle-left").history, History::Gesture);
    assert_eq!(entry("add-text").history, History::Completion);
    assert_eq!(entry("save").history, History::None);
    assert_eq!(entry("undo").history, History::Undo);
    assert_eq!(entry("redo").history, History::Redo);
}

#[test]
fn scope_precedence_and_hint_aliases_do_not_create_second_bindings() {
    let chord = Chord::new("KeyL", false, false, false);
    assert_eq!(shortcuts::resolve(&chord, &[Scope::Drawing, Scope::Hover, Scope::Canvas], Platform::Control, true).unwrap().command.id(), "drawing-lasso");
    assert_eq!(shortcuts::resolve(&chord, &[Scope::Hover, Scope::Canvas], Platform::Control, true).unwrap().command.id(), "locate-previous");
    assert_eq!(shortcuts::resolve(&chord, &[], Platform::Control, true).unwrap().command.id(), "tool-line");
    assert!(entry("tool-line").visible_bindings(Platform::Control, true, &[Scope::Drawing]).is_empty());
    assert_eq!(entry("play").visible_bindings(Platform::Control, true, &[]), ["Space"]);
    assert_eq!(entry("delete-single-segment").visible_bindings(Platform::Control, true, &[Scope::Builder]), ["Delete", "Backspace"]);
    assert_eq!(shortcuts::resolve(&Chord::new("Space", false, false, false), &[], Platform::Control, true).unwrap().command.id(), "play-pan");
    assert!(entry("recent-project").visible_bindings(Platform::Control, false, &[]).is_empty());
    assert_eq!(entry("recent-project").visible_bindings(Platform::Command, true, &[]), ["Ctrl+Tab"]);
}

#[test]
fn every_field_chord_checks_all_modifiers_and_shift_f6_never_removes_keys() {
    let focus = field(TargetKind::TextEntry);
    for key in ["F6", "KeyM", "KeyL", "KeyZ", "Delete"] {
        for modifiers in 0..16 {
            let chord = Chord { key: key.into(), ctrl: modifiers & 1 != 0, alt: modifiers & 2 != 0,
                shift: modifiers & 4 != 0, meta: modifiers & 8 != 0, alt_graph: false };
            let allowed = matches!((key, modifiers), ("F6", 0 | 1) | ("KeyM" | "KeyL", 3));
            let result = Shortcuts::new(Platform::Control, true).press(&focus, &chord, &[Scope::Timeline], Input::default(), |_| true);
            assert_eq!(matches!(result, Press::Run(_)), allowed, "{key} modifiers={modifiers}");
        }
    }
    for (key, ctrl, alt, id) in [("F6", false, false, "focus-next-region"), ("F6", true, false, "focus-previous-region"), ("KeyM", true, true, "layout-arrange"), ("KeyL", true, true, "layout-menu")] {
        let mut chord = Chord::new(key, ctrl, alt, false);
        assert_eq!(shortcuts::resolve(&chord, &[], Platform::Control, true).unwrap().command.id(), id);
        chord.meta = chord.ctrl; chord.ctrl = false;
        assert!(matches!(Shortcuts::new(Platform::Command, true).press(&focus, &chord, &[], Input::default(), |_| true), Press::Run(_)));
    }
}

#[test]
fn composing_altgraph_and_overlay_never_start_a_command() {
    let mut focus = field(TargetKind::TextEntry);
    let mut chord = Chord::new("F6", false, false, false);
    focus.set_composing(true);
    let mut router = Shortcuts::new(Platform::Control, true);
    assert_eq!(router.press(&focus, &chord, &[], Input::default(), |_| true), Press::Ignored);
    focus.set_composing(false);
    assert_eq!(router.press(&focus, &chord, &[], Input { composing: true, ..Input::default() }, |_| true), Press::Ignored);
    chord.alt_graph = true;
    assert_eq!(router.press(&focus, &chord, &[], Input::default(), |_| true), Press::Ignored);
    chord.alt_graph = false;
    assert_eq!(router.press(&focus, &chord, &[], Input { blocked_by_overlay: true, ..Input::default() }, |_| true), Press::Ignored);
    assert_eq!(router.press(&focus, &Chord::new("KeyP", true, false, false), &[], Input::default(), |_| true), Press::Consumed);
}

#[test]
fn held_keys_release_after_focus_modifiers_or_document_change_and_refusals_rollback() {
    let mut router = Shortcuts::new(Platform::Control, true);
    let chord = Chord::new("ArrowLeft", false, false, false);
    let focus = FocusState::new();
    let Press::Run(press) = router.press(&focus, &chord, &[Scope::Canvas], Input::default(), |_| true) else { panic!("press"); };
    let field = field(TargetKind::TextEntry);
    assert_eq!(router.press(&field, &chord, &[], Input::default(), |_| true), Press::Ignored);
    assert_eq!(router.release("ArrowLeft"), Some(Release { activation: press, cancelled: false }));
    assert_eq!(router.release("ArrowLeft"), None);
    assert!(matches!(router.press(&focus, &chord, &[Scope::Canvas], Input::default(), |_| true), Press::Run(_)));
    assert_eq!(router.release_all().collect::<Vec<_>>(), [Release { activation: press, cancelled: true }]);
    assert!(matches!(router.press(&focus, &chord, &[Scope::Canvas], Input::default(), |_| true), Press::Run(_)));
    assert_eq!(router.reject(press), None, "a refused fresh start clears the hold without an unowned terminal");
    assert_eq!(router.release_all().count(), 0);
    assert_eq!(router.press(&focus, &chord, &[Scope::Canvas], Input::default(), |_| false), Press::Consumed);
    assert!(router.release("ArrowLeft").is_none());
}

#[test]
fn queue_releases_in_order_and_rechecks_busy_after_each_command() {
    let mut queue = GestureQueue::default();
    assert_eq!(queue.submit(action("save"), busy(), &[]), Submitted::Queued);
    assert_eq!(queue.submit(action("undo"), busy(), &[]), Submitted::Queued);
    assert_eq!(queue.next(action("save").document, busy(), Settlement::Ready), Next::Blocked);
    assert_eq!(next(&mut queue), Next::Ready(action("save")));
    assert_eq!(queue.next(action("save").document, Activity { operation: true, ..Activity::default() }, Settlement::Ready), Next::Blocked);
    assert_eq!(next(&mut queue), Next::Ready(action("undo")));
    assert_eq!(next(&mut queue), Next::Empty);
}

#[test]
fn drawing_loading_selection_and_gestures_are_barriers_with_keyboard_escape() {
    for activity in [busy(), Activity { gesture: true, ..Activity::default() }, Activity { loading: true, ..Activity::default() }, Activity { selection: true, ..Activity::default() }, Activity { operation: true, ..Activity::default() }] {
        let mut queue = GestureQueue::default();
        assert_eq!(queue.submit(action("save"), activity, &[]), Submitted::Queued);
        let cancel = Invocation::press(activation("cancel", "Escape"), action("save").document);
        assert_eq!(queue.submit(cancel, activity, &[]), Submitted::Ready(cancel));
    }
    let key = Invocation::press(activation("copy", "KeyC"), action("save").document);
    assert_eq!(GestureQueue::default().submit(key, Activity { selection: true, ..Activity::default() }, &[]), Submitted::Ready(key));
    assert_eq!(GestureQueue::default().submit(key, Activity { selection_committing: true, ..Activity::default() }, &[]), Submitted::Queued);
}

#[test]
fn a_queued_command_never_runs_on_another_document_or_after_failed_settlement() {
    let mut queue = GestureQueue::default();
    queue.submit(action("delete"), busy(), &[]);
    assert_eq!(queue.next(Some(DocumentId::preview(2)), busy(), Settlement::Ready), Next::Cancelled(action("delete")));
    queue.submit(action("save"), busy(), &[]);
    assert_eq!(queue.next(action("save").document, busy(), Settlement::Failed), Next::Cancelled(action("save")));
    assert!(queue.is_empty());
}

#[test]
fn capacity_refuses_visibly_and_reserves_a_held_keys_release() {
    let mut queue = GestureQueue::default();
    let press = Invocation::press(activation("handle-left", "ArrowLeft"), action("save").document);
    let release = Invocation { phase: Phase::Release { cancelled: false }, ..press };
    assert_eq!(queue.submit(press, busy(), &[]), Submitted::Queued);
    for _ in 0..command_queue::CAPACITY - 2 { assert_eq!(queue.submit(action("save"), busy(), &[]), Submitted::Queued); }
    assert_eq!(queue.submit(action("undo"), busy(), &[]), Submitted::Refused { invocation: action("undo"), reason: command_queue::Refusal::Full });
    assert_eq!(queue.submit(release, busy(), &[]), Submitted::Queued);
    assert_eq!(queue.len(), command_queue::CAPACITY);
    assert_eq!(queue.reserved_releases(&[]), 0);
    assert_eq!(next(&mut queue), Next::Ready(press));
    for _ in 0..command_queue::CAPACITY - 2 { assert_eq!(next(&mut queue), Next::Ready(action("save"))); }
    assert_eq!(next(&mut queue), Next::Ready(release));
    assert!(queue.is_empty());
}

#[test]
fn releasing_a_press_from_the_queue_returns_its_reservation() {
    let mut queue = GestureQueue::default();
    let press = Invocation::press(activation("handle-left", "ArrowLeft"), action("save").document);
    queue.submit(press, busy(), &[]);
    assert_eq!(queue.reserved_releases(&[]), 1);
    assert_eq!(next(&mut queue), Next::Ready(press));
    assert_eq!(queue.reserved_releases(&[]), 0);
    queue.submit(press, busy(), &[]);
    assert_eq!(queue.next(Some(DocumentId::preview(2)), busy(), Settlement::Ready), Next::Cancelled(press));
    assert_eq!(queue.reserved_releases(&[]), 0, "cancellation returns the same reservation");
}

#[test]
fn a_refused_held_repeat_can_cancel_through_a_full_queue_without_losing_its_terminal() {
    let mut router = Shortcuts::new(Platform::Control, true);
    let mut queue = GestureQueue::default();
    let chord = Chord::new("ArrowLeft", false, false, false);
    let mut press_key = |repeat| {
        match router.press(&FocusState::new(), &chord, &[Scope::Canvas], Input { repeat, ..Input::default() }, |_| true) {
            Press::Run(press) => press,
            other => panic!("{other:?}"),
        }
    };
    let first = press_key(false);
    assert_eq!(queue.submit(Invocation::press(first, action("save").document), busy(), &[]), Submitted::Queued);
    for _ in 0..command_queue::CAPACITY - 2 {
        assert_eq!(queue.submit(Invocation::press(press_key(true), action("save").document), busy(), &[]), Submitted::Queued);
    }
    let rejected = press_key(true);
    let refused = Invocation::press(rejected, action("save").document);
    assert_eq!(queue.submit(refused, busy(), &[]), Submitted::Refused { invocation: refused, reason: command_queue::Refusal::Full });
    let release = Invocation::release(router.reject(rejected).unwrap(), action("save").document);
    assert_eq!(queue.submit(release, busy(), &[]), Submitted::Queued);
    assert!(router.release("ArrowLeft").is_none(), "the owner rolled back its held key");
    for _ in 0..command_queue::CAPACITY - 1 {
        assert!(matches!(next(&mut queue), Next::Ready(Invocation { phase: Phase::Press, .. })));
    }
    assert_eq!(next(&mut queue), Next::Ready(release));
    assert_eq!(queue.reserved_releases(&[]), 0);
    assert!(queue.is_empty());
}

#[test]
fn polygon_draft_has_distinct_action_and_keyboard_safe_lists() {
    assert!(entry("save").polygon_key);
    assert_eq!(command_queue::polygon_action(entry("save").id, true), Polygon::Refuse);
    assert_eq!(command_queue::polygon_action(entry("open").id, true), Polygon::CancelDraft);
    assert_eq!(command_queue::polygon_action(entry("toggle-grid").id, true), Polygon::Allow);
    assert_eq!(command_queue::polygon_action(entry("delete").id, false), Polygon::Allow);
    let mut router = Shortcuts::new(Platform::Control, true);
    assert_eq!(router.press(&FocusState::new(), &Chord::new("Delete", false, false, false), &[], Input { polygon: true, ..Input::default() }, |_| true), Press::Consumed);
}

#[test]
fn error_policy_preserves_warning_cancel_persistent_and_routine_failure_outcomes() {
    for operation in [Operation::Command, Operation::Save, Operation::Import, Operation::Export] {
        assert_eq!(classify(Kind::Cancelled, operation), None);
        let warning = classify(Kind::User, operation).unwrap();
        assert_eq!(warning.tone, Tone::Warning);
        assert_eq!(warning.lifetime, Lifetime::Timed { milliseconds: 6000 });
        assert!(!warning.dismissible);
        let failed = classify(Kind::Failure, operation).unwrap();
        assert_eq!(failed.tone, Tone::Error);
        assert!(failed.dismissible);
        assert_eq!(failed.lifetime, if operation == Operation::Command { Lifetime::Timed { milliseconds: 8000 } } else { Lifetime::UntilDismissed });
    }
}

#[test]
fn native_menu_preserves_text_history_and_modal_document_gates() {
    use shortcuts::{FieldAction as F, NativeRoute as N, native_route};
    let text = field(TargetKind::TextEntry);
    for (id, action) in [("cut", F::Cut), ("copy", F::Copy), ("paste", F::Paste), ("select-all", F::SelectAll), ("undo", F::Undo), ("redo", F::Redo), ("delete", F::Delete)] {
        assert_eq!(native_route(entry(id).id, &text, false), N::Field(action));
        assert_eq!(native_route(entry(id).id, &text, true), N::Field(action));
        assert_eq!(native_route(entry(id).id, &FocusState::new(), true), N::Blocked);
    }
    let mut vfx = FocusTarget::new(1, FocusArea::Panels, TargetKind::TextEntry);
    vfx.history_owner = styk_core::focus::HistoryOwner::Vfx;
    let mut focus = text.clone();
    focus.register(ScopeId::ROOT, vec![vfx]);
    assert_eq!(native_route(entry("undo").id, &focus, false), N::FeatureHistory { owner: vfx.history_owner, action: F::Undo });
    assert_eq!(native_route(entry("undo").id, &focus, true), N::Field(F::Undo));
    assert_eq!(native_route(entry("delete").id, &FocusState::new(), false), N::Run);
    assert_eq!(native_route(entry("save").id, &text, true), N::Blocked);
}
