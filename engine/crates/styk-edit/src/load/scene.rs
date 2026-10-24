//! `validateScene` (src/pivot/model.mjs): the checks every document passes before the editor holds it,
//! in the editor's order, so the first refusal is the editor's.

use std::collections::HashMap;

use styk_doc::Value;

use super::figure::{self, OriginMetadata};
use super::js::*;
use super::movieclip;
use super::object::{self, bounded_integer, finite_number, float32, rgb};
use crate::EditError;

/// A figure's native handles: `0` and every segment identity.
type Handles = NumberSet;

/// `frame.objects[slot]` for a join's target slot.
fn object_at<'a>(objects: &'a [Value], slot: V) -> V<'a> {
    num(slot).filter(|s| s.is_finite() && s.fract() == 0.0 && *s >= 0.0).and_then(|s| objects.get(s as usize))
}

/// `projectedDrawing(objects, object, figures)` (src/spatial-projection.mjs).
fn projected_drawing(objects: &[Value], object: &Value, figures: &[Value]) -> bool {
    let figure = |id: V| figures.iter().find(|f| f.get("figure_type_id") == id && id.is_some());
    let parent = object_at(objects, path(Some(object), &["join", "target_object_slot"]));
    let clip = figure(object.get("figure_type_id")).and_then(|f| movieclip::asset(f));
    if !(truthy(get(clip, "drawingRotation")) || truthy(get(clip, "spatialMeshes"))) {
        return false;
    }
    let target = path(Some(object), &["join", "target_handle_id"]);
    figure(get(parent, "figure_type_id")).is_some_and(|f| items(f.get("segments")).iter().any(|s| s.get("segment_id") == target && truthy(path(Some(s), &["_stykRig", "spatial", "origin"]))))
}

/// `validateSpatialJoins(frame, figures)`: perspective needs a single figure or a projected drawing.
pub(super) fn spatial_joins(frame: &Value, figures: &[Value]) -> Result<(), EditError> {
    let objects = items(frame.get("objects"));
    for o in &objects {
        if !truthy(o.get("join")) {
            continue;
        }
        let own = truthy(path(Some(o), &["_stykSpatial", "camera", "strength"]));
        let parent = object_at(&objects, path(Some(o), &["join", "target_object_slot"]));
        let parent_perspective = truthy(path(parent, &["_stykSpatial", "camera", "strength"])) && !projected_drawing(&objects, o, figures);
        if own || parent_perspective {
            return fail("errors.spatialProjection.perspectiveRequiresASingleSpatialFigureOrA");
        }
    }
    Ok(())
}

/// The identities of a document's figure types: `Map<figure_type_id, figure>` in the order of the table.
struct Types<'a> {
    figures: Vec<&'a Value>,
    by_id: HashMap<u64, usize>,
}

fn id_key(value: f64) -> u64 {
    if value == 0.0 { 0.0f64.to_bits() } else { value.to_bits() }
}

impl Types<'_> {
    fn get(&self, id: V) -> Option<&Value> {
        num(id).and_then(|n| self.by_id.get(&id_key(n))).map(|i| self.figures[*i])
    }
}

/// The checks of one frame's objects and ordering, against the figure table.
struct Context<'a> {
    report: &'a Value,
    types: &'a Types<'a>,
    handles: &'a HashMap<u64, Handles>,
    origins: &'a HashMap<u64, OriginMetadata>,
}

