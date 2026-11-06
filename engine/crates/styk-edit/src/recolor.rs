//! Recolouring figures (src/figure-colors.mjs `validateRecolor`, `recolorObject`, `figurePalette`,
//! `attachedFigurePalette`; the overlays of src/animation-style.mjs `resolveInstanceFigure`; the
//! paints of src/paint.mjs) and the commands that recolour across frames through the range
//! operation (`editFigureColors`, `setFigureColor`, `replaceFigureColor`,
//! `resetFigureColors`; a polygon's colour from `updatePolygon`). A figure's colours become its
//! own style overlay (`_stykStyle`); its definition stays shared.

use styk_doc::{Obj, Value};
use styk_eval::records::paint::{Paint, Stop, normalize_paint, rgb_of_value, rgb_value, segment_paint};

use crate::range_plan::js_round;
use crate::record::{num, uid};
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// `x >>> 0`.
pub(crate) fn to_uint32(x: f64) -> u32 {
    if x.is_finite() { x.trunc().rem_euclid(4294967296.0) as u32 } else { 0 }
}

/// `x | 0`.
pub(crate) fn to_int32(x: f64) -> i32 {
    to_uint32(x) as i32
}

fn json(value: &Value) -> String {
    styk_doc::json::to_string(value)
}

/// A key of a style table: a handle or polygon identity as JavaScript spells it.
fn key(id: f64) -> String {
    json(&Value::Num(id))
}

/// `rgbOf(color)`: a packed `0xRRGGBB` as three bytes.
pub(crate) fn rgb_of(color: f64) -> [f64; 3] {
    let n = to_uint32(color);
    [(n >> 16 & 255) as f64, (n >> 8 & 255) as f64, (n & 255) as f64]
}

/// `styleColor(rgb)`: three bytes packed as `0xRRGGBB`.
pub(crate) fn style_color(rgb: [f64; 3]) -> f64 {
    let [r, g, b] = rgb.map(|v| if v.is_nan() { 0 } else { to_int32(v) });
    ((r.wrapping_shl(16)) | (g.wrapping_shl(8)) | b) as u32 as f64
}

/// `hexColor(rgb)`.
fn hex_color(rgb: [f64; 3]) -> String {
    let mut out = String::from("#");
    for v in rgb {
        let n = js_round(v);
        if n >= 0.0 {
            out.push_str(&format!("{:02x}", n as i64));
        } else {
            out.push_str(&format!("-{:x}", (-n) as i64));
        }
    }
    out
}

/// `parseColor(value).color`: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (the alpha read and dropped).
fn parse_color(text: &str) -> Result<[f64; 3], EditError> {
    let digits = text.strip_prefix('#').unwrap_or(text);
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
    let expanded: String = if (digits.len() == 3 || digits.len() == 4) && hex(digits) { digits.chars().flat_map(|c| [c, c]).collect() } else { digits.to_string() };
    if !((expanded.len() == 6 || expanded.len() == 8) && hex(&expanded)) {
        return Err(invalid("errors.paint.useAValidHexColorOptionallyIncludingAlpha"));
    }
    Ok([0, 2, 4].map(|i| u8::from_str_radix(&expanded[i..i + 2], 16).map_or(f64::NAN, f64::from)))
}

/// `rgb(value)` of src/figure-colors.mjs: a hex colour or three bytes.
fn rgb(value: &Value) -> Result<[f64; 3], EditError> {
    if let Some(text) = value.as_str() {
        return parse_color(text);
    }
    match value.elements() {
        Some(list) if list.len() == 3 && list.iter().all(|v| v.as_f64().is_some_and(|n| n.fract() == 0.0 && (0.0..=255.0).contains(&n))) => Ok([0, 1, 2].map(|i| list.get(i).and_then(|v| v.as_f64()).unwrap())),
        _ => Err(invalid("errors.figureColors.chooseThreeRgbBytesOrAHexColor")),
    }
}

/// `opacity(value)` of src/figure-colors.mjs.
fn opacity(value: &Value) -> Result<f64, EditError> {
    match value.as_f64() {
        Some(n) if n.is_finite() && (0.0..=1.0).contains(&n) => Ok(n),
        _ => Err(invalid("errors.figureColors.opacityMustBeBetweenZeroAndOne")),
    }
}

/// `samplePaint(p, t).color`.
fn sample_paint(p: &Paint, t: f64) -> [f64; 3] {
    let stops = &p.stops;
    if t <= stops[0].offset {
        return stops[0].rgb();
    }
    for i in 1..stops.len() {
        if t < stops[i].offset {
            let (a, b) = (&stops[i - 1], &stops[i]);
            let span = b.offset - a.offset;
            let f = (t - a.offset) / if span == 0.0 || span.is_nan() { 1.0 } else { span };
            let (x, y) = (a.rgb(), b.rgb());
            return [0, 1, 2].map(|j| x[j] + (y[j] - x[j]) * f);
        }
    }
    stops.last().unwrap().rgb()
}

/// `usesSegmentColors(report, figure, object)`: format 5, or a figure or instance that colours its segments.
pub(crate) fn uses_segment_colors(version: f64, figure: &Value, object: &Value) -> bool {
    let segments = |v: &Value| v.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments");
    version >= 5.0 || segments(figure) || segments(object)
}

/// `color(raw).rgb`: a native colour (`0xAABBGGRR`) as bytes.
pub(crate) fn native_rgb(raw: f64) -> [f64; 3] {
    let n = to_uint32(raw);
    [(n & 255) as f64, (n >> 8 & 255) as f64, (n >> 16 & 255) as f64]
}

