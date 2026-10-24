//! The in-between planner agrees with the editor's own (`planInsertInbetweens`, recorded by
//! engine/tools/inbetween-fixtures.mjs): the plan it sends, or the refusal it words.
use std::sync::Arc;
use styk_doc::{Value, json};
use styk_edit::{EditError, inbetween_planning};
use styk_eval::eval::Prepared;

/// The recorded fixtures: the plans, and the refusals the editor words.
fn recorded() -> (Vec<String>, Vec<String>) {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/inbetween");
    let (mut plans, mut refusals) = (Vec::new(), Vec::new());
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let reference = json::parse(&std::fs::read(&path).unwrap()).unwrap();
        if reference.get("payload").is_some() { plans.push(name) } else { refusals.push(name) }
    }
    plans.sort();
    refusals.sort();
    (plans, refusals)
}

struct Fixture {
    reference: Value,
    tree: Value,
    prepared: Prepared,
    ratio: f64,
    indices: Vec<usize>,
    identity: u64,
}
fn load(name: &str) -> Fixture {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/inbetween/{name}.json"));
    let reference = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let tree = json::parse(reference.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let doc = styk_eval::load::Loader::new().document(&tree, "in-between planner").unwrap();
    let request = reference.get("request").unwrap();
    Fixture {
        ratio: request.get("ratio").unwrap().as_f64().unwrap(),
        indices: request.get("indices").unwrap().numbers().unwrap().iter().map(|index| *index as usize).collect(),
        identity: request.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
        prepared: Prepared::new(Arc::new(doc)),
        reference,
        tree,
    }
}
fn plan(fixture: &Fixture, progress: &mut Vec<inbetween_planning::Progress>) -> Result<Value, EditError> {
    inbetween_planning::plan(
        &fixture.tree,
        &fixture.prepared,
        &inbetween_planning::Request { ratio: fixture.ratio, indices: &fixture.indices, next_frame_identity: fixture.identity },
        || Ok(()),
        |step| progress.push(step),
    )
}

#[test]
fn plans_match_the_editors_wire_byte_for_byte() {
    let (plans, _) = recorded();
    assert_eq!(plans.len(), 18, "{plans:?}");
    for name in plans {
        let fixture = load(&name);
        let before = json::to_string(&fixture.tree);
        let mut progress = Vec::new();
        let payload = plan(&fixture, &mut progress).unwrap_or_else(|error| panic!("{name}: {error}"));
        let expected = fixture.reference.get("payload").unwrap();
        assert_eq!(json::to_string(&payload), json::to_string(expected), "{name}");
        assert_eq!(before, json::to_string(&fixture.tree), "planning never edits the document: {name}");
        let entries = expected.path(&["plan", "entries"]).unwrap().array_len().unwrap();
        assert_eq!(progress.iter().filter(|step| step.phase == "sampling").count(), entries, "{name}");
        assert_eq!(progress.last().unwrap().completed, progress.last().unwrap().total, "{name} ends complete");
    }
}

#[test]
fn refusals_carry_the_editors_message_keys() {
    let (_, refusals) = recorded();
    assert_eq!(refusals.len(), 4, "{refusals:?}");
    for name in refusals {
        let fixture = load(&name);
        let key = fixture.reference.path(&["failure", "messageKey"]).unwrap().as_str().unwrap();
        match plan(&fixture, &mut Vec::new()) {
            Err(EditError::Invalid(message)) => assert_eq!(message, key, "{name}"),
            other => panic!("{name}: expected the refusal {key}, found {other:?}"),
        }
    }
}

#[test]
fn cancellation_stops_the_plan_and_leaves_the_document() {
    for name in ["native-auto", "authored-independent"] {
        let fixture = load(name);
        let before = json::to_string(&fixture.tree);
        let mut checks = 0;
        let result = inbetween_planning::plan(
            &fixture.tree,
            &fixture.prepared,
            &inbetween_planning::Request { ratio: fixture.ratio, indices: &fixture.indices, next_frame_identity: fixture.identity },
            || {
                checks += 1;
                if checks > 2 { Err(EditError::Invalid("cancelled".into())) } else { Ok(()) }
            },
            |_| {},
        );
        assert!(matches!(result, Err(EditError::Invalid(ref message)) if message == "cancelled"), "{name}: {result:?}");
        assert_eq!(before, json::to_string(&fixture.tree));
    }
}

#[test]
fn what_the_engine_does_not_plan_is_unported() {
    // A layer sheet and authored poses with camera-motion clips plan in JavaScript.
    let mut fixture = load("authored-independent");
    let mut styk = fixture.tree.get("_styk").unwrap().as_obj().unwrap().clone();
    let mut clips = styk_doc::Obj::new();
    clips.set("clips", Value::array(vec![Value::object(styk_doc::Obj::new())]));
    styk.set("cameraMotion", Value::object(clips));
    let mut tree = fixture.tree.as_obj().unwrap().clone();
    tree.set("_styk", Value::object(styk));
    fixture.tree = Value::object(tree);
    assert!(matches!(plan(&fixture, &mut Vec::new()), Err(EditError::Unported(_))));
    let mut sheet = load("native-linear");
    let mut styk = sheet.tree.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("layerSheet", Value::object(styk_doc::Obj::new()));
    let mut tree = sheet.tree.as_obj().unwrap().clone();
    tree.set("_styk", Value::object(styk));
    sheet.tree = Value::object(tree);
    assert!(matches!(plan(&sheet, &mut Vec::new()), Err(EditError::Unported(_))));
}
