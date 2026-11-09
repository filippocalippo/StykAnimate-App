//! V0's production document/runtime/press route, without a window.
#[path = "../../styk-platform/src/spawn.rs"]
mod platform_spawn;
use std::sync::Arc;
use std::time::{Duration, Instant};
use styk_core::{app::Core, commands::{Command, CommandId, Effect}, documents::{Documents, HostOptions, Request}, engine::{Budgets, Engine, json}, stage::{Event, Progress}};
use styk_core::stage::input::{Button, Pointer, PointerPhase};
use styk_services::{FixedClock, input::Modifiers};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

fn opened() -> (Core, Arc<Progress>, Arc<styk_services::files::fake::MemoryFiles>) {
    opened_bytes(STARTUP)
}
fn opened_bytes(bytes: &[u8]) -> (Core, Arc<Progress>, Arc<styk_services::files::fake::MemoryFiles>) {
    let spawner = Arc::new(platform_spawn::ThreadSpawner);
    let progress = Progress::new();
    let files = Arc::new(styk_services::files::fake::MemoryFiles::default());
    let mut documents = Documents::new();
    documents.attach_host(HostOptions {
        engine: Engine::new(|| 0., Budgets::for_device(None)), spawner: spawner.clone(),
        files: files.clone(),
        startup: json::parse(STARTUP).unwrap(), clock: || 0., notify: progress.wake(),
    }).unwrap();
    let mut core = Core::new(documents);
    core.start_runtime(spawner, Arc::new(FixedClock::new()), progress.clone()).unwrap();
    core.dispatch_document(Request::OpenBytes { bytes: bytes.into(), name: "Blue.json".into() }).map_err(|(e, _)| e).unwrap();
    until(&mut core, &progress, |core| core.stage().is_some() && !core.inspector().pending() && core.inspector().model().is_some());
    (core, progress, files)
}

fn until(core: &mut Core, progress: &Progress, ready: impl Fn(&Core) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if progress.poll(std::task::Waker::noop()) {
            while let Some(effect) = core.poll_document() { core.document_effect(&effect); }
            send(core, Command::Wake { now: 0 });
        }
        if ready(core) { return; }
        assert!(Instant::now() < deadline, "the production worker wake must complete the requested state: selection={:?} inspector={} publication={:?}", core.documents.active().and_then(|d| d.selection().ok()), core.inspector().pending(), core.documents.published());
        std::thread::yield_now();
    }
}

fn click(core: &mut Core, point: [f64; 2]) {
    let stage = core.stage().unwrap();
    let point = stage.view().unwrap().document_to_stage(point, [960, 540], None);
    for phase in [PointerPhase::Down, PointerPhase::Up] {
        send(core, Command::Stage(Event::Pointer(Pointer { id: 0, phase, point, button: Button::Left, modifiers: Modifiers::NONE })));
    }
}

#[test]
fn stage_click_selects_figure_joint_and_empty_through_the_runtime() {
    let (mut core, progress, _) = opened();
    click(&mut core, [480., 280.]);
    until(&mut core, &progress, |c| c.documents.active().unwrap().selection().is_ok_and(|s| s.uid == Some(1)));
    assert_eq!(core.documents.active().unwrap().selection().unwrap().joint, -1);
    click(&mut core, [480., 202.]);
    until(&mut core, &progress, |c| c.documents.active().unwrap().selection().is_ok_and(|s| s.joint == 0));
    settle(&mut core, &progress);
    assert_eq!(core.inspector().model().unwrap().kind, styk_core::inspector::model::Kind::Joint);
    assert_eq!(core.inspector().model().unwrap().number(styk_core::inspector::property::PropertyKey::JointLength).unwrap().value, 78.);
    click(&mut core, [20., 20.]);
    until(&mut core, &progress, |c| c.documents.active().unwrap().selection().is_ok_and(|s| s.uid.is_none()));
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 0);
}

#[test]
fn fitted_and_panned_stage_picks_project_the_query_and_handles_once() {
    let (mut core, progress, _) = opened();
    send(&mut core, Command::Stage(Event::Zoom { factor: 1.3, at: [250., 120.] }));
    send(&mut core, Command::Stage(Event::Pan([115., 44.])));
    click(&mut core, [20., 20.]); settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().uid, None);
    click(&mut core, [480., 280.]); settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().joint, -1);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().uid, Some(1));
    click(&mut core, [480., 202.]); settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().joint, 0);
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 0);
}