/// `validateSceneSteps(report)` on `frames`: the report's own keyframes, or the pose sources and draft
/// baseline the load checks the same way (`{...report, keyframes}`).
pub(super) fn validate_scene(report: &Value, frames: Option<&[Value]>) -> Result<(), EditError> {
    if !report.is_object() || !matches!(num(report.get("version")), Some(v) if [2.0, 3.0, 4.0, 5.0].contains(&v)) {
        return fail("errors.model.expectedADecodedPivot25Scene");
    }
    for key in ["canvas_width", "canvas_height"] {
        if !integer_in(report.get(key), 1.0, 100_000.0) {
            return fail("errors.model.canvasDimensionsMustBeIntegersFrom1To");
        }
    }
    bounded_integer(report.get("fps"), 1.0, 1000.0)?;
    let delay = report.get("frame_delay_ms");
    if is_given(delay) {
        bounded_integer(delay, 1.0, 65535.0)?;
    }
    let figures_value = report.get("figure_types");
    let keyframes_value = report.get("keyframes");
    let own_frames: Vec<Value>;
    let (frames, frames_ok): (&[Value], bool) = match frames {
        Some(frames) => (frames, true),
        None => {
            own_frames = items(keyframes_value);
            (&own_frames, is_array(keyframes_value))
        }
    };
    let table_ok = is_array(figures_value) && len(figures_value) <= 65535 && frames_ok;
    if !table_ok || frames.is_empty() || frames.len() > 100_000 {
        return fail("errors.model.sceneMustHaveAValidFigureTableAnd");
    }
    let figures = items(figures_value);
    let mut types = Types { figures: Vec::with_capacity(figures.len()), by_id: HashMap::new() };
    let mut handles: HashMap<u64, Handles> = HashMap::new();
    let mut origins: HashMap<u64, OriginMetadata> = HashMap::new();
    let (mut total_segments, mut total_objects) = (0usize, 0usize);
    for fig in &figures {
        let id = prop(Some(fig), "figure_type_id")?;
        if !integer(id) || types.by_id.contains_key(&id_key(num(id).unwrap())) || !is_array(fig.get("segments")) {
            return fail("errors.model.invalidOrRepeatedFigureType");
        }
        types.by_id.insert(id_key(num(id).unwrap()), types.figures.len());
        types.figures.push(fig);
        let segments = items(fig.get("segments"));
        if segments.len() > 30000 {
            return fail("errors.editorBuilderBranch.aNativePivotFigureSupportsAtMost30");
        }
        total_segments += segments.len();
        if total_segments > 1_000_000 {
            return fail("errors.model.figureTableExceedsTheOneMillionSegmentLimit");
        }
        // `parents`: segment identity to its parent's, in the order of the table.
        let mut parents: Vec<(f64, Option<f64>)> = Vec::with_capacity(segments.len());
        let mut known = NumberSet::default();
        for s in &segments {
            if truthy(prop(Some(s), "paint")?) {
                crate::recolor::normalize_paint(s.get("paint").unwrap())?;
            }
            if truthy(s.get("_sticknodes")) {
                object::sticknodes_shape(s.get("_sticknodes"))?;
            }
            let segment_id = s.get("segment_id");
            if !integer_in(segment_id, 1.0, 65535.0) || known.has(num(segment_id).unwrap()) {
                return fail("errors.model.invalidOrRepeatedSegmentHandle");
            }
            known.insert(num(segment_id).unwrap());
            parents.push((num(segment_id).unwrap(), num(s.get("parent_id"))));
            for key in ["length", "angle_rad", "thickness"] {
                if key == "angle_rad" { finite_number(s.get(key))?; } else { float32(s.get(key))?; }
            }
            figure::segment_style(s)?;
            figure::pose_choice(s)?;
            figure::control_metadata(s)?;
        }
        let parent_of: HashMap<u64, Option<f64>> = parents.iter().map(|(id, parent)| (id_key(*id), *parent)).collect();
        let mut done = NumberSet::default();
        done.insert(0.0);
        for (id, _) in &parents {
            if done.has(*id) {
                continue;
            }
            let mut seen = NumberSet::default();
            let mut chain = Vec::new();
            let mut p = Some(*id);
            while !p.is_some_and(|p| done.has(p)) {
                let Some(current) = p.filter(|p| parent_of.contains_key(&id_key(*p)) && !seen.has(*p)) else {
                    return fail("errors.model.figureHasAMissingParentOrACycle");
                };
                seen.insert(current);
                chain.push(current);
                p = parent_of[&id_key(current)];
            }
            for p in chain {
                done.insert(p);
            }
        }
        if segments.iter().any(|s| truthy(s.get("_stykRig"))) {
            crate::rig_behavior::validate_rig(&segments)?;
        }
        figure::figure_pose_choices(fig)?;
        if !missing(path(Some(fig), &["_styk", "spatialMesh"])) {
            figure::spatial_mesh(fig)?;
        }
        let mut set = NumberSet::default();
        set.insert(0.0);
        for (id, _) in &parents {
            set.insert(*id);
        }
        handles.insert(id_key(num(id).unwrap()), set);
        if !missing(path(Some(fig), &["_styk", "animationOrigin"])) {
            if let Some(metadata) = figure::origin_support(fig)? {
                origins.insert(id_key(num(id).unwrap()), metadata);
            }
        }
    }
    let mut continuation_types = NumberSet::default();
    for fig in &types.figures {
        if truthy(path(Some(fig), &["_styk", "movieclip"])) {
            continuation_types.insert(num(fig.get("figure_type_id")).unwrap());
        }
    }
    let context = Context { report, types: &types, handles: &handles, origins: &origins };
    for frame in frames {
        let f = Some(frame);
        object::vfx_owner(f)?;
        movieclip::continuations(f, &continuation_types)?;
        for step in movieclip::steps(frame) {
            movieclip::playback(get(Some(&step), "playback"))?;
        }
        if !frame.is_object() || !is_array(frame.get("objects")) || !integer_in(frame.get("duration_raw"), 0.0, 65535.0) {
            return fail("errors.model.invalidKeyframeObjectsOrDuration");
        }
        let objects = items(frame.get("objects"));
        total_objects += objects.len();
        spatial_joins(frame, &figures)?;
        if total_objects > 2_000_000 {
            return fail("errors.model.sceneExceedsTheTwoMillionObjectLimit");
        }
        frame_objects(&context, frame, &objects)?;
        let order = frame.get("object_draw_order");
        if truthy(order) {
            let listed = items(order);
            let mut seen = NumberSet::default();
            let unique = listed.iter().all(|v| match v {
                Value::Num(n) => seen.insert(*n),
                _ => true,
            });
            // `new Set(order).size !== order.length` also counts non-number entries as distinct values.
            if !is_array(order) || len(order) != objects.len() || !unique || !listed.iter().all(|v| integer_in(Some(v), 0.0, objects.len() as f64 - 1.0)) {
                return fail("errors.model.invalidFigureLayerOrder");
            }
        }
        let camera = frame.get("camera");
        if truthy(camera) && !truthy(get(camera, "is_default")) {
            for key in ["x", "y", "scale"] {
                float32(get(camera, key))?;
            }
            if num(get(camera, "scale")).is_some_and(|s| s <= 0.0) {
                return fail("errors.editorCamera.cameraScaleMustBePositive");
            }
            let inverse = fround(1.0 / fround(num(get(camera, "scale")).unwrap_or(1.0)));
            if !inverse.is_finite() || inverse <= 0.0 {
                return fail("errors.background.cameraScaleExceedsTheNativeRenderingRange");
            }
            let angle = get(camera, "angle_rad");
            if !missing(angle) {
                finite_number(angle)?;
            }
        }
    }
    for fig in &figures {
        let style = path(Some(fig), &["segment_decode", "global_style"]);
        if truthy(style) {
            let width = get(style, "outline_thickness");
            if !missing(width) {
                float32(width)?;
                if num(width).is_some_and(|w| w < 0.0) {
                    return fail("errors.model.outlineWidthCannotBeNegative");
                }
            }
            let bits = get(style, "u28");
            if !missing(bits) {
                bounded_integer(bits, 0.0, 4_294_967_295.0)?;
                let width = f32::from_bits(num(bits).unwrap() as u32);
                if !width.is_finite() || width < 0.0 {
                    return fail("errors.model.invalidOutlineWidth");
                }
            }
            if truthy(get(style, "rgb")) {
                rgb(get(style, "rgb"))?;
            }
            let u30 = get(style, "u30");
            if !missing(u30) {
                bounded_integer(u30, 0.0, 255.0)?;
            }
        }
        let own_handles = &handles[&id_key(num(fig.get("figure_type_id")).unwrap())];
        let polyfills = fig.get("polyfills");
        for poly in if truthy(polyfills) { items(polyfills) } else { Vec::new() } {
            if truthy(poly.get("_stykSurface")) {
                figure::surface(&poly, own_handles)?;
            }
            let order = poly.get("z_order");
            if !missing(order) {
                float32(order)?;
            }
            let alpha = poly.get("color_alpha");
            if !missing(alpha) {
                finite_number(alpha)?;
                if num(alpha).is_some_and(|a| !(0.0..=1.0).contains(&a)) {
                    return fail("errors.model.polygonOpacityMustBeBetweenZeroAndOne");
                }
            }
            if truthy(poly.get("color_rgb")) {
                rgb(poly.get("color_rgb"))?;
            }
            let raw = poly.get("alpha_raw");
            if !missing(raw) {
                bounded_integer(raw, 0.0, 255.0)?;
            }
        }
    }
    let mut backgrounds = NumberSet::default();
    backgrounds.insert(0.0);
    let list = report.get("backgrounds");
    for bg in if truthy(list) { items(list) } else { Vec::new() } {
        let b = Some(&bg);
        if truthy(prop(b, "paint")?) {
            crate::recolor::normalize_paint(bg.get("paint").unwrap())?;
        }
        let id = get(b, "background_id");
        if !integer(id) || num(id).unwrap() < 1.0 || backgrounds.has(num(id).unwrap()) {
            return fail("errors.model.invalidOrRepeatedBackgroundId");
        }
        backgrounds.insert(num(id).unwrap());
        let kind = num(get(b, "kind"));
        if kind == Some(2.0) {
            bounded_integer(get(b, "color"), 0.0, 4_294_967_295.0)?;
        }
        if kind == Some(3.0) || kind == Some(4.0) {
            bounded_integer(get(b, "color_a"), 0.0, 4_294_967_295.0)?;
            bounded_integer(get(b, "color_b"), 0.0, 4_294_967_295.0)?;
            for key in ["x1", "y1", "x2", "y2"] {
                float32(get(b, key))?;
            }
            if kind == Some(4.0) && (num(get(b, "x2")).unwrap() < 0.0 || num(get(b, "y2")).unwrap() < 0.0) {
                return fail("errors.model.radialBackgroundRadiiCannotBeNegative");
            }
        }
    }
    for f in frames {
        let reference = |v: V| match v {
            None | Some(Value::Null) => Some(0.0),
            Some(Value::Num(n)) => Some(*n),
            _ => None,
        };
        let first = reference(f.get("background_id"));
        let second = reference(f.get("background_id_b"));
        let known = |id: Option<f64>| id.is_some_and(|n| backgrounds.has(n));
        if !known(first) || (truthy(f.get("background_mix")) && !known(second)) {
            return fail("errors.model.frameReferencesAMissingBackground");
        }
        let mix = f.get("background_mix");
        if !missing(mix) {
            bounded_integer(mix, 0.0, 255.0)?;
        }
    }
    Ok(())
}

