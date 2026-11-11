//! A pose property at one value in every chosen frame: the inspector's number fields (`root_x`, `group_width`, `rotation`,
//! `joint_angle`, ...) with several keys chosen on the timeline ("Edit together"). The value is absolute: each frame is brought to it
//! from where it stands there (`mutatePose`). The frames are planned like any figure operation across
//! frames ([`crate::range_plan`]) and committed as one history entry ([`crate::range`]).
//!
//! The selected figures are the ones that change, and with them everything joined below: `root_x`, `root_y` and the group keys also
//! take the figures they hang from, so a joined figure keeps its place against its parent. `joint_*` change the selected joint of the
//! selected figure and what turns with it.

use std::collections::{BTreeMap, HashSet};

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::pose::{add_angles, rotation_targets};
use crate::range_plan::{js_round, native_finite, Context, Planned};
use crate::record::{join_target, num, uid};
use crate::EditError;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

const UNRESOLVED: &str = "errors.rangeFigureOperations.cannotTransformAFrameWithUnresolvedFigureGeometry";

/// The keys a pose is set by, as the inspector names them.
pub(crate) const KEYS: [&str; 13] = [
    "root_x", "root_y", "group_x", "group_y", "group_width", "group_height", "scale", "rotation", "figure_opacity", "figure_z_order", "joint_angle", "joint_length", "joint_bend",
];

/// A pose property set to `value` (degrees, percent or pixels, as the inspector shows it), by the primary selected figure's lights.
#[derive(Clone, Debug)]
pub(crate) struct Pose {
    pub key: String,
    pub value: f64,
    /// The figure whose property the inspector shows: the selection's primary.
    pub uid: Option<u32>,
    /// The selected joint, for `joint_*`.
    pub joint: i64,
}

impl Pose {
    /// The checks the inspector makes of the value before it is applied anywhere.
    pub(crate) fn validated(key: &str, value: &Value, uid: Option<u32>, joint: i64) -> Result<Pose, EditError> {
        let Some(key) = KEYS.iter().find(|known| **known == key) else { return Err(invalid("errors.nativePropertyEdit.selectThePropertyBeforeEditingIt")) };
        let value = native_finite(value.as_f64(), "Value").map_err(|_| invalid("errors.nativePropertyEdit.enterAFiniteNumberWithinTheNativeRange"))?;
        Ok(Pose { key: (*key).to_string(), value, uid, joint })
    }

    /// Whether the figures the selection hangs from take part (their place moves with a move of the selection).
    fn moves_roots(&self) -> bool {
        self.key == "root_x" || self.key == "root_y" || self.key.starts_with("group_")
    }
}

/// `affectedSlots(frame, selected, ancestors)`: the selected figures, with ancestors when asked, and everything joined below any of them.
fn affected_slots(objects: &[Value], selected: &[usize], ancestors: bool) -> Vec<usize> {
    let mut children: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (slot, object) in objects.iter().enumerate() {
        if let Some(parent) = join_target(object) {
            children.entry(parent).or_default().push(slot);
        }
    }
    let mut queue: Vec<usize> = selected.to_vec();
    let mut taken: HashSet<usize> = queue.iter().copied().collect();
    if ancestors {
        let mut at = 0;
        while at < queue.len() {
            if let Some(parent) = join_target(&objects[queue[at]]).filter(|parent| *parent < objects.len())
                && taken.insert(parent)
            {
                queue.push(parent);
            }
            at += 1;
        }
    }
    let mut at = 0;
    while at < queue.len() {
        for &child in children.get(&queue[at]).map(Vec::as_slice).unwrap_or(&[]) {
            if taken.insert(child) {
                queue.push(child);
            }
        }
        at += 1;
    }
    queue
}

/// The slots and every figure they hang from, in order: what the geometry of a few figures needs to be built.
fn with_parents(objects: &[Value], slots: &[usize]) -> Vec<usize> {
    let mut needed: HashSet<usize> = slots.iter().copied().collect();
    let mut queue: Vec<usize> = slots.to_vec();
    let mut at = 0;
    while at < queue.len() {
        if let Some(parent) = join_target(&objects[queue[at]]).filter(|parent| *parent < objects.len())
            && needed.insert(parent)
        {
            queue.push(parent);
        }
        at += 1;
    }
    let mut ordered: Vec<usize> = needed.into_iter().collect();
    ordered.sort_unstable();
    ordered
}

fn item(object: &Value, key: &str, index: usize) -> Option<f64> {
    object.get(key).and_then(|list| list.item(index)).and_then(|v| v.as_f64())
}

fn number(object: &Value, key: &str) -> f64 {
    num(object, key).unwrap_or(f64::NAN)
}

