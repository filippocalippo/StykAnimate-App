//! Pivot 2 and 3 projects (`piv_legacy_v2.py`).
//!
//! Version 2 stores neither timing nor object identities: Pivot plays it at
//! 13 frames per second and every occurrence of a figure gets a new ID. Version 3
//! adds frame holds, a background table and a trailing frame interval in
//! milliseconds. Holds repeat a pose; they are not tweened.

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::ctx::{Ctx, ObjB, empty_list, int, list, num, text};
use crate::error::{PyResult, value_error};
use crate::piv::legacy::{LegacyParts, data_url_default, normalize_sprite, png_from_rows};
use crate::piv::side_tables::blob;
use crate::text::cp1252_decode;

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    /// Fields the Python reader bound for its scalar editor (only their number is reported).
    bindings: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: i128) -> PyResult<&'a [u8]> {
        if count < 0 || self.pos as i128 + count > self.data.len() as i128 {
            return Err(value_error(format!("Unexpected EOF at {}, need {} bytes", self.pos, count)));
        }
        let start = self.pos;
        self.pos += count as usize;
        Ok(&self.data[start..self.pos])
    }

    fn u8(&mut self) -> PyResult<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> PyResult<u16> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> PyResult<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> PyResult<u64> {
        let bytes = self.take(8)?;
        let mut word = [0u8; 8];
        word.copy_from_slice(bytes);
        Ok(u64::from_le_bytes(word))
    }

    fn f32(&mut self) -> PyResult<f32> {
        let at = self.pos;
        let value = f32::from_bits(self.u32()?);
        if !value.is_finite() {
            return Err(value_error(format!("Non-finite f at {at}")));
        }
        Ok(value)
    }

    fn f64(&mut self) -> PyResult<f64> {
        let at = self.pos;
        let value = f64::from_bits(self.u64()?);
        if !value.is_finite() {
            return Err(value_error(format!("Non-finite d at {at}")));
        }
        Ok(value)
    }

    fn str8(&mut self) -> PyResult<String> {
        let length = self.u8()?;
        Ok(cp1252_decode(self.take(length as i128)?))
    }
}

/// `_asset`: the shared tail of every image record (`kind`, `name`, `mime_type`, `data_uri`).
fn finish_asset(asset: &mut ObjB, kind: &'static str, name: &str, data: Vec<u8>) {
    let mime = match kind {
        "png" => "image/png",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    };
    asset.set("kind", text(kind));
    asset.set("name", text(name));
    asset.set("mime_type", text(mime));
    asset.set("data_uri", blob(&format!("data:{mime};base64,"), &Arc::from(data)));
}

fn point(x: f64, y: f64) -> Value {
    let mut object = ObjB::new();
    object.num("x", x).num("y", y);
    object.build()
}

/// `_compact_bitmap`: column-major pixels, an 8-bit palette or 24-bit BGR, as a keyed PNG.
fn compact_bitmap(r: &mut Reader<'_>, name: &str) -> PyResult<ObjB> {
    let start = r.pos;
    let mode = r.u8()?;
    let (width, height, key) = (r.u16()? as usize, r.u16()? as usize, r.u32()?);
    if !(0 < width && width <= 32767) || !(0 < height && height <= 32767) {
        return Err(value_error(format!("Invalid compact bitmap dimensions at {start}")));
    }
    let indexed = mode == 3;
    let pixels = r.take((width * height * if indexed { 1 } else { 3 }) as i128)?;
    let palette = if indexed { r.take(1024)? } else { &[][..] };
    let transparent = [(key & 255) as u8, ((key >> 8) & 255) as u8, ((key >> 16) & 255) as u8];
    let mut rows = vec![0u8; height * (width * 4 + 1)];
    for x in 0..width {
        for y in 0..height {
            let source = x * height + y;
            let rgb = if indexed {
                let p = pixels[source] as usize * 4;
                [palette[p], palette[p + 1], palette[p + 2]]
            } else {
                let p = source * 3;
                [pixels[p + 2], pixels[p + 1], pixels[p]]
            };
            let target = y * (width * 4 + 1) + 1 + x * 4;
            rows[target..target + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], if rgb == transparent { 0 } else { 255 }]);
        }
    }
    let mut asset = ObjB::new();
    asset.set("width", int(width));
    asset.set("height", int(height));
    asset.set("record_offset", int(start));
    asset.set("record_size", int(r.pos - start));
    asset.num("legacy_pixel_mode", mode);
    asset.num("transparency_color_raw", key);
    asset.set("pixel_layout", text("column_major"));
    asset.set("pivot", point(0.0, height as f64));
    asset.set("endpoint", point(width as f64, height as f64));
    finish_asset(&mut asset, "png", name, png_from_rows(width as u32, height as u32, &rows));
    Ok(asset)
}

