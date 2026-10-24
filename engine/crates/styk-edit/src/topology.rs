//! Topology edits of a figure definition (`_topologyEdit` in src/editor.mjs and the builder's
//! segment commands in src/editor-builder*.mjs, src/editor-rig-constraints.mjs): segments
//! added, drawn as a chain, deleted one at a time or with their branch, unsplit, flipped,
//! moved in the hierarchy, split and duplicated; rig joints appended (connectors, weighted
//! joints). Every pose of the figure, in the keyframes and the pose sources, follows the new
//! definition; figures joined to a removed handle stay where they were drawn, and figures
//! joined below a reshaped one are placed again where geometry puts them. Inverse-kinematics
//! controllers, style overlays, Stick Nodes shapes and effect owners follow the handles they
//! name (`repairIKTopology`, `repairTopologyStyles`). One `topology` history entry records the
//! definition and the poses it touched, before and after.
//!
//! Recorded animation-origin edits retain their original pivot and hidden support.
//! Frame drafts, movieclip sources, IK across joined figures, channels a
//! changed handle animates, pose choices and 3D meshes answer `Unported`.

use std::collections::{HashMap, HashSet};

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::record::{join_target, num, uid};
use crate::{EditError, Editor};
mod sprite;
mod new_figure;

struct StrokeSpec {
    parent: Option<Value>,
    length: f64,
    angle: f64,
    thickness: Option<f64>,
    code: f64,
}

const EPS: f64 = 1e-9;
const MAX_SEGMENTS: usize = 30000;
const MAX_IK_CHAIN: f64 = 256.0;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn truthy(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(Value::truthy)
}

/// A number field, `undefined` and `null` as absent.
fn given(value: &Value, key: &str) -> Option<f64> {
    value.get(key).filter(|v| !v.is_null()).map(|v| v.as_f64().unwrap_or(f64::NAN))
}

/// A handle id as the editor's maps key it (`Number(id)`).
fn handle(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

/// Where poses live: a keyframe or a pose source.
#[derive(Clone, Debug, PartialEq)]
pub enum Place {
    Keyframe(usize),
    Source(String),
}

/// The poses of one frame a topology entry keeps.
#[derive(Clone, Debug)]
pub struct FramePoses {
    pub place: Place,
    pub objects: Vec<Value>,
}

/// `_topologySnapshot`: the definition and the poses of the figure's instances (with the
/// figures joined below them and their IK assemblies) in every frame that shows it.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub figure: Value,
    pub frames: Vec<FramePoses>,
    /// Saved sheet animations in this document and retained source documents.
    pub sheet_animations: Vec<(usize, Option<Value>)>,
    /// Saved animations in retained movieclip source documents, in depth order.
    pub movieclip_source_animations: Vec<Option<Value>>,
}

/// `_allSourceFrames()` as places: the keyframes, then the pose sources.
pub(crate) fn places(report: &Value) -> Vec<Place> {
    let mut out: Vec<Place> = (0..report.get("keyframes").and_then(Value::array_len).unwrap_or(0)).map(Place::Keyframe).collect();
    if let Some(sources) = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj) {
        out.extend(sources.keys().map(|id| Place::Source(id.to_string())));
    }
    out
}

pub(crate) fn frame_at<'a>(report: &'a Value, place: &Place) -> Option<&'a Value> {
    match place {
        Place::Keyframe(index) => report.get("keyframes").and_then(Value::as_arr).and_then(|frames| frames.get(*index)),
        Place::Source(id) => report.path(&["_styk", "frameSources"]).and_then(|s| s.get(id)),
    }
}

pub(crate) fn frame_mut<'a>(report: &'a mut Value, place: &Place) -> Option<&'a mut Obj> {
    let root = report.make_obj()?;
    match place {
        Place::Keyframe(index) => root.get_mut("keyframes")?.make_arr()?.get_mut(*index)?.make_obj(),
        Place::Source(id) => root.get_mut("_styk")?.make_obj()?.get_mut("frameSources")?.make_obj()?.get_mut(id)?.make_obj(),
    }
}

/// The objects of a frame at `place`, to change.
fn objects_mut<'a>(report: &'a mut Value, place: &Place) -> Option<&'a mut Vec<Value>> {
    frame_mut(report, place)?.get_mut("objects")?.make_arr()
}

/// `snapshotPoseObject(object, {retainRuntime: true})`: the record without its clip sample.
fn snapshot_object(object: &Value) -> Value {
    match object.as_obj() {
        Some(record) if record.contains("_movieclipSample") => {
            let mut record = record.clone();
            record.remove("_movieclipSample");
            Value::object(record)
        }
        _ => object.clone(),
    }
}

/// `{...object, key: value}` on a pose record in place.
fn set(object: &mut Value, key: &str, value: Value) {
    if let Some(record) = object.make_obj() {
        record.set(key, value);
    }
}

fn remove(object: &mut Value, key: &str) {
    if let Some(record) = object.make_obj() {
        record.remove(key);
    }
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    value.and_then(Value::elements).map(|e| e.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default()
}

/// What a topology edit tells its repairs (`segmentMap`): each old handle's replacements; a
/// handle not named keeps its id if it still exists.
#[derive(Default)]
pub(crate) struct TopologyOptions {
    pub segment_map: Vec<(f64, Vec<f64>)>,
    /// A replaced definition (`replaceFigureDefinition`) keeps its own count and order arrays.
    pub replaced: bool,
    pub reversed_gradients: HashSet<u64>,
    pub origin_reroot: Option<OriginReroot>,
    pub origin_splits: Vec<(f64, f64)>,
    pub origin_freeze: HashSet<u64>,
    /// Read-only worker sizing of the editor's sparse command representation.
    pub history_append_only: bool,
    pub history_segment_indices: Option<Vec<usize>>,
}

#[derive(Clone)]
pub(crate) struct OriginEdge {
    pub old_id: f64,
    pub parent: f64,
    pub id: f64,
    pub reverse: bool,
}

pub(crate) struct OriginReroot {
    pub handle: f64,
    pub edges: Vec<OriginEdge>,
}

/// `ikLayout(figure)`: handle ids to indices (the last of repeated ids), children by parent id
/// in record order.
struct Layout {
    ids: HashMap<u64, usize>,
    children: HashMap<u64, Vec<usize>>,
}

fn key_of(id: f64) -> u64 {
    if id == 0.0 { 0 } else { id.to_bits() }
}

fn layout(segments: &[Value]) -> Layout {
    let mut ids = HashMap::new();
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, s) in segments.iter().enumerate() {
        if let Some(id) = handle(s.get("segment_id")) {
            ids.insert(key_of(id), i);
        }
    }
    for (i, s) in segments.iter().enumerate() {
        if let Some(parent) = handle(s.get("parent_id")) {
            children.entry(key_of(parent)).or_default().push(i);
        }
    }
    Layout { ids, children }
}

/// `derivedRigJoint(segment)`: a joint its rig positions.
fn derived_rig_joint(segment: &Value) -> bool {
    let rig = |key: &str| segment.path(&["_stykRig", key]).is_some_and(Value::truthy);
    segment.path(&["_stykRig", "spatial", "bindings"]).is_some_and(Value::truthy) || rig("connector") || rig("angleLock") || rig("anglePath") || rig("weighted")
}

/// `ikChain(figure, handle, length, layout)`.
fn ik_chain(segments: &[Value], layout: &Layout, id: f64, length: f64) -> Vec<usize> {
    let limit = if length.is_nan() { f64::NAN } else { length.min(MAX_IK_CHAIN) };
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut at = layout.ids.get(&key_of(id)).copied();
    while let Some(i) = at {
        // `chain.length < Math.min(length, 256)`, false for NaN.
        if (chain.len() as f64).partial_cmp(&limit) != Some(std::cmp::Ordering::Less) || seen.contains(&i) {
            break;
        }
        if derived_rig_joint(&segments[i]) {
            break;
        }
        seen.insert(i);
        chain.push(i);
        at = handle(segments[i].get("parent_id")).and_then(|p| layout.ids.get(&key_of(p)).copied());
    }
    chain.reverse();
    chain
}

/// `ikConstruction(segment)`.
fn ik_construction(s: &Value) -> bool {
    if let Some(aux) = s.get("aux_code") {
        return to_int32(aux.as_f64().unwrap_or(0.0)) & 1 != 0;
    }
    if let Some(raw) = s.get("static_raw") {
        return raw.truthy();
    }
    match s.path(&["flag_bits", "is_static"]).filter(|v| !v.is_null()).or_else(|| s.get("is_static").filter(|v| !v.is_null())) {
        Some(value) => value.truthy(),
        None => {
            let flags = s.get("flags").filter(|v| v.truthy()).and_then(Value::as_f64).unwrap_or(0.0);
            to_int32(flags) & 256 != 0
        }
    }
}

fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    (x.trunc().rem_euclid(4_294_967_296.0) as u32) as i32
}

/// `ikFollowerIndices(figure, handle, layout)`.
fn ik_follower_indices(segments: &[Value], polygons: &[Value], layout: &Layout, id: f64) -> Vec<usize> {
    let direct: Vec<usize> = layout.children.get(&key_of(id)).cloned().unwrap_or_default();
    let spatial_bone = |s: &Value| s.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy);
    if let Some(&endpoint) = layout.ids.get(&key_of(id))
        && spatial_bone(&segments[endpoint])
        && direct.iter().all(|&i| segments[i].path(&["_stykRig", "spatial"]).is_some_and(Value::truthy))
    {
        return direct.into_iter().filter(|&i| spatial_bone(&segments[i]) && !ik_construction(&segments[i])).collect();
    }
    let mut candidates = Vec::new();
    let mut owners: HashMap<u64, usize> = HashMap::new();
    let mut queue: Vec<(usize, Option<usize>)> = direct.iter().map(|&i| (i, None)).collect();
    let mut q = 0;
    while q < queue.len() {
        let (i, owner) = queue[q];
        let s = &segments[i];
        let anchor = owner.is_none() && ik_construction(s) && given(s, "length").unwrap_or(f64::NAN).abs() <= 0.001;
        let branch = if anchor { None } else { Some(owner.unwrap_or(i)) };
        if let Some(branch) = branch {
            if let Some(sid) = handle(s.get("segment_id")) {
                owners.insert(key_of(sid), branch);
            }
            if owner.is_none() {
                candidates.push(i);
            }
        }
        if let Some(sid) = handle(s.get("segment_id")) {
            for &child in layout.children.get(&key_of(sid)).map(Vec::as_slice).unwrap_or(&[]) {
                queue.push((child, branch));
            }
        }
        q += 1;
    }
    let mut groups: HashMap<usize, usize> = candidates.iter().map(|&i| (i, i)).collect();
    let find = |groups: &HashMap<usize, usize>, i: usize| {
        let mut root = i;
        while groups[&root] != root {
            root = groups[&root];
        }
        root
    };
    for polygon in polygons {
        let branches: Vec<usize> = numbers(polygon.get("segment_ids")).into_iter().filter_map(|id| owners.get(&key_of(id)).copied()).collect();
        if branches.len() > 1 {
            for &i in &branches[1..] {
                let (from, to) = (find(&groups, i), find(&groups, branches[0]));
                groups.insert(from, to);
            }
        }
    }
    let articulated: HashSet<usize> = candidates.iter().filter(|&&i| !ik_construction(&segments[i])).map(|&i| find(&groups, i)).collect();
    candidates.into_iter().filter(|&i| articulated.contains(&find(&groups, i))).collect()
}

