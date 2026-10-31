//! The figure clipboard on a layer sheet (`copySelection`, `cutSelection`,
//! `pasteSelection`, `duplicateSelection`; `insertionPlan`
//! and `insert` for a paste at the playhead).
//!
//! The clipboard belongs to the editor that copied: a session pastes only what it copied
//! itself (the facade checks that the editor's clipboard is that object). Figures with effect
//! clips paste them too, with new random identities, in one history entry. A drawing pastes as a cel
//! of its own (a new cel identity, the pixels of the copied cel forked for the interface to copy).
//! Clipboards from another document or an older format answer `Unported` when pasted.

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::record::{num, uid};
use crate::sheet::items;
use crate::{EditError, Editor};

/// `editor._selectionClipboard`, as far as pasting it in the same document reads it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FigureClipboard {
    objects: Vec<Value>,
    figures: Vec<Value>,
    layers: Vec<(u32, String)>,
    order: Vec<u32>,
    source_version: Value,
    pub(crate) offset: f64,
    pastes: f64,
    /// The effect clips of the copied figures (`vfxClips`), pasted on the copies.
    vfx_clips: Vec<Value>,
    /// The frame the figures were copied at (`copyTick`), which timed effect clips keep their distance from.
    copy_tick: Option<f64>,
    /// From an imported file: every definition is a new one.
    foreign: bool,
    /// Where each copied movieclip instance was in its clip (`movieclipSamples`).
    movieclip_samples: Vec<(u32, f64)>,
    /// Definitions the copy made that the document does not hold (`freshTypes`, a copied branch): each pastes as a new one.
    fresh_types: Vec<f64>,
}

/// `snapshotFigureDefinition(figure)`: a copy of a definition whose immutable parts (a clip's
/// document and meshes, a figure's 3D mesh) come after its other settings, as the editor
/// shares them.
pub(crate) fn snapshot_figure_definition(figure: &Value) -> Value {
    let Some(styk) = figure.get("_styk").and_then(Value::as_obj) else { return figure.clone() };
    if let Some(mesh) = styk.get("spatialMesh") {
        let mut rest = styk.clone();
        rest.remove("spatialMesh");
        let mut without = figure.as_obj().cloned().unwrap_or_default();
        without.set("_styk", Value::object(rest));
        let mut copy = snapshot_figure_definition(&Value::object(without)).as_obj().cloned().unwrap_or_default();
        let mut styk = copy.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("spatialMesh", mesh.clone());
        copy.set("_styk", Value::object(styk));
        return Value::object(copy);
    }
    let Some(asset) = styk.get("movieclip").filter(|m| m.truthy()).and_then(Value::as_obj) else { return figure.clone() };
    let mut settings = Obj::new();
    for (key, value) in asset.iter() {
        if &**key != "document" && &**key != "spatialMeshes" {
            settings.set(key, value.clone());
        }
    }
    settings.set("document", asset.get("document").cloned().unwrap_or(Value::Null));
    if let Some(meshes) = asset.get("spatialMeshes").filter(|m| m.truthy()) {
        settings.set("spatialMeshes", meshes.clone());
    }
    let mut styk = styk.clone();
    styk.set("movieclip", Value::object(settings));
    let mut copy = figure.as_obj().cloned().unwrap_or_default();
    copy.set("_styk", Value::object(styk));
    Value::object(copy)
}

fn is_movieclip(figure: &Value) -> bool {
    figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)
}

/// `drawingMetadata(figure)`: a drawing cel.
fn is_drawing(figure: &Value) -> bool {
    figure.path(&["_styk", "drawing"]).is_some_and(Value::truthy)
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// `Number(text)` of a handle written in a key.
fn js_number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
}

/// How a segment is drawn in the frame on show (`geometry.segments[i]`): its angle, bend and scaled length, and its start.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PosedSegment {
    pub angle: f64,
    pub bend: f64,
    pub length: f64,
    pub start: [f64; 2],
}

/// `snapshotPoseObject(object)`: the pose without its evaluation caches.
pub(crate) fn snapshot_pose_object(object: &Value) -> Obj {
    let mut out = Obj::new();
    for (key, value) in object.as_obj().map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
        if &**key != "runtime_segments" && &**key != "_movieclipSample" {
            out.set(key, value.clone());
        }
    }
    out
}

/// `insert(frame, payload)`: the frame with the pasted figures, slots following unique ids,
/// pasted joins following their remapped parents, drawn in front.
pub(crate) fn insert(frame: &Value, pasted: &[Value], order: &[u32]) -> Result<Value, EditError> {
    let before = objects_of(frame);
    let replacements: HashMap<u32, Value> = pasted.iter().filter_map(|o| Some((uid(o)?, o.clone()))).collect();
    let mut objects: Vec<Value> = before.iter().map(|o| uid(o).and_then(|u| replacements.get(&u).cloned()).unwrap_or_else(|| o.clone())).collect();
    let present: Vec<u32> = before.iter().filter_map(uid).collect();
    objects.extend(pasted.iter().filter(|o| uid(o).is_some_and(|u| !present.contains(&u))).cloned());
    if objects.len() > 65535 {
        return Err(invalid("errors.editorRangeCommands.aNativeKeyframeSupportsAtMost65535"));
    }
    let id_of = |o: &Value| num(o, "unique_id").unwrap_or(f64::NAN);
    objects.sort_by(|a, b| id_of(a).partial_cmp(&id_of(b)).unwrap_or(std::cmp::Ordering::Equal));
    let slots: Vec<f64> = objects.iter().map(id_of).collect();
    let slot_of = |u: f64| slots.iter().position(|s| *s == u).map(|s| Value::Num(s as f64));
    let objects: Vec<Value> = objects
        .into_iter()
        .enumerate()
        .map(|(i, object)| {
            let join = object.get("join").filter(|j| j.truthy());
            let parent = join.and_then(|j| {
                if uid(&object).is_some_and(|u| replacements.contains_key(&u)) {
                    j.get("target_unique_id").cloned()
                } else {
                    num(j, "target_object_slot").filter(|s| *s >= 0.0).and_then(|s| before.get(s as usize)).and_then(|p| p.get("unique_id").cloned())
                }
            });
            let parent_slot = parent.as_ref().and_then(Value::as_f64).and_then(slot_of);
            let consistent = num(&object, "object_slot") == Some(i as f64)
                && join.is_none_or(|j| j.get("target_object_slot") == parent_slot.as_ref() && j.get("target_unique_id") == parent.as_ref());
            if consistent {
                return object;
            }
            let mut record = object.as_obj().cloned().unwrap_or_default();
            record.set("object_slot", Value::Num(i as f64));
            if let Some(join) = join.and_then(Value::as_obj).cloned() {
                let mut join = join;
                match parent {
                    Some(parent) => join.set("target_unique_id", parent),
                    None => {
                        join.remove("target_unique_id");
                    }
                }
                match parent_slot {
                    Some(slot) => join.set("target_object_slot", slot),
                    None => {
                        join.remove("target_object_slot");
                    }
                }
                record.set("join", Value::object(join));
            }
            Value::object(record)
        })
        .collect();
    let mut out = frame.as_obj().cloned().unwrap_or_default();
    let mut ids = crate::figures::frame_order(&out);
    ids.extend(order.iter().filter(|u| !present.contains(u)).map(|u| *u as f64));
    let count = objects.len();
    out.set("objects", Value::array(objects));
    crate::figures::set_order(&mut out, &ids);
    if out.contains("object_count") {
        out.set("object_count", Value::Num(count as f64));
    }
    Ok(Value::object(out))
}

