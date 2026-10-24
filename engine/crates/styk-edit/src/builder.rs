//! The Build Figure workspace's styles of a figure definition (src/editor-builder-branch.mjs,
//! src/editor-builder.mjs, src/editor-builder-style.mjs): a segment's shape, colour, opacity,
//! thickness and construction flag, a branch's caps and circle fill, a polygon's opacity and the
//! figure's name and outline. Definition edits are one `native-properties` history entry of the
//! paths they change (or, for the figure's name, one `figure` entry); colours of a figure on show
//! are recoloured ([`crate::recolor`]) and, with property channels, opacity and thickness keyed
//! ([`crate::property_edit`]), as the editor does.

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::record::num;
use crate::{EditError, Editor};
pub(crate) mod native;

/// `kinds`: a segment's `segment_kind` by its primitive code.
pub(crate) const KINDS: [&str; 7] = ["line", "circle", "image", "circleFill", "circleClear", "text", "squareLine"];

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// A step of a path into a figure definition (`['segments', 3, 'thickness']`).
#[derive(Clone, Debug, PartialEq)]
pub enum Key {
    Field(String),
    Index(usize),
}

impl Key {
    fn value(&self) -> Value {
        match self {
            Key::Field(name) => Value::str(name),
            Key::Index(index) => Value::Num(*index as f64),
        }
    }
}

/// A path and its value; `None` when the field is absent (`{path, exists, value}`).
#[derive(Clone, Debug)]
pub struct Entry {
    pub path: Vec<Key>,
    pub value: Option<Value>,
}

/// `{entries, removeEmptyParents}` of a `native-properties` history entry.
#[derive(Clone, Debug, Default)]
pub struct Patch {
    pub entries: Vec<Entry>,
    pub remove_empty: Vec<Vec<Key>>,
}

impl Patch {
    /// The native property owner's enumerable patch, for worker history sizing.
    pub(crate) fn history_value(&self) -> Value {
        let mut patch = Obj::new();
        patch.set("entries", Value::array(self.entries.iter().map(|entry| {
            let mut object = Obj::new();
            object.set("path", Value::array(entry.path.iter().map(Key::value).collect()));
            object.set("exists", Value::Bool(entry.value.is_some()));
            if let Some(value) = &entry.value { object.set("value", value.clone()); }
            Value::object(object)
        }).collect()));
        patch.set("removeEmptyParents", Value::array(self.remove_empty.iter().map(|path| Value::array(path.iter().map(Key::value).collect())).collect()));
        Value::object(patch)
    }
}

fn segment_path(index: usize, field: &str) -> Vec<Key> {
    vec![Key::Field("segments".into()), Key::Index(index), Key::Field(field.into())]
}

fn polygon_path(index: usize, field: &str) -> Vec<Key> {
    vec![Key::Field("polyfills".into()), Key::Index(index), Key::Field(field.into())]
}

/// `field(path, value)`.
fn field(path: Vec<Key>, value: Value) -> Entry {
    Entry { path, value: Some(value) }
}

/// The entries as `JSON.stringify` writes them, to compare captures with patches.
fn entries_json(entries: &[Entry]) -> String {
    let list = entries
        .iter()
        .map(|entry| {
            let mut object = Obj::new();
            object.set("path", Value::array(entry.path.iter().map(Key::value).collect()));
            object.set("exists", Value::Bool(entry.value.is_some()));
            if let Some(value) = &entry.value {
                object.set("value", value.clone());
            }
            Value::object(object)
        })
        .collect();
    styk_doc::json::to_string(&Value::array(list))
}

/// `parent[key]` of an object or array node.
fn child(node: &Value, key: &Key) -> Option<Value> {
    match key {
        Key::Field(name) => node.get(name).cloned(),
        Key::Index(index) => node.item(*index),
    }
}

/// `capture(figure, paths)`: each path's value as the definition holds it.
pub(crate) fn capture(figure: &Value, paths: &[Vec<Key>]) -> Patch {
    let entries = paths
        .iter()
        .map(|path| {
            let mut node = Some(figure.clone());
            for key in &path[..path.len() - 1] {
                node = node.and_then(|n| child(&n, key));
            }
            let value = node.and_then(|n| child(&n, path.last().unwrap()));
            Entry { path: path.clone(), value }
        })
        .collect();
    Patch { entries, remove_empty: Vec::new() }
}

fn apply_at(node: &mut Value, path: &[Key], value: Option<&Value>) {
    let Some((first, rest)) = path.split_first() else { return };
    if rest.is_empty() {
        match first {
            Key::Field(name) => {
                if let Some(object) = node.make_obj() {
                    match value {
                        Some(value) => object.set(name, value.clone()),
                        None => {
                            object.remove(name);
                        }
                    }
                }
            }
            Key::Index(index) => {
                if let (Some(list), Some(value)) = (node.make_arr(), value)
                    && let Some(slot) = list.get_mut(*index)
                {
                    *slot = value.clone();
                }
            }
        }
        return;
    }
    // `parent = parent[key] ??= {}`.
    let next = match first {
        Key::Field(name) => {
            let Some(object) = node.make_obj() else { return };
            if object.get(name).is_none_or(Value::is_null) {
                object.set(name, Value::object(Obj::new()));
            }
            object.get_mut(name)
        }
        Key::Index(index) => {
            let Some(list) = node.make_arr() else { return };
            match list.get_mut(*index) {
                Some(slot) => {
                    if slot.is_null() {
                        *slot = Value::object(Obj::new());
                    }
                    Some(slot)
                }
                None => None,
            }
        }
    };
    if let Some(next) = next {
        apply_at(next, rest, value);
    }
}

/// `applyPatch(root, patch)` (src/native-property-edit.mjs): each entry set or deleted, missing
/// parents created, then the listed parents removed when left empty.
pub(crate) fn apply_patch(root: &mut Value, patch: &Patch) {
    for entry in &patch.entries {
        apply_at(root, &entry.path, entry.value.as_ref());
    }
    for path in &patch.remove_empty {
        let Some((last, parents)) = path.split_last() else { continue };
        let mut node = Some(root.clone());
        for key in parents {
            node = node.and_then(|n| child(&n, key));
        }
        let empty = node.and_then(|n| child(&n, last)).is_some_and(|v| v.as_obj().is_some_and(Obj::is_empty));
        if empty {
            apply_at(root, path, None);
        }
    }
}

/// `code(segment)`: its primitive code, else the index of its kind or type (-1 when unknown).
pub(crate) fn code(segment: &Value) -> f64 {
    if let Some(code) = segment.get("primitive_code").filter(|v| !v.is_null()) {
        return code.as_f64().unwrap_or(f64::NAN);
    }
    let kind = segment.get("segment_kind").filter(|v| !v.is_null()).or_else(|| segment.get("segment_type").filter(|v| !v.is_null()));
    match kind {
        None => 0.0,
        Some(kind) => kind.as_str().and_then(|k| KINDS.iter().position(|known| *known == k)).map_or(-1.0, |i| i as f64),
    }
}

fn is_circle(code: f64) -> bool {
    code == 1.0 || code == 3.0 || code == 4.0
}

/// ToInt32.
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    (x.trunc().rem_euclid(4_294_967_296.0) as u32) as i32
}

