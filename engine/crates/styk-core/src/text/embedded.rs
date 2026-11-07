//! `src/native-text-authoring.mjs`: editing text that came from a Pivot file without private metadata, and installing
//! the outlines of an explicitly chosen font into a figure of a mixed rig.
//!
//! Imported text keeps its exact paths, UTF-16 units, CRLF and positions when nothing changes. A character the file has
//! no glyph for is an error, never a silent substitution. The functions take and return figure definitions as document
//! values, as the JavaScript ones take and return plain objects, so key order and numbers stay the file's own.

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use super::compile::{
    alignment_code, bounds_value, path_bounds, svg_path, text_bounds, Bounds, CompiledPath,
};
use super::options::{f32r, js_round, TextOptions, TextSettings};
use super::TextError;

fn num(v: f64) -> Value {
    Value::Num(v)
}

fn nums(values: &[f64]) -> Value {
    Value::array(values.iter().map(|&v| Value::Num(v)).collect())
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn number_at(value: &Value, key: &str) -> Option<f64> {
    get(value, key).and_then(Value::as_f64)
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    get(value, key).and_then(Value::as_str).map(str::to_string)
}

/// `String(text ?? "").replace(/\r\n?/g, "\n")`.
fn normalized(text: Option<&Value>) -> String {
    super::options::normalize_line_breaks(text.and_then(Value::as_str).unwrap_or(""))
}

/// `Number(asset.asset_index ?? asset.table_index ?? 0)`.
fn asset_id(asset: &Value) -> f64 {
    number_at(asset, "asset_index").or_else(|| number_at(asset, "table_index")).unwrap_or(0.0)
}

fn authoring_metadata(figure: &Value) -> Option<&Value> {
    figure.get("_styk").and_then(|s| get(s, "textAuthoring"))
}

/// `metadataFor(figure, index)`: the private authoring record when it belongs to this asset.
fn metadata_for(figure: &Value, index: f64) -> Option<&Value> {
    let metadata = authoring_metadata(figure)?;
    (number_at(metadata, "assetIndex").unwrap_or(0.0) == index).then_some(metadata)
}

/// `textSegments(figure, index)`: the indexes of the figure's text segments of an asset.
fn text_segment_indexes(figure: &Value, index: f64) -> Vec<usize> {
    let Some(segments) = figure.get("segments").and_then(Value::elements) else { return Vec::new() };
    segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| {
            let is_text = number_at(segment, "primitive_code") == Some(5.0)
                || segment.get("segment_type").and_then(Value::as_str) == Some("text");
            let extra = number_at(segment, "extra_u16")
                .or_else(|| get(segment, "extra").and_then(|e| e.item(0)).and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            is_text && extra == index
        })
        .map(|(i, _)| i)
        .collect()
}

/// `textAssetFor(figure, index)`.
pub fn text_asset_for(figure: &Value, index: Option<f64>) -> Option<Value> {
    let wanted = index.or_else(|| authoring_metadata(figure).and_then(|m| number_at(m, "assetIndex")));
    let assets = figure.get("text_assets").and_then(Value::elements)?;
    match wanted {
        None => assets.get(0),
        Some(wanted) => assets.iter().find(|a| asset_id(a) == wanted),
    }
}

/// `canEditTextFigure(figure)`.
pub fn can_edit_text_figure(figure: &Value) -> bool {
    text_asset_for(figure, None)
        .and_then(|a| a.get("glyphs").and_then(Value::array_len))
        .is_some_and(|n| n > 0)
}

/// `readTextFigureOptions(figure, {assetIndex})`: the draft that reproduces the figure's current text.
pub fn read_text_figure_options(figure: &Value, asset_index: Option<f64>) -> Result<Value, TextError> {
    let asset = text_asset_for(figure, asset_index)
        .ok_or_else(|| TextError::key("errors.nativeTextAuthoring.selectATextFigure"))?;
    let index = asset_id(&asset);
    let segments = figure.get("segments");
    let segment = text_segment_indexes(figure, index)
        .first()
        .and_then(|&i| segments.and_then(|s| s.item(i)))
        .or_else(|| segments.and_then(|s| s.item(0)))
        .unwrap_or(Value::Null);
    let empty = Value::object(Obj::new());
    let style = figure.get("segment_decode").and_then(|d| get(d, "global_style")).cloned().unwrap_or(empty.clone());
    let meta = metadata_for(figure, index).cloned().unwrap_or(empty);

    let font_size = number_at(&meta, "fontSize").or_else(|| number_at(&asset, "font_size"));
    let mut o = Obj::new();
    o.set("text", Value::str(&normalized(asset.get("text"))));
    o.set("name", Value::str(&figure.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("Text")));
    let family = string_at(&asset, "font_name")
        .filter(|f| !f.is_empty())
        .or_else(|| string_at(&meta, "fontFamily").filter(|f| !f.is_empty()))
        .unwrap_or_else(|| "Embedded font".to_string());
    o.set("fontFamily", Value::str(&family));
    o.set("fontSize", num(font_size.unwrap_or(48.0)));
    o.set("fontSizeKnown", Value::Bool(font_size.is_some_and(f64::is_finite)));
    o.set("embeddedScale", num(100.0));
    o.set("fontOrigin", Value::str(&string_at(&meta, "fontOrigin").unwrap_or_else(|| "embedded".to_string())));
    let style_bits = number_at(&asset, "font_style").unwrap_or(0.0) as i64 as i32;
    o.set("bold", Value::Bool(style_bits & 1 != 0));
    o.set("italic", Value::Bool(style_bits & 2 != 0));
    let alignment = match number_at(&asset, "alignment") {
        Some(a) if a == 0.0 => "center",
        Some(a) if a == 1.0 => "left",
        Some(a) if a == 2.0 => "right",
        _ => "left",
    };
    o.set("alignment", Value::str(alignment));
    o.set("lineHeight", num(number_at(&meta, "lineHeight").unwrap_or(1.2)));
    o.set("color", get(&segment, "color_rgb").cloned().unwrap_or_else(|| nums(&[43.0, 43.0, 43.0])));
    o.set("opacity", num(1.0 - number_at(&segment, "transparency").unwrap_or(0.0) / 255.0));
    if let Some(paint) = get(&segment, "paint").filter(|p| p.truthy()) {
        o.set("paint", paint.clone());
    }
    o.set(
        "gradientColor",
        match get(&segment, "secondary") {
            Some(secondary) => secondary.get("rgb").cloned().unwrap_or(Value::Null),
            None => Value::Null,
        },
    );
    o.set("outlineWidth", num(number_at(&style, "outline_thickness").unwrap_or(0.0)));
    o.set("outlineColor", get(&style, "rgb").cloned().unwrap_or_else(|| nums(&[0.0, 0.0, 0.0])));
    o.set("figureTypeId", figure.get("figure_type_id").cloned().unwrap_or(Value::Null));
    o.set("assetIndex", num(index));
    Ok(Value::object(o))
}

impl TextOptions {
    /// The draft `textOptionsWithDefaults({...})` reads from a plain object: defaults for what is missing, and a value of
    /// the wrong type left where validation rejects it with the same message.
    pub fn from_value(options: &Value) -> TextOptions {
        let mut o = TextOptions::new("");
        let number = |key: &str, default: f64| match options.get(key) {
            None => default,
            Some(v) => v.as_f64().unwrap_or(f64::NAN),
        };
        let triple = |key: &str, default: [f64; 3]| match options.get(key) {
            None => default,
            Some(v) => match v.numbers().filter(|n| n.len() == 3) {
                Some(n) => [n[0], n[1], n[2]],
                None => [f64::NAN; 3],
            },
        };
        o.text = options.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        o.paint = options.get("paint").filter(|p| p.truthy()).cloned();
        o.name = match options.get("name") {
            None => "Text".to_string(),
            Some(Value::Str(s)) => s.to_string(),
            Some(Value::Num(n)) => super::compile::js_number_text(*n),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Null) => "null".to_string(),
            Some(_) => "[object Object]".to_string(),
        };
        o.font_family = options.get("fontFamily").and_then(Value::as_str).filter(|f| !f.is_empty()).map(str::to_string);
        o.font_size = number("fontSize", 48.0);
        for (key, slot) in [("bold", &mut o.bold), ("italic", &mut o.italic)] {
            match options.get(key) {
                None => {}
                Some(Value::Bool(b)) => *slot = *b,
                Some(_) => o.flags_invalid = true,
            }
        }
        o.alignment = match options.get("alignment") {
            None => "left".to_string(),
            Some(v) => v.as_str().unwrap_or("").to_string(),
        };
        o.line_height = number("lineHeight", 1.2);
        o.color = triple("color", [43.0, 43.0, 43.0]);
        o.opacity = number("opacity", 1.0);
        o.gradient_color = match options.get("gradientColor") {
            None | Some(Value::Null) => None,
            Some(_) => Some(triple("gradientColor", [f64::NAN; 3])),
        };
        o.outline_width = number("outlineWidth", 0.0);
        o.outline_color = triple("outlineColor", [0.0, 0.0, 0.0]);
        o.figure_type_id = number("figureTypeId", 1.0);
        o
    }
}

