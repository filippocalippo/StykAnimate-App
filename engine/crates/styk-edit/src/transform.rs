//! Gestures on figures (`beginDrag`, `_objectEdit`, `touch`, `commitDrag`,
//! `cancelDrag`) and moving them (`moveSelection`).

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind};
use crate::record::{join_target, num, object_mut, same, uid};
use crate::select::resolve_join_selection;
use crate::timeline::rows;
use crate::{Drag, EditError, Editor};

pub(crate) const NOT_FINITE: &str = "errors.editorCamera.mustBeFinite";

/// A value the editor's `finite(value, label)` refuses.
pub(crate) fn not_finite(label: &str) -> EditError {
    crate::invalid_with(NOT_FINITE, vec![("label", crate::label(label))])
}

/// `moveSelection`'s options.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MoveOptions {
    pub from_start: bool,
    pub detach_external: bool,
    pub move_pins: bool,
}

impl MoveOptions {
    pub(crate) fn from_value(options: &Value) -> MoveOptions {
        let flag = |key| options.get(key).is_some_and(Value::truthy);
        MoveOptions { from_start: flag("fromStart"), detach_external: flag("detachExternal"), move_pins: flag("movePins") }
    }
}

impl Editor {
    /// `beginDrag(label, {scope})`: snapshots the figures the gesture may change.
    pub(crate) fn begin_drag(&mut self, label: &str, translation: bool) -> Result<bool, EditError> { self.begin_drag_checked(label, translation, &mut || Ok(())) }
    pub(crate) fn begin_drag_checked(&mut self, label: &str, translation: bool, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        if self.drag.is_some() {
            self.commit_drag_checked(check)?;
        }
        if self.sheet() || self.options.property_channels {
            return self.begin_authored_drag(label, translation);
        }
        let Some((_, object)) = self.object()? else { return Ok(false) };
        self.selection.uid = uid(&object);
        self.tick = rows(&self.report).get(self.frame_index).map_or(0.0, |row| row.start);
        let objects = self.frame_objects();
        let slots = Editor::ik_pose_slots(&objects, resolve_join_selection(&objects, &self.selection.uids, translation)?);
        self.drag = Some(Drag {
            label: label.to_string(),
            translation,
            index: self.frame_index,
            before: slots.iter().map(|&slot| objects[slot].clone()).collect(),
            before_selection: self.selection_state(),
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
            rig: None,
            motion_path: None,
            duplicate: None,
            tweener: None,
            serial: self.next_drag_serial(),
            authored: false,
        });
        Ok(true)
    }

    /// `_expandTranslationDrag`: a pose gesture that starts moving takes in whole connected figures.
    pub(crate) fn expand_translation_drag(&mut self) -> Result<(), EditError> {
        let Some(drag) = self.drag.as_ref().filter(|d| !d.translation) else { return Ok(()) };
        // On a draft the selection frame is the draft itself.
        let objects = self.frame_objects();
        let slots = resolve_join_selection(&objects, &self.selection.uids, true)?;
        let snapshots: HashMap<u32, Value> = drag.before.iter().filter_map(|o| Some((uid(o)?, o.clone()))).collect();
        let before = slots.iter().map(|&slot| uid(&objects[slot]).and_then(|u| snapshots.get(&u).cloned()).unwrap_or_else(|| objects[slot].clone())).collect();
        let drag = self.drag.as_mut().unwrap();
        drag.before = before;
        drag.translation = true;
        Ok(())
    }

    /// `_objectEdit`: runs `mutate` inside the current gesture, or as a gesture of its own.
    pub(crate) fn object_edit(&mut self, label: &str, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>) -> Result<bool, EditError> {
        self.object_edit_with(label, false, mutate)
    }

