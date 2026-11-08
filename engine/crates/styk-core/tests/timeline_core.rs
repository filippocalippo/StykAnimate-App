use std::sync::{Arc, mpsc};
use std::time::Duration;
use styk_core::{
    app::Core,
    commands::{Command, CommandId as Id, Effect},
    settings::{self, SettingId, TimelineMode},
    testing,
    timeline::{self, Event, Modifiers, Payload, Phase, Selection},
};
use styk_doc::Value;
struct Threads;
impl styk_services::Spawner for Threads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|e| styk_services::SpawnError(e.to_string()))
    }
}
struct Rig {
    core: Core,
    wake: mpsc::Receiver<()>,
    files: Arc<styk_services::files::fake::MemoryFiles>,
}
impl Rig {
    fn new() -> Self {
        Self::with(include_bytes!("../../../tests/edit/property-sheet.document.json"), "Timeline.styk")
    }
    fn with(bytes: &[u8], name: &str) -> Self {
        Self::with_core(Core::default(), bytes, name)
    }
    fn with_core(mut core: Core, bytes: &[u8], name: &str) -> Self {
        let (send, wake) = mpsc::channel();
        let notify: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = send.send(());
        });
        let files = Arc::new(styk_services::files::fake::MemoryFiles::default());
        core.documents
            .attach_host(styk_core::documents::HostOptions {
                engine: styk_core::engine::Engine::new(|| 0., styk_core::engine::Budgets::for_device(None)),
                spawner: Arc::new(Threads),
                files: files.clone(),
                startup: styk_doc::json::parse(include_bytes!("../../../tests/edit/startup.document.json")).unwrap(),
                clock: || 0.,
                notify: notify.clone(),
            })
            .unwrap();
        assert!(matches!(
            core.dispatch_document(styk_core::documents::Request::OpenBytes { bytes: Arc::from(bytes), name: name.into() }),
            Ok(styk_core::documents::Effect::Started(_))
        ));
        while core.documents.active().is_none() {
            if core.poll_document().is_none() {
                wake.recv_timeout(Duration::from_secs(30)).unwrap();
            }
        }
        core.start_timeline(&Threads, notify).unwrap();
        let mut rig = Self { core, wake, files };
        rig.settle();
        rig
    }
    fn settle(&mut self) {
        let until = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            assert!(std::time::Instant::now() < until, "timeline did not settle");
            while self.core.poll_document().is_some() {}
            self.core.dispatch(Command::Wake { now: 100 });
            self.core.refresh();
            if !self.core.timeline().model().pending {
                return;
            }
            self.wake.recv_timeout(Duration::from_secs(30)).expect("timeline worker wakes its host");
        }
    }
    fn action(&mut self, id: Id, payload: Payload) -> Vec<Effect> {
        let effects = self.core.dispatch(Command::Timeline(Event::Action { id, payload, now: 100 }));
        self.settle();
        effects
    }
    fn tick(&self) -> f64 {
        self.core.documents.active().unwrap().view().unwrap().tick
    }
    fn request(&mut self, mut request: styk_core::documents::Request) -> styk_core::documents::Effect {
        let until = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            assert!(std::time::Instant::now() < until, "document request did not settle");
            match self.core.dispatch_document(request) {
                Ok(effect) => return effect,
                Err((styk_core::documents::HostError::Documents(styk_core::documents::DocumentsError::Busy), returned)) => {
                    request = returned;
                    self.settle();
                }
                Err((error, _)) => panic!("request failed: {error}"),
            }
        }
    }
    fn completion(&mut self) -> styk_core::documents::Effect {
        loop {
            if let Some(effect) = self.core.poll_document() {
                return effect;
            }
            self.wake.recv_timeout(Duration::from_secs(30)).unwrap();
        }
    }
}
#[test]
fn accepted_exit_fences_commands_and_document_requests_until_window_teardown() {
    let mut rig = Rig::new();
    let revision = rig.core.documents.active().unwrap().revision();
    assert!(rig.core.dispatch(Command::PrepareExit).iter().any(|effect| matches!(effect, Effect::ExitReady)));
    rig.core.dispatch(Command::Timeline(Event::Action { id: Id::TimelineSetFps, payload: Payload::Number(30.), now: 200 }));
    rig.core.dispatch(Command::Settings(settings::Event::Set { id: SettingId::LoopPlayback, value: Value::Bool(false), now: 200 }));
    for _ in 0..3 { rig.core.dispatch(Command::Wake { now: 200 }); }
    assert!(rig.core.documents.active().unwrap().view().is_ok(), "no edit may acquire the session after accepted exit");
    assert_eq!(rig.core.documents.active().unwrap().revision(), revision);
    assert!(rig.core.settings().animation().loop_playback, "no new preference may follow the final flush");
    assert!(matches!(rig.core.dispatch_document(styk_core::documents::Request::Publish), Err((styk_core::documents::HostError::Documents(styk_core::documents::DocumentsError::Busy), _))));
}

