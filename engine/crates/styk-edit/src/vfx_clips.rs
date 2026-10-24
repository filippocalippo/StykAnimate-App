//! Effect clips on the timeline (src/editor-vfx-clips.mjs): a clip's timing, switch,
//! strength, fades and effects, its parameters and their keys, its place among the clips
//! of its target, deleting it; and the gizmo edit that previews several changes and records
//! them once (`beginVfxClipEdit`). Each change is one `vfx-clips` history entry, the layer
//! sheet lengthened to the last timed clip (`publish`). Adding, copying, pasting and
//! duplicating clips and adding effects to them take the identities and seeds the editor
//! drew (D18). Paint colours use the shared strict paint validator and the evaluator's
//! colour interpolation. Connected scopes validate the currently displayed joins.
//!
//! The clips are checked as `validateVfxClips` checks them. A clip the document already
//! holds was checked when it arrived (the editor keeps a set of checked clips), so only
//! the clips a command changes, and inside them the effects and key channels it changes,
//! are checked in full; identities, key counts and simultaneous effects are checked for all.

use styk_doc::{Obj, Value};
use styk_eval::vfx::{Kind, ParamKind};

use crate::history::{Command, CommandKind, Direction};
use crate::property_edit::normalize_target;
use crate::{EditError, Editor};

const CLIP_LIMIT: usize = 4096;
const STACK_LIMIT: usize = 16;
const MAX_TICK: f64 = 10_000_000.0;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn whole(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Num(n)) if n.fract() == 0.0 && n.is_finite() => Some(*n),
        _ => None,
    }
}

/// An identity of 1 to `max` letters, digits, `_` or `-`.
fn word_id(value: Option<&Value>, max: usize) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// `Object.is(a, b)` for two fields: numbers by value (NaN is NaN, -0 is not 0),
/// containers by identity.
fn object_is(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Num(x)), Some(Value::Num(y))) => x.to_bits() == y.to_bits() || (x == y && x.is_sign_negative() == y.is_sign_negative()),
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(x @ (Value::Str(_) | Value::Blob(_))), Some(y @ (Value::Str(_) | Value::Blob(_)))) => x.text() == y.text(),
        (Some(x), Some(y)) => x.same_node(y),
        _ => false,
    }
}

/// `vfxDescriptor(property)` for `vfx1:type:id:param`: the effect type, its identity and
/// the parameter's kind and range (`enabled` is a switch).
pub(crate) struct Descriptor {
    kind: Kind,
    /// The effect's type as the property names it.
    type_name: String,
    id: String,
    param: String,
    color: bool,
    discrete: bool,
    min: f64,
    max: f64,
}

pub(crate) fn descriptor(property: &str) -> Option<Descriptor> {
    let parts: Vec<&str> = property.split(':').collect();
    if parts.len() != 4 || parts[0] != "vfx1" {
        return None;
    }
    let kind = Kind::from_name(parts[1])?;
    let id = parts[2];
    if !(1..=64).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    let param = parts[3];
    let (color, discrete, min, max) = if param == "enabled" {
        (false, true, 0.0, 1.0)
    } else {
        let spec = kind.specs()[kind.param(param)?];
        (spec.kind == ParamKind::Color, spec.kind.discrete(), spec.min, spec.max)
    };
    Some(Descriptor { kind, type_name: parts[1].to_string(), id: id.to_string(), param: param.to_string(), color, discrete, min, max })
}

/// `vfxProperty(type, id, param)`.
fn property_of(kind: &str, id: &str, param: &str) -> Result<(String, Descriptor), EditError> {
    let property = format!("vfx1:{kind}:{id}:{param}");
    let found = descriptor(&property).ok_or_else(|| invalid("errors.vfx.invalidEffectParameter"))?;
    Ok((property, found))
}

/// `validateVfxValue(property, value)` for a parameter: a number in its range (whole for
/// colours and discrete parameters), or a paint through the shared editor validator.
pub(crate) fn check_value(found: &Descriptor, value: Option<&Value>) -> Result<(), EditError> {
    match value {
        Some(Value::Num(n)) if n.is_finite() && *n >= found.min && *n <= found.max && (!(found.color || found.discrete) || n.fract() == 0.0) => Ok(()),
        Some(paint @ (Value::Obj(_) | Value::Arr(_) | Value::Nums(_) | Value::Null)) if found.color => crate::recolor::normalize_paint(paint).map(|_| ()),
        _ => Err(vfx_range_error(&found.type_name, &found.param, found.min, found.max)),
    }
}

/// A value outside an effect parameter's range: the parameter is named as the interface names it.
pub(crate) fn vfx_range_error(type_name: &str, param: &str, min: f64, max: f64) -> EditError {
    let mut parameter = Obj::new();
    parameter.set("type", Value::str(type_name));
    parameter.set("param", Value::str(param));
    let mut reference = Obj::new();
    reference.set("@vfxParameter", Value::object(parameter));
    crate::invalid_with("errors.cameraMotion.mustBeBetweenAnd", vec![("label", Value::object(reference)), ("min", Value::Num(min)), ("max", Value::Num(max))])
}

/// `validateVfxStack(stack)`, effects in `known` (already checked) skipped.
pub(crate) fn check_stack(stack: Option<&Value>, known: &[Value]) -> Result<(), EditError> {
    let Some(effects) = stack.filter(|s| s.is_array()).map(|s| list(Some(s))).filter(|e| e.len() <= STACK_LIMIT) else {
        return Err(invalid("errors.vfx.anEffectStackSupportsUpToEffects"));
    };
    let mut ids: Vec<String> = Vec::new();
    for effect in &effects {
        let kind = effect.get("type").and_then(Value::as_str).and_then(Kind::from_name);
        let id = word_id(effect.get("id"), 64).map(str::to_string);
        let version = matches!(effect.get("version"), Some(Value::Num(v)) if *v == 1.0 || *v == 2.0);
        let params = effect.get("params").and_then(Value::as_obj);
        let (Some(kind), Some(id), true, Some(Value::Bool(_)), Some(params)) = (kind, id, version, effect.get("enabled"), params) else {
            return Err(invalid("errors.vfx.invalidVfxStack"));
        };
        if ids.contains(&id) {
            return Err(invalid("errors.vfx.invalidVfxStack"));
        }
        ids.push(id.clone());
        if known.iter().any(|k| k.same_node(effect)) {
            continue;
        }
        if params.keys().any(|key| kind.param(key).is_none()) {
            return Err(invalid("errors.vfx.unknownVfxParameter"));
        }
        for spec in kind.specs() {
            // A missing parameter takes its default, which is valid.
            let Some(value) = params.get(spec.name).filter(|v| !v.is_null()) else { continue };
            let (_, found) = property_of(kind.name(), &id, spec.name)?;
            check_value(&found, Some(value))?;
        }
    }
    Ok(())
}

/// `vfxOwnerKey(target)`.
fn owner_key(target: &Value) -> String {
    if target.get("kind").and_then(Value::as_str) == Some("segment") {
        let scope = target.get("figureTypeId").map_or("*".to_string(), styk_doc::json::to_string);
        format!("{scope}/{}", target.get("handleId").map_or("undefined".to_string(), styk_doc::json::to_string))
    } else {
        "figure".into()
    }
}

