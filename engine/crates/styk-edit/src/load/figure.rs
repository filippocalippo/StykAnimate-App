//! What a figure definition may hold: the segment table's styling, the rig's pose choices and detail
//! controls, faces, 3D meshes, and the animation origin's support graph (the figure half of
//! src/pivot/model.mjs and the validators it calls).

use std::collections::HashSet;

use styk_doc::{Elements, Value};

use super::js::*;
use super::object::{bounded_integer, finite_number, float32, rgb};
use crate::EditError;

/// `styleValues(s)` of src/pivot/model.mjs: a segment's colours and codes.
pub(super) fn segment_style(s: &Value) -> Result<(), EditError> {
    let order = s.get("z_order");
    if !missing(order) {
        float32(order)?;
    }
    let bend = s.get("bend_rad");
    if !missing(bend) {
        finite_number(bend)?;
    }
    let color = s.get("color_rgb");
    if !missing(color) {
        rgb(color)?;
    }
    let transparency = s.get("transparency");
    if !missing(transparency) {
        bounded_integer(transparency, 0.0, 255.0)?;
    }
    let secondary = s.get("secondary");
    if truthy(secondary) {
        rgb(get(secondary, "rgb"))?;
        bounded_integer(get(secondary, "a"), 0.0, 255.0)?;
    }
    let aux = s.get("aux_code");
    if !missing(aux) {
        bounded_integer(aux, 0.0, 255.0)?;
    }
    let primitive = s.get("primitive_code");
    if !missing(primitive) {
        bounded_integer(primitive, 0.0, 6.0)?;
    }
    Ok(())
}

/// `validatePoseChoice(segment)` (src/rig-pose-choices.mjs): a visibility choice on a 3D bone.
pub(super) fn pose_choice(segment: &Value) -> Result<(), EditError> {
    let choice = segment.get("_stykPoseChoice");
    if missing(choice) {
        return Ok(());
    }
    let within = is_record(choice) && entries(choice).iter().all(|(key, _)| ["group", "label", "shown", "hidden"].contains(&&**key));
    let shown = num(get(choice, "shown"));
    let hidden = num(get(choice, "hidden"));
    let valid = within
        && name(get(choice, "group"), 80)
        && name(get(choice, "label"), 80)
        && finite_in(get(choice, "shown"), 0.0, 1e6)
        && finite_in(get(choice, "hidden"), 0.0, 1e6)
        && shown != hidden
        && truthy(path(Some(segment), &["_stykRig", "spatial", "origin"]))
        && !num(segment.get("length")).is_some_and(|length| length <= 0.0);
    if !valid {
        return fail("errors.rigPoseChoices.aPoseChoiceNeedsASpatialBoneNames");
    }
    Ok(())
}

/// `validateControlMetadata(segment)` (src/rig-control-details.mjs).
pub(super) fn control_metadata(segment: &Value) -> Result<(), EditError> {
    let control = segment.get("_stykControl");
    if missing(control) {
        return Ok(());
    }
    if !is_record(control) || entries(control).iter().any(|(key, _)| &**key != "level") || text(get(control, "level")) != Some("detail") {
        return fail("errors.rigConstraints.invalidRigBehavior");
    }
    Ok(())
}

const POSE_CHOICES: &str = "Invalid native rig pose choices.";

