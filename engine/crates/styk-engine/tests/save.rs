//! Writing a project from the document an edit session holds: the file reads back as that document, with the metadata every
//! project carries and the Pivot original stored first, the same document saves to the same bytes, and a stopped save writes
//! nothing. Byte identity with the JavaScript writer this replaced is checked on the repository's recorded files by
//! `tests/save-references.test.mjs`.
use sha2::{Digest, Sha256};
use std::sync::Arc;

use styk_doc::{Nums, Obj, Value, json};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::save::{ProjectRequest, SaveError, Source, save_figure_file, save_project};
use styk_engine::{Budgets, Engine};
use styk_formats::container;
use styk_formats::{Kind, files};

fn repo(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)
}

/// The tree the app's session holds of a repository document.
fn tree(path: &str) -> Value {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let text = std::fs::read(repo(path)).unwrap();
    engine.open_document(OpenSource::Json { bytes: &text, name: "Untitled" }, OpenOptions { layer_timeline: true }, &|| false).unwrap().tree
}

fn save(tree: &Value, name: Option<&str>, source: Option<Source>) -> Vec<u8> {
    save_project(std::slice::from_ref(tree), &[], ProjectRequest { name: name.map(str::to_string), source }, &|| false).unwrap().bytes
}

#[test]
fn a_project_reads_back_as_the_document_it_was_saved_from() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let bytes = save(&tree, Some("Saved"), None);
    let reopened = files::open_document(&bytes, Kind::Styk).unwrap();
    assert_eq!(reopened.path(&["_styk", "format"]).and_then(Value::as_str), Some("StykAnimate"));
    assert_eq!(reopened.path(&["_styk", "format_version"]).and_then(Value::as_f64), Some(1.0));
    assert_eq!(reopened.path(&["_styk", "name"]).and_then(Value::as_str), Some("Saved"));
    // Everything else is what the session held (the tree is shared, so the metadata is the only difference).
    let mut expected = tree.clone();
    let mut styk = expected.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("format", Value::str("StykAnimate"));
    styk.set("format_version", Value::Num(1.0));
    styk.set("name", Value::str("Saved"));
    expected.make_obj().unwrap().set("_styk", Value::object(styk));
    assert_eq!(json::to_string(&reopened), json::to_string(&expected));
    // The same document saves to the same bytes.
    assert_eq!(save(&tree, Some("Saved"), None), bytes);
}

#[test]
fn the_pivot_original_is_stored_first_and_checked_on_reading() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let original: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let digest: String = Sha256::digest(&original).iter().map(|byte| format!("{byte:02x}")).collect();
    let mut record = Obj::new();
    record.set("kind", Value::str("piv"));
    record.set("sha256", Value::str(&digest));
    let bytes = save(&tree, None, Some(Source { record: Value::object(record), bytes: original.clone() }));
    let opened = files::open_document(&bytes, Kind::Styk).expect("the fingerprint matches the stored original");
    let source = opened.get("_stykSource").unwrap();
    assert_eq!(source.get("kind").and_then(Value::as_str), Some("piv"));
    let Some(Value::Blob(blob)) = source.get("source_base64") else { panic!("the original is a payload") };
    assert_eq!(&*blob.bytes, &original[..]);
    let checked = container::check(&bytes, Kind::Styk).unwrap();
    let payloads = &checked.parts.sections.iter().find(|(kind, _)| *kind == 2).unwrap().1;
    assert!(payloads.starts_with(&original), "the original opens the payload section, as the app has always stored it");
    // A fingerprint that names other bytes is refused when the file is read.
    let mut wrong = Obj::new();
    wrong.set("sha256", Value::str(&"0".repeat(64)));
    let bad = save(&tree, None, Some(Source { record: Value::object(wrong), bytes: original }));
    assert!(files::open_document(&bad, Kind::Styk).is_err());
}

#[test]
fn a_stopped_save_writes_nothing_and_an_invalid_document_is_refused() {
    let tree = tree("engine/tests/edit/startup.document.json");
    let stopped = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None }, &|| true);
    assert!(matches!(stopped, Err(SaveError::Cancelled)), "{stopped:?}");
    let mut broken = tree.clone();
    broken.make_obj().unwrap().set("figure_types", Value::Num(3.0));
    let refused = save_project(&[broken], &[], ProjectRequest { name: None, source: None }, &|| false);
    assert!(matches!(refused, Err(SaveError::Refused(_))), "{refused:?}");
    let none = save_project(&[], &[], ProjectRequest { name: None, source: None }, &|| false);
    assert!(matches!(none, Err(SaveError::Refused(_))), "{none:?}");
}

