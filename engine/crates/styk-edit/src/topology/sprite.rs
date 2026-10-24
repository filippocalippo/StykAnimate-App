//! `editor-sprite-segment`: attach portable embedded image data through the existing
//! topology transaction. No image decoding or additional resource cache is involved.
use super::{
    MAX_SEGMENTS, Pose, TopologyOptions, instances, invalid, items, objects_mut, remove, set,
};
use crate::{EditError, Editor};
use std::collections::HashMap;
use styk_doc::{Obj, Value};

const MAX_ASSETS: usize = 65535;
fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}
fn asset_id(asset: &Value, index: usize) -> Value {
    ["asset_index", "table_index", "image_index", "sprite_index"]
        .iter()
        .find_map(|key| nullish(asset.get(key)))
        .cloned()
        .unwrap_or(Value::Num(index as f64))
}
fn media_id(segment: &Value) -> Value {
    nullish(segment.get("extra_u16"))
        .cloned()
        .or_else(|| {
            segment
                .get("extra")
                .and_then(|v| v.item(0))
                .filter(|v| !v.is_null())
        })
        .or_else(|| nullish(segment.get("image_asset_index")).cloned())
        .or_else(|| nullish(segment.get("sprite_index")).cloned())
        .unwrap_or(Value::Num(0.0))
}
fn is_image(segment: &Value) -> bool {
    segment.get("primitive_code").and_then(Value::as_f64) == Some(2.0)
        || segment.get("segment_type").and_then(Value::as_str) == Some("image")
}
fn set_asset_index(asset: &mut Value, index: usize) {
    if let Some(record) = asset.make_obj() {
        record.set("kind", Value::str("image"));
        record.set("asset_index", Value::Num(index as f64));
        record.set("table_index", Value::Num(index as f64));
        for alias in ["image_index", "sprite_index"] {
            if record.contains(alias) {
                record.set(alias, Value::Num(index as f64));
            }
        }
    }
}
fn set_media_index(segment: &mut Value, index: usize) {
    let a = nullish(segment.get("extra_u8_a"))
        .cloned()
        .or_else(|| {
            segment
                .get("extra")
                .and_then(|v| v.item(1))
                .filter(|v| !v.is_null())
        })
        .unwrap_or(Value::Num(0.0));
    let b = nullish(segment.get("extra_u8_b"))
        .cloned()
        .or_else(|| {
            segment
                .get("extra")
                .and_then(|v| v.item(2))
                .filter(|v| !v.is_null())
        })
        .unwrap_or(Value::Num(0.0));
    if let Some(record) = segment.make_obj() {
        record.set("extra_u16", Value::Num(index as f64));
        record.set("extra_u8_a", a.clone());
        record.set("extra_u8_b", b.clone());
        record.set("extra", Value::array(vec![Value::Num(index as f64), a, b]));
        for alias in ["image_asset_index", "sprite_index"] {
            if record.contains(alias) {
                record.set(alias, Value::Num(index as f64));
            }
        }
    }
}
fn normalize_image_table(figure: &mut Value) -> Result<(), EditError> {
    let mut assets = items(figure.get("image_assets"));
    let mut remap = HashMap::new();
    for (index, asset) in assets.iter().enumerate() {
        let id = asset_id(asset, index)
            .as_f64()
            .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v < MAX_ASSETS as f64)
            .ok_or_else(|| {
                invalid("errors.editorSpriteSegment.theFigureContainsInvalidOrRepeatedSpriteAsset")
            })? as usize;
        if remap.insert(id, index).is_some() {
            return Err(invalid(
                "errors.editorSpriteSegment.theFigureContainsInvalidOrRepeatedSpriteAsset",
            ));
        }
    }
    let mut segments = items(figure.get("segments"));
    for segment in &mut segments {
        if !is_image(segment) {
            continue;
        }
        let index = media_id(segment)
            .as_f64()
            .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0)
            .and_then(|id| remap.get(&(id as usize)))
            .copied()
            .ok_or_else(|| {
                invalid("errors.editorSpriteSegment.anExistingSpriteSegmentIsMissingItsImage")
            })?;
        set_media_index(segment, index);
    }
    for (index, asset) in assets.iter_mut().enumerate() {
        set_asset_index(asset, index);
    }
    set(figure, "image_assets", Value::array(assets));
    set(figure, "segments", Value::array(segments));
    remove(figure, "side_tables");
    Ok(())
}
fn portable_asset(asset: &Value) -> Value {
    let mut next = asset.clone();
    for key in [
        "record_offset",
        "record_end",
        "records_start",
        "records_end",
        "source_start",
        "source_end",
        "source_offset",
        "source_size",
        "image_start",
    ] {
        remove(&mut next, key);
    }
    set(&mut next, "kind", Value::str("image"));
    let id = asset_id(&next, 0);
    set(&mut next, "asset_index", id.clone());
    set(&mut next, "table_index", id);
    for (key, alias) in [
        ("anchor_start", "pivot"),
        ("anchor_end", "endpoint"),
        ("data_url", "data_uri"),
    ] {
        if nullish(next.get(key)).is_none()
            && let Some(value) = next.get(alias).cloned()
        {
            set(&mut next, key, value);
        }
    }
    if next.get("data_url").is_some_and(Value::truthy) {
        remove(&mut next, "data_uri");
        remove(&mut next, "data_base64");
    }
    if let Some(mime) = next
        .get("data_url")
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix("data:"))
        .and_then(|s| s.split_once(";base64,"))
        .map(|(m, _)| m)
        .filter(|m| !m.is_empty() && !m.contains(';'))
    {
        let mime = mime.to_string();
        set(&mut next, "mime_type", Value::str(&mime));
    }
    next
}
fn point(value: Option<&Value>) -> Result<(Value, [f64; 2]), EditError> {
    let coordinate = |key| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_f64)
            .filter(|v| {
                v.is_finite() && v.fract() == 0.0 && *v >= i32::MIN as f64 && *v <= i32::MAX as f64
            })
            .ok_or_else(|| {
                invalid("errors.editorSpriteSegment.spriteAnchorCoordinatesMustBeSigned32Bit")
            })
    };
    let xy = [coordinate("x")?, coordinate("y")?];
    let mut point = Obj::new();
    point.set("x", Value::Num(xy[0]));
    point.set("y", Value::Num(xy[1]));
    Ok((Value::object(point), xy))
}
fn embedded_png(data: &str) -> bool {
    let Some(encoded) = data.strip_prefix("data:image/png;base64,") else {
        return false;
    };
    let unpadded = encoded.trim_end_matches('=');
    !unpadded.is_empty()
        && encoded.len() - unpadded.len() <= 2
        && unpadded
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
}
fn derived_runtime_pose(object: &Value, segments: &[Value]) -> bool {
    let Some(runtime) = object.get("runtime_segments").filter(|v| v.truthy()) else {
        return false;
    };
    [("len_flag", "length"), ("bend_flag", "bend_rad")]
        .into_iter()
        .any(|(flag, field)| {
            !object.get(flag).is_some_and(Value::truthy)
                && segments.iter().enumerate().any(|(i, segment)| {
                    runtime
                        .item(i)
                        .and_then(|s| s.get(field).cloned())
                        .is_some_and(|value| {
                            value != segment.get(field).cloned().unwrap_or(Value::Num(0.0))
                        })
                })
        })
}

