//! Movieclips on load: the asset graph (`validateMovieclipGraph`), a placement's playback, the
//! continuations a frame carries, the clip's drawing sets and meshes (src/movieclips.mjs,
//! src/movieclip-presence.mjs, src/movieclip-drawings.mjs, src/movieclip-mesh.mjs).

use styk_doc::Value;

use super::js::*;
use crate::EditError;

/// `movieclipAsset(figure)`: the clip a figure definition holds.
pub(super) fn asset(figure: &Value) -> V<'_> {
    path(Some(figure), &["_styk", "movieclip"])
}

/// `validatePlayback(settings)`: a placement's playback record, defaults taken where it omits a field.
pub(super) fn playback(settings: V) -> Result<(), EditError> {
    if !is_record(settings) {
        return fail("errors.movieclips.invalidMovieclipPlayback");
    }
    // `{start: 0, end: null, offset: 0, speed: 1, mode: 'loop', ...settings}`
    let field = |key: &str| get(settings, key);
    let start = if has_own(settings, "start") { field("start") } else { None };
    let start_value = if has_own(settings, "start") { num(start) } else { Some(0.0) };
    let end = field("end");
    let end_is_null = !has_own(settings, "end") || is_null(end);
    let clock = field("clock");
    if !missing(clock) && text(clock) != Some("presence") {
        return fail("errors.movieclips.invalidMovieclipClock");
    }
    let restarts = field("restarts");
    if text(clock) == Some("presence") && (len(restarts) > 0 || start_value != Some(0.0) || !end_is_null) {
        return fail("errors.movieclips.presenceMovieclipsUseFrameMembershipInsteadOfPlacement");
    }
    let mode = if has_own(settings, "mode") { text(field("mode")) } else { Some("loop") };
    if !matches!(mode, Some("loop" | "once" | "hold" | "single")) {
        return fail("errors.movieclips.invalidMovieclipPlaybackMode");
    }
    let start_ok = if has_own(settings, "start") { integer_in(start, 0.0, 10_000_000.0) } else { true };
    let end_ok = end_is_null || (integer(end) && num(end).unwrap() > start_value.unwrap_or(f64::NAN) && num(end).unwrap() <= 10_000_001.0);
    if !start_ok || !end_ok {
        return fail("errors.movieclips.movieclipPlacementMustHaveAValidStartAnd");
    }
    let offset = if has_own(settings, "offset") { num(field("offset")) } else { Some(0.0) };
    let speed = if has_own(settings, "speed") { num(field("speed")) } else { Some(1.0) };
    let offset_ok = offset.is_some_and(|o| o.is_finite() && (0.0..=10_000_000.0).contains(&o));
    let speed_ok = speed.is_some_and(|s| s.is_finite() && s > 0.0 && s <= 100.0);
    if !offset_ok || !speed_ok {
        return fail("errors.movieclips.movieclipOffsetOrSpeedIsOutsideTheSupported");
    }
    if !missing(restarts) {
        let keys = items(restarts);
        let bad = !is_array(restarts)
            || keys.len() > 100_000
            || keys.iter().enumerate().any(|(i, key)| {
                let k = Some(key);
                !integer_in(get(k, "tick"), 0.0, 10_000_000.0)
                    || !finite_in(get(k, "offset"), 0.0, 10_000_000.0)
                    || (i > 0 && num(get(k, "tick")).unwrap() <= num(keys[i - 1].get("tick")).unwrap_or(f64::NAN))
            });
        if bad {
            return fail("errors.movieclips.invalidMovieclipRestartKeys");
        }
    }
    Ok(())
}

/// `validateContinuations(frame, types)`: the presence clocks a frame continues.
pub(super) fn continuations(frame: V, types: &NumberSet) -> Result<(), EditError> {
    let values = path(frame, &["_styk", "movieclipContinuations"]);
    if missing(values) {
        return Ok(());
    }
    if !is_array(values) || len(values) > 65535 {
        return fail("errors.movieclipPresence.invalidMovieclipContinuationData");
    }
    let mut seen = NumberSet::default();
    for value in items(values) {
        let v = Some(&value);
        let valid = truthy(v)
            && integer_in(get(v, "uid"), 0.0, 2_147_483_646.0)
            && !seen.has(num(get(v, "uid")).unwrap())
            && num(get(v, "typeId")).is_some_and(|id| types.has(id))
            && text(path(v, &["playback", "clock"])) == Some("presence");
        if !valid {
            return fail("errors.movieclipPresence.invalidMovieclipContinuation");
        }
        seen.insert(num(get(v, "uid")).unwrap());
    }
    Ok(())
}