/// `mixColor(base, raw)`: the override blended over a colour by its alpha.
pub(crate) fn mix_color(base: [f64; 3], raw: f64) -> [f64; 3] {
    let k = (to_uint32(raw) >> 24) as f64;
    if k == 0.0 {
        return base;
    }
    let c = native_rgb(raw);
    if k == 255.0 {
        return c;
    }
    [0, 1, 2].map(|i| ((base[i] * 256.0 + k * (c[i] - base[i])) / 256.0).floor())
}

pub(crate) fn override_raw(object: &Value) -> f64 {
    object.get("color_override_raw").map_or(f64::NAN, |v| v.as_f64().unwrap_or(f64::NAN))
}

/// `displayedColor(report, figure, object, rgb)`.
fn displayed_color(version: f64, figure: &Value, object: &Value, rgb: [f64; 3]) -> [f64; 3] {
    let raw = override_raw(object);
    if !uses_segment_colors(version, figure, object) {
        return if to_int32(raw) < 0 { [0.0; 3] } else { native_rgb(raw) };
    }
    mix_color(rgb, raw)
}

/// `displayedColor` of a colour record: without an override (segment colours) the record itself,
/// as `mixColor` returns its base.
fn displayed_value(version: f64, figure: &Value, object: &Value, color: &Value) -> Value {
    let raw = override_raw(object);
    if uses_segment_colors(version, figure, object) && to_uint32(raw) >> 24 == 0 {
        return color.clone();
    }
    rgb_value(displayed_color(version, figure, object, rgb_of_value(Some(color)).unwrap_or([f64::NAN; 3])))
}

/// `displayedSegmentPaint(report, figure, object, segment)`: a full override shows solid.
fn displayed_segment_paint(version: f64, figure: &Value, object: &Value, segment: &Value) -> Result<Paint, EditError> {
    let mut paint = segment_paint(segment)?;
    if uses_segment_colors(version, figure, object) && to_uint32(override_raw(object)) >> 24 == 255 {
        paint.kind = "solid".into();
        paint.stops.truncate(1);
    }
    for stop in paint.stops.iter_mut() {
        stop.color = displayed_value(version, figure, object, &stop.color);
    }
    Ok(paint)
}

/// `polygonIdentity(polygon, index)`.
pub(crate) fn polygon_identity(polygon: &Value, index: usize) -> f64 {
    polygon.get("polyfill_id").filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(index as f64 + 1.0)
}

/// `meshPaletteColor(figure, object, index)`.
fn mesh_palette_color(figure: &Value, object: &Value, index: usize) -> Option<[f64; 3]> {
    match object.path(&["_stykStyle", "meshColors"]).and_then(|t| t.get(&index.to_string())) {
        Some(value) => Some(rgb_of(value.as_f64().unwrap_or(f64::NAN))),
        None => rgb_of_value(figure.path(&["_styk", "spatialMesh", "colors"]).and_then(|c| c.item(index)).as_ref()),
    }
}

fn mesh_colors(figure: &Value) -> usize {
    figure.path(&["_styk", "spatialMesh", "colors"]).and_then(Value::array_len).unwrap_or(0)
}

/// `alphaByte(opacity)`.
pub(crate) fn alpha_byte(opacity: f64) -> f64 {
    js_round((1.0 - opacity) * 255.0)
}

/// `resolveInstanceFigure(figure, object)` for what recolouring reads: the segments and
/// polygons with the instance's overrides (`_stykStyle.segments`, `.polygons`).
pub(crate) fn resolve(figure: &Value, object: &Value) -> Result<(Vec<Value>, Vec<Value>), EditError> {
    let list = |key: &str| figure.get(key).and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
    let (mut segments, mut polygons) = (list("segments"), list("polyfills"));
    let Some(style) = object.get("_stykStyle").filter(|s| !s.is_null()) else { return Ok((segments, polygons)) };
    let finite = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite());
    if let Some(table) = style.get("segments").filter(|t| t.truthy()) {
        for segment in segments.iter_mut() {
            let Some(id) = num(segment, "segment_id") else { continue };
            let Some(over) = table.get(&key(id)).filter(|o| o.truthy()) else { continue };
            let mut next = segment.as_obj().cloned().unwrap_or_default();
            if let Some(z) = finite(over.get("zIndex")) {
                next.set("z_order", Value::Num(z));
                next.set("z_order_runtime_raw", Value::Num(z - 1.0));
            }
            if let Some(paint) = over.get("paint").filter(|p| p.truthy()) {
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
            }
            if let Some(color) = finite(over.get("color")) {
                next.set("color_rgb", rgb_value(rgb_of(color)));
            }
            if let Some(thickness) = finite(over.get("thickness")) {
                next.set("thickness", Value::Num(thickness));
            }
            let secondary = |next: &Obj| next.get("secondary").filter(|s| s.truthy()).and_then(Value::as_obj).cloned();
            if let (Some(mut end), Some(color)) = (secondary(&next), finite(over.get("gradientColor"))) {
                end.set("rgb", rgb_value(rgb_of(color)));
                next.set("secondary", Value::object(end));
            }
            if let Some(opacity) = finite(over.get("opacity")) {
                let transparency = alpha_byte(opacity);
                let native = match next.get("transparency") {
                    None => next.get("color_alpha").and_then(Value::as_f64).unwrap_or(1.0),
                    Some(t) => 1.0 - t.as_f64().unwrap_or(0.0) / 255.0,
                };
                if transparency != alpha_byte(native) {
                    next.set("transparency", Value::Num(transparency));
                    next.set("color_alpha", Value::Num(1.0 - transparency / 255.0));
                }
            }
            if let (Some(mut end), Some(opacity)) = (secondary(&next), finite(over.get("gradientOpacity"))) {
                let a = alpha_byte(opacity);
                if a != end.get("a").and_then(Value::as_f64).unwrap_or(0.0) {
                    end.set("a", Value::Num(a));
                    next.set("secondary", Value::object(end));
                }
            }
            *segment = Value::object(next);
        }
    }
    if let Some(table) = style.get("polygons").filter(|t| t.truthy()) {
        for (index, polygon) in polygons.iter_mut().enumerate() {
            let Some(values) = table.get(&key(polygon_identity(polygon, index))).filter(|v| v.truthy()) else { continue };
            if let Some(color) = values.get("color") {
                let mut next = polygon.as_obj().cloned().unwrap_or_default();
                next.set("color_rgb", rgb_value(rgb_of(color.as_f64().unwrap_or(f64::NAN))));
                *polygon = Value::object(next);
            }
        }
    }
    Ok((segments, polygons))
}