/// `validateVfxClips({version: 1, clips}, {immutable: true})`, clips in `known` (already
/// checked) checked only for what involves other clips.
pub(crate) fn check_clips(clips: &[Value], known: &[Value]) -> Result<(), EditError> {
    if clips.len() > CLIP_LIMIT {
        return Err(invalid("errors.vfxClips.invalidEffectsTimeline"));
    }
    let mut ids: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut events: Vec<(String, Vec<(f64, f64)>)> = Vec::new();
    for clip in clips {
        let id = word_id(clip.get("id"), 80);
        let Some(id) = id.filter(|id| clip.is_object() && !ids.iter().any(|known| known == id)) else {
            return Err(invalid("errors.vfxClips.invalidEffectClipIdentity"));
        };
        ids.push(id.to_string());
        let old = known.iter().find(|k| k.get("id").and_then(Value::as_str) == Some(id));
        if !known.iter().any(|k| k.same_node(clip)) {
            check_clip(clip, old)?;
        }
        for channel in clip.get("keys").and_then(Value::as_obj).map(|k| k.values().to_vec()).unwrap_or_default() {
            count += channel.array_len().unwrap_or(0);
        }
        if count > 1_000_000 {
            return Err(invalid("errors.vfxClips.tooManyEffectKeys"));
        }
        let target = clip.get("target").cloned().unwrap_or(Value::Null);
        let uid = target.get("uid").filter(|u| !u.is_null()).map_or(String::new(), styk_doc::json::to_string);
        let key = format!("{}/{uid}/{}", target.get("kind").and_then(Value::as_str).unwrap_or(""), owner_key(&target));
        let at = match events.iter().position(|(k, _)| *k == key) {
            Some(at) => at,
            None => {
                events.push((key, Vec::new()));
                events.len() - 1
            }
        };
        if clip.get("enabled") == Some(&Value::Bool(true)) {
            let effects = clip.get("effects").and_then(Value::array_len).unwrap_or(0) as f64;
            let start = clip.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN);
            events[at].1.push((start, effects));
            if let Some(duration) = clip.get("duration").filter(|d| !d.is_null()).and_then(Value::as_f64) {
                events[at].1.push((start + duration, -effects));
            }
        }
    }
    for (_, mut changes) in events {
        changes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
        let mut active = 0.0;
        for (_, change) in changes {
            active += change;
            if active > 64.0 {
                return Err(invalid("errors.vfxClips.aTargetSupportsUpTo64SimultaneousEffects"));
            }
        }
    }
    Ok(())
}

/// One clip's target, timing, effects and keys; parts it shares with `old` (the clip it
/// replaces) were checked with it.
fn check_clip(clip: &Value, old: Option<&Value>) -> Result<(), EditError> {
    let target = clip.get("target");
    let kind = target.and_then(|t| t.get("kind")).and_then(Value::as_str);
    let uid_ok = |t: &Value| whole(t.get("uid")).is_some_and(|u| u >= 0.0);
    let target_ok = match (target.filter(|t| t.truthy()), kind) {
        (Some(_), Some("scene")) => true,
        (Some(t), Some("figure")) => uid_ok(t),
        (Some(t), Some("segment")) => {
            uid_ok(t)
                && whole(t.get("handleId")).is_some_and(|h| (1.0..=65535.0).contains(&h))
                && (t.get("figureTypeId").is_none() || whole(t.get("figureTypeId")).is_some_and(|f| f >= 1.0 && f <= 9_007_199_254_740_991.0))
        }
        _ => false,
    };
    if !target_ok {
        return Err(invalid("errors.vfxClips.invalidEffectClipTarget"));
    }
    let tick = |key: &str| whole(clip.get(key)).filter(|n| (0.0..=MAX_TICK).contains(n));
    let name_ok = clip.get("name").and_then(Value::as_str).is_some_and(|n| n.encode_utf16().count() <= 120);
    let flags = matches!(clip.get("enabled"), Some(Value::Bool(_))) && matches!(clip.get("includeAttached"), Some(Value::Bool(_)));
    let times = ["start", "offset", "fadeIn", "fadeOut"].iter().all(|k| tick(k).is_some());
    let start = clip.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let duration_ok = match clip.get("duration") {
        Some(Value::Null) => clip.get("start").and_then(Value::as_f64) == Some(0.0) && clip.get("offset").and_then(Value::as_f64) == Some(0.0),
        other => whole(other).is_some_and(|d| d >= 1.0 && start + d <= MAX_TICK),
    };
    let strength_ok = matches!(clip.get("strength"), Some(Value::Num(s)) if s.is_finite() && (0.0..=1.0).contains(s));
    if !name_ok || !flags || !times || !duration_ok || !strength_ok {
        return Err(invalid("errors.vfxClips.invalidEffectClipTiming"));
    }
    let effects = clip.get("effects");
    let known_effects = old.and_then(|o| o.get("effects")).map(|e| list(Some(e))).unwrap_or_default();
    check_stack(effects, &known_effects)?;
    let effects = list(effects);
    let Some(keys) = clip.get("keys").filter(|k| k.truthy()).and_then(Value::as_obj).filter(|k| k.len() <= 512) else {
        return Err(invalid("errors.vfxClips.invalidEffectKeys"));
    };
    let old_keys = old.and_then(|o| o.get("keys")).and_then(Value::as_obj);
    for (property, channel) in keys.iter() {
        let found = descriptor(property);
        let owned = found.as_ref().is_some_and(|d| effects.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(d.id.as_str()) && e.get("type").and_then(Value::as_str) == Some(d.kind.name())));
        let (Some(found), true, true) = (found, owned, channel.is_array() && channel.array_len().unwrap_or(0) <= 100_000) else {
            return Err(invalid("errors.vfxClips.invalidEffectKeyChannel"));
        };
        if old_keys.and_then(|k| k.get(property)).is_some_and(|k| k.same_node(channel)) {
            continue;
        }
        let mut previous = -1.0;
        for key in list(Some(channel)) {
            let Some(at) = whole(key.get("tick")).filter(|t| *t >= 0.0 && *t > previous && *t <= MAX_TICK) else {
                return Err(invalid("errors.vfxClips.effectKeysMustBeOrderedAndUnique"));
            };
            previous = at;
            check_value(&found, key.get("value"))?;
            crate::sheet_frames::valid_easing(&key)?;
            let mode = match key.get("interpolation") {
                None | Some(Value::Null) => "linear".to_string(),
                Some(mode) => mode.as_str().map(|m| if m == "hold" { "constant" } else { m }).unwrap_or("").to_string(),
            };
            if found.discrete && mode != "constant" {
                return Err(crate::invalid_with("errors.keyframeEasing.useConstantEasing", vec![("value", crate::message("keyframeEasing.backgroundIdentities"))]));
            }
        }
    }
    Ok(())
}

/// `sameVfxTarget(a, b)`.
fn same_target(a: Option<&Value>, b: Option<&Value>) -> bool {
    let field = |t: Option<&Value>, k: &str| t.and_then(|t| t.get(k)).cloned();
    ["kind", "uid", "handleId", "figureTypeId"].iter().all(|k| object_is(field(a, k).as_ref(), field(b, k).as_ref()))
}