// Core tests execute the same publication effect as the UI adapter. A mounted app test separately
// proves that adapter; workers are driven only by their notifications, never synthetic frame polling.
fn send(core: &mut Core, command: Command) -> Vec<Effect> {
    let effects = core.dispatch(command);
    if effects.iter().any(|effect| matches!(effect, Effect::RequestFrame | Effect::PollDocuments)) {
        while let Some(effect) = core.poll_document() { core.document_effect(&effect); }
    }
    effects
}
fn settle(core: &mut Core, progress: &Progress) {
    until(core, progress, |c| !c.inspector().pending() && !c.file_pending() && !c.tools_pending());
}
fn dialog(effects: &[Effect]) -> u64 {
    effects.iter().find_map(|effect| if let Effect::Dialog { id, .. } = effect { Some(*id) } else { None }).expect("the real control must request its picker")
}

#[test]
fn a_picker_answer_starts_a_fresh_dispatch_report_even_when_obsolete() {
    let (mut core, _, _) = opened();
    send(&mut core, Command::Run(CommandId::CameraCopy));
    assert_eq!(core.session_report().copied, Some("camera"));
    send(&mut core, Command::DialogAnswer { id: u64::MAX, result: Ok(styk_services::dialogs::Choice::File(None)) });
    assert_eq!(core.session_report().copied, None, "a picker reply must not replay the preceding dispatch's clipboard report");
    assert!(core.session_report().events.is_empty());
}

#[test]
fn cancelled_or_failed_save_picker_releases_the_host_for_the_next_request() {
    use styk_services::dialogs::Choice;
    let (mut core, progress, _) = opened();
    let first = dialog(&send(&mut core, Command::Run(CommandId::SaveAs)));
    send(&mut core, Command::DialogAnswer { id: first, result: Ok(Choice::File(None)) });
    settle(&mut core, &progress);
    let second = dialog(&send(&mut core, Command::Run(CommandId::SaveAs)));
    send(&mut core, Command::DialogAnswer { id: first, result: Ok(Choice::File(None)) });
    assert!(core.file_pending(), "an obsolete answer must not end the current picker");
    let effects = send(&mut core, Command::DialogAnswer { id: second, result: Err("picker unavailable".into()) });
    assert!(effects.iter().any(|effect| matches!(effect, Effect::Notice(notice) if notice.message.key == "privacyUi.operationFailedPleaseTryAgain")), "platform failures must use the translated presentation path");
    settle(&mut core, &progress);
    let third = dialog(&send(&mut core, Command::Run(CommandId::Open)));
    send(&mut core, Command::DialogAnswer { id: third, result: Ok(Choice::File(None)) });
    settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 0);
}
#[test]
fn number_colour_history_save_reopen_and_front_document_stay_together() {
    use styk_core::inspector::{Event as Inspector, FieldEvent, property::PropertyKey, model::{ColorTarget, Kind}};
    use styk_services::{dialogs::Choice, files::FileTarget};
    let (mut core, progress, files) = opened();
    click(&mut core, [480., 280.]); settle(&mut core, &progress);
    assert_eq!(core.inspector().model().unwrap().kind, Kind::Figure);
    for event in [FieldEvent::Focus, FieldEvent::Input("520".into()), FieldEvent::Enter] {
        send(&mut core, Command::Inspector(Inspector::Field(PropertyKey::RootX, event)));
    }
    settle(&mut core, &progress);
    let value = |c: &Core| c.inspector().model().unwrap().number(PropertyKey::RootX).unwrap().value;
    assert_eq!(value(&core), 520.);
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 1);
    send(&mut core, Command::Run(CommandId::Undo)); settle(&mut core, &progress); assert_eq!(value(&core), 480.);
    send(&mut core, Command::Run(CommandId::Redo)); settle(&mut core, &progress); assert_eq!(value(&core), 520.);
    let effects = send(&mut core, Command::Inspector(Inspector::Color(ColorTarget::Figure)));
    // Losing window focus to the native modal does not invalidate its colour answer.
    send(&mut core, Command::Blur);
    let answer = send(&mut core, Command::DialogAnswer { id: dialog(&effects), result: Ok(Choice::Color(Some([220, 60, 60]))) });
    assert!(!answer.iter().any(|effect| matches!(effect, Effect::Notice(_))), "colour answer: {answer:?}");
    settle(&mut core, &progress);
    assert_eq!(styk_core::inspector::color::initial(core.inspector(), ColorTarget::Figure), Some([220, 60, 60]));
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 2);
    let first = core.documents.active().unwrap().id(); let first_stage = core.stage().unwrap();
    let path = FileTarget::new("loop.styk");
    let effects = send(&mut core, Command::Run(CommandId::SaveAs));
    send(&mut core, Command::DialogAnswer { id: dialog(&effects), result: Ok(Choice::File(Some(path.clone()))) });
    settle(&mut core, &progress);
    assert!(!core.documents.active().unwrap().dirty()); assert!(files.get(&path).is_some());
    // Reopen a distinct file identity with the exact bytes the save owner produced.
    let reopened = FileTarget::new("reopened.styk"); files.put(reopened.clone(), files.get(&path).unwrap());
    let effects = send(&mut core, Command::Run(CommandId::Open));
    send(&mut core, Command::DialogAnswer { id: dialog(&effects), result: Ok(Choice::File(Some(reopened))) });
    settle(&mut core, &progress);
    let second = core.documents.active().unwrap().id(); assert_ne!(first, second);
    click(&mut core, [520., 280.]); settle(&mut core, &progress); assert_eq!(value(&core), 520.);
    assert_eq!(styk_core::inspector::color::initial(core.inspector(), ColorTarget::Figure), Some([220, 60, 60]));
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 0);
    send(&mut core, Command::Activate(first)); settle(&mut core, &progress); assert!(Arc::ptr_eq(&first_stage, &core.stage().unwrap()));
    send(&mut core, Command::Activate(second)); settle(&mut core, &progress);
    send(&mut core, Command::Run(CommandId::CloseProject)); settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().id(), first); assert!(Arc::ptr_eq(&first_stage, &core.stage().unwrap()));
    assert_eq!(value(&core), 520.);
}
#[test]
fn superseded_clicks_and_colour_answers_do_not_change_the_new_selection() {
    use styk_core::inspector::{Event as Inspector, model::ColorTarget};
    use styk_services::dialogs::Choice;
    let (mut core, progress, _) = opened();
    click(&mut core, [480., 280.]); click(&mut core, [20., 20.]); settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().uid, None);
    click(&mut core, [480., 280.]); settle(&mut core, &progress);
    let effects = send(&mut core, Command::Inspector(Inspector::Color(ColorTarget::Figure)));
    click(&mut core, [20., 20.]);
    send(&mut core, Command::DialogAnswer { id: dialog(&effects), result: Ok(Choice::Color(Some([1, 2, 3]))) });
    settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().uid, None);
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 0);
    click(&mut core, [480., 280.]); settle(&mut core, &progress);
    assert_ne!(styk_core::inspector::color::initial(core.inspector(), ColorTarget::Figure), Some([1, 2, 3]));
}

