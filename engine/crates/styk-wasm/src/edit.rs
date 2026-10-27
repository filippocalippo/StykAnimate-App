//! Editing calls as JavaScript sees them (docs/engine/editing.md).

use std::sync::Arc;

use styk_doc::Value;
use styk_engine::Engine;
use styk_engine::document::OpenedDocument;
use wasm_bindgen::prelude::*;

use crate::js_error;

/// The memory one editing call may need beyond what the document holds: the records it replaces, its history entry
/// and the conversion of what it changed for the engine (a pose, a movieclip: 2 MiB on the largest documents
/// measured). A call starts only when the memory can hold this much, so that a document the engine holds cannot be
/// edited into running it out of memory.
const CALL_WORKING_BYTES: usize = 64 << 20;

/// The same for an undo or a redo, which builds the records of the entry anew (380 MiB beyond the 230 MiB of the
/// document at the peak of undoing a movieclip edit of a 40 MiB Pivot file). A session asks for the most any of its
/// calls has taken, once it knows it.
const HISTORY_WORKING_BYTES: usize = 256 << 20;

/// The answer to a call the engine refuses for want of memory, in the shape of an error the session raised.
fn out_of_memory_answer() -> String {
    format!("{{\"status\":\"error\",\"error\":\"{}\"}}", styk_engine::document::OUT_OF_MEMORY)
}

/// What a session publishes into: the engine, and the document it was started from (its typed views and
/// lineage), with the tree last published.
struct Publisher {
    engine: Engine,
    opened: Arc<OpenedDocument>,
    /// The tree and the revision last published.
    published: Option<(Value, u64)>,
    /// Why the last publication failed, until the next one succeeds.
    error: Option<String>,
}

/// The editor's calls run on the open document. Lives on the interface thread; a call is plain
/// computation on the session's own copy-on-write document and takes no lock. Once the session is the
/// engine's document ([`EditSession::activate`]) each call that changed the document publishes the new tree
/// at the session's revision, converting only the records that changed.
#[wasm_bindgen]
pub struct EditSession {
    /// Taken out only when the session is closed ([`Drop`]).
    session: Option<styk_edit::session::Session>,
    revision: f64,
    publisher: Option<Publisher>,
    /// The most memory one call of this session has taken beyond what it held when it began (and a quarter more): of
    /// an edit, and of an undo or a redo.
    working: [usize; 2],
}

/// A closed session's document and history can be hundreds of megabytes: they are dropped on an engine
/// worker, never on the interface thread (D7).
impl Drop for EditSession {
    fn drop(&mut self) {
        let Some(publisher) = self.publisher.take() else { return };
        let engine = publisher.engine.clone();
        let session = self.session.take();
        engine.spawn(move |_| drop((session, publisher)));
    }
}

impl EditSession {
    /// The record of the frame the stage draws ([`styk_edit::session::Session::show`]).
    pub(crate) fn show(&mut self, view: &str, motion: bool) -> Result<Value, JsError> {
        let record = self.session.as_mut().expect("a session is open until it is dropped").show(view, motion).map_err(js_error);
        self.publish();
        record
    }

    /// The onion skins the stage draws (`Session::onions`).
    pub(crate) fn onions(&mut self, view: &str, request: &str) -> Result<Arc<styk_edit::OnionSet>, JsError> {
        let set = self.session.as_mut().expect("a session is open until it is dropped").onions(view, request).map_err(js_error);
        self.publish();
        set
    }

    /// A session that publishes into `engine` the document `opened` was made from.
    pub(crate) fn publishing(mut session: styk_edit::session::Session, engine: Engine, opened: Arc<OpenedDocument>) -> EditSession {
        session.set_clock(crate::clock);
        EditSession { session: Some(session), revision: 0.0, publisher: Some(Publisher { engine, opened, published: None, error: None }), working: [0; 2] }
    }

    fn session(&self) -> &styk_edit::session::Session {
        self.session.as_ref().expect("a session is open until it is dropped")
    }

    /// Publishes the session's tree when a call changed it or moved its revision (a document marked as
    /// changed keeps its tree) and this session is the engine's document.
    fn publish(&mut self) {
        let Some(publisher) = &mut self.publisher else { return };
        let Some((published, at)) = &publisher.published else { return };
        let session = self.session.as_ref().expect("a session is open until it is dropped");
        let report = session.report();
        let revision = session.revision();
        if report.same_node(published) && revision == *at {
            return;
        }
        match publisher.engine.publish_tree(publisher.opened.lineage(), report.clone(), revision) {
            Ok(Some(_)) => {
                publisher.published = Some((report.clone(), revision));
                publisher.error = None;
            }
            // Another document is in front: this one is published when it comes back (`activate`).
            Ok(None) => publisher.published = None,
            Err(error) => publisher.error = Some(error.to_string()),
        }
    }
}

