//! Inverse-kinematics controllers of figures joined to a figure whose definition a topology edit
//! changes (`repairJoined`, with the temporary skeleton of
//! `joinedIKGraph`).
//!
//! A chain may run through several joined figures, so a controller names its chain and its
//! followers across the whole assembly. The assembly is compiled twice, from the definitions and
//! poses before the edit and after it, and every controller is carried over: its target handle
//! follows the handle map, its chain starts where the old chain's base joint is now, and the
//! branches that follow it are those of the new skeleton, keeping the angles they had.

use std::collections::{BTreeMap, HashMap, HashSet};

use styk_doc::{Obj, Value};

use super::{Layout, MAX_IK_CHAIN, format_number, given, ik_chain, ik_construction, ik_follower_indices, items, js_number, key_of, layout, numbers};
use crate::EditError;
use crate::record::{join_target, num};

/// A bone of the temporary skeleton: where it came from (`entries`).
struct Entry {
    slot: usize,
    handle: f64,
    uid: f64,
}

/// `joinedIKGraph(report, frame, slots)`: the assembly as one figure, its bones numbered from 1 in
/// the order of the slots and of each figure's segments.
struct Graph {
    segments: Vec<Value>,
    polygons: Vec<Value>,
    /// `graph.object.angles`.
    angles: Vec<f64>,
    entries: Vec<Entry>,
    /// Per object slot: a segment handle of its figure to its bone.
    maps: HashMap<usize, HashMap<u64, usize>>,
    by_uid: HashMap<u64, usize>,
    layout: Layout,
}

impl Graph {
    fn id(&self, slot: usize, handle: f64) -> Option<usize> {
        self.maps.get(&slot)?.get(&key_of(handle)).copied()
    }

    /// `graph.chain(slot, handle, length)`.
    fn chain(&self, slot: usize, handle: f64, length: f64) -> Vec<usize> {
        self.id(slot, handle).map(|id| ik_chain(&self.segments, &self.layout, id as f64, length)).unwrap_or_default()
    }

    fn parent_of(&self, bone: usize) -> f64 {
        given(&self.segments[bone], "parent_id").unwrap_or(f64::NAN)
    }