/// The colours of a palette: segment handles with their stops, polygons, mesh colours.
#[derive(Clone, Debug, Default)]
pub(crate) struct Targets {
    segments: Vec<(f64, Vec<usize>)>,
    polygons: Vec<f64>,
    mesh: Option<Vec<usize>>,
}

/// `operation.targets`: the colours to change, and per instance of a joined assembly its own
/// colours and definition (`targets.instances`).
#[derive(Clone, Debug)]
pub(crate) struct Spec {
    own: Targets,
    instances: Option<Vec<(u32, Targets, Option<Value>)>>,
}

/// A colour row of a palette (`figurePalette`).
#[derive(Clone, Debug)]
struct Row {
    color: String,
    targets: Targets,
    instances: Vec<(u32, Targets, Value)>,
}

fn palette_row(rows: &mut Vec<Row>, rgb: [f64; 3]) -> &mut Row {
    let color = hex_color(rgb);
    match rows.iter().position(|r| r.color == color) {
        Some(at) => &mut rows[at],
        None => {
            rows.push(Row { color, targets: Targets::default(), instances: Vec::new() });
            rows.last_mut().unwrap()
        }
    }
}

/// `figurePalette(report, figure, object)`, in the order rows first appear (callers look a colour up).
fn figure_palette(version: f64, figure: &Value, object: &Value) -> Result<Vec<Row>, EditError> {
    let (segments, polygons) = resolve(figure, object)?;
    let resolved = resolved_figure(figure, object);
    let mut rows: Vec<Row> = Vec::new();
    for segment in &segments {
        let paint = displayed_segment_paint(version, &resolved, object, segment)?;
        let id = num(segment, "segment_id").unwrap_or(f64::NAN);
        let mut seen: Vec<String> = Vec::new();
        for (index, stop) in paint.stops.iter().enumerate() {
            let row = palette_row(&mut rows, stop.rgb());
            if !seen.contains(&row.color) {
                seen.push(row.color.clone());
                row.targets.segments.push((id, Vec::new()));
            }
            let entry = row.targets.segments.iter_mut().rev().find(|(h, _)| *h == id || (h.is_nan() && id.is_nan())).unwrap();
            entry.1.push(index);
        }
    }
    for (index, polygon) in polygons.iter().enumerate() {
        let color = rgb_of_value(polygon.get("color_rgb").filter(|c| !c.is_null())).unwrap_or([0.0; 3]);
        palette_row(&mut rows, displayed_color(version, &resolved, object, color)).targets.polygons.push(polygon_identity(polygon, index));
    }
    for index in 0..mesh_colors(figure) {
        let color = mesh_palette_color(figure, object, index).unwrap_or([f64::NAN; 3]);
        palette_row(&mut rows, displayed_color(version, &resolved, object, color)).targets.mesh.get_or_insert_with(Vec::new).push(index);
    }
    Ok(rows)
}

/// The figure as `resolveInstanceFigure` returns it, as far as `usesSegmentColors` reads it.
fn resolved_figure(figure: &Value, object: &Value) -> Value {
    let object_segments = object.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments");
    let figure_segments = figure.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments");
    if !object_segments || figure_segments {
        return figure.clone();
    }
    let mut styk = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("colorMode", Value::str("segments"));
    let mut out = figure.as_obj().cloned().unwrap_or_default();
    out.set("_styk", Value::object(styk));
    Value::object(out)
}

/// `attachedFigurePalette(report, frame, uid)`: the palette of a figure and those joined below
/// it, each colour naming the instances that show it (when there are several figures).
fn attached_palette(version: f64, figures: &[Value], objects: &[Value], id: u32) -> Result<Vec<Row>, EditError> {
    let Some(start) = objects.iter().position(|o| uid(o) == Some(id)) else { return Ok(Vec::new()) };
    let mut queue = vec![start];
    let mut cursor = 0;
    let mut rows: Vec<Row> = Vec::new();
    while cursor < queue.len() {
        let object = &objects[queue[cursor]];
        let type_id = num(object, "figure_type_id");
        if let Some(figure) = figures.iter().find(|f| num(f, "figure_type_id") == type_id && type_id.is_some()) {
            for entry in figure_palette(version, figure, object)? {
                let row = match rows.iter().position(|r| r.color == entry.color) {
                    Some(at) => &mut rows[at],
                    None => {
                        rows.push(Row { color: entry.color.clone(), targets: Targets::default(), instances: Vec::new() });
                        rows.last_mut().unwrap()
                    }
                };
                row.targets.segments.extend(entry.targets.segments.iter().cloned());
                row.targets.polygons.extend(entry.targets.polygons.iter().copied());
                if let Some(mesh) = &entry.targets.mesh {
                    let merged = row.targets.mesh.get_or_insert_with(Vec::new);
                    for &index in mesh {
                        if !merged.contains(&index) {
                            merged.push(index);
                        }
                    }
                }
                if let Some(id) = uid(object) {
                    let figure_type = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
                    match row.instances.iter_mut().find(|(u, _, _)| *u == id) {
                        Some(instance) => *instance = (id, entry.targets.clone(), figure_type),
                        None => row.instances.push((id, entry.targets.clone(), figure_type)),
                    }
                }
            }
        }
        let slot = queue[cursor];
        for (child, o) in objects.iter().enumerate() {
            if crate::record::join_target(o) == Some(slot) && !queue.contains(&child) {
                queue.push(child);
            }
        }
        cursor += 1;
    }
    if queue.len() == 1 {
        for row in rows.iter_mut() {
            row.instances.clear();
        }
    }
    Ok(rows)
}

