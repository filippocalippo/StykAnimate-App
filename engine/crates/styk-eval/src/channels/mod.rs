//! Property channels (`_styk.animation`, validated by src/animation-channels.mjs): sparse keyed curves laid over the native timeline.
//!
//! A channel animates one property of one target with its own keys and curves:
//! a figure's pose, position, scale, rotation, colour, opacity, outline and depth,
//! a segment's or polygon's style, the camera, the scene's background and pose, a
//! layer's pose, and the parameters, stacks and scope of effects. The native
//! evaluation runs first; pose channels then replace whole figures and layers with
//! poses sampled from their own key tracks ([`pose::compose`], `composePoseChannels`),
//! and scalar channels set properties on the result ([`scalar::compose`],
//! `composeAnimationChannels`). On a layer sheet the channels are the
//! `legacyAnimation` its imported keys sample (`legacySheetReport`).
//!
//! Arithmetic is the editor's, operation for operation (`sampleAnimationChannel`,
//! `sampleNativePropertyCurve`, `autoValue`); stored values a gesture could capture go
//! through `styk-math` where the editor uses trigonometry (D16).

pub mod pose;
pub mod scalar;

use std::sync::Arc;

use styk_doc::Value;

use crate::doc::{Easing, EasingMode, Paint};
use crate::eval::{auto_value, eased_progress, Seq};
use crate::vfx::registry::{Kind, ParamKind, ParamValue, Spec};
use crate::vfx::{Effect, Field};

/// The channels of a document, in saved order.
#[derive(Clone, Debug, Default)]
pub struct Animation {
    pub channels: Vec<Channel>,
    /// `animationEndTick`: where the last visible key's frame ends (or a movieclip
    /// curve's `clipEnd`); the native timeline lasts at least this long.
    pub end: f64,
    /// A channel animates effects (`isVfxProperty`).
    pub vfx: bool,
    /// Some channel is a pose channel.
    pub poses: bool,
    /// Some channel is not a pose channel.
    pub scalars: bool,
}

/// What a channel animates (`normalizeAnimationTarget`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Figure { uid: u32 },
    /// A segment by handle; with a figure type, only on instances of that type.
    Segment { uid: u32, handle: u32, figure_type: Option<u32> },
    /// A polygon by its identity (`polyfill_id`, else index + 1) on one figure type.
    Polygon { uid: u32, polygon: u32, figure_type: u32 },
    Camera,
    Scene,
    Layer { id: Arc<str> },
}

impl Target {
    pub fn uid(&self) -> Option<u32> {
        match self {
            Target::Figure { uid } | Target::Segment { uid, .. } | Target::Polygon { uid, .. } => Some(*uid),
            _ => None,
        }
    }
}

/// The animated property (`ANIMATION_PROPERTIES`, and effect properties).
#[derive(Clone, Debug, PartialEq)]
pub enum Property {
    Pose,
    X,
    Y,
    Scale,
    Rotation,
    Color,
    Opacity,
    OutlineColor,
    OutlineWidth,
    OutlineOpacity,
    ZIndex,
    Thickness,
    GradientColor,
    GradientOpacity,
    Paint,
    BackgroundId,
    /// `vfxScope`: the figure's stack covers its attached figures.
    VfxScope,
    /// `vfxStack`: the whole stack of the target.
    VfxStack,
    /// `vfx1:<type>:<id>:<param>`: one parameter (or `enabled`) of the effect `id`.
    Vfx { kind: Kind, id: Arc<str>, field: Field },
}

impl Property {
    fn parse(name: &str) -> Option<Property> {
        Some(match name {
            "pose" => Property::Pose,
            "x" => Property::X,
            "y" => Property::Y,
            "scale" => Property::Scale,
            "rotation" => Property::Rotation,
            "color" => Property::Color,
            "opacity" => Property::Opacity,
            "outlineColor" => Property::OutlineColor,
            "outlineWidth" => Property::OutlineWidth,
            "outlineOpacity" => Property::OutlineOpacity,
            "zIndex" => Property::ZIndex,
            "thickness" => Property::Thickness,
            "gradientColor" => Property::GradientColor,
            "gradientOpacity" => Property::GradientOpacity,
            "paint" => Property::Paint,
            "backgroundId" => Property::BackgroundId,
            "vfxScope" => Property::VfxScope,
            "vfxStack" => Property::VfxStack,
            _ => {
                let (kind, id, field) = crate::vfx::parse::property(name)?;
                Property::Vfx { kind, id: Arc::from(id), field }
            }
        })
    }

