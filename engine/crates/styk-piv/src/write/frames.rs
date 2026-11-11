//! The frame writer (`piv_document.py`): rebuilds the frame table of a Pivot 5
//! payload from an editable document and keeps every byte before it.
//!
//! It only applies when the document's tables (canvas, backgrounds, figures)
//! are exactly the source's; anything else goes through the full writer, which
//! builds new tables and then calls this for the frames.

use std::collections::HashMap;
use std::fmt;

use styk_doc::Value;

use crate::base64;
use crate::ctx::Ctx;
use crate::error::{Class, PyResult, piv, type_error};
use crate::piv::frames::{FigureInfo, FrameMode};
use crate::piv::v5::{self, V5};
use crate::piv::{MAX_PAYLOAD_BYTES, unpack_source};
use crate::py::{self, HKey};
use crate::zlib;

/// A `struct` format letter.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Fmt {
    U8,
    U16,
    U32,
    U64,
    F32,
    F64,
}

/// `_Writer`: little-endian output with the writer's own range and type errors.
#[derive(Default)]
pub(crate) struct Writer {
    pub data: Vec<u8>,
}

impl Writer {
    /// `put(fmt, value, label)`.
    pub fn put(&mut self, fmt: Fmt, value: &Value, label: fmt::Arguments<'_>) -> PyResult<()> {
        let number = match value {
            Value::Num(n) if n.is_finite() => *n,
            _ => return Err(piv(format!("{label} must be a finite number"))),
        };
        self.put_number(fmt, number, label)
    }

    /// `put` of a value that may be absent (`dict.get`).
    pub fn put_opt(&mut self, fmt: Fmt, value: Option<&Value>, label: fmt::Arguments<'_>) -> PyResult<()> {
        self.put(fmt, value.unwrap_or(&Value::Null), label)
    }

    pub fn put_number(&mut self, fmt: Fmt, number: f64, label: fmt::Arguments<'_>) -> PyResult<()> {
        let out_of_range = || piv(format!("{label} is out of range"));
        match fmt {
            Fmt::F64 => self.data.extend_from_slice(&number.to_le_bytes()),
            Fmt::F32 => {
                let single = number as f32;
                if single.is_infinite() {
                    return Err(out_of_range());
                }
                self.data.extend_from_slice(&single.to_le_bytes());
            }
            _ => {
                if number.fract() != 0.0 {
                    return Err(piv(format!("{label} must be an integer")));
                }
                let maximum = match fmt {
                    Fmt::U8 => 255.0,
                    Fmt::U16 => 65535.0,
                    Fmt::U32 => 4294967295.0,
                    _ => 18446744073709551615.0,
                };
                if !(0.0..=maximum).contains(&number) || (fmt == Fmt::U64 && number >= 18446744073709551616.0) {
                    return Err(out_of_range());
                }
                match fmt {
                    Fmt::U8 => self.data.push(number as u8),
                    Fmt::U16 => self.data.extend_from_slice(&(number as u16).to_le_bytes()),
                    Fmt::U32 => self.data.extend_from_slice(&(number as u32).to_le_bytes()),
                    _ => self.data.extend_from_slice(&(number as u64).to_le_bytes()),
                }
            }
        }
        Ok(())
    }

    /// A count or offset the writer computed itself.
    pub fn put_count(&mut self, fmt: Fmt, count: usize, label: fmt::Arguments<'_>) -> PyResult<()> {
        self.put_number(fmt, count as f64, label)
    }

    /// `array(fmt, values, count, label)`: exactly `count` values of one format.
    pub fn array(&mut self, ctx: &Ctx<'_>, fmt: Fmt, values: Option<&Value>, count: usize, label: fmt::Arguments<'_>) -> PyResult<()> {
        ctx.checkpoint()?;
        let Some(values) = values.filter(|v| py::is_list(v) && v.array_len() == Some(count)) else {
            return Err(piv(format!("{label} must contain exactly {count} values")));
        };
        if let Value::Nums(numbers) = values {
            // Packed numbers: no per-value dispatch.
            self.data.reserve(count * 8);
            for number in numbers.iter() {
                if !number.is_finite() {
                    return Err(piv(format!("{label} must be a finite number")));
                }
                self.put_number(fmt, number, label)?;
            }
            return Ok(());
        }
        for value in py::iter(values)?.iter() {
            self.put(fmt, &value, label)?;
        }
        Ok(())
    }
}