/// `{...initial, ...options}` for plain objects: later keys replace earlier ones in place.
fn merged(initial: &Value, options: &Value) -> Value {
    let mut object = initial.as_obj().cloned().unwrap_or_default();
    if let Some(extra) = options.as_obj() {
        for (key, value) in extra.iter() {
            object.set(key, value.clone());
        }
    }
    Value::object(object)
}

/// A glyph command as `{op, values}` plus whatever else the file stored on it.
fn compiled_commands(glyph: &Value) -> Vec<CompiledPath> {
    glyph
        .get("commands")
        .and_then(Value::elements)
        .map(|commands| {
            commands
                .iter()
                .map(|c| CompiledPath {
                    op: c.get("op").and_then(Value::as_str).and_then(|s| s.chars().next()).unwrap_or('M'),
                    values: c.get("values").and_then(Value::numbers).unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn bounds_of(value: Option<&Value>) -> Option<Bounds> {
    let b = value.filter(|b| b.is_object())?;
    Some(Bounds {
        left: number_at(b, "left")?,
        top: number_at(b, "top")?,
        right: number_at(b, "right")?,
        bottom: number_at(b, "bottom")?,
    })
}

/// `Math.max` over a list, with NaN contagion.
fn max_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::NEG_INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) })
}

fn min_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) })
}