    /// `isVfxProperty`.
    pub fn is_vfx(&self) -> bool {
        matches!(self, Property::VfxScope | Property::VfxStack | Property::Vfx { .. })
    }

    /// The descriptor of an effect parameter (`vfxDescriptor`), for `vfx1:` properties.
    fn spec(&self) -> Option<Spec> {
        match self {
            Property::Vfx { kind, field: Field::Param(i), .. } => Some(kind.specs()[*i]),
            Property::Vfx { field: Field::Enabled, .. } => Some(crate::vfx::parse::ENABLED),
            Property::VfxScope => Some(SCOPE),
            _ => None,
        }
    }

    /// `isDiscreteAnimationProperty`: the value holds until the next key.
    pub fn discrete(&self) -> bool {
        match self {
            Property::BackgroundId | Property::ZIndex | Property::Paint | Property::VfxStack => true,
            _ => self.spec().is_some_and(|spec| spec.kind.discrete()),
        }
    }

    /// `isColorAnimationProperty`.
    pub fn color(&self) -> bool {
        matches!(self, Property::Color | Property::OutlineColor | Property::GradientColor) || self.spec().is_some_and(|spec| spec.kind == ParamKind::Color)
    }

    /// `supportsAnimationProperty`.
    fn supported_on(&self, target: &Target) -> bool {
        use Property::*;
        match target {
            Target::Figure { .. } => {
                matches!(self, X | Y | Scale | Rotation | Color | Opacity | OutlineColor | OutlineWidth | OutlineOpacity | ZIndex | Pose | VfxScope | VfxStack | Vfx { .. })
            }
            Target::Segment { .. } => matches!(self, Color | Opacity | Thickness | GradientColor | GradientOpacity | Paint | ZIndex | VfxStack | Vfx { .. }),
            Target::Polygon { .. } => matches!(self, Color | Opacity | ZIndex),
            Target::Camera => matches!(self, Pose | X | Y | Scale | Rotation),
            Target::Scene => matches!(self, Pose | BackgroundId | Color | VfxStack | Vfx { .. }),
            Target::Layer { .. } => matches!(self, Pose),
        }
    }
}

/// The descriptor of `vfxScope` (`vfxDescriptor('vfxScope')`).
const SCOPE: Spec = Spec { name: "vfxScope", kind: ParamKind::Toggle, default: 0.0, min: 0.0, max: 1.0 };

/// A key's value, as validated (`validateAnimationValue`).
#[derive(Clone, Debug, PartialEq)]
pub enum KeyValue {
    Num(f64),
    /// A scene colour key of `null`: control returns to the background track.
    Null,
    /// A segment's fill style (`paint`), normalized as style overlays are.
    Paint(Option<Arc<Paint>>),
    /// A whole effect stack (`vfxStack`).
    Stack(Arc<[Arc<Effect>]>),
    /// An effect colour given as a paint.
    Param(ParamValue),
    /// A pose key's source frame (`{frameId}`; `None` for an empty pose).
    Pose(Option<Arc<str>>),
}

impl KeyValue {
    /// The number a numeric curve reads (`key.value`).
    fn number(&self) -> f64 {
        match self {
            KeyValue::Num(n) | KeyValue::Param(ParamValue::Num(n)) => *n,
            _ => f64::NAN,
        }
    }
}

/// How the editor resamples an imported figure curve (`nativeValueMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeValue {
    /// Colour bytes interpolated as Pivot does (`color_tween`).
    Color,
    /// Opacity through Pivot's transparency byte.
    Opacity,
}

