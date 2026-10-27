use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::Path;
use std::sync::Arc;
use styk_doc::{Value, json};
use styk_edit::{
    EditError, Editor, HistoryLimits, Options, Selection,
    layer_planning::{Request, sheet_layer_plan},
};
use styk_eval::{eval::Prepared, load::Loader};

struct CountAlloc;
thread_local! { static ACTIVITY: Cell<Option<(usize, usize)>> = const { Cell::new(None) }; }
unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ACTIVITY.with(|cell| {
            if let Some((a, d)) = cell.get() {
                cell.set(Some((a + 1, d)));
            }
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        ACTIVITY.with(|cell| {
            if let Some((a, d)) = cell.get() {
                cell.set(Some((a, d + 1)));
            }
        });
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOC: CountAlloc = CountAlloc;
fn clock() -> f64 {
    0.0
}
fn string(value: &Value) -> String {
    json::to_string(value)
}
fn fixture(name: &str) -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/publication/{name}.json"));
    json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn editor(reference: &Value) -> Editor {
    let initial = reference.get("steps").unwrap().item(0).unwrap();
    let mut e = Editor::new(
        json::parse(
            initial
                .get("document")
                .unwrap()
                .as_str()
                .unwrap()
                .as_bytes(),
        )
        .unwrap(),
        Options {
            layer_timeline: true,
            ..Default::default()
        },
    );
    let s = initial.get("selection").unwrap();
    let state = initial.get("state").unwrap();
    let h = initial.get("history").unwrap();
    let number = |v: &Value, k: &str| v.get(k).unwrap().as_f64().unwrap();
    e.set_view(
        number(s, "tick"),
        number(s, "frameIndex") as usize,
        Selection {
            uid: s.get("uid").unwrap().as_f64().map(|u| u as u32),
            uids: s
                .get("uids")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .map(|u| *u as u32)
                .collect(),
            joint: number(s, "joint") as i64,
        },
    );
    e.set_active_layer_id(s.get("activeLayerId").unwrap().as_str().unwrap());
    e.set_counters(
        number(state, "layerRevision") as u64,
        number(state, "nextFrameIdentity") as u64,
        number(state, "nextUid") as u64,
    );
    e.set_revision_counters(
        number(h, "revision") as u64,
        number(h, "revisionSerial") as u64,
        number(h, "savedRevision") as u64,
    );
    let limits = reference.get("historyLimits").unwrap();
    e.configure_worker_history(HistoryLimits {
        count: number(limits, "count") as usize,
        bytes: number(limits, "bytes"),
    })
    .unwrap();
    e
}
fn plan(e: &Editor, reference: &Value) -> Option<styk_edit::layer_planning::SheetPlan> {
    let mut loader = Loader::new();
    let prepared = Arc::new(Prepared::new(Arc::new(
        loader.document(e.report(), "transaction fixture").unwrap(),
    )));
    let r = reference.get("request").unwrap();
    let ids = r
        .get("uids")
        .unwrap()
        .numbers()
        .unwrap()
        .iter()
        .map(|u| *u as u32)
        .collect::<Vec<_>>();
    sheet_layer_plan(
        e.report(),
        &prepared,
        &mut loader,
        Request {
            uids: &ids,
            target_layer: r.get("targetLayerId").unwrap().as_str().unwrap(),
            deleted_layer: r.get("deletedLayerId").and_then(Value::as_str),
            next_frame_identity: e.state().next_frame_identity,
            max_source_bytes: 128 * 1024 * 1024,
            focus: None,
        },
        || Ok(()),
        |_| {},
        clock,
    )
    .unwrap()
}
#[test]
fn actual_editor_before_after_undo_redo_branch_bytes_and_dense_commits_match() {
    for name in [
        "shared",
        "vacant",
        "vacant-tail",
        "combined",
        "combined-zero-budget",
        "absence",
        "delete-unused",
        "delete-native",
        "delete-joined",
        "dense",
        "noop",
        "movieclip",
        "delete-movieclip",
    ] {
        let reference = fixture(name);
        let mut e = editor(&reference);
        let steps = reference.get("steps").unwrap();
        for at in 1..steps.array_len().unwrap() {
            let before = steps.item(at - 1).unwrap();
            let want = steps.item(at).unwrap();
            let call = want.get("call").unwrap();
            let method = call.item(0).unwrap();
            let method = method.as_str().unwrap();
            let original = e.report().clone();
            let ready = if method.ends_with("Async") {
                let p = plan(&e, &reference);
                e.prepare_worker_publication(
                    move |e, check| {
                        p.map(|p| e.publish_sheet_migration_checked(p, check))
                            .unwrap_or(Ok(false))
                            .map(Value::Bool)
                    },
                    || Ok(()),
                )
            } else {
                e.prepare_worker_publication(
                    |e, check| {
                        check()?;
                        e.call(method, &[])
                    },
                    || Ok(()),
                )
            }
            .unwrap();
            assert!(
                e.report().same_node(&original),
                "{name}/{at}: preparation mutated owner"
            );
            assert_eq!(
                e.report_json(),
                before.get("document").unwrap().as_str().unwrap(),
                "{name}/{at} before document"
            );
            assert_eq!(
                string(ready.before_state()),
                string(before.get("state").unwrap()),
                "{name}/{at} before state"
            );
            assert_eq!(
                string(ready.before_history()),
                string(before.get("history").unwrap()),
                "{name}/{at} before history"
            );
            assert_eq!(
                string(ready.report()),
                want.get("document").unwrap().as_str().unwrap(),
                "{name}/{at} prepared document"
            );
            assert_eq!(
                string(ready.result()),
                string(want.get("result").unwrap()),
                "{name}/{at} result"
            );
            assert_eq!(
                string(ready.state()),
                string(want.get("state").unwrap()),
                "{name}/{at} state"
            );
            assert_eq!(
                string(ready.history()),
                string(want.get("history").unwrap()),
                "{name}/{at} exact bytes/history"
            );
            assert_eq!(
                string(ready.events()),
                string(want.get("events").unwrap()),
                "{name}/{at} events"
            );
            let guarded = match ready.guard_worker(&mut e) {
                Ok(g) => g,
                Err((error, _)) => panic!("{name}/{at}: {error:?}"),
            };
            ACTIVITY.with(|cell| cell.set(Some((0, 0))));
            let retired = guarded.commit();
            let activity = ACTIVITY.with(|cell| cell.replace(None).unwrap());
            assert_eq!(
                activity,
                (0, 0),
                "{name}/{at}: commit allocated or dropped payload"
            );
            assert!(retired.previous_report().same_node(&original));
            assert_eq!(
                e.report_json(),
                want.get("document").unwrap().as_str().unwrap(),
                "{name}/{at} committed document"
            );
            assert_eq!(
                string(&Value::array(e.take_events())),
                string(want.get("events").unwrap()),
                "{name}/{at} committed events"
            );
            // Displaced heads are deliberately released here on this test worker,
            // representing the host's terminal ACK rather than the UI handle.
            drop(retired);
        }
    }
}
#[test]
fn cancellation_after_partial_publication_restores_report_history_events_and_cache() {
    let reference = fixture("dense");
    let mut e = editor(&reference);
    let original = e.report().clone();
    let before = e.state_value();
    for reason in ["cancelled", "stale"] {
        let p = plan(&e, &reference).unwrap();
        let mut checks = 0;
        let result = e.prepare_worker_publication(
            move |e, check| e.publish_sheet_migration_checked(p, check).map(Value::Bool),
            || {
                checks += 1;
                if checks == 20 {
                    Err(EditError::Invalid(reason.into()))
                } else {
                    Ok(())
                }
            },
        );
        assert!(matches!(result,Err(EditError::Invalid(ref actual)) if actual==reason));
        assert_eq!(checks, 20);
        assert!(e.report().same_node(&original));
        assert_eq!(string(&e.state_value()), string(&before));
        assert_eq!(e.history_size(), Some(0.0));
        assert!(e.take_events().is_empty());
    }
    let p = plan(&e, &reference).unwrap();
    let ready = e
        .prepare_worker_publication(
            move |e, check| e.publish_sheet_migration_checked(p, check).map(Value::Bool),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(
        string(ready.history()),
        string(
            reference
                .get("steps")
                .unwrap()
                .item(1)
                .unwrap()
                .get("history")
                .unwrap()
        )
    );
}
#[test]
fn guard_refuses_document_view_history_settings_and_clipboard_drift_without_mutation() {
    for kind in ["document", "view", "limits", "clipboard"] {
        let reference = fixture("combined");
        let mut e = editor(&reference);
        let p = plan(&e, &reference).unwrap();
        let ready = e
            .prepare_worker_publication(
                move |e, check| e.publish_sheet_migration_checked(p, check).map(Value::Bool),
                || Ok(()),
            )
            .unwrap();
        match kind {
            "document" => {
                e.call("setFPS", &[Value::Num(27.0)]).unwrap();
            }
            "view" => e.set_view(
                3.0,
                0,
                Selection {
                    uid: Some(2),
                    uids: vec![2],
                    joint: -1,
                },
            ),
            "limits" => e
                .configure_worker_history(HistoryLimits {
                    count: 3,
                    bytes: 1.0,
                })
                .unwrap(),
            "clipboard" => {
                e.call("copySelection", &[]).unwrap();
            }
            _ => unreachable!(),
        }
        let current = e.report().clone();
        let state = e.state_value();
        let rejected = match ready.guard_worker(&mut e) {
            Err((error, p)) => {
                assert!(matches!(error, EditError::Invalid(_)));
                p
            }
            Ok(_) => panic!("{kind} drift was accepted"),
        };
        assert!(e.report().same_node(&current));
        assert_eq!(string(&e.state_value()), string(&state));
        drop(rejected);
    }
}
#[test]
fn unprepared_and_live_gesture_refusals_keep_the_existing_owner() {
    let reference = fixture("combined");
    let mut e = editor(&reference);
    e.call("select", &[Value::Num(1.0)]).unwrap();
    e.call("beginDrag", &[Value::str("Move")]).unwrap();
    let current = e.report().clone();
    assert!(matches!(
        e.prepare_worker_publication(|_, _| Ok(Value::Null), || Ok(())),
        Err(EditError::Unported(_))
    ));
    assert!(e.report().same_node(&current));
    e.call("cancelDrag", &[]).unwrap();
    let mut e = Editor::new(current, Options::default());
    let current = e.report().clone();
    assert!(matches!(
        e.prepare_worker_publication(|_, _| Ok(Value::Null), || Ok(())),
        Err(EditError::Unported(_))
    ));
    assert!(e.report().same_node(&current));
}

#[test]
fn late_error_and_guard_cancel_restore_complete_owner_and_keep_payload_for_disposal() {
    let reference = fixture("combined");
    let mut e = editor(&reference);
    e.call("select", &[Value::Num(1.0)]).unwrap();
    let before = e.report().clone();
    let state = e.state_value();
    let limits = e.history_limits();
    let p = plan(&e, &reference).unwrap();
    let retained_before = before.clone();
    let result = e.prepare_worker_publication(
        move |e, check| {
            e.publish_sheet_migration_checked(p, check)?;
            assert!(!e.report().same_node(&retained_before));
            assert!(e.state().can_undo);
            e.configure_worker_history(HistoryLimits {
                count: 0,
                bytes: 0.0,
            })?;
            e.take_events();
            Err(EditError::Invalid("late cancelled".into()))
        },
        || Ok(()),
    );
    assert!(matches!(result, Err(EditError::Invalid(ref reason)) if reason=="late cancelled"));
    assert!(e.report().same_node(&before));
    assert_eq!(string(&e.state_value()), string(&state));
    assert_eq!(e.history_size(), Some(0.0));
    assert_eq!(e.history_limits().count, limits.count);
    assert_eq!(e.history_limits().bytes, limits.bytes);
    assert_eq!(
        e.take_events().len(),
        1,
        "queued selection event was not restored"
    );
    let p = plan(&e, &reference).unwrap();
    let ready = e
        .prepare_worker_publication(
            move |e, check| e.publish_sheet_migration_checked(p, check).map(Value::Bool),
            || Ok(()),
        )
        .unwrap();
    let prepared_after = ready.report().clone();
    let mut calls = 0;
    let returned = match ready.guard_worker_checked(&mut e, || {
        calls += 1;
        if calls == 2 {
            Err(EditError::Invalid("guard stale".into()))
        } else {
            Ok(())
        }
    }) {
        Err((error, ready)) => {
            assert!(matches!(error, EditError::Invalid(ref reason) if reason=="guard stale"));
            ready
        }
        Ok(_) => panic!("guard cancellation committed"),
    };
    assert_eq!(calls, 2);
    assert!(e.report().same_node(&before));
    assert!(returned.report().same_node(&prepared_after));
    assert!(e.take_events().is_empty());
    drop(returned);
}

fn optional_metadata_fixture(field: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/publication-selection/{field}.json"));
    json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn optional_metadata_editor(reference: &Value) -> Editor {
    let initial = reference.get("steps").unwrap().item(0).unwrap();
    let state = initial.get("state").unwrap();
    let mut editor = Editor::new(
        json::parse(initial.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap(),
        Options::default(),
    );
    let number = |key| state.get(key).unwrap().as_f64().unwrap();
    editor.set_view(number("tick"), number("frameIndex") as usize,
        Selection { uid: Some(1), uids: vec![1], joint: 0 });
    editor.set_counters(number("layerRevision") as u64,
        number("nextFrameIdentity") as u64, number("nextUid") as u64);
    editor.configure_worker_history(HistoryLimits::default()).unwrap();
    editor
}
fn metadata_input(reference: &Value, step: usize) -> Value {
    reference.get("steps").unwrap().item(step).unwrap()
        .get("call").unwrap().item(1).unwrap()
}
fn reveal_metadata(editor: &mut Editor, field: &str) {
    let state = editor.state();
    editor.set_view(state.tick, state.frame_index,
        Selection { uid: Some(1), uids: vec![1], joint: if field == "polygonSelection" { -1 } else { 1 } });
}
fn hide_metadata(editor: &mut Editor) {
    let state = editor.state();
    editor.set_view(state.tick, state.frame_index,
        Selection { uid: Some(1), uids: vec![1], joint: 0 });
}

#[test]
fn hidden_raw_selection_drift_refuses_and_preserves_the_newer_owner() {
    for field in ["polygonSelection", "branch"] {
        let reference = optional_metadata_fixture(field);
        let mut editor = optional_metadata_editor(&reference);
        editor.set_selection_metadata(&metadata_input(&reference, 1)).unwrap();
        let before = editor.state_value();
        let report = editor.report().clone();
        let ready = editor.prepare_worker_publication(|_, _| Ok(Value::Null), || Ok(())).unwrap();
        editor.set_selection_metadata(&metadata_input(&reference, 2)).unwrap();
        assert_eq!(editor.state_value(), before, "{field}: drift must be canonically hidden");
        assert!(editor.report().same_node(&report));
        assert!(editor.take_events().is_empty());
        let rejected = match ready.guard_worker(&mut editor) {
            Err((EditError::Invalid(_), ready)) => ready,
            Err((error, _)) => panic!("unexpected {error:?}"),
            Ok(_) => panic!("hidden {field} drift was accepted"),
        };
        drop(rejected);
        reveal_metadata(&mut editor, field);
        let expected = reference.get("steps").unwrap().item(3).unwrap();
        assert_eq!(editor.state_value(), *expected.get("state").unwrap(), "{field}");
        assert_eq!(editor.state_value().get(field).unwrap().get("unknown").and_then(Value::as_str), Some("newer"));
        assert!(editor.report().same_node(&report));
        assert_eq!(editor.history_size(), Some(0.0));
        assert!(editor.take_events().is_empty());
    }
}

#[test]
fn hidden_selection_heads_restore_prepare_error_and_exchange_without_allocations() {
    for field in ["polygonSelection", "branch"] {
        let reference = optional_metadata_fixture(field);
        let mut editor = optional_metadata_editor(&reference);
        editor.set_selection_metadata(&metadata_input(&reference, 1)).unwrap();
        let newer = metadata_input(&reference, 2);
        let ready = editor.prepare_worker_publication(|editor, _| {
            editor.set_selection_metadata(&newer)?; Ok(Value::Bool(true))
        }, || Ok(())).unwrap();
        reveal_metadata(&mut editor, field);
        assert_eq!(editor.state_value().get(field).unwrap().get("unknown").and_then(Value::as_str), Some("before"), "{field}: preparation leaked metadata");
        hide_metadata(&mut editor);
        let guard = ready.guard_worker(&mut editor).unwrap_or_else(|(error, _)| panic!("{error:?}"));
        ACTIVITY.with(|cell| cell.set(Some((0,0))));
        let retired = guard.commit();
        let activity = ACTIVITY.with(|cell| cell.replace(None)).unwrap();
        assert_eq!(activity, (0,0), "{field}: commit allocated or dropped payload");
        drop(retired);
        reveal_metadata(&mut editor, field);
        assert_eq!(editor.state_value().get(field).unwrap().get("unknown").and_then(Value::as_str), Some("newer"));
        hide_metadata(&mut editor);
        editor.set_selection_metadata(&metadata_input(&reference, 1)).unwrap();
        let result = editor.prepare_worker_publication(|editor, _| {
            editor.set_selection_metadata(&newer)?;
            Err(EditError::Invalid("cancel after metadata".into()))
        }, || Ok(()));
        assert!(matches!(result, Err(EditError::Invalid(ref reason)) if reason == "cancel after metadata"));
        reveal_metadata(&mut editor, field);
        assert_eq!(editor.state_value().get(field).unwrap().get("unknown").and_then(Value::as_str), Some("before"));
        assert!(editor.take_events().is_empty());
    }
}
