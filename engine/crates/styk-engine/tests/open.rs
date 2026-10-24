//! Documents entering the engine: opened from JSON text and from a file, normalized as the editor's load
//! does, published, edited by a session whose changes the published document follows, and refused with the
//! message the interface shows.
use styk_doc::{Value, json};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine};

fn clock() -> f64 {
    0.0
}

fn engine() -> Engine {
    Engine::new(clock, Budgets::for_device(None))
}

fn repo(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)
}

const APP: OpenOptions = OpenOptions { layer_timeline: true };
const STATE: &str = r#"{"propertyChannels":true,"layerTimeline":true,"tick":0,"frameIndex":0,"layerRevision":1,"nextFrameIdentity":2,"nextUid":2}"#;

#[test]
fn a_json_document_opens_normalized_and_is_published() {
    let engine = engine();
    let text = std::fs::read(repo("engine/tests/edit/startup.document.json")).unwrap();
    let opened = engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, APP, &|| false).unwrap();
    assert_eq!(opened.kind, "json");
    assert_eq!(opened.indexes.next_uid, 2.0);
    assert!(opened.tree.path(&["_styk", "layerSheet"]).is_some());
    assert!(engine.generation().is_none(), "opening publishes nothing");
    let id = engine.activate(&opened.typed, &opened.tree, 7).unwrap().generation;
    let generation = engine.generation().expect("the document is published");
    assert_eq!((generation.id, generation.revision), (id, 7));
    assert_eq!(generation.prepared.doc.keyframes.len(), 1);
}

#[test]
fn a_file_opens_like_the_document_it_holds() {
    let engine = engine();
    let folder = repo("engine/tests/containers");
    let mut opened_any = false;
    for entry in std::fs::read_dir(folder).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".styk") {
            continue;
        }
        let bytes = std::fs::read(entry.path()).unwrap();
        // A file may be refused (a figure file is no project); one that opens must publish.
        if let Ok(opened) = engine.open_document(OpenSource::File { bytes: &bytes, name: &name }, APP, &|| false) {
            opened_any = true;
            assert_eq!(opened.kind, "styk", "{name}");
            engine.activate(&opened.typed, &opened.tree, 1).unwrap();
            assert!(engine.generation().unwrap().prepared.doc.keyframes.len() >= 1, "{name}");
        }
    }
    assert!(opened_any, "the container fixtures hold a project");
}

#[test]
fn the_published_document_follows_the_session() {
    let engine = engine();
    let text = std::fs::read(repo("engine/tests/edit/startup.document.json")).unwrap();
    let opened = engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, APP, &|| false).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let before = engine.generation().unwrap();
    let mut session = opened.start_session(STATE).unwrap();
    let answer = json::parse(session.call("setFPS", "[30]", "null").as_bytes()).unwrap();
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer}");
    let committed = engine.publish_tree(opened.lineage(), session.report().clone(), session.revision()).unwrap().expect("nothing reads the document");
    let after = engine.generation().unwrap();
    assert_eq!(after.id, committed.generation);
    assert_ne!(after.id, before.id);
    assert_eq!(after.lineage, before.lineage, "an edit stays in the document's lineage");
    assert_eq!(after.prepared.doc.fps, 30.0);
    assert_eq!(before.prepared.doc.fps, 24.0);
    assert_eq!(committed.converted.keyframes, 0, "no keyframe was converted again");
    assert_eq!(engine.stored().unwrap().1.get("fps").and_then(Value::as_f64), Some(30.0));
}

#[test]
fn a_document_that_cannot_open_says_why() {
    let engine = engine();
    let refused = |source: OpenSource| engine.open_document(source, APP, &|| false).err().expect("refused");
    let broken = refused(OpenSource::Json { bytes: b"{not json", name: "x" });
    assert_eq!(broken.key.as_deref(), Some("errors.importWorker.unreadableProject"));
    let mut document = json::parse(&std::fs::read(repo("engine/tests/edit/startup.document.json")).unwrap()).unwrap();
    document.make_obj().unwrap().set("figure_types", Value::str("not a table"));
    let bytes = json::to_string(&document).into_bytes();
    let damaged = refused(OpenSource::Json { bytes: &bytes, name: "x" });
    assert!(damaged.key.is_some(), "a damaged project is refused with a message key: {damaged:?}");
    assert!(damaged.to_json().contains("\"messageKey\""));
    let unsupported = refused(OpenSource::File { bytes: b"abc", name: "notes.txt" });
    assert!(unsupported.message.contains("Choose a"), "{}", unsupported.message);
    let piv = refused(OpenSource::File { bytes: b"definitely not a pivot file", name: "x.piv" });
    assert_eq!(piv.code.as_deref(), Some("invalid_project"));
    assert_eq!(piv.status, Some(422));
    let cancelled = engine.open_document(OpenSource::Json { bytes: &json::to_string(&document).into_bytes(), name: "x" }, APP, &|| true).err().expect("cancelled");
    assert_eq!(cancelled.code.as_deref(), Some("cancelled"));
}

#[test]
fn a_revision_that_moves_with_the_tree_untouched_is_published_without_converting_anything() {
    let engine = engine();
    let text = std::fs::read(repo("engine/tests/edit/startup.document.json")).unwrap();
    let opened = engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, APP, &|| false).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let before = engine.generation().unwrap();
    // `dirty = true` in the editor: a new revision, the same document.
    let committed = engine.publish_tree(opened.lineage(), opened.tree.clone(), 2).unwrap().expect("nothing reads the document");
    let after = engine.generation().unwrap();
    assert_eq!((before.revision, after.revision), (1, 2));
    assert_eq!(committed.converted.keyframes, 0);
    assert!(std::sync::Arc::ptr_eq(&before.prepared, &after.prepared), "the typed views are the same");
    assert_eq!(engine.stored().unwrap().0, 2);
}

