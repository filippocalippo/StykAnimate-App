//! The paint model (ST-085): a port of `src/paint.mjs` for the Inspector's colour rows and the colour picker's
//! gradient editor (`src/color-picker.mjs`, IN-060).
//!
//! - [`PaintSpec`]: solid, linear, radial, angular and diamond paints; 1..32 stops (a solid needs 1, a gradient 2..32),
//!   each an offset 0..1, a colour and an opacity 0..1. [`PaintSpec::normalize`] is `normalizePaint`: it validates,
//!   rounds the colours and sorts the stops by offset. [`PaintSpec::sample`] is `samplePaint`.
//! - [`parse_color`] and [`hex`]: `parseColor` (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and `hexColor`.
//! - [`Draft`]: the gradient editor's data (the paint being edited and its selected stop) with today's operations:
//!   Solid and Gradient (the last gradient is remembered), type, angle (wraps), Rotate 90, Reverse, add a stop at an
//!   offset (its colour sampled), remove one (never below 2), move one. Each operation that today calls `commit()`
//!   returns `true`: the picker then sends the normalised paint ([`Draft::paint`]) to its owner.
//! - The document's encodings (engine builds): a paint as the session takes it ([`PaintSpec::to_value`],
//!   [`PaintSpec::from_value`]), a scene background's paint (`backgroundPaint`) and the background a paint makes
//!   (`paintBackground`).
//!
//! Colours are kept as numbers, not bytes, while a draft is edited: a sampled stop holds the interpolated colour until
//! the paint is normalised, as today.

use crate::i18n::Msg;

/// A paint's kind (`type`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum PaintType {
    #[default]
    Solid,
    Linear,
    Radial,
    Angular,
    Diamond,
}

impl PaintType {
    /// The gradient kinds, in the type select's order.
    pub const GRADIENTS: [PaintType; 4] = [PaintType::Linear, PaintType::Radial, PaintType::Angular, PaintType::Diamond];

    /// Today's name (`'solid'`, `'linear'`, ...), also the catalogue key's last part (`colorPicker.linear`).
    pub fn id(self) -> &'static str {
        match self {
            PaintType::Solid => "solid",
            PaintType::Linear => "linear",
            PaintType::Radial => "radial",
            PaintType::Angular => "angular",
            PaintType::Diamond => "diamond",
        }
    }

    pub fn from_id(id: &str) -> Option<PaintType> {
        [PaintType::Solid, PaintType::Linear, PaintType::Radial, PaintType::Angular, PaintType::Diamond].into_iter().find(|kind| kind.id() == id)
    }
}

/// One stop: an offset 0..1, a colour (0..255 per channel; whole numbers once normalised) and an opacity 0..1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stop {
    pub offset: f64,
    pub color: [f64; 3],
    pub opacity: f64,
}

impl Stop {
    pub fn new(offset: f64, rgb: [u8; 3], opacity: f64) -> Stop {
        Stop { offset, color: rgb.map(f64::from), opacity }
    }

    /// The colour as bytes (rounded as `hexColor` rounds).
    pub fn rgb(&self) -> [u8; 3] {
        self.color.map(|channel| js_round(channel).clamp(0.0, 255.0) as u8)
    }
}

/// A paint (`{type, angle, stops}`).
#[derive(Clone, Debug, PartialEq)]
pub struct PaintSpec {
    pub kind: PaintType,
    /// Degrees.
    pub angle: f64,
    pub stops: Vec<Stop>,
}

/// `Math.round`: halves round up, toward positive infinity.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn invalid_value() -> Msg {
    Msg::new("errors.paint.invalidPaintValue")
}

fn finite(value: f64, min: f64, max: f64) -> Result<f64, Msg> {
    if value.is_finite() && value >= min && value <= max { Ok(value) } else { Err(invalid_value()) }
}

