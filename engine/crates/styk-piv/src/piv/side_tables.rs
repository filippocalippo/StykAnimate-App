//! Image and text tables of a Pivot 5 figure (`piv_side_tables.py`).
//!
//! A figure with image or text segments stores, right after its bend table, a
//! table of images (anchor points and an encoded image whose end is an absolute
//! stream offset) and a table of texts (font, string, one vector outline per
//! distinct UTF-16 unit, and a position per character). Offsets passed here are
//! positions in the whole decompressed stream.

use std::sync::Arc;

use styk_doc::{Blob, Value};

use crate::base64;
use crate::ctx::{ObjB, int, list, num, text};
use crate::error::{PyResult, side_table};
use crate::pyfmt::g9_into;
use crate::text::utf16_decode;

/// Outline command letters by opcode.
pub(crate) const COMMAND_NAMES: [&str; 6] = ["M", "L", "C", "Z", "V", "H"];
/// Coordinates each command takes.
pub(crate) const VALUE_COUNTS: [usize; 6] = [2, 2, 6, 0, 1, 1];

/// The transparent 1x1 PNG that stands for an image record without pixels.
pub(crate) const MISSING_IMAGE_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=";

/// Cursor over the stream with this module's own error wording (decimal offsets).
pub(crate) struct TableReader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> TableReader<'a> {
    pub fn new(data: &'a [u8], pos: usize) -> TableReader<'a> {
        TableReader { data, pos }
    }

    fn take(&mut self, count: i128, label: &str) -> PyResult<&'a [u8]> {
        if count < 0 || count > self.data.len() as i128 - self.pos as i128 {
            return Err(side_table(format!("Invalid {} at {}: need {} bytes", label, self.pos, count)));
        }
        let start = self.pos;
        self.pos += count as usize;
        Ok(&self.data[start..self.pos])
    }

    fn u8(&mut self, label: &str) -> PyResult<u8> {
        Ok(self.take(1, label)?[0])
    }

    fn u16(&mut self, label: &str) -> PyResult<u16> {
        let bytes = self.take(2, label)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self, label: &str) -> PyResult<u32> {
        let bytes = self.take(4, label)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// A UTF-16 string with a `u32` unit count: its text and its code units.
    fn string(&mut self, label: &str) -> PyResult<(String, Vec<u16>)> {
        let count = self.u32(&format!("{label}.length"))?;
        let blob = self.take(count as i128 * 2, label)?;
        let units: Vec<u16> = blob.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        Ok((utf16_decode(&units), units))
    }
}

/// One outline command: its opcode and coordinates.
#[derive(Clone, Debug)]
pub(crate) struct Command {
    pub code: usize,
    pub values: Vec<f64>,
}

/// `left, top, right, bottom`.
pub(crate) type Bounds = [f64; 4];

/// Python's `min`: the first of equal values wins (which decides the sign of a zero).
fn first_min(values: impl Iterator<Item = f64>) -> f64 {
    let mut best: Option<f64> = None;
    for value in values {
        if best.is_none_or(|current| value < current) {
            best = Some(value);
        }
    }
    best.unwrap_or(0.0)
}

fn first_max(values: impl Iterator<Item = f64>) -> f64 {
    let mut best: Option<f64> = None;
    for value in values {
        if best.is_none_or(|current| value > current) {
            best = Some(value);
        }
    }
    best.unwrap_or(0.0)
}

/// `format(value, '.9g')` joined by spaces after the command letter.
fn push_command(out: &mut Vec<u8>, name: &str, values: impl Iterator<Item = f64>) {
    out.extend_from_slice(name.as_bytes());
    for (index, value) in values.enumerate() {
        if index > 0 {
            out.push(b' ');
        }
        g9_into(value, out);
    }
}

