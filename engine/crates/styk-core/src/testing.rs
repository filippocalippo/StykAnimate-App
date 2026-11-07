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
    engine: styk_engine::Engine,
    lineage: u64,
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
    // The documents services (shared clipboards, jobs), as the application attaches them.
    let startup = styk_doc::json::parse(bytes).unwrap_or(styk_doc::Value::Null);
    documents
        .attach_host(crate::documents::HostOptions {
            engine: opener,
            spawner: Arc::new(Threads),
            files: Arc::new(styk_services::files::fake::MemoryFiles::default()),
            startup,
            clock: || 0.0,
            notify: Arc::new(|| {}),
        })
        .map_err(|error| format!("{error:?}"))?;
    let mut core = Core::new(documents);
    let (notify, ready) = std::sync::mpsc::channel();
    core.set_facts(Facts::start(&Threads, Arc::new(move || { let _ = notify.send(()); })).map_err(|error| error.0)?);
    READY.with(|cell| cell.borrow_mut().insert(id.serial(), ready));
    // The published generations come from an engine that opened the same file and publishes the session's tree at each
    // revision, as K-doc's publication does.
    let engine = styk_engine::Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
    let opened = engine
        .open_document(styk_engine::document::OpenSource::File { bytes, name }, styk_engine::document::OpenOptions { layer_timeline: true }, &|| false)
        .map_err(|error| error.message)?;
    engine.activate(&opened.typed, &opened.tree, 0).map_err(|error| error.message)?;
    let lineage = opened.lineage();
    let published = Arc::new(Published { engine, lineage, generations: Mutex::new(HashMap::new()) });
    core.set_source(id, published.clone());
    SOURCES.with(|sources| sources.borrow_mut().insert(id.serial(), published));
    publish(&mut core)?;
    core.refresh();
    Ok(core)
}

/// Starts test lanes on threads of their own (the application's spawner lives in `styk-platform`).
struct Threads;

impl styk_services::Spawner for Threads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.to_owned()).spawn(job).map(|_| ()).map_err(|error| styk_services::SpawnError(error.to_string()))
    }
}

thread_local! {
    static READY: std::cell::RefCell<HashMap<u64, std::sync::mpsc::Receiver<()>>> = std::cell::RefCell::new(HashMap::new());
    static SOURCES: std::cell::RefCell<HashMap<u64, Arc<Published>>> = std::cell::RefCell::new(HashMap::new());
}

/// Publishes the active document's current state as a generation for its revision, as K-doc's publication does
/// (test-only work on the test's thread).
pub fn publish(core: &mut Core) -> Result<(), String> {
    let document = core.documents.active().ok_or("no document is open")?;
    let (id, revision) = (document.id(), document.revision());
    let tree = document.records().map_err(|error| error.to_string())?.clone();
    let source = SOURCES.with(|sources| sources.borrow().get(&id.serial()).cloned()).ok_or("the document has no test source")?;
    source.engine.publish_tree(source.lineage, tree, revision).map_err(|error| error.message)?.ok_or("the test engine holds another document")?;
    let generation = source.engine.generation().ok_or("nothing was published")?;
    source.generations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(revision, generation);
    Ok(())
}

/// Lets the facts lane answer what the panels asked for: publish, request, wait for the lane (test-only), take it.
pub fn settle_facts(core: &mut Core) -> Result<(), String> {
    publish(core)?;
    // An answer for an earlier request may come first; three rounds cover it and the one asked now.
    for _ in 0..3 {
        wait_facts(core)?;
    }
    Ok(())
}

/// Waits for the facts lane to answer what is asked now (one answer; an "unpublished" one counts), without publishing.
pub fn wait_facts(core: &mut Core) -> Result<(), String> {
    core.refresh();
    let id = core.documents.active().ok_or("no document is open")?.id().serial();
    if core.facts().is_some_and(Facts::in_flight) {
        READY.with(|cell| cell.borrow().get(&id).map(|ready| ready.recv_timeout(std::time::Duration::from_secs(30))))
            .ok_or("the document has no facts lane")?
            .map_err(|_| "the facts lane did not answer in 30 s")?;
        core.refresh();
    }
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
    core.documents.active().map_or(0, |document| document.view().map_or(0, |view| view.history.undo))
}

/// Whether the active document's session has a gesture open.
pub fn editing(core: &Core) -> bool {
    core.documents.active().is_some_and(|document| document.view().is_ok_and(|view| view.editing))
}