/// The palette targets of an operation (`targets` checked as `validateRecolor` checks them).
fn parse_targets(value: &Value) -> Result<Targets, EditError> {
    let bad = || invalid("errors.figureColors.chooseValidPaletteTargets");
    let polygons_value = value.get("polygons").filter(|p| !p.is_null());
    let (Some(segments), true) = (value.get("segments").filter(|s| s.is_array()).and_then(Value::elements), polygons_value.is_none_or(Value::is_array)) else { return Err(bad()) };
    let mut out = Targets::default();
    for entry in segments.iter() {
        let handle = entry.get("handleId").and_then(Value::as_f64).filter(|h| h.fract() == 0.0 && (1.0..=65535.0).contains(h));
        let stops = entry.get("stops").filter(|s| s.is_array()).and_then(Value::elements).map(|e| e.iter().map(|v| v.as_f64().filter(|i| i.fract() == 0.0 && (0.0..32.0).contains(i))).collect::<Option<Vec<_>>>());
        match (handle, stops) {
            (Some(handle), Some(Some(stops))) => out.segments.push((handle, stops.into_iter().map(|i| i as usize).collect())),
            _ => return Err(invalid("errors.figureColors.chooseValidSegmentColorStops")),
        }
    }
    for id in polygons_value.and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
        match id.as_f64().filter(|i| i.fract() == 0.0 && (1.0..=65535.0).contains(i)) {
            Some(id) => out.polygons.push(id),
            None => return Err(invalid("errors.figureColors.chooseValidFillIdentities")),
        }
    }
    if let Some(mesh) = value.get("meshColors") {
        let list: Option<Vec<f64>> = mesh.is_array().then(|| mesh.elements().map(|e| e.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default());
        let Some(list) = list else { return Err(bad()) };
        let distinct = list.iter().enumerate().all(|(i, v)| !list[..i].contains(v));
        if list.len() > 1024 || !distinct || list.iter().any(|i| !(i.fract() == 0.0 && (0.0..1024.0).contains(i))) {
            return Err(bad());
        }
        out.mesh = Some(list.into_iter().map(|i| i as usize).collect());
    }
    Ok(out)
}

/// What a recolouring operation asks for, validated (`validateRecolor`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    All,
    Replace,
    Style,
    Reset,
}

/// A style patch (`{color, paint, gradient, opacity, thickness}`); `gradient: Some(None)` is a
/// gradient removed.
#[derive(Clone, Debug, Default)]
struct Style {
    color: Option<[f64; 3]>,
    paint: Option<Paint>,
    gradient: Option<Option<([f64; 3], Option<f64>)>>,
    opacity: Option<f64>,
    thickness: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct Recolor {
    pub mode: Mode,
    pub color: Option<[f64; 3]>,
    from: Option<[f64; 3]>,
    opacity: Option<f64>,
    targets: Option<Spec>,
    figure_type_id: Option<Value>,
    style: Style,
}

/// `validateRecolor(operation)`.
pub(crate) fn validate_recolor(operation: &Value) -> Result<Recolor, EditError> {
    let mode = match operation.get("mode").and_then(Value::as_str) {
        Some("all") => Mode::All,
        Some("replace") => Mode::Replace,
        Some("style") => Mode::Style,
        Some("reset") => Mode::Reset,
        _ => return Err(invalid("errors.figureColors.chooseAColorOperation")),
    };
    let present = |key: &str| operation.get(key).filter(|_| operation.as_obj().is_some_and(|o| o.contains(key)));
    let color = present("color").map(rgb).transpose()?;
    let from = present("from").map(rgb).transpose()?;
    let opacity = present("opacity").map(opacity).transpose()?;
    let targets_value = operation.get("targets").filter(|t| t.truthy());
    if mode == Mode::Replace && (color.is_none() || from.is_none() && targets_value.is_none()) {
        return Err(invalid("errors.figureColors.chooseTheColorToReplace"));
    }
    let mut targets = None;
    if let Some(value) = targets_value {
        let mut instances = None;
        if let Some(table) = value.get("instances").filter(|t| t.truthy()) {
            let mut list = Vec::new();
            for (id, entry) in table.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
                let number = id.parse::<f64>().ok().filter(|n| n.fract() == 0.0 && (0.0..=4294967295.0).contains(n));
                let (Some(number), false) = (number, entry.get("instances").is_some_and(Value::truthy)) else { return Err(invalid("errors.figureColors.chooseValidPaletteInstances")) };
                list.push((number as u32, parse_targets(&entry)?, entry.get("figureTypeId").cloned()));
            }
            instances = Some(list);
        }
        targets = Some(Spec { own: parse_targets(value)?, instances });
    }
    let mut style = Style::default();
    if mode == Mode::Style {
        let patch = operation.get("patch").and_then(Value::as_obj).cloned().unwrap_or_default();
        if let Some(key) = patch.keys().find(|k| !["color", "paint", "gradient", "opacity", "thickness"].contains(&&***k)) {
            return Err(crate::invalid_with("errors.figureColors.unsupportedColorStyle", vec![("key", Value::str(key))]));
        }
        if let Some(color) = patch.get("color") {
            style.color = Some(rgb(color)?);
        }
        if let Some(paint) = patch.get("paint").filter(|p| p.truthy()) {
            style.paint = Some(normalize_paint(paint)?);
        }
        if let Some(value) = patch.get("opacity") {
            style.opacity = Some(self::opacity(value)?);
        }
        if let Some(thickness) = patch.get("thickness") {
            match thickness.as_f64() {
                Some(t) if t.is_finite() && (0.0..=1e6).contains(&t) => style.thickness = Some(t),
                _ => return Err(invalid("errors.figureColors.invalidSegmentThickness")),
            }
        }
        if let Some(gradient) = patch.get("gradient") {
            style.gradient = Some(match gradient.truthy() {
                false => None,
                true => {
                    let color = match gradient.get("color").filter(|c| !c.is_null()) {
                        Some(color) => rgb(color)?,
                        None => [255.0; 3],
                    };
                    let opacity = gradient.get("opacity").map(self::opacity).transpose()?;
                    Some((color, opacity))
                }
            });
        }
    }
    let figure_type_id = present("figureTypeId").cloned();
    Ok(Recolor { mode, color, from, opacity, targets, figure_type_id, style })
}