/// Fields that say where a decoded asset was materialized, not what it is.
const ASSET_EXPORT_METADATA: [&str; 8] = ["asset_path", "asset_path_relative", "asset_url", "data_base64", "data_url", "data_uri", "sha256", "byte_length"];

/// `_table_signature(a) == _table_signature(b)`: equality that ignores asset materialization fields.
pub(crate) fn same_signature(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Obj(x), Value::Obj(y)) => {
            let kept = |object: &styk_doc::Obj| object.keys().filter(|key| !ASSET_EXPORT_METADATA.contains(&&***key)).count();
            std::sync::Arc::ptr_eq(x, y)
                || (kept(x) == kept(y)
                    && x.iter().filter(|(key, _)| !ASSET_EXPORT_METADATA.contains(&&***key)).all(|(key, value)| y.get(key).is_some_and(|other| same_signature(value, other))))
        }
        (Value::Arr(x), Value::Arr(y)) => std::sync::Arc::ptr_eq(x, y) || (x.len() == y.len() && x.iter().zip(y.iter()).all(|(p, q)| same_signature(p, q))),
        _ => match (a.as_arr(), b.as_arr()) {
            (Some(x), None) | (None, Some(x)) if a.is_array() && b.is_array() => {
                // One side packed, the other not: compare element by element.
                let packed = if a.as_arr().is_some() { b } else { a };
                x.len() == packed.array_len().unwrap_or(0) && x.iter().enumerate().all(|(i, item)| packed.item(i).is_some_and(|other| py::eq(item, &other)))
            }
            _ => py::eq(a, b),
        },
    }
}

/// The inline bytes a document node supplies, if any (`_check_assets_unchanged.inline_bytes`).
fn inline_bytes(value: &styk_doc::Obj) -> PyResult<Option<Vec<u8>>> {
    let mut decoded: Vec<Vec<u8>> = Vec::new();
    for key in ["data_base64", "data_url", "data_uri"] {
        let Some(data) = value.get(key).filter(|data| !data.is_null()) else { continue };
        if let Value::Blob(blob) = data
            && (if key == "data_base64" { blob.prefix.is_empty() } else { blob.prefix.starts_with("data:") && blob.prefix.ends_with(";base64,") && blob.prefix.matches(',').count() == 1 })
        {
            decoded.push(blob.bytes.to_vec());
            continue;
        }
        if !py::is_str(data) {
            return Err(piv("Inline media must be encoded text"));
        }
        let text = data.text().unwrap_or_default();
        let encoded = if key == "data_base64" {
            &text[..]
        } else {
            match text.split_once(',') {
                Some((head, rest)) if text.starts_with("data:") && head.ends_with(";base64") => rest,
                _ => return Err(piv("Inline media URL must use base64 encoding")),
            }
        };
        match base64::decode(encoded.as_bytes(), true) {
            Some(bytes) => decoded.push(bytes),
            None => return Err(piv("Invalid inline media encoding")),
        }
    }
    if decoded.iter().skip(1).any(|data| *data != decoded[0]) {
        return Err(piv("Conflicting inline media representations"));
    }
    Ok(decoded.into_iter().next())
}

/// `_check_assets_unchanged`: media may be omitted from a document, but a
/// supplied replacement must never be silently discarded by this writer.
fn check_assets_unchanged(original: &Value, document: &Value) -> PyResult<()> {
    match (original, document) {
        (Value::Obj(old), Value::Obj(new)) => {
            if std::sync::Arc::ptr_eq(old, new) {
                return Ok(());
            }
            if let Some(supplied) = inline_bytes(new)?
                && Some(&supplied) != inline_bytes(old)?.as_ref()
            {
                return Err(piv("Replacing image assets is not supported by the frame writer"));
            }
            for (key, value) in new.iter() {
                if let Some(old_value) = old.get(key) {
                    check_assets_unchanged(old_value, value)?;
                }
            }
            Ok(())
        }
        (Value::Arr(old), Value::Arr(new)) => old.iter().zip(new.iter()).try_for_each(|(a, b)| check_assets_unchanged(a, b)),
        _ => Ok(()),
    }
}

