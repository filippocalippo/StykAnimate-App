//! The full project writer (`piv_full_writer.py`): builds new background and
//! figure tables from an editable document, then the frames behind them.
//!
//! Logical IDs in the document (figure types, backgrounds, joints) may be
//! sparse after edits; the file needs dense ones. The writer assigns them in
//! list order, stores segments parent before child, and rewrites every frame
//! reference accordingly. The original source supplies media the document
//! omits and the trailer bytes after the frame rate. Everything written is
//! decoded again before it is returned.

use std::collections::{BinaryHeap, HashMap};
use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::ctx::Ctx;
use crate::error::{Class, PyResult, piv, type_error};
use crate::piv::v5::{MAX_SEGMENTS, builtin_man};
use crate::piv::{MAX_PAYLOAD_BYTES, v5};
use crate::py::{self, HKey};
use crate::text::cp1252_encode;
use crate::write::assets::{encode_side_tables, hydrate_side_tables, primitive_key, resolve_image_bytes};
use crate::write::frames::{Fmt, Original, Tables, Writer, decode_original, encode_frames_only, same_signature, validate_payload, wrap_malformed, write_frames};
use crate::zlib;

fn zero() -> Value {
    Value::Num(0.0)
}

fn missing() -> &'static Value {
    static NULL: Value = Value::Null;
    &NULL
}

fn empty_dict() -> &'static Value {
    static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Value::object(Obj::new()))
}

/// `_name`: a length-prefixed Windows-1252 string.
fn name(w: &mut Writer, value: Option<&Value>, default: &str, label: &str) -> PyResult<()> {
    let text = match value {
        None => default.to_string(),
        Some(value) if py::is_str(value) => value.text().unwrap_or_default().into_owned(),
        Some(_) => return Err(piv(format!("{label} must be text"))),
    };
    let Some(bytes) = cp1252_encode(&text) else {
        return Err(piv(format!("{label} must fit the native Windows ANSI encoding")));
    };
    w.put_count(Fmt::U8, bytes.len(), format_args!("{label} length"))?;
    w.data.extend_from_slice(&bytes);
    Ok(())
}

