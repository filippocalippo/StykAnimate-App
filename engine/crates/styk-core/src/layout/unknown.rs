//! Opaque JSON members, anchored to record identity rather than array position.
//! No known values are cached here. Editing rebuilds known fields and overlays only these members.
use super::{Layout, Node, PanelId};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use styk_doc::Value;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Record {
    Node(u32),
    Kid(u32),
    Size(u32),
    Panel(PanelId),
    Float(u32),
    Relative(u32),
    Setup(u32, u64),
    SetupRect(u32, u64),
    Return(PanelId),
    ReturnPanel(PanelId),
    Hint(PanelId),
    HintSize(PanelId),
}
/// Unknown members share their immutable values across layout/history snapshots.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UnknownRecords(Arc<BTreeMap<Record, Value>>);
impl UnknownRecords {
    pub(crate) fn read(value: &Value) -> Self {
        let mut fields = BTreeMap::new();
        walk(&mut value.clone(), &mut |key, record, known| {
            if let Some(o) = record.as_obj() {
                let extra: styk_doc::Obj = o
                    .iter()
                    .filter(|(k, _)| !known.contains(&k.as_ref()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                if !extra.is_empty() {
                    fields.insert(key, Value::object(extra));
                }
            }
        });
        Self(Arc::new(fields))
    }
    pub(crate) fn restore(&self, value: &mut Value) {
        if self.0.is_empty() {
            return;
        }
        walk(value, &mut |key, record, known| {
            if let Some(extra) = self.0.get(&key).and_then(Value::as_obj)
                && let Value::Obj(o) = record
            {
                let o = Arc::make_mut(o);
                for (k, v) in extra.iter() {
                    if !known.contains(&k.as_ref()) && o.get(k).is_none() {
                        o.set(k, v.clone());
                    }
                }
            }
        });
    }
    /// An operation can remove an owner before allocating a new ID; never give its opaque data to that new record.
    pub(crate) fn max_id(&self) -> u32 {
        self.0
            .keys()
            .filter_map(|key| match key {
                Record::Node(id)
                | Record::Kid(id)
                | Record::Size(id)
                | Record::Float(id)
                | Record::Relative(id)
                | Record::Setup(id, _)
                | Record::SetupRect(id, _) => Some(*id),
                _ => None,
            })
            .max()
            .unwrap_or(0)
    }
    /// Deleting an owning record deletes its extensions too. Surviving records retain their exact values.
    pub(crate) fn prune(layout: &mut Layout) {
        if layout.unknown_records.0.is_empty() {
            return;
        }
        let mut live = BTreeSet::new();
        fn node(n: &Node, live: &mut BTreeSet<Record>) {
            live.insert(Record::Node(n.id()));
            match n {
                Node::Tabs(g) => {
                    for p in &g.tabs {
                        live.insert(Record::Panel(p.clone()));
                    }
                }
                Node::Split { kids, .. } => {
                    for k in kids {
                        live.insert(Record::Kid(k.node.id()));
                        live.insert(Record::Size(k.node.id()));
                        node(&k.node, live);
                    }
                }
            }
        }
        if let Some(n) = &layout.main {
            node(n, &mut live);
        }
        for f in &layout.floats {
            live.insert(Record::Float(f.id));
            live.insert(Record::Relative(f.id));
            node(&f.root, &mut live);
            for (setup, _) in &f.frames.by_setup {
                live.insert(Record::Setup(f.id, *setup));
                live.insert(Record::SetupRect(f.id, *setup));
            }
        }
        for p in layout.panels() {
            live.insert(Record::Panel(p));
        }
        for p in layout.returns.keys() {
            live.insert(Record::Return(p.clone()));
            live.insert(Record::ReturnPanel(p.clone()));
            live.insert(Record::Hint(p.clone()));
            live.insert(Record::HintSize(p.clone()));
        }
        if layout
            .unknown_records
            .0
            .keys()
            .any(|key| !live.contains(key))
        {
            Arc::make_mut(&mut layout.unknown_records.0).retain(|key, _| live.contains(key));
        }
    }
}
type Visitor<'a> = dyn FnMut(Record, &mut Value, &[&str]) + 'a;
fn field<'a>(v: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    match v {
        Value::Obj(o) => Arc::make_mut(o).get_mut(key),
        _ => None,
    }
}
fn array(v: &mut Value, key: &str, mut visit: impl FnMut(&mut Value)) {
    if let Some(Value::Arr(items)) = field(v, key) {
        for item in Arc::make_mut(items) {
            visit(item);
        }
    }
}
fn id(v: &Value) -> Option<u32> {
    v.get("id")?.as_f64().map(|n| n as u32)
}
fn panel_id(v: &Value) -> Option<PanelId> {
    Some(PanelId {
        kind: v.get("kind")?.as_str()?.into(),
        n: v.get("n")?.as_f64()? as u8,
    })
}
fn panel(v: &mut Value, returned: bool, visit: &mut Visitor<'_>) {
    if let Some(p) = panel_id(v) {
        visit(
            if returned {
                Record::ReturnPanel(p)
            } else {
                Record::Panel(p)
            },
            v,
            &["kind", "n"],
        );
    }
}
fn size(v: &mut Value, key: Record, visit: &mut Visitor<'_>) {
    visit(key, v, &["px", "flex"]);
}
fn rect(v: &mut Value, key: Record, visit: &mut Visitor<'_>) {
    visit(key, v, &["x", "y", "w", "h"]);
}
fn node(v: &mut Value, visit: &mut Visitor<'_>) {
    let Some(node_id) = id(v) else { return };
    if v.get("tabs").is_some() {
        visit(
            Record::Node(node_id),
            v,
            &["id", "tabs", "active", "collapsed", "flyout"],
        );
        array(v, "tabs", |v| panel(v, false, visit));
    } else {
        visit(Record::Node(node_id), v, &["id", "axis", "kids"]);
        array(v, "kids", |kid| {
            let Some(child_id) = kid.get("node").and_then(id) else {
                return;
            };
            visit(Record::Kid(child_id), kid, &["size", "node"]);
            if let Some(s) = field(kid, "size") {
                size(s, Record::Size(child_id), visit);
            }
            if let Some(n) = field(kid, "node") {
                node(n, visit);
            }
        });
    }
}
/// Visits only schema-owned records. Unknown payloads are opaque, even if they resemble a node or contain IDs.
/// Called after typed validation on load, and on freshly encoded typed records on save.
fn walk(v: &mut Value, visit: &mut Visitor<'_>) {
    if let Some(n) = field(v, "main") {
        node(n, visit);
    }
    array(v, "floats", |f| {
        let Some(float_id) = id(f) else { return };
        visit(
            Record::Float(float_id),
            f,
            &["id", "root", "monitor", "relative", "setups"],
        );
        if let Some(n) = field(f, "root") {
            node(n, visit);
        }
        if let Some(r) = field(f, "relative") {
            rect(r, Record::Relative(float_id), visit);
        }
        array(f, "setups", |s| {
            let Some(key) = s
                .get("key")
                .and_then(Value::as_str)
                .and_then(|k| k.parse::<u64>().ok())
            else {
                return;
            };
            visit(Record::Setup(float_id, key), s, &["key", "rect"]);
            if let Some(r) = field(s, "rect") {
                rect(r, Record::SetupRect(float_id, key), visit);
            }
        });
    });
    for key in ["closed", "dormant", "presentedPanels"] {
        array(v, key, |p| panel(p, false, visit));
    }
    array(v, "returns", |r| {
        let Some(p) = r.get("panel").and_then(panel_id) else {
            return;
        };
        visit(Record::Return(p.clone()), r, &["panel", "hint"]);
        if let Some(v) = field(r, "panel") {
            panel(v, true, visit);
        }
        if let Some(h) = field(r, "hint") {
            visit(
                Record::Hint(p.clone()),
                h,
                &["group", "index", "sibling", "side", "size"],
            );
            if let Some(s) = field(h, "size") {
                size(s, Record::HintSize(p), visit);
            }
        }
    });
}
