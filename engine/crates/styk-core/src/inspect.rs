//! Owner-produced read models; developer tools never access private owner fields.
use crate::{documents::Documents, focus::FocusState};
// Core owns these read models; engine types never escape the private adapter.
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
#[derive(Clone, Debug)]
pub struct Node {
    pub key: String,
    pub kind: &'static str,
    pub children: usize,
    pub value: Option<String>,
    pub truncated: bool,
}
#[derive(Clone)]
pub struct DocumentSnapshot {
    inner: styk_edit::inspect::Snapshot,
    pub revision: u64,
}
impl From<styk_edit::inspect::Snapshot> for DocumentSnapshot {
    fn from(inner: styk_edit::inspect::Snapshot) -> Self {
        Self { revision: inner.revision, inner }
    }
}
impl From<styk_edit::inspect::Node> for Node {
    fn from(n: styk_edit::inspect::Node) -> Self {
        Self { key: n.key, kind: n.kind, children: n.children, value: n.value, truncated: n.truncated }
    }
}
impl From<styk_edit::inspect::HistoryRow> for HistoryRow {
    fn from(r: styk_edit::inspect::HistoryRow) -> Self {
        Self { revision: r.revision, before_revision: r.before_revision, label: r.label, redo: r.redo }
    }
}
impl<T, U: From<T>> From<styk_edit::inspect::Page<T>> for Page<U> {
    fn from(p: styk_edit::inspect::Page<T>) -> Self {
        Self { rows: p.rows.into_iter().map(U::from).collect(), n_total: p.n_total, more: p.more }
    }
}
impl DocumentSnapshot {
    /// Worker-only bounded traversal of the revision-pinned owner ticket.
    pub fn memory_report(&self, max_bytes: usize) -> Result<usize, &'static str> {
        self.inner.memory_report(max_bytes)
    }
    pub fn node_raw(&self, path: &[&str]) -> Result<Node, &'static str> {
        self.inner.node_raw(path).map(Into::into)
    }
    pub fn tree(&self, path: &[&str], offset: usize) -> Result<Page<Node>, &'static str> {
        self.inner.tree(path, offset).map(Into::into)
    }
}
pub use styk_services::clock::Clock;
#[derive(Clone, Debug)]
pub struct DocumentState {
    pub id: u64,
    pub revision: u64,
    pub tick: f64,
    pub dirty: bool,
    pub undo: usize,
    pub redo: usize,
}
#[derive(Clone, Debug)]
pub struct State {
    pub documents: Vec<DocumentState>,
    pub active: Option<u64>,
}
#[derive(Clone, Copy, Debug)]
pub struct Focus {
    pub target: Option<u64>,
    pub scope: u64,
    pub scopes: usize,
    pub keyboard: bool,
}
pub fn focus(owner: &FocusState) -> Focus {
    Focus {
        target: owner.focused().map(|id| id.0),
        scope: owner.top_scope().0,
        scopes: owner.depth(),
        keyboard: owner.focus_visible(),
    }
}
pub fn state(owner: &Documents) -> State {
    owner.inspection_state()
}
/// These owners have not landed; callers must display unavailability, not an empty fabricated tree.
pub const UNAVAILABLE: &[&str] = &[
    "docking_tree",
    "solver_decisions",
    "hit_regions",
    "drag_split",
    "redraw_log",
    "widget_tree",
    "gpu_timing",
    "tracy",
];
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_owner_and_focus_are_real_snapshots() {
        let state = state(&Documents::new());
        assert!(state.documents.is_empty());
        assert!(state.active.is_none());
        let focus = focus(&FocusState::new());
        assert_eq!(focus.scopes, 1);
        assert_eq!(focus.target, None);
    }
    #[test]
    fn inspection_pins_a_revision_without_changing_history_or_saved_records() {
        use crate::documents::{PreparedDocument, Value};
        let engine = styk_engine::Engine::new(|| 0., styk_engine::Budgets::for_device(None));
        let bytes = include_bytes!("../../../tests/edit/startup.document.json");
        let prepared =
            PreparedDocument::open_bytes(&engine, bytes.as_slice().into(), "fixture.styk", &|| {
                false
            })
            .unwrap();
        let mut owner = Documents::new();
        let id = owner.open(prepared).map_err(|(error, _)| error).unwrap();
        let before = owner.active().unwrap().inspection();
        let original = styk_doc::json::to_string(owner.active().unwrap().records());
        assert_eq!(
            before.node_raw(&["fps"]).unwrap().value.as_deref(),
            Some("24")
        );
        assert!(before.memory_report(0).is_err());
        assert!(before.memory_report(16 * 1024 * 1024).unwrap() > 0);
        owner
            .call(id, "setFPS", &[Value::Num(30.)], &Value::Null)
            .unwrap()
            .result
            .unwrap();
        let after = owner.active().unwrap().inspection();
        assert_ne!(before.revision, after.revision);
        assert_eq!(
            before.node_raw(&["fps"]).unwrap().value.as_deref(),
            Some("24")
        );
        assert_eq!(
            after.node_raw(&["fps"]).unwrap().value.as_deref(),
            Some("30")
        );
        let history = owner.active().unwrap().inspect_history(0);
        assert_eq!(history.rows.len(), 1);
        assert_eq!(history.rows[0].revision, after.revision);
        owner.undo(id).unwrap().result.unwrap();
        assert_eq!(
            styk_doc::json::to_string(owner.active().unwrap().records()),
            original
        );
        assert_eq!(
            owner.active().unwrap().inspect_history(0).rows[0].redo,
            true
        );
    }
}
