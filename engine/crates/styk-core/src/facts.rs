//! Derived facts a panel shows that need evaluation or geometry (the frame on show, the typed views of the document, a
//! selection's bounds), made on a background lane from the document's published generation and handed to the interface
//! ready and stamped with what they were made for.
//!
//! The interface thread never builds geometry (D7). A panel asks for the facts of a [`FactsKey`] (document, revision,
//! tick, selection), keeps showing the last ready value meanwhile, and takes the new one when it lands. The lane is the
//! documents host's [`styk_services::worker::Worker`]: one input and one output, exchanged with `try_lock` only. While
//! it is busy only the newest key/receipt waits here; document handles are acquired on admission. The
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
    pub lineage: u64,
    pub revision: u64,
    /// The playhead as bits (an exact fractional tick).
    pub tick: u64,
    /// The selected figures, in selection order.
    pub uids: Arc<[u32]>,
}

impl FactsKey {
    pub fn new(document: u64, lineage: u64, revision: u64, tick: f64, uids: &[u32]) -> FactsKey {
        FactsKey { document, lineage, revision, tick: tick.to_bits(), uids: uids.into() }
    }
}


/// What the lane made of the one selected figure: everything the Properties panel needs of it that walks the frame,
/// its figure or the figures joined to it, so the interface thread only reads it.
#[derive(Debug)]
pub struct Subject {
    pub uid: u32,
    /// Its figure type (`figure_type_id`).
    pub figure: u32,
    /// Immutable definition identity, captured with the resolved instance.
    pub definition: crate::engine::Value,
    pub object: crate::engine::Value,
    /// Its pose restyles its figure: the evaluation drew it with a style overlay (`_stykStyle`, a colour mode).
    pub restyled: bool,
    /// When restyled, its figure as the overlay resolves it (`resolveInstanceFigure`): the evaluation's own, shared
    /// with [`Ready::figures`], never resolved again.
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
    /// The selected figures as evaluated at the key's tick, their style overlays included (`figure_override`): what the
    /// panel shows of each, shared, never resolved by a view.
    pub figures: Arc<std::collections::HashMap<u32, Arc<crate::engine::doc::Figure>>>,
    /// With one figure selected, what the panel needs of it ([`Subject`]); `None` when it is not drawn at the tick.
    pub subject: Option<Arc<Subject>>,
}

/// A request's own cancellation: set when a newer request supersedes it or the lane's owner goes away, read by the lane
/// between the steps of its preparation. Nothing else cancels it (no watermark).
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<std::sync::atomic::AtomicBool>);

impl Cancel {
    fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
    fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
    fn check(&self) -> Result<(), ()> {
        if self.is_cancelled() { Err(()) } else { Ok(()) }
    }
}

/// The one selected figure, as [`Subject`]: its record in `frame` (the frame on show's records) gives its type and the
/// palette rows; the evaluation's `figures` give its resolved figure. Cancellation is checked between the steps.
/// Lane-only: it walks the frame, the figure and its joined figures.
fn subject(report: &crate::engine::Value, frame: &crate::engine::Value, uid: u32, cancel: &Cancel, doc: &styk_eval::doc::Document, typed: &styk_eval::eval::Frame) -> Result<Option<Subject>, ()> {
    use crate::engine::Value;
    let Some(items) = frame.get("objects").and_then(Value::elements) else { return Ok(None) };
    let mut objects = Vec::with_capacity(items.len());
    let mut selected = None;
    for object in items.iter() {
        cancel.check()?;
        if object.get("unique_id").and_then(Value::as_f64) == Some(f64::from(uid)) { selected = Some(object.clone()); }
        objects.push(object);
    }
    let Some(object) = selected else { return Ok(None) };
    let Some(figure) = object.get("figure_type_id").and_then(Value::as_f64).map(|id| id as u32) else { return Ok(None) };
    let mut instance = None;
    for object in &typed.objects {
        cancel.check()?;
        if object.uid == uid { instance = object.figure_override.clone(); break; }
    }
    let palette = styk_edit::attached_palette_rows_resolved(report, &objects, uid, doc, typed, &|| cancel.is_cancelled()).unwrap_or_default();
    let mut definition = Value::Null;
    if let Some(figures) = report.get("figure_types").and_then(Value::elements) {
        for value in figures.iter() {
            cancel.check()?;
            if value.get("figure_type_id").and_then(Value::as_f64) == Some(f64::from(figure)) { definition = value; break; }
        }
    }
    cancel.check()?;
    Ok(Some(Subject { uid, figure, definition, object, restyled: instance.is_some(), instance, palette }))
}

