//! Read-only background layer planning against the document the engine holds.
//! Publication remains an editor command: a plan never changes the engine document.

use std::collections::{HashMap, HashSet};
use styk_doc::{Obj, Value};
use styk_eval::eval::Prepared;

pub const TRANSFER_BYTES: usize = 128 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 64 * 1024;
const IDLE_TIMEOUT_MS: f64 = 30_000.0;

#[derive(Clone, Debug)]
pub struct LayerRequest {
    pub uids: Vec<u32>,
    pub target_layer: String,
    pub deleted_layer: Option<String>,
    pub next_frame_identity: u64,
    pub max_source_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0} is not ported")]
    Unported(String),
    #[error("Planning was cancelled.")]
    Cancelled,
    #[error("The document changed while the plan was prepared.")]
    Stale,
    #[error("Planning timed out.")]
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub phase: &'static str,
    pub completed: u32,
    pub total: u32,
    pub source_frames: usize,
    pub object_poses: usize,
    pub segment_values: usize,
}

fn invalid(key: &str) -> PlanError {
    PlanError::Invalid(key.into())
}
fn items(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::elements)
        .map(|e| e.iter().collect())
        .unwrap_or_default()
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}
fn layer_pose(value: &Value) -> bool {
    value.get("property").and_then(Value::as_str) == Some("pose")
        && value.path(&["target", "kind"]).and_then(Value::as_str) == Some("layer")
}

