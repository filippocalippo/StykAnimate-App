//! `validateAnimationDocumentSteps` (src/animation-channels.mjs): the effects timeline, camera motion,
//! per-key easing and the authored channels with their keys, targets and values.

use std::collections::HashSet;

use styk_doc::Value;

use super::js::*;
use super::object::{drawable_z_index, figure_z_index};
use crate::EditError;

/// `validateKeyEasing(key, property)` (src/keyframe-easing.mjs); `property` is `zIndex` only where the
/// caller passes it.
pub(super) fn key_easing(key: V, property: Option<&str>) -> Result<(), EditError> {
    let interpolation = get(key, "interpolation");
    let mode = match interpolation {
        None | Some(Value::Null) => Some("linear"),
        Some(Value::Str(mode)) if &**mode == "hold" => Some("constant"),
        Some(Value::Str(mode)) => Some(&**mode),
        Some(_) => None,
    };
    if !matches!(mode, Some("auto" | "bezier" | "ease-in" | "ease-out" | "linear" | "constant")) {
        return fail("errors.keyframeEasing.invalidKeyInterpolationChooseAutoBezierEaseIn");
    }
    let bezier = get(key, "bezier");
    if !missing(bezier) && (mode != Some("bezier") || !is_array(bezier) || len(bezier) != 4 || !items(bezier).iter().all(|v| finite_in(Some(v), 0.0, 1.0))) {
        return fail("errors.keyframeEasing.bezierRequiresFourControlCoordinatesBetween0And");
    }
    if property == Some("zIndex") && mode != Some("constant") {
        return fail("errors.keyframeEasing.useConstantEasing");
    }
    Ok(())
}

/// `validateCameraParallaxOffset(camera)` (src/layer-parallax.mjs).
fn parallax_offset(camera: V) -> Result<(), EditError> {
    let offset = get(camera, "_parallaxMotionOffset");
    if !missing(offset) && !(truthy(offset) && finite(get(offset, "x")) && finite(get(offset, "y"))) {
        return fail("errors.layerParallax.invalidBakedCameraParallaxOffset");
    }
    Ok(())
}

/// `encodeURIComponent(text)`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The properties each kind of target animates (`ANIMATION_PROPERTIES`).
fn kind_properties(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "figure" => &["x", "y", "scale", "rotation", "color", "opacity", "outlineColor", "outlineWidth", "outlineOpacity", "zIndex", "pose"],
        "segment" => &["color", "opacity", "thickness", "gradientColor", "gradientOpacity", "paint", "zIndex"],
        "polygon" => &["color", "opacity", "zIndex"],
        "camera" => &["pose", "x", "y", "scale", "rotation"],
        "scene" => &["pose", "backgroundId", "color"],
        "layer" => &["pose"],
        _ => return None,
    })
}

/// `isVfxProperty(property)`.
fn is_vfx_property(property: &str) -> bool {
    property == "vfxScope" || property == "vfxStack" || property.starts_with("vfx1:")
}

/// A target as `normalizeAnimationTarget` returns it: the kind and the identity text of its channel id.
struct Target {
    kind: String,
    identity: String,
}