/// `_positive_id`.
fn positive_id(value: Option<&Value>, label: &str) -> PyResult<Value> {
    match value {
        Some(Value::Num(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 1.0 => Ok(Value::Num(*n)),
        _ => Err(piv(format!("{label} must be a positive integer"))),
    }
}

/// `_alias_value`: a raw field and its readable alias may both be edited; the
/// alias wins when it changed, and contradicting edits are an error.
fn alias_value(item: &Value, old: Option<&Value>, raw: &str, alias: &str, convert: &dyn Fn(&Value) -> PyResult<Value>, default: Value) -> PyResult<Value> {
    let base = py::get(item, raw)?.cloned().unwrap_or(default);
    let old = old.filter(|old| py::truthy(old));
    let changed = |key: &str| -> PyResult<bool> {
        let Some(value) = py::get(item, key)? else { return Ok(false) };
        Ok(match old {
            None => true,
            Some(old) => !py::get(old, key)?.is_some_and(|before| py::eq(value, before)),
        })
    };
    if changed(alias)? {
        let candidate = convert(py::item(item, alias)?)?;
        if changed(raw)? && !py::eq(&candidate, &base) {
            return Err(piv(format!("Conflicting edits to {raw} and {alias}")));
        }
        return Ok(candidate);
    }
    Ok(base)
}

/// `_transparency`: an opacity between 0 and 1 as the stored 0..255 transparency.
fn transparency(alpha: &Value) -> PyResult<Value> {
    match alpha {
        Value::Num(n) if n.is_finite() && (0.0..=1.0).contains(n) => Ok(Value::Num(crate::pyfmt::py_round((1.0 - n) * 255.0))),
        _ => Err(piv("Color alpha must be between 0 and 1")),
    }
}

/// `value - 1` (a one-based layer as a zero-based one).
fn minus_one(value: &Value) -> PyResult<Value> {
    match value {
        Value::Num(n) => Ok(Value::Num(n - 1.0)),
        Value::Bool(b) => Ok(Value::Num(*b as u8 as f64 - 1.0)),
        other => Err(type_error(format!("unsupported operand type(s) for -: '{}' and 'int'", py::type_name(other)))),
    }
}

/// `value & 1` on what Python holds as an integer.
fn low_bit(value: &Value) -> PyResult<bool> {
    match value {
        Value::Num(n) if n.fract() == 0.0 && n.is_finite() => Ok((*n as i64) & 1 != 0),
        Value::Bool(b) => Ok(*b),
        other => Err(type_error(format!("unsupported operand type(s) for &: '{}' and 'int'", py::type_name(other)))),
    }
}

/// `_aux`: the auxiliary flag byte, with the static-node bit following `is_static` when that changed.
fn aux(segment: &Value, old: Option<&Value>) -> PyResult<f64> {
    let raw = match py::get(segment, "aux_code")? {
        None => 0.0,
        Some(Value::Num(n)) if n.fract() == 0.0 && (0.0..=255.0).contains(n) => *n,
        Some(_) => return Err(piv("Invalid segment auxiliary flags")),
    };
    let old = old.filter(|old| py::truthy(old));
    let nested = match py::get(segment, "flag_bits")? {
        None => None,
        Some(bits) => py::get(bits, "is_static")?,
    };
    let Some(is_static) = py::get(segment, "is_static")?.or(nested).filter(|value| !value.is_null()) else {
        return Ok(raw);
    };
    let Value::Bool(is_static) = is_static else {
        return Err(piv("is_static must be a boolean"));
    };
    let unchanged = match old {
        None => false,
        Some(old) => {
            let fallback = low_bit(py::get(old, "aux_code")?.unwrap_or(&zero()))?;
            match py::get(old, "is_static")? {
                Some(before) => py::eq(before, &Value::Bool(*is_static)),
                None => fallback == *is_static,
            }
        }
    };
    if unchanged {
        return Ok(raw);
    }
    let raw_static = (raw as i64) & 1 != 0;
    let old_aux_differs = match old {
        None => false,
        Some(old) => py::get(old, "aux_code")?.is_some_and(|before| !py::eq(before, &Value::Num(raw))),
    };
    if py::get(segment, "aux_code")?.is_some() && old_aux_differs && raw_static != *is_static {
        return Err(piv("Conflicting static-node and auxiliary flag edits"));
    }
    Ok(((raw as i64 & 254) | *is_static as i64) as f64)
}

/// What iterating a value yields (nothing for a missing one).
fn items(value: Option<&Value>) -> PyResult<Vec<Value>> {
    match value {
        None => Ok(Vec::new()),
        Some(value) => Ok(py::iter(value)?.iter().collect()),
    }
}

/// `[*value]`.
fn star(value: Option<&Value>) -> PyResult<Vec<Value>> {
    match value {
        None => Ok(Vec::new()),
        Some(value) => py::star(value),
    }
}

fn list_eq(a: &[Value], b: &[Value]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| py::eq(x, y))
}

/// `_choose_assets`: the media table to write, from `side_tables` or from
/// `image_assets` + `text_assets`, whichever the edit touched.
fn choose_assets(figure: &Value, old: Option<&Value>) -> PyResult<Vec<Value>> {
    let mut combined = star(py::get(figure, "image_assets")?)?;
    combined.extend(star(py::get(figure, "text_assets")?)?);
    let Some(side) = py::get(figure, "side_tables")?.filter(|side| !side.is_null()) else {
        return Ok(combined);
    };
    let old = old.filter(|old| py::truthy(old)).unwrap_or(empty_dict());
    let original_side = items(py::get(old, "side_tables")?)?;
    let mut original_combined = star(py::get(old, "image_assets")?)?;
    original_combined.extend(star(py::get(old, "text_assets")?)?);
    if !py::is_list(side) {
        return Err(crate::error::asset_write("assets must be a list and original_payload must be bytes"));
    }
    let side_items = items(Some(side))?;
    let side_changed = !list_eq(&side_items, &original_side);
    let combined_changed = !list_eq(&combined, &original_combined);
    if combined_changed && !side_changed {
        return Ok(combined);
    }
    if combined_changed && side_changed && !list_eq(&side_items, &combined) {
        let same = side_items.len() == combined.len() && side_items.iter().zip(&combined).all(|(a, b)| same_signature(a, b));
        if !same {
            return Err(piv("Conflicting side_tables and image/text asset edits"));
        }
    }
    Ok(side_items)
}

struct Prepared {
    value: Value,
    segment_id: Value,
    aux: f64,
    transparency: Value,
    primitive: Value,
    color_rgb: Value,
    secondary: Value,
    bend: Value,
}

fn is_code(value: &Value, codes: &[f64]) -> bool {
    codes.iter().any(|&code| py::eq(value, &Value::Num(code)))
}

/// `_figure`: one figure definition as the file stores it. `old` is the same
/// figure in the source, which tells edits of aliases from stale copies.
pub(crate) fn write_figure(ctx: &Ctx<'_>, w: &mut Writer, figure: &Value, old: Option<&Value>, source_payload: &[u8]) -> PyResult<()> {
    let label = format!("figure {}", py::get(figure, "figure_type_id")?.map(py::str_of).unwrap_or_else(|| "None".to_string()));
    let segments = py::get(figure, "segments")?.filter(|s| py::is_list(s) && (1..=MAX_SEGMENTS).contains(&s.array_len().unwrap_or(0)));
    let Some(segments) = segments else {
        return Err(piv(format!("{label} needs 1\u{2013}{MAX_SEGMENTS} segments")));
    };
    let old = old.filter(|old| py::truthy(old));
    let old_or_empty = old.unwrap_or(empty_dict());
    let mut original_segments: HashMap<HKey, Value> = HashMap::new();
    for segment in items(py::get(old_or_empty, "segments")?)? {
        original_segments.insert(py::hkey(py::item(&segment, "segment_id")?)?, segment);
    }
    let reference_of = |segment: &Value| -> PyResult<Option<&Value>> {
        let id = match py::get(segment, "_logical_segment_id")? {
            Some(id) => Some(id),
            None => py::get(segment, "segment_id")?,
        };
        Ok(original_segments.get(&py::hkey(id.unwrap_or(missing()))?))
    };
    let mut prepared: Vec<Prepared> = Vec::with_capacity(segments.array_len().unwrap_or(0));
    for segment in py::iter(segments)?.iter() {
        let reference = reference_of(&segment)?;
        let aux = aux(&segment, reference)?;
        let transparency = alias_value(&segment, reference, "transparency", "color_alpha", &transparency, zero())?;
        let get = |key: &str, default: Value| -> PyResult<Value> { Ok(py::get(&segment, key)?.cloned().unwrap_or(default)) };
        let primitive = get("primitive_code", zero())?;
        let color_rgb = get("color_rgb", Value::nums(&[0.0, 0.0, 0.0]))?;
        let secondary = get("secondary", Value::Null)?;
        let bend = get("bend_rad", zero())?;
        // `extra` only matters as the default of the three media fields: it must be iterable.
        if let Some(extra) = py::get(&segment, "extra")?.filter(|extra| py::truthy(extra)) {
            py::iter(extra).map_err(|_| type_error(format!("'{}' object is not iterable", py::type_name(extra))))?;
        }
        prepared.push(Prepared { segment_id: Value::Null, value: segment, aux, transparency, primitive, color_rgb, secondary, bend });
    }
    let mut ids: Vec<f64> = Vec::with_capacity(prepared.len());
    let mut valid_ids = true;
    let mut seen: std::collections::HashSet<HKey> = std::collections::HashSet::new();
    for segment in &mut prepared {
        let id = py::item(&segment.value, "segment_id")?.clone();
        valid_ids &= seen.insert(py::hkey(&id)?);
        match &id {
            Value::Num(n) if n.fract() == 0.0 && (1.0..=65535.0).contains(n) => ids.push(*n),
            _ => valid_ids = false,
        }
        segment.segment_id = id;
    }
    if !valid_ids {
        return Err(piv(format!("{label} has invalid or duplicate segment joint IDs")));
    }
    let polygons = match py::get(figure, "polyfills")? {
        None => Vec::new(),
        Some(list) if py::is_list(list) && list.array_len().unwrap_or(0) <= 20000 => items(Some(list))?,
        Some(_) => return Err(piv(format!("{label} has invalid polygon list"))),
    };
    let mut old_polygons: HashMap<HKey, Value> = HashMap::new();
    for (i, polygon) in items(py::get(old_or_empty, "polyfills")?)?.into_iter().enumerate() {
        let id = py::get(&polygon, "polyfill_id")?.cloned().unwrap_or(Value::Num(i as f64 + 1.0));
        old_polygons.insert(py::hkey(&id)?, polygon);
    }
    let old_polygon = |polygon: &Value, i: usize| -> PyResult<Option<&Value>> {
        let id = py::get(polygon, "polyfill_id")?.cloned().unwrap_or(Value::Num(i as f64 + 1.0));
        Ok(old_polygons.get(&py::hkey(&id)?))
    };
    let mut polygon_alpha: Vec<Value> = Vec::with_capacity(polygons.len());
    for (i, polygon) in polygons.iter().enumerate() {
        polygon_alpha.push(alias_value(polygon, old_polygon(polygon, i)?, "alpha_raw", "color_alpha", &transparency, zero())?);
    }
    // Layers: semantic z values keep their relative order even when deletions leave gaps.
    let mut entries: Vec<(f64, u8, f64, usize)> = Vec::with_capacity(prepared.len() + polygons.len());
    for (is_segment, array_name, count) in [(true, "segment_z_raw", prepared.len()), (false, "poly_z_raw", polygons.len())] {
        let empty = crate::ctx::empty_list();
        let array = py::get(figure, array_name)?.unwrap_or(&empty);
        let old_array = py::get(old_or_empty, array_name)?.unwrap_or(&empty);
        let resolved = is_segment && py::truthy_opt(py::get(figure, "_resolved_segment_z")?);
        let use_array = py::len(array)? == count && (!py::eq(array, old_array) || resolved);
        for i in 0..count {
            let default = if is_segment { i } else { prepared.len() + i };
            let z = if use_array {
                py::at(array, i)?
            } else if is_segment {
                alias_value(&prepared[i].value, reference_of(&prepared[i].value)?, "z_order_runtime_raw", "z_order", &minus_one, Value::Num(default as f64))?
            } else {
                alias_value(&polygons[i], old_polygon(&polygons[i], i)?, "z_order_runtime_raw", "z_order", &minus_one, Value::Num(default as f64))?
            };
            let z = match z {
                Value::Num(n) if n.is_finite() => n,
                _ => return Err(piv("Invalid layer order")),
            };
            // Parent-first storage may reorder records: equal layers keep their input order.
            let ordinal = if is_segment { py::get(&prepared[i].value, "_paint_input_index")?.and_then(Value::as_f64).unwrap_or(i as f64) } else { i as f64 };
            entries.push((z, is_segment as u8, ordinal, i));
        }
    }
    entries.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.total_cmp(&b.2)).then(a.3.cmp(&b.3)));
    let mut seg_z = vec![0usize; prepared.len()];
    let mut poly_z = vec![0usize; polygons.len()];
    for (rank, &(_, is_segment, _, i)) in entries.iter().enumerate() {
        if is_segment == 1 {
            seg_z[i] = rank;
        } else {
            poly_z[i] = rank;
        }
    }
    let decode = py::get(figure, "segment_decode")?.unwrap_or(empty_dict());
    let style = py::get(decode, "global_style")?.filter(|style| !style.is_null());
    let sequential = seg_z.iter().enumerate().all(|(i, &z)| z == i) && poly_z.iter().enumerate().all(|(i, &z)| z == prepared.len() + i);
    let flags: u8 = prepared.iter().all(|s| py::eq(&s.primitive, &zero())) as u8
        | (prepared.iter().all(|s| s.aux == 0.0) as u8) << 1
        | (prepared.iter().all(|s| py::eq(&s.color_rgb, &Value::nums(&[0.0, 0.0, 0.0]))) as u8) << 2
        | (prepared.iter().all(|s| py::eq(&s.transparency, &zero())) as u8) << 3
        | (sequential as u8) << 4
        | (ids.iter().enumerate().all(|(i, &id)| id == i as f64 + 1.0) as u8) << 5
        | (style.is_some() as u8) << 6
        | (prepared.iter().all(|s| s.secondary.is_null()) as u8) << 7;
    w.data.push(flags);
    w.put_count(Fmt::U16, prepared.len(), format_args!("{label} segment count"))?;
    for s in &prepared {
        w.put(Fmt::U16, py::item(&s.value, "parent_id")?, format_args!("segment parent"))?;
        if flags & 32 == 0 {
            w.put(Fmt::U16, &s.segment_id, format_args!("segment joint ID"))?;
        }
        w.put(Fmt::F32, py::item(&s.value, "length")?, format_args!("segment length"))?;
        w.put(Fmt::F64, py::item(&s.value, "angle_rad")?, format_args!("segment angle"))?;
        w.put(Fmt::F32, py::item(&s.value, "thickness")?, format_args!("segment thickness"))?;
        if flags & 1 == 0 {
            w.put(Fmt::U8, &s.primitive, format_args!("primitive code"))?;
        }
        if flags & 2 == 0 {
            w.put_number(Fmt::U8, s.aux, format_args!("auxiliary flags"))?;
        }
        if flags & 4 == 0 {
            w.array(ctx, Fmt::U8, Some(&s.color_rgb), 3, format_args!("segment RGB"))?;
        }
        if flags & 8 == 0 {
            w.put(Fmt::U8, &s.transparency, format_args!("segment transparency"))?;
        }
        if flags & 128 == 0 {
            w.data.push(!s.secondary.is_null() as u8);
            if !s.secondary.is_null() {
                w.array(ctx, Fmt::U8, Some(py::item(&s.secondary, "rgb")?), 3, format_args!("secondary RGB"))?;
                w.put(Fmt::U8, py::item(&s.secondary, "a")?, format_args!("secondary transparency"))?;
            }
        }
        if is_code(&s.primitive, &[2.0, 5.0]) {
            // The media fields default to the items of `extra`, or zero.
            let extra = py::get(&s.value, "extra")?.filter(|extra| py::truthy(extra));
            let field = |key: &str, at: usize| -> PyResult<Value> {
                if let Some(value) = py::get(&s.value, key)? {
                    return Ok(value.clone());
                }
                match extra {
                    None => Ok(zero()),
                    Some(extra) => py::iter(extra)?.iter().nth(at).ok_or_else(|| crate::error::key_error(key)),
                }
            };
            w.put(Fmt::U16, &field("extra_u16", 0)?, format_args!("media table index"))?;
            w.put(Fmt::U8, &field("extra_u8_a", 1)?, format_args!("media endpoint flag"))?;
            w.put(Fmt::U8, &field("extra_u8_b", 2)?, format_args!("media reflection flag"))?;
        }
    }
    let bends: Vec<(usize, &Value)> = prepared.iter().enumerate().filter(|(_, s)| !py::eq(&s.bend, &zero())).map(|(i, s)| (i, &s.bend)).collect();
    w.put_count(Fmt::U16, bends.len(), format_args!("bend count"))?;
    for (index, value) in bends {
        w.put_count(Fmt::U16, index, format_args!("bend record index"))?;
        w.put(Fmt::F64, value, format_args!("bend angle"))?;
    }
    let assets = choose_assets(figure, old)?;
    if prepared.iter().any(|s| is_code(&s.primitive, &[2.0, 5.0])) {
        let hydrated = hydrate_side_tables(&assets, source_payload)?;
        for segment in &prepared {
            primitive_key(&segment.primitive)?;
        }
        let has = |code: f64| prepared.iter().any(|s| py::eq(&s.primitive, &Value::Num(code)));
        if hydrated.iter().any(|asset| if asset.is_image() { !has(2.0) } else { !has(5.0) }) {
            return Err(piv(format!("{label} has an asset table without a matching primitive kind")));
        }
        let table = encode_side_tables(&hydrated, w.data.len(), has(2.0), has(5.0));
        w.data.extend_from_slice(&table);
    } else if !assets.is_empty() {
        return Err(piv(format!("{label} has media assets but no image/text segment references")));
    }
    w.put_count(Fmt::U16, polygons.len(), format_args!("polygon count"))?;
    for (polygon, alpha) in polygons.iter().zip(&polygon_alpha) {
        let vertices = py::item(polygon, "segment_ids")?;
        let count = py::len(vertices)?;
        w.put_count(Fmt::U16, count, format_args!("polygon vertex count"))?;
        let black = Value::nums(&[0.0, 0.0, 0.0]);
        w.array(ctx, Fmt::U8, Some(py::get(polygon, "color_rgb")?.unwrap_or(&black)), 3, format_args!("polygon RGB"))?;
        w.put(Fmt::U8, alpha, format_args!("polygon transparency"))?;
        w.array(ctx, Fmt::U16, Some(vertices), count, format_args!("polygon vertices"))?;
    }
    if flags & 16 == 0 {
        ctx.checkpoint()?;
        for &z in &seg_z {
            w.put_count(Fmt::U16, z, format_args!("segment z indices"))?;
        }
        ctx.checkpoint()?;
        for &z in &poly_z {
            w.put_count(Fmt::U16, z, format_args!("polygon z indices"))?;
        }
    }
    if let Some(style) = style {
        let old_decode = py::get(old_or_empty, "segment_decode")?.unwrap_or(empty_dict());
        let old_style = py::get(old_decode, "global_style")?.filter(|style| py::truthy(style));
        let bits = |value: &Value| -> PyResult<Value> {
            match value {
                Value::Num(n) if n.is_finite() => {
                    let single = *n as f32;
                    if single.is_infinite() {
                        return Err(crate::error::overflow_error("float too large to pack with f format"));
                    }
                    Ok(Value::Num(single.to_bits() as f64))
                }
                _ => Err(piv("Invalid outline thickness")),
            }
        };
        let raw = alias_value(style, old_style, "u28", "outline_thickness", &bits, zero())?;
        w.put(Fmt::U32, &raw, format_args!("outline thickness bits"))?;
        let black = Value::nums(&[0.0, 0.0, 0.0]);
        w.array(ctx, Fmt::U8, Some(py::get(style, "rgb")?.unwrap_or(&black)), 3, format_args!("outline RGB"))?;
        let transparency = alias_value(style, old_style, "u30", "outline_transparency", &|value| Ok(value.clone()), zero())?;
        w.put(Fmt::U8, &transparency, format_args!("outline transparency"))?;
    }
    name(w, py::get(figure, "name")?, "Figure", &format!("{label} name"))
}