impl Editor {
    /// Read the existing clipboard counter without copying its payload.
    pub(crate) fn figure_clipboard_pastes(&self) -> Option<f64> {
        self.figure_clipboard.as_ref().map(|clipboard| clipboard.pastes)
    }

    /// `copySelection({wholeFigures, inPlace})`: the selected figures, their definitions, layers and
    /// drawing order; `in_place` pastes them where they were (a cut). Returns how many were copied.
    pub(crate) fn copy_selection(&mut self, in_place: bool) -> Result<Value, EditError> {
        let selected = self.selected_objects()?;
        if selected.is_empty() {
            return Ok(Value::Num(0.0));
        }
        let ids: Vec<u32> = selected.iter().filter_map(uid).collect();
        // Joined figures keep where geometry draws them.
        let roots: Option<Vec<(u32, [f64; 2])>> = if selected.iter().any(|o| o.get("join").is_some_and(Value::truthy)) {
            let (_, frame, scene) = self.evaluate()?;
            Some(frame.objects.iter().filter_map(|o| scene.objects.iter().find(|g| g.uid == o.uid).map(|g| (o.uid, g.root))).collect())
        } else {
            None
        };
        let shown = self.selection_frame()?;
        let definitions: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let mut types: Vec<Value> = Vec::new();
        for object in &selected {
            let type_id = object.get("figure_type_id").cloned().unwrap_or(Value::Null);
            if !types.contains(&type_id) {
                types.push(type_id);
            }
        }
        let figures: Vec<Value> = types.iter().map(|t| definitions.iter().find(|f| f.get("figure_type_id") == Some(t)).cloned().unwrap_or(Value::Null)).collect();
        // A movieclip instance pasted again carries on from where it was when copied.
        let movieclip_samples: Vec<(u32, f64)> = selected
            .iter()
            .filter(|o| figures.iter().any(|f| f.get("figure_type_id") == o.get("figure_type_id") && is_movieclip(f)))
            .filter_map(|o| Some((uid(o)?, o.get("_movieclipSample").and_then(Value::as_f64).filter(|t| t.is_finite())?)))
            .collect();
        let vfx_clips: Vec<Value> = self.report.path(&["_styk", "vfxClips", "clips"]).and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default().into_iter()
            .filter(|c| c.path(&["target", "kind"]).and_then(Value::as_str) != Some("scene") && c.path(&["target", "uid"]).and_then(Value::as_f64).is_some_and(|u| ids.contains(&(u as u32)))).collect();
        let objects: Vec<Value> = selected
            .iter()
            .map(|object| {
                let mut out = snapshot_pose_object(object);
                if let Some(root) = roots.as_ref().and_then(|r| r.iter().find(|(u, _)| Some(*u) == uid(object))).map(|(_, root)| *root) {
                    out.set("root_x", Value::Num(root[0]));
                    out.set("root_y", Value::Num(root[1]));
                }
                if let Some(join) = out.get("join").filter(|j| j.truthy()).and_then(Value::as_obj).cloned() {
                    let target = num(&Value::object(join.clone()), "target_object_slot").filter(|s| *s >= 0.0).and_then(|s| shown.get(s as usize)).and_then(uid);
                    match target.filter(|t| ids.contains(t)) {
                        Some(target) => {
                            let mut join = join;
                            join.set("target_unique_id", Value::Num(target as f64));
                            out.set("join", Value::object(join));
                        }
                        None => out.set("join", Value::Null),
                    }
                }
                out.remove("runtime_segments");
                Value::object(out)
            })
            .collect();
        let frame = self.shown_frame()?;
        let order: Vec<u32> = crate::figures::frame_order(frame.as_obj().unwrap_or(&Obj::new())).into_iter().map(|u| u as u32).filter(|u| ids.contains(u)).collect();
        let layers = ids.iter().map(|&u| (u, self.layer_of(u))).collect();
        let count = objects.len();
        self.figure_clipboard = Some(FigureClipboard { objects, figures, layers, order, source_version: self.report.get("version").cloned().unwrap_or(Value::Null), offset: if in_place { 0.0 } else { 24.0 }, pastes: 0.0, vfx_clips, copy_tick: Some((self.tick + 0.5).floor()), foreign: false, movieclip_samples, fresh_types: Vec::new() });
        Ok(Value::Num(count as f64))
    }

    /// `copySelection({wholeFigures, inPlace})`: with a branch selected, the branch alone (unless `whole_figures`).
    pub(crate) fn copy_selection_of(&mut self, whole_figures: bool, in_place: bool) -> Result<Value, EditError> {
        if !whole_figures && self.branch_selected() {
            return self.copy_branch_selection();
        }
        self.copy_selection(in_place)
    }

    /// `cutSelection()`: copied, then deleted; pasting puts it back where it was.
    pub(crate) fn cut_selection(&mut self) -> Result<Value, EditError> {
        let count = self.copy_selection_of(false, true)?;
        if count.as_f64() == Some(0.0) {
            return Ok(Value::Num(0.0));
        }
        if let Some(clipboard) = self.figure_clipboard.as_mut() {
            clipboard.offset = 0.0;
        }
        self.delete_selection()?;
        Ok(count)
    }

