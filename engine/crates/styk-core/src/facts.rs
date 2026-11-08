//! Derived facts a panel shows that need evaluation or geometry (the frame on show, the typed views of the document, a
//! selection's bounds), made on a background lane from the document's published generation and handed to the interface
//! ready and stamped with what they were made for.
//!
//! The interface thread never builds geometry (D7). A panel asks for the facts of a [`FactsKey`] (document, revision,
//! tick, selection), keeps showing the last ready value meanwhile, and takes the new one when it lands. The lane is the
//! documents host's [`styk_services::worker::Worker`]: one input and one output, exchanged with `try_lock` only. While
//! it is busy the newest request waits here (an older waiting one is replaced: only the latest state matters). The
//! generation comes from the seam the frame scheduler reads, [`crate::frames::FrameDocument`], so facts and frames
//! describe the same published document.

use std::sync::Arc;

use styk_services::worker::Worker;
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
#[derive(Clone)]
pub struct Ready {
    pub key: FactsKey,
    /// The app's `selectionBounds()`: `[minX, minY, maxX, maxY]` of the selected figures' `boundsOf` at the tick, `None`
    /// when none of them is drawn there (or fewer than two are selected: nothing asks).
    pub bounds: Option<[f64; 4]>,
    /// The frame on show at the key's tick and the views it was made from, for the session to adopt
    /// ([`crate::documents::Document::adopt_evaluation`]); `None` when the evaluation failed.
    pub evaluation: Option<(Arc<crate::engine::Prepared>, crate::engine::Value)>,
}

/// What the lane answers: facts, or that the revision's generation is not published yet (K-doc publishes after the
/// edit): not a result, so the panel keeps what it shows and asks again at its next refresh.
pub enum Answer {
    Ready(Ready),
    Unpublished(FactsKey),
}

/// What the lane is given.
pub struct Request {
    key: FactsKey,
    source: Arc<dyn FrameDocument>,
    /// The document's records at the key's revision (a handle, not a copy): what the frame on show is evaluated from.
    report: crate::engine::Value,
}

/// The frame on show at the key's tick, as the session evaluates it (`styk_edit::editor_frame`), from the generation's
/// views; and, for two or more selected figures, their bounds: the same evaluation, geometry and effect reach the app's
/// `boundsOf` measures (`styk_eval::drawlist::app_bounds_of`), for the selected figures only. Lane-only.
fn make(request: Request) -> Answer {
    let Request { key, source, report } = request;
    let Some(generation) = source.snapshot(key.revision, 0) else { return Answer::Unpublished(key) };
    let evaluation = styk_edit::editor_frame(&report, &generation.prepared, f64::from_bits(key.tick)).ok().map(|frame| (generation.prepared.clone(), frame));
    let bounds = if key.uids.len() < 2 { None } else {
        let prepared = &generation.prepared;
        let frame = prepared.evaluate(f64::from_bits(key.tick));
        let slots: Vec<usize> = frame.objects.iter().enumerate().filter(|(_, object)| key.uids.contains(&object.uid)).map(|(slot, _)| slot).collect();
        let scene = styk_eval::geometry::build_only_measured(&prepared.doc, &frame, &slots);
        // (No selected figure drawn at the tick measures to nothing.)
        let measured = styk_eval::drawlist::app_bounds_of(&scene, prepared.doc.as_ref(), &slots);
        slots.iter().filter_map(|slot| measured.get(*slot).copied().flatten()).fold(None, |union: Option<[f64; 4]>, b| {
            Some(union.map_or(b, |u| [u[0].min(b[0]), u[1].min(b[1]), u[2].max(b[2]), u[3].max(b[3])]))
        })
    };
    Answer::Ready(Ready { key, bounds, evaluation })
}

/// The interface's handle on the facts lane.
pub struct Facts {
    lane: Worker<Request, Answer>,
    /// The newest request, waiting while the lane works on an older one.
    waiting: Option<Request>,
    /// What was last asked for, so the same key is not asked again.
    asked: Option<FactsKey>,
    /// The lane holds a request whose result has not been taken.
    submitted: bool,
    latest: Option<Ready>,
}

impl std::fmt::Debug for Ready {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ready").field("key", &self.key).field("bounds", &self.bounds).field("evaluated", &self.evaluation.is_some()).finish()
    }
}

impl Facts {
    /// Starts the lane through the host's spawner. `wake` is called on the lane when facts are ready; the host turns it
    /// into an event, never a synchronous call back into update.
    pub fn start(spawner: &dyn Spawner, wake: Wake) -> Result<Facts, SpawnError> {
        Ok(Facts { lane: Worker::start(spawner, "styk-facts", make, wake)?, waiting: None, asked: None, submitted: false, latest: None })
    }

    /// Facts for `key`, made from `source` and the document's records at the key's revision. A newer request replaces
    /// an older one still waiting.
    pub fn request(&mut self, key: FactsKey, source: Arc<dyn FrameDocument>, report: crate::engine::Value) {
        if self.asked.as_ref() == Some(&key) {
            return;
        }
        self.asked = Some(key.clone());
        self.waiting = Some(Request { key, source, report });
        self.flush();
    }

    /// Hands the waiting request to the lane if it takes one right now; never waits.
    pub fn flush(&mut self) {
        if let Some(request) = self.waiting.take() {
            match self.lane.submit(request) {
                Ok(()) => self.submitted = true,
                Err(request) => self.waiting = Some(request),
            }
        }
    }

    /// The newest ready facts, taking a completion of the lane if there is one; never waits.
    pub fn latest(&mut self) -> Option<&Ready> {
        if let Some(answer) = self.lane.take() {
            self.submitted = false;
            match answer {
                Answer::Ready(ready) => self.latest = Some(ready),
                // Not published yet: forget it was asked, so the next refresh asks again.
                Answer::Unpublished(key) => {
                    if self.asked.as_ref() == Some(&key) {
                        self.asked = None;
                    }
                }
            }
            // The lane is free again: the request that waited behind it goes now.
            self.flush();
        }
        self.latest.as_ref()
    }

    /// Whether a request is waiting or being worked on.
    pub fn in_flight(&self) -> bool {
        self.waiting.is_some() || self.submitted
    }
}
