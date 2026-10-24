//! Motion-path edits (src/editor-motion-path.mjs, src/motion-path-falloff.mjs): a dragged
//! trail point rewrites the pose at its own tick while the playhead stays put. The session
//! poses a copy of the frame evaluated there (`snapshotPoseFrame`) and commits once through the
//! sheet plan, as gestures on a layer sheet do (`_sheetPoseDraftBegin`, `_sheetPoseDraftWrite`,
//! `_sheetPoseDraftPublish`): one key per track, rewritten in place on every pointer move. With
//! a falloff (`planFalloff`) the grabbed frame moves fully and the target's keys inside the
//! influence follow by their weight; an edge key just outside it keeps the original pose where a
//! long tween would carry the change further.
//!
//! Ported on layer sheets: a figure's origin (its connected figures translated, pinned IK
//! targets carried along with `movePins`; a joined figure's origin is its parent's joint), a
//! joint (turned with its subtree and the figures joined below it, stretched, isolated; the
//! displayed solution of pinned limbs baked first and followers of pinned limbs turned), the end
//! of a limb with an IK controller (a pinned target moves; a free limb is solved and baked, across
//! joined figures too), and the camera. Recorded native origin figures reuse the same pose math,
//! Objects history and shared native row-splice owner. Recorded saved native origin
//! pose/transform channels use the same private animation draft and Animation history. Native camera,
//! ordinary native targets, rigged and 3D figures, and keys whose figures a movieclip replacement placed stay `Unported`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use styk_doc::{Obj, Value};
use styk_eval::eval::{Frame, Prepared};
use styk_eval::geometry::Scene;
use styk_eval::ik::joined::Assembly;
use styk_eval::ik::{self, Controller, Skeleton, Table};
use styk_math::{atan2, cos, hypot, pow, shortest, sin};

use crate::frame::objects_of;
use crate::ik::{angle_table, assign, bake_object, controllers, displayed_angle, has_pinned, joined_table, reference_value, same_bend, set_controller, solve_frame, translate_targets};
use crate::record::{join_target, num, uid};
use crate::select::{resolve_join_selection, SelectionState};
use crate::sheet::{constant, continuations, fixed, items, key_at, signature, Plan, Write};
use crate::timeline::{rows, total_ticks, Row};
use crate::{Drag, EditError, Editor};

/// `MOTION_PATH_FALLOFF_SHAPES`.
const SHAPES: [&str; 4] = ["smooth", "linear", "sharp", "flat"];
/// `MOTION_PATH_FALLOFF_MAX`.
const FALLOFF_MAX: f64 = 240.0;
/// Below this weight a leaked change is too small to justify an edge key.
const EDGE_THRESHOLD: f64 = 0.1;
/// The calls a motion-path edit answers while it is open.
const CALLS: [&str; 6] = ["beginMotionPathEdit", "updateMotionPathEdit", "commitMotionPathEdit", "cancelMotionPathEdit", "setMotionPathFalloff", "motionPathFalloff"];

/// A falloff's influence (`normalizeFalloff`): ticks either side of the grabbed frame and how
/// the weight fades.
#[derive(Clone, Debug, PartialEq)]
struct Falloff {
    radius: f64,
    shape: &'static str,
}

/// What a write of a falloff edit is (`planFalloff`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    /// The dragged frame, weight 1.
    Grab,
    /// An existing key inside the influence.
    Key,
    /// An added key that keeps the original pose, weight 0.
    Edge,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Grab => "grab",
            Kind::Key => "key",
            Kind::Edge => "edge",
        }
    }
}

/// One write of `planFalloff`: `{tick, weight, kind}`.
#[derive(Clone, Copy, Debug)]
struct Planned {
    tick: f64,
    weight: f64,
    kind: Kind,
}

/// What a trail belongs to: a figure's joint (`{kind: 'node', uid, handleId, joint}`, handle 0
/// the origin) or the camera.
#[derive(Clone, Debug)]
struct Target {
    camera: bool,
    uid: Option<f64>,
    /// `handleId`; `None` when the target has none.
    handle: Option<f64>,
    /// `joint`; `None` when the target has none.
    joint: Option<f64>,
}

impl Target {
    fn parse(value: &Value) -> Result<Target, EditError> {
        let unported = |what: &str| EditError::Unported(format!("a motion-path target {what}"));
        if !value.is_object() {
            return Err(unported("that is not an object"));
        }
        let camera = match value.get("kind").and_then(Value::as_str) {
            Some("camera") => true,
            Some("node") => false,
            _ => return Err(unported("of another kind")),
        };
        let number = |key: &str| -> Result<Option<f64>, EditError> {
            match value.get(key) {
                None => Ok(None),
                Some(Value::Num(n)) => Ok(Some(*n)),
                Some(_) => Err(unported(&format!("whose {key} is not a number"))),
            }
        };
        Ok(Target { camera, uid: value.get("uid").and_then(Value::as_f64), handle: number("handleId")?, joint: number("joint")? })
    }

    /// `String(target.handleId)`: the key of the handle's IK controller.
    fn handle_key(&self) -> String {
        self.handle.map_or_else(|| "undefined".into(), |h| styk_doc::json::to_string(&Value::Num(h)))
    }

    /// `target.handleId === 0`: the figure's origin.
    fn origin(&self) -> bool {
        self.handle == Some(0.0)
    }
}

/// A key the gesture wrote on a track (`draft.writes`): the key's identity and the pose
/// source it holds, if any.
#[derive(Clone, Debug)]
struct Entry {
    key: String,
    source: Option<String>,
    /// `_sheetPoseDraftWrite`'s original span; later moves recapture its source.
    write_tick: f64,
    next_tick: f64,
    /// On a key whose movieclip replacements placed every figure the gesture changed there,
    /// the replacements are captured again and the key keeps its own pose (`patchOnly`): by
    /// replaced figure, the pose source captured and the replacement written (`patchSources`).
    patches: Option<Vec<(f64, String, Value)>>,
}

/// A frame the gesture rewrites at its own tick (`session`, and each `sub` of a falloff edit):
/// the frame evaluated there, the copy being posed and what the gesture keeps for it.
#[derive(Clone, Debug)]
struct Posed {
    tick: f64,
    weight: f64,
    kind: Kind,
    index: usize,
    row: Row,
    source: Value,
    working: Value,
    /// The component's figures as they were (`baseline`).
    baseline: Vec<Value>,
    /// Where the target is in this frame (a falloff's writes move by the grabbed frame's delta).
    origin: [f64; 2],
    rotation_targets: HashMap<(usize, usize, bool), Vec<(usize, usize)>>,
    translation_origin: Option<[f64; 2]>,
    moved: bool,
    camera_changed: bool,
    /// The figures this frame's writes changed (`sub.changed`).
    changed: Vec<u32>,
    written: bool,
    /// The keys written per track (`sub.sheet.writes`), in the order first written.
    writes: Vec<(String, Entry)>,
    /// The channel owners this sub captured, with their stable frame IDs.
    source_ids: Vec<(String, String)>,
    /// Whether each track's key may be written here (`sub.claims`).
    claims: Vec<(String, bool)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode { Sheet, Key, Split, Native, Channels }

/// An open motion-path edit (`editor._drag` with `motionPath`).
#[derive(Clone, Debug)]
pub(crate) struct Session {
    label: String,
    /// What began it (`request`): the target as given, the tick and the label.
    request: (Value, f64, Option<String>),
    target: Target,
    tick: f64,
    before_selection: SelectionState,
    falloff: Option<Falloff>,
    mode: Mode,
    plan: Option<Plan>,
    draft: Option<crate::property_edit::NativeAnimationDraft>,
    channel_touched: Vec<String>,
    /// The grabbed frame first, then a falloff's other writes by priority.
    posed: Vec<Posed>,
    /// The figures joined to the target (`component`).
    component: Vec<u32>,
    /// Track keys already claimed by a stronger write (`session.claims`).
    claims: HashSet<(String, u64)>,
    /// The falloff's writes that have a frame (`session.writes`), by tick.
    planned: Vec<Planned>,
    /// The target's original key ticks, used by `refreshFalloff`'s display range.
    keys: Vec<f64>,
    moved: bool,
    /// The last pointer and its options (`lastPoint`, `lastOptions`).
    last: Option<(Value, Value)>,
    /// What the owner has not been told yet (`motion_path_view`): that the gesture began, and
    /// that its virtual report (`session.report`) was refreshed by a pointer move.
    fresh: bool,
    refreshed: bool,
}

/// `Math.round`.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `normalizeFalloff(value)`: `None` when the drag edits one frame.
fn normalize_falloff(value: Option<&Value>) -> Result<Option<Falloff>, EditError> {
    let Some(value) = value.filter(|v| v.truthy()) else { return Ok(None) };
    // `Number(value.radius)`.
    let radius = match value.get("radius") {
        None => f64::NAN,
        Some(Value::Num(n)) => *n,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(_) => return Err(EditError::Unported("a falloff radius that is not a number".into())),
    };
    let radius = js_round(radius);
    if !radius.is_finite() || radius < 1.0 {
        return Ok(None);
    }
    let shape = value.get("shape").and_then(Value::as_str).and_then(|s| SHAPES.iter().find(|&&known| known == s)).copied().unwrap_or("smooth");
    Ok(Some(Falloff { radius: radius.min(FALLOFF_MAX), shape }))
}

/// `falloffWeight(distance, radius, shape)`: 1 at the grabbed frame, 0 beyond `radius`, and
/// strictly positive inside it for every shape.
fn falloff_weight(distance: f64, radius: f64, shape: &str) -> f64 {
    let distance = distance.abs();
    if distance == 0.0 {
        return 1.0;
    }
    // `!(radius > 0)`: a NaN radius gives no weight either.
    if radius.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) || distance > radius {
        return 0.0;
    }
    let u = distance / (radius + 1.0);
    match shape {
        "linear" => 1.0 - u,
        "sharp" => pow(1.0 - u, 3.0),
        "flat" => 1.0,
        _ => 0.5 + 0.5 * cos(std::f64::consts::PI * u),
    }
}

/// `planFalloff({tick, radius, shape, keys, totalTicks})`: the writes of one falloff edit, by tick.
fn plan_falloff(tick: f64, falloff: &Falloff, keys: &[f64], total: f64) -> Vec<Planned> {
    let mut sorted: Vec<f64> = Vec::new();
    for &key in keys {
        if key.fract() == 0.0 && key >= 0.0 && key < total && !sorted.contains(&key) {
            sorted.push(key);
        }
    }
    sorted.sort_by(f64::total_cmp);
    let radius = falloff.radius;
    let mut writes = vec![Planned { tick, weight: 1.0, kind: Kind::Grab }];
    for &key in &sorted {
        if key == tick {
            continue;
        }
        let weight = falloff_weight(key - tick, radius, falloff.shape);
        if weight > 0.0 {
            writes.push(Planned { tick: key, weight, kind: Kind::Key });
        }
    }
    if radius > 0.0 {
        for side in [-1.0, 1.0] {
            let edge = tick + side * (radius + 1.0);
            if edge < 0.0 || edge >= total || sorted.contains(&edge) {
                continue;
            }
            // Only a key beyond the edge makes a tween that would carry the change further.
            if !sorted.iter().any(|&key| if side < 0.0 { key < edge } else { key > edge }) {
                continue;
            }
            let inside: Vec<Planned> = writes.iter().copied().filter(|w| if side < 0.0 { w.tick <= tick } else { w.tick >= tick }).collect();
            let outermost = inside.iter().copied().reduce(|far, w| if (w.tick - tick).abs() > (far.tick - tick).abs() { w } else { far });
            if outermost.is_some_and(|w| w.weight >= EDGE_THRESHOLD) {
                writes.push(Planned { tick: edge, weight: 0.0, kind: Kind::Edge });
            }
        }
    }
    writes.sort_by(|a, b| a.tick.total_cmp(&b.tick));
    writes
}

/// `snapshotPoseObject(object)`: a pose without its evaluation caches.
fn snapshot_object(object: &Value) -> Value {
    let mut fields = object.as_obj().cloned().unwrap_or_default();
    fields.remove("runtime_segments");
    fields.remove("_movieclipSample");
    Value::object(fields)
}

/// `ikComponents(frame)` group of `slot`: the figures a pose edit of it can reach.
fn component_slots(objects: &[Value], slot: usize) -> Vec<usize> {
    let joins: Vec<Option<usize>> = objects.iter().map(join_target).collect();
    ik::joined::components_of(&joins).into_iter().find(|group| group.contains(&slot)).unwrap_or_else(|| vec![slot])
}

fn object_at(frame: &Value, slot: usize) -> Value {
    frame.get("objects").and_then(|o| o.item(slot)).unwrap_or(Value::Null)
}

fn object_mut(frame: &mut Value, slot: usize) -> Option<&mut Obj> {
    frame.make_obj()?.get_mut("objects")?.make_arr()?.get_mut(slot)?.make_obj()
}

/// The slot of the figure `id` (`objects.findIndex(o => o.unique_id === id)`).
fn slot_of(objects: &[Value], id: Option<f64>) -> Option<usize> {
    let id = id?;
    objects.iter().position(|o| num(o, "unique_id") == Some(id))
}

