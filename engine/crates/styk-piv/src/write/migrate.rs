//! A Pivot 2-4 document as a Pivot 5 project (`piv_migrate.py`).
//!
//! Every legacy figure, including the version's default one, becomes an
//! ordinary custom figure; held poses expand the way Pivot's own compatibility
//! reader expands them (a hold of `h > 1` becomes the same pose twice, lasting
//! `h - 1` and `1`); legacy colours become opaque overrides. Only embedded
//! images are used: nothing is read from a path or a URL.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::ctx::{Ctx, ObjB, empty_list, int, list, text};
use crate::error::{Class, PyResult, piv, type_error};
use crate::piv::decode_piv_bytes;
use crate::piv::frames::FrameMode;
use crate::piv::legacy::keyed_bitmap_png;
use crate::piv::side_tables::blob;
use crate::piv::v5::builtin_man;
use crate::py::{self, HKey};
use crate::write::assets::resolve_image_bytes;
use crate::write::full::encode_piv_project;
use crate::zlib;

/// `_integer`: an integer within bounds, or the error naming the field.
fn integer(value: Option<&Value>, label: &str, low: f64, high: f64) -> PyResult<f64> {
    match value {
        Some(Value::Num(n)) if n.is_finite() && n.fract() == 0.0 && low <= *n && *n <= high => Ok(*n),
        _ => Err(piv(format!("{} must be an integer in [{}, {}]", label, crate::pyfmt::py_number(low), crate::pyfmt::py_number(high)))),
    }
}

/// `_fields`: the named keys of a dictionary that are present, in the given order.
fn fields(value: &Value, names: &[&str]) -> PyResult<Obj> {
    let mut out = Obj::new();
    for name in names {
        if py::contains_key(value, name)? {
            out.set(name, py::item(value, name)?.clone());
        }
    }
    Ok(out)
}

/// `_image_index`.
fn image_index(asset: &Value, fallback: usize) -> PyResult<Value> {
    for key in ["asset_index", "table_index", "image_index", "sprite_index"] {
        if let Some(value) = py::get(asset, key)? {
            return Ok(value.clone());
        }
    }
    Ok(int(fallback))
}