/// `_background`: an image, a colour or a gradient, then its name.
fn write_background(w: &mut Writer, background: &Value, source_payload: &[u8]) -> PyResult<()> {
    let kind = py::item(background, "kind")?;
    w.put(Fmt::U8, kind, format_args!("background kind"))?;
    if is_code(kind, &[0.0, 1.0]) {
        let mut media = background.clone();
        if let Some(offset) = py::get(background, "record_offset")?.filter(|offset| !offset.is_null()) {
            let valid = match offset {
                Value::Num(n) if n.fract() == 0.0 => 0.0 <= *n && *n < source_payload.len() as f64 - 8.0,
                Value::Bool(b) => (*b as u8 as f64) < source_payload.len() as f64 - 8.0,
                _ => false,
            };
            if !valid {
                return Err(piv("Invalid background source offset"));
            }
            let at = match offset {
                Value::Bool(b) => *b as usize,
                other => other.as_f64().unwrap_or(0.0) as usize,
            };
            let mut end = [0u8; 8];
            end.copy_from_slice(&source_payload[at + 1..at + 9]);
            if let Some(object) = media.make_obj() {
                if !object.contains("image_start") {
                    object.set("image_start", Value::Num(at as f64 + 9.0));
                }
                if !object.contains("source_end") {
                    object.set("source_end", Value::Num(u64::from_le_bytes(end) as f64));
                }
            }
        }
        let data = resolve_image_bytes(&media, source_payload)?;
        w.put_count(Fmt::U64, w.data.len() + 8 + data.len(), format_args!("background image endpoint"))?;
        w.data.extend_from_slice(&data);
    } else if is_code(kind, &[2.0]) {
        w.put(Fmt::U32, py::item(background, "color")?, format_args!("background color"))?;
    } else if is_code(kind, &[3.0, 4.0]) {
        w.put(Fmt::U32, py::item(background, "color_a")?, format_args!("gradient color A"))?;
        w.put(Fmt::U32, py::item(background, "color_b")?, format_args!("gradient color B"))?;
        for key in ["x1", "y1", "x2", "y2"] {
            w.put(Fmt::F32, py::item(background, key)?, format_args!("gradient {key}"))?;
        }
    } else {
        return Err(piv("Unsupported background kind"));
    }
    name(w, py::get(background, "name")?, "Background", "background name")
}