fn json(value: &Value) -> String {
    styk_doc::json::to_string(value)
}

fn truthy(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(Value::truthy)
}

fn keys_next_tick(plan: &mut Plan, id: &str, index: usize) -> f64 {
    plan.keys(id).get(index + 1).and_then(|key| num(key, "tick")).unwrap_or_else(|| plan.end(id))
}

/// `isStatic(segment)` on a figure record.
fn is_static(segment: &Value) -> bool {
    crate::pose::is_static(segment)
}

/// A segment as geometry draws it (`geometry.objects.get(slot).segments[joint]`).
struct Shape {
    start: [f64; 2],
    angle: f64,
    bend: f64,
}

/// `cameraValues(camera)`, then `checkedCamera` of it with `x` and `y` replaced: the camera a
/// camera trail point puts there, or the editor's refusal.
fn checked_camera(current: &Value, x: f64, y: f64) -> Result<Value, EditError> {
    let mut camera = current.as_obj().cloned().unwrap_or_default();
    camera.set("x", Value::Num(x));
    camera.set("y", Value::Num(y));
    let field = |key: &str| camera.get(key).and_then(Value::as_f64);
    let mut values = [0.0; 4];
    for (i, key) in ["x", "y", "scale", "angle_rad"].into_iter().enumerate() {
        values[i] = field(key).filter(|v| v.is_finite()).ok_or_else(|| crate::camera_commands::camera_not_finite(key))?;
    }
    if let Some(bad) = values[..3].iter().position(|&v| !(v as f32).is_finite()) {
        return Err(crate::invalid_with("errors.editorCamera.cameraExceedsTheNativeRange", vec![("field", Value::str(["x", "y", "scale"][bad]))]));
    }
    if values[2] <= 0.0 {
        return Err(EditError::Invalid("errors.editorCamera.cameraScaleMustBePositive".into()));
    }
    let inverse = 1.0 / (values[2] as f32);
    if !inverse.is_finite() || inverse <= 0.0 {
        return Err(EditError::Invalid("errors.background.cameraScaleExceedsTheNativeRenderingRange".into()));
    }
    camera.set("is_default", Value::Bool(values == [0.0, 0.0, 1.0, 0.0]));
    Ok(Value::object(camera))
}

impl Editor {
    /// The stage's motion-path display (`_drag.display.frame`), separately from
    /// `evaluatedFrame`. This query prepares a transient COW Plan through the existing
    /// Loader/Prepared/Records owners. Call only on the durable session worker (or
    /// native replay); it is intentionally absent from Session.call/UI dispatch.
    /// The future actor must publish its result with the same gesture/revision guard.
    pub fn motion_display_frame_worker(&self) -> Result<Option<Value>, EditError> {
        let Some(session) = self.drag.as_ref().and_then(|drag| drag.motion_path.as_ref()).filter(|session| session.moved) else { return Ok(None) };
        let range = self.display_range(session);
        if self.tick < range[0] || self.tick >= range[1] { return Ok(None); }
        let report = self.motion_virtual_report(session)?;
        let doc = self.eval.borrow_mut().loader.document(&report, "").map_err(|error| EditError::Invalid(error.to_string()))?;
        let prepared = Prepared::new(Arc::new(doc));
        let records = match &session.draft {
            Some(draft) => styk_eval::records::Records::new_native_draft(&report, &prepared, draft.channels())?,
            None => styk_eval::records::Records::new(&report, &prepared)?,
        };
        Ok(Some(records.evaluated(self.tick)?))
    }

    /// The ticks the gesture's virtual report changes (`session.range`) once it has moved: a
    /// falloff's frames between the keys around its writes, the keys a channel gesture wrote and
    /// their neighbours, the rows around a stored pose, or the spans of a layer sheet's writes.
    fn display_range(&self, session: &Session) -> [f64; 2] {
        let total = total_ticks(&rows(&self.report));
        if session.falloff.is_some() {
            let low = session.posed.iter().map(|posed| posed.tick).fold(f64::INFINITY, f64::min);
            let high = session.posed.iter().map(|posed| posed.tick).fold(f64::NEG_INFINITY, f64::max);
            [session.keys.iter().copied().filter(|tick| *tick < low).fold(0.0, f64::max),
                session.keys.iter().copied().filter(|tick| *tick > high).map(|tick| tick + 1.0).fold(total, f64::min)]
        } else if session.mode == Mode::Channels {
            let draft = session.draft.as_ref().expect("channel session");
            session.channel_touched.iter().fold([session.tick, session.tick + 1.0], |range, id| {
                let keys = draft.channels().iter().find(|channel| channel.get("id").and_then(Value::as_str) == Some(id.as_str()))
                    .map(|channel| items(channel.get("keys"))).unwrap_or_default();
                let visible = keys.iter().filter(|key| !truthy(key,"hidden")).filter_map(|key| num(key,"tick")).collect::<Vec<_>>();
                let before = visible.iter().copied().filter(|tick| *tick < session.tick).reduce(f64::max).unwrap_or(session.tick);
                let after = visible.iter().copied().filter(|tick| *tick > session.tick).reduce(f64::min).unwrap_or(total);
                [range[0].min(before), range[1].max(after)]
            })
        } else if session.mode != Mode::Sheet {
            let timeline = rows(&self.report); let index = session.posed[0].index;
            let low = timeline[index.saturating_sub(2)].start;
            let last = timeline[(index + 2).min(timeline.len() - 1)];
            [low, last.start + last.count]
        } else {
            session.posed[0].writes.iter().fold([session.tick, session.tick + 1.0], |range, (_, entry)|
                [range[0].min(entry.write_tick), range[1].max(entry.next_tick)])
        }
    }

    /// The document as the gesture shows it while it is open (`session.report`): the sheet plan
    /// or the posed native frames laid over it.
    fn motion_virtual_report(&self, session: &Session) -> Result<Value, EditError> {
        if let Some(plan) = &session.plan { plan.virtual_report(&self.report) } else { self.native_motion_report(session, false) }
    }

    /// The open motion-path edit as the owner mirrors it on the editor (`editor._drag`, which the
    /// interface reads for its trails and overlays): after every call whether it has moved, the
    /// ticks it changes (`range`) and a falloff's writes that moved (`movedSubs`); the call that
    /// opens it adds what stays fixed (`target`, `tick`, the `falloff`, its writes and `subs`, the
    /// pinned figures of the grabbed frame's `baseline`); a pointer move that changed the virtual
    /// report adds `report`, the operations that turn the document into it. `null` when no edit is
    /// open. `consume` marks what it carries as told.
    pub fn motion_path_view(&mut self, consume: bool) -> Result<Value, EditError> {
        let Some(session) = self.drag.as_ref().and_then(|drag| drag.motion_path.as_deref()) else { return Ok(Value::Null) };
        let mut out = Obj::new();
        out.set("moved", Value::Bool(session.moved));
        let range = if !session.moved && (session.falloff.is_some() || matches!(session.mode, Mode::Sheet | Mode::Channels)) { [session.tick, session.tick + 1.0] } else { self.display_range(session) };
        out.set("range", Value::array(range.into_iter().map(Value::Num).collect()));
        if session.falloff.is_some() {
            out.set("movedSubs", Value::array(session.posed.iter().map(|posed| Value::Bool(posed.moved)).collect()));
        }
        if session.fresh {
            let mut target = Obj::new();
            target.set("kind", Value::str(if session.target.camera { "camera" } else { "node" }));
            if !session.target.camera {
                if let Some(uid) = session.target.uid { target.set("uid", Value::Num(uid)); }
                if let Some(handle) = session.target.handle { target.set("handleId", Value::Num(handle)); }
                if let Some(joint) = session.target.joint { target.set("joint", Value::Num(joint)); }
            }
            out.set("target", Value::object(target));
            out.set("tick", Value::Num(session.tick));
            if let Some(falloff) = &session.falloff {
                let mut value = Obj::new();
                value.set("radius", Value::Num(falloff.radius));
                value.set("shape", Value::str(falloff.shape));
                out.set("falloff", Value::object(value));
                out.set("writes", Value::array(session.planned.iter().map(|write| {
                    let mut value = Obj::new();
                    value.set("tick", Value::Num(write.tick));
                    value.set("weight", Value::Num(write.weight));
                    value.set("kind", Value::str(write.kind.name()));
                    Value::object(value)
                }).collect()));
                out.set("subs", Value::array(session.posed.iter().map(|posed| {
                    let mut value = Obj::new();
                    value.set("tick", Value::Num(posed.tick));
                    value.set("kind", Value::str(posed.kind.name()));
                    Value::object(value)
                }).collect()));
            }
            // The figures with pinned limbs among the grabbed frame's baseline: the interface asks
            // whether any is pinned.
            let pinned = session.posed.first().map(|posed| posed.baseline.iter().filter(|object| has_pinned(object)).map(|object| {
                let mut value = Obj::new();
                value.set("unique_id", object.get("unique_id").cloned().unwrap_or(Value::Null));
                value.set("_stykIK", object.get("_stykIK").cloned().unwrap_or(Value::Null));
                Value::object(value)
            }).collect()).unwrap_or_default();
            out.set("baseline", Value::array(pinned));
        }
        if session.fresh || session.refreshed {
            let ops = if session.refreshed { crate::patch::diff(&self.report, &self.motion_virtual_report(session)?) } else { Value::array(Vec::new()) };
            out.set("report", ops);
        }
        if consume && let Some(session) = self.drag.as_mut().and_then(|drag| drag.motion_path.as_deref_mut()) {
            session.fresh = false;
            session.refreshed = false;
        }
        Ok(Value::object(out))
    }

    /// A native gesture projects its same posed records over the canonical COW
    /// report only for the worker display query; no preview becomes another store.
    fn native_motion_report(&self, session: &Session, commit: bool) -> Result<Value, EditError> {
        if session.mode == Mode::Channels { return Ok(session.draft.as_ref().expect("channel session").project_report(&self.report)); }
        let mut report = self.report.clone();
        if session.mode == Mode::Key {
            let posed = &session.posed[0];
            let frames = report.make_obj().and_then(|report| report.get_mut("keyframes")).and_then(Value::make_arr)
                .ok_or_else(|| EditError::Unported("native motion without keyframes".into()))?;
            frames[posed.index] = posed.working.clone();
        } else if let Some((change, _)) = self.native_motion_slice(session, commit)? {
            crate::frame::splice_ranges(&mut report, &[change], true)?;
        }
        Ok(report)
    }

    /// `falloffNativeFrames`: one contiguous slice keeps untouched rows and
    /// replaces stored poses or splits their spans at the grabbed/edge ticks.
    fn native_motion_slice(&self, session: &Session, commit: bool) -> Result<Option<(crate::frame::FrameSlice, bool)>, EditError> {
        let frames = self.report.get("keyframes").and_then(Value::elements).map(|frames| frames.iter().collect::<Vec<_>>()).unwrap_or_default();
        if session.mode == Mode::Split {
            let posed = &session.posed[0];
            let before = frames.get(posed.index).cloned().ok_or_else(|| EditError::Unported("a missing native motion row".into()))?;
            let mut head = before.as_obj().cloned().unwrap();
            head.set("duration_raw", Value::Num(posed.tick - posed.row.start));
            let mut tail = posed.working.as_obj().cloned().unwrap();
            tail.set("duration_raw", Value::Num(posed.row.start + posed.row.count - posed.tick));
            return Ok(Some((crate::frame::FrameSlice { index: posed.index, before: vec![before], after: vec![Value::object(head), Value::object(tail)] }, true)));
        }
        let mut by_row = BTreeMap::<usize, Vec<&Posed>>::new();
        for posed in &session.posed {
            if posed.moved || posed.kind == Kind::Edge { by_row.entry(posed.index).or_default().push(posed); }
        }
        let Some((&first, _)) = by_row.first_key_value() else { return Ok(None) };
        let last = *by_row.last_key_value().unwrap().0;
        let mut after = Vec::new(); let mut timing = false;
        for index in first..=last {
            let stored = frames.get(index).cloned().ok_or_else(|| EditError::Unported("a missing native falloff row".into()))?;
            let Some(subs) = by_row.get_mut(&index) else { after.push(stored); continue };
            subs.sort_by(|a,b| a.tick.total_cmp(&b.tick));
            let row = subs[0].row;
            let mut pose = stored.clone();
            if let Some(head) = subs.iter().find(|posed| posed.tick <= row.start).filter(|posed| posed.moved) {
                pose = stored_candidate(&stored, &head.working, &session.component, session.target.camera);
                if commit { pose = self.settle_native_motion(&stored, &pose, &session.component)?; }
            }
            let splits = subs.iter().filter(|posed| posed.tick > row.start).collect::<Vec<_>>();
            if let Some(first) = splits.first() {
                timing = true;
                pose.make_obj().unwrap().set("duration_raw", Value::Num(first.tick - row.start));
            }
            after.push(pose);
            for (offset, posed) in splits.iter().enumerate() {
                let next = splits.get(offset + 1).map_or(row.start + row.count, |posed| posed.tick);
                let mut piece = posed.working.clone();
                piece.make_obj().unwrap().set("duration_raw", Value::Num(next - posed.tick));
                after.push(piece);
            }
        }
        Ok(Some((crate::frame::FrameSlice { index: first, before: frames[first..=last].to_vec(), after }, timing)))
    }

