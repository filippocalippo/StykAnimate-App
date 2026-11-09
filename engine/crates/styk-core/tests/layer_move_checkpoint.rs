//! A layer move cancelled while the sheet planner is at work: the documents host's worker is held at a real cancellation
//! checkpoint of the command after its planning has begun, Cancel is pressed there, and the document is exactly as it
//! was. Its own test binary: the checkpoint hook is process-wide.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use styk_core::app::Core;
use styk_core::commands::Command;
use styk_core::inspector::Event;
use styk_core::inspector::model::Choice;
use styk_core::testing;
use styk_doc::json;

const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");

struct Threads;

impl styk_services::Spawner for Threads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.to_owned()).spawn(job).map(|_| ()).map_err(|error| styk_services::SpawnError(error.to_string()))
    }
}

fn records(core: &Core) -> String {
    json::to_string(core.documents.active().unwrap().records().unwrap())
}

/// The checkpoint the worker is held at: the third, so the planner has begun (its first check opens planning).
const HELD_AT: usize = 3;

#[test]
fn cancel_at_a_planner_checkpoint_after_work_has_begun_leaves_the_document_exactly_as_it_was() {
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (reached, at_checkpoint) = mpsc::channel();
    let reached = Mutex::new(reached);
    {
        let (calls, gate) = (calls.clone(), gate.clone());
        testing::set_checkpoint(Some(Arc::new(move || {
            if calls.fetch_add(1, Ordering::SeqCst) + 1 == HELD_AT {
                let _ = reached.lock().unwrap().send(());
                let mut open = gate.0.lock().unwrap();
                while !*open {
                    open = gate.1.wait(open).unwrap();
                }
            }
        })));
    }
    let mut core = testing::core_with_document(SHEET, "Test.styk", Arc::new(Threads)).unwrap();
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let (before, depth) = (records(&core), testing::undo_depth(&core));
    core.dispatch(Command::Inspector(Event::Choose(Choice::FigureLayer, Arc::from("layer-2"))));
    at_checkpoint.recv_timeout(Duration::from_secs(30)).expect("the planner reached its checkpoint with work begun");
    core.dispatch(Command::Inspector(Event::CancelLayerMove));
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    let mut ended = false;
    for _ in 0..15_000 {
        while core.poll_document().is_some() {}
        core.refresh();
        if core.inspector().layer_move().is_none() {
            ended = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    testing::set_checkpoint(None);
    assert!(ended, "the move ended");
    testing::settle_facts(&mut core).unwrap();
    assert!(calls.load(Ordering::SeqCst) >= HELD_AT, "the hold was at a checkpoint after planning began");
    assert_eq!(records(&core), before, "the document is exactly as it was");
    assert_eq!(testing::undo_depth(&core), depth, "no history entry");
}