/// `validateFigurePoseChoices(figure)`: the channel groups of `figure._styk.poseChoices`.
pub(super) fn figure_pose_choices(figure: &Value) -> Result<(), EditError> {
    let groups = path(Some(figure), &["_styk", "poseChoices"]);
    if missing(groups) {
        return Ok(());
    }
    let bad = || fail(POSE_CHOICES);
    if !is_array(groups) || len(groups) == 0 || len(groups) > 16 {
        return bad();
    }
    let segments = items(figure.get("segments"));
    let ids: Vec<f64> = segments.iter().filter_map(|s| num(s.get("segment_id"))).collect();
    let mut allowed = NumberSet::default();
    for s in &segments {
        let spatial = path(Some(s), &["_stykRig", "spatial"]);
        if truthy(get(spatial, "origin")) {
            for value in [s.get("segment_id"), get(spatial, "turn"), get(spatial, "pitch")] {
                if let Some(n) = num(value) {
                    allowed.insert(n);
                }
            }
        }
    }
    let mut group_names: HashSet<String> = HashSet::new();
    for s in &segments {
        if let Some(choice) = s.get("_stykPoseChoice").filter(|c| c.truthy()) {
            if let Some(group) = choice.get("group").and_then(Value::as_str) {
                group_names.insert(group.to_string());
            }
        }
    }
    let known = |entries: &[(std::sync::Arc<str>, &Value)], keys: &[&str]| entries.iter().all(|(key, _)| keys.contains(&&**key));
    let mut total = 0usize;
    for group in items(groups) {
        let g = Some(&group);
        let group_name = text(get(g, "name")).map(str::to_string);
        if !truthy(g) || !known(&entries(g), &["name", "choices"]) || !name(get(g, "name"), 80) || group_names.contains(group_name.as_deref().unwrap_or("")) {
            return bad();
        }
        let choices = get(g, "choices");
        if !is_array(choices) || len(choices) == 0 || len(choices) > 64 {
            return bad();
        }
        group_names.insert(group_name.unwrap());
        let mut choice_ids = NumberSet::default();
        let mut labels: HashSet<String> = HashSet::new();
        let mut signature: Option<(Vec<f64>, Vec<f64>)> = None;
        for choice in items(choices) {
            let c = Some(&choice);
            let label = text(get(c, "label")).map(str::to_string);
            if !truthy(c)
                || !known(&entries(c), &["id", "label", "angles", "lengths"])
                || !integer_in(get(c, "id"), 1.0, 65535.0)
                || choice_ids.has(num(get(c, "id")).unwrap())
                || !name(get(c, "label"), 80)
                || labels.contains(label.as_deref().unwrap_or(""))
            {
                return bad();
            }
            choice_ids.insert(num(get(c, "id")).unwrap());
            labels.insert(label.unwrap());
            let mut keyed: Vec<Vec<f64>> = Vec::new();
            for key in ["angles", "lengths"] {
                let list = get(c, key);
                if !is_array(list) || len(list) > 2048 {
                    return bad();
                }
                let mut seen = NumberSet::default();
                let mut order = Vec::new();
                for pair in items(list) {
                    let p = Some(&pair);
                    let id = num(pair.item(0).as_ref());
                    let valid = is_array(p)
                        && len(p) == 2
                        && id.is_some_and(|id| allowed.has(id) && ids.contains(&id) && !seen.has(id))
                        && finite(pair.item(1).as_ref())
                        && num(pair.item(1).as_ref()).is_some_and(|v| v.abs() <= 1e6 && !(key == "lengths" && v < 0.0));
                    if !valid {
                        return bad();
                    }
                    seen.insert(id.unwrap());
                    order.push(id.unwrap());
                    total += 1;
                    if total > 32768 {
                        return bad();
                    }
                }
                order.sort_by(|a, b| a.partial_cmp(b).unwrap());
                keyed.push(order);
            }
            if keyed[0].is_empty() && keyed[1].is_empty() {
                return bad();
            }
            let current = (keyed[0].clone(), keyed[1].clone());
            if signature.as_ref().is_some_and(|previous| *previous != current) {
                return bad();
            }
            signature = Some(current);
        }
    }
    Ok(())
}