/// `continuations(frame)`: the steps a frame carries.
pub(super) fn steps(frame: &Value) -> Vec<Value> {
    items(path(Some(frame), &["_styk", "movieclipContinuations"]))
}

/// `validateDrawingSets(asset)` (src/movieclip-drawings.mjs).
fn drawing_sets(asset: V) -> Result<(), EditError> {
    let rotation = get(asset, "drawingRotation");
    let sets = get(asset, "drawingSets");
    if !missing(rotation) {
        let steps = get(rotation, "steps");
        let threshold = get(rotation, "tiltThreshold");
        let valid = truthy(rotation)
            && entries(rotation).iter().all(|(key, _)| ["steps", "tiltThreshold"].contains(&&**key))
            && integer_in(steps, 2.0, 32.0)
            && finite(threshold)
            && num(threshold).is_some_and(|t| t > 0.0 && t < std::f64::consts::FRAC_PI_2)
            && truthy(sets);
        if !valid {
            return fail("errors.movieclipDrawings.rotatingDrawingsNeed232DirectionsAndA");
        }
    }
    if missing(sets) {
        return Ok(());
    }
    if !is_array(sets) || len(sets) == 0 || len(sets) > 128 {
        return fail("errors.movieclipDrawings.drawingSetsNeed1128Groups");
    }
    let duration = num(get(asset, "duration"));
    for set in items(sets) {
        let s = Some(&set);
        if !truthy(s) || !name(get(s, "name"), 120) || !is_array(get(s, "views")) || len(get(s, "views")) == 0 || len(get(s, "views")) > 256 {
            return fail("errors.movieclipDrawings.aDrawingSetNeedsANameAnd1");
        }
        if truthy(rotation) && len(get(s, "views")) as f64 != num(get(rotation, "steps")).unwrap_or(f64::NAN) * 3.0 {
            return fail("errors.movieclipDrawings.rotatingDrawingsNeedLevelUpAndDownViews");
        }
        for view in items(get(s, "views")) {
            let v = Some(&view);
            let frame = num(get(v, "frame"));
            let valid = truthy(v) && name(get(v, "name"), 120) && integer(get(v, "frame")) && frame.unwrap() >= 0.0 && frame.unwrap() < duration.unwrap_or(f64::NAN);
            if !valid {
                return fail("errors.movieclipDrawings.drawingViewsMustSelectExistingClipFrames");
            }
        }
    }
    Ok(())
}