/// One key (`{id, tick, value, interpolation, bezier, …}`).
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub tick: f64,
    pub value: KeyValue,
    /// The outgoing curve; `None` when the key has no `interpolation` (a pose key then
    /// keeps its source frame's easing, any other key is linear).
    pub easing: Option<Easing>,
    pub hidden: bool,
    /// The interval from this key holds the property's base value (`passthrough`).
    pub passthrough: bool,
    /// `nativeCurve === 'pchip'`: Pivot's monotone cubic across the run of such keys.
    pub pchip: bool,
    /// `nativeRotation`: angles unwrap along the shortest turn.
    pub native_rotation: bool,
    pub native_value: Option<NativeValue>,
}

impl Key {
    fn mode(&self) -> EasingMode {
        self.easing.map_or(EasingMode::Linear, |e| e.mode)
    }
}

/// One channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    pub target: Target,
    pub property: Property,
    /// Ordered by tick (a hidden pose key may share its tick with a visible one).
    pub keys: Arc<[Key]>,
    /// `nativeProperties`: a pose track that keeps the native appearance (scale,
    /// transparency, colour, depth and outline) of the figures it replaces.
    pub native_properties: bool,
    /// `maskedRanges`: `[start, end)` spans where the pose track shows nothing.
    pub masked: Arc<[(f64, f64)]>,
    /// `useBasePose`: the pose is the native evaluation's own.
    pub use_base_pose: bool,
    /// `orderAnchor`: the figure this one is stacked right after.
    pub order_anchor: Option<u32>,
    /// `clipEnd`: a movieclip curve's end, which the timeline reaches.
    pub clip_end: Option<f64>,
}

/// What [`Channel::sample_at`] found: a key's own value, or one worked out between two keys.
#[derive(Clone, Debug, PartialEq)]
pub enum Sampled {
    /// The value key `index` holds (`a.value`), as saved.
    Key(usize),
    /// A value interpolated between keys.
    Value(KeyValue),
}

impl Channel {
    /// `sampleAnimationChannel`: the value at `tick`, or `None` where the channel does
    /// not control the property (before its first key, inside a passthrough interval).
    pub fn sample(&self, tick: f64) -> Option<KeyValue> {
        Some(match self.sample_at(tick)? {
            Sampled::Key(index) => self.keys[index].value.clone(),
            Sampled::Value(value) => value,
        })
    }

