//! Rig relationships (`_stykRig`, src/rig-constraints.mjs, rig-spatial.mjs,
//! rig-weighted.mjs, rig-angle-path.mjs). The plan is compiled once per figure;
//! evaluation is stateless per pose, so any thread can evaluate any tick.

use std::f64::consts::PI;

use styk_doc::Value;
// The spatial path computes as V8 does, bit for bit: its results decide which
// faces are culled, where a tolerance of a few units in the last place matters.
use styk_math::{atan2, cos, hypot, norm, sin};

const EPS: f64 = 1e-8;
const SPATIAL_EPS: f64 = 1e-9;

mod validation;
pub use validation::validate_2d;

#[derive(Clone, Debug)]
pub struct Connector {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidthResponse {
    Keep,
    Inverse,
    Scale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StretchSource {
    Span,
    Slide,
    Combined,
}

#[derive(Clone, Debug)]
pub struct Stretch {
    pub rest_length: f64,
    pub min: f64,
    pub max: f64,
    pub width: WidthResponse,
    pub branch: bool,
    pub source: Option<StretchSource>,
    pub rest_position: f64,
}

#[derive(Clone, Debug)]
pub struct Follow {
    pub driver: u32,
    pub rigid: bool,
    pub influence: f64,
    pub automatic: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseMode {
    Stretch,
    Rigid,
    Stop,
}

#[derive(Clone, Debug)]
pub struct Response {
    pub mode: ResponseMode,
    pub multiplier: Option<f64>,
    pub reset: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockMode {
    World,
    Figure,
    Parent,
}

#[derive(Clone, Debug)]
pub struct AngleLock {
    pub mode: LockMode,
    pub authored: bool,
    pub reference: u32,
    pub angle: f64,
    pub rest_angle: f64,
    pub figure_rest_angle: Option<f64>,
    pub multiplier: f64,
    pub secondary: Option<(u32, f64, f64)>,
}

#[derive(Clone, Debug)]
pub struct AnglePath {
    pub source: Option<u32>,
    pub driver: u32,
    pub pitch: Option<u32>,
    pub origin: u32,
    pub rest_angle: f64,
    pub pitch_rest_angle: f64,
    pub figure_rest_angle: f64,
    pub keys: Vec<[f64; 4]>,
}

#[derive(Clone, Debug)]
pub struct Weighted {
    pub origin: u32,
    pub anchors: Vec<(u32, f64)>,
    pub depth: Option<Box<Weighted>>,
}

#[derive(Clone, Debug)]
pub struct Motion {
    pub hinge: bool,
    pub min: f64,
    pub max: f64,
    pub axis: Option<[f64; 3]>,
    pub driver: Option<(u32, f64)>,
}

#[derive(Clone, Debug)]
pub enum Spatial {
    Bone { parent: u32, turn: u32, pitch: u32, origin: [f64; 3], tip: [f64; 3], motion: Option<Motion> },
    Skin { point: [f64; 3], bindings: Vec<(u32, f64)>, view_points: Option<Vec<[f64; 3]>> },
}

#[derive(Clone, Debug, Default)]
pub struct Rig {
    pub connector: Option<Connector>,
    pub stretch: Option<Stretch>,
    pub follow: Option<Follow>,
    pub world: bool,
    pub response: Option<Response>,
    pub lock: Option<AngleLock>,
    pub path: Option<AnglePath>,
    pub weighted: Option<Weighted>,
    pub spatial: Option<Spatial>,
}

fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}
fn id(v: &Value, k: &str) -> Option<u32> {
    v.get(k).and_then(Value::as_f64).map(|x| x as u32)
}
fn vec3(v: Option<&Value>) -> Option<[f64; 3]> {
    let a = v?.numbers()?;
    Some([*a.first()?, *a.get(1)?, *a.get(2)?])
}
fn weighted(v: &Value) -> Option<Weighted> {
    Some(Weighted {
        origin: id(v, "origin").unwrap_or(0),
        anchors: v.get("anchors")?.as_arr()?.iter().filter_map(|a| Some((id(a, "joint")?, f(a, "weight")?))).collect(),
        depth: v.get("depth").and_then(weighted).map(Box::new),
    })
}

pub fn parse(v: &Value) -> Option<Rig> {
    if !v.is_object() {
        return None;
    }
    let mut rig = Rig { world: v.get("orientation").and_then(Value::as_str) == Some("world"), ..Default::default() };
    if let Some(c) = v.get("connector").filter(|value| value.truthy()) {
        rig.connector = Some(Connector { start: id(c, "start").unwrap_or(0), end: id(c, "end").unwrap_or(0) });
    }
    if let Some(d) = v.get("stretch").filter(|value| value.truthy()) {
        rig.stretch = Some(Stretch {
            rest_length: f(d, "restLength").unwrap_or(1.0),
            min: f(d, "min").unwrap_or(0.0),
            max: f(d, "max").unwrap_or(10.0),
            width: match d.get("width").and_then(Value::as_str) {
                Some("inverse") => WidthResponse::Inverse,
                Some("scale") => WidthResponse::Scale,
                _ => WidthResponse::Keep,
            },
            branch: d.get("branch") == Some(&Value::Bool(true)),
            source: match d.get("source").and_then(Value::as_str) {
                Some("span") => Some(StretchSource::Span),
                Some("slide") => Some(StretchSource::Slide),
                Some("combined") => Some(StretchSource::Combined),
                _ => None,
            },
            rest_position: f(d, "restPosition").unwrap_or(1.0),
        });
    }
    if let Some(x) = v.get("follow").filter(|value| value.truthy()) {
        rig.follow = Some(Follow {
            driver: id(x, "driver").unwrap_or(0),
            rigid: x.get("mode").and_then(Value::as_str) == Some("rigid"),
            influence: f(x, "influence").unwrap_or(1.0),
            automatic: x.get("automatic") == Some(&Value::Bool(true)),
        });
    }
    if let Some(r) = v.get("response").filter(|r| r.is_object()) {
        rig.response = Some(Response {
            mode: match r.get("mode").and_then(Value::as_str) {
                Some("rigid") => ResponseMode::Rigid,
                Some("stop") => ResponseMode::Stop,
                _ => ResponseMode::Stretch,
            },
            multiplier: f(r, "multiplier"),
            reset: r.get("reset") == Some(&Value::Bool(true)),
        });
    }
    if let Some(l) = v.get("angleLock").filter(|l| l.is_object()) {
        rig.lock = Some(AngleLock {
            mode: match l.get("mode").and_then(Value::as_str) {
                Some("figure") => LockMode::Figure,
                Some("parent") => LockMode::Parent,
                _ => LockMode::World,
            },
            authored: l.get("space").and_then(Value::as_str) == Some("authored"),
            reference: id(l, "reference").unwrap_or(0),
            angle: f(l, "angle").unwrap_or(0.0),
            rest_angle: f(l, "restAngle").unwrap_or(0.0),
            figure_rest_angle: f(l, "figureRestAngle"),
            multiplier: f(l, "multiplier").unwrap_or(0.0),
            secondary: l.get("secondary").filter(|s| s.is_object()).map(|s| (id(s, "reference").unwrap_or(0), f(s, "restAngle").unwrap_or(0.0), f(s, "multiplier").unwrap_or(0.0))),
        });
    }
    if let Some(p) = v.get("anglePath").filter(|p| p.is_object()) {
        rig.path = Some(AnglePath {
            source: id(p, "source"),
            driver: id(p, "driver").unwrap_or(0),
            pitch: id(p, "pitch"),
            origin: id(p, "origin").unwrap_or(0),
            rest_angle: f(p, "restAngle").unwrap_or(0.0),
            pitch_rest_angle: f(p, "pitchRestAngle").unwrap_or(0.0),
            figure_rest_angle: f(p, "figureRestAngle").unwrap_or(0.0),
            keys: p
                .get("keys")
                .and_then(Value::as_arr)
                .into_iter()
                .flatten()
                .filter_map(|k| {
                    let a = k.numbers()?;
                    Some([*a.first()?, *a.get(1)?, *a.get(2)?, *a.get(3)?])
                })
                .collect(),
        });
    }
    rig.weighted = v.get("weighted").and_then(weighted);
    if let Some(s) = v.get("spatial").filter(|s| s.is_object()) {
        rig.spatial = if s.get("bindings").is_some() {
            Some(Spatial::Skin {
                point: vec3(s.get("point")).unwrap_or([0.0; 3]),
                bindings: s.get("bindings").and_then(Value::as_arr).into_iter().flatten().filter_map(|b| Some((id(b, "joint")?, f(b, "weight")?))).collect(),
                view_points: s.get("viewPoints").and_then(Value::as_arr).map(|a| a.iter().filter_map(|p| vec3(Some(p))).collect()),
            })
        } else {
            Some(Spatial::Bone {
                parent: id(s, "parent").unwrap_or(0),
                turn: id(s, "turn").unwrap_or(0),
                pitch: id(s, "pitch").unwrap_or(0),
                origin: vec3(s.get("origin")).unwrap_or([0.0; 3]),
                tip: vec3(s.get("tip")).unwrap_or([0.0; 3]),
                motion: s.get("motion").filter(|m| m.is_object()).map(|m| Motion {
                    hinge: m.get("type").and_then(Value::as_str) == Some("hinge"),
                    min: f(m, "min").unwrap_or(0.0),
                    max: f(m, "max").unwrap_or(0.0),
                    axis: vec3(m.get("axis")),
                    driver: m.get("driver").filter(|d| d.is_object()).and_then(|d| Some((id(d, "joint")?, f(d, "multiplier")?))),
                }),
            })
        };
    }
    Some(rig)
}

/// An impulse source: which stretch driver and whose axis a joint follows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Impulse {
    pub driver: usize,
    pub axis: usize,
    pub legacy: bool,
}

#[derive(Clone, Debug, Default)]
pub struct RigPlan {
    pub order: Vec<u32>,
    pub inputs: Vec<Option<Impulse>>,
    /// Segment indices each joint reads (`plan.dependencies`), for IK (`crate::ik::rig`).
    pub dependencies: Vec<Vec<u32>>,
}

/// Shared dependency ordering for typed plans and strict raw edit validation.
fn dependency_order(dependencies: &[Vec<u32>]) -> Option<Vec<u32>> {
    let n = dependencies.len();
    let mut outgoing = vec![Vec::new(); n];
    let mut indegree = vec![0usize; n];
    for (index, dependencies) in dependencies.iter().enumerate() {
        for &dependency in dependencies {
            outgoing.get_mut(dependency as usize)?.push(index);
            indegree[index] += 1;
        }
    }
    let mut order: Vec<u32> = (0..n as u32).filter(|&index| indegree[index as usize] == 0).collect();
    let mut q = 0;
    while q < order.len() {
        for &child in &outgoing[order[q] as usize] {
            indegree[child] -= 1;
            if indegree[child] == 0 { order.push(child as u32); }
        }
        q += 1;
    }
    (order.len() == n).then_some(order)
}

/// `rigConstraintPlanSteps`: dependency order and resolved impulses.
pub fn plan(segments: &[crate::doc::Segment], index_of: &std::collections::HashMap<u32, u32>) -> Option<RigPlan> {
    if segments.iter().all(|s| s.rig.is_none()) {
        return None;
    }
    let n = segments.len();
    let idx = |id: u32| index_of.get(&id).map(|&i| i as usize);
    let mut dependencies: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (i, s) in segments.iter().enumerate() {
        let mut deps: Vec<u32> = vec![s.parent];
        if let Some(r) = &s.rig {
            if let Some(sp) = &r.spatial {
                match sp {
                    Spatial::Skin { bindings, .. } => deps.extend(bindings.iter().map(|b| b.0)),
                    Spatial::Bone { parent, turn, pitch, motion, .. } => {
                        deps.extend([*parent, *turn, *pitch]);
                        if let Some(Motion { driver: Some((j, _)), .. }) = motion {
                            deps.push(*j);
                        }
                    }
                }
            }
            let mut w = r.weighted.as_ref();
            while let Some(x) = w {
                deps.push(x.origin);
                deps.extend(x.anchors.iter().map(|a| a.0));
                w = x.depth.as_deref();
            }
            if let Some(p) = &r.path {
                match p.source {
                    Some(src) => deps.push(src),
                    None => {
                        deps.extend([p.driver, p.origin]);
                        if let Some(pitch) = p.pitch {
                            deps.push(pitch);
                        }
                    }
                }
            }
            if let Some(c) = &r.connector {
                deps.extend([c.start, c.end]);
            }
            if let Some(fo) = &r.follow {
                deps.push(fo.driver);
            }
            if let Some(l) = &r.lock
                && l.mode == LockMode::Parent
            {
                deps.push(l.reference);
                if let Some((sref, _, _)) = l.secondary {
                    deps.push(sref);
                }
            }
        }
        let mut seen = Vec::new();
        for d in deps {
            if d == 0 || seen.contains(&d) {
                continue;
            }
            seen.push(d);
            if let Some(p) = idx(d) {
                dependencies[i].push(p as u32);
            }
        }
    }
    let order = dependency_order(&dependencies)?;
    let mut inputs: Vec<Option<Impulse>> = vec![None; n];
    let mut outputs: Vec<Option<Impulse>> = vec![None; n];
    let mut blocked: Vec<Option<usize>> = vec![None; n];
    let empty = Rig::default();
    for &i in &order {
        let i = i as usize;
        let s = &segments[i];
        let r = s.rig.as_deref().unwrap_or(&empty);
        let parent = idx(s.parent);
        let parent_output = parent.and_then(|p| outputs[p]);
        let mut source = match &r.follow {
            Some(fo) if !fo.automatic => idx(fo.driver).map(|d| Impulse { driver: d, axis: d, legacy: true }),
            _ if (r.stretch.is_some() && r.connector.is_none()) || r.weighted.is_some() || r.spatial.is_some() => None,
            _ => parent_output,
        };
        if let Some(src) = source.as_mut()
            && src.legacy
            && let Some(po) = parent_output
            && po.driver == src.driver
        {
            src.axis = po.axis;
        }
        blocked[i] = if r.stretch.is_some() { None } else { parent.and_then(|p| blocked[p]) };
        if r.response.as_ref().is_some_and(|x| x.mode == ResponseMode::Stop) {
            blocked[i] = source.map(|s| s.driver).or(blocked[i]);
            source = None;
        }
        if source.is_some_and(|s| Some(s.driver) == blocked[i]) && blocked[i].is_some() {
            source = None;
        }
        inputs[i] = source;
        outputs[i] = if r.response.as_ref().is_some_and(|x| x.mode == ResponseMode::Stop) {
            None
        } else if r.stretch.as_ref().is_some_and(|x| x.branch) {
            Some(Impulse { driver: i, axis: i, legacy: false })
        } else if let Some(src) = source.filter(|_| r.response.as_ref().is_some_and(|x| x.reset)) {
            Some(Impulse { axis: i, legacy: false, ..src })
        } else if source.is_some_and(|s| s.legacy) {
            if r.response.is_some() { source.map(|s| Impulse { legacy: false, ..s }) } else { None }
        } else {
            source
        };
    }
    Some(RigPlan { order, inputs, dependencies })
}

// ------------------------------------------------------------ evaluation

#[derive(Clone, Copy, Debug, Default)]
pub struct SpatialFrame {
    pub q: [f64; 4],
    pub t: [f64; 3],
    pub dual: [f64; 4],
    pub native_bend: f64,
    pub authored_bend: f64,
    pub motion_value: f64,
    pub origin: [f64; 3],
    pub axis: [f64; 3],
    pub stretch: f64,
    /// `choiceScale`: a hidden expression scales about its origin by its stretch.
    pub choice_scale: Option<f64>,
    /// Part proportions of the pose (`_stykSpatial.shape`), when they change anything.
    pub shape: Option<crate::doc::SpatialShape>,
    /// `restLength`: the bone's rest length, set with `shape`.
    pub rest_length: f64,
}

/// The derived local space of a rig joint (`space` in rig-constraints.mjs): what
/// `authoredRigTarget` inverts when IK poses the joint (`crate::ik::rig`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Space {
    pub rotation: f64,
    /// Axis and amount of the stretch the joint follows, if it follows one.
    pub follow: Option<(f64, f64)>,
}

/// One evaluated rig joint.
#[derive(Clone, Copy, Debug, Default)]
pub struct State {
    pub start: [f64; 2],
    pub angle: f64,
    pub authored_angle: f64,
    pub length: f64,
    pub bend: f64,
    pub width: f64,
    pub handle: Option<[f64; 2]>,
    pub rotation: f64,
    pub ratio: f64,
    pub impulse_angle: f64,
    pub spatial: Option<SpatialFrame>,
    pub path: Option<([f64; 2], f64, f64)>,
    pub space: Option<Space>,
    /// Where the joint's depth lands along the surface reference X, from the
    /// figure root (`depthOffset`): spatial joints and weighted joints with a depth.
    pub depth_offset: Option<[f64; 2]>,
    /// The handle before perspective (`handle.rawPoint`), when the pose has a camera.
    pub raw_point: Option<[f64; 3]>,
    /// A spatial bone's start before perspective (`start.rawPoint`), when the pose has a camera.
    pub start_raw: Option<[f64; 3]>,
}

pub struct Input {
    pub start: [f64; 2],
    pub angle: f64,
    pub length: f64,
    pub bend: f64,
}

pub fn quat_multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

pub fn quat_rotate(q: [f64; 4], p: [f64; 3]) -> [f64; 3] {
    let [x, y, z, w] = q;
    let [a, b, c] = p;
    let (tx, ty, tz) = (2.0 * (y * c - z * b), 2.0 * (z * a - x * c), 2.0 * (x * b - y * a));
    [a + w * tx + y * tz - z * ty, b + w * ty + z * tx - x * tz, c + w * tz + x * ty - y * tx]
}

pub fn spatial_quaternion(bend: f64, turn: f64, pitch: f64) -> [f64; 4] {
    let (x, y, z) = (pitch / 2.0, turn / 2.0, bend / 2.0);
    let (cx, sx, cy, sy, cz, sz) = (cos(x), sin(x), cos(y), sin(y), cos(z), sin(z));
    [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz]
}

fn axis_quaternion(axis: [f64; 3], angle: f64) -> [f64; 4] {
    let h = sin(angle / 2.0) / norm(&axis);
    [axis[0] * h, axis[1] * h, axis[2] * h, cos(angle / 2.0)]
}

fn wrap(a: f64) -> f64 {
    atan2(sin(a), cos(a))
}

/// `quaternionPose(q, previous)`: the bend, turn and pitch of a rotation, on the Euler
/// branch nearest `previous` (`[bend, turn, pitch]`), with V8's trigonometry.
pub fn quaternion_pose(q: [f64; 4], previous: [f64; 3]) -> [f64; 3] {
    let n = norm(&q);
    let [x, y, z, w] = q.map(|v| v / n);
    let sy = (2.0 * (w * y - z * x)).clamp(-1.0, 1.0);
    let turn = styk_math::asin(sy);
    let [prev_bend, prev_turn, prev_pitch] = previous;
    let (pitch, bend) = if sy.abs() > 1.0 - 1e-10 {
        let pitch = prev_pitch;
        let a = quat_multiply([x, y, z, w], [-sin(pitch / 2.0), 0.0, 0.0, cos(pitch / 2.0)]);
        (pitch, 2.0 * atan2(a[2], a[3]))
    } else {
        (atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y)), atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))
    };
    // Keys in the editor's order: pitch, turn, bend.
    let near = |p: [f64; 3]| [prev_pitch + wrap(p[0] - prev_pitch), prev_turn + wrap(p[1] - prev_turn), prev_bend + wrap(p[2] - prev_bend)];
    let first = near([pitch, turn, bend]);
    let second = near([pitch + std::f64::consts::PI, std::f64::consts::PI - turn, bend + std::f64::consts::PI]);
    // The editor sorts the two by the difference of their squared distances.
    let prev = [prev_pitch, prev_turn, prev_bend];
    let order = (0..3).fold(0.0, |s, k| s + (second[k] - prev[k]).powi(2) - (first[k] - prev[k]).powi(2));
    let [p, t, b] = if order < 0.0 { second } else { first };
    [b, t, p]
}

