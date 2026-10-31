//! Handle positioning and segment values (src/editor-handle-commands.mjs): a handle nudged
//! by screen pixels (`nudgeHandle`) or aligned to an axis (`alignHandle`), moved to where it
//! is on the neighbouring key (`locateEditedHandle`), and a segment's angle, bend and length
//! typed, copied and pasted (`segmentValues`, `beginSegmentValueEdit`, `setSegmentValues`,
//! `copySegmentValues`, `pasteSegmentValues`).

use std::f64::consts::PI;

use styk_doc::{Obj, Value};

use crate::handle_edit::{drawn_segments, Drawn};
use crate::record::{num, uid};
use crate::{EditError, Editor};

const RAD: f64 = PI / 180.0;
const DEG: f64 = 180.0 / PI;
const NOT_FINITE: &str = "errors.editorHandleCommands.positionValuesMustBeFinite";
const LENGTH: &str = "errors.editorHandleCommands.segmentLengthMustBeGreaterThanZero";

fn finite(value: f64) -> Result<f64, EditError> {
    if value.is_finite() { Ok(value) } else { Err(EditError::Invalid(NOT_FINITE.into())) }
}

fn flag(options: &Value, key: &str) -> bool {
    options.get(key).is_some_and(Value::truthy)
}

/// `{...a, ...b}` of two option objects.
fn merged(a: Option<&Value>, b: &Value) -> Value {
    let mut out = Obj::new();
    for source in [a, Some(b)].into_iter().flatten() {
        for (key, value) in entries(source) {
            out.set(&key, value);
        }
    }
    Value::object(out)
}

/// An object's fields in order (none for anything else).
fn entries(value: &Value) -> Vec<(std::sync::Arc<str>, Value)> {
    value.as_obj().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
}

/// The end of `arc(start, angle, length, bend)` (`.at(-1)`), as the editor computes it.
fn arc_end(start: [f64; 2], angle: f64, length: f64, bend: f64) -> Option<[f64; 2]> {
    if !start[0].is_finite() || !start[1].is_finite() || !angle.is_finite() || !length.is_finite() || !bend.is_finite() {
        return None;
    }
    if bend.abs() < 1e-7 {
        return Some([start[0] + length * styk_math::cos(angle), start[1] + length * styk_math::sin(angle)]);
    }
    let steps = 8f64.max(160f64.min((bend.abs() * 16.0).ceil()).min((length.abs() / 4.0).ceil()));
    let r = length / bend;
    let a = angle + (bend * steps) / steps;
    Some([start[0] + r * (styk_math::sin(a) - styk_math::sin(angle)), start[1] + r * (styk_math::cos(angle) - styk_math::cos(a))])
}

/// The selected figure's segments as drawn, and their figure's join, in the frame on show.
struct Figure {
    shapes: Vec<Drawn>,
    root: [f64; 2],
    scale: f64,
    object: Value,
}

impl Editor {
    /// Every figure of the frame on show as drawn, by slot of the selection frame.
    fn drawn_figures(&self) -> Result<Vec<Option<Figure>>, EditError> {
        let objects = self.selection_frame()?;
        let (prepared, frame, scene) = self.evaluate()?;
        let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
        let mut figures = Vec::with_capacity(objects.len());
        for object in &objects {
            let found = uid(object).and_then(|id| Some((frame.objects.iter().position(|o| o.uid == id)?, scene.objects.iter().find(|g| g.uid == id && g.resolved)?)));
            let Some((at, geometry)) = found else {
                figures.push(None);
                continue;
            };
            let definition: Vec<Value> = self.figure_record(object).and_then(|f| f.get("segments").and_then(Value::elements).map(|e| e.iter().collect())).unwrap_or_default();
            let shapes = drawn_segments(&prepared, &frame, &scene, &solved, at, &definition)?;
            figures.push(Some(Figure { shapes, root: geometry.root, scale: frame.objects[at].scale, object: object.clone() }));
        }
        Ok(figures)
    }

