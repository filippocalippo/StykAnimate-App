//! Per-instance style overlays as Pivot figure types (`resolveInstanceFigure` of
//! src/animation-style.mjs): native Pivot stores a segment's or an outline's appearance on reusable figure types, so each
//! distinct overlay an export meets becomes one more figure type, shared by every instance that looks alike.

use std::collections::HashMap;

use styk_doc::{Obj, Value};
use styk_eval::records::paint::normalize_paint;

use crate::range_plan::js_round;
use crate::recolor::{alpha_byte, polygon_identity, rgb_of, style_color};
use crate::EditError;

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn rgb_value(color: f64) -> Value {
    Value::array(rgb_of(color).iter().map(|&channel| Value::Num(channel)).collect())
}

/// `opacityOf(alpha)`.
fn opacity_of(alpha: f64) -> f64 {
    1.0 - alpha / 255.0
}

/// `nativeSegmentOpacity(segment)`.
fn native_segment_opacity(segment: &Obj) -> f64 {
    match segment.get("transparency") {
        None => segment.get("color_alpha").and_then(Value::as_f64).unwrap_or(1.0),
        Some(transparency) => opacity_of(transparency.as_f64().unwrap_or(0.0)),
    }
}

/// `Number(value ?? 0)` of a field.
fn number_or_zero(value: Option<&Value>) -> f64 {
    value.filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN))
}

fn with(record: Option<&Value>, key: &str, value: Value) -> Value {
    let mut next = record.and_then(Value::as_obj).cloned().unwrap_or_default();
    next.set(key, value);
    Value::object(next)
}