    /// `copyBranchSelection()`: the selected branch extracted as a figure definition of its own (the posed angles, bends and
    /// lengths of its segments, the fills and effects that belong to it), with the figures joined below it, in the clipboard.
    fn copy_branch_selection(&mut self) -> Result<Value, EditError> {
        let zero = Ok(Value::Num(0.0));
        let Some((slot, object)) = self.object()? else { return zero };
        let figure = self.figure_value(&object);
        let segments = items(figure.get("segments"));
        let joint = self.selection.joint;
        let Some(segment) = usize::try_from(joint).ok().and_then(|joint| segments.get(joint)) else { return zero };
        if figure.path(&["_styk", "spatialMesh"]).is_some_and(Value::truthy) {
            return Err(invalid("errors.editorSelection.copyTheWholeFigureToIncludeIts3d"));
        }
        let indices = crate::builder::branch(&figure, joint as usize, true, false).indices;
        let handles: Vec<f64> = indices.iter().filter_map(|&i| num(&segments[i], "segment_id")).collect();
        let boundary = segment.get("parent_id").cloned().unwrap_or(Value::Null);
        let posed = self.posed_segments(slot)?;
        let definitions = items(self.report.get("figure_types"));
        let type_id = definitions.iter().filter_map(|f| num(f, "figure_type_id")).fold(0.0f64, f64::max) + 1.0;
        // `geometry.obj.scale ? posed.length / scale : segment.length`: a pose with no scale keeps the definition's lengths.
        let scale = object.get("scale").and_then(Value::as_f64).filter(|scale| *scale != 0.0 && !scale.is_nan());
        let name = figure.get("name").filter(|n| n.truthy()).and_then(Value::as_str).unwrap_or("Figure").to_string();

        let mut branch = figure.as_obj().cloned().unwrap_or_default();
        branch.set("figure_type_id", Value::Num(type_id));
        branch.set("name", Value::str(&format!("{name} branch")));
        let taken: Vec<Value> = indices
            .iter()
            .map(|&i| {
                let mut copy = segments[i].as_obj().cloned().unwrap_or_default();
                if copy.get("parent_id") == Some(&boundary) {
                    copy.set("parent_id", Value::Num(0.0));
                }
                if let Some(Some(pose)) = posed.get(i) {
                    copy.set("angle_rad", Value::Num(pose.angle));
                    copy.set("bend_rad", Value::Num(pose.bend));
                    if let Some(scale) = scale {
                        copy.set("length", Value::Num(pose.length / scale));
                    }
                }
                Value::object(copy)
            })
            .collect();
        branch.set("segment_count", Value::Num(taken.len() as f64));
        branch.set("segments", Value::array(taken));
        branch.remove("segment_z_raw");
        branch.remove("poly_z_raw");
        let inside = |id: f64| handles.contains(&id);
        let is_boundary = |id: &Value| id == &boundary;
        let mut fills = Vec::new();
        for polygon in items(figure.get("polyfills")) {
            let ids = items(polygon.get("segment_ids"));
            if !ids.iter().all(|id| id.as_f64().is_some_and(inside) || is_boundary(id)) {
                continue;
            }
            let remap = |id: &Value| if is_boundary(id) { Value::Num(0.0) } else { id.clone() };
            let mut fill = polygon.as_obj().cloned().unwrap_or_default();
            let moved: Vec<Value> = ids.iter().map(remap).collect();
            fill.set("segment_ids", Value::array(moved.clone()));
            if let Some(surface) = fill.get("_stykSurface").filter(|s| s.truthy()).and_then(Value::as_obj).cloned() {
                let basis = items(surface.get("basis"));
                if basis.iter().any(|id| !id.as_f64().is_some_and(inside) && !is_boundary(id)) {
                    return Err(invalid("errors.editorSelection.copyTheWholeFigureToIncludeItsFace"));
                }
                let mut next = surface.clone();
                next.set("basis", Value::array(basis.iter().map(remap).collect()));
                if surface.get("depth").is_some_and(Value::truthy) {
                    next.set("depth", Value::array(items(surface.get("depth")).iter().map(remap).collect()));
                }
                fill.set("_stykSurface", Value::object(next));
            }
            fill.set("segment_ids_raw", Value::array(moved));
            fills.push(Value::object(fill));
        }
        branch.set("polyfills", Value::array(fills));
        if let Some(mut styk) = branch.get("_styk").and_then(Value::as_obj).cloned() {
            styk.remove("animationOrigin");
            branch.set("_styk", Value::object(styk));
        }
        let branch_start = posed.get(joint as usize).and_then(Option::as_ref).map_or([f64::NAN; 2], |pose| pose.start);
        let angles: Vec<f64> = items(branch.get("segments")).iter().map(|s| num(s, "angle_rad").unwrap_or(f64::NAN)).collect();

        // The ordinary copy of the joined figures, then the selected one replaced by the branch and a fresh definition.
        let count = self.copy_selection(false)?;
        let selected = self.selection.uid;
        let Some(clipboard) = self.figure_clipboard.as_mut() else { return Ok(count) };
        let source_type = num(&object, "figure_type_id").unwrap_or(f64::NAN);
        if let Some(copy) = clipboard.objects.iter_mut().find(|o| uid(o) == selected).and_then(Value::make_obj) {
            if let Some(stacks) = copy.get("_stykVfx").filter(|v| v.truthy()).and_then(Value::as_obj).cloned() {
                let mut next = Obj::new();
                for (key, stack) in stacks.iter() {
                    if &**key == "figure" {
                        next.set(key, stack.clone());
                    } else {
                        // `const [scope, handle] = key.split('/')`.
                        let mut parts = key.split('/');
                        let (scope, handle) = (parts.next().unwrap_or(""), parts.next());
                        if let Some(handle) = handle.filter(|handle| inside(js_number(handle))) && (scope == "*" || js_number(scope) == source_type) {
                            next.set(&format!("{type_id}/{handle}"), stack.clone());
                        }
                    }
                }
                copy.set("_stykVfx", Value::object(next));
            }
            copy.set("figure_type_id", Value::Num(type_id));
            copy.set("join", Value::Null);
            copy.set("root_x", Value::Num(branch_start[0]));
            copy.set("root_y", Value::Num(branch_start[1]));
            copy.set("angles", Value::nums(&angles));
            copy.set("len_flag", Value::Num(0.0));
            copy.set("lengths", Value::array(Vec::new()));
            copy.set("bend_flag", Value::Num(0.0));
            copy.set("bends", Value::array(Vec::new()));
            copy.remove("_stykAnimationOrigin");
            // A limb controller of a joint the branch does not hold has nothing to drive (the editor refused to paste such a copy).
            if let Some(controllers) = copy.get("_stykIK").and_then(Value::as_obj).cloned()
                && controllers.keys().any(|key| !inside(js_number(key)))
            {
                let mut kept = Obj::new();
                for (key, controller) in controllers.iter().filter(|(key, _)| inside(js_number(key))) {
                    kept.set(key, controller.clone());
                }
                if kept.is_empty() { copy.remove("_stykIK"); } else { copy.set("_stykIK", Value::object(kept)); }
            }
        }
        clipboard.figures.push(Value::object(branch));
        let objects = &clipboard.objects;
        clipboard.figures.retain(|figure| objects.iter().any(|o| num(o, "figure_type_id") == num(figure, "figure_type_id")));
        clipboard.fresh_types = vec![type_id];
        Ok(count)
    }

