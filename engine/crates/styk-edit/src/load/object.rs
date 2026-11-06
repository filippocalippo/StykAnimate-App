//! What a posed figure may hold (`validateObjectPose` of src/pivot/model.mjs and the validators it
//! calls): the Stick Nodes extension, inverse-kinematics controllers, perspective and proportions,
//! the instance style, the figure's effects, depth and the animation origin.

use styk_doc::Value;

use super::js::*;
use crate::EditError;

/// `validateSticknodesShape(shape)` (src/sticknodes/validation.mjs).
pub(super) fn sticknodes_shape(shape: V) -> Result<(), EditError> {
    const KINDS: [&str; 8] = ["segment", "rounded-segment", "circle", "triangle", "filled-circle", "ellipse", "trapezoid", "polygon"];
    if !shape.is_some_and(Value::is_object) || !text(get(shape, "kind")).is_some_and(|kind| KINDS.contains(&kind)) {
        return fail("errors.validation.invalidStickNodesShape");
    }
    for key in ["sagitta", "drawRatio", "drawLength", "trapezoid_top_thickness_ratio", "trapezoid_thickness_start", "trapezoid_thickness_end", "right_triangle_direction"] {
        let value = get(shape, key);
        if !missing(value) && !num(value).is_some_and(|n| n.is_finite() && n.abs() <= 1e12) {
            return fail("errors.validation.invalidStickNodes");
        }
    }
    let vertices = get(shape, "num_polygon_vertices");
    if !missing(vertices) && !integer_in(vertices, 0.0, 256.0) {
        return fail("errors.validation.invalidStickNodesPolygonVertexCount");
    }
    let outline = get(shape, "outline");
    if !missing(outline) && !(len(outline) == 3 && is_array(outline) && items(outline).iter().all(|n| integer_in(Some(n), 0.0, 255.0))) {
        return fail("errors.validation.invalidStickNodesOutlineColor");
    }
    let alpha = get(shape, "outlineAlpha");
    if !missing(alpha) && !finite_in(alpha, 0.0, 1.0) {
        return fail("errors.validation.invalidStickNodesOutlineOpacity");
    }
    let reversed = get(shape, "reversed");
    if !missing(reversed) && !boolean(reversed) {
        return fail("errors.validation.invalidStickNodesShapeOrientation");
    }
    Ok(())
}

/// `validateSticknodesObject(object, figure)`.
fn sticknodes_object(object: &Value, figure: &Value) -> Result<(), EditError> {
    let shapes = object.get("_sticknodesShapes");
    if truthy(shapes) {
        let ids: Vec<String> = items(figure.get("segments")).iter().map(|s| styk_doc::json::to_string(s.get("segment_id").unwrap_or(&Value::Null))).collect();
        for (id, shape) in entries(shapes) {
            if !ids.iter().any(|known| **known == *id) {
                return fail("errors.validation.stickNodesShapeRefersToAMissingHandle");
            }
            sticknodes_shape(Some(shape))?;
        }
        // A table that is an array has the index keys, which no handle matches.
        if is_array(shapes) && len(shapes) > 0 {
            return fail("errors.validation.stickNodesShapeRefersToAMissingHandle");
        }
    }
    let sprite = object.get("_sticknodesSprite");
    if truthy(sprite) {
        for key in ["ratio", "pivotX", "pivotY"] {
            if !num(get(sprite, key)).is_some_and(|n| n.is_finite() && n.abs() <= 1e12) {
                return fail("errors.validation.invalidStickNodes");
            }
        }
        if num(get(sprite, "ratio")).is_some_and(|n| n < 0.0) {
            return fail("errors.validation.invalidStickNodesSpriteAspectRatio");
        }
    }
    Ok(())
}

