//! Document patches: what a call changed in the report, as a short list of operations
//! the JavaScript read view applies (D19, docs/engine/editing.md "Phase 3").
//!
//! The store is copy-on-write: a call replaces the containers on the paths to what it
//! changed and shares everything else. [`diff`] therefore walks only into nodes that
//! differ by identity, and its cost follows the size of the change, not of the document.
//!
//! Operations (JSON objects), applied in order with JavaScript's own assignment rules
//! (integer-like keys first, the rest in insertion order: the store keeps the same order):
//!
//! - `{"p": path, "v": value}`: set the value at `path` (a new key is appended);
//! - `{"p": path, "x": 1}`: delete the key at `path`;
//! - `{"p": path, "a": [ref, …]}`: rebuild the array at `path`; a ref is the index of an
//!   element of the array before (kept as it was) or `{"v": value}`;
//! - `{"p": path, "o": [[key], [key, value], …]}`: rebuild the object at `path` in this
//!   key order; `[key]` keeps the value the key had before.
//!
//! A path is a list of object keys (strings) and array indices (numbers). The root is
//! never replaced: an empty path only appears in an `o` operation.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Shape, Value};

/// The operations that turn `before` into `after` (both report roots).
pub fn diff(before: &Value, after: &Value) -> Value {
    let mut ops = Vec::new();
    let mut path = Vec::new();
    walk(before, after, &mut path, &mut ops);
    Value::array(ops)
}

/// The records of its lazy tables the read view holds (`keyframes`: indices into the table), as the call's view names them
/// (`lazy`). A table that is not named is held whole.
pub type Known = HashMap<String, std::collections::HashSet<usize>>;

/// The records the read view has fetched, from the view of a call (`{"lazy": {"keyframes": [3, 4]}}`), or `None` when it holds no lazy table.
pub fn known(view: &Value) -> Option<Known> {
    let lazy = view.get("lazy")?.as_obj()?;
    Some(lazy.iter().map(|(table, indices)| (table.to_string(), indices.elements().map(|list| list.iter().filter_map(|index| index.as_f64()).map(|index| index as usize).collect()).unwrap_or_default())).collect())
}

/// `ops` with every change inside a record of a lazy table that the view has not fetched replaced by the record whole, taken from
/// `after`: the view cannot apply a change to a record it does not hold, and the record it fetches later is the session's. A
/// change inside a record the view holds, and the rebuilds of the table itself, are kept as they are.
pub fn collapse_unfetched(ops: Value, after: &Value, known: &Known) -> Value {
    let Some(list) = ops.as_arr() else { return ops };
    let enters_unfetched = |op: &Value| -> Option<(Arc<str>, usize)> {
        let path: Vec<Value> = op.get("p")?.elements()?.iter().collect();
        if path.len() < 3 { return None; }
        let (Value::Str(table), Value::Num(index)) = (&path[0], &path[1]) else { return None };
        let held = known.get(&**table)?;
        (!held.contains(&(*index as usize))).then(|| (table.clone(), *index as usize))
    };
    if !list.iter().any(|op| enters_unfetched(op).is_some()) { return ops; }
    let mut done = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for change in list.iter() {
        let Some((table, index)) = enters_unfetched(change) else { out.push(change.clone()); continue };
        if !done.insert((table.clone(), index)) { continue; }
        match after.get(&table).and_then(Value::elements).and_then(|records| records.get(index)) {
            Some(record) => out.push(op(&[Value::Str(table), Value::Num(index as f64)], "v", record)),
            None => out.push(change.clone()),
        }
    }
    Value::array(out)
}

