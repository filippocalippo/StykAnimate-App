//! In-between planning on the engine's workers: the editor's plan over the existing bounded
//! packet lane, a refusal in the editor's words, and cancellation or a newer document retiring
//! the job without touching the document.
use styk_doc::{Value, json};
use styk_engine::{Engine, planning::InbetweenRequest, planning::PlanError};

mod common;
use common::{apply, engine_with, republish};

struct Fixture {
    reference: Value,
    engine: Engine,
    request: InbetweenRequest,
}
fn load(name: &str) -> Fixture {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/inbetween/{name}.json"));
    let reference = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let tree = json::parse(reference.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let request = reference.get("request").unwrap();
    let request = InbetweenRequest {
        ratio: request.get("ratio").unwrap().as_f64().unwrap(),
        indices: request.get("indices").unwrap().numbers().unwrap().iter().map(|index| *index as usize).collect(),
        next_frame_identity: request.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
    };
    let engine = engine_with(&tree);
    // Whatever the publication of a document with channels leaves for the workers runs first.
    while engine.step() {}
    Fixture { engine, reference, request }
}
fn names() -> Vec<String> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/inbetween");
    let mut names: Vec<String> =
        std::fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().path().file_stem().unwrap().to_string_lossy().to_string()).collect();
    names.sort();
    names
}

#[test]
fn the_worker_sends_the_editors_plan_in_acknowledged_packets() {
    let mut planned = 0;
    for name in names() {
        let Fixture { reference, engine, request } = load(&name);
        let Some(expected) = reference.get("payload") else { continue };
        planned += 1;
        let before = engine.stored().unwrap().1;
        let generation = engine.generation().unwrap().id;
        let job = engine.plan_inbetweens(1, request).unwrap();
        assert!(job.poll().chunk.is_none(), "{name} must only enqueue on the caller");
        let (mut actual, mut packets, mut phases) = (Value::Null, 0, Vec::new());
        loop {
            engine.step();
            let result = job.poll();
            assert!(result.error.is_none(), "{name}: {:?}", result.error);
            if let Some(progress) = result.progress {
                phases.push(progress.phase);
            }
            if let Some(chunk) = result.chunk {
                assert_eq!(chunk.sequence, packets);
                assert!(chunk.json.len() <= styk_engine::planning::CHUNK_BYTES);
                actual = apply(actual, &json::parse(chunk.json.as_bytes()).unwrap());
                packets += 1;
                assert!(!engine.step(), "{name}: an unacknowledged packet cannot enqueue cursor work");
                assert!(job.ack(chunk.sequence).unwrap());
            }
            if result.done {
                break;
            }
            assert!(packets < 10_000);
        }
        assert_eq!(json::to_string(&actual), json::to_string(expected), "{name}");
        assert!(before.same_node(&engine.stored().unwrap().1), "planning only reads {name}");
        assert_eq!(engine.generation().unwrap().id, generation);
        assert!(!engine.step(), "nothing is left queued for {name}");
        // Sampling, and for authored documents the animation, was reported on the way.
        if name.starts_with("authored-") {
            assert!(phases.contains(&"animation") || phases.contains(&"sampling animation"), "{name}: {phases:?}");
        }
    }
    assert_eq!(planned, 18);
}

#[test]
fn a_refusal_arrives_with_the_editors_message_key() {
    for name in names() {
        let Fixture { reference, engine, request } = load(&name);
        let Some(key) = reference.path(&["failure", "messageKey"]).and_then(Value::as_str) else { continue };
        let before = engine.stored().unwrap().1;
        let job = engine.plan_inbetweens(1, request).unwrap();
        engine.step();
        assert_eq!(job.poll().error, Some(PlanError::Invalid(key.to_string())), "{name}");
        assert!(before.same_node(&engine.stored().unwrap().1));
        assert!(!engine.step(), "{name}: nothing is left queued after the refusal");
    }
}

#[test]
fn cancellation_and_a_newer_document_retire_the_job() {
    for state in ["queued", "awaiting-ack"] {
        for change in ["cancel", "stale"] {
            let Fixture { engine, request, .. } = load("authored-independent");
            let before = engine.stored().unwrap().1;
            let job = engine.plan_inbetweens(1, request).unwrap();
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
            let expected = if change == "cancel" { PlanError::Cancelled } else { PlanError::Stale };
            assert_eq!(job.poll().error, Some(expected), "{state} {change}");
            assert!(before.same_node(&engine.stored().unwrap().1) || change == "stale");
            while engine.step() {}
        }
    }
}

#[test]
fn only_the_acknowledged_revision_is_planned_and_one_job_runs_at_a_time() {
    let Fixture { engine, request, .. } = load("native-linear");
    assert_eq!(engine.plan_inbetweens(2, request.clone()).err(), Some(PlanError::Stale));
    let first = engine.plan_inbetweens(1, request.clone()).unwrap();
    assert!(matches!(engine.plan_inbetweens(1, request.clone()), Err(PlanError::Invalid(_))), "a second job is refused while one holds the lane");
    while engine.step() {}
    assert_eq!(first.poll().error, Some(PlanError::Cancelled), "the refused request retired the first");
    let mut huge = request;
    huge.indices = vec![0; 100_001];
    assert!(matches!(engine.plan_inbetweens(1, huge), Err(PlanError::Invalid(_))));
}
