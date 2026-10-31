//! Image and text tables for the full writer (`piv_asset_writer.py` and the
//! writing half of `piv_side_tables.py`).
//!
//! An edited document may carry its media inline, or only point at where the
//! original file stores it. Hydration resolves every asset to what the file
//! needs (image bytes and anchors; a text's outlines and placements), checking
//! each field the way the Python writer did. The original payload is the
//! decompressed source; image spans are absolute offsets in it.

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::base64;
use crate::error::{Class, PyResult, asset_write};
use crate::piv::side_tables::{COMMAND_NAMES, TableReader, VALUE_COUNTS, read_image, read_text};
use crate::py::{self, HKey};
use crate::text::utf16_units;

/// `_integer(value, label, minimum, maximum)`.
fn integer(value: Option<&Value>, label: &str, minimum: f64, maximum: f64) -> PyResult<f64> {
    let number = match value {
        Some(Value::Num(n)) => *n,
        _ => return Err(asset_write(format!("{label} must be an integer"))),
    };
    if !(minimum <= number && number <= maximum) || !number.is_finite() || number.fract() != 0.0 {
        return Err(asset_write(format!("{} must be an integer in [{}, {}]", label, crate::pyfmt::py_number(minimum), crate::pyfmt::py_number(maximum))));
    }
    Ok(number)
}

/// `_float32(value, label)`: the value as the file will hold it.
fn float32(value: Option<&Value>, label: &str) -> PyResult<f32> {
    let number = match value {
        Some(Value::Num(n)) if n.is_finite() => *n,
        _ => return Err(asset_write(format!("{label} must be a finite number"))),
    };
    let single = number as f32;
    if !single.is_finite() {
        return Err(asset_write(format!("{label} is outside the float32 range")));
    }
    Ok(single)
}

/// `_base64(value, label)`.
fn base64_field(value: &Value, label: &str) -> PyResult<Arc<[u8]>> {
    match value {
        Value::Blob(blob) if blob.prefix.is_empty() => Ok(blob.bytes.clone()),
        Value::Str(_) | Value::Blob(_) => {
            let text = value.text().unwrap_or_default();
            base64::decode(text.as_bytes(), true).map(Arc::from).ok_or_else(|| asset_write(format!("Invalid {label}")))
        }
        _ => Err(asset_write(format!("{label} must be a base64 string"))),
    }
}

/// `_inline_bytes(asset)`: the image a document supplies itself, if any.
fn inline_bytes(asset: &Obj) -> PyResult<Option<Arc<[u8]>>> {
    let mut values: Vec<Arc<[u8]>> = Vec::new();
    if let Some(data) = asset.get("data_base64").filter(|data| !data.is_null()) {
        values.push(base64_field(data, "data_base64")?);
    }
    for key in ["data_url", "data_uri"] {
        let Some(value) = asset.get(key).filter(|value| !value.is_null()) else { continue };
        let remote = || asset_write("data_url must be a base64 data URL, not a remote URL");
        if !py::is_str(value) {
            return Err(remote());
        }
        let (header, payload): (String, Option<Arc<[u8]>>) = match value {
            // A blob whose prefix is the whole header: the bytes need no decoding.
            Value::Blob(blob) if blob.prefix.ends_with(',') && blob.prefix.matches(',').count() == 1 => (blob.prefix[..blob.prefix.len() - 1].to_string(), Some(blob.bytes.clone())),
            _ => {
                let text = value.text().unwrap_or_default();
                match text.split_once(',') {
                    Some((header, encoded)) if text.starts_with("data:") => {
                        let header = header.to_string();
                        check_data_header(&header)?;
                        let bytes = base64::decode(encoded.as_bytes(), true).ok_or_else(|| asset_write("Invalid data_url base64 payload"))?;
                        values.push(Arc::from(bytes));
                        continue;
                    }
                    _ => return Err(remote()),
                }
            }
        };
        if !header.starts_with("data:") {
            return Err(remote());
        }
        check_data_header(&header)?;
        if let Some(bytes) = payload {
            values.push(bytes);
        }
    }
    let Some(first) = values.first() else { return Ok(None) };
    if values.iter().skip(1).any(|value| !Arc::ptr_eq(value, first) && **value != **first) {
        return Err(asset_write("Conflicting data_base64 and data_url; remove or update the stale representation"));
    }
    Ok(Some(first.clone()))
}

