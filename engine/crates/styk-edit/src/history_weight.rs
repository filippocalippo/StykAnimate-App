//! Exact editor history weights, prepared on a worker. No cache or second
//! document owner: sizes use the retained command's COW records and owner views.
use crate::history::{Command, CommandKind};
use crate::topology::{FramePoses, Place, Snapshot};
use std::collections::{HashMap, HashSet};
use styk_doc::{Obj, Value};

fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn bytes(
    value: &Value,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<f64, crate::EditError> {
    Ok((styk_doc::json::utf16_units_checked(value, check)? * 2) as f64)
}
fn array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::elements)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}
fn count(value: Option<&Value>) -> usize {
    value.and_then(Value::array_len).unwrap_or(0)
}
fn patch(before: &Value, after: &Value) -> Value {
    object([("before", before.clone()), ("after", after.clone())])
}

/// Parameters the existing topology owner passes to `_topologyEdit` in JS.
#[derive(Clone, Debug, Default)]
pub(crate) struct TopologyShape {
    pub append_only: bool,
    pub segment_indices: Option<std::sync::Arc<Vec<usize>>>,
}

fn poses(
    frames: &[FramePoses],
    stripped: bool,
    vectors: &mut usize,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<Value, crate::EditError> {
    let mut values = Vec::with_capacity(frames.len());
    for entry in frames {
        check()?;
        let mut frame = Obj::new();
        match &entry.place {
            Place::Keyframe(index) => frame.set("index", Value::Num(*index as f64)),
            Place::Source(id) => {
                frame.set("index", Value::Num(-1.0));
                frame.set("sourceId", Value::str(id));
            }
        }
        let mut objects = Vec::with_capacity(entry.objects.len());
        for value in &entry.objects {
            check()?;
            if !stripped {
                objects.push(value.clone());
                continue;
            }
            let mut fields = value.as_obj().cloned().unwrap_or_default();
            for name in ["angles", "lengths", "bends"] {
                if let Some(len) = fields.get(name).and_then(Value::array_len) {
                    *vectors += 64 * len + 32;
                    fields.remove(name);
                }
            }
            objects.push(Value::object(fields));
        }
        frame.set("objects", Value::array(objects));
        values.push(Value::object(frame));
    }
    Ok(Value::array(values))
}
fn snapshot(
    value: &Snapshot,
    figure: Value,
    vectors: &mut usize,
    stripped: bool,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<Value, crate::EditError> {
    let mut snapshot = Obj::new();
    snapshot.set("figure", figure);
    snapshot.set("frames", poses(&value.frames, stripped, vectors, check)?);
    if !value.movieclip_source_animations.is_empty() {
        snapshot.set(
            "movieclipSourceAnimations",
            Value::array(
                value
                    .movieclip_source_animations
                    .iter()
                    .map(|value| value.clone().unwrap_or(Value::Null))
                    .collect(),
            ),
        );
    }
    if !value.sheet_animations.is_empty() {
        snapshot.set(
            "sheetAnimations",
            Value::array(
                value
                    .sheet_animations
                    .iter()
                    .map(|(depth, animation)| {
                        object([
                            ("depth", Value::Num(*depth as f64)),
                            ("animation", animation.clone().unwrap_or(Value::Null)),
                        ])
                    })
                    .collect(),
            ),
        );
    }
    Ok(Value::object(snapshot))
}
fn channel_size(
    channel: &Value,
    seen: &mut HashSet<(u8, usize)>,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<f64, crate::EditError> {
    check()?;
    let mut metadata = channel.as_obj().cloned().unwrap_or_default();
    metadata.remove("keys");
    let mut result = bytes(&Value::object(metadata), check)?;
    if let Some(keys) = channel.get("keys") {
        let identity = match keys {
            Value::Arr(value) => (0, std::sync::Arc::as_ptr(value) as usize),
            Value::Nums(value) => (1, std::sync::Arc::as_ptr(value) as usize),
            _ => unreachable!("validated channels have array keys"),
        };
        if seen.insert(identity) {
            result += bytes(keys, check)?;
        }
    }
    Ok(result)
}
fn animation_size(
    before: Option<&Value>,
    after: &Value,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<f64, crate::EditError> {
    let previous = array(before.and_then(|before| before.get("channels")));
    let next = array(after.get("channels"));
    let mut old: HashMap<_, _> = previous
        .iter()
        .filter_map(|channel| {
            channel
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), channel))
        })
        .collect();
    let mut seen = HashSet::new();
    let mut result = 128.0 + 8.0 * (previous.len() + next.len()) as f64;
    for channel in next {
        check()?;
        let previous = channel
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| old.remove(id));
        if !previous.is_some_and(|old| old.same_node(&channel)) {
            result += channel_size(&channel, &mut seen, check)?;
            if let Some(previous) = previous {
                result += channel_size(previous, &mut seen, check)?;
            }
        }
    }
    // Match Map insertion order for floating arithmetic even with large tables.
    for channel in &previous {
        check()?;
        if channel
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| old.contains_key(id))
        {
            result += channel_size(channel, &mut seen, check)?;
        }
    }
    for animation in before.into_iter().chain(std::iter::once(after)) {
        let mut metadata = animation.as_obj().cloned().unwrap_or_default();
        metadata.remove("channels");
        result += bytes(&Value::object(metadata), check)?;
    }
    Ok(result)
}

