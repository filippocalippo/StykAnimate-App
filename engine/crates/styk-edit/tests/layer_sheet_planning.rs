//! The borrowed planning kernel and existing publication/history owner match the editor.
use std::sync::Arc;
use styk_doc::{Obj, Value, json};
use styk_edit::{
    Editor, Options, Selection,
    layer_planning::{Progress, Request, sheet_layer_plan},
};
use styk_eval::{eval::Prepared, load::Loader};
fn clock() -> f64 {
    0.0
}
fn fixture(name: &str) -> (Value, Value, Loader, Arc<Prepared>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/layer-sheet-migration/{name}.json"));
    let reference = json::parse(&std::fs::read(path).unwrap()).unwrap();
    let report = json::parse(
        reference
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let mut loader = Loader::new();
    let prepared = Arc::new(Prepared::new(Arc::new(
        loader.document(&report, "sheet planning").unwrap(),
    )));
    (reference, report, loader, prepared)
}
fn assert_json(actual: &str, expected: &str, context: &str) {
    let difference = actual
        .bytes()
        .zip(expected.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or(actual.len().min(expected.len()));
    if actual != expected {
        let excerpt = |text: &str| {
            String::from_utf8_lossy(
                &text.as_bytes()
                    [difference.saturating_sub(100)..(difference + 160).min(text.len())],
            )
            .into_owned()
        };
        panic!(
            "{context} differs at byte {difference}, lengths {} / {}: {} / {}",
            actual.len(),
            expected.len(),
            excerpt(actual),
            excerpt(expected)
        );
    }
}
fn progress_value(p: Progress) -> Value {
    let mut o = Obj::new();
    o.set("phase", Value::str(p.phase));
    o.set("completed", Value::Num(p.completed as f64));
    o.set("total", Value::Num(p.total as f64));
    if p.phase == "sampling" {
        o.set("sourceFrames", Value::Num(p.source_frames as f64));
        o.set("objectPoses", Value::Num(p.object_poses as f64));
        o.set("segmentValues", Value::Num(p.segment_values as f64));
    }
    Value::object(o)
}
#[test]
fn sheet_plan_and_publication_use_the_existing_owner_exactly() {
    for name in [
        "shared",
        "vacant",
        "vacant-tail",
        "combined",
        "absence",
        "delete-unused",
        "delete-native",
        "delete-joined",
        "dense",
        "noop",
        "movieclip",
        "delete-movieclip",
        "view-changed",
    ] {
        let (reference, report, mut loader, prepared) = fixture(name);
        let initial = reference.get("initialState").unwrap();
        let r = reference.get("request").unwrap();
        let uids: Vec<u32> = r
            .get("uids")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .map(|u| *u as u32)
            .collect();
        let next = r.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64;
        let mut progress = Vec::new();
        let plan = sheet_layer_plan(
            &report,
            &prepared,
            &mut loader,
            Request {
                uids: &uids,
                target_layer: r.get("targetLayerId").unwrap().as_str().unwrap(),
                deleted_layer: r.get("deletedLayerId").and_then(Value::as_str),
                next_frame_identity: next,
                max_source_bytes: 128 * 1024 * 1024,
                focus: None,
            },
            || Ok(()),
            |p| progress.push(progress_value(p)),
            clock,
        )
        .unwrap();
        let payload = plan.as_ref().map(|plan| plan.payload()).unwrap_or_else(|| {
            let mut o = Obj::new();
            o.set("plan", Value::Null);
            Value::object(o)
        });
        assert_json(
            &json::to_string(&payload),
            &json::to_string(reference.get("payload").unwrap()),
            &format!("{name} worker payload"),
        );
        assert_eq!(
            json::to_string(&Value::array(progress)),
            json::to_string(reference.get("progress").unwrap()),
            "{name} progress"
        );
        assert_eq!(
            json::to_string(&report),
            reference.get("document").unwrap().as_str().unwrap(),
            "read-only {name}"
        );
        let mut editor = Editor::new(
            report.clone(),
            Options {
                layer_timeline: true,
                property_channels: false,
                auto_key: false,
            },
        );
        let s = initial.get("selection").unwrap();
        let selected = s.get("uid").and_then(Value::as_f64).map(|u| u as u32);
        editor.set_view(
            s.get("tick").unwrap().as_f64().unwrap(),
            s.get("frameIndex").unwrap().as_f64().unwrap() as usize,
            Selection {
                uid: selected,
                uids: s
                    .get("uids")
                    .unwrap()
                    .numbers()
                    .unwrap()
                    .iter()
                    .map(|u| *u as u32)
                    .collect(),
                joint: s.get("joint").unwrap().as_f64().unwrap() as i64,
            },
        );
        editor.set_counters(
            initial.get("layerRevision").unwrap().as_f64().unwrap() as u64,
            next,
            initial.get("nextUid").unwrap().as_f64().unwrap() as u64,
        );
        editor.adopt_prepared(loader, prepared);
        if name == "view-changed" {
            editor.call("seek", &[Value::Num(3.0)]).unwrap();
            editor.call("select", &[Value::Num(2.0)]).unwrap();
        }
        let command = reference.get("command").unwrap();
        assert_eq!(
            plan.map(|plan| editor.publish_sheet_migration(plan).unwrap())
                .unwrap_or(false),
            command.get("result").unwrap().as_bool().unwrap(),
            "{name} result"
        );
        assert_json(
            &editor.report_json(),
            command.get("after").unwrap().as_str().unwrap(),
            &format!("{name} after"),
        );
        assert_eq!(
            json::to_string(&Value::array(editor.take_events())),
            json::to_string(command.get("events").unwrap()),
            "{name} events"
        );
        assert_eq!(
            editor.state().next_frame_identity,
            command
                .path(&["state", "nextFrameIdentity"])
                .unwrap()
                .as_f64()
                .unwrap() as u64
        );
        assert_eq!(
            editor.state().layer_revision,
            command
                .path(&["state", "layerRevision"])
                .unwrap()
                .as_f64()
                .unwrap() as u64
        );
        assert_eq!(
            editor.state().can_undo,
            command
                .path(&["state", "canUndo"])
                .unwrap()
                .as_bool()
                .unwrap()
        );
        editor.call("undo", &[]).unwrap();
        assert_json(
            &editor.report_json(),
            command.get("undone").unwrap().as_str().unwrap(),
            &format!("{name} undo"),
        );
        assert_eq!(
            json::to_string(&Value::array(editor.take_events())),
            json::to_string(command.get("undoEvents").unwrap()),
            "{name} undo events"
        );
        editor.call("redo", &[]).unwrap();
        assert_json(
            &editor.report_json(),
            command.get("redone").unwrap().as_str().unwrap(),
            &format!("{name} redo"),
        );
        assert_eq!(
            json::to_string(&Value::array(editor.take_events())),
            json::to_string(command.get("redoEvents").unwrap()),
            "{name} redo events"
        );
    }
}

#[test]
fn recorded_refusals_cancellation_and_stale_publication_preserve_the_owner() {
    for name in [
        "invalid-uid",
        "missing-layer",
        "locked-destination",
        "locked-source",
        "delete-camera",
        "delete-last",
        "zero-budget",
        "small-budget",
        "cancelled",
        "stale",
    ] {
        let (reference, report, mut loader, prepared) = fixture(name);
        let request = reference.get("request").unwrap();
        let uids: Vec<_> = request
            .get("uids")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .map(|uid| *uid as u32)
            .collect();
        let stopped = std::cell::Cell::new(false);
        let key = reference
            .path(&["failure", "messageKey"])
            .unwrap()
            .as_str()
            .unwrap();
        let mut progress = Vec::new();
        let result = sheet_layer_plan(
            &report,
            &prepared,
            &mut loader,
            Request {
                uids: &uids,
                target_layer: request.get("targetLayerId").unwrap().as_str().unwrap(),
                deleted_layer: request.get("deletedLayerId").and_then(Value::as_str),
                next_frame_identity: request.get("nextFrameIdentity").unwrap().as_f64().unwrap()
                    as u64,
                max_source_bytes: reference
                    .get("maxSourceBytes")
                    .and_then(Value::as_f64)
                    .unwrap_or(128.0 * 1024.0 * 1024.0) as usize,
                focus: None,
            },
            || {
                if stopped.get() {
                    Err(styk_edit::EditError::Invalid(key.into()))
                } else {
                    Ok(())
                }
            },
            |p| {
                progress.push(progress_value(p));
                if name == "cancelled" || name == "stale" {
                    stopped.set(true)
                }
            },
            clock,
        );
        assert_eq!(styk_edit::error_key(&result.unwrap_err().to_string()), key, "{name}");
        assert_json(
            &json::to_string(&report),
            reference.get("document").unwrap().as_str().unwrap(),
            &format!("{name} read-only"),
        );
        assert_json(
            &json::to_string(&Value::array(progress)),
            &json::to_string(reference.get("progress").unwrap()),
            &format!("{name} progress"),
        );
    }
    // A plan which already finished cannot replace independent metadata changes,
    // consume a frame identity, append events or erase the independent history.
    let (reference, report, mut loader, prepared) = fixture("stale");
    let request = reference.get("request").unwrap();
    let identity = request.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64;
    let plan = sheet_layer_plan(
        &report,
        &prepared,
        &mut loader,
        Request {
            uids: &[1],
            target_layer: "layer-2",
            deleted_layer: None,
            next_frame_identity: identity,
            max_source_bytes: 128 * 1024 * 1024,
            focus: None,
        },
        || Ok(()),
        |_| {},
        clock,
    )
    .unwrap()
    .unwrap();
    let mut editor = Editor::new(
        report,
        Options {
            layer_timeline: true,
            ..Options::default()
        },
    );
    editor.set_counters(
        reference
            .path(&["initialState", "layerRevision"])
            .unwrap()
            .as_f64()
            .unwrap() as u64,
        identity,
        reference
            .path(&["initialState", "nextUid"])
            .unwrap()
            .as_f64()
            .unwrap() as u64,
    );
    editor.set_view(
        2.0,
        0,
        Selection {
            uid: Some(1),
            uids: vec![1],
            joint: -1,
        },
    );
    editor.adopt_prepared(loader, prepared);
    editor
        .call(
            "setLayerColor",
            &[
                Value::array(vec![Value::str("layer-3")]),
                Value::str("blue"),
            ],
        )
        .unwrap();
    let events = editor.take_events();
    let before = editor.report().clone();
    let state = editor.state();
    let error = editor.publish_sheet_migration(plan).unwrap_err();
    assert_eq!(
        error.to_string(),
        reference
            .path(&["failure", "messageKey"])
            .unwrap()
            .as_str()
            .unwrap()
    );
    assert!(editor.report().same_node(&before));
    assert_json(
        &editor.report_json(),
        reference
            .path(&["failure", "after"])
            .unwrap()
            .as_str()
            .unwrap(),
        "stale independent change survives",
    );
    assert_eq!(
        json::to_string(&Value::array(events)),
        json::to_string(reference.path(&["failure", "events"]).unwrap())
    );
    assert!(editor.take_events().is_empty());
    assert_eq!(
        editor.state().next_frame_identity,
        state.next_frame_identity
    );
    assert_eq!(editor.state().layer_revision, state.layer_revision);
    assert_eq!(editor.state().undo_label, state.undo_label);
    assert!(editor.call("undo", &[]).unwrap().truthy());
    assert_json(
        &editor.report_json(),
        reference.get("document").unwrap().as_str().unwrap(),
        "stale history remains undoable",
    );
}

#[test]
fn malformed_raw_owner_descriptors_refuse_without_panics_or_mutation() {
    for name in [
        "malformed-fallback-track-missing",
        "malformed-order-missing",
        "malformed-order-empty",
        "malformed-order-numeric",
        "malformed-byid-array",
        "malformed-layer-null",
        "malformed-tracks-missing",
        "malformed-source-track-null",
        "malformed-source-keys-null",
        "malformed-source-key-null",
    ] {
        let (reference, report, mut loader, prepared) = fixture(name);
        assert!(
            reference.path(&["malformed", "loadError"]).is_some(),
            "{name} must be rejected by actual editor loading"
        );
        let r = reference.get("request").unwrap();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sheet_layer_plan(
                &report,
                &prepared,
                &mut loader,
                Request {
                    uids: &[1],
                    target_layer: "layer-2",
                    deleted_layer: r.get("deletedLayerId").and_then(Value::as_str),
                    next_frame_identity: r.get("nextFrameIdentity").unwrap().as_f64().unwrap()
                        as u64,
                    max_source_bytes: 128 * 1024 * 1024,
                    focus: None,
                },
                || Ok(()),
                |_| {},
                clock,
            )
        }));
        assert!(outcome.is_ok(), "{name} raw owner descriptor panicked");
        assert!(
            matches!(
                outcome.unwrap(),
                Err(styk_edit::EditError::Invalid(_) | styk_edit::EditError::Unported(_))
            ),
            "{name} must refuse before capture/publication"
        );
        assert_json(
            &json::to_string(&report),
            reference.get("document").unwrap().as_str().unwrap(),
            &format!("{name} remains untouched"),
        );
    }
}