    /// `selectHandle(editor, {uid, jointIndex, handleId})`: the handle's figure slot and
    /// joint, selected.
    fn select_handle(&mut self, options: &Value) -> Result<Option<(usize, i64)>, EditError> {
        let uid_option = match options.get("uid") {
            Some(value) => value.as_f64().filter(|v| v.fract() == 0.0 && *v >= 0.0).map(|v| v as u32),
            None => self.selection.uid,
        };
        let frame = self.selection_frame()?;
        let Some(slot) = uid_option.and_then(|id| frame.iter().position(|o| uid(o) == Some(id))) else { return Ok(None) };
        let segments: Vec<Value> = self.figure_record(&frame[slot]).and_then(|f| f.get("segments").and_then(Value::elements).map(|e| e.iter().collect())).unwrap_or_default();
        let mut joint = options.get("jointIndex").and_then(Value::as_f64).map_or(self.selection.joint, |j| j as i64);
        let handle = options.get("handleId").and_then(Value::as_f64);
        if let Some(handle) = handle {
            joint = if handle == 0.0 { -1 } else { segments.iter().position(|s| num(s, "segment_id") == Some(handle)).map_or(-1, |i| i as i64) };
        }
        if joint < -1 || joint >= segments.len() as i64 || handle.is_some_and(|h| h > 0.0) && joint < 0 {
            return Ok(None);
        }
        if uid_option != self.selection.uid || joint != self.selection.joint {
            let add = joint < 0 && uid_option.is_some_and(|u| self.selection.uids.contains(&u));
            self.select(uid_option, joint, false, add)?;
        }
        Ok(Some((slot, joint)))
    }

    /// `applyHandleTarget(editor, point, {editMode, bend, stretch, isolate, wholeFigure})`.
    fn apply_handle_target(&mut self, point: [f64; 2], options: &Value) -> Result<bool, EditError> {
        let mut pose = Obj::new();
        if flag(options, "editMode") {
            pose.set("bend", Value::Bool(flag(options, "bend")));
            return self.edit_handle_position(point[0], point[1], &Value::object(pose));
        }
        if flag(options, "wholeFigure") {
            pose.set("rotate", Value::Bool(true));
            pose.set("scale", Value::Bool(false));
            return self.transform_figure_handle(point[0], point[1], &Value::object(pose));
        }
        pose.set("stretch", Value::Bool(flag(options, "stretch")));
        pose.set("isolate", Value::Bool(flag(options, "isolate")));
        pose.set("snap", Value::Bool(false));
        if flag(options, "bend") { self.bend_joint(point[0], point[1], &Value::object(pose)) } else { self.pose_joint(point[0], point[1], &Value::object(pose)) }
    }

    /// `screenVectorToWorld(dx, dy, {report, frame, view, cameraEnabled})`: the linear part of
    /// the workspace transform (`cameraMatrix`) inverted. Follow clips are not ported.
    fn screen_vector_to_world(&self, dx: f64, dy: f64, options: &Value) -> Result<[f64; 2], EditError> {
        let view = options.get("view").cloned().unwrap_or(Value::Null);
        let zoom = view.get("scale").filter(|v| !v.is_null()).map_or(1.0, |v| v.as_f64().unwrap_or(f64::NAN));
        let (mut a, mut b, mut c, mut d) = (zoom, 0.0, 0.0, zoom);
        let frame = self.shown_frame()?;
        let tick = self.authored.as_ref().map_or(self.tick, |edit| edit.tick);
        if let Some(camera) = self.effective_camera(&frame, options.get("cameraEnabled").is_none_or(Value::truthy), tick)? {
            let [ca, sa, mc, md] = camera_linear(&camera, zoom)?;
            (a, b, c, d) = (ca, sa, mc, md);
        }
        if let Some(rotation) = view.get("rotation").and_then(Value::as_f64).filter(|r| *r != 0.0) {
            let (r, s) = (styk_math::cos(rotation), styk_math::sin(rotation));
            (a, b, c, d) = (r * a - s * b, s * a + r * b, r * c - s * d, s * c + r * d);
        }
        if view.get("flip").is_some_and(Value::truthy) {
            (a, c) = (-a, -c);
        }
        let determinant = a * d - b * c;
        if !determinant.is_finite() || determinant.abs() < 1e-20 {
            return Err(EditError::Invalid("errors.editorHandleCommands.theCurrentViewCannotResolveAPixelMovement".into()));
        }
        Ok([(d * dx - c * dy) / determinant, (a * dy - b * dx) / determinant])
    }

