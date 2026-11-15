//! The decoded pixels the rasterizer holds are bounded: the least recently used are dropped beyond the budget,
//! and a frame decodes again the pictures it samples and does not hold, so it is drawn as it would be with
//! every picture held. The live drawing cels' slots, which nothing could decode again, are never dropped for it.

use std::path::Path;
use std::sync::Arc;

use styk_eval::assets::{self, Assets, DecodedImage, Picture};
use styk_eval::{drawlist, geometry};
use styk_raster::{Edges, Images, Raster, ViewParams};

const SIZE: [u32; 2] = [278, 139];

struct Scene {
    prepared: styk_eval::eval::Prepared,
    assets: Assets,
    list: styk_draw::DrawList,
    view: ViewParams,
}

/// A document of one drawing cel (hundreds of tiles of several display levels) seen at the size of a thumbnail.
fn scene() -> Scene {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let prepared = styk_eval::prepare(styk_eval::open(&file).unwrap());
    let assets = Assets::build(&prepared.doc);
    let frame = prepared.evaluate(0.0);
    let scene = geometry::build(&prepared.doc, &frame);
    let list = drawlist::encode(&prepared.doc, &assets, &scene);
    let zoom = SIZE[1] as f64 / prepared.doc.canvas[1] as f64;
    let pan = [(SIZE[0] as f64 - prepared.doc.canvas[0] as f64 * zoom) / 2.0, 0.0];
    let view = ViewParams {
        matrix: styk_eval::view::camera_matrix(&prepared.doc, frame.camera.as_ref(), zoom, pan),
        artboard: [pan[0], 0.0, pan[0] + prepared.doc.canvas[0] as f64 * zoom, SIZE[1] as f64],
        clip_to_artboard: true,
        clear: [0.0; 4],
        zoom,
        pan,
        stretch: 1.0,
        camera_view: true,
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    Scene { prepared, assets, list, view }
}

fn decoded(scene: &Scene) -> Vec<assets::DecodedImage> {
    let mut images = Vec::new();
    for key in scene.assets.cels.keys() {
        images.extend(assets::decode_picture(&scene.prepared.doc, &scene.assets, Picture::Cel(*key)).unwrap());
    }
    images
}

fn draw(scene: &Scene, images: &Images) -> Vec<u8> {
    Raster::new(Edges::Smooth).render(&scene.list, images, &scene.view, SIZE).straight()
}

#[test]
fn pictures_beyond_the_budget_are_dropped_least_recently_used_first() {
    let scene = scene();
    let all = decoded(&scene);
    assert!(all.len() > 8, "a cel is many tiles");
    let tile = all[0].rgba.len();
    let mut images = Images::with_budget(4 * tile);
    for image in &all {
        images.add(&scene.assets, image);
    }
    assert!(images.bytes() <= 4 * tile, "{} bytes held of {}", images.bytes(), 4 * tile);
    assert!(images.len() >= 3 && images.len() < all.len(), "{} of {} pictures held", images.len(), all.len());
    // The newest are the ones kept.
    let newest = all.last().unwrap();
    assert!(images.decoded().any(|held| held.index == newest.index && held.drawing == newest.drawing));
    let oldest = &all[0];
    assert!(!images.decoded().any(|held| held.index == oldest.index && held.drawing == oldest.drawing));
}

#[test]
fn a_frame_decodes_again_what_it_samples_and_is_drawn_as_with_every_picture_held() {
    let scene = scene();
    let all = decoded(&scene);
    let mut full = Images::with_budget(usize::MAX);
    for image in &all {
        full.add(&scene.assets, image);
    }
    let expected = draw(&scene, &full);
    assert!(expected.as_chunks::<4>().0.iter().any(|pixel| pixel[3] > 0), "the cel is drawn");

    // Nothing held, a budget of a few tiles: the frame needs more than the budget, and gets all it samples.
    let mut images = Images::with_budget(4 * all[0].rgba.len());
    assert_ne!(draw(&scene, &images), expected, "without its pictures the frame is blank");
    images.ensure(&scene.list, &scene.prepared.doc, &scene.assets).unwrap();
    let needed = Images::places(&scene.list);
    assert!(needed.iter().all(|place| images.get(*place).is_some()), "every picture the frame samples is held");
    assert_eq!(draw(&scene, &images), expected);
    assert!(images.bytes() > 4 * all[0].rgba.len(), "what a frame samples is kept whatever the budget");

    // Another frame that samples nothing drops them again; the next frame decodes them once more.
    let blank = styk_draw::DrawList::default();
    images.ensure(&blank, &scene.prepared.doc, &scene.assets).unwrap();
    assert!(images.bytes() <= 4 * all[0].rgba.len(), "{} bytes held", images.bytes());
    images.ensure(&scene.list, &scene.prepared.doc, &scene.assets).unwrap();
    assert_eq!(draw(&scene, &images), expected);
}

#[test]
fn a_live_drawing_slot_is_never_dropped_for_the_budget() {
    // A slot of a cel the editor holds live, as the stage hands it over (`put_tile`): nothing in the document decodes it again.
    let scene = scene();
    let all = decoded(&scene);
    let tile = all[0].rgba.len();
    let side = styk_eval::live::CELL;
    let live = Arc::new(DecodedImage { index: 0, drawing: true, soft: false, width: side, height: side, rgba: vec![255; (side * side * 4) as usize], placement: 0 });
    let border = styk_eval::drawing::BORDER;
    let layer = scene.assets.pages;
    let held = |images: &Images| images.decoded().any(|image| std::ptr::eq(image, Arc::as_ptr(&live)));
    let mut images = Images::with_budget(4 * tile);
    images.put_tile((layer, border, border), live.clone());
    // Pictures of the document beyond the budget come after it: they give way to each other, not to it.
    for image in &all {
        images.add(&scene.assets, image);
    }
    assert!(held(&images), "the live slot was dropped for the document's pictures");
    assert!(images.bytes() <= 4 * tile + live.rgba.len(), "{} bytes held: the other pictures stay within the budget", images.bytes());
    // Frames that sample the document's pictures, or nothing, keep it too.
    images.ensure(&scene.list, &scene.prepared.doc, &scene.assets).unwrap();
    images.ensure(&styk_draw::DrawList::default(), &scene.prepared.doc, &scene.assets).unwrap();
    assert!(held(&images), "a frame's budget dropped the live slot");
    // Another document's pictures are let go of, the live slots are not (they are the stage's, written once).
    images.forget_pictures();
    assert!(held(&images) && images.len() == 1, "{} pictures held", images.len());
    // The live pages moved: the slot is let go of.
    images.drop_tiles_from(layer);
    assert!(!held(&images));
    assert_eq!(images.bytes(), 0);
}

#[test]
fn a_picture_the_memory_cannot_hold_is_an_error_not_a_blank_frame() {
    let scene = scene();
    let mut images = Images::with_budget(usize::MAX);
    let refused = styk_alloc::with_limit(1 << 20, || images.ensure(&scene.list, &scene.prepared.doc, &scene.assets));
    assert!(refused.is_err(), "the cel needs more than 1 MiB to decode");
    assert!(images.is_empty());
    images.ensure(&scene.list, &scene.prepared.doc, &scene.assets).unwrap();
    assert!(!images.is_empty());
}