#[test]
fn no_document_refusal_cannot_poison_open_or_edit_the_next_document() {
    let mut core = Core::default();
    let effects = core.dispatch(Command::Timeline(Event::Action { id: Id::TimelineSetFps, payload: Payload::Number(31.), now: 0 }));
    assert!(effects.iter().any(|effect| matches!(effect, Effect::Notice(_))));
    let rig = Rig::with_core(core, include_bytes!("../../../tests/edit/property-sheet.document.json"), "Timeline.styk");
    assert_eq!(rig.core.timeline().model().fps, 24.);
    assert_eq!(testing::undo_depth(&rig.core), 0);
}
#[test]
fn fps_uses_one_session_edit_and_exact_undo_redo() {
    let mut rig = Rig::new();
    let before = rig.core.documents.active().unwrap().records().unwrap().clone();
    let history = testing::undo_depth(&rig.core);
    let effects = rig.action(Id::TimelineSetFps, Payload::Number(31.));
    assert!(!effects.iter().any(|e| matches!(e, Effect::Notice(_))));
    assert_eq!(testing::undo_depth(&rig.core), history + 1);
    let after = rig.core.documents.active().unwrap().records().unwrap().clone();
    assert_eq!(after.get("fps"), Some(&Value::Num(31.)));
    rig.core.dispatch(Command::Run(Id::Undo));
    rig.settle();
    assert_eq!(rig.core.documents.active().unwrap().records().unwrap(), &before);
    rig.core.dispatch(Command::Run(Id::Redo));
    rig.settle();
    assert_eq!(rig.core.documents.active().unwrap().records().unwrap(), &after);
    rig.action(Id::TimelineSetFps, Payload::Number(f64::NAN));
    assert_eq!(rig.core.documents.active().unwrap().records().unwrap(), &after);
}
#[test]
fn mode_selection_and_navigation_share_session_and_inspector_range() {
    let mut rig = Rig::new();
    let depth = testing::undo_depth(&rig.core);
    let model = rig.core.timeline().model();
    assert!(model.row_count >= 3);
    assert!(model.card_count >= 1);
    rig.action(Id::TimelineSeek, Payload::Number(1000.));
    assert_eq!(rig.tick(), 1000., "advanced beyond-end navigation never extends the document");
    rig.action(Id::TimelineSimple, Payload::None);
    assert_eq!(rig.core.settings().animation().timeline_mode, TimelineMode::Simple);
    rig.action(Id::FirstFrame, Payload::None);
    let cards = rig.core.timeline().model().cards.clone();
    rig.action(Id::NextFrame, Payload::None);
    if cards.len() > 1 {
        assert_eq!(rig.tick(), cards[1].tick as f64);
    }
    rig.action(Id::TimelineAdvanced, Payload::None);
    rig.action(Id::TimelineSelectCell, Payload::Cell { point: [220. + 14., 81.], modifiers: Modifiers::default() });
    rig.action(
        Id::TimelineSelectCell,
        Payload::Cell { point: [220. + 6. * 14., 81.], modifiers: Modifiers { extend: true, toggle: false } },
    );
    assert_eq!(rig.core.view_state().range(), &Selection::Span { first: 1, last: 6 });
    rig.core.dispatch(Command::Run(Id::ToggleRangeEdit));
    assert!(rig.core.view_state().apply_range());
    assert_eq!(
        styk_core::range::Range::of(rig.core.view_state(), rig.core.documents.active().unwrap()).unwrap().sheet_ticks,
        Some(vec![1., 6.])
    );
    assert_eq!(testing::undo_depth(&rig.core), depth, "selection, modes and seeks are not edits");
}
#[test]
fn geometry_and_scrub_release_live_in_core_and_leave_no_history() {
    let mut rig = Rig::new();
    let history = testing::undo_depth(&rig.core);
    rig.core.dispatch(Command::Timeline(Event::Viewport { width: 400., height: 112. }));
    let geometry = rig.core.timeline().model().geometry.clone();
    assert_eq!(geometry.row(5., 4), None);
    assert_eq!(geometry.row(33., 4), Some(0));
    assert_eq!(geometry.tick(248.), Some(2));
    rig.action(Id::TimelineScrub, Payload::Scrub { phase: Phase::Begin, x: 248. });
    rig.action(Id::TimelineScrub, Payload::Scrub { phase: Phase::Move, x: 276. });
    rig.action(Id::TimelineScrub, Payload::Scrub { phase: Phase::End, x: 290. });
    assert_eq!(rig.tick(), 5.);
    assert_eq!(testing::undo_depth(&rig.core), history);
    assert!(rig.core.timeline().deadline().is_none(), "a released scrub has no idle wake");
    rig.action(Id::TimelineSeek, Payload::Number(500.));
    assert!(rig.core.timeline().model().geometry.scroll_x > 0.);
    assert!(rig.core.timeline().model().geometry.ticks().contains(&500));
}
#[test]
fn settings_change_and_revert_are_dispatched_and_late_revert_is_rejected() {
    let mut core = Core::default();
    let change = core
        .dispatch(Command::Settings(settings::Event::Set { id: SettingId::FitViewOnPlayback, value: Value::Bool(false), now: 0 }))
        .into_iter()
        .find_map(|effect| if let Effect::SettingsChanged(c) = effect { Some(c) } else { None })
        .unwrap();
    assert!(!core.settings().animation().fit_view_on_playback);
    let effects = core.dispatch(Command::Settings(settings::Event::Revert { change: change.clone(), now: 1 }));
    assert!(core.settings().animation().fit_view_on_playback);
    assert!(effects.iter().any(|e| matches!(e, Effect::SettingsChanged(_))));
    assert!(core.dispatch(Command::Settings(settings::Event::Revert { change, now: 2 })).is_empty());
}
#[test]
fn compact_selection_and_edge_scroll_do_not_allocate_per_tick() {
    let selection = Selection::Span { first: 0, last: 10_000_000 };
    assert_eq!(selection.len(), 10_000_001);
    assert_eq!(selection.iter().take(3).collect::<Vec<_>>(), [0, 1, 2]);
    let mut geometry = timeline::geometry::Geometry::default();
    assert!(geometry.scrub_edge(900., 100, 20, 10_000));
    assert!(geometry.scroll_x > 0.);
    geometry.scroll(f64::NAN, 0., 20, 10_000);
    assert!(geometry.scroll_x.is_finite());
}
#[test]
fn playback_waits_for_time_audio_and_actual_submission_then_reanchors_stalls() {
    use timeline::transport::*;
    let mut transport = Transport::default();
    transport.model.looping = true;
    transport.range(Some((2, 6)), 10);
    assert!(transport.start(9., 10, 100));
    assert_eq!(transport.tick(100, 9., 25., 10, Audio::Preparing, true), None);
    assert_eq!(transport.tick(100, 9., 25., 10, Audio::Silent, false), None);
    let first = transport.tick(100, 9., 25., 10, Audio::Silent, true).unwrap();
    assert_eq!(first.tick, 2.);
    assert_eq!(transport.tick(1000, 2., 25., 10, Audio::Silent, true), None, "ready is not submitted");
    assert!(transport.submitted(first, 1000, 25.));
    assert_eq!(transport.tick(1039, 2., 25., 10, Audio::Silent, true), None);
    assert_eq!(transport.tick(1040, 2., 25., 10, Audio::Starting, true), None);
    assert_eq!(transport.tick(1040, 2., 25., 10, Audio::Running(0.1), true), None);
    assert_eq!(transport.tick(1040, 2., 25., 10, Audio::Running(0.12), false), None);
    assert_eq!(transport.model.state, State::Buffering);
    let second = transport.tick(5000, 2., 25., 10, Audio::Silent, true).unwrap();
    assert_eq!(second.tick, 3., "a stall never skips frames");
    transport.submitted(second, 5000, 25.);
    assert_eq!(transport.tick(5000, 3., 25., 10, Audio::Silent, true), None, "no catch-up burst");
    transport.pause();
    assert!(!transport.submitted(second, 6000, 25.));
    assert_eq!(transport.deadline(), None);
}
#[test]
fn ranges_shrink_and_loop_or_stop_at_half_open_end() {
    use timeline::transport::*;
    assert_eq!(normalize(Some((9, 30)), 5), (4, 5));
    let mut transport = Transport::default();
    transport.range(Some((2, 4)), 6);
    transport.model.looping = true;
    transport.start(3., 6, 0);
    let start = transport.tick(0, 3., 24., 6, Audio::Silent, true).unwrap();
    assert_eq!(start.tick, 2.);
    transport.submitted(start, 0, 24.);
    assert_eq!(transport.next(3., 6), Some(2.));
    transport.model.looping = false;
    assert_eq!(transport.next(3., 6), None);
    assert_eq!(transport.tick(40, 3., 24., 6, Audio::Silent, true), None);
    assert!(transport.playing(), "the last frame keeps its duration");
    assert_eq!(transport.tick(42, 3., 24., 6, Audio::Silent, true), None);
    assert!(!transport.playing());
    assert_eq!(startup_frames(24., 1., 4), 3);
    assert_eq!(startup_frames(24., 40., 4), 6);
}