/// `shapeOffset(frame, point)`: the radial offset part proportions give a bind-space point.
pub fn shape_offset(f: &SpatialFrame, shape: crate::doc::SpatialShape, point: [f64; 3]) -> [f64; 3] {
    let r = [point[0] - f.origin[0], point[1] - f.origin[1], point[2] - f.origin[2]];
    let d = r[0] * f.axis[0] + r[1] * f.axis[1] + r[2] * f.axis[2];
    let u = (d / f.rest_length).clamp(0.0, 1.0);
    let amount = shape.width * (1.0 + shape.taper * u * u * (3.0 - 2.0 * u)) - 1.0;
    [(r[0] - d * f.axis[0]) * amount, (r[1] - d * f.axis[1]) * amount, (r[2] - d * f.axis[2]) * amount]
}

/// `spatialPoint(frame, point)`: a bind-space point carried by a bone's frame.
pub fn spatial_point(f: &SpatialFrame, point: [f64; 3]) -> [f64; 3] {
    let mut p = point;
    if let Some(shape) = f.shape {
        let offset = shape_offset(f, shape, point);
        p = [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]];
    }
    if let Some(choice) = f.choice_scale {
        p = [f.origin[0] + (p[0] - f.origin[0]) * choice, f.origin[1] + (p[1] - f.origin[1]) * choice, f.origin[2] + (p[2] - f.origin[2]) * choice];
    } else if (f.stretch - 1.0).abs() > SPATIAL_EPS {
        let d = (point[0] - f.origin[0]) * f.axis[0] + (point[1] - f.origin[1]) * f.axis[1] + (point[2] - f.origin[2]) * f.axis[2];
        for i in 0..3 {
            p[i] += d * (f.stretch - 1.0) * f.axis[i];
        }
    }
    let mut r = quat_rotate(f.q, p);
    for i in 0..3 {
        r[i] += f.t[i];
    }
    r
}

