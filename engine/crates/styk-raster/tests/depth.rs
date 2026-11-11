//! Depth runs on the CPU: the scene and expectations of the GPU test
//! (styk-render/tests/depth.rs), so both renderers are held to one picture.

#[path = "../../styk-render/tests/support/depth_scene.rs"]
mod depth_scene;

use styk_raster::{Edges, Images, ViewParams};

fn view() -> ViewParams {
    ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 }
}

/// Faces of a run are drawn over what is there one by one, as the GPU blends them: a
/// translucent near face drawn after a translucent far one shows both, the far one through
/// the near one; drawn before it, the far one fails the depth test and does not show.
#[test]
fn translucent_faces_blend_in_drawing_order() {
    use styk_draw::*;
    let face = |color: u32, depth: f32| {
        let (x0, y0, x1, y1) = (0.0, 0.0, 16.0, 16.0);
        let d = [depth; 3];
        [
            Prim { kind: K_TRI | F_DEPTH, group: 0, color, paint: NO_PAINT, a: [x0, y0, x1, y0], b: [x1, y1, d[0], d[1]], c: [d[2], 0.0, 10.0, 0.0] },
            Prim { kind: K_TRI | F_DEPTH, group: 0, color, paint: NO_PAINT, a: [x0, y0, x1, y1], b: [x0, y1, d[0], d[1]], c: [d[2], 0.0, 10.0, 0.0] },
        ]
    };
    let reset = Prim { kind: K_DEPTH_RESET, group: 0, color: 0, paint: NO_PAINT, a: [0.0, 0.0, 16.0, 16.0], b: [0.0; 4], c: [0.0; 4] };
    // Half-transparent red (far, depth 0) and blue (near, depth 10).
    let (red, blue) = (face(0x8000_00ff, 0.0), face(0x80ff_0000, 10.0));
    let scene = |first: [Prim; 2], second: [Prim; 2]| {
        let mut prims = vec![reset];
        prims.extend(first);
        prims.extend(second);
        let end = prims.len() as u32;
        DrawList { prims, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 16.0, 16.0], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end }], ..Default::default() }
    };
    let view = ViewParams { artboard: [0.0, 0.0, 16.0, 16.0], ..view() };
    let pixel = |list: DrawList| styk_raster::render(&list, &Images::default(), &view, [16, 16], Edges::Smooth).pixels[(8 * 16 + 8) * 4..(8 * 16 + 8) * 4 + 4].to_vec();
    // Far first: blue (a = 128/255) over red over nothing, premultiplied.
    let a = 128.0 / 255.0;
    let expected = [(a * (1.0 - a) * 255.0f64).round() as u8, 0, (a * 255.0f64).round() as u8, ((a + a * (1.0 - a)) * 255.0f64).round() as u8];
    let got = pixel(scene(red, blue));
    assert!(got.iter().zip(expected).all(|(g, e)| g.abs_diff(e) <= 1), "far then near: {got:?}, expected {expected:?}");
    // Near first: the far face is behind it and does not draw.
    assert_eq!(pixel(scene(blue, red)), vec![0, 0, 128, 128]);
}

#[test]
fn depth_runs_hide_faces_behind_and_keep_painter_order() {
    for edges in [Edges::Smooth, Edges::Crisp] {
        let frame = styk_raster::render(&depth_scene::scene(), &Images::default(), &view(), [64, 64], edges);
        let pixels = frame.straight();
        for (x, y, rgb, why) in depth_scene::EXPECTED {
            let i = ((y * 64 + x) * 4) as usize;
            assert_eq!([pixels[i], pixels[i + 1], pixels[i + 2]], rgb, "{why} ({edges:?})");
        }
    }
}