/// `normalizeAnimationTarget(target)`.
fn normalize_target(target: V) -> Result<Target, EditError> {
    let kind = text(get(target, "kind")).filter(|kind| kind_properties(kind).is_some());
    let Some(kind) = kind.filter(|_| truthy(target)) else {
        return fail("errors.animationChannels.chooseAFigureSegmentLayerCameraOrScene");
    };
    if !missing(get(target, "figureTypeId")) && !matches!(kind, "segment" | "polygon") {
        return fail("errors.animationChannels.onlySegmentAndPolygonAnimationCanBeScoped");
    }
    let number = |key: &str| num(get(target, key)).map(number_text).unwrap_or_default();
    let identity = match kind {
        "polygon" => {
            if !integer_in(get(target, "uid"), 0.0, f64::INFINITY)
                || !integer_in(get(target, "polygonId"), 1.0, 65535.0)
                || !safe_integer(get(target, "figureTypeId"))
                || num(get(target, "figureTypeId")).unwrap() < 1.0
            {
                return fail("errors.animationChannels.polygonAnimationRequiresAFigureUidPolygonIdentity");
            }
            format!("{}/{}@{}", number("uid"), number("polygonId"), number("figureTypeId"))
        }
        "figure" | "segment" => {
            if !integer_in(get(target, "uid"), 0.0, f64::INFINITY) {
                return fail("errors.animationChannels.figureAnimationRequiresANativeFigureIdentity");
            }
            if kind == "segment" {
                if !integer_in(get(target, "handleId"), 1.0, 65535.0) {
                    return fail("errors.animationChannels.segmentAnimationRequiresANativeSegmentHandleIdentity");
                }
                let scope = get(target, "figureTypeId");
                if !missing(scope) && !(safe_integer(scope) && num(scope).unwrap() >= 1.0) {
                    return fail("errors.animationChannels.segmentAnimationScopeRequiresAPositiveNativeFigure");
                }
                format!("{}/{}{}", number("uid"), number("handleId"), if missing(scope) { String::new() } else { format!("@{}", number("figureTypeId")) })
            } else {
                number("uid")
            }
        }
        "layer" => {
            let id = text(get(target, "id"));
            if !id.is_some_and(|id| !id.is_empty() && js_len(id) <= 256) {
                return fail("errors.animationChannels.layerAnimationRequiresALayerIdentity");
            }
            id.unwrap().to_string()
        }
        _ => String::new(),
    };
    Ok(Target { kind: kind.to_string(), identity })
}

/// `vfxDescriptor(property)` is non-null.
fn vfx_known(property: &str) -> bool {
    property == "vfxScope" || property == "vfxStack" || crate::vfx_clips::descriptor(property).is_some()
}

/// `animationChannelId(target, property)`; the normalized target comes with it.
fn channel_id(target: V, property: V) -> Result<(String, Target), EditError> {
    let normalized = normalize_target(target)?;
    let supported = match text(property) {
        Some("vfxScope") => normalized.kind == "figure",
        Some(p) => kind_properties(&normalized.kind).is_some_and(|list| list.contains(&p)) || (matches!(normalized.kind.as_str(), "figure" | "segment" | "scene") && is_vfx_property(p) && vfx_known(p)),
        None => false,
    };
    if !supported {
        return fail("errors.animationChannels.propertyCannotAnimateOn");
    }
    let id = format!("{}:{}:{}", normalized.kind, encode_uri_component(&normalized.identity), text(property).unwrap());
    Ok((id, normalized))
}