    /// `nudgeHandle(dx, dy, options)`.
    pub(crate) fn nudge_handle(&mut self, dx: f64, dy: f64, options: &Value) -> Result<bool, EditError> {
        finite(dx)?;
        finite(dy)?;
        if dx == 0.0 && dy == 0.0 {
            return Ok(false);
        }
        let Some((slot, joint)) = self.select_handle(options)? else { return Ok(false) };
        let delta = self.screen_vector_to_world(dx, dy, options)?;
        if joint < 0 && !flag(options, "editMode") {
            return self.move_selection(delta[0], delta[1], &Value::Null);
        }
        let figures = self.drawn_figures()?;
        let Some(figure) = figures.get(slot).and_then(Option::as_ref) else { return Err(EditError::Unported("a handle the engine does not draw".into())) };
        let point = if joint < 0 { figure.root } else { figure.shapes.get(joint as usize).map_or([f64::NAN; 2], |s| s.end) };
        self.apply_handle_target([point[0] + delta[0], point[1] + delta[1]], options)
    }

    /// `alignHandle(dx, dy, options)`: the handle on the axis through its pivot.
    pub(crate) fn align_handle(&mut self, dx: f64, dy: f64, options: &Value) -> Result<bool, EditError> {
        finite(dx)?;
        finite(dy)?;
        let magnitude = styk_math::hypot(dx, dy);
        if magnitude == 0.0 {
            return Ok(false);
        }
        let Some((slot, joint)) = self.select_handle(options)?.filter(|(_, joint)| *joint >= 0) else { return Ok(false) };
        let figures = self.drawn_figures()?;
        let Some(figure) = figures.get(slot).and_then(Option::as_ref) else { return Err(EditError::Unported("a handle the engine does not draw".into())) };
        let Some(shape) = figure.shapes.get(joint as usize) else { return Ok(false) };
        let pivot = if flag(options, "wholeFigure") { figure.root } else { shape.start };
        let distance = styk_math::hypot(shape.end[0] - pivot[0], shape.end[1] - pivot[1]);
        self.apply_handle_target([pivot[0] + distance * dx / magnitude, pivot[1] + distance * dy / magnitude], options)
    }

    /// `locateEditedHandle(direction, {uid, jointIndex, handleId, bend})`: the handle moved
    /// (Handle Edit Mode) to where it is on the previous or next key.
    pub(crate) fn locate_edited_handle(&mut self, direction: f64, options: &Value) -> Result<bool, EditError> {
        if direction != -1.0 && direction != 1.0 {
            return Err(EditError::Invalid("errors.editorHandleCommands.chooseThePreviousOrNextFrame".into()));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let index = self.frame_index as i64 + direction as i64;
        let keys = self.report.get("keyframes").and_then(Value::array_len).unwrap_or(0) as i64;
        if index < 0 || index >= keys {
            return Ok(false);
        }
        let current = self.selection_frame()?;
        let target = match options.get("uid") {
            Some(value) => value.as_f64().filter(|v| v.fract() == 0.0 && *v >= 0.0).map(|v| v as u32),
            None => self.selection.uid,
        };
        let Some(object) = target.and_then(|id| current.iter().find(|o| uid(o) == Some(id))) else { return Ok(false) };
        let segments: Vec<Value> = self.figure_record(object).and_then(|f| f.get("segments").and_then(Value::elements).map(|e| e.iter().collect())).unwrap_or_default();
        let joint = options.get("jointIndex").and_then(Value::as_f64).map_or(self.selection.joint, |j| j as i64);
        let handle = match options.get("handleId") {
            Some(value) => value.as_f64().unwrap_or(f64::NAN),
            None if joint < 0 => 0.0,
            None => segments.get(joint as usize).and_then(|s| num(s, "segment_id")).unwrap_or(f64::NAN),
        };
        if !(handle.fract() == 0.0 && handle >= 0.0) {
            return Ok(false);
        }
        let rows = crate::timeline::rows(&self.report);
        let Some(row) = rows.get(index as usize).copied() else { return Ok(false) };
        // Without a layer sheet or saved channels a hidden (zero-length) key is read as the frame itself: it shares its tick with the key after it, which the tick would give.
        let hidden = rows.get(index as usize + 1).is_some_and(|next| next.start == row.start);
        let own = hidden && !self.sheet() && self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) == 0;
        let neighbour = match own.then(|| self.report.get("keyframes").and_then(|k| k.item(index as usize))).flatten() {
            Some(key) => key,
            None => self.evaluated(row.start, true)?,
        };
        let id = target.unwrap();
        let point = self.joint_in_frame(&neighbour, id, handle)?;
        let Some(point) = point else { return Ok(false) };
        let mut select = Obj::new();
        for (key, value) in entries(options) {
            select.set(&key, value);
        }
        select.set("uid", Value::Num(id as f64));
        select.set("handleId", Value::Num(handle));
        if self.select_handle(&Value::object(select))?.is_none() {
            return Ok(false);
        }
        let mut edit = Obj::new();
        edit.set("bend", Value::Bool(flag(options, "bend")));
        self.edit_handle_position(point[0], point[1], &Value::object(edit))
    }

