//! Recorded native async commands use the one planner, layer publisher and history.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::Path;
use std::sync::Arc;
use styk_doc::{Value, json};
use styk_edit::{EditError, Editor, HistoryLimits, Options, Selection};
use styk_engine::planning::{LayerRequest, TRANSFER_BYTES, native_layer_plan};
use styk_eval::{eval::Prepared, load::Loader};
struct CountAlloc;
thread_local! {static ACTIVITY:Cell<Option<(usize,usize)>>=const{Cell::new(None)};}
unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ACTIVITY.with(|c| {
            if let Some((a, d)) = c.get() {
                c.set(Some((a + 1, d)))
            }
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        ACTIVITY.with(|c| {
            if let Some((a, d)) = c.get() {
                c.set(Some((a, d + 1)))
            }
        });
        unsafe { System.dealloc(p, layout) }
    }
}
#[global_allocator]
static ALLOC: CountAlloc = CountAlloc;
fn history(e: &mut Editor) -> Value {
    e.prepare_worker_publication(|_, _| Ok(Value::Null), || Ok(()))
        .unwrap()
        .history()
        .clone()
}
fn num(value: &Value, key: &str) -> f64 {
    value.get(key).unwrap().as_f64().unwrap()
}
fn fixture(name: &str) -> Value {
    json::parse(
        &std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../tests/native-layer-publication/{name}.json")),
        )
        .unwrap(),
    )
    .unwrap()
}
fn editor(reference: &Value) -> Editor {
    let s = reference.get("steps").unwrap().item(0).unwrap();
    let state = s.get("state").unwrap();
    let selection = s.get("selection").unwrap();
    let history = s.get("history").unwrap();
    let mut e = Editor::new(
        json::parse(s.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap(),
        Options::default(),
    );
    e.set_view(
        num(selection, "tick"),
        num(selection, "frameIndex") as usize,
        Selection {
            uid: selection
                .get("uid")
                .and_then(Value::as_f64)
                .map(|n| n as u32),
            uids: selection
                .get("uids")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .map(|n| *n as u32)
                .collect(),
            joint: num(selection, "joint") as i64,
        },
    );
    e.set_active_layer_id(selection.get("activeLayerId").unwrap().as_str().unwrap());
    e.set_counters(
        num(state, "layerRevision") as u64,
        num(state, "nextFrameIdentity") as u64,
        num(state, "nextUid") as u64,
    );
    e.set_revision_counters(
        num(history, "revision") as u64,
        num(history, "revisionSerial") as u64,
        num(history, "savedRevision") as u64,
    );
    let limits = reference.get("historyLimits").unwrap();
    e.configure_worker_history(HistoryLimits {
        count: num(limits, "count") as usize,
        bytes: num(limits, "bytes"),
    })
    .unwrap();
    e
}
fn request(e: &Editor, r: &Value) -> LayerRequest {
    LayerRequest {
        uids: r
            .get("uids")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .map(|n| *n as u32)
            .collect(),
        target_layer: r.get("targetLayerId").unwrap().as_str().unwrap().into(),
        deleted_layer: r
            .get("deletedLayerId")
            .and_then(Value::as_str)
            .map(str::to_string),
        next_frame_identity: e.state().next_frame_identity,
        max_source_bytes: TRANSFER_BYTES,
    }
}
fn wire(e: &Editor, r: &LayerRequest) -> Value {
    let prepared = Prepared::new(Arc::new(
        Loader::new()
            .document(e.report(), "native publication")
            .unwrap(),
    ));
    native_layer_plan(e.report(), &prepared, r, || Ok(()), |_| {}, || 0.0)
        .unwrap()
        .get("plan")
        .unwrap()
        .clone()
}
#[test]
fn editor_publication_history_bytes_branch_and_sources_match_at_every_step() {
    for name in [
        "native-only",
        "independent",
        "joined-scalars",
        "delete-default",
        "dense-single-figure",
        "independent-zero",
        "independent-count-one",
        "independent-source-retention",
        "independent-count-zero",
        "independent-active-view",
        "independent-delete-unused",
        "independent-empty-table",
        "independent-header-extra",
    ] {
        let reference = fixture(name);
        let mut e = editor(&reference);
        let steps = reference.get("steps").unwrap();
        for at in 1..steps.array_len().unwrap() {
            let want = steps.item(at).unwrap();
            let call = want.get("call").unwrap();
            let method = call.item(0).unwrap();
            let method = method.as_str().unwrap();
            let before = e.report().clone();
            if want.get("error").is_some_and(|v| !v.is_null()) {
                let r = request(&e, reference.get("request").unwrap());
                let result = e.prepare_native_layer_migration_worker(
                    &r.uids,
                    &r.target_layer,
                    r.deleted_layer.as_deref(),
                    want.get("wire").unwrap(),
                    || Ok(()),
                    |_| {},
                    || 0.0,
                );
                let EditError::Invalid(key) = result.unwrap_err() else {
                    panic!("{name}/{at} wrong error")
                };
                assert_eq!(key, want.path(&["error", "key"]).unwrap().as_str().unwrap());
                assert_eq!(
                    e.report_json(),
                    want.get("document").unwrap().as_str().unwrap()
                );
                assert_eq!(e.state_value(), want.get("state").unwrap().clone());
                assert_eq!(history(&mut e), want.get("history").unwrap().clone());
                continue;
            }
            let prepared = if method.ends_with("Async") {
                let mut r = request(&e, reference.get("request").unwrap());
                let expected = want.get("wire").unwrap();
                if method == "deleteLayerAsync" {
                    let deleted = call.item(1).unwrap();
                    let deleted = deleted.as_str().unwrap();
                    r.deleted_layer = Some(deleted.into());
                    if let Some(target) = call.item(2).and_then(|v| v.as_str().map(str::to_string))
                    {
                        r.target_layer = target;
                    }
                    let mut ids = Vec::new();
                    let frames = e
                        .report()
                        .get("keyframes")
                        .unwrap()
                        .elements()
                        .unwrap()
                        .iter()
                        .chain(
                            e.report()
                                .path(&["_styk", "frameSources"])
                                .and_then(Value::as_obj)
                                .into_iter()
                                .flat_map(|o| o.values().iter().cloned()),
                        );
                    for f in frames {
                        for o in f.get("objects").unwrap().elements().unwrap().iter() {
                            let id = num(&o, "unique_id") as u32;
                            let layer = e
                                .report()
                                .path(&["_styk", "layers", "assignments", &id.to_string()])
                                .and_then(Value::as_str)
                                .unwrap_or_else(|| {
                                    e.report()
                                        .path(&["_styk", "layers", "defaultLayerId"])
                                        .unwrap()
                                        .as_str()
                                        .unwrap()
                                });
                            if layer == deleted && !ids.contains(&id) {
                                ids.push(id);
                            }
                        }
                    }
                    r.uids = ids;
                }
                // The editor skips planning if assignment already matches; a captured null
                // wire then belongs to that no-op. All other inputs use the actual Rust kernel.
                let actual = if expected.is_null() {
                    Value::Null
                } else {
                    wire(&e, &r)
                };
                assert_eq!(
                    json::to_string(&actual),
                    json::to_string(expected),
                    "{name}/{at} shared kernel wire"
                );
                let mut progress = Vec::new();
                let p = e
                    .prepare_native_layer_migration_worker(
                        &r.uids,
                        &r.target_layer,
                        r.deleted_layer.as_deref(),
                        &actual,
                        || Ok(()),
                        |p| {
                            progress.push(
                                json::parse(
                                    format!(
                                        r#"{{"phase":"{}","completed":{},"total":{}}}"#,
                                        p.phase, p.completed, p.total
                                    )
                                    .as_bytes(),
                                )
                                .unwrap(),
                            )
                        },
                        || 0.0,
                    )
                    .unwrap();
                let expected_progress: Vec<_> = want
                    .get("progress")
                    .unwrap()
                    .elements()
                    .unwrap()
                    .iter()
                    .filter(|p| p.get("phase").and_then(Value::as_str) == Some("staging"))
                    .collect();
                assert_eq!(
                    json::to_string(&Value::array(progress)),
                    json::to_string(&Value::array(expected_progress)),
                    "{name}/{at} actual staging progress"
                );
                let active = name == "independent-active-view" && !expected.is_null();
                e.prepare_worker_publication(
                    move |e, check| {
                        if active {
                            e.call_layer_metadata_worker(
                                "setActiveLayer",
                                &[Value::str("layer-1")],
                            )?;
                        }
                        e.publish_native_layer_migration_worker(p, check)
                            .map(Value::Bool)
                    },
                    || Ok(()),
                )
            } else {
                e.prepare_worker_publication(
                    |e, check| {
                        check()?;
                        if method == "renameLayer" {
                            let args: Vec<_> = call.elements().unwrap().iter().skip(1).collect();
                            e.call_layer_metadata_worker(method, &args)
                        } else {
                            e.apply_history_worker(method == "redo").map(Value::Bool)
                        }
                    },
                    || Ok(()),
                )
            }
            .unwrap();
            assert!(
                e.report().same_node(&before),
                "{name}/{at} preparation mutated live report"
            );
            assert_eq!(
                json::to_string(prepared.report()),
                want.get("document").unwrap().as_str().unwrap(),
                "{name}/{at} document"
            );
            assert_eq!(
                json::to_string(prepared.result()),
                json::to_string(want.get("result").unwrap()),
                "{name}/{at} return"
            );
            assert_eq!(
                json::to_string(prepared.state()),
                json::to_string(want.get("state").unwrap()),
                "{name}/{at} state"
            );
            assert_eq!(
                json::to_string(prepared.history()),
                json::to_string(want.get("history").unwrap()),
                "{name}/{at} byte history"
            );
            assert_eq!(
                json::to_string(prepared.events()),
                json::to_string(want.get("events").unwrap()),
                "{name}/{at} events"
            );
            let guarded = prepared
                .guard_worker(&mut e)
                .unwrap_or_else(|(err, _)| panic!("{name}/{at} {err:?}"));
            ACTIVITY.with(|c| c.set(Some((0, 0))));
            let retired = guarded.commit();
            let activity = ACTIVITY.with(|c| c.replace(None).unwrap());
            assert_eq!(
                activity,
                (0, 0),
                "{name}/{at} dense commit allocated or retired payload"
            );
            assert!(retired.previous_report().same_node(&before));
            assert_eq!(
                e.report_json(),
                want.get("document").unwrap().as_str().unwrap()
            );
            e.take_events();
            drop(retired);
        }
    }
}
#[test]
fn recorded_malformed_worker_wires_refuse_without_mutation() {
    for suffix in [
        "invalid-uid",
        "invalid-target",
        "invalid-plan",
        "invalid-channel",
        "invalid-order",
        "invalid-source",
        "missing-source",
    ] {
        let reference = fixture(&format!("independent-{suffix}"));
        let mut e = editor(&reference);
        let before = e.report().clone();
        let want = reference.get("steps").unwrap().item(1).unwrap();
        let r = request(&e, reference.get("request").unwrap());
        let result = e.prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            None,
            want.get("wire").unwrap(),
            || Ok(()),
            |_| {},
            || 0.0,
        );
        let EditError::Invalid(key) = result.unwrap_err() else {
            panic!("wrong {suffix} error")
        };
        assert_eq!(key, want.path(&["error", "key"]).unwrap().as_str().unwrap());
        assert!(e.report().same_node(&before));
        assert_eq!(
            json::to_string(&history(&mut e)),
            json::to_string(
                reference
                    .get("steps")
                    .unwrap()
                    .item(0)
                    .unwrap()
                    .get("history")
                    .unwrap()
            )
        );
    }
}
#[test]
fn cancellation_stale_and_late_partial_publication_restore_the_owning_editor() {
    let reference = fixture("dense-single-figure");
    let mut e = editor(&reference);
    let before = e.report().clone();
    let state = e.state_value();
    let before_history = history(&mut e);
    let r = request(&e, reference.get("request").unwrap());
    let w = wire(&e, &r);
    for after in [0, 2, 7, 25] {
        let mut checks = 0;
        let result = e.prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            None,
            &w,
            || {
                checks += 1;
                if checks > after {
                    Err(EditError::Invalid("cancelled".into()))
                } else {
                    Ok(())
                }
            },
            |_| {},
            || 0.0,
        );
        assert!(result.is_err());
        assert!(e.report().same_node(&before));
    }
    let p = e
        .prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            None,
            &w,
            || Ok(()),
            |_| {},
            || 0.0,
        )
        .unwrap();
    let mut cancelled = false;
    let result = e.prepare_worker_publication(
        |e, check| {
            e.publish_native_layer_migration_worker(p, check)?;
            cancelled = true;
            Err(EditError::Invalid("cancelled after publication".into()))
        },
        || Ok(()),
    );
    assert!(result.is_err());
    assert!(cancelled);
    assert!(e.report().same_node(&before));
    assert_eq!(e.state_value(), state);
    assert_eq!(history(&mut e), before_history);
    assert!(e.take_events().is_empty());
    let p = e
        .prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            None,
            &w,
            || Ok(()),
            |_| {},
            || 0.0,
        )
        .unwrap();
    e.set_revision_counters(3, 3, 2);
    assert!(matches!(
        e.publish_native_layer_migration_worker(p, || Ok(())),
        Err(EditError::Invalid(_))
    ));
    assert!(e.report().same_node(&before));
}