/// Validates a complete Pivot 5 payload the writers produced (`_decode(result)`).
pub(crate) fn validate_payload(ctx: &Ctx<'_>, payload: &[u8]) -> PyResult<V5> {
    if payload.first() != Some(&5) {
        // The writers only produce version 5; anything else here is the caller's source.
        return Err(piv("Structural document export currently supports PIV version 5 only"));
    }
    v5::decode(ctx, payload, payload.len(), "", FrameMode::Validate)
}

/// What the frame writer needs from the tables in front of the frames.
pub(crate) struct Tables<'a> {
    pub figures: &'a [FigureInfo],
    pub auto_easing: bool,
    pub trailer: &'a [u8],
}

fn missing() -> &'static Value {
    static NULL: Value = Value::Null;
    &NULL
}

fn uid_of(value: &Value) -> Option<f64> {
    match value {
        Value::Num(n) if n.fract() == 0.0 && (0.0..=4294967295.0).contains(n) => Some(*n),
        _ => None,
    }
}

/// The frame table, frame rate and trailer of `document` (`_encode_piv_document`'s loop).
pub(crate) fn write_frames(ctx: &Ctx<'_>, w: &mut Writer, document: &Value, tables: &Tables<'_>) -> PyResult<()> {
    let frames = py::get(document, "keyframes")?.filter(|f| py::is_list(f) && f.array_len().unwrap_or(0) <= 1_000_000);
    let Some(frames) = frames else {
        return Err(piv("A project must contain between 0 and 1000000 keyframes"));
    };
    let types: HashMap<HKey, &FigureInfo> = tables.figures.iter().map(|figure| (py::hkey_int(figure.id), figure)).collect();
    w.put_count(Fmt::U32, frames.array_len().unwrap_or(0), format_args!("keyframe count"))?;
    for (fi, frame) in py::iter(frames)?.iter().enumerate() {
        ctx.checkpoint()?;
        w.put(Fmt::U16, py::item(&frame, "duration_raw")?, format_args!("keyframe {fi} duration"))?;
        let mix = py::get(&frame, "background_mix")?.cloned().unwrap_or(Value::Num(0.0));
        w.put(Fmt::U8, &mix, format_args!("keyframe {fi} background mix"))?;
        w.put(Fmt::U16, py::get(&frame, "background_id")?.unwrap_or(&Value::Num(0.0)), format_args!("keyframe {fi} background ID"))?;
        if py::truthy(&mix) {
            w.put_opt(Fmt::U16, py::get(&frame, "background_id_b")?, format_args!("keyframe {fi} secondary background ID"))?;
        }
        let Some(input_objects) = py::get(&frame, "objects")?.filter(|objects| py::is_list(objects)) else {
            return Err(piv(format!("keyframe {fi} objects must be a list")));
        };
        let input_objects: Vec<Value> = py::iter(input_objects)?.iter().collect();
        w.put_count(Fmt::U16, input_objects.len(), format_args!("keyframe {fi} object count"))?;
        let mut input_uids: Vec<f64> = Vec::with_capacity(input_objects.len());
        let mut distinct = true;
        for object in &input_objects {
            match py::get(object, "unique_id")?.and_then(uid_of) {
                Some(uid) => input_uids.push(uid),
                None => distinct = false,
            }
        }
        if distinct {
            let mut sorted = input_uids.clone();
            sorted.sort_by(f64::total_cmp);
            distinct = sorted.windows(2).all(|pair| pair[0] != pair[1]);
        }
        if !distinct {
            return Err(piv(format!("keyframe {fi} requires distinct integer object unique IDs")));
        }
        // Records are stored in signed-ID order; joins and layers follow the IDs.
        let signed = |uid: f64| if uid < 2147483648.0 { uid } else { uid - 4294967296.0 };
        let mut order: Vec<usize> = (0..input_objects.len()).collect();
        order.sort_by(|&a, &b| signed(input_uids[a]).total_cmp(&signed(input_uids[b])));
        let slots: HashMap<u64, usize> = order.iter().enumerate().map(|(slot, &index)| (input_uids[index] as u64, slot)).collect();
        for (oi, &index) in order.iter().enumerate() {
            ctx.checkpoint()?;
            let object = &input_objects[index];
            let tid = py::item(object, "figure_type_id")?;
            let Some(figure) = types.get(&py::hkey(tid)?) else {
                return Err(piv(format!("keyframe {fi}, object {oi} has unknown figure type")));
            };
            let count = figure.count;
            w.put(Fmt::U32, py::item(object, "unique_id")?, format_args!("keyframe {fi}, object {oi} unique ID"))?;
            w.put(Fmt::U16, tid, format_args!("keyframe {fi}, object {oi} figure type"))?;
            w.put(Fmt::F32, py::item(object, "scale")?, format_args!("keyframe {fi}, object {oi} scale"))?;
            w.put(Fmt::U32, py::item(object, "color_override_raw")?, format_args!("keyframe {fi}, object {oi} override color"))?;
            w.put(Fmt::U8, py::item(object, "field28")?, format_args!("keyframe {fi}, object {oi} transparency"))?;
            if figure.has_media {
                w.put(Fmt::U8, py::get(object, "image_text_flags")?.unwrap_or(&Value::Num(0.0)), format_args!("keyframe {fi}, object {oi} image/text mirror"))?;
            }
            w.array(ctx, Fmt::F64, Some(py::item(object, "angles")?), count, format_args!("keyframe {fi}, object {oi} angles"))?;
            w.put(Fmt::F32, py::item(object, "root_x")?, format_args!("keyframe {fi}, object {oi} root x"))?;
            w.put(Fmt::F32, py::item(object, "root_y")?, format_args!("keyframe {fi}, object {oi} root y"))?;
            for (field, flag, fmt) in [("lengths", "len_flag", Fmt::F32), ("bends", "bend_flag", Fmt::F64)] {
                let values = py::get(object, field)?;
                let enabled = py::truthy_opt(values);
                let flag_value = match (enabled, py::get(object, flag)?.filter(|f| py::truthy(f))) {
                    (false, _) => Value::Num(0.0),
                    (true, Some(value)) => value.clone(),
                    (true, None) => Value::Num(1.0),
                };
                w.put(Fmt::U16, &flag_value, format_args!("keyframe {fi}, object {oi} {flag}"))?;
                if enabled {
                    w.array(ctx, fmt, values, count, format_args!("keyframe {fi}, object {oi} {field}"))?;
                }
            }
            let join = py::get(object, "join")?.filter(|join| py::truthy(join));
            w.put_count(Fmt::U8, join.is_some() as usize, format_args!("keyframe {fi}, object {oi} join flag"))?;
            if let Some(join) = join {
                let target = if py::contains_key(join, "target_unique_id")? {
                    let wanted = py::item(join, "target_unique_id")?;
                    py::hkey(wanted)?;
                    match uid_of(wanted).and_then(|uid| slots.get(&(uid as u64))) {
                        Some(&slot) => slot,
                        None => return Err(piv(format!("keyframe {fi}, object {oi} joins an object removed from this frame"))),
                    }
                } else {
                    let input_slot = py::get(join, "target_object_slot")?.filter(|s| py::is_int(s) || matches!(s, Value::Bool(_)));
                    let input_slot = input_slot.and_then(|s| if let Value::Bool(b) = s { Some(*b as i64) } else { py::as_int(s) });
                    match input_slot.filter(|&s| 0 <= s && (s as usize) < input_uids.len()) {
                        Some(slot) => slots[&(input_uids[slot as usize] as u64)],
                        None => return Err(piv(format!("keyframe {fi}, object {oi} has an invalid joined object slot"))),
                    }
                };
                w.put_count(Fmt::U16, target, format_args!("keyframe {fi}, object {oi} joined object slot"))?;
                w.put_opt(Fmt::U16, py::get(join, "target_handle_id")?, format_args!("keyframe {fi}, object {oi} joined handle"))?;
            }
        }
        let draw_order: Vec<usize> = if py::contains_key(&frame, "object_draw_order_unique_ids")? {
            let requested = py::item(&frame, "object_draw_order_unique_ids")?;
            let mut ids: Vec<f64> = Vec::new();
            let mut valid = py::is_list(requested);
            if valid {
                for value in py::iter(requested)?.iter() {
                    match value {
                        Value::Num(n) if n.is_finite() && n.fract() == 0.0 => ids.push(n),
                        _ => valid = false,
                    }
                }
                let mut sorted = ids.clone();
                sorted.sort_by(f64::total_cmp);
                valid &= sorted.windows(2).all(|pair| pair[0] != pair[1]);
            }
            if !valid {
                return Err(piv(format!("keyframe {fi} draw-order IDs must be a list without duplicates")));
            }
            // Surviving IDs keep their relative layer order; new objects appear on top.
            let slot_of = |uid: f64| if (0.0..=4294967295.0).contains(&uid) { slots.get(&(uid as u64)).copied() } else { None };
            let mut placed = vec![false; order.len()];
            let mut result = Vec::with_capacity(order.len());
            for slot in ids.iter().filter_map(|&uid| slot_of(uid)) {
                placed[slot] = true;
                result.push(slot);
            }
            result.extend((0..order.len()).filter(|&slot| !placed[slot]));
            result
        } else {
            let count = input_uids.len();
            let input_order: Vec<Value> = match py::get(&frame, "object_draw_order")? {
                None => (0..count).map(|slot| Value::Num(slot as f64)).collect(),
                Some(value) => py::iter(value)?.iter().collect(),
            };
            // `sorted(input_order) != list(range(count))`: sorting compares neighbours first,
            // and a number cannot be compared with anything else.
            let sortable = |value: &Value| matches!(value, Value::Num(_) | Value::Bool(_));
            for pair in input_order.windows(2) {
                let (previous, current) = (&pair[0], &pair[1]);
                let comparable = (sortable(previous) && sortable(current)) || (py::is_str(previous) && py::is_str(current)) || (py::is_list(previous) && py::is_list(current));
                if !comparable {
                    return Err(type_error(format!("'<' not supported between instances of '{}' and '{}'", py::type_name(current), py::type_name(previous))));
                }
            }
            let mut seen = vec![false; count];
            let mut result = Vec::with_capacity(count);
            let mut valid = input_order.len() == count;
            for value in &input_order {
                let slot = match value {
                    Value::Num(n) if n.fract() == 0.0 && *n >= 0.0 && (*n as usize) < count => Some(*n as usize),
                    Value::Bool(flag) if (*flag as usize) < count => Some(*flag as usize),
                    _ => None,
                };
                match slot.filter(|&slot| !seen[slot]) {
                    Some(slot) => {
                        seen[slot] = true;
                        result.push(slots[&(input_uids[slot] as u64)]);
                    }
                    None => valid = false,
                }
            }
            if !valid {
                return Err(piv(format!("keyframe {fi} has invalid draw-order slots")));
            }
            result
        };
        ctx.checkpoint()?;
        for slot in draw_order {
            w.data.extend_from_slice(&(slot as u16).to_le_bytes());
        }
        let camera = py::get(&frame, "camera")?.filter(|camera| py::truthy(camera));
        let field = |name: &str, default: f64| -> PyResult<Value> {
            Ok(match camera {
                None => Value::Num(default),
                Some(camera) => py::get(camera, name)?.cloned().unwrap_or(Value::Num(default)),
            })
        };
        let values = [field("x", 0.0)?, field("y", 0.0)?, field("angle_rad", 0.0)?, field("scale", 1.0)?];
        let at_rest = values.iter().zip([0.0, 0.0, 0.0, 1.0]).all(|(value, rest)| py::eq(value, &Value::Num(rest)));
        let flagged = match camera {
            None => false,
            Some(camera) => py::truthy_opt(py::get(camera, "is_default")?),
        };
        let default = flagged && at_rest;
        w.put_count(Fmt::U8, default as usize, format_args!("keyframe {fi} camera default"))?;
        if !default {
            for (fmt, value) in [Fmt::F32, Fmt::F32, Fmt::F64, Fmt::F32].into_iter().zip(&values) {
                w.put(fmt, value, format_args!("keyframe {fi} camera"))?;
            }
        }
    }
    w.put(Fmt::U32, py::item(document, "fps")?, format_args!("FPS"))?;
    let auto_easing = match py::get(document, "auto_easing")? {
        None => tables.auto_easing,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(piv("auto_easing must be a boolean")),
    };
    let from_file = py::get(document, "auto_easing_source")?.and_then(Value::as_str) == Some("file");
    if !tables.trailer.is_empty() || auto_easing != tables.auto_easing || from_file {
        w.data.push(!auto_easing as u8);
    }
    w.data.extend_from_slice(tables.trailer.get(1..).unwrap_or(&[]));
    Ok(())
}