/// `resolveInstanceFigure(figure, object)`: the figure as the instance's style overlay shows it. Without an overlay (or
/// when the overlay changes nothing it can) the figure itself.
pub(crate) fn resolve_instance_figure(figure: &Value, object: &Value) -> Result<Value, EditError> {
    let style = object.get("_stykStyle").filter(|style| style.truthy());
    let segment_colors = object.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments");
    if style.is_none() && !segment_colors {
        return Ok(figure.clone());
    }
    let empty = Value::object(Obj::new());
    let style = style.unwrap_or(&empty);
    let mut result = figure.as_obj().cloned().unwrap_or_default();
    let mut copied = false;
    if segment_colors && figure.path(&["_styk", "colorMode"]).and_then(Value::as_str) != Some("segments") {
        copied = true;
        result.set("_styk", with(figure.get("_styk"), "colorMode", Value::str("segments")));
    }
    let global = |figure_like: &Obj| figure_like.get("segment_decode").and_then(|decode| decode.get("global_style")).cloned();
    if let Some(opacity) = finite(style.get("outlineOpacity")) {
        let u30 = alpha_byte(opacity);
        if u30 != number_or_zero(figure.path(&["segment_decode", "global_style", "u30"])) {
            copied = true;
            let global_style = with(figure.path(&["segment_decode", "global_style"]), "u30", Value::Num(u30));
            result.set("segment_decode", with(figure.get("segment_decode"), "global_style", global_style));
        }
    }
    for (property, field) in [("outlineColor", "rgb"), ("outlineWidth", "outline_thickness")] {
        let Some(value) = finite(style.get(property)) else { continue };
        copied = true;
        let before = global(&result);
        let mut global_style = before.as_ref().and_then(Value::as_obj).cloned().unwrap_or_default();
        global_style.set(field, if property == "outlineColor" { rgb_value(value) } else { Value::Num(value) });
        if property == "outlineWidth" {
            global_style.set("u28", Value::Num(f64::from((value as f32).to_bits())));
        }
        let decode = with(result.get("segment_decode"), "global_style", Value::object(global_style));
        result.set("segment_decode", decode);
    }
    let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let mut replaced: Option<Vec<Value>> = None;
    if let Some(table) = style.get("segments").filter(|table| table.truthy()) {
        for (index, segment) in segments.iter().enumerate() {
            let Some(id) = segment.get("segment_id") else { continue };
            let Some(over) = table.get(&styk_doc::json::to_string(id)).filter(|over| over.truthy()) else { continue };
            let primitive = segment.get("primitive_code").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let mut next = segment.as_obj().cloned().unwrap_or_default();
            let mut changed = false;
            if let Some(z) = finite(over.get("zIndex")) {
                next.set("z_order", Value::Num(z));
                next.set("z_order_runtime_raw", Value::Num(z - 1.0));
                changed = true;
            }
            if let Some(paint) = over.get("paint").filter(|paint| paint.truthy()) {
                let paint = normalize_paint(paint)?;
                let (first, last) = (paint.stops[0].clone(), paint.stops.last().unwrap().clone());
                next.set("paint", paint.value());
                next.set("color_rgb", first.color.clone());
                next.set("transparency", Value::Num(alpha_byte(first.opacity)));
                next.set("color_alpha", Value::Num(first.opacity));
                next.set("secondary", if paint.solid() {
                    Value::Null
                } else {
                    let mut secondary = Obj::new();
                    secondary.set("rgb", last.color.clone());
                    secondary.set("a", Value::Num(alpha_byte(last.opacity)));
                    Value::object(secondary)
                });
                changed = true;
            }
            if let Some(color) = finite(over.get("color")) {
                next.set("color_rgb", rgb_value(color));
                changed = true;
            }
            if let Some(thickness) = finite(over.get("thickness")) {
                next.set("thickness", Value::Num(thickness));
                next.set("visible", Value::Bool(thickness > 0.01 || primitive > 0.0));
                changed = true;
            }
            let secondary = |next: &Obj| next.get("secondary").filter(|secondary| secondary.truthy()).and_then(Value::as_obj).cloned();
            if let (Some(mut end), Some(color)) = (secondary(&next), finite(over.get("gradientColor"))) {
                end.set("rgb", rgb_value(color));
                next.set("secondary", Value::object(end));
                changed = true;
            }
            if let Some(opacity) = finite(over.get("opacity")) {
                let transparency = alpha_byte(opacity);
                if transparency != alpha_byte(native_segment_opacity(&next)) {
                    next.set("transparency", Value::Num(transparency));
                    next.set("color_alpha", Value::Num(opacity_of(transparency)));
                    changed = true;
                }
            }
            if let (Some(mut end), Some(opacity)) = (secondary(&next), finite(over.get("gradientOpacity"))) {
                let a = alpha_byte(opacity);
                if a != number_or_zero(end.get("a")) {
                    end.set("a", Value::Num(a));
                    next.set("secondary", Value::object(end));
                    changed = true;
                }
            }
            if changed {
                replaced.get_or_insert_with(|| segments.clone())[index] = Value::object(next);
            }
        }
    }
    if let Some(list) = replaced {
        copied = true;
        let list = Value::array(list);
        result.set("segments", list.clone());
        // Decoders may expose the same segment table through both aliases.
        if figure.path(&["segment_decode", "segments"]).is_some_and(Value::truthy) {
            let decode = with(result.get("segment_decode"), "segments", list);
            result.set("segment_decode", decode);
        }
    }
    if let (Some(table), Some(polygons)) = (style.get("polygons").filter(|table| table.truthy()), figure.get("polyfills").filter(|p| p.truthy())) {
        let polygons: Vec<Value> = polygons.elements().map(|e| e.iter().collect()).unwrap_or_default();
        let mapped = polygons.iter().enumerate().map(|(index, polygon)| {
            let Some(values) = table.get(&styk_doc::json::to_string(&Value::Num(polygon_identity(polygon, index)))).filter(|values| values.truthy()) else { return polygon.clone() };
            let mut next = polygon.as_obj().cloned().unwrap_or_default();
            if let Some(color) = values.get("color") {
                next.set("color_rgb", rgb_value(color.as_f64().unwrap_or(f64::NAN)));
            }
            if let Some(z) = values.get("zIndex") {
                let z = z.as_f64().unwrap_or(f64::NAN);
                next.set("z_order", Value::Num(z));
                next.set("z_order_runtime_raw", Value::Num(z - 1.0));
            }
            if let Some(opacity) = values.get("opacity") {
                let alpha = alpha_byte(opacity.as_f64().unwrap_or(f64::NAN));
                next.set("alpha_raw", Value::Num(alpha));
                next.set("color_alpha", Value::Num(opacity_of(alpha)));
            }
            Value::object(next)
        });
        copied = true;
        result.set("polyfills", Value::array(mapped.collect()));
    }
    let has_z = |table: Option<&Value>| table.and_then(Value::as_obj).is_some_and(|entries| entries.iter().any(|(_, values)| values.get("zIndex").is_some()));
    if copied && (has_z(style.get("segments")) || has_z(style.get("polygons"))) {
        result.remove("segment_z_raw");
        result.remove("poly_z_raw");
    }
    Ok(if copied { Value::object(result) } else { figure.clone() })
}

