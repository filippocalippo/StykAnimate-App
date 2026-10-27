//! `planFigureFrameOperation`: what one figure control
//! does to one frame record, copy-on-write. Slots address joins; unique ids name the same
//! figure across frames. Numeric scale changes the selected figures only; flips and turns
//! take the figures joined below them too. The caller commits every planned frame together
//! and owns history and selection ([`crate::range`]).

use std::collections::{BTreeMap, HashMap, HashSet};

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::record::{num, uid};
use crate::EditError;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

pub(crate) const NOT_NATIVE: &str = "errors.rangeFigureOperations.mustBeFiniteAndWithinTheNativeNumeric";

/// `finite(value, label)`: a number, finite in single precision too.
pub(crate) fn native_finite(value: Option<f64>, label: &str) -> Result<f64, EditError> {
    match value {
        Some(value) if value.is_finite() && (value as f32).is_finite() => Ok(value),
        _ => Err(crate::invalid_with(NOT_NATIVE, vec![("label", crate::label(label))])),
    }
}

/// `integer(value, min, max, label)`.
pub(crate) fn integer(value: Option<f64>, min: f64, max: f64, label: &str) -> Result<f64, EditError> {
    match value {
        Some(value) if value.fract() == 0.0 && value >= min && value <= max => Ok(value),
        _ => Err(crate::invalid_with("errors.rangeFigureOperations.invalid", vec![("label", crate::label(label))])),
    }
}