/// `_bmp`: a Windows bitmap with its own size field.
fn bmp(r: &mut Reader<'_>, name: &str) -> PyResult<ObjB> {
    let start = r.pos;
    if r.take(2)? != b"BM" {
        return Err(value_error(format!("Expected BMP signature at {start}")));
    }
    let size = r.u32()?;
    if size < 26 {
        return Err(value_error(format!("Invalid BMP size at {start}")));
    }
    let rest = r.take(size as i128 - 6)?;
    let mut data = Vec::with_capacity(size as usize);
    data.extend_from_slice(b"BM");
    data.extend_from_slice(&size.to_le_bytes());
    data.extend_from_slice(rest);
    let dib_size = u32::from_le_bytes([data[14], data[15], data[16], data[17]]);
    let (width, height): (i64, i64) = if dib_size == 12 {
        (u16::from_le_bytes([data[18], data[19]]) as i64, u16::from_le_bytes([data[20], data[21]]) as i64)
    } else if dib_size >= 40 && size >= 54 {
        (i32::from_le_bytes([data[18], data[19], data[20], data[21]]) as i64, i32::from_le_bytes([data[22], data[23], data[24], data[25]]) as i64)
    } else {
        return Err(value_error(format!("Unsupported BMP DIB at {start}")));
    };
    if width <= 0 || height == 0 {
        return Err(value_error(format!("Unsupported BMP DIB at {start}")));
    }
    let mut asset = ObjB::new();
    asset.num("width", width as f64);
    asset.num("height", height.abs() as f64);
    asset.set("record_offset", int(start));
    asset.num("record_size", size);
    finish_asset(&mut asset, "bmp", name, data);
    Ok(asset)
}

/// `_jpeg`: a JPEG between the record's start and its absolute end pointer.
fn jpeg(r: &mut Reader<'_>, name: &str) -> PyResult<ObjB> {
    let start = r.pos;
    let end = r.u64()?;
    if end <= r.pos as u64 {
        return Err(value_error(format!("Invalid absolute JPEG end pointer at {start}")));
    }
    let data = r.take(end as i128 - r.pos as i128)?;
    if !data.starts_with(b"\xff\xd8") || !data.ends_with(b"\xff\xd9") {
        return Err(value_error(format!("Invalid JPEG boundaries at {start}")));
    }
    let mut asset = ObjB::new();
    asset.set("width", Value::Null);
    asset.set("height", Value::Null);
    asset.set("record_offset", int(start));
    asset.set("record_size", int(r.pos - start));
    finish_asset(&mut asset, "jpeg", name, data.to_vec());
    Ok(asset)
}

/// One 24-byte segment record as the legacy reader reports it.
pub(crate) struct OldSegment {
    pub id: u8,
    pub parent: u8,
    pub primitive: u8,
    pub is_static: bool,
    pub value: ObjB,
}

