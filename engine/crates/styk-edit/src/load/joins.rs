//! Joins a document's frames cannot resolve, mended on load so that the document opens.
//!
//! A frame saved by a build that cut a scene down badly can hold joins that name no figure (a slot that is not there, a figure joined to
//! itself, a ring of figures joined to each other), and the document is refused for it
//! (`errors.model.joinPointsToAMissingFigureOrHandle`). The keyframes and the poses a layer sheet retains (`_styk.frameSources`, which
//! the scene of a movieclip keeps) are mended alike: in a frame whose joins do not resolve, a figure whose own join names a figure of the
//! frame keeps it, and so does a figure that is not joined (a frame unjoins a figure on purpose; another frame's join is no reason to
//! join it again). Only a join that names no figure is given the join the figure has in the nearest keyframe whose joins do resolve (the
//! same figures are joined in the clip's other frames), else the join it has in any frame that resolves, and a figure no frame can say
//! a join for is unjoined, as is one of a ring: a project opens with a figure unjoined rather than not at all. Every step is linear in the figures of the document. This runs only for a document the load refused for a join: a
//! document whose frames resolve is never touched.

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use super::js::*;

/// A figure identity as a key: the bits of its number, with zero the same either way.
fn key(uid: f64) -> u64 {
    if uid == 0.0 { 0 } else { uid.to_bits() }
}

/// The place of `objects[index]`'s parent: `Ok(None)` for a figure that is not joined, `Err` for a join that names no figure of the
/// frame (a slot that is not there, the figure itself, an identity other than the figure's at that slot).
fn parent_of(objects: &[Value], index: usize) -> Result<Option<usize>, ()> {
    let Some(join) = objects[index].get("join").filter(|join| join.truthy()) else { return Ok(None) };
    let slot = join.get("target_object_slot").and_then(Value::as_f64).filter(|slot| *slot >= 0.0 && slot.fract() == 0.0).ok_or(())? as usize;
    let parent = objects.get(slot).ok_or(())?;
    let held = join.get("target_unique_id").is_none_or(|uid| parent.get("unique_id") == Some(uid));
    if slot != index && held { Ok(Some(slot)) } else { Err(()) }
}

/// The first figure that closes a ring of joins, if the parents (`parent[i]`, a figure's parent or none) have one.
fn ring(parent: &[Option<usize>]) -> Option<usize> {
    let mut state = vec![0u8; parent.len()]; // 0 not seen, 1 on the path being walked, 2 known to end
    let mut path = Vec::new();
    for start in 0..parent.len() {
        if state[start] != 0 {
            continue;
        }
        path.clear();
        let mut at = Some(start);
        while let Some(i) = at {
            match state[i] {
                2 => break,
                1 => return Some(i),
                _ => {}
            }
            state[i] = 1;
            path.push(i);
            at = parent[i];
        }
        for &i in &path {
            state[i] = 2;
        }
    }
    None
}

/// Whether every join of `frame` names another figure of the frame, the figure it names is the one its identity says, and no ring closes.
fn resolves(frame: &Value) -> bool {
    let objects = items(frame.get("objects"));
    let parents: Result<Vec<Option<usize>>, ()> = (0..objects.len()).map(|i| parent_of(&objects, i)).collect();
    parents.is_ok_and(|parents| ring(&parents).is_none())
}

/// A join a frame that resolves holds: the parent's identity and the join record.
type Book = HashMap<u64, (f64, Value)>;

fn add_to(book: &mut Book, frame: &Value) {
    let objects = items(frame.get("objects"));
    for (index, object) in objects.iter().enumerate() {
        let Some(uid) = num(object.get("unique_id")) else { continue };
        if let Ok(Some(slot)) = parent_of(&objects, index) {
            if let (Some(parent), Some(join)) = (num(objects[slot].get("unique_id")), object.get("join")) {
                book.entry(key(uid)).or_insert((parent, join.clone()));
            }
        }
    }
}

