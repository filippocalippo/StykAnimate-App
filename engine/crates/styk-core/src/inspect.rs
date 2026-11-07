//! Owner-produced read models; developer tools never access private owner fields.
use crate::{documents::Documents, focus::FocusState};
pub use styk_edit::inspect::{HistoryRow, Node, Page, Snapshot as DocumentSnapshot};
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