/// `_segment`: parent, joint ID, length, angle, thickness, primitive and the
/// static flag (record byte 21); bytes 2-3 and 22-23 are padding.
pub(crate) fn segment(data: &[u8], pos: &mut usize, index: usize, bindings: &mut usize, bind: bool) -> PyResult<OldSegment> {
    let mut r = Reader { data, pos: *pos, bindings: 0 };
    let start = r.pos;
    let parent = r.u8()?;
    let id = r.u8()?;
    let ignored = r.u16()?;
    let length = r.f32()?;
    let angle = r.f64()?;
    let thickness = r.f32()?;
    let primitive = r.u8()?;
    let is_static = r.u8()?;
    let padding = r.u16()?;
    *pos = r.pos;
    if bind {
        *bindings += 7;
    }
    if !matches!(primitive, 0 | 1 | 2 | 3 | 4 | 6) {
        return Err(value_error(format!("Unsupported old primitive {} at {}", primitive, start + 20)));
    }
    if is_static > 1 {
        return Err(value_error(format!("Invalid static Boolean at {}", start + 21)));
    }
    let kind = ["line", "circle", "image", "circleFill", "circleClear", "", "squareLine"][primitive as usize];
    let segment_type = match primitive {
        1 | 3 | 4 => "circle",
        2 => "image",
        _ => "line",
    };
    let flags = ((is_static as u32) << 8) | primitive as u32;
    let circle = matches!(primitive, 1 | 3 | 4);
    let mut flag_bits = ObjB::new();
    flag_bits.set("is_static", is_static != 0);
    flag_bits.set("is_circle", circle);
    flag_bits.num("raw", flags);
    flag_bits.num("low_byte", primitive);
    flag_bits.num("high_byte", is_static);
    let mut value = ObjB::new();
    value.set("segment_order_index", int(index));
    value.num("segment_id", id);
    value.num("parent_id", parent);
    value.num("length", length);
    value.num("angle_rad", angle);
    value.num("thickness", thickness);
    value.num("primitive_code", primitive);
    value.set("segment_type", text(segment_type));
    value.set("segment_kind", text(kind));
    value.num("static_raw", is_static);
    value.set("is_static", is_static != 0);
    value.num("flags", flags);
    value.set("flag_bits", flag_bits.build());
    value.set("color_rgb", Value::nums(&[0.0, 0.0, 0.0]));
    value.num("color_alpha", 1.0);
    value.num("transparency", 0.0);
    value.num("bend_rad", 0.0);
    value.set("visible", matches!(primitive, 1..=4) || thickness as f64 > 0.01);
    value.set("valid", true);
    value.set("z_order", int(index + 1));
    value.set("source_layout", text("legacy_24_native"));
    value.num("legacy_ignored_word", ignored);
    value.num("legacy_padding_word", padding);
    value.set("record_offset", int(start));
    value.num("record_size", 24.0);
    Ok(OldSegment { id, parent, primitive, is_static: is_static != 0, value })
}

struct Figure {
    id: usize,
    count: usize,
    has_images: bool,
    value: Value,
}