/// `Math.round(x)`: halves go up; NaN stays NaN.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// A copy of `object` with `key` set.
fn with(object: &Value, key: &str, value: Value) -> Value {
    let mut copy = object.as_obj().cloned().unwrap_or_default();
    copy.set(key, value);
    Value::object(copy)
}

fn sorted_by_tick(mut keys: Vec<Value>) -> Vec<Value> {
    let tick = |k: &Value| k.get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN);
    keys.sort_by(|a, b| (tick(a) - tick(b)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    keys
}

impl Editor {
    fn vfx_clips(&self) -> Vec<Value> {
        list(self.report.path(&["_styk", "vfxClips", "clips"]))
    }

    /// `find(editor, id)`.
    fn vfx_clip(&self, id: &Value) -> Result<Value, EditError> {
        self.vfx_clips().into_iter().find(|c| object_is(c.get("id"), Some(id))).ok_or_else(|| invalid("errors.editorVfxClips.selectAnEffectClip"))
    }

    /// `unlocked(editor, target)`: the layer of the clip's target must not be locked.
    fn vfx_unlocked(&self, target: Option<&Value>) -> Result<(), EditError> {
        let layers = self.report.path(&["_styk", "layers"]);
        let mut owner = "scene".to_string();
        let locked = match target.and_then(|t| t.get("kind")).and_then(Value::as_str) {
            Some("scene") => layers.and_then(|l| l.path(&["fixed", "scene", "locked"])).is_some_and(Value::truthy),
            _ => {
                let uid = target.and_then(|t| t.get("uid")).and_then(Value::as_f64);
                let layer = match uid {
                    Some(uid) => self.layer_of(uid as u32),
                    None => return Err(EditError::Unported("an effect clip without a figure".into())),
                };
                let locked = layers.and_then(|l| l.path(&["byId", &layer, "locked"])).is_some_and(Value::truthy);
                owner = layer;
                locked
            }
        };
        if locked {
            return Err(crate::invalid_with("errors.editorVfxClips.unlockBeforeEditingEffects", vec![("name", Value::str(&crate::layers::layer_title(layers, &owner)))]));
        }
        Ok(())
    }

    /// `publish(editor, clips, label)`; inside a gizmo edit, a preview with no history.
    fn publish_vfx(&mut self, clips: Vec<Value>, label: &str) -> Result<bool, EditError> {
        let old = self.vfx_clips();
        check_clips(&clips, &old)?;
        for clip in old.iter().filter(|c| !clips.iter().any(|n| n.same_node(c))).chain(clips.iter().filter(|c| !old.iter().any(|o| o.same_node(c)))) {
            self.vfx_unlocked(clip.get("target"))?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let mut table = Obj::new();
        table.set("version", Value::Num(1.0));
        table.set("clips", Value::array(clips.clone()));
        let after = Value::object(table);
        if self.vfx_edit.is_some() {
            if let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
                styk.set("vfxClips", after);
            }
            self.emit("preview", vec![("vfxClips", Value::Bool(true))]);
            return Ok(true);
        }
        let before_selection = self.selection_state();
        let before = self.report.path(&["_styk", "vfxClips"]).filter(|v| !v.is_null()).cloned();
        let end = clips.iter().map(|c| match c.get("duration") {
            Some(Value::Null) | None => 0.0,
            Some(d) => c.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN) + d.as_f64().unwrap_or(f64::NAN),
        });
        let end = end.fold(1.0, js_max);
        let sheet = self.report.path(&["_styk", "layerSheet"]).cloned().filter(|s| s.truthy());
        let duration = sheet.as_ref().and_then(|s| s.get("duration")).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let patch = sheet.filter(|_| end > duration).map(|before| {
            let mut tracks = before.get("tracks").and_then(Value::as_obj).cloned().unwrap_or_default();
            for id in tracks.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
                if tracks.get(&id).and_then(|t| t.get("end")).and_then(Value::as_f64) == Some(duration) {
                    let track = with(tracks.get(&id).unwrap(), "end", Value::Num(end));
                    tracks.set(&id, track);
                }
            }
            let mut sheet = before.as_obj().cloned().unwrap_or_default();
            sheet.set("duration", Value::Num(end));
            sheet.set("tracks", Value::object(tracks));
            (before, Value::object(sheet))
        });
        if let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            styk.set("vfxClips", after.clone());
            if let Some((_, sheet)) = &patch {
                styk.set("layerSheet", sheet.clone());
            }
        }
        let after_selection = self.selection_state();
        self.record(Command { kind: CommandKind::VfxClips { before, after, sheet: patch }, label: label.into(), before_selection, after_selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("vfxClips", Value::Bool(true)), ("timing", Value::Bool(true)), ("frameIndices", Value::array(Vec::new()))]);
        Ok(true)
    }

    /// `_applyCommand` for a `vfx-clips` entry.
    pub(crate) fn apply_vfx_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::VfxClips { before, after, sheet } = &command.kind else { return Ok(()) };
        if let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            match (direction, before) {
                (Direction::Before, None) => {
                    styk.remove("vfxClips");
                }
                (Direction::Before, Some(before)) => styk.set("vfxClips", before.clone()),
                (Direction::After, _) => styk.set("vfxClips", after.clone()),
            }
            if let Some((old, new)) = sheet {
                styk.set("layerSheet", if direction == Direction::Before { old.clone() } else { new.clone() });
            }
        }
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        self.restore_selection(selection)?;
        self.revision = revision;
        // The history event has no `structural` (the entry does not say), as the editor's.
        let mut event = Obj::new();
        event.set("kind", Value::str("history"));
        event.set("frameIndex", Value::Num(self.frame_index as f64));
        event.set("tick", Value::Num(self.tick));
        event.set("timing", Value::Bool(true));
        event.set("label", Value::str(&command.label));
        event.set("definition", Value::Bool(false));
        event.set("animation", Value::Bool(false));
        self.events.push(Value::object(event));
        Ok(())
    }

    /// `beginVfxClipEdit()`: later clip changes preview until the edit is committed.
    pub(crate) fn begin_vfx_clip_edit(&mut self) -> Result<Value, EditError> {
        self.commit_vfx_clip_edit()?;
        self.vfx_edit = Some(self.report.path(&["_styk", "vfxClips"]).filter(|v| !v.is_null()).cloned());
        Ok(Value::Null)
    }

    /// `commitVfxClipEdit()`: what the edit previewed, recorded as one change.
    pub(crate) fn commit_vfx_clip_edit(&mut self) -> Result<bool, EditError> {
        let Some(before) = self.vfx_edit.take() else { return Ok(false) };
        let after = self.report.path(&["_styk", "vfxClips"]).filter(|v| !v.is_null()).cloned();
        self.restore_vfx(before.clone());
        let unchanged = match (&after, &before) {
            (None, None) => true,
            (Some(a), Some(b)) => a.same_node(b),
            _ => false,
        };
        if unchanged {
            return Ok(false);
        }
        self.publish_vfx(list(after.as_ref().and_then(|a| a.get("clips"))), "Edit effect")
    }

    /// `cancelVfxClipEdit()`: the clips as they were before the edit.
    pub(crate) fn cancel_vfx_clip_edit(&mut self) -> Result<bool, EditError> {
        let Some(before) = self.vfx_edit.take() else { return Ok(false) };
        self.restore_vfx(before);
        self.emit("preview", vec![("vfxClips", Value::Bool(true))]);
        Ok(true)
    }

    fn restore_vfx(&mut self, value: Option<Value>) {
        if let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            match value {
                Some(value) => styk.set("vfxClips", value),
                None => {
                    styk.remove("vfxClips");
                }
            }
        }
    }

    /// `setVfxClip(id, patch)`.
    pub(crate) fn set_vfx_clip(&mut self, id: &Value, patch: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let patch = patch.as_obj().ok_or_else(|| EditError::Unported("an effect clip change that is not an object".into()))?;
        const KEYS: [&str; 11] = ["name", "start", "duration", "offset", "enabled", "strength", "fadeIn", "fadeOut", "includeAttached", "effects", "keys"];
        if patch.keys().any(|k| !KEYS.contains(&&**k)) {
            return Err(invalid("errors.editorVfxClips.unsupportedEffectClipProperty"));
        }
        if patch.get("includeAttached").is_some_and(Value::truthy) {
            self.check_connected_vfx(clip.path(&["target", "uid"]).unwrap_or(&Value::Null))?;
        }
        let mut next = clip.as_obj().cloned().unwrap_or_default();
        for (key, value) in patch.iter() {
            next.set(key, value.clone());
        }
        if patch.keys().all(|k| object_is(clip.get(k), next.get(k))) {
            return Ok(false);
        }
        let next = Value::object(next);
        let clips = self.vfx_clips().into_iter().map(|c| if c.same_node(&clip) { next.clone() } else { c }).collect();
        self.publish_vfx(clips, "Edit effect clip")
    }

    /// `trimVfxClipStart(id, start)`: a timed clip starts later or earlier, its end kept;
    /// keys move with the source when time before the source's start is revealed.
    pub(crate) fn trim_vfx_clip_start(&mut self, id: &Value, start: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let Some(duration) = clip.get("duration").filter(|d| !d.is_null()).map(|d| d.as_f64().unwrap_or(f64::NAN)) else { return Ok(false) };
        let number = |k: &str| clip.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let wanted = start.as_f64().unwrap_or(f64::NAN);
        let start = js_max(0.0, js_min(number("start") + duration - 1.0, js_round(wanted)));
        let delta = start - number("start");
        let offset = number("offset") + delta;
        let keys = match clip.get("keys") {
            Some(keys) if offset < 0.0 => {
                let mut rebased = Obj::new();
                for (property, channel) in keys.as_obj().map(|k| k.iter().map(|(p, c)| (p.to_string(), c.clone())).collect::<Vec<_>>()).unwrap_or_default() {
                    let moved = list(Some(&channel)).into_iter().map(|k| with(&k, "tick", Value::Num(k.get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN) - offset))).collect();
                    rebased.set(&property, Value::array(moved));
                }
                Value::object(rebased)
            }
            Some(keys) => keys.clone(),
            None => Value::Null,
        };
        let mut patch = Obj::new();
        patch.set("start", Value::Num(start));
        patch.set("duration", Value::Num(duration - delta));
        patch.set("offset", Value::Num(js_max(0.0, offset)));
        patch.set("keys", keys);
        self.set_vfx_clip(id, &Value::object(patch))
    }

    /// `deleteVfxClip(id)`.
    pub(crate) fn delete_vfx_clip(&mut self, id: &Value) -> Result<bool, EditError> {
        self.vfx_clip(id)?;
        let clips = self.vfx_clips().into_iter().filter(|c| !object_is(c.get("id"), Some(id))).collect();
        self.publish_vfx(clips, "Delete effect clip")
    }

    /// `moveVfxClipOrder(id, delta)`: before or after the next clip of the same target.
    pub(crate) fn move_vfx_clip_order(&mut self, id: &Value, delta: &Value) -> Result<bool, EditError> {
        let step = match delta {
            Value::Num(d) if *d == 1.0 || *d == -1.0 => *d as i64,
            _ => return Err(invalid("errors.editorVfxClips.chooseAnEffectOrder")),
        };
        let mut clips = self.vfx_clips();
        let Some(i) = clips.iter().position(|c| object_is(c.get("id"), Some(id))) else { return Ok(false) };
        let mut j = i as i64 + step;
        while j >= 0 && (j as usize) < clips.len() && !same_target(clips[i].get("target"), clips[j as usize].get("target")) {
            j += step;
        }
        if j < 0 || j as usize >= clips.len() {
            return Ok(false);
        }
        clips.swap(i, j as usize);
        self.publish_vfx(clips, "Reorder effects")
    }

    /// `reorderVfxGroupEffect(id, effectId, index)`.
    pub(crate) fn reorder_vfx_group_effect(&mut self, id: &Value, effect: &Value, index: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let mut effects = list(clip.get("effects"));
        let from = effects.iter().position(|e| object_is(e.get("id"), Some(effect)));
        let to = whole(Some(index)).filter(|i| *i >= 0.0 && (*i as usize) < effects.len()).map(|i| i as usize);
        let (Some(from), Some(to)) = (from, to) else { return Err(invalid("errors.editorVfxClips.chooseAnEffectOrder")) };
        if from == to {
            return Ok(false);
        }
        let moved = effects.remove(from);
        effects.insert(to, moved);
        let mut patch = Obj::new();
        patch.set("effects", Value::array(effects));
        self.set_vfx_clip(id, &Value::object(patch))
    }

    /// `setVfxClipParameters(id, effectId, values, {key, tick})`: values set on the effect,
    /// or keyed at the clip's time when keying (asked, auto key, or the parameter has keys).
    pub(crate) fn set_vfx_clip_parameters(&mut self, id: &Value, effect_id: &Value, values: &Value, options: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let effects = list(clip.get("effects"));
        let effect = effects.iter().find(|e| object_is(e.get("id"), Some(effect_id))).cloned().ok_or_else(|| invalid("errors.editorVfxClips.selectAnEffect"))?;
        let values = values.as_obj().ok_or_else(|| EditError::Unported("effect values that are not an object".into()))?;
        let keying = options.get("key").is_some_and(Value::truthy);
        let tick = match options.get("tick") {
            Some(tick) => tick.as_f64().unwrap_or(f64::NAN),
            None => self.tick,
        };
        let kind = effect.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let effect_name = effect_id.as_str().map(str::to_string).unwrap_or_else(|| styk_doc::json::to_string(effect_id));
        let mut updated = effect.clone();
        let original_keys = clip.get("keys").cloned().unwrap_or(Value::Null);
        let mut table = original_keys.clone();
        for (param, value) in values.iter() {
            let (property, found) = property_of(&kind, &effect_name, param)?;
            check_value(&found, Some(value))?;
            let channel = table.get(&property).map(|c| list(Some(c))).unwrap_or_default();
            if keying || self.auto_key || !channel.is_empty() {
                let start = clip.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN);
                let offset = clip.get("offset").and_then(Value::as_f64).unwrap_or(f64::NAN);
                let time = js_max(0.0, tick - start + offset).floor();
                let index = channel.iter().position(|k| k.get("tick").and_then(Value::as_f64) == Some(time));
                let old = index.map(|i| channel[i].clone());
                if old.as_ref().is_some_and(|k| object_is(k.get("value"), Some(value))) {
                    continue;
                }
                let mut key = old.as_ref().and_then(Value::as_obj).cloned().unwrap_or_default();
                key.set("tick", Value::Num(time));
                key.set("value", value.clone());
                let easing = old.as_ref().and_then(|k| k.get("interpolation")).filter(|i| !i.is_null()).cloned().unwrap_or_else(|| Value::str(if found.discrete { "constant" } else { "linear" }));
                key.set("interpolation", easing);
                let mut keys = channel.clone();
                match index {
                    Some(i) => keys[i] = Value::object(key),
                    None => keys.push(Value::object(key)),
                }
                table = with(&table, &property, Value::array(sorted_by_tick(keys)));
            } else if param.as_ref() == "enabled" {
                let on = value.truthy();
                if updated.get("enabled") != Some(&Value::Bool(on)) {
                    updated = with(&updated, "enabled", Value::Bool(on));
                }
            } else if !object_is(updated.path(&["params", param]), Some(value)) {
                let params = with(updated.get("params").unwrap_or(&Value::Null), param, value.clone());
                updated = with(&updated, "params", params);
            }
        }
        if updated.same_node(&effect) && table.same_node(&original_keys) {
            return Ok(false);
        }
        let effects = if updated.same_node(&effect) { clip.get("effects").cloned().unwrap_or(Value::Null) } else { Value::array(effects.into_iter().map(|e| if e.same_node(&effect) { updated.clone() } else { e }).collect()) };
        let mut patch = Obj::new();
        patch.set("effects", effects);
        patch.set("keys", table);
        self.set_vfx_clip(id, &Value::object(patch))
    }

    /// `toggleVfxClipKey(id, property, tick)`: a key at the clip's time removed, or one
    /// added with the sampled value there, including paint colours between keys.
    pub(crate) fn toggle_vfx_clip_key(&mut self, id: &Value, property: &Value, tick: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let property = property.as_str().ok_or_else(|| EditError::Unported("an effect key property that is not text".into()))?.to_string();
        let tick = if tick.is_null() { self.tick } else { tick.as_f64().unwrap_or(f64::NAN) };
        let time = js_max(0.0, tick - clip.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN) + clip.get("offset").and_then(Value::as_f64).unwrap_or(f64::NAN)).floor();
        let keys = list(clip.path(&["keys", &property]));
        if let Some(existing) = keys.iter().position(|k| k.get("tick").and_then(Value::as_f64) == Some(time)) {
            let remaining: Vec<Value> = keys.iter().enumerate().filter(|(i, _)| *i != existing).map(|(_, k)| k.clone()).collect();
            let mut table = clip.get("keys").and_then(Value::as_obj).cloned().unwrap_or_default();
            if remaining.is_empty() {
                table.remove(&property);
            } else {
                table.set(&property, Value::array(remaining));
            }
            let mut patch = Obj::new();
            patch.set("keys", Value::object(table));
            return self.set_vfx_clip(id, &Value::object(patch));
        }
        let found = descriptor(&property).ok_or_else(|| EditError::Unported("an effect key property the registry does not name".into()))?;
        let sampled = sampled_effects(&clip, tick).ok_or_else(|| EditError::Unported("an effect parameter the evaluator does not sample".into()))?;
        let effect = list(Some(&sampled)).into_iter().find(|e| e.get("id").and_then(Value::as_str) == Some(found.id.as_str()));
        let Some(effect) = effect else { return Err(EditError::Unported("an effect key for an effect the clip does not hold".into())) };
        let value = if found.param == "enabled" {
            Value::Num(if effect.get("enabled").is_some_and(Value::truthy) { 1.0 } else { 0.0 })
        } else {
            match effect.path(&["params", &found.param]) {
                Some(value) => value.clone(),
                None => return Err(EditError::Unported("an effect parameter left at its default".into())),
            }
        };
        let mut values = Obj::new();
        values.set(&found.param, value);
        let mut options = Obj::new();
        options.set("key", Value::Bool(true));
        options.set("tick", Value::Num(tick));
        self.set_vfx_clip_parameters(id, &Value::str(&found.id), &Value::object(values), &Value::object(options))
    }

    /// `moveVfxClipKey(id, property, from, to)`.
    pub(crate) fn move_vfx_clip_key(&mut self, id: &Value, property: &Value, from: &Value, to: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let property = property.as_str().ok_or_else(|| EditError::Unported("an effect key property that is not text".into()))?.to_string();
        let keys = list(clip.path(&["keys", &property]));
        let time = js_max(0.0, js_round(to.as_f64().unwrap_or(f64::NAN)));
        let tick_is = |k: &Value, t: &Value| object_is(k.get("tick"), Some(t));
        if keys.iter().any(|k| k.get("tick").and_then(Value::as_f64) == Some(time) && !tick_is(k, from)) {
            return Err(invalid("errors.editorVfxClips.anEffectKeyAlreadyExistsHere"));
        }
        let moved = keys.into_iter().map(|k| if tick_is(&k, from) { with(&k, "tick", Value::Num(time)) } else { k }).collect();
        let table = with(clip.get("keys").unwrap_or(&Value::Null), &property, Value::array(sorted_by_tick(moved)));
        let mut patch = Obj::new();
        patch.set("keys", table);
        self.set_vfx_clip(id, &Value::object(patch))
    }

    /// `moveVfxClipKeys(id, from, to, {properties})`: every key at `from` (of the named
    /// properties) moved to `to`, refused if any lands on another.
    pub(crate) fn move_vfx_clip_keys(&mut self, id: &Value, from: &Value, to: &Value, options: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let time = js_max(0.0, js_round(to.as_f64().unwrap_or(f64::NAN)));
        if object_is(Some(&Value::Num(time)), Some(from)) {
            return Ok(false);
        }
        let names: Option<Vec<Value>> = options.get("properties").filter(|p| !p.is_null()).map(|p| list(Some(p)));
        let mut table = clip.get("keys").and_then(Value::as_obj).cloned().unwrap_or_default();
        let mut changed = false;
        for (property, channel) in clip.get("keys").and_then(Value::as_obj).map(|k| k.iter().map(|(p, c)| (p.to_string(), c.clone())).collect::<Vec<_>>()).unwrap_or_default() {
            if names.as_ref().is_some_and(|names| !names.iter().any(|n| n.as_str() == Some(property.as_str()))) {
                continue;
            }
            let keys = list(Some(&channel));
            if !keys.iter().any(|k| object_is(k.get("tick"), Some(from))) {
                continue;
            }
            if keys.iter().any(|k| k.get("tick").and_then(Value::as_f64) == Some(time)) {
                return Err(invalid("errors.editorVfxClips.anEffectKeyAlreadyExistsHere"));
            }
            let moved = keys.into_iter().map(|k| if object_is(k.get("tick"), Some(from)) { with(&k, "tick", Value::Num(time)) } else { k }).collect();
            table.set(&property, Value::array(sorted_by_tick(moved)));
            changed = true;
        }
        if !changed {
            return Ok(false);
        }
        let mut patch = Obj::new();
        patch.set("keys", Value::object(table));
        self.set_vfx_clip(id, &Value::object(patch))
    }

    /// `deleteVfxClipKeys(id, tick, {properties})`.
    pub(crate) fn delete_vfx_clip_keys(&mut self, id: &Value, tick: &Value, options: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let names: Option<Vec<Value>> = options.get("properties").filter(|p| !p.is_null()).map(|p| list(Some(p)));
        let mut table = clip.get("keys").and_then(Value::as_obj).cloned().unwrap_or_default();
        let mut changed = false;
        for (property, channel) in clip.get("keys").and_then(Value::as_obj).map(|k| k.iter().map(|(p, c)| (p.to_string(), c.clone())).collect::<Vec<_>>()).unwrap_or_default() {
            let keys = list(Some(&channel));
            if names.as_ref().is_some_and(|names| !names.iter().any(|n| n.as_str() == Some(property.as_str()))) || !keys.iter().any(|k| object_is(k.get("tick"), Some(tick))) {
                continue;
            }
            let next: Vec<Value> = keys.into_iter().filter(|k| !object_is(k.get("tick"), Some(tick))).collect();
            if next.is_empty() {
                table.remove(&property);
            } else {
                table.set(&property, Value::array(next));
            }
            changed = true;
        }
        if !changed {
            return Ok(false);
        }
        let mut patch = Obj::new();
        patch.set("keys", Value::object(table));
        self.set_vfx_clip(id, &Value::object(patch))
    }

    /// `setVfxClipEasing(id, property, tick, interpolation)`.
    pub(crate) fn set_vfx_clip_easing(&mut self, id: &Value, property: &Value, tick: &Value, interpolation: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let property = property.as_str().ok_or_else(|| EditError::Unported("an effect key property that is not text".into()))?.to_string();
        if interpolation.is_null() {
            return Err(EditError::Unported("an effect key easing left out".into()));
        }
        let keys = list(clip.path(&["keys", &property]))
            .into_iter()
            .map(|k| {
                if !object_is(k.get("tick"), Some(tick)) {
                    return k;
                }
                let mut key = Obj::new();
                key.set("tick", k.get("tick").cloned().unwrap_or(Value::Null));
                if let Some(value) = k.get("value") {
                    key.set("value", value.clone());
                }
                key.set("interpolation", interpolation.clone());
                Value::object(key)
            })
            .collect();
        let table = with(clip.get("keys").unwrap_or(&Value::Null), &property, Value::array(keys));
        let mut patch = Obj::new();
        patch.set("keys", table);
        self.set_vfx_clip(id, &Value::object(patch))
    }
}

