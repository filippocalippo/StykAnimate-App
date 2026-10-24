//! Property channels on the editor's records: `composePoseChannels` (src/animation-pose.mjs),
//! `composeAnimationChannels` and `animationPropertyValue` (src/animation-channels.mjs) on
//! record frames, byte for byte.
//!
//! They run where the editor runs them: on the native timeline a layer sheet's imported keys
//! sample (`sampleLegacy`, with the sheet's `legacyAnimation`, or a native document's
//! `_styk.animation`), and on the frame a property edit writes as a key, with the one-key
//! channels `_sheetPropertyEntries` builds ([`Records::compose_channels`]).
//!
//! Values come from the sampling drawing uses ([`Channel::sample_at`]): a key's own value is
//! taken as saved, an interpolated one as the typed curve works it out. Where the editor
//! measures geometry (a joined figure's position, a figure that comes loose from its parent)
//! the record is read into a typed frame and measured. Animation pivots, original joint
//! tangents and retained ghost bones use the typed origin evaluator's arithmetic.

use std::collections::{HashMap, HashSet};

use styk_doc::{Obj, Value};

use super::{Error, Records, default_camera, items, num, numbers, paint_record, uid};
use crate::channels::{Channel, KeyValue, Property, Sampled, Target};
use crate::eval::{Prepared, Seq};
use crate::vfx::registry::{ParamKind, ParamValue};
use crate::vfx::Field;

/// A channel as records compose it: its record (keys as saved), its typed view and, for a pose
/// channel, its key track as a timeline (`buildVirtualPoseTrack`).
#[derive(Clone)]
pub struct Bound {
    record: Value,
    channel: Channel,
    track: Option<Seq>,
}

/// A channel composition bound once to the same immutable Records generation.
/// The caller samples frames one at a time; no second evaluator or frame cache.
pub struct RecordChannels<'records, 'doc> {
    records: &'records Records<'doc>,
    channels: Vec<Bound>,
}
impl RecordChannels<'_, '_> {
    pub fn compose(&self, frame: Value, tick: f64) -> Result<Value, Error> {
        self.records.compose(frame, &self.channels, tick)
    }
}

/// `SCENE_FIELDS`: what a scene pose track sets.
const SCENE_FIELDS: [&str; 6] = ["background_id", "background_id_b", "background_mix", "background_color", "_stykBackgroundColor", "_stykVfx"];
/// `NATIVE_PROPERTY_FIELDS` and `NATIVE_OUTLINE_FIELDS`: what `nativeAppearance` keeps.
const NATIVE_FIELDS: [&str; 6] = ["scale", "field28", "color_override_raw", "color_override_rgb", "color_override_mix", "_stykZIndex"];
const OUTLINE_FIELDS: [&str; 3] = ["outlineColor", "outlineWidth", "outlineOpacity"];

/// Channel records read into typed channels, with each pose channel's track.
pub(super) fn bind(prepared: &Prepared, records: &[Value]) -> Result<Vec<Bound>, Error> {
    bind_with(prepared, records, false)
}

pub(super) fn bind_draft(prepared: &Prepared, records: &[Value]) -> Result<Vec<Bound>, Error> {
    bind_with(prepared, records, true)
}

fn bind_with(prepared: &Prepared, records: &[Value], draft: bool) -> Result<Vec<Bound>, Error> {
    let mut notes = Vec::new();
    records
        .iter()
        .map(|record| {
            let read = if draft { crate::channels::draft_channel } else { crate::channels::channel };
            let channel = read(record, &mut notes).map_err(|why| Error::Unported(format!("a property channel the engine does not read ({why})")))?;
            let track = (channel.property == Property::Pose).then(|| crate::channels::pose::track(&prepared.doc, &channel));
            Ok(Bound { record: record.clone(), channel, track })
        })
        .collect()
}

/// [`bind`], reusing the channels `prepared` compiled from the same records.
pub(super) fn bind_compiled(prepared: &Prepared, records: &[Value]) -> Result<Vec<Bound>, Error> {
    match prepared.channels() {
        Some(compiled) if compiled.animation.channels.len() == records.len() => Ok(records
            .iter()
            .zip(compiled.animation.channels.iter().zip(&compiled.tracks))
            .map(|(record, (channel, track))| Bound { record: record.clone(), channel: channel.clone(), track: track.clone() })
            .collect()),
        _ => bind(prepared, records),
    }
}

/// `animationEndTick`: where the last visible key's frame ends (or a movieclip curve's `clipEnd`).
pub(super) fn end_tick(channels: &[Bound]) -> f64 {
    let mut end = 0.0f64;
    for bound in channels {
        let keys = &bound.channel.keys;
        let Some(last) = keys.last() else { continue };
        let visible = keys.iter().rev().take_while(|key| key.tick == last.tick).any(|key| !key.hidden);
        end = end.max(bound.channel.clip_end.unwrap_or(0.0)).max(last.tick + if visible { 1.0 } else { 0.0 });
    }
    end
}

/// Who owns a figure for pose channels (`owner(uid)`): its own channel, else its layer.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Owner {
    Figure(u64),
    Layer(String),
}

/// Where a composed figure came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Source {
    Base,
    Sampled(usize),
}

struct Placed {
    object: Value,
    source: Source,
    /// Its slot in its source frame.
    slot: usize,
}

fn uid_bits(object: &Value) -> u64 {
    uid(object).unwrap_or(f64::NAN).to_bits()
}

/// A JSON value that is neither absent nor `null` (`value ?? fallback`).
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// `Number(value)` of a stored number; `undefined` and `null` read as given.
fn number(value: Option<&Value>, fallback: f64) -> f64 {
    present(value).and_then(Value::as_f64).unwrap_or(fallback)
}

/// `orderedObjects(frame)`: slots in drawing order, then any the order leaves out.
fn ordered_slots(frame: &Value) -> Vec<usize> {
    let count = frame.get("objects").and_then(Value::array_len).unwrap_or(0);
    let mut seen = vec![false; count];
    let mut out = Vec::with_capacity(count);
    for slot in frame.get("object_draw_order").and_then(Value::numbers).unwrap_or_default() {
        if slot >= 0.0 && slot.fract() == 0.0 && (slot as usize) < count && !seen[slot as usize] {
            seen[slot as usize] = true;
            out.push(slot as usize);
        }
    }
    out.extend((0..count).filter(|&slot| !seen[slot]));
    out
}

/// `blankPoseFrame(template)`: nothing posed, the first background, the default camera.
fn blank_pose_frame(template: &Value) -> Value {
    let mut frame = template.as_obj().cloned().unwrap_or_default();
    for key in ["background_color", "_stykBackgroundColor", "_stykVfx"] {
        frame.remove(key);
    }
    frame.set("objects", Value::array(Vec::new()));
    frame.set("object_count", Value::Num(0.0));
    frame.set("object_draw_order", Value::array(Vec::new()));
    frame.set("object_draw_order_unique_ids", Value::array(Vec::new()));
    for key in ["background_id", "background_id_b", "background_mix"] {
        frame.set(key, Value::Num(0.0));
    }
    frame.set("camera", default_camera());
    Value::object(frame)
}