/// How the figure counts of the poses changed between `before` and `after`: `[[uid, delta], …]` over the keyframes and the retained
/// pose sources, the poses that left counted down and those that joined counted up. Poses are told apart by node, as the patch's
/// array rebuilds are; the cost follows the poses that changed, not the document.
pub fn layer_delta(before: &Value, after: &Value) -> Value {
    // In the order the poses are met (the ones that left first), so the figures come out in the order the view counted them.
    let mut poses: Vec<(Value, i64)> = Vec::new();
    let mut at: HashMap<usize, usize> = HashMap::new();
    let tables = |root: &Value| -> (Option<Value>, Option<Value>) { (root.get("keyframes").cloned(), root.path(&["_styk", "frameSources"]).cloned()) };
    let (old, new) = (tables(before), tables(after));
    let same = |a: &Option<Value>, b: &Option<Value>| match (a, b) { (Some(a), Some(b)) => a.same_node(b), (None, None) => true, _ => false };
    let mut count = |table: &Option<Value>, sign: i64| {
        let records: Vec<Value> = match table {
            Some(Value::Obj(object)) => object.values().to_vec(),
            Some(other) => other.elements().map(|items| items.iter().collect()).unwrap_or_default(),
            None => Vec::new(),
        };
        for record in records {
            if let Some(address) = node_address(&record) {
                let slot = *at.entry(address).or_insert_with(|| { poses.push((record.clone(), 0)); poses.len() - 1 });
                poses[slot].1 += sign;
            }
        }
    };
    for (a, b) in [(&old.0, &new.0), (&old.1, &new.1)] {
        if same(a, b) { continue; }
        count(a, -1);
        count(b, 1);
    }
    let mut deltas: Vec<(f64, i64)> = Vec::new();
    for (record, net) in poses.iter().filter(|(_, net)| *net != 0) {
        for object in record.get("objects").and_then(Value::elements).map(|items| items.iter().collect::<Vec<_>>()).unwrap_or_default() {
            let Some(uid) = object.get("unique_id").and_then(Value::as_f64) else { continue };
            match deltas.iter_mut().find(|(seen, _)| *seen == uid) {
                Some((_, amount)) => *amount += net,
                None => deltas.push((uid, *net)),
            }
        }
    }
    Value::array(deltas.into_iter().filter(|(_, amount)| *amount != 0).map(|(uid, amount)| Value::array(vec![Value::Num(uid), Value::Num(amount as f64)])).collect())
}

/// `ops` as the read view receives them: the payloads they would carry (the pictures and originals a file lifts
/// out of its skeleton) are named by token (`S2P:<token>`, `styk_doc::payload`) for the view to ask for when
/// something reads them, and a string that looks like a marker is escaped (`S2E:` before it). Everything else
/// is as it was. The flag says whether any was named, for the interface to look for them.
pub fn for_view(ops: Value) -> (Value, bool) {
    let Some(list) = ops.as_arr() else { return (ops, false) };
    let mut changed = false;
    let list: Vec<Value> = list.iter().map(|op| match view_op(op) {
        Some(op) => { changed = true; op }
        None => op.clone(),
    }).collect();
    if changed { (Value::array(list), true) } else { (ops, false) }
}

fn view_op(op: &Value) -> Option<Value> {
    let object = op.as_obj()?;
    let key = object.get("p").and_then(Value::as_arr).and_then(|path| path.last()).and_then(Value::as_str).unwrap_or("");
    let mut values: Vec<Value> = object.values().to_vec();
    let mut changed = false;
    for (name, slot) in object.keys().zip(values.iter_mut()) {
        let replaced = match &**name {
            "v" => view_value(slot, key),
            // The elements of a rebuilt array: a kept index or `{v}`.
            "a" => slot.as_arr().and_then(|refs| rewrite(refs, |item| item.get("v").and_then(|value| view_value(value, "")).map(|value| keyed("v", value)))),
            // The entries of a rebuilt object: `[key]` or `[key, value]`.
            "o" => slot.as_arr().and_then(|entries| rewrite(entries, |entry| {
                let entry = entry.as_arr()?;
                let value = view_value(entry.get(1)?, entry[0].as_str()?)?;
                Some(Value::array(vec![entry[0].clone(), value]))
            })),
            _ => None,
        };
        if let Some(replaced) = replaced { *slot = replaced; changed = true; }
    }
    changed.then(|| Value::object(Obj::from_shape(object.shape().clone(), values)))
}

fn keyed(key: &str, value: Value) -> Value {
    Value::object(Obj::from_shape(Shape::new(vec![Arc::from(key)]), vec![value]))
}

/// `items` with `change` applied to each element, or `None` when it changed none.
fn rewrite(items: &[Value], change: impl Fn(&Value) -> Option<Value>) -> Option<Value> {
    let mut changed = false;
    let items: Vec<Value> = items.iter().map(|item| match change(item) {
        Some(item) => { changed = true; item }
        None => item.clone(),
    }).collect();
    changed.then(|| Value::array(items))
}

