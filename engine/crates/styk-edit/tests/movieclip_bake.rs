//! Worker planning + owning publication is compared at every actual editor step.
use std::path::Path;
use styk_doc::{Value, json};
use styk_edit::{EditError, Editor, Options, Selection, movieclip_planning::TimelineWorker};
fn items(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::elements)
        .map(|e| e.iter().collect())
        .unwrap_or_default()
}
fn editor(initial: &Value, report: Value, sheet: bool) -> Editor {
    let state = initial.get("state").unwrap();
    let mut e = Editor::new(
        report,
        Options {
            property_channels: sheet,
            layer_timeline: sheet,
            auto_key: false,
        },
    );
    e.set_view(
        state.get("tick").unwrap().as_f64().unwrap(),
        state.get("frameIndex").unwrap().as_f64().unwrap() as usize,
        Selection {
            uid: state
                .get("selectedUid")
                .and_then(Value::as_f64)
                .map(|u| u as u32),
            uids: state
                .get("selectedUids")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .map(|u| *u as u32)
                .collect(),
            joint: state.get("selectedJoint").unwrap().as_f64().unwrap() as i64,
        },
    );
    e.set_counters(
        state.get("layerRevision").unwrap().as_f64().unwrap() as u64,
        state.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
        state.get("nextUid").unwrap().as_f64().unwrap() as u64,
    );
    e
}
fn live(name: &str) -> Editor {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/movieclip-bake/{name}.json"));
    let reference = json::parse(&std::fs::read(path).unwrap()).unwrap();
    let steps = items(reference.get("steps"));
    let report = json::parse(steps[0].get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut editor = editor(&steps[0], report, name.contains("-sheet"));
    for step in &steps[1..5] {
        let call = items(step.get("call"));
        editor.call(call[0].as_str().unwrap(), &call[1..]).unwrap();
    }
    editor.take_events();
    editor
}

#[test]
fn worker_bake_cancellation_and_budget_preserve_live_gesture() {
    for name in ["bake-native-live", "bake-sheet-live"] {
        let mut successful = live(name);
        let mut checks = 0;
        successful.call_movieclip_timeline_worker("bakeMovieclip", &[], &mut TimelineWorker {
            max_source_bytes: 128 * 1024 * 1024, check: &mut || { checks += 1; Ok(()) },
            progress: &mut |_| {}, clock: || 0.0,
        }).unwrap();
        assert!(checks > 1);
        for at in 1..=checks {
            let mut cancelled = live(name);
            let (report, state) = (cancelled.report_json(), json::to_string(&cancelled.state_value()));
            let mut seen = 0;
            let result = cancelled.call_movieclip_timeline_worker("bakeMovieclip", &[], &mut TimelineWorker {
                max_source_bytes: 128 * 1024 * 1024,
                check: &mut || { seen += 1; if seen == at { Err(EditError::Invalid("host-bake-cancel".into())) } else { Ok(()) } },
                progress: &mut |_| {}, clock: || 0.0,
            });
            assert!(matches!(result, Err(EditError::Invalid(ref key)) if key == "host-bake-cancel"), "{name} at{at}");
            assert_eq!(cancelled.report_json(), report, "{name} at{at}");
            assert_eq!(json::to_string(&cancelled.state_value()), state, "{name} at{at}");
            assert!(cancelled.take_events().is_empty(), "{name} at{at}");
            let mut untouched = live(name);
            for editor in [&mut cancelled, &mut untouched] { editor.call("cancelDrag", &[]).unwrap(); }
            assert_eq!(cancelled.report_json(), untouched.report_json(), "{name} cancelled gesture at{at}");
            assert_eq!(cancelled.state_value(), untouched.state_value());
            assert_eq!(cancelled.take_events(), untouched.take_events());
        }
        for bytes in [0, 1] {
            let mut limited = live(name);
            let (report, state) = (limited.report_json(), limited.state_value());
            let result = limited.call_movieclip_timeline_worker("bakeMovieclip", &[], &mut TimelineWorker {
                max_source_bytes: bytes, check: &mut || Ok(()), progress: &mut |_| {}, clock: || 0.0,
            });
            assert!(matches!(result, Err(EditError::Invalid(ref key)) if key.starts_with("errors.editorLayerMigration.")), "{name} budget{bytes}");
            assert_eq!(limited.report_json(), report);
            assert_eq!(limited.state_value(), state);
            assert!(limited.take_events().is_empty());
            let mut untouched = live(name);
            for editor in [&mut limited, &mut untouched] { editor.call("cancelDrag", &[]).unwrap(); }
            assert_eq!(limited.report_json(), untouched.report_json());
            assert_eq!(limited.state_value(), untouched.state_value());
            assert_eq!(limited.take_events(), untouched.take_events());
        }
    }
}

#[test]
fn worker_bake_preserves_existing_unrecorded_native_draft_and_ik_refusals() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-admission");
    for name in ["native-ik-shown", "native-ik-future", "native-ik-source", "native-ik-asset", "native-saved-draft"] {
        let report = json::parse(&std::fs::read(folder.join(format!("{name}.document.json"))).unwrap()).unwrap();
        let mut editor = Editor::new(report, Options::default());
        let (report, state) = (editor.report_json(), editor.state_value());
        let result = editor.call_movieclip_timeline_worker("bakeMovieclip", &[], &mut TimelineWorker {
            max_source_bytes: 128 * 1024 * 1024, check: &mut || Ok(()), progress: &mut |_| {}, clock: || 0.0,
        });
        assert!(matches!(result, Err(EditError::Unported(_))), "{name}: {result:?}");
        assert_eq!(editor.report_json(), report);
        assert_eq!(editor.state_value(), state);
        assert!(editor.take_events().is_empty());
    }
}