/// `validateMovieclipMeshes(asset)` (src/movieclip-mesh.mjs).
fn meshes(asset: V) -> Result<(), EditError> {
    let list = get(asset, "spatialMeshes");
    if missing(list) {
        return Ok(());
    }
    let duration = num(get(asset, "duration"));
    if truthy(get(asset, "drawingRotation")) || !is_array(list) || Some(len(list) as f64) != duration || len(list) > 128 {
        return fail("errors.movieclipMesh.spatialFormsNeedOneMeshPerClipFrame");
    }
    let finite_list = |v: V, bound: f64| items(v).iter().all(|x| finite_in(Some(x), -bound, bound));
    let mut total = 0.0;
    for mesh in items(list) {
        let m = Some(&mesh);
        let (positions, indices, colors, materials) = (get(m, "positions"), get(m, "indices"), get(m, "colors"), get(m, "materials"));
        let vertices = len(positions) / 3;
        let palette = |c: &Value| c.is_array() && c.array_len() == Some(3) && items(Some(c)).iter().all(|v| integer_in(Some(v), 0.0, 255.0));
        let valid = truthy(m)
            && is_array(positions)
            && len(positions) >= 9
            && len(positions) % 3 == 0
            && len(positions) <= 300_000
            && finite_list(positions, 1e6)
            && is_array(indices)
            && len(indices) > 0
            && len(indices) % 3 == 0
            && len(indices) <= 600_000
            && items(indices).iter().all(|i| integer_in(Some(i), 0.0, vertices as f64 - 1.0))
            && is_array(colors)
            && len(colors) > 0
            && len(colors) <= 256
            && items(colors).iter().all(palette)
            && is_array(materials)
            && len(materials) == len(indices) / 3
            && items(materials).iter().all(|i| integer_in(Some(i), 0.0, len(colors) as f64 - 1.0));
        if !valid {
            return fail("errors.movieclipMesh.invalidIndexedSpatialMesh");
        }
        let views = get(m, "viewPositions");
        if !missing(views) {
            let ok = is_array(views)
                && matches!(len(views), 4 | 8)
                && items(views).iter().all(|v| is_array(Some(v)) && len(Some(v)) == len(positions) && finite_list(Some(v), 1e6));
            if !ok {
                return fail("errors.movieclipMesh.viewCorrectedMeshesNeedFourOrEightComplete");
            }
        }
        let turns = get(m, "viewTurns");
        if !missing(turns) {
            let pivot = get(m, "viewPivot");
            let ok = !missing(views)
                && truthy(views)
                && is_array(turns)
                && len(turns) == len(views)
                && items(turns).iter().all(|t| finite_in(Some(t), -std::f64::consts::PI, std::f64::consts::PI))
                && is_array(pivot)
                && len(pivot) == 3
                && finite_list(pivot, 1e6);
            if !ok {
                return fail("errors.movieclipMesh.viewTurnsNeedOneAnglePerViewSet");
            }
        }
        let weights = get(m, "viewTurnWeights");
        if !missing(weights) {
            let ok = truthy(get(m, "viewTurns")) && is_array(weights) && len(weights) == vertices && items(weights).iter().all(|w| finite_in(Some(w), 0.0, 1.0));
            if !ok {
                return fail("errors.movieclipMesh.viewTurnWeightsNeedOneValueFrom0");
            }
        }
        total += len(positions) as f64 * (1.0 + if missing(views) { 0.0 } else { len(views) as f64 }) + len(indices) as f64;
        if total > 6_000_000.0 {
            return fail("errors.movieclipMesh.spatialMeshAssetExceedsItsGeometryBudget");
        }
    }
    Ok(())
}

/// `validateMovieclipGraph(report)`: nesting, asset shapes and the drawing sets and meshes of every clip.
pub(super) fn graph(report: &Value) -> Result<(), EditError> {
    fn visit(document: V, depth: usize, assets: &mut usize) -> Result<(), EditError> {
        if !is_object_type(document) || is_null(document) || !is_array(get(document, "figure_types")) {
            return fail("errors.movieclips.invalidMovieclipDocument");
        }
        if depth > 8 {
            return fail("errors.movieclips.movieclipsContainACycleOrExceedEightNested");
        }
        let source = path(document, &["_styk", "movieclipSource", "document"]);
        if truthy(source) {
            visit(source, depth + 1, assets)?;
        }
        for figure in items(get(document, "figure_types")) {
            let clip = asset(&figure);
            if !truthy(clip) {
                continue;
            }
            *assets += 1;
            if *assets > 4096 {
                return fail("errors.movieclips.movieclipAssetLimitExceeded");
            }
            let invalid = num(get(clip, "version")) != Some(1.0)
                || !truthy(get(clip, "document"))
                || !integer_in(get(clip, "duration"), 1.0, 10_000_000.0)
                || !integer_in(get(clip, "sourceStart"), 0.0, f64::INFINITY)
                || !finite(path(clip, &["pivot", "x"]))
                || !finite(path(clip, &["pivot", "y"]));
            if invalid {
                return fail("errors.movieclips.invalidMovieclipAsset");
            }
            if len(figure.get("segments")) != 1 {
                return fail("errors.movieclips.movieclipContainersRequireOneTransformHandle");
            }
            drawing_sets(clip)?;
            meshes(clip)?;
            visit(get(clip, "document"), depth + 1, assets)?;
        }
        Ok(())
    }
    let mut assets = 0;
    visit(Some(report), 0, &mut assets)
}