    /// `buildGeometry(report, frame).objects.get(slot)?.joints.get(handle)` for a figure of
    /// another frame.
    pub(crate) fn joint_in_frame(&self, record: &Value, id: u32, handle: f64) -> Result<Option<[f64; 2]>, EditError> {
        if !crate::frame::objects_of(record).iter().any(|o| uid(o) == Some(id)) {
            return Ok(None);
        }
        let prepared = self.prepared()?;
        let frame = self.eval.borrow_mut().loader.edit_frame(record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        let scene = styk_eval::geometry::build(&prepared.doc, &frame);
        let Some(geometry) = scene.objects.iter().find(|g| g.uid == id && g.resolved) else { return Ok(None) };
        if handle == 0.0 {
            return Ok(Some(geometry.root));
        }
        let Some(evaluated) = frame.objects.iter().find(|o| o.uid == id) else { return Ok(None) };
        let figure = evaluated.figure_override.as_ref().or_else(|| prepared.doc.figure(evaluated.figure));
        let index = figure.and_then(|f| f.segments.iter().position(|s| s.id as f64 == handle));
        Ok(index.and_then(|i| geometry.ends.get(i).copied()))
    }

    /// `segmentValues({relative})`: the selected segment's angle and bend in degrees and its
    /// unscaled length.
    pub(crate) fn segment_values(&self, options: &Value) -> Result<Value, EditError> {
        let Some(values) = self.segment_values_of(flag(options, "relative"))? else { return Ok(Value::Null) };
        let mut out = Obj::new();
        out.set("angle", Value::Num(values[0]));
        out.set("bend", Value::Num(values[1]));
        out.set("length", Value::Num(values[2]));
        Ok(Value::object(out))
    }

    fn segment_values_of(&self, relative: bool) -> Result<Option<[f64; 3]>, EditError> {
        let Some(slot) = self.selection.uid.and_then(|id| self.selection_frame().ok()?.iter().position(|o| uid(o) == Some(id))) else { return Ok(None) };
        if self.selection.joint < 0 {
            return Ok(None);
        }
        let figures = self.drawn_figures()?;
        let Some(figure) = figures.get(slot).and_then(Option::as_ref) else { return Ok(None) };
        let joint = self.selection.joint as usize;
        let Some(shape) = figure.shapes.get(joint) else { return Ok(None) };
        let reference = if relative { relative_reference(&figures, slot, joint) } else { 0.0 };
        let length = if figure.scale.abs() > 1e-9 {
            shape.length / figure.scale.abs()
        } else if figure.object.get("len_flag").is_some_and(Value::truthy) {
            figure.object.get("lengths").and_then(|l| l.item(joint)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)
        } else {
            shape.definition_length
        };
        Ok(Some([styk_math::shortest(shape.angle - reference) * DEG, shape.bend * DEG, length]))
    }

    /// `beginSegmentValueEdit(options)`.
    pub(crate) fn begin_segment_value_edit(&mut self, options: &Value) -> Result<bool, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(false) };
        let count = self.figure_record(&object).and_then(|f| f.get("segments").and_then(Value::array_len)).unwrap_or(0) as i64;
        if self.selection.joint < 0 || self.selection.joint >= count {
            return Ok(false);
        }
        let began = if flag(options, "editMode") {
            let mut begin = Obj::new();
            begin.set("label", Value::str("Edit segment values"));
            self.begin_handle_edit_drag(&Value::object(begin))?
        } else {
            self.begin_drag("Edit segment values", false)?
        };
        if began {
            self.drag.as_mut().unwrap().segment_value_options = Some(merged(None, options));
        }
        Ok(began)
    }

    /// `setSegmentValues(values, options)`.
    pub(crate) fn set_segment_values(&mut self, values: &Value, options: &Value) -> Result<bool, EditError> {
        let options = merged(self.drag.as_ref().and_then(|d| d.segment_value_options.as_ref()), options);
        let entries = values.as_obj().map(|_| entries(values));
        let Some(entries) = entries.filter(|e| e.iter().all(|(key, _)| ["angle", "bend", "length"].contains(&key.as_ref()))) else {
            return Err(EditError::Invalid("errors.editorHandleCommands.chooseSegmentAngleBendAndLengthValues".into()));
        };
        let given = |key: &str| entries.iter().find(|(k, _)| k.as_ref() == key).map(|(_, v)| v.as_f64().unwrap_or(f64::NAN));
        for (_, value) in &entries {
            finite(value.as_f64().unwrap_or(f64::NAN))?;
        }
        if given("length").is_some_and(|l| !(l > 0.0)) {
            return Err(EditError::Invalid(LENGTH.into()));
        }
        let Some((_, object)) = self.object()? else { return Ok(false) };
        let count = self.figure_record(&object).and_then(|f| f.get("segments").and_then(Value::array_len)).unwrap_or(0) as i64;
        let index = self.selection.joint;
        if index < 0 || index >= count || entries.is_empty() {
            return Ok(false);
        }
        let relative = flag(&options, "relative");
        let Some(previous) = self.segment_values_of(relative)? else { return Err(EditError::Unported("segment values of a segment not drawn".into())) };
        let unchanged = entries.iter().all(|(key, value)| {
            let value = value.as_f64().unwrap_or(f64::NAN);
            match key.as_ref() {
                "angle" => styk_math::shortest((value - previous[0]) * RAD).abs() < 1e-12,
                "bend" => value == previous[1],
                _ => value == previous[2],
            }
        });
        if unchanged {
            return Ok(false);
        }
        let active = self.drag.is_some();
        if !active && !self.begin_segment_value_edit(&options)? {
            return Ok(false);
        }
        let result = self.apply_segment_values(index as usize, &given, relative, flag(&options, "editMode"), flag(&options, "isolate")).and_then(|()| {
            self.touch()?;
            if !active { self.commit_drag().map(|_| ()) } else { Ok(()) }
        });
        if let Err(error) = result {
            self.cancel_drag()?;
            return Err(error);
        }
        Ok(true)
    }

    fn apply_segment_values(&mut self, index: usize, given: &dyn Fn(&str) -> Option<f64>, relative: bool, edit_mode: bool, isolate: bool) -> Result<(), EditError> {
        let id = self.selection.uid;
        let Some(slot) = id.and_then(|id| self.selection_frame().ok()?.iter().position(|o| uid(o) == Some(id))) else { return Err(EditError::Unported("segment values outside the frame".into())) };
        let figures = self.drawn_figures()?;
        let Some(figure) = figures.get(slot).and_then(Option::as_ref) else { return Err(EditError::Unported("segment values of a figure not drawn".into())) };
        let shape = figure.shapes[index].clone();
        let drawn_bends: Vec<f64> = figure.shapes.iter().map(|s| s.bend).collect();
        let reference = if relative { relative_reference(&figures, slot, index) } else { 0.0 };
        let angle = given("angle").map_or(shape.angle, |a| a * RAD + reference);
        let bend = given("bend").map_or(shape.bend, |b| b * RAD);
        let length = match given("length") {
            Some(length) => length,
            None => self.segment_values_of(false)?.map_or(f64::NAN, |v| v[2]),
        };
        let record_slot = self.frame_objects().iter().position(|o| uid(o) == id).ok_or_else(|| EditError::Unported("segment values outside the frame".into()))?;
        if edit_mode {
            if !self.drag.as_ref().is_some_and(|d| d.handle_edit.is_some()) {
                return Err(EditError::Invalid("errors.editorHandleCommands.beginAHandleEditValueGestureBeforeChanging".into()));
            }
            let scale = num(&self.frame_objects()[record_slot], "scale").unwrap_or(f64::NAN);
            let Some(end) = arc_end(shape.start, angle, length * scale, bend) else { return Err(EditError::Unported("segment values without an arc".into())) };
            self.edit_handle_position(end[0], end[1], &Value::Null)?;
            let object = self.frame_object_mut(record_slot).unwrap();
            crate::pose::set_item(object, "angles", index, shape.angle + styk_math::shortest(angle - shape.angle));
            object.set("len_flag", Value::Num(1.0));
            crate::pose::set_item(object, "lengths", index, length);
        } else {
            let (angle_delta, bend_delta) = (styk_math::shortest(angle - shape.angle), bend - shape.bend);
            if angle_delta.abs() > 1e-12 {
                self.rotate_joint_by(slot, index, angle_delta, true, isolate)?;
            }
            if bend_delta.abs() > 1e-12 {
                self.rotate_joint_by(slot, index, bend_delta, false, isolate)?;
            }
            if given("length").is_some() {
                let object = self.frame_object_mut(record_slot).unwrap();
                if !object.get("len_flag").is_some_and(Value::truthy) {
                    let scale = num(&Value::object(object.clone()), "scale").unwrap_or(f64::NAN);
                    let lengths: Vec<f64> = figure.shapes.iter().map(|s| if scale.abs() > 1e-9 { s.length / scale.abs() } else { s.definition_length }).collect();
                    object.set("lengths", Value::nums(&lengths));
                }
                object.set("len_flag", Value::Num(1.0));
                crate::pose::set_item(object, "lengths", index, length);
            }
        }
        let object = self.frame_object_mut(record_slot).unwrap();
        if given("bend").is_some() {
            if !object.get("bend_flag").is_some_and(Value::truthy) {
                object.set("bends", Value::nums(&drawn_bends));
            }
            object.set("bend_flag", Value::Num(1.0));
            crate::pose::set_item(object, "bends", index, bend);
        }
        object.remove("runtime_segments");
        Ok(())
    }

    /// `copySegmentValues(options)`: `Angle:Bend:Length`, kept for pasting.
    pub(crate) fn copy_segment_values(&mut self, options: &Value) -> Result<Value, EditError> {
        let Some(values) = self.segment_values_of(flag(options, "relative"))? else { return Ok(Value::Null) };
        let text = values.iter().map(|v| finite(*v).map(|v| styk_doc::json::to_string(&Value::Num(v)))).collect::<Result<Vec<_>, _>>()?.join(":");
        self.segment_values_clipboard = Some(text.clone());
        Ok(Value::str(&text))
    }

    /// `pasteSegmentValues(text, options)`.
    pub(crate) fn paste_segment_values(&mut self, text: Option<&Value>, options: &Value) -> Result<bool, EditError> {
        let text = match text {
            None => self.segment_values_clipboard.clone(),
            Some(value) => value.as_str().map(str::to_string),
        };
        let values = parse_segment_values(text.as_deref())?;
        self.set_segment_values(&values, options)
    }
}

