//! A cel published again is written where it differs from the one in the atlas: when the atlas holds what the engine was asked for, it keeps the
//! slots of the tiles they share and writes none of them again; while pictures are on their way it is written whole.

use std::path::Path;
use std::sync::Arc;

use styk_doc::{json, Value};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine, Uploaded};

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
    let frames = engine.export_frames(2).unwrap();
    frames.decode_images_since(Some(&earlier));
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let tiles: usize = assets.cel_slots(&after).unwrap().iter().map(Vec::len).sum();
    assert_eq!(images.iter().filter(|image| image.drawing).count(), tiles, "every tile of the new cel is decoded for the export");
}

/// A cel whose decode is refused (the memory cannot hold its work) is written over with nothing: the places it was given are the cel before's
/// until written, and a frame that drew them would show the old pixels among the new.
#[test]
fn a_refused_decode_of_a_cel_that_replaced_another_leaves_none_of_its_places_waiting_for_pixels() {
    let (engine, opened) = opened();
    while engine.step() {}
    let mut uploaded = Uploaded::default();
    uploaded.observe(&engine.generation().unwrap().assets);
    for image in engine.take_images(usize::MAX) {
        uploaded.record(&engine.generation().unwrap().assets, &image);
    }
    assert_eq!(uploaded.refilling(), 0);
    // The first publication's pictures are decoded and taken, so the atlas holds nothing the next may share: it is written whole.
    engine.publish_tree(opened.lineage(), republished(&opened.tree), 2).unwrap().expect("the document is the engine's");
    let assets = engine.generation().unwrap().assets.clone();
    let after = cel(&engine);
    assert!(assets.cel_dirty(after.key()).is_some_and(|dirty| dirty.iter().flatten().all(|dirty| !dirty)), "the atlas holds the tiles");
    // A change the atlas cannot share: the pictures of the second publication are still waiting when the third arrives.
    engine.publish_tree(opened.lineage(), republished(&opened.tree), 3).unwrap().expect("the document is the engine's");
    let assets = engine.generation().unwrap().assets.clone();
    let after = cel(&engine);
    assert!(assets.cel_dirty(after.key()).is_none(), "the cel is written whole");
    uploaded.observe(&assets);
    let tiles: usize = assets.cel_slots(&after).unwrap().iter().map(Vec::len).sum();
    assert_eq!(uploaded.refilling(), tiles, "every place of the cel waits for its pixels");
    styk_alloc::with_limit(1 << 20, || while engine.step() {});
    assert!(engine.pictures_refused() > 0, "the decode was refused");
    let images = engine.take_images(usize::MAX);
    assert_eq!(images.iter().filter(|image| image.drawing).count(), tiles, "every place of the cel is written");
    assert!(images.iter().all(|image| image.rgba.iter().all(|byte| *byte == 0)), "with nothing");
    for image in &images {
        uploaded.record(&assets, image);
    }
    assert_eq!(uploaded.refilling(), 0, "so none waits, and a frame may draw the cel");
}

/// The same document with ten tiles more in the cel (the first tile again, far from the others), as a payload of its own.
fn enlarged(tree: &Value) -> Value {
    use base64::Engine as _;
    let mut next = tree.clone();
    let asset = &mut next.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("image_assets").unwrap().make_arr().unwrap()[0];
    let blob = asset.get("styk_tiles").and_then(Value::payload_bytes).expect("the cel's tiles");
    let tiles = styk_eval::drawing::parse_tiles(&blob).expect("a tile blob");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0x5459_5453u32.to_be_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&64u32.to_le_bytes());
    bytes.extend_from_slice(&((tiles.len() + 10) as u32).to_le_bytes());
    let png = tiles[0].2.clone();
    for (x, y, png) in tiles.iter().map(|(x, y, png)| (*x, *y, png.clone())).chain((0..10).map(|k| (400 + 3 * k, 400, png.clone()))) {
        bytes.extend_from_slice(&(x as u32).to_le_bytes());
        bytes.extend_from_slice(&(y as u32).to_le_bytes());
        bytes.extend_from_slice(&(png.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&png);
    }
    let text = format!("data:application/x-styk-tiles;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    asset.make_obj().unwrap().set("styk_tiles", Value::str(&text));
    next
}

/// A cel that replaces a smaller one is given slots of its own for the tiles that are new. When the memory refuses its decode they are written
/// over with nothing too, with the slots it took over: none of its places is left waiting for pixels that will not come.
#[test]
fn a_refused_decode_of_a_larger_cel_leaves_none_of_its_places_waiting_for_pixels() {
    let (engine, opened) = opened();
    while engine.step() {}
    let mut uploaded = Uploaded::default();
    uploaded.observe(&engine.generation().unwrap().assets);
    for image in engine.take_images(usize::MAX) {
        uploaded.record(&engine.generation().unwrap().assets, &image);
    }
    let before_slots = engine.generation().unwrap().assets.drawing.len();
    engine.publish_tree(opened.lineage(), enlarged(&opened.tree), 2).unwrap().expect("the document is the engine's");
    let assets = engine.generation().unwrap().assets.clone();
    let after = cel(&engine);
    assert!(assets.drawing.len() > before_slots, "the new tiles took slots of their own");
    assert!(assets.cel_dirty(after.key()).is_some_and(|dirty| dirty.iter().flatten().any(|dirty| *dirty)), "some tiles are written");
    uploaded.observe(&assets);
    let waiting = uploaded.refilling();
    assert!(waiting > 0);
    styk_alloc::with_limit(1 << 20, || while engine.step() {});
    assert!(engine.pictures_refused() > 0, "the decode was refused");
    let images = engine.take_images(usize::MAX);
    assert_eq!(images.len(), waiting, "every place that waits is written over");
    for image in &images {
        uploaded.record(&assets, image);
    }
    assert_eq!(uploaded.refilling(), 0, "so none waits, and the guard of the frame lets go");
    assert_eq!(engine.images_backlog(), (0, 0));
}

/// An export that keeps an earlier generation's pictures is given nothing for a cel the memory refused, and the places the cel took over hold the
/// earlier cel's pixels: they are written over with nothing, as the stage's are.
#[test]
fn an_export_writes_over_the_places_of_a_cel_the_memory_refused() {
    let (engine, opened) = opened();
    while engine.step() {}
    engine.take_images(usize::MAX);
    let earlier = engine.generation().unwrap();
    engine.publish_tree(opened.lineage(), republished(&opened.tree), 2).unwrap().expect("the document is the engine's");
    let assets = engine.generation().unwrap().assets.clone();
    let after = cel(&engine);
    let frames = engine.export_frames(2).unwrap();
    styk_alloc::with_limit(1 << 20, || {
        frames.decode_images_since(Some(&earlier));
        while engine.step() {}
    });
    assert!(engine.pictures_refused() > 0, "the decode was refused");
    let tiles: usize = assets.cel_slots(&after).unwrap().iter().map(Vec::len).sum();
    assert_eq!(frames.images_pending(), tiles, "every place of the cel is to be written over");
    let images = frames.take_images(usize::MAX);
    assert_eq!(images.iter().filter(|image| image.drawing).count(), tiles, "and is");
    assert!(images.iter().all(|image| image.rgba.iter().all(|byte| *byte == 0)), "with nothing");
    assert_eq!(frames.images_pending(), 0);
}