/// `spatialViewInterpolation(frame)` for `count` evenly spaced views: the two
/// views around the bone's heading (index, next, blend), the heading's cosine
/// and sine, and the strength that fades correction out near a vertical view.
pub fn view_interpolation(f: &SpatialFrame, count: usize) -> (usize, usize, f64, f64, f64, f64) {
    let [x, y, z, w] = f.q;
    let (fx, fz) = (2.0 * (w * y - x * z), 1.0 - 2.0 * (x * x + y * y));
    let horizontal = hypot(fx, fz);
    let yaw = if horizontal > 1e-9 { atan2(fx, fz) } else { 0.0 };
    let c = count as f64;
    let phase = (yaw / (2.0 * PI) * c + c) % c;
    let index = phase.floor() as usize % count;
    let u = phase - phase.floor();
    let confidence = ((horizontal - 0.05) / 0.2).clamp(0.0, 1.0);
    (index, (index + 1) % count, u * u * (3.0 - 2.0 * u), cos(yaw), sin(yaw), confidence * confidence * (3.0 - 2.0 * confidence))
}

fn view_corrected(point: [f64; 3], views: &[[f64; 3]], f: &SpatialFrame) -> [f64; 3] {
    let (i, j, t, cos, sin, k) = view_interpolation(f, views.len());
    let (a, b) = (views[i], views[j]);
    let (x, y, z) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    let p = point;
    [
        p[0] + (f.origin[0] + x * cos - z * sin - p[0]) * k,
        p[1] + (f.origin[1] + y - p[1]) * k,
        p[2] + (f.origin[2] + x * sin + z * cos - p[2]) * k,
    ]
}

