//! Effect colours: `vfxPaint` and `interpolateVfxColor` (src/vfx-paint.mjs),
//! with the parts of `normalizePaint` and `samplePaint` (src/paint.mjs) they use.

use std::sync::Arc;

use styk_doc::Value;

use super::registry::ParamValue;
use crate::doc::{Paint, PaintKind, PaintStop};

/// JavaScript's `Math.round`: halves round up, towards positive infinity.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn kind(name: &str) -> Option<PaintKind> {
    Some(match name {
        "solid" => PaintKind::Solid,
        "linear" => PaintKind::Linear,
        "radial" => PaintKind::Radial,
        "angular" => PaintKind::Angular,
        "diamond" => PaintKind::Diamond,
        _ => return None,
    })
}

pub fn kind_name(kind: PaintKind) -> &'static str {
    match kind {
        PaintKind::Solid => "solid",
        PaintKind::Linear => "linear",
        PaintKind::Radial => "radial",
        PaintKind::Angular => "angular",
        PaintKind::Diamond => "diamond",
    }
}

/// `normalizePaint`: `None` where the editor throws (an unknown type, 1–32
/// stops for a solid and 2–32 for a gradient, values out of range). Colours
/// round to integers and stops sort by offset, stably.
pub fn normalize(value: &Value) -> Option<Paint> {
    let kind = kind(value.get("type")?.as_str()?)?;
    let stops = value.get("stops")?;
    let count = stops.array_len()?;
    if count < if kind == PaintKind::Solid { 1 } else { 2 } || count > 32 {
        return None;
    }
    let within = |v: Option<f64>, min: f64, max: f64| v.filter(|v| v.is_finite() && *v >= min && *v <= max);
    let mut out = Vec::with_capacity(count);
    for stop in stops.elements()? {
        let color = stop.get("color")?;
        if !color.is_array() || color.array_len() != Some(3) {
            return None;
        }
        let mut rgb = [0u8; 3];
        for (i, channel) in color.numbers()?.into_iter().enumerate() {
            rgb[i] = js_round(within(Some(channel), 0.0, 255.0)?) as u8;
        }
        out.push(PaintStop {
            offset: within(stop.get("offset").and_then(Value::as_f64), 0.0, 1.0)?,
            rgb,
            opacity: within(stop.get("opacity").and_then(Value::as_f64), 0.0, 1.0)?,
        });
    }
    sort(&mut out);
    let angle = match value.get("angle") {
        None | Some(Value::Null) => 0.0,
        Some(angle) => within(angle.as_f64(), -36000.0, 36000.0)?,
    };
    Some(Paint { kind, angle, stops: out })
}

/// `stops.sort((a, b) => a.offset - b.offset)`: stable, equal offsets (zeros of either sign) keep their order.
fn sort(stops: &mut [PaintStop]) {
    stops.sort_by(|a, b| a.offset.partial_cmp(&b.offset).unwrap_or(std::cmp::Ordering::Equal));
}

/// `vfxPaint` of an RGB integer: one solid, opaque stop.
pub fn solid(rgb: u32) -> Paint {
    Paint { kind: PaintKind::Solid, angle: 0.0, stops: vec![PaintStop { offset: 0.0, rgb: [(rgb >> 16 & 255) as u8, (rgb >> 8 & 255) as u8, (rgb & 255) as u8], opacity: 1.0 }] }
}

/// A stop while interpolating: `samplePaint` returns fractional colours.
#[derive(Clone, Copy)]
struct Stop {
    offset: f64,
    color: [f64; 3],
    opacity: f64,
}

impl From<&PaintStop> for Stop {
    fn from(s: &PaintStop) -> Stop {
        Stop { offset: s.offset, color: s.rgb.map(f64::from), opacity: s.opacity }
    }
}