impl PaintSpec {
    /// A solid paint of one colour.
    pub fn solid(rgb: [u8; 3], opacity: f64) -> PaintSpec {
        PaintSpec { kind: PaintType::Solid, angle: 0.0, stops: vec![Stop::new(0.0, rgb, opacity)] }
    }

    pub fn is_solid(&self) -> bool {
        self.kind == PaintType::Solid
    }

    /// `normalizePaint`: 1 stop for a solid, 2..32 for a gradient; finite offsets 0..1, colours 0..255 (rounded) and
    /// opacities 0..1; the stops sorted by offset (stable, as `Array.prototype.sort`); an angle within ±36000.
    pub fn normalize(&self) -> Result<PaintSpec, Msg> {
        let least = if self.kind == PaintType::Solid { 1 } else { 2 };
        if self.stops.len() < least || self.stops.len() > 32 {
            return Err(Msg::new("errors.paint.useBetween2And32GradientStops"));
        }
        let mut stops = self
            .stops
            .iter()
            .map(|stop| {
                let offset = finite(stop.offset, 0.0, 1.0)?;
                let mut color = [0.0; 3];
                for (out, channel) in color.iter_mut().zip(stop.color) {
                    *out = js_round(finite(channel, 0.0, 255.0)?);
                }
                Ok(Stop { offset, color, opacity: finite(stop.opacity, 0.0, 1.0)? })
            })
            .collect::<Result<Vec<Stop>, Msg>>()?;
        stops.sort_by(|a, b| a.offset.partial_cmp(&b.offset).unwrap_or(std::cmp::Ordering::Equal));
        Ok(PaintSpec { kind: self.kind, angle: finite(self.angle, -36000.0, 36000.0)?, stops })
    }

    /// `samplePaint(p, t)`: the colour and opacity at `t`, interpolated linearly between the stops around it (a
    /// normalised paint's stops are in order).
    pub fn sample(&self, t: f64) -> Stop {
        let stops = &self.stops;
        let Some(first) = stops.first() else { return Stop { offset: t, color: [0.0; 3], opacity: 1.0 } };
        if t <= first.offset {
            return *first;
        }
        for pair in stops.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if t < b.offset {
                let span = b.offset - a.offset;
                let f = (t - a.offset) / if span == 0.0 { 1.0 } else { span };
                let opacity = a.opacity + (b.opacity - a.opacity) * f;
                let mut color = a.color;
                for (channel, (from, to)) in color.iter_mut().zip(a.color.iter().zip(b.color)) {
                    *channel = from + (to - from) * f;
                }
                return Stop { offset: t, color, opacity };
            }
        }
        *stops.last().unwrap_or(first)
    }
}

/// `parseColor`: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (the `#` optional, any case) to a colour and an opacity.
pub fn parse_color(value: &str) -> Result<([u8; 3], f64), Msg> {
    let refused = || Msg::new("errors.paint.useAValidHexColorOptionallyIncludingAlpha");
    let digits = value.strip_prefix('#').unwrap_or(value);
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(refused());
    }
    let digits: String = match digits.len() {
        3 | 4 => digits.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => digits.to_owned(),
        _ => return Err(refused()),
    };
    let byte = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).map_err(|_| refused());
    let opacity = if digits.len() == 8 { f64::from(byte(6)?) / 255.0 } else { 1.0 };
    Ok(([byte(0)?, byte(2)?, byte(4)?], opacity))
}

/// `hexColor`: `#rrggbb`, lower case, each channel rounded.
pub fn hex(color: [f64; 3]) -> String {
    let mut out = String::with_capacity(7);
    out.push('#');
    for channel in color {
        out.push_str(&format!("{:02x}", js_round(channel).clamp(0.0, 255.0) as u8));
    }
    out
}

/// The gradient editor's data: the paint being edited (its stops in the order they were made, as today's draft) and
/// the selected stop.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    paint: PaintSpec,
    selected: usize,
    /// The gradient a switch to Solid put aside, restored by a switch back.
    saved: Option<PaintSpec>,
}