    /// The followers `graph.mapController(slot, handle, controller)` gives a controller (`ikFollowers`
    /// over the skeleton): by bone, the angles of the branches that follow its target.
    fn followers(&self, slot: usize, id: usize, c: &Value) -> BTreeMap<usize, Value> {
        let mut captured: BTreeMap<usize, Value> = BTreeMap::new();
        let own = self.maps.get(&slot);
        for (child, angle) in c.get("followers").and_then(Value::as_obj).into_iter().flat_map(|table| table.iter()) {
            if let Some(&mapped) = own.and_then(|ids| ids.get(&key_of(js_number(child)))) {
                captured.insert(mapped, angle.clone());
            }
        }
        for (owner, table) in c.get("joinedFollowers").and_then(Value::as_obj).into_iter().flat_map(|table| table.iter()) {
            let Some(ids) = self.by_uid.get(&key_of(js_number(owner))).and_then(|slot| self.maps.get(slot)) else { continue };
            for (child, angle) in table.as_obj().into_iter().flat_map(|children| children.iter()) {
                if let Some(&mapped) = ids.get(&key_of(js_number(child))) {
                    captured.insert(mapped, angle.clone());
                }
            }
        }
        let finite = |bone: usize| captured.get(&(bone + 1)).and_then(Value::as_f64).filter(|angle| angle.is_finite());
        let children = ik_follower_indices(&self.segments, &self.polygons, &self.layout, id as f64);
        let direct = self.layout.children.get(&key_of(id as f64)).cloned().unwrap_or_default();
        let anchor = children.iter().copied().find(|&i| finite(i).is_some()).or_else(|| direct.iter().copied().find(|&i| finite(i).is_some()));
        let rotation = c.path(&["target", "rotation"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let offset = match anchor {
            None => -rotation,
            Some(i) => finite(i).unwrap_or(f64::NAN) - self.angles[i],
        };
        children
            .into_iter()
            .map(|i| (i + 1, captured.get(&(i + 1)).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::Num(self.angles[i] + offset))))
            .collect()
    }
}

/// `joinedIKGraph(report, frame, slots)` on the figure table and the frame's objects. `None` for an
/// assembly with a movieclip or a figure the table lacks; an error where the editor's graph throws.
fn build(figures: &[Value], objects: &[Value], slots: &[usize]) -> Result<Option<Graph>, EditError> {
    let mut definitions: Vec<(usize, &Value)> = Vec::new();
    for &slot in slots {
        let Some(figure) = objects.get(slot).and_then(|object| figures.iter().find(|f| f.get("figure_type_id") == object.get("figure_type_id"))) else { return Ok(None) };
        if figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy) {
            return Ok(None);
        }
        definitions.push((slot, figure));
    }
    let mut segments: Vec<Value> = Vec::new();
    let mut angles = Vec::new();
    let mut entries = Vec::new();
    let mut maps: HashMap<usize, HashMap<u64, usize>> = HashMap::new();
    for &(slot, figure) in &definitions {
        let source = &objects[slot];
        let scale = given(source, "scale").unwrap_or(1.0);
        let mut ids = HashMap::new();
        for (index, s) in items(figure.get("segments")).iter().enumerate() {
            let id = entries.len() + 1;
            let segment_id = given(s, "segment_id").unwrap_or(f64::NAN);
            ids.insert(key_of(segment_id), id);
            entries.push(Entry { slot, handle: segment_id, uid: num(source, "unique_id").unwrap_or(f64::NAN) });
            let mut bone = Obj::new();
            bone.set("segment_id", Value::Num(id as f64));
            bone.set("parent_id", Value::Num(0.0));
            bone.set("length", Value::Num(given(s, "length").unwrap_or(f64::NAN) * scale));
            bone.set("angle_rad", Value::Num(given(s, "angle_rad").unwrap_or(f64::NAN)));
            bone.set("is_static", Value::Bool(ik_construction(s)));
            if let Some(rig) = s.get("_stykRig").filter(|rig| rig.truthy()) {
                bone.set("_stykRig", rig.clone());
            }
            segments.push(Value::object(bone));
            let runtime = source.get("runtime_segments").and_then(|r| r.item(index));
            let authored = source.get("angles").and_then(|a| a.item(index)).filter(|v| !v.is_null()).and_then(|v| v.as_f64());
            angles.push(authored.or_else(|| runtime.and_then(|r| given(&r, "angle_rad"))).or_else(|| given(s, "angle_rad")).unwrap_or(0.0));
        }
        maps.insert(slot, ids);
    }
    // `rootId(slot)`: the bone an object hangs from (0 for the root of the assembly).
    let mut roots: HashMap<usize, usize> = HashMap::new();
    fn root_id(objects: &[Value], maps: &HashMap<usize, HashMap<u64, usize>>, roots: &mut HashMap<usize, usize>, slot: usize, seen: &mut Vec<usize>) -> Result<usize, EditError> {
        if let Some(&id) = roots.get(&slot) {
            return Ok(id);
        }
        if seen.contains(&slot) {
            return Err(EditError::Invalid("errors.editorSelection.figuresContainACyclicJoin".into()));
        }
        seen.push(slot);
        let join = objects.get(slot).and_then(|object| object.get("join")).filter(|join| join.truthy());
        let missing = || EditError::Invalid("errors.ikJoined.ikJoinTargetIsMissing".into());
        let id = match join {
            None => 0,
            Some(join) => {
                let target = join_target(&objects[slot]).ok_or_else(missing)?;
                match join.get("target_handle_id").filter(|h| h.truthy()) {
                    Some(h) => maps.get(&target).and_then(|ids| ids.get(&key_of(h.as_f64().unwrap_or(f64::NAN)))).copied().ok_or_else(missing)?,
                    None => root_id(objects, maps, roots, target, seen)?,
                }
            }
        };
        roots.insert(slot, id);
        Ok(id)
    }
    let mut polygons = Vec::new();
    for &(slot, figure) in &definitions {
        let root = root_id(objects, &maps, &mut roots, slot, &mut Vec::new())?;
        let ids = &maps[&slot];
        for s in items(figure.get("segments")) {
            let own = ids[&key_of(given(&s, "segment_id").unwrap_or(f64::NAN))];
            let parent = given(&s, "parent_id").filter(|p| *p != 0.0 && !p.is_nan()).map_or(root, |p| ids.get(&key_of(p)).copied().unwrap_or(root));
            if let Some(bone) = segments[own - 1].make_obj() {
                bone.set("parent_id", Value::Num(parent as f64));
            }
        }
        for polygon in items(figure.get("polyfills")) {
            let joints: Vec<f64> = numbers(polygon.get("segment_ids")).into_iter().map(|id| if id != 0.0 && !id.is_nan() { ids.get(&key_of(id)).map_or(f64::NAN, |&bone| bone as f64) } else { root as f64 }).collect();
            let mut record = Obj::new();
            record.set("segment_ids", Value::nums(&joints));
            polygons.push(Value::object(record));
        }
    }
    let by_uid = definitions.iter().map(|&(slot, _)| (key_of(num(&objects[slot], "unique_id").unwrap_or(f64::NAN)), slot)).collect();
    let layout = layout(&segments);
    Ok(Some(Graph { segments, polygons, angles, entries, maps, by_uid, layout }))
}

