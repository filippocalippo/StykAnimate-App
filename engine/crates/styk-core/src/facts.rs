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


/// What the lane made of the one selected figure: everything the Properties panel needs of it that walks the frame,
/// its figure or the figures joined to it, so the interface thread only reads it.
#[derive(Debug)]
pub struct Subject {
    pub uid: u32,
    /// Its figure type (`figure_type_id`).
    pub figure: u32,
    /// Its pose restyles its figure (`_stykStyle` or a segment colour mode).
    pub restyled: bool,
    /// When restyled, its figure as the overlay resolves it (`resolveInstanceFigure`).
    pub instance: Option<Arc<styk_eval::doc::Figure>>,
    /// `editor.figurePalette()` with nothing but the figure selected (`attachedFigurePalette`): each colour (`#rrggbb`)
    /// with its row, which a palette swatch's picker captures as its `targets` when it opens.
    pub palette: Vec<(String, crate::engine::Value)>,
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
    /// With one figure selected, what the panel needs of it ([`Subject`]); `None` when it is not drawn at the tick.
    pub subject: Option<Arc<Subject>>,
}

/// Whether a pose restyles its figure (`_stykStyle` or a segment colour mode): only then does its figure need
/// resolving.
fn restyled(object: &crate::engine::Value) -> bool {
    object.get("_stykStyle").is_some_and(crate::engine::Value::truthy) || object.path(&["_styk", "colorMode"]).is_some_and(crate::engine::Value::truthy)
}

/// A request's own cancellation: set when a newer request supersedes it or the lane's owner goes away, read by the lane
/// between the steps of its preparation. Nothing else cancels it (no watermark).
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<std::sync::atomic::AtomicBool>);

impl Cancel {
    fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
    fn check(&self) -> Result<(), ()> {
        if self.0.load(std::sync::atomic::Ordering::Acquire) { Err(()) } else { Ok(()) }
    }
}

/// The one selected figure of `frame`, as [`Subject`]: found, its overlay resolved, its palette rows made, with the
/// request's cancellation checked between the steps. Lane-only: it walks the frame, the figure and its joined figures.
fn subject(report: &crate::engine::Value, prepared: &crate::engine::Prepared, frame: &crate::engine::Value, uid: u32, cancel: &Cancel) -> Result<Option<Subject>, ()> {
    let Some(objects) = frame.get("objects").and_then(crate::engine::Value::elements).map(|objects| objects.iter().collect::<Vec<_>>()) else { return Ok(None) };
    let Some(object) = objects.iter().find(|object| object.get("unique_id").and_then(crate::engine::Value::as_f64) == Some(f64::from(uid))) else { return Ok(None) };
    let Some(figure) = object.get("figure_type_id").and_then(crate::engine::Value::as_f64).map(|id| id as u32) else { return Ok(None) };
    cancel.check()?;
    let restyled = restyled(object);
    let instance = match (restyled, prepared.doc.figure(figure)) {
        (true, Some(definition)) => styk_eval::style::parse(object.get("_stykStyle"), object.path(&["_styk", "colorMode"])).map(|style| {
            let definition = definition.clone();
            Arc::new(styk_eval::style::resolve(&definition, &style))
        }),
        _ => None,
    };
    cancel.check()?;
    let palette = styk_edit::attached_palette_rows(report, &objects, uid).unwrap_or_default();
    cancel.check()?;
    Ok(Some(Subject { uid, figure, restyled, instance, palette }))
}

/// What the lane answers: facts; that the revision's generation is not published yet (K-doc publishes after the
/// edit): not a result, so the panel keeps what it shows and asks again at its next refresh; or that a newer request
/// superseded this one, which stopped where it was.
pub enum Answer {
    Ready(Ready),
    Unpublished(FactsKey),
    Cancelled(FactsKey),
}

/// What the lane is given.
pub struct Request {
    key: FactsKey,
    source: Arc<dyn FrameDocument>,
    /// The document's records at the key's revision (a handle, not a copy): what the frame on show is evaluated from.
    report: crate::engine::Value,
    cancel: Cancel,
}

/// The frame on show at the key's tick, as the session evaluates it (`styk_edit::editor_frame`), from the generation's
/// views; for two or more selected figures their bounds (the same evaluation, geometry and effect reach the app's
/// `boundsOf` measures, `styk_eval::drawlist::app_bounds_of`); for one, its [`Subject`]. The request's cancellation is
/// checked between the steps: a superseded request stops at the next one. Lane-only.
fn make(request: Request) -> Answer {
    let Request { key, source, report, cancel } = request;
    let Some(generation) = source.snapshot(key.revision, 0) else { return Answer::Unpublished(key) };
    if cancel.check().is_err() {
        return Answer::Cancelled(key);
    }
    let evaluation = styk_edit::editor_frame(&report, &generation.prepared, f64::from_bits(key.tick)).ok().map(|frame| (generation.prepared.clone(), frame));
    if cancel.check().is_err() {
        return Answer::Cancelled(key);
    }
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
    let subject = match (&evaluation, key.uids.as_ref()) {
        (Some((prepared, frame)), [uid]) => match subject(&report, prepared, frame, *uid, &cancel) {
            Ok(subject) => subject.map(Arc::new),
            Err(()) => return Answer::Cancelled(key),
        },
        _ => None,
    };
    Answer::Ready(Ready { key, bounds, evaluation, subject })
}