fn segments_of(figure: &Value) -> Vec<Value> {
    figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn polygons_of(figure: &Value) -> Vec<Value> {
    figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

/// `branch(figure, selectedIndex, whole, polygons)`: the selected segment and, with `whole`,
/// every segment below it in the document's order, the order they were reached in, and the
/// polygons whose every handle belongs to the branch or its pivot.
#[derive(Clone)]
pub(crate) struct Branch {
    pub indices: Vec<usize>,
    pub queue: Vec<usize>,
    pub polygons: Vec<usize>,
}

pub(crate) fn branch(figure: &Value, selected: usize, whole: bool, polygons: bool) -> Branch {
    let segments = segments_of(figure);
    let Some(segment) = segments.get(selected) else { return Branch { indices: Vec::new(), queue: Vec::new(), polygons: Vec::new() } };
    let id = |s: &Value| s.get("segment_id").cloned().unwrap_or(Value::Null);
    let key = |v: &Value| styk_doc::json::to_string(v);
    let mut children: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    if whole {
        for (index, s) in segments.iter().enumerate() {
            children.entry(key(&s.get("parent_id").cloned().unwrap_or(Value::Null))).or_default().push(index);
        }
    }
    let mut queue = vec![selected];
    let mut ids: Vec<String> = vec![key(&id(segment))];
    let mut i = 0;
    while i < queue.len() {
        for &index in children.get(&key(&id(&segments[queue[i]]))).map(Vec::as_slice).unwrap_or(&[]) {
            let child = key(&id(&segments[index]));
            if !ids.contains(&child) {
                ids.push(child);
                queue.push(index);
            }
        }
        i += 1;
    }
    let indices = if whole { (0..segments.len()).filter(|&i| ids.contains(&key(&id(&segments[i])))).collect() } else { vec![selected] };
    ids.push(key(&segment.get("parent_id").cloned().unwrap_or(Value::Null)));
    let polygons = if polygons && whole {
        polygons_of(figure)
            .iter()
            .enumerate()
            .filter(|(_, polygon)| polygon.get("segment_ids").and_then(Value::elements).is_some_and(|handles| handles.iter().all(|h| ids.contains(&key(&h)))))
            .map(|(index, _)| index)
            .collect()
    } else {
        Vec::new()
    };
    Branch { indices, queue, polygons }
}

/// `finite(value, label, min, max)` of src/editor-builder-branch.mjs.
pub(crate) fn branch_finite(value: Option<&Value>, label: &str, min: f64, max: f64) -> Result<f64, EditError> {
    match value {
        Some(Value::Num(n)) if n.is_finite() && *n >= min && *n <= max => Ok(*n),
        _ => Err(crate::out_of_range("errors.editorBuilderBranch.mustBeAFiniteNumberBetweenAnd", label, ("min", "max"), (min, max))),
    }
}

/// `finite(value, label, min, max)` of src/editor-builder.mjs.
pub(crate) fn builder_finite(value: Option<&Value>, label: &str, min: f64, max: f64) -> Result<f64, EditError> {
    match value {
        Some(Value::Num(n)) if n.is_finite() && *n >= min && *n <= max => Ok(*n),
        _ => Err(crate::out_of_range("errors.editorBuilder.mustBeAFiniteNumberBetweenAnd", label, ("minimum", "maximum"), (min, max))),
    }
}

/// `Math.round(x)`: halves go up.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn rgb_array(rgb: [f64; 3]) -> Value {
    Value::array(rgb.iter().map(|&c| Value::Num(c)).collect())
}

fn rgb_of(value: &Value) -> [f64; 3] {
    let n = |i: usize| value.item(i).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
    [n(0), n(1), n(2)]
}

/// `rgb(value)` as numbers.
fn rgb(value: Option<&Value>) -> Result<[f64; 3], EditError> {
    crate::polygons::rgb(value).map(|v| rgb_of(&v))
}

/// The validated values of a style patch (`stylePatch`).
#[derive(Default)]
struct Values {
    paint: Option<Value>,
    color: Option<[f64; 3]>,
    alpha: Option<f64>,
    thickness: Option<f64>,
    fixed: Option<bool>,
    gradient_color: Option<[f64; 3]>,
    gradient_alpha: Option<f64>,
    /// Which of `color`, `opacity` and `gradient` the patch names (a paint names all three).
    has_color: bool,
    has_opacity: bool,
    has_gradient: bool,
}

/// `stylePatch(figure, selectedIndex, patch, targets)`: the entries a style edit writes into the
/// definition, validated.
fn style_patch(figure: &Value, selected: usize, patch: &Obj, targets: &Branch) -> Result<(Vec<Entry>, Values), EditError> {
    for key in patch.keys() {
        if !["color", "opacity", "thickness", "static", "gradient", "paint"].contains(&&**key) {
            return Err(crate::invalid_with("errors.editorBuilderBranch.branchStyleIsNotEditableUseTheCaps", vec![("key", Value::str(key))]));
        }
    }
    let mut values = Values { has_color: patch.contains("color"), has_opacity: patch.contains("opacity"), has_gradient: patch.contains("gradient"), ..Values::default() };
    let mut color = patch.get("color").cloned();
    let mut opacity = patch.get("opacity").cloned();
    let mut gradient = patch.get("gradient").cloned();
    if patch.contains("paint") {
        let paint = crate::recolor::normalize_paint(patch.get("paint").unwrap_or(&Value::Null))?;
        let value = paint.value();
        let stops: Vec<Value> = value.get("stops").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let (first, last) = (stops.first().cloned().unwrap_or(Value::Null), stops.last().cloned().unwrap_or(Value::Null));
        color = first.get("color").cloned();
        opacity = first.get("opacity").cloned();
        gradient = Some(if paint.solid() {
            Value::Null
        } else {
            let mut end = Obj::new();
            end.set("color", last.get("color").cloned().unwrap_or(Value::Null));
            end.set("opacity", last.get("opacity").cloned().unwrap_or(Value::Null));
            Value::object(end)
        });
        values.paint = Some(value);
        values.has_color = true;
        values.has_opacity = true;
        values.has_gradient = true;
    }
    if values.has_color {
        values.color = Some(rgb(color.as_ref())?);
    }
    if values.has_opacity {
        values.alpha = Some(js_round(255.0 * (1.0 - branch_finite(opacity.as_ref(), "Opacity", 0.0, 1.0)?)));
    }
    if patch.contains("thickness") {
        values.thickness = Some(branch_finite(patch.get("thickness"), "Thickness", 0.0, 1e6)?);
    }
    if patch.contains("static") {
        match patch.get("static") {
            Some(Value::Bool(b)) => values.fixed = Some(*b),
            _ => return Err(invalid("errors.editorBuilderBranch.staticMustBeTrueOrFalse")),
        }
    }
    let segments = segments_of(figure);
    if values.has_gradient {
        match &gradient {
            None | Some(Value::Null) | Some(Value::Bool(false)) => {}
            Some(gradient) => {
                let fields = gradient.as_obj().filter(|_| gradient.truthy());
                let Some(fields) = fields.filter(|f| f.keys().all(|k| &**k == "color" || &**k == "opacity")) else {
                    return Err(invalid("errors.editorBuilderBranch.gradientMustContainAColorAndOpacityOr"));
                };
                let fallback = segments.get(selected).and_then(|s| s.path(&["secondary", "rgb"]).filter(|v| !v.is_null()).cloned());
                let color = fields.get("color").filter(|v| !v.is_null()).cloned().or(fallback).unwrap_or_else(|| Value::str("#ffffff"));
                values.gradient_color = Some(rgb(Some(&color))?);
                if fields.contains("opacity") {
                    values.gradient_alpha = Some(js_round(255.0 * (1.0 - branch_finite(fields.get("opacity"), "Opacity", 0.0, 1.0)?)));
                }
            }
        }
    }
    let mut entries = Vec::new();
    for &index in &targets.indices {
        let segment = segments.get(index).cloned().unwrap_or(Value::Null);
        let paint = segment.get("paint").filter(|p| p.truthy());
        if let Some(value) = &values.paint {
            entries.push(field(segment_path(index, "paint"), value.clone()));
        } else if let Some(paint) = paint.filter(|_| values.has_color || values.has_opacity || values.has_gradient) {
            let mut paint = paint.as_obj().cloned().unwrap_or_default();
            let mut stops: Vec<Value> = paint.get("stops").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            let set = |stop: &mut Value, key: &str, value: Value| {
                if let Some(stop) = stop.make_obj() {
                    stop.set(key, value);
                }
            };
            if let (Some(color), Some(first)) = (values.color, stops.first_mut()) {
                set(first, "color", rgb_array(color));
            }
            if let (Some(alpha), Some(first)) = (values.alpha, stops.first_mut()) {
                set(first, "opacity", Value::Num(1.0 - alpha / 255.0));
            }
            if values.has_gradient {
                match values.gradient_color {
                    None => {
                        paint.set("type", Value::str("solid"));
                        stops.truncate(1);
                    }
                    Some(color) => {
                        if let Some(last) = stops.last_mut() {
                            set(last, "color", rgb_array(color));
                            if let Some(alpha) = values.gradient_alpha {
                                set(last, "opacity", Value::Num(1.0 - alpha / 255.0));
                            }
                        }
                    }
                }
            }
            paint.set("stops", Value::array(stops));
            entries.push(field(segment_path(index, "paint"), Value::object(paint)));
        }
        if let Some(color) = values.color {
            entries.push(field(segment_path(index, "color_rgb"), rgb_array(color)));
        }
        if let Some(alpha) = values.alpha {
            entries.push(field(segment_path(index, "transparency"), Value::Num(alpha)));
            entries.push(field(segment_path(index, "color_alpha"), Value::Num(1.0 - alpha / 255.0)));
        }
        if let Some(thickness) = values.thickness {
            entries.push(field(segment_path(index, "thickness"), Value::Num(thickness)));
            entries.push(field(segment_path(index, "visible"), Value::Bool(thickness > 0.01 || code(&segment) > 0.0)));
        }
        if let Some(fixed) = values.fixed {
            // `(segment.aux_code ?? 0) & ~1 | Number(static)`, `code | aux << 8`, in 32-bit integers.
            let aux_code = segment.get("aux_code").filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN));
            let aux = (to_int32(aux_code) & !1) | fixed as i32;
            let flags = to_int32(code(&segment)) | aux.wrapping_shl(8);
            let mut bits = segment.get("flag_bits").and_then(Value::as_obj).cloned().unwrap_or_default();
            bits.set("is_static", Value::Bool(fixed));
            if bits.contains("raw") {
                bits.set("raw", Value::Num(flags as f64));
            }
            if bits.contains("high_byte") {
                bits.set("high_byte", Value::Num(aux as f64));
            }
            if bits.contains("set_bits") {
                bits.set("set_bits", Value::array((0..16).filter(|bit| flags & (1 << bit) != 0).map(|bit| Value::Num(bit as f64)).collect()));
            }
            entries.push(field(segment_path(index, "is_static"), Value::Bool(fixed)));
            entries.push(field(segment_path(index, "aux_code"), Value::Num(aux as f64)));
            entries.push(field(segment_path(index, "flags"), Value::Num(flags as f64)));
            entries.push(field(segment_path(index, "flag_bits"), Value::object(bits)));
        }
        if values.has_color || values.has_opacity || values.has_gradient {
            let mut secondary = segment.get("secondary").cloned();
            if values.has_gradient {
                secondary = Some(match values.gradient_color {
                    Some(color) => {
                        let previous = segment.get("secondary").filter(|s| s.truthy());
                        let mut next = previous.and_then(Value::as_obj).cloned().unwrap_or_default();
                        let a = values.gradient_alpha.map(Value::Num).or_else(|| previous.and_then(|s| s.get("a")).filter(|a| !a.is_null()).cloned()).unwrap_or(Value::Num(0.0));
                        next.set("rgb", rgb_array(color));
                        next.set("a", a);
                        Value::object(next)
                    }
                    None => Value::Null,
                });
            }
            let primary = values.color.map(rgb_array).or_else(|| segment.get("color_rgb").filter(|c| !c.is_null()).cloned()).unwrap_or_else(|| rgb_array([0.0; 3]));
            let alpha = values.alpha.map(Value::Num).or_else(|| segment.get("transparency").filter(|t| !t.is_null()).cloned()).unwrap_or(Value::Num(0.0));
            if let Some(held) = secondary.clone().filter(|s| s.truthy())
                && values.paint.is_none()
                && paint.is_none()
            {
                let held_rgb = held.get("rgb").cloned().unwrap_or(Value::Null);
                let same_rgb = primary.elements().is_some_and(|p| p.iter().enumerate().all(|(i, n)| crate::history::js_strict_eq(&n, &held_rgb.item(i).unwrap_or(Value::Null))));
                let held_a = held.get("a").filter(|a| !a.is_null()).cloned().unwrap_or(Value::Num(0.0));
                if same_rgb && crate::history::js_strict_eq(&alpha, &held_a) {
                    secondary = Some(Value::Null);
                }
            }
            entries.push(Entry { path: segment_path(index, "secondary"), value: secondary });
        }
    }
    if values.has_color || values.has_opacity {
        for &index in &targets.polygons {
            if let Some(color) = values.color {
                entries.push(field(polygon_path(index, "color_rgb"), rgb_array(color)));
            }
            if let Some(alpha) = values.alpha {
                entries.push(field(polygon_path(index, "alpha_raw"), Value::Num(alpha)));
                entries.push(field(polygon_path(index, "color_alpha"), Value::Num(1.0 - alpha / 255.0)));
            }
        }
    }
    Ok((entries, values))
}