/// `styleColor(rgb)` of a colour that may be missing (`rgb?.[i] ?? 0`).
fn style_color_of(value: Option<&Value>) -> f64 {
    let channel = |i: usize| value.and_then(|v| v.item(i)).and_then(|v| v.as_f64()).unwrap_or(0.0);
    style_color([channel(0), channel(1), channel(2)])
}

/// `write(table, id, patch)`: the entry merged with `patch`, kept only when it changes.
fn write(table: &mut Obj, id: f64, patch: Vec<(&str, Value)>, changed: &mut bool) {
    let name = key(id);
    let before = table.get(&name).and_then(Value::as_obj).cloned().unwrap_or_default();
    let mut next = before.clone();
    for (k, v) in patch {
        next.set(k, v);
    }
    if json(&Value::object(before)) != json(&Value::object(next.clone())) {
        table.set(&name, Value::object(next));
        *changed = true;
    }
}

/// `recolorObject(report, figure, object, operation)`: the recoloured figure, `None` when
/// nothing changes. Recolouring writes the instance's style overlay; a figure that still
/// takes the native whole-figure colour switches to its segments' colours.
pub(crate) fn recolor_object(version: f64, figure: Option<&Value>, object: &Value, operation: &Recolor) -> Result<Option<Obj>, EditError> {
    let Some(figure) = figure else { return Ok(None) };
    let mut targets = operation.targets.as_ref().map(|t| t.own.clone());
    let mut figure_type_id = operation.figure_type_id.clone();
    if let Some(instances) = operation.targets.as_ref().and_then(|t| t.instances.as_ref()) {
        let Some((_, own, type_id)) = uid(object).and_then(|id| instances.iter().find(|(u, _, _)| *u == id)) else { return Ok(None) };
        targets = Some(own.clone());
        figure_type_id = type_id.clone();
    }
    if let Some(type_id) = &figure_type_id
        && !crate::history::js_strict_eq(type_id, figure.get("figure_type_id").unwrap_or(&Value::Null))
    {
        return Ok(None);
    }
    let mut fields: Vec<(&str, Value)> = Vec::new();
    if let Some(opacity) = operation.opacity {
        let value = js_round((1.0 - opacity) * 255.0);
        if value != object.get("field28").filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(0.0) {
            fields.push(("field28", Value::Num(value)));
        }
    }
    let assign = |record: &mut Obj, fields: &[(&str, Value)]| {
        for (k, v) in fields {
            record.set(k, v.clone());
        }
    };
    if operation.mode == Mode::All && operation.color.is_none() {
        if fields.is_empty() {
            return Ok(None);
        }
        let mut next = object.as_obj().cloned().unwrap_or_default();
        assign(&mut next, &fields);
        return Ok(Some(next));
    }
    let hex = |c: Option<[f64; 3]>| c.map(hex_color);
    if operation.mode == Mode::Replace && targets.is_none() && hex(operation.from) == hex(operation.color) {
        return Ok(None);
    }
    let (segments, polygons) = resolve(figure, object)?;
    let resolved = resolved_figure(figure, object);
    if operation.mode == Mode::Replace && targets.is_none() {
        let wanted = hex(operation.from);
        targets = figure_palette(version, figure, object)?.into_iter().find(|r| Some(&r.color) == wanted.as_ref()).map(|r| r.targets);
        if targets.is_none() {
            return Ok(None);
        }
    }
    let empty = Targets::default();
    let targets = targets.as_ref().unwrap_or(&empty);
    let matched = |id: f64| targets.segments.iter().rev().find(|(h, _)| *h == id).map(|(_, stops)| stops.clone());
    let mesh = mesh_colors(figure);
    for &index in targets.mesh.as_deref().unwrap_or(&[]) {
        if index >= mesh {
            return Err(invalid("errors.figureColors.chooseValidPaletteTargets"));
        }
    }
    let segment_colors = uses_segment_colors(version, figure, object);
    let needs_normalize = !segment_colors || to_uint32(override_raw(object)) >> 24 != 0;
    let normalize = operation.mode == Mode::Reset || needs_normalize;
    let base = object.get("_stykStyle").filter(|s| s.truthy());
    let mut style = base.and_then(Value::as_obj).cloned().unwrap_or_default();
    let table = |name: &str| base.and_then(|b| b.get(name)).and_then(Value::as_obj).cloned().unwrap_or_default();
    let mut segment_table = table("segments");
    let mut polygon_table = table("polygons");
    let mut mesh_table = base.and_then(|b| b.get("meshColors")).filter(|m| m.truthy()).map(|_| table("meshColors"));
    style.set("segments", Value::Null);
    style.set("polygons", Value::Null);
    if mesh_table.is_some() {
        style.set("meshColors", Value::Null);
    }
    let mut changed = false;
    let style_paint = operation.mode == Mode::Style && (operation.style.paint.is_some() || operation.style.gradient.is_some());
    let all_or_reset = matches!(operation.mode, Mode::All | Mode::Reset);
    let definition: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    for (index, segment) in segments.iter().enumerate() {
        let id = num(segment, "segment_id").unwrap_or(f64::NAN);
        let matches = matched(id);
        let selected = all_or_reset || matches.is_some();
        if !normalize && !selected {
            continue;
        }
        let mut paint = displayed_segment_paint(version, &resolved, object, segment)?;
        if operation.mode == Mode::Reset {
            let original = segment_paint(definition.get(index).unwrap_or(&Value::Null))?;
            for stop in paint.stops.iter_mut() {
                stop.color = rgb_value(sample_paint(&original, stop.offset).map(js_round));
            }
        }
        if let (Mode::All, Some(color)) = (operation.mode, operation.color) {
            for stop in paint.stops.iter_mut() {
                stop.color = rgb_value(color);
            }
        }
        if let (Mode::Replace, Some(stops)) = (operation.mode, &matches) {
            for &at in stops {
                let Some(stop) = paint.stops.get_mut(at) else { return Err(invalid("errors.figureColors.theGradientChangedReopenThePalette")) };
                stop.color = rgb_value(operation.color.unwrap_or([f64::NAN; 3]));
            }
        }
        if operation.mode == Mode::Style && selected {
            let patch = &operation.style;
            if let Some(next) = &patch.paint {
                paint = next.clone();
            }
            if let Some(color) = patch.color {
                paint.stops[0].color = rgb_value(color);
            }
            if let Some(opacity) = patch.opacity {
                paint.stops[0].opacity = opacity;
            }
            match &patch.gradient {
                None => {}
                Some(None) => {
                    paint.kind = "solid".into();
                    paint.stops.truncate(1);
                }
                Some(Some((color, opacity))) => {
                    if paint.solid() {
                        paint.kind = "linear".into();
                        paint.stops.push(Stop { offset: 1.0, color: rgb_value(*color), opacity: 1.0 });
                    }
                    let last = paint.stops.last_mut().unwrap();
                    last.color = rgb_value(*color);
                    if let Some(opacity) = opacity {
                        last.opacity = *opacity;
                    }
                }
            }
            let mut values: Vec<(&str, Value)> = Vec::new();
            if let Some(opacity) = patch.opacity {
                values.push(("opacity", Value::Num(opacity)));
            }
            if let Some(thickness) = patch.thickness {
                values.push(("thickness", Value::Num(thickness)));
            }
            write(&mut segment_table, id, values, &mut changed);
        }
        // `putPaint(segment, paint)`.
        let (first, last) = (paint.stops[0].clone(), paint.stops.last().unwrap().clone());
        let mut patch: Vec<(&str, Value)> = vec![("color", Value::Num(style_color_of(Some(&first.color))))];
        if !paint.solid() {
            patch.push(("gradientColor", Value::Num(style_color_of(Some(&last.color)))));
        }
        let secondary = segment.get("secondary").is_some_and(Value::truthy);
        if segment.get("paint").is_some_and(Value::truthy) || secondary && paint.solid() || style_paint {
            patch.push(("paint", paint.value()));
        }
        if style_paint {
            patch.push(("opacity", Value::Num(first.opacity)));
            if !paint.solid() {
                patch.push(("gradientOpacity", Value::Num(last.opacity)));
            }
        }
        write(&mut segment_table, id, patch, &mut changed);
    }
    let figure_polygons: Vec<Value> = figure.get("polyfills").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    for (index, polygon) in polygons.iter().enumerate() {
        let id = polygon_identity(polygon, index);
        let selected = all_or_reset || targets.polygons.contains(&id);
        if !normalize && !selected {
            continue;
        }
        let mut value: Option<Value> = if operation.mode == Mode::Reset {
            figure_polygons.get(index).and_then(|p| p.get("color_rgb").cloned())
        } else {
            let color = polygon.get("color_rgb").filter(|c| !c.is_null()).cloned().unwrap_or_else(|| rgb_value([0.0; 3]));
            Some(displayed_value(version, &resolved, object, &color))
        };
        if let (true, Some(color)) = (selected, operation.color) {
            value = Some(rgb_value(color));
        }
        if let (true, Mode::Style, Some(color)) = (selected, operation.mode, operation.style.color) {
            value = Some(rgb_value(color));
        }
        let mut patch = vec![("color", Value::Num(style_color_of(value.as_ref())))];
        if let (true, Mode::Style, Some(opacity)) = (selected, operation.mode, operation.style.opacity) {
            patch.push(("opacity", Value::Num(opacity)));
        }
        write(&mut polygon_table, id, patch, &mut changed);
    }
    let definition_mesh: Vec<Value> = figure.path(&["_styk", "spatialMesh", "colors"]).and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    for index in 0..mesh {
        let selected = all_or_reset || targets.mesh.as_deref().unwrap_or(&[]).contains(&index);
        if !normalize && !selected {
            continue;
        }
        let mut value: Option<Value> = if operation.mode == Mode::Reset {
            definition_mesh.get(index).cloned()
        } else {
            mesh_palette_color(figure, object, index).map(|c| rgb_value(displayed_color(version, &resolved, object, c)))
        };
        if let (true, Some(color)) = (selected, operation.color) {
            value = Some(rgb_value(color));
        }
        if let (true, Mode::Style, Some(color)) = (selected, operation.mode, operation.style.color) {
            value = Some(rgb_value(color));
        }
        let next = style_color_of(value.as_ref());
        let name = index.to_string();
        let before = mesh_table.as_ref().and_then(|t| t.get(&name)).and_then(Value::as_f64);
        if before != Some(next) {
            mesh_table.get_or_insert_with(|| table("meshColors")).set(&name, Value::Num(next));
            changed = true;
        }
    }
    if !changed && !needs_normalize && fields.is_empty() {
        return Ok(None);
    }
    style.set("segments", Value::object(segment_table));
    style.set("polygons", Value::object(polygon_table));
    if let Some(mesh_table) = mesh_table {
        style.set("meshColors", Value::object(mesh_table));
    }
    let mut next = object.as_obj().cloned().unwrap_or_default();
    assign(&mut next, &fields);
    if !segment_colors {
        let mut styk = object.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("colorMode", Value::str("segments"));
        next.set("_styk", Value::object(styk));
    }
    next.set("_stykStyle", Value::object(style));
    next.set("color_override_raw", Value::Num(0.0));
    Ok(Some(next))
}

