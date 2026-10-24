//! The tweener (src/editor-tweener.mjs): a gesture that poses the selected figures between the keys on
//! either side of the playhead. `beginTween` plans it once (the neighbouring poses and the blends
//! between them); `updateTween` poses the draft from a mode and an amount; the gesture ends with the
//! ordinary `commitDrag` or `cancelDrag`, which key the playhead on the layers it posed.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Value};
use styk_eval::eval::Prepared;
use styk_eval::records::{snapshot_pose_frame_of, Records};
use styk_math::shortest;

use crate::record::uid;
use crate::sheet::{items, key_at, num};
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

const MODES: [&str; 4] = ["breakdown", "neighbor", "push", "relax"];
/// The pose fields a tween writes (`fields` in the editor).
const FIELDS: [&str; 10] = ["root_x", "root_y", "scale", "angles", "len_flag", "lengths", "bend_flag", "bends", "_stykAnimationOrigin", "_stykSpatial"];

/// A document of two poses with linear easing between them (`blendReport`), and the typed views to sample it.
#[derive(Clone)]
pub(crate) struct Blend {
    tree: Value,
    prepared: Arc<Prepared>,
}

impl std::fmt::Debug for Blend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Blend").finish_non_exhaustive()
    }
}

impl Blend {
    /// `evaluatedNativeFrame(report, 0, t)`.
    fn sample(&self, t: f64) -> Result<Value, EditError> {
        Ok(Records::new(&self.tree, &self.prepared)?.native_interval(0, t)?)
    }

    /// The first pose's figures, by identity (`report.keyframes[0].objects`).
    fn start(&self) -> HashMap<u32, Value> {
        items(self.tree.path(&["keyframes"]).and_then(|frames| frames.item(0)).as_ref().and_then(|frame| frame.get("objects"))).into_iter().filter_map(|o| Some((uid(&o)?, o))).collect()
    }
}

/// One pair of neighbouring keys and the figures between them.
#[derive(Clone, Debug)]
struct Plan {
    uids: Vec<u32>,
    between: Blend,
    left: Blend,
    right: Blend,
    relax: Blend,
    /// The figures as they were when the gesture began (`plan.relax.keyframes[0]`).
    start: HashMap<u32, Value>,
}

/// `_drag.tweener`.
#[derive(Clone, Debug)]
pub(crate) struct Tweener {
    plans: Vec<Plan>,
}

/// `tweenNeighbors(keys, tick)`: the keys strictly either side of `tick` that are not boundaries or hidden.
fn neighbors(keys: &[Value], tick: f64) -> (Option<&Value>, Option<&Value>) {
    let flagged = |key: &Value| key.get("patchOnly").is_some_and(Value::truthy) || key.get("hidden").is_some_and(Value::truthy);
    let mut index = key_at(keys, tick).map_or(-1, |i| i as i64);
    let mut right = (index + 1) as usize;
    if index >= 0 && num(&keys[index as usize], "tick") == Some(tick) {
        index -= 1;
    }
    while index >= 0 && flagged(&keys[index as usize]) {
        index -= 1;
    }
    while right < keys.len() && flagged(&keys[right]) {
        right += 1;
    }
    (if index >= 0 { keys.get(index as usize) } else { None }, keys.get(right))
}

/// The wrap of IK angles (`wrap` in src/ik.mjs).
fn wrap(a: f64) -> f64 {
    const TAU: f64 = std::f64::consts::PI * 2.0;
    ((a + std::f64::consts::PI) % TAU + TAU) % TAU - std::f64::consts::PI
}

fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => crate::history::js_strict_eq(a, b),
        _ => false,
    }
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `interpolateIK(a, b, t)` on figure records: the IK controllers of `a` moved toward those of `b`.
fn interpolate_ik(a: &Value, b: &Value, t: f64) -> Option<Value> {
    let table = a.get("_stykIK").filter(|ik| ik.truthy())?.as_obj()?;
    let mut out = Obj::new();
    for (id, c) in table.iter() {
        let next = b.get("_stykIK").and_then(|ik| ik.get(id));
        let Some(next) = next.filter(|next| next.get("enabled").is_some_and(Value::truthy) && c.get("enabled").is_some_and(Value::truthy) && strict_eq(next.get("pinned"), c.get("pinned"))) else {
            out.set(id, c.clone());
            continue;
        };
        let mut target = c.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        for key in ["x", "y", "rotation"] {
            let from = number(target.get(key));
            let to = number(next.path(&["target", key]));
            let step = if key == "rotation" { wrap(to - from) } else { to - from };
            target.set(key, Value::Num(from + step * t));
        }
        let mut followers = c.get("followers").and_then(Value::as_obj).cloned().unwrap_or_default();
        let children: Vec<std::sync::Arc<str>> = followers.keys().cloned().collect();
        for child in children {
            if let Some(to) = next.path(&["followers", &child]).and_then(Value::as_f64).filter(|v| v.is_finite()) {
                let from = number(followers.get(&child));
                followers.set(&child, Value::Num(from + wrap(to - from) * t));
            }
        }
        let joined_followers = c.get("joinedFollowers").filter(|v| v.truthy()).and_then(Value::as_obj).map(|owners| {
            owners.iter().map(|(owner, children)| {
                let moved: Obj = children.as_obj().map(|children| children.iter().map(|(child, angle)| {
                    let from = number(Some(angle));
                    let value = match next.path(&["joinedFollowers", owner, child]).and_then(Value::as_f64).filter(|v| v.is_finite()) {
                        Some(to) => Value::Num(from + wrap(to - from) * t),
                        None => angle.clone(),
                    };
                    (child.clone(), value)
                }).collect()).unwrap_or_default();
                (owner.clone(), Value::object(moved))
            }).collect::<Obj>()
        });
        let bend_reference = c.get("bendReference").filter(|v| v.truthy()).map(|reference| {
            let shape = reference.get("shape").and_then(Value::numbers).unwrap_or_default();
            let other = next.path(&["bendReference", "shape"]).and_then(Value::numbers).unwrap_or_default();
            if !shape.is_empty() && shape.len() == other.len() {
                let mut moved = reference.as_obj().cloned().unwrap_or_default();
                moved.set("shape", Value::nums(&shape.iter().zip(&other).map(|(a, b)| a + wrap(b - a) * t).collect::<Vec<_>>()));
                Value::object(moved)
            } else {
                reference.clone()
            }
        });
        let quaternion = |from: &Value, to: Option<&Value>| -> Value {
            match (from.numbers(), to.and_then(Value::numbers)) {
                (Some(a), Some(b)) if a.len() == 4 && b.len() == 4 => Value::nums(&styk_eval::ik::spatial::interpolate_quaternion([a[0], a[1], a[2], a[3]], [b[0], b[1], b[2], b[3]], t)),
                _ => from.clone(),
            }
        };
        let spatial_followers = c.get("spatialFollowers").filter(|v| v.truthy()).and_then(Value::as_obj).map(|followers| {
            followers.iter().map(|(id, q)| (id.clone(), match next.path(&["spatialFollowers", id]).filter(|n| n.truthy()) { Some(n) => quaternion(q, Some(n)), None => q.clone() })).collect::<Obj>()
        });
        let joined_spatial_followers = c.get("joinedSpatialFollowers").filter(|v| v.truthy()).and_then(Value::as_obj).map(|owners| {
            owners.iter().map(|(owner, children)| {
                let moved: Obj = children.as_obj().map(|children| children.iter().map(|(id, q)| (id.clone(), match next.path(&["joinedSpatialFollowers", owner, id]).filter(|n| n.truthy()) { Some(n) => quaternion(q, Some(n)), None => q.clone() })).collect()).unwrap_or_default();
                (owner.clone(), Value::object(moved))
            }).collect::<Obj>()
        });
        let spatial_target = match (c.get("spatialTarget").filter(|v| v.truthy()), next.get("spatialTarget").filter(|v| v.truthy())) {
            (Some(from), Some(to)) => {
                let mut moved = from.as_obj().cloned().unwrap_or_default();
                let depth = number(from.get("depth"));
                moved.set("depth", Value::Num(depth + (number(to.get("depth")) - depth) * t));
                let swivel = number(from.get("swivel"));
                moved.set("swivel", Value::Num(swivel + wrap(number(to.get("swivel")) - swivel) * t));
                let pole = |value: Option<&Value>| value.and_then(Value::numbers).filter(|v| v.len() == 3).map(|v| [v[0], v[1], v[2]]);
                if let (Some(a), Some(b)) = (pole(from.get("pole")), pole(to.get("pole"))) {
                    moved.set("pole", Value::nums(&styk_eval::ik::spatial::interpolate_pole(a, b, t)));
                }
                if let (Some(a), Some(b)) = (from.get("normals").and_then(Value::elements), to.get("normals").and_then(Value::elements)) {
                    let normals: Vec<Value> = a.iter().enumerate().map(|(i, from)| match (pole(Some(&from)), b.get(i).as_ref().and_then(|v| pole(Some(v)))) {
                        (Some(a), Some(b)) => Value::nums(&styk_eval::ik::spatial::interpolate_pole(a, b, t)),
                        _ => from,
                    }).collect();
                    moved.set("normals", Value::array(normals));
                }
                Some(Value::object(moved))
            }
            (Some(from), None) => Some(from.clone()),
            _ => None,
        };
        let mut controller = c.as_obj().cloned().unwrap_or_default();
        controller.set("target", Value::object(target));
        controller.set("followers", Value::object(followers));
        if let Some(value) = spatial_followers { controller.set("spatialFollowers", Value::object(value)); }
        if let Some(value) = joined_spatial_followers { controller.set("joinedSpatialFollowers", Value::object(value)); }
        if let Some(value) = spatial_target { controller.set("spatialTarget", value); }
        if let Some(value) = joined_followers { controller.set("joinedFollowers", Value::object(value)); }
        if let Some(value) = bend_reference { controller.set("bendReference", value); }
        out.set(id, Value::object(controller));
    }
    Some(Value::object(out))
}

