//! Pivot 2-4 projects (`piv_legacy.py`): version dispatch, the checks shared by
//! the legacy readers, and what they normalize for the editor.
//!
//! Legacy sprites are bitmaps with a transparent key colour. The editor needs
//! an image a browser can draw, so the reader also produces a PNG with real
//! transparency; its bytes are the Python reader's (same pixel order, same
//! zlib stream).

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::base64;
use crate::ctx::{Ctx, ObjB, int, list, text};
use crate::error::{PyResult, type_error, value_error};
use crate::piv::side_tables::{blob, py_hypot};
use crate::py;
use crate::zlib;

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = zlib::crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

/// An 8-bit RGBA PNG from scanlines that already carry their filter byte.
pub(crate) fn png_from_rows(width: u32, height: u32, rows: &[u8]) -> Vec<u8> {
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(&mut out, b"IHDR", &header);
    png_chunk(&mut out, b"IDAT", &zlib::compress(rows));
    png_chunk(&mut out, b"IEND", &[]);
    out
}

/// The bytes of a `data:` URL field, whether it is held as text or as a blob.
fn data_uri_bytes(value: &Value, prefix: &str) -> PyResult<Option<Vec<u8>>> {
    match value {
        Value::Blob(blob) if &*blob.prefix == prefix => Ok(Some(blob.bytes.to_vec())),
        Value::Str(_) | Value::Blob(_) => {
            let uri = value.text().unwrap_or_default();
            match uri.strip_prefix(prefix) {
                None => Ok(None),
                Some(encoded) => base64::decode(encoded.as_bytes(), false).map(Some).ok_or_else(|| value_error("Incorrect padding")),
            }
        }
        _ => Ok(None),
    }
}

/// `_keyed_bitmap_png`: turns a colour-keyed BMP sprite (`data_uri`) into a PNG
/// with transparency (`data_url`), or records why it cannot.
pub(crate) fn keyed_bitmap_png(asset: &mut Obj) -> PyResult<()> {
    let key = match asset.get("transparency_color_raw").or_else(|| asset.get("transparent_color_raw")) {
        None | Some(Value::Null) => return Ok(()),
        Some(value) => value.clone(),
    };
    let Some(data) = asset.get("data_uri") else { return Ok(()) };
    let Some(bmp) = data_uri_bytes(data, "data:image/bmp;base64,")? else { return Ok(()) };
    if bmp.len() < 54 || &bmp[..2] != b"BM" {
        return Err(value_error("Truncated legacy sprite bitmap"));
    }
    let u32_at = |at: usize| u32::from_le_bytes([bmp[at], bmp[at + 1], bmp[at + 2], bmp[at + 3]]);
    let pixel_offset = u32_at(10) as u64;
    let dib_size = u32_at(14) as u64;
    if dib_size < 40 {
        asset.set("render_limitations", list(vec![text("Color-key conversion for OS/2 BMP headers is not implemented.")]));
        return Ok(());
    }
    let (width, signed_height) = (u32_at(18) as i32 as i64, u32_at(22) as i32 as i64);
    let planes = u16::from_le_bytes([bmp[26], bmp[27]]);
    let bits = u16::from_le_bytes([bmp[28], bmp[29]]) as u64;
    let compression = u32_at(30);
    let height = signed_height.unsigned_abs();
    if width <= 0 || height == 0 || planes != 1 {
        return Err(value_error("Invalid legacy sprite bitmap geometry"));
    }
    let width = width as u64;
    if compression != 0 || !matches!(bits, 1 | 4 | 8 | 24 | 32) {
        asset.set("render_limitations", list(vec![text(&format!("Color-key conversion for BMP compression {compression}, depth {bits} is not implemented."))]));
        return Ok(());
    }
    let stride = (width * bits).div_ceil(32) * 4;
    if pixel_offset as u128 + stride as u128 * height as u128 > bmp.len() as u128 {
        return Err(value_error("Legacy sprite bitmap pixels exceed stored resource"));
    }
    let key = match py::as_int(&key) {
        Some(key) => key,
        None => return Err(type_error(format!("unsupported operand type(s) for &: '{}' and 'int'", py::type_name(&key)))),
    };
    let key_rgb = [(key & 255) as u8, ((key >> 8) & 255) as u8, ((key >> 16) & 255) as u8];
    let mut palette: Vec<[u8; 3]> = Vec::new();
    if bits <= 8 {
        let used = match u32_at(46) as u64 {
            0 => 1 << bits,
            used => used,
        };
        let palette_start = 14 + dib_size;
        if used > 1 << bits || palette_start + used * 4 > pixel_offset {
            return Err(value_error("Invalid legacy sprite bitmap palette"));
        }
        for index in 0..used as usize {
            let at = palette_start as usize + index * 4;
            palette.push([bmp[at + 2], bmp[at + 1], bmp[at]]);
        }
    }
    let (width, height, stride, pixel_offset) = (width as usize, height as usize, stride as usize, pixel_offset as usize);
    let mut rows: Vec<u8> = Vec::with_capacity(height * (width * 4 + 1));
    for y in 0..height {
        let row = pixel_offset + (if signed_height > 0 { height - 1 - y } else { y }) * stride;
        // PNG filter: none.
        rows.push(0);
        if bits <= 8 {
            let bits = bits as usize;
            let line_start = rows.len();
            for x in 0..width {
                let byte = bmp[row + x * bits / 8];
                let index = ((byte >> (8 - bits - (x * bits % 8))) as usize) & ((1 << bits) - 1);
                let rgb = palette.get(index).copied().unwrap_or([0, 0, 0]);
                if index >= palette.len() {
                    // Python checks the whole row before converting it.
                    rows.truncate(line_start);
                    return Err(value_error("Legacy sprite bitmap references an absent palette color"));
                }
                rows.extend_from_slice(&[rgb[0], rgb[1], rgb[2], if rgb == key_rgb { 0 } else { 255 }]);
            }
        } else {
            let step = (bits / 8) as usize;
            for x in 0..width {
                let at = row + x * step;
                let rgb = [bmp[at + 2], bmp[at + 1], bmp[at]];
                rows.extend_from_slice(&[rgb[0], rgb[1], rgb[2], if rgb == key_rgb { 0 } else { 255 }]);
            }
        }
    }
    let png: Arc<[u8]> = Arc::from(png_from_rows(width as u32, height as u32, &rows));
    asset.set("data_url", blob("data:image/png;base64,", &png));
    asset.set("render_mime_type", text("image/png"));
    asset.set("color_key_applied", Value::Bool(true));
    Ok(())
}