fn skin_point(point: [f64; 3], bindings: &[(u32, f64)], views: Option<&Vec<[f64; 3]>>, get: &dyn Fn(u32) -> Option<SpatialFrame>) -> Option<[f64; 3]> {
    if bindings.len() == 1 {
        let f = get(bindings[0].0)?;
        let p = match views {
            Some(v) if !v.is_empty() => view_corrected(point, v, &f),
            _ => point,
        };
        return Some(spatial_point(&f, p));
    }
    let first = get(bindings[0].0)?.q;
    let (mut x, mut y, mut z, mut w, mut dx, mut dy, mut dz, mut dw) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut stretch = false;
    let mut shaped = false;
    for &(joint, weight) in bindings {
        let f = get(joint)?;
        let (q, d) = (f.q, f.dual);
        stretch |= (f.stretch - 1.0).abs() > SPATIAL_EPS;
        shaped |= f.shape.is_some();
        let wgt = weight * if q[0] * first[0] + q[1] * first[1] + q[2] * first[2] + q[3] * first[3] < 0.0 { -1.0 } else { 1.0 };
        x += q[0] * wgt;
        y += q[1] * wgt;
        z += q[2] * wgt;
        w += q[3] * wgt;
        dx += d[0] * wgt;
        dy += d[1] * wgt;
        dz += d[2] * wgt;
        dw += d[3] * wgt;
    }
    if stretch {
        let mut p = [0.0; 3];
        for &(joint, weight) in bindings {
            let v = spatial_point(&get(joint)?, point);
            for i in 0..3 {
                p[i] += v[i] * weight;
            }
        }
        return Some(p);
    }
    let norm = norm(&[x, y, z, w]);
    let (x, y, z, w, dx, dy, dz, dw) = (x / norm, y / norm, z / norm, w / norm, dx / norm, dy / norm, dz / norm, dw / norm);
    let [a, b, c] = point;
    let (tx, ty, tz) = (2.0 * (y * c - z * b), 2.0 * (z * a - x * c), 2.0 * (x * b - y * a));
    let mut result = [
        a + w * tx + y * tz - z * ty + 2.0 * (-dw * x + dx * w - dy * z + dz * y),
        b + w * ty + z * tx - x * tz + 2.0 * (-dw * y + dx * z + dy * w - dz * x),
        c + w * tz + x * ty - y * tx + 2.0 * (-dw * z - dx * y + dy * x + dz * w),
    ];
    // Radial offsets blend in bind space and rotate with the same normalized quaternion.
    if shaped {
        let mut offset = [0.0; 3];
        for &(joint, weight) in bindings {
            let f = get(joint)?;
            if let Some(shape) = f.shape {
                let d = shape_offset(&f, shape, point);
                for i in 0..3 {
                    offset[i] += d[i] * weight;
                }
            }
        }
        let rotated = quat_rotate([x, y, z, w], offset);
        for i in 0..3 {
            result[i] += rotated[i];
        }
    }
    Some(result)
}