impl Editor {
    /// The recolouring commands by their JavaScript names; `None` for other calls.
    pub(crate) fn recolor_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        Some(match method {
            "editFigureColors" => self.edit_figure_colors(&arg(0), &arg(1)),
            "setFigureColor" => {
                // `setFigureColor(color, {opacity, ...range})`.
                let mut operation = Obj::new();
                operation.set("mode", Value::str("all"));
                // A color the caller left out (`undefined`) reaches the session as null.
                if let Some(color) = args.first().filter(|color| !color.is_null()) {
                    operation.set("color", color.clone());
                }
                let mut range = arg(1).as_obj().cloned().unwrap_or_default();
                if let Some(opacity) = range.remove("opacity") {
                    operation.set("opacity", opacity);
                }
                self.edit_figure_colors(&Value::object(operation), &Value::object(range))
            }
            "replaceFigureColor" => self.replace_figure_color(args.first(), args.get(1), &arg(2)),
            "resetFigureColors" => {
                let mut operation = Obj::new();
                operation.set("mode", Value::str("reset"));
                self.edit_figure_colors(&Value::object(operation), &arg(0))
            }
            _ => return None,
        })
    }

    /// `editFigureColors(operation, {indices, ...options})`: the selected figures (or
    /// `options.uids`) recoloured at the playhead or across `indices`.
    pub(crate) fn edit_figure_colors(&mut self, operation: &Value, options: &Value) -> Result<Value, EditError> {
        let recolor = validate_recolor(operation)?;
        let uids: Vec<u32> = match options.get("uids").filter(|u| !u.is_null()) {
            Some(list) => list.elements().map(|e| e.iter().filter_map(|v| v.as_f64()).map(|v| v as u32).collect()).unwrap_or_default(),
            None => self.selection.uids.clone(),
        };
        let layers = self.report.path(&["_styk", "layers", "byId"]).cloned();
        let hidden_or_locked = |editor: &Editor, id: u32| {
            let layer = layers.as_ref().and_then(|l| l.get(&editor.layer_of(id)).cloned());
            layer.as_ref().is_some_and(|l| l.get("locked").and_then(Value::as_bool) == Some(true) || l.get("visible").and_then(Value::as_bool) == Some(false))
                || editor.layer_focus_locked(&editor.layer_of(id))
        };
        if uids.iter().any(|&id| hidden_or_locked(self, id)) {
            return Err(invalid("errors.editorColors.showAndUnlockTheSelectedLayersBeforeRecoloring"));
        }
        let label = match recolor.mode {
            Mode::Replace => "Replace figure color",
            Mode::Style => "Edit segment colors",
            Mode::Reset => "Reset figure colors",
            Mode::All => "Set figure color",
        };
        // `{...options, uids, ...(indices ? {indices} : {atPlayhead: true}), label}`.
        let mut merged = options.as_obj().cloned().unwrap_or_default();
        let indices = merged.remove("indices").filter(Value::truthy);
        merged.set("uids", Value::array(uids.iter().map(|&u| Value::Num(u as f64)).collect()));
        match indices {
            Some(indices) => merged.set("indices", indices),
            None if self.options.property_channels && !self.sheet() => return Err(EditError::Unported("recolouring with property channels on a native timeline".into())),
            None => merged.set("atPlayhead", Value::Bool(true)),
        }
        merged.set("label", Value::str(label));
        let merged = Value::object(merged);
        self.apply_figure_range(crate::range::Request::Recolor(Box::new(recolor)), crate::range::Options::of(&merged, merged.get("indices")))
    }

    /// `replaceFigureColor(from, color, {targets, ...options})`: with a whole figure selected,
    /// a colour of the assembly's palette is replaced in every figure that shows it.
    fn replace_figure_color(&mut self, from: Option<&Value>, color: Option<&Value>, options: &Value) -> Result<Value, EditError> {
        let mut operation = Obj::new();
        operation.set("mode", Value::str("replace"));
        if let Some(from) = from {
            operation.set("from", from.clone());
        }
        if let Some(color) = color {
            operation.set("color", color.clone());
        }
        let mut options = options.as_obj().cloned().unwrap_or_default();
        let mut targets = options.remove("targets").filter(|t| !t.is_null());
        if let Some(targets) = &targets {
            operation.set("targets", targets.clone());
        }
        let validated = validate_recolor(&Value::object(operation.clone()))?;
        let object = self.object()?;
        if targets.is_none() && self.selection.joint < 0 && validated.from.map(hex_color) != validated.color.map(hex_color) {
            let wanted = validated.from.map(hex_color);
            let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            let version = num(&self.report, "version").unwrap_or(f64::NAN);
            let rows = match (&object, self.selection.uid) {
                (Some(_), Some(id)) => attached_palette(version, &figures, &self.selection_frame()?, id)?,
                _ => Vec::new(),
            };
            if let Some(row) = rows.into_iter().find(|r| Some(&r.color) == wanted.as_ref()).filter(|r| !r.instances.is_empty()) {
                targets = Some(row_value(&row));
            }
        }
        // `{...operation, targets, figureTypeId: this.figure?.figure_type_id}` with the figure's validated colours.
        let mut next = Obj::new();
        next.set("mode", Value::str("replace"));
        if let Some(from) = validated.from {
            next.set("from", rgb_value(from));
        }
        if let Some(color) = validated.color {
            next.set("color", rgb_value(color));
        }
        if let Some(targets) = &targets {
            next.set("targets", targets.clone());
        }
        let figure_type = object.as_ref().and_then(|(_, o)| {
            let id = num(o, "figure_type_id");
            self.report.get("figure_types").and_then(Value::elements).and_then(|e| e.iter().find(|f| num(f, "figure_type_id") == id && id.is_some())).and_then(|f| f.get("figure_type_id").cloned())
        });
        if let Some(type_id) = figure_type {
            next.set("figureTypeId", type_id);
        }
        if let Some(instances) = targets.as_ref().and_then(|t| t.get("instances")).filter(|i| i.truthy()) {
            let ids = instances.as_obj().map(|o| o.keys().filter_map(|k| k.parse::<f64>().ok()).map(Value::Num).collect()).unwrap_or_default();
            options.set("uids", Value::array(ids));
        }
        self.edit_figure_colors(&Value::object(next), &Value::object(options))
    }
}

