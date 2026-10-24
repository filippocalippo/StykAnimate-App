//! Read-only layer-sheet migration, using the existing sheet Plan/source owner.
use crate::{
    EditError,
    frame::{layer_of, objects_of},
    record::uid,
    sheet::{Plan, Write, constant, continuations, items, num, owned_frame_with},
};
use std::collections::{HashMap, HashSet};
use styk_doc::{Obj, Value};
use styk_eval::{eval::Prepared, load::Loader, records::Records};

mod native;
pub use native::{NativeMigration, NativePlan};

pub struct Request<'a> {
    pub uids: &'a [u32],
    pub target_layer: &'a str,
    pub deleted_layer: Option<&'a str>,
    pub next_frame_identity: u64,
    pub max_source_bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub phase: &'static str,
    pub completed: usize,
    pub total: usize,
    pub source_frames: usize,
    pub object_poses: usize,
    pub segment_values: usize,
}
/// Opaque plan retained on the worker for publication by the existing sheet/history owner.
#[derive(Clone, Debug)]
pub struct SheetPlan {
    pub(crate) plan: Plan,
    pub(crate) deleted: Option<String>,
    label: Option<String>,
    before_layers: Value,
    before_identity: u64,
}
fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}
fn source(report: &Value, id: &str) -> Option<Value> {
    report
        .path(&["_styk", "frameSources", id])
        .cloned()
        .or_else(|| {
            items(report.get("keyframes"))
                .into_iter()
                .find(|frame| frame.path(&["_styk", "frameId"]).and_then(Value::as_str) == Some(id))
        })
}
fn owner(report: &Value, id: u32) -> String {
    layer_of(report.path(&["_styk", "layers"]), id).to_string()
}
fn known(report: &Value) -> HashSet<u32> {
    let mut result = HashSet::new();
    for frame in items(report.get("keyframes")).into_iter().chain(
        report
            .path(&["_styk", "frameSources"])
            .and_then(Value::as_obj)
            .into_iter()
            .flat_map(|o| o.values().iter().cloned()),
    ) {
        result.extend(objects_of(&frame).iter().filter_map(uid));
    }
    result
}
pub(crate) fn checked_plan(report: &Value, ids: &[String], identity: u64) -> Result<Plan, EditError> {
    let layers = report
        .path(&["_styk", "layers"])
        .cloned()
        .ok_or_else(|| invalid("errors.editorLayerSheet.theSelectedLayerNoLongerExists"))?;
    for id in ids {
        let layer = layers
            .path(&[if crate::sheet::fixed(id) { "fixed" } else { "byId" }, id])
            .ok_or_else(|| invalid("errors.editorLayerSheet.theSelectedLayerNoLongerExists"))?;
        if layer.get("locked").is_some_and(Value::truthy) {
            return Err(crate::invalid_with("errors.editorLayerSheet.unlockBeforeEditingIt", vec![("name", Value::str(&crate::layers::layer_title(Some(&layers), id)))]));
        }
    }
    let before = report
        .path(&["_styk", "layerSheet"])
        .cloned()
        .ok_or_else(|| invalid("errors.editorLayerSheet.openTheLayerTimelineFirst"))?;
    // Required owner nodes only. Full layer/sheet validation remains the
    // document/publication owner's responsibility; Loader's permissive typed
    // view is not a guarantee that these raw descriptors exist.
    let shape = || invalid("errors.layerSheet.invalidLayerTimeline");
    let by_id = layers
        .get("byId")
        .and_then(Value::as_obj)
        .ok_or_else(shape)?;
    let order = layers
        .get("order")
        .and_then(Value::elements)
        .ok_or_else(shape)?;
    if order.is_empty() || layers.get("assignments").and_then(Value::as_obj).is_none() {
        return Err(shape());
    }
    let tracks = before
        .get("tracks")
        .and_then(Value::as_obj)
        .ok_or_else(shape)?;
    for id in order.iter() {
        let id = id.as_str().ok_or_else(shape)?;
        if by_id.get(id).and_then(Value::as_obj).is_none() {
            return Err(shape());
        }
        let track = tracks.get(id).and_then(Value::as_obj).ok_or_else(shape)?;
        let keys = track
            .get("keys")
            .and_then(Value::elements)
            .ok_or_else(shape)?;
        if keys.iter().any(|key| !key.is_object()) {
            return Err(shape());
        }
    }
    Ok(Plan {
        next_id: num(&before, "nextId").unwrap_or(1.0),
        duration: num(&before, "duration").unwrap_or(1.0),
        before,
        tracks: Vec::new(),
        removed_tracks: Vec::new(),
        sources: Vec::new(),
        layers,
        next_frame: identity,
        definitions: Vec::new(),
    })
}
fn track_signature(track: &Value) -> Value {
    let mut track = track.as_obj().cloned().unwrap_or_default();
    let keys = items(track.get("keys"))
        .iter()
        .map(|key| {
            let mut key = key.as_obj().cloned().unwrap_or_default();
            key.remove("id");
            key.remove("empty");
            Value::object(key)
        })
        .collect();
    track.set("keys", Value::array(keys));
    Value::object(track)
}
fn refresh(
    plan: &mut Plan,
    records: &Records<'_>,
    id: &str,
    check: &mut impl FnMut() -> Result<(), EditError>,
    progress: &mut impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<(), EditError> {
    let keys = plan.keys(id);
    let total = keys.len();
    let mut updated = Vec::with_capacity(total);
    let mut last = clock();
    for (at, key) in keys.into_iter().enumerate() {
        check()?;
        let frame = records
            .evaluated_with(num(&key, "tick").unwrap_or(0.0), false)
            .map_err(EditError::from)?;
        let owns = |u: Option<f64>| u.is_some_and(|u| layer_of(Some(&plan.layers), u as u32) == id);
        let empty = !objects_of(&frame).iter().any(|o| owns(num(o, "unique_id")))
            && !continuations(&frame)
                .iter()
                .any(|step| owns(num(step, "uid")));
        let mut key = key.as_obj().cloned().unwrap_or_default();
        key.set("empty", Value::Bool(empty));
        updated.push(Value::object(key));
        if (at + 1) % 8 == 0 || clock() - last >= 8.0 {
            progress(Progress {
                phase: "planning",
                completed: at + 1,
                total,
                source_frames: 0,
                object_poses: 0,
                segment_values: 0,
            });
            last = clock();
        }
    }
    plan.set_keys(id, updated);
    Ok(())
}
fn sample(
    plan: &mut Plan,
    report: &Value,
    records: &Records<'_>,
    prepared: &Prepared,
    loader: &mut Loader,
    ids: &[String],
    removed: Option<&HashSet<u32>>,
    maxbytes: usize,
    check: &mut impl FnMut() -> Result<(), EditError>,
    progress: &mut impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<(), EditError> {
    let end = ids
        .iter()
        .map(|id| plan.end(id) as usize)
        .max()
        .unwrap_or(0);
    if end > 10_000_000 {
        return Err(invalid(
            "errors.editorLayerSheet.thisLayerChangeNeedsMoreThan10000",
        ));
    }
    let estimated = plan
        .before
        .get("tracks")
        .and_then(Value::as_obj)
        .map(|tracks| {
            tracks
                .iter()
                .map(|(id, track)| {
                    if ids.iter().any(|affected| affected == id.as_ref()) {
                        plan.tracks
                            .iter()
                            .find(|(name, _)| name == id.as_ref())
                            .and_then(|(_, track)| track.get("end"))
                            .and_then(Value::as_f64)
                            .unwrap_or(num(track, "end").unwrap_or(0.0))
                            as usize
                    } else {
                        items(track.get("keys")).len()
                    }
                })
                .sum::<usize>()
        })
        .unwrap_or(0);
    if estimated > 1_000_000 {
        return Err(invalid(
            "errors.editorLayerSheet.preservingThisLayerChangeWouldExceedTheOne",
        ));
    }
    if maxbytes == 0 {
        return Err(invalid(
            "errors.editorLayerMigration.layerMigrationSourceMemoryBudgetMustBePositive",
        ));
    }
    for id in ids {
        plan.set_keys(id, Vec::new());
    }
    let (mut poses, mut values, mut keys, mut last) = (0usize, 0usize, 0usize, clock());
    for tick in 0..end {
        check()?;
        let mut frame = records
            .evaluated_with(tick as f64, false)
            .map_err(EditError::from)?;
        if let Some(removed) = removed {
            let uids: Vec<_> = objects_of(&frame)
                .iter()
                .filter_map(uid)
                .chain(
                    continuations(&frame)
                        .iter()
                        .filter_map(|s| num(s, "uid").map(|u| u as u32)),
                )
                .filter(|u| !removed.contains(u))
                .collect();
            let steps: Vec<_> = continuations(&frame)
                .into_iter()
                .filter(|s| num(s, "uid").is_some_and(|u| !removed.contains(&(u as u32))))
                .collect();
            frame = owned_frame_with(&frame, &uids, &steps, |record| {
                let frame = loader
                    .edit_frame(record, None, &prepared.doc)
                    .map_err(|e| invalid(&e.to_string()))?;
                Ok(styk_eval::geometry::build(&prepared.doc, &frame))
            })?;
        }
        for id in ids {
            if (tick as f64) >= plan.end(id) {
                continue;
            }
            let old_sources = plan.sources.len();
            plan.append_sample(id, tick as f64, &frame)?;
            keys += 1;
            if plan.sources.len() > old_sources {
                let source = &plan.sources.last().unwrap().1;
                for object in objects_of(source) {
                    poses += 1;
                    for field in ["angles", "lengths", "bends"] {
                        values += object.get(field).and_then(Value::array_len).unwrap_or(0);
                    }
                }
            }
        }
        if poses > 2_000_000
            || values > 12_000_000
            || 256 * keys + 512 * poses + 8 * values > maxbytes.min(128 * 1024 * 1024)
        {
            return Err(invalid(
                "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory",
            ));
        }
        if (tick + 1) % 8 == 0 || clock() - last >= 8.0 || tick + 1 == end {
            progress(Progress {
                phase: "sampling",
                completed: tick + 1,
                total: end,
                source_frames: plan.sources.len(),
                object_poses: poses,
                segment_values: values,
            });
            last = clock();
        }
    }
    let _ = report;
    Ok(())
}
impl SheetPlan {
    pub fn label(&self) -> &str {
        if let Some(label) = &self.label {
            label
        } else if self.deleted.is_some() {
            "Delete layer"
        } else {
            "Move figures to layer"
        }
    }
    pub(crate) fn movieclip(plan: Plan, label: &str, before_layers: Value, before_identity: u64) -> Self {
        Self { plan, deleted: None, label: Some(label.into()), before_layers, before_identity }
    }
    /// Changed tracks/header, retained order, new sources and memberships only.
    pub fn payload(&self) -> Value {
        let plan = &self.plan;
        let mut state = plan.before.as_obj().cloned().unwrap_or_default();
        let mut tracks = Obj::new();
        if let Some(before) = plan.before.get("tracks").and_then(Value::as_obj) {
            for id in before.keys() {
                if let Some((_, track)) = plan.tracks.iter().find(|(name, _)| name == id.as_ref()) {
                    tracks.set(id, Value::object(track.clone()));
                }
            }
        }
        state.set("tracks", Value::object(tracks));
        state.set("nextId", Value::Num(plan.next_id));
        state.set("duration", Value::Num(plan.duration));
        let order: Vec<_> = plan
            .before
            .get("tracks")
            .and_then(Value::as_obj)
            .into_iter()
            .flat_map(|tracks| tracks.keys())
            .filter(|id| {
                !plan
                    .removed_tracks
                    .iter()
                    .any(|removed| removed == id.as_ref())
            })
            .map(|id| Value::str(id))
            .collect();
        let mut wire = Obj::new();
        wire.set("sheet", Value::object(state));
        wire.set("trackOrder", Value::array(order));
        wire.set("layers", plan.layers.clone());
        wire.set(
            "sources",
            Value::object(
                plan.sources
                    .iter()
                    .map(|(id, frame)| (std::sync::Arc::from(id.as_str()), frame.clone()))
                    .collect(),
            ),
        );
        wire.set("nextFrame", Value::Num(plan.next_frame as f64));
        let mut payload = Obj::new();
        payload.set("plan", Value::object(wire));
        Value::object(payload)
    }
}
/// Borrowed worker context; no second Editor, store or evaluator cache.
/// `report` and `prepared` must come from the same validated document generation,
/// as returned together by the engine's acknowledged mirror. The caller guards
/// revision/lineage in `check`; arbitrary mismatched views are not a supported
/// context. Required raw owner descriptor shapes still refuse without mutation.
pub fn sheet_layer_plan(
    report: &Value,
    prepared: &Prepared,
    loader: &mut Loader,
    request: Request<'_>,
    mut check: impl FnMut() -> Result<(), EditError>,
    mut progress: impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<Option<SheetPlan>, EditError> {
    check()?;
    let records = Records::new(report, prepared).map_err(EditError::from)?;
    let layers = report
        .path(&["_styk", "layers"])
        .ok_or_else(|| invalid("errors.editorLayerSheet.figuresBelongToUserLayers"))?;
    if let Some(id) = request.deleted_layer {
        return deletion(
            report,
            prepared,
            loader,
            &records,
            id,
            request.next_frame_identity,
            request.max_source_bytes,
            &mut check,
            &mut progress,
            clock,
        )
        .map(Some);
    }
    if layers.path(&["byId", request.target_layer]).is_none() {
        return Err(invalid("errors.editorLayerSheet.figuresBelongToUserLayers"));
    }
    if std::iter::once(request.target_layer.to_string())
        .chain(request.uids.iter().map(|u| owner(report, *u)))
        .any(|id| {
            layers
                .path(&["byId", &id, "drawing", "version"])
                .and_then(Value::as_f64)
                == Some(1.0)
        })
    {
        return Err(invalid(
            "errors.editorLayerSheet.useDrawingKeyCopyPasteBetweenDrawingLayers",
        ));
    }
    let present = known(report);
    if request.uids.iter().any(|u| !present.contains(u)) {
        return Err(invalid(
            "errors.editorLayerAsync.chooseFiguresPresentInThisAnimation",
        ));
    }
    let mut source_ids = Vec::new();
    let mut moved = Vec::new();
    for &u in request.uids {
        let source = owner(report, u);
        if source != request.target_layer && !moved.contains(&u) {
            moved.push(u);
            if !source_ids.contains(&source) {
                source_ids.push(source);
            }
        }
    }
    if moved.is_empty() {
        return Ok(None);
    }
    let mut ids = vec![request.target_layer.to_string()];
    ids.extend(source_ids.clone());
    let mut plan = checked_plan(report, &ids, request.next_frame_identity)?;
    for u in moved {
        plan.assign(u, request.target_layer);
    }
    let destination = plan
        .before
        .path(&["tracks", request.target_layer])
        .cloned()
        .unwrap_or(Value::Null);
    let signature = track_signature(&destination);
    let shared = source_ids.iter().all(|id| {
        track_signature(plan.before.path(&["tracks", id]).unwrap_or(&Value::Null)) == signature
    });
    let vacant = !present
        .iter()
        .any(|u| owner(report, *u) == request.target_layer);
    if shared {
        refresh(
            &mut plan,
            &records,
            request.target_layer,
            &mut check,
            &mut progress,
            clock,
        )?;
    } else if vacant && source_ids.len() == 1 {
        let source = plan
            .before
            .path(&["tracks", &source_ids[0]])
            .and_then(Value::as_obj)
            .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?
            .clone();
        let old_end = num(&destination, "end").unwrap_or(0.0);
        let source_end = source.get("end").and_then(Value::as_f64).unwrap_or(0.0);
        let mut keys = items(source.get("keys"));
        for key in &mut keys {
            key.make_obj()
                .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?
                .set("id", Value::str(&plan.cell()));
        }
        *plan.track(request.target_layer) = source;
        plan.set_keys(request.target_layer, keys);
        refresh(
            &mut plan,
            &records,
            request.target_layer,
            &mut check,
            &mut progress,
            clock,
        )?;
        if old_end > source_end {
            plan.write(
                request.target_layer,
                source_end,
                &crate::sheet::create_frame(&[]),
                Write {
                    blank: true,
                    easing: Some(&constant()),
                    extend: false,
                },
            )?;
            plan.set_end(request.target_layer, old_end);
        }
    } else {
        let end = ids
            .iter()
            .filter_map(|id| {
                plan.before
                    .path(&["tracks", id])
                    .and_then(|track| num(track, "end"))
            })
            .fold(0.0, f64::max);
        let mut track = Obj::new();
        track.set("end", Value::Num(end));
        track.set("keys", Value::array(Vec::new()));
        *plan.track(request.target_layer) = track;
        sample(
            &mut plan,
            report,
            &records,
            prepared,
            loader,
            &[request.target_layer.into()],
            None,
            request.max_source_bytes,
            &mut check,
            &mut progress,
            clock,
        )?;
    }
    for id in source_ids {
        refresh(&mut plan, &records, &id, &mut check, &mut progress, clock)?;
    }
    check()?;
    Ok(Some(SheetPlan {
        plan,
        deleted: None,
        label: None,
        before_layers: layers.clone(),
        before_identity: request.next_frame_identity,
    }))
}
fn node_id(value: &Value) -> usize {
    match value {
        Value::Obj(object) => std::sync::Arc::as_ptr(object) as usize,
        _ => 0,
    }
}
fn deletion(
    report: &Value,
    prepared: &Prepared,
    loader: &mut Loader,
    records: &Records<'_>,
    id: &str,
    identity: u64,
    maxbytes: usize,
    check: &mut impl FnMut() -> Result<(), EditError>,
    progress: &mut impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<SheetPlan, EditError> {
    let layers = report
        .path(&["_styk", "layers"])
        .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?;
    if layers.path(&["byId", id]).is_none() {
        return Err(invalid(
            "errors.editorLayerSheet.sceneAndCameraCannotBeDeleted",
        ));
    }
    let mut plan = checked_plan(report, &[id.into()], identity)?;
    let before_layers = layers.clone();
    let order: Vec<_> = items(layers.get("order"))
        .iter()
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect();
    if order.len() == 1 {
        return Err(invalid("errors.editorLayerAsync.keepAtLeastOneUserLayer"));
    }
    let target = order
        .iter()
        .find(|owner| owner.as_str() != id)
        .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?
        .clone();
    let mut removed: HashSet<_> = known(report)
        .into_iter()
        .filter(|u| owner(report, *u) == id)
        .collect();
    if let Some(assignments) = layers.get("assignments").and_then(Value::as_obj) {
        for (uid, assignment) in assignments.iter() {
            if assignment.as_str() == Some(id) {
                if let Ok(u) = uid.parse::<u32>() {
                    removed.insert(u);
                }
            }
        }
    }
    let mut native = items(report.get("keyframes"));
    let mut native_ids: HashSet<_> = native.iter().map(node_id).collect();
    for channel in items(plan.before.path(&["legacyAnimation", "channels"])) {
        if channel.get("property").and_then(Value::as_str) == Some("pose") {
            for key in items(channel.get("keys")) {
                if let Some(frame) = key
                    .path(&["value", "frameId"])
                    .and_then(Value::as_str)
                    .and_then(|id| source(report, id))
                {
                    if native_ids.insert(node_id(&frame)) {
                        native.push(frame);
                    }
                }
            }
        }
    }
    let mut imported = HashSet::new();
    let mut explicit: HashMap<usize, HashSet<String>> = HashMap::new();
    let mut sources = Vec::new();
    let mut included = HashSet::new();
    for owner in order.iter().filter(|owner| owner.as_str() != id) {
        for key in items(plan.before.path(&["tracks", owner, "keys"])) {
            if key.get("sourceTick").is_some() {
                imported.insert(owner.clone());
            }
            for value in std::iter::once(key.get("value").cloned().unwrap_or(Value::Null))
                .chain(items(key.get("movieclipPatches")))
            {
                if let Some(frame) = value
                    .get("frameId")
                    .and_then(Value::as_str)
                    .and_then(|id| source(report, id))
                {
                    let identity = node_id(&frame);
                    explicit.entry(identity).or_default().insert(owner.clone());
                    if included.insert(identity) {
                        sources.push(frame);
                    }
                }
            }
        }
    }
    if !imported.is_empty() {
        for frame in native {
            if included.insert(node_id(&frame)) {
                sources.push(frame);
            }
        }
    }
    let mut native_members = false;
    let mut affected = Vec::new();
    let mut last = clock();
    let total = sources.len();
    let members = |frame: &Value| {
        objects_of(frame)
            .iter()
            .filter_map(uid)
            .chain(
                continuations(frame)
                    .iter()
                    .filter_map(|step| num(step, "uid").map(|u| u as u32)),
            )
            .collect::<Vec<_>>()
    };
    for (at, frame) in sources.into_iter().enumerate() {
        check()?;
        for step in continuations(&frame) {
            if let Some(u) = num(&step, "uid").map(|u| u as u32) {
                if owner(report, u) == id {
                    removed.insert(u);
                }
            }
        }
        let identity = node_id(&frame);
        if native_ids.contains(&identity) && members(&frame).iter().any(|u| removed.contains(u)) {
            native_members = true;
        }
        let objects = objects_of(&frame);
        for object in &objects {
            if let Some(join) = object.get("join").filter(|join| join.truthy()) {
                let u = uid(object).unwrap_or(0);
                let owner = owner(report, u);
                let parent = num(join, "target_object_slot")
                    .and_then(|slot| objects.get(slot as usize))
                    .and_then(uid)
                    .or_else(|| num(join, "target_unique_id").map(|u| u as u32));
                if owner != id
                    && parent.is_some_and(|u| removed.contains(&u))
                    && (explicit
                        .get(&identity)
                        .is_some_and(|owners| owners.contains(&owner))
                        || native_ids.contains(&identity) && imported.contains(&owner))
                    && !affected.contains(&owner)
                {
                    affected.push(owner);
                }
            }
        }
        if (at + 1) % 64 == 0 || clock() - last >= 8.0 {
            progress(Progress {
                phase: "planning",
                completed: at + 1,
                total,
                source_frames: 0,
                object_poses: 0,
                segment_values: 0,
            });
            last = clock();
        }
    }
    let fallback = plan
        .before
        .path(&["tracks", &target])
        .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?;
    let depends = items(fallback.get("keys")).iter().any(|key| {
        if key.get("sourceTick").is_some() && native_members {
            return true;
        }
        std::iter::once(key.get("value").cloned().unwrap_or(Value::Null))
            .chain(items(key.get("movieclipPatches")))
            .any(|value| {
                value
                    .get("frameId")
                    .and_then(Value::as_str)
                    .and_then(|id| source(report, id))
                    .is_some_and(|frame| members(&frame).iter().any(|u| removed.contains(u)))
            })
    });
    if depends && !affected.contains(&target) {
        affected.push(target.clone());
    }

    sample(
        &mut plan,
        report,
        records,
        prepared,
        loader,
        &affected,
        Some(&removed),
        maxbytes,
        check,
        progress,
        clock,
    )?;
    for &u in &removed {
        plan.assign(u, &target);
    }
    let layers = plan
        .layers
        .make_obj()
        .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?;
    layers.set(
        "order",
        Value::array(
            order
                .iter()
                .filter(|owner| owner.as_str() != id)
                .map(|id| Value::str(id))
                .collect(),
        ),
    );
    layers
        .get_mut("byId")
        .and_then(Value::make_obj)
        .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?
        .remove(id);
    for field in ["defaultLayerId", "activeId"] {
        if layers.get(field).and_then(Value::as_str) == Some(id) {
            layers.set(field, Value::str(&target));
        }
    }
    plan.removed_tracks.push(id.into());
    plan.tracks.retain(|(owner, _)| owner != id);
    plan.duration = plan
        .before
        .get("tracks")
        .and_then(Value::as_obj)
        .ok_or_else(|| invalid("errors.layerSheet.invalidLayerTimeline"))?
        .iter()
        .filter(|(name, _)| name.as_ref() != id)
        .map(|(_, track)| num(track, "end").unwrap_or(0.0))
        .fold(1.0, f64::max);
    check()?;
    Ok(SheetPlan {
        plan,
        deleted: Some(id.into()),
        label: None,
        before_layers,
        before_identity: identity,
    })
}

impl crate::Editor {
    /// Worker-only publication through the existing sheet/history owner. The
    /// asynchronous host additionally guards its revision/lineage before calling.
    /// Errors restore the Editor snapshot, including counters, events and history.
    pub fn publish_sheet_migration(&mut self, prepared: SheetPlan) -> Result<bool, EditError> {
        self.publish_sheet_migration_with_selection_checked(prepared, None, || Ok(()))
    }

    /// Same publication owner, with cooperative worker cancellation/stale checks.
    pub fn publish_sheet_migration_checked(&mut self, prepared: SheetPlan, check: impl FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        self.publish_sheet_migration_with_selection_checked(prepared, None, check)
    }

    pub(crate) fn publish_sheet_migration_with_selection_checked(&mut self, prepared: SheetPlan, selection: Option<crate::select::SelectionState>, check: impl FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        self.publish_sheet_migration_with_geometry_checked(prepared, selection, false, check)
    }

    pub(crate) fn publish_sheet_migration_with_geometry_checked(&mut self, prepared: SheetPlan, selection: Option<crate::select::SelectionState>, retain_geometry: bool, mut check: impl FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        // Selection may change activeId without a document revision while the
        // async planner yields. Preserve that permitted live view; all other
        // metadata must still match the captured owner.
        let same_metadata = self
            .report
            .path(&["_styk", "layers"])
            .and_then(Value::as_obj)
            .zip(prepared.before_layers.as_obj())
            .is_some_and(|(current, before)| {
                let mut current = current.clone();
                let mut before = before.clone();
                current.remove("activeId");
                before.remove("activeId");
                Value::object(current) == Value::object(before)
            });
        if self.report.path(&["_styk", "layerSheet"]) != Some(&prepared.plan.before)
            || !same_metadata
            || self.next_frame_identity != prepared.before_identity
        {
            return Err(invalid(
                "errors.editorLayerAsync.theAnimationChangedWhileTheLayerMoveWas",
            ));
        }
        let label = prepared.label().to_string();
        let selection = selection.unwrap_or_else(|| self.selection_state());
        let snapshot = self.snapshot();
        let result = self.publish_checked(prepared.plan, &label, selection, None, retain_geometry, &mut check);
        if result.is_err() {
            self.restore(snapshot);
        }
        result
    }
}
