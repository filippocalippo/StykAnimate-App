//! 3D target space of spatial rigs (src/ik-spatial.mjs), with the two
//! quaternion helpers of src/rig-spatial.mjs that only IK uses.
//!
//! Quaternions are `[x, y, z, w]`. A spatial limb keeps a depth, a pole
//! direction and a swivel beside its 2D target; the solver still writes the
//! figure's ordinary angle channels.

use std::f64::consts::PI;

use crate::rig::{quat_multiply, quat_rotate, spatial_quaternion};

use super::{norm, SpatialTarget};
use styk_math::{acos, asin, atan2, cos, sin};

/// `inverseQuaternion`.
pub fn inverse_quaternion(q: [f64; 4]) -> [f64; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

pub fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    0.0 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// `normalize` in ik-spatial.mjs: a degenerate vector becomes +Z.
pub fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = norm(&v);
    if n > 1e-10 { v.map(|x| x / n) } else { [0.0, 0.0, 1.0] }
}

/// `normalize` in rig-spatial.mjs: no guard.
fn normalize_unguarded<const N: usize>(v: [f64; N]) -> [f64; N] {
    let n = norm(&v);
    v.map(|x| x / n)
}

/// `spatialWorldVector(v, figure, object, inverse)`: between the figure's rest
/// frame and scene space (its rotation and mirroring; depth is unchanged).
pub fn spatial_world_vector(v: [f64; 3], figure_angle: f64, mirror: bool, inverse: bool) -> [f64; 3] {
    let (c, s) = (cos(figure_angle), sin(figure_angle));
    let m = if mirror { -1.0 } else { 1.0 };
    if inverse { [v[0] * c + v[1] * s, (-v[0] * s + v[1] * c) * m, v[2]] } else { [v[0] * c - v[1] * m * s, v[0] * s + v[1] * m * c, v[2]] }
}

/// `spatialWorldQuaternion(q, figure, object, inverse)`.
pub fn spatial_world_quaternion(q: [f64; 4], figure_angle: f64, mirror: bool, inverse: bool) -> [f64; 4] {
    let reflect = |v: [f64; 4]| if mirror { [-v[0], v[1], -v[2], v[3]] } else { v };
    if inverse { reflect(quat_multiply(spatial_quaternion(-figure_angle, 0.0, 0.0), q)) } else { quat_multiply(spatial_quaternion(figure_angle, 0.0, 0.0), reflect(q)) }
}

/// `flatSpatialBend(base, end, lean, side, a, b)`: of the knee positions [`spatial_knee`]
/// reaches, the one where the upper bone keeps its depth `lean` and the knee lies on
/// screen `side` of the base→end line; the unit bend direction across the axis, or `None`
/// when the axis points into the screen.
pub fn flat_spatial_bend(base: [f64; 3], end: [f64; 3], lean: f64, side: f64, a: f64, b: f64) -> Option<[f64; 3]> {
    let vector = [end[0] - base[0], end[1] - base[1], end[2] - base[2]];
    let distance = norm(&vector);
    let q = styk_math::hypot(vector[0], vector[1]);
    if distance < 1e-9 || q < 1e-6 * distance {
        return None;
    }
    let axis = vector.map(|v| v / distance);
    let d = ((a - b).abs() + 1e-8).max((a + b).min(distance));
    let along = (a * a - b * b + d * d) / (2.0 * d);
    let height = (a * a - along * along).max(0.0).sqrt();
    // u lies in the screen plane, so only v changes the knee's depth.
    let u = [vector[1] / q, -vector[0] / q, 0.0];
    let v = cross(axis, u);
    let s = if height * v[2].abs() > 1e-9 { (-1f64).max(1f64.min((lean - axis[2] * along) / (height * v[2]))) } else { 0.0 };
    let c = -side * (1.0 - s * s).sqrt();
    Some([u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s])
}

/// `spatialPoleFor(base, end, bend, swivel)`: the pole for which [`spatial_knee`] bends
/// toward `bend` at this swivel.
pub fn spatial_pole_for(base: [f64; 3], end: [f64; 3], bend: [f64; 3], swivel: f64) -> [f64; 3] {
    let axis = normalize([end[0] - base[0], end[1] - base[1], end[2] - base[2]]);
    let side = cross(axis, bend);
    let (c, s) = (cos(swivel), sin(swivel));
    normalize([bend[0] * c - side[0] * s, bend[1] * c - side[1] * s, bend[2] * c - side[2] * s])
}