/// `GENERATOR_DURATIONS[type] ?? 48` (src/vfx-presets.mjs): how many frames a newly added
/// generated effect lasts.
fn generator_duration(kind: &str) -> f64 {
    match kind {
        "aura" | "smoke" => 72.0,
        "explosion" => 36.0,
        _ => 48.0,
    }
}

/// `sampleVfxKeys(keys, tick, fallback, property)` for a channel with keys.
fn sample_channel(keys: &[Value], tick: f64, found: &Descriptor) -> Option<Value> {
    let at = |k: &Value| k.get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let low = keys.partition_point(|k| at(k) <= tick).saturating_sub(1);
    let a = &keys[low];
    let value = a.get("value").cloned().unwrap_or(Value::Null);
    let Some(b) = keys.get(low + 1) else { return Some(value) };
    if tick <= at(a) || found.discrete {
        return Some(value);
    }
    let t = styk_eval::eval::eased_progress(styk_eval::load::easing(Some(a)).as_ref(), (tick - at(a)) / (at(b) - at(a)));
    if found.color {
        let spec = &found.kind.specs()[found.kind.param(&found.param)?];
        let a = styk_eval::vfx::parse::value(spec, &value)?;
        let b = styk_eval::vfx::parse::value(spec, b.get("value")?)?;
        return Some(match styk_eval::vfx::paint::interpolate(&a, &b, t) {
            styk_eval::vfx::ParamValue::Num(value) => Value::Num(value),
            styk_eval::vfx::ParamValue::Paint(paint) => styk_eval::records::paint_record(&paint),
        });
    }
    match (value.as_f64(), b.get("value").and_then(Value::as_f64)) {
        (Some(x), Some(y)) => Some(Value::Num(x + (y - x) * t)),
        _ => None,
    }
}

