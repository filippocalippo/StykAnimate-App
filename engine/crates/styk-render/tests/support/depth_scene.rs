//! The depth-run scene both renderers draw (styk-render/tests/depth.rs on the GPU,
//! styk-raster/tests/depth.rs on the CPU), and what they must show of it.

use styk_draw::*;

const RED: u32 = 0xff00_00ff;
const BLUE: u32 = 0xffff_0000;
const GREEN: u32 = 0xff00_ff00;
const WHITE: u32 = 0xffff_ffff;

fn tri(color: u32, p: [[f32; 2]; 3], depth: Option<[f32; 3]>) -> Prim {
    let (kind, d) = match depth {
        Some(d) => (K_TRI | F_DEPTH, d),
        None => (K_TRI, [0.0; 3]),
    };
    // Depths in a run spanning 0..10.
    Prim { kind, group: 0, color, paint: NO_PAINT, a: [p[0][0], p[0][1], p[1][0], p[1][1]], b: [p[2][0], p[2][1], d[0], d[1]], c: [d[2], 0.0, 10.0, 0.0] }
}

/// A square of two faces at one depth.
fn square(color: u32, x0: f32, y0: f32, x1: f32, y1: f32, depth: Option<f32>) -> [Prim; 2] {
    let d = depth.map(|d| [d; 3]);
    [tri(color, [[x0, y0], [x1, y0], [x1, y1]], d), tri(color, [[x0, y0], [x1, y1], [x0, y1]], d)]
}

fn reset(x0: f32, y0: f32, x1: f32, y1: f32) -> Prim {
    Prim { kind: K_DEPTH_RESET, group: 0, color: 0, paint: NO_PAINT, a: [x0, y0, x1, y1], b: [0.0; 4], c: [0.0; 4] }
}

/// A white artboard, then
/// 1. a run whose near red square is drawn before the far blue one: red shows where they overlap;
/// 2. a green square in painter order, over part of that run;
/// 3. a second run with one far square over the corner of the first: it shows, from a fresh depth.
pub fn scene() -> DrawList {
    let mut prims = vec![Prim { kind: K_FILL_VIEW, group: 0, color: WHITE, paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] }];
    prims.push(reset(0.0, 0.0, 60.0, 60.0));
    prims.extend(square(RED, 0.0, 0.0, 40.0, 40.0, Some(10.0)));
    prims.extend(square(BLUE, 20.0, 20.0, 60.0, 60.0, Some(0.0)));
    prims.extend(square(GREEN, 30.0, 0.0, 40.0, 10.0, None));
    prims.push(reset(50.0, 50.0, 64.0, 64.0));
    prims.extend(square(WHITE, 50.0, 50.0, 64.0, 64.0, Some(0.0)));
    let end = prims.len() as u32;
    DrawList {
        prims,
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 64.0, 64.0], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end }],
        background_prims: 1,
        ..Default::default()
    }
}

/// What both renderers must show of [`scene`]: (x, y, rgb, why).
pub const EXPECTED: [(u32, u32, [u8; 3], &str); 5] = [
    (30, 30, [255, 0, 0], "the nearer face, drawn first, shows"),
    (45, 45, [0, 0, 255], "the farther face shows where nothing hides it"),
    (35, 5, [0, 255, 0], "a later record draws over the run"),
    (57, 57, [255, 255, 255], "a later run starts from a fresh depth"),
    (10, 50, [255, 255, 255], "outside the faces the artboard shows"),
];
