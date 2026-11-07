//! Test support for the interface's tests (feature `testing`): a core with a document open, prepared the way an open
//! worker prepares one, so a panel's headless test never names an engine crate.

use std::sync::Arc;

use crate::app::Core;
use crate::documents::{Documents, PreparedDocument};

/// A core with `bytes` (a project file named `name`) open in one tab, its view models built.
pub fn core_with_document(bytes: &[u8], name: &str) -> Result<Core, String> {
    let engine = styk_engine::Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
    let prepared = PreparedDocument::open_bytes(&engine, Arc::from(bytes), name, &|| false).map_err(|error| error.message)?;
    let mut documents = Documents::new();
    documents.open(prepared).map_err(|(error, _)| error.to_string())?;
    let mut core = Core::new(documents);
    core.refresh();
    Ok(core)
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
