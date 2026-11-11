//! Edges as the GPU renderer covers them (styk-render's `prim.wgsl` and its four samples a
//! pixel): strokes by their distance at each pixel's centre, smooth coverage of hundreds
//! of levels, and adjacent triangles of different colours leaving no seam between them.

use styk_draw::{DrawList, Group, Pass, Prim, K_CAPSULE, K_TRI, NO_LAYER, NO_PAINT};
use styk_raster::{Edges, Images, ViewParams};

fn view(width: f64, height: f64) -> ViewParams {
    ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, width, height], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 }
}

fn list(prims: Vec<Prim>) -> DrawList {
    let end = prims.len() as u32;
    DrawList { prims, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end }], ..Default::default() }
}

fn capsule(a: [f32; 2], b: [f32; 2], half_width: f32, color: u32) -> Prim {
    Prim { kind: K_CAPSULE, group: 0, color, paint: NO_PAINT, a: [a[0], a[1], b[0], b[1]], b: [half_width, 0.0, 0.0, 0.0], c: [0.0; 4] }
}

fn tri(p: [[f32; 2]; 3], color: u32) -> Prim {
    Prim { kind: K_TRI, group: 0, color, paint: NO_PAINT, a: [p[0][0], p[0][1], p[1][0], p[1][1]], b: [p[2][0], p[2][1], 0.0, 0.0], c: [0.0; 4] }
}

/// Distance from `p` to the segment `a`–`b`.
fn distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (pa, ba) = ([p[0] - a[0], p[1] - a[1]], [b[0] - a[0], b[1] - a[1]]);
    let h = ((pa[0] * ba[0] + pa[1] * ba[1]) / (ba[0] * ba[0] + ba[1] * ba[1])).clamp(0.0, 1.0);
    (pa[0] - ba[0] * h).hypot(pa[1] - ba[1] * h)
}

#[test]
fn strokes_are_covered_by_distance_at_pixel_centres() {
    // A white stroke four units wide at a slant over transparency, one unit a pixel.
    let (a, b, hw) = ([10.3f32, 12.1f32], [180.7f32, 61.4f32], 2.0f32);
    let frame = styk_raster::render(&list(vec![capsule(a, b, hw, 0xffff_ffff)]), &Images::default(), &view(200.0, 80.0), [200, 80], Edges::Smooth);
    let mut levels = std::collections::BTreeSet::new();
    for y in 0..80 {
        for x in 0..200 {
            let alpha = frame.pixels[(y * 200 + x) * 4 + 3];
            // clamp(0.5 - d / aa, 0, 1) with aa one pixel.
            let d = distance([x as f64 + 0.5, y as f64 + 0.5], [a[0] as f64, a[1] as f64], [b[0] as f64, b[1] as f64]) - hw as f64;
            let expected = ((0.5 - d).clamp(0.0, 1.0) * 255.0).round() as i32;
            assert!((alpha as i32 - expected).abs() <= 1, "pixel ({x}, {y}): alpha {alpha}, distance rule {expected}");
            levels.insert(alpha);
        }
    }
    assert!(levels.len() > 150, "smooth coverage takes many levels along a slanted edge: {}", levels.len());
}

#[test]
fn crisp_edges_cover_fully_or_not_at_all() {
    let frame = styk_raster::render(&list(vec![capsule([10.3, 12.1], [180.7, 61.4], 2.0, 0xffff_ffff)]), &Images::default(), &view(200.0, 80.0), [200, 80], Edges::Crisp);
    assert!(frame.pixels.as_chunks::<4>().0.iter().all(|p| p[3] == 0 || p[3] == 255));
}

#[test]
fn adjacent_triangles_of_different_colours_leave_no_seam() {
    // A red and a blue triangle sharing a slanted edge, over transparency: every pixel the
    // pair covers is opaque, the edge's pixels a mix of the two colours (each sample takes
    // one), as on the GPU. Covering each triangle by its own area would let the transparent
    // background through along the edge.
    let (p, q, r, s) = ([4.2f32, 3.7f32], [91.6f32, 7.3f32], [12.9f32, 58.1f32], [97.4f32, 61.8f32]);
    let frame = styk_raster::render(&list(vec![tri([p, q, r], 0xff00_00ff), tri([r, q, s], 0xffff_0000)]), &Images::default(), &view(100.0, 64.0), [100, 64], Edges::Smooth);
    let mut mixed = 0;
    for y in 12..52 {
        for x in 20..80 {
            let px = &frame.pixels[(y * 100 + x) * 4..(y * 100 + x) * 4 + 4];
            assert_eq!(px[3], 255, "pixel ({x}, {y}) is opaque: {px:?}");
            assert_eq!(px[1], 0);
            // Each sample one colour or the other; averages round, so two of each give 128 + 128.
            assert!((255..=256).contains(&(px[0] as u32 + px[2] as u32)), "pixel ({x}, {y}) is red, blue or a mix of them: {px:?}");
            mixed += usize::from(px[0] != 0 && px[2] != 0);
        }
    }
    assert!(mixed > 20, "the shared edge mixes the two colours ({mixed} pixels)");
}