#[test]
fn closing_the_last_tab_replaces_its_lineage_and_never_reuses_its_facts() {
    use styk_core::inspector::{color, model::ColorTarget};
    let mut tree = json::parse(STARTUP).unwrap();
    for figure in tree.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap() {
        for segment in figure.make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap() {
            segment.make_obj().unwrap().set("color_rgb", json::parse(b"[220,60,60]").unwrap());
        }
    }
    let (mut core, progress, _) = opened_bytes(json::to_string(&tree).as_bytes());
    let before = core.documents.active().unwrap(); let (id, lineage, revision) = (before.id(), before.lineage(), before.revision());
    assert_eq!(color::initial(core.inspector(), ColorTarget::Figure), Some([220, 60, 60]));
    send(&mut core, Command::Run(CommandId::CloseProject)); settle(&mut core, &progress);
    let after = core.documents.active().unwrap();
    assert_eq!(after.id(), id); assert_ne!(after.lineage(), lineage); assert_eq!(after.revision(), revision);
    assert_eq!(color::initial(core.inspector(), ColorTarget::Figure), Some([13, 153, 255]));
}

#[test]
fn the_selected_joints_colour_changes_its_instance_and_undo_restores_it() {
    use styk_core::inspector::{Event as Inspector, color, model::ColorTarget};
    use styk_services::dialogs::Choice;
    let (mut core, progress, _) = opened();
    click(&mut core, [480., 202.]); settle(&mut core, &progress);
    let effects = send(&mut core, Command::Inspector(Inspector::Color(ColorTarget::Segment)));
    let answer = send(&mut core, Command::DialogAnswer { id: dialog(&effects), result: Ok(Choice::Color(Some([19, 80, 90]))) });
    assert!(!answer.iter().any(|effect| matches!(effect, Effect::Notice(_))), "{answer:?}");
    settle(&mut core, &progress);
    assert_eq!(color::initial(core.inspector(), ColorTarget::Segment), Some([19, 80, 90]));
    assert_eq!(core.documents.active().unwrap().view().unwrap().history.undo, 1);
    send(&mut core, Command::Run(CommandId::Undo)); settle(&mut core, &progress);
    assert_eq!(color::initial(core.inspector(), ColorTarget::Segment), Some([13, 153, 255]));
}

#[test]
fn a_cancelled_press_never_reaches_the_session() {
    let (mut core, progress, _) = opened();
    click(&mut core, [20., 20.]); settle(&mut core, &progress);
    click(&mut core, [480., 280.]);
    send(&mut core, Command::Stage(Event::Pointer(Pointer { id: 0, phase: PointerPhase::Cancel, point: [0., 0.], button: Button::Left, modifiers: Modifiers::NONE })));
    settle(&mut core, &progress);
    assert_eq!(core.documents.active().unwrap().selection().unwrap().uid, None);
}
