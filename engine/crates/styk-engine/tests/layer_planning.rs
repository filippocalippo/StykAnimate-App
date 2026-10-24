//! Read-only native layer planner agrees with actual editor worker recordings.
use std::sync::Arc;
use styk_doc::{Value, json};
use styk_engine::planning::{LayerRequest, PlanError, TRANSFER_BYTES, native_layer_plan};
use styk_eval::eval::Prepared;

mod common;
use common::{apply, clock, engine_with, republish};

fn load(name: &str) -> (Value, Value, Prepared, LayerRequest) {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/layer-migration/{name}.json"));
    let reference = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let tree = json::parse(
        reference
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let doc = styk_eval::load::Loader::new()
        .document(&tree, "layer planner")
        .unwrap();
    let prepared = Prepared::new(Arc::new(doc));
    let request = reference.get("request").unwrap();
    let req = LayerRequest {
        uids: request
            .get("uids")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .map(|v| *v as u32)
            .collect(),
        target_layer: request
            .get("targetLayerId")
            .unwrap()
            .as_str()
            .unwrap()
            .into(),
        deleted_layer: request
            .get("deletedLayerId")
            .and_then(Value::as_str)
            .map(str::to_string),
        next_frame_identity: request.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
        max_source_bytes: TRANSFER_BYTES,
    };
    (reference, tree, prepared, req)
}
#[test]
fn native_worker_plans_match_editor_payloads() {
    for name in [
        "native-only",
        "independent",
        "joined-scalars",
        "delete-default",
        "dense-single-figure",
    ] {
        let (reference, tree, prepared, request) = load(name);
        let before = json::to_string(&tree);
        let mut progress = Vec::new();
        let payload = native_layer_plan(
            &tree,
            &prepared,
            &request,
            || Ok(()),
            |p| progress.push(p),
            clock,
        )
        .unwrap();
        assert_eq!(
            json::to_string(&payload),
            json::to_string(reference.get("payload").unwrap()),
            "{name}"
        );
        assert_eq!(
            before,
            json::to_string(&tree),
            "planning never publishes {name}"
        );
        if name != "native-only" {
            assert_eq!(progress.last().unwrap().completed, prepared.total_ticks);
        }
    }
}
#[test]
fn cancellation_and_source_budget_preserve_original_document() {
    let (_, tree, prepared, mut request) = load("independent");
    let before = json::to_string(&tree);
    let mut checks = 0;
    assert_eq!(
        native_layer_plan(
            &tree,
            &prepared,
            &request,
            || {
                checks += 1;
                if checks > 5 {
                    Err(PlanError::Cancelled)
                } else {
                    Ok(())
                }
            },
            |_| {},
            clock
        )
        .unwrap_err(),
        PlanError::Cancelled
    );
    request.max_source_bytes = 1;
    assert!(matches!(
        native_layer_plan(&tree, &prepared, &request, || Ok(()), |_| {}, clock),
        Err(PlanError::Invalid(_))
    ));
    assert_eq!(before, json::to_string(&tree));
}

fn reconstruct(payload: Value) -> (Value, usize) {
    let mut chunks = styk_engine::planning::Chunks::new(payload).unwrap();
    let mut report = Value::Null;
    let mut count = 0;
    while let Some(text) = chunks.next_chunk().unwrap() {
        assert!(text.len() <= styk_engine::planning::CHUNK_BYTES);
        let packet = json::parse(text.as_bytes()).unwrap();
        if let Some(size) = packet.get("estimatedBytes") {
            assert!(size.as_f64().unwrap() <= styk_engine::planning::CHUNK_BYTES as f64);
        }
        report = apply(report, &packet);
        count += 1;
    }
    (report, count)
}
#[test]
fn dense_single_figure_and_channel_are_sliced_losslessly() {
    let (reference, _, _, _) = load("dense-single-figure");
    let expected = reference.get("payload").unwrap();
    let (actual, count) = reconstruct(expected.clone());
    assert!(count > 20, "large figure must cross ACKs");
    assert_eq!(json::to_string(&actual), json::to_string(expected));
    let keys: Vec<_> = (0..5000).map(|i| json::parse(format!(r#"{{"id":"key-{i}","tick":{i},"value":{{"frameId":"frame-1"}},"interpolation":"hold"}}"#).as_bytes()).unwrap()).collect();
    let mut channel = styk_doc::Obj::new();
    channel.set("property", Value::str("pose"));
    channel.set("keys", Value::array(keys));
    let mut plan = styk_doc::Obj::new();
    plan.set("channel", Value::object(channel));
    plan.set("unicode", Value::str(&"🍀\n\"\\".repeat(30_000)));
    plan.set(
        "blob",
        Value::Blob(Arc::new(styk_doc::Blob {
            prefix: Arc::from("data:image/png;base64,"),
            bytes: vec![123; 99_999].into(),
        })),
    );
    let payload = Value::object(plan);
    let (actual, count) = reconstruct(payload.clone());
    assert!(count > 30);
    assert_eq!(json::to_string(&actual), json::to_string(&payload));
}

fn sheet_fixture(name: &str) -> (Value, styk_engine::Engine, LayerRequest) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/layer-sheet-migration/{name}.json"));
    let reference = json::parse(&std::fs::read(path).unwrap()).unwrap();
    let tree = json::parse(
        reference
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let engine = engine_with(&tree);
    let request = reference.get("request").unwrap();
    let request = LayerRequest {
        uids: request
            .get("uids")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .map(|u| *u as u32)
            .collect(),
        target_layer: request
            .get("targetLayerId")
            .unwrap()
            .as_str()
            .unwrap()
            .into(),
        deleted_layer: request
            .get("deletedLayerId")
            .and_then(Value::as_str)
            .map(str::to_string),
        next_frame_identity: request.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
        max_source_bytes: reference
            .get("maxSourceBytes")
            .and_then(Value::as_f64)
            .unwrap_or(TRANSFER_BYTES as f64) as usize,
    };
    (reference, engine, request)
}
#[test]
fn stored_sheet_kernel_uses_the_existing_bounded_worker_lane() {
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
        let (reference, engine, request) = sheet_fixture(name);
        let before = engine.stored().unwrap().1;
        let generation = engine.generation().unwrap().id;
        let job = engine.plan_layers(1, request).unwrap();
        assert!(
            job.poll().chunk.is_none(),
            "{name} must only enqueue on caller"
        );
        let mut actual = Value::Null;
        let mut packets = 0;
        let mut progress = None;
        loop {
            engine.step();
            let result = job.poll();
            assert!(result.error.is_none(), "{name}: {:?}", result.error);
            if let Some(p) = result.progress {
                progress = Some(p)
            }
            if let Some(chunk) = result.chunk {
                assert_eq!(chunk.sequence, packets);
                assert!(chunk.json.len() <= styk_engine::planning::CHUNK_BYTES);
                let packet = json::parse(chunk.json.as_bytes()).unwrap();
                actual = apply(actual, &packet);
                packets += 1;
                assert!(
                    !engine.step(),
                    "an unacked sheet packet cannot enqueue cursor work"
                );
                assert!(job.ack(chunk.sequence).unwrap());
            }
            if result.done {
                break;
            }
            assert!(packets < 10000);
        }
        let expected = reference.get("payload").unwrap();
        assert!(actual == *expected, "{name} payload differs");
        if name == "dense" {
            assert!(
                packets > 20,
                "dense figure + unknown fields must cross bounded ACKs"
            )
        }
        let expected_progress = reference.get("progress").unwrap().elements().unwrap();
        if let Some(last) = expected_progress.get(expected_progress.len().saturating_sub(1)) {
            let p = progress.unwrap();
            assert_eq!(p.phase, last.get("phase").unwrap().as_str().unwrap());
            assert_eq!(
                p.completed as f64,
                last.get("completed").unwrap().as_f64().unwrap()
            );
            assert_eq!(p.total as f64, last.get("total").unwrap().as_f64().unwrap());
        } else {
            assert!(progress.is_none())
        }
        assert!(
            before.same_node(&engine.stored().unwrap().1),
            "read-only {name}"
        );
        assert_eq!(engine.generation().unwrap().id, generation);
    }
}
#[test]
fn sheet_worker_refusals_cancel_and_generation_changes_preserve_canonical_owner() {
    for name in [
        "invalid-uid",
        "missing-layer",
        "locked-destination",
        "locked-source",
        "delete-camera",
        "delete-last",
        "zero-budget",
        "small-budget",
    ] {
        let (reference, engine, request) = sheet_fixture(name);
        let before = engine.stored().unwrap().1;
        let job = engine.plan_layers(1, request).unwrap();
        engine.step();
        assert_eq!(
            styk_edit::error_key(&job.poll().error.unwrap().to_string()),
            reference
                .path(&["failure", "messageKey"])
                .unwrap()
                .as_str()
                .unwrap(),
            "{name}"
        );
        assert!(before.same_node(&engine.stored().unwrap().1));
    }
    for state in ["queued", "awaiting-ack"] {
        for change in ["cancel", "stale"] {
            let (_, engine, request) = sheet_fixture("dense");
            let before = engine.stored().unwrap().1;
            let previous = std::sync::Arc::downgrade(&engine.generation().unwrap());
            let job = engine.plan_layers(1, request).unwrap();
            if state == "awaiting-ack" {
                engine.step();
                assert!(job.poll().chunk.is_some());
            }
            if change == "cancel" {
                job.cancel()
            } else {
                republish(&engine, 2);
            }
            engine.step();
            assert_eq!(
                job.poll().error,
                Some(if change == "cancel" {
                    PlanError::Cancelled
                } else {
                    PlanError::Stale
                })
            );
            assert!(before.same_node(&engine.stored().unwrap().1));
            if change == "stale" {
                assert!(previous.upgrade().is_some(), "the displaced generation remains owned until worker retirement");
                assert!(engine.step(), "the separate generation retirement must run on its worker");
                assert!(previous.upgrade().is_none(), "the displaced generation is released by that exact retirement");
            }
            assert!(
                !engine.step(),
                "no stale planner payload or publication retirement remains queued"
            );
        }
    }
}