/// `samplePaint`.
fn sample(stops: &[Stop], t: f64) -> Stop {
    if t <= stops[0].offset {
        return stops[0];
    }
    for i in 1..stops.len() {
        if t < stops[i].offset {
            let (a, b) = (stops[i - 1], stops[i]);
            let span = b.offset - a.offset;
            let f = (t - a.offset) / if span == 0.0 || span.is_nan() { 1.0 } else { span };
            return Stop { offset: t, opacity: a.opacity + (b.opacity - a.opacity) * f, color: [0, 1, 2].map(|j| a.color[j] + (b.color[j] - a.color[j]) * f) };
        }
    }
    stops[stops.len() - 1]
}

/// `samplePaint(vfxPaint(color), t)`: the colour (fractional channels, 0–255)
/// and opacity of an effect colour at `t`.
pub fn sample_color(color: &super::Color, t: f64) -> ([f64; 3], f64) {
    let stops: Vec<Stop> = match color {
        super::Color::Rgb(rgb) => solid(*rgb).stops.iter().map(Stop::from).collect(),
        super::Color::Paint(paint) => paint.stops.iter().map(Stop::from).collect(),
    };
    let s = sample(&stops, t);
    (s.color, s.opacity)
}

/// `isGradient`: a paint that is not solid and has more than one stop.
pub fn is_gradient(color: &super::Color) -> bool {
    matches!(color, super::Color::Paint(p) if p.kind != PaintKind::Solid && p.stops.len() > 1)
}

/// `interpolateVfxColor`. Two RGB integers mix per channel, rounded and
/// clamped. Otherwise both become paints: different gradient kinds or stop
/// counts keep `a`; a solid takes the other's layout; matching layouts
/// interpolate stop by stop (colours rounded), others resample both evenly.
pub fn interpolate(a: &ParamValue, b: &ParamValue, t: f64) -> ParamValue {
    if let (ParamValue::Num(a), ParamValue::Num(b)) = (a, b) {
        let (a, b) = (*a as i64 as u32, *b as i64 as u32);
        let mut value = 0u32;
        for shift in [0, 8, 16] {
            let (x, y) = ((a >> shift & 255) as f64, (b >> shift & 255) as f64);
            value |= (js_round((x + (y - x) * t).clamp(0.0, 255.0)) as u32) << shift;
        }
        return ParamValue::Num(value as f64);
    }
    let paint = |v: &ParamValue| match v {
        ParamValue::Num(n) => Arc::new(solid(*n as i64 as u32)),
        ParamValue::Paint(p) => p.clone(),
    };
    let (p, q) = (paint(a), paint(b));
    if p.kind != PaintKind::Solid && q.kind != PaintKind::Solid && (p.kind != q.kind || p.stops.len() != q.stops.len()) {
        return ParamValue::Paint(p);
    }
    let mut ps: Vec<Stop> = p.stops.iter().map(Stop::from).collect();
    let mut qs: Vec<Stop> = q.stops.iter().map(Stop::from).collect();
    if p.kind == PaintKind::Solid && q.kind != PaintKind::Solid {
        ps = qs.iter().map(|s| Stop { offset: s.offset, ..ps[0] }).collect();
    }
    if q.kind == PaintKind::Solid && p.kind != PaintKind::Solid {
        qs = ps.iter().map(|s| Stop { offset: s.offset, ..qs[0] }).collect();
    }
    let count = ps.len().max(qs.len());
    let same = ps.len() == qs.len();
    let mut stops: Vec<PaintStop> = (0..count)
        .map(|i| {
            let offset = i as f64 / if count == 1 { 1.0 } else { (count - 1) as f64 };
            let (x, y) = if same { (ps[i], qs[i]) } else { (sample(&ps, offset), sample(&qs, offset)) };
            PaintStop {
                offset: if same { x.offset + (y.offset - x.offset) * t } else { offset },
                rgb: [0, 1, 2].map(|j| js_round(x.color[j] + (y.color[j] - x.color[j]) * t) as u8),
                opacity: x.opacity + (y.opacity - x.opacity) * t,
            }
        })
        .collect();
    // `normalizePaint` of the result: colours are already whole, stops sort by offset.
    sort(&mut stops);
    ParamValue::Paint(Arc::new(Paint { kind: if p.kind == PaintKind::Solid { q.kind } else { p.kind }, angle: p.angle + (q.angle - p.angle) * t, stops }))
}