fn set(value: &mut Value, key: &str, item: Value) {
    if let Some(object) = value.make_obj() {
        object.set(key, item);
    }
}

/// How one edited figure maps onto the file: the storage order of its
/// segments (as indexes into the document's list) and its dense joint IDs.
struct FigurePlan {
    pose_order: Vec<usize>,
    joint_map: HashMap<HKey, f64>,
}

/// Prepares one custom figure for storage (the per-figure loop of `_encode_project`).
fn plan_figure(figure: &mut Value, old: Option<&Value>) -> PyResult<FigurePlan> {
    let input_segments = items(Some(py::item(figure, "segments")?))?;
    let mut segment_ids: Vec<f64> = Vec::with_capacity(input_segments.len());
    for segment in &input_segments {
        match py::item(segment, "segment_id")? {
            Value::Num(n) if n.is_finite() && n.fract() == 0.0 && *n >= 1.0 => segment_ids.push(*n),
            _ => return Err(piv("Segment joint IDs must be distinct positive integers")),
        }
    }
    let mut by_id: HashMap<HKey, usize> = HashMap::with_capacity(input_segments.len());
    for (i, &id) in segment_ids.iter().enumerate() {
        if by_id.insert(py::hkey(&Value::Num(id))?, i).is_some() {
            return Err(piv("Segment joint IDs must be distinct positive integers"));
        }
    }
    // Parent before child, smallest input index first.
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); input_segments.len()];
    let mut ready: BinaryHeap<std::cmp::Reverse<usize>> = BinaryHeap::new();
    for (i, segment) in input_segments.iter().enumerate() {
        let parent = py::item(segment, "parent_id")?;
        if py::eq(parent, &zero()) {
            ready.push(std::cmp::Reverse(i));
        } else {
            match by_id.get(&py::hkey(parent)?) {
                None => return Err(piv("Segment references a deleted parent joint")),
                Some(&at) => children[at].push(i),
            }
        }
    }
    let mut order: Vec<usize> = Vec::with_capacity(input_segments.len());
    while let Some(std::cmp::Reverse(index)) = ready.pop() {
        order.push(index);
        for &child in &children[index] {
            ready.push(std::cmp::Reverse(child));
        }
    }
    if order.len() != input_segments.len() {
        return Err(piv("Cyclic segment topology"));
    }
    // Requested layers are resolved before records move, so their ranks survive the reordering.
    let old = old.filter(|old| py::truthy(old));
    let old_or_empty = old.unwrap_or(empty_dict());
    let mut old_segments: HashMap<HKey, Value> = HashMap::new();
    for segment in items(py::get(old_or_empty, "segments")?)? {
        old_segments.insert(py::hkey(py::item(&segment, "segment_id")?)?, segment);
    }
    let empty = crate::ctx::empty_list();
    let original_array = py::get(old_or_empty, "segment_z_raw")?.unwrap_or(&empty).clone();
    let current_array = py::get(figure, "segment_z_raw")?.unwrap_or(&empty).clone();
    let explicit_array = py::len(&current_array)? == input_segments.len() && !py::eq(&current_array, &original_array);
    let mut layer_values: Vec<Value> = Vec::with_capacity(input_segments.len());
    for (i, segment) in input_segments.iter().enumerate() {
        layer_values.push(if explicit_array {
            py::at(&current_array, i)?
        } else {
            let before = old_segments.get(&py::hkey(py::item(segment, "segment_id")?)?);
            // The paint index is already on the record when Python evaluates this alias.
            alias_value(segment, before, "z_order_runtime_raw", "z_order", &minus_one, Value::Num(i as f64))?
        });
    }
    // Joint IDs become dense: sparse or deleted IDs are renumbered in ascending order.
    let mut sorted = segment_ids.clone();
    sorted.sort_by(f64::total_cmp);
    let dense = sorted.iter().enumerate().all(|(i, &id)| id == i as f64 + 1.0);
    let mut joint_map: HashMap<HKey, f64> = HashMap::from([(py::hkey_int(0), 0.0)]);
    for (i, &id) in sorted.iter().enumerate() {
        joint_map.insert(py::hkey(&Value::Num(id))?, if dense { id } else { i as f64 + 1.0 });
    }
    let mut stored: Vec<Value> = Vec::with_capacity(order.len());
    for &index in &order {
        let mut segment = input_segments[index].clone();
        let old_id = py::item(&segment, "segment_id")?.clone();
        let parent = py::item(&segment, "parent_id")?.clone();
        let new_id = joint_map[&py::hkey(&old_id)?];
        let Some(&new_parent) = joint_map.get(&py::hkey(&parent)?) else {
            return Err(piv("Segment references a deleted parent joint"));
        };
        set(&mut segment, "_paint_input_index", Value::Num(index as f64));
        set(&mut segment, "_logical_segment_id", old_id);
        set(&mut segment, "segment_id", Value::Num(new_id));
        set(&mut segment, "parent_id", Value::Num(new_parent));
        stored.push(segment);
    }
    let layers: Vec<Value> = order.iter().map(|&index| layer_values[index].clone()).collect();
    let mut polygons = items(py::get(figure, "polyfills")?)?;
    for polygon in &mut polygons {
        let mut mapped = Vec::new();
        for id in py::iter(py::item(polygon, "segment_ids")?)?.iter() {
            match joint_map.get(&py::hkey(&id)?) {
                Some(&new_id) => mapped.push(Value::Num(new_id)),
                None => return Err(piv("Polygon references a deleted joint")),
            }
        }
        set(polygon, "segment_ids", crate::ctx::list(mapped));
    }
    let had_polygons = py::get(figure, "polyfills")?.is_some_and(py::is_list);
    set(figure, "segments", Value::Arr(Arc::new(stored)));
    set(figure, "segment_z_raw", crate::ctx::list(layers));
    set(figure, "_resolved_segment_z", Value::Bool(true));
    if had_polygons {
        set(figure, "polyfills", Value::Arr(Arc::new(polygons)));
    }
    Ok(FigurePlan { pose_order: order, joint_map })
}