/// `nativeAppearance(object, native)`: a replaced figure keeps the native evaluation's
/// scale, transparency, colour, depth and outline style.
fn native_appearance(object: &Value, native: Option<&Value>) -> Obj {
    let mut out = object.as_obj().cloned().unwrap_or_default();
    let Some(native) = native.filter(|native| native.get("figure_type_id") == object.get("figure_type_id")) else { return out };
    for field in NATIVE_FIELDS {
        match native.get(field) {
            Some(value) => out.set(field, value.clone()),
            None => {
                out.remove(field);
            }
        }
    }
    if object.get("_stykStyle").is_some_and(Value::truthy) || native.get("_stykStyle").is_some_and(Value::truthy) {
        let mut style = object.get("_stykStyle").and_then(Value::as_obj).cloned().unwrap_or_default();
        let from = native.get("_stykStyle");
        for field in OUTLINE_FIELDS {
            match from.and_then(|s| s.get(field)) {
                Some(value) => style.set(field, value.clone()),
                None => {
                    style.remove(field);
                }
            }
        }
        if style.is_empty() {
            out.remove("_stykStyle");
        } else {
            out.set("_stykStyle", Value::object(style));
        }
    }
    out
}

/// `styleColor(rgb)`: an RGB triple as one integer.
fn style_color(rgb: Option<&Value>) -> f64 {
    let part = |i: usize| present(rgb.and_then(|c| c.item(i)).as_ref()).and_then(Value::as_f64).unwrap_or(0.0) as i64 as i32;
    ((part(0) << 16 | part(1) << 8 | part(2)) as u32) as f64
}

/// `opacityOf(alpha)`.
fn opacity_of(alpha: Option<&Value>) -> f64 {
    1.0 - number(alpha, 0.0) / 255.0
}

/// `Math.max` and `Math.min` of two finite numbers, signed zeros as JavaScript orders them.
fn js_max(a: f64, b: f64) -> f64 {
    if a == b { if a.is_sign_negative() { b } else { a } } else if a > b { a } else { b }
}
fn js_min(a: f64, b: f64) -> f64 {
    if a == b { if a.is_sign_negative() { a } else { b } } else if a < b { a } else { b }
}

/// `vfxOwnerKey(target)`: where a target's stack lives in `_stykVfx`.
fn vfx_owner_key(target: &Target) -> String {
    match target {
        Target::Segment { handle, figure_type, .. } => format!("{}/{handle}", figure_type.map_or("*".to_string(), |t| t.to_string())),
        _ => "figure".to_string(),
    }
}

/// `vfxStack(owner, target)` as saved.
fn vfx_stack(owner: &Obj, target: &Target) -> Vec<Value> {
    items(owner.get("_stykVfx").and_then(|s| s.get(&vfx_owner_key(target))))
}

/// `setVfxStack(owner, target, stack)`: an empty stack removes its entry, and no entry left
/// removes the table.
fn set_vfx_stack(owner: &mut Obj, target: &Target, stack: Value) {
    let key = vfx_owner_key(target);
    let mut next = owner.get("_stykVfx").and_then(Value::as_obj).cloned().unwrap_or_default();
    if stack.array_len().unwrap_or(0) > 0 {
        next.set(&key, stack);
    } else {
        next.remove(&key);
    }
    if next.is_empty() {
        owner.remove("_stykVfx");
    } else {
        owner.set("_stykVfx", Value::object(next));
    }
}

/// `resolvedVfx(effect)`: an effect record with every parameter, in the registry's order.
fn resolved_vfx(effect: &Value) -> Result<Obj, Error> {
    let typed = crate::vfx::parse::effect(effect).map_err(|why| Error::Unported(format!("an effect record the engine does not read ({why})")))?;
    let kind = typed.kind();
    let mut params = Obj::new();
    for (index, spec) in kind.specs().iter().enumerate() {
        params.set(spec.name, match typed.params.get(index) {
            ParamValue::Num(value) => Value::Num(value),
            ParamValue::Paint(paint) => paint_record(&paint),
        });
    }
    let mut record = Obj::new();
    record.set("version", Value::Num(2.0));
    record.set("id", Value::str(&typed.id));
    record.set("type", Value::str(kind.name()));
    record.set("enabled", Value::Bool(typed.enabled));
    record.set("params", Value::object(params));
    Ok(record)
}

/// `validateVfxStack(stack)` of a stack already checked: every effect resolved.
pub fn resolved_stack(stack: &Value) -> Result<Value, Error> {
    Ok(Value::array(items(Some(stack)).iter().map(|effect| resolved_vfx(effect).map(Value::object)).collect::<Result<_, _>>()?))
}

/// `applyVfxParameter(owner, target, property, value)`.
fn apply_vfx(owner: &mut Obj, target: &Target, property: &Property, value: &Value) -> Result<(), Error> {
    match property {
        Property::VfxScope => {
            if value.truthy() {
                owner.set("_stykVfxScope", Value::Num(1.0));
            } else {
                owner.remove("_stykVfxScope");
            }
        }
        Property::VfxStack => set_vfx_stack(owner, target, value.clone()),
        Property::Vfx { kind, id, field } => {
            let mut stack = vfx_stack(owner, target);
            let Some(index) = stack.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(id) && e.get("type").and_then(Value::as_str) == Some(kind.name())) else { return Ok(()) };
            let mut effect = resolved_vfx(&stack[index])?;
            match field {
                Field::Enabled => effect.set("enabled", Value::Bool(value.truthy())),
                Field::Param(i) => {
                    let spec = kind.specs()[*i];
                    let resolved = if spec.kind == ParamKind::Color {
                        // `validateVfxValue`: a paint is normalized, a number kept.
                        match value {
                            Value::Num(_) => value.clone(),
                            other => match crate::vfx::parse::value(&spec, other) {
                                Some(ParamValue::Paint(paint)) => paint_record(&paint),
                                _ => return Err(Error::Invalid("errors.vfx.unknownVfxParameter".into())),
                            },
                        }
                    } else {
                        Value::Num(js_max(spec.min, js_min(spec.max, value.as_f64().unwrap_or(f64::NAN))))
                    };
                    let mut params = effect.get("params").and_then(Value::as_obj).cloned().unwrap_or_default();
                    params.set(spec.name, resolved);
                    effect.set("params", Value::object(params));
                }
            }
            stack[index] = Value::object(effect);
            set_vfx_stack(owner, target, Value::array(stack));
        }
        _ => {}
    }
    Ok(())
}

/// `isAnimationStyleProperty(target, property)`.
fn style_property(target: &Target, property: &Property) -> bool {
    match target {
        Target::Polygon { .. } | Target::Segment { .. } => true,
        Target::Figure { .. } => matches!(property, Property::OutlineOpacity | Property::OutlineColor | Property::OutlineWidth),
        _ => false,
    }
}

/// `setAnimationStyle(object, target, property, value)`.
fn set_style(object: &mut Obj, target: &Target, name: &str, value: &Value) {
    let type_id = object.get("figure_type_id").and_then(Value::as_f64);
    if let Target::Segment { figure_type: Some(scope), .. } = target
        && type_id != Some(*scope as f64)
    {
        return;
    }
    let mut style = object.get("_stykStyle").and_then(Value::as_obj).cloned().unwrap_or_default();
    match target {
        Target::Figure { .. } => style.set(name, value.clone()),
        Target::Polygon { polygon, figure_type, .. } => {
            if type_id != Some(*figure_type as f64) {
                object.set("_stykStyle", Value::object(style));
                return;
            }
            let mut polygons = style.get("polygons").and_then(Value::as_obj).cloned().unwrap_or_default();
            let key = polygon.to_string();
            let mut entry = polygons.get(&key).and_then(Value::as_obj).cloned().unwrap_or_default();
            entry.set(name, value.clone());
            polygons.set(&key, Value::object(entry));
            style.set("polygons", Value::object(polygons));
        }
        Target::Segment { handle, .. } => {
            let mut segments = style.get("segments").and_then(Value::as_obj).cloned().unwrap_or_default();
            let key = handle.to_string();
            let mut entry = segments.get(&key).and_then(Value::as_obj).cloned().unwrap_or_default();
            entry.set(name, value.clone());
            segments.set(&key, Value::object(entry));
            style.set("segments", Value::object(segments));
        }
        _ => {}
    }
    object.set("_stykStyle", Value::object(style));
}