/// `validateSurface(poly, ids)` (src/pivot/surfaces.mjs): face visibility on a polygon.
pub(super) fn surface(poly: &Value, handles: &NumberSet) -> Result<(), EditError> {
    let s = poly.get("_stykSurface");
    if missing(s) {
        return Ok(());
    }
    let basis = get(s, "basis");
    let listed = |v: V| items(v).iter().all(|id| integer(Some(id)) && handles.has(num(Some(id)).unwrap()));
    let distinct = {
        let mut seen = NumberSet::default();
        items(basis).iter().all(|id| num(Some(id)).is_some_and(|n| seen.insert(n)))
    };
    if !truthy(s) || !is_array(basis) || len(basis) != 3 || !distinct || !listed(basis) {
        return fail("errors.surfaces.faceVisibilityNeedsThreeDistinctExistingReferenceJoints");
    }
    let side = get(s, "side");
    if !missing(side) && !matches!(text(side), Some("front" | "back")) {
        return fail("errors.surfaces.chooseFrontBackOrBothForFaceVisibility");
    }
    let flipped = get(s, "flipped");
    if !missing(flipped) && !boolean(flipped) {
        return fail("errors.surfaces.faceFacingMustBeABoolean");
    }
    let depth = get(s, "depth");
    if !missing(depth) && (!is_array(depth) || len(depth) == 0 || len(depth) > 1024 || !listed(depth)) {
        return fail("errors.surfaces.faceDepthNeedsExistingReferenceJointsUpTo");
    }
    let test = get(s, "depthTest");
    if !missing(test) {
        let on = matches!(test, Some(Value::Bool(true)));
        if !boolean(test) || (on && (len(depth) != 3 || len(poly.get("segment_ids")) != 3)) {
            return fail("errors.surfaces.depthTestingNeedsATriangleWithOneDepth");
        }
    }
    Ok(())
}

/// A list of numbers read element by element, as the validators do.
fn list<'a>(value: V<'a>) -> Option<Elements<'a>> {
    value.and_then(Value::elements)
}

fn at(elements: Elements, index: usize) -> Option<Value> {
    elements.get(index)
}