/// `value` held under `key` as the view receives it, or `None` when that is the value itself.
fn view_value(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Blob(blob) if styk_doc::payload::lifts(blob, key) => Some(Value::str(&format!("{}{}", styk_doc::payload::MARKER, styk_doc::payload::register(blob)))),
        Value::Str(text) if text.starts_with("S2P:") || text.starts_with("S2E:") => Some(Value::str(&format!("S2E:{text}"))),
        Value::Arr(items) => rewrite(items, |item| view_value(item, "")),
        Value::Obj(object) => {
            let mut values: Vec<Value> = object.values().to_vec();
            let mut changed = false;
            for (name, slot) in object.keys().zip(values.iter_mut()) {
                if let Some(replaced) = view_value(slot, name) { *slot = replaced; changed = true; }
            }
            changed.then(|| Value::object(Obj::from_shape(object.shape().clone(), values)))
        }
        _ => None,
    }
}

fn path_value(path: &[Value]) -> Value {
    Value::array(path.to_vec())
}

fn op(path: &[Value], key: &str, value: Value) -> Value {
    let keys: Vec<Arc<str>> = vec![Arc::from("p"), Arc::from(key)];
    Value::object(Obj::from_shape(Shape::new(keys), vec![path_value(path), value]))
}

/// Whether two leaves need no operation: the same node, or equal scalars.
fn unchanged(before: &Value, after: &Value) -> bool {
    if before.same_node(after) { return true; }
    match (before, after) {
        // Bits, not `==`: 0 and -0 print alike but are different values.
        (Value::Num(a), Value::Num(b)) => a.to_bits() == b.to_bits(),
        (Value::Str(a), Value::Str(b)) => a == b,
        _ => false,
    }
}

fn walk(before: &Value, after: &Value, path: &mut Vec<Value>, ops: &mut Vec<Value>) {
    if unchanged(before, after) { return; }
    match (before, after) {
        (Value::Obj(old), Value::Obj(new)) => object(old, new, path, ops),
        (Value::Arr(old), Value::Arr(new)) => array(old, new, path, ops),
        _ => ops.push(op(path, "v", after.clone())),
    }
}

/// The key order `delete` of the removed keys and assignment of the new ones produces:
/// JavaScript enumerates integer-like keys first, ascending, then the others in insertion
/// order (kept keys in their old order, then the new ones).
fn assigned_order(old: &Obj, new: &Obj) -> Vec<Arc<str>> {
    let kept = old.keys().filter(|key| new.contains(key));
    let added = new.keys().filter(|key| !old.contains(key));
    let (mut integers, others): (Vec<Arc<str>>, Vec<Arc<str>>) = kept.chain(added).cloned().partition(|key| styk_doc::index_key(key).is_some());
    integers.sort_by_key(|key| styk_doc::index_key(key));
    integers.extend(others);
    integers
}

fn object(old: &Obj, new: &Obj, path: &mut Vec<Value>, ops: &mut Vec<Value>) {
    let same_keys = old.len() == new.len() && old.keys().zip(new.keys()).all(|(a, b)| a == b);
    if same_keys {
        for ((key, a), b) in old.iter().zip(new.values()) {
            if unchanged(a, b) { continue; }
            path.push(Value::Str(key.clone()));
            walk(a, b, path, ops);
            path.pop();
        }
        return;
    }
    let order = assigned_order(old, new);
    if order.len() == new.len() && order.iter().zip(new.keys()).all(|(a, b)| a == b) {
        for (key, _) in old.iter() {
            if !new.contains(key) {
                path.push(Value::Str(key.clone()));
                ops.push(op(path, "x", Value::Num(1.0)));
                path.pop();
            }
        }
        for (key, b) in new.iter() {
            path.push(Value::Str(key.clone()));
            match old.get(key) {
                Some(a) => walk(a, b, path, ops),
                None => ops.push(op(path, "v", b.clone())),
            }
            path.pop();
        }
        return;
    }
    // Another order: rebuild, keeping what did not change.
    let refs = new.iter().map(|(key, b)| match old.get(key) {
        Some(a) if a.same_node(b) => Value::array(vec![Value::Str(key.clone())]),
        _ => Value::array(vec![Value::Str(key.clone()), b.clone()]),
    }).collect();
    ops.push(op(path, "o", Value::array(refs)));
}

