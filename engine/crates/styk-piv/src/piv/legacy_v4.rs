//! Pivot 4 projects (`piv_legacy_v4.py`).
//!
//! Version 4 keeps the 24-byte segment records of versions 2 and 3 and adds
//! stable object IDs, per-object lengths and transparency, joins between
//! objects, a draw order per frame, and BMP sprites with a colour key.

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::ctx::{Ctx, ObjB, empty_list, int, num, text};
use crate::error::{PyResult, value_error};
use crate::piv::image_stream::jpeg_end;
use crate::piv::legacy::{LegacyParts, data_url_default, normalize_sprite};
use crate::piv::legacy_v2::builtin_man_records;
use crate::piv::side_tables::blob;
use crate::text::latin1_decode;

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    bindings: usize,
}

impl<'a> Reader<'a> {
    fn read(&mut self, size: i128) -> PyResult<&'a [u8]> {
        if size < 0 || self.pos as i128 + size > self.data.len() as i128 {
            return Err(value_error(format!("Truncated Pivot 4 payload at byte {}: need {} bytes", self.pos, size)));
        }
        let start = self.pos;
        self.pos += size as usize;
        Ok(&self.data[start..self.pos])
    }

    fn u8(&mut self) -> PyResult<u8> {
        Ok(self.read(1)?[0])
    }

    fn u16(&mut self) -> PyResult<u16> {
        let bytes = self.read(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> PyResult<u32> {
        let bytes = self.read(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> PyResult<u64> {
        let bytes = self.read(8)?;
        let mut word = [0u8; 8];
        word.copy_from_slice(bytes);
        Ok(u64::from_le_bytes(word))
    }

    /// A finite `f32`; `what` is the field's path, or `f` where the Python reader gave none.
    fn f32(&mut self, what: std::fmt::Arguments<'_>) -> PyResult<f32> {
        let start = self.pos;
        let value = f32::from_bits(self.u32()?);
        if !value.is_finite() {
            return Err(value_error(format!("Non-finite {what} at byte {start}")));
        }
        Ok(value)
    }

    fn f64(&mut self, what: std::fmt::Arguments<'_>) -> PyResult<f64> {
        let start = self.pos;
        let value = f64::from_bits(self.u64()?);
        if !value.is_finite() {
            return Err(value_error(format!("Non-finite {what} at byte {start}")));
        }
        Ok(value)
    }

    /// `Reader.values`: `count` consecutive floats of `size` bytes, bound as `prefix/i`.
    fn floats(&mut self, count: usize, size: usize, prefix: std::fmt::Arguments<'_>) -> PyResult<Vec<f64>> {
        let mut out = Vec::with_capacity(count);
        if self.pos + size * count > self.data.len() {
            // The per-value path reports exactly where a truncated list ends.
            for index in 0..count {
                let start = self.pos;
                let value = if size == 8 { f64::from_bits(self.u64()?) } else { f32::from_bits(self.u32()?) as f64 };
                if !value.is_finite() {
                    return Err(value_error(format!("Non-finite {prefix}/{index} at byte {start}")));
                }
                out.push(value);
            }
            return Ok(out);
        }
        let start = self.pos;
        for (index, chunk) in self.data[start..start + size * count].chunks_exact(size).enumerate() {
            let value = if size == 8 {
                let mut word = [0u8; 8];
                word.copy_from_slice(chunk);
                f64::from_le_bytes(word)
            } else {
                f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64
            };
            if !value.is_finite() {
                return Err(value_error(format!("Non-finite {}/{} at byte {}", prefix, index, start + index * size)));
            }
            out.push(value);
        }
        self.pos += size * count;
        self.bindings += count;
        Ok(out)
    }

    fn string(&mut self) -> PyResult<String> {
        let length = self.u8()?;
        Ok(latin1_decode(self.read(length as i128)?))
    }
}

/// `_image`: a BMP with its own size field, or a JPEG up to an absolute end pointer.
fn image(reader: &mut Reader<'_>, jpeg: bool) -> PyResult<(ObjB, Value, Value)> {
    let start = reader.pos;
    let (mime, data, width, height): (&str, Vec<u8>, Value, Value) = if !jpeg {
        if reader.data.get(start..start + 2) != Some(b"BM") {
            return Err(value_error(format!("Expected BMP header at byte {start}")));
        }
        if start + 26 > reader.data.len() {
            return Err(value_error(format!("Truncated BMP at byte {start}")));
        }
        let size = u32::from_le_bytes([reader.data[start + 2], reader.data[start + 3], reader.data[start + 4], reader.data[start + 5]]);
        if size < 26 {
            return Err(value_error(format!("Invalid BMP size {size} at byte {start}")));
        }
        let data = reader.read(size as i128)?;
        let dib_size = u32::from_le_bytes([data[14], data[15], data[16], data[17]]);
        let (width, height): (i64, i64) = if dib_size == 12 {
            (u16::from_le_bytes([data[18], data[19]]) as i64, u16::from_le_bytes([data[20], data[21]]) as i64)
        } else if dib_size >= 40 && size >= 54 {
            (i32::from_le_bytes([data[18], data[19], data[20], data[21]]) as i64, (i32::from_le_bytes([data[22], data[23], data[24], data[25]]) as i64).abs())
        } else {
            return Err(value_error(format!("Unsupported BMP DIB header size {dib_size}")));
        };
        if width <= 0 || height <= 0 {
            return Err(value_error(format!("Invalid BMP dimensions {width}x{height}")));
        }
        ("image/bmp", data.to_vec(), Value::Num(width as f64), Value::Num(height as f64))
    } else {
        // The end pointer is absolute within the uncompressed stream.
        let end = reader.u64()?;
        if end <= reader.pos as u64 {
            return Err(value_error(format!("Invalid JPEG end pointer {end} at byte {start}")));
        }
        // Pivot decodes the first image, then seeks to the declared end: keep the
        // record's extent, but only the image itself is media.
        let image_end = jpeg_end(reader.data, reader.pos, end)?;
        let data = reader.data[reader.pos..image_end].to_vec();
        reader.pos = end as usize;
        ("image/jpeg", data, Value::Null, Value::Null)
    };
    let mut asset = ObjB::new();
    asset.set("kind", text(if jpeg { "jpeg" } else { "bmp" }));
    asset.set("mime_type", text(mime));
    asset.set("width", width.clone());
    asset.set("height", height.clone());
    asset.set("data_uri", blob(&format!("data:{mime};base64,"), &Arc::from(data)));
    asset.set("source_offset", int(start));
    asset.set("source_size", int(reader.pos - start));
    Ok((asset, width, height))
}

struct Figure {
    id: usize,
    count: usize,
    has_images: bool,
    value: Value,
}

fn figure(reader: &mut Reader<'_>, figure_id: usize, index: usize, builtin: bool) -> PyResult<Figure> {
    let start = reader.pos;
    let count = reader.u8()? as usize;
    if count == 0 {
        return Err(value_error(format!("Zero-segment figure {figure_id} at byte {start}")));
    }
    let mut segments: Vec<ObjB> = Vec::with_capacity(count);
    let mut links: Vec<(u8, u8)> = Vec::with_capacity(count);
    let mut sprite_refs: Vec<u8> = Vec::new();
    for order in 0..count {
        let pos = reader.pos;
        let parent = reader.u8()?;
        let segment_id = reader.u8()?;
        let unused_flags = reader.u16()?;
        let length = match builtin {
            true => reader.f32(format_args!("f"))?,
            false => reader.f32(format_args!("/figure_types/{index}/segments/{order}/length"))?,
        };
        let angle = match builtin {
            true => reader.f64(format_args!("d"))?,
            false => reader.f64(format_args!("/figure_types/{index}/segments/{order}/angle_rad"))?,
        };
        let thickness = match builtin {
            true => reader.f32(format_args!("f"))?,
            false => reader.f32(format_args!("/figure_types/{index}/segments/{order}/thickness"))?,
        };
        let primitive = reader.u8()?;
        let is_static = reader.u8()?;
        let reserved = reader.u16()?;
        if !matches!(primitive, 0 | 1 | 2 | 3 | 4 | 6) {
            return Err(value_error(format!("Unsupported legacy primitive {} at byte {}", primitive, pos + 20)));
        }
        if segment_id == 0 || segment_id as usize > count || parent as usize > count {
            return Err(value_error(format!("Invalid topology in figure {figure_id} at segment {order}")));
        }
        let kind = ["line", "circle", "image", "circleFill", "circleClear", "", "squareLine"][primitive as usize];
        let segment_type = match primitive {
            1 | 3 | 4 => "circle",
            2 => "image",
            _ => "line",
        };
        let flags = (if is_static != 0 { 0x100 } else { 0 }) | primitive as u32;
        let mut flag_bits = ObjB::new();
        flag_bits.set("is_static", is_static != 0);
        flag_bits.set("is_circle", matches!(primitive, 1 | 3 | 4));
        flag_bits.num("raw", flags);
        let mut seg = ObjB::new();
        seg.set("segment_order_index", int(order));
        seg.num("segment_id", segment_id);
        seg.num("parent_id", parent);
        seg.num("length", length);
        seg.num("angle_rad", angle);
        seg.num("thickness", thickness);
        seg.num("primitive_code", primitive);
        seg.set("segment_type", text(segment_type));
        seg.set("segment_kind", text(kind));
        seg.num("flags", flags);
        seg.set("is_static", is_static != 0);
        seg.num("static_raw", is_static);
        seg.set("flag_bits", flag_bits.build());
        seg.set("color_rgb", Value::nums(&[0.0, 0.0, 0.0]));
        seg.num("color_alpha", 1.0);
        seg.num("transparency", 0.0);
        seg.num("bend_rad", 0.0);
        seg.set("visible", matches!(primitive, 1..=4) || thickness as f64 > 0.01);
        seg.set("valid", true);
        seg.set("z_order", int(order + 1));
        seg.set("z_order_runtime_raw", int(order));
        seg.set("record_offset", if builtin { Value::Null } else { int(pos) });
        seg.set("source_layout", text("piv_v4_legacy24"));
        seg.num("legacy_unused_flags", unused_flags);
        seg.num("legacy_reserved", reserved);
        if !builtin {
            // length, angle_rad, thickness and static_raw.
            reader.bindings += 4;
        }
        if primitive == 2 {
            let sprite_index = reader.u8()?;
            let sprite_flip = reader.u8()?;
            seg.num("sprite_index", sprite_index);
            seg.num("sprite_flip", sprite_flip);
            seg.num("image_asset_index", sprite_index);
            seg.num("image_flip", sprite_flip);
            // The modern field names of the sprite reference.
            seg.num("extra_u16", sprite_index);
            seg.num("extra_u8_a", sprite_flip);
            seg.num("extra_u8_b", 0.0);
            sprite_refs.push(sprite_index);
        }
        segments.push(seg);
        links.push((segment_id, parent));
    }
    let mut parent_of = [0u8; 256];
    let mut seen = [false; 256];
    let mut distinct = true;
    for &(id, parent) in &links {
        distinct &= !std::mem::replace(&mut seen[id as usize], true);
        parent_of[id as usize] = parent;
    }
    if !distinct {
        return Err(value_error(format!("Duplicate segment IDs in figure {figure_id}")));
    }
    for &(id, _) in &links {
        let mut chain = [false; 256];
        let mut node = id;
        while node != 0 {
            if chain[node as usize] {
                return Err(value_error(format!("Cyclic segment topology in figure {figure_id}")));
            }
            chain[node as usize] = true;
            node = parent_of[node as usize];
        }
    }
    let mut images: Vec<Value> = Vec::new();
    if !sprite_refs.is_empty() {
        let sprite_count = reader.u8()? as usize;
        for si in 0..sprite_count {
            let transparent = reader.u32()?;
            let (mut asset, width, height) = image(reader, false)?;
            asset.set("sprite_index", int(si));
            asset.num("transparent_color_raw", transparent);
            asset.set("transparent_color_rgb", Value::nums(&[(transparent & 255) as f64, ((transparent >> 8) & 255) as f64, ((transparent >> 16) & 255) as f64]));
            asset.set("image_index", int(si));
            asset.num("transparency_color_raw", transparent);
            let point = |x: Value, y: Value| {
                let mut object = ObjB::new();
                object.set("x", x);
                object.set("y", y);
                object.build()
            };
            asset.set("pivot", point(Value::Num(0.0), height.clone()));
            asset.set("endpoint", point(width, height));
            let mut asset: Obj = asset.build_obj();
            normalize_sprite(&mut asset)?;
            images.push(Value::object(asset));
        }
        if sprite_refs.iter().any(|&si| si as usize >= images.len()) {
            return Err(value_error(format!("Missing sprite resource in figure {figure_id}")));
        }
    }
    let name = if builtin { "Default".to_string() } else { reader.string()? };
    let has_images = !images.is_empty();
    let mut decode = ObjB::new();
    decode.set("layout", text("piv_v4_legacy24"));
    decode.set("records_start", if builtin { Value::Null } else { int(start) });
    decode.set("records_end", if builtin { Value::Null } else { int(reader.pos) });
    let mut value = ObjB::new();
    value.set("figure_type_id", int(figure_id));
    value.set("name", text(&name));
    value.set("segment_count", int(count));
    value.set("segments", Value::Arr(Arc::new(segments.into_iter().map(ObjB::build).collect())));
    value.set("polyfills", empty_list());
    value.set("bends", empty_list());
    value.set("image_assets", if has_images { Value::Arr(Arc::new(images)) } else { empty_list() });
    value.set("text_assets", empty_list());
    value.set("has_side_table", has_images);
    value.set("segment_decode", decode.build());
    value.set("z_order_mode", text("record_order"));
    value.set("builtin", builtin);
    Ok(Figure { id: figure_id, count, has_images, value: value.build() })
}

/// One object of a frame until every object of the frame is read (a join names a later slot).
struct PendingObject {
    report: ObjB,
    /// The slot and the handle this object is joined to.
    join: Option<(u16, u8)>,
    figure_index: usize,
    unique_id: u32,
}

/// `decode_v4`: a decompressed version 4 payload, consumed exactly.
pub(crate) fn decode_v4(ctx: &Ctx<'_>, data: &[u8], source_path: &str) -> PyResult<LegacyParts> {
    let mut reader = Reader { data, pos: 0, bindings: 0 };
    if reader.u8()? != 4 {
        return Err(value_error("decode_v4 requires a Pivot version 4 payload"));
    }
    let width = reader.u32()?;
    let height = reader.u32()?;
    reader.bindings += 2;
    if width == 0 || height == 0 {
        return Err(value_error("Pivot canvas dimensions must be positive"));
    }
    let bg_slots = reader.u8()? as usize;
    if bg_slots == 0 {
        return Err(value_error("Pivot background table must contain default slot 0"));
    }
    let mut backgrounds: Vec<Value> = Vec::new();
    for bg_id in 1..bg_slots {
        let kind = reader.u8()?;
        if kind > 1 {
            return Err(value_error(format!("Unsupported Pivot 4 background kind {} at byte {}", kind, reader.pos - 1)));
        }
        let (mut asset, _, _) = image(&mut reader, kind == 1)?;
        let name = reader.string()?;
        asset.set("background_id", int(bg_id));
        asset.num("kind", kind);
        asset.set("name", text(&name));
        let mut asset: Obj = asset.build_obj();
        data_url_default(&mut asset);
        backgrounds.push(Value::object(asset));
    }
    let figure_slots = reader.u16()? as usize;
    if figure_slots < 2 {
        return Err(value_error("Pivot 4 figure table must include empty and builtin slots"));
    }
    let records = builtin_man_records();
    let mut figures = vec![figure(&mut Reader { data: &records, pos: 0, bindings: 0 }, 1, 0, true)?];
    for figure_id in 2..figure_slots {
        let index = figures.len();
        figures.push(figure(&mut reader, figure_id, index, false)?);
    }
    let mut by_id: Vec<Option<usize>> = vec![None; 65536];
    for (index, figure) in figures.iter().enumerate() {
        by_id[figure.id] = Some(index);
    }
    let frame_start = reader.pos;
    let frame_count = reader.u32()? as usize;
    if frame_count == 0 || frame_count > (data.len() - reader.pos) / 5 {
        return Err(value_error(format!("Invalid Pivot 4 frame count {frame_count}")));
    }
    let mut frames = Vec::with_capacity(frame_count);
    let mut total_frames = 0f64;
    for fi in 0..frame_count {
        ctx.checkpoint()?;
        let duration = reader.u16()?;
        reader.bindings += 1;
        if duration == 0 {
            return Err(value_error(format!("Zero frame duration at frame {fi}")));
        }
        let bg_id = reader.u8()? as usize;
        reader.bindings += 1;
        if bg_id >= bg_slots {
            return Err(value_error(format!("Missing background {bg_id} at frame {fi}")));
        }
        let object_count = reader.u16()? as usize;
        let mut objects: Vec<PendingObject> = Vec::with_capacity(object_count.min(4096));
        for oi in 0..object_count {
            let unique_id = reader.u32()?;
            let type_id = reader.u16()? as usize;
            let Some(figure_index) = by_id[type_id] else {
                return Err(value_error(format!("Missing figure type {type_id} at frame {fi}, object {oi}")));
            };
            let figure = &figures[figure_index];
            let scale = reader.f32(format_args!("/keyframes/{fi}/objects/{oi}/scale"))?;
            let color_raw = reader.u32()?;
            let transparency = reader.u8()?;
            reader.bindings += 3;
            let flags = if figure.has_images {
                reader.bindings += 1;
                reader.u8()?
            } else {
                0
            };
            let count = figure.count;
            let angles = reader.floats(count, 8, format_args!("/keyframes/{fi}/objects/{oi}/angles"))?;
            if angles.iter().any(|angle| angle.abs() > 100.0) {
                // Pivot reads this as a reset sentinel and derives the pose another way.
                return Err(value_error(format!("Unsupported legacy angle-reset sentinel at frame {fi}, object {oi}")));
            }
            let root_x = reader.f32(format_args!("/keyframes/{fi}/objects/{oi}/root_x"))?;
            let root_y = reader.f32(format_args!("/keyframes/{fi}/objects/{oi}/root_y"))?;
            reader.bindings += 2;
            let length_flag = reader.u8()?;
            let lengths = if length_flag != 0 { reader.floats(count, 4, format_args!("/keyframes/{fi}/objects/{oi}/lengths"))? } else { Vec::new() };
            let join_flag = reader.u8()?;
            let join = if join_flag != 0 { Some((reader.u16()?, reader.u8()?)) } else { None };
            let color = if color_raw < 0x8000_0000 { color_raw } else { 0 };
            let mut object = ObjB::new();
            object.set("object_slot", int(oi));
            object.num("unique_id", unique_id);
            object.set("figure_type_id", int(type_id));
            object.num("scale", scale);
            object.num("color_override_raw", color_raw);
            object.set("color_override_rgb", Value::nums(&[(color & 255) as f64, ((color >> 8) & 255) as f64, ((color >> 16) & 255) as f64]));
            object.num("field28", transparency);
            object.num("image_text_flags", flags);
            object.set("angles", Value::nums(&angles));
            object.num("root_x", root_x);
            object.num("root_y", root_y);
            object.num("len_flag", length_flag);
            object.set("lengths", Value::nums(&lengths));
            object.num("bend_flag", 0.0);
            object.set("bends", empty_list());
            object.set("join", Value::Null);
            object.num("join_flag_raw", join_flag);
            objects.push(PendingObject { report: object, join, figure_index, unique_id });
        }
        let mut order = Vec::with_capacity(object_count.min(4096));
        for _ in 0..object_count {
            order.push(reader.u16()? as usize);
        }
        let mut used = vec![false; object_count];
        for &slot in &order {
            if slot >= object_count || std::mem::replace(&mut used[slot], true) {
                return Err(value_error(format!("Object draw order is not a permutation at frame {fi}")));
            }
        }
        let targets: Vec<(usize, u32)> = objects.iter().map(|object| (object.figure_index, object.unique_id)).collect();
        let mut object_values = Vec::with_capacity(object_count);
        for PendingObject { report: mut object, join, .. } in objects {
            if let Some((slot, handle)) = join {
                let Some(&(target_figure, target_id)) = targets.get(slot as usize) else {
                    return Err(value_error(format!("Join target outside frame {fi}")));
                };
                if handle as usize > figures[target_figure].count {
                    return Err(value_error(format!("Join handle outside target figure at frame {fi}")));
                }
                let mut link = ObjB::new();
                link.num("target_object_slot", slot);
                link.num("target_handle_id", handle);
                link.num("target_unique_id", target_id);
                object.set("join", link.build());
            }
            object_values.push(object.build());
        }
        let mut camera = ObjB::new();
        camera.set("is_default", true);
        camera.num("x", 0.0).num("y", 0.0).num("scale", 1.0);
        total_frames += duration as f64;
        let order_values: Vec<f64> = order.iter().map(|&slot| slot as f64).collect();
        let mut frame = ObjB::new();
        frame.set("keyframe_index", int(fi));
        frame.num("duration_raw", duration);
        frame.num("duration_frames", duration);
        frame.num("inbetweens", 0.0);
        frame.set("duration_semantics", text("hold"));
        frame.num("background_mix", 0.0);
        frame.set("background_id", int(bg_id));
        frame.set("background_id_b", Value::Null);
        frame.set("objects", if object_values.is_empty() { empty_list() } else { Value::Arr(Arc::new(object_values)) });
        frame.set("object_draw_order", Value::nums(&order_values));
        frame.set("camera", camera.build());
        frame.set("interpolation", text("hold"));
        frames.push(frame.build());
    }
    let delay_ms = reader.u32()?;
    reader.bindings += 1;
    if delay_ms == 0 {
        return Err(value_error("Pivot 4 frame delay must be positive"));
    }
    let optional_flag = if data.len() - reader.pos == 1 { Some(reader.u8()?) } else { None };
    if reader.pos != data.len() {
        return Err(value_error(format!("Unexpected trailing data at byte {}: {} bytes", reader.pos, data.len() - reader.pos)));
    }
    let fps = crate::pyfmt::py_round(1000.0 / delay_ms as f64);
    let mut validation = ObjB::new();
    validation.set("consumed_bytes", int(reader.pos));
    validation.num("trailing_bytes", 0.0);
    validation.set("frame_start", int(frame_start));
    validation.set("exact_consumption", true);
    let notes = vec![
        text("Version 4 duration values repeat held poses; they are not interpolated frames."),
        text("FPS is the native rounded 1000/frame_delay_ms conversion."),
        text("Legacy static state comes from record byte 21; record bytes 2 and 3 are unused."),
        text("Sprite assets preserve bitmap color-key transparency metadata."),
    ];
    let mut report = ObjB::new();
    report.set("source_path", text(source_path));
    report.set("file_type", text("piv"));
    report.set("format", text("piv_v4_exact"));
    report.set("decode_status", text("decoded"));
    report.set("trace_assisted", false);
    report.num("version", 4.0);
    report.num("canvas_width", width);
    report.num("canvas_height", height);
    report.set("backgrounds", if backgrounds.is_empty() { empty_list() } else { Value::Arr(Arc::new(backgrounds)) });
    report.set("figure_types", Value::Arr(Arc::new(figures.into_iter().map(|figure| figure.value).collect())));
    report.set("keyframes", Value::Arr(Arc::new(frames)));
    report.num("fps", fps);
    report.num("frame_delay_ms", delay_ms);
    report.set("optional_trailing_flag", optional_flag.map(num).unwrap_or(Value::Null));
    report.num("timeline_frame_count", total_frames);
    report.set("payload_size", int(data.len()));
    report.set("validation", Value::Null);
    report.set("notes", Value::Arr(Arc::new(notes)));
    Ok(LegacyParts { report, validation, width, height, fps, bindings: reader.bindings, total_frames })
}
