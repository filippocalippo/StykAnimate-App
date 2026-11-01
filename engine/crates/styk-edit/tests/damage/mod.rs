//! Damaged copies of real documents, for the tests that load them: every value of a document replaced in turn by values of the
//! wrong kind, or taken out.
#![allow(dead_code)]

use std::path::Path;

use styk_doc::{Value, json};

#[derive(Clone, Debug)]
pub enum Step {
    Key(String),
    Slot(usize),
}

pub fn paths(value: &Value, at: &mut Vec<Step>, out: &mut Vec<Vec<Step>>) {
    out.push(at.clone());
    match value {
        Value::Obj(object) => {
            for (key, child) in object.iter() {
                at.push(Step::Key(key.to_string()));
                paths(child, at, out);
                at.pop();
            }
        }
        Value::Arr(_) | Value::Nums(_) => {
            // Packed numbers have no children of their own; one slot stands for the others.
            let items = value.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
            for (index, child) in items.iter().enumerate().take(4) {
                at.push(Step::Slot(index));
                paths(child, at, out);
                at.pop();
            }
        }
        _ => {}
    }
}

/// A copy of `document` with the value at `at` replaced by `with`, or taken out (a field removed, an element dropped).
pub fn replace(document: &Value, at: &[Step], with: Option<Value>) -> Option<Value> {
    let mut copy = document.clone();
    let (last, parents) = at.split_last()?;
    let mut node = &mut copy;
    for step in parents {
        node = match step {
            Step::Key(key) => node.make_obj()?.get_mut(key)?,
            Step::Slot(index) => node.make_arr()?.get_mut(*index)?,
        };
    }
    match (last, with) {
        (Step::Key(key), Some(with)) => *node.make_obj()?.get_mut(key)? = with,
        (Step::Slot(index), Some(with)) => *node.make_arr()?.get_mut(*index)? = with,
        (Step::Key(key), None) => {
            node.make_obj()?.remove(key);
        }
        (Step::Slot(index), None) => {
            let items = node.make_arr()?;
            (*index < items.len()).then(|| items.remove(*index))?;
        }
    }
    Some(copy)
}

pub fn wrong_values() -> Vec<Value> {
    ["null", "true", "\"x\"", "-1", "1e308", "0.5", "[]", "{}", "[null]", "{\"a\":null}", "[1,2,3]", "\"\""].iter().map(|text| json::parse(text.as_bytes()).unwrap()).collect()
}

pub fn read(path: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path);
    json::parse(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