/// `validateAnimationValue(target, property, value)`.
fn animation_value(kind: &str, property: &str, value: V) -> Result<(), EditError> {
    if is_vfx_property(property) {
        if property == "vfxStack" {
            return crate::vfx_clips::check_stack(value, &[]);
        }
        let found = if property == "vfxScope" { None } else { crate::vfx_clips::descriptor(property) };
        if property != "vfxScope" && found.is_none() {
            return fail("errors.vfx.unknownVfxParameter");
        }
        return match found {
            Some(found) => crate::vfx_clips::check_value(&found, value),
            None => {
                if integer_in(value, 0.0, 1.0) { Ok(()) } else { fail("errors.cameraMotion.mustBeBetweenAnd") }
            }
        };
    }
    if property == "paint" {
        return match value {
            Some(paint) => styk_eval::records::paint::normalize_paint(paint).map(|_| ()).map_err(EditError::from),
            None => fail("errors.paint.invalidPaintType"),
        };
    }
    if property == "pose" {
        if is_null(value) {
            return Ok(());
        }
        let frame_id = get(value, "frameId");
        if !truthy(value) || !(is_null(frame_id) || text(frame_id).is_some_and(|id| !id.is_empty())) {
            return fail("errors.animationChannels.aPoseKeyMustReferenceANativeFrame");
        }
        return Ok(());
    }
    if kind == "scene" && property == "color" && is_null(value) {
        return Ok(());
    }
    let Some(n) = num(value).filter(|n| n.is_finite()) else {
        return fail("errors.animationChannels.animationValuesMustBeFiniteNumbers");
    };
    if property == "zIndex" {
        return if kind == "figure" { figure_z_index(value) } else { drawable_z_index(value) };
    }
    if property == "scale" && (n < if kind == "camera" { 0.000001 } else { 0.0 } || n > 1e6) {
        return fail("errors.animationChannels.animationScaleIsOutsideTheSupportedRange");
    }
    if matches!(property, "opacity" | "outlineOpacity" | "gradientOpacity") && !(0.0..=1.0).contains(&n) {
        return fail("errors.animationChannels.animationOpacityMustBeBetweenZeroAndOne");
    }
    let whole_color = n.fract() == 0.0 && (0.0..=4_294_967_295.0).contains(&n);
    if property == "backgroundId" && !whole_color {
        return fail("errors.animationChannels.chooseAValidBackgroundIdentity");
    }
    let color = matches!(property, "color" | "outlineColor" | "gradientColor");
    if color && !whole_color {
        return fail("errors.animationChannels.colorMustBeA32BitColor");
    }
    if color && (matches!(kind, "segment" | "polygon") || property == "outlineColor") && n > 16_777_215.0 {
        return fail("errors.animationChannels.styleColorsUseRgbOpacityHasItsOwn");
    }
    if matches!(property, "outlineWidth" | "thickness") && !(0.0..=1e6).contains(&n) {
        return fail("errors.animationChannels.widthMustBeBetweenZeroAnd1000");
    }
    Ok(())
}

/// The identity of a shared array, for the "validated once" memory of pose key sequences.
pub(super) fn node_id(value: V) -> Option<usize> {
    match value? {
        Value::Arr(items) => Some(std::sync::Arc::as_ptr(items) as *const () as usize),
        Value::Nums(numbers) => Some(std::sync::Arc::as_ptr(numbers) as *const () as usize),
        _ => None,
    }
}