#[test]
fn canonical_bake_replay_verifies_all_captured_fields() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake");
    let mut calls = 0;
    for file in std::fs::read_dir(folder).unwrap() {
        let file = file.unwrap().path();
        if file.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        let name = file.file_stem().unwrap().to_str().unwrap();
        if name.starts_with("bake-owner-origin-") { continue; }
        if matches!(name, "bake-native-stale" | "bake-native-object-limit" | "bake-native-stored-container" | "bake-native-stored-outer-scene") { continue; }
        let tape = json::parse(&std::fs::read(&file).unwrap()).unwrap();
        let result = styk_edit::replay::replay_worker(&tape).unwrap();
        assert!(result.unported.is_none(), "{name}: {:?}",result.unported);
        assert!(result.mismatches.is_empty(),"{name}: {:?}",result.mismatches);
        assert_eq!(result.matched,result.steps,"{name}");
        calls += result.matched;
    }
    assert_eq!(calls,224);
}

#[test]
fn canonical_observer_covers_existing_native_frame_and_ranges_owners() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake");
    for name in ["bake-owner-origin-join-layout-native", "bake-owner-origin-motion-layout-native"] {
        let tape = json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
        let result = styk_edit::replay::replay_worker(&tape).unwrap();
        assert!(result.unported.is_none(),"{name}: {:?}",result.unported);
        assert!(result.mismatches.is_empty(),"{name}: {:?}",result.mismatches);
        assert_eq!(result.matched,result.steps,"{name}");
    }
}

#[test]
fn canonical_native_saved_stack_bake_replays() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake");
    for name in ["bake-native-stored-container", "bake-native-stored-outer-scene"] {
        let tape = json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
        let result = styk_edit::replay::replay_worker(&tape).unwrap();
        assert!(result.unported.is_none(),"{name}: {:?}",result.unported);
        assert!(result.mismatches.is_empty(),"{name}: {:?}",result.mismatches);
        assert_eq!((result.matched,result.steps),(5,5),"{name}");
    }
}