/// `_encode_project` after the frame-only attempt: new tables, then the frames.
fn rebuild(ctx: &Ctx<'_>, source: &[u8], original: &Original<'_>, document: &Value) -> PyResult<Vec<u8>> {
    ctx.checkpoint()?;
    let figures = py::get(document, "figure_types")?.filter(|f| py::is_list(f));
    let backgrounds = py::get(document, "backgrounds")?.filter(|b| py::is_list(b));
    let (Some(figures), Some(backgrounds)) = (figures, backgrounds) else {
        return Err(piv("Figure/background tables must be lists"));
    };
    let figures = items(Some(figures))?;
    let backgrounds = items(Some(backgrounds))?;
    let original_figures = items(original.layout.report.get("figure_types"))?;
    let mut old_types: HashMap<HKey, &Value> = HashMap::new();
    let mut old_offsets: HashMap<HKey, &Value> = HashMap::new();
    for figure in &original_figures {
        old_types.insert(py::hkey(py::item(figure, "figure_type_id")?)?, figure);
        if !py::truthy_opt(py::get(figure, "implicit")?) {
            let decode = py::get(figure, "segment_decode")?.unwrap_or(empty_dict());
            old_offsets.insert(py::hkey(py::get(decode, "records_start")?.unwrap_or(missing()))?, figure);
        }
    }
    let old_of = |figure: &Value| -> PyResult<Option<&Value>> {
        if let Some(&old) = old_types.get(&py::hkey(py::item(figure, "figure_type_id")?)?) {
            return Ok(Some(old));
        }
        let decode = py::get(figure, "segment_decode")?.unwrap_or(empty_dict());
        Ok(old_offsets.get(&py::hkey(py::get(decode, "records_start")?.unwrap_or(missing()))?).copied())
    };
    let mut ids: Vec<HKey> = Vec::with_capacity(figures.len());
    for figure in &figures {
        ids.push(py::hkey(&positive_id(py::get(figure, "figure_type_id")?, "figure ID")?)?);
    }
    let mut distinct = ids.clone();
    distinct.sort();
    distinct.dedup();
    if distinct.len() != ids.len() {
        return Err(piv("Duplicate figure type IDs"));
    }
    let one = Value::Num(1.0);
    let native = builtin_man();
    let builtin = figures.iter().find(|figure| py::eq(figure.get("figure_type_id").unwrap_or(missing()), &one));
    let mut custom: Vec<Value> = figures.iter().filter(|figure| !py::eq(figure.get("figure_type_id").unwrap_or(missing()), &one)).cloned().collect();
    // Slot 1 cannot store edits: an edited default figure becomes the first custom record.
    if let Some(builtin) = builtin.filter(|builtin| !same_signature(builtin, &native)) {
        custom.insert(0, builtin.clone());
    }
    let mut mapping: HashMap<HKey, f64> = HashMap::from([(py::hkey_int(1), 1.0)]);
    for (i, figure) in custom.iter().enumerate() {
        mapping.insert(py::hkey(py::item(figure, "figure_type_id")?)?, i as f64 + 2.0);
    }
    let mut plans: HashMap<HKey, FigurePlan> = HashMap::new();
    let native_joints: HashMap<HKey, f64> = (0..=12).map(|i| (py::hkey_int(i), i as f64)).collect();
    for figure in &mut custom {
        ctx.checkpoint()?;
        let old = old_of(figure)?;
        let key = py::hkey(py::item(figure, "figure_type_id")?)?;
        let plan = plan_figure(figure, old)?;
        plans.insert(key, plan);
    }
    let mut bg_map: HashMap<HKey, f64> = HashMap::from([(py::hkey_int(0), 0.0)]);
    let mut bg_ids: Vec<HKey> = Vec::with_capacity(backgrounds.len());
    for background in &backgrounds {
        bg_ids.push(py::hkey(&positive_id(py::get(background, "background_id")?, "background ID")?)?);
    }
    let mut distinct = bg_ids.clone();
    distinct.sort();
    distinct.dedup();
    if distinct.len() != bg_ids.len() {
        return Err(piv("Duplicate background IDs"));
    }
    for (i, id) in bg_ids.into_iter().enumerate() {
        bg_map.insert(id, i as f64 + 1.0);
    }
    let mut w = Writer::default();
    w.data.push(5);
    w.put(Fmt::U32, py::item(document, "canvas_width")?, format_args!("canvas width"))?;
    w.put(Fmt::U32, py::item(document, "canvas_height")?, format_args!("canvas height"))?;
    w.put_count(Fmt::U16, backgrounds.len() + 1, format_args!("background slots"))?;
    for background in &backgrounds {
        write_background(&mut w, background, &original.payload)?;
    }
    w.put_count(Fmt::U16, custom.len() + 2, format_args!("figure slots"))?;
    for figure in &custom {
        let old = old_of(figure)?;
        write_figure(ctx, &mut w, figure, old, &original.payload)?;
    }
    // A valid one-frame scaffold lets the reader check every rebuilt table.
    let tables_end = w.data.len();
    w.data.extend_from_slice(&crate::bridge::scaffold_frames(&original.layout.fps.to_le_bytes()));
    w.data.extend_from_slice(&original.layout.trailer);
    if w.data.len() > MAX_PAYLOAD_BYTES {
        return Err(piv("Serialized tables exceed project size limit"));
    }
    let normalized = validate_payload(ctx, &w.data)?;
    w.data.truncate(tables_end);
    // Frames: logical references become the file's dense ones.
    let mut frames = items(Some(py::item(document, "keyframes")?))?;
    for frame in &mut frames {
        ctx.checkpoint()?;
        for key in ["background_id", "background_id_b"] {
            if let Some(id) = py::get(frame, key)?.filter(|id| !id.is_null()) {
                match bg_map.get(&py::hkey(id)?) {
                    Some(&mapped) => set(frame, key, Value::Num(mapped)),
                    None => return Err(piv("Frame references a deleted background")),
                }
            }
        }
        let mut objects = items(Some(py::item(frame, "objects")?))?;
        let mut uid_types: HashMap<HKey, Value> = HashMap::with_capacity(objects.len());
        for object in &objects {
            uid_types.insert(py::hkey(py::item(object, "unique_id")?)?, py::item(object, "figure_type_id")?.clone());
        }
        let object_ids: Vec<Value> = objects.iter().map(|object| object.get("unique_id").cloned().unwrap_or(Value::Null)).collect();
        for object in &mut objects {
            ctx.checkpoint()?;
            let type_key = py::hkey(py::item(object, "figure_type_id")?)?;
            if let Some(plan) = plans.get(&type_key) {
                for key in ["angles", "lengths", "bends"] {
                    let Some(values) = py::get(object, key)?.filter(|values| py::truthy(values)).cloned() else { continue };
                    if py::len(&values)? != plan.pose_order.len() {
                        return Err(piv(format!("Pose {key} does not match edited segment count")));
                    }
                    let reordered: PyResult<Vec<Value>> = plan.pose_order.iter().map(|&i| py::at(&values, i)).collect();
                    set(object, key, crate::ctx::list(reordered?));
                }
            }
            if let Some(join) = py::get(object, "join")?.filter(|join| py::truthy(join)).cloned() {
                let target_type = if py::contains_key(&join, "target_unique_id")? {
                    match uid_types.get(&py::hkey(py::item(&join, "target_unique_id")?)?) {
                        Some(target) => target.clone(),
                        None => return Err(piv("Join references a deleted object")),
                    }
                } else {
                    let slot = py::item(&join, "target_object_slot")?;
                    let index = match slot {
                        Value::Num(n) if n.fract() == 0.0 && *n >= 0.0 && (*n as usize) < object_ids.len() => *n as usize,
                        Value::Bool(b) if (*b as usize) < object_ids.len() => *b as usize,
                        _ => return Err(piv("Join references an invalid object slot")),
                    };
                    uid_types[&py::hkey(&object_ids[index])?].clone()
                };
                let target_key = py::hkey(&target_type)?;
                let handle = py::item(&join, "target_handle_id")?;
                let mapped = match plans.get(&target_key) {
                    Some(plan) => plan.joint_map.get(&py::hkey(handle)?),
                    None if target_key == py::hkey_int(1) => native_joints.get(&py::hkey(handle)?),
                    None => None,
                };
                let Some(&mapped) = mapped else {
                    return Err(piv("Join references a deleted target joint"));
                };
                let mut join = join;
                set(&mut join, "target_handle_id", Value::Num(mapped));
                set(object, "join", join);
            }
            match mapping.get(&type_key) {
                Some(&mapped) => set(object, "figure_type_id", Value::Num(mapped)),
                None => return Err(piv("Frame references a deleted figure type")),
            }
        }
        set(frame, "objects", Value::Arr(Arc::new(objects)));
    }
    let mut scene = Obj::new();
    scene.set("keyframes", Value::Arr(Arc::new(frames)));
    scene.set("fps", py::item(document, "fps")?.clone());
    scene.set("auto_easing", py::get(document, "auto_easing")?.cloned().unwrap_or(Value::Bool(original.layout.auto_easing)));
    let source_default = original.layout.report.get("auto_easing_source").cloned().unwrap_or_else(|| Value::str("file"));
    scene.set("auto_easing_source", py::get(document, "auto_easing_source")?.cloned().unwrap_or(source_default));
    let scene = Value::object(scene);
    let tables = Tables { figures: &normalized.figures, auto_easing: normalized.auto_easing, trailer: &original.layout.trailer };
    wrap_malformed(write_frames(ctx, &mut w, &scene, &tables))?;
    if w.data.len() > MAX_PAYLOAD_BYTES {
        return Err(piv("Encoded project exceeds size limit"));
    }
    let result = w.data;
    // References, topology, finite geometry and timings of the whole result.
    validate_payload(ctx, &result)?;
    if result[..] == original.payload[..] {
        return Ok(source.to_vec());
    }
    Ok(if original.compressed { zlib::compress(&result) } else { result })
}