/// `Number(text)` for the keys the editor writes.
fn js_number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(number)`.
fn format_number(n: f64) -> String {
    styk_doc::json::to_string(&Value::Num(n))
}

/// The existing topology owner's raw definition checks, shared by sparse
/// commands that must validate a currently mirrored definition before a live commit.
pub(crate) fn validate_definition(figure: &Value) -> Result<Vec<Value>, EditError> {
    let segments = items(figure.get("segments"));
    if segments.len() > MAX_SEGMENTS {
        return Err(invalid("errors.editorBuilderBranch.aNativePivotFigureSupportsAtMost30"));
    }
    let mut parents: Vec<(f64, f64)> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    for s in &segments {
        if let Some(paint) = s.get("paint").filter(|p| p.truthy()) {
            crate::recolor::normalize_paint(paint)?;
        }
        let id = s.get("segment_id").and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 65535.0);
        let Some(id) = id.filter(|id| !seen.contains(&key_of(*id))) else { return Err(invalid("errors.model.invalidOrRepeatedSegmentHandle")) };
        seen.insert(key_of(id));
        parents.push((id, given(s, "parent_id").unwrap_or(f64::NAN)));
        definition_float32(s.get("length"))?;
        definition_finite(s.get("angle_rad"))?;
        definition_float32(s.get("thickness"))?;
    }
    let parent_of: HashMap<u64, f64> = parents.iter().map(|(id, p)| (key_of(*id), *p)).collect();
    let mut done: HashSet<u64> = HashSet::from([0]);
    for (id, _) in &parents {
        if done.contains(&key_of(*id)) {
            continue;
        }
        let mut chain = Vec::new();
        let mut p = *id;
        while !done.contains(&key_of(p)) {
            if !parent_of.contains_key(&key_of(p)) || chain.contains(&key_of(p)) {
                return Err(invalid("errors.model.figureHasAMissingParentOrACycle"));
            }
            chain.push(key_of(p));
            p = parent_of[&key_of(p)];
        }
        done.extend(chain);
    }
    if segments.iter().any(|s| s.get("_stykRig").is_some_and(Value::truthy)) {
        crate::rig_behavior::validate_rig(&segments)?;
    }
    let ids: HashSet<u64> = segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).chain([0]).collect();
    for polygon in items(figure.get("polyfills")) {
        if let Some(surface) = polygon.get("_stykSurface") {
            let basis = numbers(surface.get("basis"));
            let distinct = basis.iter().enumerate().all(|(i, a)| !basis[..i].contains(a));
            if !surface.truthy() || !surface.get("basis").is_some_and(Value::is_array) || basis.len() != 3 || !distinct || basis.iter().any(|b| b.fract() != 0.0 || !ids.contains(&key_of(*b))) {
                return Err(invalid("errors.surfaces.faceVisibilityNeedsThreeDistinctExistingReferenceJoints"));
            }
            if let Some(depth) = surface.get("depth") {
                let depth = numbers(Some(depth));
                if depth.is_empty() || depth.len() > 1024 || depth.iter().any(|d| d.fract() != 0.0 || !ids.contains(&key_of(*d))) {
                    return Err(invalid("errors.surfaces.faceDepthNeedsExistingReferenceJointsUpTo"));
                }
            }
        }
        if let Some(order) = polygon.get("z_order") {
            definition_float32(Some(order))?;
        }
    }
    Ok(segments)
}

fn definition_finite(value: Option<&Value>) -> Result<f64, EditError> {
    match value {
        Some(Value::Num(n)) if n.is_finite() => Ok(*n),
        _ => Err(invalid("errors.model.mustBeAFiniteNumber")),
    }
}
fn definition_float32(value: Option<&Value>) -> Result<(), EditError> {
    let n = definition_finite(value)?;
    if !((n as f32) as f64).is_finite() {
        return Err(invalid("errors.model.exceedsTheNativeFloat32Range"));
    }
    Ok(())
}

impl Editor {
    /// The selected figure's definition and its index (`editor.figure`).
    pub(crate) fn topology_figure(&self) -> Result<Option<(usize, Value)>, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(None) };
        let figures = items(self.report.get("figure_types"));
        Ok(figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")).map(|i| (i, figures[i].clone())))
    }

    /// The identities whose poses a topology entry keeps, frame by frame (`_topologySnapshot`).
    fn topology_identities(&self, type_id: &Value) -> Result<Vec<(Place, HashSet<u32>)>, EditError> {
        let mut out = Vec::new();
        for place in places(&self.report) {
            let objects = items(frame_at(&self.report, &place).and_then(|f| f.get("objects")));
            let instances: Vec<u32> = objects.iter().filter(|o| o.get("figure_type_id") == Some(type_id)).filter_map(uid).collect();
            if instances.is_empty() {
                continue;
            }
            let slots = crate::select::resolve_join_selection(&objects, &instances, false)?;
            let slots = Editor::ik_pose_slots(&objects, slots);
            out.push((place, slots.into_iter().filter_map(|s| objects.get(s).and_then(uid)).collect()));
        }
        Ok(out)
    }

    fn topology_snapshot(&self, index: usize, identities: &[(Place, HashSet<u32>)]) -> Snapshot {
        let figure = self.report.get("figure_types").and_then(|f| f.item(index)).unwrap_or(Value::Null);
        let frames = identities
            .iter()
            .map(|(place, ids)| {
                let objects = items(frame_at(&self.report, place).and_then(|f| f.get("objects")));
                FramePoses { place: place.clone(), objects: objects.iter().filter(|o| uid(o).is_some_and(|u| ids.contains(&u))).map(snapshot_object).collect() }
            })
            .collect();
        let mut sheet_animations=Vec::new();let mut movieclip_source_animations=Vec::new();let mut document=Some(&self.report);let mut depth=0;
        while let Some(report)=document {
            if let Some(sheet)=report.path(&["_styk","layerSheet"]).filter(|value|value.truthy()) { sheet_animations.push((depth,sheet.get("legacyAnimation").filter(|value|!value.is_null()).cloned())); }
            if depth>0 { movieclip_source_animations.push(report.path(&["_styk","animation"]).filter(|value|!value.is_null()).cloned()); }
            document=report.path(&["_styk","movieclipSource","document"]);depth+=1;
        }
        Snapshot { figure, frames, sheet_animations, movieclip_source_animations }
    }

    /// `_topologyEdit(label, mutate, options)`: the selected figure's definition and every pose
    /// of it changed by `mutate`, repaired and validated, as one `topology` history entry.
    /// `false` without a figure.
    pub(crate) fn topology_edit(&mut self, label: &str, options: TopologyOptions, mutate: impl FnOnce(&mut Editor, usize) -> Result<(), EditError>) -> Result<bool, EditError> {
        self.topology_edit_of(None, label, options, mutate)
    }

    /// [`Editor::topology_edit`] of definition `definition` (`_topologyEdit(…, {definition})`), else
    /// of the selected figure's.
    pub(crate) fn topology_edit_of(&mut self, definition: Option<usize>, label: &str, options: TopologyOptions, mutate: impl FnOnce(&mut Editor, usize) -> Result<(), EditError>) -> Result<bool, EditError> {
        let chosen = match definition {
            Some(index) => self.report.get("figure_types").and_then(|f| f.item(index)).map(|figure| (index, figure)),
            None => self.topology_figure()?,
        };
        let Some((index, figure)) = chosen else { return Ok(false) };
        if figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy) {
            return Err(invalid("errors.editor.openTheMovieclipToEditItsFigures"));
        }
        if self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(EditError::Unported("topology edits with a frame draft".into()));
        }
        if figure.path(&["_styk", "poseChoices"]).is_some() || figure.path(&["_styk", "spatialMesh"]).is_some() || items(figure.get("segments")).iter().any(|s| s.get("_stykPoseChoice").is_some()) {
            return Err(EditError::Unported("topology edits of a figure with pose choices or a 3D mesh".into()));
        }
        // Raw support remapping relies on the typed origin owner's validated indices.
        // Refuse before committing a live gesture, keeping report/history atomic.
        if figure.path(&["_styk", "animationOrigin"]).is_some() { self.origin_figure(&figure)?; }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let identities = self.topology_identities(&type_id)?;
        let before = self.topology_snapshot(index, &identities);
        let before_selection = self.selection_state();
        let report_before = self.report.clone();
        let outcome = (|| {
            mutate(self, index)?;
            self.repair_origin_support(index, &before, &options)?;
            self.repair_topology(index, &before, &options)?;
            let figure = self.figure_at(index);
            if options.origin_reroot.is_none() && crate::origin_topology::geometry_changed(&before.figure, &figure) {
                for entry in &before.frames { self.preserve_topology_origins(entry)?; }
            }
            self.validate_topology(index, &before)
        })();
        if let Err(error) = outcome {
            self.report = report_before;
            self.restore_selection(&before_selection)?;
            return Err(error);
        }
        // `_invalidate()`: the committed draft kept on show is evaluated again.
        self.retained = None;
        if let Some(figure) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(index)).and_then(Value::make_obj).filter(|_| !options.replaced) {
            let count = figure.get("segments").and_then(Value::array_len).unwrap_or(0);
            figure.set("segment_count", Value::Num(count as f64));
            figure.remove("segment_z_raw");
            figure.remove("poly_z_raw");
        }
        let after = self.topology_snapshot(index, &identities);
        self.record_topology(Command { kind: CommandKind::Topology { index, before, after }, label: label.into(), before_selection, after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false }, crate::history_weight::TopologyShape { append_only: options.history_append_only, segment_indices: options.history_segment_indices.map(std::sync::Arc::new) })?;
        self.emit("edit", vec![("label", Value::str(label)), ("structural", Value::Bool(true)), ("definition", Value::Bool(true))]);
        Ok(true)
    }

    /// Undo or redo of a `topology` entry: the definition, and the poses it kept by identity.
    pub(crate) fn apply_topology(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Topology { index, before, after } = &command.kind else { return Ok(()) };
        let (snapshot, selection, revision) = match direction {
            Direction::Before => (before, &command.before_selection, command.before_revision),
            Direction::After => (after, &command.after_selection, command.after_revision),
        };
        if let Some(slot) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(*index)) {
            *slot = snapshot.figure.clone();
        }
        for entry in &snapshot.frames {
            if let Some(objects) = objects_mut(&mut self.report, &entry.place) {
                for object in objects.iter_mut() {
                    if let Some(replacement) = uid(object).and_then(|id| entry.objects.iter().find(|o| uid(o) == Some(id))) {
                        *object = replacement.clone();
                    }
                }
            }
        }
        for (depth,animation) in &snapshot.sheet_animations {
            let mut document=Some(&mut self.report);
            for _ in 0..*depth {document=document.and_then(|report|report.make_obj()?.get_mut("_styk")?.make_obj()?.get_mut("movieclipSource")?.make_obj()?.get_mut("document"));}
            if let Some(sheet)=document.and_then(|report|report.make_obj()?.get_mut("_styk")?.make_obj()?.get_mut("layerSheet")?.make_obj()) {
                match animation {Some(animation)=>sheet.set("legacyAnimation",animation.clone()),None=>{sheet.remove("legacyAnimation");}}
            }
        }
        let mut document=Some(&mut self.report);
        for animation in &snapshot.movieclip_source_animations {
            document=document.and_then(|report|report.make_obj()?.get_mut("_styk")?.make_obj()?.get_mut("movieclipSource")?.make_obj()?.get_mut("document"));
            if let Some(styk)=document.as_mut().and_then(|report|report.make_obj()?.get_mut("_styk")?.make_obj()) {
                match animation {Some(animation)=>styk.set("animation",animation.clone()),None=>{styk.remove("animation");}}
            }
        }
        self.retained = None;
        self.restore_selection(selection)?;
        self.revision = revision;
        self.emit("history", vec![("label", Value::str(&command.label)), ("structural", Value::Bool(true)), ("definition", Value::Bool(true)), ("animation", Value::Bool(false))]);
        Ok(())
    }

    /// `repairOriginSupport`, `repairTopologyStyles` (with `repairIKTopology`) for the figures
    /// the engine edits: IK controllers, 3D shapes, style overlays, Stick Nodes shapes and effect
    /// owners follow the handles they name.
    fn repair_topology(&mut self, index: usize, before: &Snapshot, options: &TopologyOptions) -> Result<(), EditError> {
        let figure = self.report.get("figure_types").and_then(|f| f.item(index)).unwrap_or(Value::Null);
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let type_number = num(&figure, "figure_type_id").unwrap_or(f64::NAN);
        let explicit: HashMap<u64, &Vec<f64>> = options.segment_map.iter().map(|(old, next)| (key_of(*old), next)).collect();
        let segments = items(figure.get("segments"));
        let polygons = items(figure.get("polyfills"));
        let old_segments = items(before.figure.get("segments"));
        // `repairIKTopology`.
        let new_layout = layout(&segments);
        let old_layout = layout(&old_segments);
        let bones: HashSet<u64> = segments.iter().filter(|s| s.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy)).filter_map(|s| handle(s.get("segment_id"))).map(key_of).collect();
        for entry in &before.frames {
            let objects = items(frame_at(&self.report, &entry.place).and_then(|f| f.get("objects")));
            // IK across joined figures (`repairJoined`) is not ported.
            if objects.iter().any(|o| o.get("join").is_some_and(Value::truthy)) {
                let joins: Vec<Option<usize>> = objects.iter().map(join_target).collect();
                for group in styk_eval::ik::joined::components_of(&joins) {
                    if group.len() >= 2 && group.iter().any(|&s| objects[s].get("figure_type_id") == Some(&type_id)) && group.iter().any(|&s| objects[s].get("_stykIK").is_some_and(Value::truthy)) {
                        return Err(EditError::Unported("topology edits of figures joined with IK".into()));
                    }
                }
            }
            let Some(list) = objects_mut(&mut self.report, &entry.place) else { continue };
            for object in list.iter_mut() {
                if object.get("figure_type_id") != Some(&type_id) {
                    continue;
                }
                if let Some(shape) = object.path(&["_stykSpatial", "shape"]).filter(|s| s.truthy()).and_then(Value::as_obj).cloned() {
                    let mut next = Obj::new();
                    for (id, value) in shape.iter() {
                        let id = js_number(id);
                        let targets = explicit.get(&key_of(id)).copied().cloned().unwrap_or_else(|| vec![id]);
                        for target in targets {
                            if bones.contains(&key_of(target)) {
                                next.set(&format_number(target), value.clone());
                            }
                        }
                    }
                    let mut spatial = object.get("_stykSpatial").and_then(Value::as_obj).cloned().unwrap_or_default();
                    spatial.set("shape", Value::object(next));
                    set(object, "_stykSpatial", Value::object(spatial));
                }
                let Some(table) = object.get("_stykIK").filter(|t| t.truthy()).and_then(Value::as_obj).cloned() else { continue };
                let angles = numbers(object.get("angles"));
                let mut next = Obj::new();
                for (key, controller) in table.iter() {
                    let id = js_number(key);
                    let target = match explicit.get(&key_of(id)).copied() {
                        Some(replacements) if replacements.contains(&id) => Some(id),
                        Some(replacements) => replacements.last().copied(),
                        None => Some(id),
                    };
                    let Some(target) = target.filter(|t| new_layout.ids.contains_key(&key_of(*t))) else { continue };
                    let chain = ik_chain(&segments, &new_layout, target, MAX_IK_CHAIN);
                    let chain_length = controller.get("chainLength").map_or(f64::NAN, |v| v.as_f64().unwrap_or(f64::NAN));
                    let old_chain = ik_chain(&old_segments, &old_layout, id, chain_length);
                    let base = old_chain.first().and_then(|&i| old_segments[i].get("parent_id").cloned());
                    let start = chain.iter().position(|&i| base.as_ref().is_some_and(|b| crate::history::js_strict_eq(segments[i].get("parent_id").unwrap_or(&Value::Null), b)));
                    let rotation = controller.path(&["target", "rotation"]).map_or(f64::NAN, |v| v.as_f64().unwrap_or(f64::NAN));
                    let captured = controller.get("followers").and_then(Value::as_obj);
                    let mut followers = Obj::new();
                    for i in ik_follower_indices(&segments, &polygons, &new_layout, target) {
                        let child = segments[i].get("segment_id").cloned().unwrap_or(Value::Null);
                        let name = styk_doc::json::to_string(&child);
                        let angle = captured.and_then(|c| c.get(&name)).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::Num(angles.get(i).copied().unwrap_or(f64::NAN) - rotation));
                        followers.set(&name, angle);
                    }
                    let length = match start {
                        None => {
                            let n = chain.len() as f64;
                            if chain_length.is_nan() { f64::NAN } else { chain_length.min(n) }
                        }
                        Some(start) => (chain.len() - start) as f64,
                    };
                    let mut repaired = controller.as_obj().cloned().unwrap_or_default();
                    repaired.set("chainLength", Value::Num(length));
                    repaired.set("followers", Value::object(followers));
                    next.set(&format_number(target), Value::object(repaired));
                }
                if next.is_empty() {
                    remove(object, "_stykIK");
                } else {
                    set(object, "_stykIK", Value::object(next));
                }
            }
        }
        // `repairStyles`: handles that are gone or replaced.
        let handles: HashSet<u64> = segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).collect();
        let mut changes: Vec<(f64, Vec<f64>)> = Vec::new();
        for segment in &old_segments {
            let Some(old) = handle(segment.get("segment_id")) else { continue };
            let next = match explicit.get(&key_of(old)).copied() {
                Some(next) => next.clone(),
                None if handles.contains(&key_of(old)) => vec![old],
                None => Vec::new(),
            };
            let distinct = next.iter().enumerate().all(|(i, a)| !next[..i].contains(a));
            if !distinct || next.iter().any(|id| !handles.contains(&key_of(*id))) {
                return Err(invalid("errors.editorStyleTopology.invalidPhysicalSegmentStyleMapping"));
            }
            if next.len() != 1 || next[0] != old || options.reversed_gradients.contains(&key_of(old)) {
                changes.push((old, next));
            }
        }
        if changes.is_empty() {
            return Ok(());
        }
        let mut uids: HashSet<u32> = HashSet::new();
        for entry in &before.frames {
            uids.extend(entry.objects.iter().filter(|o| o.get("figure_type_id") == Some(&type_id)).filter_map(uid));
        }
        // Channels a changed handle animates (`_styk.animation` is refused for the whole document;
        // a layer sheet's saved channels stay with the editor here).
        let channels = items(self.report.path(&["_styk", "layerSheet", "legacyAnimation", "channels"]));
        let affected = channels.iter().any(|channel| {
            let target = channel.get("target").cloned().unwrap_or(Value::Null);
            target.get("kind").and_then(Value::as_str) == Some("segment")
                && uid(&target.get("uid").map(|u| { let mut o = Obj::new(); o.set("unique_id", u.clone()); Value::object(o) }).unwrap_or(Value::Null)).is_some_and(|u| uids.contains(&u))
                && handle(target.get("handleId")).is_some_and(|h| changes.iter().any(|(old, _)| *old == h))
                && target.get("figureTypeId").is_none_or(|t| t == &type_id)
        });
        if affected {
            return Err(EditError::Unported("topology edits of handles saved property channels animate".into()));
        }
        for entry in &before.frames {
            let Some(list) = objects_mut(&mut self.report, &entry.place) else { continue };
            for object in list.iter_mut() {
                if object.get("figure_type_id") != Some(&type_id) {
                    continue;
                }
                if object.get("_stykVfx").and_then(Value::as_obj).is_some() {
                    let source_type = num(object, "figure_type_id").unwrap_or(f64::NAN);
                    if let Some(owner) = object.make_obj() {
                        styk_eval::vfx::remap_owner(owner, type_number, Some(&changes), source_type);
                    }
                }
                if let Some(shapes) = object.get("_sticknodesShapes").filter(|s| s.truthy()).and_then(Value::as_obj).cloned() {
                    let mut next = Obj::new();
                    for (id, shape) in shapes.iter() {
                        let id = js_number(id);
                        let targets = changes.iter().find(|(old, _)| *old == id).map(|(_, n)| n.clone()).unwrap_or_else(|| vec![id]);
                        for target in targets {
                            let mut shape = shape.clone();
                            if options.reversed_gradients.contains(&key_of(id)) {
                                let reversed = !shape.get("reversed").is_some_and(Value::truthy);
                                set(&mut shape, "reversed", Value::Bool(reversed));
                            }
                            next.set(&format_number(target), shape);
                        }
                    }
                    if next.is_empty() {
                        remove(object, "_sticknodesShapes");
                    } else {
                        set(object, "_sticknodesShapes", Value::object(next));
                    }
                }
                let Some(table) = object.path(&["_stykStyle", "segments"]).filter(|t| t.truthy()).and_then(Value::as_obj).cloned() else { continue };
                if !table.keys().any(|h| changes.iter().any(|(old, _)| *old == js_number(h))) {
                    continue;
                }
                let mut next = Obj::new();
                for (h, style) in table.iter() {
                    match changes.iter().find(|(old, _)| *old == js_number(h)) {
                        Some((_, replacements)) => {
                            for target in replacements {
                                let old_handle = js_number(h);
                                let reversed = options.reversed_gradients.contains(&key_of(old_handle));
                                let endpoint_swap = old_segments.iter().find(|s| handle(s.get("segment_id")) == Some(old_handle))
                                    .is_some_and(|s| truthy(s, "secondary") && !matches!(s.path(&["paint", "type"]).and_then(Value::as_str), Some("radial" | "angular" | "diamond")));
                                next.set(&format_number(*target), if reversed { reverse_overrides(style, endpoint_swap) } else { style.clone() });
                            }
                        }
                        None => next.set(h, style.clone()),
                    }
                }
                let mut style = object.get("_stykStyle").and_then(Value::as_obj).cloned().unwrap_or_default();
                if next.is_empty() {
                    style.remove("segments");
                } else {
                    style.set("segments", Value::object(next));
                }
                if style.is_empty() {
                    remove(object, "_stykStyle");
                } else {
                    set(object, "_stykStyle", Value::object(style));
                }
            }
        }
        Ok(())
    }

    /// What `validateScene` checks that a topology edit can make invalid: the definition's
    /// handles, numbers, hierarchy, rig and polygons, and its poses and joins.
    fn validate_topology(&self, index: usize, before: &Snapshot) -> Result<(), EditError> {
        let figure = self.report.get("figure_types").and_then(|f| f.item(index)).unwrap_or(Value::Null);
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let segments = validate_definition(&figure)?;
        let ids: HashSet<u64> = segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).chain([0]).collect();
        let at = |id: f64| segments.iter().position(|s| handle(s.get("segment_id")) == Some(id));
        for entry in &before.frames {
            let objects = items(frame_at(&self.report, &entry.place).and_then(|f| f.get("objects")));
            for object in &objects {
                if object.get("figure_type_id") == Some(&type_id) {
                    for (flag, key) in [(true, "angles"), (truthy(object, "len_flag"), "lengths"), (truthy(object, "bend_flag"), "bends")] {
                        if !flag {
                            continue;
                        }
                        let values = object.get(key).filter(|v| v.is_array()).map(|v| items(Some(v)));
                        let Some(values) = values.filter(|v| v.len() == segments.len()) else { return Err(invalid("errors.model.poseArrayDoesNotMatchItsFigure")) };
                        for value in &values {
                            if key == "lengths" { definition_float32(Some(value))? } else { definition_finite(Some(value)).map(|_| ())? }
                        }
                    }
                    for (id, controller) in object.get("_stykIK").and_then(Value::as_obj).map(|o| o.iter().map(|(k, v)| (js_number(k), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
                        let allowed = at(id).is_some_and(|i| !derived_rig_joint(&segments[i]));
                        if truthy(&controller, "enabled") && !allowed {
                            return Err(invalid("errors.model.ikCannotDriveADerivedConnectorWeightedOr"));
                        }
                    }
                }
                if let Some(parent) = join_target(object).and_then(|slot| objects.get(slot))
                    && parent.get("figure_type_id") == Some(&type_id)
                {
                    let target = handle(object.get("join").and_then(|j| j.get("target_handle_id")));
                    if !target.is_some_and(|t| ids.contains(&key_of(t))) {
                        return Err(invalid("errors.model.joinPointsToAMissingFigureOrHandle"));
                    }
                }
            }
        }
        Ok(())
    }

    /// The topology commands by their JavaScript names; `None` for other calls.
    pub(crate) fn topology_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i);
        Some(match method {
            "setOrigin" => self.set_origin(arg(0)).map(Value::Bool),
            "addSegment" => self.add_segments(&Value::array(vec![arg(0).cloned().unwrap_or_else(|| Value::object(Obj::new()))])).map(|r| r.item(0).unwrap_or(Value::Null)),
            "addSegments" => self.add_segments(arg(0).unwrap_or(&Value::Null)),
            "addSpriteSegment" => self.add_sprite_segment(arg(0).unwrap_or(&Value::Null), arg(1)),
            "deleteSegment" => self.delete_segment(arg(0)).map(Value::Bool),
            "deleteSingleSegment" => self.delete_single_segment(arg(0)).map(Value::Bool),
            "unsplitSegment" => {
                let mut options = Obj::new();
                options.set("preserveEndpoints", Value::Bool(true));
                self.delete_single_segment(Some(&Value::object(options))).map(Value::Bool)
            }
            "mirrorSegment" => self.mirror_segment(arg(0), arg(1)).map(Value::Bool),
            "mirrorSegmentBranch" => {
                let mut options = Obj::new();
                options.set("branch", Value::Bool(true));
                self.mirror_segment(arg(0), Some(&Value::object(options))).map(Value::Bool)
            }
            "moveBuilderSegment" => self.move_builder_segment(arg(0), arg(1)).map(Value::Bool),
            "splitBuilderSegments" => self.split_builder_segments(arg(0)).map(Value::Bool),
            "splitSegment" | "splitSegmentBranch" => {
                let mut options = Obj::new();
                options.set("branch", Value::Bool(method == "splitSegmentBranch"));
                options.set("fraction", arg(0).cloned().unwrap_or(Value::Num(0.5)));
                self.split_builder_segments(Some(&Value::object(options))).map(Value::Bool)
            }
            "duplicateSegment" => self.duplicate_segment(arg(0), false),
            "duplicateSegmentBranch" => self.duplicate_segment(arg(0), true),
            "addConnector" => self.add_connector(arg(0), arg(1), arg(2)),
            "replaceFigureDefinition" => self.replace_figure_definition(arg(0), arg(1), arg(2)),
            "addWeightedJoint" => self.add_weighted_joint(arg(0), arg(1)),
            _ => return None,
        })
    }
}

/// The frames a topology command walks: every place with an instance of the figure, with the
/// slots of its instances.
fn instances(report: &Value, type_id: &Value) -> Vec<(Place, Vec<usize>)> {
    places(report)
        .into_iter()
        .filter_map(|place| {
            let objects = items(frame_at(report, &place).and_then(|f| f.get("objects")));
            let slots: Vec<usize> = objects.iter().enumerate().filter(|(_, o)| o.get("figure_type_id") == Some(type_id)).map(|(s, _)| s).collect();
            (!slots.is_empty()).then_some((place, slots))
        })
        .collect()
}

/// The pose vectors of an object, read for editing.
struct Pose {
    angles: Vec<f64>,
    lengths: Option<Vec<f64>>,
    bends: Option<Vec<f64>>,
}

impl Pose {
    fn of(object: &Value) -> Pose {
        Pose {
            angles: numbers(object.get("angles")),
            lengths: truthy(object, "len_flag").then(|| numbers(object.get("lengths"))),
            bends: truthy(object, "bend_flag").then(|| numbers(object.get("bends"))),
        }
    }

    /// Writes the vectors back (each array a fresh one), dropping `runtime_segments`.
    fn write(self, object: &mut Value) {
        let Some(record) = object.make_obj() else { return };
        record.set("angles", Value::nums(&self.angles));
        if let Some(lengths) = self.lengths {
            record.set("lengths", Value::nums(&lengths));
        }
        if let Some(bends) = self.bends {
            record.set("bends", Value::nums(&bends));
        }
        record.remove("runtime_segments");
    }
}

/// `topology(segments)`: children by parent handle and a breadth-first order from the roots.
struct Tree {
    children: HashMap<u64, Vec<usize>>,
    order: Vec<usize>,
}

fn tree(segments: &[Value]) -> Result<Tree, EditError> {
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut order = Vec::new();
    for (i, s) in segments.iter().enumerate() {
        let parent = given(s, "parent_id").unwrap_or(f64::NAN);
        if parent == 0.0 {
            order.push(i);
        } else {
            children.entry(key_of(parent)).or_default().push(i);
        }
    }
    let mut q = 0;
    while q < order.len() {
        let id = given(&segments[order[q]], "segment_id").unwrap_or(f64::NAN);
        for &child in children.get(&key_of(id)).map(Vec::as_slice).unwrap_or(&[]) {
            order.push(child);
        }
        q += 1;
    }
    if order.len() != segments.len() {
        return Err(invalid("errors.editorBuilderTopology.theFigureContainsAnInvalidJointHierarchy"));
    }
    Ok(Tree { children, order })
}

/// `points(segments, object, tree, root, scale)`: each handle's position, in single precision.
fn points(segments: &[Value], object: Option<&Value>, tree: &Tree, root: [f64; 2], scale: f64) -> HashMap<u64, [f64; 2]> {
    let mut joints: HashMap<u64, [f64; 2]> = HashMap::from([(0, root)]);
    let pose = object.map(Pose::of);
    for &index in &tree.order {
        let segment = &segments[index];
        let start = joints.get(&key_of(given(segment, "parent_id").unwrap_or(f64::NAN))).copied().unwrap_or([f64::NAN; 2]);
        let angle = pose.as_ref().and_then(|p| p.angles.get(index).copied()).or_else(|| given(segment, "angle_rad")).unwrap_or(f64::NAN);
        let bend = match pose.as_ref().and_then(|p| p.bends.as_ref()) {
            Some(bends) => bends.get(index).copied().unwrap_or(f64::NAN),
            None => given(segment, "bend_rad").unwrap_or(0.0),
        };
        let length = match pose.as_ref().and_then(|p| p.lengths.as_ref()) {
            Some(lengths) => lengths.get(index).copied().unwrap_or(f64::NAN),
            None => given(segment, "length").unwrap_or(f64::NAN),
        } * scale;
        let (x, y) = if bend.abs() < 1e-7 {
            (length * styk_math::cos(angle), length * styk_math::sin(angle))
        } else {
            (length / bend * (styk_math::sin(angle + bend) - styk_math::sin(angle)), length / bend * (styk_math::cos(angle) - styk_math::cos(angle + bend)))
        };
        let id = given(segment, "segment_id").unwrap_or(f64::NAN);
        joints.insert(key_of(id), [(start[0] + x) as f32 as f64, (start[1] + y) as f32 as f64]);
    }
    joints
}

/// `fit(start, end, bend, fallbackAngle, scale)`: the angle and length of an arc of `bend` from
/// `start` to `end`.
fn fit(start: [f64; 2], end: [f64; 2], bend: f64, fallback: f64, scale: f64) -> Result<(f64, f64), EditError> {
    let distance = styk_math::hypot(end[0] - start[0], end[1] - start[1]);
    let factor = if bend.abs() < EPS { 1.0 } else { 2.0 * styk_math::sin(bend / 2.0) / bend };
    if factor.abs() < EPS && distance > EPS {
        return Err(invalid("errors.editorBuilderTopology.reduceTheClosedFullCircleBendBeforeRemoving"));
    }
    let angle = if distance < EPS { fallback } else { styk_math::atan2(end[1] - start[1], end[0] - start[0]) - bend / 2.0 - if factor * scale < 0.0 { std::f64::consts::PI } else { 0.0 } };
    let length = if distance < EPS { 0.0 } else { distance / (factor * scale).abs() };
    Ok((angle, length))
}

/// `mergedBend(parentAngle, parentBend, childAngle, childBend)`: a smooth pair of arcs bending
/// the same way becomes one.
fn merged_bend(parent_angle: f64, parent_bend: f64, child_angle: f64, child_bend: f64) -> f64 {
    let turn = child_angle - parent_angle - parent_bend;
    let difference = styk_math::atan2(styk_math::sin(turn), styk_math::cos(turn));
    if parent_bend.abs() > 0.001 && (parent_bend + child_bend).abs() < 2.0 * std::f64::consts::PI && parent_bend * child_bend > 0.0 && difference.abs() < 0.02 {
        parent_bend + child_bend
    } else {
        child_bend
    }
}

/// `protectSurfaceReferences(figure, removed)`.
fn protect_surfaces(figure: &Value, removed: &HashSet<u64>) -> Result<(), EditError> {
    for polygon in items(figure.get("polyfills")) {
        let own = numbers(polygon.get("segment_ids"));
        let references: Vec<f64> = numbers(polygon.path(&["_stykSurface", "basis"])).into_iter().chain(numbers(polygon.path(&["_stykSurface", "depth"]))).collect();
        if !own.iter().any(|id| removed.contains(&key_of(*id))) && references.iter().any(|id| removed.contains(&key_of(*id))) {
            return Err(invalid("errors.editorBuilderTopology.thisJointControlsFaceVisibilityChangeTheFill"));
        }
    }
    Ok(())
}

impl Editor {
    /// Writes the definition being edited.
    pub(crate) fn edit_figure(&mut self, index: usize) -> Option<&mut Obj> {
        self.report.make_obj()?.get_mut("figure_types")?.make_arr()?.get_mut(index)?.make_obj()
    }

    pub(crate) fn figure_at(&self, index: usize) -> Value {
        self.report.get("figure_types").and_then(|f| f.item(index)).unwrap_or(Value::Null)
    }

    /// The root and handles of the figures at `slots` of the frame at `place`, as the document
    /// now places them (`componentGeometry`).
    pub(crate) fn component_joints(&self, place: &Place, slots: &[usize]) -> Result<HashMap<usize, crate::range_plan::Joints>, EditError> {
        let record = frame_at(&self.report, place).cloned().unwrap_or(Value::Null);
        self.joints_of(&record, slots).map_err(|error| match error {
            EditError::Invalid(why) => EditError::Unported(format!("a topology edit over unresolved geometry ({why})")),
            other => other,
        })
    }

    /// `canonicalizeChildren(report, frame, roots)`: figures joined below the instances placed
    /// again where their parents' handles now are.
    pub(crate) fn canonicalize_children(&mut self, place: &Place, roots: &[usize]) -> Result<(), EditError> {
        let objects = items(frame_at(&self.report, place).and_then(|f| f.get("objects")));
        let mut children: HashMap<usize, Vec<usize>> = HashMap::new();
        for (slot, object) in objects.iter().enumerate() {
            if let Some(parent) = join_target(object) {
                children.entry(parent).or_default().push(slot);
            }
        }
        let mut affected: Vec<usize> = roots.to_vec();
        let mut queue: Vec<usize> = roots.to_vec();
        let mut moved: Vec<usize> = Vec::new();
        let mut q = 0;
        while q < queue.len() {
            for &child in children.get(&queue[q]).map(Vec::as_slice).unwrap_or(&[]) {
                if !moved.contains(&child) {
                    moved.push(child);
                }
                if !affected.contains(&child) {
                    affected.push(child);
                    queue.push(child);
                }
            }
            q += 1;
        }
        if moved.is_empty() {
            return Ok(());
        }
        let joints = self.component_joints(place, &affected)?;
        let Some(list) = objects_mut(&mut self.report, place) else { return Ok(()) };
        for slot in moved {
            if let (Some(geometry), Some(object)) = (joints.get(&slot), list.get_mut(slot)) {
                let root = geometry.root();
                set(object, "root_x", Value::Num(root[0]));
                set(object, "root_y", Value::Num(root[1]));
            }
        }
        Ok(())
    }

    /// `addSegments(specs)` (`addSegment(options)` is one): a connected stroke appended to the
    /// selected figure, each segment taking its parent's displayed colour and width.
    fn add_segments(&mut self, specs: &Value) -> Result<Value, EditError> {
        let list = match specs {
            value if value.is_array() => items(Some(value)),
            _ => return Ok(Value::array(Vec::new())),
        };
        if list.is_empty() {
            return Ok(Value::array(Vec::new()));
        }
        let selected = self.topology_figure()?;
        let count = selected.as_ref().map_or(0, |(_, f)| items(f.get("segments")).len());
        if count + list.len() > MAX_SEGMENTS {
            return Err(invalid("errors.editorRigConstraints.figureSegmentCapacityReached"));
        }
        let check = |value: Option<&Value>, label: &str| match value {
            Some(Value::Num(n)) if n.is_finite() => Ok(*n),
            _ => Err(crate::transform::not_finite(label)),
        };
        let mut prepared = Vec::new();
        for spec in &list {
            let field = |key: &str| spec.get(key);
            let length = match field("length") { None => 50.0, some => check(some, "Segment length")? };
            let angle = match field("angle") { None => 0.0, some => check(some, "Segment angle")? };
            let thickness = match field("thickness") { None => None, some => Some(check(some, "Segment thickness")?) };
            if length < 0.0 || thickness.is_some_and(|t| t < 0.0) {
                return Err(invalid("errors.editor.segmentLengthAndThicknessCannotBeNegative"));
            }
            let code = match field("type") {
                None => 0.0,
                Some(Value::Num(n)) => *n,
                Some(other) => match other.as_str() {
                    Some("line") => 0.0,
                    Some("circle") => 1.0,
                    Some("circleFill") => 3.0,
                    Some("circleClear") => 4.0,
                    Some("squareLine") => 6.0,
                    _ => f64::NAN,
                },
            };
            if ![0.0, 1.0, 3.0, 4.0, 6.0].contains(&code) {
                return Err(invalid("errors.editor.chooseALineOrCircleSegment"));
            }
            prepared.push(StrokeSpec { parent: field("parentId").cloned(), length, angle, thickness, code });
        }
        let Some((index, figure)) = selected else { return self.add_drawn_figure(specs, &prepared, &list[0]) };
        let segments = items(figure.get("segments"));
        let object = self.object()?.map(|(_, o)| o).unwrap_or(Value::Null);
        let id_of = |s: &Value| s.get("segment_id").cloned().unwrap_or(Value::Null);
        let selected_id = usize::try_from(self.selection.joint).ok().and_then(|j| segments.get(j)).map(id_of);
        let parent = prepared[0].parent.clone().filter(|p| !p.is_null()).or(selected_id).unwrap_or(Value::Num(0.0));
        let known = |id: &Value| id.as_f64() == Some(0.0) || segments.iter().any(|s| crate::history::js_strict_eq(&id_of(s), id));
        if !(parent.as_f64() == Some(0.0)) && !segments.iter().any(|s| crate::history::js_strict_eq(&id_of(s), &parent)) {
            return Err(invalid("errors.editor.theSegmentParentDoesNotExist"));
        }
        for spec in &prepared {
            if let Some(p) = spec.parent.as_ref().filter(|p| !p.is_null())
                && !known(p)
            {
                return Err(invalid("errors.editor.theSegmentParentDoesNotExist"));
            }
        }
        let next_id = segments.iter().filter_map(|s| num(s, "segment_id")).fold(0.0, f64::max) + 1.0;
        if next_id + list.len() as f64 - 1.0 > 65535.0 {
            return Err(invalid("errors.editorBuilderBranch.figureJointCapacityReached"));
        }
        if segments.iter().any(|s| s.get("_stykRig").is_some_and(Value::truthy)) {
            return Err(EditError::Unported("drawing into a figure with rig relationships".into()));
        }
        let (resolved, _) = crate::recolor::resolve(&figure, &object)?;
        let mut styles: Vec<(Value, Value)> = resolved.iter().map(|s| (id_of(s), s.clone())).collect();
        let style_of = |styles: &Vec<(Value, Value)>, id: &Value| styles.iter().rev().find(|(k, _)| crate::history::js_strict_eq(k, id)).map(|(_, s)| s.clone());
        let first_color = segments.first().and_then(|s| s.get("color_rgb").filter(|c| !c.is_null()).cloned());
        let mut result = Vec::new();
        for (i, spec) in prepared.iter().enumerate() {
            let parent_handle = spec.parent.clone().filter(|p| !p.is_null()).unwrap_or_else(|| if i > 0 { Value::Num(next_id + i as f64 - 1.0) } else { parent.clone() });
            let source = style_of(&styles, &parent_handle);
            let thickness = spec.thickness.or_else(|| source.as_ref().and_then(|s| given(s, "thickness"))).unwrap_or(8.0);
            let color = source.as_ref().and_then(|s| s.get("color_rgb").filter(|c| !c.is_null()).cloned()).or_else(|| first_color.clone()).unwrap_or_else(|| Value::nums(&[48.0, 48.0, 56.0]));
            let code = spec.code;
            let mut segment = Obj::new();
            segment.set("segment_id", Value::Num(next_id + i as f64));
            segment.set("parent_id", parent_handle);
            segment.set("length", Value::Num(spec.length));
            segment.set("angle_rad", Value::Num(spec.angle));
            segment.set("thickness", Value::Num(thickness));
            segment.set("bend_rad", Value::Num(0.0));
            segment.set("primitive_code", Value::Num(code));
            segment.set("aux_code", Value::Num(0.0));
            segment.set("flags", Value::Num(code));
            segment.set("segment_type", Value::str(if [1.0, 3.0, 4.0].contains(&code) { "circle" } else { "line" }));
            segment.set("segment_kind", Value::str(crate::builder::KINDS[code as usize]));
            segment.set("color_rgb", color);
            segment.set("transparency", Value::Num(0.0));
            segment.set("visible", Value::Bool(thickness > 0.0 || code > 0.0));
            segment.set("z_order", Value::Num((segments.len() + i + 1) as f64));
            let segment = Value::object(segment);
            styles.push((id_of(&segment), segment.clone()));
            result.push(segment);
        }
        let label = if list.len() > 1 { "Draw chain" } else { "Add segment" };
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let added = result.clone();
        let angles: Vec<f64> = prepared.iter().map(|s| s.angle).collect();
        let lengths: Vec<f64> = prepared.iter().map(|s| s.length).collect();
        self.topology_edit(label, TopologyOptions { history_append_only: true, ..TopologyOptions::default() }, |editor, index| {
            let mut all = items(editor.figure_at(index).get("segments"));
            all.extend(added.iter().cloned());
            let total = all.len();
            if let Some(figure) = editor.edit_figure(index) {
                figure.set("segments", Value::array(all));
            }
            for (place, slots) in instances(&editor.report, &type_id) {
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in slots {
                    let mut pose = Pose::of(&list[slot]);
                    pose.angles.extend(&angles);
                    if let Some(l) = pose.lengths.as_mut() {
                        l.extend(&lengths);
                    }
                    if let Some(b) = pose.bends.as_mut() {
                        b.extend(std::iter::repeat_n(0.0, angles.len()));
                    }
                    pose.write(&mut list[slot]);
                }
            }
            editor.selection.joint = total as i64 - 1;
            Ok(())
        })?;
        let _ = index;
        Ok(Value::array(result))
    }

    /// `deleteSegment({handleIds, branch})`: segments (with their branches) removed; figures
    /// joined to a removed handle stay where they were drawn.
    fn delete_segment(&mut self, options: Option<&Value>) -> Result<bool, EditError> {
        let Some((_, figure)) = self.topology_figure()? else { return Ok(false) };
        let segments = items(figure.get("segments"));
        let Some(selected) = usize::try_from(self.selection.joint).ok().and_then(|j| segments.get(j)).cloned() else { return Ok(false) };
        let options = match options {
            None => Value::object(Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("delete options that are null".into())),
            Some(o) => o.clone(),
        };
        let whole = options.get("branch").is_none_or(Value::truthy);
        let requested: Vec<f64> = match options.get("handleIds").filter(|h| !h.is_null()) {
            None => vec![num(&selected, "segment_id").unwrap_or(f64::NAN)],
            Some(list) if list.is_array() => numbers(Some(list)),
            Some(_) => return Err(EditError::Unported("handles that are not a list".into())),
        };
        let valid: HashSet<u64> = segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).collect();
        let mut ids: Vec<f64> = Vec::new();
        for id in requested {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if ids.is_empty() || ids.iter().any(|id| !valid.contains(&key_of(*id))) {
            return Err(invalid("errors.editor.selectExistingSegmentsToDelete"));
        }
        if whole {
            let mut q = 0;
            while q < ids.len() {
                let parent = ids[q];
                for s in &segments {
                    if given(s, "parent_id") == Some(parent)
                        && let Some(id) = handle(s.get("segment_id"))
                        && !ids.contains(&id)
                    {
                        ids.push(id);
                    }
                }
                q += 1;
            }
        }
        let removed: HashSet<u64> = ids.iter().map(|id| key_of(*id)).collect();
        if removed.len() == segments.len() {
            return Err(invalid("errors.editorBuilderTopology.aFigureNeedsAtLeastOneSegmentDelete"));
        }
        let label = if whole { "Delete segment branches" } else { "Delete selected segments" };
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        self.topology_edit(label, TopologyOptions::default(), |editor, index| {
            let figure = editor.figure_at(index);
            let segments = items(figure.get("segments"));
            let keep: Vec<usize> = (0..segments.len()).filter(|&i| !handle(segments[i].get("segment_id")).is_some_and(|id| removed.contains(&key_of(id)))).collect();
            for place in places(&editor.report) {
                let objects = items(frame_at(&editor.report, &place).and_then(|f| f.get("objects")));
                let detached: Vec<usize> = (0..objects.len())
                    .filter(|&slot| {
                        let object = &objects[slot];
                        let target = handle(object.get("join").filter(|j| j.truthy()).and_then(|j| j.get("target_handle_id")));
                        target.is_some_and(|t| removed.contains(&key_of(t))) && join_target(object).and_then(|p| objects.get(p)).is_some_and(|p| p.get("figure_type_id") == Some(&type_id))
                    })
                    .collect();
                let joints = if detached.is_empty() { HashMap::new() } else { editor.component_joints(&place, &detached)? };
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in detached {
                    if let Some(geometry) = joints.get(&slot) {
                        let root = geometry.root();
                        set(&mut list[slot], "root_x", Value::Num(root[0]));
                        set(&mut list[slot], "root_y", Value::Num(root[1]));
                    }
                    set(&mut list[slot], "join", Value::Null);
                }
                for object in list.iter_mut() {
                    if object.get("figure_type_id") != Some(&type_id) {
                        continue;
                    }
                    let pose = Pose::of(object);
                    let pick = |v: &Vec<f64>| keep.iter().map(|&i| v.get(i).copied().unwrap_or(f64::NAN)).collect::<Vec<_>>();
                    Pose { angles: pick(&pose.angles), lengths: pose.lengths.as_ref().map(pick), bends: pose.bends.as_ref().map(pick) }.write(object);
                }
            }
            let parents: HashMap<u64, Value> = segments.iter().filter_map(|s| handle(s.get("segment_id")).map(|id| (key_of(id), s.get("parent_id").cloned().unwrap_or(Value::Null)))).collect();
            let mut next = Vec::new();
            for &i in &keep {
                let mut segment = segments[i].clone();
                let mut parent = segment.get("parent_id").cloned().unwrap_or(Value::Null);
                while handle(Some(&parent)).is_some_and(|p| removed.contains(&key_of(p))) {
                    parent = parents.get(&key_of(handle(Some(&parent)).unwrap())).cloned().unwrap_or(Value::Null);
                }
                if !crate::history::js_strict_eq(&parent, segment.get("parent_id").unwrap_or(&Value::Null)) {
                    set(&mut segment, "parent_id", parent);
                }
                next.push(segment);
            }
            protect_surfaces(&figure, &removed)?;
            if figure.path(&["_styk", "spatialMesh"]).is_some() {
                return Err(EditError::Unported("deleting joints of a 3D mesh".into()));
            }
            let polygons: Vec<Value> = items(figure.get("polyfills"))
                .into_iter()
                .filter(|p| {
                    let surface: Vec<f64> = numbers(p.get("segment_ids")).into_iter().chain(numbers(p.path(&["_stykSurface", "basis"]))).chain(numbers(p.path(&["_stykSurface", "depth"]))).collect();
                    !surface.iter().any(|id| removed.contains(&key_of(*id)))
                })
                .collect();
            let had_polygons = figure.get("polyfills").is_some();
            if let Some(record) = editor.edit_figure(index) {
                record.set("segments", Value::array(next));
                if had_polygons || !polygons.is_empty() {
                    record.set("polyfills", Value::array(polygons));
                } else {
                    record.set("polyfills", Value::array(Vec::new()));
                }
            }
            editor.selection.joint = -1;
            Ok(())
        })
    }

    /// `deleteSingleSegment({preserveEndpoints})` and `unsplitSegment()`: one segment removed, its
    /// children taken by its parent; Ctrl+Delete refits them to the joints they reached.
    fn delete_single_segment(&mut self, options: Option<&Value>) -> Result<bool, EditError> {
        let Some((_, figure)) = self.topology_figure()? else { return Ok(false) };
        let segments = items(figure.get("segments"));
        let index = self.selection.joint;
        let Some(segment) = usize::try_from(index).ok().and_then(|j| segments.get(j)).cloned() else { return Ok(false) };
        let index = index as usize;
        let id = num(&segment, "segment_id").unwrap_or(f64::NAN);
        let removed: HashSet<u64> = HashSet::from([key_of(id)]);
        if items(figure.get("polyfills")).iter().any(|p| numbers(p.path(&["_stykSurface", "basis"])).contains(&id)) {
            return Err(invalid("errors.editorBuilderTopology.thisJointControlsFaceVisibilityChangeTheFill"));
        }
        protect_surfaces(&figure, &removed)?;
        if figure.path(&["_styk", "spatialMesh"]).is_some() {
            return Err(EditError::Unported("deleting joints of a 3D mesh".into()));
        }
        let preserve = match options.and_then(|o| o.get("preserveEndpoints")) {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(invalid("errors.editorBuilderTopology.chooseWhetherToPreserveTheOtherJoints")),
        };
        if options.is_some_and(Value::is_null) {
            return Err(EditError::Unported("delete options that are null".into()));
        }
        if segments.len() == 1 {
            return Err(invalid("errors.editorBuilderTopology.aFigureNeedsAtLeastOneSegmentDelete"));
        }
        let shape = tree(&segments)?;
        let children: Vec<usize> = shape.children.get(&key_of(id)).cloned().unwrap_or_default();
        let defaults = (preserve && !children.is_empty()).then(|| points(&segments, None, &shape, [0.0, 0.0], 1.0));
        let label = if preserve { "Remove joint (Unsplit)" } else { "Delete single segment" };
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let parent_id = segment.get("parent_id").cloned().unwrap_or(Value::Null);
        let parent = given(&segment, "parent_id").unwrap_or(f64::NAN);
        let topology = TopologyOptions { origin_freeze: if preserve { children.iter().filter_map(|&i| num(&segments[i], "segment_id")).map(key_of).collect() } else { HashSet::new() }, ..TopologyOptions::default() };
        self.topology_edit(label, topology, |editor, index_of_figure| {
            let mut touched: Vec<(Place, Vec<usize>)> = Vec::new();
            for (place, slots) in instances(&editor.report, &type_id) {
                touched.push((place.clone(), slots.clone()));
                let objects = items(frame_at(&editor.report, &place).and_then(|f| f.get("objects")));
                let typed: HashSet<usize> = slots.iter().copied().collect();
                let detached: Vec<usize> = (0..objects.len())
                    .filter(|&s| {
                        let join = objects[s].get("join").filter(|j| j.truthy());
                        handle(join.and_then(|j| j.get("target_handle_id"))) == Some(id) && join_target(&objects[s]).is_some_and(|p| typed.contains(&p))
                    })
                    .collect();
                let needed: Vec<usize> = detached.iter().copied().chain(slots.iter().copied().filter(|&s| objects[s].get("join").is_some_and(Value::truthy))).collect();
                let joints = if needed.is_empty() { None } else { Some(editor.component_joints(&place, &needed)?) };
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for &slot in &detached {
                    let Some(root) = joints.as_ref().and_then(|j| j.get(&slot)).map(|g| g.root()) else {
                        return Err(EditError::Unported("a joined figure without geometry".into()));
                    };
                    set(&mut list[slot], "root_x", Value::Num(root[0]));
                    set(&mut list[slot], "root_y", Value::Num(root[1]));
                    set(&mut list[slot], "join", Value::Null);
                }
                for &slot in &slots {
                    let object = &list[slot];
                    let mut pose = Pose::of(object);
                    if preserve && !children.is_empty() {
                        let scale = given(object, "scale").unwrap_or(f64::NAN);
                        let scale = if scale.abs() > EPS { scale } else { 1.0 };
                        let root = joints.as_ref().and_then(|j| j.get(&slot)).map(|g| g.root()).unwrap_or([given(object, "root_x").unwrap_or(f64::NAN), given(object, "root_y").unwrap_or(f64::NAN)]);
                        let joints_now = points(&segments, Some(object), &shape, root, scale);
                        let start = joints_now.get(&key_of(parent)).copied().unwrap_or([f64::NAN; 2]);
                        let mut lengths = pose.lengths.clone().unwrap_or_else(|| segments.iter().map(|s| given(s, "length").unwrap_or(f64::NAN)).collect());
                        let mut bends = pose.bends.clone().unwrap_or_else(|| segments.iter().map(|s| given(s, "bend_rad").unwrap_or(0.0)).collect());
                        for &child_index in &children {
                            let child_id = num(&segments[child_index], "segment_id").unwrap_or(f64::NAN);
                            let bend = merged_bend(pose.angles[index], bends[index], pose.angles[child_index], bends[child_index]);
                            let end = joints_now.get(&key_of(child_id)).copied().unwrap_or([f64::NAN; 2]);
                            let (angle, length) = fit(start, end, bend, pose.angles[child_index], scale)?;
                            pose.angles[child_index] = angle;
                            lengths[child_index] = length;
                            bends[child_index] = bend;
                        }
                        set(&mut list[slot], "len_flag", Value::Num(1.0));
                        set(&mut list[slot], "bend_flag", Value::Num(1.0));
                        pose.lengths = Some(lengths);
                        pose.bends = Some(bends);
                    }
                    pose.angles.remove(index);
                    if let Some(l) = pose.lengths.as_mut() {
                        l.remove(index);
                    }
                    if let Some(b) = pose.bends.as_mut() {
                        b.remove(index);
                    }
                    pose.write(&mut list[slot]);
                }
            }
            let mut next = segments.clone();
            for &child_index in &children {
                let child = &mut next[child_index];
                if let Some(defaults) = &defaults {
                    let child_angle = given(child, "angle_rad").unwrap_or(f64::NAN);
                    let bend = merged_bend(given(&segment, "angle_rad").unwrap_or(f64::NAN), given(&segment, "bend_rad").unwrap_or(0.0), child_angle, given(child, "bend_rad").unwrap_or(0.0));
                    let child_id = num(child, "segment_id").unwrap_or(f64::NAN);
                    let start = defaults.get(&key_of(parent)).copied().unwrap_or([f64::NAN; 2]);
                    let end = defaults.get(&key_of(child_id)).copied().unwrap_or([f64::NAN; 2]);
                    let (angle, length) = fit(start, end, bend, child_angle, 1.0)?;
                    set(child, "angle_rad", Value::Num(angle));
                    set(child, "length", Value::Num(length));
                    set(child, "bend_rad", Value::Num(bend));
                }
                set(child, "parent_id", parent_id.clone());
            }
            next.remove(index);
            // `trimPolygons(figure, removedId)`.
            let figure_now = editor.figure_at(index_of_figure);
            let polygons: Vec<Value> = items(figure_now.get("polyfills"))
                .into_iter()
                .filter_map(|polygon| {
                    let ids: Vec<f64> = numbers(polygon.get("segment_ids")).into_iter().filter(|h| *h != id).collect();
                    let distinct = ids.iter().enumerate().filter(|(i, a)| !ids[..*i].contains(a)).count();
                    (distinct >= 3).then(|| {
                        let mut record = polygon.as_obj().cloned().unwrap_or_default();
                        record.set("segment_ids", Value::nums(&ids));
                        record.set("segment_ids_raw", Value::nums(&ids));
                        Value::object(record)
                    })
                })
                .collect();
            if let Some(record) = editor.edit_figure(index_of_figure) {
                record.set("segments", Value::array(next.clone()));
                record.set("polyfills", Value::array(polygons));
            }
            for (place, slots) in &touched {
                editor.canonicalize_children(place, slots)?;
            }
            editor.selection.joint = if parent == 0.0 { -1 } else { next.iter().position(|s| given(s, "segment_id") == Some(parent)).map_or(-1, |i| i as i64) };
            Ok(())
        })
    }

    /// `mirrorSegment(axis, {branch})`: the selected segment (and its branch) flipped about its
    /// parent joint in every pose and in the definition.
    fn mirror_segment(&mut self, axis: Option<&Value>, options: Option<&Value>) -> Result<bool, EditError> {
        let horizontal = match axis {
            None => true,
            Some(value) => match value.as_str() {
                Some("horizontal") => true,
                Some("vertical") => false,
                _ => return Err(invalid("errors.editorBuilderTopology.chooseAHorizontalOrVerticalFlip")),
            },
        };
        let whole = match options {
            None => false,
            Some(Value::Null) => return Err(EditError::Unported("flip options that are null".into())),
            Some(o) => o.get("branch").is_some_and(Value::truthy),
        };
        let Some((_, figure)) = self.topology_figure()? else { return Ok(false) };
        let segments = items(figure.get("segments"));
        let Some(index) = usize::try_from(self.selection.joint).ok().filter(|&j| j < segments.len()) else { return Ok(false) };
        let shape = tree(&segments)?;
        let mut indices = vec![index];
        if whole {
            let mut i = 0;
            while i < indices.len() {
                let id = num(&segments[indices[i]], "segment_id").unwrap_or(f64::NAN);
                for &child in shape.children.get(&key_of(id)).map(Vec::as_slice).unwrap_or(&[]) {
                    indices.push(child);
                }
                i += 1;
            }
        }
        if indices.iter().any(|&i| segments[i].path(&["_stykRig", "spatial"]).is_some_and(Value::truthy)) {
            return Err(invalid("errors.editorBuilderTopology.flipTheCompleteSpatialFigureInAnimateTo"));
        }
        let reflect = move |angle: f64| {
            if horizontal {
                if angle < 0.0 { -std::f64::consts::PI - angle } else { std::f64::consts::PI - angle }
            } else {
                -angle
            }
        };
        let label = format!("Flip {} {}", if whole { "branch" } else { "segment" }, if horizontal { "horizontal" } else { "vertical" });
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        self.topology_edit(&label, TopologyOptions::default(), |editor, at| {
            let frames = instances(&editor.report, &type_id);
            for (place, slots) in &frames {
                let Some(list) = objects_mut(&mut editor.report, place) else { continue };
                for &slot in slots {
                    let mut pose = Pose::of(&list[slot]);
                    for &i in &indices {
                        if let Some(a) = pose.angles.get_mut(i) {
                            *a = reflect(*a);
                        }
                        if let Some(b) = pose.bends.as_mut().and_then(|b| b.get_mut(i)) {
                            *b = -*b;
                        }
                    }
                    pose.write(&mut list[slot]);
                }
            }
            let mut next = items(editor.figure_at(at).get("segments"));
            for &i in &indices {
                let current = &mut next[i];
                let angle = given(current, "angle_rad").unwrap_or(f64::NAN);
                let bend = given(current, "bend_rad").unwrap_or(0.0);
                set(current, "angle_rad", Value::Num(reflect(angle)));
                set(current, "bend_rad", Value::Num(-bend));
                let code = given(current, "primitive_code");
                if code == Some(2.0) || code == Some(5.0) {
                    let flag = current.get("extra_u8_b").filter(|v| !v.is_null()).cloned().or_else(|| current.get("extra").and_then(|e| e.item(2)).filter(|v| !v.is_null()));
                    let flipped = if flag.is_some_and(|f| f.truthy()) { 0.0 } else { 1.0 };
                    set(current, "extra_u8_b", Value::Num(flipped));
                    if let Some(extra) = current.get("extra").filter(|e| e.is_array()).cloned() {
                        let values: Vec<Value> = items(Some(&extra)).into_iter().enumerate().map(|(k, v)| if k == 2 { Value::Num(flipped) } else { v }).collect();
                        set(current, "extra", Value::array(values));
                    }
                }
            }
            if let Some(record) = editor.edit_figure(at) {
                record.set("segments", Value::array(next));
            }
            for (place, slots) in &frames {
                editor.canonicalize_children(place, slots)?;
            }
            Ok(())
        })
    }

    /// `moveBuilderSegment(segmentId, {parentId, beforeId})`: a segment reparented or reordered
    /// among its new parent's children; every pose follows the new order.
    fn move_builder_segment(&mut self, id: Option<&Value>, options: Option<&Value>) -> Result<bool, EditError> {
        let Some((_, figure)) = self.topology_figure()? else { return Ok(false) };
        let segments = items(figure.get("segments"));
        let id = id.cloned().unwrap_or(Value::Null);
        let same = |a: &Value, b: &Value| crate::history::js_strict_eq(a, b);
        let Some(index) = segments.iter().position(|s| same(s.get("segment_id").unwrap_or(&Value::Null), &id)) else { return Ok(false) };
        let options = match options {
            None => Value::object(Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("move options that are null".into())),
            Some(o) => o.clone(),
        };
        let segment = &segments[index];
        let next_parent = options.get("parentId").cloned().unwrap_or_else(|| segment.get("parent_id").cloned().unwrap_or(Value::Null));
        if segment.path(&["_stykRig", "spatial"]).is_some_and(Value::truthy) && !same(&next_parent, segment.get("parent_id").unwrap_or(&Value::Null)) {
            return Err(invalid("errors.editorBuilderTopology.aSpatialJointMustKeepItsBoundParent"));
        }
        if next_parent.as_f64() != Some(0.0) {
            if !segments.iter().any(|s| same(s.get("segment_id").unwrap_or(&Value::Null), &next_parent)) {
                return Err(invalid("errors.editorBuilderTopology.chooseAValidParentJoint"));
            }
            let mut ancestor = next_parent.clone();
            let mut steps = 0;
            while ancestor.truthy() {
                if same(&ancestor, &id) {
                    return Err(invalid("errors.editorBuilderTopology.aJointCannotMoveInsideItsOwnBranch"));
                }
                ancestor = segments.iter().find(|s| same(s.get("segment_id").unwrap_or(&Value::Null), &ancestor)).and_then(|s| s.get("parent_id").cloned()).filter(|p| !p.is_null()).unwrap_or(Value::Num(0.0));
                steps += 1;
                if steps > segments.len() + 1 {
                    return Err(EditError::Unported("a figure whose hierarchy loops".into()));
                }
            }
        }
        let before_id = options.get("beforeId").cloned().filter(|b| !b.is_null());
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        self.topology_edit("Move segment", TopologyOptions::default(), |editor, at| {
            let original = items(editor.figure_at(at).get("segments"));
            let mut order: Vec<usize> = (0..original.len()).collect();
            let from = original.iter().position(|s| same(s.get("segment_id").unwrap_or(&Value::Null), &id)).unwrap();
            order.remove(from);
            let mut moved = original[from].clone();
            set(&mut moved, "parent_id", next_parent.clone());
            let mut list: Vec<Value> = order.iter().map(|&i| original[i].clone()).collect();
            let mut place_at = before_id.as_ref().and_then(|b| list.iter().position(|s| same(s.get("segment_id").unwrap_or(&Value::Null), b)));
            if place_at.is_none() {
                let mut subtree: Vec<Value> = vec![next_parent.clone()];
                for candidate in &list {
                    if subtree.iter().any(|p| same(p, candidate.get("parent_id").unwrap_or(&Value::Null))) {
                        subtree.push(candidate.get("segment_id").cloned().unwrap_or(Value::Null));
                    }
                }
                place_at = Some(list.len());
                for i in (0..list.len()).rev() {
                    if subtree.iter().any(|p| same(p, list[i].get("segment_id").unwrap_or(&Value::Null))) {
                        place_at = Some(i + 1);
                        break;
                    }
                }
            }
            let place_at = place_at.unwrap();
            list.insert(place_at, moved);
            order.insert(place_at, from);
            if let Some(record) = editor.edit_figure(at) {
                record.set("segments", Value::array(list));
            }
            if order.iter().enumerate().all(|(position, &index)| position == index) {
                return Ok(());
            }
            for (place, slots) in instances(&editor.report, &type_id) {
                let Some(objects) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in slots {
                    let pose = Pose::of(&objects[slot]);
                    let pick = |v: &Vec<f64>| order.iter().map(|&i| v.get(i).copied().unwrap_or(f64::NAN)).collect::<Vec<_>>();
                    Pose { angles: pick(&pose.angles), lengths: pose.lengths.as_ref().map(pick), bends: pose.bends.as_ref().map(pick) }.write(&mut objects[slot]);
                }
            }
            Ok(())
        })
    }
}

/// `newHandles(segments, count)`: free handle ids past the largest, wrapping to the first free.
fn new_handles(segments: &[Value], count: usize) -> Result<Vec<f64>, EditError> {
    let mut used: HashSet<u64> = segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).collect();
    let mut candidate = segments.iter().filter_map(|s| handle(s.get("segment_id"))).fold(1.0f64, |c, id| c.max(id + 1.0));
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if candidate > 65535.0 {
            candidate = 1.0;
        }
        while used.contains(&key_of(candidate)) && candidate <= 65535.0 {
            candidate += 1.0;
        }
        if candidate > 65535.0 {
            return Err(invalid("errors.editorBuilderBranch.figureJointCapacityReached"));
        }
        out.push(candidate);
        used.insert(key_of(candidate));
        candidate += 1.0;
    }
    Ok(out)
}

/// `splitAngle(angle, firstBend)`: the second piece's angle, wrapped once into ±π.
fn split_angle(angle: f64, first_bend: f64) -> f64 {
    if first_bend.abs() <= 0.001 {
        return angle;
    }
    let next = angle + first_bend;
    let tau = std::f64::consts::PI * 2.0;
    if next > std::f64::consts::PI {
        next - tau
    } else if next < -std::f64::consts::PI {
        next + tau
    } else {
        next
    }
}

/// `orderValue(value)`: a finite single-precision draw order.
fn order_value(value: Option<&Value>, fallback: f64) -> Result<f64, EditError> {
    match value.filter(|v| !v.is_null()) {
        None => Ok(fallback),
        Some(Value::Num(n)) if n.is_finite() && ((*n as f32) as f64).is_finite() => Ok(*n),
        Some(_) => Err(invalid("errors.animationProperties.drawOrderMustBeAFiniteNativeNumber")),
    }
}

/// `remapRigReferences(segment, remap)` for the relationships a duplicated segment can carry.
fn remap_rig_references(segment: &mut Value, remap: &[(f64, f64)]) -> Result<(), EditError> {
    let Some(rig) = segment.get("_stykRig").filter(|r| r.truthy()).and_then(Value::as_obj).cloned() else { return Ok(()) };
    if rig.get("spatial").is_some_and(Value::truthy) {
        return Err(EditError::Unported("duplicating a 3D joint".into()));
    }
    let map = |value: Option<&Value>| -> Value {
        let value = value.cloned().unwrap_or(Value::Null);
        match value.as_f64().and_then(|id| remap.iter().find(|(from, _)| *from == id)) {
            Some((_, to)) => Value::Num(*to),
            None => value,
        }
    };
    let mut next = rig.clone();
    if let Some(weighted) = rig.get("weighted").filter(|w| w.truthy()) {
        next.set("weighted", remap_weighted(weighted, &map));
    }
    if let Some(path) = rig.get("anglePath").filter(|p| p.truthy()).and_then(Value::as_obj) {
        let mut out = path.clone();
        for key in ["driver", "pitch", "origin", "source"] {
            if path.contains(key) {
                out.set(key, map(path.get(key)));
            }
        }
        next.set("anglePath", Value::object(out));
    }
    if let Some(connector) = rig.get("connector").filter(|c| c.truthy()).and_then(Value::as_obj) {
        let mut out = connector.clone();
        out.set("start", map(connector.get("start")));
        out.set("end", map(connector.get("end")));
        next.set("connector", Value::object(out));
    }
    if let Some(follow) = rig.get("follow").filter(|f| f.truthy()).and_then(Value::as_obj) {
        let mut out = follow.clone();
        out.set("driver", map(follow.get("driver")));
        next.set("follow", Value::object(out));
    }
    if let Some(lock) = rig.get("angleLock").and_then(Value::as_obj).filter(|l| l.contains("reference")) {
        let mut out = lock.clone();
        out.set("reference", map(lock.get("reference")));
        if let Some(secondary) = lock.get("secondary").filter(|s| s.truthy()).and_then(Value::as_obj) {
            let mut second = secondary.clone();
            second.set("reference", map(secondary.get("reference")));
            out.set("secondary", Value::object(second));
        }
        next.set("angleLock", Value::object(out));
    }
    set(segment, "_stykRig", Value::object(next));
    Ok(())
}

/// `remapWeightedJoint(value, remap)`.
fn remap_weighted(value: &Value, map: &dyn Fn(Option<&Value>) -> Value) -> Value {
    let mut out = Obj::new();
    out.set("origin", map(value.get("origin")));
    let anchors = items(value.get("anchors"))
        .into_iter()
        .map(|anchor| {
            let mut a = anchor.as_obj().cloned().unwrap_or_default();
            a.set("joint", map(anchor.get("joint")));
            Value::object(a)
        })
        .collect();
    out.set("anchors", Value::array(anchors));
    if let Some(depth) = value.get("depth").filter(|d| d.truthy()) {
        out.set("depth", remap_weighted(depth, map));
    }
    Value::object(out)
}

impl Editor {
    /// `splitBuilderSegments({branch, fraction})`, `splitSegment(fraction)`,
    /// `splitSegmentBranch(fraction)`: each segment of the selection cut in two at `fraction`,
    /// the far piece keeping its handle, poses and polygons following.
    fn split_builder_segments(&mut self, options: Option<&Value>) -> Result<bool, EditError> {
        let options = match options {
            None => Value::object(Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("split options that are null".into())),
            Some(o) => o.clone(),
        };
        let fraction = match options.get("fraction") {
            None => 0.5,
            Some(Value::Num(n)) if n.is_finite() => *n,
            Some(_) => return Err(crate::out_of_range("errors.editorBuilderBranch.mustBeAFiniteNumberBetweenAnd", "Split fraction", ("min", "max"), (f64::NEG_INFINITY, f64::INFINITY))),
        };
        if fraction <= 0.0 || fraction >= 1.0 {
            return Err(invalid("errors.editorBuilderBranch.splitFractionMustBeBetweenZeroAndOne"));
        }
        let whole = match options.get("branch") {
            None => true,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(invalid("errors.editorBuilderBranch.chooseWhetherToSplitTheWholeBranch")),
        };
        let Some((_, figure)) = self.topology_figure()? else { return Ok(false) };
        let segments = items(figure.get("segments"));
        let Some(selected) = usize::try_from(self.selection.joint).ok().filter(|&j| j < segments.len()) else { return Ok(false) };
        let targets = crate::builder::branch(&figure, selected, whole, false);
        if targets.indices.iter().any(|&i| segments[i].get("_stykRig").is_some_and(Value::truthy)) {
            return Err(invalid("errors.editorBuilderBranch.splitPartsBeforeConfiguringRigRelationshipsConnectorsAlready"));
        }
        if segments.len() + targets.indices.len() > MAX_SEGMENTS {
            return Err(invalid("errors.editorBuilderBranch.aNativePivotFigureSupportsAtMost30"));
        }
        let allocated = new_handles(&segments, targets.queue.len())?;
        let split: Vec<(usize, f64)> = targets.queue.iter().copied().zip(allocated.iter().copied()).collect();
        let new_id = |index: usize| split.iter().find(|(i, _)| *i == index).map(|(_, id)| *id);
        let options = TopologyOptions { origin_splits: split.iter().map(|&(i, id)| (num(&segments[i], "segment_id").unwrap_or(f64::NAN), id)).collect(), segment_map: split.iter().map(|&(i, id)| (num(&segments[i], "segment_id").unwrap_or(f64::NAN), vec![num(&segments[i], "segment_id").unwrap_or(f64::NAN), id])).collect(), replaced: false, ..TopologyOptions::default() };
        let label = if whole { "Split segment branch" } else { "Split segment" };
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let selected_handle = new_id(selected);
        self.topology_edit(label, options, |editor, at| {
            let figure = editor.figure_at(at);
            let originals = items(figure.get("segments"));
            // Pieces by the original's handle: the first (a new handle) and the second.
            let mut pieces: Vec<(f64, Value, Value)> = Vec::new();
            for (index, original) in originals.iter().enumerate() {
                let Some(id) = new_id(index) else { continue };
                let bend = given(original, "bend_rad").unwrap_or(0.0);
                let length = given(original, "length").unwrap_or(f64::NAN);
                let mut first = original.clone();
                set(&mut first, "segment_id", Value::Num(id));
                set(&mut first, "length", Value::Num(length * fraction));
                set(&mut first, "bend_rad", Value::Num(bend * fraction));
                let mut second = original.clone();
                set(&mut second, "parent_id", Value::Num(id));
                set(&mut second, "length", Value::Num(length * (1.0 - fraction)));
                set(&mut second, "angle_rad", Value::Num(split_angle(given(original, "angle_rad").unwrap_or(f64::NAN), bend * fraction)));
                set(&mut second, "bend_rad", Value::Num(bend * (1.0 - fraction)));
                pieces.push((num(original, "segment_id").unwrap_or(f64::NAN), first, second));
            }
            for (place, slots) in instances(&editor.report, &type_id) {
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in slots {
                    let pose = Pose::of(&list[slot]);
                    let mut next = Pose { angles: Vec::new(), lengths: pose.lengths.as_ref().map(|_| Vec::new()), bends: pose.bends.as_ref().map(|_| Vec::new()) };
                    for (index, original) in originals.iter().enumerate() {
                        let angle = pose.angles.get(index).copied().unwrap_or(f64::NAN);
                        let bend = match &pose.bends {
                            Some(b) => b.get(index).copied().unwrap_or(f64::NAN),
                            None => given(original, "bend_rad").unwrap_or(0.0),
                        };
                        let length = pose.lengths.as_ref().map(|l| l.get(index).copied().unwrap_or(f64::NAN));
                        if new_id(index).is_none() {
                            next.angles.push(angle);
                            if let (Some(l), Some(length)) = (next.lengths.as_mut(), length) {
                                l.push(length);
                            }
                            if let Some(b) = next.bends.as_mut() {
                                b.push(bend);
                            }
                            continue;
                        }
                        next.angles.push(angle);
                        next.angles.push(split_angle(angle, bend * fraction));
                        if let (Some(l), Some(length)) = (next.lengths.as_mut(), length) {
                            l.push(length * fraction);
                            l.push(length * (1.0 - fraction));
                        }
                        if let Some(b) = next.bends.as_mut() {
                            b.push(bend * fraction);
                            b.push(bend * (1.0 - fraction));
                        }
                    }
                    next.write(&mut list[slot]);
                }
            }
            // Each old polygon connection gains its midpoint once, the closing edge included.
            let piece_of = |id: f64| pieces.iter().find(|(old, _, _)| *old == id);
            let mut polygons = items(figure.get("polyfills"));
            for polygon in polygons.iter_mut() {
                let ids = numbers(polygon.get("segment_ids"));
                let mut expanded = Vec::new();
                let mut inserted: Vec<f64> = Vec::new();
                for i in 0..ids.len() {
                    let (a, b) = (ids[i], ids[(i + 1) % ids.len()]);
                    expanded.push(a);
                    let forward = piece_of(b).filter(|(_, first, _)| given(first, "parent_id") == Some(a));
                    let reverse = piece_of(a).filter(|(_, first, _)| given(first, "parent_id") == Some(b));
                    if let Some((_, first, second)) = forward.or(reverse) {
                        let second_id = num(second, "segment_id").unwrap_or(f64::NAN);
                        if !inserted.contains(&second_id) {
                            expanded.push(num(first, "segment_id").unwrap_or(f64::NAN));
                            inserted.push(second_id);
                        }
                    }
                }
                if expanded.len() > 65535 {
                    return Err(invalid("errors.editorBuilderBranch.polygonConnectionCapacityReached"));
                }
                set(polygon, "segment_ids", Value::nums(&expanded));
            }
            // The pieces take consecutive places in the combined drawing order.
            let mut drawables: Vec<(bool, usize, f64)> = Vec::new();
            for (i, p) in polygons.iter().enumerate() {
                drawables.push((false, i, order_value(p.get("z_order"), 0.0)?));
            }
            for (i, s) in originals.iter().enumerate() {
                drawables.push((true, i, order_value(s.get("z_order"), i as f64 + 1.0)?));
            }
            drawables.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
            let mut segments_out: Vec<Option<Value>> = originals.iter().cloned().map(Some).collect();
            let mut piece_values: HashMap<usize, (Value, Value)> = HashMap::new();
            let mut order = 0.0;
            let number = |item: &mut Value, order: &mut f64| {
                set(item, "z_order_runtime_raw", Value::Num(*order));
                *order += 1.0;
                set(item, "z_order", Value::Num(*order));
            };
            for (is_segment, index, _) in drawables {
                if !is_segment {
                    number(&mut polygons[index], &mut order);
                    continue;
                }
                let id = num(&originals[index], "segment_id").unwrap_or(f64::NAN);
                match piece_of(id) {
                    Some((_, first, second)) => {
                        let (mut first, mut second) = (first.clone(), second.clone());
                        number(&mut first, &mut order);
                        number(&mut second, &mut order);
                        piece_values.insert(index, (first, second));
                    }
                    None => number(segments_out[index].as_mut().unwrap(), &mut order),
                }
            }
            let mut next = Vec::new();
            for (index, segment) in segments_out.into_iter().enumerate() {
                match piece_values.remove(&index) {
                    Some((first, second)) => {
                        next.push(first);
                        next.push(second);
                    }
                    None => next.push(segment.unwrap()),
                }
            }
            let joint = next.iter().position(|s| selected_handle.is_some_and(|h| given(s, "segment_id") == Some(h)));
            let had_polygons = figure.get("polyfills").is_some();
            if let Some(record) = editor.edit_figure(at) {
                if had_polygons {
                    record.set("polyfills", Value::array(polygons));
                }
                record.set("segments", Value::array(next));
            }
            editor.selection.joint = joint.map_or(-1, |j| j as i64);
            Ok(())
        })
    }

    /// `duplicateSegment({angleOffset, parentId, branch, flip})` and `duplicateSegmentBranch`: a
    /// copy of the selected segment (or its branch, with its polygons) hung from a handle, turned
    /// or flipped; every pose gains the copies' angles.
    fn duplicate_segment(&mut self, options: Option<&Value>, force_branch: bool) -> Result<Value, EditError> {
        let mut options = match options {
            None => Obj::new(),
            Some(Value::Null) => return Err(EditError::Unported("duplicate options that are null".into())),
            Some(o) => o.as_obj().cloned().ok_or_else(|| EditError::Unported("duplicate options that are not an object".into()))?,
        };
        if force_branch {
            options.set("branch", Value::Bool(true));
        }
        let offset = match options.get("angleOffset") {
            None => 0.0,
            Some(Value::Num(n)) if n.is_finite() => *n,
            Some(_) => return Err(crate::out_of_range("errors.editorBuilder.mustBeAFiniteNumberBetweenAnd", "Branch rotation", ("minimum", "maximum"), (f64::NEG_INFINITY, f64::INFINITY))),
        };
        let flag = |key: &str| match options.get(key) {
            None => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(invalid("errors.editorBuilder.chooseWhetherToDuplicateTheWholeBranchAnd")),
        };
        let (whole, flip) = (flag("branch")?, flag("flip")?);
        let Some((_, figure)) = self.topology_figure()? else { return Ok(Value::Bool(false)) };
        let segments = items(figure.get("segments"));
        let Some(joint) = usize::try_from(self.selection.joint).ok().filter(|&j| j < segments.len()) else { return Ok(Value::Bool(false)) };
        let selected = segments[joint].clone();
        let anchor = options.get("parentId").filter(|p| !p.is_null()).cloned().or_else(|| selected.get("parent_id").cloned()).unwrap_or(Value::Null);
        let anchor_id = anchor.as_f64().filter(|a| a.fract() == 0.0 && a.is_finite());
        let Some(anchor_id) = anchor_id.filter(|a| *a == 0.0 || segments.iter().any(|s| given(s, "segment_id") == Some(*a))) else {
            return Err(invalid("errors.editorBuilder.chooseAnExistingParentHandle"));
        };
        let indices = if whole { crate::builder::branch(&figure, joint, true, false).indices } else { vec![joint] };
        let pi = std::f64::consts::PI;
        let angle_of = move |angle: f64| (if flip { if angle < 0.0 { -pi - angle } else { pi - angle } } else { angle }) + offset;
        let ids: Vec<f64> = indices.iter().map(|&i| num(&segments[i], "segment_id").unwrap_or(f64::NAN)).collect();
        let first_id = segments.iter().filter_map(|s| num(s, "segment_id")).fold(f64::NEG_INFINITY, f64::max) + 1.0;
        if segments.len() + indices.len() > MAX_SEGMENTS {
            return Err(invalid("errors.editorBuilder.aFigureSupportsAtMost30000Segments"));
        }
        let mut available = Vec::new();
        if first_id + indices.len() as f64 - 1.0 <= 65535.0 {
            available.extend((0..indices.len()).map(|i| first_id + i as f64));
        } else {
            let used: HashSet<u64> = segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).collect();
            let mut id = 1.0;
            while id <= 65535.0 && available.len() < indices.len() {
                if !used.contains(&key_of(id)) {
                    available.push(id);
                }
                id += 1.0;
            }
        }
        if available.len() != indices.len() {
            return Err(invalid("errors.editorBuilder.theFigureHasNoFreeNativeJointIds"));
        }
        let remap: Vec<(f64, f64)> = ids.iter().copied().zip(available.iter().copied()).collect();
        let map = |id: f64| remap.iter().find(|(from, _)| *from == id).map(|(_, to)| *to);
        let initial = segments.len();
        let selected_id = num(&selected, "segment_id").unwrap_or(f64::NAN);
        let selected_parent = given(&selected, "parent_id");
        let label = format!("Duplicate {}", if whole { "segment branch" } else { "segment" });
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let topology = TopologyOptions { segment_map: remap.iter().map(|&(from, to)| (from, vec![from, to])).collect(), replaced: false, ..TopologyOptions::default() };
        self.topology_edit(&label, topology, |editor, at| {
            let figure = editor.figure_at(at);
            let all = items(figure.get("segments"));
            let polygons_now = items(figure.get("polyfills"));
            let max_order = all.iter().map(|s| given(s, "z_order").unwrap_or(0.0)).chain(polygons_now.iter().map(|p| given(p, "z_order").unwrap_or(0.0))).fold(0.0f64, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) });
            let mut copies = Vec::new();
            for &i in &indices {
                let original = &all[i];
                let mut segment = original.clone();
                remove(&mut segment, "_logical_segment_id");
                let own = num(original, "segment_id").unwrap_or(f64::NAN);
                set(&mut segment, "segment_id", map(own).map_or(Value::Null, Value::Num));
                remap_rig_references(&mut segment, &remap)?;
                let parent = if own == selected_id { Value::Num(anchor_id) } else { given(original, "parent_id").and_then(map).map_or(Value::Null, Value::Num) };
                set(&mut segment, "parent_id", parent);
                let turned = angle_of(given(&segment, "angle_rad").unwrap_or(f64::NAN));
                set(&mut segment, "angle_rad", Value::Num(turned));
                if flip {
                    let bend = given(&segment, "bend_rad").unwrap_or(0.0);
                    set(&mut segment, "bend_rad", Value::Num(-bend));
                }
                let code = given(&segment, "primitive_code");
                if code == Some(2.0) && flip {
                    let flag = segment.get("extra_u8_b").filter(|v| !v.is_null()).cloned().or_else(|| segment.get("extra").and_then(|e| e.item(2)).filter(|v| !v.is_null()));
                    set(&mut segment, "extra_u8_b", Value::Num(if flag.is_some_and(|f| f.truthy()) { 0.0 } else { 1.0 }));
                }
                if code == Some(5.0) {
                    set(&mut segment, "extra_u8_a", Value::Num(0.0));
                    set(&mut segment, "extra_u8_b", Value::Num(0.0));
                }
                if (code == Some(2.0) || code == Some(5.0)) && segment.get("extra").is_some_and(Value::is_array) {
                    let extra = items(segment.get("extra"));
                    let pick = |key: &str, i: usize| segment.get(key).filter(|v| !v.is_null()).cloned().or_else(|| extra.get(i).cloned()).unwrap_or(Value::Null);
                    let values = vec![extra.first().cloned().unwrap_or(Value::Null), pick("extra_u8_a", 1), pick("extra_u8_b", 2)];
                    set(&mut segment, "extra", Value::array(values));
                }
                copies.push(segment);
            }
            let in_branch = |id: f64| ids.contains(&id);
            let mut polygons: Vec<Value> = if whole {
                polygons_now
                    .iter()
                    .filter(|p| {
                        let handles = numbers(p.get("segment_ids"));
                        handles.iter().all(|h| in_branch(*h) || Some(*h) == selected_parent) && handles.iter().any(|h| in_branch(*h))
                    })
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            if polygons_now.len() + polygons.len() > 20000 {
                return Err(invalid("errors.editorBuilder.aFigureSupportsAtMost20000Polygons"));
            }
            let mut polygon_id = polygons_now.iter().enumerate().map(|(i, p)| given(p, "polyfill_id").unwrap_or(i as f64 + 1.0)).fold(0.0f64, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) });
            for polygon in polygons.iter_mut() {
                polygon_id += 1.0;
                set(polygon, "polyfill_id", Value::Num(polygon_id));
                let handles: Vec<f64> = numbers(polygon.get("segment_ids")).into_iter().map(|h| map(h).unwrap_or(anchor_id)).collect();
                set(polygon, "segment_ids", Value::nums(&handles));
                set(polygon, "segment_ids_raw", Value::nums(&handles));
                if let Some(surface) = polygon.get("_stykSurface").filter(|s| s.truthy()).and_then(Value::as_obj).cloned() {
                    let mut next = surface.clone();
                    next.set("basis", Value::nums(&numbers(surface.get("basis")).into_iter().map(|h| map(h).unwrap_or(h)).collect::<Vec<_>>()));
                    if surface.get("depth").is_some_and(Value::truthy) {
                        next.set("depth", Value::nums(&numbers(surface.get("depth")).into_iter().map(|h| map(h).unwrap_or(h)).collect::<Vec<_>>()));
                    }
                    set(polygon, "_stykSurface", Value::object(next));
                }
            }
            // Copies and polygons above everything, in the order of their old draw order.
            let mut ordered: Vec<(bool, usize, f64)> = copies.iter().enumerate().map(|(i, c)| (true, i, given(c, "z_order").unwrap_or(0.0))).chain(polygons.iter().enumerate().map(|(i, p)| (false, i, given(p, "z_order").unwrap_or(0.0)))).collect();
            ordered.sort_by(|a, b| {
                let d = a.2 - b.2;
                if d < 0.0 { std::cmp::Ordering::Less } else if d > 0.0 { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal }
            });
            for (position, (is_copy, index, _)) in ordered.into_iter().enumerate() {
                let item = if is_copy { &mut copies[index] } else { &mut polygons[index] };
                let z = max_order + position as f64 + 1.0;
                set(item, "z_order", Value::Num(z));
                set(item, "z_order_runtime_raw", Value::Num(z - 1.0));
            }
            for (place, slots) in instances(&editor.report, &type_id) {
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in slots {
                    let mut pose = Pose::of(&list[slot]);
                    let added: Vec<f64> = indices.iter().map(|&i| angle_of(pose.angles.get(i).copied().unwrap_or(f64::NAN))).collect();
                    pose.angles.extend(added);
                    if let Some(l) = pose.lengths.as_mut() {
                        let added: Vec<f64> = indices.iter().map(|&i| l.get(i).copied().unwrap_or(f64::NAN)).collect();
                        l.extend(added);
                    }
                    if let Some(b) = pose.bends.as_mut() {
                        let added: Vec<f64> = indices.iter().map(|&i| (if flip { -1.0 } else { 1.0 }) * b.get(i).copied().unwrap_or(f64::NAN)).collect();
                        b.extend(added);
                    }
                    pose.write(&mut list[slot]);
                }
            }
            let mut next_segments = all.clone();
            next_segments.extend(copies);
            let mut next_polygons = polygons_now.clone();
            next_polygons.extend(polygons);
            if let Some(record) = editor.edit_figure(at) {
                record.set("segments", Value::array(next_segments));
                record.set("polyfills", Value::array(next_polygons));
            }
            editor.selection.joint = indices.iter().position(|&i| i == joint).map_or(-1, |p| (initial + p) as i64);
            Ok(())
        })?;
        let mut result = Obj::new();
        result.set("handleIds", Value::array(ids.iter().map(|id| map(*id).map_or(Value::Null, Value::Num)).collect()));
        result.set("selectedHandleId", map(selected_id).map_or(Value::Null, Value::Num));
        Ok(Value::object(result))
    }

    /// `replaceFigureDefinition(figureTypeId, definition, {label})`: a definition replaced, every
    /// pose keeping its handles' offsets from the old definition, figures joined to a handle
    /// that is gone staying where they were drawn. Returns the definition stored.
    fn replace_figure_definition(&mut self, type_id: Option<&Value>, definition: Option<&Value>, options: Option<&Value>) -> Result<Value, EditError> {
        let type_id = type_id.cloned().unwrap_or(Value::Null);
        let figures = items(self.report.get("figure_types"));
        let Some(index) = figures.iter().position(|f| f.get("figure_type_id").is_some_and(|id| crate::history::js_strict_eq(id, &type_id))) else {
            return Err(invalid("errors.editor.theFigureDefinitionDoesNotExist"));
        };
        let definition = definition.cloned().unwrap_or(Value::Null);
        let new_segments = items(definition.get("segments"));
        if !definition.truthy() || !definition.get("segments").is_some_and(Value::is_array) || new_segments.is_empty() {
            return Err(invalid("errors.editor.aFigureNeedsAtLeastOneSegment"));
        }
        let label = match options.and_then(|o| o.get("label")) {
            None => "Edit figure definition".to_string(),
            Some(Value::Str(text)) => text.to_string(),
            Some(_) => return Err(EditError::Unported("a definition label that is not text".into())),
        };
        let mut replacement = definition.as_obj().cloned().ok_or_else(|| EditError::Unported("a definition that is not an object".into()))?;
        replacement.set("figure_type_id", type_id.clone());
        replacement.set("segment_count", Value::Num(new_segments.len() as f64));
        let replacement = Value::object(replacement);
        let old = figures[index].clone();
        let old_segments = items(old.get("segments"));
        let old_index = |id: Option<f64>| id.and_then(|id| old_segments.iter().rposition(|s| handle(s.get("segment_id")) == Some(id)));
        let handles: HashSet<u64> = new_segments.iter().filter_map(|s| handle(s.get("segment_id"))).map(key_of).chain([0]).collect();
        let selected_type = self.object()?.and_then(|(_, o)| o.get("figure_type_id").cloned());
        let stored = replacement.clone();
        let options = TopologyOptions { replaced: true, ..TopologyOptions::default() };
        self.topology_edit_of(Some(index), &label, options, |editor, at| {
            for place in places(&editor.report) {
                let objects = items(frame_at(&editor.report, &place).and_then(|f| f.get("objects")));
                let detached: Vec<usize> = (0..objects.len())
                    .filter(|&slot| {
                        let join = objects[slot].get("join").filter(|j| j.truthy());
                        join.is_some_and(|j| !handle(j.get("target_handle_id")).is_some_and(|h| handles.contains(&key_of(h))))
                            && join_target(&objects[slot]).and_then(|p| objects.get(p)).is_some_and(|p| p.get("figure_type_id").is_some_and(|id| crate::history::js_strict_eq(id, &type_id)))
                    })
                    .collect();
                let joints = if detached.is_empty() { HashMap::new() } else { editor.component_joints(&place, &detached)? };
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in detached {
                    if let Some(geometry) = joints.get(&slot) {
                        let root = geometry.root();
                        set(&mut list[slot], "root_x", Value::Num(root[0]));
                        set(&mut list[slot], "root_y", Value::Num(root[1]));
                    }
                    set(&mut list[slot], "join", Value::Null);
                }
                for object in list.iter_mut() {
                    if !object.get("figure_type_id").is_some_and(|id| crate::history::js_strict_eq(id, &type_id)) {
                        continue;
                    }
                    let pose = Pose::of(object);
                    let at_old = |s: &Value| old_index(handle(s.get("segment_id")));
                    let angles = new_segments
                        .iter()
                        .map(|s| {
                            let angle = given(s, "angle_rad").unwrap_or(f64::NAN);
                            match at_old(s) {
                                None => angle,
                                Some(i) => angle + pose.angles.get(i).copied().unwrap_or(f64::NAN) - given(&old_segments[i], "angle_rad").unwrap_or(f64::NAN),
                            }
                        })
                        .collect();
                    let lengths = pose.lengths.as_ref().map(|lengths| {
                        new_segments
                            .iter()
                            .map(|s| {
                                let length = given(s, "length").unwrap_or(f64::NAN);
                                match at_old(s) {
                                    None => length,
                                    Some(i) => {
                                        let base = given(&old_segments[i], "length").unwrap_or(f64::NAN);
                                        let own = lengths.get(i).copied().unwrap_or(f64::NAN);
                                        if base.abs() > 1e-9 { length * own / base } else { own }
                                    }
                                }
                            })
                            .collect()
                    });
                    let bends = pose.bends.as_ref().map(|bends| {
                        new_segments
                            .iter()
                            .map(|s| {
                                let bend = given(s, "bend_rad").unwrap_or(0.0);
                                bend + match at_old(s) {
                                    None => 0.0,
                                    Some(i) => bends.get(i).copied().unwrap_or(f64::NAN) - given(&old_segments[i], "bend_rad").unwrap_or(0.0),
                                }
                            })
                            .collect()
                    });
                    Pose { angles, lengths, bends }.write(object);
                }
            }
            if let Some(slot) = editor.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(at)) {
                *slot = stored.clone();
            }
            if selected_type.as_ref().is_some_and(|t| crate::history::js_strict_eq(t, &type_id)) {
                editor.selection.joint = editor.selection.joint.min(new_segments.len() as i64 - 1);
            }
            Ok(())
        })?;
        Ok(self.figure_at(index))
    }

    /// `appendRigJoint(editor, definition, label)`: a rig joint (a connector, a weighted joint)
    /// appended to the selected figure and every pose of it.
    fn append_rig_joint(&mut self, definition: Obj, label: &str) -> Result<Value, EditError> {
        let Some((_, figure)) = self.topology_figure()? else { return Err(invalid("errors.editorRigConstraints.selectAFigureBeforeAddingARigJoint")) };
        let segments = items(figure.get("segments"));
        if segments.len() >= MAX_SEGMENTS {
            return Err(invalid("errors.editorRigConstraints.figureSegmentCapacityReached"));
        }
        let id = segments.iter().filter_map(|s| num(s, "segment_id")).fold(0.0, f64::max) + 1.0;
        if id > 65535.0 {
            return Err(invalid("errors.editorBuilderBranch.figureJointCapacityReached"));
        }
        let mut segment = Obj::new();
        segment.set("segment_id", Value::Num(id));
        segment.set("bend_rad", Value::Num(0.0));
        segment.set("thickness", Value::Num(0.0));
        segment.set("primitive_code", Value::Num(0.0));
        segment.set("aux_code", Value::Num(0.0));
        segment.set("flags", Value::Num(0.0));
        segment.set("segment_type", Value::str("line"));
        segment.set("segment_kind", Value::str("line"));
        segment.set("color_rgb", Value::nums(&[13.0, 153.0, 255.0]));
        segment.set("transparency", Value::Num(0.0));
        segment.set("visible", Value::Bool(true));
        segment.set("z_order", Value::Num((segments.len() + 1) as f64));
        for (key, value) in definition.iter() {
            segment.set(key, value.clone());
        }
        let segment = Value::object(segment);
        let mut proposed = segments.clone();
        proposed.push(segment.clone());
        crate::rig_behavior::validate_rig(&proposed)?;
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let angle = given(&segment, "angle_rad").unwrap_or(f64::NAN);
        let length = given(&segment, "length").unwrap_or(f64::NAN);
        let added = segment.clone();
        self.topology_edit(label, TopologyOptions { history_append_only: true, ..TopologyOptions::default() }, |editor, at| {
            let mut all = items(editor.figure_at(at).get("segments"));
            all.push(added.clone());
            let total = all.len();
            if let Some(record) = editor.edit_figure(at) {
                record.set("segments", Value::array(all));
            }
            for (place, slots) in instances(&editor.report, &type_id) {
                let Some(list) = objects_mut(&mut editor.report, &place) else { continue };
                for slot in slots {
                    let mut pose = Pose::of(&list[slot]);
                    pose.angles.push(angle);
                    if let Some(l) = pose.lengths.as_mut() {
                        l.push(length);
                    }
                    if let Some(b) = pose.bends.as_mut() {
                        b.push(0.0);
                    }
                    pose.write(&mut list[slot]);
                }
            }
            editor.selection.joint = total as i64 - 1;
            Ok(())
        })?;
        Ok(segment)
    }

    /// `addConnector(start, end, {position, thickness})`: a joint sliding between two handles of
    /// the selected figure, its rest span as they are on show.
    fn add_connector(&mut self, start: Option<&Value>, end: Option<&Value>, options: Option<&Value>) -> Result<Value, EditError> {
        let Some((_, object)) = self.object()? else { return Err(invalid("errors.editorRigConstraints.selectAFigureBeforeConnectingItsJoints")) };
        let options = match options {
            None => Value::object(Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("connector options that are null".into())),
            Some(o) => o.clone(),
        };
        let range = |value: Option<&Value>, label: &str, fallback: f64, min: f64, max: f64| match value {
            None => Ok(fallback),
            Some(Value::Num(n)) if n.is_finite() && *n >= min && *n <= max => Ok(*n),
            Some(_) => Err(crate::out_of_range("errors.cameraMotion.mustBeBetweenAnd", label, ("min", "max"), (min, max))),
        };
        let position = range(options.get("position"), "Slide position", 0.5, 0.0, 1.0)?;
        let thickness = range(options.get("thickness"), "Thickness", 6.0, 0.0, 1e6)?;
        let (start, end) = (start.cloned().unwrap_or(Value::Null), end.cloned().unwrap_or(Value::Null));
        let (prepared, frame, scene) = self.evaluate()?;
        let evaluated = frame.objects.iter().find(|o| Some(o.uid) == uid(&object));
        let geometry = evaluated.and_then(|o| scene.objects.iter().find(|g| g.uid == o.uid && g.resolved));
        let figure = evaluated.and_then(|o| o.figure_override.clone().or_else(|| prepared.doc.figure(o.figure).cloned()));
        let joint = |id: &Value| -> Option<[f64; 2]> {
            let id = id.as_f64().filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= u32::MAX as f64)?;
            geometry?.joint(figure.as_deref()?, id as u32)
        };
        let (a, b) = (joint(&start), joint(&end));
        let (Some(a), Some(b)) = (a, b) else { return Err(invalid("errors.editorRigConstraints.chooseTwoDifferentJointsInThisFigure")) };
        if crate::history::js_strict_eq(&start, &end) {
            return Err(invalid("errors.editorRigConstraints.chooseTwoDifferentJointsInThisFigure"));
        }
        let scale = given(&object, "scale").unwrap_or(f64::NAN).abs();
        let span = styk_math::hypot(b[0] - a[0], b[1] - a[1]) / if scale.is_nan() { f64::NAN } else { scale.max(1e-8) };
        if span < 1e-8 {
            return Err(invalid("errors.editorRigConstraints.separateTheAnchorsBeforeCreatingAConnectorThey"));
        }
        let mut connector = Obj::new();
        connector.set("start", start.clone());
        connector.set("end", end);
        connector.set("restLength", Value::Num(span));
        let mut rig = Obj::new();
        rig.set("connector", Value::object(connector));
        let mut definition = Obj::new();
        definition.set("parent_id", start);
        definition.set("length", Value::Num(position));
        definition.set("angle_rad", Value::Num(styk_math::atan2(b[1] - a[1], b[0] - a[0])));
        definition.set("thickness", Value::Num(thickness));
        definition.set("_stykRig", Value::object(rig));
        self.append_rig_joint(definition, "Connect joints")
    }

    /// `addWeightedJoint(origin, anchors)`: a joint placed by weighted anchors.
    fn add_weighted_joint(&mut self, origin: Option<&Value>, anchors: Option<&Value>) -> Result<Value, EditError> {
        let mut weighted = Obj::new();
        weighted.set("origin", origin.cloned().unwrap_or(Value::Null));
        weighted.set("anchors", anchors.cloned().unwrap_or(Value::Null));
        let mut rig = Obj::new();
        rig.set("weighted", Value::object(weighted));
        let mut definition = Obj::new();
        definition.set("parent_id", origin.cloned().unwrap_or(Value::Null));
        definition.set("length", Value::Num(0.0));
        definition.set("angle_rad", Value::Num(0.0));
        definition.set("name", Value::str("Weighted joint"));
        definition.set("_stykRig", Value::object(rig));
        self.append_rig_joint(definition, "Add weighted joint")
    }
}

/// Gradient reversal belongs to the topology/style owner (editor-style-topology.mjs).
fn reverse_gradient(mut segment: Value) -> Value {
    if let Some(shape) = segment.get("_sticknodes").filter(|s| s.truthy()).cloned() {
        let mut shape = shape; let reversed = !truthy(&shape, "reversed");
        set(&mut shape, "reversed", Value::Bool(reversed)); set(&mut segment, "_sticknodes", shape);
    }
    if matches!(segment.path(&["paint", "type"]).and_then(Value::as_str), Some("radial" | "angular" | "diamond")) {
        let mut paint = segment.get("paint").cloned().unwrap();
        let angle = num(&paint, "angle").unwrap_or(f64::NAN) - 180.0;
        set(&mut paint, "angle", Value::Num(angle)); set(&mut segment, "paint", paint); return segment;
    }
    let Some(mut secondary) = segment.get("secondary").filter(|s| s.truthy()).cloned() else { return segment };
    let opacity = match segment.get("transparency") { Some(value) => 1.0 - value.as_f64().unwrap_or(0.0) / 255.0, None => given(&segment, "color_alpha").unwrap_or(1.0) };
    let transparency = given(&secondary, "a").unwrap_or(0.0);
    let color = segment.get("color_rgb").cloned().unwrap_or(Value::Null);
    let end = secondary.get("rgb").cloned().unwrap_or(Value::Null);
    if let Some(mut paint) = segment.get("paint").filter(|s| s.truthy()).cloned() {
        let mut stops = items(paint.get("stops"));
        for stop in &mut stops { let offset = 1.0 - num(stop, "offset").unwrap_or(f64::NAN); set(stop, "offset", Value::Num(offset)); }
        stops.reverse(); set(&mut paint, "stops", Value::array(stops)); set(&mut segment, "paint", paint);
    }
    set(&mut segment, "color_rgb", end); set(&mut segment, "transparency", Value::Num(transparency));
    if segment.get("color_alpha").is_some() { set(&mut segment, "color_alpha", Value::Num(1.0 - transparency / 255.0)); }
    set(&mut secondary, "rgb", color); set(&mut secondary, "a", Value::Num(crate::range_plan::js_round(255.0 * (1.0 - opacity))));
    set(&mut segment, "secondary", secondary); segment
}

fn reverse_overrides(style: &Value, swap: bool) -> Value {
    if let Some(mut paint) = style.get("paint").filter(|p| p.truthy()).cloned() {
        if paint.get("type").and_then(Value::as_str) != Some("solid") {
            let angle = ((num(&paint, "angle").unwrap_or(f64::NAN) - 180.0) % 360.0 + 540.0) % 360.0 - 180.0;
            set(&mut paint, "angle", Value::Num(angle));
        }
        let mut out = style.clone(); set(&mut out, "paint", paint); return out;
    }
    if !swap { return style.clone(); }
    let mut out = style.clone();
    for field in ["opacity", "gradientOpacity"] { remove(&mut out, field); }
    if let Some(v) = style.get("opacity") { set(&mut out, "gradientOpacity", v.clone()); }
    if let Some(v) = style.get("gradientOpacity") { set(&mut out, "opacity", v.clone()); }
    for field in ["color", "gradientColor"] { remove(&mut out, field); }
    if let Some(v) = style.get("color") { set(&mut out, "gradientColor", v.clone()); }
    if let Some(v) = style.get("gradientColor") { set(&mut out, "color", v.clone()); }
    out
}

impl Editor {
    fn set_origin(&mut self, requested: Option<&Value>) -> Result<bool, EditError> {
        let Some((index, figure)) = self.topology_figure()? else { return Ok(false) };
        let segments = items(figure.get("segments"));
        if segments.iter().any(|s| truthy(s, "_stykRig")) { return Err(invalid("errors.editor.setTheFigureOriginBeforeConfiguringRigRelationships")); }
        let selected = usize::try_from(self.selection.joint).ok().and_then(|i| segments.get(i)).and_then(|s| handle(s.get("segment_id")));
        let id = requested.map(|v| v.as_f64().unwrap_or(f64::NAN)).or(selected);
        if id == Some(0.0) { return Ok(false); }
        let Some(id) = id.filter(|id| id.fract() == 0.0 && segments.iter().any(|s| handle(s.get("segment_id")) == Some(*id))) else { return Err(invalid("errors.editor.selectAValidJointForTheNewOrigin")); };
        let remap = |value: f64| if value == 0.0 { id } else if value == id { 0.0 } else { value };
        let mut adjacent: HashMap<u64, Vec<(f64, usize)>> = HashMap::new();
        for (i, segment) in segments.iter().enumerate() {
            let (parent, child) = (given(segment, "parent_id").unwrap_or(f64::NAN), given(segment, "segment_id").unwrap_or(f64::NAN));
            adjacent.entry(key_of(parent)).or_default().push((child, i)); adjacent.entry(key_of(child)).or_default().push((parent, i));
        }
        let mut visited = HashSet::from([key_of(id)]); let mut queue = vec![id];
        let mut edges: Vec<Option<OriginEdge>> = vec![None; segments.len()];
        let mut cursor = 0;
        while cursor < queue.len() {
            for &(other, i) in adjacent.get(&key_of(queue[cursor])).map(Vec::as_slice).unwrap_or(&[]) {
                if !visited.insert(key_of(other)) { continue; }
                queue.push(other);
                edges[i] = Some(OriginEdge { old_id: num(&segments[i], "segment_id").unwrap(), parent: remap(queue[cursor]), id: remap(other), reverse: given(&segments[i], "parent_id") != Some(queue[cursor]) });
            }
            cursor += 1;
        }
        let edges = edges.into_iter().collect::<Option<Vec<_>>>().ok_or_else(|| EditError::Unported("Set Origin on disconnected geometry".into()))?;
        if edges.iter().enumerate().any(|(i, edge)| edge.reverse && matches!(segments[i].get("segment_type").and_then(Value::as_str), Some("image" | "text"))) { return Err(invalid("errors.editor.chooseAnOriginWhosePathContainsOrdinaryLines")); }
        let previous = figure.path(&["_styk", "animationOrigin"]);
        let origin = if let Some(previous) = previous.filter(|o| truthy(o, "support")) { previous.clone() } else {
            let reference = match previous { Some(origin) => segments.iter().position(|s| s.get("segment_id") == origin.get("rotationHandleId")), None => Some(0) }.ok_or_else(|| EditError::Unported("a missing animation rotation handle".into()))?;
            let mut origin = Obj::new();
            origin.set("handleId", Value::Num(remap(previous.and_then(|o| given(o, "handleId")).unwrap_or(0.0))));
            origin.set("rotationHandleId", Value::Num(edges[reference].id));
            origin.set("reversed", Value::Bool(previous.is_some_and(|o| truthy(o, "reversed")) != edges[reference].reverse));
            Value::object(origin)
        };
        let options = TopologyOptions { segment_map: edges.iter().map(|e| (e.old_id, vec![e.id])).collect(), reversed_gradients: edges.iter().filter(|e| e.reverse).map(|e| key_of(e.old_id)).collect(), origin_reroot: Some(OriginReroot { handle: id, edges: edges.clone() }), ..TopologyOptions::default() };
        self.topology_edit_of(Some(index), "Set figure origin", options, |editor, at| {
            let type_id = figure.get("figure_type_id");
            for place in places(&editor.report) {
                let objects = items(frame_at(&editor.report, &place).and_then(|f| f.get("objects")));
                let slots: Vec<usize> = objects.iter().enumerate().filter(|(_, o)| o.get("figure_type_id") == type_id).map(|(i, _)| i).collect();
                if slots.is_empty() { continue; }
                let geometry = editor.component_joints(&place, &slots)?;
                let mut next = objects.clone();
                for object in &mut next {
                    if join_target(object).and_then(|i| objects.get(i)).is_some_and(|p| p.get("figure_type_id") == type_id) {
                        if let Some(join) = object.make_obj().and_then(|o| o.get_mut("join")).and_then(Value::make_obj) {
                            let target = join.get("target_handle_id").and_then(Value::as_f64).unwrap_or(f64::NAN); join.set("target_handle_id", Value::Num(remap(target)));
                        }
                    }
                }
                for slot in slots {
                    let old = &objects[slot]; let object = &mut next[slot];
                    let old_pose = old.get("_stykAnimationOrigin");
                    let point = if old_pose.is_some() && !truthy(old, "join") { old_pose.map(|o| [num(o, "x").unwrap_or(f64::NAN), num(o, "y").unwrap_or(f64::NAN)]) }
                        else if previous.is_some() && old_pose.is_some() && truthy(old, "join") {
                            let (typed, pose) = editor.origin_view(&figure, old)?;
                            let offset = styk_eval::origin::offset(&typed, &pose);
                            geometry.get(&slot).map(|g| { let root = g.root(); [root[0] + offset[0], root[1] + offset[1]] })
                        } else { geometry.get(&slot).and_then(|g| g.get(previous.and_then(|o| given(o, "handleId")).unwrap_or(0.0))) };
                    if let Some(point) = point {
                        let mut pivot = old_pose.and_then(Value::as_obj).cloned().unwrap_or_default(); pivot.set("x", Value::Num(point[0])); pivot.set("y", Value::Num(point[1])); set(object, "_stykAnimationOrigin", Value::object(pivot));
                    }
                    if let Some(point) = geometry.get(&slot).and_then(|g| g.get(id)) { set(object, "root_x", Value::Num(point[0])); set(object, "root_y", Value::Num(point[1])); }
                    set(object, "join", Value::Null);
                    let mut pose = Pose::of(old);
                    for (i, _) in edges.iter().enumerate().filter(|(_, e)| e.reverse) {
                        let bend = pose.bends.as_ref().and_then(|b| b.get(i)).copied().unwrap_or_else(|| given(&segments[i], "bend_rad").unwrap_or(0.0));
                        pose.angles[i] += bend + std::f64::consts::PI;
                        if let Some(bends) = pose.bends.as_mut() { bends[i] = -bend; }
                    }
                    pose.write(object);
                }
                if let Some(list) = objects_mut(&mut editor.report, &place) { *list = next; }
            }
            let next: Vec<Value> = segments.iter().enumerate().map(|(i, s)| {
                let edge = &edges[i]; let mut out = s.clone(); set(&mut out, "parent_id", Value::Num(edge.parent)); set(&mut out, "segment_id", Value::Num(edge.id));
                if edge.reverse { let bend = given(s, "bend_rad").unwrap_or(0.0); set(&mut out, "angle_rad", Value::Num(num(s, "angle_rad").unwrap() + (bend + std::f64::consts::PI))); set(&mut out, "bend_rad", Value::Num(-bend)); reverse_gradient(out) } else { out }
            }).collect();
            let mut polygons = items(figure.get("polyfills"));
            for polygon in &mut polygons {
                set(polygon, "segment_ids", Value::nums(&numbers(polygon.get("segment_ids")).into_iter().map(remap).collect::<Vec<_>>()));
                if let Some(mut surface) = polygon.get("_stykSurface").filter(|s| s.truthy()).cloned() {
                    for key in ["basis", "depth"] { if surface.get(key).is_some() { let ids = numbers(surface.get(key)).into_iter().map(remap).collect::<Vec<_>>(); set(&mut surface, key, Value::nums(&ids)); } }
                    set(polygon, "_stykSurface", surface);
                }
            }
            if let Some(record) = editor.edit_figure(at) {
                record.set("segments", Value::array(next));
                let mut metadata = record.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default(); metadata.set("animationOrigin", origin.clone()); record.set("_styk", Value::object(metadata));
                if record.get("polyfills").is_some() { record.set("polyfills", Value::array(polygons)); }
            }
            editor.selection.joint = -1; Ok(())
        })
    }
}