/// `validateIK(object)` (src/ik.mjs).
fn ik(object: &Value) -> Result<(), EditError> {
    const MAX_CHAIN: usize = 256;
    let table = object.get("_stykIK");
    if missing(table) {
        return Ok(());
    }
    if !is_record(table) || key_count(table) > MAX_CHAIN {
        return fail("errors.ik.invalidIkControllerTable");
    }
    for (handle, controller) in entries(table) {
        let c = Some(controller);
        let target = get(c, "target");
        let chain = get(c, "chainLength");
        let allow = get(c, "allowStretch");
        let well_formed = positive_canonical(&handle)
            && number_of(&handle) <= 65535.0
            && truthy(c)
            && boolean(get(c, "enabled"))
            && boolean(get(c, "pinned"))
            && integer_in(chain, 1.0, MAX_CHAIN as f64)
            && num(get(c, "bendDirection")).is_some_and(|d| d == 1.0 || d == 0.0 || d == -1.0)
            && (missing(allow) || boolean(allow))
            && truthy(target)
            && ["x", "y", "rotation"].iter().all(|k| finite(get(target, k)))
            && ["x", "y"].iter().all(|k| num(get(target, k)).is_some_and(|n| fround(n).is_finite()));
        if !well_formed {
            return fail("errors.ik.invalidIkController");
        }
        let angles = |table: V| is_record(table) && entries(table).iter().all(|(id, a)| positive_canonical(id) && finite(Some(a)));
        if !angles(get(c, "followers")) {
            return fail("errors.ik.invalidIkControllerOrientation");
        }
        let offsets = get(c, "attachmentOffsets");
        if !missing(offsets) && !angles(offsets) {
            return fail("errors.ik.invalidIkAttachmentOrientation");
        }
        for field in ["joinedFollowers", "joinedAttachmentOffsets"] {
            let value = get(c, field);
            if !missing(value) && !(is_record(value) && entries(value).iter().all(|(uid, children)| positive_canonical(uid) && angles(Some(children)))) {
                return fail("errors.ik.invalidJoinedIkOrientation");
            }
        }
        let quaternion = |q: V| len(q) == 4 && is_array(q) && items(q).iter().all(|n| finite(Some(n))) && (hypot(&items(q).iter().filter_map(Value::as_f64).collect::<Vec<_>>()) - 1.0).abs() < 1e-5;
        let quaternions = |t: V| is_record(t) && entries(t).iter().all(|(id, q)| positive_canonical(id) && quaternion(Some(q)));
        let followers = get(c, "spatialFollowers");
        let joined = get(c, "joinedSpatialFollowers");
        if (!missing(followers) && !quaternions(followers))
            || (!missing(joined) && !(truthy(joined) && is_record(joined) && entries(joined).iter().all(|(id, t)| positive_canonical(id) && quaternions(Some(t)))))
        {
            return fail("errors.ik.invalidSpatialIkOrientation");
        }
        let spatial = get(c, "spatialTarget");
        if !missing(spatial) {
            let unit = |v: V| len(v) == 3 && is_array(v) && items(v).iter().all(|n| finite(Some(n))) && (hypot(&items(v).iter().filter_map(Value::as_f64).collect::<Vec<_>>()) - 1.0).abs() <= 1e-5;
            let normals = get(spatial, "normals");
            let valid = truthy(spatial)
                && finite(get(spatial, "depth"))
                && num(get(spatial, "depth")).is_some_and(|n| fround(n).is_finite())
                && unit(get(spatial, "pole"))
                && finite(get(spatial, "swivel"))
                && (missing(normals) || (is_array(normals) && len(normals) == 2 && items(normals).iter().all(|n| unit(Some(n)))));
            if !valid {
                return fail("errors.ik.invalidSpatialIkTarget");
            }
        }
        let reference = get(c, "bendReference");
        if !missing(reference) {
            let shape = get(reference, "shape");
            let valid = truthy(reference)
                && num(get(reference, "side")).is_some_and(|s| s == 1.0 || s == -1.0)
                && ["angle", "axis", "ratio"].iter().all(|k| finite(get(reference, k)))
                && num(get(reference, "ratio")).is_some_and(|r| r >= 0.0)
                && (missing(shape) || (is_array(shape) && len(shape) <= MAX_CHAIN && items(shape).iter().all(|n| finite(Some(n)))));
            if !valid {
                return fail("errors.ik.invalidIkBendReference");
            }
        }
    }
    Ok(())
}

/// `Math.hypot(...values)` as V8 computes it.
fn hypot(values: &[f64]) -> f64 {
    styk_math::norm(values)
}