/// `validateSpatialMesh(figure)` (src/spatial-mesh.mjs).
pub(super) fn spatial_mesh(figure: &Value) -> Result<(), EditError> {
    const KEYS: [&str; 12] = ["positions", "bones", "weights", "indices", "colors", "materials", "basis", "z", "views", "viewVertices", "viewPoints", "groups"];
    let mesh = path(Some(figure), &["_styk", "spatialMesh"]);
    if missing(mesh) {
        return Ok(());
    }
    if !is_record(mesh) || entries(mesh).iter().any(|(key, _)| !KEYS.contains(&&**key)) {
        return fail("errors.spatialMesh.invalid3dMesh");
    }
    let (positions, bones, weights, indices, colors, materials, basis) =
        (get(mesh, "positions"), get(mesh, "bones"), get(mesh, "weights"), get(mesh, "indices"), get(mesh, "colors"), get(mesh, "materials"), get(mesh, "basis"));
    if !is_array(positions) || len(positions) < 9 || len(positions) % 3 != 0 {
        return fail("errors.spatialMesh.a3dMeshNeedsXyzPositionsForAt");
    }
    let count = len(positions) / 3;
    if count > 200_000 {
        return fail("errors.spatialMesh.a3dMeshCanHaveUpToVertices");
    }
    let bounded = |v: &Value| v.as_f64().is_some_and(|n| n.is_finite() && n.abs() <= 1e6);
    for v in list(positions).unwrap().iter() {
        if !bounded(&v) {
            return fail("errors.spatialMesh.failure3dMeshPositionsMustBeFinite");
        }
    }
    if !is_array(bones) || len(bones) != count * 4 || !is_array(weights) || len(weights) != count * 4 {
        return fail("errors.spatialMesh.each3dMeshVertexNeedsFourBoneAnd");
    }
    let segments = items(figure.get("segments"));
    let index_of = |bone: f64| segments.iter().position(|s| num(s.get("segment_id")) == Some(bone));
    let handles: Vec<f64> = segments.iter().filter_map(|s| num(s.get("segment_id"))).collect();
    let (bone_list, weight_list) = (list(bones).unwrap(), list(weights).unwrap());
    let mut checked = NumberSet::default();
    for v in 0..count {
        let mut sum = 0.0;
        for k in 0..4 {
            let (bone, weight) = (at(bone_list, v * 4 + k), at(weight_list, v * 4 + k));
            let bone_id = num(bone.as_ref());
            let weight_value = num(weight.as_ref());
            if !integer_in(bone.as_ref(), 0.0, 65535.0) || !weight_value.is_some_and(|w| w.is_finite() && (0.0..=1.0).contains(&w)) {
                return fail("errors.spatialMesh.failure3dMeshBindingsNeedBoneIdsAndWeights");
            }
            let (bone_id, weight_value) = (bone_id.unwrap(), weight_value.unwrap());
            if (bone_id == 0.0) != (weight_value == 0.0) || (k == 0 && bone_id == 0.0) {
                return fail("errors.spatialMesh.bindEvery3dMeshVertexToAtLeast");
            }
            if bone_id == 0.0 {
                continue;
            }
            for j in 0..k {
                if num(at(bone_list, v * 4 + j).as_ref()) == Some(bone_id) {
                    return fail("errors.spatialMesh.a3dMeshVertexCannotBindOneBone");
                }
            }
            if !checked.has(bone_id) {
                let articulated = index_of(bone_id).is_some_and(|i| truthy(path(Some(&segments[i]), &["_stykRig", "spatial", "origin"])));
                if !articulated {
                    return fail("errors.spatialMesh.failure3dMeshVerticesMustBindArticulatedSpatialJoints");
                }
                checked.insert(bone_id);
            }
            sum += weight_value;
        }
        if (sum - 1.0).abs() > 1e-6 {
            return fail("errors.spatialMesh.failure3dMeshVertexWeightsMustAddUpTo");
        }
    }
    if !is_array(indices) || len(indices) == 0 || len(indices) % 3 != 0 {
        return fail("errors.spatialMesh.a3dMeshNeedsTriangleIndices");
    }
    let triangles = len(indices) / 3;
    if triangles > 400_000 {
        return fail("errors.spatialMesh.a3dMeshCanHaveUpToTriangles");
    }
    let index_list = list(indices).unwrap();
    for t in 0..triangles {
        let corner: Vec<Option<Value>> = (0..3).map(|i| at(index_list, t * 3 + i)).collect();
        for n in &corner {
            if !integer_in(n.as_ref(), 0.0, count as f64 - 1.0) {
                return fail("errors.spatialMesh.failure3dMeshTrianglesMustReferenceExistingVertices");
            }
        }
        let n: Vec<f64> = corner.iter().map(|c| num(c.as_ref()).unwrap()).collect();
        if n[0] == n[1] || n[1] == n[2] || n[0] == n[2] {
            return fail("errors.spatialMesh.failure3dMeshTrianglesNeedThreeDifferentVertices");
        }
    }
    let palette = |c: &Value| c.is_array() && c.array_len() == Some(3) && items(Some(c)).iter().all(|v| integer_in(Some(v), 0.0, 255.0));
    if !is_array(colors) || len(colors) == 0 || len(colors) > 1024 || !items(colors).iter().all(palette) {
        return fail("errors.spatialMesh.a3dMeshNeeds1RgbColours");
    }
    if !is_array(materials) || len(materials) != triangles || !items(materials).iter().all(|i| integer_in(Some(i), 0.0, len(colors) as f64 - 1.0)) {
        return fail("errors.spatialMesh.each3dMeshTriangleNeedsAColour");
    }
    let basis_ok = is_array(basis)
        && len(basis) == 3
        && items(basis).iter().all(|id| integer(Some(id)) && (num(Some(id)) == Some(0.0) || handles.contains(&num(Some(id)).unwrap())));
    let basis_numbers: Vec<f64> = items(basis).iter().filter_map(Value::as_f64).collect();
    if !basis_ok || basis_numbers[1] == 0.0 || basis_numbers[2] == 0.0 || basis_numbers[1] == basis_numbers[2] {
        return fail("errors.spatialMesh.a3dMeshNeedsItsOriginXAnd");
    }
    let z = get(mesh, "z");
    if !missing(z) && !num(z).is_some_and(|n| n.is_finite() && n.abs() <= 1e6) {
        return fail("errors.spatialMesh.failure3dMeshDepthOrderMustBeFinite");
    }
    let (views, vertices, points) = (get(mesh, "views"), get(mesh, "viewVertices"), get(mesh, "viewPoints"));
    if !missing(views) || !missing(vertices) || !missing(points) {
        let view_count = num(views).filter(|v| *v == 4.0 || *v == 8.0);
        if view_count.is_none() || !is_array(vertices) || len(vertices) == 0 || !is_array(points) || len(points) != len(vertices) * view_count.unwrap() as usize * 3 {
            return fail("errors.spatialMesh.viewCorrectedMeshVerticesNeedFourOrEight");
        }
        let mut previous = -1.0;
        for v in items(vertices) {
            let n = num(Some(&v));
            if !integer(Some(&v)) || n.unwrap() <= previous || n.unwrap() >= count as f64 {
                return fail("errors.spatialMesh.viewCorrectedVerticesMustBeListedOnceIn");
            }
            if num(at(weight_list, n.unwrap() as usize * 4).as_ref()) != Some(1.0) {
                return fail("errors.spatialMesh.viewCorrectedMeshVerticesMustFollowOneBone");
            }
            previous = n.unwrap();
        }
        for n in list(points).unwrap().iter() {
            if !bounded(&n) {
                return fail("errors.spatialMesh.failure3dMeshViewPositionsMustBeFinite");
            }
        }
    }
    let groups = get(mesh, "groups");
    if !missing(groups) {
        if !is_array(groups) || len(groups) > 1024 {
            return fail("errors.spatialMesh.invalid3dMeshParts");
        }
        let mut end = 0.0;
        for group in items(groups) {
            let g = Some(&group);
            let (start, span) = (num(get(g, "start")), num(get(g, "count")));
            let valid = is_object_type(g)
                && !matches!(g, Some(Value::Null))
                && entries(g).iter().all(|(key, _)| ["name", "start", "count"].contains(&&**key))
                && text(get(g, "name")).is_some_and(|n| js_len(n) <= 256)
                && integer(get(g, "start"))
                && integer(get(g, "count"))
                && span.unwrap() >= 1.0
                && start.unwrap() >= end
                && start.unwrap() + span.unwrap() <= triangles as f64;
            if !valid {
                return fail("errors.spatialMesh.failure3dMeshPartsNeedNamesAndOrderedTriangle");
            }
            end = start.unwrap() + span.unwrap();
        }
    }
    Ok(())
}