/// The `data:<mime>;base64` part of a data URL must say base64 and name an image.
fn check_data_header(header: &str) -> PyResult<()> {
    let parts: Vec<&str> = header.get(5..).unwrap_or("").split(';').collect();
    if parts.last().map(|p| p.to_lowercase()) != Some("base64".to_string()) {
        return Err(asset_write("data_url must use base64 encoding"));
    }
    let mime = parts[0].to_lowercase();
    if !(mime.starts_with("image/") || mime == "application/octet-stream") {
        return Err(asset_write("data_url must contain image data"));
    }
    Ok(())
}

/// `_source_span`: the bytes between `image_start` and `source_end` of the original payload.
fn source_span<'a>(asset: &Obj, payload: &'a [u8]) -> PyResult<Option<&'a [u8]>> {
    let present = |key: &str| asset.get(key).filter(|value| !value.is_null());
    match (present("image_start"), present("source_end")) {
        (None, None) => Ok(None),
        (Some(start), Some(end)) => {
            let start = integer(Some(start), "image_start", 0.0, payload.len() as f64)?;
            let end = integer(Some(end), "source_end", start, payload.len() as f64)?;
            Ok(Some(&payload[start as usize..end as usize]))
        }
        _ => Err(asset_write("Original image recovery requires both image_start and source_end")),
    }
}

/// `resolve_image_bytes`: inline data first, then the original source span.
/// Paths are never read (the service passes no workspace root).
pub(crate) fn resolve_image_bytes(asset: &Value, payload: &[u8]) -> PyResult<Arc<[u8]>> {
    let Some(object) = asset.as_obj() else {
        return Err(asset_write("Image asset must be an object"));
    };
    let value = match inline_bytes(object)? {
        Some(bytes) => bytes,
        None => match source_span(object, payload)? {
            Some(span) => Arc::from(span),
            None => return Err(asset_write("Image has no inline data, original source span, or permitted workspace file")),
        },
    };
    if value.is_empty() {
        return Err(asset_write("Encoded image data cannot be empty"));
    }
    Ok(value)
}

/// One outline as the file stores it.
pub(crate) struct Outline {
    pub codes: Vec<usize>,
    pub values: Vec<f32>,
}

/// An asset with everything the file needs.
pub(crate) enum Hydrated {
    Image { index: usize, anchors: [i32; 4], data: Arc<[u8]> },
    Text { index: usize, font_name: Vec<u16>, font_style: u8, alignment: u32, text: Vec<u16>, glyphs: Vec<Outline>, placements: Vec<Option<(f32, f32)>> },
}

impl Hydrated {
    pub fn is_image(&self) -> bool {
        matches!(self, Hydrated::Image { .. })
    }
}