    /// What each segment of the object at `slot` is drawn with (`geometry.objects.get(slot).segments`): by index, its
    /// angle, bend and scaled length after inverse kinematics and the rig, and where it starts. `None` for one not built.
    pub(crate) fn posed_segments(&self, slot: usize) -> Result<Vec<Option<PosedSegment>>, EditError> {
        let (prepared, frame) = self.evaluate_frame()?;
        let scene = styk_eval::geometry::build_shapes(&prepared.doc, &frame, Some(&[slot]));
        let mut posed = vec![None; scene.objects.get(slot).map_or(0, |g| g.ends.len())];
        for item in scene.measured.iter().filter(|item| item.slot as usize == slot && !matches!(item.kind, styk_eval::geometry::ItemKind::Poly | styk_eval::geometry::ItemKind::Mesh)) {
            if let Some(place) = posed.get_mut(item.index as usize) {
                *place = Some(PosedSegment { angle: item.angle, bend: item.bend, length: item.length, start: item.start });
            }
        }
        Ok(posed)
    }

    /// `pasteSelection({newIdentities, pasteMode, pasteDepth, offset})`: the clipboard's
    /// figures at the playhead, each paste a little further along. Returns the selected
    /// figures.
    pub(crate) fn paste_selection(&mut self, options: &Value) -> Result<Value, EditError> {
        let Some(clipboard) = self.figure_clipboard.clone() else { return Ok(Value::array(Vec::new())) };
        if self.tick.fract() != 0.0 {
            return Err(EditError::Unported("pasting between frames".into()));
        }
        let offset = options.get("offset").filter(|o| !o.is_null()).cloned();
        let default_offset = clipboard.offset * (clipboard.pastes + 1.0);
        let inserted = self.paste_figures(&clipboard, options, offset.as_ref(), default_offset, None, "Paste figures")?;
        if !inserted.is_empty() && offset.as_ref().is_none_or(|o| o.as_f64() != Some(0.0))
            && let Some(clipboard) = self.figure_clipboard.as_mut()
        {
            clipboard.pastes += 1.0;
        }
        Ok(Value::array(self.selected_objects()?))
    }

    /// `duplicateSelection({pasteMode, offset})`: copied and pasted with new identities as
    /// instances of the same definitions, the clipboard left as it was.
    pub(crate) fn duplicate_selection(&mut self, options: &Value) -> Result<Value, EditError> {
        self.duplicate_selection_pastes(options, None)
    }

    pub(crate) fn duplicate_selection_pastes(&mut self, options: &Value, mut pastes: Option<&mut Option<Value>>) -> Result<Value, EditError> {
        let whole_figures = options.get("wholeFigures").is_some_and(Value::truthy);
        let kept = self.figure_clipboard.clone();
        let result = (|| {
            if self.copy_selection_of(whole_figures, false)?.as_f64() == Some(0.0) {
                if let Some(pastes) = pastes.as_deref_mut() { *pastes = Some(Value::Null); }
                return Ok(Value::array(Vec::new()));
            }
            let mut paste = Obj::new();
            paste.set("newIdentities", Value::Bool(true));
            paste.set("pasteMode", options.get("pasteMode").filter(|m| !m.is_null()).cloned().unwrap_or_else(|| Value::str("instance")));
            if let Some(offset) = options.get("offset") {
                paste.set("offset", offset.clone());
            }
            let before = if pastes.is_some() { self.figure_clipboard_pastes() } else { None };
            let result = self.paste_selection(&Value::object(paste));
            if result.is_ok() && let Some(pastes) = pastes.as_deref_mut()
                && let Some((before, after)) = before.zip(self.figure_clipboard_pastes())
            {
                let mut counts = Obj::new();
                counts.set("before", Value::Num(before));
                counts.set("after", Value::Num(after));
                *pastes = Some(Value::object(counts));
            }
            result
        })();
        self.figure_clipboard = kept;
        result
    }

