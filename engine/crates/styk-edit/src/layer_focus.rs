//! Focus and lock (`src/editor-layer-focus.mjs`, docs/LAYER-FOCUS.md): the interface focuses some layers and, with the lock,
//! holds every other layer, Scene and Camera too, as if it were locked.
//!
//! The focus is the interface's view. It never changes the document, its history or the saved locks, and the session does not
//! keep it: every call carries it (`layerFocusLock`, the focused layers; absent without the lock) and the checks that refuse an
//! edit of a locked layer refuse a held one the same way, with the same message.

use std::collections::HashSet;

use styk_doc::Value;

use crate::sheet::fixed;
use crate::Editor;

/// The layers Focus and lock holds as a call begins: Scene, Camera and every user layer outside the focus. A layer the call
/// creates joins the focus (`_includeCreatedLayersInFocus`), so it is not among them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FocusLock {
    held: HashSet<String>,
}

impl FocusLock {
    /// `isLayerFocusLocked(id)`.
    pub fn holds(&self, id: &str) -> bool {
        self.held.contains(id)
    }
}

/// `layerLocked`, `getLayer(id).locked`: the saved lock of the layer or the lock the focus puts on it.
pub(crate) fn locked(saved: bool, focus: Option<&FocusLock>, id: &str) -> bool {
    saved || focus.is_some_and(|focus| focus.holds(id))
}

impl Editor {
    /// The focus the interface holds, with the lock (`editor.getLayerFocus()` of a focus with `lock`): `focused` are the layers
    /// left free. `None`: no focus, or one that only filters the view. Taken from the layers the document has now.
    pub fn set_layer_focus_lock(&mut self, focused: Option<&[String]>) {
        self.focus_lock = focused.map(|focused| {
            let order = self.report.path(&["_styk", "layers", "order"]).and_then(Value::elements);
            let held = ["scene", "camera"].into_iter().map(str::to_string)
                .chain(order.into_iter().flat_map(|order| order.iter().filter_map(|id| id.as_str().map(str::to_string))))
                .filter(|id| !focused.contains(id))
                .collect();
            FocusLock { held }
        });
    }

    /// The focus lock of a call's view (`layerFocusLock`).
    pub(crate) fn set_layer_focus_lock_of(&mut self, view: &Value) {
        let focused = view.get("layerFocusLock").and_then(Value::elements).map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect::<Vec<_>>());
        self.set_layer_focus_lock(focused.as_deref());
    }

    /// `isLayerFocusLocked(id)`.
    pub(crate) fn layer_focus_locked(&self, id: &str) -> bool {
        self.focus_lock.as_ref().is_some_and(|focus| focus.holds(id))
    }

    /// `getLayer(id).locked` of Scene, Camera or a user layer: its saved lock or the focus's.
    pub(crate) fn track_locked(&self, id: &str) -> bool {
        let layers = self.report.path(&["_styk", "layers"]);
        let state = layers.and_then(|layers| if fixed(id) { layers.path(&["fixed", id]) } else { layers.path(&["byId", id]) });
        locked(state.and_then(|state| state.get("locked")).is_some_and(Value::truthy), self.focus_lock.as_ref(), id)
    }
}
