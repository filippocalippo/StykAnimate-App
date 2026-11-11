//! Animation origins (src/animation-origin.mjs, src/animation-origin-support.mjs).
//!
//! Set Origin re-roots a figure's construction tree at another joint while its
//! animation keeps the original pivot and joint basis: a pose stores where that
//! pivot is (`_stykAnimationOrigin`: `x`, `y`, an optional local `offsetX`/`offsetY`)
//! and tweens move the pivot, not the new root; each tween interpolates the angles of
//! the original tree (the construction tree turned back at the origin), and the root
//! is then placed so the pivot lands where the pose says (`correctAnimationOrigins`).
//! When later construction edits remove joints of the original tree, the figure keeps
//! it as a retained support graph (`support`: bones bound to live segments or ghosts,
//! whose poses the pose stores in `ghosts`).
//!
//! Arithmetic is the editor's, operation for operation, with V8's trigonometry
//! (`styk-math`, D16): the corrected root is a stored value once a gesture commits.

use std::collections::{BTreeMap, HashMap, HashSet};

use styk_doc::Value;
use styk_math::{cos, sin};

use crate::doc::{Figure, Object, Segment};

/// `_styk.animationOrigin` of a figure, compiled against its segments.
#[derive(Clone, Debug)]
pub struct Origin {
    /// The original tree's root handle (`handleId`; `None` with a support graph that lost it).
    pub handle: Option<u32>,
    /// `rotationHandleId`: the segment whose turn is the figure's rotation.
    pub rotation_handle: Option<u32>,
    pub reversed: bool,
    pub kind: Kind,
}

#[derive(Clone, Debug)]
pub enum Kind {
    /// The original tree re-derived from the live segments (`animationOriginLayout`).
    Layout(Layout),
    /// The retained original tree (`support`, `originSupportLayout`).
    Support(Support),
}

/// `animationOriginLayout`: the live segments as a tree rooted at the original pivot.
#[derive(Clone, Debug, Default)]
pub struct Layout {
    /// Segment indices breadth first from the pivot.
    pub ready: Vec<usize>,
    /// Per segment: the segment it hangs from in that tree (`None` at the pivot).
    pub parents: Vec<Option<usize>>,
    /// Per segment: whether the tree walks it against its construction direction.
    pub reversed: Vec<bool>,
    /// Segment indices from the construction root to the pivot handle.
    pub path: Vec<usize>,
    /// The segment index of the rotation handle.
    pub rotation: Option<usize>,
    /// By handle: the segment the walk from the pivot reaches it through (`endpoints`).
    pub endpoints: HashMap<u32, usize>,
}

/// One bone of a retained support graph.
#[derive(Clone, Copy, Debug)]
pub struct Bone {
    /// The live segment it is bound to (`handleId`), or `None` for a ghost.
    pub segment: Option<usize>,
    pub parent: Option<usize>,
    pub reversed: bool,
    /// The bone's rest pose.
    pub rest: GhostPose,
}

#[derive(Clone, Debug, Default)]
pub struct Support {
    pub bones: Vec<Bone>,
    /// Bone indices, parents before children (`ready`).
    pub ready: Vec<usize>,
    /// `{bone, sign}` terms from the construction root to the pivot.
    pub path: Vec<(usize, f64)>,
    /// The bone whose turn is the figure's rotation.
    pub rotation: usize,
    /// By handle: the bone ending there, or `-1` at the original pivot (`vertices`).
    pub vertices: HashMap<u32, i64>,
}

/// A bone's or ghost's pose: angle, bend and length.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GhostPose {
    pub angle: f64,
    pub bend: f64,
    pub length: f64,
}

/// `_stykAnimationOrigin` of a pose.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PoseOrigin {
    pub x: f64,
    pub y: f64,
    /// `offsetX`, `offsetY` (each kept only when present).
    pub offset: [Option<f64>; 2],
    /// Ghost bone poses by bone index.
    pub ghosts: BTreeMap<usize, GhostPose>,
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn ghost(v: &Value) -> Option<GhostPose> {
    Some(GhostPose { angle: num(v, "angle_rad")?, bend: num(v, "bend_rad")?, length: num(v, "length")? })
}

/// Reads a pose's `_stykAnimationOrigin` (`None` when it has none or it is malformed).
pub fn parse_pose(v: &Value) -> Option<PoseOrigin> {
    if !v.is_object() {
        return None;
    }
    let ghosts = match v.get("ghosts") {
        Some(Value::Obj(map)) => map.iter().filter_map(|(key, pose)| Some((key.parse::<usize>().ok()?, ghost(pose)?))).collect(),
        _ => BTreeMap::new(),
    };
    Some(PoseOrigin { x: num(v, "x")?, y: num(v, "y")?, offset: [num(v, "offsetX"), num(v, "offsetY")], ghosts })
}

