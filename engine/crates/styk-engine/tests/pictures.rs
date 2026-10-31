//! Whether a frame drawn by a renderer that uploads decoded pictures a slice at a time
//! (the stage) lacks some of them: it is drawn again once they arrive.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_engine::{Budgets, Engine, Uploaded};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn open(path: &str) -> Engine {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path);
    let engine = Engine::new(clock, Budgets::for_device(None));
    let extension = file.extension().unwrap().to_str().unwrap().to_string();
    engine.open(&std::fs::read(&file).unwrap(), &extension, "test").unwrap();
    engine
}

#[test]
fn a_frame_lacks_its_drawing_cel_until_every_tile_is_uploaded() {
    let engine = open("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let generation = engine.generation().unwrap();
    let list = engine.frame_now(0).unwrap().list.clone();
    let mut uploaded = Uploaded::default();
    let (decoding, decoded) = engine.images_backlog();
    assert!(decoding > 0 && decoded == 0, "the cel is queued for decoding");
    assert!(uploaded.lacks(&list), "nothing is uploaded yet");
    while engine.step() {}
    let (decoding, decoded) = engine.images_backlog();
    assert_eq!(decoding, 0);
    assert!(decoded > 1, "a cel is many tiles");
    // One tile at a time, as a frame's upload budget allows: the frame lacks the cel until the last.
    let mut taken = 0;
    loop {
        let slice = engine.take_images(1);
        if slice.is_empty() {
            break;
        }
        assert!(uploaded.lacks(&list), "{taken} of {decoded} tiles uploaded");
        for image in &slice {
            uploaded.record(&generation.assets, image);
        }
        taken += slice.len();
    }
    assert_eq!(taken, decoded);
    assert_eq!(engine.images_backlog(), (0, 0));
    assert!(!uploaded.lacks(&list), "every tile of every level is there");
    // A new atlas holds nothing.
    uploaded.clear();
    assert!(uploaded.lacks(&list));
}

#[test]
fn a_frame_without_pictures_never_lacks_one() {
    // Figures and generated effects drawn as many records, none of them a picture.
    let engine = open("engine/crates/styk-eval/tests/fixtures/generators/explosions.json");
    let list = engine.frame_now(6).unwrap().list.clone();
    assert!(list.prims.len() > 100, "the frame is drawn ({} records)", list.prims.len());
    assert!(!Uploaded::default().lacks(&list));
}