/// `_original_record`: the record of the original file an incomplete asset points at.
fn original_record(asset: &Obj, kind: &str, payload: &[u8], index: usize) -> PyResult<Option<Obj>> {
    let mut start = asset.get("source_start").filter(|value| !value.is_null()).cloned();
    if start.is_none()
        && kind == "image"
        && let Some(image_start) = asset.get("image_start").filter(|value| !value.is_null())
    {
        start = Some(Value::Num(integer(Some(image_start), "image_start", 24.0, payload.len() as f64)? - 24.0));
    }
    let Some(start) = start else { return Ok(None) };
    let start = integer(Some(&start), "asset.source_start", 0.0, payload.len() as f64)? as usize;
    if payload.is_empty() {
        return Ok(None);
    }
    let mut reader = TableReader::new(payload, start);
    let recovered = if kind == "image" { read_image(&mut reader, index, false) } else { read_text(&mut reader, index) };
    let recovered = match recovered {
        Ok(recovered) => recovered.build_obj(),
        Err(error) if error.is_any(&[Class::Value, Class::Struct, Class::Index]) => {
            return Err(asset_write(format!("Cannot recover original {kind} record at {start}")));
        }
        Err(error) => return Err(error),
    };
    if let Some(end) = asset.get("source_end").filter(|value| !value.is_null())
        && !py::eq(end, &Value::Num(reader.pos as f64))
    {
        return Err(asset_write(format!("Original {kind} record end disagrees with source_end")));
    }
    Ok(Some(recovered))
}

/// `_validate_text`: one glyph per distinct UTF-16 unit, one placement per unit.
fn validate_text(asset: &Obj, index: usize) -> PyResult<Hydrated> {
    for field in ["font_name", "text"] {
        if !asset.get(field).is_some_and(py::is_str) {
            return Err(asset_write(format!("Text asset {field} must be a string")));
        }
    }
    let string = |field: &str| asset.get(field).and_then(|value| value.text()).unwrap_or_default().into_owned();
    let font_style = integer(Some(asset.get("font_style").unwrap_or(&Value::Num(0.0))), "font_style", 0.0, 255.0)? as u8;
    let alignment = integer(Some(asset.get("alignment").unwrap_or(&Value::Num(0.0))), "alignment", 0.0, 4294967295.0)? as u32;
    let units = utf16_units(&string("text"));
    let mut unique: Vec<u16> = Vec::new();
    for &unit in &units {
        if !unique.contains(&unit) {
            unique.push(unit);
        }
    }
    let glyphs = asset.get("glyphs").filter(|g| py::is_list(g) && g.array_len() == Some(unique.len()) && unique.len() <= 255);
    let Some(glyphs) = glyphs else {
        return Err(asset_write("Text requires one glyph per distinct UTF-16 code unit, at most 255"));
    };
    let Some(placements) = asset.get("placements").filter(|p| py::is_list(p) && p.array_len() == Some(units.len())) else {
        return Err(asset_write("Text requires one placement per UTF-16 code unit"));
    };
    let mut outlines: Vec<Outline> = Vec::with_capacity(unique.len());
    for (gi, (glyph, &unit)) in py::iter(glyphs)?.iter().zip(&unique).enumerate() {
        let commands = glyph.as_obj().and_then(|g| g.get("commands")).filter(|c| py::is_list(c));
        let Some(commands) = commands else {
            return Err(asset_write(format!("Glyph {gi} requires a commands array")));
        };
        if glyph.get("utf16_code_unit").is_some_and(|recorded| !py::eq(recorded, &Value::Num(unit as f64))) {
            return Err(asset_write(format!("Glyph {gi} does not match the edited text")));
        }
        let mut outline = Outline { codes: Vec::new(), values: Vec::new() };
        for (ci, command) in py::iter(commands)?.iter().enumerate() {
            let code = command.as_obj().and_then(|c| c.get("op")).and_then(Value::as_str).and_then(|op| COMMAND_NAMES.iter().position(|name| *name == op));
            let Some(code) = code else {
                return Err(asset_write(format!("Invalid glyph {gi} command {ci}")));
            };
            let values = command.get("values").filter(|v| py::is_list(v) && v.array_len() == Some(VALUE_COUNTS[code]));
            let Some(values) = values else {
                return Err(asset_write(format!("Invalid coordinate count for glyph {gi} command {ci}")));
            };
            for value in py::iter(values)?.iter() {
                outline.values.push(float32(Some(&value), &format!("glyph {gi} command {ci} coordinate"))?);
            }
            outline.codes.push(code);
        }
        outlines.push(outline);
    }
    let mut placed: Vec<Option<(f32, f32)>> = Vec::with_capacity(units.len());
    for (pi, (placement, &unit)) in py::iter(placements)?.iter().zip(&units).enumerate() {
        let Some(object) = placement.as_obj() else {
            return Err(asset_write(format!("Text placement {pi} must be an object")));
        };
        let index = unique.iter().position(|&u| u == unit).unwrap_or(0);
        let unit_ok = object.get("utf16_code_unit").is_none_or(|recorded| py::eq(recorded, &Value::Num(unit as f64)));
        let glyph_ok = object.get("glyph_index").is_none_or(|recorded| py::eq(recorded, &Value::Num(index as f64)));
        if !unit_ok || !glyph_ok {
            return Err(asset_write(format!("Text placement {pi} does not match the edited text")));
        }
        placed.push(if outlines[index].codes.is_empty() {
            None
        } else {
            Some((float32(object.get("x"), &format!("text placement {pi}.x"))?, float32(object.get("y"), &format!("text placement {pi}.y"))?))
        });
    }
    Ok(Hydrated::Text { index, font_name: utf16_units(&string("font_name")), font_style, alignment, text: units, glyphs: outlines, placements: placed })
}