    /// `_objectEdit(label, mutate, {posed})`: a `posed` edit changes the pose as it is
    /// displayed, so pinned IK solutions are baked into the gesture's figures first.
    pub(crate) fn object_edit_with(&mut self, label: &str, posed: bool, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>) -> Result<bool, EditError> { self.object_edit_with_checked(label, posed, mutate, &mut || Ok(())) }
    pub(crate) fn object_edit_with_checked(&mut self, label: &str, posed: bool, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        if self.object()?.is_none() {
            return Ok(false);
        }
        let active = self.drag.is_some();
        if !active {
            self.begin_drag_checked(label, false, check)?;
        }
        let result = (if posed { self.bake_pinned() } else { Ok(()) }).and_then(|()| mutate(self)).and_then(|()| {
            self.touch()?;
            if !active { self.commit_drag_checked(check).map(|_| ()) } else { Ok(()) }
        });
        if let Err(error) = result {
            self.cancel_drag()?;
            return Err(error);
        }
        Ok(true)
    }

    /// `touch`: marks the gesture changed, remembers how pinned limbs now bend, and
    /// announces the live edit.
    pub(crate) fn touch(&mut self) -> Result<(), EditError> {
        if let Some(before) = self.drag.as_ref().map(|drag| drag.before.clone()) { self.synchronize_origins(&before)?; }
        let changed = match self.drag.as_mut() {
            Some(drag) => {
                drag.changed = true;
                drag.before.iter().filter_map(uid).collect::<Vec<_>>()
            }
            None => {
                self.revision_serial += 1;
                self.revision = self.revision_serial;
                self.selection.uid.into_iter().collect()
            }
        };
        self.remember_bends()?;
        let live = self.drag.is_some();
        self.emit("edit", vec![("live", Value::Bool(live)), ("changedUids", uid_array(&changed))]);
        Ok(())
    }