/// The 3D target `captureSpatialIK` takes from a two-bone limb as posed: the end's depth,
/// the pole (the knee's side turned by `swivel`, in scene space), and each bone's bend-plane
/// normal in its own frame. `points` are the base, knee and end in figure space, `q0`/`q1`
/// the bones' frames.
pub fn capture_spatial_target(points: [[f64; 3]; 3], q0: [f64; 4], q1: [f64; 4], swivel: f64, figure_angle: f64, mirror: bool, scale: f64) -> SpatialTarget {
    let axis = normalize([points[2][0] - points[0][0], points[2][1] - points[0][1], points[2][2] - points[0][2]]);
    let knee = [points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]];
    let along = dot(knee, axis);
    let mut pole = [knee[0] - axis[0] * along, knee[1] - axis[1] * along, knee[2] - axis[2] * along];
    if norm(&pole) < 1e-5 {
        let hint = quat_rotate(q0, [0.0, 0.0, 1.0]);
        let along = dot(hint, axis);
        pole = [hint[0] - axis[0] * along, hint[1] - axis[1] * along, hint[2] - axis[2] * along];
        if norm(&pole) < 1e-5 {
            pole = cross(axis, [0.0, 1.0, 0.0]);
        }
    }
    let normal = normalize(cross(axis, pole));
    let direction = normalize(pole);
    let side = cross(axis, direction);
    let (c, s) = (cos(swivel), sin(swivel));
    let reference = [direction[0] * c - side[0] * s, direction[1] * c - side[1] * s, direction[2] * c - side[2] * s];
    SpatialTarget {
        depth: points[2][2] * scale,
        pole: normalize(spatial_world_vector(reference, figure_angle, mirror, false)),
        swivel,
        normals: Some([normalize(quat_rotate(inverse_quaternion(q0), normal)), normalize(quat_rotate(inverse_quaternion(q1), normal))]),
    }
}

/// The analytic two-bone solution in 3D (`spatialKnee`).
pub struct Knee {
    pub knee: [f64; 3],
    pub end: [f64; 3],
    /// Unit normal of the bend plane.
    pub normal: [f64; 3],
}

/// `spatialKnee(base, end, pole, swivel, a, b)`: where the knee and the
/// endpoint of a limb with bone lengths `a` and `b` go when it reaches from
/// `base` toward `end`, bending toward `pole` turned by `swivel` about the axis.
pub fn spatial_knee(base: [f64; 3], end: [f64; 3], pole: [f64; 3], swivel: f64, a: f64, b: f64) -> Knee {
    let vector = [end[0] - base[0], end[1] - base[1], end[2] - base[2]];
    let distance = norm(&vector);
    let axis = normalize(vector);
    let d = ((a - b).abs() + 1e-8).max((a + b).min(distance));
    let along_pole = dot(pole, axis);
    let mut direction = [pole[0] - axis[0] * along_pole, pole[1] - axis[1] * along_pole, pole[2] - axis[2] * along_pole];
    if norm(&direction) < 1e-6 {
        direction = cross(axis, if axis[0].abs() < 0.8 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] });
    }
    let direction = normalize(direction);
    let side = cross(axis, direction);
    let (cs, sn) = (cos(swivel), sin(swivel));
    let along = (a * a - b * b + d * d) / (2.0 * d);
    let height = (a * a - along * along).max(0.0).sqrt();
    let bend = [direction[0] * cs + side[0] * sn, direction[1] * cs + side[1] * sn, direction[2] * cs + side[2] * sn];
    Knee {
        knee: [base[0] + axis[0] * along + bend[0] * height, base[1] + axis[1] * along + bend[1] * height, base[2] + axis[2] * along + bend[2] * height],
        end: [base[0] + axis[0] * d, base[1] + axis[1] * d, base[2] + axis[2] * d],
        normal: normalize(cross(axis, bend)),
    }
}

/// `betweenVectors(a, b)`: the shortest rotation taking unit vector `a` to `b`.
pub fn between_vectors(a: [f64; 3], b: [f64; 3]) -> [f64; 4] {
    let d = dot(a, b);
    if d < -0.999999 {
        let axis = normalize_unguarded(cross(a, if a[0].abs() < 0.8 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] }));
        return [axis[0], axis[1], axis[2], 0.0];
    }
    let c = cross(a, b);
    normalize_unguarded([c[0], c[1], c[2], 1.0 + d])
}

/// `spatialIKOrientation(axis, normal, direction, plane)`: aim a bone's axis
/// along `direction` and its captured bend-plane normal along `plane`. A
/// shortest swing alone would accumulate axial twist on closed drags.
pub fn spatial_ik_orientation(axis: [f64; 3], normal: [f64; 3], direction: [f64; 3], plane: [f64; 3]) -> [f64; 4] {
    let aim = normalize(direction);
    let swing = between_vectors(normalize(axis), aim);
    let turned = quat_rotate(swing, normal);
    let angle = atan2(dot(aim, cross(turned, plane)), dot(turned, plane)) / 2.0;
    let twist = [aim[0] * sin(angle), aim[1] * sin(angle), aim[2] * sin(angle), cos(angle)];
    quat_multiply(twist, swing)
}

