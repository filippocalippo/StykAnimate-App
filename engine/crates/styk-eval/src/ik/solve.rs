//! The point solver (`solveIKPoints` and `ikBendReference` in src/ik.mjs).
//!
//! Two-bone chains have an analytic solution; longer chains run at most 32
//! FABRIK passes. Lengths never change here: stretch is applied by the caller.

use std::f64::consts::PI;

use styk_math::{atan2, cos, sin};

use super::{hypot, sign, BendReference, EPS};

/// What a point solve reports (`{iterations, error, bendReference}`).
#[derive(Clone, Debug, PartialEq)]
pub struct Solved {
    /// FABRIK passes used (0 for the analytic and straight solutions).
    pub iterations: u32,
    /// Distance left between the endpoint and the target.
    pub error: f64,
    /// The continuity reference after the solve, for automatic bends only.
    pub bend_reference: Option<BendReference>,
}

/// `ikBendReference(points, lengths, previous)`: a small serializable
/// description of how the chain bends, so the next solve continues from it.
pub fn bend_reference(points: &[[f64; 2]], lengths: &[f64], previous: Option<&BendReference>) -> BendReference {
    let base = points[0];
    let end = points[points.len() - 1];
    let (dx, dy) = (end[0] - base[0], end[1] - base[1]);
    let total = lengths.iter().fold(0.0, |a, b| a + b);
    let distance = hypot(dx, dy);
    let mut cross = 0.0f64;
    let mut pole = points.get(1).copied().unwrap_or(end);
    for p in points.iter().take(points.len() - 1).skip(1) {
        let value = dx * (p[1] - base[1]) - dy * (p[0] - base[0]);
        if value.abs() > cross.abs() {
            cross = value;
            pole = *p;
        }
    }
    BendReference {
        side: if cross.abs() > total * total * 1e-7 { sign(cross) } else { previous.map(|p| p.side).unwrap_or(1.0) },
        angle: if hypot(pole[0] - base[0], pole[1] - base[1]) > EPS {
            atan2(pole[1] - base[1], pole[0] - base[0])
        } else {
            previous.map(|p| p.angle).unwrap_or(0.0)
        },
        axis: if distance > EPS { atan2(dy, dx) } else { previous.map(|p| p.axis).unwrap_or(0.0) },
        ratio: if total > EPS { distance / total } else { 0.0 },
        shape: (lengths.len() > 2).then(|| (0..lengths.len()).map(|i| atan2(points[i + 1][1] - points[i][1], points[i + 1][0] - points[i][0])).collect()),
    }
}

