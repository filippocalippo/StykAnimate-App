//! Reading and replacing records of the report (copy-on-write).

use styk_doc::{Obj, Value};

/// The report without `runtime_segments` caches, as the mirror sends it.
pub(crate) fn without_runtime(value: &Value) -> Value {
    match value {
        Value::Obj(object) => {
            let mut out = Obj::new();
            for (key, item) in object.iter() {
                if &**key != "runtime_segments" {
                    out.set(key, without_runtime(item));
                }
            }
            Value::object(out)
        }
        Value::Arr(items) => Value::array(items.iter().map(without_runtime).collect()),
        other => other.clone(),
    }
}

pub(crate) fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

/// The objects of keyframe `index`.
pub(crate) fn frame_objects(report: &Value, index: usize) -> Vec<Value> {
    report.get("keyframes").and_then(|k| k.item(index)).and_then(|f| f.get("objects").and_then(|o| o.elements()).map(|e| e.iter().collect())).unwrap_or_default()
}

/// A mutable keyframe `index` (cloning the path to it).
pub(crate) fn frame_mut(report: &mut Value, index: usize) -> Option<&mut Obj> {
    report.make_obj()?.get_mut("keyframes")?.make_arr()?.get_mut(index)?.make_obj()
}

/// A mutable object in keyframe `index` at `slot`.
pub(crate) fn object_mut(report: &mut Value, index: usize, slot: usize) -> Option<&mut Obj> {
    frame_mut(report, index)?.get_mut("objects")?.make_arr()?.get_mut(slot)?.make_obj()
}

pub(crate) fn uid(object: &Value) -> Option<u32> {
    num(object, "unique_id").map(|v| v as u32)
}

/// The slot an object joins to, if any.
pub(crate) fn join_target(object: &Value) -> Option<usize> {
    object.get("join").filter(|j| j.is_object()).and_then(|j| num(j, "target_object_slot")).map(|v| v as usize)
}

/// JSON equality (`same` in the editor compares structured clones).
pub(crate) fn same(a: &[Value], b: &[Value]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| styk_doc::json::to_string(x) == styk_doc::json::to_string(y))
}
