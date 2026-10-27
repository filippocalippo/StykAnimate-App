//! Native migration staging. The canonical worker/kernel generation supplies
//! validated definitions and unchanged channels; this owner checks its delta
//! boundary and records the same animation/source descriptor as `_layerEdit`.
use super::Progress;
use crate::{EditError, Editor, history::Direction, layers::Update};
use std::collections::{HashMap, HashSet};
use styk_doc::{Obj, Value};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}
fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::elements)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
fn integer(value: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= min && *n <= max)
}
fn header(animation: Option<&Value>) -> Value {
    let Some(animation) = animation.filter(|a| !a.is_null()) else {
        return object([("exists", Value::Bool(false))]);
    };
    let mut fields = animation.as_obj().cloned().unwrap_or_default();
    fields.remove("channels");
    object([
        ("exists", Value::Bool(true)),
        ("fields", Value::object(fields)),
    ])
}
fn channel_side(channel: Option<&Value>, index: usize) -> Value {
    channel
        .map(|channel| {
            object([
                ("exists", Value::Bool(true)),
                ("index", Value::Num(index as f64)),
                ("channel", channel.clone()),
            ])
        })
        .unwrap_or_else(|| object([("exists", Value::Bool(false))]))
}

/// Existing Layers history owns this immutable delta. Fields are private so
/// hosts cannot fabricate an unchecked history descriptor.
#[derive(Clone, Debug)]
pub struct NativeMigration {
    animation_patch: Value,
    sources: Vec<(String, Value)>,
    had_source_table: bool,
    source_bytes: usize,
    uid_counts: Vec<(u32, usize)>,
    next_frame_identity: u64,
}
impl NativeMigration {
    pub(crate) fn frames(&self) -> Vec<Value> {
        self.sources
            .iter()
            .map(|(_, frame)| frame.clone())
            .collect()
    }
    pub(crate) fn source_bytes(&self) -> usize {
        self.source_bytes
    }
    pub(crate) fn history_fields(&self, fields: &mut Obj) {
        fields.set("layerAnimationPatch", self.animation_patch.clone());
        // `_record` strips only these source values before JSON sizing.
        fields.set(
            "frameSourceChanges",
            Value::array(
                self.sources
                    .iter()
                    .map(|(id, _)| {
                        object([
                            ("id", Value::str(id)),
                            ("before", object([("exists", Value::Bool(false))])),
                            ("after", object([("exists", Value::Bool(true))])),
                        ])
                    })
                    .collect(),
            ),
        );
        fields.set("hadFrameSourceTable", Value::Bool(self.had_source_table));
        fields.set("sourceBytes", Value::Num(self.source_bytes as f64));
        fields.set(
            "frameSourceUidCounts",
            object([
                ("before", Value::array(Vec::new())),
                (
                    "after",
                    Value::array(
                        self.uid_counts
                            .iter()
                            .map(|(id, n)| Value::nums(&[*id as f64, *n as f64]))
                            .collect(),
                    ),
                ),
            ]),
        );
    }
    pub(crate) fn retain_sources(&self, retained: &mut Vec<String>) {
        retained.extend(self.sources.iter().map(|(id, _)| id.clone()));
        for change in array(self.animation_patch.get("changes")) {
            for side in ["before", "after"] {
                for key in array(change.path(&[side, "channel", "keys"])) {
                    if let Some(id) = key.path(&["value", "frameId"]).and_then(Value::as_str) {
                        retained.push(id.to_string());
                    }
                }
            }
        }
    }
    fn animation(&self, editor: &mut Editor, direction: Direction) {
        let side = if direction == Direction::Before {
            "before"
        } else {
            "after"
        };
        let header = self.animation_patch.get(side).unwrap();
        let styk = editor
            .report
            .make_obj()
            .and_then(|r| r.get_mut("_styk"))
            .and_then(Value::make_obj)
            .unwrap();
        if header.get("exists") == Some(&Value::Bool(false)) {
            styk.remove("animation");
            return;
        }
        let changes = array(self.animation_patch.get("changes"));
        let ids: HashSet<_> = changes
            .iter()
            .filter_map(|c| c.get("id").and_then(Value::as_str))
            .collect();
        let mut channels: Vec<_> = array(styk.get("animation").and_then(|a| a.get("channels")))
            .into_iter()
            .filter(|c| {
                !c.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.contains(id))
            })
            .collect();
        let mut added: Vec<_> = changes
            .iter()
            .filter_map(|change| change.get(side))
            .filter(|state| state.get("exists").is_some_and(Value::truthy))
            .collect();
        added.sort_by_key(|state| state.get("index").and_then(Value::as_f64).unwrap() as usize);
        for state in added {
            let at =
                (state.get("index").and_then(Value::as_f64).unwrap() as usize).min(channels.len());
            channels.insert(at, state.get("channel").unwrap().clone());
        }
        let mut animation = header
            .get("fields")
            .and_then(Value::as_obj)
            .unwrap()
            .clone();
        animation.set("channels", Value::array(channels));
        styk.set("animation", Value::object(animation));
    }
    fn sources(&self, editor: &mut Editor, direction: Direction) {
        if self.sources.is_empty() {
            return;
        }
        let styk = editor
            .report
            .make_obj()
            .and_then(|r| r.get_mut("_styk"))
            .and_then(Value::make_obj)
            .unwrap();
        if styk.get("frameSources").is_none() {
            styk.set("frameSources", Value::object(Obj::new()));
        }
        let table = styk
            .get_mut("frameSources")
            .and_then(Value::make_obj)
            .unwrap();
        for (id, frame) in &self.sources {
            if direction == Direction::Before {
                table.remove(id);
            } else {
                table.set(id, frame.clone());
            }
        }
        if direction == Direction::Before && !self.had_source_table && table.is_empty() {
            styk.remove("frameSources");
        }
    }
    pub(crate) fn publish(
        &self,
        editor: &mut Editor,
        check: &mut impl FnMut() -> Result<(), EditError>,
    ) -> Result<(), EditError> {
        check()?;
        editor.next_frame_identity = self.next_frame_identity;
        self.sources(editor, Direction::After);
        check()?;
        self.animation(editor, Direction::After);
        Ok(())
    }
    pub(crate) fn apply(&self, editor: &mut Editor, direction: Direction) -> Result<(), EditError> {
        let frames = self.frames();
        match direction {
            Direction::Before => editor.track_frames(&frames, &[], false)?,
            Direction::After => editor.track_frames(&[], &frames, false)?,
        };
        self.sources(editor, direction);
        self.animation(editor, direction);
        Ok(())
    }
}