impl Draft {
    /// A draft of `paint` (`draft = normalizePaint(paint)`), its first stop selected.
    pub fn new(paint: &PaintSpec) -> Result<Draft, Msg> {
        Ok(Draft { paint: paint.normalize()?, selected: 0, saved: None })
    }

    /// The paint as drawn while it is edited (not normalised: stops in the order they were made).
    pub fn draft(&self) -> &PaintSpec {
        &self.paint
    }

    /// The paint the picker commits (`normalizePaint(draft)`).
    pub fn paint(&self) -> Result<PaintSpec, Msg> {
        self.paint.normalize()
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// The selected stop.
    pub fn stop(&self) -> Stop {
        self.paint.stops[self.selected.min(self.paint.stops.len() - 1)]
    }

    fn stop_mut(&mut self) -> &mut Stop {
        let at = self.selected.min(self.paint.stops.len() - 1);
        &mut self.paint.stops[at]
    }

    /// Whether Remove is available (more than two stops) and Add (fewer than 32).
    pub fn can_remove(&self) -> bool {
        self.paint.stops.len() > 2
    }
    pub fn can_add(&self) -> bool {
        self.paint.stops.len() < 32
    }

    /// The Solid and Gradient tabs. Solid keeps the selected stop's colour and puts the gradient aside; Gradient brings
    /// it back, or makes a linear one from the selected colour to dark grey (a light colour) or white. Commits.
    pub fn set_gradient(&mut self, gradient: bool) -> bool {
        let stop = self.stop();
        if !gradient {
            if self.paint.kind != PaintType::Solid {
                self.saved = Some(self.paint.clone());
            }
            self.paint = PaintSpec { kind: PaintType::Solid, angle: 0.0, stops: vec![Stop { offset: 0.0, ..stop }] };
        } else if self.paint.kind == PaintType::Solid {
            self.paint = self.saved.clone().unwrap_or_else(|| {
                let light = stop.color.iter().sum::<f64>() > 600.0;
                let end = if light { [32.0; 3] } else { [255.0; 3] };
                PaintSpec { kind: PaintType::Linear, angle: 0.0, stops: vec![Stop { offset: 0.0, ..stop }, Stop { offset: 1.0, color: end, opacity: stop.opacity }] }
            });
        }
        self.selected = 0;
        true
    }

    /// The gradient type select. Commits.
    pub fn set_type(&mut self, kind: PaintType) -> bool {
        self.paint.kind = kind;
        true
    }

    /// The angle field: a finite value wraps into 0..360 (`((n % 360) + 360) % 360`); any change commits.
    pub fn set_angle(&mut self, degrees: f64) -> bool {
        if degrees.is_finite() {
            self.paint.angle = ((degrees % 360.0) + 360.0) % 360.0;
        }
        true
    }

    /// Rotate 90°. Commits.
    pub fn rotate(&mut self) -> bool {
        self.paint.angle = (self.paint.angle + 90.0) % 360.0;
        true
    }

    /// Reverse: every offset mirrored and the order reversed; the same stop stays selected. Commits.
    pub fn reverse(&mut self) -> bool {
        self.paint.stops = self.paint.stops.iter().rev().map(|stop| Stop { offset: 1.0 - stop.offset, ..*stop }).collect();
        self.selected = self.paint.stops.len() - 1 - self.selected.min(self.paint.stops.len() - 1);
        true
    }

    /// A stop added at `t` (Add puts it at 0.5, a click on the ramp where it lands) with the colour sampled there,
    /// and selected. Nothing at 32 stops. Commits when it added one.
    pub fn add(&mut self, t: f64) -> bool {
        if !self.can_add() {
            return false;
        }
        // `samplePaint(normalizePaint(draft), t)`: a draft that does not normalise adds nothing, as the throw did.
        let Ok(normalized) = self.paint.normalize() else { return false };
        let sampled = normalized.sample(t);
        self.paint.stops.push(Stop { offset: t, ..sampled });
        self.selected = self.paint.stops.len() - 1;
        true
    }

    /// The selected stop removed (never below two); the next one, or the last, is selected. Commits when it removed one.
    pub fn remove(&mut self) -> bool {
        if !self.can_remove() {
            return false;
        }
        let at = self.selected.min(self.paint.stops.len() - 1);
        self.paint.stops.remove(at);
        self.selected = at.min(self.paint.stops.len() - 1);
        true
    }

    /// A press on a stop selects it (no commit).
    pub fn select(&mut self, index: usize) {
        if index < self.paint.stops.len() {
            self.selected = index;
        }
    }

    /// A stop dragged along the ramp (the fraction clamped to 0..1): drawn only; the release commits.
    pub fn drag_stop(&mut self, fraction: f64) {
        self.stop_mut().offset = clamp01(fraction);
    }

    /// Left or Right on a stop: it is selected and moves by `step` (±0.01), clamped. Commits.
    pub fn nudge(&mut self, index: usize, step: f64) -> bool {
        self.select(index);
        let stop = self.stop_mut();
        stop.offset = clamp01(stop.offset + step);
        true
    }

    /// The position field (percent), clamped to 0..100. Commits.
    pub fn set_position(&mut self, percent: f64) -> bool {
        self.stop_mut().offset = clamp01(percent / 100.0);
        true
    }

    /// The selected stop's colour (the square, the hue, a swatch, the hex field, the eyedropper).
    pub fn set_color(&mut self, color: [f64; 3]) {
        self.stop_mut().color = color;
    }

    /// The selected stop's opacity, clamped to 0..1.
    pub fn set_opacity(&mut self, opacity: f64) {
        self.stop_mut().opacity = clamp01(opacity);
    }
}

#[cfg(feature = "engine")]
mod document {
    use styk_doc::{Obj, Value};