    /// The stored-pose commit owner keeps unrelated records and unknown metadata,
    /// drops runtime fields and stores final joined roots from existing geometry.
    fn settle_native_motion(&self, stored: &Value, candidate: &Value, component: &[u32]) -> Result<Value, EditError> {
        let old = objects_of(stored); let current = objects_of(candidate);
        let mut changed = Vec::new();
        let objects = current.iter().map(|object| {
            let Some(id) = uid(object).filter(|id| component.contains(id)) else { return object.clone() };
            let before = old.iter().find(|object| uid(object) == Some(id));
            if before.is_some_and(|before| signature(before, &old) == signature(object, &current)) { return before.unwrap().clone(); }
            changed.push(id); snapshot_object(object)
        }).collect::<Vec<_>>();
        let mut settled = candidate.clone(); settled.make_obj().unwrap().set("objects", Value::array(objects));
        if changed.is_empty() { return Ok(settled); }
        self.check_native_motion_records(&settled, &changed)?;
        if objects_of(&settled).iter().any(|object| join_target(object).is_some() && uid(object).is_some_and(|id| changed.contains(&id))) {
            let (_, _, scene) = self.posed_scene(&settled)?;
            for (slot, object) in objects_of(&settled).iter().enumerate() {
                if join_target(object).is_some() && uid(object).is_some_and(|id| changed.contains(&id)) {
                    if let (Some(geometry), Some(record)) = (scene.objects.get(slot), object_mut(&mut settled, slot)) {
                        record.set("root_x", Value::Num(geometry.root[0])); record.set("root_y", Value::Num(geometry.root[1]));
                    }
                }
            }
        }
        Ok(settled)
    }

    /// Out-of-range/malformed stored pose mutations remain an atomic fallback;
    /// admission otherwise uses the same typed origin/definition/joins owner.
    fn check_native_motion_records(&self, frame: &Value, ids: &[u32]) -> Result<(), EditError> {
        let objects = objects_of(frame);
        let slots = objects.iter().enumerate().filter_map(|(slot, object)| uid(object).is_some_and(|id| ids.contains(&id)).then_some(slot)).collect::<Vec<_>>();
        self.origin_motion_gate(&objects, &slots)?;
        for slot in slots {
            let object = &objects[slot];
            if ["root_x", "root_y", "scale"].iter().any(|key| !num(object,key).is_some_and(|number| number.is_finite() && (number as f32).is_finite())) ||
                ["angles", "lengths", "bends"].iter().any(|key| object.get(key).and_then(Value::numbers).is_some_and(|numbers| numbers.iter().any(|number| !number.is_finite() || !(number.abs() as f32).is_finite()))) {
                return Err(EditError::Unported("an unrecorded native motion pose outside its stored range".into()));
            }
        }
        Ok(())
    }

    fn commit_native_motion(&mut self, session: Session) -> Result<bool, EditError> {
        if session.mode == Mode::Channels {
            self.drag = None;
            return session.draft.expect("channel session").publish(self, &session.label, session.before_selection);
        }
        if session.mode == Mode::Key {
            let posed = &session.posed[0];
            let stored = self.report.get("keyframes").and_then(|frames| frames.item(posed.index)).unwrap();
            let candidate = stored_candidate(&stored, &posed.working, &session.component, session.target.camera);
            let previous = objects_of(&stored); let current = objects_of(&candidate);
            let after = current.iter().filter(|object| uid(object).is_some_and(|id| session.component.contains(&id)) &&
                previous.iter().find(|before| uid(before) == uid(object)).is_none_or(|before| signature(before,&previous) != signature(object,&current))).map(snapshot_object).collect::<Vec<_>>();
            self.drag = None;
            if after.is_empty() { self.emit("edit", vec![("motionPath", Value::Bool(true))]); return Ok(false); }
            self.check_native_motion_records(&candidate, &after.iter().filter_map(uid).collect::<Vec<_>>())?;
            self.replace_objects(posed.index, &after); self.retained = None;
            self.record(crate::history::Command { kind: crate::history::CommandKind::Objects { index: posed.index, before: posed.baseline.clone(), after }, label: session.label.clone(), before_selection: session.before_selection, after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
            self.emit("edit", vec![("label", Value::str(&session.label)), ("changedUids", uid_array(&session.component)), ("frameIndices", Value::array(vec![Value::Num(posed.index as f64)]))]);
            return Ok(true);
        }
        let Some((change, timing)) = self.native_motion_slice(&session, true)? else { self.drag = None; return Ok(false) };
        for frame in &change.after { self.check_native_motion_records(frame, &session.component)?; }
        self.drag = None;
        self.commit_native_ranges(vec![change], &session.label, session.before_selection, false, timing)
    }

    /// Per-call admission for the two saved native origin motion recordings.
    /// Channel headers only; the existing typed Records owner validates their keys.
    pub(crate) fn recorded_native_motion_call(&self, method: &str) -> bool {
        if self.sheet() || self.options.property_channels || self.options.layer_timeline ||
            self.selection_metadata.polygon.is_some() || self.selection_metadata.segments.is_some() || self.selection_metadata.branch.is_some() ||
            self.report.path(&["_styk","movieclipSource"]).is_some() || self.report.path(&["_styk","simpleFrameDraft"]).is_some() ||
            !(CALLS.contains(&method) || ["select","@select","seek","@seek","undo","redo"].contains(&method)) ||
            !items(self.report.get("figure_types")).iter().any(|figure| figure.path(&["_styk","animationOrigin"]).is_some_and(Value::truthy)) { return false; }
        let Some(animation) = self.report.path(&["_styk","animation"]).filter(|value| value.is_object()) else { return false };
        let Some(channels) = animation.get("channels").and_then(Value::elements) else { return false };
        // These recordings already own an authored figure pose. Scalar-only
        // native motion needs its separate capture/projection recording first.
        if !channels.iter().any(|channel| channel.get("property").and_then(Value::as_str) == Some("pose") &&
            channel.path(&["target","kind"]).and_then(Value::as_str) == Some("figure") && channel.get("keys").and_then(Value::array_len).unwrap_or(0) > 0) { return false; }
        let mut ids = HashSet::new();
        channels.iter().all(|channel| {
            let property = channel.get("property").and_then(Value::as_str).unwrap_or("");
            let target = channel.get("target").unwrap_or(&Value::Null);
            let kind = target.get("kind").and_then(Value::as_str);
            let recorded = kind == Some("figure") && ["pose","x","y","scale","rotation"].contains(&property) || kind == Some("layer") && property == "pose";
            recorded && (property != "pose" || ["useBasePose","maskedRanges","orderAnchor","clipEnd"].iter().all(|field| channel.get(field).is_none())) && channel.get("source").is_none_or(|source| source.as_str() == Some("authored")) &&
                crate::property_edit::normalize_target(target).and_then(|target| crate::property_edit::channel_id(&target,property))
                    .is_ok_and(|id| channel.get("id").and_then(Value::as_str) == Some(id.as_str()) && ids.insert(id))
        })
    }

    /// `writeChannels`: repeated writes retain one source identity per owner/sub.
    /// Saved scalar curves are re-keyed from the posed frame through Records.
    fn write_channels(&mut self, session: &mut Session, index: usize, changed: &[u32]) -> Result<(), EditError> {
        let canonical = items(self.report.path(&["_styk","animation","channels"]));
        let mut owners: Vec<(String, Value)> = Vec::new();
        for uid in changed {
            let independent = canonical.iter().any(|channel| channel.path(&["target","kind"]).and_then(Value::as_str) == Some("figure") && channel.path(&["target","uid"]).and_then(Value::as_f64) == Some(*uid as f64) && channel.get("property").and_then(Value::as_str) == Some("pose"));
            let mut target = Obj::new();
            if independent { target.set("kind",Value::str("figure")); target.set("uid",Value::Num(*uid as f64)); }
            else { target.set("kind",Value::str("layer")); target.set("id",Value::str(&self.layer_of(*uid))); }
            let target = Value::object(target); let key = crate::property_edit::channel_id(&target,"pose")?;
            if !owners.iter().any(|(id,_)| *id == key) { owners.push((key,target)); }
        }
        let posed = &mut session.posed[index]; let draft = session.draft.as_mut().expect("channel session");
        for (key, target) in owners {
            let capture = if target.get("kind").and_then(Value::as_str) == Some("figure") { vec![num(&target,"uid").unwrap()] }
                else { let layer = target.get("id").and_then(Value::as_str).unwrap(); objects_of(&posed.working).iter().filter_map(uid).filter(|id| self.layer_of(*id) == layer).map(|id| id as f64).collect() };
            let known = posed.source_ids.iter().find(|(owner,_)| *owner == key).map(|(_,id)| id.as_str());
            let (id, source) = self.native_pose_source(&posed.working,Some(&capture),known)?;
            if known.is_none() {
                posed.source_ids.push((key.clone(),id.clone()));
                let mut entry = Obj::new(); entry.set("target",target); entry.set("property",Value::str("pose")); entry.set("tick",Value::Num(posed.tick));
                let mut value = Obj::new(); value.set("frameId",Value::str(&id)); entry.set("value",Value::object(value)); entry.set("exactTarget",Value::Bool(true));
                draft.put(self,&Value::object(entry))?;
                if !session.channel_touched.contains(&key) { session.channel_touched.push(key); }
            }
            draft.write_source(id,source);
        }
        let values = self.with_records(|records| {
            let mut values = Vec::new();
            for channel in canonical.iter().filter(|channel| channel.get("property").and_then(Value::as_str) != Some("pose") && channel.get("keys").and_then(Value::array_len).unwrap_or(0)>0 && channel.path(&["target","uid"]).and_then(Value::as_f64).is_some_and(|id| changed.contains(&(id as u32)))) {
                let target = channel.get("target").unwrap(); let property = channel.get("property").and_then(Value::as_str).unwrap();
                if let Some(value) = records.property_value(&posed.working,target,property)? { values.push((channel.clone(),value)); }
            }
            Ok(values)
        })?;
        for (channel,value) in values {
            let id = channel.get("id").and_then(Value::as_str).unwrap().to_string();
            let mut entry = Obj::new(); entry.set("target",channel.get("target").unwrap().clone()); entry.set("property",channel.get("property").unwrap().clone()); entry.set("tick",Value::Num(posed.tick)); entry.set("value",value); entry.set("exactTarget",Value::Bool(true));
            draft.put(self,&Value::object(entry))?;
            if !session.channel_touched.contains(&id) { session.channel_touched.push(id); }
        }
        Ok(())
    }

    /// Whether a motion-path edit is open.
    pub(crate) fn motion_path_open(&self) -> bool {
        self.drag.as_ref().is_some_and(|d| d.motion_path.is_some())
    }

    /// While a motion-path edit is open only its own calls, committing or cancelling the
    /// gesture, seeking (which commits it) and undo (which cancels it) run here.
    pub(crate) fn motion_path_gate(&self, method: &str) -> Result<(), EditError> {
        if !self.motion_path_open() || CALLS.contains(&method) || ["commitDrag", "cancelDrag", "seek", "@seek", "undo"].contains(&method) {
            return Ok(());
        }
        Err(EditError::Unported(format!("{method} during a motion-path edit")))
    }

    /// Runs a motion-path call by its JavaScript name; `None` for other names.
    pub(crate) fn motion_path_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        // Options default to `{}` when left out; anything else that is not an object the editor
        // would fail to read.
        let options = |i: usize| match args.get(i) {
            None => Ok(Value::object(Obj::new())),
            Some(value) if value.is_object() => Ok(value.clone()),
            Some(_) => Err(EditError::Unported(format!("{method} with options that are not an object"))),
        };
        Some(match method {
            "beginMotionPathEdit" => options(2).and_then(|o| self.begin_motion_path_edit(&arg(0), &arg(1), &o)).map(Value::Bool),
            "updateMotionPathEdit" => options(1).and_then(|o| self.update_motion_path_edit(&arg(0), &o)).map(Value::Bool),
            "commitMotionPathEdit" => self.commit_motion_path_edit().map(Value::Bool),
            "cancelMotionPathEdit" => self.cancel_motion_path_edit().map(Value::Bool),
            "setMotionPathFalloff" => self.set_motion_path_falloff(args.first()).map(Value::Bool),
            "motionPathFalloff" => Ok(self.motion_path_falloff()),
            _ => return None,
        })
    }

    /// `beginMotionPathEdit(target, tick, {label, falloff})`: never seeks.
    fn begin_motion_path_edit(&mut self, target: &Value, tick: &Value, options: &Value) -> Result<bool, EditError> {
        let saved = self.recorded_native_motion_call("beginMotionPathEdit");
        if !self.sheet() && !saved && self.unported_document() != Some("with animation origins") {
            return Err(EditError::Unported("a native motion-path document outside its origin recordings".into()));
        }
        if (!self.sheet() && (self.drag.is_some() || self.property_edit.is_some())) || (self.drag.is_some() && self.unported_document().is_some_and(|reason| matches!(reason, "with animation origins" | "with animation origins and property channels"))) {
            return Err(EditError::Unported("an origin motion-path begin during another live gesture".into()));
        }
        if !self.sheet() && !saved && self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) != 0 {
            return Err(EditError::Unported("an authored native motion-path edit".into()));
        }
        let total = total_ticks(&rows(&self.report));
        let Some(tick) = tick.as_f64().filter(|t| t.fract() == 0.0 && *t >= 0.0 && *t < total) else { return Ok(false) };
        let label = match options.get("label") {
            None | Some(Value::Null) => None,
            Some(Value::Str(_)) => options.get("label").and_then(Value::as_str).map(str::to_string),
            Some(_) => return Err(EditError::Unported("a motion-path label that is not text".into())),
        };
        let request = (target.clone(), tick, label.clone());
        let falloff = normalize_falloff(options.get("falloff"))?;
        let label = label.unwrap_or_else(|| if falloff.is_some() { "Reshape motion path" } else { "Edit motion path" }.to_string());
        let mut target = Target::parse(target)?;
        if target.camera && !self.sheet() { return Err(EditError::Unported("an unrecorded native camera motion-path edit".into())); }
        if target.camera && self.unported_document().is_some_and(|reason| matches!(reason, "with animation origins" | "with animation origins and property channels")) {
            return Err(EditError::Unported("an unrecorded camera motion-path edit on an origin document".into()));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if self.report.path(&["_styk", "movieclipSource"]).is_some_and(Value::truthy) || self.report.path(&["_styk", "simpleFrameDraft"]).is_some_and(Value::truthy) {
            return Ok(false);
        }
        if rows(&self.report).is_empty() {
            return Ok(false);
        }
        let source = self.motion_path_source(tick)?;
        let objects = objects_of(&source);
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let figure_of = |object: &Value| figures.iter().find(|f| num(f, "figure_type_id") == num(object, "figure_type_id")).cloned();
        // A joined figure's origin is its parent's attach point: the edit turns that joint
        // instead of translating the whole component.
        if !target.camera && target.origin() {
            let join = slot_of(&objects, target.uid).map(|slot| &objects[slot]).and_then(|o| o.get("join")).filter(|j| j.truthy()).cloned();
            if let Some(join) = join {
                let by_identity = join.get("target_unique_id").and_then(|id| objects.iter().find(|o| o.get("unique_id") == Some(id)));
                let parent = by_identity.cloned().or_else(|| num(&join, "target_object_slot").filter(|s| s.fract() == 0.0 && *s >= 0.0).and_then(|s| objects.get(s as usize).cloned()));
                let handle = join.get("target_handle_id").cloned();
                let joint = parent.as_ref().and_then(&figure_of).and_then(|f| f.get("segments").and_then(Value::elements).and_then(|s| s.iter().position(|segment| segment.get("segment_id") == handle.as_ref())));
                if let (Some(parent), Some(joint)) = (parent, joint) {
                    target.uid = num(&parent, "unique_id");
                    // `Number(join.target_handle_id)`.
                    target.handle = Some(handle.and_then(|h| h.as_f64()).unwrap_or(f64::NAN));
                    target.joint = Some(joint as f64);
                }
            }
        }
        if !self.sheet() && slot_of(&objects, target.uid).and_then(|slot| figure_of(&objects[slot])).is_none_or(|figure| !figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
            return Err(EditError::Unported("an ordinary native motion-path target before its recordings".into()));
        }
        let mut component = Vec::new();
        if !target.camera {
            let Some(slot) = slot_of(&objects, target.uid) else { return Ok(false) };
            let object = &objects[slot];
            let figure = figure_of(object);
            let segment = target.joint.filter(|j| *j >= 0.0).and_then(|j| figure.as_ref().and_then(|f| f.path(&["segments"])).and_then(|s| if j.fract() == 0.0 { s.item(j as usize) } else { None }));
            if let Some(handle) = target.handle.filter(|h| *h != 0.0 && !h.is_nan())
                && segment.as_ref().is_none_or(|s| num(s, "segment_id") != Some(handle))
            {
                return Ok(false);
            }
            if segment.as_ref().is_some_and(is_static) && !object.path(&["_stykIK", &target.handle_key(), "enabled"]).is_some_and(Value::truthy) {
                return Ok(false);
            }
            component = component_slots(&objects, slot).into_iter().filter_map(|s| uid(&objects[s])).collect();
        }
        // The tracks of the component's layers (and the camera's) must be editable.
        let mut owners: Vec<String> = if target.camera { vec!["camera".into()] } else { Vec::new() };
        for &id in &component {
            let layer = self.layer_of(id);
            if !owners.contains(&layer) {
                owners.push(layer);
            }
        }
        let timeline = rows(&self.report);
        let index = timeline.iter().rposition(|row| row.start <= tick).unwrap_or(0);
        let row = timeline[index];
        let mode = if self.sheet() { Mode::Sheet } else if saved { Mode::Channels } else if falloff.is_some() { Mode::Native } else if tick <= row.start { Mode::Key } else { Mode::Split };
        let falloff_mode = falloff.is_some();
        let mut session = Session {
            label,
            request,
            target,
            tick,
            before_selection: self.selection_state(),
            falloff,
            mode,
            plan: if mode == Mode::Sheet { Some(self.planner(&owners)?) } else { None },
            draft: if mode == Mode::Channels { Some(crate::property_edit::NativeAnimationDraft::new(self)) } else { None },
            channel_touched: Vec::new(),
            posed: Vec::new(),
            component,
            claims: HashSet::new(),
            planned: Vec::new(),
            keys: Vec::new(),
            moved: false,
            last: None,
            fresh: true,
            refreshed: false,
        };
        if falloff_mode {
            if !self.begin_falloff(&mut session)? {
                return Ok(false);
            }
        } else {
            self.check_figures(&session, &source)?;
            let stored = self.report.get("keyframes").and_then(|frames| frames.item(index)).unwrap_or(Value::Null);
            let baseline_frame = if matches!(mode, Mode::Sheet | Mode::Channels) { &source } else { &stored };
            let baseline = if session.target.camera { Vec::new() } else { objects_of(baseline_frame).iter().filter(|o| uid(o).is_some_and(|u| session.component.contains(&u))).map(snapshot_object).collect() };
            let mut working = styk_eval::records::snapshot_pose_frame_of(&source, None);
            if mode == Mode::Key { copy_frame_identity(&mut working, &stored); }
            if mode == Mode::Split { working.make_obj().unwrap().set("duration_raw", Value::Num(row.start + row.count - tick)); }
            let mut posed = Posed::new(tick, 1.0, Kind::Grab, source, working, baseline, [f64::NAN; 2]);
            posed.index = index; posed.row = row;
            session.posed.push(posed);
        }
        self.drag = Some(Drag {
            label: session.label.clone(),
            translation: false,
            index: self.frame_index,
            before: Vec::new(),
            before_selection: session.before_selection.clone(),
            changed: false,
            detached: HashMap::new(),
            rotation_targets: HashMap::new(),
            spatial_gestures: HashMap::new(),
            spatial_kinds: HashMap::new(),
            ik_captures: HashMap::new(),
            spatial_ik_captures: HashMap::new(),
            ik_resume: HashMap::new(),
            handle_edit: None,
            figure_handle: None,
            segment_value_options: None,
            camera: None,
            authored: false,
            rig: None,
            motion_path: Some(Box::new(session)),
            duplicate: None,
            tweener: None,
            serial: self.next_drag_serial(),
        });
        Ok(true)
    }

    /// The frame a write at `tick` starts from: the frame on show at the playhead (a committed
    /// gesture's draft stays on show), else the document evaluated there.
    fn motion_path_source(&self, tick: f64) -> Result<Value, EditError> {
        if tick == self.tick { self.shown_frame() } else { self.evaluated(tick, true) }
    }

    /// The figures a motion-path edit poses and those whose pinned limbs it bakes must be
    /// figures without rig relationships, 3D bones or perspective.
    fn check_figures(&self, session: &Session, frame: &Value) -> Result<(), EditError> {
        if session.target.camera {
            return Ok(());
        }
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let objects = objects_of(frame);
        if figures.iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
            let slots = objects.iter().enumerate().filter_map(|(slot, object)|
                (uid(object).is_some_and(|uid| session.component.contains(&uid)) || has_pinned(object)).then_some(slot)).collect::<Vec<_>>();
            self.origin_motion_gate(&objects, &slots)?;
        }
        for object in objects {
            if !uid(&object).is_some_and(|u| session.component.contains(&u)) && !has_pinned(&object) {
                continue;
            }
            let figure = figures.iter().find(|f| num(f, "figure_type_id") == num(&object, "figure_type_id"));
            let rigged = figure.and_then(|f| f.get("segments")).and_then(Value::elements).is_some_and(|s| s.iter().any(|segment| truthy(&segment, "_stykRig")));
            let spatial = truthy(&object, "_stykSpatial") || controllers(&object).iter().any(|(_, c)| truthy(c, "spatialTarget"));
            if rigged || spatial {
                return Err(EditError::Unported("a motion-path edit of rigged or 3D figures".into()));
            }
        }
        Ok(())
    }

