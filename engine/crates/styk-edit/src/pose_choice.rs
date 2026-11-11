//! Pose choices: named, mutually exclusive poses of a rig (src/rig-pose-choices.mjs,
//! `setPoseChoice` in src/editor-spatial.mjs).
//!
//! A visibility group is made of 3D bones marked `_stykPoseChoice`, one shown at its
//! `shown` length and the others at their `hidden` length (0 hides them all); a channel
//! group (`figure._styk.poseChoices`) sets angles and lengths of existing channels. What is
//! selected is read back from those channels: there is no other state.

use std::collections::HashSet;
use styk_doc::{Obj, Value};
use styk_math::{atan2, cos, sin};

use crate::{EditError, Editor};

struct Choice {
    id: f64,
    /// The bone a visibility choice shows, and its two lengths.
    index: usize,
    shown: f64,
    hidden: f64,
    /// A channel choice's `[id, value]` pairs.
    angles: Vec<(f64, f64)>,
    lengths: Vec<(f64, f64)>,
}

struct Group {
    name: String,
    channels: bool,
    /// Whether 0 (every choice hidden) may be chosen.
    hidden: bool,
    /// The choice the channels show: its id, 0 for all hidden, -1 for none or several.
    value: f64,
    choices: Vec<Choice>,
}

fn pairs(value: Option<&Value>) -> Vec<(f64, f64)> {
    let items = value.and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
    items.iter().map(|pair| (pair.item(0).and_then(|v| v.as_f64()).unwrap_or(f64::NAN), pair.item(1).and_then(|v| v.as_f64()).unwrap_or(f64::NAN))).collect()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Native choice metadata validated where its groups and bindings are consumed.
/// General segment/rig validation remains with the topology owner.
pub(crate) fn validate_choices(figure: &Value, segments: &[Value]) -> Result<(), &'static str> {
    const VISIBILITY: &str = "errors.rigPoseChoices.aPoseChoiceNeedsASpatialBoneNames";
    const CHANNELS: &str = "Invalid native rig pose choices.";
    let within = |value: &Value, keys: &[&str]| value.as_obj().is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_ref())));
    let name = |value: Option<&Value>| value.and_then(Value::as_str).is_some_and(|text| !crate::builder::js_trim(text).is_empty() && text.encode_utf16().count() <= 80);
    let finite = |value: Option<&Value>, min: f64, max: f64| value.and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n >= min && n <= max);
    let id = |value: Option<&Value>| value.and_then(Value::as_f64).filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= 65535.0).map(|n| n as u32);
    let mut group_names = HashSet::new();
    let mut allowed = HashSet::new();
    let ids: HashSet<u32> = segments.iter().filter_map(|segment| id(segment.get("segment_id"))).collect();
    for segment in segments {
        if segment.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy) {
            allowed.extend([id(segment.get("segment_id")), id(segment.path(&["_stykRig", "spatial", "turn"])), id(segment.path(&["_stykRig", "spatial", "pitch"]))].into_iter().flatten());
        }
        if let Some(choice) = segment.get("_stykPoseChoice") {
            if !within(choice, &["group", "label", "shown", "hidden"]) || !name(choice.get("group")) || !name(choice.get("label")) ||
                !finite(choice.get("shown"), 0.0, 1e6) || !finite(choice.get("hidden"), 0.0, 1e6) || choice.get("shown") == choice.get("hidden") ||
                !segment.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy) || !segment.get("length").and_then(Value::as_f64).is_some_and(|length| length > 0.0) {
                return Err(VISIBILITY);
            }
            group_names.insert(choice.get("group").and_then(Value::as_str).unwrap().to_string());
        }
    }
    let Some(definitions) = figure.path(&["_styk", "poseChoices"]) else { return Ok(()) };
    let definitions = definitions.elements().filter(|groups| !groups.is_empty() && groups.len() <= 16).ok_or(CHANNELS)?;
    let mut total = 0;
    for group in definitions.iter() {
        if !within(&group, &["name", "choices"]) || !name(group.get("name")) || !group_names.insert(group.get("name").and_then(Value::as_str).unwrap_or("").to_string()) {
            return Err(CHANNELS);
        }
        let choices = group.get("choices").and_then(Value::elements).filter(|choices| !choices.is_empty() && choices.len() <= 64).ok_or(CHANNELS)?;
        let (mut choice_ids, mut labels) = (HashSet::new(), HashSet::new());
        let mut signature = None;
        for choice in choices.iter() {
            if !within(&choice, &["id", "label", "angles", "lengths"]) || !id(choice.get("id")).is_some_and(|id| choice_ids.insert(id)) || !name(choice.get("label")) || !labels.insert(choice.get("label").and_then(Value::as_str).unwrap_or("").to_string()) {
                return Err(CHANNELS);
            }
            let mut binding_ids = Vec::new();
            for key in ["angles", "lengths"] {
                let pairs = choice.get(key).and_then(Value::elements).filter(|pairs| pairs.len() <= 2048).ok_or(CHANNELS)?;
                let mut seen = HashSet::new();
                for pair in pairs.iter() {
                    if pair.array_len() != Some(2) || !id(pair.item(0).as_ref()).is_some_and(|id| allowed.contains(&id) && ids.contains(&id) && seen.insert(id)) ||
                        !finite(pair.item(1).as_ref(), if key == "lengths" { 0.0 } else { -1e6 }, 1e6) {
                        return Err(CHANNELS);
                    }
                    total += 1;if total > 32768 { return Err(CHANNELS); }
                }
                let mut seen: Vec<u32> = seen.into_iter().collect();seen.sort_unstable();binding_ids.push(seen);
            }
            if binding_ids.iter().all(Vec::is_empty) || signature.as_ref().is_some_and(|previous| previous != &binding_ids) { return Err(CHANNELS); }
            signature = Some(binding_ids);
        }
    }
    Ok(())
}

