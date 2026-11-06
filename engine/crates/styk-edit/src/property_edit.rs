//! Property edits on a layer sheet: the inspector's scrubs and keyed values
//! (`addAnimationKeys` and the sheet branches of
//! `beginAnimationEdit`, `previewAnimationEdit`, `commitAnimationEdit`,
//! `cancelAnimationEdit`), the sheet's property entries, and the
//! commands that reach it on a sheet: `setSceneColor`, `setSceneBackground`,
//! `setBackgroundColor`, `updateFigureStyle` and the
//! opacity of `updatePolygon`, `setVfxParameter`.
//!
//! A property edit at a tick composes one-key channels on the frame there
//! (`styk_eval::records::Records::compose_channels`) and writes the result as keys of the
//! layers it touches, through the sheet planner. While the inspector scrubs, the composed
//! frame is what the editor shows (`_sheetPropertyPreview`); the session holds it the same
//! way, and the app compares it, it does not adopt it.

use styk_doc::{Obj, Value};
use styk_eval::records::Records;

use crate::select::SelectionState;
use crate::sheet::{constant, fixed, items, key_at, num, Write};
use crate::{EditError, Editor};

mod native;
pub(crate) use native::Draft as NativeAnimationDraft;

/// `MAX_TICK` of the editor's animation keys and `MAX_SHEET_TICKS` of the sheet.
const MAX_TICK: f64 = 10_000_000.0;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// An inspector edit in progress (`editor._animationEdit` on a layer sheet) and the frame it
/// shows meanwhile (`editor._sheetPropertyPreview`).
#[derive(Clone, Debug)]
pub(crate) struct Edit {
    native: Option<native::NativeEdit>,
    target: Value,
    property: String,
    exact: bool,
    tick: f64,
    initial: Value,
    value: Value,
    /// The frame on show when the edit began, which previews compose on.
    frame: Value,
    #[allow(dead_code)]
    selection: SelectionState,
    pub changed: bool,
    pub preview: Option<Value>,
    /// An edit that sets one property on several targets at once (a branch's segments and polygons, the drawables of a figure's draw
    /// order): every member with its value. `target`, `initial` and `value` above are the first member's.
    group: Option<Vec<Member>>,
}

/// One target of a group edit.
#[derive(Clone, Debug)]
struct Member {
    target: Value,
    initial: Value,
    value: Value,
}

/// `Number.isInteger(value)`.
fn integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && v.fract() == 0.0)
}

/// `Number.isSafeInteger(value)`.
fn safe_integer(value: &Value) -> Option<f64> {
    integer(value).filter(|v| v.abs() <= 9007199254740991.0)
}

/// `normalizeAnimationTarget(target)`: the target's record in its canonical shape.
pub(crate) fn normalize_target(target: &Value) -> Result<Value, EditError> {
    let kind = target.get("kind").and_then(Value::as_str).filter(|k| ["figure", "segment", "polygon", "camera", "scene", "layer"].contains(k));
    let Some(kind) = kind.filter(|_| target.is_object()) else { return Err(invalid("errors.animationChannels.chooseAFigureSegmentLayerCameraOrScene")) };
    let scope = target.get("figureTypeId");
    if scope.is_some() && !["segment", "polygon"].contains(&kind) {
        return Err(invalid("errors.animationChannels.onlySegmentAndPolygonAnimationCanBeScoped"));
    }
    let mut out = Obj::new();
    out.set("kind", Value::str(kind));
    let uid = || target.get("uid").and_then(integer).filter(|v| *v >= 0.0);
    match kind {
        "polygon" => {
            let polygon = target.get("polygonId").and_then(integer).filter(|v| (1.0..=65535.0).contains(v));
            let figure = scope.and_then(safe_integer).filter(|v| *v >= 1.0);
            let (Some(uid), Some(polygon), Some(figure)) = (uid(), polygon, figure) else { return Err(invalid("errors.animationChannels.polygonAnimationRequiresAFigureUidPolygonIdentity")) };
            out.set("uid", Value::Num(uid));
            out.set("polygonId", Value::Num(polygon));
            out.set("figureTypeId", Value::Num(figure));
        }
        "figure" | "segment" => {
            let Some(uid) = uid() else { return Err(invalid("errors.animationChannels.figureAnimationRequiresANativeFigureIdentity")) };
            out.set("uid", Value::Num(uid));
            if kind == "segment" {
                let Some(handle) = target.get("handleId").and_then(integer).filter(|v| (1.0..=65535.0).contains(v)) else {
                    return Err(invalid("errors.animationChannels.segmentAnimationRequiresANativeSegmentHandleIdentity"));
                };
                out.set("handleId", Value::Num(handle));
                if let Some(scope) = scope {
                    let Some(figure) = safe_integer(scope).filter(|v| *v >= 1.0) else { return Err(invalid("errors.animationChannels.segmentAnimationScopeRequiresAPositiveNativeFigure")) };
                    out.set("figureTypeId", Value::Num(figure));
                }
            }
        }
        "layer" => {
            let id = target.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256);
            let Some(id) = id else { return Err(invalid("errors.animationChannels.layerAnimationRequiresALayerIdentity")) };
            out.set("id", Value::str(id));
        }
        _ => {}
    }
    Ok(Value::object(out))
}

/// `supportsAnimationProperty(target, property)`.
fn supported(kind: &str, property: &str) -> bool {
    let plain: &[&str] = match kind {
        "figure" => &["x", "y", "scale", "rotation", "color", "opacity", "outlineColor", "outlineWidth", "outlineOpacity", "zIndex", "pose"],
        "segment" => &["color", "opacity", "thickness", "gradientColor", "gradientOpacity", "paint", "zIndex"],
        "polygon" => &["color", "opacity", "zIndex"],
        "camera" => &["pose", "x", "y", "scale", "rotation"],
        "scene" => &["pose", "backgroundId", "color"],
        "layer" => &["pose"],
        _ => &[],
    };
    if property == "vfxScope" {
        return kind == "figure";
    }
    plain.contains(&property) || (["figure", "segment", "scene"].contains(&kind) && (property == "vfxStack" || styk_eval::vfx::parse::property(property).is_some()))
}

