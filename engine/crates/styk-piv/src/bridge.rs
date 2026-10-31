//! Document-level rules shared by import and export (`codec_bridge.py`):
//! independent validation of an editable document, the embedded original
//! source, the blank Pivot 5 scaffold, and STK import/export.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use styk_doc::Value;

use crate::base64;
use crate::ctx::Ctx;
use crate::error::{PyResult, piv, type_error};
use crate::piv::v5::{MAX_SEGMENTS, sha256_hex};
use crate::py::{self, HKey};
use crate::zlib;

/// Largest embedded original source (`codec_bridge.MAX_SOURCE`).
pub(crate) const MAX_SOURCE: usize = 256 * 1024 * 1024;

/// `isinstance(value, int)`, which a boolean passes.
fn is_int_or_bool(value: &Value) -> bool {
    matches!(value, Value::Bool(_)) || py::is_int(value)
}

fn missing() -> &'static Value {
    static NULL: Value = Value::Null;
    &NULL
}

fn numeric(value: Option<&Value>, label: &str) -> PyResult<()> {
    match value {
        Some(Value::Num(n)) => {
            if n.is_finite() {
                Ok(())
            } else {
                Err(piv(format!("Document contains non-finite {label}")))
            }
        }
        _ => Err(piv(format!("Invalid numeric {label}"))),
    }
}

/// Every number of a pose array is a finite number.
fn numeric_all(value: Option<&Value>, label: &str) -> PyResult<()> {
    match value {
        None => Ok(()),
        Some(Value::Nums(numbers)) => {
            if numbers.iter().all(f64::is_finite) {
                Ok(())
            } else {
                Err(piv(format!("Document contains non-finite {label}")))
            }
        }
        Some(Value::Arr(items)) => items.iter().try_for_each(|item| numeric(Some(item), label)),
        // Iterating a dictionary or a string yields keys and characters, which are not numbers.
        Some(Value::Obj(object)) if object.is_empty() => Ok(()),
        Some(Value::Str(text)) if text.is_empty() => Ok(()),
        Some(Value::Obj(_) | Value::Str(_) | Value::Blob(_)) => Err(piv(format!("Invalid numeric {label}"))),
        Some(other) => Err(type_error(format!("'{}' object is not iterable", py::type_name(other)))),
    }
}