/// One table per export (`createNativeStyleTable`). Native byte equality, rather than float identity, decides whether a
/// new figure record is necessary; assets stay shared.
pub(crate) struct StyleTable {
    figures: HashMap<i64, Value>,
    handles: HashMap<i64, HashMap<i64, Value>>,
    variants: HashMap<String, f64>,
    next_id: f64,
}

/// `Math.round((1 - value) * 255)`.
fn byte(value: f64) -> f64 {
    js_round((1.0 - value) * 255.0)
}

fn key(value: f64) -> i64 {
    value as i64
}

impl StyleTable {
    /// A table over the figure types `figures` (the ones the export starts with).
    pub fn new(figures: &[Value]) -> StyleTable {
        let mut table = StyleTable { figures: HashMap::new(), handles: HashMap::new(), variants: HashMap::new(), next_id: 1.0 };
        for figure in figures {
            let Some(id) = figure.get("figure_type_id").and_then(Value::as_f64) else { continue };
            table.figures.insert(key(id), figure.clone());
            table.next_id = table.next_id.max(id + 1.0);
        }
        table
    }

    /// The figure type `object` is drawn with: its own where no overlay differs from the definition, else a variant,
    /// appended to `figure_types` the first time it is met.
    pub fn id(&mut self, object: &Value, figure_types: &mut Vec<Value>) -> Result<f64, EditError> {
        let own = object.get("figure_type_id").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let Some(figure) = self.figures.get(&key(own)).cloned() else { return Ok(own) };
        let Some(style) = object.get("_stykStyle").filter(|style| style.truthy()) else { return Ok(own) };
        let handles = self.handles.entry(key(own)).or_insert_with(|| {
            figure.get("segments").and_then(Value::elements).map(|list| list.iter().filter_map(|s| Some((key(s.get("segment_id")?.as_f64()?), s))).collect()).unwrap_or_default()
        });
        let mut signature: Vec<String> = Vec::new();
        if object.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments") && figure.path(&["_styk", "colorMode"]).and_then(Value::as_str) != Some("segments") {
            signature.push("colorMode:segments".into());
        }
        let global = figure.path(&["segment_decode", "global_style"]);
        if let Some(polygons) = style.get("polygons").and_then(Value::as_obj) {
            let list: Vec<Value> = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            for (id, values) in polygons.iter() {
                let wanted = id.parse::<f64>().unwrap_or(f64::NAN);
                if list.iter().enumerate().any(|(index, polygon)| polygon_identity(polygon, index) == wanted) {
                    signature.push(format!("p:{id}:{}", styk_doc::json::to_string(values)));
                }
            }
        }
        let channels = |rgb: Option<&Value>| style_color([0, 1, 2].map(|i| rgb.and_then(|rgb| rgb.item(i)).and_then(|v| v.as_f64()).unwrap_or(0.0)));
        if let Some(color) = finite(style.get("outlineColor")) {
            if color != channels(global.and_then(|g| g.get("rgb"))) {
                signature.push(format!("oc:{}", number_text(color)));
            }
        }
        if let Some(width) = finite(style.get("outlineWidth")) {
            if width != number_or_zero(global.and_then(|g| g.get("outline_thickness"))) {
                signature.push(format!("ow:{}", number_text(width)));
            }
        }
        if let Some(opacity) = finite(style.get("outlineOpacity")) {
            let alpha = byte(opacity);
            if alpha != number_or_zero(global.and_then(|g| g.get("u30"))) {
                signature.push(format!("o:{}", number_text(alpha)));
            }
        }
        if let Some(table) = style.get("segments").and_then(Value::as_obj) {
            let mut ids: Vec<&std::sync::Arc<str>> = table.keys().collect();
            ids.sort_by(|a, b| a.parse::<f64>().unwrap_or(f64::NAN).partial_cmp(&b.parse::<f64>().unwrap_or(f64::NAN)).unwrap_or(std::cmp::Ordering::Equal));
            for id in ids {
                let (Some(segment), Some(over)) = (handles.get(&key(id.parse::<f64>().unwrap_or(f64::NAN))), table.get(id)) else { continue };
                if !over.truthy() {
                    continue;
                }
                if let Some(z) = finite(over.get("zIndex")) {
                    signature.push(format!("z:{id}:{}", number_text(z)));
                }
                if over.get("paint").is_some_and(Value::truthy) {
                    signature.push(format!("paint:{id}:{}", styk_doc::json::to_string(over)));
                }
                if let Some(color) = finite(over.get("color")) {
                    if color != channels(segment.get("color_rgb")) {
                        signature.push(format!("c:{id}:{}", number_text(color)));
                    }
                }
                if let Some(thickness) = finite(over.get("thickness")) {
                    if segment.get("thickness").and_then(Value::as_f64) != Some(thickness) {
                        signature.push(format!("w:{id}:{}", number_text(thickness)));
                    }
                }
                let secondary = segment.get("secondary").filter(|secondary| secondary.truthy());
                if let (Some(secondary), Some(color)) = (secondary, finite(over.get("gradientColor"))) {
                    if color != channels(secondary.get("rgb")) {
                        signature.push(format!("gc:{id}:{}", number_text(color)));
                    }
                }
                if let Some(opacity) = finite(over.get("opacity")) {
                    let alpha = byte(opacity);
                    let native = segment.as_obj().map_or(1.0, native_segment_opacity);
                    if alpha != byte(native) {
                        signature.push(format!("s:{id}:{}", number_text(alpha)));
                    }
                }
                if let (Some(secondary), Some(opacity)) = (secondary, finite(over.get("gradientOpacity"))) {
                    let alpha = byte(opacity);
                    if alpha != number_or_zero(secondary.get("a")) {
                        signature.push(format!("g:{id}:{}", number_text(alpha)));
                    }
                }
            }
        }
        if signature.is_empty() {
            return Ok(own);
        }
        let name = format!("{own}|{}", signature.join("|"));
        if let Some(id) = self.variants.get(&name) {
            return Ok(*id);
        }
        if figure_types.len() >= 65534 {
            return Err(EditError::Invalid("errors.pivotStyleMaterialize.animatedFigureStylesExceedTheNativePivotFigure".into()));
        }
        let resolved = resolve_instance_figure(&figure, object)?;
        let id = self.next_id;
        self.next_id += 1.0;
        let mut variant = resolved.as_obj().cloned().unwrap_or_default();
        variant.set("figure_type_id", Value::Num(id));
        let base = figure.get("name").filter(|name| name.truthy()).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| "Figure".into());
        variant.set("name", Value::str(&format!("{base} \u{b7} Style {}", self.variants.len() + 1)));
        figure_types.push(Value::object(variant));
        self.variants.insert(name, id);
        Ok(id)
    }
}

fn number_text(value: f64) -> String {
    styk_doc::json::to_string(&Value::Num(value))
}