/// `hydrate_side_tables`: every asset validated and complete, in the order given.
pub(crate) fn hydrate_side_tables(assets: &[Value], payload: &[u8]) -> PyResult<Vec<Hydrated>> {
    let mut result = Vec::with_capacity(assets.len());
    let mut images: Vec<usize> = Vec::new();
    let mut texts: Vec<usize> = Vec::new();
    for original in assets {
        let kind = match original.as_obj().map(|object| object.get("kind")) {
            Some(Some(kind)) => {
                // Looking the kind up in a dictionary hashes it.
                py::hkey(kind)?;
                kind.as_str().filter(|kind| matches!(*kind, "image" | "text"))
            }
            Some(None) => None,
            None => None,
        };
        let (Some(kind), Some(object)) = (kind, original.as_obj()) else {
            return Err(asset_write("Side-table asset kind must be image or text"));
        };
        let seen = if kind == "image" { &mut images } else { &mut texts };
        let fallback = Value::Num(seen.len() as f64);
        let declared = object.get("asset_index").or_else(|| object.get("table_index")).unwrap_or(&fallback);
        let index = integer(Some(declared), &format!("{kind}.asset_index"), 0.0, 65534.0)?;
        let table_index = integer(Some(object.get("table_index").unwrap_or(&Value::Num(index))), &format!("{kind}.table_index"), 0.0, 65534.0)?;
        if table_index != index {
            return Err(asset_write("asset_index and table_index disagree"));
        }
        let index = index as usize;
        if seen.contains(&index) {
            return Err(asset_write(format!("Duplicate {kind} asset index {index}")));
        }
        seen.push(index);
        let mandatory: &[&str] = if kind == "image" { &["anchor_start", "anchor_end"] } else { &["font_name", "font_style", "alignment", "text", "glyphs", "placements"] };
        let mut needs_recovery = mandatory.iter().any(|field| !object.contains(field));
        if kind == "image" {
            needs_recovery |= ["anchor_start", "anchor_end"].iter().any(|field| object.get(field).and_then(Value::as_obj).is_some_and(|point| !point.contains("x") || !point.contains("y")));
        }
        let mut asset: Obj = object.clone();
        if needs_recovery {
            // Metadata only: the original inline data never overrides a supplied source span.
            let mut recovered = original_record(&asset, kind, payload, index)?.unwrap_or_default();
            recovered.remove("data_base64");
            recovered.remove("data_url");
            for field in ["anchor_start", "anchor_end"] {
                if let (Some(Value::Obj(supplied)), Some(Value::Obj(found))) = (asset.get(field), recovered.get(field)) {
                    let mut merged: Obj = (**found).clone();
                    for (key, value) in supplied.iter() {
                        merged.set(key, value.clone());
                    }
                    recovered.set(field, Value::object(merged));
                    asset.remove(field);
                }
            }
            for (key, value) in asset.iter() {
                recovered.set(key, value.clone());
            }
            asset = recovered;
        }
        if kind == "image" {
            let data = resolve_image_bytes(&Value::object(asset.clone()), payload)?;
            let mut anchors = [0i32; 4];
            for (at, field) in ["anchor_start", "anchor_end"].iter().enumerate() {
                let Some(point) = asset.get(field).and_then(Value::as_obj) else {
                    return Err(asset_write(format!("Image asset requires {field}")));
                };
                for (axis_at, axis) in ["x", "y"].iter().enumerate() {
                    anchors[at * 2 + axis_at] = integer(point.get(axis), &format!("{field}.{axis}"), -2147483648.0, 2147483647.0)? as i32;
                }
            }
            result.push(Hydrated::Image { index, anchors, data });
        } else {
            result.push(validate_text(&asset, index)?);
        }
    }
    for (kind, mut present) in [("image", images), ("text", texts)] {
        present.sort_unstable();
        if present.iter().enumerate().any(|(expected, &index)| expected != index) {
            return Err(asset_write(format!("Non-contiguous {kind} table indexes")));
        }
    }
    Ok(result)
}