    /// [`Channel::sample`], telling a key's own value (which a record takes as saved) from
    /// one interpolated between keys.
    pub fn sample_at(&self, tick: f64) -> Option<Sampled> {
        let keys = &*self.keys;
        if keys.is_empty() || tick.is_nan() || tick < keys[0].tick {
            return None;
        }
        let low = keys.partition_point(|key| key.tick <= tick) - 1;
        let a = &keys[low];
        let b = keys.get(low + 1);
        if a.passthrough {
            return None;
        }
        let Some(b) = b else { return Some(Sampled::Key(low)) };
        if b.passthrough || a.tick == tick || self.property == Property::Pose || self.property.discrete() {
            return Some(Sampled::Key(low));
        }
        let fraction = (tick - a.tick) / (b.tick - a.tick);
        let auto = a.mode() == EasingMode::Auto;
        let t = if auto { fraction } else { eased_progress(Some(&a.easing.unwrap_or(Easing::LINEAR)), fraction) };
        if a.pchip {
            return Some(Sampled::Value(KeyValue::Num(native_curve(keys, low, t, a.native_rotation))));
        }
        // `value(get)`: a straight or Auto interpolation of one number the keys hold.
        let value = |get: &dyn Fn(&Key) -> f64| -> f64 {
            if !auto {
                return get(a) + (get(b) - get(a)) * t;
            }
            let neighbour = |key: Option<&Key>, duration: f64| match key {
                Some(key) if !key.passthrough && key.value != KeyValue::Null => Some((get(key), duration)),
                _ => None,
            };
            let previous = low.checked_sub(1).map(|i| &keys[i]).filter(|k| k.mode() == EasingMode::Auto);
            let following = keys.get(low + 2).filter(|_| b.mode() == EasingMode::Auto);
            auto_value(
                get(a),
                get(b),
                t,
                b.tick - a.tick,
                neighbour(previous, previous.map_or(f64::NAN, |p| a.tick - p.tick)),
                neighbour(following, following.map_or(f64::NAN, |f| f.tick - b.tick)),
            )
        };
        if self.property.color() {
            if self.property.is_vfx() {
                let param = |key: &Key| match &key.value {
                    KeyValue::Param(value) => value.clone(),
                    other => ParamValue::Num(other.number()),
                };
                return Some(Sampled::Value(KeyValue::Param(crate::vfx::paint::interpolate(&param(a), &param(b), t))));
            }
            // A `null` scene colour returns control to the background track; it is not
            // an ARGB zero to interpolate towards.
            if a.value == KeyValue::Null || b.value == KeyValue::Null {
                return Some(Sampled::Key(low));
            }
            let (av, bv) = (js_uint32(a.value.number()), js_uint32(b.value.number()));
            if a.native_value == Some(NativeValue::Color) && !auto {
                return Some(Sampled::Value(KeyValue::Num(crate::eval::color_tween(av, bv, t) as f64)));
            }
            let mut out = 0u32;
            for shift in (0..32).step_by(8) {
                let byte = crate::vfx::paint::js_round(value(&|key: &Key| ((js_uint32(key.value.number()) >> shift) & 255) as f64));
                out |= (js_int32(byte) as u32) << shift;
            }
            return Some(Sampled::Value(KeyValue::Num(out as f64)));
        }
        if a.native_value == Some(NativeValue::Opacity) && !auto {
            let byte = |opacity: f64| crate::vfx::paint::js_round((1.0 - opacity) * 255.0);
            let (av, bv) = (byte(a.value.number()), byte(b.value.number()));
            return Some(Sampled::Value(KeyValue::Num(1.0 - (av + ((bv - av) * t).trunc()) / 255.0)));
        }
        if a.native_rotation {
            let (start, next) = (a.value.number(), b.value.number());
            let end = start + shortest_property_angle(next - start);
            if !auto {
                return Some(Sampled::Value(KeyValue::Num(start + (end - start) * t)));
            }
            let previous = low.checked_sub(1).map(|i| &keys[i]).filter(|k| k.mode() == EasingMode::Auto);
            let following = keys.get(low + 2).filter(|_| b.mode() == EasingMode::Auto);
            return Some(Sampled::Value(KeyValue::Num(auto_value(
                start,
                end,
                t,
                b.tick - a.tick,
                previous.map(|p| (start - shortest_property_angle(start - p.value.number()), a.tick - p.tick)),
                following.map(|f| (end + shortest_property_angle(f.value.number() - next), f.tick - b.tick)),
            ))));
        }
        Some(Sampled::Value(KeyValue::Num(value(&|key: &Key| key.value.number()))))
    }
}

/// `Number(value) >>> 0` for the integers colour keys hold.
fn js_uint32(value: f64) -> u32 {
    if value.is_finite() { value.trunc().rem_euclid(4294967296.0) as u32 } else { 0 }
}

/// `value | 0`, for the rounded bytes of a colour (always 0–255 here).
fn js_int32(value: f64) -> i32 {
    js_uint32(value) as i32
}

/// `shortestPropertyAngle`: an angle in [-π, π).
pub fn shortest_property_angle(angle: f64) -> f64 {
    use std::f64::consts::{PI, TAU};
    ((angle + PI) % TAU + TAU) % TAU - PI
}

/// `Math.sign(a) !== Math.sign(b)`: NaN differs from everything.
fn signs_differ(a: f64, b: f64) -> bool {
    let sign = |v: f64| if v > 0.0 { 1 } else if v < 0.0 { -1 } else { 0 };
    a.is_nan() || b.is_nan() || sign(a) != sign(b)
}

