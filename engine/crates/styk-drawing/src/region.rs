//! `strokeRegion` (drawing-stroke-region.mjs): the tiles a run of quadratic midpoint
//! curves can reach, from the convex hulls of their input points inflated by a margin.

use crate::error::{fail, Result, WORKING_MEMORY};
use crate::tiles::{assert_tile, TILE};

/// Tile coordinates in first-reached order, at most `max_tiles` of them.
pub fn stroke_region(points: &[(f64, f64)], margin: f64, max_tiles: usize) -> Result<Vec<(i64, i64)>> {
    let mut order = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let t = TILE as f64;
    for i in 0..points.len() {
        let hull = &points[i.saturating_sub(2)..=i];
        if !hull.iter().all(|p| p.0.is_finite() && p.1.is_finite()) || !margin.is_finite() {
            return fail("errors.drawingStrokeRegion.invalidStrokeCoordinates");
        }
        let ymin = hull.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let ymax = hull.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        let y0 = ((ymin - margin) / t).floor();
        let y1 = ((ymax + margin) / t).floor();
        if y1 - y0 > max_tiles as f64 {
            return fail(WORKING_MEMORY);
        }
        let mut ty = y0;
        while ty <= y1 {
            let lo = ty * t - margin;
            let hi = (ty + 1.0) * t + margin;
            let mut xs = Vec::new();
            for j in 0..hull.len() {
                let (a, b) = (hull[j], hull[(j + 1) % hull.len()]);
                if a.1 >= lo && a.1 <= hi {
                    xs.push(a.0);
                }
                if a.1 != b.1 {
                    for y in [lo, hi] {
                        let k = (y - a.1) / (b.1 - a.1);
                        if (0.0..=1.0).contains(&k) {
                            xs.push(a.0 + (b.0 - a.0) * k);
                        }
                    }
                }
            }
            if !xs.is_empty() {
                let xmin = xs.iter().copied().fold(f64::INFINITY, f64::min);
                let xmax = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let x0 = ((xmin - margin) / t).floor();
                let x1 = ((xmax + margin) / t).floor();
                if x1 - x0 > max_tiles as f64 {
                    return fail(WORKING_MEMORY);
                }
                let mut tx = x0;
                while tx <= x1 {
                    assert_tile(tx as i64, ty as i64)?;
                    if seen.insert((tx as i64, ty as i64)) {
                        order.push((tx as i64, ty as i64));
                    }
                    if order.len() > max_tiles {
                        return fail(WORKING_MEMORY);
                    }
                    tx += 1.0;
                }
            }
            ty += 1.0;
        }
    }
    Ok(order)
}