#[test]
fn a_figure_file_is_checked_for_being_self_contained_before_it_is_written() {
    // A project is no figure file: the container's own check refuses it, with the message the interface shows.
    let tree = tree("engine/tests/edit/startup.document.json");
    let refused = save_figure_file(&tree, Kind::Stkz, &|| false).unwrap_err();
    let SaveError::File(error) = refused else { panic!("{refused:?}") };
    assert!(error.message_key.starts_with("errors.nativeContainer."), "{error:?}");
}

/// The tree of a repository document with a numeric array of `count` values (single precision, so it is stored as `f32`) added.
fn heavy_tree(count: usize) -> Value {
    let mut tree = tree("engine/tests/edit/startup.document.json");
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let values: Vec<f64> = (0..count)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            f64::from((state % 4096) as f32 / 8.0)
        })
        .collect();
    tree.make_obj().unwrap().set("heavy", Value::Nums(Arc::new(Nums::new(&values))));
    tree
}

#[test]
fn a_save_stops_at_the_question_that_says_so_wherever_it_is_asked_and_writes_nothing() {
    // The worker that runs a save is ended five seconds after it is told to stop, and must not be inside the engine then
    // (docs/engine/threading.md): the longest stretch between two questions is the lift of a few thousand values, the
    // preparation of the document, or hashing or compressing a few megabytes. Counting the questions shows the stretches are short
    // (hashing alone asks for every 4 MiB of a document of 32 MiB of numbers) and that a stop is obeyed by the very next question.
    let tree = heavy_tree(8 << 20);
    let asked = std::cell::Cell::new(0usize);
    let saved = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None }, &|| { asked.set(asked.get() + 1); false }).unwrap();
    let total = asked.get();
    assert!(saved.raw_bytes >= 32 << 20, "{} raw bytes", saved.raw_bytes);
    assert!(total >= 32 / 4 + 2, "{total} questions for {} MiB", saved.raw_bytes >> 20);
    // Stopped at the start, in the preparation, in the lift, while hashing and while compressing: the same answer.
    for stop_at in [1, 2, 5, total / 4, total / 2, total * 3 / 4, total - 1, total] {
        let asked = std::cell::Cell::new(0usize);
        let stopped = save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None }, &|| { asked.set(asked.get() + 1); asked.get() >= stop_at });
        assert!(matches!(stopped, Err(SaveError::Cancelled)), "stopped at question {stop_at} of {total}: {:?}", stopped.map(|written| written.bytes.len()));
        assert_eq!(asked.get(), stop_at, "nothing is asked, and no work is started, after the question that said stop");
    }
}

#[test]
fn a_save_the_memory_cannot_hold_is_refused_before_it_starts() {
    let tree = tree("engine/tests/edit/startup.document.json");
    // The save reserves what its sections and the compressed file take; with the memory limited to 8 MiB it is refused whole.
    let refused = styk_alloc::with_limit(8 << 20, || save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None }, &|| false));
    assert!(matches!(refused, Err(SaveError::OutOfMemory(_))), "{refused:?}");
    // The same document saves when the memory is there, and a refused save changed nothing of it.
    assert!(save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: None }, &|| false).is_ok());
    // The Pivot original counts twice: a document that fits alone does not fit with an original that takes most of the memory.
    let original = Source { record: Value::object(Obj::new()), bytes: vec![0; 100 << 20] };
    let refused = styk_alloc::with_limit(256 << 20, || save_project(std::slice::from_ref(&tree), &[], ProjectRequest { name: None, source: Some(original) }, &|| false));
    assert!(matches!(refused, Err(SaveError::OutOfMemory(_))), "{:?}", refused.map(|written| written.bytes.len()));
}

#[test]
fn every_recorded_project_opens_and_saves_to_its_own_bytes() {
    // The files the repository records were written by the JavaScript writer; a document opened from one and not changed saves
    // to the same bytes, arrays several records share included (`project-shared-arrays.styk`). The app's side of this is
    // `tests/save-references.test.mjs`.
    let mut checked = Vec::new();
    for entry in std::fs::read_dir(repo("engine/tests/containers")).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".styk") || name.contains("version-1") {
            continue;
        }
        let recorded = std::fs::read(&path).unwrap();
        // As the app opens a file, except the one whose movieclip frames the open gives identities the file lacks: that one is the tree as stored.
        let tree = if name.contains("shared") {
            files::open_document(&recorded, Kind::Styk).unwrap()
        } else {
            let engine = Engine::new(|| 0.0, Budgets::for_device(None));
            engine.open_document(OpenSource::File { bytes: &recorded, name: &name }, OpenOptions { layer_timeline: false }, &|| false).unwrap().tree
        };
        let saved = save(&tree, None, None);
        assert!(saved == recorded, "{name}: {} bytes saved, {} recorded", saved.len(), recorded.len());
        checked.push(name);
    }
    assert!(checked.contains(&"project-shared-arrays.styk".to_string()) && checked.len() >= 5, "{checked:?}");
}