/// `shapePatch(figure, indices, target)`: segments turned into another primitive, with their
/// raw flags following.
fn shape_patch(figure: &Value, indices: &[usize], target: i32) -> Vec<Entry> {
    let segments = segments_of(figure);
    let mut entries = Vec::new();
    for &index in indices {
        let Some(segment) = segments.get(index) else { continue };
        if code(segment) == target as f64 {
            continue;
        }
        let aux_code = segment.get("aux_code").filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN));
        let flags = target | to_int32(aux_code).wrapping_shl(8);
        let thick = segment.get("thickness").and_then(Value::as_f64).is_some_and(|t| t > 0.01);
        entries.push(field(segment_path(index, "primitive_code"), Value::Num(target as f64)));
        entries.push(field(segment_path(index, "segment_kind"), Value::str(KINDS[target as usize])));
        entries.push(field(segment_path(index, "segment_type"), Value::str(if is_circle(target as f64) { "circle" } else { "line" })));
        entries.push(field(segment_path(index, "flags"), Value::Num(flags as f64)));
        entries.push(field(segment_path(index, "visible"), Value::Bool(thick || target > 0)));
        if segment.get("flag_bits").is_some_and(Value::truthy) {
            let mut bits = segment.get("flag_bits").and_then(Value::as_obj).cloned().unwrap_or_default();
            if bits.contains("raw") {
                bits.set("raw", Value::Num(flags as f64));
            }
            if bits.contains("low_byte") {
                bits.set("low_byte", Value::Num(target as f64));
            }
            if bits.contains("set_bits") {
                bits.set("set_bits", Value::array((0..16).filter(|bit| flags & (1 << bit) != 0).map(|bit| Value::Num(bit as f64)).collect()));
            }
            entries.push(field(segment_path(index, "flag_bits"), Value::object(bits)));
        }
    }
    entries
}

/// A segment target of the selected figure (`{kind: 'segment', uid, handleId, figureTypeId}`).
fn segment_target(uid: &Value, handle: Value, type_id: &Value) -> Value {
    let mut target = Obj::new();
    target.set("kind", Value::str("segment"));
    target.set("uid", uid.clone());
    target.set("handleId", handle);
    target.set("figureTypeId", type_id.clone());
    Value::object(target)
}

/// The selected figure's definition and joint (`editor.figure`, `editor.selectedJoint`).
pub(crate) struct Selected {
    pub index: usize,
    pub figure: Value,
    pub joint: usize,
    pub object: Value,
}

