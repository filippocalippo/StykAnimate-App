//! A document with more sprite pages than the stage's texture keeps ([`styk_engine::on_demand`]): its
//! pictures are not decoded with the document, and are decoded again for the pages a frame needs.

use std::sync::OnceLock;
use std::time::Instant;

use base64::Engine as _;
use styk_engine::{images_on, on_demand, Budgets, Engine, ATLAS_PAGES};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// A solid `side`² picture in `shade`, as a PNG data URL.
fn picture(side: u32, shade: u8) -> String {
    let mut png = Vec::new();
    let pixels = image::RgbaImage::from_pixel(side, side, image::Rgba([shade, 255 - shade, 90, 255]));
    image::DynamicImage::ImageRgba8(pixels).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

/// The channels fixture with `count` more pictures of 3,000² pixels: each takes a 4,096² page of its own.
fn document(count: u32) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/channels/channels-figure.json");
    let text = std::fs::read_to_string(path).unwrap();
    let assets: Vec<String> = (0..count)
        .map(|i| {
            format!(
                "{{\"kind\":\"image\",\"asset_index\":{i},\"table_index\":{i},\"mime_type\":\"image/png\",\"width\":3000,\"height\":3000,\"data_url\":\"{}\",\"anchor_start\":{{\"x\":0,\"y\":0}},\"anchor_end\":{{\"x\":256,\"y\":0}},\"anchor_length\":256,\"anchor_angle_rad\":0,\"display_width\":300,\"display_height\":300}}",
                picture(3000, (i * 30) as u8)
            )
        })
        .collect();
    text.replacen("\"image_assets\":[", &format!("\"image_assets\":[{}", assets.join(",")), 1).into_bytes()
}

fn open(count: u32) -> Engine {
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&document(count), "json", "test").unwrap();
    engine
}

#[test]
fn a_document_of_more_pages_than_the_texture_keeps_decodes_pictures_when_asked() {
    let engine = open(ATLAS_PAGES + 1);
    let generation = engine.generation().unwrap();
    assert_eq!(generation.assets.pages, ATLAS_PAGES + 1);
    assert!(on_demand(&generation.assets, engine.atlas_pages()));
    while engine.step() {}
    assert_eq!(engine.images_backlog(), (0, 0), "no picture is decoded with the document");
    assert!(engine.take_images(usize::MAX).is_empty());

    // A page's pictures are decoded when it is asked for, as many times as it is.
    let page = generation.assets.atlas[3].layer;
    let on_page = images_on(&generation.assets, page);
    assert_eq!(on_page, vec![3]);
    for _ in 0..2 {
        engine.decode_images(&generation, &on_page, true);
        assert_eq!(engine.images_backlog().0, 1);
        while engine.step() {}
        let taken = engine.take_images(usize::MAX);
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].index, 3);
        assert_eq!(taken[0].rgba.len(), 3002 * 3002 * 4);
        assert_eq!(engine.images_backlog(), (0, 0));
    }
}

#[test]
fn a_document_that_fits_the_texture_is_decoded_with_it() {
    let engine = open(2);
    let generation = engine.generation().unwrap();
    assert!(!on_demand(&generation.assets, engine.atlas_pages()));
    while engine.step() {}
    let (decoding, decoded) = engine.images_backlog();
    assert_eq!(decoding, 0);
    assert!(decoded >= 2, "the pictures wait for the renderer ({decoded})");
}

#[test]
fn the_picture_table_names_what_each_tick_draws_and_is_made_when_nothing_else_waits() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/sticknodes-sprites.json");
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&std::fs::read(path).unwrap(), "json", "sprites").unwrap();
    let generation = engine.generation().unwrap();
    let ticks = generation.playable_ticks();
    assert!(ticks > 1);
    assert!(engine.picture_row(generation.id, 0).is_none(), "nothing is made before it is asked for");
    engine.request_picture_table(&generation);
    while engine.step() {}
    assert_eq!(engine.picture_table_progress(generation.id), (ticks, ticks));
    let index = styk_engine::PlaceIndex::new(&generation.assets);
    let mut drawn = 0;
    for tick in 0..ticks {
        let row = engine.picture_row(generation.id, tick).expect("every row is made");
        let frame = engine.frame_now(tick).unwrap();
        assert_eq!(row.as_ref(), styk_engine::pictures_of(&frame.list, &index).as_slice(), "tick {tick}");
        drawn += row.len();
    }
    assert!(drawn > 0, "the document draws pictures");
    // The next revision of a document has no rows until its table is asked for.
    assert!(engine.picture_row(generation.id + 1, 0).is_none());
}