/// `glyph_svg_path`: the outline as SVG path data, moved by `(x, y)`.
pub(crate) fn glyph_svg_path(commands: &[Command], x: f64, y: f64) -> String {
    let mut out = Vec::new();
    for (index, command) in commands.iter().enumerate() {
        if index > 0 {
            out.push(b' ');
        }
        let name = COMMAND_NAMES[command.code];
        match command.code {
            0..=2 => push_command(&mut out, name, command.values.iter().enumerate().map(|(i, &v)| v + if i % 2 == 0 { x } else { y })),
            5 => push_command(&mut out, name, command.values.iter().take(1).map(|&v| v + x)),
            4 => push_command(&mut out, name, command.values.iter().take(1).map(|&v| v + y)),
            _ => push_command(&mut out, name, command.values.iter().copied()),
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

/// `_path_bounds`: the box of every point an outline names, control points included.
pub(crate) fn path_bounds(commands: &[Command]) -> Option<Bounds> {
    let mut points: Vec<(f64, f64)> = Vec::new();
    let (mut current_x, mut current_y, mut start_x, mut start_y) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for command in commands {
        let values = &command.values;
        match command.code {
            0..=2 => {
                points.extend(values.as_chunks::<2>().0.iter().map(|pair| (pair[0], pair[1])));
                if values.len() >= 2 {
                    current_x = values[values.len() - 2];
                    current_y = values[values.len() - 1];
                }
                if command.code == 0 {
                    start_x = current_x;
                    start_y = current_y;
                }
            }
            5 => {
                current_x = values[0];
                points.push((current_x, current_y));
            }
            4 => {
                current_y = values[0];
                points.push((current_x, current_y));
            }
            _ => {
                current_x = start_x;
                current_y = start_y;
            }
        }
    }
    if points.is_empty() {
        return None;
    }
    Some([
        first_min(points.iter().map(|p| p.0)),
        first_min(points.iter().map(|p| p.1)),
        first_max(points.iter().map(|p| p.0)),
        first_max(points.iter().map(|p| p.1)),
    ])
}

fn f32_round(value: f64) -> f64 {
    value as f32 as f64
}

/// Where one character sits: which outline it uses and its offset.
#[derive(Clone, Debug)]
pub(crate) struct Placement {
    pub glyph_index: usize,
    pub visible: bool,
    pub x: f64,
    pub y: f64,
}

/// `_text_bounds`: `left, top, right, bottom, width, height` of a placed text.
pub(crate) fn text_bounds(glyph_bounds: &[Option<Bounds>], placements: &[Placement]) -> [f64; 6] {
    let boxes: Vec<Bounds> = placements
        .iter()
        .filter_map(|placement| {
            glyph_bounds[placement.glyph_index].map(|b| {
                // Each rectangle translation is persisted to float32 in the loader.
                [f32_round(b[0] + placement.x), f32_round(b[1] + placement.y), f32_round(b[2] + placement.x), f32_round(b[3] + placement.y)]
            })
        })
        .collect();
    let (left, top, right, bottom) = if boxes.is_empty() {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        (first_min(boxes.iter().map(|b| b[0])), first_min(boxes.iter().map(|b| b[1])), first_max(boxes.iter().map(|b| b[2])), first_max(boxes.iter().map(|b| b[3])))
    };
    [left, top, right, bottom, f32_round(right - left), f32_round(bottom - top)]
}

/// `text_svg_path`: every visible character's outline at its position.
pub(crate) fn text_svg_path(glyphs: &[Vec<Command>], placements: &[Placement], dx: f64, dy: f64) -> String {
    let pieces: Vec<String> =
        placements.iter().filter(|p| p.visible).map(|p| glyph_svg_path(&glyphs[p.glyph_index], p.x - dx, p.y - dy)).collect();
    pieces.join(" ")
}

pub(crate) fn bounds_value(bounds: Option<Bounds>) -> Value {
    match bounds {
        None => Value::Null,
        Some(b) => {
            let mut object = ObjB::new();
            object.num("left", b[0]).num("top", b[1]).num("right", b[2]).num("bottom", b[3]);
            object.build()
        }
    }
}

pub(crate) fn text_bounds_value(b: &[f64; 6]) -> Value {
    let mut object = ObjB::new();
    object.num("left", b[0]).num("top", b[1]).num("right", b[2]).num("bottom", b[3]).num("width", b[4]).num("height", b[5]);
    object.build()
}

pub(crate) fn commands_value(commands: &[Command]) -> Value {
    // Glyphs can hold thousands of commands: one shared layout and one string per letter.
    let layout = crate::ctx::shape(&["op", "values"]);
    let names: Vec<Value> = COMMAND_NAMES.iter().map(|name| Value::Str(crate::ctx::key(name))).collect();
    let items = commands
        .iter()
        .map(|command| Value::object(styk_doc::Obj::from_shape(layout.clone(), vec![names[command.code].clone(), Value::nums(&command.values)])))
        .collect();
    Value::Arr(Arc::new(items))
}

struct Glyph {
    node_count: u32,
    commands: Vec<Command>,
    start: usize,
    end: usize,
}

fn read_path(r: &mut TableReader<'_>) -> PyResult<Glyph> {
    let start = r.pos;
    let count = r.u32("glyph.node_count")?;
    // At least one byte per six expanded nodes, even when every command is a cubic.
    if count as u128 > (r.data.len() - r.pos) as u128 * 6 {
        return Err(side_table(format!("Impossible glyph node count {count} at {start}")));
    }
    let mut codes: Vec<usize> = Vec::new();
    let mut expanded: u64 = 0;
    while expanded < count as u64 {
        let packed = r.u8("glyph.opcodes")?;
        for code in [packed & 15, packed >> 4] {
            if code > 5 {
                return Err(side_table(format!("Unknown glyph opcode {} at {}", code, r.pos - 1)));
            }
            codes.push(code as usize);
            expanded += if code == 2 { 3 } else { 1 };
            if expanded >= count as u64 {
                break;
            }
        }
    }
    if expanded != count as u64 {
        return Err(side_table(format!("Cubic crosses glyph node count at {start}")));
    }
    let mut commands = Vec::with_capacity(codes.len());
    for code in codes {
        let n = VALUE_COUNTS[code];
        let mut values = Vec::with_capacity(n);
        if n > 0 {
            let bytes = r.take(n as i128 * 4, "glyph.coordinates")?;
            values.extend(bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c) as f64));
        }
        if !values.iter().all(|v| v.is_finite()) {
            return Err(side_table(format!("Nonfinite glyph coordinate at {}", r.pos)));
        }
        commands.push(Command { code, values });
    }
    Ok(Glyph { node_count: count, commands, start, end: r.pos })
}

/// `_read_text`: one text record as its report dictionary (not yet closed, so
/// the caller can append `segment_ids`).
pub(crate) fn read_text(r: &mut TableReader<'_>, index: usize) -> PyResult<ObjB> {
    let start = r.pos;
    let (font_name, _) = r.string("text.font_name")?;
    let font_style = r.u8("text.font_style")?;
    let alignment = r.u32("text.alignment")?;
    let (content, units) = r.string("text.content")?;
    let glyph_count = r.u8("text.glyph_count")? as usize;
    let mut glyphs = Vec::with_capacity(glyph_count);
    for _ in 0..glyph_count {
        glyphs.push(read_path(r)?);
    }
    let mut unique: Vec<u16> = Vec::new();
    for &unit in &units {
        if !unique.contains(&unit) {
            unique.push(unit);
        }
    }
    if unique.len() != glyph_count {
        return Err(side_table(format!("Text at {} has {} unique UTF-16 code units but {} glyphs", start, unique.len(), glyph_count)));
    }
    let mut placements = Vec::with_capacity(units.len());
    for &unit in &units {
        let glyph_index = unique.iter().position(|&u| u == unit).unwrap_or(0);
        let visible = glyphs[glyph_index].node_count != 0;
        let (x, y) = if visible {
            let bytes = r.take(8, "text.character_offset")?;
            (f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]), f32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]))
        } else {
            (0.0, 0.0)
        };
        if !x.is_finite() || !y.is_finite() {
            return Err(side_table(format!("Nonfinite text placement at {}", r.pos - 8)));
        }
        placements.push((unit, Placement { glyph_index, visible, x: x as f64, y: y as f64 }));
    }
    let glyph_bounds: Vec<Option<Bounds>> = glyphs.iter().map(|g| path_bounds(&g.commands)).collect();
    let glyph_values: Vec<Value> = glyphs
        .iter()
        .zip(&unique)
        .zip(&glyph_bounds)
        .map(|((glyph, &unit), bounds)| {
            let mut object = ObjB::new();
            object.num("node_count", glyph.node_count);
            object.set("commands", commands_value(&glyph.commands));
            object.set("source_start", int(glyph.start));
            object.set("source_end", int(glyph.end));
            object.num("utf16_code_unit", unit);
            object.set("svg_path", text(&glyph_svg_path(&glyph.commands, 0.0, 0.0)));
            object.set("bounds", bounds_value(*bounds));
            object.build()
        })
        .collect();
    let placement_values: Vec<Value> = placements
        .iter()
        .enumerate()
        .map(|(index, (unit, placement))| {
            let mut object = ObjB::new();
            object.set("character_index", int(index));
            object.num("utf16_code_unit", *unit);
            object.set("glyph_index", int(placement.glyph_index));
            object.set("visible", placement.visible);
            object.num("x", placement.x);
            object.num("y", placement.y);
            object.build()
        })
        .collect();
    let commands: Vec<Vec<Command>> = glyphs.into_iter().map(|g| g.commands).collect();
    let placed: Vec<Placement> = placements.into_iter().map(|(_, p)| p).collect();
    let bounds = text_bounds(&glyph_bounds, &placed);
    let mut asset = ObjB::new();
    asset.set("kind", text("text"));
    asset.set("asset_index", int(index));
    asset.set("table_index", int(index));
    asset.set("font_name", text(&font_name));
    asset.num("font_style", font_style);
    asset.set("bold", font_style & 1 != 0);
    asset.set("italic", font_style & 2 != 0);
    asset.set("underline", font_style & 4 != 0);
    asset.set("strikeout", font_style & 8 != 0);
    asset.num("alignment", alignment);
    asset.set("text", text(&content));
    asset.set("glyphs", Value::Arr(Arc::new(glyph_values)));
    asset.set("placements", Value::Arr(Arc::new(placement_values)));
    asset.set("source_start", int(start));
    asset.set("source_end", int(r.pos));
    asset.set("svg_path", text(&text_svg_path(&commands, &placed, 0.0, 0.0)));
    asset.set("bounds", text_bounds_value(&bounds));
    asset.set("normalized_svg_path", text(&text_svg_path(&commands, &placed, bounds[0], bounds[3])));
    asset.set("normalized_origin", text("lower_left"));
    Ok(asset)
}