/// `_figure`: segments, then (when a segment is a sprite) the bitmaps, then the name.
fn figure(r: &mut Reader<'_>, type_id: usize, builtin: Option<&str>) -> PyResult<Figure> {
    let start = r.pos;
    let count = r.u8()? as usize;
    if count == 0 {
        return Err(value_error(format!("Empty old figure at {start}")));
    }
    let mut segments = Vec::with_capacity(count);
    let mut has_images = false;
    for index in 0..count {
        let mut pos = r.pos;
        let mut bound = 0;
        let mut seg = segment(r.data, &mut pos, index, &mut bound, builtin.is_none())?;
        r.pos = pos;
        r.bindings += bound;
        let mut asset_index = None;
        if seg.primitive == 2 {
            has_images = true;
            let index = r.u8()?;
            asset_index = Some(index);
            seg.value.num("image_asset_index", index);
            seg.value.num("sprite_index", index);
            // Compressed version 2/3 files omit the image flip byte.
            seg.value.num("image_flip", 0.0);
            seg.value.num("sprite_flip", 0.0);
        }
        segments.push((seg, asset_index));
    }
    let mut images: Vec<Value> = Vec::new();
    if has_images {
        let image_count = r.u8()? as usize;
        for image_index in 0..image_count {
            let mut image = compact_bitmap(r, &format!("figure_{type_id}_sprite_{image_index}.png"))?;
            image.set("image_index", int(image_index));
            image.set("sprite_index", int(image_index));
            let mut image: Obj = image.build_obj();
            normalize_sprite(&mut image)?;
            images.push(Value::object(image));
        }
        if segments.iter().any(|(_, index)| index.is_some_and(|index| index as usize >= image_count)) {
            return Err(value_error(format!("Invalid sprite index in figure {type_id}")));
        }
    }
    let mut seen = [false; 256];
    let mut distinct = true;
    for (seg, _) in &segments {
        distinct &= !std::mem::replace(&mut seen[seg.id as usize], true);
    }
    if !distinct || seen[0] {
        return Err(value_error(format!("Duplicate/root segment IDs in figure {type_id}")));
    }
    let mut parent_of = [0u8; 256];
    for (seg, _) in &segments {
        parent_of[seg.id as usize] = seg.parent;
    }
    for (seg, _) in &segments {
        let mut visited = [false; 256];
        visited[seg.id as usize] = true;
        let mut parent = seg.parent;
        while parent != 0 {
            if !seen[parent as usize] || visited[parent as usize] {
                return Err(value_error(format!("Invalid/cyclic parent graph in figure {type_id}")));
            }
            visited[parent as usize] = true;
            parent = parent_of[parent as usize];
        }
    }
    let name = match builtin {
        Some(name) => name.to_string(),
        None => r.str8()?,
    };
    let segment_values: Vec<Value> = segments
        .into_iter()
        .map(|(mut seg, asset_index)| {
            if builtin.is_some() {
                // These records belong to a separate figure file, so they have no offset here.
                seg.value.set("record_offset", Value::Null);
            }
            if let Some(index) = asset_index {
                // The modern field names of the sprite reference.
                seg.value.num("extra_u16", index);
                seg.value.num("extra_u8_a", 0.0);
                seg.value.num("extra_u8_b", 0.0);
            }
            seg.value.build()
        })
        .collect();
    let mut value = ObjB::new();
    value.set("figure_type_id", int(type_id));
    value.set("name", text(&name));
    value.set("segment_count", int(count));
    value.set("segments", Value::Arr(Arc::new(segment_values)));
    value.set("polyfills", empty_list());
    value.set("bends", empty_list());
    value.set("text_assets", empty_list());
    value.set("image_assets", if images.is_empty() { empty_list() } else { Value::Arr(Arc::new(images)) });
    value.set("has_side_table", has_images);
    value.set("z_order_mode", text("record_order"));
    value.set("record_offset", if builtin.is_some() { Value::Null } else { int(start) });
    value.set("record_size", if builtin.is_some() { int(0) } else { int(r.pos - start) });
    value.set("builtin", builtin.is_some());
    Ok(Figure { id: type_id, count, has_images, value: value.build() })
}

/// The 24-byte records of the implicit figure in slot 1.
fn builtin_records(version: u8) -> Vec<u8> {
    if version == 2 {
        // `default_pivot2.stk`, which Pivot substitutes for slot 1 of a version 2 file.
        const HEX: &str = concat!(
            "0a0001000000007042d221337f7cd912400000e04000000000",
            "0102000000001042d221337f7cd912400000e04001000000",
            "0103000000002042d221337f7cd902400000e04000000000",
            "0104000000002042182d4454fb21e93f0000e04000000000",
            "030500000000204266732d3852c100400000e04000000000",
            "040600000000204266732d3852c1f03f0000e04000000000",
            "00070000000048425e3855297a6aff3f0000e04000000000",
            "0008000000004842d221337f7cd9f23f0000e04000000000",
            "07090000000048425e3855297a6aff3f0000e04000000000",
            "080a000000004842d221337f7cd9f23f0000e04000000000"
        );
        return (0..HEX.len() / 2).map(|i| u8::from_str_radix(&HEX[i * 2..i * 2 + 2], 16).unwrap_or(0)).collect();
    }
    builtin_man_records()
}