#[wasm_bindgen]
impl EditSession {
    /// Starts a session on `document` (its JSON, exactly as the editor holds it): the session converts what
    /// it evaluates itself (D19). It publishes nothing.
    pub fn from_document(document: &str, state: &str, revision: f64) -> Result<EditSession, JsError> {
        let tree = styk_doc::json::parse(document.as_bytes()).map_err(js_error)?;
        let mut session = styk_edit::session::Session::start(tree, state).map_err(js_error)?;
        session.set_clock(crate::clock);
        Ok(EditSession { session: Some(session), revision, publisher: None, working: [0; 2] })
    }

    /// Makes the session's document the engine's document at `revision` (the editor's revision counter),
    /// as it is now: the stage draws it, playback and exports read it, and every call that changes it
    /// publishes the change. Answers `{generation, revision, ms}` as JSON.
    pub fn activate(&mut self, revision: f64) -> Result<String, JsError> {
        let _working = styk_alloc::reserve(CALL_WORKING_BYTES.max(self.working[0])).map_err(|error| js_error(styk_engine::document::OpenError::out_of_memory(error).to_json()))?;
        let tree = self.session().report().clone();
        let Some(publisher) = &mut self.publisher else { return Err(js_error("this session has no document to publish")) };
        let done = publisher.engine.activate(&publisher.opened.typed, &tree, revision as u64).map_err(|error| js_error(error.to_json()))?;
        publisher.published = Some((tree, revision as u64));
        publisher.error = None;
        Ok(format!("{{\"generation\":{},\"revision\":{},\"ms\":{:.3}}}", done.generation, done.revision, done.ms))
    }

    /// Why the engine could not follow the last change of the document, or `undefined`.
    pub fn publish_error(&self) -> Option<String> {
        self.publisher.as_ref().and_then(|publisher| publisher.error.clone())
    }

    /// The session's document as JSON (tests and recovery; never on an interactive path).
    pub fn report_json(&self) -> String {
        styk_doc::json::to_string(self.session().report())
    }

    /// The interface revision of the document the session started from.
    pub fn revision(&self) -> f64 {
        self.revision
    }

    pub fn can_undo(&self) -> bool {
        self.session().can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.session().can_redo()
    }

    /// A read of what the interface shows at `view` (the call's view): `kind` is `frame` (the frame on show),
    /// `document` (the document's own frame under any gesture), `motion` (the motion-path edit's display, `null`
    /// where it shows the document), `timeline` or `geometry` (`args`: `{since, motion}`; the groups that changed
    /// since the read `since`). Answers JSON text; the document does not change.
    pub fn query(&mut self, kind: &str, args: &str, view: &str) -> Result<String, JsError> {
        let answer = self.session.as_mut().expect("a session is open until it is dropped").query(kind, args, view).map_err(js_error);
        self.publish();
        answer
    }

    /// Runs one editor call: its JavaScript name, its arguments as a JSON array and
    /// the editor's view before it (JSON). Answers with JSON: status, result, state,
    /// events, the gesture's draft and what a command published. With `changesOnly: true`
    /// in the view, unchanged COW figures and sheet fields are omitted (the app's owned
    /// adoption path); default responses stay complete for shadow comparison.
    pub fn call(&mut self, method: &str, args: &str, view: &str) -> String {
        let (kind, base) = if matches!(method, "undo" | "redo") { (1, HISTORY_WORKING_BYTES) } else { (0, CALL_WORKING_BYTES) };
        let Ok(_working) = styk_alloc::reserve(base.max(self.working[kind])) else { return out_of_memory_answer() };
        styk_alloc::reset_peak();
        let began = styk_alloc::live_bytes();
        let answer = self.session.as_mut().expect("a session is open until it is dropped").call(method, args, view);
        self.publish();
        // What this call took (and whatever the workers took meanwhile) is what the next may need.
        let took = styk_alloc::peak_bytes().saturating_sub(began);
        self.working[kind] = self.working[kind].max((took + took / 4).min(styk_alloc::ceiling() / 2));
        answer
    }
}