impl Editor {
    /// `blendReport(report, a, b, uids)`: two poses of the figures `uids` (and what they hang from), linear.
    fn blend(&self, a: &Value, b: &Value, uids: &[u32]) -> Result<Blend, EditError> {
        let wanted: Vec<f64> = uids.iter().map(|&u| u as f64).collect();
        let frames: Vec<Value> = [a, b].into_iter().map(|frame| {
            let mut pose = snapshot_pose_frame_of(frame, Some(&wanted));
            if let Some(record) = pose.make_obj() {
                let mut easing = Obj::new();
                easing.set("interpolation", Value::str("linear"));
                let mut styk = Obj::new();
                styk.set("easing", Value::object(easing));
                record.set("_styk", Value::object(styk));
                record.set("duration_raw", Value::Num(1.0));
            }
            pose
        }).collect();
        let types: Vec<Value> = frames.iter().flat_map(|frame| items(frame.get("objects"))).filter_map(|object| object.get("figure_type_id").cloned()).collect();
        let figures: Vec<Value> = items(self.report.get("figure_types")).into_iter().filter(|figure| figure.get("figure_type_id").is_some_and(|id| types.contains(id))).collect();
        let mut tree = Obj::new();
        tree.set("version", Value::Num(5.0));
        tree.set("auto_easing", Value::Bool(false));
        tree.set("figure_types", Value::array(figures));
        tree.set("keyframes", Value::array(frames));
        tree.set("_styk", Value::object(Obj::new()));
        let tree = Value::object(tree);
        let document = styk_eval::load::Loader::new().document(&tree, "tween").map_err(|error| EditError::Invalid(error.to_string()))?;
        Ok(Blend { tree, prepared: Arc::new(Prepared::new(Arc::new(document))) })
    }