/// `sampleNativePropertyCurve`: Pivot's monotone cubic through the run of `pchip` keys
/// around the interval `index`, at eased progress `t`.
fn native_curve(keys: &[Key], index: usize, t: f64, angular: bool) -> f64 {
    let (mut left, mut right) = (index, index + 1);
    while left > 0 && keys[left].tick - keys[left - 1].tick > 1.0 && keys[left - 1].pchip {
        left -= 1;
    }
    while right < keys.len() - 1 && keys[right + 1].tick - keys[right].tick > 1.0 && keys[right].pchip {
        right += 1;
    }
    let mut values = vec![keys[left].value.number()];
    let mut times = vec![0.0];
    for key in &keys[left + 1..=right] {
        times.push(key.tick - keys[left].tick);
        let last = *values.last().unwrap();
        values.push(if angular { last + shortest_property_angle(key.value.number() - last) } else { key.value.number() });
    }
    let (j, n) = (index - left, values.len());
    if n < 3 {
        return values[j] + (values[j + 1] - values[j]) * t;
    }
    let h: Vec<f64> = (0..n - 1).map(|i| times[i + 1] - times[i]).collect();
    let d: Vec<f64> = (0..n - 1).map(|i| (values[i + 1] - values[i]) / h[i]).collect();
    let endpoint = |h0: f64, h1: f64, d0: f64, d1: f64| -> f64 {
        let mut m = ((2.0 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if signs_differ(m, d0) {
            return 0.0;
        }
        if signs_differ(d0, d1) && m.abs() > 3.0 * d0.abs() {
            m = 3.0 * d0;
        }
        m
    };
    let falsy = |v: f64| v == 0.0 || v.is_nan();
    let slope = |i: usize| -> f64 {
        if i == 0 {
            return endpoint(h[0], h[1], d[0], d[1]);
        }
        if i == n - 1 {
            return endpoint(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
        }
        if falsy(d[i - 1]) || falsy(d[i]) || signs_differ(d[i - 1], d[i]) {
            return 0.0;
        }
        let w = (2.0 * h[i - 1] + h[i]) / (3.0 * (h[i - 1] + h[i]));
        d[i - 1] * d[i] / (w * d[i - 1] + (1.0 - w) * d[i])
    };
    let (t2, t3) = (t * t, t * t * t);
    (2.0 * t3 - 3.0 * t2 + 1.0) * values[j] + (t3 - 2.0 * t2 + t) * h[j] * slope(j) + (3.0 * t2 - 2.0 * t3) * values[j + 1] + (t3 - t2) * h[j] * slope(j + 1)
}

/// The channels as evaluation uses them: each pose channel's key track as a native
/// timeline of its source poses (`buildVirtualPoseTrack`), built once per document.
#[derive(Debug)]
pub struct Compiled {
    pub animation: Arc<Animation>,
    /// By channel: the pose track of a pose channel.
    pub tracks: Vec<Option<Seq>>,
}

impl Compiled {
    pub fn new(doc: &crate::doc::Document, animation: &Arc<Animation>) -> Compiled {
        let tracks = animation.channels.iter().map(|channel| (channel.property == Property::Pose).then(|| pose::track(doc, channel))).collect();
        Compiled { animation: animation.clone(), tracks }
    }

    /// The frame with every channel applied at `tick`: pose channels, then the others.
    pub fn compose(&self, doc: &crate::doc::Document, frame: crate::eval::Frame, tick: f64) -> crate::eval::Frame {
        let frame = if self.animation.poses { pose::compose(doc, self, frame, tick) } else { frame };
        if self.animation.scalars { scalar::compose(doc, &self.animation, frame, tick) } else { frame }
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// A whole number in `min..=max`.
fn whole(v: Option<&Value>, min: f64, max: f64) -> Option<u32> {
    v?.as_f64().filter(|n| n.fract() == 0.0 && *n >= min && *n <= max).map(|n| n as u32)
}

fn target(v: &Value) -> Result<Target, &'static str> {
    let uid = || whole(v.get("uid"), 0.0, u32::MAX as f64).ok_or("a figure target without a figure identity");
    Ok(match v.get("kind").and_then(Value::as_str) {
        Some("figure") => Target::Figure { uid: uid()? },
        Some("segment") => Target::Segment {
            uid: uid()?,
            handle: whole(v.get("handleId"), 1.0, 65535.0).ok_or("a segment target without a segment handle")?,
            figure_type: match v.get("figureTypeId") {
                None => None,
                Some(scope) => Some(whole(Some(scope), 1.0, 9007199254740991.0).ok_or("a segment target with an invalid figure type")?),
            },
        },
        Some("polygon") => Target::Polygon {
            uid: uid()?,
            polygon: whole(v.get("polygonId"), 1.0, 65535.0).ok_or("a polygon target without a polygon identity")?,
            figure_type: whole(v.get("figureTypeId"), 1.0, 9007199254740991.0).ok_or("a polygon target without a figure type")?,
        },
        Some("camera") => Target::Camera,
        Some("scene") => Target::Scene,
        Some("layer") => Target::Layer { id: v.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(Arc::from).ok_or("a layer target without a layer")? },
        _ => return Err("a channel without a figure, segment, polygon, layer, camera or scene"),
    })
}

/// `validateAnimationValue`, leniently: `None` where the editor would refuse the value.
fn value(target: &Target, property: &Property, v: Option<&Value>, notes: &mut Vec<String>) -> Option<KeyValue> {
    let v = v.unwrap_or(&Value::Null);
    match property {
        Property::Pose => match v {
            Value::Null => Some(KeyValue::Pose(None)),
            _ => match v.get("frameId") {
                Some(Value::Null) => Some(KeyValue::Pose(None)),
                Some(Value::Str(id)) if !id.is_empty() => Some(KeyValue::Pose(Some(id.clone()))),
                _ => None,
            },
        },
        Property::VfxStack => v.is_array().then(|| KeyValue::Stack(Arc::from(crate::vfx::parse::stack(v, notes)))),
        Property::Paint => crate::load::paint(Some(v)).map(|paint| KeyValue::Paint(Some(paint))),
        Property::Color if *target == Target::Scene && v.is_null() => Some(KeyValue::Null),
        _ => {
            if let Some(spec) = property.spec() {
                return match crate::vfx::parse::value(&spec, v)? {
                    ParamValue::Num(n) => Some(KeyValue::Num(n)),
                    paint => Some(KeyValue::Param(paint)),
                };
            }
            v.as_f64().filter(|n| n.is_finite()).map(KeyValue::Num)
        }
    }
}

fn key(target: &Target, property: &Property, v: &Value, notes: &mut Vec<String>) -> Result<Key, &'static str> {
    let tick = num(v, "tick").filter(|t| t.is_finite()).ok_or("a key without a valid time")?;
    let value = value(target, property, v.get("value"), notes).ok_or("a key with an invalid value")?;
    let flag = |name: &str| matches!(v.get(name), Some(Value::Bool(true)));
    Ok(Key {
        tick,
        value,
        easing: if v.get("interpolation").is_some() { crate::load::easing(Some(v)) } else { None },
        hidden: flag("hidden") && *property == Property::Pose,
        passthrough: flag("passthrough") && *property != Property::Pose,
        pchip: v.get("nativeCurve").and_then(Value::as_str) == Some("pchip") && matches!(property, Property::X | Property::Y | Property::Scale | Property::Rotation),
        native_rotation: flag("nativeRotation") && *property == Property::Rotation,
        native_value: match (v.get("nativeValueMode").and_then(Value::as_str), target, property) {
            (Some("color"), Target::Figure { .. }, Property::Color) => Some(NativeValue::Color),
            (Some("opacity"), Target::Figure { .. }, Property::Opacity) => Some(NativeValue::Opacity),
            _ => None,
        },
    })
}

pub(crate) fn channel(v: &Value, notes: &mut Vec<String>) -> Result<Channel, String> {
    read_channel(v, notes, true)
}

/// Live editor draft: only finalized key ordering is deferred.
pub(crate) fn draft_channel(v: &Value, notes: &mut Vec<String>) -> Result<Channel, String> {
    read_channel(v, notes, false)
}

fn read_channel(v: &Value, notes: &mut Vec<String>, ordered: bool) -> Result<Channel, String> {
    let target = target(v.get("target").unwrap_or(&Value::Null))?;
    let name = v.get("property").and_then(Value::as_str).unwrap_or("");
    let property = Property::parse(name).filter(|p| p.supported_on(&target)).ok_or_else(|| format!("a channel of {name:?}, which cannot animate on its target"))?;
    let items = v.get("keys").and_then(Value::as_arr).ok_or("a channel without keys")?;
    let mut keys = Vec::with_capacity(items.len());
    for item in items {
        let key = key(&target, &property, item, notes)?;
        if ordered && keys.last().is_some_and(|last: &Key| key.tick < last.tick) {
            return Err("a channel whose keys are not in order".into());
        }
        keys.push(key);
    }
    let pose = property == Property::Pose;
    let masked: Vec<(f64, f64)> = match v.get("maskedRanges").filter(|_| pose) {
        Some(ranges) => ranges.elements().map(|items| items.iter().filter_map(|range| range.numbers().filter(|r| r.len() == 2).map(|r| (r[0], r[1]))).collect()).unwrap_or_default(),
        None => Vec::new(),
    };
    let figure = matches!(target, Target::Figure { .. });
    Ok(Channel {
        native_properties: pose && matches!(v.get("nativeProperties"), Some(Value::Bool(true))),
        use_base_pose: pose && figure && matches!(v.get("useBasePose"), Some(Value::Bool(true))),
        order_anchor: if pose && figure { whole(v.get("orderAnchor"), 0.0, u32::MAX as f64) } else { None },
        clip_end: if pose && figure { num(v, "clipEnd") } else { None },
        masked: masked.into(),
        target,
        property,
        keys: keys.into(),
    })
}

/// Reads `_styk.animation` (or a layer sheet's `legacyAnimation`). A channel the editor
/// would refuse is left out and named in `notes`; `None` when no channel remains.
pub fn parse(v: Option<&Value>, notes: &mut Vec<String>) -> Option<Arc<Animation>> {
    let items = v?.get("channels")?.as_arr()?;
    let mut channels = Vec::with_capacity(items.len());
    for item in items {
        match channel(item, notes) {
            Ok(channel) => channels.push(channel),
            Err(why) => notes.push(format!("{why}; the property channel was ignored")),
        }
    }
    Animation::of(channels)
}

impl Animation {
    /// The animation of these channels; `None` when there is none.
    pub fn of(channels: Vec<Channel>) -> Option<Arc<Animation>> {
        if channels.is_empty() {
            return None;
        }
        let mut animation = Animation { channels, ..Default::default() };
        for channel in &animation.channels {
            animation.vfx |= channel.property.is_vfx();
            animation.poses |= channel.property == Property::Pose;
            animation.scalars |= channel.property != Property::Pose;
            // `animationEndTick`: every visible key owns its final display frame.
            if let Some(last) = channel.keys.last() {
                let visible = channel.keys.iter().rev().take_while(|key| key.tick == last.tick).any(|key| !key.hidden);
                animation.end = animation.end.max(channel.clip_end.unwrap_or(0.0)).max(last.tick + if visible { 1.0 } else { 0.0 });
            }
        }
        Some(Arc::new(animation))
    }
}

/// `animationEndTick` on a validated editor animation record. Timeline edits
/// need only this bound; they do not rebuild all typed channels on every seek.
pub fn end_tick_of_record(animation: Option<&Value>) -> f64 {
    let mut end: f64 = 0.0;
    for channel in animation.and_then(|a| a.get("channels")).and_then(Value::as_arr).into_iter().flatten() {
        let Some(keys) = channel.get("keys").and_then(Value::as_arr) else { continue };
        let Some(tick) = keys.last().and_then(|k| k.get("tick")).and_then(Value::as_f64) else { continue };
        let visible = keys.iter().rev().take_while(|k| k.get("tick").and_then(Value::as_f64) == Some(tick)).any(|k| !k.get("hidden").is_some_and(Value::truthy));
        end = end.max(channel.get("clipEnd").and_then(Value::as_f64).unwrap_or(0.0)).max(tick + if visible { 1.0 } else { 0.0 });
    }
    end
}
