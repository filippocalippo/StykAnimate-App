//! What the planning tests share: an engine holding a recorded document, and the
//! editor's own way to apply a transport packet to the report being received.
#![allow(dead_code)]
use styk_doc::{Value, json};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine};

pub fn clock() -> f64 {
    0.0
}

/// An engine that holds `tree` at revision 1, as the app's session leaves it once the document is open.
pub fn engine_with(tree: &Value) -> Engine {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let text = json::to_string(tree);
    let opened = engine.open_document(OpenSource::Json { bytes: text.as_bytes(), name: "planning" }, OpenOptions::default(), &|| false).unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    engine
}

/// The same document published again at `revision`: a newer revision of the engine's document.
pub fn republish(engine: &Engine, revision: u64) {
    let lineage = engine.generation().unwrap().lineage;
    engine.publish_tree(lineage, engine.stored().unwrap().1, revision).unwrap().unwrap();
}

fn parent_mut<'a>(value: &'a mut Value, path: &[Value]) -> &'a mut Value {
    if path.is_empty() {
        return value;
    }
    let next = if let Some(key) = path[0].as_str() {
        value.make_obj().unwrap().get_mut(key).unwrap()
    } else {
        &mut value.make_arr().unwrap()[path[0].as_f64().unwrap() as usize]
    };
    parent_mut(next, &path[1..])
}

/// `applyDocumentChunk`: one packet of the plan applied to what has been received so far.
pub fn apply(mut report: Value, packet: &Value) -> Value {
    if let Some(header) = packet.get("header") {
        return header.clone();
    }
    for op in packet.get("operations").unwrap().elements().unwrap().iter() {
        let path: Vec<_> = op.get("path").unwrap().elements().unwrap().iter().collect();
        let parent = parent_mut(&mut report, &path[..path.len() - 1]);
        let key = path.last().unwrap();
        let old = if let Some(key) = key.as_str() {
            parent.get(key).cloned()
        } else {
            parent.item(key.as_f64().unwrap() as usize)
        };
        let value = if let Some(part) = op.get("append") {
            Value::str(&format!("{}{}", old.unwrap().text().unwrap(), part.text().unwrap()))
        } else if let Some(part) = op.get("extend") {
            let mut value = old.unwrap();
            value.make_arr().unwrap().extend(part.elements().unwrap().iter());
            value
        } else {
            op.get("value").unwrap().clone()
        };
        if let Some(key) = key.as_str() {
            parent.make_obj().unwrap().set(key, value);
        } else {
            let array = parent.make_arr().unwrap();
            let at = key.as_f64().unwrap() as usize;
            if array.len() <= at {
                array.resize(at + 1, Value::Null);
            }
            array[at] = value;
        }
    }
    report
}