/// A palette row as `attachedFigurePalette` returns it (`{color, segments, polygons, meshColors?, instances}`).
fn row_value(row: &Row) -> Value {
    let targets_value = |targets: &Targets, extra: Option<(&str, &Value)>| {
        let mut out = Obj::new();
        out.set("color", Value::str(&row.color));
        let segments = targets
            .segments
            .iter()
            .map(|(handle, stops)| {
                let mut entry = Obj::new();
                entry.set("handleId", Value::Num(*handle));
                entry.set("stops", Value::array(stops.iter().map(|&s| Value::Num(s as f64)).collect()));
                Value::object(entry)
            })
            .collect();
        out.set("segments", Value::array(segments));
        out.set("polygons", Value::array(targets.polygons.iter().map(|&p| Value::Num(p)).collect()));
        if let Some(mesh) = &targets.mesh {
            out.set("meshColors", Value::array(mesh.iter().map(|&m| Value::Num(m as f64)).collect()));
        }
        if let Some((key, value)) = extra {
            out.set(key, value.clone());
        }
        out
    };
    let mut instances = Obj::new();
    for (id, targets, type_id) in &row.instances {
        instances.set(&id.to_string(), Value::object(targets_value(targets, Some(("figureTypeId", type_id)))));
    }
    let mut out = targets_value(&row.targets, None);
    out.set("instances", Value::object(instances));
    Value::object(out)
}