    /// `beginTween()`: plans the gesture for the selected figures; answers the key pairs and the figure count.
    pub(crate) fn begin_tween(&mut self) -> Result<Value, EditError> {
        if self.drag.is_some() {
            return Err(invalid("errors.editorTweener.finishTheCurrentEditBeforeOpeningTweener"));
        }
        if self.selection.uids.is_empty() {
            return Err(invalid("errors.editorTweener.selectFiguresToTween"));
        }
        if self.tick.fract() != 0.0 {
            return Err(invalid("errors.editorTweener.chooseAWholeFrameBeforeTweening"));
        }
        if !self.sheet() {
            return Err(EditError::Unported("tweening on a native timeline".into()));
        }
        let current = self.shown_frame()?;
        let selected: Vec<Value> = items(current.get("objects")).into_iter().filter(|o| uid(o).is_some_and(|u| self.selection.uids.contains(&u))).collect();
        if selected.is_empty() {
            return Err(invalid("errors.editorTweener.selectFiguresPresentAtThisFrame"));
        }
        // Bound interactive pose work.
        if selected.len() > 256 || selected.iter().map(|o| o.get("angles").and_then(Value::array_len).unwrap_or(0)).sum::<usize>() > 100_000 {
            return Err(invalid("errors.editorTweener.tweenASmallerSelectionUpTo256Figures"));
        }
        let layers = self.report.path(&["_styk", "layers"]).cloned();
        let sheet_tracks = self.report.path(&["_styk", "layerSheet", "tracks"]).cloned();
        let mut sampled: Vec<(f64, Value)> = Vec::new();
        // The pairs of neighbouring ticks, in the order the figures first need them.
        let mut groups: Vec<((f64, f64), Vec<u32>)> = Vec::new();
        let join_parent = |frame: &Value, object: &Value| -> Option<Option<u32>> {
            match object.get("join").filter(|j| j.truthy()) {
                None => Some(None),
                Some(join) => num(join, "target_object_slot").filter(|s| *s >= 0.0).and_then(|slot| items(frame.get("objects")).get(slot as usize).and_then(uid)).map(Some),
            }
        };
        for object in &selected {
            let id = uid(object).unwrap_or(0);
            let layer = self.layer_of(id);
            let locked = object.path(&["_styk", "locked"]).is_some_and(Value::truthy)
                || layers.as_ref().and_then(|l| l.path(&["byId", &layer, "locked"])).and_then(Value::as_bool) == Some(true)
                || layers.as_ref().and_then(|l| l.path(&["byId", &layer, "visible"])).and_then(Value::as_bool) == Some(false);
            if locked {
                return Err(invalid("errors.editorTweener.unlockAndShowAllSelectedFiguresBeforeTweening"));
            }
            let keys = items(sheet_tracks.as_ref().and_then(|tracks| tracks.path(&[&layer, "keys"])));
            let (previous, next) = neighbors(&keys, self.tick);
            let (Some(previous), Some(next)) = (previous, next) else { return Err(invalid("errors.editorTweener.placeThePlayheadBetweenTwoKeysOnEvery")) };
            let (previous, next) = (num(previous, "tick").unwrap_or(f64::NAN), num(next, "tick").unwrap_or(f64::NAN));
            for tick in [previous, next] {
                if !sampled.iter().any(|(at, _)| *at == tick) {
                    sampled.push((tick, self.evaluated(tick, false)?));
                }
            }
            let frame_at = |tick: f64| sampled.iter().find(|(at, _)| *at == tick).map(|(_, frame)| frame.clone()).unwrap();
            let (a, b) = (frame_at(previous), frame_at(next));
            let find = |frame: &Value| items(frame.get("objects")).into_iter().find(|o| uid(o) == Some(id));
            let (from, to) = (find(&a), find(&b));
            let same_rig = |pose: &Option<Value>| pose.as_ref().is_some_and(|pose| pose.get("figure_type_id") == object.get("figure_type_id")
                && pose.get("angles").and_then(Value::array_len) == object.get("angles").and_then(Value::array_len));
            if !same_rig(&from) || !same_rig(&to) {
                return Err(invalid("errors.editorTweener.eachSelectedFigureNeedsTheSameRigAt"));
            }
            let parent = join_parent(&current, object);
            if join_parent(&a, from.as_ref().unwrap()) != parent || join_parent(&b, to.as_ref().unwrap()) != parent {
                return Err(invalid("errors.editorTweener.keepTheSameFigureAttachmentsAtBothNeighboring"));
            }
            match groups.iter_mut().find(|(ticks, _)| *ticks == (previous, next)) {
                Some((_, uids)) => uids.push(id),
                None => groups.push(((previous, next), vec![id])),
            }
        }
        let mut plans = Vec::new();
        for ((previous, next), uids) in &groups {
            let frame_at = |tick: f64| sampled.iter().find(|(at, _)| *at == tick).map(|(_, frame)| frame.clone()).unwrap();
            let (a, b) = (frame_at(*previous), frame_at(*next));
            let between = self.blend(&a, &b, uids)?;
            let breakdown = between.sample((self.tick - previous) / (next - previous))?;
            let relax = self.blend(&current, &breakdown, uids)?;
            plans.push(Plan { start: relax.start(), left: self.blend(&current, &a, uids)?, right: self.blend(&current, &b, uids)?, relax, between, uids: uids.clone() });
        }
        if !self.begin_drag("Tween pose", false)? {
            return Err(invalid("errors.editorTweener.selectFiguresToTween"));
        }
        let keyed: Vec<String> = {
            let mut layers_taken: Vec<String> = Vec::new();
            for object in &selected {
                let layer = self.layer_of(uid(object).unwrap_or(0));
                if !layers_taken.contains(&layer) {
                    layers_taken.push(layer);
                }
            }
            layers_taken.into_iter().filter(|layer| {
                let keys = items(sheet_tracks.as_ref().and_then(|tracks| tracks.path(&[layer, "keys"])));
                match key_at(&keys, self.tick).map(|i| &keys[i]) {
                    Some(key) => num(key, "tick") != Some(self.tick) || key.get("patchOnly").is_some_and(Value::truthy),
                    None => true,
                }
            }).collect()
        };
        let summary = Value::array(plans.iter().zip(&groups).map(|(_, ((previous, next), _))| {
            let mut pair = Obj::new();
            pair.set("previous", Value::Num(*previous));
            pair.set("next", Value::Num(*next));
            Value::object(pair)
        }).collect());
        if let Some(edit) = self.authored.as_mut() {
            edit.key_at_playhead = true;
            edit.key_at_playhead_layers = keyed;
        }
        if let Some(drag) = self.drag.as_mut() {
            drag.tweener = Some(Tweener { plans });
        }
        let mut result = Obj::new();
        result.set("groups", summary);
        result.set("figures", Value::Num(selected.len() as f64));
        Ok(Value::object(result))
    }