fn array(old: &Arc<Vec<Value>>, new: &Arc<Vec<Value>>, path: &mut Vec<Value>, ops: &mut Vec<Value>) {
    let mut positions: Option<HashMap<usize, usize>> = None;
    let positions_of = |positions: &mut Option<HashMap<usize, usize>>| -> HashMap<usize, usize> {
        positions.take().unwrap_or_else(|| {
            let mut map = HashMap::with_capacity(old.len());
            for (index, value) in old.iter().enumerate() {
                if let Some(address) = node_address(value) { map.entry(address).or_insert(index); }
            }
            map
        })
    };
    if old.len() == new.len() {
        let changed: Vec<usize> = (0..old.len()).filter(|&index| !unchanged(&old[index], &new[index])).collect();
        if changed.is_empty() { return; }
        // An element that moved (it is still in the array, elsewhere): rebuild instead of
        // comparing the elements that now share its position.
        let map = positions_of(&mut positions);
        let moved = changed.iter().any(|&index| node_address(&new[index]).is_some_and(|address| map.contains_key(&address)));
        if !moved {
            for index in changed {
                path.push(Value::Num(index as f64));
                walk(&old[index], &new[index], path, ops);
                path.pop();
            }
            return;
        }
        positions = Some(map);
    }
    // Inserted, removed or moved elements: keep every element that is still the same node.
    let positions = positions_of(&mut positions);
    let refs = new.iter().enumerate().map(|(index, value)| {
        let kept = node_address(value).and_then(|address| positions.get(&address).copied())
            .or_else(|| old.get(index).filter(|old| unchanged(old, value)).map(|_| index));
        match kept {
            Some(at) => Value::Num(at as f64),
            None => Value::object(Obj::from_shape(Shape::new(vec![Arc::from("v")]), vec![value.clone()])),
        }
    }).collect();
    ops.push(op(path, "a", Value::array(refs)));
}

/// The identity of a shared container, for finding kept elements.
fn node_address(value: &Value) -> Option<usize> {
    match value {
        Value::Arr(a) => Some(Arc::as_ptr(a) as *const () as usize),
        Value::Nums(n) => Some(Arc::as_ptr(n) as *const () as usize),
        Value::Obj(o) => Some(Arc::as_ptr(o) as *const () as usize),
        Value::Blob(b) => Some(Arc::as_ptr(b) as *const () as usize),
        _ => None,
    }
}

/// Applies `ops` to `root` copy-on-write, as the JavaScript read view does.
pub fn apply(root: &Value, ops: &Value) -> Result<Value, String> {
    let mut root = root.clone();
    for op in ops.elements().ok_or("a patch is a list")?.iter() {
        let path: Vec<Value> = op.get("p").and_then(Value::elements).ok_or("an operation without a path")?.iter().collect();
        apply_one(&mut root, &path, &op)?;
    }
    Ok(root)
}

fn apply_one(node: &mut Value, path: &[Value], op: &Value) -> Result<(), String> {
    if path.is_empty() {
        let before = node.clone();
        *node = rebuild(&before, op)?;
        return Ok(());
    }
    let last = path.len() == 1;
    match &path[0] {
        Value::Str(key) => {
            let object = node.make_obj().ok_or_else(|| format!("{key}: not an object"))?;
            if last {
                if op.get("x").is_some() { object.remove(key); return Ok(()); }
                if let Some(value) = op.get("v") { object.set(key, value.clone()); return Ok(()); }
                let before = object.get(key).cloned().ok_or_else(|| format!("{key}: nothing to rebuild"))?;
                object.set(key, rebuild(&before, op)?);
                return Ok(());
            }
            let child = object.get_mut(key).ok_or_else(|| format!("{key}: missing"))?;
            apply_one(child, &path[1..], op)
        }
        Value::Num(index) => {
            let index = *index as usize;
            // Packed number arrays are leaves: they change whole.
            let items = node.make_arr().ok_or_else(|| format!("{index}: not an array"))?;
            let child = items.get_mut(index).ok_or_else(|| format!("{index}: out of range"))?;
            if last {
                if let Some(value) = op.get("v") { *child = value.clone(); return Ok(()); }
                let before = child.clone();
                *child = rebuild(&before, op)?;
                return Ok(());
            }
            apply_one(child, &path[1..], op)
        }
        _ => Err("a path step that is neither a key nor an index".into()),
    }
}