/// Compiles a figure's `_styk.animationOrigin` against its segments. `Err` names why the
/// editor would refuse it.
pub fn compile(v: &Value, segments: &[Segment]) -> Result<Origin, String> {
    let ids: HashMap<u32, usize> = segments.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
    // The editor validates descriptor numbers before arithmetic/indexing. Never turn
    // malformed known fields into truncated indices or silently drop raw vertices.
    let integer = |value: Option<&Value>, low: f64, high: f64| {
        value.and_then(Value::as_f64).filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= low && *n <= high)
    };
    let id = |key: &str| -> Option<u32> { integer(v.get(key), 0.0, u32::MAX as f64).map(|n| n as u32) };
    let reversed = match v.get("reversed") {
        Some(Value::Bool(reversed)) => *reversed,
        _ => return Err("an origin's reversed field is not boolean".into()),
    };
    let (handle, rotation_handle) = (id("handleId"), id("rotationHandleId"));
    if let Some(support) = v.get("support") {
        if !support.is_object() || num(support, "version") != Some(1.0) {
            return Err("a support graph needs version 1".into());
        }
        let raw_bones = support.get("bones").and_then(Value::as_arr).filter(|bones| !bones.is_empty() && bones.len() <= 100000)
            .ok_or("a support graph needs 1 to 100000 bones")?;
        let high = raw_bones.len() as f64 - 1.0;
        let mut bound = HashSet::new();
        let mut bones = Vec::with_capacity(raw_bones.len());
        for b in raw_bones {
            let segment = match b.get("handleId") {
                Some(Value::Null) => None,
                value => {
                    let handle = integer(value, 1.0, 65535.0).ok_or("a support bone's handle is not a native integer")? as u32;
                    let index = *ids.get(&handle).ok_or("a support bone names a missing segment")?;
                    if !bound.insert(handle) { return Err("a support bone repeats a live binding".into()); }
                    Some(index)
                }
            };
            let parent = integer(b.get("parent"), -1.0, high).ok_or("a support bone's parent is out of range")?;
            let reversed = match b.get("reversed") {
                Some(Value::Bool(reversed)) => *reversed,
                _ => return Err("a support bone's reversed field is not boolean".into()),
            };
            let rest = ghost(b).filter(|pose| pose.angle.is_finite() && pose.bend.is_finite() && (pose.length as f32).is_finite())
                .ok_or("a support bone without a finite native pose")?;
            bones.push(Bone { segment, parent: (parent >= 0.0).then_some(parent as usize), reversed, rest });
        }
        if bound.len() != ids.len() { return Err("the retained support is missing a live binding".into()); }
        // Parents before children, roots in order (`originSupportLayout`).
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); bones.len()];
        let mut ready: Vec<usize> = Vec::with_capacity(bones.len());
        for (i, bone) in bones.iter().enumerate() {
            match bone.parent {
                None => ready.push(i),
                Some(p) => children[p].push(i),
            }
        }
        let mut cursor = 0;
        while cursor < ready.len() {
            let next = children[ready[cursor]].clone();
            ready.extend(next);
            cursor += 1;
        }
        if ready.len() != bones.len() {
            return Err("the retained animation support contains a cycle".into());
        }
        let path = support.get("path").and_then(Value::as_arr).filter(|path| path.len() <= 100000)
            .ok_or("a support path is missing or exceeds capacity")?.iter().map(|term| {
                let bone = integer(term.get("bone"), 0.0, high)? as usize;
                let sign = num(term, "sign").filter(|sign| *sign == 1.0 || *sign == -1.0)?;
                Some((bone, sign))
            }).collect::<Option<Vec<_>>>().ok_or("a support path term is malformed")?;
        let rotation = integer(support.get("rotation"), 0.0, high).ok_or("a support rotation out of range")? as usize;
        let raw_vertices = support.get("vertices").and_then(Value::as_obj).ok_or("support vertices are not a record")?;
        let mut vertices = HashMap::new();
        let mut nodes = HashSet::new();
        for (key, node) in raw_vertices.iter() {
            let handle = key.parse::<u32>().ok().filter(|id| id.to_string() == key.as_ref() && (*id == 0 || ids.contains_key(id)))
                .ok_or("a support vertex key is not an exact native handle")?;
            let node = integer(Some(node), -1.0, high).ok_or("a support vertex is out of range")? as i64;
            if !nodes.insert(node) { return Err("support vertices repeat a node".into()); }
            vertices.insert(handle, node);
        }
        if vertices.len() != ids.len() + 1 { return Err("support vertices omit a native handle".into()); }
        if v.get("handleId") != Some(&Value::Null) && !handle.is_some_and(|id| vertices.get(&id) == Some(&-1)) {
            return Err("a support origin does not name its virtual root".into());
        }
        let rotation_bone = bones[rotation];
        let rotation_id = rotation_bone.segment.map(|i| segments[i].id);
        if rotation_handle != rotation_id || rotation_id.is_none() && v.get("rotationHandleId") != Some(&Value::Null)
            || rotation_id.is_some() && reversed != rotation_bone.reversed {
            return Err("a support origin's rotation reference differs from its bone".into());
        }
        return Ok(Origin { handle, rotation_handle, reversed, kind: Kind::Support(Support { bones, ready, path, rotation, vertices }) });
    }
    if !rotation_handle.is_some_and(|handle| ids.contains_key(&handle)) {
        return Err("an origin without a native rotation handle".into());
    }
    // `animationOriginLayout`: breadth first from the pivot over the undirected segments,
    // each node's edges in segment order.
    let handle_id = handle.ok_or("an origin without a pivot handle")?;
    let mut adjacency: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
    for (index, segment) in segments.iter().enumerate() {
        adjacency.entry(segment.parent).or_default().push((segment.id, index));
        adjacency.entry(segment.id).or_default().push((segment.parent, index));
    }
    let n = segments.len();
    let mut layout = Layout { parents: vec![None; n], reversed: vec![false; n], ..Default::default() };
    let mut queue: Vec<(u32, Option<usize>)> = vec![(handle_id, None)];
    let mut seen = std::collections::HashSet::from([handle_id]);
    let mut q = 0;
    while q < queue.len() {
        let (node, via) = queue[q];
        for &(other, index) in adjacency.get(&node).map(Vec::as_slice).unwrap_or(&[]) {
            if !seen.insert(other) {
                continue;
            }
            layout.ready.push(index);
            layout.parents[index] = via;
            layout.reversed[index] = segments[index].parent != node;
            layout.endpoints.insert(other, index);
            queue.push((other, Some(index)));
        }
        q += 1;
    }
    let mut node = handle_id;
    while node != 0 {
        let index = *ids.get(&node).ok_or("the animation pivot no longer belongs to its figure")?;
        if layout.path.len() >= n {
            return Err("the animation pivot no longer belongs to its figure".into());
        }
        layout.path.push(index);
        node = segments[index].parent;
    }
    layout.path.reverse();
    layout.rotation = rotation_handle.and_then(|h| ids.get(&h).copied());
    Ok(Origin { handle, rotation_handle, reversed, kind: Kind::Layout(layout) })
}