/// `validateSpatialPose(object, figure)` (src/spatial-projection.mjs).
pub(crate) fn spatial_pose(object: &Value, figure: &Value) -> Result<(), EditError> {
    let state = object.get("_stykSpatial");
    if missing(state) {
        return Ok(());
    }
    let number = |v: V, min: f64, max: f64| finite_in(v, min, max);
    let only = |value: V, allowed: &[&str]| entries(value).iter().all(|(key, _)| allowed.contains(&&**key));
    if !is_record(state) || !only(state, &["camera", "shape"]) {
        return fail("errors.spatialProjection.invalidSpatialPoseSettings");
    }
    let camera = get(state, "camera");
    if !missing(camera) {
        let valid = is_record(camera)
            && only(camera, &["strength", "distance", "centerX", "centerY"])
            && number(get(camera, "strength"), 0.0, 1.0)
            && number(get(camera, "distance"), 10.0, 100000.0)
            && ["centerX", "centerY"].iter().all(|k| missing(get(camera, k)) || number(get(camera, k), -1e7, 1e7));
        if !valid {
            return fail("errors.spatialProjection.perspectiveNeedsStrength01AndDistance10");
        }
    }
    let shape = get(state, "shape");
    if !missing(shape) {
        let segments = items(figure.get("segments"));
        if !is_record(shape) || key_count(shape) > segments.len() {
            return fail("errors.spatialProjection.invalidSpatialProportions");
        }
        let bones: Vec<f64> = segments.iter().filter(|s| truthy(path(Some(s), &["_stykRig", "spatial", "origin"]))).filter_map(|s| num(s.get("segment_id"))).collect();
        for (id, proportions) in entries(shape) {
            let p = Some(proportions);
            let valid = canonical(&id)
                && bones.contains(&number_of(&id))
                && is_record(p)
                && only(p, &["width", "taper"])
                && number(get(p, "width"), 0.1, 5.0)
                && number(get(p, "taper"), -0.9, 3.0);
            if !valid {
                return fail("errors.spatialProjection.spatialProportionsNeedAnExistingBoneWidth0");
            }
        }
    }
    Ok(())
}

/// `rigIKAllowed(figure, index)`: the joint exists and no other relationship derives it.
fn ik_allowed(segment: V) -> bool {
    let rig = get(segment, "_stykRig");
    segment.is_some() && !(truthy(path(rig, &["spatial", "bindings"])) || truthy(get(rig, "connector")) || truthy(get(rig, "angleLock")) || truthy(get(rig, "anglePath")) || truthy(get(rig, "weighted")))
}

/// `validateDrawableZIndex(value)`.
pub(super) fn drawable_z_index(value: V) -> Result<(), EditError> {
    if !num(value).is_some_and(|n| n.is_finite() && fround(n).is_finite()) {
        return fail("errors.animationProperties.drawOrderMustBeAFiniteNativeNumber");
    }
    Ok(())
}

/// `validateFigureZIndex(value)`.
pub(super) fn figure_z_index(value: V) -> Result<(), EditError> {
    if !safe_integer(value) || num(value).is_some_and(|n| n.abs() > 1_000_000.0) {
        return fail("errors.animationProperties.zIndexMustBeAWholeNumberFrom");
    }
    Ok(())
}

