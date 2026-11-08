//! Test support for the core's and the interface's tests (feature `testing`): a core with a document open as the
//! screens open theirs ([`crate::screens::core_with_document`]), its facts lane started through the test's spawner
//! (a desktop test passes `styk_platform::spawn::ThreadSpawner`), publication of later revisions, and session calls with JSON
//! arguments, so a panel's headless test never names an engine type.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use crate::app::Core;
use crate::facts::Facts;
use crate::screens::FixturePublication;

struct Fixture {
    publication: Arc<FixturePublication>,
    ready: Receiver<()>,
}

thread_local! {
    /// Each test thread's fixtures by document identity (a test may hold several cores).
    static FIXTURES: std::cell::RefCell<HashMap<u64, Vec<Fixture>>> = std::cell::RefCell::new(HashMap::new());
}

/// A core with `bytes` (a project file named `name`) open in one tab, its facts lane started through `spawner` (it
/// must run the lane on a thread of its own) and its first revision published.
pub fn core_with_document(bytes: &[u8], name: &str, spawner: Arc<dyn styk_services::Spawner>) -> Result<Core, String> {
    let (notify, ready) = std::sync::mpsc::channel();
    let (core, publication) = crate::screens::core_with_document(bytes, name, spawner, Arc::new(move || {
        // A test that ended has dropped its receiver: nothing to tell.
        let _ = notify.send(());
    }))?;
    let id = core.documents.active().ok_or("no document is open")?.id().get();
    FIXTURES.with(|fixtures| fixtures.borrow_mut().entry(id).or_default().push(Fixture { publication, ready }));
    Ok(core)
}

fn with_fixture<T>(core: &Core, run: impl FnOnce(&Fixture) -> Result<T, String>) -> Result<T, String> {
    let id = core.documents.active().ok_or("no document is open")?.id().get();
    // The newest core of this identity on this thread is the one under test.
    FIXTURES.with(|fixtures| fixtures.borrow().get(&id).and_then(|list| list.last()).ok_or_else(|| "the document has no test fixture".to_string()).and_then(run))
}

/// Publishes the active document's current state as a generation for its revision, as K-doc's publication does.
pub fn publish(core: &mut Core) -> Result<(), String> {
    let document = core.documents.active().ok_or("no document is open")?;
    let (revision, tree) = (document.revision(), document.records().map_err(|error| error.to_string())?.clone());
    with_fixture(core, |fixture| fixture.publication.publish(tree, revision))
}

/// Waits for the facts lane to answer what is asked now (one answer; an "unpublished" one counts), without publishing.
pub fn wait_facts(core: &mut Core) -> Result<(), String> {
    core.refresh();
    if core.facts().is_some_and(Facts::in_flight) {
        with_fixture(core, |fixture| fixture.ready.recv_timeout(std::time::Duration::from_secs(30)).map_err(|_| "the facts lane did not answer in 30 s".to_string()))?;
        core.refresh();
    }
    Ok(())
}

/// Lets the facts lane answer what the panels asked for: publish, then wait (an answer for an earlier request may come
/// first; three rounds cover it and the one asked now).
pub fn settle_facts(core: &mut Core) -> Result<(), String> {
    publish(core)?;
    for _ in 0..3 {
        wait_facts(core)?;
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