/// `codec_bridge.validate_document`: the editable document is structurally
/// sound, independent of the binary grammar that may have produced it.
pub(crate) fn validate_document(ctx: &Ctx<'_>, document: &Value) -> PyResult<()> {
    ctx.checkpoint()?;
    let supported = |version: Option<&Value>| version.is_some_and(|v| [2.0, 3.0, 4.0, 5.0].iter().any(|&n| py::eq(v, &Value::Num(n))));
    let Some(root) = document.as_obj() else {
        return Err(piv("Not a supported StykAnimate/Pivot document"));
    };
    if !supported(root.get("version")) {
        return Err(piv("Not a supported StykAnimate/Pivot document"));
    }
    if let Some(native) = root.get("_styk").filter(|native| py::truthy(native)) {
        let format_ok = py::get(native, "format")?.is_some_and(|f| f.as_str() == Some("StykAnimate"));
        let version_ok = py::get(native, "format_version")?.is_some_and(|v| py::eq(v, &Value::Num(1.0)));
        if !format_ok || !version_ok {
            return Err(piv("Unsupported StykAnimate native project version"));
        }
    }
    for key in ["canvas_width", "canvas_height"] {
        match root.get(key) {
            Some(Value::Num(n)) if 0.0 < *n && *n <= 100000.0 => {}
            _ => return Err(piv(format!("Invalid {key}"))),
        }
    }
    let fps_ok = match root.get("fps") {
        Some(Value::Num(n)) => 0.0 < *n && *n <= 1000.0,
        Some(Value::Bool(b)) => *b,
        _ => false,
    };
    if !fps_ok {
        return Err(piv("Invalid project frame rate"));
    }
    let figures = root.get("figure_types").filter(|f| py::is_list(f) && py::truthy(f) && f.array_len().unwrap_or(0) <= 65535);
    let Some(figures) = figures else {
        return Err(piv("Invalid figure table"));
    };
    let is_v5 = root.get("version").is_some_and(|v| py::eq(v, &Value::Num(5.0)));
    let frames = root.get("keyframes").filter(|f| py::is_list(f) && (py::truthy(f) || is_v5) && f.array_len().unwrap_or(0) <= 1_000_000);
    let Some(frames) = frames else {
        return Err(piv("Invalid keyframe table"));
    };
    // Per figure type: segment count and the set of joint IDs.
    let mut types: HashMap<HKey, (usize, HashSet<HKey>)> = HashMap::new();
    for figure in py::iter(figures)?.iter() {
        ctx.checkpoint()?;
        let tid = py::get(&figure, "figure_type_id")?.unwrap_or(missing());
        let segments = py::get(&figure, "segments")?.unwrap_or(missing());
        let invalid = || piv("Invalid or duplicate figure definition");
        if !is_int_or_bool(tid) {
            return Err(invalid());
        }
        let tid_key = py::hkey(tid)?;
        let count = segments.array_len().unwrap_or(0);
        if types.contains_key(&tid_key) || !py::is_list(segments) || count == 0 || count > MAX_SEGMENTS {
            return Err(invalid());
        }
        let mut parents: HashMap<HKey, HKey> = HashMap::with_capacity(count);
        let mut order: Vec<HKey> = Vec::with_capacity(count);
        for segment in py::iter(segments)?.iter() {
            let id_value = py::item(&segment, "segment_id")?;
            let parent = py::item(&segment, "parent_id")?;
            let id = py::hkey(id_value)?;
            // A dictionary value may be anything; it is only hashed when the chain is walked.
            let parent_key = py::hkey(parent).unwrap_or(HKey::Str(format!("\u{0}unhashable:{}", py::type_name(parent))));
            if parents.insert(id.clone(), parent_key).is_none() {
                order.push(id);
            }
        }
        if parents.len() != count || parents.contains_key(&py::hkey_int(0)) {
            return Err(piv("Invalid segment identifiers"));
        }
        for segment in py::iter(segments)?.iter() {
            for field in ["length", "angle_rad", "thickness"] {
                numeric(py::get(&segment, field)?, &format!("segment {field}"))?;
            }
            numeric(Some(py::get(&segment, "bend_rad")?.unwrap_or(&Value::Num(0.0))), "segment bend")?;
            let primitive = py::get(&segment, "primitive_code")?.cloned().unwrap_or(Value::Num(0.0));
            if !(0..=6).any(|code| py::eq(&primitive, &Value::Num(code as f64))) {
                return Err(piv("Unsupported segment primitive"));
            }
        }
        let mut seen: HashSet<HKey> = HashSet::from([py::hkey_int(0)]);
        for id in &order {
            let mut cursor = id.clone();
            let mut chain: HashSet<HKey> = HashSet::new();
            while !seen.contains(&cursor) {
                if let HKey::Str(text) = &cursor
                    && let Some(kind) = text.strip_prefix("\u{0}unhashable:")
                {
                    return Err(type_error(format!("unhashable type: '{kind}'")));
                }
                if chain.contains(&cursor) || !parents.contains_key(&cursor) {
                    return Err(piv("Cyclic or missing segment parent"));
                }
                chain.insert(cursor.clone());
                cursor = parents[&cursor].clone();
            }
            seen.extend(chain);
        }
        types.insert(tid_key, (count, parents.into_keys().collect()));
    }
    for frame in py::iter(frames)?.iter() {
        ctx.checkpoint()?;
        let objects = py::get(&frame, "objects")?.unwrap_or(missing());
        let object_count = objects.array_len().unwrap_or(0);
        if !py::is_list(objects) || object_count > 65535 {
            return Err(piv("Invalid frame objects"));
        }
        let objects: Vec<Value> = py::iter(objects)?.iter().collect();
        // Each identity and the last object that carries it.
        let mut uids: HashMap<HKey, usize> = HashMap::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            uids.insert(py::hkey(py::item(object, "unique_id")?)?, index);
        }
        if uids.len() != objects.len() {
            return Err(piv("Duplicate object identity in frame"));
        }
        let mut joined_to: HashMap<HKey, HKey> = HashMap::new();
        let mut join_order: Vec<HKey> = Vec::new();
        for object in &objects {
            ctx.checkpoint()?;
            let tid = py::hkey(py::get(object, "figure_type_id")?.unwrap_or(missing()))?;
            let Some((count, _)) = types.get(&tid) else {
                return Err(piv("Object figure reference or pose length is invalid"));
            };
            let angles = py::get(object, "angles")?;
            if angles.map(py::len).transpose()?.unwrap_or(0) != *count {
                return Err(piv("Object figure reference or pose length is invalid"));
            }
            for field in ["lengths", "bends"] {
                if let Some(values) = py::get(object, field)?.filter(|v| py::truthy(v))
                    && py::len(values)? != *count
                {
                    return Err(piv(format!("Object {field} count does not match its figure")));
                }
            }
            for field in ["root_x", "root_y", "scale"] {
                numeric(py::get(object, field)?, &format!("object {field}"))?;
            }
            for field in ["angles", "lengths", "bends"] {
                numeric_all(py::get(object, field)?, &format!("pose {field}"))?;
            }
            let Some(join) = py::get(object, "join")?.filter(|join| py::truthy(join)) else {
                continue;
            };
            let target_key = match py::get_some(join, "target_unique_id")? {
                Some(target) => py::hkey(target)?,
                None => {
                    let slot = py::get(join, "target_object_slot")?.filter(|s| is_int_or_bool(s)).and_then(|s| match s {
                        Value::Bool(b) => Some(*b as i64),
                        other => py::as_int(other),
                    });
                    let Some(slot) = slot.filter(|&s| 0 <= s && (s as usize) < objects.len()) else {
                        return Err(piv("Invalid joined object slot"));
                    };
                    py::hkey(py::item(&objects[slot as usize], "unique_id")?)?
                }
            };
            let Some(&target_index) = uids.get(&target_key) else {
                return Err(piv("Joined figure references a missing object"));
            };
            let target = &objects[target_index];
            let handle = py::get(join, "target_handle_id")?.unwrap_or(missing());
            let target_type = types.get(&py::hkey(py::item(target, "figure_type_id")?)?);
            let handle_ok = match target_type {
                None => false,
                Some((_, handles)) => py::eq(handle, &Value::Num(0.0)) || handles.contains(&py::hkey(handle)?),
            };
            if !handle_ok {
                return Err(piv("Joined figure references a missing handle"));
            }
            let own = py::hkey(py::item(object, "unique_id")?)?;
            if joined_to.insert(own.clone(), target_key).is_none() {
                join_order.push(own);
            }
        }
        let mut checked: HashSet<HKey> = HashSet::new();
        for start in &join_order {
            let mut uid = start.clone();
            let mut chain: HashSet<HKey> = HashSet::new();
            while joined_to.contains_key(&uid) && !checked.contains(&uid) {
                if chain.contains(&uid) {
                    return Err(piv("Cyclic figure attachments"));
                }
                chain.insert(uid.clone());
                uid = joined_to[&uid].clone();
            }
            checked.extend(chain);
        }
    }
    // The reader admits numbers too large for a double; nothing downstream may see them.
    let mut stack: Vec<&Value> = vec![document];
    let mut visited = 0usize;
    while let Some(item) = stack.pop() {
        visited += 1;
        if visited.is_multiple_of(1024) {
            ctx.checkpoint()?;
        }
        match item {
            Value::Num(n) if !n.is_finite() => return Err(piv("Document contains non-finite numbers")),
            Value::Nums(numbers) if !numbers.iter().all(f64::is_finite) => return Err(piv("Document contains non-finite numbers")),
            Value::Arr(items) => stack.extend(items.iter()),
            Value::Obj(object) => stack.extend(object.values().iter()),
            _ => {}
        }
    }
    Ok(())
}