/// `Math.round` of a percentage turned into a transparency byte.
fn transparency(percent: f64) -> f64 {
    js_round((1.0 - percent / 100.0) * 255.0)
}

fn segments_of(figure: Option<&Value>) -> Vec<Value> {
    figure.and_then(|figure| figure.get("segments")).and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn figure_of<'f>(figures: &'f [Value], object: &Value) -> Option<&'f Value> {
    let id = num(object, "figure_type_id")?;
    figures.iter().find(|figure| num(figure, "figure_type_id") == Some(id))
}

/// `mutatePose` on one frame: `None` when none of the selected figures is in it or nothing changes.
pub(crate) fn plan(context: &Context, frame: &Value, selected: &[usize], pose: &Pose) -> Result<Option<Planned>, EditError> {
    let objects = objects_of(frame);
    let key = pose.key.as_str();
    let slots = affected_slots(&objects, selected, pose.moves_roots());
    let primary = pose.uid.and_then(|id| objects.iter().position(|object| uid(object) == Some(id))).or_else(|| selected.first().copied());
    let Some(primary) = primary else { return Ok(None) };
    let mut records: BTreeMap<usize, Obj> = slots.iter().map(|&slot| (slot, objects[slot].as_obj().cloned().unwrap_or_default())).collect();
    let figure_at = |slot: usize| figure_of(context.figures, &objects[slot]);

    match key {
        "root_x" | "root_y" | "group_x" | "group_y" | "group_width" | "group_height" => {
            let group = key.starts_with("group_");
            let bounds = if group { Some(selection_bounds(context, frame, selected)?) } else { None };
            if key == "group_width" || key == "group_height" {
                let [min_x, min_y, max_x, max_y] = bounds.unwrap();
                let size = if key == "group_width" { max_x - min_x } else { max_y - min_y };
                if size <= 0.0 {
                    return Err(invalid("errors.nativePropertyRanges.aSelectedFrameHasAZeroSizedFigure"));
                }
                let factor = pose.value / size;
                let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
                for (&slot, record) in records.iter_mut() {
                    if join_target(&objects[slot]).is_none() {
                        record.set("root_x", Value::Num(cx + (number(&objects[slot], "root_x") - cx) * factor));
                        record.set("root_y", Value::Num(cy + (number(&objects[slot], "root_y") - cy) * factor));
                    }
                    record.set("scale", Value::Num(number(&objects[slot], "scale") * factor));
                }
            } else {
                let horizontal = key.ends_with("_x");
                let current = match bounds {
                    Some([min_x, min_y, ..]) => if horizontal { min_x } else { min_y },
                    None => {
                        let joints = (context.geometry)(frame, &slots_sorted(&slots))?;
                        let root = joints.get(&primary).ok_or_else(|| invalid(UNRESOLVED))?.root();
                        if horizontal { root[0] } else { root[1] }
                    }
                };
                let delta = pose.value - current;
                let field = if horizontal { "root_x" } else { "root_y" };
                for (&slot, record) in records.iter_mut() {
                    if join_target(&objects[slot]).is_none() {
                        record.set(field, Value::Num(number(&objects[slot], field) + delta));
                    }
                }
            }
        }
        "scale" => {
            records.get_mut(&primary).map(|record| record.set("scale", Value::Num(pose.value / 100.0)));
        }
        "rotation" => {
            let first = item(&objects[primary], "angles", 0).unwrap_or(0.0);
            let rest = segments_of(figure_at(primary)).first().and_then(|segment| num(segment, "angle_rad")).unwrap_or(0.0);
            let delta = radians(pose.value) - (first - rest);
            for (&slot, record) in records.iter_mut() {
                crate::transform::map_numbers(record, "angles", |angle| angle + delta);
                if let Some(figure) = figure_at(slot) {
                    crate::origin::rotate_support(figure, record, delta);
                }
            }
        }
        "figure_opacity" => {
            let byte = transparency(pose.value);
            for &slot in selected {
                records.get_mut(&slot).map(|record| record.set("field28", Value::Num(byte)));
            }
        }
        "figure_z_order" => {
            for &slot in selected {
                if let Some(record) = records.get_mut(&slot) {
                    if pose.value != 0.0 {
                        record.set("_stykZIndex", Value::Num(pose.value));
                    } else {
                        record.remove("_stykZIndex");
                    }
                }
            }
        }
        _ => {
            if !joint_pose(context, &objects, &mut records, primary, pose)? {
                return Ok(None);
            }
        }
    }
    for record in records.values_mut() {
        record.remove("runtime_segments");
    }
    // A joined figure's root is where its parent's joint puts it: bring it back after the move.
    if slots.iter().any(|&slot| join_target(&objects[slot]).is_some()) {
        let mut moved = objects.clone();
        for (&slot, record) in &records {
            moved[slot] = Value::object(record.clone());
        }
        let mut shown = frame.as_obj().cloned().unwrap_or_default();
        shown.set("objects", Value::array(moved));
        let joints = (context.geometry)(&Value::object(shown), &with_parents(&objects, &slots))?;
        for &slot in &slots {
            if join_target(&objects[slot]).is_none() {
                continue;
            }
            if let Some(joints) = joints.get(&slot) {
                let root = joints.root();
                if let Some(record) = records.get_mut(&slot) {
                    record.set("root_x", Value::Num(root[0]));
                    record.set("root_y", Value::Num(root[1]));
                }
            }
        }
    }
    let json = styk_doc::json::to_string;
    let changed: Vec<usize> = records.iter().filter(|(slot, record)| json(&Value::object((*record).clone())) != json(&objects[**slot])).map(|(slot, _)| *slot).collect();
    if changed.is_empty() {
        return Ok(None);
    }
    let mut next = objects.clone();
    for (&slot, record) in &records {
        next[slot] = Value::object(record.clone());
    }
    let mut out = frame.as_obj().cloned().unwrap_or_default();
    out.set("objects", Value::array(next.clone()));
    Ok(Some(Planned { frame: Value::object(out), changed: changed.iter().filter_map(|&slot| uid(&next[slot])).collect(), structural: false }))
}