/// `parseSegmentValues(text)`: up to three numbers separated by colons, malformed tokens skipped.
fn parse_segment_values(text: Option<&str>) -> Result<Value, EditError> {
    let Some(text) = text.filter(|t| t.encode_utf16().count() <= 100) else {
        return Err(EditError::Invalid("errors.editorHandleCommands.pasteUpTo100CharactersOfAngleBend".into()));
    };
    let mut numbers = Vec::new();
    for token in text.split(':') {
        let Some(value) = numeric_token(token) else { continue };
        if value.is_finite() {
            numbers.push(value);
        }
        if numbers.len() == 3 {
            break;
        }
    }
    let mut out = Obj::new();
    for (value, key) in numbers.iter().zip(["angle", "bend", "length"]) {
        out.set(key, Value::Num(*value));
    }
    if numbers.len() == 3 && !(numbers[2] > 0.0) {
        return Err(EditError::Invalid(LENGTH.into()));
    }
    Ok(Value::object(out))
}

/// A token matching `^\s*[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?\s*$` (case-insensitive),
/// read as `Number(token.trim().replace(',', '.'))`.
fn numeric_token(token: &str) -> Option<f64> {
    let trimmed = token.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < bytes.len() && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    if digits(&mut i) {
        if i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b',') {
            i += 1;
            digits(&mut i);
        }
    } else if i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b',') {
        i += 1;
        if !digits(&mut i) {
            return None;
        }
    } else {
        return None;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    trimmed.replacen(',', ".", 1).parse::<f64>().ok()
}