/// `codec_bridge.source_bytes`: the original Pivot file a native document
/// embeds, checked against its recorded SHA-256.
pub(crate) fn source_bytes(document: &Value) -> PyResult<Option<Arc<[u8]>>> {
    let Some(metadata) = py::get(document, "_stykSource")?.filter(|m| py::truthy(m)) else {
        return Ok(None);
    };
    let limit = MAX_SOURCE * 4 / 3 + 8;
    let source: Arc<[u8]> = match py::get(metadata, "source_base64")? {
        Some(Value::Blob(blob)) if blob.prefix.is_empty() => {
            if blob.text_len() > limit {
                return Err(piv("Invalid embedded original source"));
            }
            blob.bytes.clone()
        }
        Some(encoded) if py::is_str(encoded) => {
            let text = encoded.text().unwrap_or_default();
            if text.chars().count() > limit {
                return Err(piv("Invalid embedded original source"));
            }
            match base64::decode(text.as_bytes(), true) {
                Some(bytes) => Arc::from(bytes),
                None => return Err(piv("Corrupted embedded original source")),
            }
        }
        _ => return Err(piv("Invalid embedded original source")),
    };
    let recorded = py::get(metadata, "sha256")?;
    if recorded.and_then(Value::as_str) != Some(sha256_hex(&source).as_str()) {
        return Err(piv("Embedded original source fingerprint does not match"));
    }
    Ok(Some(source))
}

/// `server.compact_media_aliases`: a decoded figure lists its media twice
/// (`side_tables`, and `image_assets` + `text_assets`); the alias is dropped so
/// the transport carries every sprite and glyph outline once.
pub(crate) fn compact_media_aliases(document: &mut Value) {
    let Some(figures) = document.get("figure_types").and_then(Value::as_arr) else { return };
    let aliased = |figure: &Value| -> bool {
        let Some(side) = figure.get("side_tables").and_then(Value::as_arr) else { return false };
        let list = |key: &str| figure.get(key).and_then(Value::as_arr).unwrap_or(&[]);
        let combined: Vec<&Value> = list("image_assets").iter().chain(list("text_assets").iter()).collect();
        side.len() == combined.len() && side.iter().all(|item| combined.iter().any(|candidate| item.same_node(candidate)))
    };
    let targets: Vec<usize> = figures.iter().enumerate().filter(|(_, figure)| aliased(figure)).map(|(index, _)| index).collect();
    if targets.is_empty() {
        return;
    }
    let Some(figures) = document.make_obj().and_then(|root| root.get_mut("figure_types")).and_then(Value::make_arr) else { return };
    for index in targets {
        if let Some(figure) = figures[index].make_obj() {
            figure.remove("side_tables");
        }
    }
}