    use super::{PaintSpec, PaintType, Stop};
    use crate::i18n::Msg;

    fn num(value: Option<&Value>) -> Option<f64> {
        value.and_then(Value::as_f64)
    }

    /// `ToUint32` of a stored colour.
    fn uint32(value: f64) -> u32 {
        if !value.is_finite() {
            return 0;
        }
        (value.trunc().rem_euclid(4_294_967_296.0)) as u32
    }

    fn stop_of_argb(raw: f64, offset: f64) -> Stop {
        let raw = uint32(raw);
        Stop::new(offset, [(raw >> 16) as u8, (raw >> 8) as u8, raw as u8], f64::from(raw >> 24) / 255.0)
    }

    /// `((round(opacity * 255) << 24) | (r << 16) | (g << 8) | b) >>> 0` of a normalised stop.
    fn argb(stop: &Stop) -> f64 {
        let [r, g, b] = stop.rgb();
        let alpha = (super::js_round(stop.opacity * 255.0) as u32) & 0xff;
        f64::from((alpha << 24) | (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b))
    }

    impl PaintSpec {
        /// The paint as the session takes it (`{type, angle, stops: [{offset, color: [r, g, b], opacity}]}`).
        pub fn to_value(&self) -> Value {
            let stops = self
                .stops
                .iter()
                .map(|stop| {
                    let mut item = Obj::new();
                    item.set("offset", Value::Num(stop.offset));
                    item.set("color", Value::array(stop.color.iter().map(|channel| Value::Num(*channel)).collect()));
                    item.set("opacity", Value::Num(stop.opacity));
                    Value::object(item)
                })
                .collect();
            let mut paint = Obj::new();
            paint.set("type", Value::str(self.kind.id()));
            paint.set("angle", Value::Num(self.angle));
            paint.set("stops", Value::array(stops));
            Value::object(paint)
        }