/// `segmentRelativeReference(geometry, slot, jointIndex)`: the tangent at the end of the
/// segment coming into the joint's start, through joined origins when needed.
fn relative_reference(figures: &[Option<Figure>], slot: usize, joint: usize) -> f64 {
    let mut at = Some(slot);
    let mut vertex = figures.get(slot).and_then(Option::as_ref).and_then(|f| f.shapes.get(joint)).map_or(f64::NAN, |s| s.parent);
    let mut seen = Vec::new();
    while let Some(current) = at.filter(|s| !seen.contains(s)) {
        seen.push(current);
        let Some(figure) = figures.get(current).and_then(Option::as_ref) else { return 0.0 };
        if let Some(incoming) = figure.shapes.iter().find(|s| s.id == vertex) {
            return incoming.angle + incoming.bend;
        }
        let Some(join) = figure.object.get("join").filter(|j| j.truthy()) else { return 0.0 };
        vertex = join.get("target_handle_id").filter(|h| !h.is_null()).map_or(0.0, |h| h.as_f64().unwrap_or(f64::NAN));
        at = num(&join, "target_object_slot").map(|s| s as usize);
    }
    0.0
}

/// The linear part of `cameraMatrix` for a camera that is not the identity, at workspace zoom
/// `zoom`: `[a, b, -b, a]` from the inverse camera scale (`inverseCameraScale`) and angle.
pub(crate) fn camera_linear(camera: &Value, zoom: f64) -> Result<[f64; 4], EditError> {
    let number = |key: &str, fallback: f64| camera.get(key).filter(|v| !v.is_null()).map_or(fallback, |v| v.as_f64().unwrap_or(f64::NAN));
    let inverse = (1.0f32 / (number("scale", 1.0) as f32)) as f64;
    if !inverse.is_finite() || inverse <= 0.0 {
        return Err(EditError::Invalid("errors.background.cameraScaleExceedsTheNativeRenderingRange".into()));
    }
    let scale = inverse * zoom;
    let angle = -number("angle_rad", 0.0);
    let (a, b) = (styk_math::cos(angle) * scale, styk_math::sin(angle) * scale);
    Ok([a, b, -b, a])
}