/// `object.len_flag ? object.lengths[i] : segment.length`.
fn length_of(object: &Value, segments: &[Value], i: usize) -> f64 {
    if object.get("len_flag").is_some_and(Value::truthy) {
        object.get("lengths").and_then(|l| l.item(i)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)
    } else {
        segments.get(i).map_or(f64::NAN, |s| number(s, "length"))
    }
}

/// `poseChoiceGroups(figure, object)`: channel groups first, then visibility groups.
fn groups(figure: &Value, object: &Value, rotation: f64) -> Vec<Group> {
    let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let near = |a: f64, b: f64| (a - b).abs() < 1e-5;
    let mut visibility: Vec<Group> = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let Some(choice) = segment.get("_stykPoseChoice").filter(|c| c.truthy()) else { continue };
        let name = choice.get("group").and_then(|g| g.as_str().map(str::to_string)).unwrap_or_default();
        let at = match visibility.iter().position(|g| g.name == name) {
            Some(at) => at,
            None => {
                visibility.push(Group { name, channels: false, hidden: true, value: -1.0, choices: Vec::new() });
                visibility.len() - 1
            }
        };
        visibility[at].choices.push(Choice { id: number(segment, "segment_id"), index, shown: number(choice, "shown"), hidden: number(choice, "hidden"), angles: Vec::new(), lengths: Vec::new() });
    }
    for group in &mut visibility {
        let lengths: Vec<f64> = group.choices.iter().map(|c| length_of(object, &segments, c.index)).collect();
        let shown: Vec<usize> = (0..group.choices.len()).filter(|&k| near(lengths[k], group.choices[k].shown)).collect();
        let hidden = (0..group.choices.len()).all(|k| near(lengths[k], group.choices[k].hidden));
        let selected = shown.len() == 1 && (0..group.choices.len()).all(|k| k == shown[0] || near(lengths[k], group.choices[k].hidden));
        group.value = if hidden {
            0.0
        } else if selected {
            group.choices[shown[0]].id
        } else {
            -1.0
        };
    }
    let mirror = object.get("image_text_flags").is_some_and(Value::truthy);
    let sign = if mirror { -1.0 } else { 1.0 };
    let angle = |i: usize| segments.get(i).map_or(f64::NAN, |s| number(s, "angle_rad"));
    let angles = object.get("angles").and_then(Value::numbers).unwrap_or_default();
    let index_of = |id: f64| segments.iter().position(|s| number(s, "segment_id") == id);
    let definitions: Vec<Value> = figure.path(&["_styk", "poseChoices"]).and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let mut channels: Vec<Group> = definitions
        .iter()
        .map(|group| {
            let choices: Vec<Choice> = group
                .get("choices")
                .and_then(Value::elements)
                .map(|e| e.iter().map(|c| Choice { id: number(&c, "id"), index: 0, shown: 0.0, hidden: 0.0, angles: pairs(c.get("angles")), lengths: pairs(c.get("lengths")) }).collect())
                .unwrap_or_default();
            let selected: Vec<f64> = choices
                .iter()
                .filter(|c| {
                    c.angles.iter().all(|&(id, value)| {
                        let delta = index_of(id).map_or(f64::NAN, |i| (angles.get(i).copied().unwrap_or(f64::NAN) - rotation) * sign - angle(i) - value);
                        atan2(sin(delta), cos(delta)).abs() < 1e-5
                    }) && c.lengths.iter().all(|&(id, value)| index_of(id).is_some_and(|i| (length_of(object, &segments, i) - value).abs() < 1e-5))
                })
                .map(|c| c.id)
                .collect();
            let name = group.get("name").and_then(|n| n.as_str().map(str::to_string)).unwrap_or_default();
            Group { name, channels: true, hidden: false, value: if selected.len() == 1 { selected[0] } else { -1.0 }, choices }
        })
        .collect();
    channels.extend(visibility);
    channels
}

