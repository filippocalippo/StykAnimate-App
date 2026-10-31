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