/// `animationOriginBend`: a segment's bend as the pose stores it, negated when walked backwards.
pub fn bend(figure: &Figure, object: Option<&Object>, index: usize, reversed: bool) -> f64 {
    let value = match object.and_then(|o| o.bends.as_ref()) {
        Some(bends) => bends.get(index).copied().unwrap_or(f64::NAN),
        None => figure.segments[index].bend,
    };
    if reversed { -value } else { value }
}

/// `animationOriginAngle`: a segment's angle as the pose stores it; walked backwards it
/// points the other way from its end, past its bend.
pub fn angle(figure: &Figure, object: Option<&Object>, index: usize, reversed: bool) -> f64 {
    let value = match object {
        Some(o) => o.angles.get(index).copied().unwrap_or(figure.segments[index].angle),
        None => figure.segments[index].angle,
    };
    value + if reversed { bend(figure, object, index, false) + std::f64::consts::PI } else { 0.0 }
}

/// `originSupportPose`: a support bone's pose in `object` (the rest pose without one).
pub fn support_pose(figure: &Figure, object: Option<&Object>, support: &Support, index: usize) -> GhostPose {
    let bone = &support.bones[index];
    let Some(native) = bone.segment else {
        return object.and_then(|o| o.origin.as_ref()).and_then(|origin| origin.ghosts.get(&index)).copied().unwrap_or(bone.rest);
    };
    let Some(object) = object else { return bone.rest };
    let segment = &figure.segments[native];
    let bend = match &object.bends {
        Some(bends) => bends.get(native).copied().unwrap_or(f64::NAN),
        None => segment.bend,
    };
    let length = match &object.lengths {
        Some(lengths) => lengths.get(native).copied().unwrap_or(f64::NAN),
        None => segment.length,
    };
    let angle = object.angles.get(native).copied().unwrap_or(f64::NAN) + if bone.reversed { bend + std::f64::consts::PI } else { 0.0 };
    GhostPose { angle, bend: if bone.reversed { -bend } else { bend }, length }
}

