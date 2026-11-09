//! Test support for the core's and the interface's tests (feature `testing`): a core with a document open as the
//! screens open theirs ([`crate::screens::core_with_document`]), its facts lane started through the test's spawner
//! (a desktop test passes `styk_platform::spawn::ThreadSpawner`), publication of later revisions, and session calls with JSON
//! arguments, so a panel's headless test never names an engine type.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use crate::app::Core;
use crate::facts::Facts;
use crate::screens::FixturePublication;

struct Fixture {
    publication: Arc<FixturePublication>,
    /// The core's facts lane says it answered (one receiver per core, shared by its documents).
    ready: Rc<Receiver<()>>,
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
    FIXTURES.with(|fixtures| fixtures.borrow_mut().entry(id).or_default().push(Fixture { publication, ready: Rc::new(ready) }));
    let mut core = core;
    settle_facts(&mut core)?;
    Ok(core)
}

/// Opens `bytes` (named `name`) in another tab of `core`, which makes it active, with its own publication, and lets
/// the facts lane answer for it.
pub fn open_document(core: &mut Core, bytes: &[u8], name: &str) -> Result<crate::documents::DocumentId, String> {
    let ready = with_fixture(core, |fixture| Ok(fixture.ready.clone()))?;
    let engine = crate::engine::Engine::new(|| 0.0, crate::engine::Budgets::for_device(None));
    let prepared = crate::documents::PreparedDocument::open_bytes(&engine, Arc::from(bytes), name, &|| false).map_err(|error| error.message)?;
    let id = core.documents.open(prepared).map_err(|(error, _)| error.to_string())?;
    let publication = Arc::new(FixturePublication::open(bytes, name)?);
    core.set_source(id, publication.clone());
    FIXTURES.with(|fixtures| fixtures.borrow_mut().entry(id.get()).or_default().push(Fixture { publication, ready }));
    settle_facts(core)?;
    Ok(id)
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

/// Lets the facts lane answer what the panels asked for: publish, then wait until the panel is not pending and the lane
/// has nothing in flight (an answer for an earlier request may come first).
pub fn settle_facts(core: &mut Core) -> Result<(), String> {
    publish(core)?;
    for _ in 0..8 {
        wait_facts(core)?;
        if !core.inspector().pending() && !core.facts().is_some_and(Facts::in_flight) {
            return Ok(());
        }
    }
    Err("the panel was still pending after eight answers of the facts lane".to_string())
}

/// Runs a session command on the active document with JSON arguments (`"[1,-1]"`), then publishes the new state and
/// lets the facts lane answer, as the app's publication and lane do between frames: the panel is ready after it.
pub fn call(core: &mut Core, method: &str, args: &str) -> Result<(), String> {
    call_unsettled(core, method, args)?;
    settle_facts(core)
}

/// Runs a session command and refreshes once, without letting the workers answer: the panel as it is right after.
pub fn call_unsettled(core: &mut Core, method: &str, args: &str) -> Result<(), String> {
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

/// How long the helpers below wait for the documents host's workers: 15 000 turns of a millisecond.
const WAIT_TURNS: u32 = 15_000;

/// Attaches recovery to `core`'s documents host over `store` (a test's private root, never the person's folder), with a
/// fixed clock, and lets the host's first listing land, so the offer is what a start would show.
pub fn attach_recovery(core: &mut Core, store: Arc<dyn styk_services::recovery::Recovery>) -> Result<(), String> {
    core.documents.attach_recovery(store, Arc::new(styk_services::clock::FixedClock::new())).map_err(|error| error.to_string())?;
    for _ in 0..WAIT_TURNS {
        while let Some(effect) = core.documents.poll() {
            core.document_effect(&effect);
            if matches!(effect, crate::documents::Effect::Recovery(crate::documents::recovery::Event::Listed)) {
                core.refresh();
                return Ok(());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    Err("the recovery host did not list its copies in 15 s".to_string())
}

/// Does what the frame loop does until `done` holds: takes what the documents host finished, hands each effect to the core
/// (`Core::document_effect`) and refreshes. Fails after 15 seconds. The effects the core answered with come back.
pub fn poll_until(core: &mut Core, done: impl Fn(&Core) -> bool) -> Result<Vec<crate::commands::Effect>, String> {
    let mut effects = Vec::new();
    for _ in 0..WAIT_TURNS {
        while let Some(effect) = core.documents.poll() {
            effects.extend(core.document_effect(&effect));
        }
        effects.extend(core.refresh());
        if done(core) {
            return Ok(effects);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    Err(format!("the documents host did not answer in 15 s (recovery: {:?})", core.documents.recovery_view()))
}

/// How many whole-frame object scans this thread has made (a counter, never a clock): a read on the interface thread that
/// must not walk the frame shows no change.
pub fn frame_scans() -> usize {
    crate::inspector::facts::SCANS.with(|scans| scans.get())
}