struct Metrics {
    advances: HashMap<u32, f64>,
    pairs: HashMap<(u16, Option<u16>), f64>,
    space: f64,
    line_gap: f64,
}

/// `sourceMetrics(asset, metadata)`: spacing observed in the file, for pairs the file never stored.
fn source_metrics(asset: &Value, metadata: Option<&Value>) -> Metrics {
    let mut advances: HashMap<u32, f64> = HashMap::new();
    if let Some(stored) = metadata.and_then(|m| get(m, "glyphAdvances")).and_then(Value::as_obj) {
        for (key, value) in stored.iter() {
            if let (Ok(unit), Some(advance)) = (key.parse::<u32>(), value.as_f64()) {
                advances.insert(unit, advance);
            }
        }
    }
    let placements: Vec<Value> = asset.get("placements").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let mut pairs: HashMap<(u16, Option<u16>), f64> = HashMap::new();
    let mut values: HashMap<u32, Vec<f64>> = HashMap::new();
    for window in placements.windows(2) {
        let (a, b) = (&window[0], &window[1]);
        let (ax, ay, bx, by) = (
            number_at(a, "x").unwrap_or(f64::NAN),
            number_at(a, "y").unwrap_or(f64::NAN),
            number_at(b, "x").unwrap_or(f64::NAN),
            number_at(b, "y").unwrap_or(f64::NAN),
        );
        let dx = bx - ax;
        let visible = |p: &Value| p.get("visible").is_some_and(Value::truthy);
        if visible(a) && visible(b) && (ay - by).abs() < 0.01 && dx > 0.0 {
            let (ua, ub) = (number_at(a, "utf16_code_unit").unwrap_or(0.0) as u16, number_at(b, "utf16_code_unit").unwrap_or(0.0) as u16);
            pairs.insert((ua, Some(ub)), dx);
            values.entry(ua as u32).or_default().push(dx);
        }
    }
    let glyphs: Vec<Value> = asset.get("glyphs").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let height = max_of(
        std::iter::once(1.0).chain(glyphs.iter().map(|g| bounds_of(g.get("bounds")).map_or(0.0, |b| b.bottom - b.top))),
    );
    for glyph in &glyphs {
        let unit = number_at(glyph, "utf16_code_unit").unwrap_or(0.0) as u32;
        let observed = values.get_mut(&unit).and_then(|pool| {
            pool.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            pool.get(pool.len() / 2).copied()
        });
        advances.entry(unit).or_insert_with(|| match observed {
            Some(v) => v,
            None => match bounds_of(glyph.get("bounds")) {
                Some(b) => max_of([1.0, b.right - b.left + height * 0.1]),
                None => height * 0.35,
            },
        });
    }
    let mut rows: Vec<f64> = Vec::new();
    for p in placements.iter().filter(|p| p.get("visible").is_some_and(Value::truthy)) {
        let y = number_at(p, "y").unwrap_or(f64::NAN);
        if !rows.iter().any(|r| *r == y) {
            rows.push(y);
        }
    }
    rows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let gaps: Vec<f64> = rows.windows(2).map(|w| w[1] - w[0]).filter(|y| *y > 0.01).collect();
    let metadata_number = |key: &str| metadata.and_then(|m| number_at(m, key));
    Metrics {
        space: metadata_number("spaceAdvance").or_else(|| advances.get(&32).copied()).unwrap_or(height * 0.35),
        line_gap: if gaps.is_empty() {
            metadata_number("fontSize").unwrap_or(height) * metadata_number("lineHeight").unwrap_or(1.4)
        } else {
            min_of(gaps)
        },
        advances,
        pairs,
    }
}

