//! A cel the document replaced gives its atlas slots to the next: what the CPU holds of a place and what the device holds of it
//! are the old cel's until they are written again, and a frame must not be drawn from them.

use std::sync::Arc;

use styk_draw::{DrawList, Prim, F_DRAWING, K_IMAGE, NO_PAINT};
use styk_eval::assets::Assets;
use styk_eval::doc::DrawingTiles;
use styk_eval::drawing::{level_tiles, TILE};
use styk_raster::{Images, Uploads};

/// A cel of one tile painted `color` all over, as a PNG.
fn cel(color: [u8; 4]) -> Arc<DrawingTiles> {
    let image = image::RgbaImage::from_pixel(TILE, TILE, image::Rgba(color));
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let tiles = vec![(0, 0, Arc::<[u8]>::from(png))];
    let levels = level_tiles(&tiles);
    Arc::new(DrawingTiles::new([0.0; 2], 1.0, None, tiles, levels))
}

/// The document of the drawing fixture with `tiles` as its cel.
fn document_of(tiles: &Arc<DrawingTiles>) -> styk_eval::doc::Document {
    let mut doc = styk_eval::open(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json")).expect("fixture");
    let figure = Arc::make_mut(&mut doc.figures[0]);
    for image in figure.images.iter_mut() {
        if image.tiles.is_some() {
            image.tiles = Some(tiles.clone());
        }
    }
    doc
}

/// A list that samples the tile (0, 0) of the cel's first level.
fn sampling(assets: &Assets, tiles: &Arc<DrawingTiles>) -> DrawList {
    let at = tiles.levels[0].binary_search_by_key(&(0, 0), |&(x, y)| (y, x)).unwrap();
    let entry = assets.drawing[assets.cel_slots(tiles).unwrap()[0][at] as usize];
    DrawList { prims: vec![Prim { kind: K_IMAGE | F_DRAWING, group: 0, color: 0, paint: NO_PAINT, a: [0.0; 4], b: [0.0, 0.0, entry.layer as f32, 0.0], c: entry.uv() }], ..Default::default() }
}

/// The texel at the middle of the tile held for the list's place.
fn middle(images: &Images, list: &DrawList) -> [u8; 4] {
    let place = Images::places(list).into_iter().next().unwrap();
    let image = images.get(place).expect("the tile is held");
    let side = image.width as usize;
    let at = ((side / 2) * side + side / 2) * 4;
    image.rgba[at..at + 4].try_into().unwrap()
}

#[test]
fn the_cpu_and_the_device_write_the_tile_of_the_cel_that_has_the_slot_not_the_one_that_had_it() {
    let (red, green) = (cel([200, 0, 0, 255]), cel([0, 200, 0, 255]));
    let (first, second) = (document_of(&red), document_of(&green));
    let a = Assets::build(&first);
    let b = a.extended(&second);
    let (list_a, list_b) = (sampling(&a, &red), sampling(&b, &green));
    assert_eq!(Images::places(&list_a), Images::places(&list_b), "the next cel is in the slot of the one before");

    let mut images = Images::default();
    let mut uploaded = Uploads::default();
    images.ensure(&list_a, &first, &a).unwrap();
    assert_eq!(middle(&images, &list_a), [200, 0, 0, 255]);
    let lacking = uploaded.lacking(Images::places(&list_a), &images);
    assert_eq!(lacking.len(), 1, "the device lacks the tile");
    uploaded.record(lacking);
    assert!(uploaded.lacking(Images::places(&list_a), &images).is_empty(), "and holds it once it is written");

    // The document replaced the cel: the place is the green cel's.
    images.ensure(&list_b, &second, &b).unwrap();
    assert_eq!(middle(&images, &list_b), [0, 200, 0, 255], "the CPU decodes the cel that has the slot, not what it held for the one before");
    let lacking = uploaded.lacking(Images::places(&list_b), &images);
    assert_eq!(lacking.len(), 1, "the device holds the red tile there: it lacks the green one");
    uploaded.record(lacking);
    assert!(uploaded.lacking(Images::places(&list_b), &images).is_empty());
}