/// The interface's handle on the facts lane.
pub struct Facts {
    lane: Option<Worker<Request, Answer>>,
    /// The newest request, waiting while the lane works on an older one.
    waiting: Option<Request>,
    /// What was last asked for, so the same key is not asked again.
    asked: Option<FactsKey>,
    /// The request the lane holds (its key and its cancellation), whose result has not been taken.
    running: Option<(FactsKey, Cancel)>,
    latest: Option<Ready>,
    /// Facts replaced by newer ones, handed to the lane to be dropped there (never on the interface thread).
    retiring: Vec<Box<dyn Send>>,
    /// How many requests stopped because a newer one superseded them (tests read it).
    pub cancelled: u64,
}

impl std::fmt::Debug for Ready {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ready").field("key", &self.key).field("bounds", &self.bounds).field("evaluated", &self.evaluation.is_some()).field("subject", &self.subject.as_ref().map(|subject| subject.uid)).finish()
    }
}

impl Facts {
    /// Starts the lane through the host's spawner. `wake` is called on the lane when facts are ready; the host turns it
    /// into an event, never a synchronous call back into update.
    pub fn start(spawner: &dyn Spawner, wake: Wake) -> Result<Facts, SpawnError> {
        Ok(Facts { lane: Some(Worker::start(spawner, "styk-facts", make, wake)?), waiting: None, asked: None, running: None, latest: None, retiring: Vec::new(), cancelled: 0 })
    }

    /// Facts for `key`, made from `source` and the document's records at the key's revision. A newer request replaces
    /// an older one still waiting, and stops the one the lane is making (by that request's own cancellation).
    pub fn request(&mut self, key: FactsKey, source: Arc<dyn FrameDocument>, report: crate::engine::Value) {
        if self.asked.as_ref() == Some(&key) {
            return;
        }
        if let Some((running, cancel)) = &self.running
            && *running != key
        {
            cancel.cancel();
        }
        self.asked = Some(key.clone());
        if let Some(replaced) = self.waiting.replace(Request { key, source, report, cancel: Cancel::default() }) {
            self.retiring.push(Box::new(replaced));
        }
        self.flush();
    }

    /// Hands the waiting request to the lane if it takes one right now, and what was replaced to be dropped there;
    /// never waits.
    pub fn flush(&mut self) {
        let Some(lane) = &self.lane else { return };
        if self.running.is_none()
            && let Some(request) = self.waiting.take()
        {
            let identity = (request.key.clone(), request.cancel.clone());
            match lane.submit(request) {
                Ok(()) => self.running = Some(identity),
                Err(request) => self.waiting = Some(request),
            }
        }
        if !self.retiring.is_empty() {
            let batch = std::mem::take(&mut self.retiring);
            if let Err(batch) = lane.retire(batch) {
                self.retiring = batch;
            }
        }
    }

    /// The newest ready facts, taking a completion of the lane if there is one; never waits. The facts it replaces go
    /// to the lane to be dropped.
    pub fn latest(&mut self) -> Option<&Ready> {
        if let Some(answer) = self.lane.as_ref().and_then(Worker::take) {
            self.running = None;
            let cancelled = matches!(answer, Answer::Cancelled(_));
            match answer {
                Answer::Ready(ready) => {
                    if let Some(replaced) = self.latest.replace(ready) {
                        self.retiring.push(Box::new(replaced));
                    }
                }
                // Not published yet, or superseded: forget it was asked, so the next refresh asks again.
                Answer::Unpublished(key) | Answer::Cancelled(key) => {
                    self.cancelled += u64::from(cancelled);
                    if matches!(self.asked.as_ref(), Some(asked) if *asked == key) {
                        self.asked = None;
                    }
                }
            }
            // The lane is free again: the request that waited behind it goes now.
            self.flush();
        }
        self.latest.as_ref()
    }

    /// How many replaced payloads wait to be handed to the lane (each refresh hands them over when it takes them).
    pub fn retiring(&self) -> usize {
        self.retiring.len()
    }

    /// Whether a request is waiting or being worked on.
    pub fn in_flight(&self) -> bool {
        self.waiting.is_some() || self.running.is_some()
    }
}

impl Drop for Facts {
    /// The lane's work stops at its next step and every payload it would leave (the last facts, a waiting request,
    /// what was retiring) is dropped on the lane.
    fn drop(&mut self) {
        if let Some((_, cancel)) = &self.running {
            cancel.cancel();
        }
        if let Some(lane) = self.lane.take() {
            let payload: Box<dyn Send> = Box::new((self.latest.take(), self.waiting.take(), std::mem::take(&mut self.retiring)));
            lane.shutdown(payload);
        }
    }
}