    /// `importFigure(document, {position})`: the figures of a file (its first frame's, else
    /// one of its first definition) as new figures and definitions, centred at `position`
    /// (the canvas's centre by default); the first of them selected.
    pub(crate) fn import_figure(&mut self, document: &Value, options: &Value) -> Result<Value, EditError> {
        let position = match options.get("position").filter(|p| p.truthy()) {
            Some(p) => {
                let (x, y) = (p.get("x").and_then(Value::as_f64), p.get("y").and_then(Value::as_f64));
                match (x, y) {
                    (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some([x, y]),
                    _ => return Err(invalid("errors.editorRangeCommands.chooseAValidCanvasPosition")),
                }
            }
            None => None,
        };
        let mut source = document.get("document").filter(|d| !d.is_null()).or_else(|| document.get("report").filter(|d| !d.is_null())).unwrap_or(document).clone();
        let definitions = |source: &Value| -> Vec<Value> {
            match source.get("figure_types").filter(|f| !f.is_null()) {
                Some(list) => list.elements().map(|e| e.iter().collect()).unwrap_or_default(),
                None if source.get("segments").is_some_and(Value::truthy) => vec![source.clone()],
                None => Vec::new(),
            }
        };
        let mut figures = definitions(&source);
        if figures.is_empty() {
            return Err(invalid("errors.editor.theImportedFileContainsNoFigureDefinitions"));
        }
        // A movieclip's own documents are validated and normalized as the editor does a file it opens (`prepareEditorLoad`).
        if figures.iter().any(is_movieclip) {
            source = crate::load::prepare_editor_load(source)?.report;
            figures = definitions(&source);
        }
        let frame = source.get("keyframes").and_then(|k| k.item(0));
        let mut sources: Vec<Value> = frame.as_ref().map(objects_of).unwrap_or_default();
        let from_frame = !sources.is_empty();
        if !from_frame {
            // `createObject(figures[0], 1, 0, 0)`
            let figure = &figures[0];
            let angles: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().map(|s| s.get("angle_rad").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
            let mut object = Obj::new();
            object.set("object_slot", Value::Num(0.0));
            object.set("unique_id", Value::Num(1.0));
            object.set("figure_type_id", figure.get("figure_type_id").cloned().unwrap_or(Value::Null));
            object.set("root_x", Value::Num(0.0));
            object.set("root_y", Value::Num(0.0));
            object.set("scale", Value::Num(1.0));
            object.set("color_override_raw", Value::Num(0.0));
            object.set("field28", Value::Num(0.0));
            object.set("angles", Value::array(angles));
            object.set("len_flag", Value::Num(0.0));
            object.set("lengths", Value::array(Vec::new()));
            object.set("bend_flag", Value::Num(0.0));
            object.set("bends", Value::array(Vec::new()));
            object.set("join", Value::Null);
            sources.push(Value::object(object));
        }
        // Joins name their parent by slot in the file; the clipboard names it by identity.
        let by_slot: Vec<(f64, Value)> = sources.iter().enumerate().map(|(i, o)| (num(o, "object_slot").unwrap_or(i as f64), o.get("unique_id").cloned().unwrap_or(Value::Null))).collect();
        let objects: Vec<Value> = sources
            .iter()
            .map(|object| {
                let mut record = object.as_obj().cloned().unwrap_or_default();
                let parent = object.get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot")).and_then(|slot| by_slot.iter().find(|(s, _)| *s == slot)).map(|(_, uid)| uid.clone());
                match (object.get("join").and_then(Value::as_obj), parent) {
                    (Some(join), Some(parent)) => {
                        let mut join = join.clone();
                        join.set("target_unique_id", parent);
                        record.set("join", Value::object(join));
                    }
                    _ => record.set("join", Value::Null),
                }
                Value::object(record)
            })
            .collect();
        let order: Vec<u32> = if from_frame {
            crate::figures::frame_order(frame.as_ref().and_then(Value::as_obj).unwrap_or(&Obj::new())).into_iter().map(|u| u as u32).collect()
        } else {
            objects.iter().filter_map(uid).collect()
        };
        let clipboard = FigureClipboard { objects, figures, layers: Vec::new(), order, source_version: Value::Null, offset: 0.0, pastes: 0.0, vfx_clips: Vec::new(), copy_tick: None, foreign: true, movieclip_samples: Vec::new(), fresh_types: Vec::new() };
        let canvas = [num(&self.report, "canvas_width").unwrap_or(f64::NAN) / 2.0, num(&self.report, "canvas_height").unwrap_or(f64::NAN) / 2.0];
        let mut operation = Obj::new();
        operation.set("newIdentities", Value::Bool(true));
        let inserted = self.paste_figures(&clipboard, &Value::object(operation), None, 0.0, Some(position.unwrap_or(canvas)), "Import figure")?;
        self.selection.uid = inserted.first().copied();
        Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
    }

    /// `applyFigureRange({kind: 'paste', …}, {atPlayhead: true})` on a layer sheet:
    /// `insertionPlan`, `insert` and `_commitSheetRange`. Returns the pasted identities.
    fn paste_figures(&mut self, clipboard: &FigureClipboard, options: &Value, offset: Option<&Value>, default_offset: f64, position: Option<[f64; 2]>, label: &str) -> Result<Vec<u32>, EditError> {
        self.paste_figures_across(clipboard, options, offset, default_offset, position, label, None)
    }

    /// [`Editor::paste_figures`] into the frames of a range (`(tick, frame)` each), or the frame on show.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn paste_figures_across(&mut self, clipboard: &FigureClipboard, options: &Value, offset: Option<&Value>, default_offset: f64, position: Option<[f64; 2]>, label: &str, targets: Option<&[(f64, Value)]>) -> Result<Vec<u32>, EditError> {
        // Pasted figures keep their timeline effects in the same undo step.
        if !clipboard.vfx_clips.is_empty() && self.batch.is_none() {
            return self.movieclip_batch(label, |editor| editor.paste_figures_in(clipboard, options, offset, default_offset, position, label, targets));
        }
        self.paste_figures_in(clipboard, options, offset, default_offset, position, label, targets)
    }

    #[allow(clippy::too_many_arguments)]
    fn paste_figures_in(&mut self, clipboard: &FigureClipboard, options: &Value, offset: Option<&Value>, default_offset: f64, position: Option<[f64; 2]>, label: &str, targets: Option<&[(f64, Value)]>) -> Result<Vec<u32>, EditError> {
        if !self.sheet() {
            return Err(EditError::Unported("pasting figures on a native timeline".into()));
        }
        let paste_mode = match options.get("pasteMode").filter(|m| !m.is_null()) {
            None if clipboard.foreign => "instance".to_string(),
            None => "default".to_string(),
            Some(mode) => mode.as_str().unwrap_or("?").to_string(),
        };
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if !["default", "unique", "instance"].contains(&paste_mode.as_str()) {
            return Err(invalid("errors.editorRangeCommands.chooseAValidFigurePasteMode"));
        }
        let depth = options.get("pasteDepth").filter(|d| !d.is_null()).map_or("same".to_string(), |d| d.as_str().unwrap_or("?").to_string());
        if !["same", "front"].contains(&depth.as_str()) {
            return Err(invalid("errors.editorRangeCommands.chooseAValidFigurePasteDepth"));
        }
        let version = self.report.get("version").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let source_version = clipboard.source_version.as_f64().unwrap_or(f64::NAN);
        let new_identities = options.get("newIdentities").is_some_and(Value::truthy);
        let definitions_now: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let mut next_type = definitions_now.iter().filter_map(|f| num(f, "figure_type_id")).fold(1.0f64, |a, t| a.max(t + 1.0));
        let mut next_uid = self.next_uid;
        // Definitions: the copied ones themselves (instances, and movieclips unless unique),
        // else new copies.
        let independent = |figure: &Value| clipboard.foreign || num(figure, "figure_type_id").is_some_and(|t| clipboard.fresh_types.contains(&t)) || paste_mode == "unique" || is_drawing(figure) || (paste_mode == "default" && !is_movieclip(figure));
        let copied_type = |object: &Value| clipboard.figures.iter().find(|f| f.get("figure_type_id") == object.get("figure_type_id"));
        // A movieclip instance pasted where it is not on show keeps its identity (`linked`,
        // `retained`): once and hide clips still own theirs after their artwork is gone.
        let linked: Vec<u32> = clipboard
            .objects
            .iter()
            .filter(|o| !new_identities && !clipboard.foreign && copied_type(o).is_some_and(|f| !independent(f)) && definitions_now.iter().any(|f| f.get("figure_type_id") == o.get("figure_type_id") && is_movieclip(f)))
            .filter_map(uid)
            .collect();
        let targets: Vec<(f64, Value)> = match targets {
            Some(targets) => targets.to_vec(),
            None => vec![(self.tick, self.shown_frame()?)],
        };
        let mut occupied: Vec<u32> = Vec::new();
        for (_, frame) in &targets {
            occupied.extend(objects_of(frame).iter().filter_map(uid).filter(|u| linked.contains(u) && !occupied.contains(u)).collect::<Vec<_>>());
        }
        if occupied.len() < linked.len() {
            for (tick, _) in &targets {
                occupied.extend(objects_of(&self.evaluated(*tick, false)?).iter().filter_map(uid).filter(|u| linked.contains(u) && !occupied.contains(u)).collect::<Vec<_>>());
                if occupied.len() == linked.len() {
                    break;
                }
            }
        }
        let retained: Vec<u32> = linked.iter().copied().filter(|u| !occupied.contains(u)).collect();
        // Every other figure takes a new identity.
        let mut uid_map: Vec<(u32, u32)> = Vec::new();
        for object in &clipboard.objects {
            let old = uid(object).unwrap_or(0);
            if retained.contains(&old) {
                uid_map.push((old, old));
                continue;
            }
            if next_uid > 0x7ffffffe {
                return Err(invalid("errors.editorLayerSheet.objectIdentityCapacityReached"));
            }
            uid_map.push((old, next_uid as u32));
            next_uid += 1;
        }
        let renamed = |old: u32| uid_map.iter().find(|(from, _)| *from == old).map(|(_, to)| *to);
        let mut added: Vec<Value> = Vec::new();
        let mut forks: Vec<(String, String)> = Vec::new();
        let mut types: Vec<(f64, Value, HashMap<i64, usize>)> = Vec::new();
        for original in &clipboard.figures {
            let type_id = num(original, "figure_type_id").unwrap_or(f64::NAN);
            let existing = if independent(original) { None } else { definitions_now.iter().find(|f| num(f, "figure_type_id") == Some(type_id)).cloned() };
            let figure = match existing {
                Some(figure) => figure,
                None => {
                    let mut copy = snapshot_figure_definition(original).as_obj().cloned().unwrap_or_default();
                    copy.set("figure_type_id", Value::Num(next_type));
                    next_type += 1.0;
                    // Modern segment colours must not acquire the destination's legacy whole-figure interpretation.
                    if source_version >= 5.0 && version < 5.0 {
                        let mut styk = copy.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                        styk.set("colorMode", Value::str("segments"));
                        copy.set("_styk", Value::object(styk));
                    }
                    let mut copy = Value::object(copy);
                    // A drawing is a cel of its own, with the pixels of the one it copies.
                    if is_drawing(&copy) {
                        let cel = format!("cel-{}", self.draw_uuid()?);
                        let from = copy.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str).map(str::to_string);
                        if let Some(drawing) = copy.make_obj().and_then(|f| f.get_mut("_styk")).and_then(Value::make_obj).and_then(|styk| styk.get_mut("drawing")).and_then(Value::make_obj) {
                            drawing.set("celId", Value::str(&cel));
                        }
                        if let Some(from) = from.filter(|_| !clipboard.foreign) {
                            forks.push((from, cel));
                        }
                    }
                    added.push(copy.clone());
                    copy
                }
            };
            let indices = original.get("segments").and_then(Value::elements).map(|e| e.iter().enumerate().filter_map(|(i, s)| Some((num(&s, "segment_id")? as i64, i))).collect()).unwrap_or_default();
            types.push((type_id, figure, indices));
        }
        let offset = match offset {
            Some(Value::Num(n)) => *n,
            Some(_) => f64::NAN,
            None if !retained.is_empty() => 0.0,
            None => default_offset,
        };
        if !offset.is_finite() {
            return Err(invalid("errors.editorRangeCommands.pasteOffsetMustBeFinite"));
        }
        // Placed at a position: the copied figures' roots (all of them when every one is joined) centred there.
        let (dx, dy) = match position {
            Some([x, y]) => {
                let roots: Vec<&Value> = clipboard.objects.iter().filter(|o| !o.get("join").is_some_and(Value::truthy)).collect();
                let anchors: Vec<&Value> = if roots.is_empty() { clipboard.objects.iter().collect() } else { roots };
                let mean = |key: &str| anchors.iter().map(|o| num(o, key).unwrap_or(f64::NAN)).sum::<f64>() / anchors.len() as f64;
                (x - mean("root_x"), y - mean("root_y"))
            }
            None => (offset, offset),
        };
        if !dx.is_finite() || !dy.is_finite() {
            return Err(invalid("errors.editorRangeCommands.chooseAValidCanvasPosition"));
        }
        let mut hints: HashMap<u32, String> = HashMap::new();
        let mut objects: Vec<Obj> = Vec::new();
        for original in &clipboard.objects {
            let Some((_, figure, indices)) = types.iter().find(|(t, _, _)| num(original, "figure_type_id") == Some(*t)) else {
                return Err(EditError::Unported("a copied figure without its definition".into()));
            };
            let mut object = snapshot_pose_object(original);
            // Legacy colours are absolute: a figure of an older format pasted into a modern document keeps the colour it shows.
            if source_version < 5.0 && version >= 5.0 && copied_type(original).is_some_and(|f| f.path(&["_styk", "colorMode"]).and_then(Value::as_str) != Some("segments")) {
                modernize_legacy_object_color(&mut object);
            }
            object.remove("_stykMovieclipPart");
            let new_type = num(figure, "figure_type_id").unwrap_or(f64::NAN);
            styk_eval::vfx::remap_owner(&mut object, new_type, None, num(original, "figure_type_id").unwrap_or(f64::NAN));
            let old = uid(original).unwrap_or(0);
            let new = renamed(old).unwrap_or(old);
            object.set("unique_id", Value::Num(new as f64));
            object.set("figure_type_id", Value::Num(new_type));
            object.set("root_x", Value::Num(num(original, "root_x").unwrap_or(f64::NAN) + dx));
            object.set("root_y", Value::Num(num(original, "root_y").unwrap_or(f64::NAN) + dy));
            // A pasted movieclip plays on the presence clock from its start, a copy of one on
            // show from where the copied instance was.
            if is_movieclip(figure) && !retained.contains(&old) {
                let previous = original.get("_stykMovieclip");
                let mut playback = Obj::new();
                playback.set("clock", Value::str("presence"));
                playback.set("offset", Value::Num(0.0));
                playback.set("speed", previous.and_then(|p| p.get("speed")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(1.0)));
                playback.set("mode", previous.and_then(|p| p.get("mode")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::str("loop")));
                if linked.contains(&old) {
                    let sample = clipboard.movieclip_samples.iter().find(|(u, _)| *u == old).map(|(_, t)| Value::Num(*t));
                    playback.set("offset", sample.or_else(|| previous.and_then(|p| p.get("offset")).filter(|v| !v.is_null()).cloned()).unwrap_or(Value::Num(0.0)));
                }
                object.set("_stykMovieclip", Value::object(playback));
            }
            crate::ik::translate_targets(&mut object, dx, dy, &Value::object(snapshot_pose_object(original)), false);
            crate::sheet_clipboard::remap_followers(&mut object, &uid_map);
            let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            for (field, enabled, fallback) in [("angles", true, "angle_rad"), ("lengths", object.get("len_flag").is_some_and(Value::truthy), "length"), ("bends", object.get("bend_flag").is_some_and(Value::truthy), "bend_rad")] {
                if !enabled {
                    continue;
                }
                let values = segments
                    .iter()
                    .map(|segment| {
                        let at = num(segment, "segment_id").and_then(|id| indices.get(&(id as i64)).copied());
                        at.and_then(|i| original.get(field).and_then(|v| v.item(i))).filter(|v| !v.is_null()).or_else(|| segment.get(fallback).filter(|v| !v.is_null()).cloned()).unwrap_or(Value::Num(0.0))
                    })
                    .collect();
                object.set(field, Value::array(values));
            }
            if let Some(join) = object.get("join").filter(|j| j.truthy()).and_then(Value::as_obj).cloned() {
                match num(&Value::object(join.clone()), "target_unique_id").and_then(|t| renamed(t as u32)) {
                    Some(target) => {
                        let mut join = join;
                        join.set("target_unique_id", Value::Num(target as f64));
                        object.set("join", Value::object(join));
                    }
                    None => object.set("join", Value::Null),
                }
            }
            let layer = if linked.contains(&old) { Some(self.layer_of(old)) } else if new_identities { clipboard.layers.iter().find(|(u, _)| *u == old).map(|(_, l)| l.clone()) } else { None };
            if let Some(layer) = layer.filter(|l| !clipboard.foreign && self.layer_exists(l)) {
                hints.insert(new, layer);
            }
            object.remove("runtime_segments");
            objects.push(object);
        }
        // A join whose parent was not copied, or whose node the parent's definition lacks, is dropped.
        for (i, original) in clipboard.objects.iter().enumerate() {
            if !objects[i].get("join").is_some_and(Value::truthy) {
                continue;
            }
            let parent = original.get("join").and_then(|j| num(j, "target_unique_id")).and_then(|t| clipboard.objects.iter().find(|o| num(o, "unique_id") == Some(t)));
            let handle = objects[i].get("join").and_then(|j| num(j, "target_handle_id"));
            let has_handle = parent.and_then(|p| types.iter().find(|(t, _, _)| num(p, "figure_type_id") == Some(*t))).is_some_and(|(_, figure, _)| {
                handle == Some(0.0) || figure.get("segments").and_then(Value::elements).is_some_and(|s| s.iter().any(|seg| num(&seg, "segment_id") == handle))
            });
            if !has_handle {
                objects[i].set("join", Value::Null);
            }
        }
        let order: Vec<u32> = clipboard.order.iter().filter_map(|u| renamed(*u)).collect();
        let pasted: Vec<Value> = objects.iter().cloned().map(Value::object).collect();
        let inserted: Vec<u32> = pasted.iter().filter_map(uid).collect();
        let mut entries: Vec<(f64, Value, Vec<u32>)> = Vec::new();
        for (tick, target) in &targets {
            // In front of the layers' figures of this frame, or at the depth they were copied at.
            let mut here = objects.clone();
            if depth == "front" {
                let mut depths: HashMap<String, f64> = HashMap::new();
                for object in objects_of(target) {
                    let layer = uid(&object).map(|u| self.layer_of(u)).unwrap_or_default();
                    let z = num(&object, "_stykZIndex").unwrap_or(0.0);
                    let entry = depths.entry(layer).or_insert(-1_000_000.0);
                    *entry = entry.max(z);
                }
                let active = self.active_layer();
                let destination = if self.report.path(&["_styk", "layers", "byId", &active]).is_some() { active } else { self.report.path(&["_styk", "layers", "defaultLayerId"]).and_then(Value::as_str).unwrap_or("").to_string() };
                for object in here.iter_mut() {
                    let layer = uid(&Value::object(object.clone())).and_then(|u| hints.get(&u).cloned()).unwrap_or_else(|| destination.clone());
                    object.set("_stykZIndex", Value::Num((depths.get(&layer).copied().unwrap_or(0.0) + 1.0).min(1_000_000.0)));
                }
            }
            let at: Vec<Value> = here.into_iter().map(Value::object).collect();
            // The pasted poses are ones the document may hold (`validateObjectChanges`): a scale below zero is refused.
            for object in &at {
                if let Some((_, figure, _)) = types.iter().find(|(_, figure, _)| figure.get("figure_type_id") == object.get("figure_type_id")) {
                    crate::load::validate_object_pose(&self.report, object, figure)?;
                }
            }
            let mut frame = insert(target, &at, &order)?;
            // Copies of a figure with an animation origin find their pivot again where they now stand.
            self.synchronize_origin_frame_with(&mut frame, &objects_of(target), true, &added)?;
            entries.push((*tick, frame, inserted.clone()));
        }
        if !added.is_empty() {
            crate::load::validate_definitions(&self.report, &added)?;
        }
        // Published, the pasted figures are selected and the identities taken; refused, neither.
        let (selection, previous, previous_next, branch) = (self.selection_state(), self.selection.clone(), self.next_uid, self.selection_metadata.branch.take());
        self.selection = crate::Selection { uid: order.last().copied(), uids: order.clone(), joint: -1 };
        self.next_uid = next_uid;
        if let Err(error) = self.commit_sheet_range(&entries, &order, &hints, added, label, selection, Some((&pasted, true)), None) {
            self.selection = previous;
            self.selection_metadata.branch = branch;
            self.next_uid = previous_next;
            return Err(error);
        }
        self.drawing_forks.extend(forks);
        if !clipboard.vfx_clips.is_empty() {
            let type_map: Vec<(f64, f64)> = types.iter().map(|(from, figure, _)| (*from, num(figure, "figure_type_id").unwrap_or(f64::NAN))).collect();
            let shift = clipboard.copy_tick.map_or(0.0, |copied| (self.tick + 0.5).floor() - copied);
            self.paste_figure_vfx_clips(&clipboard.vfx_clips, &uid_map, &type_map, shift)?;
        }
        Ok(order)
    }
}