/// What `animationStyleValue` reads for a segment's fill style without an override: the
/// segment's own paint (`segmentPaint`), not read here.
enum Style {
    Value(Value),
    NativePaint,
}

/// `animationStyleValue(figure, object, target, property)`: `None` where it is undefined.
fn style_value(figure: Option<&Value>, object: &Value, target: &Target, property: &Property) -> Option<Style> {
    let figure = figure?;
    let type_id = object.get("figure_type_id").and_then(Value::as_f64);
    let style = object.get("_stykStyle");
    let found = |value: Option<&Value>| present(value).cloned();
    let value = match target {
        Target::Polygon { polygon, figure_type, .. } => {
            if type_id != Some(*figure_type as f64) {
                return None;
            }
            let polyfills = items(figure.get("polyfills"));
            let item = polyfills.iter().enumerate().find(|(index, item)| number(item.get("polyfill_id"), *index as f64 + 1.0) == *polygon as f64).map(|(_, item)| item)?;
            let own = style.and_then(|s| s.path(&["polygons", &polygon.to_string()]));
            match property {
                Property::ZIndex => found(own.and_then(|o| o.get("zIndex"))).unwrap_or_else(|| Value::Num(number(item.get("z_order"), 0.0))),
                Property::Color => found(own.and_then(|o| o.get("color"))).unwrap_or_else(|| Value::Num(style_color(item.get("color_rgb")))),
                _ => found(own.and_then(|o| o.get("opacity"))).unwrap_or_else(|| match item.get("alpha_raw") {
                    None => Value::Num(number(item.get("color_alpha"), 1.0)),
                    Some(alpha) => Value::Num(opacity_of(Some(alpha))),
                }),
            }
        }
        Target::Figure { .. } => {
            let global = figure.path(&["segment_decode", "global_style"]);
            let name = match property {
                Property::OutlineColor => "outlineColor",
                Property::OutlineWidth => "outlineWidth",
                _ => "outlineOpacity",
            };
            found(style.and_then(|s| s.get(name))).unwrap_or_else(|| match property {
                Property::OutlineColor => Value::Num(style_color(global.and_then(|g| g.get("rgb")))),
                Property::OutlineWidth => Value::Num(number(global.and_then(|g| g.get("outline_thickness")), 0.0)),
                _ => Value::Num(opacity_of(global.and_then(|g| g.get("u30")))),
            })
        }
        Target::Segment { handle, figure_type, .. } => {
            if figure_type.is_some_and(|scope| type_id != Some(scope as f64)) {
                return None;
            }
            let segments = items(figure.get("segments"));
            let (index, segment) = segments.iter().enumerate().find(|(_, s)| s.get("segment_id").and_then(Value::as_f64) == Some(*handle as f64))?;
            let own = style.and_then(|s| s.path(&["segments", &handle.to_string()]));
            let field = |name: &str| found(own.and_then(|o| o.get(name)));
            let paint = own.and_then(|o| present(o.get("paint")));
            match property {
                Property::ZIndex => field("zIndex").unwrap_or_else(|| Value::Num(number(segment.get("z_order"), index as f64 + 1.0))),
                Property::Paint => return Some(field("paint").map_or(Style::NativePaint, Style::Value)),
                Property::Opacity => field("opacity")
                    .or_else(|| found(paint.and_then(|p| p.get("stops")).and_then(|s| s.item(0)).as_ref().and_then(|stop| stop.get("opacity"))))
                    .unwrap_or_else(|| match segment.get("transparency") {
                        None => Value::Num(number(segment.get("color_alpha"), 1.0)),
                        Some(alpha) => Value::Num(opacity_of(Some(alpha))),
                    }),
                Property::Color => field("color").unwrap_or_else(|| match paint {
                    Some(paint) => Value::Num(style_color(paint.get("stops").and_then(|s| s.item(0)).as_ref().and_then(|stop| stop.get("color")))),
                    None => Value::Num(style_color(segment.get("color_rgb"))),
                }),
                Property::Thickness => field("thickness").unwrap_or_else(|| Value::Num(number(segment.get("thickness"), 0.0))),
                _ => {
                    // A second colour exists on a native gradient, or on a gradient fill style.
                    let endpoint = paint.filter(|p| p.get("type").and_then(Value::as_str) != Some("solid")).and_then(|p| {
                        let stops = items(p.get("stops"));
                        stops.last().cloned()
                    });
                    let secondary = present(segment.get("secondary"));
                    if secondary.is_none() && endpoint.is_none() {
                        return None;
                    }
                    if *property == Property::GradientColor {
                        field("gradientColor").unwrap_or_else(|| match &endpoint {
                            Some(stop) => Value::Num(style_color(stop.get("color"))),
                            None => Value::Num(style_color(secondary.and_then(|s| s.get("rgb")))),
                        })
                    } else {
                        field("gradientOpacity").unwrap_or_else(|| match endpoint.as_ref().and_then(|stop| present(stop.get("opacity"))) {
                            Some(opacity) => opacity.clone(),
                            None => Value::Num(opacity_of(secondary.and_then(|s| s.get("a")))),
                        })
                    }
                }
            }
        }
        _ => return None,
    };
    Some(Style::Value(value))
}