fn encode_project(ctx: &Ctx<'_>, source: &[u8], document: &Value, force_rebuild: bool) -> PyResult<Vec<u8>> {
    ctx.checkpoint()?;
    let original = decode_original(ctx, source)?;
    let is_v5 = py::get(document, "version")?.is_some_and(|v| py::eq(v, &Value::Num(5.0)));
    let Some(original) = original.filter(|_| is_v5) else {
        return Err(piv("Full project serialization supports V5 only"));
    };
    if !force_rebuild {
        // Unchanged tables keep the source's bytes: only the frames are rewritten.
        match wrap_malformed(encode_frames_only(ctx, source, &original, document)) {
            Ok(result) => return Ok(result),
            Err(error) if error.is(Class::Piv) => {}
            Err(error) => return Err(error),
        }
    }
    rebuild(ctx, source, &original, document)
}

/// `encode_piv_project(source, document, force_rebuild=...)`: a Pivot 5 file
/// of `document`, compressed when `source` is.
pub(crate) fn encode_piv_project(ctx: &Ctx<'_>, source: &[u8], document: &Value, force_rebuild: bool) -> PyResult<Vec<u8>> {
    if !document.is_object() {
        return Err(piv("Project document must be an object"));
    }
    encode_project(ctx, source, document, force_rebuild).map_err(|error| {
        let wrapped = [Class::Key, Class::Type, Class::Attribute, Class::Index, Class::Value, Class::Struct, Class::Overflow];
        if !error.is(Class::Piv) && error.is_any(&wrapped) && error.exc != crate::error::Exc::Api {
            piv(format!("Invalid full project document: {}", error.msg))
        } else {
            error
        }
    })
}

/// The figure report of a decoded payload (used by STK export).
pub(crate) fn decoded_figures(ctx: &Ctx<'_>, payload: &[u8]) -> PyResult<Vec<Value>> {
    let decoded = v5::decode(ctx, payload, payload.len(), "", crate::piv::frames::FrameMode::Validate)?;
    items(decoded.report.get("figure_types"))
}