/// A decoded source the writers work against.
pub(crate) struct Original<'a> {
    pub layout: V5,
    pub payload: std::borrow::Cow<'a, [u8]>,
    pub compressed: bool,
}

/// `_decode(source)` for a writer: the tables as a report, the frames only validated.
pub(crate) fn decode_original<'a>(ctx: &Ctx<'_>, source: &'a [u8]) -> PyResult<Option<Original<'a>>> {
    let (payload, compressed) = unpack_source(source)?;
    let version = crate::reader::Reader::new(&payload).u8()?;
    if version != 5 {
        // A legacy source: decoded for its errors, as `_decode` did before the version test.
        crate::piv::legacy::decode_legacy_payload(ctx, &payload, "")?;
        return Ok(None);
    }
    let layout = v5::decode(ctx, &payload, source.len(), "", FrameMode::Validate)?;
    Ok(Some(Original { layout, payload, compressed }))
}

/// `_encode_piv_document` after its source was decoded: new frames behind the source's tables.
pub(crate) fn encode_frames_only(ctx: &Ctx<'_>, source: &[u8], original: &Original<'_>, document: &Value) -> PyResult<Vec<u8>> {
    ctx.checkpoint()?;
    if !py::get(document, "version")?.is_some_and(|v| py::eq(v, &Value::Num(5.0))) {
        return Err(piv("Structural document export currently supports PIV version 5 only"));
    }
    let report = &original.layout.report;
    for field in ["canvas_width", "canvas_height", "backgrounds", "figure_types"] {
        let ours = report.get(field).unwrap_or(missing());
        match py::get(document, field)? {
            Some(theirs) if same_signature(theirs, ours) => check_assets_unchanged(ours, theirs)?,
            _ => return Err(piv(format!("{field} changes are outside the structural frame writer; use fixed-field edits separately"))),
        }
    }
    let mut w = Writer::default();
    let tables = Tables { figures: &original.layout.figures, auto_easing: original.layout.auto_easing, trailer: &original.layout.trailer };
    write_frames(ctx, &mut w, document, &tables)?;
    let head = &original.payload[..original.layout.frame_start];
    if head.len() + w.data.len() > MAX_PAYLOAD_BYTES {
        return Err(piv("Encoded project exceeds size limit"));
    }
    let mut payload = Vec::with_capacity(head.len() + w.data.len());
    payload.extend_from_slice(head);
    payload.extend_from_slice(&w.data);
    if payload[..] == original.payload[..] {
        return Ok(source.to_vec());
    }
    // References, topology, finite geometry and timings of the result.
    validate_payload(ctx, &payload)?;
    Ok(if original.compressed { zlib::compress(&payload) } else { payload })
}

/// `encode_piv_document`'s error contract: a malformed scene is a `PivError` with the cause.
pub(crate) fn wrap_malformed<T>(result: PyResult<T>) -> PyResult<T> {
    result.map_err(|error| {
        if error.is_any(&[Class::Key, Class::Type, Class::Attribute, Class::Index]) {
            piv(format!("Malformed scene document: {}", error.msg))
        } else {
            error
        }
    })
}