impl Editor {
    pub(super) fn add_sprite_segment(
        &mut self,
        source: &Value,
        options: Option<&Value>,
    ) -> Result<Value, EditError> {
        let Some((_, figure)) = self.topology_figure()? else {
            return Err(invalid(
                "errors.editorSpriteSegment.selectAFigureBeforeAttachingASprite",
            ));
        };
        let source_segments = items(source.get("segments"));
        let source_assets = items(source.get("image_assets"));
        if source_segments.len() != 1 || !is_image(&source_segments[0]) || source_assets.len() != 1
        {
            return Err(invalid(
                "errors.editorSpriteSegment.chooseOneImportedImageToAttachAsA",
            ));
        }
        if source
            .path(&["_styk", "drawing", "version"])
            .and_then(Value::as_f64)
            == Some(2.0)
        {
            return Err(invalid(
                "errors.editorSpriteSegment.drawingCelsCannotBeAttachedAsSpriteImages",
            ));
        }
        if !crate::history::js_strict_eq(
            &media_id(&source_segments[0]),
            &asset_id(&source_assets[0], 0),
        ) {
            return Err(invalid(
                "errors.editorSpriteSegment.theSpriteSegmentDoesNotReferenceItsImage",
            ));
        }
        let mut asset = portable_asset(&source_assets[0]);
        if !asset
            .get("data_url")
            .and_then(Value::as_str)
            .is_some_and(embedded_png)
        {
            return Err(invalid(
                "errors.editorSpriteSegment.spriteAttachmentRequiresAnEmbeddedPngImage",
            ));
        }
        let (start, a) = point(asset.get("anchor_start"))?;
        let (end, b) = point(asset.get("anchor_end"))?;
        set(&mut asset, "anchor_start", start.clone());
        set(&mut asset, "anchor_end", end.clone());
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let length = styk_math::hypot(dx, dy);
        let anchor_angle = styk_math::atan2(dy, dx);
        set(&mut asset, "anchor_length", Value::Num(length));
        set(&mut asset, "anchor_angle_rad", Value::Num(anchor_angle));
        if length == 0.0 {
            return Err(invalid(
                "errors.editorSpriteSegment.spriteOriginAndEndpointMustBeDifferentPoints",
            ));
        }
        if asset.get("pivot").is_some() {
            set(&mut asset, "pivot", start);
        }
        if asset.get("endpoint").is_some() {
            set(&mut asset, "endpoint", end);
        }
        if options.is_some_and(Value::is_null) {
            return Err(EditError::Unported("sprite options that are null".into()));
        }
        let angle = match options.and_then(|o| nullish(o.get("angle"))) {
            None => anchor_angle,
            Some(v) => v
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| invalid("errors.editorSpriteSegment.spriteAngleMustBeFinite"))?,
        };
        let segments = items(figure.get("segments"));
        let parent = options
            .and_then(|o| nullish(o.get("parentId")))
            .cloned()
            .or_else(|| {
                usize::try_from(self.selection.joint)
                    .ok()
                    .and_then(|i| segments.get(i))
                    .and_then(|s| s.get("segment_id"))
                    .cloned()
            })
            .unwrap_or(Value::Num(0.0));
        if !parent.as_f64().is_some_and(|p| {
            p.is_finite()
                && p.fract() == 0.0
                && (p == 0.0
                    || segments
                        .iter()
                        .any(|s| s.get("segment_id") == Some(&parent)))
        }) {
            return Err(invalid(
                "errors.editorSpriteSegment.chooseAnExistingParentHandleForTheSprite",
            ));
        }
        let handle = segments
            .iter()
            .filter_map(|s| s.get("segment_id").and_then(Value::as_f64))
            .fold(0.0, f64::max)
            + 1.0;
        if segments.len() >= MAX_SEGMENTS || handle > 65535.0 {
            return Err(invalid(
                "errors.editorBuilder.aFigureSupportsAtMost30000Segments",
            ));
        }
        let asset_index = items(figure.get("image_assets")).len();
        if asset_index >= MAX_ASSETS {
            return Err(invalid(
                "errors.editorSpriteSegment.aFigureSupportsAtMost65535Image",
            ));
        }
        if segments
            .iter()
            .any(|s| s.get("_stykRig").is_some_and(Value::truthy))
        {
            return Err(EditError::Unported(
                "sprite attachment to rig-derived runtime geometry".into(),
            ));
        }
        let segment_index = segments.len();
        let type_id = figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        self.topology_edit(
            "Add sprite segment",
            TopologyOptions::default(),
            |editor, index| {
                let mut next = editor.figure_at(index);
                normalize_image_table(&mut next)?;
                set_asset_index(&mut asset, asset_index);
                let mut assets = items(next.get("image_assets"));
                assets.push(asset);
                set(&mut next, "image_assets", Value::array(assets));
                let z = crate::builder::normalize_builder_order(&mut next)? + 1;
                let mut segment = Obj::new();
                for (key, value) in [
                    ("segment_id", handle),
                    ("parent_id", parent.as_f64().unwrap()),
                    ("length", length),
                    ("angle_rad", angle),
                    ("thickness", 0.0),
                    ("bend_rad", 0.0),
                    ("primitive_code", 2.0),
                    ("aux_code", 0.0),
                    ("flags", 2.0),
                ] {
                    segment.set(key, Value::Num(value));
                }
                segment.set("is_static", Value::Bool(false));
                segment.set("segment_type", Value::str("image"));
                segment.set("segment_kind", Value::str("image"));
                segment.set("color_rgb", Value::nums(&[0.0; 3]));
                segment.set("transparency", Value::Num(0.0));
                segment.set("color_alpha", Value::Num(1.0));
                segment.set("visible", Value::Bool(true));
                segment.set("extra_u8_a", Value::Num(0.0));
                segment.set("extra_u8_b", Value::Num(0.0));
                segment.set("z_order", Value::Num(z as f64));
                segment.set("z_order_runtime_raw", Value::Num(z as f64 - 1.0));
                let mut segment = Value::object(segment);
                set_media_index(&mut segment, asset_index);
                for (place, slots) in instances(&editor.report, &type_id) {
                    let Some(objects) = objects_mut(&mut editor.report, &place) else {
                        continue;
                    };
                    for slot in slots {
                        let object = &mut objects[slot];
                        if derived_runtime_pose(object, &segments) {
                            return Err(EditError::Unported(
                                "sprite attachment retaining derived runtime pose".into(),
                            ));
                        }
                        let mut pose = Pose::of(object);
                        pose.angles.push(angle);
                        if let Some(v) = pose.lengths.as_mut() {
                            v.push(length)
                        }
                        if let Some(v) = pose.bends.as_mut() {
                            v.push(0.0)
                        }
                        pose.write(object);
                    }
                }
                let mut all = items(next.get("segments"));
                all.push(segment);
                set(&mut next, "segments", Value::array(all));
                *editor.edit_figure(index).unwrap() = next.as_obj().unwrap().clone();
                editor.selection.joint = segment_index as i64;
                Ok(())
            },
        )?;
        let mut result = Obj::new();
        result.set("handleId", Value::Num(handle));
        result.set("segmentIndex", Value::Num(segment_index as f64));
        result.set("assetIndex", Value::Num(asset_index as f64));
        Ok(Value::object(result))
    }
}