impl Editor {
    /// The definition of the figure selected, its index, the selected joint when it names one of
    /// its segments, and the figure's record on show.
    pub(crate) fn builder_selection(&self) -> Result<Option<Selected>, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(None) };
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let Some(index) = figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")) else { return Ok(None) };
        let joint = self.selection.joint;
        let count = figures[index].get("segments").and_then(Value::array_len).unwrap_or(0);
        if joint < 0 || joint as usize >= count {
            return Ok(None);
        }
        Ok(Some(Selected { index, figure: figures[index].clone(), joint: joint as usize, object }))
    }

    /// `command(editor, label, patch)`: the entries written into definition `index` as one
    /// `native-properties` history entry; `false` when they change nothing.
    pub(crate) fn native_properties(&mut self, label: &str, index: usize, entries: Vec<Entry>) -> Result<bool, EditError> {
        if entries.is_empty() {
            return Ok(false);
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let selection = self.selection_state();
        let Some(figure) = self.report.get("figure_types").and_then(|f| f.item(index)) else { return Ok(false) };
        let paths: Vec<Vec<Key>> = entries.iter().map(|e| e.path.clone()).collect();
        let before = capture(&figure, &paths);
        if entries_json(&before.entries) == entries_json(&entries) {
            return Ok(false);
        }
        let after = Patch { entries, remove_empty: Vec::new() };
        self.apply_definition_patch(index, &after);
        // `_invalidateFigure`: the committed draft kept on show is evaluated again.
        self.retained = None;
        self.record(Command { kind: CommandKind::NativeProperties { index, before, after }, label: label.into(), before_selection: selection.clone(), after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("definition", Value::Bool(true))]);
        Ok(true)
    }

    fn apply_definition_patch(&mut self, index: usize, patch: &Patch) {
        if let Some(figure) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(index)) {
            apply_patch(figure, patch);
        }
    }

    /// Undo or redo of a `native-properties` entry of a figure definition.
    pub(crate) fn apply_native_properties(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::NativeProperties { index, before, after } = &command.kind else { return Ok(()) };
        let (patch, selection, revision) = match direction {
            Direction::Before => (before, &command.before_selection, command.before_revision),
            Direction::After => (after, &command.after_selection, command.after_revision),
        };
        if self.report.get("figure_types").and_then(|f| f.item(*index)).is_none() {
            return Err(invalid("errors.nativePropertyEdit.thePropertyTargetNoLongerExists"));
        }
        self.apply_definition_patch(*index, patch);
        self.retained = None;
        self.restore_selection(selection)?;
        self.revision = revision;
        self.emit("history", vec![("label", Value::str(&command.label)), ("definition", Value::Bool(true)), ("animation", Value::Bool(false))]);
        Ok(())
    }

    /// The builder's style commands by their JavaScript names; `None` for other calls.
    pub(crate) fn builder_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        if let Some(result) = self.native_property_call(method, args) { return Some(result); }
        let given = |i: usize| args.get(i);
        Some(match method {
            "updateBuilderSegmentStyle" => self.update_builder_segment_style(given(0), given(1)),
            "updateSegmentStyle" => self.update_builder_segment_style(Some(given(0).unwrap_or(&Value::object(Obj::new()))), None),
            "updateSegmentBranchStyle" => {
                let mut options = Obj::new();
                options.set("branch", Value::Bool(true));
                self.update_builder_segment_style(Some(given(0).unwrap_or(&Value::object(Obj::new()))), Some(&Value::object(options)))
            }
            "convertSegment" => {
                let mut patch = Obj::new();
                patch.set("shape", given(0).cloned().unwrap_or(Value::Null));
                if given(0).is_none() {
                    // `{shape: undefined}` names the shape: an unknown one.
                    return Some(Err(EditError::Unported("convertSegment without a shape".into())));
                }
                self.update_builder_segment_style(Some(&Value::object(patch)), None)
            }
            "setBranchCaps" => self.set_branch_caps(given(0)).map(Value::Bool),
            "setBranchFill" => self.set_branch_fill(given(0)).map(Value::Bool),
            "changeBranchThickness" => self.change_branch_thickness(given(0)),
            "setPolygonOpacity" => self.set_polygon_opacity(given(0), given(1)),
            "moveBuilderOrder" => self.move_builder_order(given(0).unwrap_or(&Value::Null), given(1).unwrap_or(&Value::Null), given(2)),
            "setBuilderOrder" => self.set_builder_order(given(0).unwrap_or(&Value::Null), given(1).unwrap_or(&Value::Null), given(2)),
            _ => return None,
        })
    }

    /// `updateBuilderSegmentStyle(patch, {branch})`: the selected segment's (or branch's) style.
    fn update_builder_segment_style(&mut self, patch: Option<&Value>, options: Option<&Value>) -> Result<Value, EditError> {
        let Some(selected) = self.builder_selection()? else { return Ok(Value::Bool(false)) };
        let whole = match options {
            None => false,
            Some(Value::Null) => return Err(EditError::Unported("style options that are null".into())),
            Some(options) => match options.get("branch") {
                None => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => return Err(invalid("errors.editorBuilderBranch.chooseWhetherToStyleTheWholeBranch")),
            },
        };
        let empty = Value::object(Obj::new());
        let patch = patch.unwrap_or(&empty);
        let Some(fields) = patch.as_obj() else { return Err(invalid("errors.editorBuilderBranch.chooseASegmentStylePatch")) };
        let mut style = fields.clone();
        let shape = style.remove("shape");
        let targets = branch(&selected.figure, selected.joint, whole, fields.contains("color") || fields.contains("opacity"));
        let (mut entries, _) = style_patch(&selected.figure, selected.joint, &style, &targets)?;
        let segments = segments_of(&selected.figure);
        let polygons = polygons_of(&selected.figure);
        let type_id = selected.figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let uid = selected.object.get("unique_id").cloned().unwrap_or(Value::Null);
        let colours = ["color", "paint", "gradient"].iter().any(|key| fields.contains(key));
        let version = num(&self.report, "version").unwrap_or(f64::NAN);
        if !fields.contains("shape") && !fields.contains("static") && colours {
            let object = &selected.object;
            let overlay = self.options.property_channels
                || self.sheet()
                || object.get("_stykStyle").is_some_and(Value::truthy)
                || !crate::recolor::uses_segment_colors(version, &selected.figure, object)
                || crate::recolor::to_uint32(crate::recolor::override_raw(object)) >> 24 != 0;
            if overlay {
                let mut targets_value = Obj::new();
                let segment_targets = targets
                    .indices
                    .iter()
                    .map(|&index| {
                        let mut entry = Obj::new();
                        entry.set("handleId", segments[index].get("segment_id").cloned().unwrap_or(Value::Null));
                        entry.set("stops", Value::array(Vec::new()));
                        Value::object(entry)
                    })
                    .collect();
                targets_value.set("segments", Value::array(segment_targets));
                targets_value.set("polygons", Value::array(targets.polygons.iter().map(|&index| Value::Num(crate::recolor::polygon_identity(&polygons[index], index))).collect()));
                let mut operation = Obj::new();
                operation.set("mode", Value::str("style"));
                operation.set("patch", patch.clone());
                operation.set("figureTypeId", type_id.clone());
                operation.set("targets", Value::object(targets_value));
                let mut range = Obj::new();
                range.set("uids", Value::array(vec![uid.clone()]));
                let result = self.edit_figure_colors(&Value::object(operation), &Value::object(range))?;
                return Ok(Value::Bool(result.get("changedFrames").and_then(Value::as_f64).is_some_and(|n| n > 0.0)));
            }
        }
        if self.options.property_channels && !fields.contains("shape") && !fields.contains("static") {
            let mut keyed = Vec::new();
            for &index in &targets.indices {
                let target = segment_target(&uid, segments[index].get("segment_id").cloned().unwrap_or(Value::Null), &type_id);
                for (property, value) in fields.iter() {
                    let shown = self.animation_value(&target, property, &Value::Num(self.tick))?;
                    if shown.as_ref().map(styk_doc::json::to_string) != Some(styk_doc::json::to_string(value)) {
                        let mut entry = Obj::new();
                        entry.set("target", target.clone());
                        entry.set("property", Value::str(property));
                        entry.set("value", value.clone());
                        keyed.push(Value::object(entry));
                    }
                }
            }
            for &index in &targets.polygons {
                for property in ["color", "opacity"] {
                    let Some(value) = fields.get(property) else { continue };
                    let mut target = Obj::new();
                    target.set("kind", Value::str("polygon"));
                    target.set("uid", uid.clone());
                    target.set("polygonId", Value::Num(crate::recolor::polygon_identity(&polygons[index], index)));
                    target.set("figureTypeId", type_id.clone());
                    let value = if property == "color" { Value::Num(crate::recolor::style_color(rgb(Some(value))?)) } else { value.clone() };
                    let mut entry = Obj::new();
                    entry.set("target", Value::object(target));
                    entry.set("property", Value::str(property));
                    entry.set("value", value);
                    keyed.push(Value::object(entry));
                }
            }
            return self.add_animation_keys(Some(&Value::array(keyed)));
        }
        if let Some(shape) = &shape {
            if whole {
                return Err(invalid("errors.editorBuilderBranch.useTheBranchCapsOrCircleFillCommand"));
            }
            let current = code(&segments[selected.joint]);
            if current == 2.0 || current == 5.0 {
                return Err(invalid("errors.editorBuilderBranch.imageAndTextSegmentsRetainTheirMediaType"));
            }
            let target = match shape {
                Value::Num(n) => *n,
                other => other.as_str().and_then(|k| KINDS.iter().position(|known| *known == k)).map_or(-1.0, |i| i as f64),
            };
            if ![0.0, 1.0, 3.0, 4.0, 6.0].contains(&target) {
                return Err(invalid("errors.editorBuilderBranch.chooseARoundLineSquareLineOrCircle"));
            }
            // The shape of the segment as the style entries leave it, merged by path.
            let mut preview = segments[selected.joint].clone();
            for entry in &entries {
                if let [_, Key::Index(_), Key::Field(name)] = entry.path.as_slice()
                    && let Some(record) = preview.make_obj()
                {
                    match &entry.value {
                        Some(value) => record.set(name, value.clone()),
                        None => {
                            record.remove(name);
                        }
                    }
                }
            }
            let mut holder = Obj::new();
            let mut list = vec![Value::Null; selected.joint + 1];
            list[selected.joint] = preview;
            holder.set("segments", Value::Arr(std::sync::Arc::new(list)));
            for entry in shape_patch(&Value::object(holder), &[selected.joint], target as i32) {
                match entries.iter_mut().find(|e| e.path == entry.path) {
                    Some(existing) => *existing = entry,
                    None => entries.push(entry),
                }
            }
        }
        let label = if whole { "Edit segment branch style" } else { "Edit segment style" };
        self.native_properties(label, selected.index, entries).map(Value::Bool)
    }

    /// `changeBranchThickness(delta)`: increment every descendant in source order,
    /// clamped to Pivot's numeric-action range and rounded as `Math.fround`.
    fn change_branch_thickness(&mut self, delta: Option<&Value>) -> Result<Value, EditError> {
        let delta = branch_finite(delta, "Thickness change", f64::NEG_INFINITY, f64::INFINITY)?;
        let Some(selected) = self.builder_selection()? else { return Ok(Value::Bool(false)) };
        let segments = segments_of(&selected.figure);
        let indices = branch(&selected.figure, selected.joint, true, false).indices;
        let increment = |width: f64| {
            let value = width + delta;
            // Math.max(0, -0) yields +0; do not preserve a negative zero here.
            let clamped = if value <= 0.0 { 0.0 } else if value >= 1000.0 { 1000.0 } else { value };
            (clamped as f32) as f64
        };
        if self.options.property_channels {
            let uid = selected.object.get("unique_id").cloned().unwrap_or(Value::Null);
            let type_id = selected.figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
            let mut entries = Vec::with_capacity(indices.len());
            for index in indices {
                let target = segment_target(&uid, segments[index].get("segment_id").cloned().unwrap_or(Value::Null), &type_id);
                let shown = self.animation_value(&target, "thickness", &Value::Num(self.tick))?.and_then(|v| v.as_f64()).ok_or_else(|| EditError::Unported("branch thickness without a displayed numeric width".into()))?;
                let mut entry = Obj::new();
                entry.set("target", target);
                entry.set("property", Value::str("thickness"));
                entry.set("value", Value::Num(increment(shown)));
                entries.push(Value::object(entry));
            }
            return self.add_animation_keys(Some(&Value::array(entries)));
        }
        let mut entries = Vec::with_capacity(indices.len() * 2);
        for index in indices {
            let value = increment(num(&segments[index], "thickness").unwrap_or(f64::NAN));
            entries.push(field(segment_path(index, "thickness"), Value::Num(value)));
            entries.push(field(segment_path(index, "visible"), Value::Bool(value > 0.01 || code(&segments[index]) > 0.0)));
        }
        self.native_properties("Change branch thickness", selected.index, entries).map(Value::Bool)
    }

    /// `setBranchCaps(square)`: the selected branch's segments of the selected one's shape given
    /// square or round caps.
    fn set_branch_caps(&mut self, square: Option<&Value>) -> Result<bool, EditError> {
        let Some(selected) = self.builder_selection()? else { return Ok(false) };
        let segments = segments_of(&selected.figure);
        let own = code(&segments[selected.joint]);
        let square = match square {
            None | Some(Value::Null) => own == 0.0,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(invalid("errors.editorBuilderBranch.squareCapsMustBeTrueOrFalse")),
        };
        let indices: Vec<usize> = branch(&selected.figure, selected.joint, true, false).indices.into_iter().filter(|&i| code(&segments[i]) == own).collect();
        let entries = shape_patch(&selected.figure, &indices, if square { 6 } else { 0 });
        self.native_properties("Change branch caps", selected.index, entries)
    }

    /// `setBranchFill(style)`: the selected branch's circles drawn as outlines, filled or clear.
    fn set_branch_fill(&mut self, style: Option<&Value>) -> Result<bool, EditError> {
        let Some(selected) = self.builder_selection()? else { return Ok(false) };
        let segments = segments_of(&selected.figure);
        let own = code(&segments[selected.joint]);
        if !is_circle(own) {
            return Ok(false);
        }
        let target = match style {
            None | Some(Value::Null) => {
                if own == 3.0 {
                    4.0
                } else if own == 4.0 {
                    1.0
                } else {
                    3.0
                }
            }
            Some(Value::Num(n)) => *n,
            Some(other) => other.as_str().and_then(|k| KINDS.iter().position(|known| *known == k)).map_or(-1.0, |i| i as f64),
        };
        if !is_circle(target) {
            return Err(invalid("errors.editorBuilderBranch.chooseCircleCirclefillOrCircleclear"));
        }
        let indices: Vec<usize> = branch(&selected.figure, selected.joint, true, false).indices.into_iter().filter(|&i| is_circle(code(&segments[i]))).collect();
        let entries = shape_patch(&selected.figure, &indices, target as i32);
        self.native_properties("Change branch circle fill", selected.index, entries)
    }

    /// `setPolygonOpacity(index, opacity)`: keyed with property channels, else the definition's.
    fn set_polygon_opacity(&mut self, index: Option<&Value>, opacity: Option<&Value>) -> Result<Value, EditError> {
        let opacity = match opacity {
            Some(Value::Num(n)) if n.is_finite() && (0.0..=1.0).contains(n) => *n,
            _ => return Err(invalid("errors.editorBuilderStyle.polygonOpacityMustBeFrom0To1")),
        };
        let index_value = index.cloned().unwrap_or(Value::Null);
        if self.options.property_channels {
            let mut patch = Obj::new();
            patch.set("opacity", Value::Num(opacity));
            return self.update_polygon(&index_value, &Value::object(patch));
        }
        // `builderStyleProperty(editor, 'polygon_<index>_opacity')`.
        let missing = || invalid("errors.editorBuilderStyle.selectAnExistingPolygon");
        let Some((_, object)) = self.object()? else { return Err(missing()) };
        let figure = self.figure_value(&object);
        let at = index_value.as_f64().filter(|i| i.fract() == 0.0 && *i >= 0.0).map(|i| i as usize).ok_or_else(missing)?;
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let definition = figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")).ok_or_else(missing)?;
        let polygons = polygons_of(&figure);
        let polygon = polygons.get(at).filter(|p| p.truthy()).ok_or_else(missing)?;
        // Every drawable's order is a finite single-precision number (`builderDrawables`).
        let order = |value: Option<&Value>, fallback: f64| match value.filter(|v| !v.is_null()) {
            None => Some(fallback),
            Some(Value::Num(n)) if n.is_finite() && (*n as f32).is_finite() => Some(*n),
            Some(_) => None,
        };
        if order(polygon.get("z_order"), 0.0).is_none() {
            return Err(missing());
        }
        let segments = segments_of(&figure);
        let mut drawables = polygons.iter().map(|p| order(p.get("z_order"), 0.0)).chain(segments.iter().enumerate().map(|(i, s)| order(s.get("z_order"), i as f64 + 1.0)));
        if drawables.any(|z| z.is_none()) {
            return Err(invalid("errors.animationProperties.drawOrderMustBeAFiniteNativeNumber"));
        }
        let value = opacity * 100.0;
        let alpha = js_round((1.0 - value / 100.0) * 255.0);
        let entries = vec![field(polygon_path(at, "alpha_raw"), Value::Num(alpha)), field(polygon_path(at, "color_alpha"), Value::Num(1.0 - alpha / 255.0))];
        self.style_command("Polygon opacity", definition, entries).map(Value::Bool)
    }

    /// `command(editor, label, paths, mutate)` of src/editor-builder-style.mjs: the paths captured
    /// before and after the mutation (here its entries), one `native-properties` entry.
    fn style_command(&mut self, label: &str, index: usize, entries: Vec<Entry>) -> Result<bool, EditError> {
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let Some(figure) = self.report.get("figure_types").and_then(|f| f.item(index)) else { return Ok(false) };
        let selection = self.selection_state();
        let paths: Vec<Vec<Key>> = entries.iter().map(|e| e.path.clone()).collect();
        let before = capture(&figure, &paths);
        let mut changed = figure.clone();
        apply_patch(&mut changed, &Patch { entries, remove_empty: Vec::new() });
        let after = capture(&changed, &paths);
        if entries_json(&before.entries) == entries_json(&after.entries) {
            return Ok(false);
        }
        self.apply_definition_patch(index, &after);
        self.retained = None;
        self.record(Command { kind: CommandKind::NativeProperties { index, before, after }, label: label.into(), before_selection: selection.clone(), after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("definition", Value::Bool(true))]);
        Ok(true)
    }

    /// `updateFigureStyle(patch)` on the definition (a name, or no property channels): one
    /// `figure` entry (`editDefinition`).
    pub(crate) fn figure_definition_style(&mut self, fields: &Obj) -> Result<Value, EditError> {
        let fields = fields.clone();
        self.edit_definition("Edit figure style", |_, figure| {
            if fields.contains("name") {
                let name = fields.get("name").and_then(Value::as_str);
                let trimmed = name.map(js_trim).unwrap_or("");
                if name.is_none() || trimmed.is_empty() || name.unwrap().encode_utf16().count() > 255 {
                    return Err(invalid("errors.editorBuilder.figureNamesMustContain1255Characters"));
                }
                figure.set("name", Value::str(trimmed));
            }
            if fields.keys().any(|key| key.starts_with("outline")) {
                let mut decode = figure.get("segment_decode").filter(|v| !v.is_null()).and_then(Value::as_obj).cloned().unwrap_or_default();
                let mut style = match decode.get("global_style").filter(|v| !v.is_null()).and_then(Value::as_obj) {
                    Some(style) => style.clone(),
                    None => {
                        let mut style = Obj::new();
                        style.set("u28", Value::Num(0.0));
                        style.set("outline_thickness", Value::Num(0.0));
                        style.set("rgb", rgb_array([0.0; 3]));
                        style.set("u30", Value::Num(0.0));
                        style
                    }
                };
                if fields.contains("outlineWidth") {
                    let width = builder_finite(fields.get("outlineWidth"), "Outline width", 0.0, 1e6)?;
                    style.set("outline_thickness", Value::Num(width));
                    style.set("u28", Value::Num((width as f32).to_bits() as f64));
                }
                if fields.contains("outlineColor") {
                    style.set("rgb", rgb_array(rgb(fields.get("outlineColor"))?));
                }
                if fields.contains("outlineOpacity") {
                    style.set("u30", Value::Num(js_round(255.0 * (1.0 - builder_finite(fields.get("outlineOpacity"), "Opacity", 0.0, 1.0)?))));
                }
                decode.set("global_style", Value::object(style));
                figure.set("segment_decode", Value::object(decode));
            }
            Ok(())
        })
    }
}