/// Periodic monotone cubic sampling of an angle path.
fn sample_angle_path(keys: &[[f64; 4]], angle: f64) -> [f64; 3] {
    let tau = 2.0 * PI;
    let mut t = ((angle % tau) + tau) % tau;
    let n = keys.len();
    let mut i = match keys.iter().rposition(|k| k[0] <= t) {
        Some(i) => i,
        None => {
            t += tau;
            n - 1
        }
    };
    if i >= n {
        i = n - 1;
    }
    let (a, b, before, after) = (keys[i], keys[(i + 1) % n], keys[(i + n - 1) % n], keys[(i + 2) % n]);
    let time_b = b[0] + if i == n - 1 { tau } else { 0.0 };
    let span = time_b - a[0];
    let u = (t - a[0]) / span;
    let prev_span = (a[0] - before[0] + tau) % tau;
    let next_span = (after[0] - b[0] + tau) % tau;
    let tangent = |left: f64, right: f64, h0: f64, h1: f64| if left * right <= 0.0 { 0.0 } else { (3.0 * (h0 + h1)) / ((2.0 * h1 + h0) / left + (h1 + 2.0 * h0) / right) };
    let mut out = [0.0; 3];
    let cube = styk_math::pow(u, 3.0);
    for k in 1..4 {
        let slope = (b[k] - a[k]) / span;
        let m0 = tangent((a[k] - before[k]) / prev_span, slope, prev_span, span);
        let m1 = tangent(slope, (after[k] - b[k]) / next_span, span, next_span);
        out[k - 1] = (2.0 * cube - 3.0 * u * u + 1.0) * a[k] + (cube - 2.0 * u * u + u) * span * m0 + (-2.0 * cube + 3.0 * u * u) * b[k] + (cube - u * u) * span * m1;
    }
    out
}

fn rig_width(ratio: f64, response: WidthResponse) -> f64 {
    match response {
        WidthResponse::Inverse => 1.0 / ratio.max(0.01),
        WidthResponse::Scale => ratio,
        WidthResponse::Keep => 1.0,
    }
}