/// `planLayerMembershipMigrationSteps`, native timeline branch. Computation and
/// progress callbacks belong on an engine worker. Only new pose assets are allocated;
/// native records and unrelated channels retain the store's COW identities.
pub fn native_layer_plan(
    tree: &Value,
    prepared: &Prepared,
    request: &LayerRequest,
    mut check: impl FnMut() -> Result<(), PlanError>,
    mut progress: impl FnMut(Progress),
    clock: crate::Clock,
) -> Result<Value, PlanError> {
    check()?;
    if tree.path(&["_styk", "layerSheet"]).is_some() {
        return Err(PlanError::Unported("layer-sheet migration planning".into()));
    }
    let state = tree
        .path(&["_styk", "layers"])
        .ok_or_else(|| invalid("errors.editorLayerAsync.chooseAnExistingDestinationUserLayer"))?;
    if state.path(&["byId", &request.target_layer]).is_none() {
        return Err(invalid(
            "errors.editorLayerAsync.chooseAnExistingDestinationUserLayer",
        ));
    }
    if let Some(deleted) = &request.deleted_layer {
        if deleted == &request.target_layer || state.path(&["byId", deleted]).is_none() {
            return Err(invalid(
                "errors.editorLayerMigration.chooseADifferentDestinationBeforeDeletingALayer",
            ));
        }
    }
    let layers =
        prepared.doc.layers.as_ref().ok_or_else(|| {
            invalid("errors.editorLayerAsync.chooseAnExistingDestinationUserLayer")
        })?;
    let moving: HashSet<u32> = request.uids.iter().copied().collect();
    let mut present = HashSet::new();
    for frame in prepared
        .doc
        .keyframes
        .iter()
        .chain(prepared.doc.frame_sources.values())
    {
        check()?;
        present.extend(frame.objects.iter().map(|object| object.uid));
    }
    if moving.iter().any(|uid| !present.contains(uid)) {
        return Err(invalid(
            "errors.editorLayerAsync.chooseFiguresPresentInThisAnimation",
        ));
    }
    let mut source_layers = Vec::new();
    for &uid in &request.uids {
        let owner = layers.layer_of(uid);
        if owner != request.target_layer && !source_layers.iter().any(|id| id == owner) {
            source_layers.push(owner.to_string());
        }
    }
    let before = tree.path(&["_styk", "animation"]);
    let channels = items(before.and_then(|a| a.get("channels")));
    let removed = |channel: &Value| {
        layer_pose(channel)
            && request.deleted_layer.as_deref().is_some_and(|deleted| {
                channel.path(&["target", "id"]).and_then(Value::as_str) == Some(deleted)
            })
    };
    let sampling = !source_layers.is_empty()
        && channels.iter().any(|channel| {
            layer_pose(channel)
                && channel
                    .path(&["target", "id"])
                    .and_then(Value::as_str)
                    .is_some_and(|id| {
                        id == request.target_layer
                            || source_layers.iter().any(|source| source == id)
                    })
        });
    let mut after_channels: Vec<Value> = channels
        .iter()
        .filter(|channel| !removed(channel))
        .cloned()
        .collect();
    if !sampling && after_channels.len() == channels.len() {
        let mut payload = Obj::new();
        payload.set("plan", Value::Null);
        return Ok(Value::object(payload));
    }
    let mut next_key = before.and_then(|a| number(a, "nextKeyId")).unwrap_or(1.0);
    let mut next_frame = request.next_frame_identity;
    let mut sources = Obj::new();
    let mut object_poses = 0usize;
    let mut segment_values = 0usize;
    let ticks = prepared.total_ticks;
    if sampling {
        if ticks == 0 || ticks > 10_000_000 {
            return Err(invalid("errors.editorLayerMigration.timeRange"));
        }
        if after_channels
            .iter()
            .map(|c| c.get("keys").and_then(Value::array_len).unwrap_or(0))
            .sum::<usize>()
            + ticks as usize
            > 1_000_000
        {
            return Err(invalid(
                "errors.editorLayerMigration.preservingThisLayerMoveWouldExceedTheOne",
            ));
        }
        if request.max_source_bytes == 0 {
            return Err(invalid(
                "errors.editorLayerMigration.layerMigrationSourceMemoryBudgetMustBePositive",
            ));
        }
        let mut pose_tree = tree.clone();
        let animation = pose_tree
            .make_obj()
            .and_then(|d| d.get_mut("_styk"))
            .and_then(Value::make_obj)
            .and_then(|s| s.get_mut("animation"))
            .and_then(Value::make_obj)
            .ok_or_else(|| invalid("errors.animationChannels.invalidAnimationMetadata"))?;
        animation.set(
            "channels",
            Value::array(
                channels
                    .iter()
                    .filter(|c| c.get("property").and_then(Value::as_str) == Some("pose"))
                    .cloned()
                    .collect(),
            ),
        );
        let records = styk_eval::records::Records::new(&pose_tree, prepared).map_err(|_| {
            PlanError::Unported("native poses the record evaluator does not preserve".into())
        })?;
        let id = format!("layer:{}:pose", request.target_layer); // Valid user layer IDs are ASCII `layer-N`.
        let mut destination = after_channels
            .iter()
            .find(|c| c.get("id").and_then(Value::as_str) == Some(&id))
            .and_then(Value::as_obj)
            .cloned()
            .unwrap_or_default();
        destination.set("id", Value::str(&id));
        let mut target = Obj::new();
        target.set("kind", Value::str("layer"));
        target.set("id", Value::str(&request.target_layer));
        destination.set("target", Value::object(target));
        destination.set("property", Value::str("pose"));
        destination.set("source", Value::str("authored"));
        let mut keys = Vec::new();
        let mut occupied: HashSet<String> = items(tree.get("keyframes"))
            .iter()
            .filter_map(|f| {
                f.path(&["_styk", "frameId"])
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        if let Some(table) = tree
            .path(&["_styk", "frameSources"])
            .and_then(Value::as_obj)
        {
            occupied.extend(table.keys().map(|key| key.to_string()));
        }
        let mut last_progress = clock();
        for tick in 0..ticks {
            check()?;
            let frame = records.evaluated(tick as f64).map_err(|_| {
                PlanError::Unported(
                    "a sampled native pose the record evaluator does not preserve".into(),
                )
            })?;
            let objects = items(frame.get("objects"));
            let mut keep = vec![false; objects.len()];
            let mut queue = Vec::new();
            for (slot, object) in objects.iter().enumerate() {
                if number(object, "unique_id").is_some_and(|uid| {
                    moving.contains(&(uid as u32))
                        || layers.layer_of(uid as u32) == request.target_layer
                }) {
                    keep[slot] = true;
                    queue.push(slot);
                }
            }
            let mut cursor = 0;
            while cursor < queue.len() {
                let slot = queue[cursor];
                cursor += 1;
                if let Some(parent) = objects[slot]
                    .path(&["join", "target_object_slot"])
                    .and_then(Value::as_f64)
                {
                    if parent.fract() != 0.0 || parent < 0.0 || parent >= objects.len() as f64 {
                        return Err(invalid(
                            "errors.editorLayerMigration.layerMigrationEncounteredAMissingAttachmentParent",
                        ));
                    }
                    if !keep[parent as usize] {
                        keep[parent as usize] = true;
                        queue.push(parent as usize);
                    }
                }
            }
            let slots: Vec<usize> = (0..objects.len()).filter(|slot| keep[*slot]).collect();
            object_poses += slots.len();
            for &slot in &slots {
                for field in ["angles", "lengths", "bends"] {
                    segment_values += objects[slot]
                        .get(field)
                        .and_then(Value::array_len)
                        .unwrap_or(0);
                }
            }
            if object_poses > 2_000_000 || segment_values > 12_000_000 {
                return Err(invalid(
                    "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory",
                ));
            }
            if 256 * (tick as usize + 1) + 512 * object_poses + 8 * segment_values
                > request.max_source_bytes.min(TRANSFER_BYTES)
            {
                return Err(invalid(
                    "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedSourceMemory",
                ));
            }
            let remap: HashMap<usize, usize> = slots
                .iter()
                .enumerate()
                .map(|(new, old)| (*old, new))
                .collect();
            let mut compact = Vec::new();
            for &slot in &slots {
                let mut object = objects[slot].as_obj().cloned().unwrap_or_default();
                object.remove("runtime_segments");
                object.set("object_slot", Value::Num(remap[&slot] as f64));
                if let Some(join) = object
                    .get("join")
                    .filter(|j| j.truthy())
                    .and_then(Value::as_obj)
                {
                    let mut join = join.clone();
                    let parent = join.get("target_object_slot").and_then(Value::as_i64).filter(|slot| *slot >= 0).ok_or_else(|| invalid("errors.editorLayerMigration.layerMigrationEncounteredAMissingAttachmentParent"))? as usize;
                    if !remap.contains_key(&parent) {
                        return Err(invalid(
                            "errors.editorLayerMigration.layerMigrationEncounteredAMissingAttachmentParent",
                        ));
                    }
                    join.set("target_object_slot", Value::Num(remap[&parent] as f64));
                    object.set("join", Value::object(join));
                }
                compact.push(Value::object(object));
            }
            let order = frame
                .get("object_draw_order")
                .and_then(Value::numbers)
                .unwrap_or_else(|| (0..objects.len()).map(|n| n as f64).collect())
                .into_iter()
                .filter_map(|slot| remap.get(&(slot as usize)).copied())
                .collect::<Vec<_>>();
            let mut frame = frame.as_obj().cloned().unwrap_or_default();
            frame.set("objects", Value::array(compact.clone()));
            frame.set("object_count", Value::Num(compact.len() as f64));
            frame.set(
                "object_draw_order",
                Value::array(order.iter().map(|&slot| Value::Num(slot as f64)).collect()),
            );
            frame.set(
                "object_draw_order_unique_ids",
                Value::array(
                    order
                        .iter()
                        .map(|&slot| {
                            compact[slot]
                                .get("unique_id")
                                .cloned()
                                .unwrap_or(Value::Null)
                        })
                        .collect(),
                ),
            );
            let frame_id = loop {
                if next_frame == 0 || next_frame > 9_007_199_254_740_991 {
                    return Err(invalid(
                        "errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded",
                    ));
                }
                let id = format!("frame-{next_frame}");
                next_frame += 1;
                if occupied.insert(id.clone()) {
                    break id;
                }
            };
            let mut styk = frame
                .get("_styk")
                .and_then(Value::as_obj)
                .cloned()
                .unwrap_or_default();
            styk.set("frameId", Value::str(&frame_id));
            frame.set("_styk", Value::object(styk));
            frame.set("duration_raw", Value::Num(1.0));
            sources.set(&frame_id, Value::object(frame));
            if !next_key.is_finite()
                || next_key < 1.0
                || next_key.fract() != 0.0
                || next_key > 9_007_199_254_740_991.0
            {
                return Err(invalid(
                    "errors.cameraBakeAuthored.animationKeyIdentityCapacityExceeded",
                ));
            }
            let mut key = Obj::new();
            key.set("id", Value::str(&format!("key-{}", next_key as u64)));
            next_key += 1.0;
            key.set("tick", Value::Num(tick as f64));
            let mut value = Obj::new();
            value.set("frameId", Value::str(&frame_id));
            key.set("value", Value::object(value));
            key.set("interpolation", Value::str("hold"));
            keys.push(Value::object(key));
            if (tick + 1) % 8 == 0 || clock() - last_progress >= 8.0 || tick + 1 == ticks {
                progress(Progress {
                    phase: "sampling",
                    completed: tick + 1,
                    total: ticks,
                    source_frames: keys.len(),
                    object_poses,
                    segment_values,
                });
                last_progress = clock();
            }
        }
        destination.set("keys", Value::array(keys));
        match after_channels
            .iter()
            .position(|c| c.get("id").and_then(Value::as_str) == Some(&id))
        {
            Some(at) => after_channels[at] = Value::object(destination),
            None => after_channels.push(Value::object(destination)),
        }
    }
    check()?;
    let mut updates = Vec::new();
    for channel in &after_channels {
        if !channels.iter().any(|before| before.same_node(channel)) {
            let mut update = Obj::new();
            update.set("id", channel.get("id").cloned().unwrap_or(Value::Null));
            update.set("channel", channel.clone());
            updates.push(Value::object(update));
        }
    }
    for channel in &channels {
        if !after_channels
            .iter()
            .any(|after| after.get("id") == channel.get("id"))
        {
            let mut update = Obj::new();
            update.set("id", channel.get("id").cloned().unwrap_or(Value::Null));
            update.set("channel", Value::Null);
            updates.push(Value::object(update));
        }
    }
    let mut plan = Obj::new();
    plan.set("version", Value::Num(1.0));
    plan.set("channelUpdates", Value::array(updates));
    plan.set(
        "channelOrder",
        Value::array(
            after_channels
                .iter()
                .map(|c| c.get("id").cloned().unwrap_or(Value::Null))
                .collect(),
        ),
    );
    plan.set("nextKeyId", Value::Num(next_key));
    plan.set("frameSources", Value::object(sources));
    plan.set("nextFrameIdentity", Value::Num(next_frame as f64));
    plan.set(
        "sampledTicks",
        Value::Num(if sampling { ticks as f64 } else { 0.0 }),
    );
    source_layers.push(request.target_layer.clone());
    plan.set(
        "affectedLayerIds",
        Value::array(source_layers.iter().map(|id| Value::str(id)).collect()),
    );
    plan.set(
        "hadFrameSourceTable",
        Value::Bool(tree.path(&["_styk", "frameSources"]).is_some()),
    );
    if sampling {
        plan.set(
            "sourceBytes",
            Value::Num((256 * ticks as usize + 512 * object_poses + 8 * segment_values) as f64),
        );
    }
    let mut payload = Obj::new();
    payload.set("plan", Value::object(plan));
    Ok(Value::object(payload))
}

/// Bounded document-transport operations, computed and serialized by workers.
/// A dense record is visited, not serialized or cloned as a single subtree.
pub struct Chunks {
    stack: Vec<Walk>,
    fragment: Option<(Vec<Value>, Value, usize)>,
    header: bool,
    transferred: usize,
}
struct Walk {
    value: Value,
    path: Vec<Value>,
    index: usize,
}

fn bounded_size(value: &Value, limit: usize) -> usize {
    let mut stack = vec![value.clone()];
    let mut size = 0;
    while let Some(value) = stack.pop() {
        match value {
            Value::Obj(object) => {
                size += 32;
                // Do not enqueue a wide subtree after its minimum size exceeds the budget.
                if object.len().saturating_mul(24) > limit.saturating_sub(size) {
                    return limit + 1;
                }
                for (key, value) in object.iter() {
                    size += key.len() * 6 + 16;
                    stack.push(value.clone());
                }
            }
            Value::Arr(array) => {
                size += 32;
                if array.len().saturating_mul(24) > limit.saturating_sub(size) {
                    return limit + 1;
                }
                stack.extend(array.iter().cloned());
            }
            Value::Nums(array) => size += 32 + array.len() * 24,
            Value::Str(text) => size += 16 + text.len() * 6,
            Value::Blob(blob) => {
                size += 16 + blob.prefix.len() * 6 + blob.bytes.len().div_ceil(3) * 4 * 6
            }
            _ => size += 24,
        }
        if size > limit {
            return size;
        }
    }
    size
}
fn operation(path: Vec<Value>, field: &str, value: Value) -> Value {
    let mut op = Obj::new();
    op.set("path", Value::array(path));
    op.set(field, value);
    Value::object(op)
}
fn path_size(path: &[Value]) -> usize {
    128 + path
        .iter()
        .map(|part| part.as_str().map_or(24, |s| s.len() * 6 + 24))
        .sum::<usize>()
}
fn string_part(value: &Value, offset: usize) -> (String, usize, bool) {
    const PER: usize = CHUNK_BYTES / 16;
    let text = match value {
        Value::Str(text) => Some(text.as_ref()),
        Value::Blob(blob) if offset < blob.prefix.len() => Some(blob.prefix.as_ref()),
        _ => None,
    };
    if let Some(text) = text {
        let mut end = (offset + PER).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let done =
            end == text.len() && !matches!(value, Value::Blob(blob) if !blob.bytes.is_empty());
        return (text[offset..end].to_string(), end, done);
    }
    let Value::Blob(blob) = value else {
        unreachable!()
    };
    let start = (offset - blob.prefix.len()) / 4 * 3;
    let end = (start + PER / 4 * 3).min(blob.bytes.len());
    let mut out = Vec::with_capacity((end - start).div_ceil(3) * 4);
    styk_doc::json::base64_into(&blob.bytes[start..end], &mut out);
    let out = String::from_utf8(out).expect("base64 is ASCII");
    (
        out,
        blob.prefix.len() + end.div_ceil(3) * 4,
        end == blob.bytes.len(),
    )
}
impl Chunks {
    pub fn new(payload: Value) -> Result<Self, PlanError> {
        if payload.as_obj().is_none() {
            return Err(invalid("planner payload must be a record"));
        }
        Ok(Self {
            stack: vec![Walk {
                value: payload,
                path: Vec::new(),
                index: 0,
            }],
            fragment: None,
            header: true,
            transferred: 0,
        })
    }
    /// JSON packets include estimated clone overhead; both each packet and the
    /// cumulative retained transfer are bounded. No complete payload stringify.
    pub fn next_chunk(&mut self) -> Result<Option<String>, PlanError> {
        if self.header {
            self.header = false;
            self.transferred = 64;
            return Ok(Some("{\"header\":{}}".into()));
        }
        let mut operations = Vec::new();
        let mut bytes = 64;
        while bytes < CHUNK_BYTES / 4 && operations.len() < 256 {
            let (op, size) = if let Some((path, value, offset)) = self.fragment.take() {
                let path_bytes = path_size(&path);
                if path_bytes > CHUNK_BYTES / 4 {
                    return Err(invalid(
                        "planning transfer path exceeds the packet budget",
                    ));
                }
                match &value {
                    Value::Str(_) | Value::Blob(_) => {
                        let (part, next, done) = string_part(&value, offset);
                        let size = part.len() * 6 + path_bytes;
                        if !done {
                            self.fragment = Some((path.clone(), value, next));
                        }
                        (
                            operation(
                                path,
                                if offset == 0 { "value" } else { "append" },
                                Value::str(&part),
                            ),
                            size,
                        )
                    }
                    Value::Nums(nums) => {
                        let end = (offset + (CHUNK_BYTES / 4) / 24).min(nums.len());
                        let part = Value::array(
                            (offset..end)
                                .map(|i| Value::Num(nums.get(i).unwrap()))
                                .collect(),
                        );
                        let size = (end - offset) * 24 + path_bytes;
                        if end < nums.len() {
                            self.fragment = Some((path.clone(), value, end));
                        }
                        (
                            operation(path, if offset == 0 { "value" } else { "extend" }, part),
                            size,
                        )
                    }
                    _ => unreachable!(),
                }
            } else {
                let Some(frame) = self.stack.last_mut() else {
                    break;
                };
                let count = frame
                    .value
                    .as_obj()
                    .map_or_else(|| frame.value.array_len().unwrap_or(0), Obj::len);
                if frame.index == count {
                    self.stack.pop();
                    continue;
                }
                let (key, value) = match &frame.value {
                    Value::Obj(object) => (
                        Value::str(&object.shape().keys()[frame.index]),
                        object.values()[frame.index].clone(),
                    ),
                    _ => (
                        Value::Num(frame.index as f64),
                        frame.value.elements().unwrap().get(frame.index).unwrap(),
                    ),
                };
                frame.index += 1;
                let mut path = frame.path.clone();
                path.push(key);
                let path_bytes = path_size(&path);
                if path_bytes > CHUNK_BYTES / 4 {
                    return Err(invalid(
                        "planning transfer path exceeds the packet budget",
                    ));
                }
                let size = bounded_size(&value, CHUNK_BYTES / 4);
                if size <= CHUNK_BYTES / 4 {
                    (operation(path, "value", value), size + path_bytes)
                } else if matches!(value, Value::Str(_) | Value::Blob(_) | Value::Nums(_)) {
                    self.fragment = Some((path, value, 0));
                    continue;
                } else {
                    let empty = if value.as_obj().is_some() {
                        Value::object(Obj::new())
                    } else {
                        Value::array(Vec::new())
                    };
                    self.stack.push(Walk {
                        value,
                        path: path.clone(),
                        index: 0,
                    });
                    (operation(path, "value", empty), path_bytes + 32)
                }
            };
            bytes += size;
            operations.push(op);
        }
        if operations.is_empty() {
            return Ok(None);
        }
        self.transferred += bytes;
        if self.transferred > TRANSFER_BYTES {
            return Err(invalid(
                "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedSourceMemory",
            ));
        }
        let mut packet = Obj::new();
        packet.set("operations", Value::array(operations));
        packet.set("estimatedBytes", Value::Num(bytes as f64));
        let json = styk_doc::json::to_string(&Value::object(packet));
        if json.len() > CHUNK_BYTES || bytes > CHUNK_BYTES {
            return Err(invalid(
                "planning transfer packet exceeds the budget",
            ));
        }
        Ok(Some(json))
    }
}

use crate::{Engine, Inner};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};

#[derive(Clone, Debug)]
pub struct Chunk {
    pub sequence: u32,
    pub json: String,
}
#[derive(Default, Debug)]
pub struct Poll {
    pub progress: Option<Progress>,
    pub chunk: Option<Chunk>,
    pub done: bool,
    pub error: Option<PlanError>,
}
#[derive(Default)]
struct Mailbox {
    progress: Option<Progress>,
    chunk: Option<Chunk>,
    terminal: Option<Result<(), PlanError>>,
    awaiting: Option<u32>,
    delivered: bool,
}
/// Strong ownership is retained by the engine until a worker clears `cursor`.
/// The UI handle owns only the bounded mailbox and a weak reference to this core.
pub(crate) struct Core {
    engine: Weak<Inner>,
    generation: u64,
    lineage: u64,
    revision: u64,
    cancelled: AtomicU8,
    queued: AtomicBool,
    mailbox: Arc<Mutex<Mailbox>>,
    cursor: Mutex<Option<Chunks>>,
    sequence: std::sync::atomic::AtomicU32,
    deadline: std::sync::atomic::AtomicU64,
}
pub struct LayerJob {
    core: Weak<Core>,
    mailbox: Arc<Mutex<Mailbox>>,
}
impl Core {
    fn touch(&self, engine: &Engine) {
        self.deadline.store(
            (engine.now() + IDLE_TIMEOUT_MS).to_bits(),
            Ordering::Release,
        );
    }
    /// The latest progress, for the host to take; the job's idle time restarts.
    fn report(&self, engine: &Engine, progress: Progress) {
        self.touch(engine);
        self.mailbox.lock().unwrap_or_else(|e| e.into_inner()).progress = Some(progress);
        engine.notify_progress();
    }
    fn check(&self, engine: &Engine) -> Result<(), PlanError> {
        match self.cancelled.load(Ordering::Acquire) {
            2 => return Err(PlanError::Stale),
            1 => return Err(PlanError::Cancelled),
            3 => return Err(PlanError::TimedOut),
            _ => {}
        }
        if engine.inner.stopping.load(Ordering::Acquire) {
            return Err(PlanError::Cancelled);
        }
        let current = engine.generation().ok_or(PlanError::Stale)?;
        if current.id != self.generation
            || current.lineage != self.lineage
            || current.revision != self.revision
        {
            return Err(PlanError::Stale);
        }
        Ok(())
    }
    fn schedule(self: &Arc<Self>) {
        if self.queued.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(inner) = self.engine.upgrade() {
            let core = self.clone();
            Engine { inner }.spawn_retained(move |engine| core.advance(engine));
        }
    }
    fn finish(self: &Arc<Self>, engine: &Engine, result: Result<(), PlanError>) {
        // Potentially large trees are destroyed here, on the worker only.
        self.cursor.lock().unwrap_or_else(|e| e.into_inner()).take();
        {
            let mut state = self.mailbox.lock().unwrap_or_else(|e| e.into_inner());
            state.chunk = None;
            state.awaiting = None;
            state.terminal = Some(result);
        }
        self.queued.store(false, Ordering::Release);
        let mut active = engine.inner.planning.lock();
        if active.as_ref().is_some_and(|core| Arc::ptr_eq(core, self)) {
            active.take();
        }
        drop(active);
        engine.notify_progress();
    }
    fn advance(self: Arc<Self>, engine: &Engine) {
        if let Err(error) = self.check(engine) {
            self.finish(engine, Err(error));
            return;
        }
        let result = self
            .cursor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
            .map_or(Ok(None), Chunks::next_chunk);
        match result {
            Err(error) => self.finish(engine, Err(error)),
            Ok(None) => self.finish(engine, Ok(())),
            Ok(Some(json)) => {
                if let Err(error) = self.check(engine) {
                    self.finish(engine, Err(error));
                    return;
                }
                let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
                // Clear queued under the same short mailbox lock the ACK tries.
                let mut state = self.mailbox.lock().unwrap_or_else(|e| e.into_inner());
                self.touch(engine);
                state.awaiting = Some(sequence);
                state.delivered = false;
                state.chunk = Some(Chunk { sequence, json });
                self.queued.store(false, Ordering::Release);
                drop(state);
                engine.notify_progress();
            }
        }
    }
}
impl LayerJob {
    /// Never waits on worker locks; a contended poll has no result yet.
    pub fn poll(&self) -> Poll {
        let Ok(mut state) = self.mailbox.try_lock() else {
            return Poll::default();
        };
        let chunk = state.chunk.take();
        if chunk.is_some() {
            state.delivered = true;
        }
        let (done, error) = match &state.terminal {
            Some(Ok(())) => (true, None),
            Some(Err(error)) => (false, Some(error.clone())),
            None => (false, None),
        };
        Poll {
            progress: state.progress.take(),
            chunk,
            done,
            error,
        }
    }
    /// ACK exactly the packet already taken by `poll`. Duplicate, future and
    /// premature ACKs cannot enqueue work or advance the cursor.
    pub fn ack(&self, sequence: u32) -> Result<bool, PlanError> {
        let Ok(mut state) = self.mailbox.try_lock() else {
            return Ok(false);
        };
        if !state.delivered || state.awaiting != Some(sequence) {
            return Err(invalid("planning packet ACK arrived out of order"));
        }
        state.awaiting = None;
        state.delivered = false;
        if let Some(core) = self.core.upgrade() {
            if let Some(inner) = core.engine.upgrade() {
                core.touch(&Engine { inner });
            }
            core.schedule();
        }
        Ok(true)
    }
    pub fn cancel(&self) {
        if let Some(core) = self.core.upgrade() {
            core.cancelled.store(1, Ordering::Release);
            core.schedule();
        }
    }
}
impl Drop for LayerJob {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Invalidates the one active job without disposing its tree on the caller.
/// Called by worker scheduling even while no ACK/frame task is ready.
pub(crate) fn expire_current(engine: &Engine) {
    let core = engine.inner.planning.lock().clone();
    if let Some(core) = core {
        if engine.now() >= f64::from_bits(core.deadline.load(Ordering::Acquire))
            && core
                .cancelled
                .compare_exchange(0, 3, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            core.schedule();
        }
    }
}
// Publication can race a job installed while its heads are being prepared, or a
// new-generation job installed after the exchange. Only retire the displaced
// generation's owner, after releasing State, on the same retained task lane.
pub(crate) fn invalidate_generation(engine: &Engine, generation: u64) {
    let core = engine.inner.planning.lock().as_ref().filter(|core| core.generation == generation).cloned();
    if let Some(core) = core {
        core.cancelled.store(2, Ordering::Release);
        core.schedule();
    }
}
pub(crate) fn cancel_current(engine: &Engine) {
    let core = engine.inner.planning.lock().clone();
    if let Some(core) = core {
        core.cancelled.store(1, Ordering::Release);
        core.schedule();
    }
}
/// What the editor asks of in-between planning: a ratio, the chosen native keys (ascending,
/// once each, as the editor orders them) and its next pose-source identity.
#[derive(Clone, Debug)]
pub struct InbetweenRequest {
    pub ratio: f64,
    pub indices: Vec<usize>,
    pub next_frame_identity: u64,
}

/// A planner's work on the worker: the engine's document in, the payload out.
type Kernel = Box<
    dyn FnOnce(&Engine, &Core, &Value, &styk_eval::load::Loader, &Prepared) -> Result<Value, PlanError>
        + Send
        + 'static,
>;

impl Engine {
    /// Queue read-only native or sheet planning against the document the engine holds.
    /// The host must run engine workers; never call `step` on a browser UI for it.
    /// A newer job cancels the previous one, bounding mailbox and task ownership.
    pub fn plan_layers(&self, revision: u64, request: LayerRequest) -> Result<LayerJob, PlanError> {
        // Requests contain only IDs: bound this UI copy independently of document size.
        if request.uids.len() > 10_000
            || request.target_layer.len() > 128
            || request
                .deleted_layer
                .as_ref()
                .is_some_and(|id| id.len() > 128)
        {
            return Err(invalid("planning request exceeds the ID budget"));
        }
        self.plan(
            revision,
            Box::new(move |engine, core, tree, loader, prepared| {
                if tree.path(&["_styk", "layerSheet"]).is_some() {
                    let mut loader = loader.clone();
                    let plan = styk_edit::layer_planning::sheet_layer_plan(
                        tree,
                        prepared,
                        &mut loader,
                        styk_edit::layer_planning::Request {
                            uids: &request.uids,
                            target_layer: &request.target_layer,
                            deleted_layer: request.deleted_layer.as_deref(),
                            next_frame_identity: request.next_frame_identity,
                            max_source_bytes: request.max_source_bytes,
                        },
                        || {
                            core.check(engine)
                                .map_err(|error| styk_edit::EditError::Invalid(error.to_string()))
                        },
                        |progress| {
                            core.report(
                                engine,
                                Progress {
                                    phase: progress.phase,
                                    completed: progress.completed as u32,
                                    total: progress.total as u32,
                                    source_frames: progress.source_frames,
                                    object_poses: progress.object_poses,
                                    segment_values: progress.segment_values,
                                },
                            );
                        },
                        engine.inner.clock,
                    );
                    // Preserve cancellation/stale/timeout identity from the same
                    // worker guard, rather than reporting it as validation failure.
                    core.check(engine)?;
                    return plan
                        .map(|plan| {
                            plan.map(|plan| plan.payload()).unwrap_or_else(|| {
                                let mut result = Obj::new();
                                result.set("plan", Value::Null);
                                Value::object(result)
                            })
                        })
                        .map_err(edit_error);
                }
                native_layer_plan(
                    tree,
                    prepared,
                    &request,
                    || core.check(engine),
                    |progress| core.report(engine, progress),
                    engine.inner.clock,
                )
            }),
        )
    }

    /// Queue read-only in-between planning (`styk_edit::inbetween_planning`) the same way:
    /// the plan crosses in bounded packets that each need an ACK, and a newer document
    /// or a cancellation retires the job on the workers.
    pub fn plan_inbetweens(&self, revision: u64, request: InbetweenRequest) -> Result<LayerJob, PlanError> {
        if request.indices.len() > 100_000 {
            return Err(invalid("planning request exceeds the index budget"));
        }
        self.plan(
            revision,
            Box::new(move |engine, core, tree, _, prepared| {
                let plan = styk_edit::inbetween_planning::plan(
                    tree,
                    prepared,
                    &styk_edit::inbetween_planning::Request {
                        ratio: request.ratio,
                        indices: &request.indices,
                        next_frame_identity: request.next_frame_identity,
                    },
                    || {
                        core.check(engine)
                            .map_err(|error| styk_edit::EditError::Invalid(error.to_string()))
                    },
                    |progress| {
                        core.report(
                            engine,
                            Progress {
                                phase: progress.phase,
                                completed: progress.completed as u32,
                                total: progress.total as u32,
                                source_frames: 0,
                                object_poses: 0,
                                segment_values: 0,
                            },
                        );
                    },
                );
                // Cancellation, replacement and timeout keep their own identity.
                core.check(engine)?;
                plan.map_err(edit_error)
            }),
        )
    }

    fn plan(&self, revision: u64, kernel: Kernel) -> Result<LayerJob, PlanError> {
        if self.inner.stopping.load(Ordering::Acquire) {
            return Err(PlanError::Cancelled);
        }
        let (generation_id, lineage, current_revision) = {
            let state = self.inner.state.lock();
            let generation = state.current.as_ref().ok_or(PlanError::Stale)?;
            (generation.id, generation.lineage, generation.revision)
        };
        if current_revision != revision {
            return Err(PlanError::Stale);
        }
        // One active planner, plus at most its one coalesced continuation. A
        // caller replacing a job cancels it and retries after worker disposal.
        if self.inner.planning.lock().is_some() {
            cancel_current(self);
            return Err(invalid("a planner is busy; wait for worker disposal"));
        }
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let core = Arc::new(Core {
            engine: Arc::downgrade(&self.inner),
            generation: generation_id,
            lineage,
            revision,
            cancelled: AtomicU8::new(0),
            queued: AtomicBool::new(true),
            mailbox: mailbox.clone(),
            cursor: Mutex::new(None),
            sequence: std::sync::atomic::AtomicU32::new(0),
            deadline: std::sync::atomic::AtomicU64::new((self.now() + IDLE_TIMEOUT_MS).to_bits()),
        });
        {
            let mut active = self.inner.planning.lock();
            if active.is_some() {
                return Err(invalid("a planner is busy; wait for worker disposal"));
            }
            *active = Some(core.clone());
        }
        let job = LayerJob {
            core: Arc::downgrade(&core),
            mailbox,
        };
        self.spawn_retained(move |engine| {
            let result = (|| {
                core.check(engine)?;
                let (revision, tree, loader, prepared) =
                    engine.stored_for_editing().ok_or(PlanError::Stale)?;
                if revision != core.revision {
                    return Err(PlanError::Stale);
                }
                core.check(engine)?;
                kernel(engine, &core, &tree, &loader, &prepared)
            })();
            match result {
                Err(error) => core.finish(engine, Err(error)),
                Ok(payload) => {
                    match Chunks::new(payload) {
                        Ok(cursor) => {
                            *core.cursor.lock().unwrap_or_else(|e| e.into_inner()) = Some(cursor)
                        }
                        Err(error) => {
                            core.finish(engine, Err(error));
                            return;
                        }
                    }
                    core.advance(engine);
                }
            }
        });
        Ok(job)
    }
}

/// A refusal of a kernel: its message keys and reasons travel as they are.
fn edit_error(error: styk_edit::EditError) -> PlanError {
    match error {
        styk_edit::EditError::Invalid(message) => PlanError::Invalid(message),
        styk_edit::EditError::Unported(feature) => PlanError::Unported(feature),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Budgets;
    use crate::document::{OpenOptions, OpenSource};
    fn clock() -> f64 {
        0.0
    }
    fn fixture() -> (Engine, LayerRequest) {
        let reference = styk_doc::json::parse(&std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/layer-migration/independent.json"),
        ).unwrap())
        .unwrap();
        let tree = styk_doc::json::parse(
            reference
                .get("document")
                .unwrap()
                .as_str()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let engine = Engine::new(clock, Budgets::for_device(None));
        let text = styk_doc::json::to_string(&tree);
        let opened = engine.open_document(OpenSource::Json { bytes: text.as_bytes(), name: "layer planning" }, OpenOptions::default(), &|| false).unwrap();
        engine.activate(&opened.typed, &opened.tree, 1).unwrap();
        let request = LayerRequest {
            uids: vec![1],
            target_layer: "layer-2".into(),
            deleted_layer: None,
            next_frame_identity: 3,
            max_source_bytes: TRANSFER_BYTES,
        };
        (engine, request)
    }
    /// The document the engine holds, published again at `revision`: a new generation of the same lineage.
    fn republish(engine: &Engine, revision: u64) -> Result<Option<crate::Committed>, crate::document::OpenError> {
        let lineage = engine.generation().unwrap().lineage;
        engine.publish_tree(lineage, engine.stored().unwrap().1, revision)
    }
    fn replacement(engine: &Engine, revision: u64) -> crate::Generation {
        let previous = engine.generation().unwrap();
        crate::Generation { id: 0, lineage: previous.lineage, revision, prepared: previous.prepared.clone(), assets: previous.assets.clone(), open_ms: 0.0, anchors: None }
    }

    #[test]
    fn accepted_publication_retires_a_planner_installed_during_head_preparation() {
        use std::sync::Barrier;
        let (engine, request) = fixture();
        let generation = replacement(&engine, 2);
        let barriers = Arc::new([Barrier::new(2), Barrier::new(2)]);
        let pointer = &engine.inner.state as *const _ as usize;
        let worker = engine.clone();
        let wait = barriers.clone();
        let thread = std::thread::spawn(move || crate::allocation::with_pause(pointer, 2, wait, || {
            crate::allocation::watch(pointer, || worker.install_generation(generation))
        }));
        barriers[0].wait();
        let job = engine.plan_layers(1, request).unwrap();
        let core = job.core.upgrade().unwrap();
        barriers[1].wait();
        let (result, counts) = thread.join().unwrap();
        assert_ne!(result.0, 0);
        assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
        assert_eq!(core.cancelled.load(Ordering::Acquire), 2);
        assert_eq!(core.check(&engine), Err(PlanError::Stale));
        engine.step();
        assert_eq!(job.poll().error, Some(PlanError::Stale));
        assert!(engine.inner.planning.lock().is_none());
    }

    #[test]
    fn a_new_generation_planner_survives_displaced_generation_cleanup_race() {
        use std::sync::Barrier;
        let (engine, request) = fixture();
        let barriers = Arc::new([Barrier::new(2), Barrier::new(2)]);
        // Pause the accepted worker after State exchange, before it reads the
        // existing planning owner. A new current job must not be invalidated.
        let pointer = &engine.inner.planning as *const _ as usize;
        let worker = engine.clone();
        let wait = barriers.clone();
        let thread = std::thread::spawn(move || crate::allocation::with_pause(pointer, 1, wait, || {
            republish(&worker, 2)
        }));
        barriers[0].wait();
        let job = engine.plan_layers(2, request).unwrap();
        let core = job.core.upgrade().unwrap();
        barriers[1].wait();
        assert!(thread.join().unwrap().is_ok());
        assert_eq!(engine.stored().unwrap().0, 2, "the publication updates both owners");
        assert_eq!(core.cancelled.load(Ordering::Acquire), 0);
        assert_eq!(core.check(&engine), Ok(()));
        engine.step();
        assert!(job.poll().chunk.is_some());
        assert!(job.poll().error.is_none());
    }

    #[test]
    fn planning_is_queued_and_acknowledgements_bound_the_cursor() {
        let (engine, request) = fixture();
        let before = styk_doc::json::to_string(&engine.stored().unwrap().1);
        let job = engine.plan_layers(1, request.clone()).unwrap();
        assert!(job.poll().chunk.is_none());
        assert_eq!(engine.inner.state.lock().retained_tasks.len(), 1);
        assert!(job.ack(0).is_err());
        engine.step();
        let packet = job.poll().chunk.unwrap();
        assert_eq!(packet.sequence, 0);
        assert!(job.poll().chunk.is_none());
        assert!(!engine.step(), "no cursor work until ACK");
        assert!(job.ack(1).is_err());
        assert!(job.ack(0).unwrap());
        assert!(job.ack(0).is_err());
        assert_eq!(engine.inner.state.lock().retained_tasks.len(), 1);
        engine.step();
        assert_eq!(job.poll().chunk.unwrap().sequence, 1);
        for _ in 0..1000 {
            job.cancel();
        }
        assert_eq!(
            engine.inner.state.lock().retained_tasks.len(),
            1,
            "coalesced cancellation"
        );
        for _ in 0..100 {
            assert!(engine.plan_layers(1, request.clone()).is_err());
        }
        assert_eq!(
            engine.inner.state.lock().retained_tasks.len(),
            1,
            "bounded replacement requests"
        );
        engine.step();
        assert_eq!(job.poll().error, Some(PlanError::Cancelled));
        assert!(engine.inner.planning.lock().is_none());
        assert_eq!(
            styk_doc::json::to_string(&engine.stored().unwrap().1),
            before
        );
    }
    #[test]
    fn a_job_delivers_one_delta_packet_per_ack_without_publishing() {
        let (engine, request) = fixture();
        let before = engine.stored().unwrap().1;
        let id = engine.generation().unwrap().id;
        let job = engine.plan_layers(1, request).unwrap();
        let mut received = 0;
        let mut last_progress = None;
        loop {
            engine.step();
            let poll = job.poll();
            assert!(poll.error.is_none());
            if let Some(progress) = poll.progress {
                last_progress = Some(progress);
            }
            if let Some(chunk) = poll.chunk {
                assert_eq!(chunk.sequence, received);
                assert!(chunk.json.len() <= CHUNK_BYTES);
                let packet = styk_doc::json::parse(chunk.json.as_bytes()).unwrap();
                if let Some(operations) = packet.get("operations").and_then(Value::elements) {
                    for operation in operations.iter() {
                        assert_eq!(
                            operation.get("path").unwrap().item(0).unwrap().as_str(),
                            Some("plan")
                        );
                    }
                }
                received += 1;
                assert!(job.ack(chunk.sequence).unwrap());
            }
            if poll.done {
                break;
            }
            assert!(received < 1000);
        }
        assert!(received > 1);
        assert_eq!(
            last_progress.unwrap().completed,
            engine.generation().unwrap().prepared.total_ticks
        );
        assert_eq!(engine.generation().unwrap().id, id);
        assert!(before.same_node(&engine.stored().unwrap().1));
        assert!(engine.inner.planning.lock().is_none());
    }
    #[test]
    fn queued_jobs_survive_replacement_only_for_worker_cleanup() {
        let (engine, request) = fixture();
        let job = engine.plan_layers(1, request).unwrap();
        let old = engine.generation().unwrap();
        let old_id = old.id;
        let old_head = Arc::downgrade(&old);
        let old_planner = job.core.clone();
        drop(old);
        republish(&engine, 2).unwrap();
        assert_eq!(engine.inner.state.lock().retained_tasks.len(), 2, "one planner plus one displaced-head retirement");
        assert!(old_head.upgrade().is_some(), "publication retains the old head until its worker disposal");
        assert!(old_planner.upgrade().is_some());
        assert!(engine.step());
        assert_eq!(job.poll().error, Some(PlanError::Stale));
        assert!(engine.inner.planning.lock().is_none());
        assert!(old_planner.upgrade().is_none(), "the first queued worker retires the stale planner");
        assert_eq!(engine.inner.state.lock().retained_tasks.len(), 1);
        assert!(old_head.upgrade().is_some(), "the remaining retirement still owns the displaced head");
        assert!(engine.step());
        assert_eq!(engine.inner.state.lock().retained_tasks.len(), 0);
        assert!(old_head.upgrade().is_none(), "only its worker step disposes the old head");
        assert!(!engine.step(), "exactly two existing retained owners complete the cleanup");
        assert_ne!(engine.generation().unwrap().id, old_id);
    }
    #[test]
    fn cancel_publish_and_stop_dispose_unacked_128_mib_cursors_on_worker() {
        for operation in ["cancel", "publish", "stop", "drop", "timeout"] {
            let (engine, request) = fixture();
            let job = engine.plan_layers(1, request).unwrap();
            engine.step();
            let core = job.core.upgrade().unwrap();
            // Construct the large fixture on the worker. The UI retains no Value.
            let weak = std::thread::spawn({
                let core = core.clone();
                move || {
                    let blob = Arc::new(styk_doc::Blob {
                        prefix: Arc::from(""),
                        bytes: vec![0; TRANSFER_BYTES].into(),
                    });
                    let weak = Arc::downgrade(&blob);
                    let mut payload = Obj::new();
                    payload.set("blob", Value::Blob(blob));
                    *core.cursor.lock().unwrap() =
                        Some(Chunks::new(Value::object(payload)).unwrap());
                    weak
                }
            })
            .join()
            .unwrap();
            drop(core);
            assert!(weak.upgrade().is_some());
            job.poll();
            match operation {
                "publish" => {
                    let other = br#"{"version":5,"canvas_width":1,"canvas_height":1,"fps":24,"figure_types":[],"backgrounds":[],"keyframes":[]}"#;
                    let opened = engine.open_document(OpenSource::Json { bytes: other, name: "other" }, OpenOptions::default(), &|| false).unwrap();
                    engine.activate(&opened.typed, &opened.tree, 2).unwrap();
                }
                "stop" => engine.stop(),
                "timeout" => {
                    job.core
                        .upgrade()
                        .unwrap()
                        .deadline
                        .store(0.0f64.to_bits(), Ordering::Release);
                }
                "drop" => {}
                _ => job.cancel(),
            }
            let job = if operation == "drop" {
                drop(job);
                None
            } else {
                Some(job)
            };
            // Keep every small handle except the explicit UI-drop case until
            // the worker has disposed the large cursor. Timeout needs no ACK.
            assert!(
                weak.upgrade().is_some(),
                "{operation}: UI never drops large cursor"
            );
            let work = engine.clone();
            let weak_check = weak.clone();
            std::thread::spawn(move || {
                if operation == "stop" {
                    work.work();
                } else {
                    work.step();
                }
                assert!(
                    weak_check.upgrade().is_none(),
                    "{operation}: cursor disposed by worker"
                );
            })
            .join()
            .unwrap();
            assert!(engine.inner.planning.lock().is_none());
            if operation == "timeout" {
                assert_eq!(
                    job.as_ref().unwrap().poll().error,
                    Some(PlanError::TimedOut)
                );
            }
        }
    }
}