/// `sampleVfxClip(clip, tick)`: the clip's effects with their keyed parameters at the clip's
/// time; `None` where the registry does not read a keyed parameter.
fn sampled_effects(clip: &Value, tick: f64) -> Option<Value> {
    let number = |key: &str| clip.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let age = js_max(0.0, tick - number("start") + number("offset"));
    let keys = clip.get("keys").and_then(Value::as_obj).cloned().unwrap_or_default();
    let mut effects = Vec::new();
    for effect in list(clip.get("effects")) {
        let mut result = effect.clone();
        for (property, channel) in keys.iter() {
            let found = descriptor(property)?;
            let channel = list(Some(channel));
            if effect.get("id").and_then(Value::as_str) != Some(found.id.as_str()) || channel.is_empty() {
                continue;
            }
            let value = sample_channel(&channel, age, &found)?;
            result = if found.param == "enabled" {
                with(&result, "enabled", Value::Bool(value.truthy()))
            } else {
                let params = with(result.get("params").unwrap_or(&Value::Null), &found.param, value);
                with(&result, "params", params)
            };
        }
        effects.push(result);
    }
    Some(Value::array(effects))
}

impl Editor {
    /// `seeded(effect)`: a generated effect still at the default seed gets one the editor drew.
    fn seeded(&mut self, effect: Value) -> Result<Value, EditError> {
        let generator = effect.get("type").and_then(Value::as_str).and_then(Kind::from_name).is_some_and(Kind::is_generator);
        if !generator || effect.path(&["params", "seed"]).and_then(Value::as_f64) != Some(1.0) {
            return Ok(effect);
        }
        let seed = 1.0 + (self.draw_random()? * 65534.0).floor();
        let params = with(effect.get("params").unwrap_or(&Value::Null), "seed", Value::Num(seed));
        Ok(with(&effect, "params", params))
    }