/// What the lane answers: facts; that the revision's generation is not published yet (K-doc publishes after the
/// edit): not a result, and the next publication receipt permits a retry (refreshing an unchanged unpublished state
/// must not create a worker-wake loop); or that a newer request superseded this one, which stopped where it was.
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
/// views; the selected figures as the typed evaluation draws them (one cancellable evaluation per key, their style
/// overlays resolved by the evaluator); for two or more, their bounds (the same evaluation, geometry and effect reach
/// the app's `boundsOf` measures, `styk_eval::drawlist::app_bounds_of`); for one, its [`Subject`]. The request's
/// cancellation is checked between the steps and inside the evaluation: a superseded request stops. Lane-only.
fn make(request: Request) -> Answer {
    let Request { key, source, report, cancel } = request;
    let Some(generation) = source.snapshot(key.revision, 0) else { return Answer::Unpublished(key) };
    if cancel.check().is_err() {
        return Answer::Cancelled(key);
    }
    let evaluation = styk_edit::editor_frame_cancellable(&report, &generation.prepared, f64::from_bits(key.tick), &|| cancel.is_cancelled()).ok().map(|frame| (generation.prepared.clone(), frame));
    let prepared = &generation.prepared;
    let Some(frame) = prepared.evaluate_cancellable(f64::from_bits(key.tick), &|| cancel.is_cancelled()) else { return Answer::Cancelled(key) };
    let selected = |uid: &u32| key.uids.contains(uid);
    let mut figures = std::collections::HashMap::new();
    for object in &frame.objects {
        if cancel.check().is_err() { return Answer::Cancelled(key); }
        if selected(&object.uid) && let Some(figure) = object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure)) {
            figures.insert(object.uid, figure.clone());
        }
    }
    let bounds = if key.uids.len() < 2 { None } else {
        let slots: Vec<usize> = frame.objects.iter().enumerate().filter(|(_, object)| selected(&object.uid)).map(|(slot, _)| slot).collect();
        let Some(scene) = styk_eval::geometry::build_only_measured_cancellable(&prepared.doc, &frame, &slots, &|| cancel.is_cancelled()) else { return Answer::Cancelled(key) };
        // (No selected figure drawn at the tick measures to nothing.)
        let Some(measured) = styk_eval::drawlist::app_bounds_of_cancellable(&scene, prepared.doc.as_ref(), &slots, &|| cancel.is_cancelled()) else { return Answer::Cancelled(key) };
        slots.iter().filter_map(|slot| measured.get(*slot).copied().flatten()).fold(None, |union: Option<[f64; 4]>, b| {
            Some(union.map_or(b, |u| [u[0].min(b[0]), u[1].min(b[1]), u[2].max(b[2]), u[3].max(b[3])]))
        })
    };
    if cancel.check().is_err() {
        return Answer::Cancelled(key);
    }
    let subject = match (&evaluation, key.uids.as_ref()) {
        (Some((_, records)), [uid]) => {
            match subject(&report, records, *uid, &cancel, &prepared.doc, &frame) {
                Ok(subject) => subject.map(Arc::new),
                Err(()) => return Answer::Cancelled(key),
            }
        }
        _ => None,
    };
    Answer::Ready(Ready { key, bounds, evaluation, figures: Arc::new(figures), subject })
}

/// The interface's handle on the facts lane.
pub struct Facts {
    lane: Option<Worker<Request, Answer>>,
    /// The newest lightweight intent; refresh supplies its document handles only on admission.
    waiting: Option<(FactsKey, Option<u64>)>,
    /// What was last asked for and under which publication receipt, so the same key is not asked again until the host
    /// publishes again.
    asked: Option<(FactsKey, Option<u64>)>,
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
    /// `publication` is the document host's current generation receipt. It changes when a previously unavailable
    /// source becomes ready, including a late reply.
    pub fn request(&mut self, key: FactsKey, source: Arc<dyn FrameDocument>, report: crate::engine::Value, publication: Option<u64>) {
        self.flush();
        if let Some((running, cancel)) = &self.running && *running != key { cancel.cancel(); }
        if self.latest.as_ref().is_some_and(|ready| ready.key == key) {
            self.waiting = None;
            return;
        }
        if self.running.is_some() {
            self.waiting = Some((key, publication));
            return;
        }
        if self.asked.as_ref().is_some_and(|(asked, receipt)| *asked == key && *receipt == publication) {
            self.waiting = None;
            return;
        }
        // Admission, not replacement, acquires the heavy document handles. Until reclamation
        // catches up the only retained intent is a key and receipt; refresh supplies the handles again.
        self.waiting = Some((key.clone(), publication));
        if !self.retiring.is_empty() { return; }
        let Some(lane) = &self.lane else { return };
        let cancel = Cancel::default();
        if lane.submit(Request { key: key.clone(), source, report, cancel: cancel.clone() }).is_ok() {
            self.running = Some((key.clone(), cancel));
            self.asked = Some((key, publication));
            self.waiting = None;
        }
    }