/// What the object checks need of a validated animation origin (`validateOriginSupportSteps`' metadata).
#[derive(Clone, Debug, Default)]
pub(super) struct OriginMetadata {
    pub support: bool,
    pub ghosts: Vec<usize>,
}

const ORIGIN: &str = "errors.animationOriginValidation.details.";

fn origin_fail<T>(detail: &str) -> Result<T, EditError> {
    Err(refuse(&format!("{ORIGIN}{detail}")))
}

fn origin_integer(value: V, low: f64, high: f64) -> Result<f64, EditError> {
    if !integer_in(value, low, high) {
        return origin_fail("mustBeAnIntegerFromTo");
    }
    Ok(num(value).unwrap())
}

fn origin_finite(value: V) -> Result<f64, EditError> {
    match num(value) {
        Some(n) if n.is_finite() => Ok(n),
        _ => origin_fail("mustBeFinite"),
    }
}

fn origin_float32(value: V) -> Result<(), EditError> {
    let n = origin_finite(value)?;
    if !fround(n).is_finite() {
        return origin_fail("exceedsNativeFloat32Range");
    }
    Ok(())
}

fn origin_pose(pose: V) -> Result<(), EditError> {
    if !is_record(pose) {
        return origin_fail("mustBeAPoseRecord");
    }
    origin_finite(get(pose, "angle_rad"))?;
    origin_finite(get(pose, "bend_rad"))?;
    origin_float32(get(pose, "length"))
}