/// `modernizeLegacyObjectColor(object)`: a legacy colour is absolute BGR with negative black; it becomes an opaque override.
pub(crate) fn modernize_legacy_object_color(object: &mut Obj) {
    if object.get("_styk").and_then(|styk| styk.get("colorMode")).and_then(Value::as_str) == Some("segments") {
        return;
    }
    let number = object.get("color_override_raw").map_or(0.0, |raw| match raw {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        other => other.as_f64().unwrap_or(f64::NAN),
    });
    // `>>> 0`: the number as an unsigned 32-bit integer.
    let raw = if number.is_finite() { number.trunc().rem_euclid(4294967296.0) as u32 } else { 0 };
    let colour = 0xff00_0000u32 | if (raw as i32) < 0 { 0 } else { raw & 0x00ff_ffff };
    object.set("color_override_raw", Value::Num(f64::from(colour)));
    object.set("color_override_rgb", Value::nums(&[f64::from(colour & 255), f64::from((colour >> 8) & 255), f64::from((colour >> 16) & 255)]));
    object.set("color_override_mix", Value::Num(255.0));
}

impl FigureClipboard {
    /// The clipboard as the interface holds it (`editor._selectionClipboard`): its map of layers and its set of
    /// fresh definitions as lists, without the document it came from (the interface knows that).
    pub(crate) fn to_wire(&self) -> Value {
        let mut wire = Obj::new();
        wire.set("objects", Value::array(self.objects.clone()));
        wire.set("figures", Value::array(self.figures.clone()));
        let mut samples = Obj::new();
        for (uid, sample) in &self.movieclip_samples {
            samples.set(&uid.to_string(), Value::Num(*sample));
        }
        wire.set("movieclipSamples", Value::object(samples));
        wire.set("layers", Value::array(self.layers.iter().map(|(uid, layer)| Value::array(vec![Value::Num(*uid as f64), Value::str(layer)])).collect()));
        wire.set("order", Value::array(self.order.iter().map(|uid| Value::Num(*uid as f64)).collect()));
        wire.set("vfxClips", Value::array(self.vfx_clips.clone()));
        if let Some(tick) = self.copy_tick {
            wire.set("copyTick", Value::Num(tick));
        }
        wire.set("sourceVersion", self.source_version.clone());
        wire.set("offset", Value::Num(self.offset));
        wire.set("pastes", Value::Num(self.pastes));
        if !self.fresh_types.is_empty() {
            wire.set("freshTypes", Value::array(self.fresh_types.iter().map(|id| Value::Num(*id)).collect()));
        }
        Value::object(wire)
    }

