//! A cel published again is written where it differs from the one in the atlas: when the atlas holds what the engine was asked for, it keeps the
//! slots of the tiles they share and writes none of them again; while pictures are on their way it is written whole.

use std::path::Path;
use std::sync::Arc;

use styk_doc::{json, Value};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine};

fn opened() -> (Engine, styk_engine::document::OpenedDocument) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let text = std::fs::read_to_string(path).unwrap();
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let opened = engine.open_document(OpenSource::Json { bytes: text.as_bytes(), name: "incremental cel" }, OpenOptions::default(), &|| false).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    (engine, opened)
}

/// The same document with the cel's tile payload made anew: other pixels as far as the engine can tell, the same tiles.
fn republished(tree: &Value) -> Value {
    let mut next = tree.clone();
    let asset = &mut next.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("image_assets").unwrap().make_arr().unwrap()[0];
    let text = asset.get("styk_tiles").and_then(Value::as_str).expect("the cel's tiles").to_string();
    asset.make_obj().unwrap().set("styk_tiles", Value::str(&text));
    next
}

fn cel(engine: &Engine) -> Arc<styk_eval::doc::DrawingTiles> {
    engine.generation().unwrap().assets.cels.values().next().unwrap().0.clone()
}

#[test]
fn a_cel_published_again_with_the_same_tiles_writes_none_of_them_once_the_atlas_holds_the_one_before() {
    let (engine, opened) = opened();
    while engine.step() {}
    let first = engine.take_images(usize::MAX);
    assert!(!first.is_empty());
    assert_eq!(engine.images_backlog(), (0, 0), "every picture is decoded and taken");
    let before = cel(&engine);
    let slots = engine.generation().unwrap().assets.cel_slots(&before).unwrap().to_vec();

    engine.publish_tree(opened.lineage(), republished(&opened.tree), 2).unwrap().expect("the document is the engine's");
    let after = cel(&engine);
    assert!(!Arc::ptr_eq(&before, &after), "the payload was made anew");
    // How the atlas is written does not touch the document: the cel's data, which is what a save writes, is the data published.
    assert_eq!(before.tiles, after.tiles, "the cel's tiles are the document's, byte for byte");
    assert_eq!(before.levels, after.levels);
    let assets = engine.generation().unwrap().assets.clone();
    assert_eq!(assets.cel_slots(&after).unwrap(), slots.as_slice(), "every tile is in the slot it was in");
    assert!(assets.cel_dirty(after.key()).expect("it inherits").iter().flatten().all(|dirty| !dirty), "none of them is written again");
    while engine.step() {}
    assert!(engine.take_images(usize::MAX).is_empty(), "so nothing is decoded for the atlas");
    assert_eq!(engine.images_backlog(), (0, 0));
}

#[test]
fn a_cel_published_while_the_one_before_is_not_in_the_atlas_is_written_whole() {
    let (engine, opened) = opened();
    while engine.step() {}
    // The pictures of the first publication are decoded and not taken: the atlas holds nothing yet.
    engine.publish_tree(opened.lineage(), republished(&opened.tree), 2).unwrap().expect("the document is the engine's");
    let after = cel(&engine);
    let assets = engine.generation().unwrap().assets.clone();
    assert!(assets.cel_dirty(after.key()).is_none(), "nothing may be assumed to be in the slots of the cel before");
    while engine.step() {}
    let images = engine.take_images(usize::MAX);
    let tiles: usize = assets.cel_slots(&after).unwrap().iter().map(Vec::len).sum();
    assert_eq!(images.iter().filter(|image| image.drawing).count(), tiles, "every tile of the cel is written");
}

/// An export that keeps the pictures of an earlier generation at their atlas places is given the whole of a cel that replaced one: the
/// places are the old cel's until it writes them, whatever the document's own atlas leaves unwritten.
#[test]
fn an_export_that_keeps_an_earlier_generations_pictures_is_given_the_cel_that_replaced_a_cel_whole() {
    let (engine, opened) = opened();
    while engine.step() {}
    engine.take_images(usize::MAX);
    let earlier = engine.generation().unwrap();
    engine.publish_tree(opened.lineage(), republished(&opened.tree), 2).unwrap().expect("the document is the engine's");
    let assets = engine.generation().unwrap().assets.clone();
    let after = cel(&engine);
    assert!(assets.cel_dirty(after.key()).is_some_and(|dirty| dirty.iter().flatten().all(|dirty| !dirty)), "the atlas of the document writes none of it");
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images_since(Some(&earlier));
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let tiles: usize = assets.cel_slots(&after).unwrap().iter().map(Vec::len).sum();
    assert_eq!(images.iter().filter(|image| image.drawing).count(), tiles, "every tile of the new cel is decoded for the export");
}
