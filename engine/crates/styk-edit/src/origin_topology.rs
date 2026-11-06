//! Retained-origin raw graph repair (editor-origin-support.mjs).
//! Bone pose arithmetic is owned by styk_eval::origin; this layer remaps identities.
use crate::record::{num, uid};
use crate::topology::{FramePoses, Snapshot, TopologyOptions, frame_at, frame_mut};
use crate::{EditError, Editor};
use std::collections::{HashMap, HashSet};
use styk_doc::{Obj, Value};

fn list(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::elements)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
fn set(v: &mut Value, key: &str, value: Value) {
    if let Some(o) = v.make_obj() {
        o.set(key, value);
    }
}
fn id(v: &Value, key: &str) -> f64 {
    num(v, key).unwrap_or(f64::NAN)
}

impl Editor {
    pub(crate) fn repair_origin_support(
        &mut self,
        index: usize,
        before: &Snapshot,
        options: &TopologyOptions,
    ) -> Result<(), EditError> {
        let Some(old_origin) = before.figure.path(&["_styk", "animationOrigin"]) else {
            return Ok(());
        };
        let mut figure = self.figure_at(index);
        if !figure
            .path(&["_styk", "animationOrigin"])
            .is_some_and(Value::truthy)
        {
            let mut metadata = figure
                .get("_styk")
                .and_then(Value::as_obj)
                .cloned()
                .unwrap_or_default();
            metadata.set("animationOrigin", old_origin.clone());
            if let Some(record) = self.edit_figure(index) {
                record.set("_styk", Value::object(metadata));
            }
            figure = self.figure_at(index);
        }
        let segments = list(figure.get("segments"));
        let old_segments = list(before.figure.get("segments"));
        let native: HashMap<u32, usize> = segments
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| Some((num(segment, "segment_id")? as u32, index)))
            .collect();
        let old_indices: HashMap<u32, usize> = old_segments
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| Some((num(segment, "segment_id")? as u32, index)))
            .collect();
        if old_origin.get("support").is_none_or(|s| !s.truthy())
            && !old_origin.get("reversed").is_some_and(Value::truthy)
        {
            if let Some((_, new_id)) = options
                .origin_splits
                .iter()
                .find(|(handle, _)| Some(*handle) == num(old_origin, "rotationHandleId"))
            {
                if let Some(origin) = self
                    .edit_figure(index)
                    .and_then(|f| f.get_mut("_styk"))
                    .and_then(Value::make_obj)
                    .and_then(|s| s.get_mut("animationOrigin"))
                    .and_then(Value::make_obj)
                {
                    origin.set("rotationHandleId", Value::Num(*new_id));
                }
                figure = self.figure_at(index);
            }
        }
        let has_support = old_origin.get("support").is_some_and(Value::truthy);
        if !has_support
            && (options.origin_reroot.is_some()
                || !options.origin_splits.is_empty()
                || old_indices.keys().all(|id| native.contains_key(id)))
        {
            return Ok(());
        }
        let mut old_view = before.figure.clone();
        let source = match old_origin.get("support").filter(|s| s.truthy()) {
            Some(source) => source.clone(),
            None => {
                let object = before
                    .frames
                    .iter()
                    .flat_map(|entry| &entry.objects)
                    .find(|o| o.get("figure_type_id") == before.figure.get("figure_type_id"))
                    .ok_or_else(|| {
                        EditError::Unported(
                            "an origin definition without a recorded pose source".into(),
                        )
                    })?;
                let (typed, _) = self.origin_view(&before.figure, object)?;
                let Some(styk_eval::origin::Origin {
                    kind: styk_eval::origin::Kind::Layout(layout),
                    ..
                }) = typed.origin.as_deref()
                else {
                    return Err(EditError::Unported("a missing origin layout".into()));
                };
                let mut bones = Vec::new();
                for (index, segment) in old_segments.iter().enumerate() {
                    let reverse = layout.reversed[index];
                    let mut bone = Obj::new();
                    bone.set(
                        "parent",
                        Value::Num(layout.parents[index].map_or(-1.0, |i| i as f64)),
                    );
                    bone.set("handleId", segment.get("segment_id").cloned().unwrap());
                    bone.set("reversed", Value::Bool(reverse));
                    bone.set(
                        "angle_rad",
                        Value::Num(styk_eval::origin::angle(&typed, None, index, reverse)),
                    );
                    bone.set(
                        "bend_rad",
                        Value::Num(styk_eval::origin::bend(&typed, None, index, reverse)),
                    );
                    bone.set("length", segment.get("length").cloned().unwrap());
                    bones.push(Value::object(bone));
                }
                let mut vertices = Obj::new();
                vertices.set(
                    &styk_doc::json::to_string(old_origin.get("handleId").unwrap()),
                    Value::Num(-1.0),
                );
                for (handle, index) in &layout.endpoints {
                    vertices.set(&handle.to_string(), Value::Num(*index as f64));
                }
                let path = layout
                    .path
                    .iter()
                    .map(|&index| {
                        let mut term = Obj::new();
                        term.set("bone", Value::Num(index as f64));
                        term.set(
                            "sign",
                            Value::Num(if layout.reversed[index] { -1.0 } else { 1.0 }),
                        );
                        Value::object(term)
                    })
                    .collect();
                let mut source = Obj::new();
                source.set("version", Value::Num(1.0));
                source.set("bones", Value::array(bones));
                source.set("vertices", Value::object(vertices));
                source.set("path", Value::array(path));
                source.set("rotation", Value::Num(layout.rotation.unwrap() as f64));
                let source = Value::object(source);
                let mut origin = old_origin.as_obj().cloned().unwrap();
                origin.set("support", source.clone());
                old_view
                    .make_obj()
                    .unwrap()
                    .get_mut("_styk")
                    .unwrap()
                    .make_obj()
                    .unwrap()
                    .set("animationOrigin", Value::object(origin));
                source
            }
        };
        let mut bones = list(source.get("bones"));
        let previous_count = bones.len();
        let mut vertices = source
            .get("vertices")
            .and_then(Value::as_obj)
            .cloned()
            .unwrap_or_default();
        let mut vertex_nodes: HashMap<usize, Vec<String>> = HashMap::new();
        for (handle, node) in vertices.iter() {
            if let Some(index) = node.as_f64().filter(|n| *n >= 0.0) {
                vertex_nodes
                    .entry(index as usize)
                    .or_default()
                    .push(handle.to_string());
            }
        }
        for index in 0..previous_count {
            let handle = num(&bones[index], "handleId");
            if !handle.is_some_and(|id| {
                options
                    .origin_freeze
                    .contains(&if id == 0.0 { 0 } else { id.to_bits() })
            }) {
                continue;
            }
            let replacement = bones.len();
            bones.push(bones[index].clone());
            set(&mut bones[index], "handleId", Value::Null);
            for handle in vertex_nodes.get(&index).into_iter().flatten() {
                vertices.set(handle, Value::Num(replacement as f64));
            }
        }
        let mut path = list(source.get("path"));
        if let Some(reroot) = &options.origin_reroot {
            let by_handle: HashMap<u32, usize> = bones
                .iter()
                .enumerate()
                .filter_map(|(index, bone)| Some((num(bone, "handleId")? as u32, index)))
                .collect();
            let edge_by_handle: HashMap<u32, _> = reroot
                .edges
                .iter()
                .map(|edge| (edge.old_id as u32, edge))
                .collect();
            let mut prepend = Vec::new();
            let mut current = reroot.handle;
            while current != 0.0 {
                let segment = old_indices
                    .get(&(current as u32))
                    .map(|&index| &old_segments[index]);
                let bone = by_handle.get(&(current as u32)).copied();
                let (Some(segment), Some(bone)) = (segment, bone) else {
                    return Err(EditError::Invalid(
                        "errors.editorOriginSupport.theNewOriginIsDisconnectedFromItsFigure".into(),
                    ));
                };
                if prepend.len() >= old_segments.len() {
                    return Err(EditError::Invalid(
                        "errors.editorOriginSupport.theNewOriginIsDisconnectedFromItsFigure".into(),
                    ));
                }
                let mut term = Obj::new();
                term.set("bone", Value::Num(bone as f64));
                term.set(
                    "sign",
                    Value::Num(if bones[bone].get("reversed").is_some_and(Value::truthy) {
                        1.0
                    } else {
                        -1.0
                    }),
                );
                prepend.push(Value::object(term));
                current = id(segment, "parent_id");
            }
            prepend.extend(path);
            path = prepend;
            let remap = |handle: f64| {
                if handle == 0.0 {
                    reroot.handle
                } else if handle == reroot.handle {
                    0.0
                } else {
                    handle
                }
            };
            let mut remapped_vertices = Obj::new();
            {
                let table = &vertices;
                for (handle, node) in table.iter() {
                    let handle = remap(handle.parse().unwrap_or(f64::NAN));
                    remapped_vertices.set(
                        &styk_doc::json::to_string(&Value::Num(handle)),
                        node.clone(),
                    );
                }
            }
            for bone in &mut bones {
                if bone.get("handleId").is_some_and(Value::is_null) {
                    continue;
                }
                let handle = id(bone, "handleId");
                let edge = edge_by_handle
                    .get(&(handle as u32))
                    .copied()
                    .ok_or_else(|| {
                        EditError::Unported("a support bone not bound to a live handle".into())
                    })?;
                let reversed = bone.get("reversed").is_some_and(Value::truthy) != edge.reverse;
                set(bone, "handleId", Value::Num(edge.id));
                set(bone, "reversed", Value::Bool(reversed));
            }
            vertices = remapped_vertices;
        }
        // Split retained angular dependencies: the second piece keeps the original
        // physical endpoint and the first piece retains its original virtual tangent.
        if !options.origin_splits.is_empty() {
            let by_handle: HashMap<u32, usize> = bones
                .iter()
                .enumerate()
                .filter_map(|(index, bone)| Some((num(bone, "handleId")? as u32, index)))
                .collect();
            let first_count = bones.len();
            let entries: Vec<(f64, usize, usize)> = options
                .origin_splits
                .iter()
                .enumerate()
                .map(|(offset, (handle, new_id))| {
                    let index = by_handle.get(&(*handle as u32)).copied().ok_or_else(|| {
                        EditError::Invalid(
                            "errors.editorOriginSupport.theSplitSegmentHasNoAnimationSupport"
                                .into(),
                        )
                    })?;
                    Ok((*new_id, index, first_count + offset))
                })
                .collect::<Result<_, EditError>>()?;
            let last_pieces: HashMap<usize, usize> = entries
                .iter()
                .map(|(_, index, next)| (*index, *next))
                .collect();
            for bone in &mut bones {
                let parent = id(bone, "parent");
                if parent >= 0.0
                    && let Some(next) = last_pieces.get(&(parent as usize))
                {
                    set(bone, "parent", Value::Num(*next as f64));
                }
            }
            for (new_id, index, _) in &entries {
                let mut first = bones[*index].clone();
                let old_handle = first.get("handleId").cloned().unwrap();
                let reversed = first.get("reversed").is_some_and(Value::truthy);
                set(&mut first, "parent", Value::Num(*index as f64));
                set(
                    &mut first,
                    "handleId",
                    if reversed {
                        Value::Num(*new_id)
                    } else {
                        old_handle.clone()
                    },
                );
                bones.push(first);
                set(
                    &mut bones[*index],
                    "handleId",
                    if reversed {
                        old_handle
                    } else {
                        Value::Num(*new_id)
                    },
                );
            }
            let keys: Vec<(String, f64)> = vertices
                .iter()
                .map(|(key, value)| (key.to_string(), value.as_f64().unwrap()))
                .collect();
            for (key, node) in keys {
                if node >= 0.0
                    && let Some(next) = last_pieces.get(&(node as usize))
                {
                    vertices.set(&key, Value::Num(*next as f64));
                }
            }
            for (new_id, index, _) in &entries {
                vertices.set(
                    &styk_doc::json::to_string(&Value::Num(*new_id)),
                    Value::Num(*index as f64),
                );
            }
            path = path
                .into_iter()
                .flat_map(|term| {
                    if let Some(next) = last_pieces.get(&(id(&term, "bone") as usize)) {
                        let mut copy = term.clone();
                        set(&mut copy, "bone", Value::Num(*next as f64));
                        vec![term, copy]
                    } else {
                        vec![term]
                    }
                })
                .collect();
        }
        let mut live = HashSet::new();
        for bone in &mut bones {
            let Some(segment) = num(bone, "handleId")
                .and_then(|handle| native.get(&(handle as u32)))
                .map(|&index| &segments[index])
            else {
                set(bone, "handleId", Value::Null);
                continue;
            };
            live.insert(id(segment, "segment_id") as u32);
            let reversed = bone.get("reversed").is_some_and(Value::truthy);
            let bend = num(segment, "bend_rad").unwrap_or(0.0);
            set(
                bone,
                "angle_rad",
                Value::Num(
                    id(segment, "angle_rad")
                        + if reversed {
                            bend + std::f64::consts::PI
                        } else {
                            0.0
                        },
                ),
            );
            set(
                bone,
                "bend_rad",
                Value::Num(if reversed { -bend } else { bend }),
            );
            set(bone, "length", segment.get("length").cloned().unwrap());
        }
        let removed: Vec<String> = vertices
            .keys()
            .filter(|key| {
                key.parse::<f64>()
                    .is_ok_and(|handle| handle != 0.0 && !native.contains_key(&(handle as u32)))
            })
            .map(|s| s.to_string())
            .collect();
        for key in removed {
            vertices.remove(&key);
        }
        let pending: Vec<&Value> = segments
            .iter()
            .filter(|s| !live.contains(&(id(s, "segment_id") as u32)))
            .collect();
        let mut ready: Vec<usize> = pending
            .iter()
            .enumerate()
            .filter(|(_, segment)| {
                vertices.contains(&styk_doc::json::to_string(
                    segment.get("parent_id").unwrap(),
                ))
            })
            .map(|(i, _)| i)
            .collect();
        let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
        for (index, segment) in pending.iter().enumerate() {
            children
                .entry(id(segment, "parent_id") as u32)
                .or_default()
                .push(index);
        }
        let mut cursor = 0;
        while cursor < ready.len() {
            let segment = pending[ready[cursor]];
            let index = bones.len();
            let mut bone = Obj::new();
            bone.set(
                "parent",
                vertices
                    .get(&styk_doc::json::to_string(
                        segment.get("parent_id").unwrap(),
                    ))
                    .cloned()
                    .unwrap(),
            );
            bone.set("handleId", segment.get("segment_id").cloned().unwrap());
            bone.set("reversed", Value::Bool(false));
            bone.set("angle_rad", segment.get("angle_rad").cloned().unwrap());
            bone.set(
                "bend_rad",
                segment.get("bend_rad").cloned().unwrap_or(Value::Num(0.0)),
            );
            bone.set("length", segment.get("length").cloned().unwrap());
            bones.push(Value::object(bone));
            vertices.set(
                &styk_doc::json::to_string(segment.get("segment_id").unwrap()),
                Value::Num(index as f64),
            );
            ready.extend(
                children
                    .get(&(id(segment, "segment_id") as u32))
                    .into_iter()
                    .flatten()
                    .copied(),
            );
            cursor += 1;
        }
        if ready.len() != pending.len() {
            return Err(EditError::Invalid(
                "errors.editorOriginSupport.anAddedSegmentIsDisconnectedFromItsAnimation".into(),
            ));
        }
        // `compact`: live/vertex/path/rotation dependencies and their parents, retained
        // in native index order. Equal path terms are counted in their first-seen order.
        let rotation = id(&source, "rotation") as usize;
        let mut required = vec![false; bones.len()];
        for (i, bone) in bones.iter().enumerate() {
            if !bone.get("handleId").is_some_and(Value::is_null) {
                required[i] = true;
            }
        }
        for (_, node) in vertices.iter() {
            if let Some(node) = node.as_f64().filter(|n| *n >= 0.0) {
                required[node as usize] = true;
            }
        }
        for term in &path {
            required[id(term, "bone") as usize] = true;
        }
        required[rotation] = true;
        let mut ready: Vec<usize> = required
            .iter()
            .enumerate()
            .filter(|(_, yes)| **yes)
            .map(|(i, _)| i)
            .collect();
        let mut cursor = 0;
        while cursor < ready.len() {
            let parent = id(&bones[ready[cursor]], "parent");
            if parent >= 0.0 && !required[parent as usize] {
                required[parent as usize] = true;
                ready.push(parent as usize);
            }
            cursor += 1;
        }
        let retained: Vec<usize> = required
            .iter()
            .enumerate()
            .filter(|(_, yes)| **yes)
            .map(|(i, _)| i)
            .collect();
        let mut map = vec![None; bones.len()];
        for (next, previous) in retained.iter().enumerate() {
            map[*previous] = Some(next);
        }
        let mut counts: Vec<(usize, f64)> = Vec::new();
        let mut counted: HashMap<usize, usize> = HashMap::new();
        for term in &path {
            let bone = map[id(term, "bone") as usize].unwrap();
            let sign = id(term, "sign");
            if let Some(&index) = counted.get(&bone) {
                counts[index].1 += sign;
            } else {
                counted.insert(bone, counts.len());
                counts.push((bone, sign));
            }
        }
        path.clear();
        for (bone, count) in counts {
            for _ in 0..count.abs() as usize {
                let mut term = Obj::new();
                term.set("bone", Value::Num(bone as f64));
                term.set("sign", Value::Num(count.signum()));
                path.push(Value::object(term));
            }
        }
        if retained.len() > 100000 || path.len() > 100000 {
            return Err(EditError::Invalid(
                "errors.editorOriginSupport.theRetainedAnimationSupportCapacityHasBeenReached"
                    .into(),
            ));
        }
        let mut packed: Vec<Value> = retained.iter().map(|&i| bones[i].clone()).collect();
        for bone in &mut packed {
            let parent = id(bone, "parent");
            set(
                bone,
                "parent",
                Value::Num(if parent < 0.0 {
                    -1.0
                } else {
                    map[parent as usize].unwrap() as f64
                }),
            );
        }
        let mut packed_vertices = Obj::new();
        for (handle, node) in vertices.iter() {
            let node = node.as_f64().unwrap();
            packed_vertices.set(
                handle,
                Value::Num(if node < 0.0 {
                    -1.0
                } else {
                    map[node as usize].unwrap() as f64
                }),
            );
        }
        let rotation = map[rotation].unwrap();
        let pivot = packed_vertices
            .iter()
            .find(|(_, node)| node.as_f64() == Some(-1.0))
            .map(|(handle, _)| Value::Num(handle.parse().unwrap()));
        let mut support = source.as_obj().cloned().unwrap_or_default();
        support.set("bones", Value::array(packed.clone()));
        support.set("vertices", Value::object(packed_vertices));
        support.set("path", Value::array(path));
        support.set("rotation", Value::Num(rotation as f64));
        let mut origin = figure
            .path(&["_styk", "animationOrigin"])
            .and_then(Value::as_obj)
            .cloned()
            .unwrap_or_default();
        origin.set("handleId", pivot.unwrap_or(Value::Null));
        origin.set(
            "rotationHandleId",
            packed[rotation]
                .get("handleId")
                .cloned()
                .unwrap_or(Value::Null),
        );
        origin.set(
            "reversed",
            packed[rotation]
                .get("reversed")
                .cloned()
                .unwrap_or(Value::Bool(false)),
        );
        origin.set("support", Value::object(support));
        let type_id = figure.get("figure_type_id");
        for entry in &before.frames {
            let objects = list(frame_at(&self.report, &entry.place).and_then(|f| f.get("objects")));
            let mut next = objects.clone();
            for (slot, object) in objects
                .iter()
                .enumerate()
                .filter(|(_, o)| o.get("figure_type_id") == type_id)
            {
                let old = uid(object)
                    .and_then(|identity| entry.objects.iter().find(|o| uid(o) == Some(identity)));
                let typed = old
                    .map(|old| self.origin_view(&old_view, old))
                    .transpose()?;
                let mut ghosts = Obj::new();
                for (index, bone) in packed
                    .iter()
                    .enumerate()
                    .filter(|(_, b)| b.get("handleId").is_some_and(Value::is_null))
                {
                    let previous = retained[index];
                    let mut pose = Obj::new();
                    if previous < previous_count
                        && let Some((figure, object)) = &typed
                        && let Some(styk_eval::origin::Origin {
                            kind: styk_eval::origin::Kind::Support(support),
                            ..
                        }) = figure.origin.as_deref()
                    {
                        let ghost = styk_eval::origin::support_pose(
                            figure,
                            Some(object),
                            support,
                            previous,
                        );
                        pose.set("angle_rad", Value::Num(ghost.angle));
                        pose.set("bend_rad", Value::Num(ghost.bend));
                        pose.set("length", Value::Num(ghost.length));
                    } else {
                        for field in ["angle_rad", "bend_rad", "length"] {
                            pose.set(field, bone.get(field).cloned().unwrap_or(Value::Null));
                        }
                    }
                    ghosts.set(&index.to_string(), Value::object(pose));
                }
                let mut pose_origin = object
                    .get("_stykAnimationOrigin")
                    .and_then(Value::as_obj)
                    .cloned()
                    .unwrap_or_default();
                if ghosts.is_empty() {
                    pose_origin.remove("ghosts");
                } else {
                    pose_origin.set("ghosts", Value::object(ghosts));
                }
                set(
                    &mut next[slot],
                    "_stykAnimationOrigin",
                    Value::object(pose_origin),
                );
            }
            if let Some(objects) = frame_mut(&mut self.report, &entry.place)
                .and_then(|f| f.get_mut("objects"))
                .and_then(Value::make_arr)
            {
                *objects = next;
            }
        }
        if let Some(record) = self.edit_figure(index) {
            let mut metadata = record
                .get("_styk")
                .and_then(Value::as_obj)
                .cloned()
                .unwrap_or_default();
            metadata.set("animationOrigin", Value::object(origin));
            record.set("_styk", Value::object(metadata));
        }
        Ok(())
    }
}

