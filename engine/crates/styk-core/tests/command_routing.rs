//! Review regressions enter through the production shortcut router and gesture queue.
use std::process::Command;
use styk_core::command_queue::{Activity, GestureQueue, Invocation, Next, Phase, Settlement, Submitted};
use styk_core::command_registry;
use styk_core::documents::DocumentId;
use styk_core::engine::{json, Value};
use styk_core::focus::{FocusArea, FocusId, FocusState, FocusTarget, HistoryOwner, InputRole, ScopeId, TargetKind};
use styk_core::shortcuts::{FieldAction, Input, Platform, Press, Scope, Shortcuts};
use styk_core::text_entry::Chord;
use styk_edit::session::Session;

fn flag(value: &Value, key: &str) -> bool { value.get(key).and_then(Value::as_bool).unwrap_or(false) }
fn text<'a>(value: &'a Value, key: &str) -> &'a str { value.get(key).and_then(Value::as_str).unwrap_or("") }

fn reference_group(group: &str) {
    let output = Command::new("node").arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/command-routing-reference.mjs"))
        .arg(group).output().expect("Node is required to execute the reference handlers");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let cases = json::parse(&output.stdout).unwrap();
    for case in cases.as_arr().unwrap() {
        let role = match text(case, "role") { "text" => InputRole::Text, "select" => InputRole::Select,
            "checkbox" => InputRole::Checkbox, "radio" => InputRole::Radio, "other" => InputRole::Other, _ => InputRole::None };
        let mut focus = FocusState::new();
        let mut target = FocusTarget::new(1, FocusArea::Panels, if role == InputRole::Text { TargetKind::TextEntry } else { TargetKind::Control });
        target.input_role = role;
        target.history_owner = if flag(case, "vfx") { HistoryOwner::Vfx } else { HistoryOwner::Field };
        focus.register(ScopeId::ROOT, vec![target]);
        focus.reconcile(Some(FocusId(1)));
        let chord = Chord { key: text(case, "code").to_owned(), ctrl: flag(case, "ctrlKey"), alt: flag(case, "altKey"),
            shift: flag(case, "shiftKey"), meta: false, alt_graph: false };
        let scopes: Vec<_> = case.get("scopes").and_then(Value::as_arr).unwrap_or(&[]).iter().map(|s| Scope::parse(s.as_str().unwrap()).unwrap()).collect();
        let input = Input { repeat: flag(case, "repeat"), drag: flag(case, "drag"), blocked_by_overlay: flag(case, "overlay"), ..Input::default() };
        let mut predicate_reached = false;
        let actual = Shortcuts::new(Platform::Control, true).press(&focus, &chord, &scopes, input, |_| { predicate_reached = true; true });
        let runs = case.get("runs").unwrap().as_arr().unwrap();
        let expected = runs.first().and_then(Value::as_str);
        match expected {
            Some("cancel-drag") => assert_eq!(actual, Press::CancelDrag, "{case:?}"),
            Some(id @ ("undo" | "redo")) if flag(case, "vfx") => {
                assert_eq!(actual, Press::FeatureHistory { owner: HistoryOwner::Vfx, action: if id == "undo" { FieldAction::Undo } else { FieldAction::Redo } }, "{case:?}");
                assert!(predicate_reached, "feature history still observes the command gate");
            }
            Some(id) => assert!(matches!(actual, Press::Run(activation) if activation.entry.id == id), "{case:?}: {actual:?}"),
            None => assert!(matches!(actual, Press::Ignored | Press::Consumed), "{case:?}: {actual:?}"),
        }
    }
}

#[test]
fn review_input_controls_suppress_editor_keys_with_only_the_builder_exceptions() { reference_group("controls"); }

#[test]
fn review_vfx_field_history_reaches_its_owner_through_keyboard_routing() { reference_group("history"); }

#[test]
fn review_modified_cancel_falls_back_only_during_a_drag_after_the_input_gates() { reference_group("drag"); }

#[test]
fn review_field_capture_repeats_shell_commands_without_changing_global_repeats() { reference_group("repeat"); }