/// `validateAnimationStyle(object, figure)` (src/animation-style.mjs).
fn animation_style(object: &Value, figure: &Value) -> Result<(), EditError> {
    let mode = path(Some(object), &["_styk", "colorMode"]);
    if !missing(mode) && text(mode) != Some("segments") {
        return fail("errors.animationStyle.invalidInstanceColorMode");
    }
    let style = object.get("_stykStyle");
    if missing(style) {
        return Ok(());
    }
    let opacity = |v: V| if finite_in(v, 0.0, 1.0) { Ok(()) } else { fail("errors.animationStyle.instanceStyleOpacityMustBeBetweenZeroAnd") };
    let color = |v: V| if integer_in(v, 0.0, 16_777_215.0) { Ok(()) } else { fail("errors.animationStyle.styleColorMustBeAnRgbInteger") };
    let width = |v: V| if finite_in(v, 0.0, 1e6) { Ok(()) } else { fail("errors.animationStyle.styleWidthIsOutsideTheSupportedRange") };
    if !is_record(style) {
        return fail("errors.animationStyle.instanceStyleMustBeAPropertyRecord");
    }
    if has_own(style, "outlineOpacity") {
        opacity(get(style, "outlineOpacity"))?;
    }
    if has_own(style, "outlineColor") {
        color(get(style, "outlineColor"))?;
    }
    if has_own(style, "outlineWidth") {
        width(get(style, "outlineWidth"))?;
    }
    let colors = get(style, "meshColors");
    if !missing(colors) {
        if !is_record(colors) || key_count(colors) > 1024 {
            return fail("errors.figureColors.chooseValidPaletteTargets");
        }
        let palette = path(Some(figure), &["_styk", "spatialMesh", "colors"]);
        for (key, value) in entries(colors) {
            let index = number_of(&key);
            if !(canonical(&key) && (0.0..1024.0).contains(&index)) || (figure.is_object() && index >= len(palette) as f64) {
                return fail("errors.figureColors.chooseValidPaletteTargets");
            }
            color(Some(value))?;
        }
    }
    let segments = get(style, "segments");
    if !missing(segments) {
        if !is_record(segments) {
            return fail("errors.animationStyle.instanceSegmentStylesMustBeAHandleTable");
        }
        for (handle, values) in entries(segments) {
            let v = Some(values);
            if !(positive_canonical(&handle) && number_of(&handle) <= 65535.0) || !is_record(v) {
                return fail("errors.animationStyle.instanceStyleHasAnInvalidSegmentHandle");
            }
            if has_own(v, "opacity") {
                opacity(get(v, "opacity"))?;
            }
            if has_own(v, "gradientOpacity") {
                opacity(get(v, "gradientOpacity"))?;
            }
            if has_own(v, "color") {
                color(get(v, "color"))?;
            }
            if has_own(v, "gradientColor") {
                color(get(v, "gradientColor"))?;
            }
            if has_own(v, "thickness") {
                width(get(v, "thickness"))?;
            }
            if has_own(v, "zIndex") {
                drawable_z_index(get(v, "zIndex"))?;
            }
            if has_own(v, "paint") {
                if let Some(paint) = get(v, "paint") {
                    styk_eval::records::paint::normalize_paint(paint)?;
                } else {
                    return fail("errors.paint.invalidPaintType");
                }
            }
        }
    }
    let polygons = get(style, "polygons");
    if !missing(polygons) {
        if !is_record(polygons) {
            return fail("errors.animationStyle.polygonStylesMustBeAnIdentityTable");
        }
        for (id, values) in entries(polygons) {
            let v = Some(values);
            let n = js_number(&id);
            if !(n.is_finite() && n.fract() == 0.0 && (1.0..=65535.0).contains(&n)) || !is_record(v) {
                return fail("errors.animationStyle.invalidPolygonStyleIdentity");
            }
            if has_own(v, "color") {
                color(get(v, "color"))?;
            }
            if has_own(v, "opacity") {
                opacity(get(v, "opacity"))?;
            }
            if has_own(v, "zIndex") {
                drawable_z_index(get(v, "zIndex"))?;
            }
        }
    }
    Ok(())
}

/// `validateVfxOwner(owner)` (src/vfx.mjs) for a figure's pose or a frame.
pub(super) fn vfx_owner(owner: V) -> Result<(), EditError> {
    let scope = get(owner, "_stykVfxScope");
    if !missing(scope) && !num(scope).is_some_and(|s| s == 0.0 || s == 1.0) {
        return fail("errors.vfx.invalidConnectedVfxScope");
    }
    let table = get(owner, "_stykVfx");
    if missing(table) {
        return Ok(());
    }
    if !is_record(table) || key_count(table) > 65536 {
        return fail("errors.vfx.invalidVfxOwner");
    }
    for (key, stack) in entries(table) {
        if &*key != "figure" && !segment_key(&key) {
            return fail("errors.vfx.invalidVfxSegmentIdentity");
        }
        if is_array(Some(stack)) && items(Some(stack)).iter().any(|effect| text(effect.get("type")).and_then(styk_eval::vfx::Kind::from_name).is_some_and(|kind| kind.is_generator())) {
            return fail("errors.vfx.generatedEffectsBelongOnTheEffectsTimeline");
        }
        crate::vfx_clips::check_stack(Some(stack), &[])?;
    }
    Ok(())
}

/// `/^(\*|[1-9]\d*)\/[1-9]\d*$/`.
fn segment_key(key: &str) -> bool {
    key.split_once('/').is_some_and(|(scope, handle)| (scope == "*" || positive_canonical(scope)) && positive_canonical(handle))
}