impl Records<'_> {
    /// `report.figure_types` by `figure_type_id` (a `Map`: the last of equal identities).
    fn definitions(&self) -> HashMap<u64, Value> {
        items(self.tree.get("figure_types")).into_iter().filter_map(|figure| Some((num(&figure, "figure_type_id")?.to_bits(), figure))).collect()
    }

    /// `report.figure_types.find(...)`: the first definition with this identity.
    fn definition(&self, type_id: Option<f64>) -> Option<Value> {
        let type_id = type_id?;
        items(self.tree.get("figure_types")).into_iter().find(|figure| num(figure, "figure_type_id") == Some(type_id))
    }

    /// `buildGeometry(report, frame)` of a frame record, read into a typed frame.
    fn geometry_of(&self, frame: &Value) -> Result<crate::geometry::Scene, Error> {
        let doc = &self.prepared.doc;
        let typed = crate::load::Loader::new().edit_frame(frame, None, doc).map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(crate::geometry::build(doc, &typed))
    }

    /// `handleOrientation(object, handle)`: the direction of joint `handle` of `object`.
    fn handle_orientation(&self, object: Option<&Value>, handle: Option<f64>, definitions: &HashMap<u64, Value>) -> Option<f64> {
        let object = object?;
        let figure = definitions.get(&num(object, "figure_type_id")?.to_bits())?;
        let handle = handle?;
        if figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
            let typed = self.typed_object(object)?;
            let figure = self.prepared.doc.figure(typed.figure)?;
            return crate::origin::handle_orientation(figure, &typed, handle as u32);
        }
        let segments = items(figure.get("segments"));
        // A `Map` of the segments' identities: the last of equal ones.
        let index = if handle == 0.0 { 0 } else { segments.iter().rposition(|s| s.get("segment_id").and_then(Value::as_f64) == Some(handle))? };
        let segment = segments.get(index);
        let angle = present(object.get("angles").and_then(|a| a.item(index)).as_ref())
            .and_then(Value::as_f64)
            .or_else(|| segment.and_then(|s| present(s.get("angle_rad"))).and_then(Value::as_f64))
            .unwrap_or(0.0);
        if handle == 0.0 {
            return Some(angle);
        }
        let bend = if object.get("bend_flag").is_some_and(Value::truthy) {
            number(object.get("bends").and_then(|b| b.item(index)).as_ref(), 0.0)
        } else {
            number(segment.and_then(|s| s.get("bend_rad")), 0.0)
        };
        Some(angle + bend)
    }

    /// `composePoseChannels(report, frame, tick)` then `composeAnimationChannels(report, frame, tick)`.
    pub(super) fn compose(&self, frame: Value, channels: &[Bound], tick: f64) -> Result<Value, Error> {
        if channels.is_empty() {
            return Ok(frame);
        }
        let frame = if channels.iter().any(|b| b.channel.property == Property::Pose) { self.compose_poses(frame, channels, tick)? } else { frame };
        self.compose_scalars(frame, channels, tick)
    }

    /// The frame a property edit on a layer sheet writes (`_sheetPropertyEntries`): `frame`
    /// (`at(report, tick)`) with the one-key channels it builds composed at `tick`, pose
    /// channels first.
    pub fn compose_channels(&self, frame: Value, channels: &[Value], tick: f64) -> Result<Value, Error> {
        self.bind_channels(channels)?.compose(frame, tick)
    }

    /// Reuse the owning channel binding across a worker's sequence of samples.
    pub fn bind_channels(&self, channels: &[Value]) -> Result<RecordChannels<'_, '_>, Error> {
        Ok(RecordChannels { records: self, channels: bind(self.prepared, channels)? })
    }

    /// `composePoseChannels`: figures and layers take the pose their own key track samples,
    /// the camera and the scene theirs.
    fn compose_poses(&self, base: Value, channels: &[Bound], tick: f64) -> Result<Value, Error> {
        let poses: Vec<&Bound> = channels.iter().filter(|b| b.channel.property == Property::Pose).collect();
        if poses.is_empty() {
            return Ok(base);
        }
        let mut result = base.as_obj().cloned().unwrap_or_default();
        let mut sampled: Vec<Value> = Vec::new();
        let mut replacements: Vec<(Owner, Source)> = Vec::new();
        let set = |replacements: &mut Vec<(Owner, Source)>, owner: Owner, source: Source| match replacements.iter_mut().find(|(o, _)| *o == owner) {
            Some(entry) => entry.1 = source,
            None => replacements.push((owner, source)),
        };
        let figure_owned: HashSet<u64> = poses.iter().filter_map(|b| match b.channel.target { Target::Figure { uid } => Some((uid as f64).to_bits()), _ => None }).collect();
        let native_owners: HashSet<Owner> = poses
            .iter()
            .filter(|b| b.channel.native_properties)
            .filter_map(|b| match &b.channel.target {
                Target::Figure { uid } => Some(Owner::Figure((*uid as f64).to_bits())),
                Target::Layer { id } => Some(Owner::Layer(id.to_string())),
                _ => None,
            })
            .collect();
        for bound in &poses {
            let channel = &bound.channel;
            let fixed = matches!(channel.target, Target::Camera | Target::Scene);
            let source = if crate::channels::pose::masked_at(&channel.masked, tick) {
                None
            } else if channel.use_base_pose {
                Some(Source::Base)
            } else {
                // A figure's track tweens that figure alone (`sampleUids`).
                let only: Option<Vec<u32>> = match channel.target {
                    Target::Figure { uid } => Some(vec![uid]),
                    _ => None,
                };
                let seq = bound.track.as_ref().ok_or_else(|| Error::Invalid("a pose channel without a track".into()))?;
                let keys = items(bound.record.get("keys"));
                self.sample_keys(seq, &keys, fixed, tick, only.as_deref())?.map(|frame| {
                    sampled.push(frame);
                    Source::Sampled(sampled.len() - 1)
                })
            };
            let source = source.unwrap_or_else(|| {
                sampled.push(blank_pose_frame(&base));
                Source::Sampled(sampled.len() - 1)
            });
            let frame = match source {
                Source::Base => &base,
                Source::Sampled(i) => &sampled[i],
            };
            match &channel.target {
                Target::Layer { id } => set(&mut replacements, Owner::Layer(id.to_string()), source),
                Target::Figure { uid } => set(&mut replacements, Owner::Figure((*uid as f64).to_bits()), source),
                Target::Camera => result.set("camera", frame.get("camera").filter(|c| c.truthy()).cloned().unwrap_or_else(default_camera)),
                Target::Scene => {
                    for field in SCENE_FIELDS {
                        match frame.get(field) {
                            Some(value) => result.set(field, value.clone()),
                            None => {
                                result.remove(field);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if replacements.is_empty() {
            return Ok(Value::object(result));
        }
        let frame_of = |source: Source| -> &Value {
            match source {
                Source::Base => &base,
                Source::Sampled(i) => &sampled[i],
            }
        };
        let owner = |uid: f64| -> Owner { if figure_owned.contains(&uid.to_bits()) { Owner::Figure(uid.to_bits()) } else { Owner::Layer(self.layer_of(uid)) } };
        let replacement_of = |id: &Owner| replacements.iter().position(|(owner, _)| owner == id);
        // The figures each replacement brings, in its frame's drawing order, with their slots there.
        let mut brought: Vec<Vec<(usize, Value)>> = vec![Vec::new(); replacements.len()];
        let mut visited: Vec<Source> = Vec::new();
        for &(_, source) in &replacements {
            if visited.contains(&source) {
                continue;
            }
            visited.push(source);
            let frame = frame_of(source);
            let objects = items(frame.get("objects"));
            for slot in ordered_slots(frame) {
                let object = &objects[slot];
                let Some(r) = replacement_of(&owner(uid(object).unwrap_or(f64::NAN))) else { continue };
                if replacements[r].1 == source {
                    brought[r].push((slot, object.clone()));
                }
            }
        }
        let base_objects = items(base.get("objects"));
        let mut placed: Vec<Placed> = Vec::new();
        let mut included: HashSet<u64> = HashSet::new();
        // Unchanged figures keep their native slots; new appearances follow in source order.
        for (slot, object) in base_objects.iter().enumerate() {
            if replacement_of(&owner(uid(object).unwrap_or(f64::NAN))).is_none() {
                placed.push(Placed { object: object.clone(), source: Source::Base, slot });
                included.insert(uid_bits(object));
            }
        }
        for (r, (id, source)) in replacements.iter().enumerate() {
            for (slot, object) in &brought[r] {
                if owner(uid(object).unwrap_or(f64::NAN)) != *id || included.contains(&uid_bits(object)) {
                    continue;
                }
                placed.push(Placed { object: object.clone(), source: *source, slot: *slot });
                included.insert(uid_bits(object));
            }
        }
        let slots: HashMap<u64, usize> = placed.iter().enumerate().map(|(slot, p)| (uid_bits(&p.object), slot)).collect();
        let natives: HashMap<u64, Value> = if native_owners.is_empty() { HashMap::new() } else { base_objects.iter().map(|o| (uid_bits(o), o.clone())).collect() };
        let definitions = self.definitions();
        let mut geometry: HashMap<Source, crate::geometry::Scene> = HashMap::new();
        let mut objects: Vec<Obj> = Vec::with_capacity(placed.len());
        for (slot, record) in placed.iter().enumerate() {
            let id = owner(uid(&record.object).unwrap_or(f64::NAN));
            let mut object = if native_owners.contains(&id) { native_appearance(&record.object, natives.get(&uid_bits(&record.object))) } else { record.object.as_obj().cloned().unwrap_or_default() };
            let Some(join) = object.get("join").filter(|j| j.truthy()).cloned() else {
                object.set("object_slot", Value::Num(slot as f64));
                objects.push(object);
                continue;
            };
            let source_objects = items(frame_of(record.source).get("objects"));
            let parent = num(&join, "target_object_slot").filter(|s| *s >= 0.0 && s.fract() == 0.0).and_then(|s| source_objects.get(s as usize));
            let parent_slot = parent.and_then(|p| slots.get(&uid_bits(p))).copied();
            let target = parent_slot.map(|p| &placed[p].object);
            let oriented = self.handle_orientation(target, num(&join, "target_handle_id"), &definitions);
            let Some(parent_slot) = parent_slot.filter(|_| oriented.is_some()) else {
                // Its parent left, or no longer has the joint: it stays where its own frame drew it.
                let scene = match geometry.entry(record.source) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => entry.insert(self.geometry_of(frame_of(record.source))?),
                };
                let root = scene.objects.get(record.slot).filter(|g| g.resolved).map(|g| g.root);
                object.set("object_slot", Value::Num(slot as f64));
                for (axis, key) in ["root_x", "root_y"].into_iter().enumerate() {
                    match root.map(|r| Value::Num(r[axis])).or_else(|| record.object.get(key).cloned()) {
                        Some(value) => object.set(key, value),
                        None => {
                            object.remove(key);
                        }
                    }
                }
                object.set("join", Value::Null);
                object.remove("runtime_segments");
                objects.push(object);
                continue;
            };
            let mut join = join.as_obj().cloned().unwrap_or_default();
            join.set("target_object_slot", Value::Num(parent_slot as f64));
            object.set("object_slot", Value::Num(slot as f64));
            object.set("join", Value::object(join));
            objects.push(object);
        }
        // Parents before children: a joined figure turns by the change of its parent's joint.
        let count = objects.len();
        let parent_of = |object: &Obj| object.get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot")).map(|s| s as usize);
        let mut done = vec![false; count];
        for start in 0..count {
            if done[start] {
                continue;
            }
            let (mut path, mut visiting) = (Vec::new(), HashSet::new());
            let mut slot = start;
            while !done[slot] {
                if !visiting.insert(slot) {
                    return Err(Error::Invalid("errors.animationPose.theseLayerPosesCreateACyclicFigureAttachment".into()));
                }
                path.push(slot);
                match parent_of(&objects[slot]) {
                    Some(parent) if parent < count => slot = parent,
                    _ => break,
                }
            }
            for &child in path.iter().rev() {
                if let Some(join) = objects[child].get("join").filter(|j| j.truthy()).cloned() {
                    let record = &placed[child];
                    let source_objects = items(frame_of(record.source).get("objects"));
                    let source_parent = record.object.get("join").and_then(|j| num(j, "target_object_slot")).filter(|s| *s >= 0.0 && s.fract() == 0.0).and_then(|s| source_objects.get(s as usize));
                    let handle = num(&join, "target_handle_id");
                    let parent = parent_of(&objects[child]).and_then(|p| objects.get(p)).map(|o| Value::object(o.clone()));
                    let before = self.handle_orientation(source_parent, handle, &definitions);
                    let after = self.handle_orientation(parent.as_ref(), handle, &definitions);
                    let delta = match (before, after) {
                        (Some(before), Some(after)) => after - before,
                        _ => 0.0,
                    };
                    if delta.abs() > 1e-12 {
                        let angles: Vec<f64> = items(objects[child].get("angles")).iter().map(|a| a.as_f64().unwrap_or(0.0) + delta).collect();
                        objects[child].set("angles", numbers(angles));
                        let definition = num(&Value::object(objects[child].clone()), "figure_type_id").and_then(|id| definitions.get(&id.to_bits()));
                        rotate_origin_support(definition, &mut objects[child], delta);
                        objects[child].remove("runtime_segments");
                    }
                }
                done[child] = true;
            }
        }
        // Each layer keeps its sampled pose's stacking order; anchored figures follow their anchor.
        let mut anchors: Vec<(f64, Vec<f64>)> = Vec::new();
        for bound in &poses {
            if let (Some(anchor), Target::Figure { uid }) = (bound.channel.order_anchor, &bound.channel.target) {
                match anchors.iter_mut().find(|(a, _)| *a == anchor as f64) {
                    Some((_, list)) => list.push(*uid as f64),
                    None => anchors.push((anchor as f64, vec![*uid as f64])),
                }
            }
        }
        let mut stack = Stacking { slots: &slots, anchors, anchored: HashSet::new(), order: Vec::with_capacity(count), placed: vec![false; count] };
        let mut emitted = vec![false; replacements.len()];
        let emit = |stack: &mut Stacking, emitted: &mut [bool], r: usize| {
            if std::mem::replace(&mut emitted[r], true) {
                return;
            }
            for (_, object) in &brought[r] {
                let id = uid(object).unwrap_or(f64::NAN);
                if owner(id) == replacements[r].0 {
                    stack.append(id);
                }
            }
        };
        for slot in ordered_slots(&base) {
            let id = uid(&base_objects[slot]).unwrap_or(f64::NAN);
            match replacement_of(&owner(id)) {
                Some(r) => emit(&mut stack, &mut emitted, r),
                None => stack.append(id),
            }
            stack.append_anchors(id);
        }
        for r in 0..replacements.len() {
            emit(&mut stack, &mut emitted, r);
        }
        let mut order = std::mem::take(&mut stack.order);
        order.extend((0..count).filter(|&slot| !stack.placed[slot]));
        let ids: Vec<Value> = order.iter().map(|&slot| objects[slot].get("unique_id").cloned().unwrap_or(Value::Null)).collect();
        result.set("objects", Value::array(objects.into_iter().map(Value::object).collect()));
        result.set("object_count", Value::Num(count as f64));
        result.set("object_draw_order", numbers(order.iter().map(|&slot| slot as f64)));
        result.set("object_draw_order_unique_ids", Value::array(ids));
        Ok(Value::object(result))
    }

    /// A sampled value as the record takes it: a key's own value as saved, an interpolated one
    /// as computed. `None` where the key has no value (the channel then does not apply).
    fn sampled_value(bound: &Bound, sampled: Sampled) -> Result<Option<Value>, Error> {
        Ok(match sampled {
            Sampled::Key(index) => bound.record.get("keys").and_then(|keys| keys.item(index)).and_then(|key| key.get("value").cloned()),
            Sampled::Value(KeyValue::Num(value)) | Sampled::Value(KeyValue::Param(ParamValue::Num(value))) => Some(Value::Num(value)),
            Sampled::Value(KeyValue::Param(ParamValue::Paint(paint))) => Some(paint_record(&paint)),
            Sampled::Value(other) => return Err(Error::Unported(format!("an interpolated channel value {other:?}"))),
        })
    }

    /// `composeAnimationChannels`: every other channel that controls its property at the tick
    /// sets it on the frame.
    fn compose_scalars(&self, frame: Value, channels: &[Bound], tick: f64) -> Result<Value, Error> {
        let mut active: Vec<(&Bound, Value)> = Vec::new();
        for bound in channels.iter().filter(|b| b.channel.property != Property::Pose) {
            let Some(sampled) = bound.channel.sample_at(tick) else { continue };
            if let Some(value) = Records::sampled_value(bound, sampled)? {
                active.push((bound, value));
            }
        }
        if active.is_empty() {
            return Ok(frame);
        }
        // Whole stacks first, then fill styles: what a parameter or a colour then changes.
        active.sort_by_key(|(b, _)| std::cmp::Reverse(2 * (b.channel.property == Property::VfxStack) as u8 + (b.channel.property == Property::Paint) as u8));
        let source = items(frame.get("objects"));
        let mut out = frame.as_obj().cloned().unwrap_or_default();
        let mut objects: Vec<Obj> = source.iter().map(|o| o.as_obj().cloned().unwrap_or_default()).collect();
        let mut edited = false;
        // `slots`: by unique id over the frame as given (a `Map`: the last of equal ones).
        let slots: HashMap<u64, usize> = source.iter().enumerate().map(|(slot, o)| (uid_bits(o), slot)).collect();
        let definitions = self.definitions();
        let mut figure_values: Vec<(usize, Vec<(&'static str, f64)>)> = Vec::new();
        let (mut background, mut color): (Option<Value>, Option<Value>) = (None, None);
        let mut camera_copied = false;
        let mut scoped: HashSet<String> = HashSet::new();
        for (bound, value) in &active {
            let (target, property) = (&bound.channel.target, &bound.channel.property);
            let name = bound.record.get("property").and_then(Value::as_str).unwrap_or("");
            if property.is_vfx() {
                if *target == Target::Scene {
                    apply_vfx(&mut out, target, property, value)?;
                    continue;
                }
                let Some(&slot) = target.uid().and_then(|uid| slots.get(&(uid as f64).to_bits())) else { continue };
                // `animationPropertyValue(report, out, target, 'vfxStack')`: the owner, and a node it has.
                let owner = objects.iter().position(|o| o.get("unique_id").and_then(Value::as_f64) == target.uid().map(f64::from));
                let Some(owner) = owner else { continue };
                if let Target::Segment { handle, figure_type, .. } = target {
                    let type_id = objects[owner].get("figure_type_id").and_then(Value::as_f64);
                    let known = self.definition(type_id).is_some_and(|f| items(f.get("segments")).iter().any(|s| s.get("segment_id").and_then(Value::as_f64) == Some(*handle as f64)));
                    if figure_type.is_some_and(|t| Some(t as f64) != type_id) || !known {
                        continue;
                    }
                }
                edited = true;
                apply_vfx(&mut objects[slot], target, property, value)?;
                continue;
            }
            match target {
                Target::Camera => {
                    if !camera_copied {
                        // `{x: 0, y: 0, scale: 1, angle_rad: 0, ...frame.camera, is_default: false}`.
                        let mut camera = Obj::new();
                        for (key, fallback) in [("x", 0.0), ("y", 0.0), ("scale", 1.0), ("angle_rad", 0.0)] {
                            camera.set(key, Value::Num(fallback));
                        }
                        if let Some(own) = frame.get("camera").and_then(Value::as_obj) {
                            for (key, value) in own.iter() {
                                camera.set(key, value.clone());
                            }
                        }
                        camera.set("is_default", Value::Bool(false));
                        out.set("camera", Value::object(camera));
                        camera_copied = true;
                    }
                    let field = if *property == Property::Rotation { "angle_rad" } else { name };
                    if let Some(camera) = out.get_mut("camera").and_then(Value::make_obj) {
                        camera.set(field, value.clone());
                    }
                }
                Target::Scene => match property {
                    Property::BackgroundId => background = Some(value.clone()),
                    Property::Color => color = Some(value.clone()),
                    _ => {}
                },
                Target::Figure { uid } | Target::Segment { uid, .. } | Target::Polygon { uid, .. } => {
                    let Some(&slot) = slots.get(&(*uid as f64).to_bits()) else { continue };
                    let figure_kind = matches!(target, Target::Figure { .. });
                    if figure_kind && *property == Property::Color {
                        edited = true;
                        objects[slot].set("color_override_raw", value.clone());
                        continue;
                    }
                    if figure_kind && *property == Property::ZIndex {
                        edited = true;
                        objects[slot].set("_stykZIndex", value.clone());
                        continue;
                    }
                    if style_property(target, property) {
                        let type_id = source[slot].get("figure_type_id").and_then(Value::as_f64);
                        let figure = type_id.and_then(|t| definitions.get(&t.to_bits()));
                        // Missing or replaced nodes stay dormant instead of styling another one.
                        if style_value(figure, &Value::object(objects[slot].clone()), target, property).is_some() {
                            // A definition scope wins over the unscoped curve, whatever their saved order.
                            let is_scoped = match target {
                                Target::Segment { figure_type, .. } => figure_type.is_some(),
                                Target::Polygon { .. } => true,
                                _ => false,
                            };
                            let part = match target {
                                Target::Segment { handle, .. } => handle.to_string(),
                                Target::Polygon { polygon, .. } => polygon.to_string(),
                                _ => "undefined".to_string(),
                            };
                            let kind = match target {
                                Target::Segment { .. } => "segment",
                                Target::Polygon { .. } => "polygon",
                                _ => "figure",
                            };
                            let identity = format!("{kind}:{uid}/{part}:{name}");
                            if !is_scoped && scoped.contains(&identity) {
                                continue;
                            }
                            edited = true;
                            set_style(&mut objects[slot], target, name, value);
                            if is_scoped {
                                scoped.insert(identity);
                            }
                        }
                        continue;
                    }
                    let key = match property {
                        Property::X => "x",
                        Property::Y => "y",
                        Property::Scale => "scale",
                        Property::Opacity => "opacity",
                        Property::Rotation => "rotation",
                        _ => continue,
                    };
                    let number = value.as_f64().unwrap_or(f64::NAN);
                    match figure_values.iter_mut().find(|(s, _)| *s == slot) {
                        Some((_, values)) => match values.iter_mut().find(|(k, _)| *k == key) {
                            Some(entry) => entry.1 = number,
                            None => values.push((key, number)),
                        },
                        None => figure_values.push((slot, vec![(key, number)])),
                    }
                }
                Target::Layer { .. } => {}
            }
        }
        // Colour and image selection are independent properties, whatever their edit order.
        if let Some(id) = background {
            out.set("background_id", id);
            out.set("background_id_b", Value::Num(0.0));
            out.set("background_mix", Value::Num(0.0));
            out.remove("_stykBackgroundColor");
        }
        match color {
            Some(Value::Null) => {
                out.remove("_stykBackgroundColor");
            }
            Some(value) => out.set("_stykBackgroundColor", value),
            None => {}
        }
        if !figure_values.is_empty() {
            self.transform(&source, &mut objects, &figure_values, &definitions, &out)?;
            edited = true;
        }
        if edited {
            out.set("objects", Value::array(objects.into_iter().map(Value::object).collect()));
        }
        Ok(Value::object(out))
    }

    /// The transform part of `composeAnimationChannels`: scale, opacity and rotation from the
    /// roots down (a rotation turns the figures joined below it too), then positions, where a
    /// joined figure's position moves its root figure.
    fn transform(&self, source: &[Value], objects: &mut [Obj], values: &[(usize, Vec<(&'static str, f64)>)], definitions: &HashMap<u64, Value>, frame: &Obj) -> Result<(), Error> {
        let count = source.len();
        let value_of = |slot: usize, key: &str| values.iter().find(|(s, _)| *s == slot).and_then(|(_, v)| v.iter().find(|(k, _)| *k == key)).map(|(_, v)| *v);
        let mut parents: Vec<Option<usize>> = vec![None; count];
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); count];
        let mut roots: Vec<usize> = (0..count).collect();
        let mut ordered: Vec<usize> = Vec::with_capacity(count);
        for (slot, object) in source.iter().enumerate() {
            let parent = object.get("join").filter(|j| !j.is_null()).and_then(|j| j.get("target_object_slot"));
            match parent {
                None => ordered.push(slot),
                Some(parent) => {
                    let parent = parent.as_f64().filter(|p| p.fract() == 0.0 && *p >= 0.0 && (*p as usize) < count);
                    let Some(parent) = parent else { return Err(Error::Invalid("errors.animationChannels.anAnimatedFigureHasAnInvalidAttachment".into())) };
                    parents[slot] = Some(parent as usize);
                    children[parent as usize].push(slot);
                }
            }
        }
        let mut i = 0;
        while i < ordered.len() {
            let slot = ordered[i];
            for &child in &children[slot] {
                roots[child] = roots[slot];
                ordered.push(child);
            }
            i += 1;
        }
        if ordered.len() != count {
            return Err(Error::Invalid("errors.animationChannels.animationChannelsCannotComposeCyclicFigureAttachments".into()));
        }
        let mut deltas = vec![0.0f64; count];
        for &slot in &ordered {
            let object = &source[slot];
            if let Some(scale) = value_of(slot, "scale") {
                objects[slot].set("scale", Value::Num(scale));
            }
            if let Some(opacity) = value_of(slot, "opacity") {
                objects[slot].set("field28", Value::Num(crate::vfx::paint::js_round(255.0 * (1.0 - opacity))));
            }
            let mut delta = parents[slot].map_or(0.0, |parent| deltas[parent]);
            let definition = num(object, "figure_type_id").and_then(|id| definitions.get(&id.to_bits()));
            if let Some(rotation) = value_of(slot, "rotation") {
                delta = rotation - self.animation_rotation(definition, object);
            }
            deltas[slot] = delta;
            if delta != 0.0 {
                let angles: Vec<f64> = items(object.get("angles")).iter().map(|a| a.as_f64().unwrap_or(0.0) + delta).collect();
                objects[slot].set("angles", numbers(angles));
                rotate_origin_support(definition, &mut objects[slot], delta);
                objects[slot].remove("runtime_segments");
            }
        }
        if self.prepared.doc.origins {
            let mut composed = frame.clone();
            composed.set("objects", Value::array(objects.iter().cloned().map(Value::object).collect()));
            let corrected = self.correct_origins(Value::object(composed))?;
            for (object, record) in objects.iter_mut().zip(items(corrected.get("objects"))) {
                *object = record.as_obj().cloned().unwrap_or_default();
            }
        }
        let needs_world = values.iter().any(|(slot, v)| parents[*slot].is_some() && v.iter().any(|(k, _)| *k == "x" || *k == "y"));
        let world = if needs_world {
            let mut composed = frame.clone();
            composed.set("objects", Value::array(objects.iter().cloned().map(Value::object).collect()));
            Some(self.geometry_of(&Value::object(composed))?)
        } else {
            None
        };
        let mut shifts = [vec![0.0f64; count], vec![0.0f64; count]];
        for &slot in &ordered {
            let (x, y) = (value_of(slot, "x"), value_of(slot, "y"));
            if x.is_none() && y.is_none() {
                continue;
            }
            let root = roots[slot];
            let object = Value::object(objects[slot].clone());
            let mut base = world.as_ref().and_then(|w| w.objects.get(slot)).filter(|g| g.resolved).map(|g| g.root);
            if let Some(origin) = object.get("_stykAnimationOrigin").filter(|origin| origin.truthy()) {
                if parents[slot].is_none() {
                    base = Some([num(origin, "x").unwrap_or(f64::NAN), num(origin, "y").unwrap_or(f64::NAN)]);
                } else if let Some(root) = base {
                    let offset = self.animation_offset(&object);
                    base = Some([root[0] + offset[0], root[1] + offset[1]]);
                }
            }
            for (axis, field, value) in [(0usize, "root_x", x), (1usize, "root_y", y)] {
                let Some(value) = value else { continue };
                let delta = value - (base.map_or_else(|| num(&object, field).unwrap_or(f64::NAN), |b| b[axis]) + shifts[axis][root]);
                if delta != 0.0 {
                    let moved = &mut objects[root];
                    let at = moved.get(field).and_then(Value::as_f64).unwrap_or(f64::NAN);
                    moved.set(field, Value::Num(at + delta));
                    if let Some(origin) = moved.get("_stykAnimationOrigin").filter(|origin| origin.truthy()).and_then(Value::as_obj) {
                        let mut origin = origin.clone();
                        let property = if axis == 0 { "x" } else { "y" };
                        let at = origin.get(property).and_then(Value::as_f64).unwrap_or(f64::NAN);
                        origin.set(property, Value::Num(at + delta));
                        moved.set("_stykAnimationOrigin", Value::object(origin));
                    }
                    moved.remove("runtime_segments");
                }
                shifts[axis][root] += delta;
            }
        }
        Ok(())
    }

    /// `animationRotation`: an original pivot's reference, otherwise the first live angle.
    fn animation_rotation(&self, definition: Option<&Value>, object: &Value) -> f64 {
        if definition.is_some_and(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy))
            && let Some(typed) = self.typed_object(object)
            && let Some(figure) = self.prepared.doc.figure(typed.figure)
        {
            return crate::origin::rotation(figure, &typed);
        }
        let first = definition.and_then(|figure| figure.get("segments")).and_then(|segments| segments.item(0));
        let reference = number(first.as_ref().and_then(|segment| segment.get("angle_rad")), 0.0);
        number(object.get("angles").and_then(|angles| angles.item(0)).as_ref(), 0.0) - reference
    }

    fn animation_offset(&self, object: &Value) -> [f64; 2] {
        self.typed_object(object).and_then(|typed| self.prepared.doc.figure(typed.figure).map(|figure| crate::origin::offset(figure, &typed))).unwrap_or([0.0, 0.0])
    }

    /// The persisted curve's own value (`sampleAnimationChannel`), before any
    /// other joined figure's channel changes its displayed world coordinates.
    /// Reuses this Records view's already bound channel and exact sampler.
    pub fn sample_channel_value(&self, target: &Value, property: &str, tick: f64) -> Result<Option<Value>, Error> {
        let mut record = Obj::new();
        record.set("target", target.clone());
        record.set("property", Value::str(property));
        record.set("keys", Value::array(Vec::new()));
        let channel = crate::channels::channel(&Value::object(record), &mut Vec::new()).map_err(|why| Error::Invalid(why.to_string()))?;
        let Some(bound) = self.legacy.iter().find(|bound| bound.channel.target == channel.target && bound.channel.property == channel.property) else { return Ok(None) };
        match bound.channel.sample_at(tick) {
            Some(value) => Self::sampled_value(bound, value),
            None => Ok(None),
        }
    }

    /// `animationPropertyValue(report, frame, target, property)`: what the editor shows for a
    /// property on a frame record. `None` where it is undefined. `target` and `property` as a
    /// channel names them (the record of a channel's `target` and its `property`).
    pub fn property_value(&self, frame: &Value, target: &Value, property: &str) -> Result<Option<Value>, Error> {
        let mut channel = Obj::new();
        channel.set("target", target.clone());
        channel.set("property", Value::str(property));
        channel.set("keys", Value::array(Vec::new()));
        let typed = crate::channels::channel(&Value::object(channel), &mut Vec::new()).map_err(|why| Error::Invalid(why.to_string()))?;
        let (target, property) = (&typed.target, &typed.property);
        let objects = items(frame.get("objects"));
        let slot = target.uid().and_then(|uid| objects.iter().position(|o| o.get("unique_id").and_then(Value::as_f64) == Some(uid as f64)));
        if property.is_vfx() {
            let owner = match target {
                Target::Scene => frame.clone(),
                _ => match slot {
                    Some(slot) => objects[slot].clone(),
                    None => return Ok(None),
                },
            };
            if let Target::Segment { handle, figure_type, .. } = target {
                let type_id = owner.get("figure_type_id").and_then(Value::as_f64);
                let known = self.definition(type_id).is_some_and(|f| items(f.get("segments")).iter().any(|s| s.get("segment_id").and_then(Value::as_f64) == Some(*handle as f64)));
                if figure_type.is_some_and(|t| Some(t as f64) != type_id) || !known {
                    return Ok(None);
                }
            }
            let owner = owner.as_obj().cloned().unwrap_or_default();
            return Ok(match property {
                Property::VfxScope => Some(owner.get("_stykVfxScope").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0))),
                Property::VfxStack => Some(Value::array(vfx_stack(&owner, target))),
                Property::Vfx { kind, id, field } => {
                    let stack = vfx_stack(&owner, target);
                    let effect = stack.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id) && e.get("type").and_then(Value::as_str) == Some(kind.name()));
                    effect.map(|effect| match field {
                        Field::Enabled => Value::Num(if effect.get("enabled").is_some_and(Value::truthy) { 1.0 } else { 0.0 }),
                        Field::Param(i) => {
                            let spec = kind.specs()[*i];
                            present(effect.path(&["params", spec.name])).cloned().unwrap_or(Value::Num(spec.default))
                        }
                    })
                }
                _ => None,
            });
        }
        if *property == Property::Pose {
            return Err(Error::Invalid("errors.animationChannels.poseKeysReferenceSourceFramesNotScalarProperty".into()));
        }
        match target {
            Target::Camera => {
                let field = if *property == Property::Rotation { "angle_rad" } else { property_name(property) };
                let fallback = if *property == Property::Scale { 1.0 } else { 0.0 };
                return Ok(Some(present(frame.get("camera").and_then(|c| c.get(field))).cloned().unwrap_or(Value::Num(fallback))));
            }
            Target::Scene => {
                if *property == Property::BackgroundId {
                    return Ok(Some(present(frame.get("background_id")).cloned().unwrap_or(Value::Num(0.0))));
                }
                if let Some(color) = present(frame.get("_stykBackgroundColor")) {
                    return Ok(Some(color.clone()));
                }
                let id = frame.get("background_id");
                let found = items(self.tree.get("backgrounds")).into_iter().find(|bg| bg.get("background_id") == id && bg.get("kind").and_then(Value::as_f64) == Some(2.0));
                return Ok(Some(found.and_then(|bg| present(bg.get("color")).cloned()).unwrap_or(Value::Num(4294967295.0))));
            }
            Target::Layer { .. } => return Err(Error::Invalid("errors.animationChannels.poseKeysReferenceSourceFramesNotScalarProperty".into())),
            _ => {}
        }
        let Some(slot) = slot else { return Ok(None) };
        let object = &objects[slot];
        let figure_kind = matches!(target, Target::Figure { .. });
        if figure_kind && *property == Property::Color {
            let raw = number(object.get("color_override_raw"), 0.0);
            return Ok(Some(Value::Num(if raw.is_finite() { raw.trunc().rem_euclid(4294967296.0) } else { 0.0 })));
        }
        if figure_kind && *property == Property::ZIndex {
            return Ok(Some(present(object.get("_stykZIndex")).cloned().unwrap_or(Value::Num(0.0))));
        }
        let definition = self.definition(object.get("figure_type_id").and_then(Value::as_f64));
        if style_property(target, property) {
            return match style_value(definition.as_ref(), object, target, property) {
                None => Ok(None),
                Some(Style::Value(value)) => Ok(Some(value)),
                Some(Style::NativePaint) => Err(Error::Unported("a segment's own paint as a property value".into())),
            };
        }
        Ok(match property {
            Property::Opacity => Some(Value::Num(1.0 - number(object.get("field28"), 0.0) / 255.0)),
            Property::Rotation => {
                Some(Value::Num(self.animation_rotation(definition.as_ref(), object)))
            }
            Property::X | Property::Y => {
                let (axis, field) = if *property == Property::X { (0, "root_x") } else { (1, "root_y") };
                let world = if object.get("join").is_some_and(Value::truthy) { self.geometry_of(frame)?.objects.get(slot).filter(|g| g.resolved).map(|g| g.root) } else { None };
                match (world, object.get("_stykAnimationOrigin").filter(|origin| origin.truthy())) {
                    (Some(root), Some(_)) => Some(Value::Num(root[axis] + self.animation_offset(object)[axis])),
                    (None, Some(origin)) => origin.get(if axis == 0 { "x" } else { "y" }).cloned(),
                    (Some(root), None) => Some(Value::Num(root[axis])),
                    (None, None) => object.get(field).cloned(),
                }
            }
            other => object.get(property_name(other)).cloned(),
        })
    }
}

/// `rotateOriginSupport`: preserve all ghost fields while the retained angular dependencies
/// follow a whole figure's turn. Native segments have already taken the same delta.
fn rotate_origin_support(figure: Option<&Value>, object: &mut Obj, delta: f64) {
    if delta == 0.0 || !figure.is_some_and(|figure| figure.path(&["_styk", "animationOrigin", "support"]).is_some_and(Value::truthy)) {
        return;
    }
    let Some(origin) = object.get("_stykAnimationOrigin").and_then(Value::as_obj) else { return };
    let Some(ghosts) = origin.get("ghosts").and_then(Value::as_obj) else { return };
    let mut turned = Obj::new();
    for (index, pose) in ghosts.iter() {
        let mut pose = pose.as_obj().cloned().unwrap_or_default();
        let angle = pose.get("angle_rad").and_then(Value::as_f64).unwrap_or(f64::NAN);
        pose.set("angle_rad", Value::Num(angle + delta));
        turned.set(index, Value::object(pose));
    }
    let mut origin = origin.clone();
    origin.set("ghosts", Value::object(turned));
    object.set("_stykAnimationOrigin", Value::object(origin));
}

/// A property's name as channels store it, for the plain ones.
fn property_name(property: &Property) -> &'static str {
    match property {
        Property::X => "x",
        Property::Y => "y",
        Property::Scale => "scale",
        Property::Rotation => "rotation",
        Property::Opacity => "opacity",
        Property::Color => "color",
        Property::Thickness => "thickness",
        Property::ZIndex => "zIndex",
        _ => "",
    }
}

/// The drawing order being built (`append`, `appendAnchors`).
struct Stacking<'a> {
    slots: &'a HashMap<u64, usize>,
    anchors: Vec<(f64, Vec<f64>)>,
    anchored: HashSet<u64>,
    order: Vec<usize>,
    placed: Vec<bool>,
}

impl Stacking<'_> {
    fn append(&mut self, uid: f64) {
        if let Some(&slot) = self.slots.get(&uid.to_bits())
            && !self.placed[slot]
        {
            self.placed[slot] = true;
            self.order.push(slot);
        }
        self.append_anchors(uid);
    }

    fn append_anchors(&mut self, uid: f64) {
        if !self.anchored.insert(uid.to_bits()) {
            return;
        }
        let children = self.anchors.iter().find(|(anchor, _)| *anchor == uid).map(|(_, list)| list.clone()).unwrap_or_default();
        for child in children {
            if self.slots.contains_key(&child.to_bits()) {
                self.append(child);
            } else {
                self.append_anchors(child);
            }
        }
    }
}
