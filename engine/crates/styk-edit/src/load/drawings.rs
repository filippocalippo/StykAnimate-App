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

/// Whether a drawing figure keeps what makes it a drawing: one segment, which is an image, and the one picture it carries.
pub(crate) fn keeps_its_image(figure: &Value) -> bool {
    let segments = items(figure.get("segments"));
    segments.len() == 1 && text(get(segments.first(), "segment_type")) == Some("image") && items(figure.get("image_assets")).len() == 1
}

/// What a damaged cel needs of its objects: how many segments it had, where its image segment was, and that segment's identity.
struct CelRepair {
    segments: usize,
    kept: usize,
    segment_id: Option<Value>,
}

/// A cel that has more than its one image segment (a build that let another be added to it wrote files opening refused) keeps the image segment
/// and its picture: the other segments, the polygons and what refers to them go, in the definition and in the poses of every object of it. Says
/// how many definitions it mended (each is one repair); runs on every document the project holds, as the other repairs do.
pub(super) fn repair_cels(report: &mut Value) -> usize {
    let mut definitions = items(report.get("figure_types"));
    let mut specs: std::collections::HashMap<u64, CelRepair> = std::collections::HashMap::new();
    let mut mended = 0usize;
    for figure in definitions.iter_mut() {
        if !truthy(path(Some(figure), &["_styk", "drawing"])) {
            continue;
        }
        let Some(id) = num(figure.get("figure_type_id")) else { continue };
        let segments = items(figure.get("segments"));
        if segments.len() == 1 {
            // Whole already (or mended by a parent whose figures this document inherits): its objects may still carry the poses of the segments it had.
            specs.entry(id_key(id)).or_insert(CelRepair { segments: 0, kept: 0, segment_id: segments[0].get("segment_id").cloned() });
            continue;
        }
        let Some(kept) = segments.iter().position(|segment| text(segment.get("segment_type")) == Some("image")) else { continue };
        let mut image = segments[kept].clone();
        if let Some(segment) = image.make_obj() {
            segment.set("parent_id", Value::Num(0.0));
        }
        let segment_id = image.get("segment_id").cloned();
        if let Some(record) = figure.make_obj() {
            record.set("segments", Value::array(vec![image]));
            record.set("segment_count", Value::Num(1.0));
            record.set("polyfills", Value::array(Vec::new()));
        }
        specs.insert(id_key(id), CelRepair { segments: segments.len(), kept, segment_id });
        mended += 1;
    }
    if specs.is_empty() {
        return 0;
    }
    // The poses: an array that has one entry for each of the segments the cel had keeps the entry of its image segment; a longer one keeps its first.
    let pose = |object: &Value, spec: &CelRepair| -> Option<Value> {
        let mut changed = false;
        let mut record = object.as_obj().cloned()?;
        for key in ["angles", "lengths", "bends"] {
            let values = items(record.get(key));
            if values.len() > 1 {
                let at = if values.len() == spec.segments { spec.kept } else { 0 };
                record.set(key, Value::array(vec![values[at.min(values.len() - 1)].clone()]));
                changed = true;
            }
        }
        if let Some(controllers) = record.get("_stykIK").and_then(Value::as_obj).filter(|controllers| controllers.len() > 0) {
            let kept: Vec<(String, Value)> = controllers
                .iter()
                .filter(|(key, _)| spec.segment_id.as_ref().and_then(Value::as_f64).is_some_and(|id| key.parse::<f64>().ok() == Some(id)))
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect();
            if kept.len() != controllers.len() {
                let mut next = styk_doc::Obj::new();
                for (key, value) in kept {
                    next.set(&key, value);
                }
                record.set("_stykIK", Value::object(next));
                changed = true;
            }
        }
        changed.then(|| Value::object(record))
    };
    let frame = |frame: &Value| -> Option<Value> {
        let objects = items(frame.get("objects"));
        let mut changed = false;
        let next: Vec<Value> = objects
            .into_iter()
            .map(|object| match num(object.get("figure_type_id")).and_then(|id| specs.get(&id_key(id))).and_then(|spec| pose(&object, spec)) {
                Some(fixed) => {
                    changed = true;
                    fixed
                }
                None => object,
            })
            .collect();
        if !changed {
            return None;
        }
        let mut record = frame.as_obj().cloned()?;
        record.set("objects", Value::array(next));
        Some(Value::object(record))
    };
    let mut pose_changed = false;
    let keyframes: Vec<Value> = items(report.get("keyframes")).into_iter().map(|each| frame(&each).inspect(|_| pose_changed = true).unwrap_or(each)).collect();
    let sources: Vec<(String, Value)> = entries(path(Some(report), &["_styk", "frameSources"])).into_iter().map(|(id, each)| (id.to_string(), frame(each).inspect(|_| pose_changed = true).unwrap_or_else(|| each.clone()))).collect();
    let Some(record) = report.make_obj() else { return mended };
    if mended > 0 {
        record.set("figure_types", Value::array(definitions));
    }
    if pose_changed {
        record.set("keyframes", Value::array(keyframes));
        if let Some(styk) = record.get_mut("_styk").and_then(Value::make_obj)
            && let Some(table) = styk.get_mut("frameSources").and_then(Value::make_obj)
        {
            for (id, each) in sources {
                table.set(&id, each);
            }
        }
        // Poses mended in a document whose definition was whole already (a retained scene, inheriting its figures) are a repair of their own.
        if mended == 0 {
            mended = 1;
        }
    }
    mended
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
                    assigned.then(|| (uid, num(object.get("figure_type_id")).is_some_and(|kind| drawn.contains(&id_key(kind)))))
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
    let drawn: HashSet<u64> = items(report.get("figure_types")).iter().filter(|f| truthy(path(Some(f), &["_styk", "drawing"]))).filter_map(|f| num(f.get("figure_type_id")).map(id_key)).collect();
    let mut figures: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let frames = items(report.get("keyframes")).into_iter().chain(entries(path(Some(report), &["_styk", "frameSources"])).into_iter().map(|(_, frame)| frame.clone()));
    for frame in frames {
        for object in items(frame.get("objects")) {
            if let (Some(uid), Some(type_id)) = (object.get("unique_id").and_then(property_name), num(object.get("figure_type_id"))) {
                let entry = figures.entry(uid).or_insert(true);
                *entry &= drawn.contains(&id_key(type_id));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A project whose drawing layer keys a frame that shows its cel: the cel's definition has the figure id 0, and the instance in the frame
    /// names it -0 (both are the number zero, and opening takes them for one figure).
    fn project() -> Value {
        let mut report = styk_doc::json::parse(
            br#"{"figure_types":[{"figure_type_id":0,"segments":[],"_styk":{"drawing":{"version":2,"celId":"cel-a","pixelsPerUnit":1,"revision":0,"bounds":null}}}],
                "keyframes":[{"_styk":{"frameId":"f1"},"objects":[{"unique_id":5,"figure_type_id":0}]}],
                "_styk":{"layers":{"byId":{"layer-1":{"name":"Layer 1"},"layer-2":{"name":"Layer 2","drawing":{"version":1}}},"defaultLayerId":"layer-1","assignments":{"5":"layer-2"}},
                  "layerSheet":{"tracks":{"layer-2":{"keys":[{"id":"cell-1","tick":0,"value":{"frameId":"f1"}}]}}}}}"#,
        ).unwrap();
        let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
        objects[0].make_obj().unwrap().set("figure_type_id", Value::Num(-0.0));
        report
    }

    #[test]
    fn a_cel_whose_instance_names_it_with_a_signed_zero_stays_on_its_drawing_layer() {
        let mut report = project();
        assert_eq!(repair_assignments(&mut report), 0, "the cel is a cel: nothing is moved");
        assert_eq!(report.path(&["_styk", "layers", "assignments", "5"]).and_then(Value::as_str), Some("layer-2"));
    }

    #[test]
    fn a_figure_that_is_not_a_cel_is_still_moved_off_a_drawing_layer_when_opening_refuses_it() {
        let mut report = project();
        // The definition is no cel any more: the keyed frame shows a figure beside no cel, which opening refuses.
        report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap().remove("_styk");
        assert_eq!(repair_assignments(&mut report), 1);
        assert_eq!(report.path(&["_styk", "layers", "assignments", "5"]).and_then(Value::as_str), Some("layer-1"));
    }

    /// A project with a cel that has a second segment (appended, with an entry in the poses of every object of the cel), as the build that let one be added wrote it.
    fn damaged() -> Value {
        styk_doc::json::parse(
            br#"{"figure_types":[{"figure_type_id":7,"segment_count":2,"polyfills":[{"polygon_id":1}],
                  "segments":[{"segment_id":1,"parent_id":0,"segment_type":"image","length":256},{"segment_id":99,"parent_id":1,"segment_type":"line","length":30}],
                  "image_assets":[{"width":1,"height":1}],"_styk":{"drawing":{"version":2,"celId":"cel-a","pixelsPerUnit":1,"revision":1,"bounds":null}}}],
                "keyframes":[{"objects":[{"unique_id":5,"figure_type_id":7,"angles":[0.5,0.25],"len_flag":1,"lengths":[256,30],"_stykIK":{"1":{"enabled":false},"99":{"enabled":false}}}]}],
                "_styk":{"frameSources":{"pose":{"objects":[{"unique_id":5,"figure_type_id":7,"angles":[0.75,0]}]}}}}"#,
        )
        .unwrap()
    }

    #[test]
    fn a_cel_with_a_second_segment_keeps_its_image_and_the_poses_of_it_and_is_whole_afterwards() {
        let mut report = damaged();
        assert!(!keeps_its_image(&items(report.get("figure_types"))[0]));
        assert_eq!(repair_cels(&mut report), 1, "one definition mended");
        let cel = items(report.get("figure_types"))[0].clone();
        assert!(keeps_its_image(&cel));
        assert_eq!(styk_doc::json::to_string(cel.get("segments").unwrap()), r#"[{"segment_id":1,"parent_id":0,"segment_type":"image","length":256}]"#, "the image segment is kept as it was");
        assert_eq!(cel.get("segment_count").and_then(Value::as_f64), Some(1.0));
        assert!(items(cel.get("polyfills")).is_empty(), "what a drawing cannot hold goes");
        let object = items(items(report.get("keyframes"))[0].get("objects"))[0].clone();
        assert_eq!(styk_doc::json::to_string(object.get("angles").unwrap()), "[0.5]");
        assert_eq!(styk_doc::json::to_string(object.get("lengths").unwrap()), "[256]");
        assert_eq!(styk_doc::json::to_string(object.get("_stykIK").unwrap()), r#"{"1":{"enabled":false}}"#, "and the controllers of the segments that went");
        assert_eq!(styk_doc::json::to_string(report.path(&["_styk", "frameSources", "pose", "objects"]).and_then(|objects| objects.item(0)).unwrap().get("angles").unwrap()), "[0.75]", "the retained poses too");
        assert_eq!(repair_cels(&mut report), 0, "and there is nothing left to mend");
    }

    #[test]
    fn the_poses_of_a_scene_that_inherits_the_figures_of_a_mended_cel_are_mended_with_them() {
        // A retained scene has no figures of its own: the cel is whole there (its parent mended it), and its objects still carry the entries of the segments it had.
        let mut report = damaged();
        report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("segments", Value::array(vec![styk_doc::json::parse(br#"{"segment_id":1,"parent_id":0,"segment_type":"image"}"#).unwrap()]));
        assert_eq!(repair_cels(&mut report), 1);
        let object = items(items(report.get("keyframes"))[0].get("objects"))[0].clone();
        assert_eq!(styk_doc::json::to_string(object.get("angles").unwrap()), "[0.5]");
    }

    #[test]
    fn a_figure_that_is_not_a_cel_and_a_cel_with_no_image_are_left_as_they_are() {
        let mut report = damaged();
        report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap().remove("_styk");
        assert_eq!(repair_cels(&mut report), 0, "a figure with two segments that is no drawing is not touched");
        let mut report = damaged();
        let segments = report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap();
        segments[0].make_obj().unwrap().set("segment_type", Value::str("line"));
        assert_eq!(repair_cels(&mut report), 0, "a cel with no image segment is left for opening to refuse: there is no picture to keep");
    }
}
