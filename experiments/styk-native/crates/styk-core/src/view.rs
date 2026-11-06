//! Camera and workspace transforms (`cameraMatrix` in src/renderer-geometry.mjs).

use crate::doc::{Camera, Document};

/// Native camera identity test (`cameraIsIdentity`).
pub fn camera_is_identity(camera: Option<&Camera>) -> bool {
    let Some(c) = camera else { return true };
    if c.is_default {
        return true;
    }
    let zero = |v: f64| {
        let m = v.abs();
        let eps = (m as f32 * 1.25e-6f32) as f64;
        m <= if eps != 0.0 { eps } else { 6.25e-37f32 as f64 }
    };
    zero(c.x) && zero(c.y) && c.angle.abs() <= 1e-12 && (c.scale - 1.0).abs() <= 1e-4f32 as f64
}

/// World → workspace pixels for a camera, workspace zoom and pan.
pub fn camera_matrix(doc: &Document, camera: Option<&Camera>, zoom: f64, pan: [f64; 2]) -> [f64; 6] {
    let camera = if doc.layers.as_ref().is_some_and(|l| !l.camera_visible) { None } else { camera };
    let [x, y] = pan;
    if camera_is_identity(camera) {
        return [zoom, 0.0, 0.0, zoom, x, y];
    }
    let c = camera.unwrap();
    let inverse = (1.0f32 / (c.scale as f32)) as f64;
    let scale = inverse * zoom;
    let angle = -c.angle;
    let (a, b) = (angle.cos() * scale, angle.sin() * scale);
    let (cx, cy) = (doc.canvas[0] as f64 / 2.0, doc.canvas[1] as f64 / 2.0);
    let (px, py) = (cx + c.x, cy + c.y);
    [a, b, -b, a, x + cx * zoom - a * px + b * py, y + cy * zoom - b * px - a * py]
}

/// Inverse of an affine matrix.
pub fn invert(m: [f64; 6]) -> [f64; 6] {
    let [a, b, c, d, e, f] = m;
    let det = a * d - b * c;
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]
}

pub fn apply(m: [f64; 6], p: [f64; 2]) -> [f64; 2] {
    [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
}