/// One drawable of a figure's combined drawing order (`builderDrawables`): a polygon or a
/// segment, its place in the definition, its order, and its identity.
#[derive(Clone, Debug)]
struct Drawable {
    polygon: bool,
    index: usize,
    z: f64,
    id: Value,
}

/// `orderValue(value)`: a finite single-precision draw order.
fn order_value(value: Option<&Value>, fallback: f64) -> Result<f64, EditError> {
    match value.filter(|v| !v.is_null()) {
        None => Ok(fallback),
        Some(Value::Num(n)) if n.is_finite() && ((*n as f32) as f64).is_finite() => Ok(*n),
        Some(_) => Err(invalid("errors.animationProperties.drawOrderMustBeAFiniteNativeNumber")),
    }
}

/// `builderDrawables(figure)`, of the figure as `object` shows it when given
/// (`resolveInstanceFigure`'s draw orders), polygons first on ties.
fn drawables(figure: &Value, object: Option<&Value>) -> Result<Vec<Drawable>, EditError> {
    let style = object.and_then(|o| o.get("_stykStyle")).filter(|s| !s.is_null());
    let mut out = Vec::new();
    for (index, polygon) in polygons_of(figure).iter().enumerate() {
        let id = crate::recolor::polygon_identity(polygon, index);
        let override_z = style.and_then(|s| s.path(&["polygons", &styk_doc::json::to_string(&Value::Num(id)), "zIndex"]));
        let z = match override_z {
            Some(value) => order_value(Some(value), 0.0)?,
            None => order_value(polygon.get("z_order"), 0.0)?,
        };
        out.push(Drawable { polygon: true, index, z, id: Value::Num(id) });
    }
    for (index, segment) in segments_of(figure).iter().enumerate() {
        let id = segment.get("segment_id").cloned().unwrap_or(Value::Null);
        let override_z = style.and_then(|s| s.get("segments")).and_then(|t| t.get(&styk_doc::json::to_string(&id))).and_then(|o| o.get("zIndex")).and_then(Value::as_f64).filter(|z| z.is_finite());
        let z = match override_z {
            Some(z) => order_value(Some(&Value::Num(z)), 0.0)?,
            None => order_value(segment.get("z_order"), index as f64 + 1.0)?,
        };
        out.push(Drawable { polygon: false, index, z, id });
    }
    out.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

/// `normalizeBuilderOrder`: append-only topology edits make room in the native
/// combined sequence while preserving the existing stable order.
pub(crate) fn normalize_builder_order(figure: &mut Value) -> Result<usize, EditError> {
    let entries = drawables(figure, None)?;
    let root = figure.make_obj().ok_or_else(|| invalid("errors.editorBuilderStyle.selectAnExistingSegmentOrPolygon"))?;
    for (place, entry) in entries.iter().enumerate() {
        if let Some(item) = root.get_mut(if entry.polygon { "polyfills" } else { "segments" }).and_then(Value::make_arr).and_then(|items| items.get_mut(entry.index)).and_then(Value::make_obj) {
            item.set("z_order", Value::Num(place as f64 + 1.0));
            item.set("z_order_runtime_raw", Value::Num(place as f64));
        }
    }
    root.remove("segment_z_raw");
    root.remove("poly_z_raw");
    Ok(entries.len())
}

/// `resolveTarget(figure, target, selectedJoint)`: `(polygon, index)` of an existing drawable.
fn resolve_target(figure: &Value, target: &Value, selected_joint: i64) -> Result<(bool, usize), EditError> {
    let missing = || invalid("errors.editorBuilderStyle.selectAnExistingSegmentOrPolygon");
    let kind = target.get("kind").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::str("segment"));
    let index = match target.get("index").filter(|v| !v.is_null()) {
        Some(value) => value.as_f64().ok_or_else(missing)?,
        None => selected_joint as f64,
    };
    if index.fract() != 0.0 || index < 0.0 {
        return Err(missing());
    }
    let polygon = match kind.as_str() {
        Some("segment") => false,
        Some("polygon") => true,
        _ => return Err(missing()),
    };
    let list = if polygon { polygons_of(figure) } else { segments_of(figure) };
    let item = list.get(index as usize).filter(|i| i.truthy()).ok_or_else(missing)?;
    order_value(item.get("z_order"), if polygon { 0.0 } else { index + 1.0 })?;
    Ok((polygon, index as usize))
}