    pub(crate) fn commit_drag(&mut self) -> Result<bool, EditError> { self.commit_drag_checked(&mut || Ok(())) }
    pub(crate) fn commit_drag_checked(&mut self, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        if self.drag.as_ref().is_some_and(|drag| drag.duplicate.is_some()) {
            return self.finish_duplicate_drag(true);
        }
        if self.rig_drag().is_some() {
            return self.commit_rig_drag();
        }
        if self.motion_path_open() {
            return self.commit_motion_path_edit();
        }
        if self.camera_drag().is_some() {
            return self.commit_camera_drag();
        }
        let Some(drag) = self.drag.as_ref() else { return Ok(false) };
        if drag.authored {
            return self.commit_authored_drag_checked(check);
        }
        let before = drag.before.clone();
        self.synchronize_origins(&before)?;
        let drag = self.drag.as_ref().unwrap();
        let ids: Vec<u32> = drag.before.iter().filter_map(uid).collect();
        let index = drag.index;
        let collect = |editor: &Editor| crate::record::frame_objects(&editor.report, index).into_iter().filter(|o| uid(o).is_some_and(|u| ids.contains(&u))).collect::<Vec<_>>();
        let mut after = collect(self);
        if same(&drag.before, &after) {
            self.drag = None;
            return Ok(false);
        }
        if let Err(error) = self.validate_spatial_joins() {
            self.cancel_drag()?;
            return Err(error);
        }
        // Native Pivot stores final attachment coordinates as well as join links.
        if after.iter().any(|o| join_target(o).is_some()) {
            let roots = self.roots_of(&ids)?;
            let objects = crate::record::frame_objects(&self.report, index);
            for (slot, object) in objects.iter().enumerate() {
                let Some(id) = uid(object).filter(|u| ids.contains(u)) else { continue };
                if join_target(object).is_none() {
                    continue;
                }
                if let (Some(root), Some(record)) = (roots.get(&id), object_mut(&mut self.report, index, slot)) {
                    record.set("root_x", Value::Num(root[0]));
                    record.set("root_y", Value::Num(root[1]));
                }
            }
            self.synchronize_origins(&before)?;
            after = collect(self);
        }
        let drag = self.drag.take().unwrap();
        let after_selection = self.selection_state();
        self.record(Command { kind: CommandKind::Objects { index, before: drag.before, after }, label: drag.label.clone(), before_selection: drag.before_selection, after_selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(&drag.label)), ("changedUids", uid_array(&ids))]);
        Ok(true)
    }

    pub(crate) fn cancel_drag(&mut self) -> Result<bool, EditError> {
        if self.drag.as_ref().is_some_and(|drag| drag.duplicate.is_some()) {
            return self.finish_duplicate_drag(false);
        }
        if self.rig_drag().is_some() {
            return self.cancel_rig_drag();
        }
        if self.motion_path_open() {
            return self.cancel_motion_path_edit();
        }
        if self.camera_drag().is_some() {
            return self.cancel_camera_drag();
        }
        if self.drag.as_ref().is_some_and(|drag| drag.authored) {
            return self.cancel_authored_drag();
        }
        let Some(drag) = self.drag.take() else { return Ok(false) };
        self.replace_objects(drag.index, &drag.before);
        let ids: Vec<u32> = drag.before.iter().filter_map(uid).collect();
        self.emit("edit", vec![("label", Value::str("Cancel pose")), ("changedUids", uid_array(&ids))]);
        Ok(true)
    }

    /// `moveSelection`: translates connected roots once, including when a selected figure is a joined child.
    pub(crate) fn move_selection(&mut self, dx: f64, dy: f64, options: &Value) -> Result<bool, EditError> { self.move_selection_checked(dx, dy, options, &mut || Ok(())) }
    pub(crate) fn move_selection_checked(&mut self, dx: f64, dy: f64, options: &Value, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        finite(dx, "Translation X")?;
        finite(dy, "Translation Y")?;
        let options = MoveOptions::from_value(options);
        self.object_edit_with_checked("Move figures", false, |editor| {
            if !options.detach_external {
                editor.expand_translation_drag()?;
            }
            let snapshots: HashMap<u32, Value> = editor.drag.as_ref().unwrap().before.iter().filter_map(|o| Some((uid(o)?, o.clone()))).collect();
            let objects = editor.frame_objects();
            let affected: Vec<usize> = (0..objects.len()).filter(|&slot| uid(&objects[slot]).is_some_and(|u| snapshots.contains_key(&u))).collect();
            let external: Vec<usize> = affected
                .iter()
                .copied()
                .filter(|&slot| join_target(&objects[slot]).is_some_and(|target| !objects.get(target).and_then(uid).is_some_and(|u| snapshots.contains_key(&u))))
                .collect();
            let mut detached: HashMap<u32, [f64; 2]> = HashMap::new();
            if !external.is_empty() {
                let roots = editor.roots_of(&external.iter().filter_map(|&slot| uid(&objects[slot])).collect::<Vec<_>>())?;
                for &slot in &external {
                    let id = uid(&objects[slot]).unwrap();
                    let record = editor.frame_object_mut(slot).unwrap();
                    if let Some(root) = roots.get(&id) {
                        detached.insert(id, *root);
                        record.set("root_x", Value::Num(root[0]));
                        record.set("root_y", Value::Num(root[1]));
                    }
                    record.set("join", Value::Null);
                }
                editor.drag.as_mut().unwrap().detached.extend(detached.iter().map(|(k, v)| (*k, *v)));
            }
            for &slot in &affected {
                let object = editor.frame_objects().swap_remove(slot);
                let id = uid(&object).unwrap();
                // Pinned targets go with the figure only when asked (`movePins`); `fromStart`
                // puts them back where the gesture found them first.
                if options.move_pins || options.from_start {
                    let source = if options.from_start { snapshots[&id].clone() } else { object.clone() };
                    let (px, py) = if options.move_pins { (dx, dy) } else { (0.0, 0.0) };
                    let record = editor.frame_object_mut(slot).unwrap();
                    if crate::ik::translate_targets(record, px, py, &source, true) {
                        record.remove("runtime_segments");
                    }
                }
                if join_target(&object).is_some() {
                    continue;
                }
                let (x, y) = if options.from_start {
                    match editor.drag.as_ref().unwrap().detached.get(&id) {
                        Some(root) => (root[0], root[1]),
                        None => {
                            let baseline = &snapshots[&id];
                            (num(baseline, "root_x").unwrap_or(f64::NAN), num(baseline, "root_y").unwrap_or(f64::NAN))
                        }
                    }
                } else {
                    (num(&object, "root_x").unwrap_or(f64::NAN), num(&object, "root_y").unwrap_or(f64::NAN))
                };
                let record = editor.frame_object_mut(slot).unwrap();
                record.set("root_x", Value::Num(x + dx));
                record.set("root_y", Value::Num(y + dy));
                record.remove("runtime_segments");
            }
            Ok(())
        }, check)
    }

    fn scene(&self) -> Result<styk_eval::geometry::Scene, EditError> {
        Ok(self.evaluate()?.2)
    }

    /// World positions of every figure's root on show, by unique id.
    pub(crate) fn roots(&self) -> Result<HashMap<u32, [f64; 2]>, EditError> {
        Ok(self.scene()?.objects.iter().map(|object| (object.uid, object.root)).collect())
    }

    /// [`Editor::roots`] of the figures `ids` only: the geometry of those figures and of
    /// the figures they are joined to is built, not the whole frame's (IK across joined
    /// figures is solved for the whole frame either way, so the roots are the same).
    pub(crate) fn roots_of(&self, ids: &[u32]) -> Result<HashMap<u32, [f64; 2]>, EditError> {
        let slots: Vec<usize> = self.frame_objects().iter().enumerate().filter(|(_, o)| uid(o).is_some_and(|u| ids.contains(&u))).map(|(slot, _)| slot).collect();
        let (_, _, scene) = self.evaluate_only(Some(&slots))?;
        Ok(scene.objects.iter().filter(|object| ids.contains(&object.uid)).map(|object| (object.uid, object.root)).collect())
    }

    /// The selected figure's root, or the middle of the box around every joint of
    /// `ids` when several figures are selected (`_transformSelection`, `centerFigure`).
    fn selection_center(&self, ids: &[u32]) -> Result<[f64; 2], EditError> {
        let single = self.selected_objects()?.len() == 1;
        let selected = self.selection.uid;
        let scene = self.scene()?;
        if single {
            let root = selected.and_then(|u| scene.objects.iter().find(|g| g.uid == u && g.resolved)).map(|g| g.root);
            return root.ok_or_else(|| EditError::Invalid(NOT_FINITE.into()));
        }
        let (mut min, mut max) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for g in scene.objects.iter().filter(|g| g.resolved && ids.contains(&g.uid)) {
            for p in std::iter::once(&g.root).chain(g.ends.iter().filter(|p| !p[0].is_nan())) {
                min = [min[0].min(p[0]), min[1].min(p[1])];
                max = [max[0].max(p[0]), max[1].max(p[1])];
            }
        }
        Ok([(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0])
    }

    /// `_transformSelection`: `transform(object, pivot, is_root, figure)` on the gesture's
    /// figures (or the selected ones only) about `center`, else the selection's center.
    fn transform_selection(&mut self, label: &str, center: Option<[f64; 2]>, selected_only: bool, mut transform: impl FnMut(&Editor, &mut Obj, [f64; 2], bool, &Value) -> Result<(), EditError>) -> Result<bool, EditError> {
        self.object_edit(label, |editor| {
            let ids: Vec<u32> = if selected_only { editor.selection.uids.clone() } else { editor.drag.as_ref().unwrap().before.iter().filter_map(uid).collect() };
            let pivot = match center {
                Some(center) => center,
                None => editor.selection_center(&ids)?,
            };
            finite(pivot[0], "Transform center X")?;
            finite(pivot[1], "Transform center Y")?;
            let figures: Vec<Value> = editor.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            for (slot, object) in editor.frame_objects().iter().enumerate() {
                if !uid(object).is_some_and(|u| ids.contains(&u)) {
                    continue;
                }
                let type_id = num(object, "figure_type_id");
                let figure = figures.iter().find(|f| num(f, "figure_type_id") == type_id).cloned().unwrap_or(Value::Null);
                let mut record = object.as_obj().cloned().unwrap_or_default();
                transform(editor, &mut record, pivot, join_target(object).is_none(), &figure)?;
                record.remove("runtime_segments");
                editor.replace_frame_object(slot, record).unwrap();
            }
            Ok(())
        })
    }

    pub(crate) fn rotate_selection(&mut self, radians: f64, options: &Value) -> Result<bool, EditError> {
        finite(radians, "Rotation")?;
        let (c, s) = (styk_math::cos(radians), styk_math::sin(radians));
        let (center, selected_only) = transform_options(options)?;
        self.transform_selection("Rotate figures", center, selected_only, |_, object, pivot, root, figure| {
            if root {
                let x = field(object, "root_x") - pivot[0];
                let y = field(object, "root_y") - pivot[1];
                object.set("root_x", Value::Num(pivot[0] + x * c - y * s));
                object.set("root_y", Value::Num(pivot[1] + x * s + y * c));
            }
            map_numbers(object, "angles", |a| a + radians);
            crate::origin::rotate_support(figure, object, radians);
            Ok(())
        })
    }

    /// `scaleSelection` (label "Scale figures") and `scaleSelected` (selected figures only).
    pub(crate) fn scale_selection(&mut self, factor: f64, options: &Value, selected: bool) -> Result<bool, EditError> {
        finite(factor, "Scale")?;
        if factor < 0.0 {
            return Err(EditError::Invalid("errors.editor.scaleCannotBeNegative".into()));
        }
        let (center, selected_only) = transform_options(options)?;
        let label = if selected { "Scale selected figures" } else { "Scale figures" };
        self.transform_selection(label, center, selected || selected_only, |_, object, pivot, root, _| {
            if root {
                object.set("root_x", Value::Num(pivot[0] + (field(object, "root_x") - pivot[0]) * factor));
                object.set("root_y", Value::Num(pivot[1] + (field(object, "root_y") - pivot[1]) * factor));
            }
            object.set("scale", Value::Num(field(object, "scale") * factor));
            Ok(())
        })
    }

    pub(crate) fn mirror_selection(&mut self, axis: &Value, options: &Value) -> Result<bool, EditError> {
        let horizontal = match axis.as_str() {
            None if axis.is_null() => true,
            Some("horizontal") => true,
            Some("vertical") => false,
            _ => return Err(EditError::Invalid("errors.editorBuilderTopology.chooseAHorizontalOrVerticalFlip".into())),
        };
        if self.selection.joint >= 0 && self.selected_objects()?.len() == 1 {
            return Err(EditError::Unported("mirrorSelection of a branch".into()));
        }
        let (center, selected_only) = transform_options(options)?;
        self.transform_selection("Flip figures", center, selected_only, |editor, object, pivot, root, figure| {
            let previous = editor.origin_rotation(figure, &Value::object(object.clone()))?;
            if root {
                if horizontal {
                    object.set("root_x", Value::Num(2.0 * pivot[0] - field(object, "root_x")));
                } else {
                    object.set("root_y", Value::Num(2.0 * pivot[1] - field(object, "root_y")));
                }
            }
            map_numbers(object, "angles", |a| if horizontal { std::f64::consts::PI - a } else { -a });
            if object.get("bend_flag").is_some_and(Value::truthy) {
                map_numbers(object, "bends", |b| -b);
            } else {
                let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
                object.set("bends", Value::array(segments.iter().map(|s| Value::Num(-s.get("bend_rad").and_then(Value::as_f64).unwrap_or(0.0))).collect()));
            }
            object.set("bend_flag", Value::Num(1.0));
            let flipped = !object.get("image_text_flags").is_some_and(Value::truthy);
            object.set("image_text_flags", Value::Num(if flipped { 1.0 } else { 0.0 }));
            crate::origin::mirror_support(figure, object, horizontal);
            editor.reflect_origin_offset(figure, object, horizontal, previous)?;
            Ok(())
        })
    }

    pub(crate) fn rotate_figure(&mut self, radians: f64) -> Result<bool, EditError> {
        if self.selected_objects()?.len() > 1 {
            return self.rotate_selection(radians, &Value::Null);
        }
        finite(radians, "Rotation")?;
        self.object_edit("Rotate figure", |editor| {
            let figures: Vec<Value> = editor.report.get("figure_types").and_then(Value::elements).map(|items| items.iter().collect()).unwrap_or_default();
            let ids: Vec<u32> = editor.drag.as_ref().unwrap().before.iter().filter_map(uid).collect();
            for (slot, object) in editor.frame_objects().iter().enumerate() {
                if uid(object).is_some_and(|u| ids.contains(&u)) {
                    let record = editor.frame_object_mut(slot).unwrap();
                    map_numbers(record, "angles", |a| a + radians);
                    if let Some(figure) = figures.iter().find(|figure| num(figure, "figure_type_id") == num(object, "figure_type_id")) { crate::origin::rotate_support(figure, record, radians); }
                    record.remove("runtime_segments");
                }
            }
            Ok(())
        })
    }

    pub(crate) fn center_figure(&mut self) -> Result<bool, EditError> {
        if self.object()?.is_none() {
            return Ok(false);
        }
        let ids = self.selection.uids.clone();
        let center = self.selection_center(&ids)?;
        let half = |key| num(&self.report, key).unwrap_or(f64::NAN) / 2.0;
        let (dx, dy) = (half("canvas_width") - center[0], half("canvas_height") - center[1]);
        self.move_selection(dx, dy, &Value::Null)
    }

    pub(crate) fn reset_pose(&mut self) -> Result<bool, EditError> {
        self.object_edit("Reset pose", |editor| {
            let figures: Vec<Value> = editor.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            for (slot, object) in editor.selection_frame()?.iter().enumerate() {
                if !uid(object).is_some_and(|u| editor.selection.uids.contains(&u)) {
                    continue;
                }
                let type_id = num(object, "figure_type_id");
                let figure = figures.iter().find(|f| num(f, "figure_type_id") == type_id).cloned().unwrap_or(Value::Null);
                let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
                let record = editor.frame_object_mut(slot).unwrap();
                record.set("angles", Value::array(segments.iter().map(|s| s.get("angle_rad").cloned().unwrap_or(Value::Null)).collect()));
                record.set("bend_flag", Value::Num(0.0));
                record.set("len_flag", Value::Num(0.0));
                record.set("lengths", Value::array(Vec::new()));
                record.set("bends", Value::array(Vec::new()));
                crate::origin::reset_support(&figure, record);
                record.remove("runtime_segments");
            }
            Ok(())
        })
    }
}