    /// `beginFalloff`: plans the writes and captures each one's frame. `false` when the
    /// grabbed frame has no such joint.
    fn begin_falloff(&mut self, session: &mut Session) -> Result<bool, EditError> {
        // `keyTicksForTarget`: the target's own keys on its layer's track.
        let sheet = self.report.path(&["_styk", "layerSheet"]).cloned().unwrap_or(Value::Null);
        let track = if session.target.camera { "camera".to_string() } else { self.layer_of(session.target.uid.unwrap_or(f64::NAN) as u32) };
        let duration = num(&sheet, "duration").unwrap_or(f64::NAN);
        let mut keys: Vec<f64> = Vec::new();
        for key in sheet.path(&["tracks", &track, "keys"]).and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            let Some(at) = num(&key, "tick") else { continue };
            if !truthy(&key, "patchOnly") && at < duration && !keys.contains(&at) {
                keys.push(at);
            }
        }
        if session.mode == Mode::Channels {
            let channels = items(self.report.path(&["_styk","animation","channels"]));
            let independent = channels.iter().any(|channel| channel.path(&["target","kind"]).and_then(Value::as_str) == Some("figure") &&
                channel.path(&["target","uid"]).and_then(Value::as_f64) == session.target.uid && channel.get("property").and_then(Value::as_str) == Some("pose"));
            for channel in channels {
                let owns = channel.path(&["target","kind"]).and_then(Value::as_str) == Some("figure") && channel.path(&["target","uid"]).and_then(Value::as_f64) == session.target.uid ||
                    !independent && channel.path(&["target","kind"]).and_then(Value::as_str) == Some("layer") && channel.path(&["target","id"]).and_then(Value::as_str) == Some(track.as_str()) && channel.get("property").and_then(Value::as_str) == Some("pose");
                if owns { for key in items(channel.get("keys")).iter().filter(|key| !truthy(key,"hidden")) { if let Some(tick) = num(key,"tick") && !keys.contains(&tick) { keys.push(tick); } } }
            }
        } else if session.mode != Mode::Sheet { keys = rows(&self.report).into_iter().filter(|row| row.count > 0.0).map(|row| row.start).collect(); }
        keys.sort_by(f64::total_cmp);
        session.keys = keys.clone();
        let total = total_ticks(&rows(&self.report));
        let falloff = session.falloff.clone().expect("a falloff edit");
        let writes = plan_falloff(session.tick, &falloff, &keys, total);
        // Stronger writes claim shared hold keys first.
        let priority = |w: &Planned| match w.kind {
            Kind::Grab => 3.0,
            Kind::Key => 1.0 + w.weight,
            Kind::Edge => 0.0,
        };
        let mut ordered = writes.clone();
        ordered.sort_by(|a, b| priority(b).total_cmp(&priority(a)));
        for write in ordered {
            match self.falloff_frame(session, write)? {
                Some(posed) => session.posed.push(posed),
                None if write.kind == Kind::Grab => return Ok(false),
                None => {}
            }
        }
        session.planned = writes.into_iter().filter(|w| session.posed.iter().any(|p| p.tick == w.tick)).collect();
        Ok(true)
    }

    /// `falloffWrite`: one write of a falloff edit, its own frame at its own tick.
    fn falloff_frame(&self, session: &Session, write: Planned) -> Result<Option<Posed>, EditError> {
        if rows(&self.report).is_empty() {
            return Ok(None);
        }
        let source = self.motion_path_source(write.tick)?;
        self.check_figures(session, &source)?;
        let timeline = rows(&self.report);
        let index = timeline.iter().rposition(|row| row.start <= write.tick).unwrap_or(0);
        let row = timeline[index];
        let stored = self.report.get("keyframes").and_then(|frames| frames.item(index)).unwrap_or(Value::Null);
        let baseline_frame = if session.mode == Mode::Native && write.tick <= row.start { &stored } else { &source };
        let baseline = if session.target.camera { Vec::new() } else { objects_of(baseline_frame).iter().filter(|o| uid(o).is_some_and(|u| session.component.contains(&u))).map(snapshot_object).collect() };
        let mut working = styk_eval::records::snapshot_pose_frame_of(&source, None);
        if session.mode == Mode::Native && write.tick <= row.start { copy_frame_identity(&mut working, &stored); }
        let origin = if session.target.camera {
            let camera = crate::camera_commands::camera_values(working.get("camera"));
            let field = |key: &str| camera.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
            [self.canvas("canvas_width") / 2.0 + field("x"), self.canvas("canvas_height") / 2.0 + field("y")]
        } else {
            let Some(slot) = slot_of(&objects_of(&working), session.target.uid) else { return Ok(None) };
            let Some(handle) = session.target.handle else { return Ok(None) };
            let (prepared, frame, scene) = self.posed_scene(&working)?;
            match self.joint_point(&prepared, &frame, &scene, slot, handle) {
                Some(point) => point,
                None => return Ok(None),
            }
        };
        let mut posed = Posed::new(write.tick, write.weight, write.kind, source, working, baseline, origin);
        posed.index = index; posed.row = row;
        Ok(Some(posed))
    }

    /// `report[key]` as a number.
    fn canvas(&self, key: &str) -> f64 {
        self.report.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
    }

    /// The typed view of a posed frame and its geometry (`buildGeometry(report, working)`).
    fn posed_scene(&self, record: &Value) -> Result<(Arc<Prepared>, Frame, Scene), EditError> {
        let (prepared, frame) = self.posed_frame(record)?;
        let scene = styk_eval::geometry::build(&prepared.doc, &frame);
        Ok((prepared, frame, scene))
    }

    fn posed_frame(&self, record: &Value) -> Result<(Arc<Prepared>, Frame), EditError> {
        let prepared = self.prepared()?;
        if let Some(feature) = prepared.doc.unsupported.first() {
            return Err(EditError::Unported(format!("geometry with {feature}")));
        }
        let frame = self.eval.borrow_mut().loader.edit_frame(record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        Ok((prepared, frame))
    }

    /// `geometry.objects.get(slot).joints.get(handle)`.
    fn joint_point(&self, prepared: &Prepared, frame: &Frame, scene: &Scene, slot: usize, handle: f64) -> Option<[f64; 2]> {
        let object = frame.objects.get(slot)?;
        let geometry = scene.objects.iter().find(|g| g.uid == object.uid && g.resolved)?;
        if handle == 0.0 {
            return Some(geometry.root);
        }
        if handle.fract() != 0.0 || !(1.0..=f64::from(u32::MAX)).contains(&handle) {
            return None;
        }
        let figure = object.figure_override.as_deref().or_else(|| prepared.doc.figure(object.figure).map(|f| &**f))?;
        geometry.joint(figure, handle as u32)
    }

    /// The segment `joint` of the figure in `slot` as geometry draws it.
    fn posed_shape(&self, prepared: &Prepared, frame: &Frame, scene: &Scene, slot: usize, joint: usize) -> Option<Shape> {
        let object = frame.objects.get(slot)?;
        let geometry = scene.objects.iter().find(|g| g.uid == object.uid && g.resolved)?;
        let figure = object.figure_override.as_deref().or_else(|| prepared.doc.figure(object.figure).map(|f| &**f))?;
        let segment = figure.segments.get(joint)?;
        let start = *geometry.starts.get(joint)?;
        let (_, bend, _) = styk_eval::geometry::segment_pose(object, segment, joint);
        // A straight Stick Nodes segment with a sagitta is drawn as a curve, which geometry
        // reports with a bend of 1e-6.
        let bend = if bend.abs() < 1e-7 && styk_eval::sticknodes::shape_for(segment, object).is_some_and(|s| s.sagitta != 0.0) { 1e-6 } else { bend };
        let angle = displayed_angle(prepared, frame, scene, &solve_frame(prepared, frame, scene), slot, joint);
        Some(Shape { start, angle, bend })
    }

    /// `updateMotionPathEdit(point, options)`.
    fn update_motion_path_edit(&mut self, point: &Value, options: &Value) -> Result<bool, EditError> {
        if !self.motion_path_open() {
            return Ok(false);
        }
        if !point.is_object() {
            return Err(EditError::Unported("a motion-path point that is not an object".into()));
        }
        let coordinate = |key: &str| point.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).ok_or_else(|| crate::transform::not_finite(&format!("Motion-path {}", key.to_uppercase())));
        let point_xy = [coordinate("x")?, coordinate("y")?];
        let mut session = self.take_motion_path();
        session.last = Some((point.clone(), options.clone()));
        let result = if session.falloff.is_some() { self.update_falloff(&mut session, point_xy, options) } else { self.update_single(&mut session, point_xy, options) };
        self.put_motion_path(session);
        result
    }

    fn take_motion_path(&mut self) -> Session {
        *self.drag.as_mut().and_then(|d| d.motion_path.take()).expect("an open motion-path edit")
    }

    fn put_motion_path(&mut self, session: Session) {
        if let Some(drag) = self.drag.as_mut() {
            drag.motion_path = Some(Box::new(session));
        }
    }

    /// One frame: the pose at the session's tick, written to the tracks of the figures it changed.
    fn update_single(&mut self, session: &mut Session, point: [f64; 2], options: &Value) -> Result<bool, EditError> {
        let target = session.target.clone();
        if !self.apply_path_point(&target, &mut session.posed[0], point, options)? {
            return Ok(true);
        }
        session.moved = true;
        let posed = &mut session.posed[0];
        posed.moved = true;
        self.synchronize_origin_frame(&mut posed.working, &posed.baseline, false)?;
        if target.camera {
            posed.camera_changed = true;
        }
        let changed = changed_uids(posed, None);
        let mut owners: Vec<String> = Vec::new();
        for &id in &changed {
            let layer = self.layer_of(id);
            if !owners.contains(&layer) {
                owners.push(layer);
            }
        }
        if posed.camera_changed && !owners.iter().any(|o| o == "camera") {
            owners.push("camera".into());
        }
        if let Some(plan) = session.plan.as_mut() {
            for id in &owners { self.draft_write(plan, posed, id, &changed)?; }
        }
        let changed = changed_uids(posed, None);
        if session.mode == Mode::Channels { self.write_channels(session, 0, &changed)?; }
        session.refreshed = true;
        self.emit("edit", vec![("live", Value::Bool(true)), ("motionPath", Value::Bool(true)), ("changedUids", uid_array(&changed))]);
        Ok(true)
    }

    /// `updateFalloff`: each write's frame moves by the grabbed frame's delta times its weight.
    fn update_falloff(&mut self, session: &mut Session, point: [f64; 2], options: &Value) -> Result<bool, EditError> {
        let target = session.target.clone();
        let grab = session.posed[0].origin;
        let delta = [point[0] - grab[0], point[1] - grab[1]];
        for index in 0..session.posed.len() {
            if session.posed[index].weight == 0.0 {
                continue;
            }
            let posed = &session.posed[index];
            let to = if index == 0 { point } else { [posed.origin[0] + delta[0] * posed.weight, posed.origin[1] + delta[1] * posed.weight] };
            let mut posed = session.posed[index].clone();
            let applied = self.apply_path_point(&target, &mut posed, to, options);
            let moved = matches!(applied, Ok(true));
            if moved {
                posed.moved = true;
                self.synchronize_origin_frame(&mut posed.working, &posed.baseline, false)?;
                if target.camera {
                    posed.camera_changed = true;
                }
                posed.changed = changed_uids(&posed, Some(&session.component));
            }
            session.posed[index] = posed;
            applied?;
        }
        session.moved = session.posed.iter().any(|p| p.moved);
        if session.moved {
            // Edges are written once they have something to hold against.
            for index in 0..session.posed.len() {
                if session.posed[index].kind != Kind::Edge || !session.posed[index].written {
                    self.write_falloff(session, index)?;
                    session.posed[index].written = true;
                }
            }
            session.refreshed = true;
        }
        let mut changed: Vec<u32> = Vec::new();
        for posed in session.posed.iter().filter(|p| p.moved) {
            for &id in &posed.changed {
                if !changed.contains(&id) {
                    changed.push(id);
                }
            }
        }
        self.emit("edit", vec![("live", Value::Bool(true)), ("motionPath", Value::Bool(true)), ("changedUids", uid_array(&changed))]);
        Ok(true)
    }

    /// `writeFalloff`: a write's poses recorded into the sheet plan; edges write the unchanged
    /// component so that the original pose holds there.
    fn write_falloff(&mut self, session: &mut Session, index: usize) -> Result<(), EditError> {
        if !matches!(session.mode, Mode::Sheet | Mode::Channels) { return Ok(()); }
        let edge = session.posed[index].kind == Kind::Edge;
        if !edge && !session.posed[index].moved {
            return Ok(());
        }
        let changed = if edge { if session.target.camera { Vec::new() } else { session.component.clone() } } else { session.posed[index].changed.clone() };
        if session.mode == Mode::Channels { return self.write_channels(session, index, &changed); }
        let mut owners: Vec<String> = Vec::new();
        for &id in &changed {
            let layer = self.layer_of(id);
            if !owners.contains(&layer) {
                owners.push(layer);
            }
        }
        if session.target.camera && !owners.iter().any(|o| o == "camera") {
            owners.push("camera".into());
        }
        for id in owners {
            if self.sheet_claim(session, index, &id) {
                self.draft_write(session.plan.as_mut().expect("sheet session"), &mut session.posed[index], &id, &changed)?;
            }
        }
        Ok(())
    }

    /// `sheetClaim`: writes resolve holds to their key; two writes resolving to the same key of
    /// the same track keep the stronger one, and edges never rewrite a hold.
    fn sheet_claim(&self, session: &mut Session, index: usize, id: &str) -> bool {
        if let Some((_, known)) = session.posed[index].claims.iter().find(|(track, _)| track == id) {
            return *known;
        }
        let keys = session.plan.as_mut().expect("sheet session").keys(id);
        let tick = session.posed[index].tick;
        let key = key_at(&keys, tick).map(|i| &keys[i]);
        let held = key.is_some_and(|k| matches!(k.get("interpolation").and_then(Value::as_str), Some("constant" | "hold")) || truthy(k, "movieclipPatches"));
        let at = if held { key.and_then(|k| num(k, "tick")).unwrap_or(f64::NAN) } else { tick };
        let claim = (id.to_string(), at.to_bits());
        let allowed = !(session.posed[index].kind == Kind::Edge && held) && !session.claims.contains(&claim);
        if allowed {
            session.claims.insert(claim);
        }
        session.posed[index].claims.push((id.to_string(), allowed));
        allowed
    }

    /// `_sheetPoseDraftWrite(draft, id, frame, changedUids)`: the first write keys the track at
    /// the frame's tick (a held cell at its key unless auto key is on); every later pointer move
    /// captures the same pose source again.
    fn draft_write(&self, plan: &mut Plan, posed: &mut Posed, id: &str, changed: &[u32]) -> Result<(), EditError> {
        let frame = &posed.working;
        let owns = |figure: f64| self.layer_of(figure as u32) == id;
        let objects = objects_of(frame);
        // Whether the layer shows anything in the frame (the scene and camera tracks always hold their pose).
        let shown = objects.iter().any(|o| num(o, "unique_id").is_some_and(owns)) || continuations(frame).iter().any(|step| num(step, "uid").is_some_and(owns));
        let empty = !fixed(id) && !shown;
        let here: Vec<u32> = changed.iter().copied().filter(|&u| owns(f64::from(u))).collect();
        let at = match posed.writes.iter().position(|(track, _)| track == id) {
            Some(at) => at,
            None => {
                let mut keys = plan.keys(id);
                let index = key_at(&keys, posed.tick);
                let key = index.map(|i| keys[i].clone());
                let patches = key.as_ref().and_then(|k| k.get("movieclipPatches")).filter(|p| p.truthy());
                let placed: Vec<u32> = patches
                    .and_then(Value::elements)
                    .map(|e| e.iter().collect::<Vec<_>>())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|p| p.get("frameId").and_then(Value::as_str).and_then(|f| self.frame_by_id(f)))
                    .flat_map(|f| objects_of(&f).iter().filter_map(uid).collect::<Vec<_>>())
                    .collect();
                if let (Some(index), Some(key), Some(_), false) = (index, &key, patches, self.auto_key)
                    && !here.is_empty()
                    && here.iter().all(|u| placed.contains(u))
                {
                    // The figures a key's movieclip replacements placed are edited in those
                    // replacements; the key keeps its pose.
                    if let Some(owned) = keys[index].make_obj() {
                        owned.set("empty", Value::Bool(!objects.iter().any(|o| num(o, "unique_id").is_some_and(owns))));
                    }
                    plan.set_keys(id, keys);
                    let name = key.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let next_tick = keys_next_tick(plan, id, index);
                    posed.writes.push((id.to_string(), Entry { key: name, source: None, write_tick: posed.tick, next_tick, patches: Some(Vec::new()) }));
                    posed.writes.len() - 1
                } else {
                    // Auto key writes at the frame's tick; otherwise a held cell edits its preceding key.
                    let held = key.as_ref().is_some_and(|k| matches!(k.get("interpolation").and_then(Value::as_str), Some("constant" | "hold")));
                    let write_tick = match &key {
                        Some(key) if !self.auto_key && held => num(key, "tick").unwrap_or(posed.tick),
                        _ => posed.tick,
                    };
                    let easing = key.unwrap_or_else(constant);
                    plan.write(id, write_tick, frame, Write { easing: Some(&easing), ..Write::default() })?;
                    let keys = plan.keys(id);
                    let index = keys.iter().position(|key| num(key, "tick") == Some(write_tick));
                    let written = index.and_then(|index| keys.get(index)).cloned().unwrap_or(Value::Null);
                    let next_tick = index.map_or(write_tick + 1.0, |index| keys_next_tick(plan, id, index));
                    let entry = Entry { key: written.get("id").and_then(Value::as_str).unwrap_or("").to_string(), source: written.path(&["value", "frameId"]).and_then(Value::as_str).map(str::to_string), write_tick, next_tick, patches: None };
                    posed.writes.push((id.to_string(), entry));
                    return Ok(());
                }
            }
        };
        let entry = posed.writes[at].1.clone();
        let mut keys = plan.keys(id);
        let Some(index) = keys.iter().position(|k| k.get("id").and_then(Value::as_str) == Some(entry.key.as_str())) else {
            return Err(EditError::Unported("a motion-path key that left its track".into()));
        };
        if let Some(mut records) = entry.patches.clone() {
            let previous: Vec<Value> = keys[index].get("movieclipPatches").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            let mut replaced = Vec::with_capacity(previous.len());
            for patch in previous {
                let replaced_uid = num(&patch, "uid").unwrap_or(f64::NAN);
                let record = records.iter().position(|(figure, _, _)| *figure == replaced_uid);
                let retained = match record {
                    Some(r) => plan.captured(&records[r].1).cloned(),
                    None => patch.get("frameId").and_then(Value::as_str).and_then(|f| self.frame_by_id(f)),
                };
                let members: Vec<u32> = retained.as_ref().map(|r| objects_of(r).iter().filter_map(uid).collect()).unwrap_or_default();
                if !here.iter().any(|u| members.contains(u)) {
                    replaced.push(patch);
                    continue;
                }
                let patch_frame = self.owned_frame(frame, &members, &retained.as_ref().map(continuations).unwrap_or_default())?;
                match record {
                    Some(r) => {
                        plan.recapture(&patch_frame, id, &records[r].1);
                        replaced.push(records[r].2.clone());
                    }
                    None => {
                        let frame_id = plan.capture(&patch_frame, id).get("frameId").and_then(Value::as_str).unwrap_or("").to_string();
                        let mut target = patch.as_obj().cloned().unwrap_or_default();
                        target.set("frameId", Value::str(&frame_id));
                        let target = Value::object(target);
                        records.push((replaced_uid, frame_id, target.clone()));
                        replaced.push(target);
                    }
                }
            }
            let mut keys = plan.keys(id);
            if let Some(key) = keys[index].make_obj() {
                key.set("empty", Value::Bool(!objects.iter().any(|o| num(o, "unique_id").is_some_and(owns))));
                key.set("movieclipPatches", Value::array(replaced));
            }
            plan.set_keys(id, keys);
            posed.writes[at].1.patches = Some(records);
            return Ok(());
        }
        match &entry.source {
            Some(source) => {
                plan.recapture(frame, id, source);
                if let Some(key) = keys[index].make_obj() {
                    key.set("empty", Value::Bool(empty));
                }
                plan.set_keys(id, keys);
            }
            None if !fixed(id) && shown => {
                let value = plan.capture(frame, id);
                let source = value.get("frameId").and_then(Value::as_str).map(str::to_string);
                let mut keys = plan.keys(id);
                if let Some(key) = keys[index].make_obj() {
                    key.set("value", value);
                    key.set("empty", Value::Bool(false));
                }
                plan.set_keys(id, keys);
                posed.writes[at].1.source = source;
            }
            None => {}
        }
        Ok(())
    }

    /// `applyPathPoint(session, editor, point, options)`: poses the frame so that the target is
    /// at `point`; whether anything changed.
    fn apply_path_point(&self, target: &Target, posed: &mut Posed, point: [f64; 2], options: &Value) -> Result<bool, EditError> {
        let flag = |key: &str| options.get(key).is_some_and(Value::truthy);
        if target.camera {
            let current = crate::camera_commands::camera_values(posed.working.get("camera"));
            let next = checked_camera(&current, point[0] - self.canvas("canvas_width") / 2.0, point[1] - self.canvas("canvas_height") / 2.0)?;
            if json(&current) == json(&next) {
                return Ok(false);
            }
            if let Some(frame) = posed.working.make_obj() {
                frame.set("camera", next);
            }
            return Ok(true);
        }
        let objects = objects_of(&posed.working);
        let Some(slot) = slot_of(&objects, target.uid) else { return Ok(false) };
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let Some(figure) = figures.iter().find(|f| num(f, "figure_type_id") == num(&objects[slot], "figure_type_id")).cloned() else { return Ok(false) };
        if target.origin() {
            return self.translate_component(posed, slot, point, flag("movePins"));
        }
        let key = target.handle_key();
        if objects[slot].path(&["_stykIK", &key, "enabled"]).is_some_and(Value::truthy) {
            return self.pose_ik_remote(target, posed, slot, point);
        }
        let joint = target.joint.filter(|j| j.fract() == 0.0 && *j >= 0.0).map(|j| j as usize);
        let Some(joint) = joint.filter(|&j| figure.get("segments").and_then(|s| s.item(j)).is_some_and(|s| !is_static(&s))) else { return Ok(false) };
        // Posing a pinned limb's figure bakes the displayed solution first.
        if posed.baseline.iter().any(has_pinned) {
            let (prepared, frame, scene) = self.posed_scene(&posed.working)?;
            let solved = solve_frame(&prepared, &frame, &scene);
            for (member, object) in objects.iter().enumerate() {
                if !has_pinned(object) {
                    continue;
                }
                let Some(solution) = uid(object).and_then(|u| solved.get(&u)) else { continue };
                let Some(record) = object_mut(&mut posed.working, member) else { continue };
                bake_object(record, solution);
                record.set("angles", Value::nums(&solution.solution.angles));
                if let Some(lengths) = &solution.solution.lengths {
                    record.set("len_flag", Value::Num(1.0));
                    record.set("lengths", Value::nums(lengths));
                }
            }
        }
        let (prepared, frame, scene) = self.posed_scene(&posed.working)?;
        let Some(shape) = self.posed_shape(&prepared, &frame, &scene, slot, joint) else { return Ok(false) };
        let angle = atan2(point[1] - shape.start[1], point[0] - shape.start[0]) - shape.bend / 2.0;
        let delta = shortest(angle - shape.angle);
        let stretch = flag("stretch");
        if (delta == 0.0 || delta.is_nan()) && !stretch {
            return Ok(false);
        }
        let isolate = flag("isolate");
        let targets = match posed.rotation_targets.get(&(slot, joint, isolate)) {
            Some(targets) => targets.clone(),
            None => {
                let targets = crate::pose::rotation_targets(&objects_of(&posed.working), &figures, slot, joint, isolate);
                posed.rotation_targets.insert((slot, joint, isolate), targets.clone());
                targets
            }
        };
        self.apply_rotation(target, posed, slot, &targets, delta)?;
        let scale = num(&object_at(&posed.working, slot), "scale").unwrap_or(f64::NAN);
        if stretch && scale.abs() > 1e-8 {
            let record = object_mut(&mut posed.working, slot).ok_or_else(|| EditError::Unported("a motion-path figure outside its frame".into()))?;
            if !truthy(&Value::object(record.clone()), "len_flag") {
                record.set("lengths", Value::array(figure.get("segments").and_then(Value::elements).map(|e| e.iter().map(|s| s.get("length").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default()));
            }
            record.set("len_flag", Value::Num(1.0));
            let bend = shape.bend;
            let chord = if bend.abs() < 1e-7 { 1.0 } else { (2.0 * sin(bend / 2.0) / bend).abs() };
            if chord < 1e-8 {
                return Err(EditError::Invalid("errors.editorMotionPath.reduceTheFullCircleBendBeforeStretchingThis".into()));
            }
            crate::pose::set_item(record, "lengths", joint, hypot(point[0] - shape.start[0], point[1] - shape.start[1]) / (scale.abs() * chord));
        }
        Ok(true)
    }

    /// The origin branch of `applyPathPoint`: the figure's connected figures translated so that
    /// its origin is at `point`, pinned targets carried along with `movePins`.
    fn translate_component(&self, posed: &mut Posed, slot: usize, point: [f64; 2], move_pins: bool) -> Result<bool, EditError> {
        let objects = objects_of(&posed.working);
        let Some(id) = uid(&objects[slot]) else { return Ok(false) };
        let affected = resolve_join_selection(&objects, &[id], true)?;
        let ids: Vec<u32> = affected.iter().filter_map(|&s| uid(&objects[s])).collect();
        let (_, frame, scene) = self.posed_scene(&posed.working)?;
        let root_of = |s: usize| frame.objects.get(s).and_then(|o| scene.objects.iter().find(|g| g.uid == o.uid && g.resolved)).map(|g| g.root);
        let Some(origin) = root_of(slot) else { return Ok(false) };
        let start = *posed.translation_origin.get_or_insert(origin);
        let (dx, dy) = (point[0] - origin[0], point[1] - origin[1]);
        let mut changed = dx != 0.0 || dy != 0.0;
        let member = |object: &Value| uid(object).is_some_and(|u| ids.contains(&u));
        // Members joined outside the component stay where geometry draws them, unjoined.
        for s in 0..objects.len() {
            let object = &objects[s];
            let outside = join_target(object).is_some_and(|parent| !objects.get(parent).is_some_and(member));
            if member(object) && object.get("join").is_some_and(Value::truthy) && outside {
                let root = root_of(s);
                let record = object_mut(&mut posed.working, s).unwrap();
                if let Some(root) = root {
                    record.set("root_x", Value::Num(root[0]));
                    record.set("root_y", Value::Num(root[1]));
                }
                record.set("join", Value::Null);
            }
        }
        for s in 0..objects.len() {
            let object = object_at(&posed.working, s);
            if member(&object) && !object.get("join").is_some_and(Value::truthy) {
                let record = object_mut(&mut posed.working, s).unwrap();
                let field = |record: &Obj, key: &str| record.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
                let (x, y) = (field(record, "root_x"), field(record, "root_y"));
                record.set("root_x", Value::Num(x + dx));
                record.set("root_y", Value::Num(y + dy));
            }
        }
        let (px, py) = if move_pins { (point[0] - start[0], point[1] - start[1]) } else { (0.0, 0.0) };
        for (s, object) in objects.iter().enumerate() {
            if !member(object) {
                continue;
            }
            let slot_field = num(&object_at(&posed.working, s), "object_slot").filter(|v| v.fract() == 0.0 && *v >= 0.0);
            let source = slot_field.map(|v| object_at(&posed.source, v as usize)).unwrap_or(Value::Null);
            let record = object_mut(&mut posed.working, s).unwrap();
            if translate_targets(record, px, py, &source, true) {
                changed = true;
            }
        }
        Ok(changed)
    }

    /// `applyRotation`: followers of pinned limbs turn with what turns (`_rotateIKFollowers`, the
    /// dragged joint itself left out), then every target segment's angle.
    fn apply_rotation(&self, target: &Target, posed: &mut Posed, slot: usize, targets: &[(usize, usize)], delta: f64) -> Result<(), EditError> {
        let unported = |what: &str| EditError::Unported(format!("turning the followers of an IK target {what}"));
        if delta != 0.0 && !delta.is_nan() && posed.baseline.iter().any(has_pinned) {
            let objects = objects_of(&posed.working);
            let selected: HashSet<(usize, usize)> = targets.iter().copied().collect();
            let (prepared, frame) = self.posed_frame(&posed.working)?;
            let slots = component_slots(&objects, slot);
            let figure_of = |s: usize| frame.objects.get(s).and_then(|o| o.figure_override.as_ref().or_else(|| prepared.doc.figure(o.figure)));
            let joint = target.joint.unwrap_or(f64::NAN);
            // (owner slot, owner handle, the controller's next value)
            let mut updates: Vec<(usize, String, Obj)> = Vec::new();
            match slots.len() > 1 {
                true => {
                    let graph = Assembly::new(&frame, &slots, &figure_of).ok_or_else(|| unported("of joined figures the engine cannot assemble"))?;
                    let skeleton = graph.skeleton();
                    for (&id, c) in &graph.controllers.controllers {
                        let Some(endpoint) = skeleton.index(id).filter(|_| c.active()) else { continue };
                        let owner = graph.entry(endpoint);
                        if selected.contains(&(owner.slot, owner.index)) { continue; }
                        let key = owner.handle.to_string();
                        let current = objects[owner.slot].path(&["_stykIK", &key]).cloned().unwrap_or(Value::Null);
                        if !current.truthy() { continue; }
                        let followers = skeleton.followers(graph.angles(), id, c);
                        let mut next: Option<Obj> = None;
                        for i in skeleton.follower_indices(id) {
                            let child = graph.entry(i);
                            if (child.slot == slot && child.index as f64 == joint) || !selected.contains(&(child.slot, child.index)) { continue; }
                            let next = next.get_or_insert_with(|| follower_copy(&current));
                            let angle = Value::Num(followers.get(&skeleton.segments[i].id).copied().unwrap_or(f64::NAN) + delta);
                            let handle = child.handle.to_string();
                            if child.slot == owner.slot {
                                let mut table = next.get("followers").and_then(Value::as_obj).cloned().unwrap_or_default();
                                assign(&mut table, &handle, angle);
                                next.set("followers", Value::object(table));
                            } else {
                                let uid = child.uid.to_string();
                                let mut table = next.get("joinedFollowers").and_then(Value::as_obj).cloned().unwrap_or_default();
                                let mut own = table.get(&uid).and_then(Value::as_obj).cloned().unwrap_or_default();
                                assign(&mut own, &handle, angle);
                                assign(&mut table, &uid, Value::object(own));
                                next.set("joinedFollowers", Value::object(table));
                            }
                        }
                        if let Some(next) = next { updates.push((owner.slot, key, next)); }
                    }
                }
                false => {
                    let source = &objects[slot];
                    let figure = num(source, "figure_type_id").and_then(|id| prepared.doc.figure(id as u32)).ok_or_else(|| unported("of a figure without a definition"))?;
                    let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
                    let table = ik::parse::table(source.get("_stykIK"));
                    for (key, c) in controllers(source) {
                        if !(truthy(&c, "enabled") && truthy(&c, "pinned")) {
                            continue;
                        }
                        let Ok(id) = key.parse::<u32>() else { continue };
                        let Some(endpoint) = skeleton.index(id) else { continue };
                        if selected.contains(&(slot, endpoint)) {
                            continue;
                        }
                        let handle = figure.segments[endpoint].id.to_string();
                        let current = source.path(&["_stykIK", &handle]).cloned().unwrap_or(Value::Null);
                        if !current.truthy() {
                            continue;
                        }
                        let angles = source.get("angles").and_then(Value::numbers).filter(|a| a.len() >= figure.segments.len()).ok_or_else(|| unported("of a pose without every angle"))?;
                        let controller = table.as_ref().and_then(|t| t.get(id)).ok_or_else(|| unported("with a controller the engine cannot read"))?;
                        let followers = skeleton.followers(&angles, id, controller);
                        let mut next: Option<Obj> = None;
                        for i in skeleton.follower_indices(id) {
                            if i as f64 == joint || !selected.contains(&(slot, i)) {
                                continue;
                            }
                            let next = next.get_or_insert_with(|| follower_copy(&current));
                            let child = figure.segments[i].id;
                            let angle = followers.get(&child).copied().unwrap_or(0.0) + delta;
                            let mut table = next.get("followers").and_then(Value::as_obj).cloned().unwrap_or_default();
                            assign(&mut table, &child.to_string(), Value::Num(angle));
                            next.set("followers", Value::object(table));
                        }
                        if let Some(next) = next {
                            updates.push((slot, handle, next));
                        }
                    }
                }
            }
            for (owner, handle, next) in updates {
                if let Some(record) = object_mut(&mut posed.working, owner) {
                    set_controller(record, &handle, next);
                }
            }
        }
        // Grouped by figure: each angle changes once.
        let mut by_object: Vec<(usize, Vec<usize>)> = Vec::new();
        for &(s, segment) in targets {
            match by_object.iter_mut().find(|(known, _)| *known == s) {
                Some((_, list)) => list.push(segment),
                None => by_object.push((s, vec![segment])),
            }
        }
        for (s, segments) in by_object {
            let figure = (s != slot).then(|| self.figure_of(&object_at(&posed.working, s))).flatten();
            let Some(record) = object_mut(&mut posed.working, s) else { continue };
            let Some(angles) = record.get_mut("angles") else { continue };
            let Some(list) = angles.make_arr() else { continue };
            for index in segments {
                if let Some(angle) = list.get_mut(index) {
                    *angle = Value::Num(angle.as_f64().unwrap_or(f64::NAN) + delta);
                }
            }
            angles.repack();
            if let Some(figure) = figure { crate::origin::rotate_support(&figure, record, delta); }
        }
        Ok(())
    }

    /// `poseIKRemote`: a pinned controller's target moves; a free limb is captured as drawn,
    /// solved with the captured controller pinned at the point, and baked, its followers and
    /// bend kept in the controller.
    fn pose_ik_remote(&self, target: &Target, posed: &mut Posed, slot: usize, point: [f64; 2]) -> Result<bool, EditError> {
        let unported = |what: &str| EditError::Unported(format!("a motion-path edit of an IK target {what}"));
        let key = target.handle_key();
        let handle = target.handle.filter(|h| h.fract() == 0.0 && (1.0..=f64::from(u32::MAX)).contains(h)).map(|h| h as u32).ok_or_else(|| unported("whose handle is not a joint"))?;
        let objects = objects_of(&posed.working);
        let object = objects[slot].clone();
        let current = object.path(&["_stykIK", &key]).cloned().unwrap_or(Value::Null);
        let slots = component_slots(&objects, slot);
        let (prepared, frame, scene) = self.posed_scene(&posed.working)?;
        let Some(evaluated) = frame.objects.get(slot) else { return Ok(false) };
        let Some(geometry) = scene.objects.iter().find(|g| g.uid == evaluated.uid && g.resolved) else { return Ok(false) };
        let mut next = current.as_obj().cloned().unwrap_or_default();
        let mut moved = current.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        moved.set("x", Value::Num(point[0]));
        moved.set("y", Value::Num(point[1]));
        next.set("target", Value::object(moved));
        if truthy(&current, "pinned") {
            let record = object_mut(&mut posed.working, slot).ok_or_else(|| unported("outside its frame"))?;
            set_controller(record, &key, next);
            return Ok(true);
        }
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|t| t.get(handle).cloned()).ok_or_else(|| unported("with a controller the engine cannot read"))?;
        let rotation = controller.target.rotation;
        let baseline_of = |s: usize| posed.baseline.iter().find(|o| num(o, "object_slot") == Some(s as f64)).cloned();
        let figure_of = |s: usize| frame.objects.get(s).and_then(|o| o.figure_override.as_ref().or_else(|| prepared.doc.figure(o.figure)));
        let graph = match slots.len() > 1 {
            true => Some(Assembly::new(&frame, &slots, &figure_of).ok_or_else(|| unported("of joined figures the engine cannot assemble"))?),
            false => None,
        };
        let solved = solve_frame(&prepared, &frame, &scene);
        let drawn = |s: usize, i: usize| displayed_angle(&prepared, &frame, &scene, &solved, s, i);
        let geometry_of = |s: usize| frame.objects.get(s).and_then(|o| scene.objects.iter().find(|g| g.uid == o.uid && g.resolved));
        match graph {
            Some(mut graph) => {
                let chain = graph.chain(slot, handle, controller.chain_length);
                if chain.is_empty() {
                    return Ok(false);
                }
                let id = graph.id(slot, handle).ok_or_else(|| unported("of a handle outside the assembly"))?;
                let (mut followers, mut joined) = (BTreeMap::new(), BTreeMap::<u32, BTreeMap<u32, f64>>::new());
                for i in graph.skeleton().follower_indices(id) {
                    let entry = graph.entry(i);
                    let angle = drawn(entry.slot, entry.index) - rotation;
                    if entry.slot == slot {
                        followers.insert(entry.handle, angle);
                    } else {
                        joined.entry(entry.uid).or_default().insert(entry.handle, angle);
                    }
                }
                let mut points = Vec::with_capacity(chain.len() + 1);
                let mut lengths = Vec::with_capacity(chain.len());
                for (k, &i) in chain.iter().enumerate() {
                    let entry = graph.entry(i);
                    let g = geometry_of(entry.slot).ok_or_else(|| unported("of a figure the engine does not draw"))?;
                    let (start, end) = (g.starts[entry.index], g.ends[entry.index]);
                    if k == 0 {
                        points.push(start);
                    }
                    points.push(end);
                    lengths.push(hypot(end[0] - start[0], end[1] - start[1]));
                }
                let captured = ik::bend_reference(&points, &lengths, controller.bend_reference.as_ref());
                let temporary = Controller {
                    pinned: true,
                    target: ik::Target { x: point[0], y: point[1], rotation },
                    followers: followers.clone(),
                    joined_followers: Some(joined.clone()),
                    bend_reference: Some(captured.clone()),
                    ..controller
                };
                // The lengths the frame had when the gesture began, scaled into the skeleton.
                for i in 0..graph.lengths_mut().len() {
                    let entry = graph.entry(i);
                    let baseline = baseline_of(entry.slot);
                    let length = match baseline.filter(|b| truthy(b, "len_flag")) {
                        Some(baseline) => baseline.get("lengths").and_then(|l| l.item(entry.index)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN),
                        None => figure_of(entry.slot).map_or(f64::NAN, |f| f.segments[entry.index].length),
                    };
                    graph.lengths_mut()[i] = length * entry.scale;
                }
                let mapped = graph.map_controller(slot, id, &temporary);
                let table = Table { controllers: BTreeMap::from([(id, mapped)]) };
                let solution = graph.solve(&table).ok_or_else(|| unported("the solver did not reach"))?;
                let bend = solution.results.iter().find(|(h, _)| *h == id).and_then(|(_, o)| o.bend_reference.clone()).unwrap_or(captured);
                for part in graph.scatter(&solution, &table) {
                    let baseline = baseline_of(part.slot);
                    let record = object_mut(&mut posed.working, part.slot).ok_or_else(|| unported("outside its frame"))?;
                    record.set("angles", Value::nums(&part.solution.angles));
                    // `result.lengths ? 1 : baseline?.len_flag ?? 0`, `(result.lengths ?? baseline?.lengths ?? []).slice()`
                    let flag = match &part.solution.lengths {
                        Some(_) => Value::Num(1.0),
                        None => baseline.as_ref().and_then(|b| b.get("len_flag")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0)),
                    };
                    record.set("len_flag", flag);
                    let lengths = match &part.solution.lengths {
                        Some(lengths) => Value::nums(lengths),
                        None => baseline.as_ref().and_then(|b| b.get("lengths")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::array(Vec::new())),
                    };
                    record.set("lengths", lengths);
                }
                next.set("followers", angle_table(&followers));
                next.set("joinedFollowers", joined_table(&joined));
                next.set("spatialFollowers", Value::object(Obj::new()));
                next.set("joinedSpatialFollowers", Value::object(Obj::new()));
                next.set("bendReference", reference_value(&bend));
            }
            None => {
                let figure = evaluated.figure_override.as_deref().or_else(|| prepared.doc.figure(evaluated.figure).map(|f| &**f)).ok_or_else(|| unported("of a figure without a definition"))?;
                let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
                if skeleton.index(handle).is_none() {
                    return Ok(false);
                }
                let followers: BTreeMap<u32, f64> = skeleton.follower_indices(handle).iter().map(|&i| (figure.segments[i].id, drawn(slot, i) - rotation)).collect();
                let chain = skeleton.chain(handle, controller.chain_length);
                if chain.is_empty() {
                    return Err(unported("without a chain"));
                }
                let mut bend_direction = 1.0;
                if chain.len() >= 2 {
                    let (a, c) = (geometry.starts[chain[0]], geometry.ends[chain[chain.len() - 1]]);
                    let mut cross = 0.0f64;
                    for &i in &chain[..chain.len() - 1] {
                        let b = geometry.ends[i];
                        let value = (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
                        if value.abs() > cross.abs() {
                            cross = value;
                        }
                    }
                    if cross.abs() > 1e-8 {
                        bend_direction = if cross < 0.0 { -1.0 } else { 1.0 };
                    }
                }
                // `controller.bendDirection ?? bendDirection`
                let bend_direction = if current.get("bendDirection").is_some_and(|v| !v.is_null()) { controller.bend_direction } else { bend_direction };
                let points: Vec<[f64; 2]> = std::iter::once(geometry.starts[chain[0]]).chain(chain.iter().map(|&i| geometry.ends[i])).collect();
                let lengths: Vec<f64> = chain.iter().map(|&i| hypot(geometry.ends[i][0] - geometry.starts[i][0], geometry.ends[i][1] - geometry.starts[i][1])).collect();
                let captured = ik::bend_reference(&points, &lengths, controller.bend_reference.as_ref());
                let temporary = Controller {
                    pinned: true,
                    target: ik::Target { x: point[0], y: point[1], rotation },
                    followers: followers.clone(),
                    bend_direction,
                    bend_reference: Some(captured.clone()),
                    ..controller
                };
                let baseline = baseline_of(slot).unwrap_or_else(|| object.clone());
                let length_flag = baseline.get("len_flag").filter(|v| !v.is_null()).cloned().ok_or_else(|| unported("of a pose without a length flag"))?;
                let rest = if length_flag.truthy() { Some(baseline.get("lengths").and_then(Value::numbers).ok_or_else(|| unported("of a pose with unreadable lengths"))?) } else { None };
                let angles = object.get("angles").and_then(Value::numbers).filter(|a| a.len() >= figure.segments.len()).ok_or_else(|| unported("of a pose without every angle"))?;
                let bends = if truthy(&object, "bend_flag") { object.get("bends").and_then(Value::numbers) } else { None };
                let pose = ik::Pose {
                    scale: num(&object, "scale").unwrap_or(f64::NAN),
                    angles: &angles,
                    lengths: rest.as_deref(),
                    bends: bends.as_deref(),
                    mirror: truthy(&object, "image_text_flags"),
                    figure_angle: ik::figure_angle(figure, evaluated),
                    shape: evaluated.spatial.as_ref().and_then(|s| s.shape.as_ref()),
                };
                let table = Table { controllers: BTreeMap::from([(handle, temporary)]) };
                let solution = ik::solve_object_with(&skeleton, &pose, geometry.root, &table, true).ok_or_else(|| unported("the solver did not reach"))?;
                let bend = solution.results.iter().find(|(h, _)| *h == handle).and_then(|(_, o)| o.bend_reference.clone()).unwrap_or(captured);
                let lengths = match &solution.lengths {
                    Some(lengths) => Value::nums(lengths),
                    None => baseline.get("lengths").filter(|v| v.is_array()).cloned().ok_or_else(|| unported("of a pose without lengths"))?,
                };
                let record = object_mut(&mut posed.working, slot).ok_or_else(|| unported("outside its frame"))?;
                record.set("angles", Value::nums(&solution.angles));
                record.set("len_flag", if solution.lengths.is_some() { Value::Num(1.0) } else { length_flag });
                record.set("lengths", lengths);
                next.set("followers", angle_table(&followers));
                next.set("bendReference", reference_value(&bend));
            }
        }
        let record = object_mut(&mut posed.working, slot).ok_or_else(|| unported("outside its frame"))?;
        set_controller(record, &key, next);
        Ok(true)
    }

    /// `rememberBends`: each pinned automatic ("Both") controller of the component keeps the
    /// bend its limb is now solved with (one geometry for all of them, as there).
    fn remember_motion_path_bends(&self, posed: &mut Posed) -> Result<(), EditError> {
        let mut solved = None;
        for before in posed.baseline.clone() {
            let objects = objects_of(&posed.working);
            let Some(slot) = objects.iter().position(|o| uid(o).is_some() && uid(o) == uid(&before)) else { continue };
            let object = objects[slot].clone();
            for (key, c) in controllers(&object) {
                if !(truthy(&c, "enabled") && truthy(&c, "pinned") && c.get("bendDirection").and_then(Value::as_f64) == Some(0.0)) {
                    continue;
                }
                if solved.is_none() {
                    let (prepared, frame, scene) = self.posed_scene(&posed.working)?;
                    solved = Some(solve_frame(&prepared, &frame, &scene));
                }
                let Ok(handle) = key.parse::<u32>() else { continue };
                let outcome = uid(&object).and_then(|u| solved.as_ref().unwrap().get(&u)).and_then(|s| s.solution.results.iter().find(|(h, _)| *h == handle));
                let Some(reference) = outcome.and_then(|(_, o)| o.bend_reference.as_ref()) else { continue };
                let value = match before.path(&["_stykIK", &key, "bendReference"]).filter(|b| b.truthy()) {
                    Some(baseline) if same_bend(reference, baseline) => baseline.clone(),
                    _ => reference_value(reference),
                };
                let mut next = c.as_obj().cloned().unwrap_or_default();
                next.set("bendReference", value);
                if let Some(record) = object_mut(&mut posed.working, slot) {
                    set_controller(record, &key, next);
                }
            }
        }
        Ok(())
    }

    /// `commitMotionPathEdit()`: the poses written go to the layer sheet as one edit.
    pub(crate) fn commit_motion_path_edit(&mut self) -> Result<bool, EditError> {
        if !self.motion_path_open() {
            return Ok(false);
        }
        let mut session = self.take_motion_path();
        let nothing = |editor: &mut Editor| {
            editor.drag = None;
            editor.emit("edit", vec![("motionPath", Value::Bool(true))]);
            Ok(false)
        };
        if session.falloff.is_none() {
            if !session.moved || !has_changes(&session.posed[0], session.target.camera) {
                return nothing(self);
            }
            if session.mode != Mode::Sheet {
                self.remember_motion_path_bends(&mut session.posed[0])?;
                return self.commit_native_motion(session);
            }
            // The bends a single frame remembers are not captured again: its key holds the pose
            // of the last pointer move.
            self.drag = None;
            if session.posed[0].writes.is_empty() {
                self.emit("edit", vec![("motionPath", Value::Bool(true))]);
                return Ok(false);
            }
            return self.publish(session.plan.expect("sheet session"), &session.label, session.before_selection, None);
        }
        let changed = session.posed.iter().any(|p| p.moved && if p.camera_changed { has_changes(p, session.target.camera) } else { !p.changed.is_empty() });
        if !session.moved || !changed {
            return nothing(self);
        }
        for index in 0..session.posed.len() {
            if session.posed[index].moved {
                let remembered = self.remember_motion_path_bends(&mut session.posed[index]);
                if let Err(error) = remembered {
                    self.put_motion_path(session);
                    return Err(error);
                }
                let posed = &session.posed[index];
                session.posed[index].changed = changed_uids(posed, Some(&session.component));
            }
        }
        if !matches!(session.mode, Mode::Sheet | Mode::Channels) { return self.commit_native_motion(session); }
        // Captured again after the bends settle, so that the stored sources include them.
        for index in 0..session.posed.len() {
            if session.posed[index].moved
                && let Err(error) = self.write_falloff(&mut session, index)
            {
                self.put_motion_path(session);
                return Err(error);
            }
        }
        if session.mode == Mode::Channels { return self.commit_native_motion(session); }
        self.drag = None;
        if !session.posed.iter().any(|p| !p.writes.is_empty()) {
            self.emit("edit", vec![("motionPath", Value::Bool(true))]);
            return Ok(false);
        }
        self.publish(session.plan.expect("sheet session"), &session.label, session.before_selection, None)
    }

    /// `cancelMotionPathEdit()`: nothing was written to the document.
    pub(crate) fn cancel_motion_path_edit(&mut self) -> Result<bool, EditError> {
        if !self.motion_path_open() {
            return Ok(false);
        }
        self.drag = None;
        self.emit("edit", vec![("label", Value::str("Cancel pose")), ("motionPath", Value::Bool(true))]);
        Ok(true)
    }

    /// `setMotionPathFalloff(falloff)`: the open gesture switched between one frame and a
    /// falloff, or its influence changed, the last pointer move replayed.
    fn set_motion_path_falloff(&mut self, falloff: Option<&Value>) -> Result<bool, EditError> {
        if !self.motion_path_open() {
            return Ok(false);
        }
        let next = normalize_falloff(falloff)?;
        let session = self.take_motion_path();
        if next == session.falloff {
            self.put_motion_path(session);
            return Ok(true);
        }
        let (target, tick, label) = session.request.clone();
        let last = session.last.clone();
        let drag = self.drag.take();
        let mut options = Obj::new();
        if let Some(label) = &label {
            options.set("label", Value::str(label));
        }
        options.set("falloff", next.as_ref().map_or(Value::Null, |f| {
            let mut value = Obj::new();
            value.set("radius", Value::Num(f.radius));
            value.set("shape", Value::str(f.shape));
            Value::object(value)
        }));
        if !self.begin_motion_path_edit(&target, &Value::Num(tick), &Value::object(options))? {
            let mut drag = drag.expect("the open motion-path edit");
            drag.motion_path = Some(Box::new(session));
            self.drag = Some(drag);
            return Ok(false);
        }
        match last {
            Some((point, options)) => {
                self.update_motion_path_edit(&point, &options)?;
            }
            None => self.emit("edit", vec![("live", Value::Bool(true)), ("motionPath", Value::Bool(true)), ("changedUids", Value::array(Vec::new()))]),
        }
        Ok(true)
    }

    /// `motionPathFalloff()`: the open gesture's falloff plan for the overlay, or null.
    fn motion_path_falloff(&self) -> Value {
        let Some(session) = self.drag.as_ref().and_then(|d| d.motion_path.as_ref()) else { return Value::Null };
        let Some(falloff) = &session.falloff else { return Value::Null };
        let mut value = Obj::new();
        value.set("tick", Value::Num(session.tick));
        value.set("radius", Value::Num(falloff.radius));
        value.set("shape", Value::str(falloff.shape));
        let writes = session
            .planned
            .iter()
            .map(|w| {
                let mut write = Obj::new();
                write.set("tick", Value::Num(w.tick));
                write.set("weight", Value::Num(w.weight));
                write.set("kind", Value::str(w.kind.name()));
                Value::object(write)
            })
            .collect();
        value.set("writes", Value::array(writes));
        let mut changed: Vec<f64> = Vec::new();
        for posed in &session.posed {
            if (posed.moved || (posed.kind == Kind::Edge && session.moved)) && !changed.contains(&posed.tick) {
                changed.push(posed.tick);
            }
        }
        value.set("changed", Value::array(changed.into_iter().map(Value::Num).collect()));
        Value::object(value)
    }
}