/// Context of one object's rig evaluation.
pub struct Context<'a> {
    pub segments: &'a [crate::doc::Segment],
    pub index_of: &'a std::collections::HashMap<u32, u32>,
    pub plan: &'a RigPlan,
    pub root: [f64; 2],
    pub scale: f64,
    pub figure_angle: f64,
    pub mirror: bool,
    pub len_flag: bool,
    pub lengths: Option<&'a [f64]>,
    /// The pose's perspective (`projection(object, root)`); inverse kinematics evaluates without it.
    pub camera: Option<crate::spatial::Camera>,
    /// The pose's part proportions by bone handle (`_stykSpatial.shape`).
    pub shape: Option<&'a std::collections::BTreeMap<u32, crate::doc::SpatialShape>>,
}

/// `createRigEvaluation(...).evaluate(i, input, joints)`.
pub fn evaluate(ctx: &Context, states: &mut [Option<State>], i: usize, input: Input, joint: &dyn Fn(u32) -> Option<[f64; 2]>) -> State {
    let seg = &ctx.segments[i];
    let empty = Rig::default();
    let r = seg.rig.as_deref().unwrap_or(&empty);
    let idx = |id: u32| ctx.index_of.get(&id).map(|&x| x as usize);
    let state_of = |states: &[Option<State>], id: u32| idx(id).and_then(|k| states[k]);
    let parent = state_of(states, seg.parent);
    let rotation = if r.world { 0.0 } else { parent.map(|p| p.rotation).unwrap_or(0.0) };
    let root = ctx.root;
    if let Some(sp) = &r.spatial {
        let s = evaluate_spatial(ctx, states, sp, seg, &input);
        states[i] = Some(s);
        return s;
    }
    if let Some(w) = &r.weighted {
        let pos = |w: &Weighted| {
            let start = joint(w.origin).unwrap_or(root);
            let (mut dx, mut dy) = (0.0, 0.0);
            for &(j, weight) in &w.anchors {
                let p = joint(j).unwrap_or(root);
                dx += (p[0] - start[0]) * weight;
                dy += (p[1] - start[1]) * weight;
            }
            (start, dx, dy)
        };
        let (start, dx, dy) = pos(w);
        let angle = if hypot(dx, dy) < 1e-8 { input.angle } else { atan2(dy, dx) };
        let depth_offset = w.depth.as_deref().map(|depth| {
            let (start, dx, dy) = pos(depth);
            [start[0] + dx - root[0], start[1] + dy - root[1]]
        });
        let s = State {
            depth_offset,
            raw_point: None,
            start_raw: None,
            start,
            angle,
            authored_angle: angle,
            length: hypot(dx, dy),
            bend: 0.0,
            width: 1.0,
            handle: Some([start[0] + dx, start[1] + dy]),
            rotation: angle - input.angle,
            ratio: 1.0,
            impulse_angle: angle,
            spatial: None,
            path: None,
            space: Some(Space { rotation: angle - input.angle, follow: None }),
        };
        states[i] = Some(s);
        return s;
    }
    if let Some(path) = &r.path {
        let (x, y, z, delta, origin);
        match path.source.and_then(|src| state_of(states, src)).and_then(|s| s.path) {
            Some((o, d, depth)) if path.source.is_some() => {
                origin = o;
                delta = d;
                z = depth;
                x = depth;
                y = 0.0;
            }
            _ => {
                delta = ctx.figure_angle - path.figure_rest_angle;
                origin = joint(path.origin).unwrap_or(root);
                let turn = state_of(states, path.driver).map(|s| s.authored_angle).unwrap_or(0.0) - path.rest_angle - delta;
                let [px, py, pz] = sample_angle_path(&path.keys, turn);
                let (mut yy, mut zz) = (py, pz);
                if let Some(pitch_id) = path.pitch {
                    let pitch = state_of(states, pitch_id).map(|s| s.authored_angle).unwrap_or(0.0) - path.pitch_rest_angle - delta;
                    let (c, s) = (cos(pitch), sin(pitch));
                    let old = yy;
                    yy = old * c - zz * s;
                    zz = old * s + zz * c;
                }
                x = px;
                y = yy;
                z = zz;
            }
        }
        let (c, s) = (cos(delta), sin(delta));
        let (dx, dy) = ((x * c - y * s) * ctx.scale, (x * s + y * c) * ctx.scale);
        let angle = atan2(dy, dx);
        let st = State {
            start: origin,
            angle,
            authored_angle: angle,
            length: hypot(dx, dy),
            bend: 0.0,
            width: 1.0,
            handle: Some([origin[0] + dx, origin[1] + dy]),
            rotation: angle - input.angle,
            ratio: 1.0,
            impulse_angle: angle,
            spatial: None,
            path: Some((origin, delta, z)),
            space: Some(Space { rotation: delta, follow: None }),
            depth_offset: None,
            raw_point: None,
            start_raw: None,
        };
        states[i] = Some(st);
        return st;
    }
    let Input { mut start, mut angle, mut length, mut bend } = input;
    let input_angle = angle;
    let mut width = 1.0;
    let mut inherited = rotation;
    let mut ratio = 1.0;
    let mut handle = None;
    let mut position = 0.0;
    let mut span = 0.0;
    angle += rotation;
    let source = ctx.plan.inputs[i];
    let driver = source.and_then(|s| states[s.driver]);
    let mut locked_angle = 0.0;
    if let Some(lock) = &r.lock {
        let figure_delta = if lock.mode == LockMode::Parent { lock.figure_rest_angle.map(|fr| ctx.figure_angle - fr).unwrap_or(0.0) } else { 0.0 };
        let reference = if lock.mode == LockMode::Parent { state_of(states, lock.reference) } else { None };
        let difference = match lock.mode {
            LockMode::Parent => {
                let rf = reference.unwrap_or_default();
                (if lock.authored { rf.authored_angle } else { rf.angle }) - lock.rest_angle - figure_delta
            }
            LockMode::Figure => ctx.figure_angle - lock.rest_angle,
            LockMode::World => 0.0,
        };
        locked_angle = lock.angle + figure_delta + lock.multiplier * wrap(difference);
        if let Some((sref, srest, smul)) = lock.secondary {
            let other = state_of(states, sref).unwrap_or_default();
            let delta = (if lock.authored { other.authored_angle } else { other.angle }) - srest - figure_delta;
            locked_angle += smul * wrap(delta);
        }
        if lock.authored {
            angle = locked_angle;
            inherited = angle - input_angle;
        }
    }
    let raw_angle = angle;
    let incoming = driver.map(|d| d.ratio).unwrap_or(1.0);
    let mut follow_scale = None;
    let mut follow_axis_used = 0.0;
    let response = r.response.as_ref();
    if let Some(c) = &r.connector {
        start = joint(c.start).unwrap_or(root);
        let end = joint(c.end).unwrap_or(root);
        let (dx, dy) = (end[0] - start[0], end[1] - start[1]);
        let distance = hypot(dx, dy);
        span = distance;
        bend = bend.clamp(-PI * 1.99, PI * 1.99);
        let factor = if bend.abs() < EPS { 1.0 } else { 2.0 * sin(bend / 2.0) / bend };
        angle = if distance > EPS { atan2(dy, dx) - bend / 2.0 } else { input_angle + rotation };
        length = distance / factor;
        inherited = angle - input_angle - if ctx.scale < 0.0 { PI } else { 0.0 };
        let raw_position = if ctx.len_flag { ctx.lengths.and_then(|l| l.get(i).copied()).unwrap_or(seg.length) } else { seg.length };
        let t = raw_position.clamp(0.0, 1.0);
        let sweep = bend * t;
        position = t;
        handle = Some(if bend.abs() < EPS {
            [start[0] + dx * t, start[1] + dy * t]
        } else {
            [start[0] + length / bend * (sin(angle + sweep) - sin(angle)), start[1] + length / bend * (cos(angle) - cos(angle + sweep))]
        });
    } else if let Some(src) = source {
        let mode_stretch = match response.map(|x| x.mode) {
            Some(ResponseMode::Stretch) => true,
            Some(_) => false,
            None => !r.follow.as_ref().is_some_and(|f| f.rigid),
        };
        if mode_stretch {
            let driver_rig = ctx.segments[src.driver].rig.as_deref();
            let width_response = driver_rig.and_then(|d| d.stretch.as_ref()).map(|s| s.width).unwrap_or(WidthResponse::Keep);
            let influence = r.follow.as_ref().map(|f| f.influence).unwrap_or(1.0);
            let amount = if src.legacy && response.and_then(|x| x.multiplier).is_none() {
                ((if incoming < 0.0 { -1.0 } else { 1.0 }) * styk_math::pow(if influence < 0.0 { incoming.abs().max(0.01) } else { incoming.abs() }, influence)).clamp(-100.0, 100.0)
            } else {
                (1.0 + (incoming - 1.0) * response.and_then(|x| x.multiplier).unwrap_or(1.0)).clamp(-100.0, 100.0)
            };
            let follow_axis = if response.is_some_and(|x| x.reset) { angle } else { states[src.axis].map(|s| s.impulse_angle).unwrap_or(angle) };
            follow_scale = Some(amount);
            follow_axis_used = follow_axis;
            let relative = angle - follow_axis;
            let (x, y) = (cos(relative) * amount, sin(relative));
            let factor = hypot(x, y);
            angle = if factor < EPS { angle } else { follow_axis + atan2(y, x) };
            length *= factor;
            width *= rig_width(amount.abs(), width_response);
        }
    }
    if let Some(d) = &r.stretch {
        let c = r.connector.is_some();
        let mut actual = (if c && d.branch { span } else { length.abs() }) / (ctx.scale.abs().max(EPS) * d.rest_length);
        if c {
            match d.source {
                Some(StretchSource::Slide) => actual = position / d.rest_position,
                Some(StretchSource::Combined) => actual *= position / d.rest_position,
                _ => {}
            }
            if source.is_some() && response.map(|x| x.mode) != Some(ResponseMode::Rigid) {
                actual *= (1.0 + (incoming - 1.0) * response.and_then(|x| x.multiplier).unwrap_or(1.0)).clamp(-100.0, 100.0);
            }
        }
        ratio = if c { (if actual < 0.0 { -1.0 } else { 1.0 }) * actual.abs().clamp(d.min, d.max) } else { actual.clamp(d.min, d.max) };
        if !c && actual > EPS {
            length *= ratio / actual;
        } else if !c {
            length = d.rest_length * ratio * ctx.scale;
        }
        width *= rig_width(ratio.abs(), d.width);
    }
    if let Some(lock) = &r.lock
        && !lock.authored
    {
        angle = locked_angle;
        inherited = angle - input_angle;
    }
    let c = r.connector.is_some();
    let authored_angle = if c || r.lock.as_ref().is_some_and(|l| !l.authored) { angle } else { raw_angle };
    // `rotation || followScale !== undefined || lock`: NaN and zero rotations are falsy.
    let space = (rotation != 0.0 && !rotation.is_nan() || follow_scale.is_some() || r.lock.is_some())
        .then(|| Space { rotation, follow: follow_scale.map(|amount| (follow_axis_used, amount)) });
    let st = State {
        start,
        angle,
        authored_angle,
        length,
        bend,
        width,
        handle,
        rotation: inherited,
        ratio,
        impulse_angle: if c {
            angle
        } else if response.is_some_and(|x| x.reset) {
            raw_angle
        } else {
            angle
        },
        spatial: None,
        path: None,
        space,
        depth_offset: None,
        raw_point: None,
        start_raw: None,
    };
    states[i] = Some(st);
    st
}