#[test]
fn a_draft_is_drawn_with_the_document_until_the_document_is_published_again() {
    use styk_engine::document::Draft;
    let engine = engine();
    let text = std::fs::read(repo("engine/tests/edit/startup.document.json")).unwrap();
    let opened = engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, APP, &|| false).unwrap();
    engine.activate(&opened.typed, &opened.tree, 3).unwrap();
    let before = engine.generation().unwrap();
    let held = before.prepared.doc.figures.len();
    // A figure the document does not hold yet, on a layer.
    let mut figure = json::parse(json::to_string(&opened.tree.path(&["figure_types"]).unwrap().item(0).unwrap()).as_bytes()).unwrap();
    figure.make_obj().unwrap().set("figure_type_id", Value::Num(40.0));
    let assignments = json::parse(br#"{"41":"layer-1"}"#).unwrap();
    let draft = Draft { figures: vec![figure], assignments: assignments.as_obj().unwrap().clone() };

    assert!(!engine.draft_held(1));
    let committed = engine.publish_draft(1, &draft).unwrap().expect("a document is open");
    let drawn = engine.generation().unwrap();
    assert_eq!(drawn.id, committed.generation);
    assert!(drawn.id > before.id);
    assert_eq!((drawn.revision, drawn.prepared.doc.figures.len()), (3, held + 1), "the draft's figure is drawn, at the editor's revision");
    assert!(engine.draft_held(1) && !engine.draft_held(2));
    // What an edit session or a planner reads never includes it.
    let (revision, tree) = engine.stored().unwrap();
    assert_eq!((revision, tree.path(&["figure_types"]).unwrap().array_len()), (3, Some(held)));
    assert!(tree.path(&["_styk", "layers", "assignments"]).and_then(|assignments| assignments.get("41")).is_none());

    // The same draft again, under a new token, replaces the one in front instead of stacking on it.
    engine.publish_draft(2, &draft).unwrap();
    assert_eq!(engine.generation().unwrap().prepared.doc.figures.len(), held + 1);
    assert!(engine.draft_held(2) && !engine.draft_held(1));

    // Taking it out draws the document again; nothing is held after.
    let cleared = engine.clear_draft().expect("a draft was held");
    let after = engine.generation().unwrap();
    assert_eq!((after.id, after.revision, after.prepared.doc.figures.len()), (cleared.generation, 3, held));
    assert!(std::sync::Arc::ptr_eq(&after.prepared, &before.prepared), "the document's own views are drawn again");
    assert!(!engine.draft_held(2));
    assert!(engine.clear_draft().is_none(), "nothing to take out");

    // A publication of the document takes a draft out too.
    engine.publish_draft(3, &draft).unwrap();
    engine.publish_tree(opened.lineage(), opened.tree.clone(), 4).unwrap().expect("the document is in front");
    assert!(!engine.draft_held(3));
    assert_eq!(engine.generation().unwrap().prepared.doc.figures.len(), held);
}

#[test]
fn an_open_the_memory_cannot_hold_is_refused_with_the_message_the_interface_shows() {
    let engine = engine();
    let text = std::fs::read(repo("engine/tests/edit/startup.document.json")).unwrap();
    // The engine's memory is 96 MiB here, less its reserve: no open (which reserves at least 96 MiB) fits.
    let refused = styk_alloc::with_limit(96 << 20, || engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, APP, &|| false));
    let error = refused.err().expect("the open is refused");
    assert_eq!(error.key.as_deref(), Some("errors.engine.outOfMemory"));
    assert_eq!(error.code.as_deref(), Some("out_of_memory"));
    let json = json::parse(error.to_json().as_bytes()).unwrap();
    assert_eq!(json.get("messageKey").and_then(Value::as_str), Some("errors.engine.outOfMemory"));
    assert_eq!(json.get("code").and_then(Value::as_str), Some("out_of_memory"));
    assert!(engine.generation().is_none(), "a refused open changes nothing");
    // The same open, once the memory is there, goes through: the engine is as it was.
    assert!(engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, APP, &|| false).is_ok());
}

#[test]
fn a_large_file_asks_for_more_memory_than_a_small_one() {
    use styk_engine::document::{OPEN_BYTES_PER_BYTE, open_estimate};
    assert_eq!(open_estimate(0), open_estimate(1000), "a small file still takes the least an open takes");
    assert!(open_estimate(1000) >= 96 << 20);
    assert_eq!(open_estimate(40 << 20), (40 << 20) * OPEN_BYTES_PER_BYTE, "a 40 MiB file");
    assert_eq!(open_estimate(usize::MAX), usize::MAX, "no overflow");
}

#[test]
fn the_interface_asks_before_it_copies_a_file_in() {
    use styk_engine::document::admit_open;
    assert!(admit_open(1 << 20).is_ok());
    let refused = styk_alloc::with_limit(64 << 20, || admit_open(1 << 20)).unwrap_err();
    assert_eq!(refused.key.as_deref(), Some("errors.engine.outOfMemory"));
    // A file that is larger than the address space the module could ever have is refused without a block being made.
    assert_eq!(admit_open(usize::MAX / 2).unwrap_err().code.as_deref(), Some("out_of_memory"));
    // Keeping the Pivot original with the document takes the file in once more.
    assert!(styk_engine::document::admit_copy(1 << 20).is_ok());
    assert!(styk_alloc::with_limit(64 << 20, || styk_engine::document::admit_copy(61 << 20)).is_err());
}