/// The implicit twelve-segment figure of versions 3 to 5, as legacy records.
pub(crate) fn builtin_man_records() -> Vec<u8> {
    // The exact doubles Pivot uses, digit for digit: not approximations of fractions of pi.
    #[allow(clippy::approx_constant)]
    const VALUES: [(u8, f32, f64, f32, u8, u8); 12] = [
        (0, 32., -1.5707963267948968, 14., 0, 0),
        (1, 32., -1.5707963267948968, 14., 0, 0),
        (2, 33., -1.5707963267948968, 14., 0, 0),
        (3, 20., 1.5707963267948966, 20., 1, 1),
        (2, 38., 2.356194490192345, 14., 0, 0),
        (2, 38., 0.7853981633974483, 14., 0, 0),
        (5, 40., 2.0943951023931957, 14., 0, 0),
        (6, 40., 1.0471975511965979, 14., 0, 0),
        (0, 50., 1.9634954084936207, 14., 0, 0),
        (0, 50., 1.1780972450961724, 14., 0, 0),
        (9, 50., 1.9634954084936207, 14., 0, 0),
        (10, 50., 1.1780972450961724, 14., 0, 0),
    ];
    let mut out = vec![VALUES.len() as u8];
    for (index, (parent, length, angle, thickness, primitive, is_static)) in VALUES.iter().enumerate() {
        out.extend_from_slice(&[*parent, index as u8 + 1, 0, 0]);
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&angle.to_le_bytes());
        out.extend_from_slice(&thickness.to_le_bytes());
        out.extend_from_slice(&[*primitive, *is_static, 0, 0]);
    }
    out
}