    /// `createVfxClip`: its identities already drawn in the caller's ordering.
    fn new_vfx_clip(&self, target: Value, kind: &str, id: &str, effect_id: &str, options: &Obj) -> Result<Value, EditError> {
        let mut clip = Obj::new();
        clip.set("id", Value::str(id));
        clip.set("name", Value::str(""));
        let include = if target.get("kind").and_then(Value::as_str) == Some("figure") { options.get("includeAttached").cloned().unwrap_or(Value::Bool(false)) } else { Value::Bool(false) };
        clip.set("target", target);
        clip.set("start", options.get("start").cloned().unwrap_or(Value::Num(0.0)));
        clip.set("duration", options.get("duration").cloned().unwrap_or(Value::Null));
        clip.set("offset", Value::Num(0.0));
        clip.set("enabled", Value::Bool(true));
        clip.set("strength", Value::Num(1.0));
        clip.set("fadeIn", Value::Num(0.0));
        clip.set("fadeOut", Value::Num(0.0));
        clip.set("includeAttached", include);
        clip.set("effects", Value::array(vec![self.create_vfx(kind, effect_id)?]));
        clip.set("keys", Value::object(Obj::new()));
        Ok(Value::object(clip))
    }

    /// `checkScope(editor, clip)` for the newly created figure clip.
    fn check_vfx_clip_scope(&self, clip: &Value) -> Result<(), EditError> {
        if clip.get("includeAttached").is_some_and(Value::truthy) && clip.path(&["target", "kind"]).and_then(Value::as_str) == Some("figure") {
            self.check_connected_vfx(clip.path(&["target", "uid"]).unwrap_or(&Value::Null))?;
        }
        Ok(())
    }