/// Opaque worker-staged native layer command. It borrows the one canonical COW
/// report through shared nodes, and is never a second live Editor or evaluator.
#[derive(Clone, Debug)]
pub struct NativePlan {
    before: Value,
    revision: u64,
    identity: u64,
    updates: Vec<Update>,
    migration: Option<NativeMigration>,
    deleted: Option<String>,
    target: String,
}

// The JS owner permits setActiveLayer while a plan yields. COW mutation of
// that one field must not reject it, but every other canonical node is guarded.
fn same_owner(
    left: &Value,
    right: &Value,
    depth: usize,
    check: &mut impl FnMut() -> Result<(), EditError>,
) -> Result<bool, EditError> {
    if left.same_node(right) {
        return Ok(true);
    }
    let Some((left, right)) = left.as_obj().zip(right.as_obj()) else {
        return Ok(false);
    };
    if left.len() != right.len() {
        return Ok(false);
    }
    for (key, value) in left.iter() {
        check()?;
        let Some(other) = right.get(key) else {
            return Ok(false);
        };
        if depth == 2 && key.as_ref() == "activeId" {
            continue;
        }
        if (depth == 0 && key.as_ref() == "_styk") || (depth == 1 && key.as_ref() == "layers") {
            if !same_owner(value, other, depth + 1, check)? {
                return Ok(false);
            }
        } else if !value.same_node(other) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn stage(
    report: &Value,
    identity: u64,
    wire: &Value,
    check: &mut impl FnMut() -> Result<(), EditError>,
    progress: &mut impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<Option<NativeMigration>, EditError> {
    if wire.is_null() {
        return Ok(None);
    }
    let plan_error = "errors.editorLayerAsync.theLayerWorkerReturnedAnInvalidMigrationPlan";
    let next = integer(
        wire.get("nextFrameIdentity"),
        identity as f64,
        9007199254740991.0,
    )
    .ok_or_else(|| invalid(plan_error))? as u64;
    if wire.get("version").and_then(Value::as_f64) != Some(1.0)
        || wire.get("channelUpdates").is_none_or(|a| !a.is_array())
        || wire.get("channelOrder").is_none_or(|a| !a.is_array())
        || wire.get("frameSources").and_then(Value::as_obj).is_none()
    {
        return Err(invalid(plan_error));
    }
    let before = report.path(&["_styk", "animation"]);
    let old = array(before.and_then(|a| a.get("channels")));
    let mut by_id: HashMap<String, Value> = old
        .iter()
        .filter_map(|c| Some((c.get("id")?.as_str()?.to_string(), c.clone())))
        .collect();
    let mut changed = HashSet::new();
    for update in array(wire.get("channelUpdates")) {
        check()?;
        let id = update
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("errors.editorLayerAsync.invalidMigratedAnimationChannel"))?;
        let channel = update
            .get("channel")
            .ok_or_else(|| invalid("errors.editorLayerAsync.invalidMigratedAnimationChannel"))?;
        if !changed.insert(id.to_string())
            || !channel.is_null() && channel.get("id").and_then(Value::as_str) != Some(id)
        {
            return Err(invalid(
                "errors.editorLayerAsync.invalidMigratedAnimationChannel",
            ));
        }
        if channel.is_null() {
            by_id.remove(id);
        } else {
            by_id.insert(id.into(), channel.clone());
        }
    }
    let order = array(wire.get("channelOrder"));
    let mut seen = HashSet::new();
    if order.len() != by_id.len()
        || order.iter().any(|v| {
            v.as_str()
                .is_none_or(|id| !by_id.contains_key(id) || !seen.insert(id))
        })
    {
        return Err(invalid(
            "errors.editorLayerAsync.theLayerWorkerReturnedAnInvalidChannelOrder",
        ));
    }
    let after: Vec<Value> = order
        .iter()
        .map(|id| by_id[id.as_str().unwrap()].clone())
        .collect();
    let mut after_header = before.and_then(Value::as_obj).cloned().unwrap_or_default();
    after_header.remove("channels");
    after_header.set("version", Value::Num(1.0));
    let next_key = integer(wire.get("nextKeyId"), 1.0, 9007199254740991.0)
        .ok_or_else(|| invalid("errors.animationChannels.invalidAnimationKeyIdentityCounter"))?;
    after_header.set("nextKeyId", Value::Num(next_key));
    let mut occupied: HashSet<String> = array(report.get("keyframes"))
        .iter()
        .filter_map(|f| {
            f.path(&["_styk", "frameId"])
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    occupied.extend(
        report
            .path(&["_styk", "frameSources"])
            .and_then(Value::as_obj)
            .into_iter()
            .flat_map(|o| o.keys().map(|k| k.to_string())),
    );
    let mut sources = Vec::new();
    let mut source_bytes = 0;
    let mut counts: Vec<(u32, usize)> = Vec::new();
    let mut count_indices: HashMap<u32, usize> = HashMap::new();
    // Transient lookup views borrow the canonical COW records, not another
    // document/evaluator/cache. Preserve source/count insertion order.
    let mut types = HashMap::new();
    for figure in array(report.get("figure_types")) {
        check()?;
        if let Some(id) = figure.get("figure_type_id").and_then(Value::as_f64) {
            types.insert(id.to_bits(), figure);
        }
    }
    let total = wire
        .get("frameSources")
        .and_then(Value::as_obj)
        .unwrap()
        .len();
    let mut last = clock();
    for (id, frame) in wire
        .get("frameSources")
        .and_then(Value::as_obj)
        .unwrap()
        .iter()
    {
        check()?;
        let number = id
            .strip_prefix("frame-")
            .filter(|n| {
                !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
            })
            .and_then(|n| n.parse::<u64>().ok());
        if number.is_none_or(|n| n >= next)
            || occupied.contains(id.as_ref())
            || frame.path(&["_styk", "frameId"]).and_then(Value::as_str) != Some(id)
            || frame.get("objects").is_none_or(|a| !a.is_array())
        {
            return Err(invalid(
                "errors.editorLayerAsync.theLayerWorkerReturnedAnInvalidPoseSource",
            ));
        }
        occupied.insert(id.to_string());
        let mut unique = HashSet::new();
        for pose in array(frame.get("objects")) {
            check()?;
            let uid = integer(pose.get("unique_id"), 0.0, u32::MAX as f64)
                .ok_or_else(|| invalid("errors.model.mustBeAnIntegerFromTo"))?
                as u32;
            let figure = pose
                .get("figure_type_id")
                .and_then(Value::as_f64)
                .and_then(|id| types.get(&id.to_bits()));
            let figure = figure
                .filter(|_| unique.insert(uid))
                .ok_or_else(|| invalid("errors.model.unknownFigureOrRepeatedObjectIdentity"))?;
            let size = figure
                .get("segments")
                .and_then(Value::array_len)
                .unwrap_or(0);
            for (enabled, field) in [
                (true, "angles"),
                (pose.get("len_flag").is_some_and(Value::truthy), "lengths"),
                (pose.get("bend_flag").is_some_and(Value::truthy), "bends"),
            ] {
                if !enabled {
                    continue;
                }
                let values = pose
                    .get(field)
                    .filter(|v| v.is_array())
                    .ok_or_else(|| invalid("errors.model.poseArrayDoesNotMatchItsFigure"))?;
                if values.array_len() != Some(size) {
                    return Err(invalid("errors.model.poseArrayDoesNotMatchItsFigure"));
                }
                for (at, value) in values.elements().unwrap().iter().enumerate() {
                    if at % 4096 == 0 {
                        check()?;
                    }
                    let n = value
                        .as_f64()
                        .filter(|n| n.is_finite())
                        .ok_or_else(|| invalid("errors.model.mustBeAFiniteNumber"))?;
                    if field == "lengths" && !(n as f32).is_finite() {
                        return Err(invalid("errors.model.exceedsTheNativeFloat32Range"));
                    }
                }
            }
            source_bytes += 512
                + 8 * ["angles", "lengths", "bends"]
                    .iter()
                    .map(|k| pose.get(k).and_then(Value::array_len).unwrap_or(0))
                    .sum::<usize>();
            if let Some(&at) = count_indices.get(&uid) {
                counts[at].1 += 1;
            } else {
                count_indices.insert(uid, counts.len());
                counts.push((uid, 1));
            }
        }
        source_bytes += 256;
        sources.push((id.to_string(), frame.clone()));
        if clock() - last >= 4.0 || sources.len() == total {
            progress(Progress {
                phase: "staging",
                completed: sources.len(),
                total,
                source_frames: 0,
                object_poses: 0,
                segment_values: 0,
            });
            check()?;
            last = clock();
        }
    }
    // Unchanged channels were validated by the canonical load; kernel updates
    // are layer pose channels. Do not admit fabricated scalar/property changes.
    for channel in &after {
        check()?;
        let id = channel.get("id").and_then(Value::as_str).unwrap();
        if !changed.contains(id) {
            continue;
        }
        if channel.get("property").and_then(Value::as_str) != Some("pose")
            || channel.path(&["target", "kind"]).and_then(Value::as_str) != Some("layer")
        {
            return Err(EditError::Unported(
                "native migration updates outside the layer pose kernel".into(),
            ));
        }
        let mut ids = HashSet::new();
        let mut previous = -1.0;
        let keys = channel
            .get("keys")
            .filter(|v| v.is_array())
            .ok_or_else(|| {
                invalid("errors.animationChannels.animationChannelsMustHaveUniqueStableIdentities")
            })?;
        for key in keys.elements().unwrap().iter() {
            check()?;
            let id = key
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && ids.insert(id.to_string()))
                .ok_or_else(|| {
                    invalid("errors.animationChannels.animationKeysMustHaveUniqueStableIdentities")
                })?;
            let _ = id;
            let tick = integer(key.get("tick"), 0.0, 10000000.0)
                .filter(|t| *t >= previous)
                .ok_or_else(|| {
                    invalid("errors.animationChannels.animationKeysMustBeSortedAtValidWhole")
                })?;
            previous = tick;
            if let Some(source) = key.path(&["value", "frameId"]).filter(|v| !v.is_null()) {
                if source.as_str().is_none_or(|id| !occupied.contains(id)) {
                    return Err(invalid(
                        "errors.animationChannels.animationPoseReferencesMissingSourceFrame",
                    ));
                }
            }
        }
    }
    let mut ids: Vec<String> = old
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut seen_ids: HashSet<String> = ids.iter().cloned().collect();
    for channel in &after {
        check()?;
        let id = channel.get("id").and_then(Value::as_str).unwrap();
        if seen_ids.insert(id.into()) {
            ids.push(id.into());
        }
    }
    let old_indices: HashMap<_, _> = old
        .iter()
        .enumerate()
        .map(|(i, c)| (c.get("id").and_then(Value::as_str).unwrap(), i))
        .collect();
    let after_indices: HashMap<_, _> = after
        .iter()
        .enumerate()
        .map(|(i, c)| (c.get("id").and_then(Value::as_str).unwrap(), i))
        .collect();
    let mut changes = Vec::new();
    for id in ids {
        check()?;
        let b = old_indices.get(id.as_str()).copied();
        let a = after_indices.get(id.as_str()).copied();
        if b.zip(a).is_some_and(|(b, a)| old[b].same_node(&after[a])) {
            continue;
        }
        changes.push(object([
            ("id", Value::str(&id)),
            ("before", channel_side(b.map(|i| &old[i]), b.unwrap_or(0))),
            ("after", channel_side(a.map(|i| &after[i]), a.unwrap_or(0))),
        ]));
    }
    check()?;
    Ok(Some(NativeMigration {
        animation_patch: object([
            ("changes", Value::array(changes)),
            ("before", header(before)),
            (
                "after",
                object([
                    ("exists", Value::Bool(true)),
                    ("fields", Value::object(after_header)),
                ]),
            ),
        ]),
        sources,
        had_source_table: report.path(&["_styk", "frameSources"]).is_some(),
        source_bytes: source_bytes * 2,
        uid_counts: counts,
        next_frame_identity: next,
    }))
}

impl Editor {
    /// The two existing metadata/view callbacks exercised while an async native
    /// plan yields. Hosts run them on this same worker owner, never through UI
    /// admission or a second history stack.
    pub fn call_layer_metadata_worker(
        &mut self,
        method: &str,
        args: &[Value],
    ) -> Result<Value, EditError> {
        if !self.worker_history {
            return Err(EditError::Unported("worker history is not prepared".into()));
        }
        let arg = |at| args.get(at).cloned().unwrap_or(Value::Null);
        match method {
            "setActiveLayer" => self.set_active_layer_command(&arg(0)).map(Value::Bool),
            "renameLayer" => self.rename_layer(&arg(0), &arg(1)).map(Value::Bool),
            _ => Err(EditError::Unported(format!(
                "native worker metadata callback {method}"
            ))),
        }
    }
    /// Worker-only stage of the existing native planner wire. The host must use
    /// the validated canonical report/Prepared generation, lineage and revision
    /// that produced the wire. This does not enable synchronous/UI commands.
    pub fn prepare_native_layer_migration_worker(
        &mut self,
        uids: &[u32],
        target: &str,
        deleted: Option<&str>,
        wire: &Value,
        mut check: impl FnMut() -> Result<(), EditError>,
        mut progress: impl FnMut(Progress),
        clock: fn() -> f64,
    ) -> Result<NativePlan, EditError> {
        check()?;
        if self.report.path(&["_styk", "layerSheet"]).is_some() {
            return Err(EditError::Unported(
                "native migration on a layer sheet".into(),
            ));
        }
        if self.drag.is_some()
            || self.authored.is_some()
            || self.property_edit.is_some()
            || self.batch.is_some()
            || self.vfx_edit.is_some()
        {
            return Err(EditError::Unported(
                "native migration staging requires a quiet worker editor".into(),
            ));
        }
        let layers = self.report.path(&["_styk", "layers"]).ok_or_else(|| {
            invalid("errors.editorLayerAsync.chooseAnExistingDestinationUserLayer")
        })?;
        let by_id = layers.get("byId").and_then(Value::as_obj).ok_or_else(|| {
            invalid("errors.editorLayerAsync.chooseAnExistingDestinationUserLayer")
        })?;
        if deleted.map_or_else(|| by_id.get(target).is_none(), |id| by_id.get(id).is_none()) {
            return Err(invalid(
                "errors.editorLayerAsync.chooseAnExistingDestinationUserLayer",
            ));
        }
        let mut updates: Vec<Update> = Vec::new();
        if let Some(id) = deleted {
            let order = array(layers.get("order"));
            if order.len() <= 1 {
                return Err(invalid("errors.editorLayerAsync.keepAtLeastOneUserLayer"));
            }
            if id == target {
                return Err(invalid(
                    "errors.editorLayerAsync.chooseADifferentDestinationLayer",
                ));
            }
            if by_id.get(target).is_none() {
                return Err(invalid(
                    "errors.editorLayerAsync.chooseAnExistingDestinationUserLayer",
                ));
            }
            updates.push((
                vec!["order".into()],
                Some(Value::array(
                    order
                        .into_iter()
                        .filter(|v| v.as_str() != Some(id))
                        .collect(),
                )),
                false,
            ));
            updates.push((vec!["byId".into(), id.into()], None, true));
            if layers.get("defaultLayerId").and_then(Value::as_str) == Some(id) {
                updates.push((
                    vec!["defaultLayerId".into()],
                    Some(Value::str(target)),
                    false,
                ));
            }
            if let Some(assignments) = layers.get("assignments").and_then(Value::as_obj) {
                for (uid, layer) in assignments.iter() {
                    check()?;
                    if layer.as_str() == Some(id) {
                        updates.push((
                            vec!["assignments".into(), uid.to_string()],
                            Some(Value::str(target)),
                            false,
                        ));
                    }
                }
            }
        } else {
            self.ensure_counts();
            let mut seen = HashSet::new();
            for &uid in uids {
                check()?;
                if !seen.insert(uid) {
                    continue;
                }
                if !self.uid_counts.as_ref().unwrap().0.contains_key(&uid) {
                    return Err(invalid(
                        "errors.editorLayerAsync.chooseFiguresPresentInThisAnimation",
                    ));
                }
                if self.layer_of(uid) != target {
                    updates.push((
                        vec!["assignments".into(), uid.to_string()],
                        Some(Value::str(target)),
                        false,
                    ));
                }
            }
        }
        let migration = if updates.is_empty() {
            None
        } else {
            stage(
                &self.report,
                self.next_frame_identity,
                wire,
                &mut check,
                &mut progress,
                clock,
            )?
        };
        Ok(NativePlan {
            before: self.report.clone(),
            revision: self.revision,
            identity: self.next_frame_identity,
            updates,
            migration,
            deleted: deleted.map(str::to_string),
            target: target.into(),
        })
    }

    /// Existing layer publication/history owner, with rollback on worker refusal.
    /// The prepared publication transaction additionally retains displaced heads
    /// through terminal ACK and performs the guarded allocation-free commit.
    pub fn publish_native_layer_migration_worker(
        &mut self,
        plan: NativePlan,
        mut check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<bool, EditError> {
        check()?;
        if !self.worker_history {
            return Err(EditError::Unported("worker history is not prepared".into()));
        }
        if self.drag.is_some()
            || self.authored.is_some()
            || self.property_edit.is_some()
            || self.vfx_edit.is_some()
            || self.batch.is_some()
        {
            return Err(EditError::Unported(
                "native migration publication requires a quiet worker editor".into(),
            ));
        }
        if !same_owner(&self.report, &plan.before, 0, &mut check)?
            || self.revision != plan.revision
            || self.next_frame_identity != plan.identity
        {
            return Err(invalid(
                "errors.editorLayerAsync.theAnimationChangedWhileTheLayerMoveWas",
            ));
        }
        let snapshot = self.snapshot();
        let label = if plan.deleted.is_some() {
            "Delete layer"
        } else {
            "Assign figures to layer"
        };
        let active = plan
            .deleted
            .as_deref()
            .filter(|id| {
                self.report
                    .path(&["_styk", "layers", "activeId"])
                    .and_then(Value::as_str)
                    == Some(*id)
            })
            .map(|_| plan.target);
        let result = self.layer_edit_migration_checked(
            label,
            plan.updates,
            true,
            active,
            plan.migration,
            &mut check,
        );
        if result.is_err() {
            self.restore(snapshot);
        }
        result
    }
}