impl Editor {
    /// `effectiveCamera(report, frame, cameraEnabled)` when it is not the identity: the frame's
    /// camera unless switched off or its track hidden. `cameraAtTime` adds the camera motion
    /// clips at the tick the frame was evaluated at (`_cameraMotionTick`, which the engine's
    /// records leave out), through the current prepared document's shared follow paths.
    pub(crate) fn effective_camera(&self, frame: &Value, enabled: bool, tick: f64) -> Result<Option<Value>, EditError> {
        let shown = self.report.path(&["_styk", "layers", "fixed", "camera", "visible"]).is_none_or(|v| !matches!(v, Value::Bool(false)));
        if !enabled || !shown {
            return Ok(None);
        }
        let camera = self.camera_at_time(frame, tick)?;
        Ok(if camera_is_identity(camera.clone()) { None } else { camera })
    }

    /// `cameraAtTime(report, frame)`: follow travel, then preset impulses. Keep the record's
    /// own fields and spread order; typed evaluation owns the sampler and stored arithmetic.
    pub(crate) fn camera_at_time(&self, frame: &Value, tick: f64) -> Result<Option<Value>, EditError> {
        let camera = self.camera_travel_at(frame, tick)?;
        if self.report.path(&["_styk", "cameraMotion", "clips"]).and_then(Value::array_len).is_none_or(|count| count == 0) { return Ok(camera); }
        let prepared = self.prepared()?;
        if prepared.doc.camera_motion.is_empty() { return Ok(camera); }
        Ok(match styk_eval::camera::impulse(&prepared.doc.camera_motion, tick, prepared.doc.fps) {
            Some(impulse) => Some(moved_camera(camera, &impulse)),
            None => camera,
        })
    }