    /// `addVfxClip(target, type, {start, duration, includeAttached})` (`createVfxClip`): a clip
    /// of one effect on `target`, for the whole animation unless timed; a generated effect
    /// starts at the playhead's frame for its usual length. Returns the clip's identity.
    pub(crate) fn add_vfx_clip(&mut self, target: &Value, kind: &Value, options: &Value) -> Result<Value, EditError> {
        let target = normalize_target(target)?;
        let mut options = match options {
            Value::Null => Obj::new(),
            other => other.as_obj().cloned().ok_or_else(|| EditError::Unported("effect clip options that are not an object".into()))?,
        };
        let name = kind.as_str().unwrap_or("");
        let generator = Kind::from_name(name).is_some_and(Kind::is_generator);
        // `generatorTiming`: only when neither the start nor the length is given.
        let timed = generator && options.get("start").is_none() && options.get("duration").is_none();
        if timed { options.set("start", Value::Num(js_max(0.0, self.tick.floor()))); options.set("duration", Value::Num(generator_duration(name))); }
        let id = self.draw_uuid()?;
        let effect_id = self.draw_uuid()?;
        let clip = self.new_vfx_clip(target, name, &id, &effect_id, &options)?;
        let effect = self.seeded(clip.get("effects").and_then(|e| e.item(0)).unwrap_or(Value::Null))?;
        let clip = with(&clip, "effects", Value::array(vec![effect]));
        self.check_vfx_clip_scope(&clip)?;
        let mut clips = self.vfx_clips();
        clips.push(clip);
        self.publish_vfx(clips, "Add effect clip")?;
        Ok(Value::str(&id))
    }

    /// `addVfxGroup(target, preset, options)`: editable built-in effects as one clip.
    pub(crate) fn add_vfx_group(&mut self, target: &Value, name: &Value, options: &Value) -> Result<Value, EditError> {
        let mut effects = Vec::new();
        for effect in self.vfx_preset_effects(name, false)? { effects.push(self.seeded(effect)?); }
        let target = normalize_target(target)?;
        let options = match options { Value::Null => Obj::new(), other => other.as_obj().cloned().ok_or_else(|| EditError::Unported("effect group options that are not an object".into()))? };
        // Current built-in presets contain filters only, so `generatorTiming` keeps options.
        let id = self.draw_uuid()?;
        let effect_id = self.draw_uuid()?;
        let kind = effects.first().and_then(|e| e.get("type")).and_then(Value::as_str).unwrap_or("");
        let clip = self.new_vfx_clip(target, kind, &id, &effect_id, &options)?;
        self.check_vfx_clip_scope(&clip)?;
        let clip = with(&with(&clip, "name", name.clone()), "effects", Value::array(effects));
        let mut clips = self.vfx_clips();
        clips.push(clip);
        self.publish_vfx(clips, "Add effect group")?;
        Ok(Value::str(&id))
    }

    /// `addVfxUserPreset`: fresh identities for the effects and clip; keyed property names
    /// follow them, while the saved settings, timing and raw paint records are preserved.
    pub(crate) fn add_vfx_user_preset(&mut self, target: &Value, preset: &Value, options: &Value) -> Result<Value, EditError> {
        let target = normalize_target(target)?;
        let effects = preset.get("effects").filter(|e| e.is_array()).map(|e| list(Some(e))).filter(|e| !e.is_empty()).ok_or_else(|| EditError::Unported("an effect preset with no effects".into()))?;
        let mut ids = Vec::new();
        for effect in &effects { ids.push((effect.get("id").cloned(), self.draw_uuid()?)); }
        let id = self.draw_uuid()?;
        let unused_effect_id = self.draw_uuid()?;
        let mut create_options = Obj::new();
        create_options.set("includeAttached", Value::Bool(options.get("includeAttached").is_some_and(Value::truthy)));
        let kind = effects[0].get("type").and_then(Value::as_str).unwrap_or("");
        let mut clip = self.new_vfx_clip(target, kind, &id, &unused_effect_id, &create_options)?.as_obj().cloned().unwrap_or_default();
        for field in ["name", "strength", "fadeIn", "fadeOut", "duration", "offset"] {
            match preset.get(field) { Some(value) => clip.set(field, value.clone()), None => { clip.remove(field); } }
        }
        let duration = preset.get("duration");
        let start = if matches!(duration, Some(Value::Null)) { 0.0 } else {
            let wanted = match options.get("start").filter(|s| !s.is_null()) {
                None => self.tick,
                Some(Value::Num(value)) => *value,
                Some(_) => return Err(EditError::Unported("an effect preset start that is not a number".into())),
            };
            js_max(0.0, js_min(wanted.floor(), MAX_TICK - duration.and_then(Value::as_f64).unwrap_or(f64::NAN)))
        };
        clip.set("start", Value::Num(start));
        let fresh = |old: Option<&Value>| ids.iter().rev().find(|(known, _)| object_is(known.as_ref(), old)).map(|(_, id)| id.as_str());
        let mut renamed = Vec::new();
        for effect in effects { renamed.push(with(&effect, "id", Value::str(fresh(effect.get("id")).unwrap_or("")))); }
        let mut keys = Obj::new();
        let channels = preset.get("keys").and_then(Value::as_obj).ok_or_else(|| EditError::Unported("an effect preset without parameter keys".into()))?;
        for (property, channel) in channels.iter() {
            let mut parts = property.split(':').map(str::to_string).collect::<Vec<_>>();
            if parts.len() >= 3 { parts[2] = fresh(Some(&Value::str(&parts[2]))).unwrap_or("").to_string(); }
            keys.set(&parts.join(":"), channel.clone());
        }
        clip.set("effects", Value::array(renamed));
        clip.set("keys", Value::object(keys));
        let clip = Value::object(clip);
        let mut seeded = Vec::new();
        for effect in list(clip.get("effects")) { seeded.push(self.seeded(effect)?); }
        let clip = with(&clip, "effects", Value::array(seeded));
        self.check_vfx_clip_scope(&clip)?;
        let mut clips = self.vfx_clips();
        clips.push(clip);
        self.publish_vfx(clips, "Add effect preset")?;
        Ok(Value::str(&id))
    }

    /// `copyVfxClip(id)`: the clip kept for pasting, with its effects as they are at the playhead.
    pub(crate) fn copy_vfx_clip(&mut self, id: &Value) -> Result<bool, EditError> {
        let clip = self.vfx_clip(id)?;
        let values = sampled_effects(&clip, self.tick);
        self.vfx_clip_clipboard = Some((clip, values));
        Ok(true)
    }

