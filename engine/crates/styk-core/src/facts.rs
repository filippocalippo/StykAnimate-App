//! Derived facts a panel shows that need evaluation or geometry (a selection's bounds), made on a worker from the
//! document's published generation and handed to the interface ready and stamped with what they were made for.
//!
//! The interface thread never builds geometry (D7). A panel asks for the facts of a [`FactsKey`] (document, revision,
//! tick, selection), keeps showing the last ready value meanwhile, and takes the new one when it lands. Requests and
//! results cross through one small slot each: the interface only ever `try_lock`s it (a request it cannot place waits
//! in an outbox for the next refresh), the worker alone waits. The generation comes from the same seam the frame
//! scheduler reads, [`crate::frames::FrameDocument`], so facts and frames describe the same published document.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, TryLockError};

use styk_services::{SpawnError, Spawner};

use crate::frames::{FrameDocument, Wake};

/// What a set of facts is made for. Two keys are equal only for the same document state, playhead and selection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactsKey {
    pub document: u64,
    pub revision: u64,
    /// The playhead as bits (an exact fractional tick).
    pub tick: u64,
    /// The selected figures, in selection order.
    pub uids: Arc<[u32]>,
}

impl FactsKey {
    pub fn new(document: u64, revision: u64, tick: f64, uids: &[u32]) -> FactsKey {
        FactsKey { document, revision, tick: tick.to_bits(), uids: uids.into() }
    }
}

/// Facts made for one key.
#[derive(Clone, Debug, PartialEq)]
pub struct Ready {
    pub key: FactsKey,
    /// The app's `selectionBounds()`: `[minX, minY, maxX, maxY]` of the selected figures' `boundsOf` at the tick, `None`
    /// when none of them is drawn there or the generation for the revision could not be had.
    pub bounds: Option<[f64; 4]>,
}

struct Request {
    key: FactsKey,
    source: Arc<dyn FrameDocument>,
}

#[derive(Default)]
struct Slot {
    request: Option<Request>,
    ready: Option<Ready>,
}

struct Shared {
    slot: Mutex<Slot>,
    changed: Condvar,
    closed: AtomicBool,
    wake: Wake,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        // A worker that panicked mid-update leaves a value that is still a whole request or result.
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Takes the pending request, computes its facts outside the lock and publishes them. `false` when there was none.
    fn step(&self) -> bool {
        let Some(request) = self.lock().request.take() else { return false };
        let bounds = request.source.snapshot(request.key.revision, 0).and_then(|generation| bounds(&generation, &request.key));
        let ready = Ready { key: request.key, bounds };
        self.lock().ready = Some(ready);
        (self.wake)();
        true
    }

    fn run(&self) {
        loop {
            {
                let mut slot = self.lock();
                while slot.request.is_none() && !self.closed.load(Ordering::Acquire) {
                    slot = self.changed.wait(slot).unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                if self.closed.load(Ordering::Acquire) {
                    return;
                }
            }
            self.step();
        }
    }
}

/// The selection's bounds at the key's tick, from the generation: the same evaluation, geometry and effect reach the
/// app's `boundsOf` measures (`styk_eval::drawlist::app_bounds_of`), for the selected figures only.
fn bounds(generation: &styk_engine::Generation, key: &FactsKey) -> Option<[f64; 4]> {
    let prepared = &generation.prepared;
    let frame = prepared.evaluate(f64::from_bits(key.tick));
    let slots: Vec<usize> = frame.objects.iter().enumerate().filter(|(_, object)| key.uids.contains(&object.uid)).map(|(slot, _)| slot).collect();
    if slots.is_empty() {
        return None;
    }
    let scene = styk_eval::geometry::build_only_measured(&prepared.doc, &frame, &slots);
    let measured = styk_eval::drawlist::app_bounds_of(&scene, prepared.doc.as_ref(), &slots);
    slots.iter().filter_map(|slot| measured.get(*slot).copied().flatten()).fold(None, |union: Option<[f64; 4]>, b| {
        Some(union.map_or(b, |u| [u[0].min(b[0]), u[1].min(b[1]), u[2].max(b[2]), u[3].max(b[3])]))
    })
}

/// The interface's handle on the facts worker.
pub struct Facts {
    shared: Arc<Shared>,
    /// A request the interface could not place (the worker held the slot); placed at the next [`Facts::flush`].
    outbox: Option<Request>,
    /// What was last asked for, so the same key is not asked again.
    asked: Option<FactsKey>,
    latest: Option<Ready>,
}

impl Facts {
    /// Starts the worker through the host's spawner. `wake` is called (on the worker) when facts are ready; the host
    /// turns it into an event, never a synchronous call back into update.
    pub fn start(spawner: &dyn Spawner, wake: Wake) -> Result<Facts, SpawnError> {
        let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), changed: Condvar::new(), closed: AtomicBool::new(false), wake });
        let worker = shared.clone();
        spawner.spawn("styk-facts", Box::new(move || worker.run()))?;
        Ok(Facts { shared, outbox: None, asked: None, latest: None })
    }

    /// Facts for `key`, made from `source`. A newer request replaces an older one that has not started.
    pub fn request(&mut self, key: FactsKey, source: Arc<dyn FrameDocument>) {
        if self.asked.as_ref() == Some(&key) {
            return;
        }
        self.asked = Some(key.clone());
        self.outbox = Some(Request { key, source });
        self.flush();
    }

    /// Places the outbox's request if the slot is free right now; never waits.
    pub fn flush(&mut self) -> bool {
        let Some(request) = self.outbox.take() else { return true };
        match self.shared.slot.try_lock() {
            Ok(mut slot) => {
                slot.request = Some(request);
                drop(slot);
                self.shared.changed.notify_one();
                true
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                poisoned.into_inner().request = Some(request);
                self.shared.changed.notify_one();
                true
            }
            Err(TryLockError::WouldBlock) => {
                self.outbox = Some(request);
                false
            }
        }
    }

    /// The newest ready facts, taking any the worker published since the last call; never waits.
    pub fn latest(&mut self) -> Option<&Ready> {
        if let Ok(mut slot) = self.shared.slot.try_lock()
            && let Some(ready) = slot.ready.take()
        {
            self.latest = Some(ready);
        }
        self.latest.as_ref()
    }

    /// Runs one pending request on the calling thread: for hosts that drive the work themselves (tests, a cooperative
    /// pool). `false` when there was nothing to do.
    pub fn work_once(&self) -> bool {
        self.shared.step()
    }
}

impl Drop for Facts {
    /// Never joins: the worker sees the flag, wakes and leaves.
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        self.shared.changed.notify_all();
    }
}