pub(crate) fn geometry_changed(before: &Value, after: &Value) -> bool {
    let (before, after) = (list(before.get("segments")), list(after.get("segments")));
    before.len() != after.len()
        || before.iter().zip(after.iter()).any(|(a, b)| {
            ["segment_id", "parent_id", "length", "angle_rad", "bend_rad"]
                .iter()
                .any(|field| a.get(field) != b.get(field))
        })
}

impl Editor {
    /// Construction changes retain the authored pivot as a local offset, in JS order.
    pub(crate) fn preserve_topology_origins(
        &mut self,
        entry: &FramePoses,
    ) -> Result<(), EditError> {
        let figures = list(self.report.get("figure_types"));
        let objects = list(frame_at(&self.report, &entry.place).and_then(|f| f.get("objects")));
        let mut next = objects.clone();
        for (slot, object) in objects.iter().enumerate() {
            let Some(current) = object.get("_stykAnimationOrigin").and_then(Value::as_obj) else {
                continue;
            };
            let Some(previous) = uid(object)
                .and_then(|identity| entry.objects.iter().find(|old| uid(old) == Some(identity)))
                .and_then(|old| old.get("_stykAnimationOrigin"))
                .and_then(Value::as_obj)
            else {
                continue;
            };
            let Some(figure) = figures.iter().find(|figure| {
                figure.get("figure_type_id") == object.get("figure_type_id")
                    && figure
                        .path(&["_styk", "animationOrigin"])
                        .is_some_and(Value::truthy)
            }) else {
                continue;
            };
            let (figure, pose) = self.origin_view(figure, object)?;
            let mut without_offsets = (*pose).clone();
            if let Some(origin) = &mut without_offsets.origin {
                std::sync::Arc::make_mut(origin).offset = [None, None];
            }
            let point = styk_eval::origin::offset(&figure, &without_offsets);
            let angle = styk_eval::origin::rotation(&figure, &pose);
            let scale = num(object, "scale").unwrap_or(1.0);
            let x = previous
                .get("x")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN)
                - num(object, "root_x").unwrap_or(f64::NAN)
                - point[0];
            let y = previous
                .get("y")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN)
                - num(object, "root_y").unwrap_or(f64::NAN)
                - point[1];
            let (c, s) = (styk_math::cos(angle), styk_math::sin(angle));
            let offset_x = if scale != 0.0 {
                (x * c + y * s) / scale
            } else {
                previous
                    .get("offsetX")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            };
            let offset_y = if scale != 0.0 {
                (-x * s + y * c) / scale
            } else {
                previous
                    .get("offsetY")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            };
            let mut origin = previous.clone();
            origin.set("offsetX", Value::Num(offset_x));
            origin.set("offsetY", Value::Num(offset_y));
            if let Some(ghosts) = current.get("ghosts").filter(|g| g.truthy()) {
                origin.set("ghosts", ghosts.clone());
            } else {
                origin.remove("ghosts");
            }
            set(
                &mut next[slot],
                "_stykAnimationOrigin",
                Value::object(origin),
            );
        }
        if let Some(objects) = frame_mut(&mut self.report, &entry.place)
            .and_then(|f| f.get_mut("objects"))
            .and_then(Value::make_arr)
        {
            *objects = next;
        }
        Ok(())
    }
}