/// `builderStyleTargets(figure, target, {branch})`: the drawables an order edit moves; a branch
/// takes the segments below the selected one and the polygons whose every handle is in it.
fn style_targets(figure: &Value, entries: &[Drawable], target: (bool, usize), branch: bool) -> Vec<(bool, usize)> {
    if !branch || target.0 {
        return vec![target];
    }
    let segments = segments_of(figure);
    let key = |v: Option<&Value>| v.map(styk_doc::json::to_string).unwrap_or_default();
    let mut children: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for s in &segments {
        children.entry(key(s.get("parent_id"))).or_default().push(key(s.get("segment_id")));
    }
    let selected = &segments[target.1];
    let mut ids = vec![key(selected.get("segment_id"))];
    let mut i = 0;
    while i < ids.len() {
        for child in children.get(&ids[i]).cloned().unwrap_or_default() {
            if !ids.contains(&child) {
                ids.push(child);
            }
        }
        i += 1;
    }
    let mut polygon_ids = ids.clone();
    polygon_ids.push(key(selected.get("parent_id")));
    let polygons = polygons_of(figure);
    entries
        .iter()
        .filter(|entry| {
            if entry.polygon {
                let handles = items_of(polygons[entry.index].get("segment_ids"));
                handles.iter().all(|h| polygon_ids.contains(&key(Some(h)))) && handles.iter().any(|h| ids.contains(&key(Some(h))))
            } else {
                ids.contains(&key(segments[entry.index].get("segment_id")))
            }
        })
        .map(|entry| (entry.polygon, entry.index))
        .collect()
}