    /// The clipboard the interface hands over; `foreign` when it was copied in another document or restored from the
    /// system's clipboard (every definition it pastes is then a new one).
    pub(crate) fn from_wire(data: &Value, foreign: bool) -> Result<FigureClipboard, EditError> {
        let invalid = || EditError::Invalid("errors.sharedClipboard.invalidFigureClipboard".into());
        let list = |key: &str| data.get(key).and_then(Value::elements).map(|items| items.iter().collect::<Vec<Value>>());
        let objects = list("objects").filter(|objects| !objects.is_empty() && objects.iter().all(Value::is_object)).ok_or_else(invalid)?;
        let figures = list("figures").filter(|figures| figures.iter().all(Value::is_object)).ok_or_else(invalid)?;
        let order = list("order").ok_or_else(invalid)?.iter().map(|uid| uid.as_f64().filter(|uid| uid.fract() == 0.0 && *uid >= 0.0).map(|uid| uid as u32)).collect::<Option<Vec<u32>>>().ok_or_else(invalid)?;
        let offset = data.get("offset").and_then(Value::as_f64).filter(|offset| offset.is_finite()).ok_or_else(invalid)?;
        // A figure the copy found on no layer has none.
        let layers = list("layers").unwrap_or_default().iter().filter_map(|pair| Some((pair.item(0)?.as_f64()? as u32, pair.item(1)?.as_str()?.to_string()))).collect();
        let movieclip_samples = match data.get("movieclipSamples").and_then(Value::as_obj) {
            None => Vec::new(),
            Some(samples) => samples.iter().filter_map(|(uid, sample)| Some((uid.parse::<u32>().ok()?, sample.as_f64()?))).collect(),
        };
        let fresh_types = list("freshTypes").map(|ids| ids.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
        Ok(FigureClipboard {
            objects, figures, layers, order,
            source_version: data.get("sourceVersion").cloned().unwrap_or(Value::Null),
            offset,
            pastes: data.get("pastes").and_then(Value::as_f64).filter(|pastes| pastes.is_finite()).unwrap_or(0.0),
            vfx_clips: list("vfxClips").unwrap_or_default(),
            copy_tick: data.get("copyTick").and_then(Value::as_f64).filter(|tick| tick.is_finite()),
            foreign, movieclip_samples, fresh_types,
        })
    }
}