fn session() -> Session {
    // Read the existing fixture in place; never rewrite or re-record it.
    let fixture = json::parse(include_bytes!("../../../../engine/tests/edit/camera-follow-handles-sheet.reference.json")).unwrap();
    let report = json::parse(fixture.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    Session::start(report, r#"{"tick":6,"frameIndex":1,"selectedUid":1,"selectedUids":[1],"selectedJoint":-1,"layerTimeline":true,"propertyChannels":true}"#).unwrap()
}

fn edit(session: &mut Session, method: &str, args: &str) {
    let answer = json::parse(session.call(method, args, "null").as_bytes()).unwrap();
    assert_eq!(text(&answer, "status"), "ok", "{method}: {answer:?}");
}

#[test]
fn review_live_handle_repeats_and_release_do_not_wait_on_their_own_gesture() {
    let document = Some(DocumentId::preview(1));
    let active = Activity { gesture: true, keyboard_handles: document, ..Activity::default() };
    for initially_queued in [false, true] {
        let mut router = Shortcuts::new(Platform::Control, true);
        let mut queue = GestureQueue::default();
        let mut session = session();
        let baseline = session.report().clone();
        let chord = Chord::new("ArrowLeft", false, false, false);
        let Press::Run(first) = router.press(&FocusState::new(), &chord, &[Scope::Canvas], Input::default(), |_| true) else { panic!("first press"); };
        let first = Invocation::press(first, document);
        let save = Invocation::action(command_registry::by_id("save").unwrap(), document);
        let barrier = if initially_queued { Activity { stroke: true, ..Activity::default() } } else { Activity::default() };
        assert_eq!(queue.submit(first, barrier), if initially_queued { Submitted::Queued } else { Submitted::Ready(first) });
        if !initially_queued {
            edit(&mut session, "beginTranslationDrag", r#"["Nudge figures"]"#);
            edit(&mut session, "nudgeHandle", "[-1,0]");
        }
        assert_eq!(queue.submit(save, if initially_queued { barrier } else { active }), Submitted::Queued);
        let Press::Run(repeat) = router.press(&FocusState::new(), &chord, &[Scope::Canvas], Input { repeat: true, ..Input::default() }, |_| true) else { panic!("repeat"); };
        let repeat = Invocation::press(repeat, document);
        assert_eq!(queue.submit(repeat, if initially_queued { barrier } else { active }),
            if initially_queued { Submitted::Queued } else { Submitted::Ready(repeat) });
        let release = Invocation::release(router.release("ArrowLeft").unwrap(), document);
        assert_eq!(queue.submit(release, if initially_queued { barrier } else { active }),
            if initially_queued { Submitted::Queued } else { Submitted::Ready(release) });
        if initially_queued {
            assert_eq!(queue.next(document, Activity::default(), Settlement::Ready), Next::Ready(first));
            edit(&mut session, "beginTranslationDrag", r#"["Nudge figures"]"#);
            edit(&mut session, "nudgeHandle", "[-1,0]");
            // The older Save still waits, but cannot trap the gesture's continuation or terminal.
            assert_eq!(queue.next(document, active, Settlement::Ready), Next::Ready(repeat));
            assert_eq!(queue.next(document, active, Settlement::Ready), Next::Ready(release));
        }
        edit(&mut session, "nudgeHandle", "[-1,0]");
        assert!(matches!(release.phase, Phase::Release { .. }));
        edit(&mut session, "commitDrag", "[]");
        assert_ne!(session.report(), &baseline);
        let after = session.report().clone();
        assert_eq!(queue.next(document, Activity::default(), Settlement::Ready), Next::Ready(save));
        assert_eq!(queue.next(document, Activity::default(), Settlement::Ready), Next::Empty);
        assert_eq!(queue.reserved_releases(), 0);
        edit(&mut session, "undo", "[]");
        assert_eq!(session.report(), &baseline);
        assert!(!session.can_undo(), "all repeats commit one undo entry");
        edit(&mut session, "redo", "[]");
        assert_eq!(session.report(), &after);
    }
}