fn rebuild(before: &Value, op: &Value) -> Result<Value, String> {
    if let Some(refs) = op.get("a") {
        let old: Vec<Value> = before.elements().ok_or("rebuilding an array that is not one")?.iter().collect();
        let items = refs.elements().ok_or("array refs")?.iter().map(|item| match item.as_f64() {
            Some(at) => old.get(at as usize).cloned().ok_or_else(|| "an array ref out of range".to_string()),
            None => item.get("v").cloned().ok_or_else(|| "an array ref without a value".to_string()),
        }).collect::<Result<Vec<_>, _>>()?;
        return Ok(Value::array(items));
    }
    if let Some(refs) = op.get("o") {
        let old = before.as_obj().ok_or("rebuilding an object that is not one")?;
        let mut object = Obj::new();
        for item in refs.elements().ok_or("object refs")?.iter() {
            let key = item.item(0).and_then(|key| key.as_str().map(str::to_string)).ok_or("an object ref without a key")?;
            let value = match item.item(1) {
                Some(value) => value,
                None => old.get(&key).cloned().ok_or("an object ref to a missing key")?,
            };
            object.set(&key, value);
        }
        return Ok(Value::object(object));
    }
    Err("an operation that is neither set, delete nor rebuild".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }
    fn text(value: &Value) -> String { styk_doc::json::to_string(value) }

    fn roundtrip(before: &str, edit: impl Fn(&mut Value)) -> Value {
        let before = parse(before);
        let mut after = before.clone();
        edit(&mut after);
        let ops = diff(&before, &after);
        assert_eq!(text(&apply(&before, &ops).unwrap()), text(&after));
        ops
    }

    #[test]
    fn unchanged_documents_need_no_operation() {
        let ops = roundtrip(r#"{"a":[1,2],"b":{"c":"d"}}"#, |_| {});
        assert_eq!(text(&ops), "[]");
    }

    #[test]
    fn a_changed_leaf_is_one_set() {
        let ops = roundtrip(r#"{"a":[{"x":1},{"x":2}],"b":{"c":"d"}}"#, |doc| {
            let a = doc.make_obj().unwrap().get_mut("a").unwrap();
            a.make_arr().unwrap()[1].make_obj().unwrap().set("x", Value::Num(3.0));
        });
        assert_eq!(text(&ops), r#"[{"p":["a",1,"x"],"v":3}]"#);
    }

    #[test]
    fn added_and_removed_keys_follow_javascript_order() {
        roundtrip(r#"{"b":1,"a":2,"2":3}"#, |doc| {
            let o = doc.make_obj().unwrap();
            o.remove("b"); o.set("1", Value::Num(4.0)); o.set("z", Value::Num(5.0));
        });
    }

    #[test]
    fn inserted_elements_keep_the_others() {
        let ops = roundtrip(r#"{"k":[{"i":0},{"i":1},{"i":2}]}"#, |doc| {
            let k = doc.make_obj().unwrap().get_mut("k").unwrap().make_arr().unwrap();
            k.insert(1, parse(r#"{"i":9}"#)); k.remove(3);
        });
        assert_eq!(text(&ops), r#"[{"p":["k"],"a":[0,{"v":{"i":9}},1]}]"#);
    }

    #[test]
    fn reordered_keys_rebuild_the_object() {
        roundtrip(r#"{"o":{"a":1,"b":{"deep":true},"c":3}}"#, |doc| {
            let o = doc.make_obj().unwrap().get_mut("o").unwrap();
            let old = o.as_obj().unwrap().clone();
            let mut rebuilt = Obj::new();
            for key in ["c", "b", "a"] { rebuilt.set(key, old.get(key).unwrap().clone()); }
            *o = Value::object(rebuilt);
        });
    }

    fn edit_records(before: &Value, changes: &[(usize, &str, f64)]) -> Value {
        let mut after = before.clone();
        let table = after.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap();
        for (index, key, value) in changes { table[*index].make_obj().unwrap().set(key, Value::Num(*value)); }
        after
    }

    #[test]
    fn a_change_inside_a_record_the_view_lacks_comes_as_the_record_whole() {
        let before = parse(r#"{"keyframes":[{"d":1,"objects":[{"unique_id":1}]},{"d":2,"objects":[{"unique_id":2}]},{"d":3,"objects":[{"unique_id":3}]}],"x":1}"#);
        let after = edit_records(&before, &[(0, "d", 5.0), (0, "e", 6.0), (2, "d", 7.0)]);
        let ops = diff(&before, &after);
        assert_eq!(ops.elements().unwrap().len(), 3, "{}", text(&ops));
        let known: Known = [("keyframes".to_string(), [0usize].into_iter().collect())].into_iter().collect();
        let collapsed = collapse_unfetched(ops.clone(), &after, &known);
        let list = text(&collapsed);
        assert!(list.contains(r#"{"p":["keyframes",0,"d"],"v":5}"#) && list.contains(r#"{"p":["keyframes",0,"e"],"v":6}"#), "the record the view holds keeps its changes: {list}");
        assert!(list.contains(r#"{"p":["keyframes",2],"v":{"d":7,"objects":[{"unique_id":3}]}}"#), "the record it lacks comes whole: {list}");
        assert!(!list.contains(r#"["keyframes",2,"d"]"#));
        // Whatever the view holds, the patch still turns the document before into the one after.
        assert_eq!(text(&apply(&before, &collapsed).unwrap()), text(&after));
        // A view that holds nothing of the table gets every changed record whole, once each.
        let none: Known = [("keyframes".to_string(), Default::default())].into_iter().collect();
        assert_eq!(collapse_unfetched(ops.clone(), &after, &none).elements().unwrap().len(), 2);
        // A table the view holds whole, and a rebuild of the table, are left alone.
        let other: Known = [("other".to_string(), Default::default())].into_iter().collect();
        assert_eq!(text(&collapse_unfetched(ops.clone(), &after, &other)), text(&ops));
    }

    #[test]
    fn the_figures_poses_gained_and_lost_are_counted_over_keyframes_and_sources() {
        let before = parse(r#"{"keyframes":[{"objects":[{"unique_id":1},{"unique_id":2}]},{"objects":[{"unique_id":1}]}],"_styk":{"frameSources":{"a":{"objects":[{"unique_id":2}]}}}}"#);
        let mut after = before.clone();
        {
            let root = after.make_obj().unwrap();
            let keyframes = root.get_mut("keyframes").unwrap().make_arr().unwrap();
            // The second pose loses figure 1 and gains figure 3; a new pose holds figures 1 and 3.
            keyframes[1] = parse(r#"{"objects":[{"unique_id":3}]}"#);
            keyframes.push(parse(r#"{"objects":[{"unique_id":1},{"unique_id":3}]}"#));
            let sources = root.get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap();
            sources.remove("a");
        }
        let delta = text(&layer_delta(&before, &after));
        // Left: pose 1 (figure 1) and the source (figure 2); joined: figure 3, then the new pose (figures 1 and 3).
        assert_eq!(delta, "[[3,2],[2,-1]]", "figure 1 lost one pose and gained one");
        assert_eq!(text(&layer_delta(&before, &before)), "[]");
    }

    #[test]
    fn negative_zero_is_a_change() {
        let ops = roundtrip(r#"{"a":0}"#, |doc| { doc.make_obj().unwrap().set("a", Value::Num(-0.0)); });
        assert_eq!(ops.elements().unwrap().len(), 1);
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;
    use styk_doc::{Blob, payload};

    fn picture(prefix: &str) -> Value {
        Value::Blob(Arc::new(Blob { prefix: Arc::from(prefix), bytes: Arc::from(vec![5u8; 60_000]) }))
    }
    fn text(value: &Value) -> String { styk_doc::json::to_string(value) }
    fn asset(blob: Value) -> Value {
        let mut object = Obj::new();
        object.set("data_url", blob);
        object.set("label", Value::str("S2P:7"));
        Value::object(object)
    }

    #[test]
    fn a_patch_names_the_pictures_it_carries_and_the_view_can_ask_for_them() {
        let blob = picture("data:image/png;base64,");
        let ops = Value::array(vec![
            op(&[Value::str("figure_types"), Value::Num(2.0)], "v", asset(blob.clone())),
            op(&[Value::str("figure_types")], "a", Value::array(vec![Value::Num(0.0), keyed("v", asset(blob.clone()))])),
            op(&[Value::str("backgrounds"), Value::Num(0.0)], "o", Value::array(vec![Value::array(vec![Value::str("kept")]), Value::array(vec![Value::str("data_url"), blob.clone()])])),
        ]);
        let (named, any) = for_view(ops);
        assert!(any);
        let json = text(&named);
        assert_eq!(json.matches("\"S2P:").count(), 3, "{json}");
        assert!(!json.contains("BQUFBQUF"), "no picture text is in the patch");
        assert!(json.contains("\"S2E:S2P:7\""), "a label that looks like a token is escaped");
        let token: u64 = json.split("\"S2P:").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
        assert_eq!(payload::text(token).unwrap(), blob.text().unwrap());
    }

    #[test]
    fn a_patch_without_pictures_is_the_patch() {
        let ops = Value::array(vec![op(&[Value::str("a")], "v", Value::Num(1.0)), op(&[Value::str("small")], "v", picture_small())]);
        let (named, any) = for_view(ops.clone());
        assert!(!any && named.same_node(&ops));
    }

    fn picture_small() -> Value { Value::Blob(Arc::new(Blob { prefix: Arc::from("data:image/png;base64,"), bytes: Arc::from(vec![1u8; 10]) })) }
}