/// `encodeURIComponent(text)`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A number as JavaScript writes it in a template string.
fn text(value: Option<&Value>) -> String {
    value.map(styk_doc::json::to_string).unwrap_or_default()
}

/// `animationChannelId(target, property)` of a normalized target.
pub(crate) fn channel_id(target: &Value, property: &str) -> Result<String, EditError> {
    let kind = target.get("kind").and_then(Value::as_str).unwrap_or("");
    if !supported(kind, property) {
        return Err(crate::invalid_with("errors.animationChannels.propertyCannotAnimateOn", vec![("property", Value::str(property)), ("kind", Value::str(kind))]));
    }
    let identity = match kind {
        "polygon" => format!("{}/{}@{}", text(target.get("uid")), text(target.get("polygonId")), text(target.get("figureTypeId"))),
        "segment" => {
            let scope = target.get("figureTypeId").map(|t| format!("@{}", text(Some(t)))).unwrap_or_default();
            format!("{}/{}{scope}", text(target.get("uid")), text(target.get("handleId")))
        }
        "figure" => text(target.get("uid")),
        "layer" => target.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    };
    Ok(format!("{kind}:{}:{property}", encode_uri_component(&identity)))
}

/// `validateAnimationValue(target, property, value)` of a normalized target; `None` is
/// `undefined`.
pub(crate) fn validate_value(target: &Value, property: &str, value: Option<&Value>) -> Result<Value, EditError> {
    channel_id(target, property)?;
    let kind = target.get("kind").and_then(Value::as_str).unwrap_or("");
    if styk_eval::vfx::parse::is_vfx_property(property) {
        return validate_vfx_value(property, value);
    }
    if property == "paint" {
        return Ok(styk_eval::records::paint::normalize_paint(value.unwrap_or(&Value::Null))?.value());
    }
    if property == "pose" {
        return match value {
            Some(Value::Null) => {
                let mut pose = Obj::new();
                pose.set("frameId", Value::Null);
                Ok(Value::object(pose))
            }
            Some(record) => match record.get("frameId") {
                Some(Value::Null) => {
                    let mut pose = Obj::new();
                    pose.set("frameId", Value::Null);
                    Ok(Value::object(pose))
                }
                Some(Value::Str(id)) if !id.is_empty() => {
                    let mut pose = Obj::new();
                    pose.set("frameId", Value::str(id));
                    Ok(Value::object(pose))
                }
                _ => Err(invalid("errors.animationChannels.aPoseKeyMustReferenceANativeFrame")),
            },
            None => Err(invalid("errors.animationChannels.aPoseKeyMustReferenceANativeFrame")),
        };
    }
    if kind == "scene" && property == "color" && matches!(value, Some(Value::Null)) {
        return Ok(Value::Null);
    }
    let Some(number) = value.and_then(|v| match v {
        Value::Num(n) if n.is_finite() => Some(*n),
        _ => None,
    }) else {
        return Err(invalid("errors.animationChannels.animationValuesMustBeFiniteNumbers"));
    };
    let whole = number.fract() == 0.0;
    if property == "zIndex" {
        if kind == "figure" {
            if !whole || number.abs() > 9007199254740991.0 || number.abs() > 1000000.0 {
                return Err(invalid("errors.animationProperties.zIndexMustBeAWholeNumberFrom"));
            }
        } else if !((number as f32) as f64).is_finite() {
            return Err(invalid("errors.animationProperties.drawOrderMustBeAFiniteNativeNumber"));
        }
        return Ok(Value::Num(number));
    }
    if property == "scale" && (number < if kind == "camera" { 0.000001 } else { 0.0 } || number > 1e6) {
        return Err(invalid("errors.animationChannels.animationScaleIsOutsideTheSupportedRange"));
    }
    if ["opacity", "outlineOpacity", "gradientOpacity"].contains(&property) && !(0.0..=1.0).contains(&number) {
        return Err(invalid("errors.animationChannels.animationOpacityMustBeBetweenZeroAndOne"));
    }
    if property == "backgroundId" && (!whole || !(0.0..=4294967295.0).contains(&number)) {
        return Err(invalid("errors.animationChannels.chooseAValidBackgroundIdentity"));
    }
    let color = ["color", "outlineColor", "gradientColor"].contains(&property);
    if color && (!whole || !(0.0..=4294967295.0).contains(&number)) {
        return Err(invalid("errors.animationChannels.colorMustBeA32BitColor"));
    }
    if color && (kind == "segment" || kind == "polygon" || property == "outlineColor") && number > 16777215.0 {
        return Err(invalid("errors.animationChannels.styleColorsUseRgbOpacityHasItsOwn"));
    }
    if ["outlineWidth", "thickness"].contains(&property) && !(0.0..=1e6).contains(&number) {
        return Err(invalid("errors.animationChannels.widthMustBeBetweenZeroAnd1000"));
    }
    Ok(Value::Num(number))
}

