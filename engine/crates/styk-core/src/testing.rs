//! Test support for the core's and the interface's tests (feature `testing`): a core with a document open, prepared the
//! way an open worker prepares one, its derived-facts worker driven by the test (one step at a time), and session calls
//! with JSON arguments, so a panel's headless test never names an engine type.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::app::Core;
use crate::documents::{Documents, PreparedDocument};
use crate::facts::Facts;
use crate::frames::FrameDocument;

/// The published generations of one test document, by revision: what K-doc's publication will supply.
struct Published {
    generations: Mutex<HashMap<u64, Arc<styk_engine::Generation>>>,
}

impl FrameDocument for Published {
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<styk_engine::Generation>> {
        self.generations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&revision).cloned()
    }
}

/// A core with `bytes` (a project file named `name`) open in one tab, a facts worker the test drives, and the
/// document's generation published for its first revision.
pub fn core_with_document(bytes: &[u8], name: &str) -> Result<Core, String> {
    let opener = styk_engine::Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
    let prepared = PreparedDocument::open_bytes(&opener, Arc::from(bytes), name, &|| false).map_err(|error| error.message)?;
    let mut documents = Documents::new();
    let id = documents.open(prepared).map_err(|(error, _)| error.to_string())?;
    let mut core = Core::new(documents);
    let spawner = styk_services::ManualSpawner::new();
    core.set_facts(Facts::start(&spawner, Arc::new(|| {})).map_err(|error| error.0)?);
    let published = Arc::new(Published { generations: Mutex::new(HashMap::new()) });
    core.set_source(id, published.clone());
    SOURCES.with(|sources| sources.borrow_mut().insert(id.serial(), published));
    publish(&mut core)?;
    core.refresh();
    Ok(core)
}

thread_local! {
    static SOURCES: std::cell::RefCell<HashMap<u64, Arc<Published>>> = std::cell::RefCell::new(HashMap::new());
}

/// Publishes the active document's current state as a generation for its revision, as K-doc's publication will: here by
/// opening the session's records in an engine of its own (test-only work on the test's thread).
pub fn publish(core: &mut Core) -> Result<(), String> {
    let document = core.documents.active().ok_or("no document is open")?;
    let (id, revision) = (document.id(), document.revision());
    let text = styk_doc::json::to_string(document.records());
    let source = SOURCES.with(|sources| sources.borrow().get(&id.serial()).cloned()).ok_or("the document has no test source")?;
    let engine = styk_engine::Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
    engine.open(text.as_bytes(), "json", "published").map_err(|error| error.to_string())?;
    let generation = engine.generation().ok_or("nothing was published")?;
    source.generations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(revision, generation);
    Ok(())
}

/// Lets the facts worker answer what the panels asked for: publish, request, one worker step, take the result.
pub fn settle_facts(core: &mut Core) -> Result<(), String> {
    publish(core)?;
    core.refresh();
    if let Some(facts) = core.facts() {
        facts.work_once();
    }
    core.refresh();
    Ok(())
}

/// Runs a session command on the active document with JSON arguments (`"[1,-1]"`) and refreshes the view models.
pub fn call(core: &mut Core, method: &str, args: &str) -> Result<(), String> {
    let id = core.documents.active().ok_or("no document is open")?.id();
    let args = styk_doc::json::parse(args.as_bytes()).map_err(|error| error.to_string())?;
    let args: Vec<styk_doc::Value> = args.elements().map(|items| items.iter().collect()).unwrap_or_default();
    let answer = core.documents.call(id, method, &args, &styk_doc::Value::Null).map_err(|error| error.to_string())?;
    answer.result.map_err(|error| error.to_string())?;
    core.refresh();
    Ok(())
}

/// Selects every figure of the frame on show; returns how many.
pub fn select_all(core: &mut Core) -> Result<usize, String> {
    let frame = core.documents.active().ok_or("no document is open")?.frame_records().map_err(|error| error.to_string())?;
    let uids: Vec<f64> = frame.get("objects").and_then(|objects| objects.elements()).map(|objects| objects.iter().filter_map(|object| object.get("unique_id").and_then(styk_doc::Value::as_f64)).collect()).unwrap_or_default();
    call(core, "selectMany", &format!("[{}]", styk_doc::json::to_string(&styk_doc::Value::nums(&uids))))?;
    Ok(uids.len())
}

/// How many entries the active document's undo history holds.
pub fn undo_depth(core: &Core) -> usize {
    core.documents.active().map_or(0, |document| document.view().history.undo)
}

/// Whether the active document's session has a gesture open.
pub fn editing(core: &Core) -> bool {
    core.documents.active().is_some_and(|document| document.view().editing)
}
