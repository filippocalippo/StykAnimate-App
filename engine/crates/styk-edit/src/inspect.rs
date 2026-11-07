//! Immutable inspection tickets. Creating a ticket is O(1); traverse it on a tool worker.
//! Canonical records remain shared with the session. No editable mirror or document serialization.
use crate::session::Session;
use styk_doc::Value;

pub const PAGE_ROWS: usize = 50;
pub const TEXT_BYTES: usize = 128;
pub fn text(value: &str) -> String {
    let mut end = value.len().min(TEXT_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}
#[derive(Clone, Debug)]
pub struct HistoryRow {
    pub revision: u64,
    pub before_revision: u64,
    pub label: String,
    pub redo: bool,
}
#[derive(Clone, Debug)]
pub struct Page<T> {
    pub rows: Vec<T>,
    pub n_total: usize,
    pub more: Option<usize>,
}
#[derive(Clone)]
pub struct Snapshot {
    records: Value,
    pub revision: u64,
}
#[derive(Clone, Debug)]
pub struct Node {
    pub key: String,
    pub kind: &'static str,
    pub children: usize,
    pub value: Option<String>,
    pub truncated: bool,
}
impl Snapshot {
    /// Worker-only conservative retained bytes. Stops before an unbounded graph walk.
    pub fn memory_report(&self, max_bytes: usize) -> Result<usize, &'static str> {
        let cap = max_bytes.min(256 * 1024 * 1024);
        styk_doc::retained_bytes_checked(&[&self.records], |bytes| {
            if bytes <= cap {
                Ok(())
            } else {
                Err("document inspection byte budget exhausted")
            }
        })
    }
    /// Explicit raw-node query, with bounded preview strings; blobs never expand into base64.
    pub fn node_raw(&self, path: &[&str]) -> Result<Node, &'static str> {
        Ok(node("", &self.at(path)?))
    }
    /// One page at one depth. The consumer expands children with a new request.
    pub fn tree(&self, path: &[&str], offset: usize) -> Result<Page<Node>, &'static str> {
        let value = self.at(path)?;
        let total = children(&value);
        let rows = match &value {
            Value::Obj(object) => object
                .iter()
                .skip(offset)
                .take(PAGE_ROWS)
                .map(|(k, v)| node(k, v))
                .collect(),
            Value::Arr(_) | Value::Nums(_) => (offset.min(total)
                ..total.min(offset.saturating_add(PAGE_ROWS)))
                .filter_map(|i| value.item(i).map(|v| node(&i.to_string(), &v)))
                .collect(),
            _ => Vec::new(),
        };
        Ok(Page {
            rows,
            n_total: total,
            more: (offset.saturating_add(PAGE_ROWS) < total)
                .then_some(offset.saturating_add(PAGE_ROWS)),
        })
    }
    fn at(&self, path: &[&str]) -> Result<Value, &'static str> {
        if path.len() > 32 || path.iter().any(|p| p.len() > 2048) {
            return Err("inspection path exceeds bounds");
        }
        let mut value = self.records.clone();
        for key in path {
            value = match &value {
                // Worker-only: scan canonical insertion order, without initializing the shape's lazy index.
                Value::Obj(object) => object
                    .iter()
                    .find(|(k, _)| k.as_ref() == *key)
                    .map(|(_, v)| v.clone()),
                _ => key.parse().ok().and_then(|i| value.item(i)),
            }
            .ok_or("inspection node not found")?;
        }
        Ok(value)
    }
}
fn children(value: &Value) -> usize {
    value
        .as_obj()
        .map_or_else(|| value.array_len().unwrap_or(0), |o| o.len())
}
fn node(key: &str, value: &Value) -> Node {
    let (kind, preview, truncated) = match value {
        Value::Null => ("null", None, false),
        Value::Bool(v) => ("boolean", Some(v.to_string()), false),
        Value::Num(v) => ("number", Some(v.to_string()), false),
        Value::Str(v) => ("string", Some(text(v)), v.len() > TEXT_BYTES),
        Value::Blob(_) => ("blob", None, true),
        Value::Obj(_) => ("object", None, false),
        _ => ("array", None, false),
    };
    Node {
        key: text(key),
        kind,
        children: children(&value),
        value: preview,
        truncated: truncated || key.len() > TEXT_BYTES,
    }
}
impl Session {
    pub fn inspection(&self) -> Snapshot {
        Snapshot {
            records: self.report().clone(),
            revision: self.revision(),
        }
    }
    /// At most 50 labels of 128 bytes, copied on the owner; no history payload is cloned.
    pub fn inspect_history(&self, offset: usize) -> Page<HistoryRow> {
        let n_total = self.editor.undo.len() + self.editor.redo.len();
        let rows = self
            .editor
            .undo
            .iter()
            .map(|e| (e, false))
            .chain(self.editor.redo.iter().rev().map(|e| (e, true)))
            .skip(offset)
            .take(PAGE_ROWS)
            .map(|(e, redo)| HistoryRow {
                revision: e.after_revision,
                before_revision: e.before_revision,
                label: text(&e.label),
                redo,
            })
            .collect();
        Page {
            rows,
            n_total,
            more: (offset.saturating_add(PAGE_ROWS) < n_total)
                .then_some(offset.saturating_add(PAGE_ROWS)),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_share_input_without_expanding_private_payloads() {
        let records = Value::array((0..100).map(|_| Value::str(&"x".repeat(10000))).collect());
        let snapshot = Snapshot {
            records,
            revision: 4,
        };
        let page = snapshot.tree(&[], 0).unwrap();
        assert_eq!(page.n_total, 100);
        assert_eq!(page.more, Some(50));
        assert_eq!(page.rows.len(), 50);
        assert!(
            page.rows
                .iter()
                .all(|n| n.truncated && n.value.as_ref().unwrap().len() == 128)
        );
        assert!(snapshot.tree(&["missing"], 0).is_err());
    }
}