/// What `decode_legacy_payload` normalizes on a sprite: the keyed PNG, a table
/// index, and attachment anchors in the modern field names.
pub(crate) fn normalize_sprite(asset: &mut Obj) -> PyResult<()> {
    keyed_bitmap_png(asset)?;
    if !asset.contains("asset_index") {
        let index = asset.get("image_index").or_else(|| asset.get("sprite_index")).cloned().unwrap_or(Value::Num(0.0));
        asset.set("asset_index", index);
    }
    if let (Some(start), Some(end)) = (asset.get("pivot").cloned(), asset.get("endpoint").cloned()) {
        let coordinate = |point: &Value, axis: &str| point.get(axis).and_then(Value::as_f64).unwrap_or(0.0);
        let (dx, dy) = (coordinate(&end, "x") - coordinate(&start, "x"), coordinate(&end, "y") - coordinate(&start, "y"));
        for (key, value) in [("anchor_start", start), ("anchor_end", end), ("anchor_length", Value::Num(py_hypot(dx, dy))), ("anchor_angle_rad", Value::Num(dy.atan2(dx)))] {
            if !asset.contains(key) {
                asset.set(key, value);
            }
        }
    }
    data_url_default(asset);
    Ok(())
}

/// `asset.setdefault("data_url", asset["data_uri"])`.
pub(crate) fn data_url_default(asset: &mut Obj) {
    if let Some(uri) = asset.get("data_uri").cloned()
        && !asset.contains("data_url")
    {
        asset.set("data_url", uri);
    }
}

/// What a legacy reader hands back before the shared checks.
pub(crate) struct LegacyParts {
    /// The report, with every per-record normalization already applied.
    pub report: ObjB,
    pub validation: ObjB,
    pub width: u32,
    pub height: u32,
    /// The frame rate as Python computed it (an integer).
    pub fps: f64,
    /// Scalar-editor bindings the Python reader recorded (reported as a count).
    pub bindings: usize,
    /// Output frames: the sum of every keyframe's hold.
    pub total_frames: f64,
}

/// `decode_legacy_payload`: an uncompressed Pivot 2, 3 or 4 payload as the report schema.
pub(crate) fn decode_legacy_payload(ctx: &Ctx<'_>, data: &[u8], source_path: &str) -> PyResult<Value> {
    let version = data.first().copied();
    let parts = match version {
        Some(4) => crate::piv::legacy_v4::decode_v4(ctx, data, source_path)?,
        Some(2 | 3) => crate::piv::legacy_v2::decode_v2(ctx, data, source_path)?,
        other => return Err(value_error(format!("Unsupported legacy Pivot version: {}", other.map(|v| v.to_string()).unwrap_or_else(|| "empty".to_string())))),
    };
    let LegacyParts { mut report, mut validation, width, height, fps, bindings, total_frames } = parts;
    // `_validate_report`: the readers already reject broken references; what is
    // left to refuse here are sizes and rates their binary widths allow.
    for (field, value) in [("canvas_width", width), ("canvas_height", height)] {
        if !(0 < value && value <= 100000) {
            return Err(value_error(format!("Invalid legacy {field}: {value}")));
        }
    }
    if !(1.0..=1000.0).contains(&fps) {
        return Err(value_error(format!("Invalid legacy playback rate: {}", crate::pyfmt::py_number(fps))));
    }
    validation.set("payload_consumed", int(data.len()));
    validation.set("reference_integrity", true);
    validation.set("editable_field_count", int(bindings));
    report.set("validation", validation.build());
    report.set_default("payload_size", int(data.len()));
    report.set_default("source_path", text(source_path));
    report.set_default("file_type", text("piv"));
    report.set_default("trace_assisted", false);
    report.set_default("supports_viewer", true);
    report.set_default("total_output_frames", Value::Num(total_frames));
    report.set_default("duration_seconds", Value::Num(total_frames / fps));
    Ok(report.build())
}

#[cfg(test)]
#[path = "legacy_tests.rs"]
mod tests;