impl Editor {
    /// The existing typed layout/support owner supplies stored origin arithmetic.
    /// Ordinary choices preserve their original raw first-angle contract.
    fn choice_rotation(&self, figure: &Value, object: &Value) -> Result<f64, EditError> {
        if figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
            self.origin_rotation(figure, object)
        } else {
            Ok(object.get("angles").and_then(|angles| angles.item(0)).and_then(|angle| angle.as_f64()).unwrap_or(0.0) -
                figure.get("segments").and_then(|segments| segments.item(0)).and_then(|segment| segment.get("angle_rad").and_then(Value::as_f64)).unwrap_or(0.0))
        }
    }

    /// `setPoseChoice(name, id)`: shows choice `id` of the group `name` (0 hides a visibility
    /// group's choices), in one posed edit.
    pub(crate) fn set_pose_choice(&mut self, name: &Value, id: f64) -> Result<bool, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(false) };
        let figure = self.figure_value(&object);
        if figure.is_null() {
            return Ok(false);
        }
        let name = name.as_str().map(str::to_string);
        let Some(group) = groups(&figure, &object, self.choice_rotation(&figure, &object)?).into_iter().find(|g| Some(&g.name) == name.as_ref()) else { return Ok(false) };
        if (id == 0.0 && !group.hidden) || (id != 0.0 && !group.choices.iter().any(|c| c.id == id)) {
            return Err(EditError::Invalid("errors.editorSpatial.chooseAnAvailableRigPose".into()));
        }
        if group.value == id {
            return Ok(false);
        }
        let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let definition_lengths: Vec<Value> = segments.iter().map(|s| s.get("length").cloned().unwrap_or(Value::Null)).collect();
        let index_of = |id: f64| segments.iter().position(|s| number(s, "segment_id") == id);
        self.object_edit_with(&format!("Change {}", group.name), true, |editor| {
            let pose = Value::object(editor.frame_object_mut(slot).unwrap().clone());
            let rotation = editor.choice_rotation(&figure, &pose)?;
            let record = editor.frame_object_mut(slot).unwrap();
            let lengths_of = |record: &Obj| {
                if record.get("len_flag").is_some_and(Value::truthy) {
                    record.get("lengths").cloned().unwrap_or(Value::Null)
                } else {
                    Value::array(definition_lengths.clone())
                }
            };
            if group.channels {
                // `applyChannelPoseChoice(figure, object, choice)`
                let choice = group.choices.iter().find(|c| c.id == id).unwrap();
                let sign = if record.get("image_text_flags").is_some_and(Value::truthy) { -1.0 } else { 1.0 };
                for &(id, value) in &choice.angles {
                    let i = index_of(id).ok_or_else(|| EditError::Unported("a pose choice naming a missing joint".into()))?;
                    crate::pose::set_item_at(record, "angles", i, rotation + (number(&segments[i], "angle_rad") + value) * sign);
                }
                if !choice.lengths.is_empty() {
                    let lengths = lengths_of(record);
                    record.set("lengths", lengths);
                    for &(id, value) in &choice.lengths {
                        let i = index_of(id).ok_or_else(|| EditError::Unported("a pose choice naming a missing joint".into()))?;
                        crate::pose::set_item_at(record, "lengths", i, value);
                    }
                    record.set("len_flag", Value::Num(1.0));
                }
            } else {
                let lengths = lengths_of(record);
                record.set("lengths", lengths);
                for c in &group.choices {
                    crate::pose::set_item_at(record, "lengths", c.index, if c.id == id { c.shown } else { c.hidden });
                }
                record.set("len_flag", Value::Num(1.0));
            }
            record.remove("runtime_segments");
            Ok(())
        })
    }
}