/// What an encoded image is and how large, from its header (`_image_metadata`).
pub(crate) struct ImageInfo {
    pub mime: &'static str,
    pub extension: &'static str,
    pub size: Option<(f64, f64)>,
}

pub(crate) fn image_metadata(blob: &[u8]) -> ImageInfo {
    if blob.starts_with(b"\x89PNG\r\n\x1a\n") {
        let size = (blob.len() >= 24).then(|| {
            (u32::from_be_bytes([blob[16], blob[17], blob[18], blob[19]]) as f64, u32::from_be_bytes([blob[20], blob[21], blob[22], blob[23]]) as f64)
        });
        return ImageInfo { mime: "image/png", extension: ".png", size };
    }
    if blob.starts_with(b"\xff\xd8") {
        let mut size = None;
        let mut pos = 2;
        while pos + 4 <= blob.len() {
            if blob[pos] != 0xff {
                break;
            }
            while pos < blob.len() && blob[pos] == 0xff {
                pos += 1;
            }
            if pos >= blob.len() {
                break;
            }
            let marker = blob[pos];
            pos += 1;
            if matches!(marker, 0xd8 | 0xd9 | 0x01) || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            if pos + 2 > blob.len() {
                break;
            }
            let length = u16::from_be_bytes([blob[pos], blob[pos + 1]]) as usize;
            if length < 2 || pos + length > blob.len() {
                break;
            }
            if matches!(marker, 0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xc9 | 0xca | 0xcb | 0xcd | 0xce | 0xcf) && length >= 7 {
                let height = u16::from_be_bytes([blob[pos + 3], blob[pos + 4]]) as f64;
                let width = u16::from_be_bytes([blob[pos + 5], blob[pos + 6]]) as f64;
                size = Some((width, height));
                break;
            }
            if marker == 0xda {
                break;
            }
            pos += length;
        }
        return ImageInfo { mime: "image/jpeg", extension: ".jpg", size };
    }
    if blob.starts_with(b"BM") {
        let size = (blob.len() >= 26).then(|| {
            let width = i32::from_le_bytes([blob[18], blob[19], blob[20], blob[21]]) as f64;
            let height = i32::from_le_bytes([blob[22], blob[23], blob[24], blob[25]]) as f64;
            (width, height.abs())
        });
        return ImageInfo { mime: "image/bmp", extension: ".bmp", size };
    }
    if blob.starts_with(b"GIF87a") || blob.starts_with(b"GIF89a") {
        let size = (blob.len() >= 10).then(|| (u16::from_le_bytes([blob[6], blob[7]]) as f64, u16::from_le_bytes([blob[8], blob[9]]) as f64));
        return ImageInfo { mime: "image/gif", extension: ".gif", size };
    }
    ImageInfo { mime: "application/octet-stream", extension: ".bin", size: None }
}

