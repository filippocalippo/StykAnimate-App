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
    camera_transform(camera, doc.canvas, zoom, pan)
}

/// [`camera_matrix`] for a camera already known to be shown, on a `canvas` of that size.
pub fn camera_transform(camera: Option<&Camera>, canvas: [u32; 2], zoom: f64, pan: [f64; 2]) -> [f64; 6] {
    let [x, y] = pan;
    if camera_is_identity(camera) {
        return [zoom, 0.0, 0.0, zoom, x, y];
    }
    let c = camera.unwrap();
    let inverse = (1.0f32 / (c.scale as f32)) as f64;
    let scale = inverse * zoom;
    let angle = -c.angle;
    let (a, b) = (angle.cos() * scale, angle.sin() * scale);
    let (cx, cy) = (canvas[0] as f64 / 2.0, canvas[1] as f64 / 2.0);
    let (px, py) = (cx + c.x, cy + c.y);
    [a, b, -b, a, x + cx * zoom - a * px + b * py, y + cy * zoom - b * px - a * py]
}

/// The world rectangle painted by a solid or gradient background in the editor
/// (`backgroundBounds`). Brush coordinates remain world aligned; these bounds
/// cover the camera viewport, with its authored two-unit paint padding.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackgroundBounds {
    /// World x, y, width and height.
    pub rect: [f64; 4],
    /// The viewport extends outside the authored canvas before paint padding.
    pub clear_raster: bool,
}

/// Resolve the existing background paint bounds for an already evaluated camera.
/// Hidden camera layers and disabled cameras use the neutral viewport. This
/// prepares geometry only; it does not evaluate a frame or request follow work.
pub fn background_bounds(doc: &Document, camera: Option<&Camera>, camera_enabled: bool, viewport: [f64; 4]) -> BackgroundBounds {
    let camera = if !camera_enabled || doc.layers.as_ref().is_some_and(|l| !l.camera_visible) { None } else { camera };
    if camera_is_identity(camera) {
        return BackgroundBounds { rect: viewport, clear_raster: false };
    }
    let camera = camera.unwrap();
    let [width, height] = doc.canvas.map(|v| v as f64);
    let [x, y, w, h] = viewport;
    let (cos, sin) = (camera.angle.cos(), camera.angle.sin());
    let (mut low, mut high) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for [px, py] in [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] {
        let dx = (px - width / 2.0) * camera.scale;
        let dy = (py - height / 2.0) * camera.scale;
        // The oracle rounds each inverse-camera corner before taking its bounds.
        let point = [(dx * cos - dy * sin + width / 2.0 + camera.x) as f32 as f64,
                     (dx * sin + dy * cos + height / 2.0 + camera.y) as f32 as f64];
        for axis in 0..2 { low[axis] = low[axis].min(point[axis]); high[axis] = high[axis].max(point[axis]); }
    }
    let padding = 2.0 * camera.scale;
    BackgroundBounds {
        rect: [low[0] - padding, low[1] - padding, high[0] - low[0] + 2.0 * padding, high[1] - low[1] + 2.0 * padding],
        clear_raster: low[0] < 0.0 || low[1] < 0.0 || high[0] > width || high[1] > height,
    }
}

/// Where the screen's pixels go when the workspace view is turned by `rotation` radians about
/// `centre` and then mirrored horizontally about it (`cameraMatrix` in renderer-geometry.mjs: the
/// Draw view rotates and flips about the artboard's centre, after the scene camera). `None` for the
/// upright view.
pub fn orientation(rotation: f64, flip: bool, centre: [f64; 2]) -> Option<[f64; 6]> {
    if rotation == 0.0 && !flip {
        return None;
    }
    let (sin, cos) = rotation.sin_cos();
    let turned = [cos, sin, -sin, cos, centre[0] - (cos * centre[0] - sin * centre[1]), centre[1] - (sin * centre[0] + cos * centre[1])];
    Some(if flip { compose([-1.0, 0.0, 0.0, 1.0, 2.0 * centre[0], 0.0], turned) } else { turned })
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

/// `a ∘ b`: applies `b`, then `a`.
pub fn compose(a: [f64; 6], b: [f64; 6]) -> [f64; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

#[cfg(test)]
mod orientation_tests {
    use super::{apply, orientation};

    #[test]
    fn an_upright_view_has_no_orientation() {
        assert_eq!(orientation(0.0, false, [320.0, 240.0]), None);
    }

    #[test]
    fn a_turn_keeps_the_centre_and_takes_the_right_edge_down() {
        let turn = orientation(std::f64::consts::FRAC_PI_2, false, [320.0, 240.0]).unwrap();
        let centre = apply(turn, [320.0, 240.0]);
        assert!((centre[0] - 320.0).abs() < 1e-9 && (centre[1] - 240.0).abs() < 1e-9);
        // y points down on screen: a positive turn takes +x to +y, as the editor's matrix does.
        let right = apply(turn, [420.0, 240.0]);
        assert!((right[0] - 320.0).abs() < 1e-9 && (right[1] - 340.0).abs() < 1e-9);
    }

    #[test]
    fn a_mirror_swaps_left_and_right_about_the_centre_after_the_turn() {
        let mirror = orientation(0.0, true, [320.0, 240.0]).unwrap();
        let left = apply(mirror, [220.0, 100.0]);
        assert!((left[0] - 420.0).abs() < 1e-9 && (left[1] - 100.0).abs() < 1e-9);
        // Turned first (+x to +y, -y to +x), then mirrored about the centre (+x to -x).
        let both = orientation(std::f64::consts::FRAC_PI_2, true, [320.0, 240.0]).unwrap();
        let right = apply(both, [420.0, 240.0]);
        assert!((right[0] - 320.0).abs() < 1e-9 && (right[1] - 340.0).abs() < 1e-9);
        let up = apply(both, [320.0, 140.0]);
        assert!((up[0] - 220.0).abs() < 1e-9 && (up[1] - 240.0).abs() < 1e-9);
    }
}