fn update_paint(figure: &mut Value, options: &TextSettings, index: f64, width_ratio: f64) {
    let transparency = js_round((1.0 - options.opacity) * 255.0);
    for segment_index in text_segment_indexes(figure, index) {
        let Some(segments) = figure.make_obj().and_then(|f| f.get_mut("segments")).and_then(Value::make_arr) else { continue };
        let Some(segment) = segments.get_mut(segment_index).and_then(Value::make_obj) else { continue };
        let length = segment.get("length").and_then(Value::as_f64).unwrap_or(f64::NAN);
        segment.set("length", num(f32r(length * width_ratio)));
        if let Some(paint) = &options.paint {
            segment.set("paint", paint.clone());
        }
        segment.set("color_rgb", nums(&options.color));
        segment.set("transparency", num(transparency));
        segment.set("color_alpha", num(1.0 - transparency / 255.0));
        segment.set(
            "secondary",
            match options.gradient_color {
                Some(rgb) => {
                    let mut s = Obj::new();
                    s.set("rgb", nums(&rgb));
                    let alpha = match &options.paint {
                        Some(paint) => {
                            let stops = paint.get("stops").and_then(Value::elements).expect("normalized paint has stops");
                            let last = stops.get(stops.len() - 1).expect("at least one stop");
                            js_round((1.0 - last.get("opacity").and_then(Value::as_f64).unwrap_or(0.0)) * 255.0)
                        }
                        None => transparency,
                    };
                    s.set("a", num(alpha));
                    Value::object(s)
                }
                None => Value::Null,
            },
        );
    }
    let Some(figure_object) = figure.make_obj() else { return };
    if !figure_object.get("segment_decode").is_some_and(|d| !d.is_null()) {
        figure_object.set("segment_decode", Value::object(Obj::new()));
    }
    let decode = figure_object.get_mut("segment_decode").and_then(Value::make_obj).expect("segment_decode is an object");
    if !decode.get("global_style").is_some_and(|d| !d.is_null()) {
        let mut style = Obj::new();
        style.set("u28", num(0.0));
        style.set("rgb", nums(&[0.0, 0.0, 0.0]));
        style.set("u30", num(0.0));
        decode.set("global_style", Value::object(style));
    }
    let style = decode.get_mut("global_style").and_then(Value::make_obj).expect("global_style is an object");
    style.set("outline_thickness", num(f32r(options.outline_width)));
    style.set("rgb", nums(&options.outline_color));
    style.set("u28", num((options.outline_width as f32).to_bits() as f64));
}

