//! The Pivot 5 project grammar (`piv_codec.py`): canvas, backgrounds, figure
//! definitions, the frame table and the trailer, read into the report the
//! editor works on.

use std::sync::Arc;

use styk_doc::{Nums, Obj, Value};

use crate::ctx::{Ctx, ObjB, empty_list, int, key, list, num, shape, text};
use crate::error::{Class, PyResult, piv};
use crate::piv::frames::{FigureInfo, FrameMode, Frames, read_frames, repairs_value};
use crate::piv::side_tables::{SegmentRef, blob, parse_side_tables};
use crate::reader::Reader;

/// Pivot 5's published figure limit; the count and joint IDs are `u16` fields.
pub(crate) const MAX_SEGMENTS: usize = 30000;

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
        out.push(char::from(b"0123456789abcdef"[(byte & 15) as usize]));
    }
    out
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&styk_doc::digest::sha256(bytes))
}

fn istr(name: &'static str) -> Value {
    Value::Str(key(name))
}

fn rgb_value(rgb: [u8; 3]) -> Value {
    Value::Nums(Arc::new(Nums::F32(Box::new([rgb[0] as f32, rgb[1] as f32, rgb[2] as f32]))))
}

/// The implicit figure in slot 1 (`_builtin_man`), which no file stores.
pub(crate) fn builtin_man() -> Value {
    // The exact doubles Pivot uses, digit for digit: not approximations of fractions of pi.
    #[allow(clippy::approx_constant)]
    const VALUES: [(u8, f64, f64, f64, u8, u8); 12] = [
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
    let segments: Vec<Value> = VALUES
        .iter()
        .enumerate()
        .map(|(i, &(parent, length, angle, thickness, prim, aux))| {
            let is_static = aux & 1 != 0;
            let kind = if prim != 0 { "circle" } else { "line" };
            let mut flag_bits = ObjB::new();
            flag_bits.set("is_static", is_static);
            let mut segment = ObjB::new();
            segment.set("segment_id", int(i + 1));
            segment.num("parent_id", parent);
            segment.num("length", length);
            segment.num("angle_rad", angle);
            segment.num("thickness", thickness);
            segment.num("primitive_code", prim);
            segment.num("aux_code", aux);
            segment.num("flags", prim as u32 | ((aux as u32) << 8));
            segment.set("is_static", is_static);
            segment.set("flag_bits", flag_bits.build());
            segment.set("color_rgb", rgb_value([0, 0, 0]));
            segment.num("color_alpha", 1.0);
            segment.num("transparency", 0.0);
            segment.num("bend_rad", 0.0);
            segment.set("segment_kind", istr(kind));
            segment.set("segment_type", istr(kind));
            segment.set("segment_order_index", int(i));
            segment.set("z_order_runtime_raw", int(i));
            segment.set("z_order", int(i + 1));
            segment.set("visible", true);
            segment.set("valid", true);
            segment.build()
        })
        .collect();
    let mut decode = ObjB::new();
    decode.set("layout", text("builtin_native_v5"));
    let mut figure = ObjB::new();
    figure.num("figure_type_id", 1.0);
    figure.set("name", text("Default"));
    figure.set("segment_count", int(segments.len()));
    figure.set("segments", Value::Arr(Arc::new(segments)));
    figure.set("polyfills", empty_list());
    figure.set("bends", empty_list());
    figure.set("text_assets", empty_list());
    figure.set("image_assets", empty_list());
    figure.set("has_side_table", false);
    figure.set("segment_decode", decode.build());
    figure.set("z_order_mode", text("record_order"));
    figure.set("implicit", true);
    figure.build()
}

/// `_asset` for a background image: what it is, and its bytes as a data URL.
fn background_asset(item: &mut ObjB, data: &[u8]) {
    let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(b"\xff\xd8") {
        "image/jpeg"
    } else if data.starts_with(b"BM") {
        "image/bmp"
    } else {
        "application/octet-stream"
    };
    item.set("mime_type", text(mime));
    item.set("byte_length", int(data.len()));
    item.set("sha256", text(&sha256_hex(data)));
    if mime != "application/octet-stream" {
        item.set("data_url", blob(&format!("data:{mime};base64,"), &Arc::from(data)));
    }
}

fn backgrounds(r: &mut Reader<'_>) -> PyResult<(Vec<Value>, u32)> {
    let slots = r.u16()? as u32;
    if slots < 1 {
        return Err(piv("Background slot count must include implicit white background"));
    }
    let mut out = Vec::new();
    for i in 1..slots {
        let kind = r.u8()?;
        let mut item = ObjB::new();
        item.num("background_id", i);
        item.num("kind", kind);
        item.set("record_offset", int(r.pos - 1));
        match kind {
            0 | 1 => {
                let end = r.u64()?;
                let data = r.take(end as i128 - r.pos as i128)?;
                background_asset(&mut item, data);
            }
            2 => {
                item.num("color", r.u32()?);
            }
            3 | 4 => {
                item.num("color_a", r.u32()?);
                item.num("color_b", r.u32()?);
                for field in ["x1", "y1", "x2", "y2"] {
                    let value = r.f32(format_args!("/backgrounds/{}/{}", i - 1, field))?;
                    item.num(field, value);
                }
            }
            _ => return Err(piv(format!("Unsupported background kind {} at {:#x}", kind, r.pos - 1))),
        }
        item.set("name", text(&r.string8()?));
        item.set("record_end", int(r.pos));
        out.push(item.build());
    }
    Ok((out, slots))
}

struct Segment {
    id: u16,
    parent: u16,
    length: f32,
    angle: f64,
    thickness: f32,
    prim: u8,
    aux: u8,
    rgb: [u8; 3],
    trans: u8,
    secondary: Option<([u8; 3], u8)>,
    extra: Option<(u16, u8, u8)>,
    bend: f64,
    start: usize,
    end: usize,
}

const SEGMENT_KINDS: [&str; 7] = ["line", "circle", "image", "circleFill", "circleClear", "text", "squareLine"];

const SEGMENT_KEYS: [&str; 23] = [
    "segment_id",
    "parent_id",
    "length",
    "angle_rad",
    "thickness",
    "primitive_code",
    "aux_code",
    "flags",
    "color_rgb",
    "transparency",
    "color_alpha",
    "secondary",
    "segment_kind",
    "segment_type",
    "is_static",
    "flag_bits",
    "extra",
    "segment_order_index",
    "visible",
    "valid",
    "bend_rad",
    "record_offset",
    "record_end",
];

/// One decoded figure definition and what the frame reader needs from it.
struct Figure {
    value: Value,
    info: FigureInfo,
    has_style: bool,
    name: String,
}

/// Joint ID to record index, for one figure at a time; `u32::MAX` means unused.
/// Kept across figures so a file with hundreds of them does not clear 64K entries each time.
struct JointIndex(Vec<u32>);

impl JointIndex {
    fn new() -> JointIndex {
        JointIndex(vec![u32::MAX; 65536])
    }
}

fn figure(ctx: &Ctx<'_>, r: &mut Reader<'_>, figure_id: usize, joints: &mut JointIndex) -> PyResult<Figure> {
    let start = r.pos;
    let prefix = figure_id - 1;
    let flags = r.u8()?;
    let count = r.u16()? as usize;
    if count == 0 || count > MAX_SEGMENTS {
        return Err(piv(format!("Invalid segment count {} for figure {} at {:#x}", count, figure_id, start)));
    }
    let mut segments: Vec<Segment> = Vec::with_capacity(count);
    for i in 0..count {
        let offset = r.pos;
        let parent = r.u16()?;
        let id = if flags & 32 != 0 { (i + 1) as u16 } else { r.u16()? };
        let length = r.f32(format_args!("/figure_types/{prefix}/segments/{i}/length"))?;
        let angle = r.f64(format_args!("/figure_types/{prefix}/segments/{i}/angle_rad"))?;
        let thickness = r.f32(format_args!("/figure_types/{prefix}/segments/{i}/thickness"))?;
        let prim = if flags & 1 != 0 { 0 } else { r.u8()? };
        let aux = if flags & 2 != 0 { 0 } else { r.u8()? };
        let rgb = if flags & 4 != 0 {
            [0, 0, 0]
        } else {
            ctx.checkpoint()?;
            let bytes = r.array(3, 1)?;
            [bytes[0], bytes[1], bytes[2]]
        };
        let trans = if flags & 8 != 0 { 0 } else { r.u8()? };
        let mut secondary = None;
        if flags & 128 == 0 && r.u8()? != 0 {
            ctx.checkpoint()?;
            let bytes = r.array(3, 1)?;
            secondary = Some(([bytes[0], bytes[1], bytes[2]], r.u8()?));
        }
        let extra = if prim == 2 || prim == 5 { Some((r.u16()?, r.u8()?, r.u8()?)) } else { None };
        if prim > 6 {
            return Err(piv(format!("Unknown primitive {} in figure {}, segment {}", prim, figure_id, i)));
        }
        segments.push(Segment { id, parent, length, angle, thickness, prim, aux, rgb, trans, secondary, extra, bend: 0.0, start: offset, end: r.pos });
    }
    // Joint IDs are distinct and non-zero, parents exist, and no chain loops.
    let index_of = &mut joints.0;
    let mut distinct = true;
    for (index, segment) in segments.iter().enumerate() {
        if index_of[segment.id as usize] != u32::MAX {
            distinct = false;
        }
        index_of[segment.id as usize] = index as u32;
    }
    if !distinct || index_of[0] != u32::MAX {
        return Err(piv(format!("Invalid duplicate/zero segment IDs in figure {figure_id}")));
    }
    if segments.iter().any(|s| s.parent != 0 && index_of[s.parent as usize] == u32::MAX) {
        return Err(piv(format!("Unknown parent ID in figure {figure_id}")));
    }
    let mut state = vec![0u8; count];
    for first in 0..count {
        let mut at = first;
        let mut path = Vec::new();
        while state[at] == 0 {
            state[at] = 1;
            path.push(at);
            let parent = segments[at].parent;
            if parent == 0 {
                break;
            }
            at = index_of[parent as usize] as usize;
            if state[at] == 1 {
                return Err(piv(format!("Cyclic segment parents in figure {figure_id}")));
            }
        }
        for done in path {
            state[done] = 2;
        }
    }
    let bend_count = r.u16()? as usize;
    if bend_count > count {
        return Err(piv(format!("Invalid bend count in figure {figure_id}")));
    }
    let mut bends = Vec::with_capacity(bend_count);
    for _ in 0..bend_count {
        let index = r.u16()? as usize;
        if index >= count {
            return Err(piv(format!("Invalid bend index {} in figure {}", index, figure_id)));
        }
        let value = r.f64(format_args!("/figure_types/{prefix}/segments/{index}/bend_rad"))?;
        let mut bend = ObjB::new();
        bend.set("segment_index", int(index));
        bend.num("bend_rad", value);
        bends.push(bend.build());
        segments[index].bend = value;
    }
    let mut side: Vec<Value> = Vec::new();
    if segments.iter().any(|s| s.prim == 2 || s.prim == 5) {
        let refs: Vec<SegmentRef> =
            segments.iter().map(|s| SegmentRef { primitive: s.prim as i64, reference: s.extra.map(|e| e.0 as i64).unwrap_or(0), segment_id: s.id as i64 }).collect();
        match parse_side_tables(r.data, r.pos, &refs, flags & 16 != 0 && flags & 64 == 0) {
            Ok((assets, pos)) => {
                side = assets;
                r.pos = pos;
            }
            Err(error) if error.is(Class::Value) => return Err(piv(format!("Invalid side table in figure {}: {}", figure_id, error.msg))),
            Err(error) => return Err(error),
        }
    }
    let poly_count = r.u16()? as usize;
    if poly_count > 20000 {
        return Err(piv(format!("Invalid polyfill count {} in figure {}", poly_count, figure_id)));
    }
    let mut polys: Vec<ObjB> = Vec::with_capacity(poly_count);
    for pi in 0..poly_count {
        let vertex_count = r.u16()? as usize;
        ctx.checkpoint()?;
        let color = r.array(3, 1)?;
        let rgb = [color[0], color[1], color[2]];
        let alpha = r.u8()?;
        ctx.checkpoint()?;
        let vertices = r.u16_array(vertex_count)?;
        if vertices.iter().any(|&v| v != 0 && index_of[v as usize] == u32::MAX) {
            return Err(piv(format!("Unknown polyfill joint in figure {}, polygon {}", figure_id, pi)));
        }
        let ids: Vec<f64> = vertices.iter().map(|&v| v as f64).collect();
        let mut poly = ObjB::new();
        poly.set("polyfill_id", int(pi + 1));
        poly.set("segment_ids", Value::nums(&ids));
        poly.set("segment_ids_raw", Value::nums(&ids));
        poly.set("vertex_id_space", text("joint_tip_ids"));
        poly.set("color_rgb", rgb_value(rgb));
        poly.num("alpha_raw", alpha);
        poly.num("color_alpha", 1.0 - alpha as f64 / 255.0);
        polys.push(poly);
    }
    let (seg_z, poly_z): (Vec<u16>, Vec<u32>) = if flags & 16 == 0 {
        ctx.checkpoint()?;
        let seg_z = r.u16_array(count)?;
        ctx.checkpoint()?;
        let poly_z = r.u16_array(poly_count)?;
        (seg_z, poly_z.into_iter().map(u32::from).collect())
    } else {
        ((0..count as u16).collect(), (count as u32..(count + poly_count) as u32).collect())
    };
    let total = count + poly_count;
    let mut used = vec![false; total];
    for z in seg_z.iter().map(|&z| z as u32).chain(poly_z.iter().copied()) {
        if z as usize >= total || used[z as usize] {
            return Err(piv(format!("Invalid z-order permutation for figure {figure_id}")));
        }
        used[z as usize] = true;
    }
    let mut style = Value::Null;
    let has_style = flags & 64 != 0;
    if has_style {
        let u28 = r.u32()?;
        ctx.checkpoint()?;
        let color = r.array(3, 1)?;
        let rgb = [color[0], color[1], color[2]];
        let u30 = r.u8()?;
        let thickness = f32::from_bits(u28);
        if !thickness.is_finite() {
            return Err(piv(format!("Non-finite outline thickness in figure {figure_id}")));
        }
        let mut object = ObjB::new();
        object.num("u28", u28);
        object.set("rgb", rgb_value(rgb));
        object.num("u30", u30);
        object.num("outline_thickness", thickness);
        object.num("outline_transparency", u30);
        object.num("outline_opacity", 1.0 - u30 as f64 / 255.0);
        style = object.build();
    }
    let name = r.string8()?;

    let mut ordered: Vec<&'static str> = SEGMENT_KEYS.to_vec();
    ordered.extend(["z_order_runtime_raw", "z_order"]);
    let mut with_media: Vec<&'static str> = SEGMENT_KEYS.to_vec();
    with_media.extend(["extra_u16", "extra_u8_a", "extra_u8_b", "z_order_runtime_raw", "z_order"]);
    let (plain, media) = (shape(&ordered), shape(&with_media));
    let flag_shape = shape(&["is_static"]);
    let secondary_shape = shape(&["rgb", "a"]);
    let segment_values: Vec<Value> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let is_static = s.aux & 1 != 0;
            let segment_type = match s.prim {
                1 | 3 | 4 => "circle",
                2 => "image",
                5 => "text",
                _ => "line",
            };
            let mut values = Vec::with_capacity(28);
            values.push(num(s.id));
            values.push(num(s.parent));
            values.push(num(s.length));
            values.push(num(s.angle));
            values.push(num(s.thickness));
            values.push(num(s.prim));
            values.push(num(s.aux));
            values.push(num(((s.aux as u32) << 8) | s.prim as u32));
            values.push(rgb_value(s.rgb));
            values.push(num(s.trans));
            values.push(num(1.0 - s.trans as f64 / 255.0));
            values.push(match s.secondary {
                None => Value::Null,
                Some((rgb, a)) => Value::Obj(Arc::new(Obj::from_shape(secondary_shape.clone(), vec![rgb_value(rgb), num(a)]))),
            });
            values.push(istr(SEGMENT_KINDS[s.prim as usize]));
            values.push(istr(segment_type));
            values.push(Value::Bool(is_static));
            values.push(Value::Obj(Arc::new(Obj::from_shape(flag_shape.clone(), vec![Value::Bool(is_static)]))));
            values.push(match s.extra {
                None => Value::Null,
                Some((a, b, c)) => Value::nums(&[a as f64, b as f64, c as f64]),
            });
            values.push(int(i));
            values.push(Value::Bool(s.thickness as f64 > 0.01 || (1..=6).contains(&s.prim)));
            values.push(Value::Bool(true));
            values.push(num(s.bend));
            values.push(int(s.start));
            values.push(int(s.end));
            if let Some((a, b, c)) = s.extra {
                values.push(num(a));
                values.push(num(b));
                values.push(num(c));
            }
            values.push(num(seg_z[i]));
            values.push(num(seg_z[i] as u32 + 1));
            let layout = if s.extra.is_some() { &media } else { &plain };
            Value::Obj(Arc::new(Obj::from_shape(layout.clone(), values)))
        })
        .collect();
    let poly_values: Vec<Value> = polys
        .into_iter()
        .zip(&poly_z)
        .map(|(mut poly, &z)| {
            poly.num("z_order_runtime_raw", z);
            poly.num("z_order", z + 1);
            poly.build()
        })
        .collect();
    let texts: Vec<Value> = side.iter().filter(|a| a.get("kind").and_then(Value::as_str) == Some("text")).cloned().collect();
    let images: Vec<Value> = side.iter().filter(|a| a.get("kind").and_then(Value::as_str) == Some("image")).cloned().collect();
    let has_media = !side.is_empty();
    let mut decode = ObjB::new();
    decode.set("layout", text("piv_v5_sequential"));
    decode.num("flags_byte", flags);
    decode.set("records_start", int(start));
    decode.set("records_end", int(r.pos));
    decode.set("global_style", style);
    let seg_z_values: Vec<f64> = seg_z.iter().map(|&z| z as f64).collect();
    let poly_z_values: Vec<f64> = poly_z.iter().map(|&z| z as f64).collect();
    let mut out = ObjB::new();
    out.set("figure_type_id", int(figure_id));
    out.set("name", text(&name));
    out.set("segment_count", int(count));
    out.set("segments", Value::Arr(Arc::new(segment_values)));
    out.set("polyfills", Value::Arr(Arc::new(poly_values)));
    out.set("bends", Value::Arr(Arc::new(bends)));
    out.set("segment_z_raw", Value::nums(&seg_z_values));
    out.set("poly_z_raw", Value::nums(&poly_z_values));
    out.set("segment_decode", decode.build());
    out.set("has_side_table", has_media);
    out.set("side_tables", Value::Arr(Arc::new(side)));
    out.set("text_assets", Value::Arr(Arc::new(texts)));
    out.set("image_assets", Value::Arr(Arc::new(images)));
    out.set("z_order_mode", text("runtime_z_map"));
    let mut handles: Vec<u16> = segments.iter().map(|s| s.id).collect();
    for &id in &handles {
        joints.0[id as usize] = u32::MAX;
    }
    handles.push(0);
    handles.sort_unstable();
    Ok(Figure { value: out.build(), info: FigureInfo { id: figure_id as i64, count, has_media, handles }, has_style, name })
}