    /// `cameraTravelAt(report, frame)`: the frame's camera moved by the clips that follow figures, where the camera
    /// actually is and what parallax layers respond to.
    pub(crate) fn camera_travel_at(&self, frame: &Value, tick: f64) -> Result<Option<Value>, EditError> {
        let camera = frame.get("camera").cloned().filter(|c| !c.is_null());
        if self.report.path(&["_styk", "cameraMotion", "clips"]).and_then(Value::array_len).is_none_or(|count| count == 0) { return Ok(camera); }
        let prepared = self.prepared()?;
        if prepared.doc.camera_motion.is_empty() { return Ok(camera); }
        let base = camera.as_ref().map(|c| styk_eval::doc::Camera {
            x: num(c, "x").unwrap_or(0.0), y: num(c, "y").unwrap_or(0.0),
            scale: num(c, "scale").unwrap_or(1.0), angle: num(c, "angle_rad").unwrap_or(0.0),
            is_default: c.get("is_default").is_some_and(Value::truthy), motion_offset: None,
        });
        let travel = prepared.travel(base, tick);
        if travel == base {
            return Ok(camera);
        }
        let Some(travel) = travel else { return Ok(camera) };
        let mut out = camera.filter(|c| !c.get("is_default").is_some_and(Value::truthy)).and_then(|c| c.as_obj().cloned()).unwrap_or_default();
        out.set("is_default", Value::Bool(false));
        out.set("x", Value::Num(travel.x));
        out.set("y", Value::Num(travel.y));
        out.set("scale", Value::Num(travel.scale));
        out.set("angle_rad", Value::Num(travel.angle));
        Ok(Some(Value::object(out)))
    }
}

/// `cameraAtTime`'s camera: `{...c, is_default: false, scale, x, y, angle_rad}`, `c` the
/// frame's camera (nothing for the default camera) moved by the impulse.
fn moved_camera(camera: Option<Value>, impulse: &styk_eval::camera::Impulse) -> Value {
    let mut c = camera.filter(|c| !c.get("is_default").is_some_and(Value::truthy)).and_then(|c| c.as_obj().cloned()).unwrap_or_default();
    let number = |c: &Obj, key: &str, fallback: f64| c.get(key).filter(|v| !v.is_null()).map_or(fallback, |v| v.as_f64().unwrap_or(f64::NAN));
    let [x, y, scale, angle] = styk_eval::camera::moved([number(&c, "x", 0.0), number(&c, "y", 0.0), number(&c, "scale", 1.0), number(&c, "angle_rad", 0.0)], impulse);
    c.set("is_default", Value::Bool(false));
    c.set("scale", Value::Num(scale));
    c.set("x", Value::Num(x));
    c.set("y", Value::Num(y));
    c.set("angle_rad", Value::Num(angle));
    Value::object(c)
}

pub(crate) fn camera_is_identity(camera: Option<Value>) -> bool {
    let Some(camera) = camera.filter(|c| !c.is_null()) else { return true };
    if camera.get("is_default").is_some_and(Value::truthy) {
        return true;
    }
    let number = |key: &str, fallback: f64| camera.get(key).filter(|v| !v.is_null()).map_or(fallback, |v| v.as_f64().unwrap_or(f64::NAN));
    let zero = |value: f64| {
        let magnitude = value.abs();
        let epsilon = (magnitude as f32 * 1.25e-6f32) as f64;
        magnitude <= if epsilon != 0.0 { epsilon } else { 6.25e-37f32 as f64 }
    };
    zero(number("x", 0.0)) && zero(number("y", 0.0)) && number("angle_rad", 0.0).abs() <= 1e-12 && (number("scale", 1.0) - 1.0).abs() <= 1e-4f32 as f64
}