fn install_asset(figure: &mut Value, asset: &Value, index: f64) {
    let Some(figure_object) = figure.make_obj() else { return };
    let replace = |list: Option<&Value>, only_text: bool| -> Option<Value> {
        let items = list?.elements()?;
        Some(Value::array(
            items
                .iter()
                .map(|item| {
                    let is_text = !only_text || item.get("kind").and_then(Value::as_str) == Some("text");
                    if is_text && asset_id(&item) == index { asset.clone() } else { item }
                })
                .collect(),
        ))
    };
    if let Some(assets) = replace(figure_object.get("text_assets"), false) {
        figure_object.set("text_assets", assets);
    }
    if let Some(tables) = replace(figure_object.get("side_tables").filter(|t| t.truthy()), true) {
        figure_object.set("side_tables", tables);
    }
}

fn set_object(target: &mut Obj, key: &str, value: Value) {
    target.set(key, value);
}

/// Scales every value of an asset's glyph commands by `factor`, in float32, and recomputes the glyph's bounds and path text.
fn scaled_glyph(source: Option<Value>, unit: u32, factor: f64) -> Value {
    let mut glyph = source.unwrap_or_else(|| {
        let mut g = Obj::new();
        g.set("utf16_code_unit", num(unit as f64));
        g.set("commands", Value::array(Vec::new()));
        g.set("node_count", num(0.0));
        g.set("bounds", Value::Null);
        g.set("svg_path", Value::str(""));
        Value::object(g)
    });
    let commands: Vec<Value> = glyph
        .get("commands")
        .and_then(Value::elements)
        .map(|e| {
            e.iter()
                .map(|command| {
                    let mut c = command.as_obj().cloned().unwrap_or_default();
                    let values: Vec<f64> =
                        command.get("values").and_then(Value::numbers).unwrap_or_default().iter().map(|v| f32r(v * factor)).collect();
                    c.set("values", nums(&values));
                    Value::object(c)
                })
                .collect()
        })
        .unwrap_or_default();
    let compiled: Vec<CompiledPath> = commands
        .iter()
        .map(|c| CompiledPath {
            op: c.get("op").and_then(Value::as_str).and_then(|s| s.chars().next()).unwrap_or('M'),
            values: c.get("values").and_then(Value::numbers).unwrap_or_default(),
        })
        .collect();
    if let Some(g) = glyph.make_obj() {
        g.set("commands", Value::array(commands));
        g.set("bounds", bounds_value(path_bounds(&compiled)));
        g.set("svg_path", Value::str(&svg_path(&compiled, 0.0, 0.0)));
    }
    glyph
}