/// `codec_bridge.scaffold`: a blank compressed Pivot 5 project of the
/// document's canvas and frame rate, with one empty keyframe.
pub(crate) fn scaffold(document: &Value) -> PyResult<Vec<u8>> {
    let field = |name: &str| -> PyResult<f64> {
        match py::item(document, name)? {
            Value::Num(n) => Ok(n.trunc()),
            Value::Bool(b) => Ok(*b as u8 as f64),
            other => Err(type_error(format!("int() argument must be a string, a bytes-like object or a real number, not '{}'", py::type_name(other)))),
        }
    };
    let pack_u32 = |value: f64| -> PyResult<[u8; 4]> {
        if (0.0..=4294967295.0).contains(&value) {
            Ok((value as u32).to_le_bytes())
        } else {
            Err(crate::error::struct_error("'I' format requires 0 <= number <= 4294967295"))
        }
    };
    let (width, height, fps) = (field("canvas_width")?, field("canvas_height")?, field("fps")?);
    let mut payload = vec![5u8];
    payload.extend_from_slice(&pack_u32(width)?);
    payload.extend_from_slice(&pack_u32(height)?);
    payload.extend_from_slice(&1u16.to_le_bytes());
    payload.extend_from_slice(&2u16.to_le_bytes());
    payload.extend_from_slice(&scaffold_frames(&pack_u32(fps)?));
    payload.push(1);
    Ok(zlib::compress(&payload))
}