/// `validateVfxValue(property, value)`: a stack resolved, a number in its range.
pub(crate) fn validate_vfx_value(property: &str, value: Option<&Value>) -> Result<Value, EditError> {
    if property == "vfxStack" {
        crate::vfx_clips::check_stack(value, &[])?;
        return styk_eval::records::resolved_stack(value.unwrap_or(&Value::Null)).map_err(EditError::from);
    }
    let (color, discrete, min, max) = if property == "vfxScope" {
        (false, true, 0.0, 1.0)
    } else {
        let Some((kind, _, field)) = styk_eval::vfx::parse::property(property) else { return Err(invalid("errors.vfx.unknownVfxParameter")) };
        let spec = match field {
            styk_eval::vfx::Field::Enabled => styk_eval::vfx::parse::ENABLED,
            styk_eval::vfx::Field::Param(i) => kind.specs()[i],
        };
        (spec.kind == styk_eval::vfx::registry::ParamKind::Color, spec.kind.discrete(), spec.min, spec.max)
    };
    match value {
        Some(Value::Num(n)) if n.is_finite() && *n >= min && *n <= max && (!(color || discrete) || n.fract() == 0.0) => Ok(Value::Num(*n)),
        Some(paint @ (Value::Obj(_) | Value::Arr(_) | Value::Nums(_) | Value::Null)) if color => styk_eval::records::paint::normalize_paint(paint).map(|paint| paint.value()).map_err(EditError::from),
        _ => {
            let mut parts = property.split(':').skip(1);
            let (type_name, _, param) = (parts.next().unwrap_or(""), parts.next(), parts.next().unwrap_or(""));
            Err(if property == "vfxScope" {
                crate::invalid_with("errors.cameraMotion.mustBeBetweenAnd", vec![("label", crate::message("vfxInspector.wholeFigure")), ("min", Value::Num(min)), ("max", Value::Num(max))])
            } else {
                crate::vfx_clips::vfx_range_error(type_name, param, min, max)
            })
        }
    }
}

/// `checkTick(tick)` of the animation methods.
fn check_tick(tick: &Value) -> Result<f64, EditError> {
    integer(tick).filter(|t| (0.0..=MAX_TICK).contains(t)).ok_or_else(|| invalid("errors.editorAnimation.keyframeTimeMustBeAnIntegerFrom0"))
}

/// `checkedTick(tick)` of the layer sheet.
pub(crate) fn checked_tick(tick: &Value) -> Result<f64, EditError> {
    integer(tick).filter(|t| *t >= 0.0 && *t < MAX_TICK).ok_or_else(|| invalid("errors.editorLayerSheet.chooseAValidWholeFrame"))
}

/// `rgb(value)` of the builder: `#rrggbb` or three bytes.
fn rgb(value: &Value) -> Result<[f64; 3], EditError> {
    let bad = || invalid("errors.editorBuilderBranch.colorMustBeASixDigitHexColor");
    if let Some(hex) = value.as_str() {
        let digits = hex.strip_prefix('#').filter(|d| d.len() == 6 && d.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(bad)?;
        let part = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).map(f64::from).map_err(|_| bad());
        return Ok([part(0)?, part(2)?, part(4)?]);
    }
    let parts: Vec<Value> = if value.is_array() { items(Some(value)) } else { return Err(bad()) };
    if parts.len() != 3 {
        return Err(bad());
    }
    let mut out = [0.0; 3];
    for (i, part) in parts.iter().enumerate() {
        out[i] = integer(part).filter(|v| (0.0..=255.0).contains(v)).ok_or_else(bad)?;
    }
    Ok(out)
}

/// `styleColor(rgb)`.
fn style_color(rgb: [f64; 3]) -> f64 {
    ((rgb[0] as u32) << 16 | (rgb[1] as u32) << 8 | rgb[2] as u32) as f64
}

/// `value === other` for what a property holds: numbers by value, records by identity
/// (never the same here: a validated record is a new one).
fn strictly_equal(value: &Value, other: Option<&Value>) -> bool {
    match (value, other) {
        (Value::Num(a), Some(Value::Num(b))) => a == b,
        (Value::Null, Some(Value::Null)) => true,
        (Value::Bool(a), Some(Value::Bool(b))) => a == b,
        (Value::Str(a), Some(Value::Str(b))) => a == b,
        _ => false,
    }
}

fn entry(target: &Value, property: &str, tick: Option<f64>, value: Option<Value>, exact: bool) -> Value {
    let mut out = Obj::new();
    out.set("target", target.clone());
    out.set("property", Value::str(property));
    if let Some(tick) = tick {
        out.set("tick", Value::Num(tick));
    }
    if let Some(value) = value {
        out.set("value", value);
    }
    if exact {
        out.set("exactTarget", Value::Bool(true));
    }
    Value::object(out)
}

/// `isDiscreteAnimationProperty(property)` for the properties a group edit names: values that hold between keys.
fn holds(property: &str) -> bool {
    matches!(property, "zIndex" | "paint" | "backgroundId")
}

/// `entry.tick ?? fallback`.
fn tick_of(entry: &Value, fallback: f64) -> Value {
    entry.get("tick").filter(|t| !t.is_null()).cloned().unwrap_or(Value::Num(fallback))
}

impl Editor {
    /// The frame a property edit or a camera drag on show composes (`editor._sheetPropertyPreview`).
    pub fn property_preview(&self) -> Option<Value> {
        self.property_edit.as_ref().and_then(|edit| edit.preview.clone()).or_else(|| self.camera_drag().and_then(|drag| drag.preview.clone()))
    }

    /// The open property edit as the owner mirrors it on the editor (`editor._animationEdit`):
    /// after every call its `changed` (and a layer sheet's `value`), and when `begin` is set,
    /// the call that opened it, the rest of its record too. `null` when no edit is open.
    pub fn animation_edit_view(&self, begin: bool) -> Value {
        let Some(edit) = &self.property_edit else { return Value::Null };
        let sheet = edit.native.is_none();
        let mut out = Obj::new();
        if begin {
            out.set("sheet", Value::Bool(sheet));
            match &edit.group {
                Some(members) => out.set("targets", Value::array(members.iter().map(|m| m.target.clone()).collect())),
                None => out.set("target", edit.target.clone()),
            }
            out.set("property", Value::str(&edit.property));
            out.set("exactTarget", Value::Bool(edit.exact));
            out.set("tick", Value::Num(edit.tick));
            out.set("initialValue", match &edit.group {
                Some(members) => Value::array(members.iter().map(|m| m.initial.clone()).collect()),
                None => edit.initial.clone(),
            });
        }
        if sheet {
            out.set("value", match &edit.group {
                Some(members) => Value::array(members.iter().map(|m| m.value.clone()).collect()),
                None => edit.value.clone(),
            });
        }
        out.set("changed", Value::Bool(edit.changed));
        Value::object(out)
    }