impl Editor {
    /// `updatePolygon(index, {color, opacity})` on a figure on show whose colours live in its
    /// overlay (always in the app: `propertyChannels`): `editFigureColors({mode: 'style', patch,
    /// figureTypeId, targets: {segments: [], polygons: [id]}}, {uids: [uid]})`. `None` when the
    /// editor would edit the definition instead.
    pub(crate) fn recolor_polygon(&mut self, figure: &Value, object: &Value, at: usize, patch: &Obj) -> Option<Result<Value, EditError>> {
        let version = num(&self.report, "version").unwrap_or(f64::NAN);
        let overlay = self.options.property_channels || object.get("_stykStyle").is_some_and(Value::truthy) || !uses_segment_colors(version, figure, object) || to_uint32(override_raw(object)) >> 24 != 0;
        if !overlay {
            return None;
        }
        let polygon = figure.get("polyfills").and_then(|p| p.item(at)).unwrap_or(Value::Null);
        let mut targets = Obj::new();
        targets.set("segments", Value::array(Vec::new()));
        targets.set("polygons", Value::array(vec![Value::Num(polygon_identity(&polygon, at))]));
        let mut operation = Obj::new();
        operation.set("mode", Value::str("style"));
        operation.set("patch", Value::object(patch.clone()));
        operation.set("figureTypeId", figure.get("figure_type_id").cloned().unwrap_or(Value::Null));
        operation.set("targets", Value::object(targets));
        let mut options = Obj::new();
        options.set("uids", Value::array(vec![object.get("unique_id").cloned().unwrap_or(Value::Null)]));
        Some(self.edit_figure_colors(&Value::object(operation), &Value::object(options)).map(|result| Value::Bool(result.get("changedFrames").and_then(Value::as_f64).is_some_and(|n| n > 0.0))))
    }
}