/// One empty keyframe with a default camera, then the frame rate (`<IHBHHBI`).
pub(crate) fn scaffold_frames(fps: &[u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.push(0);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.push(1);
    out.extend_from_slice(fps);
    out
}

/// `codec_bridge.inflate_stk`: the figure stream of a compressed STK (a marker
/// byte `0x79`/`0x7a`, then a zlib stream), or `None` for a plain legacy file.
pub(crate) fn inflate_stk(source: &[u8]) -> PyResult<Option<Vec<u8>>> {
    if source.len() < 3 || !matches!(source[0], 0x79 | 0x7a) || source[1] != 0x78 {
        return Ok(None);
    }
    // A damaged stream is a `zlib.error`, which the service reported as a codec failure.
    let inflated = zlib::inflate(&source[1..], MAX_SOURCE + 1).map_err(crate::error::zlib_error)?;
    if inflated.end == zlib::StreamEnd::Limit || inflated.data.len() > MAX_SOURCE {
        return Err(piv("Decompressed STK exceeds the 256 MiB limit"));
    }
    match inflated.end {
        zlib::StreamEnd::Complete { consumed } if consumed == source.len() - 1 => Ok(Some(inflated.data)),
        _ => Err(piv("Truncated STK stream or unexpected trailing data")),
    }
}

/// `pivot_decoder._parse_legacy_payload`, as far as the service depends on it:
/// the number of 24-byte segment records, when the payload is exactly a count
/// byte (optionally after a version byte) followed by that many records.
pub(crate) fn legacy_stk_count(payload: &[u8]) -> Option<usize> {
    if payload.len() >= 2 && payload.len() == 2 + payload[1] as usize * 24 {
        Some(payload[1] as usize)
    } else if !payload.is_empty() && payload.len() == 1 + payload[0] as usize * 24 {
        Some(payload[0] as usize)
    } else {
        None
    }
}

fn topology_error() -> Box<crate::error::PyErr> {
    piv("STK contains missing parents or a cyclic topology")
}

/// `codec_bridge._stk_joint_points`: where every joint of a figure at rest is,
/// with the root at the origin. Records keep their authored order; only those
/// whose parent appears later need a second pass.
pub(crate) fn stk_joint_points(ctx: &Ctx<'_>, segments: &Value) -> PyResult<Vec<(f64, f64)>> {
    fn number(segment: &Value, key: &str) -> PyResult<f64> {
        match py::item(segment, key)? {
            Value::Num(n) => Ok(*n),
            Value::Bool(b) => Ok(*b as u8 as f64),
            other => Err(type_error(format!("must be real number, not {}", py::type_name(other)))),
        }
    }
    let mut order: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    let mut index_of: HashMap<HKey, usize> = HashMap::from([(py::hkey_int(0), 0)]);
    let mut remaining: Vec<Value> = py::iter(segments)?.iter().collect();
    for _ in 0..2 {
        ctx.checkpoint()?;
        let mut pending: Vec<Value> = Vec::new();
        for (index, segment) in remaining.iter().enumerate() {
            if index % 256 == 0 {
                ctx.checkpoint()?;
            }
            let parent = py::hkey(py::item(segment, "parent_id")?)?;
            let Some(&at) = index_of.get(&parent) else {
                pending.push(segment.clone());
                continue;
            };
            let (x, y) = order[at];
            let (a, length) = (number(segment, "angle_rad")?, number(segment, "length")?);
            let bend = match py::get(segment, "bend_rad")? {
                None => 0.0,
                Some(Value::Num(n)) => *n,
                Some(other) => return Err(type_error(format!("bad operand type for abs(): '{}'", py::type_name(other)))),
            };
            let (dx, dy) = if bend.abs() < 1e-8 {
                (length * a.cos(), length * a.sin())
            } else {
                (length / bend * ((a + bend).sin() - a.sin()), length / bend * (a.cos() - (a + bend).cos()))
            };
            let id = py::hkey(py::item(segment, "segment_id")?)?;
            match index_of.get(&id) {
                Some(&existing) => order[existing] = (x + dx, y + dy),
                None => {
                    index_of.insert(id, order.len());
                    order.push((x + dx, y + dy));
                }
            }
        }
        if pending.is_empty() {
            return Ok(order);
        }
        // Order the unresolved records parent first; a missing parent or a cycle is an error.
        let mut by_id: HashMap<HKey, usize> = HashMap::new();
        for (index, segment) in pending.iter().enumerate() {
            by_id.insert(py::hkey(py::item(segment, "segment_id")?)?, index);
        }
        let mut known: HashSet<HKey> = index_of.keys().cloned().collect();
        let mut ordered: Vec<Value> = Vec::with_capacity(pending.len());
        let mut visits = 0usize;
        for segment in &pending {
            let mut cursor = py::hkey(py::item(segment, "segment_id")?)?;
            let mut chain: Vec<usize> = Vec::new();
            let mut visiting: HashSet<HKey> = HashSet::new();
            while !known.contains(&cursor) {
                visits += 1;
                if visits.is_multiple_of(256) {
                    ctx.checkpoint()?;
                }
                let Some(&at) = by_id.get(&cursor).filter(|_| !visiting.contains(&cursor)) else {
                    return Err(topology_error());
                };
                visiting.insert(cursor);
                chain.push(at);
                cursor = py::hkey(py::item(&pending[at], "parent_id")?)?;
            }
            for &at in chain.iter().rev() {
                ordered.push(pending[at].clone());
                known.insert(py::hkey(py::item(&pending[at], "segment_id")?)?);
            }
        }
        remaining = ordered;
    }
    Err(topology_error())
}

/// `codec_bridge.stk_document`: a figure file as a one-figure, one-pose
/// Pivot 5 document, its canvas fitted around the figure.
pub(crate) fn stk_document(ctx: &Ctx<'_>, name: &str, source: &[u8]) -> PyResult<Value> {
    use crate::ctx::{ObjB, empty_list, int, text};
    use crate::error::Class;
    use crate::reader::Reader;
    let payload = inflate_stk(source)?;
    let mut figure: Option<Value> = None;
    if let Some(payload) = &payload {
        // A modern STK is the figure record of a PIV without its trailing name.
        let mut stream = payload.clone();
        stream.push(0);
        let mut reader = Reader::new(&stream);
        let parsed = crate::piv::v5::read_figure(ctx, &mut reader, 2).and_then(|figure| {
            if reader.pos != stream.len() { Err(piv("STK figure stream contains unparsed trailing bytes")) } else { Ok(figure) }
        });
        match parsed {
            Ok(value) => figure = Some(value),
            Err(error) if error.is_any(&[Class::Value, Class::Struct]) => {
                // The legacy layout is authoritative for raw and compressed legacy
                // files; modern corruption never becomes an approximate figure.
                if legacy_stk_count(payload).is_none() {
                    return Err(piv(format!("Unsupported or malformed modern STK: {}", error.msg)));
                }
            }
            Err(error) => return Err(error),
        }
    }
    let figure = match figure {
        Some(mut figure) => {
            if let Some(object) = figure.make_obj() {
                object.set("name", text(crate::store::stem(name)));
                object.set("implicit", Value::Bool(false));
            }
            figure
        }
        None => {
            let raw: &[u8] = payload.as_deref().unwrap_or(source);
            let Some(count) = legacy_stk_count(raw) else {
                return Err(piv("Unsupported STK layout; no approximate import was performed"));
            };
            let mut pos = raw.len() - count * 24;
            let mut segments = Vec::with_capacity(count);
            let mut sprite = false;
            for index in 0..count {
                let mut unbound = 0;
                let mut segment = crate::piv::legacy_v2::segment(raw, &mut pos, index, &mut unbound, false)?;
                segment.value.num("aux_code", segment.is_static as u8);
                segment.value.set("z_order_runtime_raw", int(index));
                sprite |= segment.primitive == 2;
                segments.push(segment.value.build());
            }
            if sprite {
                return Err(piv("Legacy STK sprite requires an embedded image table"));
            }
            let mut decode = ObjB::new();
            decode.set("layout", text("legacy_stk"));
            decode.set("global_style", Value::Null);
            let mut figure = ObjB::new();
            figure.num("figure_type_id", 2.0);
            figure.set("segments", if segments.is_empty() { empty_list() } else { Value::Arr(Arc::new(segments)) });
            figure.set("segment_count", int(count));
            figure.set("polyfills", empty_list());
            figure.set("image_assets", empty_list());
            figure.set("text_assets", empty_list());
            figure.set("side_tables", empty_list());
            figure.set("segment_decode", decode.build());
            figure.set("name", text(crate::store::stem(name)));
            figure.set("implicit", false);
            figure.build()
        }
    };
    let empty = empty_list();
    let segments = figure.get("segments").unwrap_or(&empty);
    // Fit by moving the root: the figure keeps its authored proportions.
    let points = stk_joint_points(ctx, segments)?;
    let fold = |pick: fn(&(f64, f64)) -> f64, better: fn(f64, f64) -> bool| {
        points.iter().map(pick).fold(None, |best: Option<f64>, value| match best {
            Some(current) if !better(value, current) => Some(current),
            _ => Some(value),
        })
    };
    let (max_x, min_x) = (fold(|p| p.0, |a, b| a > b).unwrap_or(0.0), fold(|p| p.0, |a, b| a < b).unwrap_or(0.0));
    let (max_y, min_y) = (fold(|p| p.1, |a, b| a > b).unwrap_or(0.0), fold(|p| p.1, |a, b| a < b).unwrap_or(0.0));
    let width = (max_x - min_x + 120.0).ceil().max(640.0);
    let height = (max_y - min_y + 120.0).ceil().max(480.0);
    let root_x = width / 2.0 - (max_x + min_x) / 2.0;
    let root_y = height / 2.0 - (max_y + min_y) / 2.0;
    let mut angles = Vec::new();
    for segment in py::iter(segments)?.iter() {
        angles.push(py::item(&segment, "angle_rad")?.clone());
    }
    let mut object = ObjB::new();
    object.num("object_slot", 0.0);
    object.num("unique_id", 1.0);
    object.num("figure_type_id", 2.0);
    object.num("scale", 1.0);
    object.num("color_override_raw", 0.0);
    object.num("field28", 0.0);
    object.num("image_text_flags", 0.0);
    object.num("opacity", 1.0);
    object.set("angles", crate::ctx::list(angles));
    object.num("root_x", root_x);
    object.num("root_y", root_y);
    object.set("lengths", empty_list());
    object.set("bends", empty_list());
    object.num("len_flag", 0.0);
    object.num("bend_flag", 0.0);
    object.set("join", Value::Null);
    let mut camera = ObjB::new();
    camera.set("is_default", true);
    camera.num("x", 0.0).num("y", 0.0).num("angle_rad", 0.0).num("scale", 1.0);
    let mut frame = ObjB::new();
    frame.num("keyframe_index", 0.0);
    frame.num("duration_raw", 1.0);
    frame.num("inbetweens", 0.0);
    frame.num("background_id", 0.0);
    frame.num("background_mix", 0.0);
    frame.set("background_id_b", Value::Null);
    frame.set("objects", Value::Arr(Arc::new(vec![object.build()])));
    frame.set("object_draw_order", Value::nums(&[0.0]));
    frame.set("object_draw_order_unique_ids", Value::nums(&[1.0]));
    frame.set("camera", camera.build());
    let mut document = ObjB::new();
    document.num("version", 5.0);
    document.num("canvas_width", width);
    document.num("canvas_height", height);
    document.num("fps", 24.0);
    document.set("auto_easing", false);
    document.set("auto_easing_source", text("file"));
    document.set("backgrounds", empty_list());
    document.set("figure_types", Value::Arr(Arc::new(vec![crate::piv::v5::builtin_man(), figure])));
    document.set("keyframes", Value::Arr(Arc::new(vec![frame.build()])));
    document.num("total_output_frames", 1.0);
    document.num("duration_seconds", 1.0 / 24.0);
    document.set("notes", Value::Arr(Arc::new(vec![text("Imported STK definition retains its original lengths, colors, static nodes, and media.")])));
    Ok(document.build())
}

/// `codec_bridge.export_stk`: one figure definition as a modern STK figure stream.
///
/// The figure goes through the full writer once inside a blank project, which
/// makes its joint IDs dense, orders its records parent first and relocates its
/// media; the normalized record is then written on its own at offset zero.
pub(crate) fn export_stk(ctx: &Ctx<'_>, document: &Value) -> PyResult<Vec<u8>> {
    use crate::piv::decode_piv_bytes;
    use crate::piv::frames::FrameMode;
    use crate::reader::Reader;
    use crate::write::frames::Writer;
    use crate::write::full::{encode_piv_project, write_figure};
    let mut selected = py::get_some(document, "_exportFigureTypeId")?.cloned();
    if selected.is_none() {
        // The first object of the animation says which figure is meant.
        for frame in py::iter(py::item(document, "keyframes")?)?.iter() {
            if let Some(object) = py::iter(py::item(&frame, "objects")?)?.iter().next() {
                selected = Some(py::item(&object, "figure_type_id")?.clone());
                break;
            }
        }
    }
    let selected = selected.unwrap_or(Value::Null);
    let mut chosen = None;
    for figure in py::iter(py::item(document, "figure_types")?)?.iter() {
        if py::eq(py::item(&figure, "figure_type_id")?, &selected) {
            chosen = Some(figure);
            break;
        }
    }
    let Some(mut figure) = chosen else {
        return Err(piv("Select a figure to export as STK"));
    };
    if let Some(object) = figure.make_obj() {
        object.set("figure_type_id", Value::Num(2.0));
        object.set("name", Value::str(""));
        object.set("implicit", Value::Bool(false));
    }
    let blank = scaffold(document)?;
    let mut mini = decode_piv_bytes(ctx, &blank, "", FrameMode::Build)?.report;
    let legacy = match py::item(document, "version")? {
        Value::Num(n) => *n < 5.0,
        Value::Bool(_) => true,
        other => return Err(type_error(format!("'<' not supported between instances of '{}' and 'int'", py::type_name(other)))),
    };
    if legacy {
        figure = crate::write::migrate::migrate_figure(&figure, 2.0)?;
    }
    if let Some(figures) = mini.make_obj().and_then(|root| root.get_mut("figure_types")).and_then(Value::make_arr) {
        figures.push(figure);
    }
    let packed = encode_piv_project(ctx, &scaffold(document)?, &mini, true)?;
    let payload = crate::piv::unpack_source(&packed)?.0.into_owned();
    let mut normalized = match crate::write::full::decoded_figures(ctx, &payload)?.into_iter().nth(1) {
        Some(figure) => figure,
        None => return Err(crate::error::index_error("list index out of range")),
    };
    if let Some(object) = normalized.make_obj() {
        object.set("name", Value::str(""));
    }
    let mut writer = Writer::default();
    write_figure(ctx, &mut writer, &normalized, Some(&normalized), &payload)?;
    // The last byte is the empty name only a project stores.
    let mut stream = writer.data;
    let mut reader = Reader::new(&stream);
    crate::piv::v5::read_figure(ctx, &mut reader, 2)?;
    if reader.pos != stream.len() {
        return Err(piv("Internal STK export validation failed"));
    }
    stream.pop();
    let mut out = vec![0x7a];
    out.extend_from_slice(&zlib::compress(&stream));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(json: &str) -> Value {
        styk_doc::json::parse(json.as_bytes()).unwrap()
    }

    fn chain(count: usize, reverse: bool) -> Value {
        let mut items: Vec<String> = (1..=count).map(|i| format!(r#"{{"segment_id":{},"parent_id":{},"length":1.25,"angle_rad":0,"bend_rad":0}}"#, i, i - 1)).collect();
        if reverse {
            items.reverse();
        }
        segments(&format!("[{}]", items.join(",")))
    }

    /// The fitting before it was made linear: repeated passes over unresolved records.
    fn historical_points(list: &Value) -> Option<Vec<(f64, (f64, f64))>> {
        let mut points: Vec<(f64, (f64, f64))> = vec![(0.0, (0.0, 0.0))];
        let mut remaining: Vec<Value> = list.as_arr().unwrap().to_vec();
        for _ in 0..=remaining.len() {
            let mut pending = Vec::new();
            for segment in &remaining {
                let number = |key: &str| segment.get(key).and_then(Value::as_f64).unwrap_or(0.0);
                let Some(&(_, (x, y))) = points.iter().find(|(id, _)| *id == number("parent_id")) else {
                    pending.push(segment.clone());
                    continue;
                };
                let (a, length, bend) = (number("angle_rad"), number("length"), number("bend_rad"));
                let (dx, dy) = if bend.abs() < 1e-8 { (length * a.cos(), length * a.sin()) } else { (length / bend * ((a + bend).sin() - a.sin()), length / bend * (a.cos() - (a + bend).cos())) };
                points.push((number("segment_id"), (x + dx, y + dy)));
            }
            if pending.is_empty() {
                return Some(points);
            }
            if pending.len() == remaining.len() {
                return None;
            }
            remaining = pending;
        }
        Some(points)
    }

    fn fit(list: &Value) -> PyResult<Vec<(f64, f64)>> {
        let never = || false;
        stk_joint_points(&Ctx::new(&never), list)
    }

    #[test]
    fn joints_are_fitted_exactly_for_every_record_order() {
        let records = [
            r#"{"segment_id":19,"parent_id":0,"length":100.25,"angle_rad":0.15}"#,
            r#"{"segment_id":3,"parent_id":19,"length":75.5,"angle_rad":-0.75,"bend_rad":0.2}"#,
            r#"{"segment_id":47,"parent_id":3,"length":9.125,"angle_rad":2.5,"bend_rad":-0.4}"#,
            r#"{"segment_id":5,"parent_id":19,"length":33.0,"angle_rad":-1.0,"bend_rad":1e-9}"#,
            r#"{"segment_id":11,"parent_id":0,"length":12.0,"angle_rad":3.1,"bend_rad":1e-8}"#,
        ];
        // Every permutation of the five records.
        let mut order = [0usize, 1, 2, 3, 4];
        let mut permutations = vec![order];
        let mut state = [0usize; 5];
        let mut i = 0;
        while i < 5 {
            if state[i] < i {
                order.swap(if i % 2 == 0 { 0 } else { state[i] }, i);
                permutations.push(order);
                state[i] += 1;
                i = 0;
            } else {
                state[i] = 0;
                i += 1;
            }
        }
        assert_eq!(permutations.len(), 120);
        for permutation in permutations {
            let list = segments(&format!("[{}]", permutation.iter().map(|&i| records[i]).collect::<Vec<_>>().join(",")));
            let mut expected: Vec<(f64, f64)> = historical_points(&list).unwrap().into_iter().map(|(_, point)| point).collect();
            let mut actual = fit(&list).unwrap();
            // The same set of points; resolution order may differ.
            expected.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
            actual.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn a_long_reverse_chain_resolves_without_rescanning() {
        let count = 6000;
        let points = fit(&chain(count, true)).unwrap();
        assert_eq!(points.len(), count + 1);
        assert!(points.contains(&(count as f64 * 1.25, 0.0)));
    }

    #[test]
    fn missing_parents_and_cycles_keep_the_fitting_error() {
        for list in [
            r#"[{"segment_id":1,"parent_id":99,"length":1.25,"angle_rad":0}]"#,
            r#"[{"segment_id":1,"parent_id":1,"length":1.25,"angle_rad":0}]"#,
            r#"[{"segment_id":1,"parent_id":2,"length":1.25,"angle_rad":0},{"segment_id":2,"parent_id":1,"length":1.25,"angle_rad":0}]"#,
            r#"[{"segment_id":1,"parent_id":0,"length":1.25,"angle_rad":0},{"segment_id":2,"parent_id":99,"length":1.25,"angle_rad":0}]"#,
        ] {
            let list = segments(list);
            assert!(historical_points(&list).is_none());
            assert_eq!(fit(&list).err().unwrap().msg, "STK contains missing parents or a cyclic topology");
        }
    }

    #[test]
    fn fitting_checks_for_cancellation_at_the_same_points() {
        // (records in reverse order, the poll that cancels)
        for (reverse, stop_at) in [(false, 4), (true, 10)] {
            let polls = std::cell::Cell::new(0);
            let cancel = || {
                polls.set(polls.get() + 1);
                polls.get() == stop_at
            };
            let error = stk_joint_points(&Ctx::new(&cancel), &chain(1024, reverse)).err().unwrap();
            assert_eq!(error.code, "cancelled");
            assert_eq!(polls.get(), stop_at);
        }
    }

    #[test]
    fn validation_reports_what_is_wrong_with_a_document() {
        let never = || false;
        let check = |json: &str| validate_document(&Ctx::new(&never), &styk_doc::json::parse(json.as_bytes()).unwrap()).err().map(|e| e.msg);
        let figure = r#"{"figure_type_id":1,"segments":[{"segment_id":1,"parent_id":0,"length":1,"angle_rad":0,"thickness":1}]}"#;
        let head = r#""version":5,"canvas_width":640,"canvas_height":480,"fps":24"#;
        assert_eq!(check("{}").as_deref(), Some("Not a supported StykAnimate/Pivot document"));
        assert_eq!(check(r#"{"version":5,"canvas_width":0}"#).as_deref(), Some("Invalid canvas_width"));
        assert_eq!(check(r#"{"version":5,"canvas_width":640,"canvas_height":480,"fps":0}"#).as_deref(), Some("Invalid project frame rate"));
        assert_eq!(check(&format!("{{{head},\"figure_types\":[],\"keyframes\":[]}}")).as_deref(), Some("Invalid figure table"));
        assert_eq!(check(&format!("{{{head},\"figure_types\":[{figure}],\"keyframes\":[]}}")), None);
        assert_eq!(check(&format!("{{\"version\":4,\"canvas_width\":1,\"canvas_height\":1,\"fps\":1,\"figure_types\":[{figure}],\"keyframes\":[]}}")).as_deref(), Some("Invalid keyframe table"));
        let pose = |extra: &str| format!("{{{head},\"figure_types\":[{figure}],\"keyframes\":[{{\"objects\":[{{\"unique_id\":1,\"figure_type_id\":1,\"angles\":[0],\"root_x\":0,\"root_y\":0,\"scale\":1{extra}}}]}}]}}");
        assert_eq!(check(&pose("")), None);
        assert_eq!(check(&pose(r#","lengths":[1,2]"#)).as_deref(), Some("Object lengths count does not match its figure"));
        assert_eq!(check(&pose(r#","join":{"target_object_slot":0,"target_handle_id":1}"#)).as_deref(), Some("Cyclic figure attachments"));
        assert_eq!(check(&pose(r#","join":{"target_object_slot":0,"target_handle_id":7}"#)).as_deref(), Some("Joined figure references a missing handle"));
        assert_eq!(check(&pose(r#","opaque":{"deep":[1e999]}"#)).as_deref(), Some("Document contains non-finite numbers"));
    }
}
