//! Polygons of the selected figure's definition: created,
//! reshaped, reordered and deleted, each one `figure` history entry (`editDefinition`).
//! Colour edits of a figure on show are recoloured ([`crate::recolor`]), opacity edits keyed;
//! a face visibility surface is checked against the joints of the figure on show.

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind};
use crate::{EditError, Editor};

const MAX_POLYGONS: usize = 20000;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// `finite(value, label, minimum, maximum)`.
fn finite(value: Option<&Value>, label: &str, minimum: f64, maximum: f64) -> Result<f64, EditError> {
    crate::builder::builder_finite(value, label, minimum, maximum)
}

/// `rgb(value)`: `#rrggbb` or three bytes.
pub(crate) fn rgb(value: Option<&Value>) -> Result<Value, EditError> {
    let bad = || invalid("errors.editorBuilderBranch.colorMustBeASixDigitHexColor");
    if let Some(text) = value.and_then(Value::as_str) {
        let hex = text.strip_prefix('#').filter(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(bad)?;
        return Ok(Value::array((0..3).map(|i| Value::Num(u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0) as f64)).collect()));
    }
    let items: Vec<Value> = value.and_then(Value::elements).map(|e| e.iter().collect()).ok_or_else(bad)?;
    let byte = |v: &Value| v.as_f64().is_some_and(|n| n.fract() == 0.0 && (0.0..=255.0).contains(&n));
    if items.len() != 3 || !items.iter().all(byte) {
        return Err(bad());
    }
    Ok(Value::array(items))
}

/// `Math.round(x)` for finite values: halves go up.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `vertexIds(figure, values)`: at least three distinct handles of the figure, a closing
/// repeat of the first dropped, no handle next to itself.
fn vertex_ids(figure: &Value, values: Option<&Value>) -> Result<Vec<f64>, EditError> {
    let Some(values) = values.and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()) else {
        return Err(invalid("errors.editorBuilder.chooseAtLeastThreeFigureHandlesForA"));
    };
    let bad = || invalid("errors.editorBuilder.aPolygonNeedsAtLeastThreeDistinctExisting");
    let mut ids: Vec<f64> = Vec::with_capacity(values.len());
    for value in &values {
        match value {
            Value::Num(n) if n.fract() == 0.0 && n.is_finite() => ids.push(*n),
            _ => return Err(bad()),
        }
    }
    if ids.len() > 1 && ids.first() == ids.last() {
        ids.pop();
    }
    let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let valid = |id: f64| id == 0.0 || segments.iter().any(|s| s.get("segment_id").and_then(Value::as_f64) == Some(id));
    let distinct = ids.iter().enumerate().all(|(i, id)| !ids[..i].contains(id));
    if ids.len() < 3 || ids.len() > 65535 || !distinct || ids.iter().enumerate().any(|(i, id)| !valid(*id) || *id == ids[(i + 1) % ids.len()]) {
        return Err(bad());
    }
    Ok(ids)
}

