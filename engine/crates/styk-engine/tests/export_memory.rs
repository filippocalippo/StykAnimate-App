use styk_engine::{Budgets, Engine};

#[test]
fn a_headless_export_has_one_picture_consumer() {
    let bytes = include_bytes!("../../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let engine = Engine::for_export(|| 0., Budgets::for_device(None));
    engine.open(bytes, "json", "drawing").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    assert!(!images.is_empty(), "the export received its decoded cel");
    assert_eq!(engine.images_pending(), 0, "no stage exists to consume a second copy");
    assert_eq!(engine.try_images_ready_bytes(), Some(0));
    assert!(engine.take_images(usize::MAX).is_empty());
    let before = frames.take(0).unwrap().list.bytes();
    drop(images);
    assert_eq!(frames.take(0).unwrap().list.bytes(), before, "cel bounds survive dropping uploaded pixels");
    engine.stop();
}