/// `frame` with the joins of `donor` (the nearest frame that resolves, if any), then of `book`, for the figures whose own joins name no
/// figure of the frame; every other figure keeps its own join or its lack of one. A figure no one can give a join is unjoined, and so is
/// one of a ring.
fn mend(frame: &Value, donor: Option<&Value>, book: &Book) -> Value {
    let objects = items(frame.get("objects"));
    let at: HashMap<u64, usize> = objects.iter().enumerate().filter_map(|(i, o)| Some((key(num(o.get("unique_id"))?), i))).collect();
    let mut donated = Book::new();
    let mut known = std::collections::HashSet::new();
    if let Some(donor) = donor {
        add_to(&mut donated, donor);
        known.extend(items(donor.get("objects")).iter().filter_map(|o| num(o.get("unique_id"))).map(key));
    }
    // For each figure: the join it is to have (the parent's place and the record) or none.
    let mut chosen: Vec<Option<(usize, Value, bool)>> = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        let uid = num(object.get("unique_id"));
        let from = |source: &Book| uid.and_then(|uid| source.get(&key(uid))).and_then(|(parent, join)| at.get(&key(*parent)).filter(|slot| **slot != index).map(|slot| (*slot, join.clone())));
        let pick = match parent_of(&objects, index) {
            // A join that names a figure of the frame, or none (an unjoin), is the frame's own and is kept.
            Ok(parent) => parent.map(|slot| (slot, object.get("join").cloned().unwrap_or(Value::Null), false)),
            Err(()) => {
                if let Some((slot, join)) = from(&donated) {
                    Some((slot, join, true))
                } else if uid.is_some_and(|uid| known.contains(&key(uid))) {
                    None // the donor has the figure and does not join it
                } else {
                    from(book).map(|(slot, join)| (slot, join, true))
                }
            }
        };
        chosen.push(pick);
    }
    let mut parent: Vec<Option<usize>> = chosen.iter().map(|pick| pick.as_ref().map(|(slot, _, _)| *slot)).collect();
    while let Some(closing) = ring(&parent) {
        parent[closing] = None;
        chosen[closing] = None;
    }
    let mended: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(index, object)| match &chosen[index] {
            Some((slot, join, true)) => {
                let mut next = object.clone();
                let mut join = join.clone();
                if let Some(fields) = join.make_obj() {
                    fields.set("target_object_slot", Value::Num(*slot as f64));
                    if let Some(uid) = objects[*slot].get("unique_id") {
                        fields.set("target_unique_id", uid.clone());
                    }
                }
                if let Some(record) = next.make_obj() {
                    record.set("join", join);
                }
                next
            }
            Some((_, _, false)) => object.clone(),
            None => {
                if object.get("join").is_some_and(Value::truthy) {
                    let mut next = object.clone();
                    if let Some(record) = next.make_obj() {
                        record.set("join", Value::Null);
                    }
                    next
                } else {
                    object.clone()
                }
            }
        })
        .collect();
    let mut out = frame.clone();
    if let Some(record) = out.make_obj() {
        record.set("objects", Value::array(mended));
    }
    out
}

