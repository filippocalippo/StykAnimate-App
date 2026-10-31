//! Drawing cel tiles meet without seams: two opaque tiles side by side, their shared
//! edge in the middle of a pixel column, cover that column fully (thumbnails draw cels
//! at scales where tile edges rarely fall on pixel boundaries).

use styk_draw::{DrawList, Prim, F_DRAWING, K_IMAGE, NO_PAINT};
use styk_eval::assets::{Assets, AtlasEntry, DecodedImage, PAGE};

/// A 64-texel tile at atlas place (x, 2), and its decoded pixels (with their border): opaque red.
fn tile(index: u32, x: u32) -> (AtlasEntry, DecodedImage) {
    let entry = AtlasEntry { layer: 0, x, y: 2, w: 64, h: 64, source_w: 64, source_h: 64, valid: true };
    let rgba = [255u8, 0, 0, 255].repeat(68 * 68);
    (entry, DecodedImage { index, drawing: true, width: 68, height: 68, rgba })
}

#[test]
fn adjacent_tiles_leave_no_seam() {
    let (a, image_a) = tile(0, 2);
    let (b, image_b) = tile(1, 70);
    let mut assets = Assets::default();
    assets.drawing = vec![a, b];
    assets.pages = 1;
    let mut images = styk_raster::Images::default();
    images.add(&assets, &image_a);
    images.add(&assets, &image_b);
    // Each tile covers 64 world units, one unit a cel pixel, at level 0.
    let prim = |x: f32, entry: &AtlasEntry| Prim {
        kind: K_IMAGE | F_DRAWING,
        group: 0,
        color: 0xffff_ffff,
        paint: NO_PAINT,
        a: [x, 0.0, 64.0, 0.0],
        b: [0.0, 64.0, 0.0, 0.0],
        c: [entry.x as f32 / PAGE as f32, entry.y as f32 / PAGE as f32, (entry.x + 64) as f32 / PAGE as f32, (entry.y + 64) as f32 / PAGE as f32],
    };
    let list = DrawList { prims: vec![prim(0.0, &a), prim(64.0, &b)], ..Default::default() };
    // 0.7 pixels a unit, shifted: the shared edge lands at x = 48.5, halfway through a pixel.
    let view = styk_raster::ViewParams { matrix: [0.7, 0.0, 0.0, 0.7, 3.7, 2.1], artboard: [0.0, 0.0, 100.0, 60.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 0.7, pan: [3.7, 2.1], stretch: 1.0, camera_view: false, camera_limit: 2048.0 };
    let pixels = styk_raster::render(&list, &images, &view, [100, 60], styk_raster::Edges::Smooth).straight();
    for x in 6..90 {
        let i = (20 * 100 + x) * 4;
        assert_eq!([pixels[i], pixels[i + 3]], [255, 255], "column {x} is covered");
    }
}