    /// The frame a property edit on a layer sheet composes its previews on: the frame on show
    /// when the edit began.
    pub(crate) fn property_edit_base(&self) -> Option<Value> {
        self.property_edit.as_ref().filter(|edit| edit.native.is_none()).map(|edit| edit.frame.clone())
    }

    /// The evaluated frame as records of the current document.
    pub(crate) fn with_records<T>(&self, run: impl FnOnce(&Records) -> Result<T, EditError>) -> Result<T, EditError> {
        let prepared = self.prepared()?;
        let records = Records::new(&self.report, &prepared)?;
        run(&records)
    }

    /// Before a call: an open property edit allows only its own calls, and history cancels it.
    pub(crate) fn property_gate_checked(&mut self, method: &str, projected_native: bool) -> Result<(), EditError> {
        if self.property_edit.is_none() {
            return Ok(());
        }
        match method {
            "beginAnimationEdit" | "previewAnimationEdit" | "commitAnimationEdit" | "cancelAnimationEdit" => Ok(()),
            "seek" | "@seek" if projected_native => Ok(()),
            "centerCamera" | "alignFiguresInFrames" => Ok(()), // Their recorded owner finishes this edit before measuring.
            "undo" | "redo" => self.cancel_animation_edit().map(|_| ()),
            "addAnimationKeys" | "addAnimationKey" if !self.sheet() => Ok(()),
            other => Err(EditError::Unported(format!("{other} during a property edit"))),
        }
    }