impl Posed {
    fn new(tick: f64, weight: f64, kind: Kind, source: Value, working: Value, baseline: Vec<Value>, origin: [f64; 2]) -> Posed {
        Posed {
            tick,
            weight,
            kind,
            index: 0,
            row: Row { start: 0.0, count: 0.0 },
            source,
            working,
            baseline,
            origin,
            rotation_targets: HashMap::new(),
            translation_origin: None,
            moved: false,
            camera_changed: false,
            changed: Vec::new(),
            written: false,
            writes: Vec::new(),
            source_ids: Vec::new(),
            claims: Vec::new(),
        }
    }

}

/// `changedUids(session)` (every figure of the frame), or `falloffChanged(sub, component)`
/// (the component and figures with pinned limbs only): figures whose pose differs from the
/// frame they were evaluated in.
fn changed_uids(posed: &Posed, component: Option<&[u32]>) -> Vec<u32> {
    let (before, after) = (objects_of(&posed.source), objects_of(&posed.working));
    let mut changed = Vec::new();
    for object in &after {
        let Some(id) = uid(object) else { continue };
        if component.is_some_and(|c| !c.contains(&id) && !has_pinned(object)) {
            continue;
        }
        let previous = before.iter().find(|o| uid(o) == Some(id));
        if previous.is_none_or(|p| signature(p, &before) != signature(object, &after)) {
            changed.push(id);
        }
    }
    changed
}