    /// No replacement is needed (for example a cleared selection whose frame is ready).
    pub fn withdraw(&mut self) {
        if let Some((_, cancel)) = &self.running { cancel.cancel(); }
        self.waiting = None;
        self.asked = None;
        self.flush();
    }

    /// A panel's last payload reference must retire with the lane's copy. The fixed
    /// admission bound also prevents repeated refreshes retaining arbitrary old documents.
    pub fn retire(&mut self, payload: Box<dyn Send>) -> Result<(), Box<dyn Send>> {
        self.flush();
        if self.retiring.len() >= 2 { return Err(payload); }
        self.retiring.push(payload);
        self.flush();
        Ok(())
    }

    /// Transfers the final panel owner during replacement/teardown. No more admission follows.
    pub(crate) fn retire_final(&mut self, payload: Box<dyn Send>) {
        self.retiring.push(payload);
    }

    pub fn can_retire(&mut self) -> bool {
        self.flush();
        self.retiring.len() < 2
    }

    /// Never waits for the reclamation lane.
    pub fn flush(&mut self) {
        let Some(lane) = &self.lane else { return };
        if !self.retiring.is_empty() {
            let batch = std::mem::take(&mut self.retiring);
            if let Err(batch) = lane.retire(batch) { self.retiring = batch; }
        }
    }

    /// The newest ready facts, taking a completion of the lane if there is one; never waits. The facts it replaces go
    /// to the lane to be dropped.
    pub fn latest(&mut self) -> Option<&Ready> {
        self.flush();
        // Do not remove a completion until its predecessor can retire.
        if self.retiring.is_empty() && let Some(answer) = self.lane.as_ref().and_then(Worker::take) {
            let superseded = self.running.take().is_some_and(|(_, cancel)| cancel.is_cancelled());
            let cancelled = matches!(answer, Answer::Cancelled(_));
            match answer {
                Answer::Ready(ready) if superseded => {
                    self.cancelled += 1;
                    if self.asked.as_ref().is_some_and(|(key, _)| *key == ready.key) { self.asked = None; }
                    self.retiring.push(Box::new(ready));
                }
                Answer::Ready(ready) => {
                    if self.waiting.as_ref().is_some_and(|(key, _)| *key == ready.key) { self.waiting = None; }
                    if let Some(replaced) = self.latest.replace(ready) {
                        self.retiring.push(Box::new(replaced));
                    }
                }
                // The host's publication receipt, not this answer's wake, permits a retry.
                Answer::Unpublished(_) => {}
                // Superseded: if the state it was made for comes back, it is asked again.
                Answer::Cancelled(key) => {
                    self.cancelled += u64::from(cancelled);
                    if matches!(self.asked.as_ref(), Some((asked, _)) if *asked == key) {
                        self.asked = None;
                    }
                }
            }
            // Reclaim first; the next refresh can admit its newest lightweight intent.
            self.flush();
        }
        self.latest.as_ref()
    }