/// `validateOriginSupportSteps(figure, origin)` (src/animation-origin-validation.mjs).
pub(super) fn origin_support(figure: &Value) -> Result<Option<OriginMetadata>, EditError> {
    const MAX_BONES: usize = 100_000;
    let origin = path(Some(figure), &["_styk", "animationOrigin"]);
    if missing(origin) {
        return Ok(None);
    }
    if !is_record(origin) || !is_array(figure.get("segments")) {
        return origin_fail("mustDescribeAnExistingFigure");
    }
    let mut handles = NumberSet::default();
    handles.insert(0.0);
    let mut live = NumberSet::default();
    for segment in items(figure.get("segments")) {
        let id = origin_integer(segment.get("segment_id"), 1.0, 65535.0)?;
        if live.has(id) {
            return origin_fail("hasRepeatedNativeHandles");
        }
        handles.insert(id);
        live.insert(id);
    }
    let support = get(origin, "support");
    if missing(support) {
        let handle = get(origin, "handleId");
        let rotation = get(origin, "rotationHandleId");
        if !integer(handle) || !handles.has(num(handle).unwrap()) || !integer(rotation) || !live.has(num(rotation).unwrap()) || !boolean(get(origin, "reversed")) {
            return origin_fail("mustReferenceExistingNativeHandles");
        }
        return Ok(Some(OriginMetadata::default()));
    }
    let bones = get(support, "bones");
    if !is_record(support) || num(get(support, "version")) != Some(1.0) || !is_array(bones) || len(bones) < 1 || len(bones) > MAX_BONES {
        return origin_fail("supportNeedsVersion1And1100000");
    }
    let bones = items(bones);
    let count = bones.len();
    let mut bound = NumberSet::default();
    let mut ghosts = Vec::new();
    let mut parents = vec![-1i64; count];
    for (index, bone) in bones.iter().enumerate() {
        let b = Some(bone);
        if !is_record(b) {
            return origin_fail("supportBoneMustBeARecord");
        }
        let parent = origin_integer(get(b, "parent"), -1.0, count as f64 - 1.0)?;
        if parent == index as f64 {
            return origin_fail("supportContainsASelfParentCycle");
        }
        parents[index] = parent as i64;
        if !boolean(get(b, "reversed")) {
            return origin_fail("supportBoneReversedMustBeBoolean");
        }
        origin_pose(b)?;
        let handle = get(b, "handleId");
        if is_null(handle) {
            ghosts.push(index);
        } else {
            if !integer(handle) || !live.has(num(handle).unwrap()) || bound.has(num(handle).unwrap()) {
                return origin_fail("supportMustBindEachExistingSegmentExactlyOnce");
            }
            bound.insert(num(handle).unwrap());
        }
    }
    if bound.len() != live.len() {
        return origin_fail("supportIsMissingALiveSegmentBinding");
    }
    let mut state = vec![0u8; count];
    for first in 0..count {
        let mut cursor = first as i64;
        while cursor != -1 && state[cursor as usize] == 0 {
            state[cursor as usize] = 1;
            cursor = parents[cursor as usize];
        }
        if cursor != -1 && state[cursor as usize] == 1 {
            return origin_fail("supportContainsAParentCycle");
        }
        cursor = first as i64;
        while cursor != -1 && state[cursor as usize] == 1 {
            state[cursor as usize] = 2;
            cursor = parents[cursor as usize];
        }
    }
    let vertices = get(support, "vertices");
    if !is_record(vertices) {
        return origin_fail("supportVerticesMustBeARecord");
    }
    let mut nodes = NumberSet::default();
    let mut vertex_count = 0;
    for (key, node) in entries(vertices) {
        let id = js_number(&key);
        if !(canonical(&key) && id.is_finite() && handles.has(id)) {
            return origin_fail("supportVertexKeysMustBeExactNativeHandle");
        }
        let node_id = origin_integer(Some(node), -1.0, count as f64 - 1.0)?;
        if !nodes.insert(node_id) {
            return origin_fail("supportVerticesMustReferenceDistinctNodes");
        }
        vertex_count += 1;
    }
    if vertex_count != handles.len() {
        return origin_fail("supportVerticesMustIncludeEveryNativeHandleAnd");
    }
    let path_terms = get(support, "path");
    if !is_array(path_terms) || len(path_terms) > MAX_BONES {
        return origin_fail("supportPathMustContainAtMost100000");
    }
    for term in items(path_terms) {
        let t = Some(&term);
        if !is_record(t) {
            return origin_fail("supportPathTermMustBeARecord");
        }
        origin_integer(get(t, "bone"), 0.0, count as f64 - 1.0)?;
        if !matches!(num(get(t, "sign")), Some(s) if s == 1.0 || s == -1.0) {
            return origin_fail("supportPathSignMustBeExactly1Or");
        }
    }
    let rotation = origin_integer(get(support, "rotation"), 0.0, count as f64 - 1.0)? as usize;
    let handle = get(origin, "handleId");
    if !is_null(handle) {
        let virtual_root = get(vertices, &format_index(num(handle))).and_then(Value::as_f64) == Some(-1.0);
        if !integer(handle) || !handles.has(num(handle).unwrap()) || !virtual_root {
            return origin_fail("handleMustReferenceItsOriginalVirtualRootOr");
        }
    }
    let turning = &bones[rotation];
    let turn_handle = get(Some(turning), "handleId");
    let reference = get(origin, "rotationHandleId");
    let same_handle = match (reference, turn_handle) {
        (Some(a), Some(b)) => a == b || (a.as_f64().is_some() && a.as_f64() == b.as_f64()),
        (None, None) => true,
        _ => false,
    };
    if !same_handle || !boolean(get(origin, "reversed")) || (!is_null(turn_handle) && get(origin, "reversed") != get(Some(turning), "reversed")) {
        return origin_fail("rotationReferenceMustMatchItsSupportBone");
    }
    Ok(Some(OriginMetadata { support: true, ghosts }))
}