    /// `pasteVfxClip(target, {animation, start})`: the copied clip on `target` with new
    /// identities, its keys (or its effects as they were when copied, without keys); a timed
    /// clip starts at `start` (the playhead's frame). Returns the new clip's identity.
    pub(crate) fn paste_vfx_clip(&mut self, target: &Value, options: &Value) -> Result<Value, EditError> {
        let Some((source, values)) = self.vfx_clip_clipboard.clone() else { return Err(invalid("errors.editorVfxClips.copyAnEffectClipFirst")) };
        let options = options.as_obj().cloned().unwrap_or_default();
        let animation = options.get("animation").is_none_or(Value::truthy);
        let start = options.get("start").cloned().unwrap_or(Value::Num(self.tick.floor()));
        let effects = list(source.get("effects"));
        let mut ids: Vec<(Option<Value>, String)> = Vec::new();
        for effect in &effects {
            ids.push((effect.get("id").cloned(), self.draw_uuid()?));
        }
        let id = self.draw_uuid()?;
        let target = normalize_target(target)?;
        let fresh = |old: Option<&Value>| ids.iter().rev().find(|(k, _)| object_is(k.as_ref(), old)).map(|(_, id)| id.clone());
        let chosen = if animation { effects } else { list(Some(&values.ok_or_else(|| EditError::Unported("effect values copied between paint keys".into()))?)) };
        let mut renamed = Vec::new();
        for effect in &chosen {
            let id = fresh(effect.get("id")).ok_or_else(|| EditError::Unported("copied effect values of an effect the clip does not hold".into()))?;
            renamed.push(with(effect, "id", Value::str(&id)));
        }
        let mut keys = Obj::new();
        if animation {
            for (property, channel) in source.get("keys").and_then(Value::as_obj).cloned().unwrap_or_default().iter() {
                let found = descriptor(property).ok_or_else(|| EditError::Unported("effect keys of an unknown parameter".into()))?;
                let id = fresh(Some(&Value::str(&found.id))).ok_or_else(|| EditError::Unported("effect keys of an effect the clip does not hold".into()))?;
                let (property, _) = property_of(found.kind.name(), &id, &found.param)?;
                keys.set(&property, channel.clone());
            }
        }
        let mut clip = source.as_obj().cloned().unwrap_or_default();
        clip.set("id", Value::str(&id));
        clip.set("target", target);
        clip.set("effects", Value::array(renamed));
        clip.set("keys", Value::object(keys));
        if !matches!(clip.get("duration"), Some(Value::Null)) {
            clip.set("start", start);
        }
        let mut clips = self.vfx_clips();
        clips.push(Value::object(clip));
        self.publish_vfx(clips, if animation { "Paste effect animation" } else { "Paste effect values" })?;
        Ok(Value::str(&id))
    }

    /// `_pasteFigureVfxClips(clips, uidMap, typeMap, shift)`: the effect clips of copied figures on the
    /// pasted ones, with new clip and effect identities; a timed clip moves by `shift` frames, trimmed
    /// where that takes it before the first frame. A figure that kept its identity gets none.
    pub(crate) fn paste_figure_vfx_clips(&mut self, clips: &[Value], uid_map: &[(u32, u32)], type_map: &[(f64, f64)], shift: f64) -> Result<bool, EditError> {
        let mut added = Vec::new();
        for source in clips {
            let old = source.path(&["target", "uid"]).and_then(Value::as_f64);
            let Some(uid) = old.and_then(|old| uid_map.iter().find(|(from, _)| *from as f64 == old)).map(|(_, to)| *to) else { continue };
            if Some(uid as f64) == old {
                continue;
            }
            let effects = list(source.get("effects"));
            let mut ids: Vec<(Option<Value>, String)> = Vec::new();
            for effect in &effects {
                ids.push((effect.get("id").cloned(), self.draw_uuid()?));
            }
            let fresh = |old: Option<&Value>| ids.iter().rev().find(|(k, _)| object_is(k.as_ref(), old)).map(|(_, id)| id.clone());
            let mut target = source.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
            target.set("uid", Value::Num(uid as f64));
            if let Some(figure_type) = target.get("figureTypeId").and_then(Value::as_f64) {
                if let Some((_, to)) = type_map.iter().find(|(from, _)| *from == figure_type) {
                    target.set("figureTypeId", Value::Num(*to));
                }
            }
            let mut keys = Obj::new();
            for (property, channel) in source.get("keys").and_then(Value::as_obj).cloned().unwrap_or_default().iter() {
                let found = descriptor(property).ok_or_else(|| EditError::Unported("effect keys of an unknown parameter".into()))?;
                let id = fresh(Some(&Value::str(&found.id))).ok_or_else(|| EditError::Unported("effect keys of an effect the clip does not hold".into()))?;
                keys.set(&property_of(found.kind.name(), &id, &found.param)?.0, channel.clone());
            }
            let id = self.draw_uuid()?;
            let mut renamed = Vec::new();
            for effect in &effects {
                let id = fresh(effect.get("id")).ok_or_else(|| EditError::Unported("a copied effect without its identity".into()))?;
                renamed.push(with(effect, "id", Value::str(&id)));
            }
            let mut clip = source.as_obj().cloned().unwrap_or_default();
            clip.set("id", Value::str(&id));
            clip.set("target", Value::object(target));
            clip.set("effects", Value::array(renamed));
            clip.set("keys", Value::object(keys));
            if !matches!(clip.get("duration"), Some(Value::Null)) {
                let number = |key: &str| clip.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
                let start = number("start") + shift;
                let cut = js_max(0.0, -start);
                let duration = number("duration");
                if cut >= duration || start + duration > 10_000_000.0 {
                    continue;
                }
                let (offset, fade_in) = (number("offset") + cut, js_max(0.0, number("fadeIn") - cut));
                clip.set("start", Value::Num(start + cut));
                clip.set("offset", Value::Num(offset));
                clip.set("duration", Value::Num(duration - cut));
                clip.set("fadeIn", Value::Num(fade_in));
            }
            added.push(Value::object(clip));
        }
        if added.is_empty() {
            return Ok(false);
        }
        let mut clips = self.vfx_clips();
        clips.extend(added);
        self.publish_vfx(clips, "Paste figure effects")
    }

    /// `duplicateVfxClip(id)`: copied, then pasted on the same target after the clip.
    pub(crate) fn duplicate_vfx_clip(&mut self, id: &Value) -> Result<Value, EditError> {
        self.copy_vfx_clip(id)?;
        let clip = self.vfx_clip(id)?;
        let number = |key: &str| clip.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let start = if matches!(clip.get("duration"), Some(Value::Null)) { 0.0 } else { number("start") + number("duration") };
        let mut options = Obj::new();
        options.set("start", Value::Num(start));
        self.paste_vfx_clip(clip.get("target").unwrap_or(&Value::Null), &Value::object(options))
    }

    /// `addVfxGroupEffect(id, type)`: another effect at the end of the clip's group. Returns
    /// the effect's identity.
    pub(crate) fn add_vfx_group_effect(&mut self, id: &Value, kind: &Value) -> Result<Value, EditError> {
        let clip = self.vfx_clip(id)?;
        let effect_id = self.draw_uuid()?;
        let effect = self.create_vfx(kind.as_str().unwrap_or(""), &effect_id)?;
        let effect = self.seeded(effect)?;
        let mut effects = list(clip.get("effects"));
        effects.push(effect.clone());
        let mut patch = Obj::new();
        patch.set("effects", Value::array(effects));
        self.set_vfx_clip(id, &Value::object(patch))?;
        Ok(effect.get("id").cloned().unwrap_or(Value::Null))
    }
}
