//! The native source drains its byte-limited decode queue completely, even when
//! a single cel is larger than the queue. The CPU owner must retain its pixels.
use styk_engine::{Budgets, Engine};
use styk_export::{CpuExport, FrameRenderer, Settings, Smoothing, TILE_SIDE};

#[test]
fn a_small_decode_queue_preserves_all_cpu_pixels() {
    let input = include_bytes!("../../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let reference = Engine::new(|| 0., Budgets::for_device(None));
    reference.open(input, "json", "reference").unwrap();
    let frames = reference.export_frames(0).unwrap();
    frames.decode_images();
    while reference.step() {}
    let images = frames.take_images(usize::MAX);
    assert!(images.len() > 1);
    let settings = Settings::new(320, 180, Smoothing::Edges, styk_export::settings::MAX_PIXELS).unwrap();
    let mut whole = CpuExport::new(settings, TILE_SIDE);
    whole.use_assets(frames.generation().assets.clone());
    whole.upload_images(&frames.generation().assets, images);
    let frame = frames.take(0).unwrap();
    let expected = whole.frame(&frames.generation().prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();

    let engine = Engine::for_export(|| 0., Budgets { picture_bytes: 1, ..Budgets::for_device(None) });
    engine.open(input, "json", "streamed").unwrap();
    let frames = engine.export_frames(0).unwrap();
    let mut source = FrameRenderer::Cpu(CpuExport::new(settings, TILE_SIDE));
    source.load_images(&engine, &frames).unwrap();
    assert_eq!(frames.images_pending(), 0);
    assert_eq!(engine.images_pending(), 0);
    let frame = frames.take(0).unwrap();
    let mut actual = Vec::new();
    source.frame_into(&frames.generation().prepared.doc, &frame.list, frame.camera.as_ref(), false, &mut actual).unwrap();
    assert_eq!(actual, expected, "no partial decode may be treated as complete");
}

#[test]
fn one_cel_can_span_several_upload_batches() {
    use base64::Engine as _;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(64, 64, image::Rgba([40, 80, 160, 255])))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    // One 4096x2048 cel. Its display levels produce more than one 32 MiB
    // upload batch in a single engine step; no artificial queue limit is used.
    let mut tiles = b"TYTS".to_vec();
    for n in [1u32, 64, 2048] { tiles.extend(n.to_le_bytes()); }
    for y in 0..32i32 {
        for x in 0..64i32 {
            tiles.extend(x.to_le_bytes());
            tiles.extend(y.to_le_bytes());
            tiles.extend((png.len() as u32).to_le_bytes());
            tiles.extend_from_slice(&png);
        }
    }
    let text = include_str!("../../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let start = text.find("data:application/x-styk-tiles;base64,").unwrap();
    let end = start + text[start..].find('"').unwrap();
    let input = format!("{}data:application/x-styk-tiles;base64,{}{}", &text[..start], base64::engine::general_purpose::STANDARD.encode(tiles), &text[end..]);
    let engine = Engine::for_export(|| 0., Budgets { picture_bytes: 32 << 20, ..Budgets::for_device(None) });
    engine.open(input.as_bytes(), "json", "large cel").unwrap();
    let frames = engine.export_frames(0).unwrap();
    frames.decode_images();
    while engine.step() {}
    let images = frames.take_images(usize::MAX);
    let bytes: usize = images.iter().map(|i| i.rgba.len()).sum();
    assert!(bytes > styk_export::resident::UPLOAD_BYTES, "the real cel must cross the batch boundary: {bytes}");
    drop(images);
    let settings = Settings::new(64, 64, Smoothing::Edges, styk_export::settings::MAX_PIXELS).unwrap();
    let mut source = FrameRenderer::Cpu(CpuExport::new(settings, TILE_SIDE));
    source.load_images(&engine, &frames).unwrap();
    assert_eq!(frames.images_pending(), 0, "drain ready batches even after the final decoder has stopped");
    assert!(frames.take(0).is_some());
}