/// Mends the keyframes and the retained poses (`_styk.frameSources`) of `report` whose joins do not resolve, and says how many frames it
/// mended. Nothing changes when every frame resolves.
pub(super) fn repair_joins(report: &mut Value) -> usize {
    let keyframes = items(report.get("keyframes"));
    let sources: Vec<(String, Value)> = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).map(|sources| sources.iter().map(|(id, frame)| (id.to_string(), frame.clone())).collect()).unwrap_or_default();
    let sound_keyframes: Vec<bool> = keyframes.iter().map(resolves).collect();
    let sound_sources: Vec<bool> = sources.iter().map(|(_, frame)| resolves(frame)).collect();
    if sound_keyframes.iter().chain(&sound_sources).all(|sound| *sound) {
        return 0;
    }
    let mut book = Book::new();
    for (frame, _) in keyframes.iter().zip(&sound_keyframes).filter(|(_, sound)| **sound) {
        add_to(&mut book, frame);
    }
    for ((_, frame), _) in sources.iter().zip(&sound_sources).filter(|(_, sound)| **sound) {
        add_to(&mut book, frame);
    }
    // The nearest keyframe that resolves, for each keyframe: one sweep each way.
    let n = keyframes.len();
    let mut before = vec![None; n];
    let mut after = vec![None; n];
    let mut last = None;
    for i in 0..n {
        if sound_keyframes[i] { last = Some(i); }
        before[i] = last;
    }
    last = None;
    for i in (0..n).rev() {
        if sound_keyframes[i] { last = Some(i); }
        after[i] = last;
    }
    let mut mended = 0;
    let next_keyframes: Vec<Value> = keyframes
        .iter()
        .enumerate()
        .map(|(i, frame)| {
            if sound_keyframes[i] {
                return frame.clone();
            }
            let donor = match (before[i], after[i]) {
                (Some(a), Some(b)) => Some(if i - a <= b - i { a } else { b }),
                (a, b) => a.or(b),
            };
            mended += 1;
            mend(frame, donor.map(|d| &keyframes[d]), &book)
        })
        .collect();
    let next_sources: Vec<(String, Value)> = sources
        .iter()
        .enumerate()
        .filter(|(i, _)| !sound_sources[*i])
        .map(|(_, (id, frame))| {
            mended += 1;
            (id.clone(), mend(frame, None, &book))
        })
        .collect();
    if next_keyframes.iter().zip(&keyframes).any(|(a, b)| !a.same_node(b)) {
        if let Some(record) = report.make_obj() {
            record.set("keyframes", Value::array(next_keyframes));
        }
    }
    if !next_sources.is_empty() {
        let styk: Option<&mut Obj> = report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj);
        if let Some(table) = styk.and_then(|styk| styk.get_mut("frameSources")).and_then(Value::make_obj) {
            for (id, frame) in next_sources {
                table.set(&id, frame);
            }
        }
    }
    mended
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

    /// A frame of figures 1..=n, each joined to the one before it (the first joined to none), except the joins in `broken`, which name no slot.
    fn chain(n: usize, broken: &[usize]) -> Value {
        let objects: Vec<String> = (0..n)
            .map(|i| {
                let join = if i == 0 { "null".to_string() } else if broken.contains(&i) { r#"{"kind":"a"}"#.to_string() } else { format!(r#"{{"kind":"a","target_object_slot":{},"target_unique_id":{}}}"#, i - 1, i) };
                format!(r#"{{"unique_id":{},"join":{join}}}"#, i + 1)
            })
            .collect();
        json(&format!(r#"{{"objects":[{}]}}"#, objects.join(",")))
    }

    fn parents(frame: &Value) -> Vec<Option<f64>> {
        let objects = items(frame.get("objects"));
        (0..objects.len()).map(|i| parent_of(&objects, i).unwrap().map(|slot| slot as f64)).collect()
    }

    fn report(keyframes: Vec<Value>, sources: Vec<(&str, Value)>) -> Value {
        let mut report = json(r#"{"keyframes":[],"_styk":{"frameSources":{}}}"#);
        report.make_obj().unwrap().set("keyframes", Value::array(keyframes));
        let table = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap();
        for (id, frame) in sources {
            table.set(id, frame);
        }
        report
    }

    fn source(report: &Value, id: &str) -> Value { report.path(&["_styk", "frameSources", id]).unwrap().clone() }

    #[test]
    fn a_retained_pose_with_bad_joins_takes_the_joins_a_frame_that_resolves_holds() {
        let mut report = report(vec![chain(4, &[])], vec![("pose", chain(4, &[2]))]);
        assert_eq!(repair_joins(&mut report), 1);
        assert_eq!(parents(&source(&report, "pose")), parents(&chain(4, &[])));
    }

    #[test]
    fn a_frame_that_nothing_can_say_joins_for_has_its_figures_unjoined() {
        // Every frame of the clip has bad joins: there is no donor, and the last resort is to unjoin rather than refuse the project.
        let mut report = report(vec![chain(3, &[1, 2]), chain(3, &[2])], vec![("pose", chain(3, &[1]))]);
        assert_eq!(repair_joins(&mut report), 3);
        let frames = items(report.get("keyframes"));
        assert!(frames.iter().all(resolves) && resolves(&source(&report, "pose")));
        assert_eq!(parents(&frames[0]), vec![None, None, None], "both joins were bad");
        assert_eq!(parents(&frames[1]), vec![None, Some(0.0), None], "the join that resolved stays");
        assert_eq!(parents(&source(&report, "pose")), vec![None, None, Some(1.0)]);
    }

    #[test]
    fn a_figure_a_frame_unjoins_on_purpose_stays_unjoined_when_another_join_of_the_frame_is_mended() {
        // Frame A joins figure 2 to 1 and 3 to 2. Frame B unjoins 2 on purpose and has a join of 3 that names no figure: only 3's join is
        // taken from A; 2 is not joined to 1 again, which a save would then have written as a change nobody made.
        let unjoined = json(r#"{"objects":[{"unique_id":1,"join":null},{"unique_id":2,"join":null},{"unique_id":3,"join":{"kind":"a","target_object_slot":7}}]}"#);
        let mut report = report(vec![chain(3, &[]), unjoined], vec![]);
        assert_eq!(repair_joins(&mut report), 1);
        let frames = items(report.get("keyframes"));
        assert!(resolves(&frames[1]));
        assert_eq!(parents(&frames[1]), vec![None, None, Some(1.0)], "3 takes A's join; 2 stays unjoined");
    }

    #[test]
    fn a_join_that_names_another_figure_of_the_frame_is_kept_over_the_donors() {
        // B joins 3 to 1 (a valid join A does not have) and has 2's join naming no slot: 3 keeps its own join, 2 takes A's.
        let own = json(r#"{"objects":[{"unique_id":1,"join":null},{"unique_id":2,"join":{"kind":"a"}},{"unique_id":3,"join":{"kind":"a","target_object_slot":0,"target_unique_id":1}}]}"#);
        let mut report = report(vec![chain(3, &[]), own], vec![]);
        assert_eq!(repair_joins(&mut report), 1);
        assert_eq!(parents(&items(report.get("keyframes"))[1]), vec![None, Some(0.0), Some(0.0)]);
    }

    #[test]
    fn a_ring_is_broken_and_a_sound_frame_is_left_alone() {
        let ring_of_two = json(r#"{"objects":[{"unique_id":1,"join":{"target_object_slot":1,"target_unique_id":2}},{"unique_id":2,"join":{"target_object_slot":0,"target_unique_id":1}}]}"#);
        let mut report = report(vec![ring_of_two, chain(2, &[])], vec![]);
        let sound = report.get("keyframes").and_then(Value::elements).unwrap().get(1).unwrap();
        assert_eq!(repair_joins(&mut report), 1);
        let frames = items(report.get("keyframes"));
        assert!(frames.iter().all(resolves));
        assert!(frames[1].same_node(&sound), "the frame that resolved is not rebuilt");
        assert_eq!(repair_joins(&mut report), 0, "a document that resolves is not touched again");
    }

    #[test]
    fn a_long_chain_with_one_bad_join_is_mended_in_linear_time() {
        // 20,000 figures joined one to the next: the walk a ring check takes per figure made this quadratic (85 s against half a second).
        let n = 20_000;
        let mut report = report(vec![chain(n, &[]), chain(n, &[n / 2]), chain(n, &[n - 1])], vec![]);
        let started = std::time::Instant::now();
        assert_eq!(repair_joins(&mut report), 2);
        let took = started.elapsed();
        assert!(items(report.get("keyframes")).iter().all(resolves));
        assert!(took < std::time::Duration::from_secs(5), "mending took {took:?}");
    }
}
