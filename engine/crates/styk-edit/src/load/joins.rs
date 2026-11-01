//! Joins a document's frames cannot resolve, mended on load so that the document opens.
//!
//! A frame of a movieclip saved by a build that cut a scene down badly can hold joins that name no figure (a slot that is not there,
//! a figure joined to itself, a ring of figures joined to each other), and the document is refused for it
//! (`errors.model.joinPointsToAMissingFigureOrHandle`). The same figures are joined in the clip's other frames, so a frame whose
//! joins do not resolve takes the joins of the nearest frame whose joins do. This runs only for a document the load refused: a
//! document whose frames resolve is never touched.

use styk_doc::Value;

use super::js::*;

/// Whether every join of `frame` names another figure of the frame, the figure it names is the one its identity says, and no ring of
/// joins closes.
fn resolves(frame: &Value) -> bool {
    let objects = items(frame.get("objects"));
    let parent_of = |index: usize| -> Option<Option<usize>> {
        let join = objects[index].get("join").filter(|join| join.truthy());
        let Some(join) = join else { return Some(None) };
        let slot = join.get("target_object_slot").and_then(Value::as_f64).filter(|slot| *slot >= 0.0 && slot.fract() == 0.0)? as usize;
        let parent = objects.get(slot)?;
        let held = join.get("target_unique_id").is_none_or(|uid| parent.get("unique_id") == Some(uid));
        (slot != index && held).then_some(Some(slot))
    };
    for start in 0..objects.len() {
        let mut at = start;
        for step in 0..=objects.len() {
            match parent_of(at) {
                None => return false,
                Some(None) => break,
                Some(Some(next)) => {
                    if step == objects.len() {
                        return false;
                    }
                    at = next;
                }
            }
        }
    }
    true
}

/// The joins of `donor` by figure identity: the parent's identity and the join record.
fn joins_of(donor: &Value) -> Vec<(f64, f64, Value)> {
    let objects = items(donor.get("objects"));
    objects
        .iter()
        .filter_map(|object| {
            let join = object.get("join").filter(|join| join.truthy())?;
            let parent = join.get("target_object_slot").and_then(Value::as_f64).and_then(|slot| objects.get(slot as usize))?;
            Some((num(object.get("unique_id"))?, num(parent.get("unique_id"))?, join.clone()))
        })
        .collect()
}

/// `frame` with the joins of `donor`: each figure joins the figure it joins in the donor, when that figure is in the frame, and is
/// otherwise left joined as it was when that still resolves, else unjoined.
fn with_joins_of(frame: &Value, donor: &Value) -> Value {
    let donated = joins_of(donor);
    let objects = items(frame.get("objects"));
    let slot_of = |uid: f64| objects.iter().position(|object| num(object.get("unique_id")) == Some(uid));
    let mended: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(index, object)| {
            let Some(uid) = num(object.get("unique_id")) else { return object.clone() };
            let mut next = object.clone();
            let Some(record) = next.make_obj() else { return object.clone() };
            match donated.iter().find(|(child, _, _)| *child == uid) {
                Some((_, parent, join)) => match slot_of(*parent).filter(|slot| *slot != index) {
                    Some(slot) => {
                        let mut join = join.clone();
                        if let Some(fields) = join.make_obj() {
                            fields.set("target_object_slot", Value::Num(slot as f64));
                            fields.set("target_unique_id", Value::Num(*parent));
                        }
                        record.set("join", join);
                    }
                    None => record.set("join", Value::Null),
                },
                // The donor does not join it: what joins it to another figure of this frame, by identity, stays.
                None => {
                    let held = object
                        .get("join")
                        .filter(|join| join.truthy())
                        .and_then(|join| num(join.get("target_unique_id")))
                        .and_then(slot_of)
                        .filter(|slot| *slot != index);
                    match held {
                        Some(slot) => {
                            if let Some(join) = record.get_mut("join").and_then(Value::make_obj) {
                                join.set("target_object_slot", Value::Num(slot as f64));
                            }
                        }
                        None => record.set("join", Value::Null),
                    }
                }
            }
            next
        })
        .collect();
    let mut out = frame.clone();
    if let Some(record) = out.make_obj() {
        record.set("objects", Value::array(mended));
    }
    out
}

/// Mends the keyframes of `report` whose joins do not resolve from the nearest keyframe whose joins do, and says how many it mended.
/// Nothing changes when every keyframe resolves, or when none does (there is no frame to take the joins from).
pub(super) fn repair_joins(report: &mut Value) -> usize {
    let frames = items(report.get("keyframes"));
    let sound: Vec<bool> = frames.iter().map(resolves).collect();
    if sound.iter().all(|sound| *sound) || !sound.iter().any(|sound| *sound) {
        return 0;
    }
    let mut mended = 0;
    let next: Vec<Value> = frames
        .iter()
        .enumerate()
        .map(|(index, frame)| {
            if sound[index] {
                return frame.clone();
            }
            let donor = (0..frames.len()).filter(|other| sound[*other]).min_by_key(|other| other.abs_diff(index)).unwrap();
            mended += 1;
            with_joins_of(frame, &frames[donor])
        })
        .collect();
    if let Some(record) = report.make_obj() {
        record.set("keyframes", Value::array(next));
    }
    mended
}