/// The `_stykIK` table every object of the assemblies that hold the edited figure takes (`None`: no
/// controller left), by slot of `place`'s frame in the order of the assemblies.
pub(super) fn repair(
    figures: &[Value],
    old_figures: &[Value],
    objects: &[Value],
    old_objects: &[Value],
    type_id: &Value,
    explicit: &HashMap<u64, &Vec<f64>>,
) -> Result<Vec<(usize, Option<Value>)>, EditError> {
    let mut repaired = Vec::new();
    if !objects.iter().any(|o| o.get("join").is_some_and(Value::truthy)) {
        return Ok(repaired);
    }
    let joins: Vec<Option<usize>> = objects.iter().map(join_target).collect();
    for slots in styk_eval::ik::joined::components_of(&joins) {
        if slots.len() < 2 || !slots.iter().any(|&s| objects[s].get("figure_type_id") == Some(type_id)) || !slots.iter().any(|&s| objects[s].get("_stykIK").is_some_and(Value::truthy)) {
            continue;
        }
        let Some(old) = build(old_figures, old_objects, &slots)? else { continue };
        let Some(next) = build(figures, objects, &slots)? else { continue };
        let remap = |slot: usize, id: f64| -> Vec<f64> {
            if objects[slot].get("figure_type_id") == Some(type_id) { explicit.get(&key_of(id)).map(|list| (*list).clone()).unwrap_or_else(|| vec![id]) } else { vec![id] }
        };
        for &slot in &slots {
            let mut table = Obj::new();
            let controllers: Vec<(String, Value)> = old_objects[slot].get("_stykIK").and_then(Value::as_obj).map(|t| t.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
            for (key, c) in controllers {
                let id = js_number(&key);
                let replacements = remap(slot, id);
                let Some(target) = replacements.iter().copied().find(|&h| h == id && next.id(slot, h).is_some()).or_else(|| replacements.last().copied()) else { continue };
                let Some(virtual_id) = next.id(slot, target) else { continue };
                let chain_length = c.get("chainLength").map_or(f64::NAN, |v| v.as_f64().unwrap_or(f64::NAN));
                let chain = old.chain(slot, id, chain_length);
                let parent = chain.first().map(|&bone| old.parent_of(bone));
                let anchor = parent.filter(|p| *p != 0.0 && !p.is_nan()).and_then(|p| old.entries.get(p as usize - 1));
                let base = match anchor {
                    Some(anchor) => remap(anchor.slot, anchor.handle).last().and_then(|&h| next.id(anchor.slot, h)).map(|bone| bone as f64),
                    None => Some(0.0),
                };
                let full = next.chain(slot, target, MAX_IK_CHAIN);
                let start = full.iter().position(|&bone| base.is_some_and(|base| next.parent_of(bone) == base));
                let children = ik_follower_indices(&next.segments, &next.polygons, &next.layout, virtual_id as f64);
                let child_set: HashSet<usize> = children.iter().copied().collect();
                let rotation = c.path(&["target", "rotation"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
                let mut candidates: HashMap<usize, Value> = HashMap::new();
                if let Some(owner) = old.id(slot, id) {
                    for (child, angle) in old.followers(slot, owner, &c) {
                        let prior = &old.entries[child - 1];
                        for h in remap(prior.slot, prior.handle) {
                            if let Some(mapped) = next.id(prior.slot, h).filter(|mapped| child_set.contains(&(mapped - 1))) {
                                candidates.insert(mapped, if h == prior.handle { angle.clone() } else { Value::Num(next.angles[mapped - 1] - rotation) });
                            }
                        }
                    }
                }
                let mut followers = Obj::new();
                let mut joined: Obj = Obj::new();
                for &bone in &children {
                    let child = &next.entries[bone];
                    let angle = candidates.get(&(bone + 1)).cloned().unwrap_or_else(|| Value::Num(next.angles[bone] - rotation));
                    if child.slot == slot {
                        followers.set(&format_number(child.handle), angle);
                    } else {
                        let owner = format_number(child.uid);
                        let mut table = joined.get(&owner).and_then(Value::as_obj).cloned().unwrap_or_default();
                        table.set(&format_number(child.handle), angle);
                        joined.set(&owner, Value::object(table));
                    }
                }
                let length = match start {
                    None => if chain_length.is_nan() { f64::NAN } else { chain_length.min(full.len() as f64) },
                    Some(start) => (full.len() - start) as f64,
                };
                let mut controller = c.as_obj().cloned().unwrap_or_default();
                controller.set("chainLength", Value::Num(length));
                controller.set("followers", Value::object(followers));
                controller.set("joinedFollowers", Value::object(joined));
                table.set(&format_number(target), Value::object(controller));
            }
            repaired.push((slot, (!table.is_empty()).then(|| Value::object(table))));
        }
    }
    Ok(repaired)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    fn segments(list: &[(u32, u32)]) -> Value {
        Value::array(list.iter().map(|&(id, parent)| parse(&format!(r#"{{"segment_id":{id},"parent_id":{parent},"length":50,"angle_rad":0}}"#))).collect())
    }

    fn figure(id: u32, list: &[(u32, u32)]) -> Value {
        let mut figure = parse(&format!(r#"{{"figure_type_id":{id}}}"#));
        figure.make_obj().unwrap().set("segments", segments(list));
        figure
    }

    /// A figure of two segments and the figure of three hanging from its end, with a controller on the second one's middle joint.
    fn objects(chain: u32) -> Vec<Value> {
        let parent = parse(r#"{"unique_id":1,"figure_type_id":1,"object_slot":0,"angles":[0,0]}"#);
        let child = parse(&format!(
            r#"{{"unique_id":2,"figure_type_id":2,"object_slot":1,"angles":[0,0,0.7],"join":{{"target_object_slot":0,"target_unique_id":1,"target_handle_id":2}},
                "_stykIK":{{"12":{{"enabled":true,"pinned":true,"chainLength":{chain},"target":{{"x":0,"y":0,"rotation":0.5}},"followers":{{}},"joinedFollowers":{{}}}}}}}}"#
        ));
        vec![parent, child]
    }

    /// The parent edited as `after` lists it, `explicit` being what the edit says became of handle 2.
    fn edit(after: &[(u32, u32)], explicit: Option<Vec<f64>>, chain: u32) -> Vec<(usize, Option<Value>)> {
        let before = [figure(1, &[(1, 0), (2, 1)]), figure(2, &[(11, 0), (12, 11), (13, 12)])];
        let after = [figure(1, after), before[1].clone()];
        let map: HashMap<u64, &Vec<f64>> = explicit.iter().map(|list| (key_of(2.0), list)).collect();
        let objects = objects(chain);
        repair(&after, &before, &objects, &objects, &Value::Num(1.0), &map).unwrap()
    }

    fn controller(repaired: &[(usize, Option<Value>)]) -> Value {
        let (slot, table) = &repaired[1];
        assert_eq!(*slot, 1);
        table.as_ref().unwrap().get("12").unwrap().clone()
    }

    #[test]
    fn a_limb_ending_inside_a_joined_figure_keeps_its_length_and_its_followers() {
        // A segment drawn from the parent's last one changes nothing of the limb.
        let repaired = edit(&[(1, 0), (2, 1), (4, 2)], None, 2);
        assert!(repaired[0].1.is_none(), "the parent holds no controller");
        let c = controller(&repaired);
        assert_eq!(c.get("chainLength").and_then(Value::as_f64), Some(2.0));
        // The branch below the controlled joint keeps the angle it had relative to the target's turn.
        assert_eq!(c.path(&["followers", "13"]).and_then(Value::as_f64), Some(0.7 - 0.5));
        assert_eq!(c.get("joinedFollowers").and_then(Value::as_obj).map(|o| o.len()), Some(0));
        assert_eq!(c.path(&["target", "rotation"]).and_then(Value::as_f64), Some(0.5), "the rest of the controller is carried over");
    }

    #[test]
    fn a_limb_reaching_into_the_split_figure_gains_the_new_piece() {
        // Split, handle 2 is [2, 3] with 3 hanging from 1: a limb starting at the joint of 1 now starts at the new piece.
        let c = controller(&edit(&[(1, 0), (3, 1), (2, 3)], Some(vec![2.0, 3.0]), 3));
        assert_eq!(c.get("chainLength").and_then(Value::as_f64), Some(4.0));
    }

    #[test]
    fn a_limb_starting_at_a_split_segment_starts_from_the_piece_the_map_names_last() {
        let c = controller(&edit(&[(1, 0), (3, 1), (2, 3)], Some(vec![2.0, 3.0]), 2));
        assert_eq!(c.get("chainLength").and_then(Value::as_f64), Some(3.0));
    }

    #[test]
    fn figures_that_are_not_joined_have_nothing_to_carry() {
        let before = [figure(1, &[(1, 0), (2, 1)]), figure(2, &[(11, 0), (12, 11)])];
        let mut objects = objects(2);
        objects[1].make_obj().unwrap().set("join", Value::Null);
        let map = HashMap::new();
        assert!(repair(&before, &before, &objects, &objects, &Value::Num(1.0), &map).unwrap().is_empty());
    }
}