/// `_has_inline`.
fn has_inline(asset: &Value) -> PyResult<bool> {
    for key in ["data_base64", "data_url", "data_uri"] {
        if py::get_some(asset, key)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `_hydrate_from_original`: media a document omitted is taken from the source's
/// decode, matched by table identity. No file is read.
fn hydrate_from_original(document: &mut Value, original: &Value) -> PyResult<()> {
    fn hydrate(asset: &mut Value, old: Option<&Value>) -> PyResult<()> {
        let Some(old) = old.filter(|old| !old.is_null()) else {
            has_inline(asset)?;
            return Ok(());
        };
        if has_inline(asset)? {
            return Ok(());
        }
        for key in ["data_base64", "data_url", "data_uri", "color_key_applied"] {
            if py::contains_key(old, key)?
                && let Some(object) = asset.make_obj()
            {
                object.set(key, py::item(old, key)?.clone());
            }
        }
        Ok(())
    }
    fn list_of(value: &Value, key: &str) -> PyResult<Vec<Value>> {
        match py::get(value, key)? {
            None => Ok(Vec::new()),
            Some(items) => Ok(py::iter(items)?.iter().collect()),
        }
    }
    fn store(value: &mut Value, key: &str, items: Vec<Value>, present: bool) {
        // Only a list holds items that can be hydrated in place.
        let present = present && value.get(key).is_some_and(py::is_list);
        if present && let Some(object) = value.make_obj() {
            object.set(key, list(items));
        }
    }
    let mut backgrounds: HashMap<HKey, Value> = HashMap::new();
    for background in list_of(original, "backgrounds")? {
        backgrounds.insert(py::hkey(py::item(&background, "background_id")?)?, background);
    }
    let present = py::get(document, "backgrounds")?.is_some();
    let mut edited = list_of(document, "backgrounds")?;
    for background in &mut edited {
        let id = py::hkey(py::get(background, "background_id")?.unwrap_or(&Value::Null))?;
        hydrate(background, backgrounds.get(&id))?;
    }
    store(document, "backgrounds", edited, present);
    let mut figures: HashMap<HKey, Value> = HashMap::new();
    for figure in list_of(original, "figure_types")? {
        figures.insert(py::hkey(py::item(&figure, "figure_type_id")?)?, figure);
    }
    let present = py::get(document, "figure_types")?.is_some();
    let mut edited = list_of(document, "figure_types")?;
    for figure in &mut edited {
        let id = py::hkey(py::get(figure, "figure_type_id")?.unwrap_or(&Value::Null))?;
        let mut images: HashMap<HKey, Value> = HashMap::new();
        if let Some(old) = figures.get(&id) {
            for (i, asset) in list_of(old, "image_assets")?.into_iter().enumerate() {
                images.insert(py::hkey(&image_index(&asset, i)?)?, asset);
            }
        }
        for key in ["image_assets", "side_tables"] {
            let present = py::get(figure, key)?.is_some();
            let mut assets = list_of(figure, key)?;
            for (i, asset) in assets.iter_mut().enumerate() {
                if key == "side_tables" && py::get(asset, "kind")?.and_then(Value::as_str) != Some("image") {
                    continue;
                }
                let index = py::hkey(&image_index(asset, i)?)?;
                hydrate(asset, images.get(&index))?;
            }
            store(figure, key, assets, present);
        }
    }
    store(document, "figure_types", edited, present);
    Ok(())
}

fn limitations(asset: &Value) -> PyResult<Option<String>> {
    let Some(reasons) = py::get(asset, "render_limitations")?.filter(|reasons| py::truthy(reasons)) else { return Ok(None) };
    let mut parts = Vec::new();
    for reason in py::iter(reasons)?.iter() {
        match reason.text() {
            Some(text) => parts.push(text.into_owned()),
            None => return Err(type_error(format!("sequence item {}: expected str instance, {} found", parts.len(), py::type_name(&reason)))),
        }
    }
    Ok(Some(format!("Unsupported legacy image conversion: {}", parts.join("; "))))
}

/// `_image`: an embedded legacy image as a modern asset (a keyed BMP sprite becomes its PNG).
fn image(asset: &Value, sprite: bool, index: usize) -> PyResult<Obj> {
    let mut asset = asset.clone();
    if let Some(message) = limitations(&asset)? {
        return Err(piv(message));
    }
    if !has_inline(&asset)? {
        return Err(piv("Legacy migration requires embedded image data or the original source for recovery"));
    }
    // A decoded keyed BMP keeps its source bitmap in `data_uri` and its transparent PNG in `data_url`.
    if !py::contains_key(&asset, "data_url")? && py::contains_key(&asset, "data_uri")? {
        let uri = py::item(&asset, "data_uri")?.clone();
        if let Some(object) = asset.make_obj() {
            object.set("data_url", uri);
        }
    }
    // Legacy byte offsets never reach the modern source-span recovery.
    let inline = Value::object(fields(&asset, &["data_url", "data_base64"])?);
    let mut data = resolve_image_bytes(&inline, &[])?;
    let keyed = sprite && data.starts_with(b"BM") && (py::contains_key(&asset, "transparency_color_raw")? || py::contains_key(&asset, "transparent_color_raw")?);
    if keyed {
        if let Some(object) = asset.make_obj() {
            object.set("data_uri", blob("data:image/bmp;base64,", &data));
            keyed_bitmap_png(object)?;
        }
        if let Some(message) = limitations(&asset)? {
            return Err(piv(message));
        }
        let mut only_url = Obj::new();
        only_url.set("data_url", py::item(&asset, "data_url")?.clone());
        data = resolve_image_bytes(&Value::object(only_url), &[])?;
    }
    let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(b"\xff\xd8") {
        "image/jpeg"
    } else if data.starts_with(b"BM") {
        "image/bmp"
    } else {
        return Err(piv("Migration accepts embedded PNG, JPEG, or BMP images only"));
    };
    let mut out = Obj::new();
    out.set("data_base64", blob("", &data));
    out.set("data_url", blob(&format!("data:{mime};base64,"), &data));
    out.set("mime_type", text(mime));
    if sprite {
        let anchor = |modern: &str, legacy: &str| -> PyResult<Option<Value>> {
            let found = match py::get(&asset, modern)? {
                Some(value) => Some(value),
                None => py::get(&asset, legacy)?,
            };
            Ok(found.filter(|value| value.is_object()).cloned())
        };
        let (Some(start), Some(end)) = (anchor("anchor_start", "pivot")?, anchor("anchor_end", "endpoint")?) else {
            return Err(piv("Legacy sprite requires both attachment anchors"));
        };
        let table_index = image_index(&asset, index)?;
        out.set("kind", text("image"));
        out.set("asset_index", table_index.clone());
        out.set("table_index", table_index);
        out.set("anchor_start", start);
        out.set("anchor_end", end);
    }
    Ok(out)
}

/// `value & mask` on what Python holds as an integer.
fn bit_and(value: &Value, mask: i64) -> PyResult<i64> {
    match value {
        Value::Num(n) if n.is_finite() && n.fract() == 0.0 => Ok((*n as i64) & mask),
        Value::Bool(b) => Ok((*b as i64) & mask),
        other => Err(type_error(format!("unsupported operand type(s) for &: '{}' and 'int'", py::type_name(other)))),
    }
}

/// `_figure`: a legacy figure as a custom figure with the type ID `new_id`.
pub(crate) fn migrate_figure(figure: &Value, new_id: f64) -> PyResult<Value> {
    const SEGMENT_FIELDS: [&str; 16] = [
        "parent_id",
        "segment_id",
        "length",
        "angle_rad",
        "thickness",
        "primitive_code",
        "color_rgb",
        "color_alpha",
        "transparency",
        "secondary",
        "bend_rad",
        "extra_u16",
        "extra_u8_a",
        "extra_u8_b",
        "z_order",
        "z_order_runtime_raw",
    ];
    let empty = Value::object(Obj::new());
    let decode = py::get(figure, "segment_decode")?.unwrap_or(&empty);
    let mut style = Obj::new();
    style.set("global_style", py::get(decode, "global_style")?.cloned().unwrap_or(Value::Null));
    let mut out = Obj::new();
    out.set("figure_type_id", Value::Num(new_id));
    out.set("name", py::get(figure, "name")?.cloned().unwrap_or_else(|| text("Figure")));
    out.set("implicit", Value::Bool(false));
    out.set("segments", empty_list());
    out.set("polyfills", py::get(figure, "polyfills")?.cloned().unwrap_or_else(empty_list));
    out.set("segment_decode", Value::object(style));
    let mut segments = Vec::new();
    for segment in py::iter(py::item(figure, "segments")?)?.iter() {
        let mut s = fields(&segment, &SEGMENT_FIELDS)?;
        let is_static = match py::get(&segment, "is_static")? {
            Some(value) => value.clone(),
            None => Value::Bool(py::truthy(py::get(&segment, "static_raw")?.unwrap_or(&Value::Num(0.0)))),
        };
        // `bool(segment.get('static_raw', 0))` is evaluated even when `is_static` is present.
        let Value::Bool(is_static) = is_static else {
            return Err(piv("Segment is_static must be a boolean"));
        };
        let aux = bit_and(py::get(&segment, "aux_code")?.unwrap_or(&Value::Num(0.0)), 254)? | is_static as i64;
        s.set("is_static", Value::Bool(is_static));
        s.set("aux_code", Value::Num(aux as f64));
        if s.get("primitive_code").is_some_and(|code| py::eq(code, &Value::Num(2.0)) || py::eq(code, &Value::Num(5.0))) {
            let first = |a: &str, b: &str| -> PyResult<Value> {
                Ok(match py::get(&segment, a)? {
                    Some(value) => value.clone(),
                    None => py::get(&segment, b)?.cloned().unwrap_or(Value::Num(0.0)),
                })
            };
            if !s.contains("extra_u16") {
                s.set("extra_u16", first("image_asset_index", "sprite_index")?);
            }
            if !s.contains("extra_u8_a") {
                s.set("extra_u8_a", first("image_flip", "sprite_flip")?);
            }
            if !s.contains("extra_u8_b") {
                s.set("extra_u8_b", Value::Num(0.0));
            }
        }
        segments.push(Value::object(s));
    }
    out.set("segment_count", int(segments.len()));
    out.set("segments", Value::Arr(Arc::new(segments)));
    for key in ["segment_z_raw", "poly_z_raw"] {
        if py::contains_key(figure, key)? {
            out.set(key, py::item(figure, key)?.clone());
        }
    }
    let assets: Vec<Value> = match py::get(figure, "side_tables")?.filter(|side| !side.is_null()) {
        Some(side) => py::iter(side)?.iter().collect(),
        None => {
            let mut combined: Vec<Value> = Vec::new();
            for key in ["image_assets", "text_assets"] {
                if let Some(items) = py::get(figure, key)? {
                    combined.extend(py::star(items)?);
                }
            }
            combined
        }
    };
    let (mut images, mut texts) = (Vec::new(), Vec::new());
    for (index, asset) in assets.iter().enumerate() {
        if py::get(asset, "kind")?.and_then(Value::as_str) == Some("text") {
            // Existing outlines are portable; the full writer validates them.
            texts.push(Value::object(fields(asset, &["kind", "asset_index", "table_index", "font_name", "font_style", "alignment", "text", "glyphs", "placements"])?));
        } else {
            images.push(Value::object(image(asset, true, index)?));
        }
    }
    out.set("image_assets", if images.is_empty() { empty_list() } else { Value::Arr(Arc::new(images)) });
    out.set("text_assets", if texts.is_empty() { empty_list() } else { Value::Arr(Arc::new(texts)) });
    Ok(Value::object(out))
}

/// `_migrate`: the modern document of a legacy one.
fn migrate(ctx: &Ctx<'_>, document: &Value) -> PyResult<Value> {
    let version = py::get(document, "version")?;
    if !version.is_some_and(|v| matches!(v, Value::Num(n) if [2.0, 3.0, 4.0].contains(n))) {
        return Err(piv("Legacy migration accepts Pivot versions 2, 3, and 4 only"));
    }
    let fps = integer(py::get(document, "fps")?, "FPS", 1.0, 1000.0)?;
    let width = integer(py::get(document, "canvas_width")?, "Canvas width", 1.0, 100000.0)?;
    let height = integer(py::get(document, "canvas_height")?, "Canvas height", 1.0, 100000.0)?;
    let figures = py::get(document, "figure_types")?.filter(|f| py::is_list(f) && py::truthy(f) && f.array_len().unwrap_or(0) <= 65533);
    let Some(figures) = figures else {
        return Err(piv("Legacy migration requires 1\u{2013}65533 figures"));
    };
    let figures: Vec<Value> = py::iter(figures)?.iter().collect();
    let mut mapping: HashMap<HKey, f64> = HashMap::new();
    for (i, figure) in figures.iter().enumerate() {
        let id = integer(py::get(figure, "figure_type_id")?, "Figure ID", 1.0, 2147483647.0)?;
        if mapping.insert(py::hkey(&Value::Num(id))?, i as f64 + 2.0).is_some() {
            // Every ID is validated before duplicates are looked for.
            for later in &figures[i + 1..] {
                integer(py::get(later, "figure_type_id")?, "Figure ID", 1.0, 2147483647.0)?;
            }
            return Err(piv("Duplicate legacy figure type IDs"));
        }
    }
    let mut figure_types = vec![builtin_man()];
    for figure in &figures {
        let new_id = mapping[&py::hkey(py::item(figure, "figure_type_id")?)?];
        figure_types.push(migrate_figure(figure, new_id)?);
    }
    let mut backgrounds = Vec::new();
    if let Some(items) = py::get(document, "backgrounds")? {
        for background in py::iter(items)?.iter() {
            let kind = py::get(&background, "kind")?.cloned().unwrap_or(Value::Null);
            py::hkey(&kind)?;
            let kind = match kind.as_str() {
                Some("bmp" | "png") => Value::Num(0.0),
                Some("jpeg" | "jpg") => Value::Num(1.0),
                _ => kind,
            };
            let mut converted = Obj::new();
            converted.set("background_id", py::item(&background, "background_id")?.clone());
            converted.set("name", py::get(&background, "name")?.cloned().unwrap_or_else(|| text("Background")));
            converted.set("kind", kind.clone());
            let is = |codes: &[f64]| codes.iter().any(|&code| py::eq(&kind, &Value::Num(code)));
            if is(&[0.0, 1.0]) {
                let media = image(&background, false, 0)?;
                let jpeg = media.get("mime_type").and_then(Value::as_str) == Some("image/jpeg");
                for (key, value) in media.iter() {
                    converted.set(key, value.clone());
                }
                // Background kind 0 loads PNG and BMP; kind 1 loads JPEG.
                converted.set("kind", Value::Num(jpeg as u8 as f64));
            } else if is(&[2.0, 3.0, 4.0]) {
                for (key, value) in fields(&background, &["color", "color_a", "color_b", "x1", "y1", "x2", "y2"])?.iter() {
                    converted.set(key, value.clone());
                }
            } else {
                return Err(piv("Unsupported legacy background kind"));
            }
            backgrounds.push(Value::object(converted));
        }
    }
    let frames = py::get(document, "keyframes")?.filter(|f| py::is_list(f) && py::truthy(f));
    let Some(frames) = frames else {
        return Err(piv("Legacy migration requires at least one keyframe"));
    };
    let mut keyframes: Vec<Value> = Vec::new();
    let mut ticks = 0.0;
    for frame in py::iter(frames)?.iter() {
        ctx.checkpoint()?;
        let hold = integer(py::get(&frame, "duration_raw")?, "Legacy hold duration", 0.0, 65535.0)?;
        let mut f = fields(&frame, &["background_id", "background_id_b", "background_mix", "camera", "object_draw_order", "object_draw_order_unique_ids"])?;
        let mut objects = Vec::new();
        for object in py::iter(py::item(&frame, "objects")?)?.iter() {
            ctx.checkpoint()?;
            let mut o = fields(&object, &["unique_id", "figure_type_id", "scale", "field28", "image_text_flags", "angles", "root_x", "root_y", "len_flag", "lengths", "bend_flag", "bends", "join"])?;
            let Some(type_id) = o.get("figure_type_id") else {
                return Err(crate::error::key_error("figure_type_id"));
            };
            let Some(&mapped) = mapping.get(&py::hkey(type_id)?) else {
                return Err(piv("Legacy object references an absent figure"));
            };
            o.set("figure_type_id", Value::Num(mapped));
            let raw = integer(py::get(&object, "color_override_raw")?, "Legacy COLORREF", 0.0, 4294967295.0)? as u64;
            let color = 0xff00_0000u64 | if raw & 0x8000_0000 != 0 { 0 } else { raw & 0xff_ffff };
            o.set("color_override_raw", Value::Num(color as f64));
            if !o.contains("field28") {
                o.set("field28", Value::Num(0.0));
            }
            let Some(angles) = o.get("angles") else {
                return Err(crate::error::key_error("angles"));
            };
            let usable = match angles {
                Value::Nums(numbers) => numbers.iter().all(|a| a.is_finite() && a.abs() <= 100.0),
                other => {
                    let mut usable = true;
                    for angle in py::iter(other)?.iter() {
                        usable &= match angle {
                            Value::Num(n) => n.is_finite() && n.abs() <= 100.0,
                            Value::Bool(_) => true,
                            _ => false,
                        };
                    }
                    usable
                }
            };
            if !usable {
                return Err(piv("Legacy angle-reset sentinels or non-finite angles cannot be migrated"));
            }
            objects.push(Value::object(o));
        }
        f.set("objects", if objects.is_empty() { empty_list() } else { Value::Arr(Arc::new(objects)) });
        let durations: Vec<f64> = if hold > 1.0 { vec![hold - 1.0, 1.0] } else { vec![hold] };
        for duration in durations {
            let mut new = f.clone();
            new.set("keyframe_index", int(keyframes.len()));
            new.set("duration_raw", Value::Num(duration));
            new.set("duration_frames", Value::Num(duration));
            new.set("inbetweens", Value::Num(duration - 1.0));
            new.set("duration_semantics", text("inbetweens"));
            keyframes.push(Value::object(new));
        }
        ticks += hold;
    }
    if keyframes.len() > 1_000_000 {
        return Err(piv("Migrated project exceeds the keyframe count limit"));
    }
    if let Some(delay) = py::get_some(document, "frame_delay_ms")?
        && !matches!(delay, Value::Num(_) | Value::Bool(_))
    {
        return Err(type_error(format!("must be real number, not {}", py::type_name(delay))));
    }
    let mut out = ObjB::new();
    out.num("version", 5.0);
    out.num("canvas_width", width);
    out.num("canvas_height", height);
    out.num("fps", fps);
    out.set("auto_easing", false);
    out.set("auto_easing_source", text("file"));
    out.set("backgrounds", if backgrounds.is_empty() { empty_list() } else { Value::Arr(Arc::new(backgrounds)) });
    out.set("figure_types", Value::Arr(Arc::new(figure_types)));
    out.set("keyframes", Value::Arr(Arc::new(keyframes)));
    out.num("total_output_frames", ticks);
    out.num("duration_seconds", ticks / fps);
    let out = out.build();
    // `_finite_tree`: a migrated project holds only finite numbers.
    let mut stack: Vec<&Value> = vec![&out];
    while let Some(item) = stack.pop() {
        match item {
            Value::Num(n) if !n.is_finite() => return Err(piv("Migrated geometry and styles must contain only finite numbers")),
            Value::Nums(numbers) if !numbers.iter().all(f64::is_finite) => return Err(piv("Migrated geometry and styles must contain only finite numbers")),
            Value::Arr(items) => stack.extend(items.iter()),
            Value::Obj(object) => stack.extend(object.values().iter()),
            _ => {}
        }
    }
    Ok(out)
}

/// `migrate_legacy_document`: failures of a malformed document carry their cause.
fn migrate_legacy_document(ctx: &Ctx<'_>, document: &Value) -> PyResult<Value> {
    if !document.is_object() {
        return Err(piv("Legacy document must be an object"));
    }
    migrate(ctx, document).map_err(|error| {
        let wrapped = [Class::Key, Class::Type, Class::Attribute, Class::Index, Class::Value, Class::Struct, Class::Overflow];
        if !error.is(Class::Piv) && error.is_any(&wrapped) && error.exc != crate::error::Exc::Api {
            piv(format!("Cannot migrate legacy project: {}", error.msg))
        } else {
            error
        }
    })
}

/// `migrate_legacy_bytes`: a separate Pivot 5 project from a legacy source and
/// the (possibly edited) document decoded from it.
pub(crate) fn migrate_legacy_bytes(ctx: &Ctx<'_>, source: &[u8], document: Option<&Value>) -> PyResult<Vec<u8>> {
    let original = decode_piv_bytes(ctx, source, "", FrameMode::Build)?;
    if !(2..=4).contains(&original.version) {
        return Err(piv("Legacy migration accepts Pivot versions 2, 3, and 4 only"));
    }
    if document.is_some_and(|document| !document.is_object()) {
        return Err(piv("Legacy document must be an object"));
    }
    let mut edited = document.cloned().unwrap_or_else(|| original.report.clone());
    ctx.checkpoint()?;
    if !py::get(&edited, "version")?.is_some_and(|v| py::eq(v, &Value::Num(original.version as f64))) {
        return Err(piv("Edited document version does not match the original legacy source"));
    }
    let fingerprint = original.report.get("source_sha256").cloned().unwrap_or(Value::Null);
    if py::get(&edited, "source_sha256")?.is_some_and(|recorded| !py::eq(recorded, &fingerprint)) {
        return Err(piv("Edited document belongs to a different original source"));
    }
    hydrate_from_original(&mut edited, &original.report).map_err(|error| {
        if error.is_any(&[Class::Key, Class::Type, Class::Attribute, Class::Index]) {
            piv(format!("Malformed legacy asset tables: {}", error.msg))
        } else {
            error
        }
    })?;
    let modern = migrate_legacy_document(ctx, &edited)?;
    // One empty keyframe, the implicit figure slot, no background, easing off.
    let number = |key: &str| modern.get(key).and_then(Value::as_f64).unwrap_or(0.0) as u32;
    let mut scaffold = vec![5u8];
    scaffold.extend_from_slice(&number("canvas_width").to_le_bytes());
    scaffold.extend_from_slice(&number("canvas_height").to_le_bytes());
    scaffold.extend_from_slice(&1u16.to_le_bytes());
    scaffold.extend_from_slice(&2u16.to_le_bytes());
    scaffold.extend_from_slice(&crate::bridge::scaffold_frames(&number("fps").to_le_bytes()));
    scaffold.push(1);
    encode_piv_project(ctx, &zlib::compress(&scaffold), &modern, true)
}