/// `Math.round(x)`: halves go up.
pub(crate) fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Object.is(a, b)` for a patch value against what the object holds: a new record is never
/// the one held.
fn object_is(held: Option<&Value>, value: &Value) -> bool {
    match (held, value) {
        (Some(Value::Num(a)), Value::Num(b)) => a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()),
        (Some(Value::Null), Value::Null) => true,
        (Some(Value::Bool(a)), Value::Bool(b)) => a == b,
        (Some(Value::Str(a)), Value::Str(b)) => a == b,
        _ => false,
    }
}

/// A figure order step: `front`, `back` or a signed number of places within its layer.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Direction {
    Front,
    Back,
    Steps(f64),
}

/// The part of one figure a branch flip turns over (`segmentSelection`): the selected
/// figure's selected handles, and with `branch` (a selected branch) everything below them,
/// the figures joined at those handles turning with it.
#[derive(Clone, Debug)]
pub(crate) struct Part {
    pub uid: Option<u32>,
    pub handles: Vec<f64>,
    pub branch: bool,
}

/// A validated operation (`validateOperation`).
#[derive(Clone, Debug)]
pub(crate) enum Kind {
    /// The figures' colour and transparency fields, in the patch's order.
    Appearance(Vec<(String, f64)>),
    Recolor(Box<crate::recolor::Recolor>),
    Order { direction: Direction, numeric: bool },
    Join { target: f64, handle: f64 },
    Scale { factor: Option<f64>, value: Option<f64>, reference: Option<Value> },
    Mirror { horizontal: bool, part: Option<Part> },
    Duplicate { map: Vec<(u32, u32)>, offset: f64 },
    Rotate(f64),
    Center,
    Align { axis: String, edge: String, bounds: crate::bounds::Callback },
    Delete,
    Detach,
    Reset,
    /// A pose property at one value ([`crate::pose_value`]).
    Pose(crate::pose_value::Pose),
}

#[derive(Clone, Debug)]
pub(crate) struct Operation {
    pub kind: Kind,
    pub center: Option<[f64; 2]>,
}

/// The joints of a figure as geometry resolved them: its root first (handle 0).
#[derive(Clone, Debug, Default)]
pub(crate) struct Joints {
    pub points: Vec<(f64, [f64; 2])>,
}

impl Joints {
    pub(crate) fn root(&self) -> [f64; 2] {
        self.points.first().map_or([f64::NAN; 2], |(_, p)| *p)
    }

    pub(crate) fn get(&self, handle: f64) -> Option<[f64; 2]> {
        self.points.iter().find(|(h, _)| *h == handle).map(|(_, p)| *p)
    }
}

/// `buildGeometry(report, frame)` for the figures at some slots of a frame record.
pub(crate) type GeometryOf<'a> = dyn Fn(&Value, &[usize]) -> Result<HashMap<usize, Joints>, EditError> + 'a;

/// The app's `boundsOf` of the figures at some slots of a frame record, by slot.
pub(crate) type BoundsOf<'a> = dyn Fn(&Value, &[usize]) -> Result<HashMap<usize, [f64; 4]>, EditError> + 'a;

/// Children by parent slot, and the slots parents first.
pub(crate) type Hierarchy = (HashMap<usize, Vec<usize>>, Vec<usize>);

/// What planning one frame reads besides the frame: the document's figure definitions,
/// figure layers and the geometry of a frame's figures.
pub(crate) struct Context<'a> {
    pub figures: &'a [Value],
    /// The document's format version (`report.version`): colours of format 4 are whole-figure overrides.
    pub version: f64,
    pub canvas: [f64; 2],
    pub layer_of: &'a dyn Fn(u32) -> String,
    /// `buildGeometry(report, frame)` for the figures at `slots` (sorted), each figure's
    /// joints, or the editor's error when one is unresolved.
    pub geometry: &'a GeometryOf<'a>,
    /// What the app's bounds callback measures of a frame's figures.
    pub bounds: &'a BoundsOf<'a>,
    /// The origin owner reflects retained support and local offsets in JS order.
    pub mirror_origin: &'a dyn Fn(&Value, &Value, &mut Obj, bool) -> Result<(), EditError>,
}

/// A planned frame (`{frame, changedUids, structural}`).
#[derive(Clone, Debug)]
pub(crate) struct Planned {
    pub frame: Value,
    pub changed: Vec<u32>,
    pub structural: bool,
}

/// `hierarchy(objects)`: children by parent slot and the slots parents first.
pub(crate) fn hierarchy(objects: &[Value]) -> Result<Hierarchy, EditError> {
    let mut children: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut ready = Vec::new();
    for (slot, object) in objects.iter().enumerate() {
        match object.get("join").filter(|j| j.truthy()) {
            None => ready.push(slot),
            Some(join) => {
                let parent = num(join, "target_object_slot").filter(|p| p.fract() == 0.0 && *p >= 0.0 && (*p as usize) < objects.len());
                let Some(parent) = parent else { return Err(invalid("errors.editorSelection.joinTargetIsMissing")) };
                children.entry(parent as usize).or_default().push(slot);
            }
        }
    }
    let mut i = 0;
    while i < ready.len() {
        if let Some(list) = children.get(&ready[i]) {
            ready.extend(list.iter().copied());
        }
        i += 1;
    }
    if ready.len() != objects.len() {
        return Err(invalid("errors.editorSelection.figuresContainACyclicJoin"));
    }
    Ok((children, ready))
}

/// `descendants(children, slots)`.
fn descendants(children: &HashMap<usize, Vec<usize>>, slots: impl IntoIterator<Item = usize>) -> HashSet<usize> {
    let mut queue: Vec<usize> = Vec::new();
    let mut affected = HashSet::new();
    for slot in slots {
        if affected.insert(slot) {
            queue.push(slot);
        }
    }
    let mut i = 0;
    while i < queue.len() {
        for &child in children.get(&queue[i]).map(Vec::as_slice).unwrap_or(&[]) {
            if affected.insert(child) {
                queue.push(child);
            }
        }
        i += 1;
    }
    affected
}

/// `nativeOrder(frame)`: the drawing order as slots, checked.
fn native_order(frame: &Value, count: usize) -> Result<Vec<usize>, EditError> {
    let order: Vec<f64> = match frame.get("object_draw_order").filter(|o| !o.is_null()) {
        Some(order) => order.elements().map(|e| e.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default(),
        None => (0..count).map(|slot| slot as f64).collect(),
    };
    let mut seen = HashSet::new();
    if order.len() != count || order.iter().any(|&slot| !(slot.fract() == 0.0 && slot >= 0.0 && (slot as usize) < count) || !seen.insert(slot as usize)) {
        return Err(invalid("errors.layers.invalidNativeFigureOrder"));
    }
    Ok(order.into_iter().map(|slot| slot as usize).collect())
}

/// `movedOrder(order, selected, direction)`: a stable, linear move of the selected slots.
fn moved_order(order: &[usize], selected: &HashSet<usize>, direction: Direction) -> Vec<usize> {
    let others: Vec<usize> = order.iter().copied().filter(|s| !selected.contains(s)).collect();
    let steps = match direction {
        Direction::Front => order.len() as f64,
        Direction::Back => -(order.len() as f64),
        Direction::Steps(n) => n,
    };
    let mut passed = 0.0;
    let mut targets: Vec<(usize, f64)> = Vec::new();
    for &slot in order {
        if selected.contains(&slot) {
            targets.push((slot, (passed + steps).min(others.len() as f64).max(0.0)));
        } else {
            passed += 1.0;
        }
    }
    let mut result = Vec::with_capacity(order.len());
    let mut cursor = 0;
    for index in 0..=others.len() {
        while cursor < targets.len() && targets[cursor].1 == index as f64 {
            result.push(targets[cursor].0);
            cursor += 1;
        }
        if index < others.len() {
            result.push(others[index]);
        }
    }
    result
}

/// A number of a figure record as JavaScript reads it (`undefined` and `null` as absent).
fn given(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn item(value: &Value, key: &str, index: usize) -> Option<f64> {
    value.get(key).and_then(|list| list.item(index)).and_then(|v| v.as_f64())
}

/// `jointEndpoints(object, figure, root)`: every handle's end, rounded to single precision
/// as native files store them, without the renderer's arcs (`styk-math` trigonometry).
pub(crate) fn joint_endpoints(object: &Value, figure: Option<&Value>, root: [f64; 2]) -> Result<Joints, EditError> {
    let Some(figure) = figure else { return Err(invalid("errors.rangeFigureOperations.unknownFigureDefinition")) };
    let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let handles: HashSet<u64> = segments.iter().filter_map(|s| given(s, "segment_id")).map(f64::to_bits).collect();
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut ready = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        match segment.get("parent_id").and_then(Value::as_f64).filter(|p| handles.contains(&p.to_bits())) {
            None => ready.push(index),
            Some(parent) => children.entry(parent.to_bits()).or_default().push(index),
        }
    }
    let mut joints = Joints { points: vec![(0.0, root)] };
    let scale = given(object, "scale").unwrap_or(f64::NAN);
    let lengths = object.get("len_flag").is_some_and(Value::truthy);
    let bends = object.get("bend_flag").is_some_and(Value::truthy);
    let mut cursor = 0;
    while cursor < ready.len() {
        let index = ready[cursor];
        let segment = &segments[index];
        let start = segment.get("parent_id").and_then(Value::as_f64).and_then(|p| joints.get(p)).unwrap_or(root);
        let angle = item(object, "angles", index).or_else(|| given(segment, "angle_rad")).unwrap_or(0.0);
        let bend = if bends { item(object, "bends", index).unwrap_or(0.0) } else { given(segment, "bend_rad").unwrap_or(0.0) };
        let length = if lengths { item(object, "lengths", index).or_else(|| given(segment, "length")).unwrap_or(f64::NAN) } else { given(segment, "length").unwrap_or(0.0) } * scale;
        let (x, y) = if bend.abs() < 1e-7 {
            (start[0] + length * styk_math::cos(angle), start[1] + length * styk_math::sin(angle))
        } else {
            let radius = length / bend;
            (start[0] + radius * (styk_math::sin(angle + bend) - styk_math::sin(angle)), start[1] + radius * (styk_math::cos(angle) - styk_math::cos(angle + bend)))
        };
        let point = [native_finite(Some(x), "Joint X")? as f32 as f64, native_finite(Some(y), "Joint Y")? as f32 as f64];
        let id = given(segment, "segment_id").unwrap_or(f64::NAN);
        match joints.points.iter_mut().find(|(h, _)| *h == id) {
            Some(entry) => entry.1 = point,
            None => joints.points.push((id, point)),
        }
        if let Some(list) = children.get(&id.to_bits()) {
            ready.extend(list.iter().copied());
        }
        cursor += 1;
    }
    if ready.len() != segments.len() {
        return Err(invalid("errors.rangeFigureOperations.figureContainsACyclicSegmentHierarchy"));
    }
    Ok(joints)
}

/// The changed figures of one frame, by slot, and how they were patched.
struct Changes<'a> {
    objects: &'a [Value],
    changes: BTreeMap<usize, Obj>,
    /// Slots in the order they were first changed (`changes.keys()` of a `Map`).
    order: Vec<usize>,
}

impl<'a> Changes<'a> {
    fn current(&self, slot: usize) -> Value {
        match self.changes.get(&slot) {
            Some(record) => Value::object(record.clone()),
            None => self.objects[slot].clone(),
        }
    }

    /// `patchObject(slot, patch, remove)`: nothing when every value is already held.
    fn patch(&mut self, slot: usize, patch: Vec<(&str, Value)>, remove: &[&str]) -> Value {
        let source = self.current(slot);
        if patch.iter().all(|(key, value)| object_is(source.get(key), value)) && remove.iter().all(|key| source.get(key).is_none()) {
            return source;
        }
        if !self.changes.contains_key(&slot) {
            self.order.push(slot);
        }
        let next = self.changes.entry(slot).or_insert_with(|| source.as_obj().cloned().unwrap_or_default());
        for (key, value) in patch {
            next.set(key, value);
        }
        for key in remove {
            next.remove(key);
        }
        Value::object(next.clone())
    }

    fn replace(&mut self, slot: usize, record: Obj) {
        if !self.changes.contains_key(&slot) {
            self.order.push(slot);
        }
        self.changes.insert(slot, record);
    }

    /// `result(structural)`.
    fn result(&self, frame: &Value, structural: bool) -> Option<Planned> {
        if self.changes.is_empty() {
            return None;
        }
        let mut out = frame.as_obj().cloned().unwrap_or_default();
        out.set("objects", Value::array(self.objects.iter().enumerate().map(|(slot, o)| self.current_or(slot, o)).collect()));
        let changed = self.changes.keys().filter_map(|&slot| uid(&self.objects[slot])).collect();
        Some(Planned { frame: Value::object(out), changed, structural })
    }

    fn current_or(&self, slot: usize, object: &Value) -> Value {
        self.changes.get(&slot).map_or_else(|| object.clone(), |record| Value::object(record.clone()))
    }
}

fn figure_of<'f>(figures: &'f [Value], object: &Value) -> Option<&'f Value> {
    let id = given(object, "figure_type_id");
    figures.iter().find(|f| given(f, "figure_type_id") == id && id.is_some())
}

fn segments_of(figure: Option<&Value>) -> Vec<Value> {
    figure.and_then(|f| f.get("segments")).and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    value.and_then(Value::elements).map(|e| e.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default()
}

/// `planFigureFrameOperation(report, frame, uids, operation)` for an operation already
/// validated: `None` when no selected figure is in the frame or nothing changes.
pub(crate) fn plan(context: &Context, frame: &Value, uids: &[u32], operation: &Operation) -> Result<Option<Planned>, EditError> {
    let objects = objects_of(frame);
    let slots: Vec<usize> = objects.iter().enumerate().filter(|(_, o)| uid(o).is_some_and(|u| uids.contains(&u))).map(|(slot, _)| slot).collect();
    if slots.is_empty() {
        return Ok(None);
    }
    if let Kind::Pose(pose) = &operation.kind {
        return crate::pose_value::plan(context, frame, &slots, pose);
    }
    let selected: HashSet<usize> = slots.iter().copied().collect();
    let mut changes = Changes { objects: &objects, changes: BTreeMap::new(), order: Vec::new() };
    let source_hierarchy = std::cell::OnceCell::new();
    let get_hierarchy = || -> Result<Hierarchy, EditError> {
        if let Some(found) = source_hierarchy.get() {
            return Ok(Clone::clone(found));
        }
        let built = hierarchy(&objects)?;
        let _ = source_hierarchy.set(built.clone());
        Ok(built)
    };
    let geometry_cell: std::cell::OnceCell<HashMap<usize, Joints>> = std::cell::OnceCell::new();
    let get_geometry = || -> Result<HashMap<usize, Joints>, EditError> {
        if let Some(found) = geometry_cell.get() {
            return Ok(found.clone());
        }
        // Only the edited component and what it hangs from, not every figure of the frame.
        let (children, _) = get_hierarchy()?;
        let mut needed: HashSet<usize> = match &operation.kind {
            Kind::Scale { .. } | Kind::Mirror { .. } | Kind::Rotate(_) | Kind::Join { .. } => descendants(&children, slots.iter().copied()),
            Kind::Delete => objects
                .iter()
                .enumerate()
                .filter(|(slot, o)| !selected.contains(slot) && o.get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot")).is_some_and(|p| p >= 0.0 && selected.contains(&(p as usize))))
                .map(|(slot, _)| slot)
                .collect(),
            _ => slots.iter().copied().collect(),
        };
        if let Kind::Join { target, .. } = &operation.kind
            && let Some(at) = objects.iter().position(|o| given(o, "unique_id") == Some(*target))
        {
            needed.insert(at);
        }
        let mut queue: Vec<usize> = needed.iter().copied().collect();
        let mut i = 0;
        while i < queue.len() {
            if let Some(parent) = objects[queue[i]].get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot")).filter(|p| *p >= 0.0).map(|p| p as usize)
                && needed.insert(parent)
            {
                queue.push(parent);
            }
            i += 1;
        }
        let mut ordered: Vec<usize> = needed.into_iter().collect();
        ordered.sort_unstable();
        let built = (context.geometry)(frame, &ordered)?;
        if ordered.iter().any(|slot| !built.contains_key(slot)) {
            return Err(invalid("errors.rangeFigureOperations.cannotTransformAFrameWithUnresolvedFigureGeometry"));
        }
        let _ = geometry_cell.set(built.clone());
        Ok(built)
    };
    let joined = |slot: usize| objects[slot].get("join").filter(|j| j.truthy()).cloned();

    match &operation.kind {
        Kind::Appearance(patch) => {
            let remove: &[&str] = if patch.iter().any(|(k, _)| k == "color_override_raw") { &["color_transition"] } else { &[] };
            for &slot in &slots {
                changes.patch(slot, patch.iter().map(|(k, v)| (k.as_str(), Value::Num(*v))).collect(), remove);
            }
            return Ok(changes.result(frame, false));
        }
        Kind::Recolor(recolor) => {
            for &slot in &slots {
                let object = &objects[slot];
                if let Some(mut next) = crate::recolor::recolor_object(context.version, figure_of(context.figures, object), object, recolor)? {
                    if recolor.mode != crate::recolor::Mode::All || recolor.color.is_some() {
                        next.remove("color_transition");
                    }
                    next.remove("runtime_segments");
                    changes.replace(slot, next);
                }
            }
            return Ok(changes.result(frame, false));
        }
        Kind::Duplicate { map, offset } => {
            if objects.len() + slots.len() > 65535 {
                return Err(invalid("errors.editorRangeCommands.aNativeKeyframeSupportsAtMost65535"));
            }
            let renamed = |old: Option<u32>| old.and_then(|old| map.iter().find(|(from, _)| *from == old)).map(|(_, to)| *to);
            let mut occupied: HashSet<u32> = objects.iter().filter_map(uid).collect();
            let mut next_slots: HashMap<usize, usize> = HashMap::new();
            for &slot in &slots {
                let id = integer(renamed(uid(&objects[slot])).map(|u| u as f64), 0.0, 4294967295.0, "duplicate figure identity")? as u32;
                if !occupied.insert(id) {
                    return Err(invalid("errors.rangeFigureOperations.duplicateFigureIdentitiesMustBeFreshAndDistinct"));
                }
                next_slots.insert(slot, objects.len() + next_slots.len());
            }
            let mut copied: HashMap<usize, Obj> = HashMap::new();
            for &slot in &slots {
                let original = &objects[slot];
                let mut object = original.as_obj().cloned().unwrap_or_default();
                object.set("unique_id", Value::Num(renamed(uid(original)).unwrap_or(0) as f64));
                object.set("object_slot", Value::Num(next_slots[&slot] as f64));
                for (key, value) in materialized(original, figure_of(context.figures, original)) { object.set(key, value); }
                let root = if joined(slot).is_some() { get_geometry()?[&slot].root() } else { [given(original, "root_x").unwrap_or(f64::NAN), given(original, "root_y").unwrap_or(f64::NAN)] };
                object.set("root_x", Value::Num(native_finite(Some(root[0] + offset), "Duplicate X")?));
                object.set("root_y", Value::Num(native_finite(Some(root[1] + offset), "Duplicate Y")?));
                let target = joined(slot).and_then(|j| num(&j, "target_object_slot")).filter(|t| *t >= 0.0).map(|t| t as usize);
                let join = match (joined(slot), target.filter(|t| selected.contains(t))) {
                    (Some(join), Some(target)) => {
                        let mut join = join.as_obj().cloned().unwrap_or_default();
                        join.set("target_object_slot", Value::Num(next_slots[&target] as f64));
                        join.set("target_unique_id", Value::Num(renamed(uid(&objects[target])).unwrap_or(0) as f64));
                        Value::object(join)
                    }
                    _ => Value::Null,
                };
                object.set("join", join);
                object.remove("runtime_segments");
                copied.insert(slot, object);
            }
            // Copied attachments are made canonical parents first.
            let (children, order) = get_hierarchy()?;
            let mut endpoints: HashMap<usize, Joints> = HashMap::new();
            for slot in order.into_iter().filter(|s| selected.contains(s)) {
                let original = &objects[slot];
                let object = copied.get_mut(&slot).unwrap();
                if let Some(join) = object.get("join").filter(|j| j.truthy()).cloned() {
                    let parent = joined(slot).and_then(|j| num(&j, "target_object_slot")).map(|p| p as usize);
                    let root = parent.and_then(|p| endpoints.get(&p)).and_then(|joints| joints.get(num(&join, "target_handle_id").unwrap_or(f64::NAN)));
                    let Some(root) = root else { return Err(invalid("errors.rangeFigureOperations.duplicateAttachmentHasAnUnresolvedJoint")) };
                    object.set("root_x", Value::Num(root[0]));
                    object.set("root_y", Value::Num(root[1]));
                }
                if children.get(&slot).is_some_and(|list| list.iter().any(|c| selected.contains(c))) {
                    let record = Value::object(object.clone());
                    let root = [given(&record, "root_x").unwrap_or(f64::NAN), given(&record, "root_y").unwrap_or(f64::NAN)];
                    endpoints.insert(slot, joint_endpoints(&record, figure_of(context.figures, &record), root)?);
                }
                let _ = original;
            }
            let added: Vec<Value> = slots.iter().map(|slot| Value::object(copied.remove(slot).unwrap())).collect();
            let before = native_order(frame, objects.len())?;
            let mut next = objects.clone();
            next.extend(added.iter().cloned());
            let mut draw = before.clone();
            draw.extend(before.iter().filter(|s| selected.contains(s)).map(|s| next_slots[s]));
            let mut out = frame.as_obj().cloned().unwrap_or_default();
            out.set("objects", Value::array(next.clone()));
            out.set("object_draw_order", Value::array(draw.iter().map(|&s| Value::Num(s as f64)).collect()));
            out.set("object_draw_order_unique_ids", Value::array(draw.iter().map(|&s| next[s].get("unique_id").cloned().unwrap_or(Value::Null)).collect()));
            if out.contains("object_count") {
                out.set("object_count", Value::Num(next.len() as f64));
            }
            return Ok(Some(Planned { frame: Value::object(out), changed: added.iter().filter_map(uid).collect(), structural: true }));
        }
        Kind::Order { direction, numeric } => {
            let before = native_order(frame, objects.len())?;
            let mut groups: Vec<(String, Vec<usize>, usize)> = Vec::new();
            let layer_of_slot = |slot: usize| uid(&objects[slot]).map(|u| (context.layer_of)(u)).unwrap_or_default();
            for &slot in &before {
                let layer = layer_of_slot(slot);
                match groups.iter_mut().find(|(id, _, _)| *id == layer) {
                    Some((_, order, _)) => order.push(slot),
                    None => groups.push((layer, vec![slot], 0)),
                }
            }
            let depth = |slot: usize| given(&objects[slot], "_stykZIndex").unwrap_or(0.0);
            let ranks: HashMap<usize, usize> = before.iter().enumerate().map(|(index, &slot)| (slot, index)).collect();
            for (_, order, _) in groups.iter_mut() {
                let mut depths: Vec<f64> = order.iter().map(|&slot| depth(slot)).collect();
                let moved = moved_order(order, &selected, *direction);
                if moved == *order {
                    continue;
                }
                *order = moved;
                if *numeric {
                    // Reordered ties are separated, unchanged runs keep equal depths; working in
                    // the direction of the move usually keys only the selection.
                    let gap = |a: usize, b: usize| if ranks[&a] > ranks[&b] || depth(a) != depth(b) { 1.0 } else { 0.0 };
                    let backwards = match direction {
                        Direction::Back => true,
                        Direction::Steps(n) => *n < 0.0,
                        Direction::Front => false,
                    };
                    if backwards {
                        for i in (0..depths.len().saturating_sub(1)).rev() {
                            depths[i] = depths[i].min(depths[i + 1] - gap(order[i], order[i + 1]));
                        }
                    } else {
                        for i in 1..depths.len() {
                            depths[i] = depths[i].max(depths[i - 1] + gap(order[i - 1], order[i]));
                        }
                    }
                    let last = *depths.last().unwrap();
                    let overflow = (last - 1_000_000.0).max(0.0);
                    if overflow != 0.0 {
                        depths.iter_mut().for_each(|d| *d -= overflow);
                    }
                    let underflow = (-1_000_000.0 - depths[0]).max(0.0);
                    if underflow != 0.0 && depths.last().unwrap() + underflow <= 1_000_000.0 {
                        depths.iter_mut().for_each(|d| *d += underflow);
                    }
                    if depths[0] < -1_000_000.0 {
                        if depths.len() > 2_000_001 {
                            return Err(invalid("errors.rangeFigureOperations.tooManyFiguresToAssignDistinctZIndex"));
                        }
                        let half = (depths.len() / 2) as f64;
                        for (i, d) in depths.iter_mut().enumerate() {
                            *d = i as f64 - half;
                        }
                    }
                }
                for (index, &slot) in order.iter().enumerate() {
                    if depth(slot) != depths[index] {
                        changes.patch(slot, vec![("_stykZIndex", Value::Num(depths[index]))], &[]);
                    }
                }
            }
            let after: Vec<usize> = before
                .iter()
                .map(|&slot| {
                    let layer = layer_of_slot(slot);
                    let (_, order, cursor) = groups.iter_mut().find(|(id, _, _)| *id == layer).unwrap();
                    *cursor += 1;
                    order[*cursor - 1]
                })
                .collect();
            let mut changed_slots: Vec<usize> = Vec::new();
            for slot in after.iter().zip(&before).filter(|(a, b)| a != b).map(|(a, _)| *a).chain(changes.order.iter().copied()) {
                if !changed_slots.contains(&slot) {
                    changed_slots.push(slot);
                }
            }
            if changed_slots.is_empty() {
                return Ok(None);
            }
            let mut out = frame.as_obj().cloned().unwrap_or_default();
            if !changes.changes.is_empty() {
                out.set("objects", Value::array(objects.iter().enumerate().map(|(slot, o)| changes.current_or(slot, o)).collect()));
            }
            out.set("object_draw_order", Value::array(after.iter().map(|&s| Value::Num(s as f64)).collect()));
            out.set("object_draw_order_unique_ids", Value::array(after.iter().map(|&s| objects[s].get("unique_id").cloned().unwrap_or(Value::Null)).collect()));
            return Ok(Some(Planned { frame: Value::object(out), changed: changed_slots.iter().filter_map(|&s| uid(&objects[s])).collect(), structural: true }));
        }
        Kind::Delete => {
            let before = native_order(frame, objects.len())?;
            let mut remap: HashMap<usize, usize> = HashMap::new();
            let mut survivors = Vec::new();
            for slot in 0..objects.len() {
                if !selected.contains(&slot) {
                    remap.insert(slot, survivors.len());
                    survivors.push(slot);
                }
            }
            let mut changed: Vec<u32> = slots.iter().filter_map(|&s| uid(&objects[s])).collect();
            let mut remaining = Vec::with_capacity(survivors.len());
            for &slot in &survivors {
                let object = &objects[slot];
                let next_slot = remap[&slot];
                let mut patch: Vec<(&str, Value)> = Vec::new();
                if given(object, "object_slot") != Some(next_slot as f64) {
                    patch.push(("object_slot", Value::Num(next_slot as f64)));
                }
                if let Some(join) = joined(slot) {
                    let target = num(&join, "target_object_slot").filter(|t| *t >= 0.0).map(|t| t as usize);
                    if target.is_some_and(|t| selected.contains(&t)) {
                        let root = get_geometry()?[&slot].root();
                        patch.push(("join", Value::Null));
                        patch.push(("root_x", Value::Num(root[0])));
                        patch.push(("root_y", Value::Num(root[1])));
                    } else if target.and_then(|t| remap.get(&t)).copied() != target {
                        let mut next = join.as_obj().cloned().unwrap_or_default();
                        next.set("target_object_slot", target.and_then(|t| remap.get(&t)).map_or(Value::Null, |s| Value::Num(*s as f64)));
                        next.set("target_unique_id", target.and_then(|t| objects.get(t)).and_then(|o| o.get("unique_id").cloned()).unwrap_or(Value::Null));
                        patch.push(("join", Value::object(next)));
                    }
                }
                if patch.is_empty() {
                    remaining.push(object.clone());
                } else {
                    changed.extend(uid(object));
                    let mut record = object.as_obj().cloned().unwrap_or_default();
                    for (key, value) in patch {
                        record.set(key, value);
                    }
                    remaining.push(Value::object(record));
                }
            }
            let order: Vec<usize> = before.iter().filter(|s| !selected.contains(s)).map(|s| remap[s]).collect();
            let mut out = frame.as_obj().cloned().unwrap_or_default();
            out.set("objects", Value::array(remaining.clone()));
            out.set("object_draw_order", Value::array(order.iter().map(|&s| Value::Num(s as f64)).collect()));
            out.set("object_draw_order_unique_ids", Value::array(order.iter().map(|&s| remaining[s].get("unique_id").cloned().unwrap_or(Value::Null)).collect()));
            if out.contains("object_count") {
                out.set("object_count", Value::Num(remaining.len() as f64));
            }
            return Ok(Some(Planned { frame: Value::object(out), changed, structural: true }));
        }
        Kind::Detach => {
            for &slot in &slots {
                if joined(slot).is_some() {
                    let root = get_geometry()?[&slot].root();
                    changes.patch(slot, vec![("join", Value::Null), ("root_x", Value::Num(root[0])), ("root_y", Value::Num(root[1]))], &[]);
                }
            }
            return Ok(changes.result(frame, true));
        }
        _ => {}
    }

    let (children, order) = get_hierarchy()?;
    match &operation.kind {
        Kind::Reset => {
            for &slot in &slots {
                let original = &objects[slot];
                let Some(figure) = figure_of(context.figures, original) else { return Err(invalid("errors.rangeFigureOperations.unknownFigureDefinition")) };
                let angles: Vec<f64> = segments_of(Some(figure)).iter().map(|s| given(s, "angle_rad").unwrap_or(0.0)).collect();
                let held = numbers(original.get("angles"));
                let mut reset = original.as_obj().cloned().unwrap_or_default();
                crate::origin::reset_support(figure, &mut reset);
                let ghosts_changed = original.path(&["_stykAnimationOrigin", "ghosts"]) != reset.get("_stykAnimationOrigin").and_then(|origin| origin.get("ghosts"));
                let empty = |key: &str| original.get(key).and_then(Value::array_len).is_none_or(|n| n == 0);
                if !ghosts_changed && original.get("runtime_segments").is_none() && !original.get("len_flag").is_some_and(Value::truthy) && !original.get("bend_flag").is_some_and(Value::truthy) && empty("lengths") && empty("bends") && held.len() == angles.len() && held.iter().zip(&angles).all(|(a, b)| a == b) {
                    continue;
                }
                let mut patch = vec![
                    ("angles", Value::array(angles.iter().map(|&a| Value::Num(a)).collect())),
                    ("len_flag", Value::Num(0.0)),
                    ("bend_flag", Value::Num(0.0)),
                    ("lengths", Value::array(Vec::new())),
                    ("bends", Value::array(Vec::new())),
                ];
                if ghosts_changed { patch.push(("_stykAnimationOrigin", reset.get("_stykAnimationOrigin").cloned().unwrap_or(Value::Null))); }
                changes.patch(slot, patch, &["runtime_segments"]);
            }
            if changes.changes.is_empty() {
                return Ok(None);
            }
        }
        Kind::Align { axis, edge, bounds } => {
            get_hierarchy()?;
            let groups = crate::bounds::groups(&objects, uids)?;
            if groups.len() < 2 { return Ok(None); }
            let position = if axis == "x" { "root_x" } else { "root_y" };
            // The range measures every figure; the editor throws on one it has no geometry for.
            let measured = match bounds {
                crate::bounds::Callback::App => (context.bounds)(frame, &groups.iter().flat_map(|(_, members)| members.iter().copied()).collect::<Vec<_>>())?,
                _ => HashMap::new(),
            };
            let measure = &mut crate::bounds::measure_with(bounds, &measured);
            let mut measure = |slot, id| measure(slot, id).and_then(|found| found.ok_or_else(|| EditError::Unported("bounds of a figure without geometry".into())).map(Some));
            for (root, target, position_at) in crate::bounds::offsets(&objects, &groups, axis, edge, &mut measure)? {
                let value = native_finite(Some(given(&objects[root], position).unwrap_or(f64::NAN) + target - position_at), "Figure position")?;
                changes.patch(root, vec![(position, Value::Num(value))], &[]);
            }
            if changes.changes.is_empty() { return Ok(None); }
        }
        Kind::Center => {
            let mut roots: HashMap<usize, usize> = HashMap::new();
            for &slot in &order {
                let root = match joined(slot).and_then(|j| num(&j, "target_object_slot")) {
                    Some(parent) => roots.get(&(parent as usize)).copied().unwrap_or(slot),
                    None => slot,
                };
                roots.insert(slot, root);
            }
            let mut groups: Vec<usize> = Vec::new();
            for &slot in &slots {
                let root = roots[&slot];
                if !groups.contains(&root) {
                    groups.push(root);
                }
            }
            let geometry = get_geometry()?;
            let center = if slots.len() == 1 {
                geometry[&slots[0]].root()
            } else {
                let (mut min, mut max) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
                for slot in &slots {
                    for (_, p) in &geometry[slot].points {
                        min = [min[0].min(p[0]), min[1].min(p[1])];
                        max = [max[0].max(p[0]), max[1].max(p[1])];
                    }
                }
                [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0]
            };
            let (dx, dy) = (context.canvas[0] / 2.0 - center[0], context.canvas[1] / 2.0 - center[1]);
            for root in groups {
                let object = &objects[root];
                let x = native_finite(Some(given(object, "root_x").unwrap_or(f64::NAN) + dx), "Figure X")?;
                let y = native_finite(Some(given(object, "root_y").unwrap_or(f64::NAN) + dy), "Figure Y")?;
                changes.patch(root, vec![("root_x", Value::Num(x)), ("root_y", Value::Num(y))], &[]);
            }
            if changes.changes.is_empty() {
                return Ok(None);
            }
        }
        Kind::Join { target: target_uid, handle } => {
            let Some(target) = objects.iter().position(|o| given(o, "unique_id") == Some(*target_uid)) else { return Ok(None) };
            let figure = figure_of(context.figures, &objects[target]);
            let valid = figure.is_some_and(|f| *handle == 0.0 || segments_of(Some(f)).iter().any(|s| given(s, "segment_id") == Some(*handle)));
            if !valid {
                return Err(invalid("errors.rangeFigureOperations.chooseAValidTargetJoint"));
            }
            let mut cursor = Some(target);
            while let Some(at) = cursor {
                if selected.contains(&at) {
                    return Err(invalid("errors.editor.joiningTheseFiguresWouldCreateACycle"));
                }
                cursor = joined(at).and_then(|j| num(&j, "target_object_slot")).filter(|p| *p >= 0.0).map(|p| p as usize);
            }
            for &slot in &slots {
                let join = joined(slot);
                if let Some(join) = &join
                    && num(join, "target_object_slot") == Some(target as f64)
                    && num(join, "target_handle_id") == Some(*handle)
                    && num(join, "target_unique_id") == Some(*target_uid)
                {
                    continue;
                }
                let mut next = join.and_then(|j| j.as_obj().cloned()).unwrap_or_default();
                next.set("target_object_slot", Value::Num(target as f64));
                next.set("target_unique_id", Value::Num(*target_uid));
                next.set("target_handle_id", Value::Num(*handle));
                changes.patch(slot, vec![("join", Value::object(next))], &[]);
            }
            if changes.changes.is_empty() {
                return Ok(None);
            }
        }
        Kind::Scale { .. } | Kind::Rotate(_) | Kind::Mirror { .. } => {
            if matches!(operation.kind, Kind::Rotate(r) if r == 0.0) {
                return Ok(None);
            }
            let scale_of = |slot: usize| given(&objects[slot], "scale").unwrap_or(f64::NAN);
            let mut factor = 1.0;
            let mut scales: Option<HashMap<usize, f64>> = None;
            if let Kind::Scale { factor: relative, value, reference } = &operation.kind {
                let mut collapsed = None;
                factor = match relative {
                    Some(f) => *f,
                    None => {
                        let value = value.unwrap_or(f64::NAN);
                        let by_uid = |u: f64| slots.iter().copied().find(|&s| given(&objects[s], "unique_id") == Some(u));
                        let first = uids.iter().find_map(|&u| by_uid(u as f64));
                        let reference = reference.as_ref().and_then(Value::as_f64).and_then(by_uid).or(first).unwrap_or(slots[0]);
                        let original = scale_of(reference);
                        let held = |s: usize| objects[s].get("scale").is_some_and(Value::truthy);
                        let f = if objects[reference].get("scale").is_some_and(Value::truthy) {
                            value / original
                        } else if value == 0.0 || value.is_nan() {
                            1.0
                        } else if slots.iter().all(|&s| !held(s)) {
                            collapsed = Some(value);
                            1.0
                        } else {
                            return Err(invalid("errors.rangeFigureOperations.cannotInferRelativeFigureScalesFromAZero"));
                        };
                        native_finite(Some(f), "Scale factor")?
                    }
                };
                let mut table = HashMap::new();
                for &slot in &slots {
                    table.insert(slot, match collapsed {
                        Some(value) => value,
                        None => native_finite(Some(scale_of(slot) * factor), "Scale")?,
                    });
                }
                if slots.iter().all(|s| table[s] == scale_of(*s)) {
                    return Ok(None);
                }
                scales = Some(table);
            }
            let affected = descendants(&children, slots.iter().copied());
            let geometry = get_geometry()?;
            let mut center = operation.center;
            if center.is_none() && slots.len() == 1 {
                center = Some(geometry[&slots[0]].root());
            }
            let center = match center {
                Some(center) => center,
                None => {
                    let (mut min, mut max) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
                    let members: Vec<usize> = if scales.is_some() { slots.clone() } else { affected.iter().copied().collect() };
                    for slot in members {
                        for (_, p) in &geometry[&slot].points {
                            min = [min[0].min(p[0]), min[1].min(p[1])];
                            max = [max[0].max(p[0]), max[1].max(p[1])];
                        }
                    }
                    [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0]
                }
            };
            let mut transformed: Vec<usize> = if scales.is_some() { slots.clone() } else { affected.iter().copied().collect() };
            transformed.sort_unstable();
            let mut part_slot = None;
            let mut part_handles: Vec<f64> = Vec::new();
            let horizontal = match &operation.kind {
                Kind::Mirror { horizontal, .. } => *horizontal,
                _ => true,
            };
            if let Kind::Mirror { part: Some(part), .. } = &operation.kind {
                let Some(slot) = slots.iter().copied().find(|&s| uid(&objects[s]) == part.uid && part.uid.is_some()) else { return Ok(None) };
                let segments = segments_of(figure_of(context.figures, &objects[slot]));
                let existing: Vec<f64> = segments.iter().filter_map(|s| given(s, "segment_id")).collect();
                for &id in &part.handles {
                    if existing.contains(&id) && !part_handles.contains(&id) {
                        part_handles.push(id);
                    }
                }
                if part_handles.is_empty() {
                    return Ok(None);
                }
                transformed = vec![slot];
                if part.branch {
                    // The branch below the handles, and the figures hanging from them.
                    let mut at = 0;
                    while at < part_handles.len() {
                        let parent = part_handles[at];
                        for child in segments.iter().filter(|s| given(s, "parent_id") == Some(parent)).filter_map(|s| given(s, "segment_id")) {
                            if !part_handles.contains(&child) {
                                part_handles.push(child);
                            }
                        }
                        at += 1;
                    }
                    for &child in children.get(&slot).map(Vec::as_slice).unwrap_or(&[]) {
                        let handle = objects[child].get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_handle_id"));
                        if handle.is_some_and(|h| part_handles.contains(&h)) {
                            let mut queue = vec![child];
                            let mut next = 0;
                            while next < queue.len() {
                                for &below in children.get(&queue[next]).map(Vec::as_slice).unwrap_or(&[]) {
                                    if !queue.contains(&below) {
                                        queue.push(below);
                                    }
                                }
                                next += 1;
                            }
                            for member in queue {
                                if !transformed.contains(&member) {
                                    transformed.push(member);
                                }
                            }
                        }
                    }
                }
                part_slot = Some(slot);
            }
            for &slot in &transformed {
                let object = &objects[slot];
                let figure = figure_of(context.figures, object);
                let definition_bends = || -> Vec<f64> { segments_of(figure).iter().map(|s| given(s, "bend_rad").unwrap_or(0.0)).collect() };
                // Effective lengths and bends from a legacy cache come first (`patch.bends ?? …`).
                let mut patch: Vec<(&str, Value)> = materialized(object, figure);
                let cached_bends = patch.iter().find(|(key, _)| *key == "bends").map(|(_, value)| numbers(Some(value)));
                let held_bends = || cached_bends.clone().unwrap_or_else(|| if object.get("bend_flag").is_some_and(Value::truthy) { numbers(object.get("bends")) } else { definition_bends() });
                if part_slot == Some(slot) {
                    let segments = segments_of(figure);
                    let flipped = |index: usize| segments.get(index).and_then(|s| given(s, "segment_id")).is_some_and(|id| part_handles.contains(&id));
                    let angles = numbers(object.get("angles")).into_iter().enumerate().map(|(i, a)| Value::Num(if flipped(i) { if horizontal { std::f64::consts::PI - a } else { -a } } else { a }));
                    patch.push(("angles", Value::array(angles.collect())));
                    patch.push(("bend_flag", Value::Num(1.0)));
                    let bends = held_bends().into_iter().enumerate().map(|(i, b)| Value::Num(if flipped(i) { -b } else { b }));
                    patch.push(("bends", Value::array(bends.collect())));
                    changes.patch(slot, patch, &["runtime_segments"]);
                    continue;
                }
                let root = object.get("join").filter(|j| j.truthy()).is_none();
                let (x, y) = (given(object, "root_x").unwrap_or(f64::NAN), given(object, "root_y").unwrap_or(f64::NAN));
                match &operation.kind {
                    Kind::Scale { .. } => {
                        patch.push(("scale", Value::Num(scales.as_ref().unwrap()[&slot])));
                        if root {
                            patch.push(("root_x", Value::Num(native_finite(Some(center[0] + (x - center[0]) * factor), "Figure X")?)));
                            patch.push(("root_y", Value::Num(native_finite(Some(center[1] + (y - center[1]) * factor), "Figure Y")?)));
                        }
                    }
                    Kind::Rotate(radians) => {
                        if root {
                            let (dx, dy, c, s) = (x - center[0], y - center[1], styk_math::cos(*radians), styk_math::sin(*radians));
                            patch.push(("root_x", Value::Num(native_finite(Some(center[0] + dx * c - dy * s), "Figure X")?)));
                            patch.push(("root_y", Value::Num(native_finite(Some(center[1] + dx * s + dy * c), "Figure Y")?)));
                        }
                        let mut angles = Vec::new();
                        for a in numbers(object.get("angles")) {
                            angles.push(Value::Num(native_finite(Some(a + radians), "Joint angle")?));
                        }
                        patch.push(("angles", Value::array(angles)));
                    }
                    _ => {
                        if root {
                            if horizontal {
                                patch.push(("root_x", Value::Num(native_finite(Some(2.0 * center[0] - x), "Figure X")?)));
                            } else {
                                patch.push(("root_y", Value::Num(native_finite(Some(2.0 * center[1] - y), "Figure Y")?)));
                            }
                        }
                        let angles = numbers(object.get("angles")).into_iter().map(|a| Value::Num(if horizontal { std::f64::consts::PI - a } else { -a }));
                        patch.push(("angles", Value::array(angles.collect())));
                        patch.push(("bend_flag", Value::Num(1.0)));
                        patch.push(("bends", Value::array(held_bends().into_iter().map(|b| Value::Num(-b)).collect())));
                        patch.push(("image_text_flags", Value::Num(if object.get("image_text_flags").is_some_and(Value::truthy) { 0.0 } else { 1.0 })));
                    }
                }
                let changed = changes.patch(slot, patch, &["runtime_segments"]);
                if let Some(figure) = figure {
                    let mut record = changed.as_obj().cloned().unwrap_or_default();
                    match &operation.kind {
                        Kind::Rotate(radians) => crate::origin::rotate_support(figure, &mut record, *radians),
                        Kind::Mirror { .. } => (context.mirror_origin)(figure, object, &mut record, horizontal)?,
                        _ => {}
                    }
                    if changed.get("_stykAnimationOrigin") != record.get("_stykAnimationOrigin") { changes.replace(slot, record); }
                }
            }
        }
        _ => unreachable!("handled above"),
    }

    // Attachment endpoints below changed figures are evaluated again: canonical roots survive
    // native export even where poses stored stale joined origins.
    let affected = descendants(&children, changes.order.clone());
    let original = get_geometry()?;
    let next_objects: Vec<Value> = (0..objects.len()).map(|slot| changes.current(slot)).collect();
    let (next_children, next_order) = hierarchy(&next_objects)?;
    let mut endpoints: HashMap<usize, Joints> = HashMap::new();
    for slot in next_order {
        if !affected.contains(&slot) {
            continue;
        }
        let mut object = changes.current(slot);
        let mut root = [given(&object, "root_x").unwrap_or(f64::NAN), given(&object, "root_y").unwrap_or(f64::NAN)];
        if let Some(join) = object.get("join").filter(|j| j.truthy()).cloned() {
            let parent = num(&join, "target_object_slot").filter(|p| *p >= 0.0).map(|p| p as usize);
            let handle = num(&join, "target_handle_id").unwrap_or(f64::NAN);
            let found = parent.and_then(|p| endpoints.get(&p).or_else(|| original.get(&p))).and_then(|joints| joints.get(handle));
            let Some(found) = found else { return Err(invalid("errors.rangeFigureOperations.joinTargetHandleIsMissing")) };
            root = found;
            object = changes.patch(slot, vec![("root_x", Value::Num(root[0])), ("root_y", Value::Num(root[1]))], &[]);
        }
        if next_children.contains_key(&slot) {
            endpoints.insert(slot, joint_endpoints(&object, figure_of(context.figures, &object), root)?);
        }
    }
    Ok(changes.result(frame, matches!(operation.kind, Kind::Join { .. })))
}

/// A pose with the legacy `runtime_segments` cache keeps its effective lengths and bends
/// when a range operation retires the cache: `len_flag`/`lengths` and `bend_flag`/`bends`
/// from the cache, else the definition (range-figure-operations.mjs).
fn materialized(object: &Value, figure: Option<&Value>) -> Vec<(&'static str, Value)> {
    let Some(runtime) = object.get("runtime_segments").filter(|value| value.truthy()) else { return Vec::new() };
    let segments = segments_of(figure);
    let cached = |index: usize, key: &str| runtime.item(index).and_then(|entry| entry.get(key).filter(|value| !value.is_null()).cloned());
    let mut patch = Vec::new();
    if !object.get("len_flag").is_some_and(Value::truthy) {
        patch.push(("len_flag", Value::Num(1.0)));
        patch.push(("lengths", Value::array(segments.iter().enumerate().map(|(index, segment)| cached(index, "length").or_else(|| segment.get("length").cloned()).unwrap_or(Value::Null)).collect())));
    }
    if !object.get("bend_flag").is_some_and(Value::truthy) {
        patch.push(("bend_flag", Value::Num(1.0)));
        patch.push(("bends", Value::array(segments.iter().enumerate().map(|(index, segment)| cached(index, "bend_rad").or_else(|| segment.get("bend_rad").filter(|value| !value.is_null()).cloned()).unwrap_or(Value::Num(0.0))).collect())));
    }
    patch
}