/// `animationOriginHandleOrientation`: the direction of joint `handle` in the original
/// tree's basis (where a figure joined there hangs). `None` for a handle the tree does not
/// reach; NaN where the editor reads an undefined segment.
pub fn handle_orientation(figure: &Figure, object: &Object, handle: u32) -> Option<f64> {
    let origin = figure.origin.as_ref()?;
    match &origin.kind {
        Kind::Support(support) => {
            let node = *support.vertices.get(&handle)?;
            let index = if node < 0 { support.rotation } else { node as usize };
            if index >= support.bones.len() {
                return Some(f64::NAN);
            }
            let pose = support_pose(figure, Some(object), support, index);
            Some(pose.angle + if node < 0 { 0.0 } else { pose.bend })
        }
        Kind::Layout(layout) => {
            if Some(handle) == origin.handle {
                return Some(layout.rotation.map_or(f64::NAN, |index| angle(figure, Some(object), index, origin.reversed)));
            }
            let index = *layout.endpoints.get(&handle)?;
            let reverse = layout.reversed[index];
            Some(angle(figure, Some(object), index, reverse) + bend(figure, Some(object), index, reverse))
        }
    }
}

/// `animationRotation`: how far the pose turned the figure from its rest angle.
pub fn rotation(figure: &Figure, object: &Object) -> f64 {
    let Some(origin) = &figure.origin else {
        return object.angles.first().copied().unwrap_or(0.0) - figure.segments.first().map(|s| s.angle).unwrap_or(0.0);
    };
    match &origin.kind {
        Kind::Support(support) => support_pose(figure, Some(object), support, support.rotation).angle - support.bones[support.rotation].rest.angle,
        Kind::Layout(layout) => match layout.rotation {
            Some(index) => angle(figure, Some(object), index, origin.reversed) - angle(figure, None, index, origin.reversed),
            // `ids.get(rotationHandleId)` undefined: the editor reads NaN.
            None => f64::NAN,
        },
    }
}

/// An arc's chord: a segment of `length` leaving at `angle` and turning by `bend`.
fn chord(angle: f64, bend: f64, length: f64) -> [f64; 2] {
    if bend.abs() < 1e-7 {
        [length * cos(angle), length * sin(angle)]
    } else {
        let radius = length / bend;
        [radius * (sin(angle + bend) - sin(angle)), radius * (cos(angle) - cos(angle + bend))]
    }
}

/// `animationOriginOffset`: from the construction root to the animation pivot.
pub fn offset(figure: &Figure, object: &Object) -> [f64; 2] {
    let Some(origin) = &figure.origin else { return [0.0, 0.0] };
    let scale = object.scale;
    let mut point = [0.0, 0.0];
    match &origin.kind {
        Kind::Support(support) => {
            for &(bone, sign) in &support.path {
                let pose = support_pose(figure, Some(object), support, bone);
                let [dx, dy] = chord(pose.angle, pose.bend, pose.length * scale * sign);
                point = [point[0] + dx, point[1] + dy];
            }
        }
        Kind::Layout(layout) => {
            for &index in &layout.path {
                let length = match &object.lengths {
                    Some(lengths) => lengths.get(index).copied().unwrap_or(f64::NAN),
                    None => figure.segments[index].length,
                } * scale;
                let [dx, dy] = chord(angle(figure, Some(object), index, false), bend(figure, Some(object), index, false), length);
                point = [point[0] + dx, point[1] + dy];
            }
        }
    }
    if let Some(pose) = &object.origin {
        let [x, y] = [pose.offset[0].unwrap_or(0.0), pose.offset[1].unwrap_or(0.0)];
        // `origin.offsetX || origin.offsetY`: zero and NaN are falsy.
        if (x != 0.0 && !x.is_nan()) || (y != 0.0 && !y.is_nan()) {
            let turn = rotation(figure, object);
            let (c, s) = (cos(turn), sin(turn));
            point = [point[0] + scale * (x * c - y * s), point[1] + scale * (x * s + y * c)];
        }
    }
    point
}

/// The root that puts the animation pivot where `object`'s pose says it is
/// (`correctAnimationOrigins`), when it differs from the stored root by more than 1e-10.
pub fn corrected_root(figure: &Figure, object: &Object) -> Option<[f64; 2]> {
    let pose = object.origin.as_ref()?;
    if figure.origin.is_none() || object.join.is_some() {
        return None;
    }
    let [ox, oy] = offset(figure, object);
    let (x, y) = (pose.x - ox, pose.y - oy);
    let close = |a: f64, b: f64| (a - b).abs() < 1e-10;
    (!(close(x, object.root[0]) && close(y, object.root[1]))).then_some([x, y])
}