#[test]
#[ignore = "explicit byte oracle; first run tests/native-documents-save-reference.test.mjs against the pinned app, then set STYK_NATIVE_SAVE_ORACLE"]
fn core_fps_navigation_saves_equal_today_after_undo_redo_and_reopen() {
    use styk_core::documents::{Documents, Effect as Saved, PreparedDocument, Request};
    use styk_services::files::FileTarget;
    let oracle = std::path::PathBuf::from(std::env::var_os("STYK_NATIVE_SAVE_ORACLE").expect("required old-versus-old baseline"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut count = 0;
    for variant in ["", "-navigation"] {
        for (case, path, name) in [
            ("startup", "../../tests/edit/startup.document.json", "Parity.styk"),
            ("channels", "../../tests/containers/project-channels.styk", "Parity.styk"),
            ("drawing", "../../tests/containers/project-drawing.styk", "Parity.styk"),
            ("pivot", "../styk-piv/tests/fixtures/modern-type-change.piv", "Parity.piv"),
        ] {
            let mut rig = Rig::with(&std::fs::read(root.join(path)).unwrap(), name);
            let id = rig.core.documents.active().unwrap().id();
            for phase in 0..4 {
                match phase {
                    1 => {
                        rig.action(Id::TimelineSetFps, Payload::Number(30.));
                    }
                    2 => {
                        rig.core.dispatch(Command::Run(Id::Undo));
                        rig.settle();
                    }
                    3 => {
                        rig.core.dispatch(Command::Run(Id::Redo));
                        rig.settle();
                    }
                    _ => {}
                }
                if !variant.is_empty() {
                    rig.action(Id::TimelineSelectLayer, Payload::Layer { id: "camera".into(), modifiers: Modifiers::default() });
                }
                // These transport/view operations must not leak into document bytes or history.
                rig.action(Id::TimelineSeek, Payload::Number(3.));
                if variant.is_empty() {
                    rig.action(Id::TimelineSimple, Payload::None);
                    rig.action(Id::TimelineAdvanced, Payload::None);
                }
                let mut effect = rig.request(Request::Save { document: id, save_as: true });
                while matches!(effect, Saved::Started(_) | Saved::None | Saved::Published { .. }) {
                    effect = rig.completion();
                }
                let Saved::SaveDialog { prompt, .. } = effect else {
                    panic!("save target: {effect:?}");
                };
                let target = FileTarget::new(format!("{case}.styk"));
                assert!(matches!(rig.request(Request::SaveTarget { prompt, target: Some(target.clone()) }), Saved::Started(_)));
                loop {
                    let effect = rig.completion();
                    if matches!(effect, Saved::Saved { current: true, .. }) {
                        break;
                    }
                    assert!(matches!(effect, Saved::None | Saved::Published { .. }), "{effect:?}");
                }
                let bytes = rig.files.get(&target).unwrap();
                let expected = std::fs::read(oracle.join(format!("{case}{variant}-{phase}.styk"))).unwrap();
                if bytes.as_ref() != expected {
                    std::fs::write(oracle.join("actual-mismatch.styk"), &bytes).unwrap();
                }
                assert!(bytes.as_ref() == expected, "{case}{variant}/{phase}: all bytes ({} vs {} bytes)", bytes.len(), expected.len());
                let engine = styk_core::engine::Engine::new(|| 0., styk_core::engine::Budgets::for_device(None));
                let prepared = PreparedDocument::open_bytes(&engine, bytes, "Parity.styk", &|| false).unwrap();
                let mut reopened = Documents::new();
                let reopened_id = reopened.open(prepared).map_err(|(e, _)| e).unwrap();
                assert_eq!(
                    reopened.get(reopened_id).unwrap().with_document(|d| d.fps).unwrap(),
                    rig.core.documents.active().unwrap().with_document(|d| d.fps).unwrap()
                );
                assert!(reopened.get(reopened_id).unwrap().frame_records().is_ok());
                count += 1;
            }
        }
    }
    assert_eq!(count, 32);
    println!("TIMELINE_SAVE_BYTES: 32 exact comparisons and reopens passed");
}

#[test]
fn range_geometry_readout_quality_and_global_dedup_follow_reference_boundaries() {
    use timeline::transport::*;
    let selected = Selection::items(vec![3, 1, 3, 2, 1]);
    assert_eq!(selected.iter().collect::<Vec<_>>(), [3, 1, 2]);
    assert_eq!(Selection::Span { first: 8, last: 3 }.len(), 0);
    let mut g = timeline::geometry::Geometry::default();
    g.viewport(800., 400.);
    g.scroll(140., 96., 20, 100);
    assert!(g.pinned(20));
    assert_eq!(g.row(33., 20), Some(0));
    assert_eq!(g.row(58., 20), Some(1));
    assert_eq!(g.row(81., 20), Some(5));
    assert_eq!(g.rows(20)[..3], [0, 1, 5]);
    g.reveal(0., Some(2), 20, 100);
    assert_eq!((g.scroll_x, g.scroll_y), (0., 0.));
    g.viewport(112., 112.);
    g.reveal_card(5, 10);
    assert_eq!(g.card(56., 10), Some(5));
    let mut t = Transport::default();
    t.start(0., 100, 0);
    for now in [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 440, 480] {
        let tick = (now / 40) as f64;
        let d = t.tick(now, if now == 0 { 0. } else { tick - 1. }, 25., 100, Audio::Silent, true).unwrap();
        t.submitted(d, now, 25.);
        if now == 240 {
            t.observe(250);
        }
    }
    t.observe(499);
    assert_eq!(t.model.measured_fps, None);
    t.observe(500);
    assert_eq!(t.model.measured_fps, Some(26.));
    assert_eq!(t.model.shown_frames, 13);
    let mut q = Quality::default();
    assert!(!q.update(Some(20.), 25., 0, false));
    assert!(!q.update(Some(20.), 25., 2500, false));
    assert!(q.update(Some(20.), 25., 2501, false));
    assert_eq!(q.index, 1);
    assert!(!q.update(Some(25.), 25., 2502, false));
    assert!(!q.update(Some(25.), 25., 8502, false));
    assert!(q.update(Some(25.), 25., 8503, false));
    assert_eq!(q.index, 0);
}
#[test]
fn final_scrub_target_and_busy_save_survive_the_exclusive_worker() {
    let mut rig = Rig::new();
    let id = rig.core.documents.active().unwrap().id();
    for (phase, x) in [(Phase::Begin, 248.), (Phase::Move, 276.), (Phase::End, 318.)] {
        rig.core.dispatch(Command::Timeline(Event::Action { id: Id::TimelineScrub, payload: Payload::Scrub { phase, x }, now: 100 }));
    }
    let request = styk_core::documents::Request::Save { document: id, save_as: true };
    let (_, request) = rig.core.dispatch_document(request).expect_err("save waits for the final seek");
    rig.settle();
    assert_eq!(rig.tick(), 7.);
    let mut effect = rig.request(request);
    while matches!(
        effect,
        styk_core::documents::Effect::Started(_) | styk_core::documents::Effect::None | styk_core::documents::Effect::Published { .. }
    ) {
        effect = rig.completion();
    }
    let styk_core::documents::Effect::SaveDialog { prompt, .. } = effect else { panic!("{effect:?}") };
    rig.request(styk_core::documents::Request::SaveTarget { prompt, target: None });
    assert_eq!(testing::undo_depth(&rig.core), 0);
}

#[test]
fn executable_legacy_policies_match_geometry_ranges_quality_hotkeys_and_settings() {
    let output = std::process::Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/timeline-reference.mjs"))
        .output()
        .expect("Node is required for the executable legacy oracle");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let reference = styk_doc::json::parse(&output.stdout).unwrap();
    for row in reference.get("geometry").unwrap().as_arr().unwrap() {
        let mut g = timeline::geometry::Geometry::default();
        g.viewport(800., row.get("height").unwrap().as_f64().unwrap());
        assert_eq!(Some(g.pinned(20)), row.get("pinned").and_then(Value::as_bool));
        for i in 0..20 {
            assert_eq!(Some(g.row_top(i)), row.get("tops").unwrap().elements().unwrap().get(i).unwrap().as_f64());
            assert_eq!(Some(g.row_size(i)), row.get("sizes").unwrap().elements().unwrap().get(i).unwrap().as_f64());
        }
    }
    let mut g = timeline::geometry::Geometry::default();
    let mut before = 0;
    let mut left = 0.;
    for (i, now) in [8, 16, 32, 80, 180].into_iter().enumerate() {
        g.scrub_edge(782., now - before, 20, 1000);
        assert_eq!(Some(g.scroll_x - left), reference.get("edge").unwrap().elements().unwrap().get(i).unwrap().as_f64());
        before = now;
        left = g.scroll_x;
    }
    for (i, input) in [None, Some((9, 30)), Some((2, 4))].into_iter().enumerate() {
        let actual = timeline::transport::normalize(input, 5);
        let expected = &reference.get("range").unwrap().as_arr().unwrap()[i];
        assert_eq!(
            (Some(actual.0 as f64), Some(actual.1 as f64)),
            (expected.get("start").and_then(Value::as_f64), expected.get("end").and_then(Value::as_f64))
        );
    }
    let mut quality = timeline::transport::Quality::default();
    for (i, now) in [0, 2500, 2501, 2502, 8502, 8503].into_iter().enumerate() {
        let changed = quality.update(Some(if i < 3 { 20. } else { 25. }), 25., now, false);
        let expected = reference.get("quality").unwrap().as_arr().unwrap()[i].as_arr().unwrap();
        assert_eq!(Some(changed), expected[0].as_bool());
        assert_eq!(Some(quality.index as f64), expected[1].as_f64());
    }
    for case in reference.get("settings").unwrap().as_arr().unwrap() {
        let mut model = settings::Settings::default();
        let envelope = styk_doc::json::parse(
            format!(
                r#"{{"schema":1,"values":{},"view":{}}}"#,
                styk_doc::json::to_string(case.get("input").unwrap()),
                styk_doc::json::to_string(case.get("input").unwrap())
            )
            .as_bytes(),
        )
        .unwrap();
        model.loaded(envelope);
        for &id in SettingId::ALL {
            assert_eq!(Some(&model.value(id)), case.get("values").unwrap().get(id.key()));
        }
    }
    let mut rig = Rig::new();
    rig.action(Id::TimelineSimple, Payload::None);
    rig.action(Id::FirstFrame, Payload::None);
    rig.action(Id::NextFrame, Payload::None);
    let at = rig.core.timeline().model().cards.iter().position(|c| c.tick as f64 == rig.tick()).unwrap();
    rig.action(Id::TimelineLayerUp, Payload::None);
    let wanted = (at + 1).min(rig.core.timeline().model().card_count - 1);
    assert_eq!(rig.tick(), rig.core.timeline().model().cards[wanted].tick as f64);
    assert_eq!(reference.get("simpleUp").and_then(Value::as_f64), Some(2.));
    rig.action(Id::TimelineAdvanced, Payload::None);
    rig.action(Id::TimelineSelectCell, Payload::Cell { point: [234., 81.], modifiers: Modifiers::default() });
    rig.action(Id::TimelineSelectCell, Payload::Cell { point: [304., 81.], modifiers: Modifiers { extend: true, toggle: false } });
    assert_eq!(
        rig.core.view_state().edit_range().iter().map(|tick| tick as f64).collect::<Vec<_>>(),
        reference.get("selectionTicks").unwrap().numbers().unwrap()
    );
}