/// One frame's objects: identities, poses, animation origins and joins, then the join graph.
fn frame_objects(context: &Context, frame: &Value, objects: &[Value]) -> Result<(), EditError> {
    let mut uids = NumberSet::default();
    for o in objects {
        let fig = context.types.get(o.get("figure_type_id"));
        let Some(fig) = fig.filter(|_| integer(o.get("unique_id")) && !uids.has(num(o.get("unique_id")).unwrap())) else {
            return fail("errors.model.unknownFigureOrRepeatedObjectIdentity");
        };
        uids.insert(num(o.get("unique_id")).unwrap());
        object::object_pose(context.report, o, fig)?;
        let clip = o.get("_stykMovieclip");
        if truthy(clip) {
            movieclip::playback(clip)?;
        }
        let type_id = id_key(num(fig.get("figure_type_id")).unwrap());
        if !missing(o.get("_stykAnimationOrigin")) || truthy(path(Some(fig), &["_styk", "animationOrigin"])) {
            figure::origin_object(o, fig, context.origins.get(&type_id))?;
        }
        let join = o.get("join");
        if truthy(join) {
            let parent = object_at(objects, get(join, "target_object_slot"));
            let target = context.types.get(get(parent, "figure_type_id"));
            let reachable = target.is_some_and(|t| context.handles[&id_key(num(t.get("figure_type_id")).unwrap())].has(num(get(join, "target_handle_id")).unwrap_or(f64::NAN)));
            if !reachable {
                return fail("errors.model.joinPointsToAMissingFigureOrHandle");
            }
        }
    }
    let mut finished = vec![false; objects.len()];
    for i in 0..objects.len() {
        if finished[i] {
            continue;
        }
        let mut slot = i as f64;
        let mut chain: Vec<usize> = Vec::new();
        loop {
            let at = slot as usize;
            if slot.is_finite() && slot >= 0.0 && slot.fract() == 0.0 && at < objects.len() && finished[at] {
                break;
            }
            if chain.iter().any(|c| *c as f64 == slot) {
                return fail("errors.editorSelection.figuresContainACyclicJoin");
            }
            if !(slot.is_finite() && slot >= 0.0 && slot.fract() == 0.0 && at < objects.len()) {
                return Err(refuse(TYPE_ERROR));
            }
            chain.push(at);
            let join = objects[at].get("join");
            if !truthy(join) {
                break;
            }
            slot = num(get(join, "target_object_slot")).unwrap_or(f64::NAN);
        }
        for slot in chain {
            finished[slot] = true;
        }
    }
    let _ = frame;
    Ok(())
}