/// Reads one value of the pose at the keys around a tween (`parameter`): `read` takes a
/// key's object, `angular` unwraps angles.
pub type Sample<'a> = &'a dyn Fn(&dyn Fn(&Object) -> f64, bool) -> f64;

/// The tweened angles of a figure whose origin is re-derived from its segments: the angles
/// of the original tree, relative to their parents there, interpolated as before Set Origin
/// (interpolating the re-rooted tree would change wrapping and easing), then turned back.
/// `out` holds the tweened bends.
pub fn tween_layout(figure: &Figure, layout: &Layout, out: &Object, sample: Sample<'_>) -> Vec<f64> {
    let n = figure.segments.len();
    let mut virtual_angles = vec![f64::NAN; n];
    for &i in &layout.ready {
        let (parent, reversed) = (layout.parents[i], layout.reversed[i]);
        let relative = sample(
            &|item: &Object| {
                let mut value = angle(figure, Some(item), i, reversed);
                if let Some(p) = parent {
                    value -= angle(figure, Some(item), p, layout.reversed[p]) + bend(figure, Some(item), p, layout.reversed[p]);
                }
                value
            },
            true,
        );
        virtual_angles[i] = relative + parent.map_or(0.0, |p| virtual_angles[p] + bend(figure, Some(out), p, layout.reversed[p]));
    }
    // A segment the original tree does not reach is a hole in the editor's angles, which
    // geometry reads as the segment's rest angle.
    let mut reached = vec![false; n];
    for &i in &layout.ready {
        reached[i] = true;
    }
    (0..n)
        .map(|i| match reached[i] {
            true => virtual_angles[i] + if layout.reversed[i] { bend(figure, Some(out), i, true) + std::f64::consts::PI } else { 0.0 },
            false => figure.segments[i].angle,
        })
        .collect()
}

/// `interpolateOriginSupport`: the retained tree's bones interpolated as their own tree;
/// live segments take their bone's angle, ghosts their whole pose. Writes `out`'s angles
/// (starting from `angles`, the first key's) and its origin's ghosts.
pub fn tween_support(figure: &Figure, support: &Support, angles: &[f64], out: &mut Object, sample: Sample<'_>) {
    let count = support.bones.len();
    let (mut turned, mut bends) = (vec![f64::NAN; count], vec![f64::NAN; count]);
    let mut ghosts: BTreeMap<usize, GhostPose> = BTreeMap::new();
    for &index in &support.ready {
        let bone = support.bones[index];
        bends[index] = sample(&|item: &Object| support_pose(figure, Some(item), support, index).bend, false);
        if bone.segment.is_none() {
            let length = sample(&|item: &Object| support_pose(figure, Some(item), support, index).length, false);
            ghosts.insert(index, GhostPose { angle: f64::NAN, bend: bends[index], length });
        }
        let relative = sample(
            &|item: &Object| {
                let pose = support_pose(figure, Some(item), support, index);
                match bone.parent {
                    None => pose.angle,
                    Some(p) => {
                        let parent = support_pose(figure, Some(item), support, p);
                        pose.angle - parent.angle - parent.bend
                    }
                }
            },
            true,
        );
        turned[index] = relative + bone.parent.map_or(0.0, |p| turned[p] + bends[p]);
        // The legacy reversed-edge round trip adds one turn to a hidden edge's stored angle.
        if let Some(ghost) = ghosts.get_mut(&index) {
            ghost.angle = turned[index] + if bone.reversed { 2.0 * std::f64::consts::PI } else { 0.0 };
        }
    }
    let mut out_angles = angles.to_vec();
    for (index, bone) in support.bones.iter().enumerate() {
        if let Some(segment) = bone.segment {
            if out_angles.len() <= segment {
                out_angles.resize(segment + 1, f64::NAN);
            }
            out_angles[segment] = turned[index] + if bone.reversed { bends[index] + std::f64::consts::PI } else { 0.0 };
        }
    }
    out.angles = out_angles.into();
    if !ghosts.is_empty() {
        let mut origin = out.origin.as_deref().cloned().unwrap_or(PoseOrigin { x: f64::NAN, y: f64::NAN, ..Default::default() });
        origin.ghosts = ghosts;
        out.origin = Some(std::sync::Arc::new(origin));
    }
}