#[test]
fn editor_recorded_cancel_and_stale_metadata_owner_callbacks_match() {
    for suffix in ["cancel", "stale"] {
        let reference = fixture(&format!("independent-{suffix}"));
        let mut e = editor(&reference);
        let want = reference.get("steps").unwrap().item(1).unwrap();
        let r = request(&e, reference.get("request").unwrap());
        let expected = want.path(&["error", "key"]).unwrap().as_str().unwrap();
        let result = if suffix == "cancel" {
            e.prepare_native_layer_migration_worker(
                &r.uids,
                &r.target_layer,
                None,
                want.get("wire").unwrap(),
                || Err(EditError::Invalid(expected.into())),
                |_| {},
                || 0.0,
            )
            .map(|_| false)
        } else {
            let p = e
                .prepare_native_layer_migration_worker(
                    &r.uids,
                    &r.target_layer,
                    None,
                    want.get("wire").unwrap(),
                    || Ok(()),
                    |_| {},
                    || 0.0,
                )
                .unwrap();
            e.call_layer_metadata_worker(
                "renameLayer",
                &[Value::str("layer-3"), Value::str("Changed while preparing")],
            )
            .unwrap();
            e.publish_native_layer_migration_worker(p, || Ok(()))
        };
        let EditError::Invalid(key) = result.unwrap_err() else {
            panic!("wrong {suffix} error")
        };
        assert_eq!(key, expected);
        assert_eq!(
            e.report_json(),
            want.get("document").unwrap().as_str().unwrap()
        );
        assert_eq!(e.state_value(), want.get("state").unwrap().clone());
        assert_eq!(history(&mut e), want.get("history").unwrap().clone());
        assert_eq!(
            json::to_string(&Value::array(e.take_events())),
            json::to_string(want.get("events").unwrap())
        );
    }
}