fn evaluate_spatial(ctx: &Context, states: &[Option<State>], sp: &Spatial, seg: &crate::doc::Segment, input: &Input) -> State {
    let idx = |id: u32| ctx.index_of.get(&id).map(|&x| x as usize);
    let get = |id: u32| idx(id).and_then(|k| states[k]).and_then(|s| s.spatial);
    let (cs, sn) = (cos(ctx.figure_angle), sin(ctx.figure_angle));
    let sign = if ctx.mirror { -1.0 } else { 1.0 };
    let root = ctx.root;
    let scale = ctx.scale;
    // The figure's rotation, scale and reflection, then the pose's perspective. The
    // second value is the point before perspective (`rawPoint`).
    let project = |p: [f64; 3]| -> ([f64; 2], Option<[f64; 3]>) {
        let flat = [root[0] + (p[0] * cs - p[1] * sign * sn) * scale, root[1] + (p[0] * sn + p[1] * sign * cs) * scale];
        match &ctx.camera {
            Some(camera) => {
                let raw = [flat[0], flat[1], p[2] * scale];
                (camera.project(raw), Some(raw))
            }
            None => (flat, None),
        }
    };
    let mut start = input.start;
    let mut start_raw = None;
    let mut spatial = None;
    let point = match sp {
        Spatial::Skin { point, bindings, view_points } => skin_point(*point, bindings, view_points.as_ref(), &get).unwrap_or(*point),
        Spatial::Bone { parent, turn, pitch, origin, tip, motion } => {
            let parent_frame = if *parent != 0 { get(*parent) } else { None };
            let parent_bend = parent_frame.map(|p| p.native_bend).unwrap_or(0.0);
            let parent_authored = parent_frame.map(|p| p.authored_bend).unwrap_or(parent_bend);
            let v = [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]];
            let length = norm(&v);
            let axis = if length > SPATIAL_EPS { [v[0] / length, v[1] / length, v[2] / length] } else { [0.0, 1.0, 0.0] };
            let authored_bend = (input.angle - ctx.figure_angle) * sign - seg.angle;
            let driver = motion.as_ref().and_then(|m| m.driver).map(|(j, mul)| get(j).map(|f| f.motion_value).unwrap_or(0.0) * mul).unwrap_or(0.0);
            let (local, native_bend, travel, motion_value);
            match motion {
                Some(m) if m.hinge => {
                    let mv = (wrap(authored_bend - parent_authored) + driver).clamp(m.min, m.max);
                    local = axis_quaternion(m.axis.unwrap_or([0.0, 0.0, 1.0]), mv);
                    native_bend = parent_bend + mv;
                    travel = 0.0;
                    motion_value = mv;
                }
                Some(m) => {
                    let len = if scale.abs() > SPATIAL_EPS { input.length / scale } else { length };
                    let mv = (len - length + driver).clamp(m.min, m.max);
                    local = [0.0, 0.0, 0.0, 1.0];
                    native_bend = parent_bend;
                    travel = mv;
                    motion_value = mv;
                }
                None => {
                    let rest = |id: u32| idx(id).map(|k| ctx.segments[k].angle).unwrap_or(0.0);
                    let authored = |id: u32| idx(id).and_then(|k| states[k]).map(|s| s.authored_angle).unwrap_or(0.0);
                    let t = (authored(*turn) - ctx.figure_angle) * sign - rest(*turn);
                    let p = (authored(*pitch) - ctx.figure_angle) * sign - rest(*pitch);
                    let bend = authored_bend - parent_authored;
                    local = spatial_quaternion(bend, t, p);
                    native_bend = parent_bend + bend;
                    travel = 0.0;
                    motion_value = 0.0;
                }
            }
            let q = match parent_frame {
                Some(pf) => quat_multiply(pf.q, local),
                None => local,
            };
            let mut o = match parent_frame {
                Some(pf) => spatial_point(&pf, *origin),
                None => *origin,
            };
            if travel != 0.0 {
                let direction = quat_rotate(q, axis);
                for k in 0..3 {
                    o[k] += direction[k] * travel;
                }
            }
            let rotated = quat_rotate(q, *origin);
            let t = [o[0] - rotated[0], o[1] - rotated[1], o[2] - rotated[2]];
            let stretch = if motion.is_none() && length > SPATIAL_EPS && scale.abs() > SPATIAL_EPS { input.length / scale / length } else { 1.0 };
            let dual = quat_multiply([t[0], t[1], t[2], 0.0], q).map(|n| n * 0.5);
            // A hidden expression loses its area instead of flattening into a card.
            let choice_scale = seg.choice_scale.then_some(stretch);
            let shape = ctx.shape.and_then(|shapes| shapes.get(&seg.id)).copied().filter(|shape| shape.width != 1.0 || shape.taper != 0.0);
            let rest_length = if shape.is_some() { length.max(SPATIAL_EPS) } else { 0.0 };
            let frame = SpatialFrame { q, t, dual, native_bend, authored_bend, motion_value, origin: *origin, axis, stretch, choice_scale, shape, rest_length };
            spatial = Some(frame);
            (start, start_raw) = project(o);
            spatial_point(&frame, *tip)
        }
    };
    let (handle, raw_point) = project(point);
    let (dx, dy) = (handle[0] - start[0], handle[1] - start[1]);
    let span = hypot(dx, dy);
    let angle = if span < SPATIAL_EPS { input.angle } else { atan2(dy, dx) };
    State {
        // Depth guides use the same figure rotation and scale as the surface reference X.
        depth_offset: Some([point[2] * scale * cs, point[2] * scale * sn]),
        raw_point,
        start_raw,
        start,
        angle,
        authored_angle: input.angle,
        length: span,
        bend: 0.0,
        width: 1.0,
        handle: Some(handle),
        rotation: angle - input.angle,
        ratio: 1.0,
        impulse_angle: angle,
        spatial,
        path: None,
        space: Some(Space { rotation: angle - input.angle, follow: None }),
    }
}