fn items_of(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

/// `reorderBuilderDrawables(entries, selected, {direction, delta})`: the new order, as indices
/// into `entries`.
fn reorder(entries: &[Drawable], selected: &[(bool, usize)], direction: Option<&str>, delta: f64) -> Result<Vec<usize>, EditError> {
    let chosen = |e: &Drawable| selected.contains(&(e.polygon, e.index));
    let all: Vec<usize> = (0..entries.len()).collect();
    if let Some(side @ ("front" | "back")) = direction {
        let own: Vec<usize> = all.iter().copied().filter(|&i| chosen(&entries[i])).collect();
        let other: Vec<usize> = all.iter().copied().filter(|&i| !chosen(&entries[i])).collect();
        return Ok(if side == "front" { [other, own].concat() } else { [own, other].concat() });
    }
    let delta = match direction {
        Some("up") => 1.0,
        Some("down") => -1.0,
        _ => delta,
    };
    if !(delta.is_finite() && delta.fract() == 0.0) {
        return Err(invalid("errors.editorBuilderStyle.chooseAWholeDrawOrderPosition"));
    }
    if delta == 0.0 {
        return Ok(all);
    }
    let mut moving: Vec<usize> = all.iter().copied().filter(|&i| chosen(&entries[i])).collect();
    let other: Vec<usize> = all.iter().copied().filter(|&i| !chosen(&entries[i])).collect();
    if delta > 0.0 {
        moving.reverse();
    }
    let n = entries.len() as f64;
    let mut result: Vec<Option<usize>> = vec![None; entries.len()];
    let mut boundary = if delta > 0.0 { n - 1.0 } else { 0.0 };
    for index in moving {
        let target = if delta > 0.0 { (index as f64 + delta).min(boundary) } else { (index as f64 + delta).max(boundary) };
        result[target as usize] = Some(index);
        boundary = target + if delta > 0.0 { -1.0 } else { 1.0 };
    }
    let mut cursor = other.into_iter();
    Ok(result.into_iter().map(|slot| slot.or_else(|| cursor.next()).unwrap_or(0)).collect())
}

impl Editor {
    /// `animatedOrder(editor)`: draw order goes through property keys (property channels or a
    /// layer sheet).
    fn animated_order(&self) -> bool {
        self.options.property_channels || self.sheet()
    }

    /// `moveBuilderOrder(target, direction, {branch})`: segments or polygons raised or lowered in
    /// the figure's combined drawing order: keyed on the figure on show when animated, else written
    /// into the definition.
    pub(crate) fn move_builder_order(&mut self, target: &Value, direction: &Value, options: Option<&Value>) -> Result<Value, EditError> {
        let direction = direction.as_str().filter(|d| ["front", "back", "up", "down"].contains(d)).ok_or_else(|| invalid("errors.editorBuilderStyle.chooseAValidDrawOrderDirection"))?.to_string();
        let branch = match options {
            None => false,
            Some(Value::Null) => return Err(EditError::Unported("order options that are null".into())),
            Some(o) => o.get("branch").is_some_and(Value::truthy),
        };
        let Some((_, object)) = self.object()? else { return Err(EditError::Unported("ordering without a figure".into())) };
        let figure = self.figure_value(&object);
        if figure.is_null() {
            return Err(EditError::Unported("ordering without a figure".into()));
        }
        let animated = self.animated_order();
        let entries = drawables(&figure, animated.then_some(&object))?;
        let target_value = resolve_target(&figure, target, self.selection.joint)?;
        let selected = style_targets(&figure, &entries, target_value, branch);
        let next = reorder(&entries, &selected, Some(&direction), 0.0)?;
        if animated {
            if next.iter().enumerate().all(|(i, &j)| i == j) {
                return Ok(Value::Bool(false));
            }
            return self.key_builder_order(&figure, &object, &entries, &next).map(Value::Bool);
        }
        // `${Raise|Lower} ${branch ? 'branch' : target.kind ?? 'segment'}`.
        let noun = if branch { "branch".to_string() } else { target.get("kind").filter(|k| !k.is_null()).and_then(Value::as_str).unwrap_or("segment").to_string() };
        let label = format!("{} {noun}", if direction == "front" || direction == "up" { "Raise" } else { "Lower" });
        self.write_builder_order(&label, &figure, &object, &entries, &next).map(Value::Bool)
    }

    /// `setBuilderOrder(target, value, {branch})`: a drawable (or branch) moved to a place in the
    /// combined drawing order, counted from 1.
    pub(crate) fn set_builder_order(&mut self, target: &Value, value: &Value, options: Option<&Value>) -> Result<Value, EditError> {
        let branch = match options {
            None => false,
            Some(Value::Null) => return Err(EditError::Unported("order options that are null".into())),
            Some(o) => o.get("branch").is_some_and(Value::truthy),
        };
        let Some((_, object)) = self.object()? else { return Err(EditError::Unported("ordering without a figure".into())) };
        let figure = self.figure_value(&object);
        if figure.is_null() {
            return Err(EditError::Unported("ordering without a figure".into()));
        }
        let selected = resolve_target(&figure, target, self.selection.joint)?;
        let animated = self.animated_order();
        let entries = drawables(&figure, animated.then_some(&object))?;
        let targets = style_targets(&figure, &entries, selected, branch);
        let current = entries.iter().position(|e| (e.polygon, e.index) == selected).map_or(0.0, |p| p as f64 + 1.0);
        let label = format!("{} draw order", if branch && !selected.0 { "Branch" } else if selected.0 { "Polygon" } else { "Segment" });
        let value = match value {
            Value::Num(n) if n.is_finite() && ((*n as f32) as f64).is_finite() => *n,
            _ => return Err(invalid("errors.animationProperties.drawOrderMustBeAFiniteNativeNumber")),
        };
        let in_range = value.fract() == 0.0 && value >= 1.0 && value <= entries.len() as f64;
        if animated {
            if self.property_edit.is_some() {
                return Err(EditError::Unported("a draw order edit while a property edit is open".into()));
            }
            if self.drag.is_some() {
                self.commit_drag()?;
            }
            if !in_range {
                let uid = object.get("unique_id").cloned().unwrap_or(Value::Null);
                self.emit("edit", vec![("label", Value::str("Cancel branch opacity")), ("live", Value::Bool(false)), ("changedUids", Value::array(vec![uid]))]);
                return Err(crate::invalid_with("errors.editorBuilderStyle.drawOrderMustBeAWholePositionFrom", vec![("length", Value::Num(entries.len() as f64))]));
            }
            let next = reorder(&entries, &targets, None, value - current)?;
            return self.key_builder_order(&figure, &object, &entries, &next).map(Value::Bool);
        }
        if !in_range {
            if self.drag.is_some() {
                self.commit_drag()?;
            }
            return Err(crate::invalid_with("errors.editorBuilderStyle.drawOrderMustBeAWholePositionFrom", vec![("length", Value::Num(entries.len() as f64))]));
        }
        let next = reorder(&entries, &targets, None, value - current)?;
        self.write_builder_order(&label, &figure, &object, &entries, &next).map(Value::Bool)
    }

    /// `beginBuilderOrderAnimation`, `previewBuilderOrderSequence`, `commitBranchStyleAnimation`: every
    /// drawable keyed at its new place (a held key), after the preview's live event.
    fn key_builder_order(&mut self, figure: &Value, object: &Value, entries: &[Drawable], next: &[usize]) -> Result<bool, EditError> {
        if self.property_edit.is_some() {
            return Err(EditError::Unported("a draw order edit while a property edit is open".into()));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let uid = object.get("unique_id").cloned().unwrap_or(Value::Null);
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let unchanged = next.iter().enumerate().all(|(i, &j)| i == j);
        let mut position = vec![0.0; entries.len()];
        for (place, &index) in next.iter().enumerate() {
            position[index] = place as f64 + 1.0;
        }
        let values: Vec<f64> = entries.iter().enumerate().map(|(i, e)| if unchanged { e.z } else { position[i] }).collect();
        self.emit("edit", vec![("label", Value::str("Preview drawable properties")), ("live", Value::Bool(true)), ("changedUids", Value::array(vec![uid.clone()]))]);
        let changed = entries.iter().zip(&values).any(|(e, v)| e.z != *v);
        if !changed {
            self.emit("edit", vec![("animation", Value::Bool(true)), ("label", Value::str("Cancel unchanged branch opacity"))]);
            return Ok(false);
        }
        let keyed = entries
            .iter()
            .zip(&values)
            .map(|(entry, value)| {
                let mut target = Obj::new();
                target.set("kind", Value::str(if entry.polygon { "polygon" } else { "segment" }));
                target.set("uid", uid.clone());
                target.set("figureTypeId", type_id.clone());
                target.set(if entry.polygon { "polygonId" } else { "handleId" }, entry.id.clone());
                let mut key = Obj::new();
                key.set("target", Value::object(target));
                key.set("property", Value::str("zIndex"));
                key.set("tick", Value::Num(self.tick));
                key.set("value", Value::Num(*value));
                key.set("exactTarget", Value::Bool(true));
                key.set("interpolation", Value::str("hold"));
                Value::object(key)
            })
            .collect();
        self.add_animation_keys(Some(&Value::array(keyed)))?;
        Ok(true)
    }

    /// `command(editor, label, orderPaths(entries), publishOrder)`: the new order written into the
    /// definition (positions from 1), the native order arrays dropped; one `native-properties` entry.
    fn write_builder_order(&mut self, label: &str, figure: &Value, object: &Value, entries: &[Drawable], next: &[usize]) -> Result<bool, EditError> {
        let _ = object;
        let figures = items_of(self.report.get("figure_types"));
        let Some(index) = figures.iter().position(|f| f.get("figure_type_id") == figure.get("figure_type_id")) else { return Ok(false) };
        let path = |e: &Drawable, field: &str| vec![Key::Field(if e.polygon { "polyfills" } else { "segments" }.into()), Key::Index(e.index), Key::Field(field.into())];
        let mut paths: Vec<Vec<Key>> = entries.iter().flat_map(|e| [path(e, "z_order"), path(e, "z_order_runtime_raw")]).collect();
        paths.push(vec![Key::Field("segment_z_raw".into())]);
        paths.push(vec![Key::Field("poly_z_raw".into())]);
        if next.iter().enumerate().all(|(i, &j)| i == j) {
            if self.drag.is_some() {
                self.commit_drag()?;
            }
            return Ok(false);
        }
        let mut writes: Vec<Entry> = Vec::new();
        for (place, &i) in next.iter().enumerate() {
            writes.push(field(path(&entries[i], "z_order"), Value::Num(place as f64 + 1.0)));
            writes.push(field(path(&entries[i], "z_order_runtime_raw"), Value::Num(place as f64)));
        }
        writes.push(Entry { path: vec![Key::Field("segment_z_raw".into())], value: None });
        writes.push(Entry { path: vec![Key::Field("poly_z_raw".into())], value: None });
        self.order_command(label, index, paths, writes)
    }

    /// `command(editor, label, paths, mutate)` with the paths captured in their own order.
    fn order_command(&mut self, label: &str, index: usize, paths: Vec<Vec<Key>>, writes: Vec<Entry>) -> Result<bool, EditError> {
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let Some(figure) = self.report.get("figure_types").and_then(|f| f.item(index)) else { return Ok(false) };
        let selection = self.selection_state();
        let before = capture(&figure, &paths);
        let mut changed = figure.clone();
        apply_patch(&mut changed, &Patch { entries: writes, remove_empty: Vec::new() });
        let after = capture(&changed, &paths);
        if entries_json(&before.entries) == entries_json(&after.entries) {
            return Ok(false);
        }
        self.apply_definition_patch(index, &after);
        self.retained = None;
        self.record(Command { kind: CommandKind::NativeProperties { index, before, after }, label: label.into(), before_selection: selection.clone(), after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("definition", Value::Bool(true))]);
        Ok(true)
    }
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
pub(crate) fn js_trim(text: &str) -> &str {
    let space = |c: char| c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}');
    text.trim_matches(space)
}