        /// A stored paint, normalised (`normalizePaint(value)`): refused as today when it is not one.
        pub fn from_value(value: &Value) -> Result<PaintSpec, Msg> {
            let kind = value.get("type").and_then(Value::as_str).and_then(PaintType::from_id).ok_or_else(|| Msg::new("errors.paint.invalidPaintType"))?;
            let stops = value.get("stops").and_then(Value::elements).ok_or_else(|| Msg::new("errors.paint.useBetween2And32GradientStops"))?;
            let stops = stops
                .iter()
                .map(|stop| {
                    let color = stop.get("color").and_then(Value::elements).filter(|color| color.len() == 3).ok_or_else(|| Msg::new("errors.paint.invalidRgbColor"))?;
                    let channel = |at: usize| color.get(at).and_then(|value| value.as_f64()).unwrap_or(f64::NAN);
                    Ok(Stop { offset: num(stop.get("offset")).unwrap_or(f64::NAN), color: [channel(0), channel(1), channel(2)], opacity: num(stop.get("opacity")).unwrap_or(f64::NAN) })
                })
                .collect::<Result<Vec<Stop>, Msg>>()?;
            let angle = match value.get("angle") {
                None | Some(Value::Null) => 0.0,
                Some(angle) => angle.as_f64().unwrap_or(f64::NAN),
            };
            PaintSpec { kind, angle, stops }.normalize()
        }

        /// `backgroundPaint(bg)`: a background's own paint, or the paint its kind and colours describe (kind 3 linear,
        /// 4 radial, anything else solid; no background is opaque white).
        pub fn of_background(background: Option<&Value>) -> Result<PaintSpec, Msg> {
            if let Some(paint) = background.and_then(|bg| bg.get("paint")).filter(|paint| !paint.is_null()) {
                return PaintSpec::from_value(paint);
            }
            let field = |name: &str| background.and_then(|bg| num(bg.get(name)));
            let kind = field("kind");
            match kind {
                Some(kind) if kind == 3.0 || kind == 4.0 => {
                    let radial = kind == 4.0;
                    let angle = if radial {
                        0.0
                    } else {
                        let (dy, dx) = (field("y2").unwrap_or(1.0) - field("y1").unwrap_or(0.0), field("x2").unwrap_or(1.0) - field("x1").unwrap_or(0.0));
                        styk_math::atan2(dy, dx) * 180.0 / std::f64::consts::PI
                    };
                    let (a, b) = (field("color_a").unwrap_or(f64::NAN), field("color_b").unwrap_or(f64::NAN));
                    let (first, last) = if radial { (b, a) } else { (a, b) };
                    Ok(PaintSpec { kind: if radial { PaintType::Radial } else { PaintType::Linear }, angle, stops: vec![stop_of_argb(first, 0.0), stop_of_argb(last, 1.0)] })
                }
                _ => Ok(PaintSpec { kind: PaintType::Solid, angle: 0.0, stops: vec![stop_of_argb(field("color").unwrap_or(f64::from(0xffff_ffff_u32)), 0.0)] }),
            }
        }

        /// `paintBackground(p)`: the background record a normalised paint makes (`{kind, paint, color, color_a,
        /// color_b, x1, y1, x2, y2}`), with `name` when given (`importSceneBackground`'s `type + ' gradient'`).
        pub fn background(&self, name: Option<&str>) -> Result<Value, Msg> {
            let paint = self.normalize()?;
            let (first, last) = (self.stops.first().ok_or_else(super::invalid_value)?, self.stops.last().ok_or_else(super::invalid_value)?);
            let kind = match self.kind {
                PaintType::Solid => 2.0,
                PaintType::Radial => 4.0,
                _ => 3.0,
            };
            let mut out = Obj::new();
            out.set("kind", Value::Num(kind));
            out.set("paint", paint.to_value());
            out.set("color", Value::Num(argb(first)));
            out.set("color_a", Value::Num(argb(first)));
            out.set("color_b", Value::Num(argb(last)));
            out.set("x1", Value::Num(0.0));
            out.set("y1", Value::Num(0.5));
            out.set("x2", Value::Num(1.0));
            out.set("y2", Value::Num(0.5));
            if let Some(name) = name {
                out.set("name", Value::str(name));
            }
            Ok(Value::object(out))
        }
    }
}
