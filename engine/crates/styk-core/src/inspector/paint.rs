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

use styk_doc::{Obj, Value};

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

/// `Math.round`: halves round up, toward positive infinity (the document's own, `styk_doc::paint`).
pub fn js_round(value: f64) -> f64 {
    styk_doc::paint::js_round(value)
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn invalid_value() -> Msg {
    Msg::new("errors.paint.invalidPaintValue")
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
    /// opacities 0..1; the stops sorted by offset (stable, as `Array.prototype.sort`); an angle within ±36000. The
    /// document's one normaliser (`styk_doc::paint::normalize_paint`) does it; this is its typed adapter.
    pub fn normalize(&self) -> Result<PaintSpec, Msg> {
        PaintSpec::from_value(&self.to_value())
    }

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

    /// A stored paint, normalised (`normalizePaint(value)`): refused with today's message when it is not one.
    pub fn from_value(value: &Value) -> Result<PaintSpec, Msg> {
        let paint = styk_doc::paint::normalize_paint(value).map_err(Msg::owned)?;
        let kind = PaintType::from_id(&paint.kind).ok_or_else(|| Msg::new("errors.paint.invalidPaintType"))?;
        let stops = paint.stops.iter().map(|stop| Stop { offset: stop.offset, color: stop.rgb(), opacity: stop.opacity }).collect();
        Ok(PaintSpec { kind, angle: paint.angle, stops })
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
        /// `backgroundPaint(bg)`: a background's own paint, or the paint its kind and colours describe (kind 3 linear,
        /// 4 radial, anything else solid; no background is opaque white).
        pub fn of_background(background: Option<&Value>) -> Result<PaintSpec, Msg> {
            if let Some(paint) = background.and_then(|bg| bg.get("paint")).filter(|paint| paint.truthy()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(offset: f64, rgb: [u8; 3], opacity: f64) -> Stop {
        Stop::new(offset, rgb, opacity)
    }

    fn linear(stops: Vec<Stop>) -> PaintSpec {
        PaintSpec { kind: PaintType::Linear, angle: 0.0, stops }
    }

    #[test]
    fn normalize_validates_rounds_and_sorts_as_normalize_paint() {
        let paint = PaintSpec { kind: PaintType::Radial, angle: 30.0, stops: vec![Stop { offset: 1.0, color: [254.5, 0.4, 3.0], opacity: 1.0 }, stop(0.0, [1, 2, 3], 0.5)] };
        let normalized = paint.normalize().unwrap();
        assert_eq!(normalized.stops.iter().map(|stop| stop.offset).collect::<Vec<_>>(), [0.0, 1.0]);
        assert_eq!(normalized.stops[1].color, [255.0, 0.0, 3.0], "Math.round");
        let key = |paint: PaintSpec| paint.normalize().unwrap_err().key;
        assert_eq!(key(linear(vec![stop(0.0, [0, 0, 0], 1.0)])), "errors.paint.useBetween2And32GradientStops");
        assert_eq!(key(PaintSpec { kind: PaintType::Solid, angle: 0.0, stops: Vec::new() }), "errors.paint.useBetween2And32GradientStops");
        assert_eq!(key(linear(vec![stop(0.0, [0, 0, 0], 1.0); 33])), "errors.paint.useBetween2And32GradientStops");
        assert_eq!(key(linear(vec![stop(0.0, [0, 0, 0], 1.5), stop(1.0, [0, 0, 0], 1.0)])), "errors.paint.invalidPaintValue");
        assert_eq!(key(PaintSpec { angle: 36001.0, ..linear(vec![stop(0.0, [0, 0, 0], 1.0), stop(1.0, [0, 0, 0], 1.0)]) }), "errors.paint.invalidPaintValue");
        assert!(linear(vec![stop(0.0, [0, 0, 0], 1.0); 32]).normalize().is_ok());
    }

    #[test]
    fn sample_interpolates_colour_and_opacity_between_stops() {
        let paint = linear(vec![stop(0.25, [0, 0, 0], 0.0), stop(0.75, [200, 100, 50], 1.0)]);
        assert_eq!(paint.sample(0.1), paint.stops[0], "before the first stop");
        assert_eq!(paint.sample(0.9), paint.stops[1], "after the last");
        let mid = paint.sample(0.5);
        assert_eq!((mid.offset, mid.color, mid.opacity), (0.5, [100.0, 50.0, 25.0], 0.5));
        // Today's order of operations: `a + (b - a) * ((t - a.offset) / (b.offset - a.offset))`.
        let third = paint.sample(0.4);
        let f = (0.4 - 0.25) / (0.75 - 0.25);
        assert_eq!(third.color[0], 0.0 + (200.0 - 0.0) * f);
    }

    #[test]
    fn hex_parsing_and_formatting_match_paint_mjs() {
        assert_eq!(parse_color("#abc").unwrap(), ([0xaa, 0xbb, 0xcc], 1.0));
        assert_eq!(parse_color("ABCD").unwrap(), ([0xaa, 0xbb, 0xcc], f64::from(0xdd_u8) / 255.0));
        assert_eq!(parse_color("#102030").unwrap(), ([0x10, 0x20, 0x30], 1.0));
        assert_eq!(parse_color("#10203080").unwrap().1, 128.0 / 255.0);
        for bad in ["#12", "#12345", "#ggg", "", "#1234567"] {
            assert_eq!(parse_color(bad).unwrap_err().key, "errors.paint.useAValidHexColorOptionallyIncludingAlpha", "{bad}");
        }
        assert_eq!(hex([255.0, 0.4, 15.5]), "#ff0010");
    }

    #[test]
    fn the_gradient_editor_keeps_today_s_draft_rules() {
        let mut draft = Draft::new(&PaintSpec::solid([250, 250, 250], 0.8)).unwrap();
        assert!(draft.set_gradient(true));
        assert_eq!(draft.draft().kind, PaintType::Linear);
        assert_eq!(draft.draft().stops[1], Stop { offset: 1.0, color: [32.0; 3], opacity: 0.8 }, "a light colour fades to dark grey");
        assert!(!draft.can_remove() && !draft.remove(), "never below two stops");
        assert!(draft.add(0.5));
        assert_eq!(draft.selected(), 2);
        assert_eq!(draft.stop().color, [141.0; 3], "the colour sampled at the offset");
        assert!(draft.set_angle(-30.0));
        assert_eq!(draft.draft().angle, 330.0, "the angle wraps");
        assert!(draft.rotate());
        assert_eq!(draft.draft().angle, 60.0);
        draft.select(0);
        assert!(draft.reverse());
        assert_eq!(draft.selected(), 2, "the same stop stays selected");
        assert_eq!(draft.stop().offset, 1.0);
        assert_eq!(draft.paint().unwrap().stops.iter().map(|stop| stop.offset).collect::<Vec<_>>(), [0.0, 0.5, 1.0], "the committed paint is sorted");
        assert!(draft.remove());
        assert_eq!(draft.selected(), 1, "the last remaining one is selected");
        // Solid remembers the gradient; Gradient brings it back.
        let gradient = draft.draft().clone();
        draft.set_gradient(false);
        assert_eq!(draft.draft().stops.len(), 1);
        draft.set_gradient(true);
        assert_eq!(draft.draft(), &gradient);
        assert!(draft.set_position(150.0));
        assert_eq!(draft.stop().offset, 1.0, "clamped");
        let mut full = Draft::new(&linear(vec![stop(0.0, [0, 0, 0], 1.0); 32])).unwrap();
        assert!(!full.can_add() && !full.add(0.5), "nothing past 32 stops");
    }

    #[cfg(feature = "engine")]
    #[test]
    fn backgrounds_read_and_write_as_background_paint_and_paint_background() {
        use styk_doc::json;
        let linear_bg = json::parse(br#"{"kind":3,"color_a":4278190335,"color_b":2164195328,"x1":0,"y1":0,"x2":1,"y2":1}"#).unwrap();
        let paint = PaintSpec::of_background(Some(&linear_bg)).unwrap();
        assert_eq!(paint.kind, PaintType::Linear);
        assert_eq!(paint.angle, styk_math::atan2(1.0, 1.0) * 180.0 / std::f64::consts::PI);
        assert_eq!((paint.stops[0].rgb(), paint.stops[0].opacity), ([0, 0, 255], 1.0));
        assert_eq!((paint.stops[1].rgb(), paint.stops[1].opacity), ([255, 0, 0], 128.0 / 255.0));
        let radial = json::parse(br#"{"kind":4,"color_a":4278190335,"color_b":4294901760}"#).unwrap();
        assert_eq!(PaintSpec::of_background(Some(&radial)).unwrap().stops[0].rgb(), [255, 0, 0], "a radial starts at its outer colour b");
        let white = PaintSpec::of_background(None).unwrap();
        assert_eq!((white.kind, white.stops[0].rgb(), white.stops[0].opacity), (PaintType::Solid, [255, 255, 255], 1.0));
        let made = PaintSpec::solid([1, 2, 3], 0.5).background(Some("solid gradient")).unwrap();
        assert_eq!(json::to_string(&made), r#"{"kind":2,"paint":{"type":"solid","angle":0,"stops":[{"offset":0,"color":[1,2,3],"opacity":0.5}]},"color":2147549699,"color_a":2147549699,"color_b":2147549699,"x1":0,"y1":0.5,"x2":1,"y2":0.5,"name":"solid gradient"}"#);
        // The stored reading (the evaluator's normalizePaint) and the draft's agree, refusals included.
        let typed = PaintSpec { kind: PaintType::Angular, angle: 12.5, stops: vec![stop(1.0, [9, 8, 7], 0.25), Stop { offset: 0.5, color: [1.4, 2.5, 3.0], opacity: 1.0 }] };
        assert_eq!(PaintSpec::from_value(&typed.to_value()).unwrap(), typed.normalize().unwrap());
        let one = linear(vec![stop(0.0, [0, 0, 0], 1.0)]);
        assert_eq!(PaintSpec::from_value(&one.to_value()).unwrap_err().key, one.normalize().unwrap_err().key);
        let stored = PaintSpec::of_background(Some(&made)).unwrap();
        assert_eq!(stored, PaintSpec::solid([1, 2, 3], 0.5), "a background's own paint wins");
    }
}