/// `finite(value, label)`.
pub(crate) fn finite(value: f64, label: &str) -> Result<f64, EditError> {
    if value.is_finite() { Ok(value) } else { Err(not_finite(label)) }
}

/// A numeric field as JavaScript arithmetic reads it (missing is NaN).
pub(crate) fn field(object: &Obj, key: &str) -> f64 {
    object.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `object[key] = object[key].map(f)` for an array of numbers.
fn map_numbers(object: &mut Obj, key: &str, f: impl Fn(f64) -> f64) {
    if let Some(values) = object.get(key).and_then(Value::elements) {
        let mapped = values.iter().map(|v| Value::Num(f(v.as_f64().unwrap_or(f64::NAN)))).collect();
        object.set(key, Value::array(mapped));
    }
}

/// `{center: {x, y}, selectedOnly}` of the transform commands.
fn transform_options(options: &Value) -> Result<(Option<[f64; 2]>, bool), EditError> {
    let center = options.get("center").filter(|c| !c.is_null()).map(|c| [num(c, "x").unwrap_or(f64::NAN), num(c, "y").unwrap_or(f64::NAN)]);
    Ok((center, options.get("selectedOnly").is_some_and(Value::truthy)))
}

fn uid_array(uids: &[u32]) -> Value {
    Value::array(uids.iter().map(|&u| Value::Num(u as f64)).collect())
}