fn slots_sorted(slots: &[usize]) -> Vec<usize> {
    let mut sorted = slots.to_vec();
    sorted.sort_unstable();
    sorted
}

/// `selectionBounds`: the box that holds the selected figures, as `[min x, min y, max x, max y]`.
fn selection_bounds(context: &Context, frame: &Value, selected: &[usize]) -> Result<[f64; 4], EditError> {
    let measured = (context.bounds)(frame, &slots_sorted(selected))?;
    let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for slot in selected {
        let Some(b) = measured.get(slot) else { continue };
        bounds = [bounds[0].min(b[0]), bounds[1].min(b[1]), bounds[2].max(b[2]), bounds[3].max(b[3])];
    }
    if bounds.iter().any(|b| !b.is_finite()) {
        return Err(invalid(UNRESOLVED));
    }
    Ok(bounds)
}

/// `joint_angle`, `joint_length` and `joint_bend` of the primary figure's selected joint. Whether the frame has that joint.
fn joint_pose(context: &Context, objects: &[Value], records: &mut BTreeMap<usize, Obj>, primary: usize, pose: &Pose) -> Result<bool, EditError> {
    let figure = figure_of(context.figures, &objects[primary]);
    let segments = segments_of(figure);
    let Some(joint) = usize::try_from(pose.joint).ok().filter(|joint| *joint < segments.len()) else { return Ok(false) };
    let segment = &segments[joint];
    let object = &objects[primary];
    if pose.key == "joint_length" {
        if !object.get("len_flag").is_some_and(Value::truthy) {
            records.get_mut(&primary).unwrap().set("lengths", Value::array(segments.iter().map(|s| Value::Num(number(s, "length"))).collect()));
        }
        let record = records.get_mut(&primary).unwrap();
        record.set("len_flag", Value::Num(1.0));
        crate::pose::set_item_at(record, "lengths", joint, pose.value);
        return Ok(true);
    }
    let angle = pose.key == "joint_angle";
    let current = if angle {
        item(object, "angles", joint).unwrap_or(f64::NAN)
    } else if object.get("bend_flag").is_some_and(Value::truthy) {
        item(object, "bends", joint).unwrap_or(f64::NAN)
    } else {
        num(segment, "bend_rad").unwrap_or(0.0)
    };
    let delta = radians(pose.value) - current;
    let mut by_slot: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (slot, index) in rotation_targets(objects, context.figures, primary, joint, false) {
        if angle || slot != primary || index != joint {
            by_slot.entry(slot).or_default().push(index);
        }
    }
    for (slot, indices) in by_slot {
        let record = records.entry(slot).or_insert_with(|| objects[slot].as_obj().cloned().unwrap_or_default());
        add_angles(record, &indices, delta);
        if slot != primary
            && let Some(figure) = figure_of(context.figures, &objects[slot])
        {
            crate::origin::rotate_support(figure, record, delta);
        }
    }
    if !angle {
        if !object.get("bend_flag").is_some_and(Value::truthy) {
            records.get_mut(&primary).unwrap().set("bends", Value::array(segments.iter().map(|s| Value::Num(num(s, "bend_rad").unwrap_or(0.0))).collect()));
        }
        let record = records.get_mut(&primary).unwrap();
        record.set("bend_flag", Value::Num(1.0));
        crate::pose::set_item_at(record, "bends", joint, radians(pose.value));
    }
    Ok(true)
}

/// `(value * Math.PI) / 180`, as the inspector's code writes it.
fn radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}