/// Computes after the command's revision and attached source metadata are set.
/// This can traverse dense values and must never run in a synchronous UI call.
#[cfg(test)]
pub(crate) fn command_bytes(command: &Command, topology: Option<&TopologyShape>) -> f64 {
    command_bytes_checked(command, topology, &mut || Ok(()))
        .expect("the no-cancellation callback cannot fail")
}

pub(crate) fn command_bytes_checked(
    command: &Command,
    topology: Option<&TopologyShape>,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<f64, crate::EditError> {
    command_projection_checked(command, topology, None, check).map(|(bytes, _)| bytes)
}

// Normal sizing consumes its existing metadata directly. Only explicit record
// observation clones the small metadata vector to retain an enumerable carrier.
fn projection_bytes(metadata: &mut Obj, retain: bool, check: &mut impl FnMut() -> Result<(), crate::EditError>) -> Result<f64, crate::EditError> {
    let fields = if retain { metadata.clone() } else { std::mem::take(metadata) };
    bytes(&Value::object(fields), check)
}

/// Replay-only full carrier from the SAME checked size/payload projection.
/// Specialized estimates are kept separate from their enumerable command data.
pub(crate) fn record_value_checked(command: &Command, weight: &crate::history::Weight, check: &mut impl FnMut() -> Result<(), crate::EditError>) -> Result<Value, crate::EditError> {
    let (_, fields) = command_projection_checked(command, weight.topology.as_ref(), Some(weight), check)?;
    Ok(Value::object(fields.expect("record mode produces a carrier")))
}

fn command_projection_checked(
    command: &Command,
    topology: Option<&TopologyShape>,
    record: Option<&crate::history::Weight>,
    check: &mut impl FnMut() -> Result<(), crate::EditError>,
) -> Result<(f64, Option<Obj>), crate::EditError> {
    check()?;
    let mut metadata = Obj::new();
    metadata.set("label", Value::str(&command.label));
    metadata.set("beforeSelection", command.before_selection.history_value());
    metadata.set("afterSelection", command.after_selection.history_value());
    metadata.set("beforeRevision", Value::Num(command.before_revision as f64));
    metadata.set("afterRevision", Value::Num(command.after_revision as f64));
    if !command.layer_changes.is_empty() {
        metadata.set(
            "layerChanges",
            Value::array(
                command
                    .layer_changes
                    .iter()
                    .map(|change| change.history_value())
                    .collect(),
            ),
        );
    }
    if command.layers {
        metadata.set("layers", Value::Bool(true));
    }
    let flags = |metadata: &mut Obj, structural: bool, timing: bool| {
        metadata.set("structural", Value::Bool(structural));
        metadata.set("timing", Value::Bool(timing));
    };
    let index = |metadata: &mut Obj, index: usize| metadata.set("index", Value::Num(index as f64));
    let result = match &command.kind {
        CommandKind::Ranges { changes, structural, timing } => {
            metadata.set("kind", Value::str("ranges"));
            metadata.set("changes", Value::array(changes.iter().map(crate::frame::FrameSlice::history_value).collect()));
            flags(&mut metadata, *structural, *timing);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::Objects {
            index: at,
            before,
            after,
        } => {
            metadata.set("kind", Value::str("objects"));
            index(&mut metadata, *at);
            metadata.set("before", Value::array(before.clone()));
            metadata.set("after", Value::array(after.clone()));
            flags(&mut metadata, false, false);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::Frame {
            index: at,
            before,
            after,
            structural,
        } => {
            metadata.set("kind", Value::str("frame"));
            index(&mut metadata, *at);
            metadata.set("before", before.clone());
            metadata.set("after", after.clone());
            flags(&mut metadata, *structural, false);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::LayerSheet {
            before,
            after,
            before_layers,
            after_layers,
            sources,
            definitions,
            retain_geometry,
        } => {
            let old = before.get("tracks");
            let tracks = after.get("tracks").and_then(Value::as_obj);
            let changed = tracks
                .into_iter()
                .flat_map(|tracks| tracks.iter())
                .filter(|(id, track)| {
                    !old.and_then(|old| old.get(id))
                        .is_some_and(|old| old.same_node(track))
                })
                .map(|(id, track)| {
                    Value::array(vec![
                        old.and_then(|old| old.get(id))
                            .cloned()
                            .unwrap_or(Value::Null),
                        track.clone(),
                    ])
                })
                .collect();
            let sources = Value::array(
                sources
                    .iter()
                    .map(|(id, source)| {
                        object([
                            ("id", Value::str(id)),
                            ("before", object([("exists", Value::Bool(false))])),
                            (
                                "after",
                                object([("exists", Value::Bool(true)), ("value", source.clone())]),
                            ),
                        ])
                    })
                    .collect(),
            );
            let mut value = Obj::new();
            value.set("tracks", Value::array(changed));
            value.set("beforeLayers", before_layers.clone());
            value.set("afterLayers", after_layers.clone());
            value.set("sources", sources.clone());
            if let Some((at, added)) = definitions {
                value.set(
                    "assets",
                    object([(
                        "figure_types",
                        object([
                            ("added", Value::array(added.clone())),
                            ("index", Value::Num(*at as f64)),
                        ]),
                    )]),
                );
            }
            let result = bytes(&Value::object(value), check)?;
            if record.is_some() {
                metadata.set("kind", Value::str("layer-sheet"));
                metadata.set("before", before.clone());
                metadata.set("after", after.clone());
                metadata.set("beforeLayers", before_layers.clone());
                metadata.set("afterLayers", after_layers.clone());
                metadata.set("frameSourceChanges", sources);
                if let Some((at, added)) = definitions {
                    metadata.set("assets", object([("figure_types", object([("index", Value::Num(*at as f64)), ("added", Value::array(added.clone()))]))]));
                }
                flags(&mut metadata, true, true);
                metadata.set("retainGeometry", Value::Bool(*retain_geometry));
                metadata.set("precomputedBytes", Value::Num(result));
            }
            result
        }
        CommandKind::Layers {
            changes,
            sheet,
            migration,
            structural,
            timing,
        } => {
            metadata.set("kind", Value::str("layers"));
            metadata.set(
                "changes",
                Value::array(
                    changes
                        .iter()
                        .map(|change| change.history_value())
                        .collect(),
                ),
            );
            flags(&mut metadata, *structural, *timing);
            if let Some((before, after)) = sheet {
                metadata.set("layerSheetPatch", patch(before, after));
            }
            if let Some(migration) = migration {
                migration.history_fields(&mut metadata);
            }
            projection_bytes(&mut metadata, record.is_some(), check)? + migration.as_ref().map_or(0.0, |migration| migration.source_bytes() as f64)
        }
        CommandKind::Figure {
            index: at,
            before,
            after,
        } => {
            metadata.set("kind", Value::str("figure"));
            index(&mut metadata, *at);
            metadata.set("before", before.clone());
            metadata.set("after", after.clone());
            flags(&mut metadata, false, false);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::FigureSplice {
            index: at,
            figure_index,
            before,
            after,
        } => {
            metadata.set("kind", Value::str("figure-splice"));
            index(&mut metadata, *at);
            metadata.set("figureIndex", Value::Num(*figure_index as f64));
            metadata.set("before", before.clone());
            metadata.set("after", after.clone());
            flags(&mut metadata, true, false);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::CameraMotion {
            before,
            after,
            sheet,
        } => {
            bytes(
                &Value::array(vec![before.clone().unwrap_or(Value::Null), after.clone()]),
                check,
            )? + sheet.as_ref().map_or(0.0, |(before, _)| {
                before
                    .get("tracks")
                    .and_then(Value::as_obj)
                    .map_or(0, Obj::len) as f64
                    * 160.0
            }) + 256.0
        }
        CommandKind::Palette { before, after } => {
            256.0
                + 16.0
                    * (count(before.as_ref().and_then(|value| value.get("colors")))
                        + count(after.as_ref().and_then(|value| value.get("colors"))))
                        as f64
        }
        CommandKind::Audio { before, after, .. } => {
            fn assets(value: &Value) -> Option<&Obj> {
                value.get("assets").and_then(Value::as_obj)
            }
            let mut weight = 0.0;
            for (source, destination) in [(before, after), (after, before)] {
                for (id, asset) in assets(source).into_iter().flat_map(|assets| assets.iter()) {
                    if !assets(destination)
                        .and_then(|assets| assets.get(id))
                        .is_some_and(|other| other.same_node(asset))
                    {
                        weight +=
                            asset.get("size").and_then(Value::as_f64).unwrap_or(0.0) * 8.0 / 3.0;
                    }
                }
            }
            weight
                + bytes(
                    &Value::array(vec![
                        before.get("tracks").cloned().unwrap_or(Value::Null),
                        after.get("tracks").cloned().unwrap_or(Value::Null),
                    ]),
                    check,
                )?
                + 512.0
        }
        CommandKind::VfxClips {
            before,
            after,
            sheet,
        } => {
            let old = array(before.as_ref().and_then(|before| before.get("clips")));
            let next = array(after.get("clips"));
            let key = |value: &Value| match value {
                Value::Obj(value) => std::sync::Arc::as_ptr(value) as usize,
                _ => 0,
            };
            let old_ids: HashSet<_> = old.iter().map(key).collect();
            let next_ids: HashSet<_> = next.iter().map(key).collect();
            let mut changed = old
                .iter()
                .filter(|value| !next_ids.contains(&key(value)))
                .chain(next.iter().filter(|value| !old_ids.contains(&key(value))));
            512.0
                + changed.try_fold(0.0, |sum, value| {
                    Ok::<_, crate::EditError>(sum + bytes(value, check)?)
                })?
                + (old_ids.len() + next_ids.len()) as f64 * 8.0
                + sheet.as_ref().map_or(0.0, |(before, _)| {
                    before
                        .get("tracks")
                        .and_then(Value::as_obj)
                        .map_or(0, Obj::len) as f64
                        * 160.0
                })
        }
        CommandKind::Fields {
            before,
            after,
            timing,
        } => {
            metadata.set("kind", Value::str("fields"));
            metadata.set(
                "before",
                Value::object(
                    before
                        .iter()
                        .filter_map(|(key, value)| {
                            value
                                .as_ref()
                                .map(|value| (key.clone().into(), value.clone()))
                        })
                        .collect(),
                ),
            );
            metadata.set(
                "after",
                Value::object(
                    after
                        .iter()
                        .map(|(key, value)| (key.clone().into(), value.clone()))
                        .collect(),
                ),
            );
            flags(&mut metadata, false, *timing);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::MovieclipDefinition { index: at, before, after } => {
            let result = after.as_ref().map(|value| bytes(value, check)).transpose()?.unwrap_or(0.0) + 128.0;
            if record.is_some() {
                metadata.set("kind", Value::str("movieclip-definition")); index(&mut metadata, *at);
                metadata.set("before", before.clone().unwrap_or(Value::Null));
                metadata.set("after", after.clone().unwrap_or(Value::Null));
                flags(&mut metadata, true, true);
                metadata.set("precomputedBytes", Value::Num(result));
            }
            result
        }
        CommandKind::Animation { before, after, structural } => {
            metadata.set("kind", Value::str("animation"));
            flags(&mut metadata, *structural, true);
            let result = animation_size(before.as_ref(), after, check)? + projection_bytes(&mut metadata, record.is_some(), check)?;
            if record.is_some() {
                metadata.set("before", before.clone().unwrap_or(Value::Null));
                metadata.set("after", after.clone());
            }
            result
        }
        CommandKind::MovieclipPoses { before, after } => {
            metadata.set("kind", Value::str("movieclip-poses"));
            let mut unused = 0;
            metadata.set(
                "before",
                object([("frames", poses(before, false, &mut unused, check)?)]),
            );
            metadata.set(
                "after",
                object([("frames", poses(after, false, &mut unused, check)?)]),
            );
            flags(&mut metadata, true, true);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::Batch { commands } => {
            if let Some(weight) = record {
                let mut children = Vec::with_capacity(commands.len());
                if commands.len() != weight.children.len() { return Err(crate::EditError::Unported("batch replay carrier weights are unavailable".into())); }
                for (command, child) in commands.iter().zip(&weight.children) {
                    check()?;
                    let mut fields = record_value_checked(command, child, check)?.as_obj().unwrap().clone();
                    fields.set("bytes", Value::Num(child.bytes));
                    children.push(Value::object(fields));
                }
                metadata.set("kind", Value::str("movieclip-batch"));
                metadata.set("commands", Value::array(children));
                metadata.set("precomputedBytes", Value::Num(weight.bytes - command.captured_source_bytes as f64));
                flags(&mut metadata, true, true);
                weight.bytes - command.captured_source_bytes as f64
            } else {
                128.0 + commands.iter().try_fold(0.0, |sum, command| Ok::<_, crate::EditError>(sum + command_bytes_checked(command, None, check)?))?
            }
        }
        CommandKind::FigureRange {
            changes,
            structural,
            retain_geometry,
        } => {
            metadata.set("kind", Value::str("figure-range"));
            metadata.set(
                "changes",
                Value::array(
                    changes
                        .iter()
                        .map(|change| change.history_value())
                        .collect(),
                ),
            );
            flags(&mut metadata, *structural, false);
            metadata.set("retainGeometry", Value::Bool(*retain_geometry));
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        CommandKind::NativeProperties {
            index: at,
            before,
            after,
        } => {
            metadata.set("kind", Value::str("native-properties"));
            metadata.set("scope", Value::str("figure"));
            index(&mut metadata, *at);
            metadata.set("before", before.history_value());
            metadata.set("after", after.history_value());
            metadata.set("definition", Value::Bool(true));
            flags(&mut metadata, false, false);
            projection_bytes(&mut metadata, record.is_some(), check)?
        }
        // Measured by the JavaScript editor, which owns the entry (D19).
        CommandKind::External { .. } => {
            metadata.set("kind", Value::str("external"));
            0.0
        }
        CommandKind::Topology {
            index: at,
            before,
            after,
        } => {
            metadata.set("kind", Value::str("topology"));
            index(&mut metadata, *at);
            flags(&mut metadata, true, false);
            let mut vectors = 0;
            let (mut before_figure, mut after_figure) =
                (before.figure.clone(), after.figure.clone());
            if let Some(shape) = topology {
                let before_segments = array(before.figure.get("segments"));
                let after_segments = array(after.figure.get("segments"));
                let origin = before
                    .figure
                    .path(&["_styk", "animationOrigin"])
                    .is_some_and(Value::truthy);
                if shape.append_only && !origin {
                    metadata.set("appendCount", Value::Num(before_segments.len() as f64));
                    before_figure
                        .make_obj()
                        .unwrap()
                        .set("segments", Value::array(Vec::new()));
                    after_figure.make_obj().unwrap().set(
                        "segments",
                        Value::array(
                            after_segments
                                .into_iter()
                                .skip(before_segments.len())
                                .collect(),
                        ),
                    );
                } else if let Some(indices) = shape.segment_indices.as_ref().filter(|_| !origin) {
                    metadata.set(
                        "segmentIndices",
                        Value::array(
                            indices
                                .iter()
                                .map(|&index| Value::Num(index as f64))
                                .collect(),
                        ),
                    );
                    before_figure.make_obj().unwrap().set(
                        "segments",
                        Value::array(
                            indices
                                .iter()
                                .map(|&index| before_segments[index].clone())
                                .collect(),
                        ),
                    );
                    after_figure.make_obj().unwrap().set(
                        "segments",
                        Value::array(
                            indices
                                .iter()
                                .map(|&index| after_segments[index].clone())
                                .collect(),
                        ),
                    );
                }
            }
            metadata.set(
                "before",
                snapshot(before, before_figure.clone(), &mut vectors, true, check)?,
            );
            metadata.set("after", snapshot(after, after_figure.clone(), &mut vectors, true, check)?);
            let result = projection_bytes(&mut metadata, record.is_some(), check)? + vectors as f64;
            if record.is_some() {
                let mut unused = 0;
                metadata.set("before", snapshot(before, before_figure, &mut unused, false, check)?);
                metadata.set("after", snapshot(after, after_figure, &mut unused, false, check)?);
            }
            result
        }
    };
    let carrier = if record.is_some() {
        // Field order is the actual JS construction order, not the estimate's
        // projection order. Missing optional fields remain absent.
        let order: &[&str] = match &command.kind {
            CommandKind::Objects { .. } | CommandKind::Frame { .. } | CommandKind::Topology { .. } => &["kind", "label", "index", "before", "after", "appendCount", "segmentIndices", "beforeSelection", "afterSelection", "structural", "timing"],
            CommandKind::LayerSheet { .. } => &["kind", "label", "before", "after", "beforeLayers", "afterLayers", "frameSourceChanges", "assets", "beforeSelection", "afterSelection", "structural", "timing", "retainGeometry", "precomputedBytes"],
            CommandKind::Layers { .. } => &["kind", "label", "changes", "beforeSelection", "structural", "timing", "layerSheetPatch", "layerAnimationPatch", "frameSourceChanges", "hadFrameSourceTable", "sourceBytes", "frameSourceUidCounts", "afterSelection"],
            CommandKind::Animation { .. } => &["kind", "label", "before", "after", "beforeSelection", "afterSelection", "structural", "timing"],
            CommandKind::MovieclipDefinition { .. } => &["kind", "index", "before", "after", "label", "beforeSelection", "afterSelection", "structural", "timing", "precomputedBytes"],
            CommandKind::Batch { .. } => &["kind", "commands", "label", "beforeSelection", "afterSelection", "precomputedBytes", "structural", "timing"],
            CommandKind::Ranges { .. } => &["kind", "label", "changes", "beforeSelection", "structural", "timing", "afterSelection"],
            // These existing owners retain exact weight support. Full enumerable
            // observation needs their own recorded optional construction fields.
            CommandKind::Figure { .. } | CommandKind::FigureSplice { .. } | CommandKind::CameraMotion { .. } | CommandKind::Palette { .. } | CommandKind::Audio { .. } | CommandKind::VfxClips { .. } | CommandKind::Fields { .. } | CommandKind::MovieclipPoses { .. } | CommandKind::FigureRange { .. } | CommandKind::NativeProperties { .. } | CommandKind::External { .. } => return Err(crate::EditError::Unported("full record observation for this history owner is not recorded".into())),
        };
        let mut fields = Obj::new();
        for key in order.iter().chain(["layerChanges", "layers", "beforeRevision", "afterRevision"].iter()) {
            if let Some(value) = metadata.get(key) { fields.set(*key, value.clone()); }
        }
        Some(fields)
    } else { None };
    Ok((result + command.captured_source_bytes as f64, carrier))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::select::{Selection, SelectionState, SheetSelection};

    #[test]
    fn recorded_new_figure_command_uses_exact_enumerable_weight() {
        let value = styk_doc::json::parse(&std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/history-evidence/figure-splice.command.json"),
        ).unwrap())
        .unwrap();
        let selection = |value: &Value| SelectionState {
            frame_index: value.get("frameIndex").and_then(Value::as_i64).unwrap() as usize,
            tick: value.get("tick").and_then(Value::as_f64).unwrap(),
            selection: Selection {
                uid: value
                    .get("uid")
                    .and_then(Value::as_i64)
                    .map(|value| value as u32),
                uids: array(value.get("uids"))
                    .iter()
                    .map(|value| value.as_i64().unwrap() as u32)
                    .collect(),
                joint: value.get("joint").and_then(Value::as_i64).unwrap(),
            },
            active_layer: value
                .get("activeLayerId")
                .and_then(Value::as_str)
                .unwrap()
                .into(),
            sheet: value
                .get("sheetSelection")
                .filter(|value| !value.is_null())
                .map(|value| SheetSelection {
                    id: value.get("id").and_then(Value::as_str).unwrap().into(),
                    contents: value.get("contents").is_some_and(Value::truthy),
                }),
            polygon: value.get("polygonSelection").cloned(),
            segment_ids: value.get("segmentIds").and_then(Value::elements)
                .map(|ids| ids.iter().collect()),
            branch: value.get("branch").cloned(),
        };
        let command = Command {
            kind: CommandKind::FigureSplice {
                index: value.get("index").and_then(Value::as_i64).unwrap() as usize,
                figure_index: value.get("figureIndex").and_then(Value::as_i64).unwrap() as usize,
                before: value.get("before").unwrap().clone(),
                after: value.get("after").unwrap().clone(),
            },
            label: value.get("label").and_then(Value::as_str).unwrap().into(),
            before_selection: selection(value.get("beforeSelection").unwrap()),
            after_selection: selection(value.get("afterSelection").unwrap()),
            before_revision: value.get("beforeRevision").and_then(Value::as_i64).unwrap() as u64,
            after_revision: value.get("afterRevision").and_then(Value::as_i64).unwrap() as u64,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: value.get("layers").is_some_and(Value::truthy),
        };
        assert_eq!(
            command_bytes(&command, None),
            value.get("bytes").and_then(Value::as_f64).unwrap()
        );
        assert_eq!(command_bytes(&command, None), 4966.0);
    }
}