/// `validateObjectPose(report, object, figure, origin)`.
pub(crate) fn object_pose(report: &Value, object: &Value, figure: &Value) -> Result<(), EditError> {
    if truthy(object.get("_sticknodesShapes")) || truthy(object.get("_sticknodesSprite")) {
        sticknodes_object(object, figure)?;
    }
    ik(object)?;
    spatial_pose(object, figure)?;
    let controllers = object.get("_stykIK");
    if truthy(controllers) {
        let segments = items(figure.get("segments"));
        for (id, controller) in entries(controllers) {
            if truthy(get(Some(controller), "enabled")) {
                let wanted = js_number(&id);
                let at = segments.iter().position(|s| num(s.get("segment_id")) == Some(wanted));
                if !ik_allowed(at.map(|i| &segments[i])) {
                    return fail("errors.model.ikCannotDriveADerivedConnectorWeightedOr");
                }
            }
        }
    }
    animation_style(object, figure)?;
    vfx_owner(Some(object))?;
    let z = object.get("_stykZIndex");
    if !missing(z) {
        figure_z_index(z)?;
    }
    for key in ["root_x", "root_y", "scale"] {
        float32(object.get(key))?;
    }
    if !integer_in(object.get("unique_id"), 0.0, 4_294_967_295.0) {
        return fail("errors.model.mustBeAnIntegerFromTo");
    }
    let raw = object.get("color_override_raw");
    if !missing(raw) {
        let low = if num(report.get("version")).is_some_and(|v| v < 5.0) { -2_147_483_648.0 } else { 0.0 };
        if !integer_in(raw, low, 4_294_967_295.0) {
            return fail("errors.model.mustBeAnIntegerFromTo");
        }
    }
    let transparency = object.get("field28");
    if !missing(transparency) && !integer_in(transparency, 0.0, 255.0) {
        return fail("errors.model.mustBeAnIntegerFromTo");
    }
    if num(object.get("scale")).is_some_and(|s| s < 0.0) {
        return fail("errors.model.objectScaleCannotBeNegative");
    }
    let count = len(figure.get("segments"));
    for (flag, key) in [(true, "angles"), (truthy(object.get("len_flag")), "lengths"), (truthy(object.get("bend_flag")), "bends")] {
        if !flag {
            continue;
        }
        let values = object.get(key);
        if !is_array(values) || len(values) != count {
            return fail("errors.model.poseArrayDoesNotMatchItsFigure");
        }
        match values.and_then(Value::elements) {
            Some(styk_doc::Elements::Numbers(numbers)) => {
                for n in numbers.iter() {
                    if !n.is_finite() || (key == "lengths" && !fround(n).is_finite()) {
                        return fail(if n.is_finite() { "errors.model.exceedsTheNativeFloat32Range" } else { "errors.model.mustBeAFiniteNumber" });
                    }
                }
            }
            Some(styk_doc::Elements::Items(list)) => {
                for value in list {
                    if key == "lengths" { float32(Some(value))?; } else { finite_number(Some(value))?; }
                }
            }
            None => {}
        }
    }
    Ok(())
}

/// `finite(value, label)` of src/pivot/model.mjs.
pub(super) fn finite_number(value: V) -> Result<f64, EditError> {
    match num(value) {
        Some(n) if n.is_finite() => Ok(n),
        _ => fail("errors.model.mustBeAFiniteNumber"),
    }
}

/// `float32(value, label)`.
pub(super) fn float32(value: V) -> Result<f64, EditError> {
    let n = finite_number(value)?;
    if !fround(n).is_finite() {
        return fail("errors.model.exceedsTheNativeFloat32Range");
    }
    Ok(n)
}

/// `integer(value, min, max, label)`.
pub(super) fn bounded_integer(value: V, min: f64, max: f64) -> Result<f64, EditError> {
    if !integer_in(value, min, max) {
        return fail("errors.model.mustBeAnIntegerFromTo");
    }
    Ok(num(value).unwrap())
}

/// `rgb(value, label)`.
pub(super) fn rgb(value: V) -> Result<(), EditError> {
    if !is_array(value) || len(value) != 3 {
        return fail("errors.model.needsThreeRgbBytes");
    }
    for n in items(value) {
        bounded_integer(Some(&n), 0.0, 255.0)?;
    }
    Ok(())
}