/// `interpolateQuaternion(a, b, t)`: spherical interpolation on the short arc.
pub fn interpolate_quaternion(a: [f64; 4], b: [f64; 4], t: f64) -> [f64; 4] {
    let d = 0.0 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let sign = if d < 0.0 { -1.0 } else { 1.0 };
    let d = 1f64.min(d.abs());
    let angle = acos(d);
    let sine = sin(angle);
    let x = if sine > 1e-6 { sin((1.0 - t) * angle) / sine } else { 1.0 - t };
    let y = (if sine > 1e-6 { sin(t * angle) / sine } else { t }) * sign;
    let v = [a[0] * x + b[0] * y, a[1] * x + b[1] * y, a[2] * x + b[2] * y, a[3] * x + b[3] * y];
    let n = norm(&v);
    // The JavaScript falls back to a three-component [0, 0, 1]; its missing w is NaN here.
    if n > 1e-10 { v.map(|c| c / n) } else { [0.0, 0.0, 1.0, f64::NAN] }
}

/// `interpolatePole(a, b, t)`: turn unit direction `a` toward `b`.
pub fn interpolate_pole(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    quat_rotate(interpolate_quaternion([0.0, 0.0, 0.0, 1.0], between_vectors(a, b), t), a)
}

/// The native Euler channels of a spatial bone (`{bend, turn, pitch}`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Euler {
    pub bend: f64,
    pub turn: f64,
    pub pitch: f64,
}

fn shortest(a: f64) -> f64 {
    atan2(sin(a), cos(a))
}

/// `quaternionPose(q, previous)`: of the two Euler triples that produce `q`,
/// the one nearest the previous pose, so channels never jump by a turn.
pub fn quaternion_pose(q: [f64; 4], previous: Euler) -> Euler {
    let [x, y, z, w] = normalize_unguarded(q);
    let sy = (-1f64).max(1f64.min(2.0 * (w * y - z * x)));
    let turn = asin(sy);
    let (pitch, bend);
    if sy.abs() > 1.0 - 1e-10 {
        pitch = previous.pitch;
        let a = quat_multiply([x, y, z, w], [-sin(pitch / 2.0), 0.0, 0.0, cos(pitch / 2.0)]);
        bend = 2.0 * atan2(a[2], a[3]);
    } else {
        pitch = atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
        bend = atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
    }
    let near = |p: Euler| Euler {
        pitch: previous.pitch + shortest(p.pitch - previous.pitch),
        turn: previous.turn + shortest(p.turn - previous.turn),
        bend: previous.bend + shortest(p.bend - previous.bend),
    };
    let first = near(Euler { pitch, turn, bend });
    let second = near(Euler { pitch: pitch + PI, turn: PI - turn, bend: bend + PI });
    // `[first, second].sort(compare)[0]`: V8 calls compare(second, first) and
    // swaps only on a negative result. Keys are summed in the order pitch, turn, bend.
    let square = |v: f64| v * v;
    let mut s = 0.0;
    s = s + square(second.pitch - previous.pitch) - square(first.pitch - previous.pitch);
    s = s + square(second.turn - previous.turn) - square(first.turn - previous.turn);
    s = s + square(second.bend - previous.bend) - square(first.bend - previous.bend);
    if s < 0.0 { second } else { first }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn rotations_interpolate_on_the_short_arc() {
        // tests/ik-spatial.test.mjs: identity to a half turn about Z, halfway.
        let q = interpolate_quaternion([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 0.0], 0.5);
        let v = quat_rotate(q, [1.0, 0.0, 0.0]);
        near(v[0], 0.0);
        near(v[1], 1.0);
    }

    #[test]
    fn a_knee_keeps_both_bone_lengths() {
        let knee = spatial_knee([0.0, 0.0, 0.0], [0.0, 120.0, 30.0], [0.0, 0.0, 1.0], 0.4, 90.0, 80.0);
        near(norm(&knee.knee), 90.0);
        near(norm(&[knee.end[0] - knee.knee[0], knee.end[1] - knee.knee[1], knee.end[2] - knee.knee[2]]), 80.0);
        near(dot(knee.normal, knee.knee), 0.0);
    }

    #[test]
    fn euler_channels_stay_near_the_previous_pose() {
        let previous = Euler { bend: 0.3, turn: 0.2, pitch: -0.1 };
        let q = spatial_quaternion(0.35, 0.25, -0.05);
        let pose = quaternion_pose(q, previous);
        near(pose.bend, 0.35);
        near(pose.turn, 0.25);
        near(pose.pitch, -0.05);
    }
}
