//! `normalizePaint` of `src/paint.mjs`, the one paint function the text tool calls.

use styk_doc::{Obj, Value};

use super::TextError;

fn invalid_value() -> TextError {
    TextError::key("errors.paint.invalidPaintValue")
}

/// `finite(v, min, max)`: a finite number inside the range.
fn finite(value: Option<f64>, min: f64, max: f64) -> Result<f64, TextError> {
    match value {
        Some(v) if v.is_finite() && v >= min && v <= max => Ok(v),
        _ => Err(invalid_value()),
    }
}

pub(crate) fn normalize_paint(paint: &Value) -> Result<Value, TextError> {
    let object = paint.as_obj().ok_or_else(|| TextError::key("errors.paint.invalidPaintType"))?;
    let kind = object.get("type").and_then(Value::as_str);
    if !matches!(kind, Some("solid" | "linear" | "radial" | "angular" | "diamond")) {
        return Err(TextError::key("errors.paint.invalidPaintType"));
    }
    let kind = kind.expect("checked");
    let stops = object.get("stops").and_then(Value::elements);
    let minimum = if kind == "solid" { 1 } else { 2 };
    let Some(stops) = stops.filter(|s| s.len() >= minimum && s.len() <= 32) else {
        return Err(TextError::key("errors.paint.useBetween2And32GradientStops"));
    };
    let mut normalized: Vec<(f64, Value)> = Vec::with_capacity(stops.len());
    for stop in stops.iter() {
        let stop = stop.as_obj().ok_or_else(|| TextError::key("errors.paint.invalidRgbColor"))?;
        let color = stop.get("color").and_then(Value::elements).filter(|c| c.len() == 3);
        let Some(color) = color else { return Err(TextError::key("errors.paint.invalidRgbColor")) };
        let offset = finite(stop.get("offset").and_then(Value::as_f64), 0.0, 1.0)?;
        let mut rgb = Vec::with_capacity(3);
        for channel in color.iter() {
            rgb.push(Value::Num(super::options::js_round(finite(channel.as_f64(), 0.0, 255.0)?)));
        }
        let opacity = finite(stop.get("opacity").and_then(Value::as_f64), 0.0, 1.0)?;
        let mut out = Obj::new();
        out.set("offset", Value::Num(offset));
        out.set("color", Value::array(rgb));
        out.set("opacity", Value::Num(opacity));
        normalized.push((offset, Value::object(out)));
    }
    // `Array.prototype.sort` is stable.
    normalized.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let angle = match object.get("angle") {
        None | Some(Value::Null) => 0.0,
        Some(v) => finite(v.as_f64(), -36000.0, 36000.0)?,
    };
    let mut out = Obj::new();
    out.set("type", Value::str(kind));
    out.set("angle", Value::Num(angle));
    out.set("stops", Value::array(normalized.into_iter().map(|(_, v)| v).collect()));
    Ok(Value::object(out))
}