/// `solveIKPoints(points, lengths, target, bendDirection, {bendReference})`.
///
/// `points` holds the chain's joints from its base to its endpoint
/// (`lengths.len() + 1` of them) and is rewritten in place. `bend_direction` is
/// 1, -1 or 0; with 0 the bend continues from `reference`, or from the points
/// themselves when the controller has none yet.
pub fn solve_points(points: &mut [[f64; 2]], lengths: &[f64], target: [f64; 2], bend_direction: f64, reference: Option<&BendReference>) -> Solved {
    const ITERATIONS: u32 = 32;
    const TOLERANCE: f64 = 1e-5;
    let n = lengths.len();
    let base = points[0];
    let total = lengths.iter().fold(0.0, |a, b| a + b);
    // `!(total >= EPS)` keeps JavaScript's `total < EPS` false for NaN.
    if n == 0 || total < EPS {
        return Solved { iterations: 0, error: hypot(target[0] - base[0], target[1] - base[1]), bend_reference: None };
    }
    let automatic = bend_direction == 0.0;
    let mut bend_direction = bend_direction;
    let reference: Option<BendReference> = automatic.then(|| reference.cloned().unwrap_or_else(|| bend_reference(points, lengths, None)));
    // Canvas/world conversion and native float32 poses introduce tiny offsets at
    // a folded endpoint. Their atan2 is essentially random; treat them as zero.
    let fold_tolerance = if automatic { EPS.max(total * 1e-6) } else { EPS };
    // Longer chains continue from their last solved chord directions.
    if n > 2
        && let Some(shape) = reference.as_ref().and_then(|r| r.shape.as_ref()).filter(|shape| shape.len() == n)
    {
        for i in 0..n {
            points[i + 1] = [points[i][0] + cos(shape[i]) * lengths[i], points[i][1] + sin(shape[i]) * lengths[i]];
        }
    }
    let (dx, dy) = (target[0] - base[0], target[1] - base[1]);
    let distance = hypot(dx, dy);
    let fallback = match &reference {
        Some(r) => r.axis,
        None => atan2(points[n][1] - base[1], points[n][0] - base[0]),
    };
    let direction = if distance > fold_tolerance { atan2(dy, dx) } else { fallback };
    let (ux, uy) = (cos(direction), sin(direction));
    // Preserve the branch of the solved limb, not the side of the old knee
    // relative to each new target position.
    if let Some(r) = &reference {
        bend_direction = r.side;
    }
    let mut used = 0;
    if distance >= total - EPS || n == 1 {
        for i in 0..n {
            points[i + 1] = [points[i][0] + ux * lengths[i], points[i][1] + uy * lengths[i]];
        }
    } else if n == 2 && lengths[0] > EPS && lengths[1] > EPS {
        let (a, b) = (lengths[0], lengths[1]);
        // `clamp(v, lo, hi)` in ik.mjs is `max(lo, min(hi, v))`.
        let d = (a - b).abs().max((a + b).min(distance));
        let along = if d > EPS { (a * a - b * b + d * d) / (2.0 * d) } else { 0.0 };
        let magnitude = (a * a - along * along).max(0.0).sqrt();
        if let Some(reference) = &reference {
            // Consider the other branch only where it can preserve continuity:
            // near extension, or when the target path passes through the fold.
            let old_x = cos(reference.axis) * reference.ratio * total;
            let old_y = sin(reference.axis) * reference.ratio * total;
            let (vx, vy) = (dx - old_x, dy - old_y);
            let travel2 = vx * vx + vy * vy;
            let t = if travel2 > EPS { 0f64.max(1f64.min(-(old_x * vx + old_y * vy) / travel2)) } else { 0.0 };
            let through_fold = hypot(old_x + t * vx, old_y + t * vy) < total * 0.04 && old_x * dx + old_y * dy <= 0.0;
            if magnitude < total * 0.02 || through_fold {
                let (pole_x, pole_y) = (cos(reference.angle), sin(reference.angle));
                // Difference in squared knee travel, normalized by link length. A
                // dead band keeps floating-point noise from flipping sides.
                let improvement = -4.0 * magnitude / a * bend_direction * (-uy * pole_x + ux * pole_y);
                if improvement > 0.002 {
                    bend_direction = -bend_direction;
                }
            }
            if distance <= fold_tolerance && (a - b).abs() < EPS {
                // Use the limit of the approaching branch at an exactly folded limb.
                let angle = if reference.ratio > 1e-6 { reference.axis + reference.side * PI / 2.0 } else { reference.angle };
                points[1] = [base[0] + cos(angle) * a, base[1] + sin(angle) * a];
                points[2] = base;
                return Solved { iterations: 0, error: distance, bend_reference: Some(BendReference { angle, ratio: 0.0, ..reference.clone() }) };
            }
        }
        let height = magnitude * bend_direction;
        points[1] = [base[0] + ux * along - uy * height, base[1] + uy * along + ux * height];
        points[2] = [base[0] + ux * d, base[1] + uy * d];
    } else {
        let mut greatest = 0.0f64;
        for p in &points[1..n] {
            let side = ux * (p[1] - base[1]) - uy * (p[0] - base[0]);
            if side.abs() > greatest.abs() {
                greatest = side;
            }
        }
        let error = hypot(points[n][0] - target[0], points[n][1] - target[1]);
        if (automatic || greatest * bend_direction >= 0.0) && error <= TOLERANCE {
            let bend = automatic.then(|| bend_reference(points, lengths, reference.as_ref()));
            return Solved { iterations: 0, error, bend_reference: bend };
        }
        // FABRIK already follows its input pose. An explicit side reflects a
        // chain that sits on the other side of the target axis.
        if !automatic && greatest * bend_direction < -total * 1e-7 {
            for point in points.iter_mut().take(n).skip(1) {
                let side = ux * (point[1] - base[1]) - uy * (point[0] - base[0]);
                *point = [point[0] + 2.0 * uy * side, point[1] - 2.0 * ux * side];
            }
        }
        // A perfectly straight chain cannot escape the collinear singularity:
        // seed a small deterministic bend on the chosen side.
        let cross = points[1..n].iter().any(|p| ((p[0] - base[0]) * uy - (p[1] - base[1]) * ux).abs() > total * 1e-7);
        if !cross {
            for (i, point) in points.iter_mut().enumerate().take(n).skip(1) {
                let offset = sin(PI * i as f64 / n as f64) * total * 0.05 * bend_direction;
                *point = [point[0] - uy * offset, point[1] + ux * offset];
            }
        }
        let place = |points: &mut [[f64; 2]], i: usize, anchor: [f64; 2], length: f64, fallback_x: f64, fallback_y: f64| {
            let p = points[i];
            let (vx, vy) = (p[0] - anchor[0], p[1] - anchor[1]);
            let d = hypot(vx, vy);
            points[i] = [
                anchor[0] + (if d > EPS { vx / d } else { fallback_x }) * length,
                anchor[1] + (if d > EPS { vy / d } else { fallback_y }) * length,
            ];
        };
        while used < ITERATIONS {
            points[n] = target;
            for i in (0..n).rev() {
                let anchor = points[i + 1];
                place(points, i, anchor, lengths[i], -ux, -uy);
            }
            points[0] = base;
            for i in 0..n {
                let anchor = points[i];
                place(points, i + 1, anchor, lengths[i], ux, uy);
            }
            if hypot(points[n][0] - target[0], points[n][1] - target[1]) <= TOLERANCE {
                used += 1;
                break;
            }
            used += 1;
        }
    }
    let bend = reference.map(|reference| bend_reference(points, lengths, Some(&BendReference { side: bend_direction, ..reference })));
    Solved { iterations: used, error: hypot(points[n][0] - target[0], points[n][1] - target[1]), bend_reference: bend }
}