#[test]
fn canonical_native_saved_stack_frame_reads() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-native-vfx");
    for name in ["native-vfx-container", "native-vfx-scene-before", "native-vfx-scene-baked"] {
        let tape = json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let result = styk_edit::replay::replay_worker(&tape).unwrap();
        assert!(result.unported.is_none(),"{name}: {:?}",result.unported);
        assert!(result.mismatches.is_empty(),"{name}: {:?}",result.mismatches);
        assert_eq!((result.matched,result.steps),(8,8),"{name}");
    }
}

#[test]
fn native_saved_stack_admission_keeps_unrecorded_mutations_atomic() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake");
    for name in ["bake-native-stored-container", "bake-native-stored-outer-scene"] {
        let tape = json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
        let initial = tape.get("steps").unwrap().item(0).unwrap();
        let report = json::parse(initial.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        for method in ["placeMovieclip", "splitMovieclip", "breakApartMovieclip", "makeMovieclipUnique", "createMovieclip", "beginTranslationDrag", "addVfx"] {
            let mut editor = editor(&initial,report.clone(),false);
            let (report,state) = (editor.report_json(),editor.state_value());
            assert!(matches!(editor.call(method,&[]),Err(EditError::Unported(_))),"{name} {method}");
            assert_eq!(editor.report_json(),report,"{name} {method}");
            assert_eq!(editor.state_value(),state,"{name} {method}");
            assert!(editor.take_events().is_empty(),"{name} {method}");
        }
    }
}

#[test]
fn canonical_object_limit_replay_uses_explicit_offline_host_budget() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake/bake-native-object-limit.json");
    let tape = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let result = styk_edit::replay::replay_worker_with_source_budget(&tape,1024 * 1024 * 1024).unwrap();
    assert!(result.unported.is_none(),"{:?}",result.unported);
    assert!(result.mismatches.is_empty(),"{:?}",result.mismatches);
    assert_eq!((result.matched,result.steps),(4,4));
}

#[test]
fn canonical_replay_refuses_recorded_interleaving_before_the_unsupported_call() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake/bake-native-stale.json");
    let mut tape = json::parse(&std::fs::read(file).unwrap()).unwrap();
    assert_eq!(tape.get("steps").unwrap().item(2).unwrap().get("interleavings"),
        Some(&json::parse(br#"[["renameLayer","layer-1","Changed while baking"]]"#).unwrap()));
    // Admission follows the recorded concurrency capability, never a scenario name.
    tape.make_obj().unwrap().set("scenario", Value::str("renamed-concurrent-recording"));
    for worker in [false, true] {
        let outcome = if worker { styk_edit::replay::replay_worker(&tape) } else { styk_edit::replay::replay(&tape) }.unwrap();
        assert_eq!((outcome.matched,outcome.steps),(1,4));
        assert_eq!(outcome.unported,Some((2,"recorded interleaved editor calls require the canonical actor".into())));
        assert!(outcome.mismatches.is_empty(),"{:?}",outcome.mismatches);
    }
}

#[test]
fn canonical_replay_validates_interleaving_metadata_and_accepts_empty_arrays() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake/bake-native-stored-container.json");
    let original = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let mut tape = original.clone();
    tape.make_obj().unwrap().get_mut("steps").unwrap().make_arr().unwrap()[1]
        .make_obj().unwrap().set("interleavings", Value::Null);
    assert_eq!(styk_edit::replay::replay_worker(&tape).unwrap_err(), "step 1: interleavings must be an array");
    tape.make_obj().unwrap().get_mut("steps").unwrap().make_arr().unwrap()[1]
        .make_obj().unwrap().set("interleavings", Value::array(Vec::new()));
    let outcome = styk_edit::replay::replay_worker(&tape).unwrap();
    assert!(outcome.unported.is_none());
    assert!(outcome.mismatches.is_empty(), "{:?}", outcome.mismatches);
    assert_eq!((outcome.matched,outcome.steps),(5,5));
}