    /// `updateTween(amount, mode)`: poses the draft between the neighbours (`breakdown`, `neighbor`), pushed
    /// past the pose it began with (`push`) or relaxed toward the breakdown (`relax`).
    pub(crate) fn update_tween(&mut self, amount: &Value, mode: Option<&Value>) -> Result<bool, EditError> {
        let mode = mode.map_or("breakdown", |mode| mode.as_str().unwrap_or(""));
        let amount = amount.as_f64().unwrap_or(f64::NAN);
        if !MODES.contains(&mode) || !amount.is_finite() || amount < (if mode == "neighbor" { -1.0 } else { 0.0 }) || amount > 1.0 {
            return Err(invalid("errors.editorTweener.chooseAValidTweenerModeAndAmount"));
        }
        let Some(tweener) = self.drag.as_ref().and_then(|drag| drag.tweener.clone()) else {
            return Err(invalid("errors.editorTweener.openTweenerBeforeAdjustingThePose"));
        };
        let definitions = items(self.report.get("figure_types"));
        for plan in &tweener.plans {
            let blend = match mode {
                "breakdown" => &plan.between,
                "neighbor" => if amount < 0.0 { &plan.left } else { &plan.right },
                _ => &plan.relax,
            };
            let result = blend.sample(amount.abs())?;
            let sampled: HashMap<u32, Value> = items(result.get("objects")).into_iter().filter_map(|o| Some((uid(&o)?, o))).collect();
            let objects = self.frame_objects();
            for &id in &plan.uids {
                let (Some(value), Some(start)) = (sampled.get(&id), plan.start.get(&id)) else { continue };
                let Some(slot) = objects.iter().position(|o| uid(o) == Some(id)) else { continue };
                let mut object = objects[slot].as_obj().cloned().unwrap_or_default();
                for field in FIELDS {
                    match value.get(field) {
                        Some(found) => object.set(field, found.clone()),
                        None => { object.remove(field); }
                    }
                }
                if start.get("_stykIK").is_some_and(Value::truthy) {
                    match interpolate_ik(start, value, if mode == "push" { -1.0 } else { 1.0 }) {
                        Some(table) => object.set("_stykIK", table),
                        None => { object.remove("_stykIK"); }
                    }
                }
                if mode == "push" {
                    push(&mut object, start, value, &definitions)?;
                }
                self.replace_frame_object(slot, object);
            }
        }
        self.touch()?;
        Ok(true)
    }
}

/// `interpolateSpatialPose(a, b, t)` on figure records (src/spatial-projection.mjs): the perspective and part
/// proportions of `a` moved toward those of `b`, within their limits. The camera is always there.
fn interpolate_spatial_pose(a: &Value, b: &Value, t: f64) -> Value {
    // `Math.max(min, Math.min(max, a + (b - a) * t))`: NaN stays NaN.
    let lerp = |a: f64, b: f64, min: f64, max: f64| {
        let v = a + (b - a) * t;
        let v = if v.is_nan() { v } else { v.min(max) };
        if v.is_nan() { v } else { v.max(min) }
    };
    // `spatialCamera`: the defaults (the centre is the figure's root), over the pose's own camera.
    let camera = |object: &Value| {
        let own = object.path(&["_stykSpatial", "camera"]);
        let field = |key: &str, default: f64| own.as_ref().and_then(|camera| camera.get(key)).and_then(Value::as_f64).unwrap_or(default);
        [field("strength", 0.0), field("distance", 600.0), field("centerX", object.get("root_x").and_then(Value::as_f64).unwrap_or(0.0)), field("centerY", object.get("root_y").and_then(Value::as_f64).unwrap_or(0.0))]
    };
    let (ca, cb) = (camera(a), camera(b));
    let shapes = |object: &Value| object.path(&["_stykSpatial", "shape"]).and_then(Value::as_obj).cloned().unwrap_or_default();
    let (sa, sb) = (shapes(a), shapes(b));
    let part = |shapes: &Obj, id: &str, key: &str, default: f64| shapes.get(id).and_then(|shape| shape.get(key)).and_then(Value::as_f64).unwrap_or(default);
    let mut shape = Obj::new();
    for id in sa.keys().chain(sb.keys()) {
        if shape.get(id).is_some() {
            continue;
        }
        let mut moved = Obj::new();
        moved.set("width", Value::Num(lerp(part(&sa, id, "width", 1.0), part(&sb, id, "width", 1.0), 0.1, 5.0)));
        moved.set("taper", Value::Num(lerp(part(&sa, id, "taper", 0.0), part(&sb, id, "taper", 0.0), -0.9, 3.0)));
        shape.set(id, Value::object(moved));
    }
    let mut moved = Obj::new();
    moved.set("strength", Value::Num(lerp(ca[0], cb[0], 0.0, 1.0)));
    moved.set("distance", Value::Num(lerp(ca[1], cb[1], 10.0, 100000.0)));
    moved.set("centerX", Value::Num(lerp(ca[2], cb[2], -1e7, 1e7)));
    moved.set("centerY", Value::Num(lerp(ca[3], cb[3], -1e7, 1e7)));
    let mut pose = Obj::new();
    pose.set("camera", Value::object(moved));
    if !shape.is_empty() {
        pose.set("shape", Value::object(shape));
    }
    Value::object(pose)
}

