//! A document taken from a tree in memory (a movieclip's, from the project that holds it) opens as the text of it does, and the open asks for
//! what a tree needs, not sixteen times its text (`OpenSource::Tree`).
use std::path::Path;

use styk_doc::json;
use styk_engine::document::{OPEN_BYTES_PER_TREE_BYTE, OpenOptions, OpenSource, open_tree_estimate};
use styk_engine::{Budgets, Engine};

fn tree() -> styk_doc::Value {
    json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/sheet-layers.document.json")).unwrap()).unwrap()
}

#[test]
fn a_tree_opens_as_its_text_does() {
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let options = OpenOptions { layer_timeline: true };
    let tree = tree();
    let text = json::to_string(&tree);
    let from_text = engine.open_document(OpenSource::Json { bytes: text.as_bytes(), name: "Clip" }, options, &|| false).expect("the text opens");
    let from_tree = engine.open_document(OpenSource::Tree { document: tree, name: "Clip" }, options, &|| false).expect("the tree opens");
    assert_eq!(json::to_string(&from_tree.tree), json::to_string(&from_text.tree), "the same document");
    assert_eq!(from_tree.name, from_text.name);
    assert_eq!(from_tree.kind, from_text.kind);
    assert_eq!(from_tree.indexes.indexes(), from_text.indexes.indexes(), "and the same indexes");
}

#[test]
fn the_open_of_a_tree_asks_for_a_few_times_its_text_not_sixteen() {
    let tree = tree();
    let text = json::to_string(&tree).len();
    let estimate = open_tree_estimate(&tree);
    assert!(estimate <= (text * OPEN_BYTES_PER_TREE_BYTE).max(96 << 20) + (1 << 10), "{estimate} for {text} bytes of text");
    assert!(OPEN_BYTES_PER_TREE_BYTE * 4 < styk_engine::document::OPEN_BYTES_PER_BYTE);
}