/// `sessionHasChanges(session)`: a camera trail compares the camera, a figure's every figure.
fn has_changes(posed: &Posed, camera: bool) -> bool {
    if camera {
        let source = crate::camera_commands::camera_values(posed.source.get("camera"));
        return Some(json(&source)) != posed.working.get("camera").map(json);
    }
    !changed_uids(posed, None).is_empty()
}

/// `{...current, followers: {...current.followers}, joinedFollowers: {...current.joinedFollowers}}`.
fn follower_copy(current: &Value) -> Obj {
    let mut next = current.as_obj().cloned().unwrap_or_default();
    for key in ["followers", "joinedFollowers"] {
        next.set(key, Value::object(current.get(key).and_then(Value::as_obj).cloned().unwrap_or_default()));
    }
    next
}

fn uid_array(ids: &[u32]) -> Value {
    Value::array(ids.iter().map(|&u| Value::Num(f64::from(u))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every weight a falloff can give, for every shape, radius and distance, is V8's: the
    /// digest of their bits that engine/tools/edit-scenarios-motion-path.mjs records from the
    /// editor's `falloffWeight`.
    #[test]
    fn falloff_weights() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/motion-path-falloff.weights.json");
        let recorded = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
        let mut digest: u64 = 0xcbf29ce484222325;
        let mut count = 0;
        for shape in SHAPES {
            for radius in 1..=240 {
                for distance in 0..=radius + 1 {
                    for byte in falloff_weight(f64::from(distance), f64::from(radius), shape).to_bits().to_le_bytes() {
                        digest = (digest ^ u64::from(byte)).wrapping_mul(0x100000001b3);
                    }
                    count += 1;
                }
            }
        }
        assert_eq!(recorded.get("count").and_then(Value::as_f64), Some(f64::from(count)));
        assert_eq!(recorded.get("digest").and_then(Value::as_str), Some(format!("{digest:016x}").as_str()));
    }
}

fn copy_frame_identity(working: &mut Value, stored: &Value) {
    let mut styk = working.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    if let Some(id) = stored.path(&["_styk", "frameId"]) { styk.set("frameId", id.clone()); }
    working.make_obj().unwrap().set("_styk", Value::object(styk));
}

fn stored_candidate(stored: &Value, working: &Value, ids: &[u32], camera: bool) -> Value {
    let edited = objects_of(working);
    let objects = objects_of(stored).iter().map(|object| {
        let Some(id) = uid(object).filter(|id| ids.contains(id)) else { return object.clone() };
        let Some(edited) = edited.iter().find(|object| uid(object) == Some(id)) else { return object.clone() };
        let mut record = edited.as_obj().cloned().unwrap();
        if let Some(slot) = object.get("object_slot") { record.set("object_slot", slot.clone()); }
        Value::object(record)
    }).collect();
    let mut candidate = stored.as_obj().cloned().unwrap();
    if camera { candidate.set("camera", working.get("camera").cloned().unwrap_or(Value::Null)); }
    candidate.set("objects", Value::array(objects)); Value::object(candidate)
}

#[cfg(test)]
#[path = "native_saved_motion_tests.rs"]
mod native_saved_motion_tests;