    /// Runs a property call by its JavaScript name; `None` for other names.
    pub(crate) fn property_call_checked(&mut self, method: &str, args: &[Value], check: &mut dyn FnMut() -> Result<(), EditError>) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i).cloned();
        let sheet = self.sheet();
        if !sheet && ["setSceneColor", "setSceneBackground", "setBackgroundColor", "setVfxParameter"].contains(&method) {
            return Some(Err(EditError::Unported(format!("{method} on a native timeline"))));
        }
        Some(match method {
            "addAnimationKeys" => self.add_animation_keys(args.first()),
            "addAnimationKey" => {
                // `addAnimationKey(target, property, tick = this.tick, value, {exactTarget})`.
                let tick = arg(2).filter(|t| !t.is_null()).unwrap_or(Value::Num(self.tick));
                let exact = arg(4).is_some_and(|o| o.get("exactTarget").is_some_and(Value::truthy));
                let mut one = Obj::new();
                one.set("target", arg(0).unwrap_or(Value::Null));
                one.set("property", arg(1).unwrap_or(Value::Null));
                one.set("tick", tick);
                if let Some(value) = arg(3) {
                    one.set("value", value);
                }
                one.set("exactTarget", Value::Bool(exact));
                self.add_animation_keys(Some(&Value::array(vec![Value::object(one)]))).map(|keys| keys.item(0).unwrap_or(Value::Null))
            }
            "beginAnimationEdit" => {
                let exact = arg(2).is_some_and(|o| o.get("exactTarget").is_some_and(Value::truthy));
                self.begin_animation_edit_checked(&arg(0).unwrap_or(Value::Null), &arg(1).unwrap_or(Value::Null), exact, check)
            }
            "previewAnimationEdit" => self.preview_animation_edit_checked(arg(0), check),
            "commitAnimationEdit" => self.commit_animation_edit_checked(check).map(Value::Bool),
            "cancelAnimationEdit" => self.cancel_animation_edit().map(Value::Bool),
            "setSceneColor" => self.set_scene_color(&arg(0).unwrap_or(Value::Null), arg(1).as_ref()),
            "setSceneBackground" => self.set_scene_background(&arg(0).unwrap_or(Value::Null), arg(1).as_ref()),
            "setBackgroundColor" => self.set_background_color(arg(0)),
            "updateFigureStyle" => self.update_figure_style(arg(0).as_ref()),
            "setVfxParameter" => self.set_vfx_parameter(&arg(0).unwrap_or(Value::Null), &arg(1).unwrap_or(Value::Null), &arg(2).unwrap_or(Value::Null), arg(3)),
            _ => return None,
        })
    }

    /// `animationValue(target, property, tick)`: what the editor shows for a property at a
    /// tick (the frame on show at the playhead). On a layer sheet no `_styk.animation`
    /// channel exists, so an exact target reads the same.
    pub(crate) fn animation_value(&self, target: &Value, property: &str, tick: &Value) -> Result<Option<Value>, EditError> {
        let frame = self.animation_frame_at(tick)?;
        let target = normalize_target(target)?;
        channel_id(&target, property)?;
        self.with_records(|records| Ok(records.property_value(&frame, &target, property)?))
    }

    /// The same property target view used by `animationValue`: the live frame at
    /// the playhead, otherwise the existing evaluated-record cache at the given tick.
    pub(crate) fn animation_frame_at(&self, tick: &Value) -> Result<Value, EditError> {
        let tick = tick.as_f64().filter(|t| t.is_finite() && (0.0..=MAX_TICK).contains(t)).ok_or_else(|| invalid("errors.editorAnimation.keyframeTimeMustBeAnIntegerFrom0"))?;
        if tick == self.tick { self.shown_frame() } else { self.evaluated(tick, true) }
    }

    /// `addAnimationKeys(entries)` on a layer sheet: a missing value is the one on show.
    pub(crate) fn add_animation_keys(&mut self, entries: Option<&Value>) -> Result<Value, EditError> {
        let list: Vec<Value> = match entries {
            Some(value) if value.is_array() => items(Some(value)),
            _ => return Ok(Value::array(Vec::new())),
        };
        if list.is_empty() {
            return Ok(Value::array(Vec::new()));
        }
        if !self.sheet() {
            return self.add_native_animation_keys(&list);
        }
        let mut filled = Vec::with_capacity(list.len());
        for entry in &list {
            let mut out = entry.as_obj().cloned().ok_or_else(|| EditError::Unported("an animation key entry that is not an object".into()))?;
            let property = entry.get("property").and_then(Value::as_str).unwrap_or("");
            if entry.get("value").is_none() && property != "pose" {
                let target = entry.get("target").cloned().unwrap_or(Value::Null);
                let tick = check_tick(&tick_of(entry, self.tick))?;
                match self.animation_value(&target, property, &Value::Num(tick))? {
                    Some(value) => out.set("value", value),
                    None => {
                        out.remove("value");
                    }
                }
            }
            filled.push(Value::object(out));
        }
        self.sheet_property_entries(&filled, "Edit layer pose").map(Value::array)
    }

    /// `_sheetPropertyEntries(entries, label)`: per tick, the frame with the entries'
    /// one-key channels composed is written as a key of each layer they touch (a held cell's
    /// key, unless auto key is on); returns the keys written.
    pub(crate) fn sheet_property_entries(&mut self, entries: &[Value], label: &str) -> Result<Vec<Value>, EditError> {
        let mut by_tick: Vec<(f64, Vec<&Value>)> = Vec::new();
        for entry in entries {
            let tick = checked_tick(&tick_of(entry, self.tick))?;
            match by_tick.iter_mut().find(|(t, _)| *t == tick) {
                Some((_, list)) => list.push(entry),
                None => by_tick.push((tick, vec![entry])),
            }
        }
        let owner = |editor: &Editor, entry: &Value| -> String {
            let target = entry.get("target");
            let kind = target.and_then(|t| t.get("kind")).and_then(Value::as_str).unwrap_or("");
            if fixed(kind) {
                kind.to_string()
            } else if kind == "layer" {
                target.and_then(|t| t.get("id")).and_then(Value::as_str).unwrap_or("").to_string()
            } else {
                match target.and_then(|t| t.get("uid")).and_then(Value::as_f64) {
                    Some(uid) => editor.layer_of(uid as u32),
                    None => crate::frame::layer_of(editor.report.path(&["_styk", "layers"]), u32::MAX),
                }
            }
        };
        let mut ids: Vec<String> = Vec::new();
        for entry in entries {
            let id = owner(self, entry);
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let mut plan = self.planner(&ids)?;
        let mut written: Vec<(String, Value)> = Vec::new();
        for (tick, list) in &by_tick {
            let mut channels: Vec<Value> = Vec::new();
            for entry in list {
                let property = entry.get("property").and_then(Value::as_str).unwrap_or("");
                if property == "pose" && entry.get("value").is_none() {
                    continue;
                }
                let target = normalize_target(entry.get("target").unwrap_or(&Value::Null))?;
                let id = channel_id(&target, property)?;
                let value = if property == "pose" { entry.get("value").cloned().unwrap_or(Value::Null) } else { validate_value(&target, property, entry.get("value"))? };
                let mut key = Obj::new();
                key.set("id", Value::str(&format!("preview-{}", channels.len())));
                key.set("tick", Value::Num(*tick));
                key.set("value", value);
                key.set("interpolation", Value::str("constant"));
                let mut channel = Obj::new();
                channel.set("id", Value::str(&id));
                channel.set("target", target);
                channel.set("property", Value::str(property));
                channel.set("keys", Value::array(vec![Value::object(key)]));
                channels.push(Value::object(channel));
            }
            let mut frames: [Option<Value>; 2] = [None, None];
            for id in &ids {
                let selected: Vec<&&Value> = list.iter().filter(|entry| owner(self, entry) == *id).collect();
                if selected.is_empty() {
                    continue;
                }
                let keys = plan.keys(id);
                let previous = key_at(&keys, *tick).map(|i| keys[i].clone());
                let held = |key: &Value| matches!(key.get("interpolation").and_then(Value::as_str), Some("constant" | "hold"));
                let target = previous.clone().filter(|key| num(key, "tick") == Some(*tick) || (!self.auto_key && held(key)));
                // A key whose movieclip frames are replaced keeps its replacements: its pose is
                // written from the frame without them.
                let patches = items(target.as_ref().and_then(|key| key.get("movieclipPatches")));
                let skip = !patches.is_empty() || target.as_ref().is_some_and(|key| key.get("patchOnly").is_some_and(Value::truthy));
                if frames[skip as usize].is_none() {
                    let base = if skip { self.evaluated_without_patches(*tick)? } else { self.evaluated(*tick, false)? };
                    frames[skip as usize] = Some(if channels.is_empty() { base } else { self.with_records(|records| Ok(records.compose_channels(base, &channels, *tick)?))? });
                }
                let given = selected.iter().rev().find(|entry| entry.get("interpolation").is_some()).map(|entry| (**entry).clone());
                if let Some(given) = &given {
                    crate::sheet_frames::valid_easing(given)?;
                }
                let held_easing = constant();
                let easing = given.or_else(|| target.clone()).or_else(|| previous.clone()).unwrap_or(held_easing);
                let at = target.as_ref().and_then(|key| num(key, "tick")).unwrap_or(*tick);
                plan.write(id, at, frames[skip as usize].as_ref().unwrap(), Write { easing: Some(&easing), ..Write::default() })?;
                if !patches.is_empty() {
                    let mut keys = plan.keys(id);
                    if let Some(written) = keys.iter_mut().find(|key| num(key, "tick") == Some(at)).and_then(Value::make_obj) {
                        written.set("movieclipPatches", Value::array(patches.clone()));
                        match target.as_ref().and_then(|key| key.get("empty")) {
                            Some(empty) => written.set("empty", empty.clone()),
                            None => {
                                written.remove("empty");
                            }
                        }
                    }
                    plan.set_keys(id, keys);
                }
                let key = plan.keys(id).into_iter().find(|key| num(key, "tick") == Some(at)).and_then(|key| key.get("id").cloned()).unwrap_or(Value::Null);
                written.push((id.clone(), key));
            }
        }
        let selection = self.selection_state();
        self.publish(plan, label, selection, None)?;
        let tracks = self.report.path(&["_styk", "layerSheet", "tracks"]).cloned().unwrap_or(Value::Null);
        Ok(written
            .iter()
            .map(|(id, key)| items(tracks.get(id).and_then(|t| t.get("keys"))).into_iter().find(|k| k.get("id") == Some(key)).unwrap_or(Value::Null))
            .collect())
    }

    /// The actual `_animationEdit` returned at BEGIN, for the exclusive worker
    /// response. It shares the existing edit's COW frame/selection and never
    /// reconstructs an edit, baseline or publication state.
    pub(crate) fn animation_edit_value_worker(&self) -> Result<Value, EditError> {
        let edit = self.property_edit.as_ref().ok_or_else(|| invalid("errors.editorAnimation.beginAPropertyEditBeforePreviewingIt"))?;
        if let Some(native) = &edit.native { return Ok(native.begin_value_worker(edit)); }
        let mut out = Obj::new();
        out.set("sheet", Value::Bool(true));
        match &edit.group {
            Some(members) => out.set("targets", Value::array(members.iter().map(|m| m.target.clone()).collect())),
            None => out.set("target", edit.target.clone()),
        }
        out.set("property", Value::str(&edit.property));
        out.set("exactTarget", Value::Bool(edit.exact));out.set("tick", Value::Num(edit.tick));
        match &edit.group {
            Some(members) => {
                out.set("initialValue", Value::array(members.iter().map(|m| m.initial.clone()).collect()));
                out.set("value", Value::array(members.iter().map(|m| m.value.clone()).collect()));
            }
            None => {
                out.set("initialValue", edit.initial.clone());out.set("value", edit.value.clone());
            }
        }
        out.set("frame", edit.frame.clone());out.set("selection", edit.selection.history_value());
        out.set("changed", Value::Bool(edit.changed));
        Ok(Value::object(out))
    }

    /// `beginAnimationEdit(target, property, {exactTarget})` on a layer sheet. A list of targets begins one edit of the property on all of
    /// them (`previewAnimationEdit` then takes one value for all, or one for each).
    pub(crate) fn begin_animation_edit_checked(&mut self, target: &Value, property: &Value, exact: bool, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        check()?;
        if target.is_array() {
            if !self.sheet() {
                return Err(EditError::Unported("an edit of several targets on a native timeline".into()));
            }
            return self.begin_group_animation_edit(&items(Some(target)), property, exact);
        }
        if !self.sheet() { return self.begin_native_animation_edit_checked(target, property, exact, check); }
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let property = property.as_str().unwrap_or("");
        let target = normalize_target(target)?;
        channel_id(&target, property)?;
        if property == "pose" {
            return Err(invalid("errors.editorAnimation.usePoseKeysToEditALayerPose"));
        }
        check_tick(&Value::Num(self.tick))?;
        let initial = self.animation_value(&target, property, &Value::Num(self.tick))?.ok_or_else(|| invalid("errors.editorAnimation.theSelectedFigureIsNotPresentAtThis"))?;
        let frame = self.shown_frame()?;
        self.property_edit = Some(Edit {
            native: None,
            target: target.clone(),
            property: property.to_string(),
            exact,
            tick: self.tick,
            initial: initial.clone(),
            value: initial.clone(),
            frame,
            selection: self.selection_state(),
            changed: false,
            preview: None,
            group: None,
        });
        // The editor returns its edit record, a view.
        let mut out = Obj::new();
        out.set("sheet", Value::Bool(true));
        out.set("target", target);
        out.set("property", Value::str(property));
        out.set("exactTarget", Value::Bool(exact));
        out.set("tick", Value::Num(self.tick));
        out.set("initialValue", initial.clone());
        out.set("value", initial);
        out.set("changed", Value::Bool(false));
        Ok(Value::object(out))
    }

    /// `previewAnimationEdit(value)` on a layer sheet: the frame on show at the edit's start
    /// with the value composed is shown until the edit ends.
    pub(crate) fn preview_animation_edit_checked(&mut self, value: Option<Value>, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        check()?;
        if !self.sheet() { return self.preview_native_animation_edit_checked(value, check); }
        let Some(edit) = self.property_edit.clone() else { return Err(invalid("errors.editorAnimation.beginAPropertyEditBeforePreviewingIt")) };
        if edit.group.is_some() {
            return self.preview_group_animation_edit(&edit, value);
        }
        let validated = validate_value(&edit.target, &edit.property, value.as_ref())?;
        let changed = !strictly_equal(&validated, Some(&edit.initial));
        let mut key = Obj::new();
        key.set("id", Value::str("preview"));
        key.set("tick", Value::Num(edit.tick));
        key.set("value", validated.clone());
        key.set("interpolation", Value::str("constant"));
        let mut channel = Obj::new();
        channel.set("id", Value::str(&channel_id(&edit.target, &edit.property)?));
        channel.set("target", edit.target.clone());
        channel.set("property", Value::str(&edit.property));
        channel.set("keys", Value::array(vec![Value::object(key)]));
        let preview = self.with_records(|records| Ok(records.compose_channels(edit.frame.clone(), &[Value::object(channel)], edit.tick)?))?;
        if let Some(open) = self.property_edit.as_mut() {
            open.value = validated;
            open.changed = changed;
            open.preview = Some(preview);
        }
        self.emit("edit", vec![("live", Value::Bool(true))]);
        Ok(value.unwrap_or(Value::Null))
    }

    /// `beginAnimationEdit([targets], property, {exactTarget})` on a layer sheet.
    fn begin_group_animation_edit(&mut self, targets: &[Value], property: &Value, exact: bool) -> Result<Value, EditError> {
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let property = property.as_str().unwrap_or("");
        if targets.is_empty() {
            return Err(invalid("errors.editorBranchStyle.chooseABranchWithEditableOpacity"));
        }
        if property == "pose" {
            return Err(invalid("errors.editorAnimation.usePoseKeysToEditALayerPose"));
        }
        check_tick(&Value::Num(self.tick))?;
        let frame = self.shown_frame()?;
        let started = self.with_records(|records| {
            let mut started = Vec::with_capacity(targets.len());
            for target in targets {
                let target = normalize_target(target)?;
                channel_id(&target, property)?;
                let Some(initial) = records.property_value(&frame, &target, property)? else { return Err(invalid("errors.editorAnimation.theSelectedFigureIsNotPresentAtThis")) };
                started.push(Member { target, initial: initial.clone(), value: initial });
            }
            Ok(started)
        })?;
        let first = started[0].clone();
        let view = Edit {
            native: None,
            target: first.target,
            property: property.to_string(),
            exact,
            tick: self.tick,
            initial: first.initial,
            value: first.value,
            frame,
            selection: self.selection_state(),
            changed: false,
            preview: None,
            group: Some(started),
        };
        self.property_edit = Some(view);
        // The editor returns its edit record, a view.
        Ok(self.animation_edit_view(true))
    }

    /// `previewAnimationEdit(value)` of a group edit: `value` is one number for every member or a list with one for each. The frame on
    /// show at the edit's start with the values composed is shown until the edit ends.
    fn preview_group_animation_edit(&mut self, edit: &Edit, value: Option<Value>) -> Result<Value, EditError> {
        let members = edit.group.as_deref().unwrap_or_default();
        let given: Vec<Option<Value>> = match &value {
            Some(list) if list.is_array() => {
                let list = items(Some(list));
                if list.len() != members.len() {
                    return Err(invalid("errors.editorBranchStyle.everyEditedDrawableNeedsAValue"));
                }
                list.into_iter().map(Some).collect()
            }
            other => vec![other.clone(); members.len()],
        };
        let mut values = Vec::with_capacity(members.len());
        let mut channels = Vec::with_capacity(members.len());
        for (member, given) in members.iter().zip(&given) {
            let validated = validate_value(&member.target, &edit.property, given.as_ref())?;
            let mut key = Obj::new();
            key.set("id", Value::str("preview"));
            key.set("tick", Value::Num(edit.tick));
            key.set("value", validated.clone());
            key.set("interpolation", Value::str("constant"));
            let mut channel = Obj::new();
            channel.set("id", Value::str(&channel_id(&member.target, &edit.property)?));
            channel.set("target", member.target.clone());
            channel.set("property", Value::str(&edit.property));
            channel.set("keys", Value::array(vec![Value::object(key)]));
            channels.push(Value::object(channel));
            values.push(validated);
        }
        let changed = members.iter().zip(&values).any(|(member, value)| !strictly_equal(value, Some(&member.initial)));
        let preview = self.with_records(|records| Ok(records.compose_channels(edit.frame.clone(), &channels, edit.tick)?))?;
        if let Some(open) = self.property_edit.as_mut() {
            if let Some(members) = open.group.as_mut() {
                for (member, value) in members.iter_mut().zip(values) {
                    member.value = value;
                }
                open.value = members[0].value.clone();
            }
            open.changed = changed;
            open.preview = Some(preview);
        }
        self.emit("edit", vec![("live", Value::Bool(true))]);
        Ok(value.unwrap_or(Value::Null))
    }

    /// `commitAnimationEdit()` on a layer sheet: the edited value keyed at the edit's tick.
    pub(crate) fn commit_animation_edit(&mut self, ) -> Result<bool, EditError> { self.commit_animation_edit_checked(&mut || Ok(())) }
    pub(crate) fn commit_animation_edit_checked(&mut self, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        if !self.sheet() { return self.commit_native_animation_edit_checked(check); }
        let Some(edit) = self.property_edit.take() else { return Ok(false) };
        self.retained = None;
        if !edit.changed {
            return Ok(false);
        }
        if let Some(members) = &edit.group {
            // Every member is keyed (a draw order gives each drawable its position) as one entry; values that hold between keys hold here too.
            let entries: Vec<Value> = members.iter().map(|member| {
                let mut written = entry(&member.target, &edit.property, Some(edit.tick), Some(member.value.clone()), edit.exact);
                if holds(&edit.property) {
                    if let Some(record) = written.make_obj() {
                        record.set("interpolation", Value::str("constant"));
                    }
                }
                written
            }).collect();
            self.sheet_property_entries(&entries, "Edit layer pose")?;
            return Ok(true);
        }
        let entry = entry(&edit.target, &edit.property, Some(edit.tick), Some(edit.value.clone()), edit.exact);
        self.sheet_property_entries(&[entry], &format!("Edit {}", edit.property))?;
        Ok(true)
    }

    /// `cancelAnimationEdit()` on a layer sheet.
    pub(crate) fn cancel_animation_edit(&mut self) -> Result<bool, EditError> {
        if !self.sheet() { return self.cancel_native_animation_edit(); }
        if self.property_edit.take().is_none() {
            return Ok(false);
        }
        self.retained = None;
        self.emit("edit", vec![("label", Value::str("Cancel property edit"))]);
        Ok(true)
    }

    /// `sheetEditTimes(indices)` of `{indices}`: the ticks a range edit keys, the timeline's
    /// chosen ticks when the indices carry them ([`crate::range::Indices`]).
    pub(crate) fn sheet_edit_times_of(&self, options: Option<&Value>) -> Result<Vec<f64>, EditError> {
        self.sheet_edit_times(crate::range::Indices::parse(options.and_then(|o| o.get("indices"))).as_ref())
    }

    /// `setSceneColor(argb, {indices})` on a layer sheet.
    fn set_scene_color(&mut self, argb: &Value, options: Option<&Value>) -> Result<Value, EditError> {
        let Some(argb) = integer(argb).filter(|v| (0.0..=4294967295.0).contains(v)) else { return Err(invalid("errors.editorScene.sceneColorMustBeA32BitArgb")) };
        let scene = scene_target();
        let entries: Vec<Value> = self.sheet_edit_times_of(options)?.into_iter().map(|tick| entry(&scene, "color", Some(tick), Some(Value::Num(argb)), false)).collect();
        self.sheet_property_entries(&entries, "Set scene color").map(Value::array)
    }

    /// `setSceneBackground(id, {indices})` on a layer sheet: the background chosen and the
    /// colour handed back to it.
    pub(crate) fn set_scene_background(&mut self, id: &Value, options: Option<&Value>) -> Result<Value, EditError> {
        let exists = |id: f64| items(self.report.get("backgrounds")).iter().any(|bg| num(bg, "background_id") == Some(id));
        let Some(id) = integer(id).filter(|v| *v >= 0.0 && (*v == 0.0 || exists(*v))) else { return Err(invalid("errors.editorScene.chooseAnExistingBackground")) };
        let scene = scene_target();
        let mut entries = Vec::new();
        for tick in self.sheet_edit_times_of(options)? {
            entries.push(entry(&scene, "backgroundId", Some(tick), Some(Value::Num(id)), false));
            entries.push(entry(&scene, "color", Some(tick), Some(Value::Null), false));
        }
        self.sheet_property_entries(&entries, "Set scene background").map(Value::array)
    }

    /// `setBackgroundColor(color)` on a layer sheet outside a gesture.
    fn set_background_color(&mut self, color: Option<Value>) -> Result<Value, EditError> {
        if self.authored.is_some() {
            return Err(EditError::Unported("setBackgroundColor during a gesture".into()));
        }
        let scene = scene_target();
        let entries = [entry(&scene, "color", Some(self.tick), color, false)];
        self.sheet_property_entries(&entries, "Background color").map(Value::array)
    }

    /// `updateFigureStyle(patch)` with property channels: the figure's outline keyed where it
    /// changes. A name, or editing without property channels, edits the definition.
    fn update_figure_style(&mut self, patch: Option<&Value>) -> Result<Value, EditError> {
        let empty = Value::object(Obj::new());
        let patch = patch.unwrap_or(&empty);
        let fields = patch.as_obj().ok_or_else(|| EditError::Unported("a figure style change that is not an object".into()))?;
        if let Some(key) = fields.keys().find(|key| !["name", "outlineWidth", "outlineColor", "outlineOpacity"].contains(&&***key)) {
            return Err(crate::invalid_with("errors.editorBuilder.figurePropertyIsNotEditable", vec![("key", Value::str(key))]));
        }
        let object = self.object()?;
        let (true, Some((_, object)), false) = (self.options.property_channels, object, fields.contains("name")) else {
            return self.figure_definition_style(fields);
        };
        if !self.sheet() {
            return Err(EditError::Unported("updateFigureStyle on a native timeline".into()));
        }
        let mut target = Obj::new();
        target.set("kind", Value::str("figure"));
        target.set("uid", object.get("unique_id").cloned().unwrap_or(Value::Null));
        let target = Value::object(target);
        let mut entries = Vec::new();
        for (property, value) in fields.iter() {
            let value = if &**property == "outlineColor" { Value::Num(style_color(rgb(value)?)) } else { value.clone() };
            entries.push(entry(&target, property, None, Some(value), false));
        }
        let mut kept = Vec::new();
        for entry in entries {
            let property = entry.get("property").and_then(Value::as_str).unwrap_or("").to_string();
            let shown = self.animation_value(&target, &property, &Value::Num(self.tick))?;
            if !strictly_equal(entry.get("value").unwrap_or(&Value::Null), shown.as_ref()) {
                kept.push(entry);
            }
        }
        self.add_animation_keys(Some(&Value::array(kept)))
    }

    /// `updatePolygon(index, {opacity})` with property channels: the polygon's opacity keyed
    /// on the figure on show (`polygon` is its identity, `figure` its definition's).
    pub(crate) fn key_polygon_style(&mut self, uid: Value, polygon: f64, figure: Value, patch: &Obj) -> Result<Value, EditError> {
        let mut target = Obj::new();
        target.set("kind", Value::str("polygon"));
        target.set("uid", uid);
        target.set("polygonId", Value::Num(polygon));
        target.set("figureTypeId", figure);
        let target = Value::object(target);
        let mut entries = Vec::new();
        for (property, value) in patch.iter() {
            let value = if &**property == "color" { Value::Num(style_color(rgb(value)?)) } else { value.clone() };
            entries.push(entry(&target, property, None, Some(value), false));
        }
        self.add_animation_keys(Some(&Value::array(entries)))
    }

    /// `setVfxParameter(target, id, param, value)`: one parameter of an effect in the target's
    /// stack on show, keyed at the playhead.
    fn set_vfx_parameter(&mut self, target: &Value, id: &Value, param: &Value, value: Option<Value>) -> Result<Value, EditError> {
        let target = self.vfx_target(target)?;
        let effect = self.vfx_effects(&target)?.into_iter().find(|effect| effect.get("id") == Some(id));
        let Some(effect) = effect else { return Err(invalid("errors.editorVfx.theEffectNoLongerExists")) };
        let property = format!("vfx1:{}:{}:{}", effect.get("type").and_then(Value::as_str).unwrap_or(""), id.as_str().unwrap_or(""), param.as_str().unwrap_or("\u{0}"));
        if styk_eval::vfx::parse::property(&property).is_none() {
            return Err(invalid("errors.vfx.invalidEffectParameter"));
        }
        let mut one = Obj::new();
        one.set("target", target);
        one.set("property", Value::str(&property));
        one.set("tick", Value::Num(self.tick));
        if let Some(value) = value {
            one.set("value", value);
        }
        one.set("exactTarget", Value::Bool(true));
        self.add_animation_keys(Some(&Value::array(vec![Value::object(one)]))).map(|keys| keys.item(0).unwrap_or(Value::Null))
    }
}

/// `{kind: 'scene'}`.
fn scene_target() -> Value {
    let mut scene = Obj::new();
    scene.set("kind", Value::str("scene"));
    Value::object(scene)
}
