//! Saved effects → typed effects: `validateVfxStack`, `validateVfxOwner` and
//! `validateVfxClips`, read leniently. The editor refuses a project with an
//! invalid effect record; the engine drops the record (an effect, a stack
//! entry, a channel or a clip) and says so in `Document::notes`.

use std::sync::Arc;

use styk_doc::Value;

use super::clips::{Channel, Clip, Clips, Field, Key, Target};
use super::registry::{Kind, ParamKind, ParamValue, Params, Spec};
use super::{paint, Effect, Stacks, StackKey};

/// `VFX_LIMIT`: effects per stack.
pub const STACK_LIMIT: usize = 16;
/// `VFX_CLIP_LIMIT`: clips per document.
pub const CLIP_LIMIT: usize = 4096;
const TIME_LIMIT: f64 = 10_000_000.0;

/// The descriptor of `vfx1:type:id:enabled`.
pub const ENABLED: Spec = Spec { name: "enabled", kind: ParamKind::Toggle, default: 1.0, min: 0.0, max: 1.0 };

/// `/^[a-zA-Z0-9_-]{1,max}$/`, the identities of effects and clips.
fn identity(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `validateVfxValue`: a saved or keyed value of a parameter described by `spec`.
pub fn value(spec: &Spec, v: &Value) -> Option<ParamValue> {
    if spec.kind == ParamKind::Color && matches!(v, Value::Obj(_) | Value::Arr(_) | Value::Nums(_) | Value::Null) {
        // `typeof value === 'object'`: a paint, or nothing valid.
        return paint::normalize(v).map(|p| ParamValue::Paint(Arc::new(p)));
    }
    let n = v.as_f64()?;
    if !n.is_finite() || n < spec.min || n > spec.max || (spec.kind == ParamKind::Color || spec.kind.discrete()) && n.fract() != 0.0 {
        return None;
    }
    Some(ParamValue::Num(n))
}

/// One saved effect record (`{version, id, type, enabled, params}`) resolved:
/// missing parameters take their defaults, and a version 1 outline without
/// `rounded` keeps its square corners.
pub fn effect(v: &Value) -> Result<Effect, String> {
    let invalid = || "an invalid effect record".to_string();
    let version = v.get("version").and_then(Value::as_f64).filter(|n| *n == 1.0 || *n == 2.0).ok_or_else(invalid)?;
    let name = v.get("type").and_then(Value::as_str).ok_or_else(invalid)?;
    let kind = Kind::from_name(name).ok_or_else(|| format!("an unknown effect type {name:?}"))?;
    let id = v.get("id").and_then(Value::as_str).filter(|id| identity(id, 64)).ok_or_else(invalid)?;
    let enabled = v.get("enabled").and_then(Value::as_bool).ok_or_else(invalid)?;
    let saved = v.get("params").and_then(Value::as_obj).ok_or_else(invalid)?;
    if let Some(unknown) = saved.keys().find(|key| kind.param(key).is_none()) {
        return Err(format!("an unknown {name} parameter {unknown:?}"));
    }
    let mut params = Params::defaults(kind);
    for (i, spec) in kind.specs().iter().enumerate() {
        let Some(raw) = saved.get(spec.name).filter(|raw| !raw.is_null()) else { continue };
        let resolved = value(spec, raw).ok_or_else(|| format!("an invalid {name} {}", spec.name))?;
        if !params.set(i, &resolved) {
            return Err(format!("an invalid {name} {}", spec.name));
        }
    }
    if version == 1.0 && kind == Kind::Outline && saved.get("rounded").is_none() {
        let rounded = kind.param("rounded").expect("outlines have rounded corners");
        params.set(rounded, &ParamValue::Num(0.0));
    }
    Ok(Effect { id: Arc::from(id), enabled, params })
}

/// A saved stack (`validateVfxStack`): its valid effects, in order. Repeated
/// identities, more than [`STACK_LIMIT`] effects and invalid records are noted.
pub fn stack(v: &Value, notes: &mut Vec<String>) -> Vec<Arc<Effect>> {
    let Some(items) = v.as_arr() else {
        if !v.is_array() || v.array_len() != Some(0) {
            notes.push("an effect stack that is not a list was ignored".into());
        }
        return Vec::new();
    };
    if items.len() > STACK_LIMIT {
        notes.push(format!("an effect stack holds {} effects, more than the editor's {STACK_LIMIT}", items.len()));
    }
    let mut out: Vec<Arc<Effect>> = Vec::with_capacity(items.len());
    for item in items {
        match effect(item) {
            Ok(effect) if out.iter().any(|other| other.id == effect.id) => notes.push(format!("a repeated effect identity {:?} was ignored", &*effect.id)),
            Ok(effect) => out.push(Arc::new(effect)),
            Err(why) => notes.push(format!("{why} was ignored")),
        }
    }
    out
}

fn stack_key(key: &str) -> Option<StackKey> {
    if key == "figure" {
        return Some(StackKey::Figure);
    }
    let (scope, handle) = key.split_once('/')?;
    let positive = |text: &str| -> Option<u32> {
        if text.is_empty() || text.starts_with('0') || !text.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    };
    let figure_type = if scope == "*" { None } else { Some(positive(scope)?) };
    Some(StackKey::Segment { figure_type, handle: positive(handle)? })
}

/// The per-pose stacks of a pose or scene (`_stykVfx`, `validateVfxOwner`).
/// `None` when absent; any other value counts as present (`documentHasVfx`),
/// even when it holds no valid stack. Generated effects never belong in a pose.
pub fn stacks(v: Option<&Value>, notes: &mut Vec<String>) -> Option<Arc<Stacks>> {
    let v = v.filter(|v| v.truthy())?;
    let Some(owner) = v.as_obj() else {
        notes.push("per-pose effects that are not a table were ignored".into());
        return Some(Arc::new(Stacks::default()));
    };
    let mut entries = Vec::with_capacity(owner.len());
    for (key, value) in owner.iter() {
        let Some(key) = stack_key(key) else {
            notes.push(format!("per-pose effects for {key:?}, which names no figure or node, were ignored"));
            continue;
        };
        let mut effects = stack(value, notes);
        if effects.iter().any(|e| e.kind().is_generator()) {
            notes.push("generated effects in a pose, which belong on the effects timeline, were ignored".into());
            effects.retain(|e| !e.kind().is_generator());
        }
        entries.push((key, Arc::from(effects)));
    }
    Some(Arc::new(Stacks { entries }))
}

/// `vfxDescriptor` of a key channel: the effect type and identity, and what it animates.
pub fn property(name: &str) -> Option<(Kind, &str, Field)> {
    let mut parts = name.split(':');
    let (prefix, kind, id, param) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if prefix != "vfx1" || parts.next().is_some() || !identity(id, 64) {
        return None;
    }
    let kind = Kind::from_name(kind)?;
    let field = if param == "enabled" { Field::Enabled } else { Field::Param(kind.param(param)?) };
    Some((kind, id, field))
}

fn integer(v: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    v?.as_f64().filter(|n| n.fract() == 0.0 && *n >= min && *n <= max)
}

fn clip(v: &Value) -> Result<Clip, String> {
    let id = v.get("id").and_then(Value::as_str).filter(|id| identity(id, 80)).ok_or("an effect clip without a valid identity")?;
    let what = |problem: &str| format!("effect clip {id:?}: {problem}");
    let t = v.get("target").filter(|t| t.is_object()).ok_or_else(|| what("no target"))?;
    let uid = || integer(t.get("uid"), 0.0, u32::MAX as f64).map(|n| n as u32).ok_or_else(|| what("an invalid target"));
    let target = match t.get("kind").and_then(Value::as_str) {
        Some("scene") => Target::Scene,
        Some("figure") => Target::Figure { uid: uid()? },
        Some("segment") => Target::Segment {
            uid: uid()?,
            handle: integer(t.get("handleId"), 1.0, 65535.0).ok_or_else(|| what("an invalid node"))? as u32,
            figure_type: match t.get("figureTypeId") {
                None => None,
                Some(scope) => Some(integer(Some(scope), 1.0, u32::MAX as f64).ok_or_else(|| what("an invalid figure type"))? as u32),
            },
        },
        _ => return Err(what("an invalid target")),
    };
    let timing = |key: &str| integer(v.get(key), 0.0, TIME_LIMIT).ok_or_else(|| what("invalid timing"));
    let (start, offset, fade_in, fade_out) = (timing("start")?, timing("offset")?, timing("fadeIn")?, timing("fadeOut")?);
    let duration = match v.get("duration") {
        Some(Value::Null) if start == 0.0 && offset == 0.0 => None,
        Some(d) => Some(integer(Some(d), 1.0, TIME_LIMIT - start).ok_or_else(|| what("invalid timing"))?),
        None => return Err(what("invalid timing")),
    };
    let strength = v.get("strength").and_then(Value::as_f64).filter(|s| (0.0..=1.0).contains(s)).ok_or_else(|| what("an invalid strength"))?;
    let enabled = v.get("enabled").and_then(Value::as_bool).ok_or_else(|| what("an invalid switch"))?;
    let include_attached = v.get("includeAttached").and_then(Value::as_bool).ok_or_else(|| what("an invalid switch"))?;
    if !v.get("name").is_some_and(|n| n.as_str().is_some_and(|n| n.encode_utf16().count() <= 120)) {
        return Err(what("an invalid name"));
    }
    let items = v.get("effects").and_then(Value::as_arr).ok_or_else(|| what("no effects"))?;
    if items.len() > STACK_LIMIT {
        return Err(what("too many effects"));
    }
    let mut effects: Vec<Arc<Effect>> = Vec::with_capacity(items.len());
    for item in items {
        let effect = effect(item).map_err(|why| what(&why))?;
        if effects.iter().any(|other| other.id == effect.id) {
            return Err(what("a repeated effect identity"));
        }
        effects.push(Arc::new(effect));
    }
    let table = v.get("keys").and_then(Value::as_obj).ok_or_else(|| what("invalid keys"))?;
    if table.len() > 512 {
        return Err(what("too many keyed properties"));
    }
    let mut channels = Vec::with_capacity(table.len());
    for (name, list) in table.iter() {
        let invalid = || what(&format!("invalid keys for {name:?}"));
        let (kind, effect_id, field) = property(name).ok_or_else(invalid)?;
        let index = effects.iter().position(|e| &*e.id == effect_id && e.kind() == kind).ok_or_else(invalid)?;
        let spec = match field {
            Field::Enabled => ENABLED,
            Field::Param(i) => kind.specs()[i],
        };
        let entries = list.as_arr().ok_or_else(invalid)?;
        if entries.len() > 100_000 {
            return Err(invalid());
        }
        let mut keys = Vec::with_capacity(entries.len());
        let mut previous = -1.0;
        for entry in entries {
            let tick = integer(entry.get("tick"), 0.0, TIME_LIMIT).filter(|tick| *tick > previous).ok_or_else(invalid)?;
            previous = tick;
            let value = entry.get("value").and_then(|raw| value(&spec, raw)).ok_or_else(invalid)?;
            keys.push(Key { tick, value, easing: crate::load::easing(Some(entry)).unwrap_or(crate::doc::Easing::LINEAR) });
        }
        if !keys.is_empty() {
            channels.push(Channel { effect: index, field, discrete: spec.kind.discrete(), color: spec.kind == ParamKind::Color, keys: keys.into() });
        }
    }
    Ok(Clip { id: Arc::from(id), target, start, duration, offset, enabled, strength, fade_in, fade_out, include_attached, effects, channels })
}

/// `_styk.vfxClips` (`{version: 1, clips}`): its valid clips, indexed. `None`
/// when there are none.
pub fn clips(v: Option<&Value>, notes: &mut Vec<String>) -> Option<Arc<Clips>> {
    let v = v?;
    let Some(items) = v.get("clips").and_then(Value::as_arr).filter(|_| v.get("version").and_then(Value::as_f64) == Some(1.0)) else {
        if !v.get("clips").is_some_and(|c| c.array_len() == Some(0)) {
            notes.push("an effects timeline the editor would refuse was ignored".into());
        }
        return None;
    };
    if items.len() > CLIP_LIMIT {
        notes.push(format!("{} effect clips, more than the editor's {CLIP_LIMIT}", items.len()));
    }
    let mut out: Vec<Arc<Clip>> = Vec::with_capacity(items.len());
    for item in items {
        match clip(item) {
            Ok(clip) if out.iter().any(|other| other.id == clip.id) => notes.push(format!("a repeated effect clip {:?} was ignored", &*clip.id)),
            Ok(clip) => out.push(Arc::new(clip)),
            Err(why) => notes.push(format!("{why}; the clip was ignored")),
        }
    }
    (!out.is_empty()).then(|| Arc::new(Clips::new(out)))
}

/// `isVfxProperty`: a property channel of effects.
pub fn is_vfx_property(name: &str) -> bool {
    name == "vfxScope" || name == "vfxStack" || name.starts_with("vfx1:")
}