fn write_string(out: &mut Vec<u8>, units: &[u16]) {
    out.extend_from_slice(&(units.len() as u32).to_le_bytes());
    for unit in units {
        out.extend_from_slice(&unit.to_le_bytes());
    }
}

/// `encode_side_tables`: the image table, then the text table, each written
/// when a segment of its kind exists. Image end pointers are absolute: `pos` is
/// where these bytes will sit in the new file.
pub(crate) fn encode_side_tables(assets: &[Hydrated], pos: usize, has_image_segments: bool, has_text_segments: bool) -> Vec<u8> {
    let mut out = Vec::new();
    for images in [true, false] {
        if !(if images { has_image_segments } else { has_text_segments }) {
            continue;
        }
        let mut table: Vec<&Hydrated> = assets.iter().filter(|asset| asset.is_image() == images).collect();
        table.sort_by_key(|asset| match asset {
            Hydrated::Image { index, .. } | Hydrated::Text { index, .. } => *index,
        });
        out.extend_from_slice(&(table.len() as u16).to_le_bytes());
        for asset in table {
            match asset {
                Hydrated::Image { anchors, data, .. } => {
                    for anchor in anchors {
                        out.extend_from_slice(&anchor.to_le_bytes());
                    }
                    out.extend_from_slice(&((pos + out.len() + 8 + data.len()) as u64).to_le_bytes());
                    out.extend_from_slice(data);
                }
                Hydrated::Text { font_name, font_style, alignment, text, glyphs, placements, .. } => {
                    write_string(&mut out, font_name);
                    out.push(*font_style);
                    out.extend_from_slice(&alignment.to_le_bytes());
                    write_string(&mut out, text);
                    out.push(glyphs.len() as u8);
                    for glyph in glyphs {
                        let nodes: u32 = glyph.codes.iter().map(|&code| if code == 2 { 3 } else { 1 }).sum();
                        out.extend_from_slice(&nodes.to_le_bytes());
                        for pair in glyph.codes.chunks(2) {
                            out.push(pair[0] as u8 | pair.get(1).map_or(0, |&code| (code as u8) << 4));
                        }
                        for value in &glyph.values {
                            out.extend_from_slice(&value.to_le_bytes());
                        }
                    }
                    for (x, y) in placements.iter().flatten() {
                        out.extend_from_slice(&x.to_le_bytes());
                        out.extend_from_slice(&y.to_le_bytes());
                    }
                }
            }
        }
    }
    out
}

/// A value's place in a Python `set` of primitive codes.
pub(crate) fn primitive_key(value: &Value) -> PyResult<HKey> {
    py::hkey(value)
}
