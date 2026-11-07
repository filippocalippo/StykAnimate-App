//! `validateDrawings(report)` (src/drawing-model.mjs): drawing cels and the layers that hold them.

use std::collections::HashSet;

use styk_doc::Value;

use super::js::*;
use crate::EditError;

const TILE_BLOB_PREFIX: &str = "data:application/x-styk-tiles;base64,";
/// `4 * Math.ceil(96 MiB / 3)`.
const TILE_BLOB_MAX_CHARACTERS: usize = 134_217_728;
const PNG_PREFIX: &str = "data:image/png;base64,";
const DRAWING_MAX_PIXELS: f64 = 16.0 * 1024.0 * 1024.0;

/// A string field as the checks here read it: its first characters and its length in UTF-16 units,
/// without building the text of a large embedded payload.
struct Text {
    head: String,
    length: usize,
}

fn text_of(value: V, head_chars: usize) -> Option<Text> {
    match value? {
        Value::Str(s) => Some(Text { head: s.chars().take(head_chars).collect(), length: js_len(s) }),
        Value::Blob(blob) => {
            let bytes = (head_chars.saturating_sub(blob.prefix.chars().count()) / 4 + 1) * 3;
            let mut text = String::from(&*blob.prefix);
            styk_doc::json::base64_into(&blob.bytes[..bytes.min(blob.bytes.len())], unsafe { text.as_mut_vec() });
            Some(Text { head: text.chars().take(head_chars).collect(), length: blob.text_len() })
        }
        _ => None,
    }
}