/// Reads one figure definition at the reader's position, as an STK file holds
/// it (`codec_bridge.stk_document` calls `_figure(reader, 2, None)`).
pub(crate) fn read_figure(ctx: &Ctx<'_>, r: &mut Reader<'_>, figure_id: usize) -> PyResult<Value> {
    Ok(figure(ctx, r, figure_id, &mut JointIndex::new())?.value)
}

/// A decoded Pivot 5 payload: the report and the layout facts writers and the
/// native-frame transport need.
pub(crate) struct V5 {
    pub report: Value,
    pub frame_start: usize,
    pub fps: u32,
    pub auto_easing: bool,
    /// Everything after the frame rate, kept verbatim.
    pub trailer: Vec<u8>,
    pub figures: Vec<FigureInfo>,
}

/// `piv_codec._decode` for a version 5 payload.
pub(crate) fn decode(ctx: &Ctx<'_>, payload: &[u8], source_len: usize, source_path: &str, mode: FrameMode) -> PyResult<V5> {
    let mut r = Reader::new(payload);
    let version = r.u8()?;
    debug_assert_eq!(version, 5);
    let width = r.u32()?;
    let height = r.u32()?;
    if !(0 < width && width <= 100000 && 0 < height && height <= 100000) {
        return Err(piv("Invalid canvas dimensions"));
    }
    let (background_values, bg_slots) = backgrounds(&mut r)?;
    let figure_slots = r.u16()? as usize;
    if figure_slots < 2 {
        return Err(piv("Figure table must include reserved and implicit slots"));
    }
    let table_start = r.pos;
    let mut figure_values = vec![builtin_man()];
    let mut infos = vec![FigureInfo { id: 1, count: 12, has_media: false, handles: (0..=12).collect() }];
    let mut bindings = 0usize;
    let mut names: Vec<String> = vec!["Default".to_string()];
    let mut joints = JointIndex::new();
    for figure_id in 2..figure_slots {
        let decoded = figure(ctx, &mut r, figure_id, &mut joints)?;
        bindings += decoded.has_style as usize;
        figure_values.push(decoded.value);
        infos.push(decoded.info);
        names.push(decoded.name);
    }
    let frame_start = r.pos;
    let Frames { durations, values, repairs, end } = read_frames(ctx, payload, frame_start, &infos, bg_slots, mode)?;
    r.pos = end;
    let fps = r.u32()?;
    if !(1..=1000).contains(&fps) {
        return Err(piv(format!("Invalid fps {} at {:#x}", fps, r.pos - 4)));
    }
    let trailer_start = r.pos;
    // Native Options/Auto-Easing stores the complement of this byte; older saves omit it.
    let ease_raw = if r.pos < payload.len() { Some(r.u8()?) } else { None };
    if let Some(raw) = ease_raw.filter(|&raw| raw > 1) {
        return Err(piv(format!("Invalid auto-easing mode {} at {:#x}", raw, trailer_start)));
    }
    if ease_raw.is_some() {
        bindings += 1;
    }
    let tail = &payload[trailer_start..];
    let frame_count = durations.len();
    let total_frames: u64 = durations.iter().take(frame_count.saturating_sub(1)).map(|&d| d as u64).sum::<u64>()
        + durations.last().map(|&d| (d > 0) as u64).unwrap_or(0);
    let auto_easing = !matches!(ease_raw, Some(1));

    let mut validation = ObjB::new();
    validation.set("figure_table_start", int(table_start));
    validation.set("frame_start", int(frame_start));
    validation.set("trailer_start", int(trailer_start));
    validation.set("payload_consumed", int(payload.len()));
    validation.set("custom_figure_count", int(figure_values.len() - 1));
    validation.set("keyframe_count", int(frame_count));
    validation.set("editable_field_count", int(bindings));
    let mut notes = vec![
        text("Sequential binary grammar; no trace, marker scan, or external figure files needed."),
        text("The first trailer byte is the inverted Auto-Easing option; further bytes are preserved."),
    ];
    if ease_raw.is_none() {
        notes.push(text("Auto-Easing omitted: standalone uses the fresh application default ON; native may inherit a different saved preference."));
    }
    // Missing images are collected before the figure list moves into the report.
    let mut missing_images = Vec::new();
    let mut missing_names: Vec<&str> = Vec::new();
    for (figure, name) in figure_values.iter().zip(&names) {
        for asset in figure.get("image_assets").and_then(Value::as_arr).unwrap_or(&[]) {
            if asset.get("missing_image_data").is_some_and(crate::py::truthy) {
                let mut entry = ObjB::new();
                entry.set("figure_type_id", figure.get("figure_type_id").cloned().unwrap_or(Value::Null));
                entry.set("figure_name", text(name));
                entry.set("asset_index", asset.get("asset_index").cloned().unwrap_or(Value::Null));
                entry.set("source_start", asset.get("source_start").cloned().unwrap_or(Value::Null));
                entry.set("recovery", asset.get("image_record_recovery").cloned().unwrap_or(Value::Null));
                missing_images.push(entry.build());
                if !missing_names.contains(&name.as_str()) {
                    missing_names.push(name);
                }
            }
        }
    }

    let keyframes = match values {
        Some(frames) => Value::Arr(Arc::new(frames)),
        // A validation-only read keeps no frames; the transport sends the original bytes.
        None => empty_list(),
    };
    let mut report = ObjB::new();
    report.set("source_path", text(source_path));
    report.set("source_size", int(source_len));
    report.set("payload_size", int(payload.len()));
    report.set("file_type", text("piv"));
    report.set("format", text("piv_v5_standalone"));
    report.set("decode_status", text("decoded"));
    report.set("trace_assisted", false);
    report.num("version", 5.0);
    report.num("canvas_width", width);
    report.num("canvas_height", height);
    report.set("backgrounds", Value::Arr(Arc::new(background_values)));
    report.num("background_slots", bg_slots);
    report.set("figure_slots", int(figure_slots));
    report.set("figure_types", Value::Arr(Arc::new(figure_values)));
    report.set("keyframes", keyframes);
    report.num("fps", fps);
    report.num("total_output_frames", total_frames as f64);
    report.num("duration_seconds", total_frames as f64 / fps as f64);
    report.set("auto_easing", auto_easing);
    report.set("auto_easing_disabled_raw", ease_raw.map(num).unwrap_or(Value::Null));
    report.set("auto_easing_source", text(if ease_raw.is_none() { "application_default" } else { "file" }));
    report.set("trailing_bytes_hex", text(&hex(tail)));
    report.set("supports_viewer", true);
    report.set("validation", validation.build());
    report.set("notes", Value::Arr(Arc::new(notes)));
    let recovered = !repairs.is_empty();
    if recovered {
        let mut affected: Vec<usize> = repairs.iter().map(|repair| repair.keyframe_index + 1).collect();
        affected.sort_unstable();
        affected.dedup();
        let mut listed = affected.iter().take(8).map(|k| k.to_string()).collect::<Vec<_>>().join(", ");
        if affected.len() > 8 {
            listed.push_str(" and more");
        }
        let mut recovery = ObjB::new();
        recovery.num("version", 1.0);
        recovery.set("objects", repairs_value(&repairs));
        report.set("piv_identity_recovery", recovery.build());
        let mut warning = ObjB::new();
        warning.set("code", text("piv_duplicate_object_ids"));
        warning.set(
            "message",
            text(&format!(
                "Recovered {} duplicate figure IDs in keyframes {}. Every figure, join, and layer was preserved. Extra occurrences now have separate identities; review animation transitions around these keyframes.",
                repairs.len(),
                listed
            )),
        );
        report.set("import_warnings", list(vec![warning.build()]));
    }
    if !missing_images.is_empty() {
        let count = missing_images.len();
        report.set("piv_missing_images", Value::Arr(Arc::new(missing_images)));
        let mut warning = ObjB::new();
        warning.set("code", text("piv_missing_image_data"));
        warning.set(
            "message",
            text(&format!(
                "{} embedded images contain no image data ({}). Their figures, anchors and animation are preserved, but these images are transparent. The missing artwork must be replaced from its original image.",
                count,
                missing_names.join(", ")
            )),
        );
        let mut warnings: Vec<Value> = report.get("import_warnings").and_then(Value::as_arr).map(|w| w.to_vec()).unwrap_or_default();
        warnings.push(warning.build());
        report.set("import_warnings", Value::Arr(Arc::new(warnings)));
    }
    Ok(V5 {
        report: report.build(),
        frame_start,
        fps,
        auto_easing,
        trailer: tail.to_vec(),
        figures: infos,
    })
}