/// `polygonCycle(ids)`: the cycle read from its smallest handle, in the direction that
/// sorts first as text.
fn polygon_cycle(ids: &[f64]) -> String {
    let mut start = 0;
    for i in 1..ids.len() {
        if ids[i] < ids[start] {
            start = i;
        }
    }
    let n = ids.len();
    let text = |list: Vec<f64>| list.iter().map(|id| styk_doc::json::to_string(&Value::Num(*id))).collect::<Vec<_>>().join(",");
    let forward = text((0..n).map(|i| ids[(start + i) % n]).collect());
    let reverse = text((0..n).map(|i| ids[(start + n - i) % n]).collect());
    if forward <= reverse { forward } else { reverse }
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    value.and_then(Value::elements).map(|e| e.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default()
}

/// `rejectDuplicatePolygon(figure, polygon)`: another polygon of the figure drawing the
/// same cycle (`skip` is the polygon itself, when it is already in the figure).
fn reject_duplicate(figure: &Obj, polygon: &Obj, skip: Option<usize>) -> Result<(), EditError> {
    let ids = numbers(polygon.get("segment_ids"));
    let cycle = polygon_cycle(&ids);
    let others: Vec<Value> = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    for (i, other) in others.iter().enumerate() {
        if Some(i) == skip {
            continue;
        }
        let theirs = other.get("segment_ids").and_then(Value::array_len);
        if theirs == Some(ids.len()) && polygon_cycle(&numbers(other.get("segment_ids"))) == cycle {
            return Err(invalid("errors.editorBuilder.aPolygonAlreadyUsesThisConnectionCycle"));
        }
    }
    Ok(())
}

/// `patchPolygon(figure, polygon, patch)`.
fn patch_polygon(figure: &Value, polygon: &mut Obj, patch: &Obj) -> Result<(), EditError> {
    if patch.contains("handleIds") {
        let ids = vertex_ids(figure, patch.get("handleIds"))?;
        polygon.set("segment_ids", Value::nums(&ids));
    }
    if patch.contains("color") {
        polygon.set("color_rgb", rgb(patch.get("color"))?);
    }
    if patch.contains("opacity") {
        let alpha = js_round(255.0 * (1.0 - finite(patch.get("opacity"), "Opacity", 0.0, 1.0)?));
        polygon.set("alpha_raw", Value::Num(alpha));
        polygon.set("color_alpha", Value::Num(1.0 - alpha / 255.0));
    }
    if patch.contains("zOrder") {
        let order = finite(patch.get("zOrder"), "Polygon order", f64::NEG_INFINITY, f64::INFINITY)?;
        polygon.set("z_order", Value::Num(order));
        polygon.set("z_order_runtime_raw", Value::Num(order - 1.0));
    }
    if patch.contains("surface") {
        match patch.get("surface") {
            Some(Value::Null) => {
                polygon.remove("_stykSurface");
            }
            Some(surface) => polygon.set("_stykSurface", surface.clone()),
            None => {}
        }
    }
    let ids = polygon.get("segment_ids").cloned().unwrap_or(Value::Null);
    let copy = Value::nums(&numbers(Some(&ids)));
    polygon.set("segment_ids_raw", if ids.is_array() { copy } else { Value::Null });
    polygon.set("vertex_id_space", Value::str("joint_tip_ids"));
    Ok(())
}

impl Editor {
    /// `editor.figure` and its index: the definition of the figure selected, if any.
    fn selected_definition(&self) -> Result<Option<(usize, Value)>, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(None) };
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        Ok(figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")).map(|i| (i, figures[i].clone())))
    }

    /// `editDefinition(editor, label, mutate)`: the selected figure's definition changed as
    /// one `figure` entry; the changed definition, or `false` when nothing changed.
    pub(crate) fn edit_definition(&mut self, label: &str, mutate: impl FnOnce(&Value, &mut Obj) -> Result<(), EditError>) -> Result<Value, EditError> {
        let Some((index, before)) = self.selected_definition()? else { return Ok(Value::Bool(false)) };
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let mut figure = before.as_obj().cloned().unwrap_or_default();
        mutate(&before, &mut figure)?;
        // `validateScene` on the definition: what a polygon edit can make invalid.
        let handles: Vec<f64> = std::iter::once(0.0).chain(figure.get("segments").and_then(Value::elements).map(|e| e.iter().filter_map(|s| s.get("segment_id").and_then(Value::as_f64)).collect::<Vec<_>>()).unwrap_or_default()).collect();
        for polygon in figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            if polygon.get("_stykSurface").is_some() {
                crate::load::validate_surface(&polygon, &handles)?;
            }
            if let Some(order) = polygon.get("z_order").and_then(Value::as_f64)
                && !((order as f32) as f64).is_finite()
            {
                return Err(crate::invalid_with("errors.model.exceedsTheNativeFloat32Range", vec![("label", crate::label("Polygon drawing order"))]));
            }
        }
        let after = Value::object(figure.clone());
        if styk_doc::json::to_string(&before) == styk_doc::json::to_string(&after) {
            return Ok(Value::Bool(false));
        }
        figure.remove("segment_z_raw");
        figure.remove("poly_z_raw");
        let after = Value::object(figure);
        // The selection is kept as it was before the edit (a deleted fill is still the one selected when undone).
        let selection = self.selection_state();
        if let Some(slot) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(index)) {
            *slot = after.clone();
        }
        self.record(Command { kind: CommandKind::Figure { index, before, after: after.clone() }, label: label.into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("definition", Value::Bool(true))]);
        Ok(after)
    }

    /// `addPolygon(handleIds, {color, opacity, zOrder})`: a fill through the handles, behind
    /// the figure's skeleton unless an order is given. Returns the polygon.
    pub(crate) fn add_polygon(&mut self, handles: &Value, options: &Value) -> Result<Value, EditError> {
        if self.selected_definition()?.is_none() {
            return Err(invalid("errors.editorBuilder.selectAFigureBeforeCreatingAPolygon"));
        }
        let mut created = None;
        self.edit_definition("Create polygon", |before, figure| {
            let polygons: Vec<Value> = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            if !figure.contains("polyfills") {
                figure.set("polyfills", Value::array(Vec::new()));
            }
            if polygons.len() >= MAX_POLYGONS {
                return Err(invalid("errors.editorBuilder.aFigureSupportsAtMost20000Polygons"));
            }
            let largest = polygons.iter().enumerate().map(|(i, p)| p.get("polyfill_id").filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(i as f64 + 1.0)).fold(0.0, f64::max);
            let next = figure.get("_styk").and_then(|s| s.get("nextPolygonId")).filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(1.0);
            let id = next.max(largest + 1.0);
            let mut styk = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.set("nextPolygonId", Value::Num(id + 1.0));
            figure.set("_styk", Value::object(styk));
            let order = match options.get("zOrder") {
                Some(order) if !order.is_null() => order.clone(),
                _ => {
                    let orders = numbers(Some(&Value::array(
                        figure.get("segments").and_then(Value::elements).map(|e| e.iter().map(|s| s.get("z_order").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(1.0))).collect()).unwrap_or_default(),
                    )))
                    .into_iter()
                    .chain(polygons.iter().map(|p| p.get("z_order").filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(1.0)));
                    Value::Num(orders.fold(1.0, |a: f64, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }) - 1.0)
                }
            };
            let mut patch = Obj::new();
            patch.set("handleIds", handles.clone());
            patch.set("color", options.get("color").cloned().unwrap_or_else(|| Value::str("#2b2b2b")));
            patch.set("opacity", options.get("opacity").cloned().unwrap_or(Value::Num(1.0)));
            patch.set("zOrder", order);
            let mut polygon = Obj::new();
            polygon.set("polyfill_id", Value::Num(id));
            patch_polygon(before, &mut polygon, &patch)?;
            reject_duplicate(figure, &polygon, None)?;
            let mut list = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
            list.push(Value::object(polygon.clone()));
            figure.set("polyfills", Value::array(list));
            created = Some(Value::object(polygon));
            Ok(())
        })?;
        Ok(created.unwrap_or(Value::Null))
    }

    /// `updatePolygon(index, patch)`: the polygon's handles, order or surface removed.
    pub(crate) fn update_polygon(&mut self, index: &Value, patch: &Value) -> Result<Value, EditError> {
        let definition = self.selected_definition()?;
        let at = index.as_f64().filter(|i| i.fract() == 0.0 && *i >= 0.0).map(|i| i as usize);
        let exists = definition.as_ref().zip(at).is_some_and(|((_, figure), at)| figure.get("polyfills").and_then(|p| p.item(at)).is_some_and(|p| p.truthy()));
        let (Some(at), true) = (at, exists) else { return Err(invalid("errors.editorBuilderStyle.selectAnExistingPolygon")) };
        let empty = Obj::new();
        let patch = match patch {
            Value::Null => &empty,
            other => other.as_obj().ok_or_else(|| EditError::Unported("a polygon change that is not an object".into()))?,
        };
        if let Some(key) = patch.keys().find(|key| !["handleIds", "color", "opacity", "zOrder", "surface"].contains(&&***key)) {
            return Err(crate::invalid_with("errors.editorBuilder.polygonPropertyIsNotEditable", vec![("key", Value::str(key))]));
        }
        let style_only = patch.keys().all(|key| ["color", "opacity"].contains(&&**key));
        if style_only && patch.contains("color") {
            // Recoloured on the figure on show (`editFigureColors`).
            if let (Some((_, figure)), Some((_, object))) = (definition.clone(), self.object()?)
                && let Some(result) = self.recolor_polygon(&figure, &object, at, patch)
            {
                return result;
            }
            return Err(EditError::Unported("a polygon's colour without the overlay it is recoloured with".into()));
        }
        if style_only && self.options.property_channels {
            // Keyed on the figure on show (`addAnimationKeys`).
            let ((_, figure), Some((_, object))) = (definition.unwrap(), self.object()?) else { return Err(EditError::Unported("a polygon without its figure on show".into())) };
            let polygon = figure.get("polyfills").and_then(|p| p.item(at)).and_then(|p| p.get("polyfill_id").and_then(Value::as_f64)).unwrap_or(at as f64 + 1.0);
            let uid = object.get("unique_id").cloned().unwrap_or(Value::Null);
            let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
            return self.key_polygon_style(uid, polygon, type_id, patch);
        }
        // A surface is validated against the joints on show first (`editableSurface`).
        let editable;
        let patch = match patch.get("surface").filter(|surface| !surface.is_null()) {
            Some(surface) => {
                let figure = definition.as_ref().map(|(_, figure)| figure).unwrap_or(&Value::Null);
                let own = figure.get("polyfills").and_then(|p| p.item(at)).and_then(|p| p.get("segment_ids").cloned());
                let mut next = patch.clone();
                next.set("surface", self.editable_surface(surface, figure, patch.get("handleIds").cloned().or(own))?);
                editable = next;
                &editable
            }
            None => patch,
        };
        self.edit_definition("Edit polygon", |before, figure| {
            let mut polygons: Vec<Value> = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            let mut polygon = polygons[at].as_obj().cloned().unwrap_or_default();
            patch_polygon(before, &mut polygon, patch)?;
            if patch.contains("handleIds") {
                reject_duplicate(figure, &polygon, Some(at))?;
            }
            polygons[at] = Value::object(polygon);
            figure.set("polyfills", Value::array(polygons));
            Ok(())
        })
    }

    /// `editableSurface(surface, figure, joints, handleIds)`: a face visibility surface the figure on show can
    /// have. Its three reference joints must form a triangle where they are drawn.
    fn editable_surface(&self, surface: &Value, figure: &Value, handle_ids: Option<Value>) -> Result<Value, EditError> {
        let segments = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
        let handles: Vec<f64> = std::iter::once(0.0).chain(segments.iter().filter_map(|s| s.get("segment_id").and_then(Value::as_f64))).collect();
        let mut probe = Obj::new();
        probe.set("_stykSurface", surface.clone());
        probe.set("segment_ids", handle_ids.unwrap_or(Value::Null));
        crate::load::validate_surface(&Value::object(probe), &handles)?;
        let Some((slot, object)) = self.object()? else { return Err(invalid("errors.surfaces.referenceJointsMustFormATriangleChooseA")) };
        let (prepared, frame, scene) = self.evaluate_only(Some(&[slot]))?;
        let uid = crate::record::uid(&object);
        let drawn = frame.objects.iter().find(|o| Some(o.uid) == uid).and_then(|o| Some((prepared.doc.figure(o.figure)?, scene.objects.iter().find(|g| g.uid == o.uid && g.resolved)?)));
        let joint = |id: &Value| -> Option<[f64; 2]> {
            let id = id.as_f64()?;
            let (typed, geometry) = drawn?;
            if id == 0.0 { Some(geometry.root) } else { geometry.joint(typed, id as u32) }
        };
        let basis: Vec<Option<[f64; 2]>> = surface.get("basis").and_then(Value::elements).map(|e| e.iter().map(|id| joint(&id)).collect()).unwrap_or_default();
        let (cross, scale) = match basis.as_slice() {
            [Some(o), Some(x), Some(y)] => ((x[0] - o[0]) * (y[1] - o[1]) - (x[1] - o[1]) * (y[0] - o[0]), styk_math::hypot(x[0] - o[0], x[1] - o[1]) * styk_math::hypot(y[0] - o[0], y[1] - o[1])),
            _ => (0.0, 0.0),
        };
        if scale == 0.0 || scale.is_nan() || cross.abs() <= scale * 1e-7 {
            return Err(invalid("errors.surfaces.referenceJointsMustFormATriangleChooseA"));
        }
        let mut editable = Obj::new();
        editable.set("basis", surface.get("basis").cloned().unwrap_or(Value::Null));
        editable.set("side", surface.get("side").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::str("front")));
        editable.set("flipped", surface.get("flipped").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Bool(false)));
        if let Some(depth) = surface.get("depth").filter(|d| d.truthy()) {
            editable.set("depth", depth.clone());
        }
        if surface.get("depthTest").is_some_and(Value::truthy) {
            editable.set("depthTest", Value::Bool(true));
        }
        Ok(Value::object(editable))
    }

    /// `removePolygon(index)`: the polygon deleted; polygons without an identity take
    /// theirs from their place, and the next identity stays past every one.
    pub(crate) fn remove_polygon(&mut self, index: &Value) -> Result<Value, EditError> {
        let definition = self.selected_definition()?;
        let at = index.as_f64().filter(|i| i.fract() == 0.0 && *i >= 0.0).map(|i| i as usize);
        let exists = definition.as_ref().zip(at).is_some_and(|((_, figure), at)| figure.get("polyfills").and_then(|p| p.item(at)).is_some_and(|p| p.truthy()));
        let (Some(at), true) = (at, exists) else { return Ok(Value::Bool(false)) };
        self.edit_definition("Delete polygon", |_, figure| {
            let mut polygons: Vec<Value> = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            for (i, polygon) in polygons.iter_mut().enumerate() {
                if polygon.get("polyfill_id").is_none_or(Value::is_null)
                    && let Some(record) = polygon.make_obj()
                {
                    record.set("polyfill_id", Value::Num(i as f64 + 1.0));
                }
            }
            let next = figure.get("_styk").and_then(|s| s.get("nextPolygonId")).filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(1.0);
            let next = polygons.iter().map(|p| p.get("polyfill_id").and_then(Value::as_f64).unwrap_or(f64::NAN) + 1.0).fold(next, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) });
            let mut styk = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.set("nextPolygonId", Value::Num(next));
            figure.set("_styk", Value::object(styk));
            polygons.remove(at);
            figure.set("polyfills", Value::array(polygons));
            Ok(())
        })
    }
}
