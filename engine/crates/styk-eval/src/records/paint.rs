//! A segment's paint as the editor reads it (`normalizePaint` and `segmentPaint` in src/paint.mjs). Colours stay the
//! records the document holds, so a stored gradient reads back as it was written. The editing commands that recolour
//! figures (`styk_edit::recolor`) and the property reads of this crate (`animationStyleValue`) share it. The one
//! `normalizePaint` is `styk_doc::paint`'s, which the interface's paint model also reaches without the engine.

use styk_doc::Value;

use super::Error;

pub use styk_doc::paint::{Paint, Stop, rgb_of_value, rgb_value};

/// `normalizePaint(paint)`.
pub fn normalize_paint(paint: &Value) -> Result<Paint, Error> {
    styk_doc::paint::normalize_paint(paint).map_err(Error::Invalid)
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