/// `String(n)` for a handle, as the support's vertex table keys it.
fn format_index(value: Option<f64>) -> String {
    value.map(|n| number_text(n)).unwrap_or_else(|| "undefined".into())
}

/// `validateOriginObjectSteps(object, figure)`: a pose's animation origin against the figure's.
pub(super) fn origin_object(object: &Value, figure: &Value, metadata: Option<&OriginMetadata>) -> Result<(), EditError> {
    const MAX_BONES: usize = 100_000;
    let origin = object.get("_stykAnimationOrigin");
    if missing(origin) {
        if !missing(path(Some(figure), &["_styk", "animationOrigin"])) {
            return origin_fail("poseIsMissingItsAnimationOrigin");
        }
        return Ok(());
    }
    if !is_record(origin) {
        return origin_fail("poseMustBeARecord");
    }
    origin_float32(get(origin, "x"))?;
    origin_float32(get(origin, "y"))?;
    for key in ["offsetX", "offsetY"] {
        let value = get(origin, key);
        if !missing(value) {
            origin_float32(value)?;
        }
    }
    let Some(metadata) = metadata.filter(|m| m.support) else {
        // Orphan pose metadata is retained for compatibility; known values still need to be valid.
        if metadata.is_none() && has_own(origin, "ghosts") {
            let ghosts = get(origin, "ghosts");
            if !is_record(ghosts) {
                return origin_fail("orphanGhostsMustBeAPoseRecord");
            }
            let mut count = 0usize;
            for (key, pose) in entries(ghosts) {
                let index = js_number(&key);
                count += 1;
                if !(canonical(&key) && index.is_finite() && index < MAX_BONES as f64) || count > MAX_BONES {
                    return origin_fail("orphanGhostKeysMustBeCanonicalSupportBone");
                }
                origin_pose(Some(pose))?;
            }
        }
        return Ok(());
    };
    if metadata.ghosts.is_empty() {
        if has_own(origin, "ghosts") {
            return origin_fail("poseMustOmitGhostsWhenTheSupportHas");
        }
        return Ok(());
    }
    let ghosts = get(origin, "ghosts");
    if !has_own(origin, "ghosts") || !is_record(ghosts) {
        return origin_fail("poseRequiresAllRetainedGhostBones");
    }
    for index in &metadata.ghosts {
        if !has_own(ghosts, &index.to_string()) {
            return origin_fail("poseIsMissingARetainedGhostBone");
        }
        origin_pose(get(ghosts, &index.to_string()))?;
    }
    let mut count = 0usize;
    for _ in entries(ghosts) {
        count += 1;
        if count > metadata.ghosts.len() {
            return origin_fail("poseGhostsMustContainExactlyTheRetainedBone");
        }
    }
    if count != metadata.ghosts.len() {
        return origin_fail("poseGhostsMustContainExactlyTheRetainedBone");
    }
    Ok(())
}