#[test]
fn unready_or_new_live_gesture_cannot_publish_partial_native_history() {
    let reference = fixture("native-only");
    let ready = editor(&reference);
    let mut unready = Editor::new(ready.report().clone(), Options::default());
    let r = request(&unready, reference.get("request").unwrap());
    let p = unready
        .prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            None,
            &Value::Null,
            || Ok(()),
            |_| {},
            || 0.0,
        )
        .unwrap();
    let before = unready.report().clone();
    assert!(matches!(
        unready.publish_native_layer_migration_worker(p, || Ok(())),
        Err(EditError::Unported(_))
    ));
    assert!(unready.report().same_node(&before));
    assert!(!unready.state().can_undo);

    let mut e = editor(&reference);
    let r = request(&e, reference.get("request").unwrap());
    let p = e
        .prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            None,
            &Value::Null,
            || Ok(()),
            |_| {},
            || 0.0,
        )
        .unwrap();
    let before = e.report().clone();
    e.call("beginDrag", &[Value::str("Live gesture")]).unwrap();
    assert!(matches!(
        e.publish_native_layer_migration_worker(p, || Ok(())),
        Err(EditError::Unported(_))
    ));
    assert!(e.report().same_node(&before));
    assert!(!e.state().can_undo);
    assert_eq!(e.call("cancelDrag", &[]).unwrap(), Value::Bool(true));
}

#[test]
fn editor_recorded_delete_error_priority_is_atomic() {
    for suffix in ["delete-last-layer", "delete-same-target"] {
        let reference = fixture(&format!("native-only-{suffix}"));
        let mut e = editor(&reference);
        let before = e.report().clone();
        let want = reference.get("steps").unwrap().item(1).unwrap();
        let r = request(&e, reference.get("request").unwrap());
        let result = e.prepare_native_layer_migration_worker(
            &r.uids,
            &r.target_layer,
            r.deleted_layer.as_deref(),
            &Value::Null,
            || Ok(()),
            |_| {},
            || 0.0,
        );
        let EditError::Invalid(key) = result.unwrap_err() else {
            panic!("wrong {suffix} error")
        };
        assert_eq!(key, want.path(&["error", "key"]).unwrap().as_str().unwrap());
        assert!(e.report().same_node(&before));
        assert_eq!(e.state_value(), want.get("state").unwrap().clone());
        assert_eq!(history(&mut e), want.get("history").unwrap().clone());
    }
}