/// Push: reflects the relaxed displacement around the pose the gesture began with.
fn push(object: &mut Obj, start: &Value, value: &Value, definitions: &[Value]) -> Result<(), EditError> {
    if start.get("_stykSpatial").is_some_and(Value::truthy) || value.get("_stykSpatial").is_some_and(Value::truthy) {
        object.set("_stykSpatial", interpolate_spatial_pose(start, value, -1.0));
    }
    for field in ["root_x", "root_y", "scale"] {
        object.set(field, Value::Num(2.0 * number(start.get(field)) - number(value.get(field))));
    }
    let scale = number(object.get("scale"));
    // `Math.max(0, NaN)` is NaN.
    object.set("scale", Value::Num(if scale.is_nan() { scale } else { scale.max(0.0) }));
    let angles = start.get("angles").and_then(Value::numbers).unwrap_or_default();
    let moved = value.get("angles").and_then(Value::numbers).unwrap_or_default();
    object.set("angles", Value::nums(&angles.iter().enumerate().map(|(i, angle)| angle - shortest(moved.get(i).copied().unwrap_or(f64::NAN) - angle)).collect::<Vec<_>>()));
    let figure = definitions.iter().find(|figure| figure.get("figure_type_id") == object.get("figure_type_id"));
    let segments = items(figure.and_then(|figure| figure.get("segments")));
    for (flag, field, base) in [("len_flag", "lengths", "length"), ("bend_flag", "bends", "bend_rad")] {
        let (from, to) = (start.get(flag).is_some_and(Value::truthy), value.get(flag).is_some_and(Value::truthy));
        if from || to {
            object.set(flag, Value::Num(1.0));
            let start_values = start.get(field).and_then(Value::numbers).unwrap_or_default();
            let value_values = value.get(field).and_then(Value::numbers).unwrap_or_default();
            let out: Vec<f64> = segments.iter().enumerate().map(|(i, segment)| {
                let default = segment.get(base).and_then(Value::as_f64).unwrap_or(0.0);
                let a = if from { start_values.get(i).copied().unwrap_or(f64::NAN) } else { default };
                let b = if to { value_values.get(i).copied().unwrap_or(f64::NAN) } else { default };
                2.0 * a - b
            }).collect();
            object.set(field, Value::nums(&out));
        }
    }
    if let (Some(current), Some(original)) = (object.get("_stykAnimationOrigin").filter(|v| v.truthy()).and_then(Value::as_obj).cloned(), start.get("_stykAnimationOrigin").filter(|v| v.truthy())) {
        let mut origin = current;
        for field in ["x", "y", "offsetX", "offsetY"] {
            if origin.get(field).and_then(Value::as_f64).is_some_and(f64::is_finite) {
                origin.set(field, Value::Num(2.0 * original.get(field).and_then(Value::as_f64).unwrap_or(0.0) - number(origin.get(field))));
            }
        }
        if let Some(ghosts) = origin.get("ghosts").and_then(Value::as_obj).cloned() {
            let mut moved = Obj::new();
            for (id, ghost) in ghosts.iter() {
                let Some(source) = original.path(&["ghosts", id]).filter(|g| g.truthy()) else { moved.set(id, ghost.clone()); continue };
                let mut ghost = ghost.as_obj().cloned().unwrap_or_default();
                for field in ["angle_rad", "bend_rad", "length"] {
                    let (a, b) = (number(source.get(field)), number(ghost.get(field)));
                    ghost.set(field, Value::Num(if field == "angle_rad" { a - shortest(b - a) } else { 2.0 * a - b }));
                }
                moved.set(id, Value::object(ghost));
            }
            origin.set("ghosts", Value::object(moved));
        }
        object.set("_stykAnimationOrigin", Value::object(origin));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

    /// The document of a recorded tape, with a figure keyed at ticks 4 and 6 in different poses.
    fn editor() -> Editor {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/channels-pose-sheet.reference.json");
        let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let state = first.get("state").unwrap();
        let mut editor = Editor::new(parse(first.get("document").unwrap().as_str().unwrap()), crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
        let number = |key| state.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        editor.set_counters(number("layerRevision") as u64, number("nextFrameIdentity") as u64, number("nextUid") as u64);
        editor.set_view(0.0, 0, crate::Selection { uid: Some(1), uids: vec![1], joint: -1 });
        for (tick, by) in [(4.0, 0.3), (6.0, -0.4)] {
            editor.call("seek", &[Value::Num(tick)]).unwrap();
            editor.call("rotateSelection", &[Value::Num(by)]).unwrap();
        }
        editor.call("seek", &[Value::Num(5.0)]).unwrap();
        editor
    }

    fn angles(editor: &Editor) -> Vec<f64> {
        let shown = editor.shown_frame().unwrap();
        items(shown.get("objects")).into_iter().find(|o| uid(o) == Some(1)).and_then(|o| o.get("angles").and_then(Value::numbers)).unwrap()
    }

    fn at(editor: &Editor, tick: f64) -> Vec<f64> {
        let frame = editor.evaluated(tick, false).unwrap();
        items(frame.get("objects")).into_iter().find(|o| uid(o) == Some(1)).and_then(|o| o.get("angles").and_then(Value::numbers)).unwrap()
    }

    fn close(a: &[f64], b: &[f64], message: &str) {
        assert_eq!(a.len(), b.len(), "{message}");
        assert!(a.iter().zip(b).all(|(a, b)| (a - b).abs() < 1e-9), "{message}: {a:?} against {b:?}");
    }

    fn tween(editor: &mut Editor, amount: f64, mode: &str) {
        assert_eq!(editor.call("updateTween", &[Value::Num(amount), Value::str(mode)]).unwrap(), Value::Bool(true));
    }

    fn keys(editor: &Editor) -> Vec<f64> {
        items(editor.report.path(&["_styk", "layerSheet", "tracks", "layer-1", "keys"])).iter().filter_map(|key| num(key, "tick")).collect()
    }

    #[test]
    fn begin_plans_the_neighbouring_keys_and_keys_the_playhead() {
        let mut editor = editor();
        let result = editor.call("beginTween", &[]).unwrap();
        assert_eq!(styk_doc::json::to_string(&result), r#"{"groups":[{"previous":4,"next":6}],"figures":1}"#);
        let edit = editor.authored.as_ref().unwrap();
        assert!(edit.key_at_playhead);
        assert_eq!(edit.key_at_playhead_layers, vec!["layer-1".to_string()]);
        assert_eq!(editor.drag.as_ref().unwrap().label, "Tween pose");
    }

    #[test]
    fn a_breakdown_blends_the_neighbours_and_neighbor_mode_leans_toward_one() {
        let mut editor = editor();
        let (a, b) = (at(&editor, 4.0), at(&editor, 6.0));
        assert!(a != b, "the keys differ");
        editor.call("beginTween", &[]).unwrap();
        tween(&mut editor, 0.0, "breakdown");
        close(&angles(&editor), &a, "breakdown 0 is the previous key");
        tween(&mut editor, 1.0, "breakdown");
        close(&angles(&editor), &b, "breakdown 1 is the next key");
        tween(&mut editor, 0.5, "breakdown");
        let middle: Vec<f64> = a.iter().zip(&b).map(|(a, b)| a + shortest(b - a) * 0.5).collect();
        close(&angles(&editor), &middle, "breakdown half way");
        tween(&mut editor, -1.0, "neighbor");
        close(&angles(&editor), &a, "neighbor -1 is the previous key");
        tween(&mut editor, 1.0, "neighbor");
        close(&angles(&editor), &b, "neighbor 1 is the next key");
        tween(&mut editor, 0.0, "neighbor");
        close(&angles(&editor), &at(&editor, 5.0), "neighbor 0 is the pose it began with");
    }

    #[test]
    fn relax_goes_to_the_breakdown_and_push_away_from_it() {
        let mut editor = editor();
        let (a, b, start) = (at(&editor, 4.0), at(&editor, 6.0), at(&editor, 5.0));
        let breakdown: Vec<f64> = a.iter().zip(&b).map(|(a, b)| a + shortest(b - a) * 0.5).collect();
        editor.call("beginTween", &[]).unwrap();
        tween(&mut editor, 1.0, "relax");
        close(&angles(&editor), &breakdown, "relax 1 is the breakdown");
        tween(&mut editor, 1.0, "push");
        let pushed: Vec<f64> = start.iter().zip(&breakdown).map(|(start, value)| start - shortest(value - start)).collect();
        close(&angles(&editor), &pushed, "push 1 is the breakdown reflected around the pose it began with");
        tween(&mut editor, 0.0, "push");
        close(&angles(&editor), &start, "push 0 is the pose it began with");
    }

    #[test]
    fn committing_keys_the_playhead_as_one_entry_and_cancelling_records_nothing() {
        let mut editor = editor();
        let entries = editor.undo.len();
        editor.call("beginTween", &[]).unwrap();
        tween(&mut editor, 0.25, "breakdown");
        assert_eq!(editor.call("cancelDrag", &[]).unwrap(), Value::Bool(true));
        assert_eq!(editor.undo.len(), entries, "a cancelled tween records nothing");
        assert!(editor.drag.is_none() && editor.authored.is_none());
        let (a, b) = (at(&editor, 4.0), at(&editor, 6.0));
        editor.call("beginTween", &[]).unwrap();
        tween(&mut editor, 0.25, "breakdown");
        assert_eq!(editor.call("commitDrag", &[]).unwrap(), Value::Bool(true));
        assert_eq!(editor.undo.len(), entries + 1);
        assert_eq!(editor.state().undo_label, "Tween pose");
        assert!(keys(&editor).contains(&5.0), "the playhead is keyed: {:?}", keys(&editor));
        let expected: Vec<f64> = a.iter().zip(&b).map(|(a, b)| a + shortest(b - a) * 0.25).collect();
        close(&at(&editor, 5.0), &expected, "the key holds the tweened pose");
        editor.call("undo", &[]).unwrap();
        assert!(!keys(&editor).contains(&5.0));
    }

    #[test]
    fn a_tween_that_changes_nothing_still_keys_the_playhead() {
        let mut editor = editor();
        editor.call("beginTween", &[]).unwrap();
        assert_eq!(editor.call("commitDrag", &[]).unwrap(), Value::Bool(true));
        assert!(keys(&editor).contains(&5.0), "pressing A while tweening keys the pose it began with: {:?}", keys(&editor));
    }

    #[test]
    fn the_perspective_and_proportions_of_a_pose_move_toward_another_within_their_limits() {
        // Expected values are what src/spatial-projection.mjs `interpolateSpatialPose` answers for these two poses.
        let a = parse(r#"{"root_x":100,"root_y":50,"_stykSpatial":{"camera":{"strength":0.2,"distance":500},"shape":{"3":{"width":2,"taper":0.5},"7":{"width":0.5,"taper":-0.5}}}}"#);
        let b = parse(r#"{"root_x":200,"root_y":150,"_stykSpatial":{"camera":{"strength":0.6,"distance":700,"centerX":300},"shape":{"7":{"width":4},"9":{"taper":1}}}}"#);
        let text = |t: f64| styk_doc::json::to_string(&interpolate_spatial_pose(&a, &b, t));
        assert_eq!(text(-1.0), r#"{"camera":{"strength":0,"distance":300,"centerX":-100,"centerY":-50},"shape":{"3":{"width":3,"taper":1},"7":{"width":0.1,"taper":-0.9},"9":{"width":1,"taper":-0.9}}}"#);
        assert_eq!(text(0.25), r#"{"camera":{"strength":0.3,"distance":550,"centerX":150,"centerY":75},"shape":{"3":{"width":1.75,"taper":0.375},"7":{"width":1.375,"taper":-0.375},"9":{"width":1,"taper":0.25}}}"#);
        assert_eq!(text(1.0), r#"{"camera":{"strength":0.6,"distance":700,"centerX":300,"centerY":150},"shape":{"3":{"width":1,"taper":0},"7":{"width":4,"taper":0},"9":{"width":1,"taper":1}}}"#);
        // A pose with no perspective of its own starts from the defaults, centred on its root.
        let none = parse(r#"{"root_x":5,"root_y":6}"#);
        assert_eq!(styk_doc::json::to_string(&interpolate_spatial_pose(&none, &b, -1.0)), r#"{"camera":{"strength":0,"distance":500,"centerX":-290,"centerY":-138},"shape":{"7":{"width":0.1,"taper":0},"9":{"width":1,"taper":-0.9}}}"#);
        // Far past the limits everything stops at them.
        let wide = parse(r#"{"root_x":0,"root_y":0,"_stykSpatial":{"camera":{"strength":1,"distance":100000}}}"#);
        let other = parse(r#"{"root_x":10000000,"root_y":0,"_stykSpatial":{"camera":{"strength":0.5,"distance":10}}}"#);
        assert_eq!(styk_doc::json::to_string(&interpolate_spatial_pose(&wide, &other, -3.0)), r#"{"camera":{"strength":1,"distance":100000,"centerX":-10000000,"centerY":0}}"#);
    }

    #[test]
    fn what_cannot_be_tweened_is_refused_with_the_editors_messages() {
        let mut editor = editor();
        let error = |editor: &mut Editor, method: &str, args: &[Value]| match editor.call(method, args) { Err(EditError::Invalid(key)) => key, other => panic!("{method}: {other:?}") };
        assert_eq!(error(&mut editor, "updateTween", &[Value::Num(0.5)]), "errors.editorTweener.openTweenerBeforeAdjustingThePose");
        editor.call("beginTween", &[]).unwrap();
        assert_eq!(error(&mut editor, "beginTween", &[]), "errors.editorTweener.finishTheCurrentEditBeforeOpeningTweener");
        assert_eq!(error(&mut editor, "updateTween", &[Value::Num(2.0), Value::str("breakdown")]), "errors.editorTweener.chooseAValidTweenerModeAndAmount");
        assert_eq!(error(&mut editor, "updateTween", &[Value::Num(-0.5), Value::str("breakdown")]), "errors.editorTweener.chooseAValidTweenerModeAndAmount");
        assert_eq!(error(&mut editor, "updateTween", &[Value::Num(0.5), Value::str("wobble")]), "errors.editorTweener.chooseAValidTweenerModeAndAmount");
        tween(&mut editor, -0.5, "neighbor");
        editor.call("cancelDrag", &[]).unwrap();
        // Before the first key there is nothing to blend from.
        editor.call("seek", &[Value::Num(0.0)]).unwrap();
        assert_eq!(error(&mut editor, "beginTween", &[]), "errors.editorTweener.placeThePlayheadBetweenTwoKeysOnEvery");
        editor.call("select", &[Value::Null]).unwrap();
        assert_eq!(error(&mut editor, "beginTween", &[]), "errors.editorTweener.selectFiguresToTween");
    }
}