    /// The already consumed result; inspecting it never polls the exchange a second time.
    pub fn ready(&self) -> Option<&Ready> { self.latest.as_ref() }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc};
    struct Threads;
    impl Spawner for Threads {
        fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), SpawnError> {
            std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|error| SpawnError(error.to_string()))
        }
    }
    struct Source { ready: AtomicBool, reads: AtomicUsize, generation: Arc<styk_engine::Generation> }
    impl FrameDocument for Source {
        fn snapshot(&self, _: u64, _: u64) -> Option<Arc<styk_engine::Generation>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.ready.load(Ordering::SeqCst).then(|| self.generation.clone())
        }
    }

    #[test]
    fn unpublished_facts_wait_for_publication_and_a_late_reply_cannot_lose_the_retry() {
        for publication_before_reply in [false, true] {
            let bytes = include_bytes!("../../../tests/edit/startup.document.json");
            let engine = styk_engine::Engine::new(|| 0., styk_engine::Budgets::for_device(None));
            engine.open(bytes, "json", "test").unwrap();
            let generation = engine.generation().unwrap();
            let key = FactsKey::new(1, generation.lineage, generation.revision, 0., &[1]);
            let report = styk_doc::json::parse(bytes).unwrap();
            let source = Arc::new(Source { ready: AtomicBool::new(false), reads: AtomicUsize::new(0), generation });
            let (send, receive) = mpsc::channel();
            let mut facts = Facts::start(&Threads, Arc::new(move || { let _ = send.send(()); })).unwrap();
            let receipt = || receive.recv_timeout(std::time::Duration::from_secs(300)).expect("the facts worker must answer");
            facts.request(key.clone(), source.clone(), report.clone(), None);
            receipt();
            if !publication_before_reply {
                assert!(facts.latest().is_none());
                for _ in 0..4 {
                    facts.request(key.clone(), source.clone(), report.clone(), None);
                    assert!(!facts.in_flight(), "a refresh must not retry an unchanged unpublished key");
                }
            }
            source.ready.store(true, Ordering::SeqCst);
            facts.request(key.clone(), source.clone(), report.clone(), Some(7));
            facts.latest();
            facts.request(key.clone(), source.clone(), report.clone(), Some(7)); // Refresh admits the lightweight newest intent.
            receipt();
            assert_eq!(facts.latest().unwrap().key, key);
            assert_eq!(source.reads.load(Ordering::SeqCst), 2);
        }
    }
    fn fixture_source() -> (Arc<Source>, crate::engine::Value, FactsKey) {
        let bytes = include_bytes!("../../../tests/edit/startup.document.json");
        let engine = styk_engine::Engine::new(|| 0., styk_engine::Budgets::for_device(None));
        engine.open(bytes, "json", "test").unwrap();
        let generation = engine.generation().unwrap();
        let key = FactsKey::new(1, generation.lineage, generation.revision, 0., &[1]);
        (Arc::new(Source { ready: AtomicBool::new(true), reads: AtomicUsize::new(0), generation }), styk_doc::json::parse(bytes).unwrap(), key)
    }

    #[test]
    fn successful_keys_ignore_receipts_and_discard_a_same_key_retry() {
        let (source, report, key) = fixture_source();
        let (send, receive) = mpsc::channel();
        let mut facts = Facts::start(&Threads, Arc::new(move || { let _ = send.send(()); })).unwrap();
        facts.request(key.clone(), source.clone(), report.clone(), Some(1));
        receive.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
        // Receipt changed before the output is consumed, although the first request read the new generation.
        facts.request(key.clone(), source.clone(), report.clone(), Some(2));
        assert_eq!(facts.latest().unwrap().key, key);
        for receipt in 3..100 { facts.request(key.clone(), source.clone(), report.clone(), Some(receipt)); }
        assert!(!facts.in_flight());
        assert_eq!(source.reads.load(Ordering::SeqCst), 1);
    }

    struct Held(std::sync::Mutex<Option<styk_services::Job>>);
    impl Spawner for Held {
        fn spawn(&self, _: &str, job: styk_services::Job) -> Result<(), SpawnError> { *self.0.lock().unwrap() = Some(job); Ok(()) }
    }
    impl Held {
        fn release(&self) { let job = self.0.lock().unwrap().take().unwrap(); std::thread::spawn(job); }
    }

    #[test]
    fn admission_keeps_only_one_lightweight_intent_while_reclamation_is_held() {
        let (source, report, key) = fixture_source();
        let held = Held(std::sync::Mutex::new(None));
        let mut facts = Facts::start(&held, Arc::new(|| {})).unwrap();
        facts.request(key.clone(), source.clone(), report.clone(), None);
        // Fill the exchange and the two bounded panel/ready retirement slots.
        for _ in 0..3 { assert!(facts.retire(Box::new(report.clone())).is_ok()); }
        for revision in 1..10_000 {
            let next = FactsKey { revision, ..key.clone() };
            facts.request(next, source.clone(), report.clone(), Some(revision));
        }
        assert_eq!(facts.waiting.as_ref().unwrap().0.revision, 9_999);
        assert_eq!(facts.retiring(), 2);
        assert_eq!(Arc::strong_count(&source), 2, "only the running request holds a source; waiting is lightweight");
        facts.withdraw();
        assert!(facts.waiting.is_none());
        drop(facts);
        held.release();
    }

}