/// Adds the keys `_image_metadata` contributes, in its order.
pub(crate) fn put_image_metadata(asset: &mut ObjB, info: &ImageInfo) {
    asset.set("mime_type", text(info.mime));
    asset.set("extension", text(info.extension));
    if let Some((width, height)) = info.size {
        // JPEG headers give the height first.
        if info.mime == "image/jpeg" {
            asset.num("height", height);
            asset.num("width", width);
        } else {
            asset.num("width", width);
            asset.num("height", height);
        }
    }
}

/// A base64 field over shared raw bytes (`prefix` is empty for `data_base64`).
pub(crate) fn blob(prefix: &str, bytes: &Arc<[u8]>) -> Value {
    Value::Blob(Arc::new(Blob { prefix: Arc::from(prefix), bytes: bytes.clone() }))
}

/// `math.hypot(x, y)` as CPython computes it (its own correctly rounded
/// algorithm, not the C library's), so decoded anchor lengths are the same doubles.
pub(crate) fn py_hypot(x: f64, y: f64) -> f64 {
    let (x, y) = (x.abs(), y.abs());
    let max = if x > y { x } else { y };
    if max.is_infinite() {
        return max;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if max == 0.0 {
        return max;
    }
    let exponent = ((max.to_bits() >> 52) & 0x7ff) as i32;
    if exponent == 0 {
        // Subnormal lengths do not occur for integer anchors.
        return x.hypot(y);
    }
    // frexp: max = m * 2^max_e with m in [0.5, 1).
    let max_e = exponent - 1022;
    // ldexp(1.0, -max_e), which is subnormal for the largest doubles.
    let power = -max_e;
    let scale = if power >= -1022 { f64::from_bits(((power + 1023) as u64) << 52) } else { f64::from_bits(1u64 << (power + 1074)) };
    let (mut csum, mut frac1, mut frac2) = (1.0f64, 0.0f64, 0.0f64);
    for value in [x, y] {
        let v = value * scale;
        let hi = v * v;
        let lo = v.mul_add(v, -hi);
        let sum = csum + hi;
        frac2 += (csum - sum) + hi;
        csum = sum;
        frac1 += lo;
    }
    let mut h = (csum - 1.0 + (frac1 + frac2)).sqrt();
    let hi = -h * h;
    let lo = (-h).mul_add(h, -hi);
    let sum = csum + hi;
    frac2 += (csum - sum) + hi;
    csum = sum;
    frac1 += lo;
    let x = csum - 1.0 + (frac1 + frac2);
    h += x / (2.0 * h);
    h / scale
}

/// `_read_image`: one image record as its report dictionary.
pub(crate) fn read_image(r: &mut TableReader<'_>, index: usize, allow_missing_end: bool) -> PyResult<ObjB> {
    let start = r.pos;
    let anchors = r.take(16, "image.anchor_points")?;
    let word = |at: usize| i32::from_le_bytes([anchors[at], anchors[at + 1], anchors[at + 2], anchors[at + 3]]);
    let (ax, ay, bx, by) = (word(0), word(4), word(8), word(12));
    let pointer = r.pos;
    let end_bytes = r.take(8, "image.absolute_end")?;
    let mut end_word = [0u8; 8];
    end_word.copy_from_slice(end_bytes);
    let mut end = u64::from_le_bytes(end_word) as i128;
    let mut image_start = r.pos;
    let mut recovery: Option<&'static str> = None;
    if end == pointer as i128 {
        // A failed native image save can leave its unpatched end placeholder.
        recovery = Some("unpatched_end");
        end = r.pos as i128;
    } else if allow_missing_end && end > r.data.len() as i128 && r.data.get(pointer..pointer + 2) == Some(&[0, 0]) {
        // The last image of the figure has no payload and no end field: its
        // name follows the anchors directly.
        let size = r.data[pointer + 2] as usize;
        let name = &r.data[(pointer + 3).min(r.data.len())..(pointer + 3 + size).min(r.data.len())];
        if size != 0 && name.len() == size && name.iter().all(|&c| c >= 32 && c != 127) {
            recovery = Some("omitted_end");
            r.pos = pointer;
            image_start = pointer;
            end = pointer as i128;
        }
    }
    let data = r.take(end - r.pos as i128, "image.encoded_data")?;
    let info = image_metadata(data);
    let bytes: Arc<[u8]> = Arc::from(data);
    let (dx, dy) = (bx as f64 - ax as f64, by as f64 - ay as f64);
    let mut asset = ObjB::new();
    asset.set("kind", text("image"));
    asset.set("asset_index", int(index));
    asset.set("table_index", int(index));
    let point = |x: i32, y: i32| {
        let mut object = ObjB::new();
        object.num("x", x).num("y", y);
        object.build()
    };
    asset.set("anchor_start", point(ax, ay));
    asset.set("anchor_end", point(bx, by));
    asset.num("anchor_length", py_hypot(dx, dy));
    asset.num("anchor_angle_rad", dy.atan2(dx));
    asset.set("source_start", int(start));
    asset.set("source_end", num(end as f64));
    asset.set("image_start", int(image_start));
    asset.set("data_base64", blob("", &bytes));
    put_image_metadata(&mut asset, &info);
    if info.mime.starts_with("image/") {
        asset.set("data_url", blob(&format!("data:{};base64,", info.mime), &bytes));
    }
    if data.is_empty() {
        // Absent pixels become a valid transparent image with a provenance flag.
        let pixel: Arc<[u8]> = Arc::from(base64::decode(MISSING_IMAGE_BASE64.as_bytes(), true).unwrap_or_default());
        asset.set("missing_image_data", true);
        asset.set("data_base64", blob("", &pixel));
        asset.set("mime_type", text("image/png"));
        asset.set("extension", text(".png"));
        asset.num("width", 1.0);
        asset.num("height", 1.0);
        asset.set("data_url", blob("data:image/png;base64,", &pixel));
    }
    if let Some(kind) = recovery {
        let mut object = ObjB::new();
        object.set("kind", text(kind));
        object.set("offset", int(pointer));
        asset.set("image_record_recovery", object.build());
    }
    Ok(asset)
}

/// What a segment tells the tables: its primitive, the asset it points at and its joint ID.
pub(crate) struct SegmentRef {
    pub primitive: i64,
    pub reference: i64,
    pub segment_id: i64,
}

/// `parse_side_tables`: the image table, then the text table, each present only
/// when a segment of that kind exists. Returns the assets and the offset after them.
pub(crate) fn parse_side_tables(data: &[u8], pos: usize, segments: &[SegmentRef], allow_missing_image_end: bool) -> PyResult<(Vec<Value>, usize)> {
    let mut r = TableReader::new(data, pos);
    let has = |primitive: i64| segments.iter().any(|s| s.primitive == primitive);
    let mut assets = Vec::new();
    for (primitive, kind) in [(2i64, "image"), (5i64, "text")] {
        if !has(primitive) {
            continue;
        }
        let count = r.u16(&format!("{kind}.table_count"))? as usize;
        let mut table: Vec<ObjB> = Vec::with_capacity(count.min(4096));
        for index in 0..count {
            table.push(if kind == "image" {
                read_image(&mut r, index, allow_missing_image_end && index == count - 1 && !has(5))?
            } else {
                read_text(&mut r, index)?
            });
        }
        let mut users: Vec<Vec<Value>> = vec![Vec::new(); count];
        for segment in segments.iter().filter(|s| s.primitive == primitive) {
            if segment.reference >= count as i64 || segment.reference < 0 {
                return Err(side_table(format!("{} segment refers to asset {}, table has {}", kind, segment.reference, count)));
            }
            users[segment.reference as usize].push(num(segment.segment_id as f64));
        }
        for (mut asset, ids) in table.into_iter().zip(users) {
            if !ids.is_empty() {
                asset.set("segment_ids", list(ids));
            }
            assets.push(asset.build());
        }
    }
    Ok((assets, r.pos))
}