/// `atob(text)` for the few characters of a PNG header.
fn atob(text: &str) -> Option<Vec<u8>> {
    let mut chars: Vec<u8> = Vec::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\t' | '\n' | '\u{c}' | '\r' | ' ' => {}
            c if c.is_ascii() => chars.push(c as u8),
            _ => return None,
        }
    }
    if chars.len() % 4 == 0 {
        for _ in 0..2 {
            if chars.last() == Some(&b'=') {
                chars.pop();
            }
        }
    }
    if chars.len() % 4 == 1 || !chars.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/') {
        return None;
    }
    let value = |b: u8| match b {
        b'A'..=b'Z' => b - b'A',
        b'a'..=b'z' => b - b'a' + 26,
        b'0'..=b'9' => b - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = Vec::new();
    for group in chars.chunks(4) {
        let v: Vec<u32> = group.iter().map(|b| value(*b) as u32).collect();
        let n = v.iter().enumerate().fold(0u32, |acc, (i, x)| acc | (x << (18 - 6 * i as u32)));
        out.push((n >> 16) as u8);
        if v.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if v.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// `validateDrawingFigure(figure)`.
fn drawing_figure(figure: &Value) -> Result<(), EditError> {
    let d = path(Some(figure), &["_styk", "drawing"]);
    if missing(d) {
        return Ok(());
    }
    if is_null(d) {
        return Err(refuse(TYPE_ERROR));
    }
    let point = |p: V| truthy(p) && finite(get(p, "x")) && finite(get(p, "y"));
    let cel = text(get(d, "celId"));
    let cel_ok = cel.is_some_and(|id| id.strip_prefix("cel-").is_some_and(|rest| (1..=100).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')));
    let identity = !cel_ok
        || !matches!(num(get(d, "pixelsPerUnit")), Some(p) if p == 1.0 || p == 2.0 || p == 4.0)
        || !safe_integer(get(d, "revision"))
        || num(get(d, "revision")).unwrap() < 0.0;
    let version = num(get(d, "version"));
    if version == Some(1.0) {
        let crop = get(d, "crop");
        let (width, height) = (num(get(d, "width")), num(get(d, "height")));
        let dimension = |v: V| integer(v) && num(v).unwrap() > 0.0 && num(v).unwrap() <= 8192.0;
        let invalid = identity
            || !dimension(get(d, "width"))
            || !dimension(get(d, "height"))
            || width.unwrap() * height.unwrap() > DRAWING_MAX_PIXELS
            || !point(get(d, "origin"))
            || !point(crop)
            || !["x", "y", "width", "height"].iter().all(|k| integer(get(crop, k)))
            || num(get(crop, "x")).unwrap() < 0.0
            || num(get(crop, "y")).unwrap() < 0.0
            || num(get(crop, "width")).unwrap() < 1.0
            || num(get(crop, "height")).unwrap() < 1.0
            || num(get(crop, "x")).unwrap() + num(get(crop, "width")).unwrap() > width.unwrap()
            || num(get(crop, "y")).unwrap() + num(get(crop, "height")).unwrap() > height.unwrap()
            || !boolean(get(d, "empty"));
        if invalid {
            return fail("errors.drawingModel.invalidDrawingMetadataOrPaintDimensions");
        }
    } else if version == Some(2.0) {
        let bounds = get(d, "bounds");
        let limit = 2_147_483_648.0 * 64.0;
        let rect = truthy(bounds)
            && ["x", "y", "width", "height"].iter().all(|k| safe_integer(get(bounds, k)))
            && num(get(bounds, "width")).unwrap() > 0.0
            && num(get(bounds, "height")).unwrap() > 0.0
            && num(get(bounds, "x")).unwrap() >= -limit
            && num(get(bounds, "y")).unwrap() >= -limit
            && num(get(bounds, "x")).unwrap() + num(get(bounds, "width")).unwrap() <= limit
            && num(get(bounds, "y")).unwrap() + num(get(bounds, "height")).unwrap() <= limit;
        if identity || !(is_null(bounds) || rect) {
            return fail("errors.drawingModel.invalidDrawingMetadata");
        }
    } else {
        return fail("errors.drawingModel.invalidDrawingMetadataOrPaintDimensions");
    }
    let assets = figure.get("image_assets");
    let a = assets.and_then(|list| list.item(0));
    let a = a.as_ref();
    let segments = figure.get("segments");
    let data_url = get(a, "data_url");
    let data = text_of(data_url, 66);
    let carrier_ok = len(segments) == 1
        && text(path(segments.and_then(|s| s.item(0)).as_ref(), &["segment_type"])) == Some("image")
        && {
            // `figure.image_assets.length`: a figure without the table throws.
            if missing(assets) {
                return Err(refuse(TYPE_ERROR));
            }
            len(assets) == 1
        }
        && data.as_ref().is_some_and(|t| t.head.starts_with(PNG_PREFIX))
        && if version == Some(1.0) {
            let crop = get(d, "crop");
            (num(get(a, "width")) == num(get(crop, "width")) && num(get(a, "height")) == num(get(crop, "height")))
                || (matches!(get(d, "empty"), Some(Value::Bool(true))) && num(get(a, "width")) == Some(1.0) && num(get(a, "height")) == Some(1.0))
        } else {
            ["width", "height", "display_width", "display_height"].iter().all(|k| num(get(a, k)) == Some(1.0))
        };
    if !carrier_ok {
        return fail("errors.drawingModel.aDrawingNeedsOneEmbeddedPngSpriteMatching");
    }
    let data = data.unwrap();
    if data.length > 96 * 1024 * 1024 {
        return fail("errors.drawingModel.drawingPngExceedsTheAssetLimit");
    }
    let tiles = get(a, "styk_tiles");
    if version == Some(2.0) && !missing(tiles) {
        let ok = text_of(tiles, TILE_BLOB_PREFIX.len()).is_some_and(|t| t.head.starts_with(TILE_BLOB_PREFIX) && t.length <= TILE_BLOB_PREFIX.len() + TILE_BLOB_MAX_CHARACTERS);
        if !ok {
            return fail("errors.drawingModel.invalidDrawingTileBlob");
        }
    }
    let encoded: String = data.head.chars().skip(22).take(44).collect();
    let header = atob(&encoded);
    let Some(header) = header.filter(|h| h.len() >= 24 && h[..8] == [137, 80, 78, 71, 13, 10, 26, 10]) else {
        return fail("errors.drawingModel.invalidDrawingPngHeader");
    };
    let read = |at: usize| u32::from_be_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]]) as f64;
    if Some(read(16)) != num(get(a, "width")) || Some(read(20)) != num(get(a, "height")) {
        return fail("errors.drawingModel.drawingPngDimensionsDoNotMatchItsMetadata");
    }
    Ok(())
}

/// `validateDrawings(report)`.
pub(super) fn validate(report: &Value) -> Result<(), EditError> {
    let mut ids: HashSet<String> = HashSet::new();
    let figures = report.get("figure_types");
    for figure in if is_given(figures) { items(figures) } else { Vec::new() } {
        drawing_figure(&figure)?;
        let cel = path(Some(&figure), &["_styk", "drawing"]);
        if !truthy(cel) {
            continue;
        }
        let id = get(cel, "celId").map(|v| styk_doc::json::to_string(v)).unwrap_or_default();
        if !ids.insert(id) {
            return fail("errors.drawingModel.drawingCelIdentitiesMustBeUnique");
        }
    }
    let layers = path(Some(report), &["_styk", "layers"]);
    let sheet = path(Some(report), &["_styk", "layerSheet"]);
    if !truthy(layers) || !truthy(sheet) {
        return Ok(());
    }
    let by_id = get(layers, "byId");
    for (id, layer) in entries(if is_given(by_id) { by_id } else { None }) {
        let layer = prop(Some(layer), "drawing")?;
        if !truthy(layer) {
            continue;
        }
        let tracks = get(sheet, "tracks");
        for key in items(path(tracks, &[&id, "keys"])) {
            let frame_id = path(Some(&key), &["value", "frameId"]);
            if !truthy(frame_id) {
                continue;
            }
            let Some(frame) = keyed_frame(report, frame_id.unwrap()) else { continue };
            let listed = prop(Some(&frame), "objects")?;
            if !is_array(listed) {
                return Err(refuse(TYPE_ERROR));
            }
            let objects: Vec<Value> = items(listed)
                .into_iter()
                .filter(|o| {
                    let key = o.get("unique_id").map(|u| property_name(u)).unwrap_or_default();
                    key.as_deref().and_then(|k| get(get(layers, "assignments"), k)).is_some_and(|assigned| assigned.as_str() == Some(&id))
                })
                .collect();
            let drawn = |o: &Value| {
                let type_id = o.get("figure_type_id");
                items(figures).iter().find(|f| f.get("figure_type_id") == type_id && type_id.is_some()).is_some_and(|f| truthy(path(Some(f), &["_styk", "drawing"])))
            };
            if objects.len() > 1 || objects.iter().any(|o| !drawn(o)) {
                return fail("errors.drawingModel.drawingLayersMustContainOneDrawingCelPer");
            }
        }
    }
    Ok(())
}

/// The frame a key of a layer shows: the pose a sheet retains under that name, else the last keyframe that carries the identity.
fn keyed_frame(report: &Value, frame_id: &Value) -> Option<Value> {
    let name = property_name(frame_id);
    let retained = path(Some(report), &["_styk", "frameSources"]).and_then(|sources| name.as_deref().and_then(|n| sources.get(n)));
    let by_frame: Option<Value> = if is_given(retained) {
        retained.cloned()
    } else {
        items(report.get("keyframes")).into_iter().rev().find(|f| path(Some(f), &["_styk", "frameId"]) == Some(frame_id))
    };
    by_frame.filter(|f| !f.is_null())
}

/// The property name a value reads as.
fn property_name(value: &Value) -> Option<String> {
    match value {
        Value::Str(s) => Some(s.to_string()),
        Value::Num(n) => Some(number_text(*n)),
        _ => None,
    }
}

/// Figures that a drawing layer's own frames show beside its cel, or instead of one: what opening refuses (`drawingLayersMustContainOneDrawingCelPer`).
/// A figure assigned to a drawing layer that no frame the layer keys shows (a movieclip placed while one was active is a replacement, which
/// is not a key's frame) is not one: opening has always kept it where it was saved, and so does the repair below.
fn refused_on_drawing_layers(report: &Value, drawing_layers: &HashSet<String>, drawn: &HashSet<u64>) -> HashSet<String> {
    let mut refused = HashSet::new();
    let assignments = path(Some(report), &["_styk", "layers", "assignments"]);
    let sheet = path(Some(report), &["_styk", "layerSheet"]);
    for id in drawing_layers {
        for key in items(path(sheet, &["tracks", id.as_str(), "keys"])) {
            let Some(frame_id) = path(Some(&key), &["value", "frameId"]).filter(|frame_id| truthy(Some(*frame_id))) else { continue };
            let Some(frame) = keyed_frame(report, frame_id) else { continue };
            let here: Vec<(String, bool)> = items(frame.get("objects"))
                .iter()
                .filter_map(|object| {
                    let uid = object.get("unique_id").and_then(property_name)?;
                    let assigned = get(assignments, &uid).is_some_and(|layer| layer.as_str() == Some(id.as_str()));
                    assigned.then(|| (uid, num(object.get("figure_type_id")).is_some_and(|kind| drawn.contains(&kind.to_bits()))))
                })
                .collect();
            if here.len() > 1 || here.iter().any(|(_, cel)| !cel) {
                refused.extend(here.into_iter().filter(|(_, cel)| !cel).map(|(uid, _)| uid));
            }
        }
    }
    refused
}

/// Figures assigned to a drawing layer, which holds only drawing cels (older builds assigned a movieclip placed while one was active), given
/// the layer new figures go to when opening would refuse the file for them. Says how many assignments it changed.
pub(super) fn repair_assignments(report: &mut Value) -> usize {
    let drawing_layers: HashSet<String> = entries(path(Some(report), &["_styk", "layers", "byId"]))
        .into_iter()
        .filter(|(_, layer)| truthy(get(Some(layer), "drawing")))
        .map(|(id, _)| id.to_string())
        .collect();
    if drawing_layers.is_empty() {
        return 0;
    }
    let default = path(Some(report), &["_styk", "layers", "defaultLayerId"]).and_then(Value::as_str).filter(|id| !drawing_layers.contains(*id)).map(str::to_string);
    let Some(default) = default else { return 0 };
    let drawn: HashSet<u64> = items(report.get("figure_types")).iter().filter(|f| truthy(path(Some(f), &["_styk", "drawing"]))).filter_map(|f| num(f.get("figure_type_id")).map(f64::to_bits)).collect();
    let mut figures: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let frames = items(report.get("keyframes")).into_iter().chain(entries(path(Some(report), &["_styk", "frameSources"])).into_iter().map(|(_, frame)| frame.clone()));
    for frame in frames {
        for object in items(frame.get("objects")) {
            if let (Some(uid), Some(type_id)) = (object.get("unique_id").and_then(property_name), num(object.get("figure_type_id"))) {
                let entry = figures.entry(uid).or_insert(true);
                *entry &= drawn.contains(&type_id.to_bits());
            }
        }
    }
    let refused = refused_on_drawing_layers(report, &drawing_layers, &drawn);
    let wrong: Vec<String> = entries(path(Some(report), &["_styk", "layers", "assignments"]))
        .into_iter()
        .filter(|(uid, layer)| layer.as_str().is_some_and(|layer| drawing_layers.contains(layer)) && figures.get(&**uid) == Some(&false) && refused.contains(&**uid))
        .map(|(uid, _)| uid.to_string())
        .collect();
    let assignments = report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj).and_then(|s| s.get_mut("layers")).and_then(Value::make_obj).and_then(|l| l.get_mut("assignments")).and_then(Value::make_obj);
    if let Some(assignments) = assignments {
        for uid in &wrong {
            assignments.set(uid, Value::str(&default));
        }
    }
    wrong.len()
}
