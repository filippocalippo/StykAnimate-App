//! One receipt-driven placement lane. Only the shell owns its pending snapshot and cancellation.
use super::*;
use std::sync::Arc;
use styk_services::{Cancel, Spawner, storage::Storage, worker::{Worker, run_future}};

type Snapshot = (SetupKey, WindowFrame);
pub(super) struct SaveLane {
    worker: Worker<(Snapshot, Cancel), (Snapshot, Result<(), String>)>,
    pending: Option<Snapshot>,
    active: Option<Cancel>,
    failed: Option<(Snapshot, String)>,
}
impl SaveLane {
    pub fn new(storage: Arc<dyn Storage>, name: String, spawner: &dyn Spawner, wakes: &Wakes) -> Result<Self, String> {
        let wakes = wakes.clone();
        let worker = Worker::start(spawner, "styk-window-state", move |(snapshot, cancel): (Snapshot, Cancel)| {
            let (setup, frame) = snapshot;
            let result = run_future(storage.update(&name, styk_services::shell::window_state::MAX_FILE,
                update(setup, frame), &cancel)).map_err(|e| format!("could not save window state: {e}"));
            (snapshot, result)
        }, Arc::new(move || wakes.send(Wake::WindowState))).map_err(|e| e.to_string())?;
        Ok(Self { worker, pending: None, active: None, failed: None })
    }
    pub fn queue(&mut self, snapshot: Snapshot) {
        if let Some(cancel) = &self.active { cancel.cancel(); }
        self.pending = Some(snapshot);
        self.failed = None;
    }
    pub fn poll(&mut self, submit: bool, wakes: &Wakes) {
        if let Some((snapshot, result)) = self.worker.take() {
            self.active = None;
            if let Err(error) = result {
                if self.pending.is_none() { eprintln!("{error}"); self.failed = Some((snapshot, error)); }
            }
        }
        if submit && self.active.is_none() {
            if let Some(snapshot) = self.pending.take() {
                let cancel = Cancel::new();
                if self.worker.submit((snapshot, cancel.clone())).is_ok() {
                    self.active = Some(cancel);
                } else {
                    self.pending = Some(snapshot);
                    // A transient exchange contention must not strand an accepted close.
                    wakes.send(Wake::WindowState);
                }
            }
        }
    }
    pub fn busy(&self) -> bool { self.active.is_some() || self.pending.is_some() }
    pub fn error(&self) -> Option<String> { self.failed.as_ref().map(|(_, error)| error.clone()) }
}
impl Drop for SaveLane {
    fn drop(&mut self) {
        if let Some(cancel) = &self.active { cancel.cancel(); }
        // Worker::drop retires its storage handle and any payload on the worker, never joins here.
    }
}

pub(super) fn update(setup: SetupKey, frame: WindowFrame) -> styk_services::storage::Update {
    Box::new(move |current| {
        let mut file = current.and_then(|b| std::str::from_utf8(b).ok()).map(WindowStateFile::parse).unwrap_or_default();
        file.record(setup, frame);
        Ok(file.to_text().into_bytes())
    })
}
