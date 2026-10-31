//! The exported native-property helper's builder token lifecycle. The JSON protocol
//! uses one opaque identity in place of the helper's object reference; closed tokens
//! are discarded, and only the current token's small paths and binding are retained.
use super::{
    Branch, Drawable, Entry, Key, Patch, branch, capture, code, drawables, entries_json, field,
    js_round, polygon_path, polygons_of, reorder, segment_path, segments_of, style_patch,
    style_targets,
};
use crate::history::{Command, CommandKind};
use crate::record::num;
use crate::{EditError, Editor};
use styk_doc::{Obj, Value};

const ENDED: &str = "errors.nativePropertyEdit.thisPropertyGestureHasEnded";
fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}
fn polygon_key(key: &str) -> Option<(usize, bool)> {
    let key = key.strip_prefix("polygon_")?;
    let (index, order) = key
        .strip_suffix("_z_order")
        .map(|s| (s, true))
        .or_else(|| key.strip_suffix("_opacity").map(|s| (s, false)))?;
    (!index.is_empty() && index.bytes().all(|c| c.is_ascii_digit()))
        .then(|| index.parse().ok())
        .flatten()
        .map(|i| (i, order))
}
fn supported(key: &str) -> bool {
    matches!(
        key,
        "outline_width"
            | "outline_opacity"
            | "thickness"
            | "segment_opacity"
            | "segment_gradient_opacity"
            | "segment_z_order"
    ) || polygon_key(key).is_some()
}
fn known_other(key: &str) -> bool {
    matches!(
        key,
        "fps"
            | "canvas_width"
            | "canvas_height"
            | "duration"
            | "root_x"
            | "root_y"
            | "scale"
            | "rotation"
            | "figure_opacity"
            | "figure_z_order"
            | "group_x"
            | "group_y"
            | "group_width"
            | "group_height"
            | "joint_angle"
            | "joint_length"
            | "joint_bend"
            | "camera_x"
            | "camera_y"
            | "camera_scale"
            | "camera_angle"
    )
}
#[derive(Clone)]
enum Binding {
    Single,
    Branch(Branch),
    Gradient(Vec<usize>),
    Order {
        entries: Vec<Drawable>,
        targets: Vec<(bool, usize)>,
    },
}
#[derive(Clone)]
struct Plan {
    key: String,
    label: String,
    index: usize,
    joint: i64,
    initial: f64,
    paths: Vec<Vec<Key>>,
    binding: Binding,
}
#[derive(Clone)]
pub(crate) struct Token {
    id: u64,
    plan: Plan,
    before: Patch,
    selection: crate::select::SelectionState,
    frame_index: usize,
    uid: Option<u32>,
    value: f64,
    applied: bool,
}
fn validate(key: &str, value: &Value) -> Result<f64, EditError> {
    let value = value
        .as_f64()
        .filter(|v| v.is_finite() && (*v as f32).is_finite())
        .ok_or_else(|| {
            invalid("errors.nativePropertyEdit.enterAFiniteNumberWithinTheNativeRange")
        })?;
    let opacity = key.ends_with("_opacity");
    if polygon_key(key).is_some_and(|(_, order)| !order) && !(0.0..=100.0).contains(&value) {
        return Err(invalid(
            "errors.editorBuilderStyle.polygonOpacityMustBeFrom0To100",
        ));
    }
    if opacity && !(0.0..=100.0).contains(&value)
        || matches!(key, "outline_width" | "thickness") && !(0.0..=1e6).contains(&value)
    {
        return Err(invalid("errors.nativePropertyEdit.enterAValueFromTo"));
    }
    Ok(value)
}
fn order_path(entry: &Drawable, name: &str) -> Vec<Key> {
    if entry.polygon {
        polygon_path(entry.index, name)
    } else {
        segment_path(entry.index, name)
    }
}

