//! The document the engine holds: the tree of the document in front, the typed views made from it, and
//! the image atlas and lineage its generations share.
//!
//! [`Engine::activate`] and [`Engine::publish_tree`] (document.rs) replace it; background work that reads
//! the document (layer planning, an edit session starting) takes the tree and its views from here.

use std::sync::Arc;

use styk_doc::{Obj, Value};
use styk_eval::assets::Assets;
use styk_eval::eval::Prepared;
use styk_eval::load::{Converted, Loader};

use crate::Engine;

/// What a publication did.
#[derive(Clone, Copy, Debug)]
pub struct Committed {
    pub generation: u64,
    pub revision: u64,
    /// Records converted into typed views; everything else was reused.
    pub converted: Converted,
    pub ms: f64,
}

pub(crate) struct Store {
    pub(crate) tree: Value,
    /// The interface revision of the last publication.
    pub(crate) revision: u64,
    pub(crate) loader: Loader,
    pub(crate) lineage: u64,
    pub(crate) assets: Option<Arc<Assets>>,
    /// The typed views of `tree`, as published with its generation.
    pub(crate) prepared: Option<Arc<Prepared>>,
    /// The token of the draft the engine's generation holds on top of this document, if it does
    /// (`Engine::publish_draft`): the tree and views above never include it.
    pub(crate) draft: Option<u64>,
}

impl Default for Store {
    fn default() -> Self {
        Store { tree: Value::object(Obj::new()), revision: 0, loader: Loader::new(), lineage: 0, assets: None, prepared: None, draft: None }
    }
}

impl Engine {
    /// The document the engine holds and the interface revision it was published at. `None` while a
    /// publication runs (this never waits) or before any document.
    pub fn stored(&self) -> Option<(u64, Value)> {
        let store = self.inner.store.try_lock().ok()?;
        store.prepared.as_ref()?;
        Some((store.revision, store.tree.clone()))
    }

    /// [`Engine::stored`] with what an edit session or a planner needs to start without converting the
    /// document again: a copy of the loader (typed records shared) and the typed views of that revision.
    pub fn stored_for_editing(&self) -> Option<(u64, Value, Loader, Arc<Prepared>)> {
        let store = self.inner.store.try_lock().ok()?;
        Some((store.revision, store.tree.clone(), store.loader.clone(), store.prepared.clone()?))
    }
}
