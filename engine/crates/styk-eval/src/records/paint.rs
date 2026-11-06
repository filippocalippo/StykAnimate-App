//! A segment's paint as the editor reads it (`normalizePaint` and `segmentPaint` in src/paint.mjs). Colours stay the
//! records the document holds, so a stored gradient reads back as it was written. The editing commands that recolour
//! figures (`styk_edit::recolor`) and the property reads of this crate (`animationStyleValue`) share it.

use styk_doc::{Obj, Value};

use super::Error;
use crate::vfx::paint::js_round;

fn invalid(key: &str) -> Error {
    Error::Invalid(key.into())
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

/// `normalizePaint(paint)`.
pub fn normalize_paint(paint: &Value) -> Result<Paint, Error> {
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

/// `segmentPaint(segment)`: a segment's paint, its first stop the segment's colour and
/// transparency, a native gradient's end its last.
pub fn segment_paint(segment: &Value) -> Result<Paint, Error> {
    let alpha = |value: Option<&Value>| 1.0 - value.and_then(Value::as_f64).unwrap_or(0.0) / 255.0;
    let secondary = segment.get("secondary").filter(|s| s.truthy());
    if let Some(paint) = segment.get("paint").filter(|p| p.truthy()) {
        let mut p = normalize_paint(paint)?;
        if let Some(color) = segment.get("color_rgb").filter(|c| !c.is_null()) {
            p.stops[0].color = color.clone();
        }
        p.stops[0].opacity = alpha(segment.get("transparency"));
        if let (Some(secondary), false) = (secondary, p.solid()) {
            let last = p.stops.last_mut().unwrap();
            last.color = secondary.get("rgb").cloned().unwrap_or(Value::Null);
            last.opacity = alpha(secondary.get("a"));
        }
        return Ok(p);
    }
    let first = segment.get("color_rgb").filter(|c| !c.is_null()).cloned().unwrap_or_else(|| rgb_value([0.0; 3]));
    let mut stops = vec![Stop { offset: 0.0, color: first, opacity: alpha(segment.get("transparency")) }];
    if let Some(secondary) = secondary {
        stops.push(Stop { offset: 1.0, color: secondary.get("rgb").cloned().unwrap_or(Value::Null), opacity: alpha(secondary.get("a")) });
    }
    Ok(Paint { kind: if secondary.is_some() { "linear" } else { "solid" }.into(), angle: 0.0, stops })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    fn json(paint: &Paint) -> String {
        styk_doc::json::to_string(&paint.value())
    }

    #[test]
    fn a_plain_segment_is_one_solid_stop_with_its_transparency() {
        let paint = segment_paint(&parse(r#"{"color_rgb":[13,153,255],"transparency":51}"#)).unwrap();
        assert!(paint.solid());
        assert_eq!(json(&paint), r#"{"type":"solid","angle":0,"stops":[{"offset":0,"color":[13,153,255],"opacity":0.8}]}"#);
    }

    #[test]
    fn a_second_colour_makes_a_linear_gradient_to_it() {
        let paint = segment_paint(&parse(r#"{"color_rgb":[1,2,3],"secondary":{"rgb":[200,10,10],"a":64}}"#)).unwrap();
        assert_eq!(json(&paint), r#"{"type":"linear","angle":0,"stops":[{"offset":0,"color":[1,2,3],"opacity":1},{"offset":1,"color":[200,10,10],"opacity":0.7490196078431373}]}"#);
    }

    #[test]
    fn a_stored_paint_is_normalized_and_takes_the_segments_own_first_colour() {
        let segment = parse(r#"{"color_rgb":[9,9,9],"transparency":51,"paint":{"type":"radial","angle":20,"stops":[{"offset":0.8,"color":[250.4,1,2],"opacity":0.5},{"offset":0,"color":[3,4,5],"opacity":1},{"offset":1,"color":[9,8,7],"opacity":0.25}]}}"#);
        let paint = segment_paint(&segment).unwrap();
        // Sorted by offset, channels rounded, the first stop the segment's colour and opacity.
        assert_eq!(json(&paint), r#"{"type":"radial","angle":20,"stops":[{"offset":0,"color":[9,9,9],"opacity":0.8},{"offset":0.8,"color":[250,1,2],"opacity":0.5},{"offset":1,"color":[9,8,7],"opacity":0.25}]}"#);
    }

    #[test]
    fn a_paint_the_editor_would_throw_on_is_refused_with_its_message() {
        for (paint, message) in [
            (r#"{"type":"cone","stops":[]}"#, "errors.paint.invalidPaintType"),
            (r#"{"type":"linear","stops":[{"offset":0,"color":[0,0,0],"opacity":1}]}"#, "errors.paint.useBetween2And32GradientStops"),
            (r#"{"type":"solid","stops":[{"offset":0,"color":[0,0],"opacity":1}]}"#, "errors.paint.invalidRgbColor"),
            (r#"{"type":"solid","stops":[{"offset":2,"color":[0,0,0],"opacity":1}]}"#, "errors.paint.invalidPaintValue"),
        ] {
            match normalize_paint(&parse(paint)) {
                Err(Error::Invalid(key)) => assert_eq!(key, message),
                other => panic!("{paint}: {other:?}"),
            }
        }
    }
}
