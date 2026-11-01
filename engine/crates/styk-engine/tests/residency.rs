//! A document with more sprite pages than the stage's texture keeps ([`styk_engine::on_demand`]): only the soft copies
//! of its pictures are made with the document, and a picture is decoded when a frame needs it.

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

/// The channels fixture with the pictures `urls` (PNG data URLs of `side`² pixels) added.
fn document_of(urls: &[String], side: u32) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/channels/channels-figure.json");
    let text = std::fs::read_to_string(path).unwrap();
    let assets: Vec<String> = urls
        .iter()
        .enumerate()
        .map(|(i, url)| {
            format!(
                "{{\"kind\":\"image\",\"asset_index\":{i},\"table_index\":{i},\"mime_type\":\"image/png\",\"width\":{side},\"height\":{side},\"data_url\":\"{url}\",\"anchor_start\":{{\"x\":0,\"y\":0}},\"anchor_end\":{{\"x\":256,\"y\":0}},\"anchor_length\":256,\"anchor_angle_rad\":0,\"display_width\":300,\"display_height\":300}}"
            )
        })
        .collect();
    text.replacen("\"image_assets\":[", &format!("\"image_assets\":[{}", assets.join(",")), 1).into_bytes()
}

/// The channels fixture with `count` more pictures of 3,000² pixels: each takes a 4,096² page of its own.
fn document(count: u32) -> Vec<u8> {
    document_of(&(0..count).map(|i| picture(3000, (i * 30) as u8)).collect::<Vec<_>>(), 3000)
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
    // What is decoded with the document is the soft copy of each picture, and nothing of the pictures themselves.
    let images = generation.prepared.doc.images.len();
    while engine.step() {}
    assert_eq!(engine.images_backlog(), (0, images));
    let softs = engine.take_images(usize::MAX);
    assert_eq!(softs.len(), images);
    assert!(softs.iter().all(|image| image.soft && !image.drawing), "only soft copies");
    assert!(softs.iter().all(|image| image.rgba.len() <= 4 << 20), "an eighth of a 4K picture on a side: 1 MiB");
    assert_eq!(engine.images_backlog(), (0, 0));

    // A picture is decoded when it is asked for, as many times as it is.
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
        assert!(!taken[0].soft);
        assert_eq!(taken[0].rgba.len(), 3002 * 3002 * 4);
        assert_eq!(engine.images_backlog(), (0, 0));
    }
}

#[test]
fn a_decode_asked_for_behind_the_queue_is_decoded_first_once_a_frame_waits_for_it() {
    let engine = open(ATLAS_PAGES + 1);
    let generation = engine.generation().unwrap();
    while engine.step() {}
    drop(engine.take_images(usize::MAX));
    // Pictures 0, 1 and 2 are asked for behind the queue, as the ticks ahead are; a frame then waits for picture 2.
    for picture in 0..3 {
        engine.decode_images(&generation, &[picture], false);
    }
    engine.promote_images(&generation, &[2]);
    assert!(engine.step());
    let first = engine.take_images(usize::MAX);
    assert_eq!(first.iter().map(|image| image.index).collect::<Vec<_>>(), vec![2], "the picture a frame waits for is decoded first");
    while engine.step() {}
    let mut rest: Vec<u32> = engine.take_images(usize::MAX).iter().map(|image| image.index).collect();
    rest.sort_unstable();
    assert_eq!(rest, vec![0, 1], "the others are still decoded, once each");
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

/// A picture of 150 by 100 pixels with every kind of pixel: opaque, translucent, transparent.
fn pattern() -> image::RgbaImage {
    image::RgbaImage::from_fn(150, 100, |x, y| image::Rgba([(x * 255 / 149) as u8, (y * 255 / 99) as u8, ((x * 7 + y * 13) % 256) as u8, if (x / 10 + y / 10) % 3 == 0 { 0 } else { 255 - (x % 5) as u8 * 40 }]))
}

#[test]
fn the_soft_copy_is_the_average_of_the_pixels_each_texel_of_the_page_covers() {
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(pattern()).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&document_of(&[url], 150), "json", "soft").unwrap();
    let generation = engine.generation().unwrap();
    let (doc, assets) = (&generation.prepared.doc, &generation.assets);
    let index = (0..doc.images.len()).find(|&i| assets.atlas[i].valid && assets.atlas[i].w == 150 && assets.atlas[i].h == 100).expect("the picture is in the layout");
    let entry = assets.atlas[index];
    let soft = styk_eval::assets::soften_image(doc, assets, index).expect("a soft copy");
    let (x0, y0, w, h) = styk_eval::assets::soft_rect(&entry);
    assert_eq!((soft.width, soft.height, soft.soft, soft.index), (w, h, true, index as u32));
    let scale = styk_eval::assets::SOFT_SCALE;
    for sy in 0..h {
        for sx in 0..w {
            // The pictures' pixels in the 8 by 8 block of the page this texel is, premultiplied and averaged.
            let (mut sum, mut n) = ([0u32; 4], 0u32);
            for py in ((y0 + sy) * scale).max(entry.y)..((y0 + sy + 1) * scale).min(entry.y + entry.h) {
                for px in ((x0 + sx) * scale).max(entry.x)..((x0 + sx + 1) * scale).min(entry.x + entry.w) {
                    let p = pattern().get_pixel(px - entry.x, py - entry.y).0;
                    let a = p[3] as u32;
                    for k in 0..3 {
                        sum[k] += (p[k] as u32 * a + 127) / 255;
                    }
                    sum[3] += a;
                    n += 1;
                }
            }
            let at = ((sy * w + sx) * 4) as usize;
            for k in 0..4 {
                assert_eq!(soft.rgba[at + k] as u32, (sum[k] + n / 2) / n, "texel ({sx}, {sy}) channel {k}");
            }
        }
    }
}