impl Editor {
    /// A definition preview owns only the recorded token and view calls. Refuse
    /// other document mutations atomically until their interaction is recorded.
    pub(crate) fn native_property_gate(&self, method: &str) -> Result<(), EditError> {
        if self.native_token.is_none()
            || matches!(
                method,
                "canEditNativeProperty"
                    | "getNativePropertyValue"
                    | "beginNativePropertyEdit"
                    | "previewNativePropertyEdit"
                    | "commitNativePropertyEdit"
                    | "cancelNativePropertyEdit"
                    | "select"
                    | "@select"
                    | "selectMany"
                    | "seek"
                    | "@seek"
            )
        {
            return Ok(());
        }
        Err(EditError::Unported(format!(
            "{method} during a native builder property token"
        )))
    }
    fn native_plan(&self, key: &str, whole: bool) -> Result<Option<Plan>, EditError> {
        if !supported(key) {
            return if known_other(key) {
                Err(EditError::Unported(
                    "native property transform, project or timing tokens".into(),
                ))
            } else {
                Ok(None)
            };
        }
        if self.options.property_channels {
            return Err(EditError::Unported(
                "authored native-property tokens".into(),
            ));
        }
        let Some((_, object)) = self.object()? else {
            return Ok(None);
        };
        if object.get("_stykStyle").is_some_and(Value::truthy) {
            return Err(EditError::Unported(
                "native-property tokens on captured appearance".into(),
            ));
        }
        let figures = self
            .report
            .get("figure_types")
            .and_then(Value::elements)
            .map(|e| e.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        let Some(index) = figures
            .iter()
            .position(|f| f.get("figure_type_id") == object.get("figure_type_id"))
        else {
            return Ok(None);
        };
        let figure = &figures[index];
        let segments = segments_of(figure);
        let polygons = polygons_of(figure);
        let joint = self.selection.joint;
        let segment = (joint >= 0).then(|| segments.get(joint as usize)).flatten();
        let mut binding = Binding::Single;
        let (label, initial, mut paths) = if key == "segment_z_order"
            || polygon_key(key).is_some_and(|(_, order)| order)
        {
            if self.sheet() {
                return Err(EditError::Unported(
                    "authored native drawable-order tokens".into(),
                ));
            }
            let target = match polygon_key(key) {
                Some((index, true)) if polygons.get(index).is_some() => (true, index),
                None if segment.is_some() => (false, joint as usize),
                _ => return Ok(None),
            };
            let entries = drawables(figure, None)?;
            let targets = style_targets(figure, &entries, target, whole);
            let initial = entries
                .iter()
                .position(|e| (e.polygon, e.index) == target)
                .unwrap() as f64
                + 1.0;
            let mut paths: Vec<_> = entries
                .iter()
                .flat_map(|e| {
                    [
                        order_path(e, "z_order"),
                        order_path(e, "z_order_runtime_raw"),
                    ]
                })
                .collect();
            paths.push(vec![Key::Field("segment_z_raw".into())]);
            paths.push(vec![Key::Field("poly_z_raw".into())]);
            let label = if target.0 {
                "Polygon draw order"
            } else if whole {
                "Branch draw order"
            } else {
                "Segment draw order"
            };
            binding = Binding::Order { entries, targets };
            (label.to_string(), initial, paths)
        } else if let Some((polygon, false)) = polygon_key(key) {
            let Some(p) = polygons.get(polygon) else {
                return Ok(None);
            };
            let opacity = num(p, "alpha_raw")
                .map(|a| 1.0 - a / 255.0)
                .unwrap_or_else(|| num(p, "color_alpha").unwrap_or(1.0));
            (
                "Polygon opacity".into(),
                opacity * 100.0,
                vec![
                    polygon_path(polygon, "alpha_raw"),
                    polygon_path(polygon, "color_alpha"),
                ],
            )
        } else if key.starts_with("outline_") {
            let style = figure.path(&["segment_decode", "global_style"]);
            let value = if key == "outline_width" {
                style
                    .and_then(|s| num(s, "outline_thickness"))
                    .unwrap_or(0.0)
            } else {
                (1.0 - style.and_then(|s| num(s, "u30")).unwrap_or(0.0) / 255.0) * 100.0
            };
            (
                if key == "outline_width" {
                    "Outline width"
                } else {
                    "Outline opacity"
                }
                .into(),
                value,
                vec![vec![
                    Key::Field("segment_decode".into()),
                    Key::Field("global_style".into()),
                ]],
            )
        } else {
            let Some(segment) = segment else {
                return Ok(None);
            };
            let (label, initial, paths) = match key {
                "thickness" => (
                    "Joint width",
                    num(segment, "thickness").unwrap_or(0.0),
                    vec![
                        segment_path(joint as usize, "thickness"),
                        segment_path(joint as usize, "visible"),
                    ],
                ),
                "segment_opacity" => (
                    "Joint opacity",
                    num(segment, "transparency")
                        .map(|a| 1.0 - a / 255.0)
                        .unwrap_or_else(|| num(segment, "color_alpha").unwrap_or(1.0))
                        * 100.0,
                    vec![
                        segment_path(joint as usize, "transparency"),
                        segment_path(joint as usize, "color_alpha"),
                    ],
                ),
                "segment_gradient_opacity" => {
                    let Some(secondary) = segment.get("secondary").filter(|v| v.truthy()) else {
                        return Ok(None);
                    };
                    let mut path = segment_path(joint as usize, "secondary");
                    path.push(Key::Field("a".into()));
                    (
                        "Gradient end opacity",
                        (1.0 - num(secondary, "a").unwrap_or(0.0) / 255.0) * 100.0,
                        vec![path],
                    )
                }
                _ => return Ok(None),
            };
            (label.into(), initial, paths)
        };
        let mut label = label;
        if whole
            && matches!(
                key,
                "thickness" | "segment_opacity" | "segment_gradient_opacity"
            )
        {
            let targets = branch(figure, joint as usize, true, key == "segment_opacity");
            if key == "segment_gradient_opacity" {
                let indices: Vec<_> = targets
                    .indices
                    .into_iter()
                    .filter(|&i| segments[i].get("secondary").is_some_and(Value::truthy))
                    .collect();
                paths = indices
                    .iter()
                    .map(|&i| {
                        let mut p = segment_path(i, "secondary");
                        p.push(Key::Field("a".into()));
                        p
                    })
                    .collect();
                binding = Binding::Gradient(indices);
            } else {
                let mut patch = Obj::new();
                patch.set(
                    if key == "thickness" {
                        "thickness"
                    } else {
                        "opacity"
                    },
                    Value::Num(0.0),
                );
                paths = style_patch(figure, joint as usize, &patch, &targets)?
                    .0
                    .into_iter()
                    .map(|e| e.path)
                    .collect();
                binding = Binding::Branch(targets);
            }
            label = format!(
                "Branch {}",
                if key == "thickness" {
                    "thickness"
                } else if key == "segment_opacity" {
                    "opacity"
                } else {
                    "gradient opacity"
                }
            );
        }
        Ok(Some(Plan {
            key: key.into(),
            label,
            index,
            joint,
            initial,
            paths,
            binding,
        }))
    }

    pub(crate) fn native_property_call(
        &mut self,
        method: &str,
        args: &[Value],
    ) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        Some(match method {
            "canEditNativeProperty" | "getNativePropertyValue" => self
                .native_plan(arg(0).as_str().unwrap_or(""), false)
                .map(|plan| {
                    if method == "canEditNativeProperty" {
                        Value::Bool(plan.is_some())
                    } else {
                        plan.map_or(Value::Null, |p| Value::Num(p.initial))
                    }
                }),
            "beginNativePropertyEdit" => {
                self.begin_native_property(arg(0).as_str().unwrap_or(""), args.get(1))
            }
            "previewNativePropertyEdit" => self
                .preview_native_property(&arg(0), &arg(1))
                .map(Value::Bool),
            "commitNativePropertyEdit" => self.commit_native_property(&arg(0)).map(Value::Bool),
            "cancelNativePropertyEdit" => self.cancel_native_property(&arg(0)).map(Value::Bool),
            _ => return None,
        })
    }
    fn begin_native_property(
        &mut self,
        key: &str,
        options: Option<&Value>,
    ) -> Result<Value, EditError> {
        // Native timelines are tools and tests; their origin documents are recorded for the other calls only.
        if !self.sheet() && self.report.get("figure_types").and_then(Value::elements).is_some_and(|figures| figures.iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy))) {
            return Err(EditError::Unported("a native builder property token on a document with animation origins".into()));
        }
        let whole = match options {
            None => false,
            Some(options) => {
                let fields = options.as_obj().ok_or_else(|| {
                    EditError::Unported("native property options that are not plain data".into())
                })?;
                if fields.keys().any(|k| &**k != "branch") {
                    return Err(EditError::Unported(
                        "native property range or bounds options".into(),
                    ));
                }
                match fields.get("branch") {
                    None => false,
                    Some(Value::Bool(b)) => *b,
                    _ => {
                        return Err(EditError::Unported(
                            "native property branch option that is not boolean".into(),
                        ));
                    }
                }
            }
        };
        // Admission precedes any finishing or cancellation: an unsupported path is atomic.
        self.native_plan(key, whole)?
            .ok_or_else(|| invalid("errors.nativePropertyEdit.selectThePropertyBeforeEditingIt"))?;
        if self.property_edit.is_some() {
            return Err(EditError::Unported(
                "native builder token during an authored property edit".into(),
            ));
        }
        if let Some(token) = self.native_token.as_ref() {
            self.cancel_native_property(&Value::Num(token.id as f64))?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let plan = self
            .native_plan(key, whole)?
            .ok_or_else(|| invalid("errors.nativePropertyEdit.selectThePropertyBeforeEditingIt"))?;
        if !plan.initial.is_finite() {
            return Err(invalid(
                "errors.nativePropertyEdit.theSelectedPropertyHasNoFiniteValue",
            ));
        }
        let figure = self
            .report
            .get("figure_types")
            .and_then(|f| f.item(plan.index))
            .unwrap();
        let mut before = capture(&figure, &plan.paths);
        if key.starts_with("outline_") && figure.get("segment_decode").is_none() {
            before
                .remove_empty
                .push(vec![Key::Field("segment_decode".into())]);
        }
        self.native_token_serial += 1;
        let id = self.native_token_serial;
        let value = plan.initial;
        self.native_token = Some(Token {
            id,
            value,
            before,
            plan,
            selection: self.selection_state(),
            frame_index: self.frame_index,
            uid: self.selection.uid,
            applied: false,
        });
        let mut out = Obj::new();
        out.set("token", Value::Num(id as f64));
        out.set("value", Value::Num(value));
        Ok(Value::object(out))
    }
    fn current_native_property(&mut self, id: &Value) -> Result<Token, EditError> {
        let token = self
            .native_token
            .as_ref()
            .filter(|t| id.as_f64() == Some(t.id as f64))
            .cloned()
            .ok_or_else(|| invalid(ENDED))?;
        if self.frame_index != token.frame_index
            || self.selection.uid != token.uid
            || self.selection.joint != token.plan.joint
        {
            self.cancel_native_property(id)?;
            return Err(invalid(
                "errors.nativePropertyEdit.theSelectedPropertyChangedDuringTheGesture",
            ));
        }
        Ok(token)
    }
    fn signal_native_property(&mut self, token: &Token, live: bool) {
        self.retained = None;
        self.emit(
            "edit",
            vec![
                ("label", Value::str(&token.plan.label)),
                ("live", Value::Bool(live)),
                ("timing", Value::Bool(false)),
                ("definition", Value::Bool(true)),
                ("nativeProperty", Value::str(&token.plan.key)),
            ],
        );
    }
    fn preview_native_property(&mut self, id: &Value, value: &Value) -> Result<bool, EditError> {
        let token = self.current_native_property(id)?;
        let value = validate(&token.plan.key, value)?;
        let branch = matches!(
            token.plan.binding,
            Binding::Branch(_) | Binding::Gradient(_)
        );
        if token.value == value && (!branch || token.applied) {
            return Ok(false);
        }
        let figure = self
            .report
            .get("figure_types")
            .and_then(|f| f.item(token.plan.index))
            .unwrap();
        let mut writes = Vec::new();
        match &token.plan.binding {
            Binding::Branch(targets) => {
                let mut patch = Obj::new();
                patch.set(
                    if token.plan.key == "thickness" {
                        "thickness"
                    } else {
                        "opacity"
                    },
                    Value::Num(if token.plan.key == "thickness" {
                        value
                    } else {
                        value / 100.0
                    }),
                );
                writes = style_patch(&figure, token.plan.joint as usize, &patch, targets)?.0;
            }
            Binding::Gradient(indices) => {
                for &i in indices {
                    let mut path = segment_path(i, "secondary");
                    path.push(Key::Field("a".into()));
                    writes.push(field(
                        path,
                        Value::Num(js_round((1.0 - value / 100.0) * 255.0)),
                    ));
                }
            }
            Binding::Order { entries, targets } => {
                if value.fract() != 0.0 || value < 1.0 || value > entries.len() as f64 {
                    return Err(crate::invalid_with(
                        "errors.editorBuilderStyle.drawOrderMustBeAWholePositionFrom",
                        vec![("length", Value::Num(entries.len() as f64))],
                    ));
                }
                let next = reorder(entries, targets, None, value - token.plan.initial)?;
                self.apply_definition_patch(token.plan.index, &token.before);
                if next.iter().enumerate().any(|(i, &j)| i != j) {
                    for (place, &i) in next.iter().enumerate() {
                        writes.push(field(
                            order_path(&entries[i], "z_order"),
                            Value::Num(place as f64 + 1.0),
                        ));
                        writes.push(field(
                            order_path(&entries[i], "z_order_runtime_raw"),
                            Value::Num(place as f64),
                        ));
                    }
                    writes.push(Entry {
                        path: vec![Key::Field("segment_z_raw".into())],
                        value: None,
                    });
                    writes.push(Entry {
                        path: vec![Key::Field("poly_z_raw".into())],
                        value: None,
                    });
                }
            }
            Binding::Single => {
                let alpha = js_round((1.0 - value / 100.0) * 255.0);
                if token.plan.key.starts_with("outline_") {
                    let mut style = figure
                        .path(&["segment_decode", "global_style"])
                        .and_then(Value::as_obj)
                        .cloned()
                        .unwrap_or_else(|| {
                            let mut o = Obj::new();
                            o.set("u28", Value::Num(0.0));
                            o.set("outline_thickness", Value::Num(0.0));
                            o.set("rgb", Value::nums(&[0.0; 3]));
                            o.set("u30", Value::Num(0.0));
                            o
                        });
                    if token.plan.key == "outline_width" {
                        style.set("outline_thickness", Value::Num(value));
                        style.set("u28", Value::Num((value as f32).to_bits() as f64));
                    } else {
                        style.set("u30", Value::Num(alpha));
                    }
                    writes.push(field(token.plan.paths[0].clone(), Value::object(style)));
                } else if token.plan.key == "thickness" {
                    let segment = segments_of(&figure)[token.plan.joint as usize].clone();
                    writes.push(field(token.plan.paths[0].clone(), Value::Num(value)));
                    writes.push(field(
                        token.plan.paths[1].clone(),
                        Value::Bool(value > 0.01 || code(&segment) > 0.0),
                    ));
                } else if token.plan.key == "segment_gradient_opacity" {
                    writes.push(field(token.plan.paths[0].clone(), Value::Num(alpha)));
                } else {
                    writes.push(field(token.plan.paths[0].clone(), Value::Num(alpha)));
                    writes.push(field(
                        token.plan.paths[1].clone(),
                        Value::Num(1.0 - alpha / 255.0),
                    ));
                }
            }
        }
        self.apply_definition_patch(
            token.plan.index,
            &Patch {
                entries: writes,
                remove_empty: Vec::new(),
            },
        );
        self.signal_native_property(&token, true);
        let active = self.native_token.as_mut().unwrap();
        active.value = value;
        active.applied |= branch;
        Ok(true)
    }
    fn commit_native_property(&mut self, id: &Value) -> Result<bool, EditError> {
        let token = self.current_native_property(id)?;
        validate(&token.plan.key, &Value::Num(token.value))?;
        if token.value == token.plan.initial
            && !matches!(
                token.plan.binding,
                Binding::Branch(_) | Binding::Gradient(_)
            )
        {
            self.cancel_native_property(id)?;
            return Ok(false);
        }
        let figure = self
            .report
            .get("figure_types")
            .and_then(|f| f.item(token.plan.index))
            .unwrap();
        let after = capture(&figure, &token.plan.paths);
        if entries_json(&token.before.entries) == entries_json(&after.entries) {
            self.cancel_native_property(id)?;
            return Ok(false);
        }
        self.native_token = None;
        self.record(Command {
            kind: CommandKind::NativeProperties {
                index: token.plan.index,
                before: token.before.clone(),
                after,
            },
            label: token.plan.label.clone(),
            before_selection: token.selection.clone(),
            after_selection: self.selection_state(),
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: false,
        })?;
        self.signal_native_property(&token, false);
        Ok(true)
    }
    fn cancel_native_property(&mut self, id: &Value) -> Result<bool, EditError> {
        let Some(token) = self
            .native_token
            .as_ref()
            .filter(|t| id.as_f64() == Some(t.id as f64))
            .cloned()
        else {
            return Ok(false);
        };
        self.native_token = None;
        self.apply_definition_patch(token.plan.index, &token.before);
        self.restore_selection(&token.selection)?;
        self.signal_native_property(&token, false);
        Ok(true)
    }
}
