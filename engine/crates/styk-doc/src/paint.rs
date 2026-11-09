//! A paint as the document stores it (`{type, angle, stops: [{offset, color, opacity}]}`) and `normalizePaint` of
//! src/paint.mjs: the one validation, rounding and sorting of a paint, shared by the evaluator (`styk_eval::records`),
//! the editing commands and the interface's paint model, which reaches it without the engine. Colours stay the values
//! the document holds, so a stored gradient reads back as it was written. A refusal is today's catalogue key.

use crate::{Obj, Value};

/// `Math.round`: halves round up, toward positive infinity.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `rgb(value)` of a stop's colour: three channels, `None` where it is not a list of three.
pub fn rgb_of_value(value: Option<&Value>) -> Option<[f64; 3]> {
    let list = value?.elements()?;
    (list.len() == 3).then(|| [0, 1, 2].map(|i| list.get(i).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)))
}

pub fn rgb_value(rgb: [f64; 3]) -> Value {
    Value::array(rgb.iter().map(|&v| Value::Num(v)).collect())
}

/// A paint (`{type, angle, stops: [{offset, color, opacity}]}`).
#[derive(Clone, Debug)]
pub struct Paint {
    pub kind: String,
    pub angle: f64,
    pub stops: Vec<Stop>,
}

#[derive(Clone, Debug)]
pub struct Stop {
    pub offset: f64,
    pub color: Value,
    pub opacity: f64,
}

impl Stop {
    pub fn rgb(&self) -> [f64; 3] {
        rgb_of_value(Some(&self.color)).unwrap_or([f64::NAN; 3])
    }
}

impl Paint {
    pub fn value(&self) -> Value {
        let stops = self
            .stops
            .iter()
            .map(|s| {
                let mut stop = Obj::new();
                stop.set("offset", Value::Num(s.offset));
                stop.set("color", s.color.clone());
                stop.set("opacity", Value::Num(s.opacity));
                Value::object(stop)
            })
            .collect();
        let mut out = Obj::new();
        out.set("type", Value::str(&self.kind));
        out.set("angle", Value::Num(self.angle));
        out.set("stops", Value::array(stops));
        Value::object(out)
    }

    pub fn solid(&self) -> bool {
        self.kind == "solid"
    }
}

/// `normalizePaint(paint)`; a refusal is its catalogue key.
pub fn normalize_paint(paint: &Value) -> Result<Paint, String> {
    let invalid = |key: &str| key.to_owned();
    let kind = paint.get("type").and_then(Value::as_str).filter(|t| ["solid", "linear", "radial", "angular", "diamond"].contains(t));
    let Some(kind) = kind.filter(|_| paint.truthy()) else { return Err(invalid("errors.paint.invalidPaintType")) };
    let finite = |v: Option<&Value>, min: f64, max: f64| match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n >= min && n <= max => Ok(n),
        _ => Err(invalid("errors.paint.invalidPaintValue")),
    };
    let stops: Vec<Value> = match paint.get("stops").and_then(Value::elements) {
        Some(list) if paint.get("stops").is_some_and(Value::is_array) && list.len() >= if kind == "solid" { 1 } else { 2 } && list.len() <= 32 => list.iter().collect(),
        _ => return Err(invalid("errors.paint.useBetween2And32GradientStops")),
    };
    let mut out = Vec::with_capacity(stops.len());
    for stop in &stops {
        let color: Vec<Value> = match stop.get("color").filter(|c| c.is_array()).and_then(Value::elements) {
            Some(list) if list.len() == 3 => list.iter().collect(),
            _ => return Err(invalid("errors.paint.invalidRgbColor")),
        };
        let offset = finite(stop.get("offset"), 0.0, 1.0)?;
        let mut channels = Vec::with_capacity(3);
        for v in &color {
            channels.push(Value::Num(js_round(finite(Some(v), 0.0, 255.0)?)));
        }
        let opacity = finite(stop.get("opacity"), 0.0, 1.0)?;
        out.push(Stop { offset, color: Value::array(channels), opacity });
    }
    out.sort_by(|a, b| a.offset.partial_cmp(&b.offset).unwrap_or(std::cmp::Ordering::Equal));
    let angle = match paint.get("angle").filter(|a| !a.is_null()) {
        None => 0.0,
        Some(angle) => finite(Some(angle), -36000.0, 36000.0)?,
    };
    Ok(Paint { kind: kind.to_string(), angle, stops: out })
}
