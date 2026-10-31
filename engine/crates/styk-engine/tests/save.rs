//! Writing a project from the document an edit session holds: the file reads back as that document, with the metadata every
//! project carries and the Pivot original stored first, the same document saves to the same bytes, and a stopped save writes
//! nothing. Byte identity with the JavaScript writer this replaced is checked on the app's documents by
//! `tests/save-references.test.mjs`.
use sha2::{Digest, Sha256};
use styk_doc::{Obj, Value, json};
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