/// `validateAnimationDocumentSteps(report)`.
pub(super) fn validate_document(report: &Value) -> Result<(), EditError> {
    let styk = report.get("_styk");
    let clips = get(styk, "vfxClips");
    if !missing(clips) {
        if !truthy(clips) || num(get(clips, "version")) != Some(1.0) || !is_array(get(clips, "clips")) || len(get(clips, "clips")) > 4096 {
            return fail("errors.vfxClips.invalidEffectsTimeline");
        }
        crate::vfx_clips::check_clips(&items(get(clips, "clips")), &[])?;
    }
    let motion = get(styk, "cameraMotion");
    if !missing(motion) {
        crate::camera_motion::validate(motion.unwrap())?;
    }
    let check_frame = |frame: &Value| -> Result<(), EditError> {
        parallax_offset(prop(Some(frame), "camera")?)?;
        if truthy(path(Some(frame), &["_styk", "easing"])) {
            key_easing(path(Some(frame), &["_styk", "easing"]), None)?;
        }
        Ok(())
    };
    let keyframes = report.get("keyframes");
    if is_given(keyframes) {
        for frame in items(keyframes) {
            check_frame(&frame)?;
        }
    }
    let sources = get(styk, "frameSources");
    for (_, frame) in entries(sources) {
        check_frame(frame)?;
    }
    let animation = get(styk, "animation");
    if !is_given(animation) {
        return Ok(());
    }
    if num(get(animation, "version")) != Some(1.0) || !is_array(get(animation, "channels")) || len(get(animation, "channels")) > 100_000 {
        return fail("errors.animationChannels.invalidAuthoredAnimationChannelTable");
    }
    let next_key = get(animation, "nextKeyId");
    if !missing(next_key) && !(safe_integer(next_key) && num(next_key).unwrap() >= 1.0) {
        return fail("errors.animationChannels.invalidAnimationKeyIdentityCounter");
    }
    let mut channel_ids: HashSet<String> = HashSet::new();
    let mut validated_poses: HashSet<usize> = HashSet::new();
    let mut key_count = 0usize;
    let mut source_ids: Option<HashSet<String>> = None;
    let mut figure_type_ids: Option<NumberSet> = None;
    for channel in items(get(animation, "channels")) {
        let ch = Some(&channel);
        let target = prop(ch, "target")?;
        let property = prop(ch, "property")?;
        let (expected, normalized) = channel_id(target, property)?;
        let keys = get(ch, "keys");
        let id = text(get(ch, "id"));
        if id != Some(expected.as_str()) || channel_ids.contains(&expected) || !is_array(keys) {
            return fail("errors.animationChannels.animationChannelsMustHaveUniqueStableIdentities");
        }
        let property = text(property).unwrap();
        let pose_figure = property == "pose" && normalized.kind == "figure";
        let native = get(ch, "nativeProperties");
        if !missing(native) && !(matches!(native, Some(Value::Bool(true))) && property == "pose" && matches!(normalized.kind.as_str(), "figure" | "layer")) {
            return fail("errors.animationChannels.nativePropertyInheritanceIsOnlyValidOnFigure");
        }
        let masked = get(ch, "maskedRanges");
        if !missing(masked) {
            let ranges = items(masked);
            let bad = !pose_figure
                || !is_array(masked)
                || ranges.len() > 100_000
                || ranges.iter().enumerate().any(|(i, range)| {
                    let r = Some(range);
                    !is_array(r)
                        || len(r) != 2
                        || !integer_in(range.item(0).as_ref(), 0.0, f64::INFINITY)
                        || !integer(range.item(1).as_ref())
                        || num(range.item(1).as_ref()).unwrap() <= num(range.item(0).as_ref()).unwrap()
                        || num(range.item(1).as_ref()).unwrap() > 10_000_001.0
                        || (i > 0 && num(range.item(0).as_ref()).unwrap() <= num(ranges[i - 1].item(1).as_ref()).unwrap_or(f64::NAN))
                });
            if bad {
                return fail("errors.animationChannels.invalidPoseVisibilityRanges");
            }
        }
        let base = get(ch, "useBasePose");
        if !missing(base) && !(matches!(base, Some(Value::Bool(true))) && pose_figure) {
            return fail("errors.animationChannels.invalidNativePosePassthrough");
        }
        let anchor = get(ch, "orderAnchor");
        if !missing(anchor) && !(pose_figure && integer_in(anchor, 0.0, 4_294_967_295.0) && num(anchor) != num(get(target, "uid"))) {
            return fail("errors.animationChannels.invalidPoseStackingAnchor");
        }
        let scope = get(target, "figureTypeId");
        if !missing(scope) {
            if figure_type_ids.is_none() {
                let mut set = NumberSet::default();
                for figure in items(report.get("figure_types")) {
                    if let Some(id) = num(figure.get("figure_type_id")) {
                        set.insert(id);
                    }
                }
                figure_type_ids = Some(set);
            }
            if !num(scope).is_some_and(|id| figure_type_ids.as_ref().unwrap().has(id)) {
                return fail("errors.animationChannels.animationSegmentScopeReferencesMissingFigureDefinition");
            }
        }
        let curve = get(ch, "movieclipCurve");
        if !missing(curve) && !(matches!(curve, Some(Value::Bool(true))) && matches!(normalized.kind.as_str(), "figure" | "segment" | "polygon")) {
            return fail("errors.animationChannels.invalidMovieclipCurveContext");
        }
        let end = get(ch, "clipEnd");
        if !missing(end) && !(pose_figure && integer_in(end, 0.0, 10_000_001.0)) {
            return fail("errors.animationChannels.invalidMovieclipEnd");
        }
        let part = get(ch, "movieclipPart");
        if !missing(part) && !(pose_figure && integer_in(get(part, "instance"), 0.0, 4_294_967_295.0) && text(get(part, "path")).is_some_and(|p| js_len(p) <= 1024)) {
            return fail("errors.animationChannels.invalidExpandedMovieclipIdentity");
        }
        let movieclip_curve = truthy(curve);
        let key_list = items(keys);
        if key_list.first().is_some_and(|first| num(first.get("tick")).is_some_and(|t| t < 0.0)) && !movieclip_curve {
            return fail("errors.animationChannels.onlyMovieclipCurvesCanRetainKeysBeforeThe");
        }
        channel_ids.insert(expected);
        let pose = property == "pose";
        if pose && node_id(keys).is_some_and(|id| validated_poses.contains(&id)) {
            continue;
        }
        let mut ids: HashSet<String> = HashSet::new();
        let mut occupied = NumberSet::default();
        let mut previous = if movieclip_curve { -10_000_000.0 } else { -1.0 };
        for key in &key_list {
            key_count += 1;
            if key_count > 1_000_000 {
                return fail("errors.animationChannels.authoredAnimationExceedsTheOneMillionKeyLimit");
            }
            let k = Some(key);
            prop(k, "id")?;
            let key_id = text(get(k, "id"));
            if !key_id.is_some_and(|id| !id.is_empty() && !ids.contains(id)) {
                return fail("errors.animationChannels.animationKeysMustHaveUniqueStableIdentities");
            }
            let tick = get(k, "tick");
            let floor = if movieclip_curve { -10_000_000.0 } else { 0.0 };
            if !integer(tick) || num(tick).unwrap() < floor || num(tick).unwrap() > 10_000_000.0 || num(tick).unwrap() < previous {
                return fail("errors.animationChannels.animationKeysMustBeSortedAtValidWhole");
            }
            let hidden = truthy(get(k, "hidden"));
            if hidden && !pose {
                return fail("errors.animationChannels.onlyNativePoseKeysCanBeHidden");
            }
            let passthrough = get(k, "passthrough");
            if !missing(passthrough) && (!boolean(passthrough) || pose) {
                return fail("errors.animationChannels.onlyScalarKeysSupportABooleanPassthroughInterval");
            }
            let curve = get(k, "nativeCurve");
            if !missing(curve) && (text(curve) != Some("pchip") || !["x", "y", "scale", "rotation"].contains(&property)) {
                return fail("errors.animationChannels.invalidNativePropertyCurve");
            }
            let rotation = get(k, "nativeRotation");
            if !missing(rotation) && (!matches!(rotation, Some(Value::Bool(true))) || property != "rotation") {
                return fail("errors.animationChannels.invalidNativeRotationCurve");
            }
            let mode = get(k, "nativeValueMode");
            if !missing(mode) && (normalized.kind != "figure" || !matches!(text(mode), Some("color" | "opacity")) || text(mode) != Some(property)) {
                return fail("errors.animationChannels.invalidNativePropertySamplingMode");
            }
            let tick_value = num(tick).unwrap();
            if !hidden && occupied.has(tick_value) {
                return fail("errors.animationChannels.multiplePropertyKeysOccupyTheSameFrame");
            }
            if !hidden {
                occupied.insert(tick_value);
            }
            ids.insert(key_id.unwrap().to_string());
            previous = tick_value;
            key_easing(k, if property == "zIndex" { Some("zIndex") } else { None })?;
            animation_value(&normalized.kind, property, get(k, "value"))?;
            let frame_id = path(k, &["value", "frameId"]);
            if pose && is_given(frame_id) {
                if source_ids.is_none() {
                    let mut set: HashSet<String> = HashSet::new();
                    for frame in items(report.get("keyframes")) {
                        if let Some(id) = text(path(Some(&frame), &["_styk", "frameId"])).filter(|id| !id.is_empty()) {
                            set.insert(id.to_string());
                        }
                    }
                    for (id, _) in entries(get(styk, "frameSources")) {
                        set.insert(id.to_string());
                    }
                    source_ids = Some(set);
                }
                if !text(frame_id).is_some_and(|id| source_ids.as_ref().unwrap().contains(id)) {
                    return fail("errors.animationChannels.animationPoseReferencesMissingSourceFrame");
                }
            }
        }
        if pose {
            if let Some(id) = node_id(keys) {
                validated_poses.insert(id);
            }
        }
    }
    Ok(())
}