/// `decode_v2`: a decompressed version 2 or 3 payload. Unconsumed bytes are an error.
pub(crate) fn decode_v2(ctx: &Ctx<'_>, data: &[u8], source_path: &str) -> PyResult<LegacyParts> {
    let mut r = Reader { data, pos: 0, bindings: 0 };
    let version = r.u8()?;
    if !matches!(version, 2 | 3) {
        return Err(value_error(format!("Expected legacy PIV version 2/3, found {version}")));
    }
    let has_background = if version == 2 { Some(r.u8()?) } else { None };
    if has_background.is_some_and(|flag| flag > 1) {
        return Err(value_error("Invalid v2 background Boolean"));
    }
    let width = r.u32()?;
    let height = r.u32()?;
    r.bindings += 2;
    if width == 0 || height == 0 {
        return Err(value_error("Canvas dimensions must be positive"));
    }
    let mut backgrounds: Vec<Value> = Vec::new();
    let background = |asset: ObjB, id: usize, name: &str, legacy_kind: Option<u8>| {
        let copy = asset.snapshot();
        let mut item = asset;
        item.set("background_id", int(id));
        item.set("name", text(name));
        if let Some(kind) = legacy_kind {
            item.num("legacy_kind", kind);
        }
        item.set("image_assets", list(vec![copy]));
        let mut item: Obj = item.build_obj();
        data_url_default(&mut item);
        Value::object(item)
    };
    if has_background == Some(1) {
        let marker = r.u8()?;
        if marker != 0 {
            return Err(value_error(format!("Unsupported v2 background marker {marker}")));
        }
        let asset = bmp(&mut r, "background_1.bmp")?;
        backgrounds.push(background(asset, 1, "Background", None));
    }
    if version == 3 {
        let slots = r.u8()? as usize;
        if slots == 0 {
            return Err(value_error("Background table must include default slot 0"));
        }
        for id in 1..slots {
            let kind = r.u8()?;
            let asset = match kind {
                0 => bmp(&mut r, &format!("background_{id}.bmp"))?,
                1 => jpeg(&mut r, &format!("background_{id}.jpg"))?,
                _ => return Err(value_error(format!("Unsupported v3 background kind {kind}"))),
            };
            let name = r.str8()?;
            backgrounds.push(background(asset, id, &name, Some(kind)));
        }
    }
    let figure_slots = r.u8()? as usize;
    if figure_slots < 2 {
        return Err(value_error("Invalid legacy figure slot count"));
    }
    let records = builtin_records(version);
    let mut builtin_reader = Reader { data: &records, pos: 0, bindings: 0 };
    let builtin = figure(&mut builtin_reader, 1, Some(if version == 2 { "default_pivot2" } else { "Default" }))?;
    if builtin_reader.pos != records.len() {
        return Err(value_error("Unexpected trailing bytes in built-in figure definition"));
    }
    let mut figures = vec![builtin];
    for type_id in 2..figure_slots {
        figures.push(figure(&mut r, type_id, None)?);
    }
    let frame_start = r.pos;
    let frame_count = r.u32()? as usize;
    if frame_count > data.len() - r.pos {
        return Err(value_error("Frame count exceeds remaining payload"));
    }
    let mut frames = Vec::with_capacity(frame_count);
    let mut unique_id = 0usize;
    let mut total_frames = 0f64;
    for fi in 0..frame_count {
        ctx.checkpoint()?;
        let duration = if version == 3 {
            r.bindings += 1;
            r.u16()?
        } else {
            1
        };
        let background = if version == 3 {
            r.bindings += 1;
            r.u8()? as usize
        } else {
            (has_background == Some(1)) as usize
        };
        if background > backgrounds.len() {
            return Err(value_error(format!("Unknown background {background} at frame {fi}")));
        }
        let object_count = r.u8()? as usize;
        let mut objects = Vec::with_capacity(object_count);
        for oi in 0..object_count {
            let offset = r.pos;
            let type_id = r.u8()? as usize;
            let Some(figure) = figures.iter().find(|figure| figure.id == type_id) else {
                return Err(value_error(format!("Unsupported/unknown figure type {type_id} at {offset}")));
            };
            let scale = r.f32()?;
            let raw_color = r.u32()?;
            r.bindings += 2;
            // An instance mirror flag, present only for figures that carry sprites.
            let flags = if figure.has_images {
                r.bindings += 1;
                Some(r.u8()?)
            } else {
                None
            };
            let mut angles = Vec::with_capacity(figure.count);
            for _ in 0..figure.count {
                angles.push(r.f64()?);
            }
            r.bindings += figure.count;
            if angles.iter().any(|angle| angle.abs() > 100.0) {
                return Err(value_error(format!("Unsupported legacy angle-reset sentinel at frame {fi}, object {oi}")));
            }
            let (root_x, root_y) = (r.f32()?, r.f32()?);
            r.bindings += 2;
            unique_id += 1;
            let color = if raw_color < 0x8000_0000 { raw_color } else { 0 };
            let mut object = ObjB::new();
            object.set("object_slot", int(oi));
            object.set("unique_id", int(unique_id));
            object.set("unique_id_source", text("generated_occurrence"));
            object.set("figure_type_id", int(type_id));
            object.num("scale", scale);
            object.num("color_override_raw", raw_color);
            object.set("color_override_rgb", Value::nums(&[(color & 255) as f64, ((color >> 8) & 255) as f64, ((color >> 16) & 255) as f64]));
            object.num("color_override_alpha", 1.0);
            object.num("field28", 0.0);
            object.set("angles", Value::nums(&angles));
            object.num("root_x", root_x);
            object.num("root_y", root_y);
            object.num("len_flag", 0.0);
            object.set("lengths", empty_list());
            object.num("bend_flag", 0.0);
            object.set("bends", empty_list());
            object.set("join", Value::Null);
            object.set("runtime_segments", empty_list());
            object.set("record_offset", int(offset));
            object.set("record_size", int(r.pos - offset));
            if let Some(flags) = flags {
                object.num("image_text_flags", flags);
            }
            objects.push(object.build());
        }
        let mut camera = ObjB::new();
        camera.set("is_default", true);
        camera.num("x", 0.0).num("y", 0.0).num("scale", 1.0);
        let hold = duration.max(1);
        total_frames += hold as f64;
        let order: Vec<f64> = (0..object_count).map(|slot| slot as f64).collect();
        let mut frame = ObjB::new();
        frame.set("keyframe_index", int(fi));
        frame.num("duration_raw", duration);
        frame.num("duration_frames", hold);
        frame.set("interpolation", text("hold"));
        frame.num("inbetweens", 0.0);
        frame.set("duration_semantics", text("hold"));
        frame.num("background_mix", 0.0);
        frame.set("background_id", int(background));
        frame.set("background_id_b", Value::Null);
        frame.set("objects", if objects.is_empty() { empty_list() } else { Value::Arr(Arc::new(objects)) });
        frame.set("object_draw_order", Value::nums(&order));
        frame.set("camera", camera.build());
        frames.push(frame.build());
    }
    let frame_interval = if version == 3 {
        r.bindings += 1;
        Some(r.u32()?)
    } else {
        None
    };
    if frame_interval == Some(0) {
        return Err(value_error("Zero legacy frame interval"));
    }
    let fps = match frame_interval {
        Some(interval) => crate::pyfmt::py_round(1000.0 / interval as f64).max(1.0),
        None => 13.0,
    };
    let mut tail = None;
    if version == 3 && data.len() - r.pos == 1 {
        r.bindings += 1;
        let flag = r.u8()?;
        if flag > 1 {
            return Err(value_error("Invalid optional legacy trailing Boolean"));
        }
        tail = Some(flag);
    }
    if r.pos != data.len() {
        return Err(value_error(format!("Unexpected trailing bytes at {}: {}", r.pos, data.len() - r.pos)));
    }
    let mut validation = ObjB::new();
    validation.set("exact_consumption", true);
    validation.set("consumed_bytes", int(r.pos));
    validation.set("frame_start", int(frame_start));
    validation.set("object_count", int(unique_id));
    let timing = "v2/v3 do not store stable cross-frame object identities.";
    let limitations = if version == 3 { vec![text(timing)] } else { vec![text("v2 stores no frame rate; Pivot loads these projects at 13 FPS."), text(timing)] };
    let notes = vec![
        text("All record boundaries follow native compatibility grammar."),
        text("Old static flag is record byte 21; bytes 2/3 are ignored padding."),
        text("Frame durations repeat a pose without interpolation."),
    ];
    let mut report = ObjB::new();
    report.set("source_path", text(source_path));
    report.set("payload_size", int(data.len()));
    report.set("file_type", text("piv"));
    report.set("format", text(&format!("piv_v{version}_legacy_exact")));
    report.num("version", version);
    report.set("decode_status", text("decoded"));
    report.set("trace_assisted", false);
    report.num("canvas_width", width);
    report.num("canvas_height", height);
    report.set("backgrounds", if backgrounds.is_empty() { empty_list() } else { Value::Arr(Arc::new(backgrounds)) });
    report.set("figure_types", Value::Arr(Arc::new(figures.into_iter().map(|figure| figure.value).collect())));
    report.set("keyframes", if frames.is_empty() { empty_list() } else { Value::Arr(Arc::new(frames)) });
    report.num("fps", fps);
    report.set("frame_delay_ms", frame_interval.map(num).unwrap_or(Value::Null));
    report.set("legacy_tail_flag", tail.map(num).unwrap_or(Value::Null));
    report.set("fps_source", text(if version == 3 { "stored_millisecond_interval" } else { "native_legacy_default" }));
    report.set("trailing_bytes_hex", text(""));
    report.set("supports_viewer", true);
    report.set("validation", Value::Null);
    report.set("limitations", Value::Arr(Arc::new(limitations)));
    report.set("notes", Value::Arr(Arc::new(notes)));
    Ok(LegacyParts { report, validation, width, height, fps, bindings: r.bindings, total_frames })
}