/// `compileEmbeddedTextFigure(options, sourceFigure)`.
pub fn compile_embedded_text_figure(options: &Value, source_figure: &Value) -> Result<Value, TextError> {
    let initial = read_text_figure_options(source_figure, options.get("assetIndex").and_then(Value::as_f64))?;
    let o = TextSettings::validate(&TextOptions::from_value(&merged(&initial, options)), false)?;
    let index = number_at(&initial, "assetIndex").unwrap_or(0.0);
    let original = text_asset_for(source_figure, Some(index)).expect("read_text_figure_options found it");
    let flag = |key: &str| initial.get(key).is_some_and(Value::truthy);
    if o.bold != flag("bold") || o.italic != flag("italic") {
        return Err(TextError::key("errors.nativeTextAuthoring.chooseAFontFaceToChangeBoldOr"));
    }
    let font_size_known = flag("fontSizeKnown");
    let initial_size = number_at(&initial, "fontSize").unwrap_or(48.0);
    let factor = if font_size_known {
        o.font_size / initial_size
    } else {
        let scale = match options.get("embeddedScale") {
            None | Some(Value::Null) => 100.0,
            Some(v) => v.as_f64().unwrap_or(f64::NAN),
        };
        scale / 100.0
    };
    if !factor.is_finite() || factor <= 0.0 || factor > 40.0 {
        return Err(TextError::key("errors.nativeTextAuthoring.embeddedTextScaleMustBeGreaterThanZero"));
    }
    let family = string_at(&initial, "fontFamily").unwrap_or_default();
    let source_glyphs: Vec<Value> = original.get("glyphs").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let source: HashMap<u32, Value> = source_glyphs
        .iter()
        .map(|g| (number_at(g, "utf16_code_unit").unwrap_or(f64::NAN) as u32, g.clone()))
        .collect();
    let mut missing: Vec<String> = Vec::new();
    for ch in o.text.chars() {
        let unit = ch as u32;
        if !source.contains_key(&unit) && ![' ', '\t', '\n'].contains(&ch) && !missing.contains(&ch.to_string()) {
            missing.push(ch.to_string());
        }
    }
    if !missing.is_empty() {
        return Err(TextError::MissingGlyphs { missing, family });
    }

    let mut figure = source_figure.clone();
    let mut asset = original.clone();
    let original_text = normalized(original.get("text"));
    let same_text = original_text == o.text;
    let same_layout = same_text
        && o.alignment == string_at(&initial, "alignment").unwrap_or_default()
        && o.line_height == number_at(&initial, "lineHeight").unwrap_or(f64::NAN);
    let metadata = metadata_for(source_figure, index).cloned();
    let mut approximate = false;
    if !same_layout || factor != 1.0 {
        let text: String = if same_layout { original.get("text").and_then(Value::as_str).unwrap_or("").to_string() } else { o.text.clone() };
        let mut unique: Vec<u32> = Vec::new();
        for unit in text.encode_utf16() {
            if !unique.contains(&(unit as u32)) {
                unique.push(unit as u32);
            }
        }
        let by_unit: HashMap<u32, usize> = unique.iter().enumerate().map(|(i, &u)| (u, i)).collect();
        let glyphs: Vec<Value> = unique.iter().map(|&unit| scaled_glyph(source.get(&unit).cloned(), unit, factor)).collect();
        let asset_object = asset.make_obj().expect("a text asset is an object");
        asset_object.set("text", Value::str(&text));
        asset_object.set("glyphs", Value::array(glyphs.clone()));
        let glyph_visible = |gi: usize| -> bool {
            glyphs[gi].get("commands").and_then(Value::array_len).is_some_and(|n| n > 0)
        };

        let placements: Vec<Value> = if same_layout {
            original
                .get("placements")
                .and_then(Value::elements)
                .map(|e| {
                    e.iter()
                        .map(|p| {
                            let mut q = p.as_obj().cloned().unwrap_or_default();
                            let unit = number_at(&p, "utf16_code_unit").unwrap_or(f64::NAN) as u32;
                            q.set("glyph_index", by_unit.get(&unit).map_or(Value::Null, |&i| num(i as f64)));
                            let visible = p.get("visible").is_some_and(Value::truthy);
                            let scale = |key: &str| if visible { f32r(number_at(&p, key).unwrap_or(f64::NAN) * factor) } else { 0.0 };
                            q.set("x", num(scale("x")));
                            q.set("y", num(scale("y")));
                            Value::object(q)
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            let metrics = source_metrics(&original, metadata.as_ref());
            let stored = metadata.as_ref().and_then(|m| get(m, "glyphAdvances"));
            struct Line {
                units: Vec<u16>,
                offsets: Vec<f64>,
                width: f64,
            }
            let all: Vec<u16> = o.text.encode_utf16().collect();
            let mut lines: Vec<Line> = Vec::new();
            for units in all.split(|&u| u == b'\n' as u16) {
                let mut offsets = Vec::with_capacity(units.len());
                let mut width = 0.0f64;
                for i in 0..units.len() {
                    offsets.push(width);
                    let unit = units[i];
                    let pair = metrics.pairs.get(&(unit, units.get(i + 1).copied())).copied();
                    let mut advance = pair.or_else(|| metrics.advances.get(&(unit as u32)).copied());
                    match advance {
                        None => {
                            advance = Some(if unit == b'\t' as u16 { metrics.space * 4.0 } else { metrics.space });
                            approximate = true;
                        }
                        Some(_) if pair.is_none() => {
                            let known = stored
                                .and_then(|s| s.get(&unit.to_string()))
                                .and_then(Value::as_f64)
                                .is_some_and(|v| v != 0.0 && !v.is_nan());
                            if !known {
                                approximate = true;
                            }
                        }
                        Some(_) => {}
                    }
                    width += advance.expect("set above") * factor;
                }
                lines.push(Line { units: units.to_vec(), offsets, width });
            }
            let width = max_of(lines.iter().map(|l| l.width));
            let line_gap = metrics.line_gap * (o.line_height / number_at(&initial, "lineHeight").unwrap_or(f64::NAN)) * factor;
            let mut placements: Vec<Value> = Vec::new();
            let place = |unit: u16, x: f64, y: f64, placements: &mut Vec<Value>| {
                let gi = by_unit[&(unit as u32)];
                let visible = glyph_visible(gi);
                let mut p = Obj::new();
                p.set("character_index", num(placements.len() as f64));
                p.set("utf16_code_unit", num(unit as f64));
                p.set("glyph_index", num(gi as f64));
                p.set("visible", Value::Bool(visible));
                p.set("x", num(if visible { f32r(x) } else { 0.0 }));
                p.set("y", num(if visible { f32r(y) } else { 0.0 }));
                placements.push(Value::object(p));
            };
            let last = lines.len() - 1;
            for (row, line) in lines.iter().enumerate() {
                let dx = match o.alignment.as_str() {
                    "right" => width - line.width,
                    "center" => (width - line.width) / 2.0,
                    _ => 0.0,
                };
                for i in 0..line.units.len() {
                    place(line.units[i], line.offsets[i] + dx, row as f64 * line_gap, &mut placements);
                }
                if row < last {
                    place(10, 0.0, 0.0, &mut placements);
                }
            }
            placements
        };

        let placement_refs: Vec<(usize, f64, f64)> = placements
            .iter()
            .map(|p| {
                (
                    number_at(p, "glyph_index").unwrap_or(0.0) as usize,
                    number_at(p, "x").unwrap_or(f64::NAN),
                    number_at(p, "y").unwrap_or(f64::NAN),
                )
            })
            .collect();
        let glyph_models: Vec<super::compile::Glyph> = glyphs
            .iter()
            .map(|g| super::compile::Glyph {
                utf16_code_unit: number_at(g, "utf16_code_unit").unwrap_or(0.0) as u16,
                commands: compiled_commands(g),
                node_count: 0,
                bounds: bounds_of(g.get("bounds")),
                svg_path: String::new(),
            })
            .collect();
        let (bounds, width, height) = text_bounds(&glyph_models, &placement_refs)?;
        let visible_paths = |dx: f64, dy: f64, normalized_by: Option<&Bounds>| -> String {
            placements
                .iter()
                .zip(&placement_refs)
                .filter(|(p, _)| p.get("visible").is_some_and(Value::truthy))
                .map(|(_, &(gi, x, y))| match normalized_by {
                    None => svg_path(&glyph_models[gi].commands, x + dx, y + dy),
                    Some(b) => svg_path(&glyph_models[gi].commands, x - b.left, y - b.bottom),
                })
                .collect::<Vec<_>>()
                .join(" ")
        };
        let svg = {
            // `svgPath(commands, p.x, p.y)`: the offsets are the placement's own.
            placements
                .iter()
                .zip(&placement_refs)
                .filter(|(p, _)| p.get("visible").is_some_and(Value::truthy))
                .map(|(_, &(gi, x, y))| svg_path(&glyph_models[gi].commands, x, y))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let normalized_svg = visible_paths(0.0, 0.0, Some(&bounds));
        let mut bounds_object = Obj::new();
        for (key, v) in [("left", bounds.left), ("top", bounds.top), ("right", bounds.right), ("bottom", bounds.bottom), ("width", width), ("height", height)] {
            bounds_object.set(key, num(v));
        }
        let asset_object = asset.make_obj().expect("a text asset is an object");
        asset_object.set("placements", Value::array(placements));
        asset_object.set("bounds", Value::object(bounds_object));
        asset_object.set("svg_path", Value::str(&svg));
        asset_object.set("normalized_svg_path", Value::str(&normalized_svg));
        asset_object.set("alignment", num(alignment_code(&o.alignment)));
        asset_object.remove("source_start");
        asset_object.remove("source_end");
    }
    if font_size_known {
        set_object(asset.make_obj().expect("object"), "font_size", num(o.font_size));
    }
    let original_width = original.get("bounds").and_then(|b| number_at(b, "width")).unwrap_or(f64::NAN);
    let new_width = asset.get("bounds").and_then(|b| number_at(b, "width")).unwrap_or(f64::NAN);
    update_paint(&mut figure, &o, index, new_width / original_width);
    install_asset(&mut figure, &asset, index);

    let mut authoring = metadata.as_ref().and_then(Value::as_obj).cloned().unwrap_or_default();
    for (key, value) in o.to_object().iter() {
        authoring.set(key, value.clone());
    }
    authoring.set("fontFamily", Value::str(&family));
    authoring.set("fontOrigin", Value::str("embedded"));
    authoring.set("assetIndex", num(index));
    authoring.set("fontSizeKnown", Value::Bool(font_size_known));
    authoring.set("embeddedScale", num(100.0));
    authoring.set("spacingEstimated", Value::Bool(approximate));
    if !font_size_known {
        authoring.remove("fontSize");
    }
    if factor != 1.0 {
        if let Some(advances) = authoring.get("glyphAdvances").and_then(Value::as_obj).cloned() {
            let mut scaled = Obj::new();
            for (key, value) in advances.iter() {
                scaled.set(key, num(value.as_f64().unwrap_or(f64::NAN) * factor));
            }
            authoring.set("glyphAdvances", Value::object(scaled));
        }
        if let Some(space) = authoring.get("spaceAdvance").and_then(Value::as_f64) {
            authoring.set("spaceAdvance", num(space * factor));
        }
    }
    let figure_object = figure.make_obj().expect("a figure is an object");
    figure_object.set("name", Value::str(&o.name));
    figure_object.set("figure_type_id", num(o.figure_type_id));
    let mut styk = figure_object.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("textAuthoring", Value::object(authoring));
    figure_object.set("_styk", Value::object(styk));
    Ok(figure)
}

/// `replaceTextAssetFigure(sourceFigure, compiled, {assetIndex})`: the outlines of a chosen font in place of an asset's.
pub fn replace_text_asset_figure(source_figure: &Value, compiled: &Value, asset_index: Option<f64>) -> Result<Value, TextError> {
    let initial = read_text_figure_options(source_figure, asset_index)?;
    let index = number_at(&initial, "assetIndex").unwrap_or(0.0);
    let mut figure = source_figure.clone();
    let original = text_asset_for(source_figure, Some(index)).expect("read_text_figure_options found it");
    let mut asset = compiled
        .get("text_assets")
        .and_then(|a| a.item(0))
        .ok_or_else(|| TextError::key("errors.nativeTextAuthoring.selectATextFigure"))?;
    let authoring = compiled.get("_styk").and_then(|s| s.get("textAuthoring")).cloned().unwrap_or(Value::Null);
    if let Some(a) = asset.make_obj() {
        a.set("asset_index", num(index));
        a.set("table_index", num(index));
    }
    let settings = TextSettings::validate(&TextOptions::from_value(&authoring), false)?;
    let original_width = original.get("bounds").and_then(|b| number_at(b, "width")).unwrap_or(f64::NAN);
    let new_width = asset.get("bounds").and_then(|b| number_at(b, "width")).unwrap_or(f64::NAN);
    update_paint(&mut figure, &settings, index, new_width / original_width);
    install_asset(&mut figure, &asset, index);

    let mut authoring_object = authoring.as_obj().cloned().unwrap_or_default();
    authoring_object.set("fontOrigin", Value::str("custom"));
    authoring_object.set("assetIndex", num(index));
    let figure_object = figure.make_obj().expect("a figure is an object");
    figure_object.set("name", compiled.get("name").cloned().unwrap_or(Value::Null));
    let mut styk = figure_object.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("textAuthoring", Value::object(authoring_object));
    figure_object.set("_styk", Value::object(styk));
    Ok(figure)
}
