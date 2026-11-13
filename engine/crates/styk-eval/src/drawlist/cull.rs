//! Leaving out of a frame what the artboard clips away.
//!
//! A frame prepared for playback is drawn clipped to the artboard (`render_ticket` clips always), through the scene camera or, in the
//! workspace view, without it. A dense frame can hold hundreds of thousands of primitives that lie wholly outside it (the triangles of
//! a glyph far larger than the canvas), which cost an upload of megabytes on the interface thread to draw nothing.
//! [`cull_outside`] drops the primitives whose world bounds lie outside both views of the artboard, by a margin.

use super::{DrawList, Pass, Prim};
use crate::doc::{Camera, Document};
use styk_draw::{F_DEPTH, K_ARC, K_BOX, K_CAPSULE, K_DISC, K_IMAGE, K_RING, K_TRI};

/// How far outside the artboard (in canvas units) a primitive must lie to be left out: more than the antialiasing fringe of a
/// device pixel at any zoom that leaves the artboard a few pixels wide, and the room a rounded artboard edge takes.
fn margin(canvas: [u32; 2]) -> f64 {
    64.0f64.max(canvas[0].max(canvas[1]) as f64 * 0.1)
}

/// The world rectangle (x0, y0, x1, y1) a primitive of a kind that is drawn as itself covers, or `None` for the kinds whose reach is not
/// known here (fills, composites, polylines, particles, beams, glyph masks, depth-tested faces).
fn bounds(p: &Prim) -> Option<[f64; 4]> {
    let f = f64::from;
    if p.kind & F_DEPTH != 0 {
        return None;
    }
    let corners = |xs: &[f64], ys: &[f64]| -> [f64; 4] {
        [xs.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::INFINITY, f64::min), xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max)]
    };
    Some(match p.kind & 255 {
        K_CAPSULE | K_BOX => {
            // A square-capped stroke reaches further than a round-capped one: past a diagonal's corner (`box_reach`).
            let hw = f(p.b[0]).abs();
            let pad = if p.kind & 255 == K_BOX { super::box_reach(hw) } else { hw };
            [f(p.a[0]).min(f(p.a[2])) - pad, f(p.a[1]).min(f(p.a[3])) - pad, f(p.a[0]).max(f(p.a[2])) + pad, f(p.a[1]).max(f(p.a[3])) + pad]
        }
        K_ARC | K_RING => {
            let r = f(p.a[2]).abs() + f(p.a[3]).abs();
            [f(p.a[0]) - r, f(p.a[1]) - r, f(p.a[0]) + r, f(p.a[1]) + r]
        }
        K_DISC => {
            let r = f(p.a[2]).abs();
            [f(p.a[0]) - r, f(p.a[1]) - r, f(p.a[0]) + r, f(p.a[1]) + r]
        }
        K_TRI => corners(&[f(p.a[0]), f(p.a[2]), f(p.b[0])], &[f(p.a[1]), f(p.a[3]), f(p.b[1])]),
        K_IMAGE => {
            let (o, u, v) = ([f(p.a[0]), f(p.a[1])], [f(p.a[2]), f(p.a[3])], [f(p.b[0]), f(p.b[1])]);
            corners(&[o[0], o[0] + u[0], o[0] + v[0], o[0] + u[0] + v[0]], &[o[1], o[1] + u[1], o[1] + v[1], o[1] + u[1] + v[1]])
        }
        _ => return None,
    })
    .filter(|b| b.iter().all(|v| v.is_finite()))
}

/// The world rectangle (x0, y0, x1, y1) that covers the artboard grown by `margin` when the world is put on the canvas by `matrix`
/// (the rectangle that bounds its image under the inverse: exact for a camera without rotation, a little larger with one). `None` when
/// the matrix cannot be inverted.
fn world_rect(matrix: &[f64; 6], canvas: [u32; 2], margin: f64) -> Option<[f64; 4]> {
    let [a, b, c, d, e, f] = *matrix;
    let det = a * d - b * c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let (x0, y0, x1, y1) = (-margin, -margin, canvas[0] as f64 + margin, canvas[1] as f64 + margin);
    let corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(|[x, y]| {
        let (px, py) = (x - e, y - f);
        [(d * px - c * py) / det, (a * py - b * px) / det]
    });
    let (mut min, mut max) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for corner in corners {
        for axis in 0..2 {
            min[axis] = min[axis].min(corner[axis]);
            max[axis] = max[axis].max(corner[axis]);
        }
    }
    [min[0], min[1], max[0], max[1]].iter().all(|v| v.is_finite()).then_some([min[0], min[1], max[0], max[1]])
}

/// The world rectangle (x0, y0, x1, y1) a primitive covers before antialiasing, or `None` for the kinds whose reach is not known here
/// (fills, composites, polylines, particles, beams, glyph masks, depth-tested faces): a primitive whose rectangle a target region does not
/// meet (grown by the antialiasing fringe) draws nothing there.
pub fn prim_bounds(p: &Prim) -> Option<[f64; 4]> {
    bounds(p)
}

fn meets(b: [f64; 4], rect: [f64; 4]) -> bool {
    b[2] >= rect[0] && b[3] >= rect[1] && b[0] <= rect[2] && b[1] <= rect[3]
}

/// Drops from `list` the primitives that lie outside the artboard of `doc` both through `camera` and without it, and returns how many.
/// Nothing is dropped from a list with effects (they read beyond what they draw on) or whose primitive reach is not known (see [`bounds`]):
/// those are kept. Groups, glyphs, paints and points are untouched; the passes follow the primitives that stay.
pub fn cull_outside(list: &mut DrawList, doc: &Document, camera: Option<&Camera>) -> usize {
    if list.layers.iter().any(|layer| layer.effects.is_some()) || list.materials != 0 {
        return 0;
    }
    let (canvas, margin) = (doc.canvas, margin(doc.canvas));
    // The world seen through the camera, and without it: a primitive stays if it reaches either.
    let through = crate::view::camera_matrix(doc, camera, 1.0, [0.0, 0.0]);
    let (Some(seen), Some(plain)) = (world_rect(&through, canvas, margin), world_rect(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], canvas, margin)) else { return 0 };
    let keep: Vec<bool> = list.prims.iter().map(|p| bounds(p).is_none_or(|b| meets(b, seen) || meets(b, plain))).collect();
    let dropped = keep.iter().filter(|keep| !**keep).count();
    if dropped == 0 {
        return 0;
    }
    // Where each pass starts among the primitives that stay.
    let mut before = Vec::with_capacity(list.prims.len() + 1);
    let mut kept = 0u32;
    for &k in &keep {
        before.push(kept);
        kept += u32::from(k);
    }
    before.push(kept);
    // The leading root primitives that are background fills: counted among the primitives that stay, from where the root pass starts (the
    // root is the last pass, after the deeper ones). Fills are never dropped, so the count is what it was.
    if let Some(root) = list.passes.last() {
        let end = (root.start + list.background_prims).min(root.end);
        list.background_prims = before[end as usize] - before[root.start as usize];
    }
    list.passes = list.passes.iter().map(|pass| Pass { depth: pass.depth, start: before[pass.start as usize], end: before[pass.end as usize] }).collect();
    let mut at = 0;
    list.prims.retain(|_| {
        at += 1;
        keep[at - 1]
    });
    dropped
}
