//! Filter effects on the CPU: a filtered group is drawn on its entry's grid, its effect
//! recipe (`styk_render::effects::recipe`) run on its pixels, then composited, as the GPU
//! renderer does.

use std::sync::Arc;

use styk_draw::{DrawList, EffectLayer, Effects, Group, LayerKind, Pass, Prim, K_COMPOSITE, K_TRI, NO_LAYER, NO_PAINT};
use styk_eval::vfx::registry::{Blur, Params, Tint};
use styk_eval::vfx::{Color, Effect};
use styk_raster::{Edges, Images, ViewParams};

/// An opaque red square (x 20–44, y 20–44) in a group filtered by `effects`, on a 64×64 view.
fn filtered(effects: Vec<Effect>) -> DrawList {
    let square = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| Prim { kind: K_TRI, group: 1, color: 0xff00_00ff, paint: NO_PAINT, a: [a[0], a[1], b[0], b[1]], b: [c[0], c[1], 0.0, 0.0], c: [0.0; 4] };
    let composite = Prim { kind: K_COMPOSITE, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0, 0.0, 64.0, 64.0], b: [f32::from_bits(1), 0.0, 0.0, 0.0], c: [0.0; 4] };
    let stack: Effects = Arc::new(effects.into_iter().map(Arc::new).collect::<Vec<_>>());
    let layer = EffectLayer { effects: Some(stack), kind: LayerKind::Entry { bounds: [4.0, 4.0, 56.0, 56.0], domain: [20.0, 20.0, 24.0, 24.0], scale: 1.0, padding: 16.0, single_drawing: false } };
    DrawList {
        prims: vec![square([20.0, 20.0], [44.0, 20.0], [44.0, 44.0]), square([20.0, 20.0], [44.0, 44.0], [20.0, 44.0]), composite],
        groups: vec![
            Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 64.0, 64.0], layer: NO_LAYER },
            Group { parent: 0, depth: 1, opacity: 1.0, bounds: [4.0, 4.0, 60.0, 60.0], layer: 0 },
        ],
        passes: vec![Pass { depth: 1, start: 0, end: 2 }, Pass { depth: 0, start: 2, end: 3 }],
        layers: vec![layer],
        ..Default::default()
    }
}

fn draw(list: &DrawList) -> Vec<u8> {
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 };
    styk_raster::render(list, &Images::default(), &view, [64, 64], Edges::Smooth).pixels
}

fn at(pixels: &[u8], x: usize, y: usize) -> [u8; 4] {
    pixels[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4].try_into().unwrap()
}

#[test]
fn a_tint_recolours_the_layer() {
    let tint = Effect { id: Arc::from("t"), enabled: true, params: Params::Tint(Tint { color: Color::Rgb(0x0000ff), mix: 1.0, ..Default::default() }) };
    let pixels = draw(&filtered(vec![tint]));
    assert_eq!(at(&pixels, 32, 32), [0, 0, 255, 255], "the square is blue");
    assert_eq!(at(&pixels, 10, 10), [0, 0, 0, 0], "nothing around it");
}

#[test]
fn a_blur_spreads_the_layer() {
    let blur = Effect { id: Arc::from("b"), enabled: true, params: Params::Blur(Blur { radius: 6.0, ..Default::default() }) };
    let (plain, blurred) = (draw(&filtered(vec![])), draw(&filtered(vec![blur])));
    assert_eq!(at(&plain, 17, 32)[3], 0);
    assert!(at(&blurred, 17, 32)[3] > 20, "the blur reaches past the square's edge: {:?}", at(&blurred, 17, 32));
    assert!(at(&blurred, 21, 32)[3] < 255, "and softens it: {:?}", at(&blurred, 21, 32));
    assert_eq!(at(&blurred, 32, 32), [255, 0, 0, 255], "the middle stays red");
}
