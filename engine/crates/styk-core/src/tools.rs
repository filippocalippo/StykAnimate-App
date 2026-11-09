//! Stage tools own input interpretation, never selection or history. V0 supplies Select's click.
//! Geometry and artwork queries run only on this bounded worker, through the existing pickers.
use std::collections::HashSet;
use std::sync::Arc;
use crate::{answers, documents::{DocumentId, Documents}, engine::Value, frames::FrameDocument, i18n::Msg};
use crate::stage::{Surface, View, input::{Button, Pointer, PointerPhase}};
use styk_services::{Cancel, Spawner, SpawnError, input::Modifiers, worker::Worker};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Key { document: DocumentId, lineage: u64, revision: u64, tick: f64, view: View, focus_version: u64 }
struct Press {
    serial: u64, key: Key, cancel: Cancel, focus: Option<Arc<[String]>>,
    point: [f64; 2], selected: Option<u32>, joint: i64, modifiers: Modifiers,
}
struct Request { press: Press, source: Arc<dyn FrameDocument>, records: Value }
impl std::ops::Deref for Request { type Target = Press; fn deref(&self) -> &Press { &self.press } }
struct Reply { serial: u64, key: Key, modifiers: Modifiers, hit: Result<Option<(u32, i32)>, Msg> }

/// One submitted query and one latest waiting press. Superseding input invalidates by event identity.
pub struct Tools {
    lane: Option<Worker<Request, Reply>>,
    retired: Vec<Box<dyn Send>>,
    current: Option<(Key, Cancel)>,
    serial: u64,
    pointer: Option<u32>,
    waiting: Option<Press>,
    submitted: bool,
    ready: Option<Reply>,
}

impl Tools {
    pub fn start(spawner: &dyn Spawner, wake: Arc<dyn Fn() + Send + Sync>) -> Result<Self, SpawnError> {
        Self::start_query(spawner, wake, pick)
    }
    fn start_query(spawner: &dyn Spawner, wake: Arc<dyn Fn() + Send + Sync>, query: impl FnMut(Request) -> Reply + Send + 'static) -> Result<Self, SpawnError> {
        Ok(Self { lane: Some(Worker::start(spawner, "styk-select", query, wake)?), retired: Vec::new(), current: None, serial: 0, pointer: None, waiting: None, submitted: false, ready: None })
    }
    pub fn cancel(&mut self) {
        if let Some((_, cancel)) = self.current.take() { cancel.cancel(); }
        self.serial = self.serial.wrapping_add(1); self.waiting = None; self.ready = None; self.pointer = None;
    }
    pub fn cancel_pointer(&mut self, pointer: Option<u32>) { if pointer.is_none() || pointer == self.pointer { self.cancel(); } }
    pub fn pending(&self) -> bool { self.waiting.is_some() || self.submitted || self.ready.is_some() }

    pub fn pointer(&mut self, pointer: Pointer, documents: &Documents, surface: &Surface, view_state: &crate::view_state::ViewState) -> Result<(), Msg> {
        if pointer.phase == PointerPhase::Cancel { self.cancel_pointer(Some(pointer.id)); return Ok(()); }
        if pointer.phase != PointerPhase::Down || pointer.button != Button::Left { return Ok(()); }
        self.cancel();
        self.pointer = Some(pointer.id);
        let document = documents.active().ok_or_else(unavailable)?;
        let view = document.view().map_err(|_| unavailable())?;
        let key = Key { focus_version: view_state.version(), document: document.id(), lineage: document.lineage(), revision: document.revision(), tick: view.tick, view: surface.view().ok_or_else(unavailable)? };
        let cancel = Cancel::new();
        self.current = Some((key, cancel.clone()));
        self.waiting = Some(Press { serial: self.serial, key, cancel, focus: view_state.layer_focus_lock(document.id(), document.lineage()), point: pointer.point,
            selected: view.selection.uid, joint: view.selection.joint, modifiers: pointer.modifiers });
        self.flush(documents);
        Ok(())
    }
    fn flush(&mut self, documents: &Documents) {
        let Some(lane) = &self.lane else { return; };
        if !self.retired.is_empty() {
            if let Err(retired) = lane.retire(std::mem::take(&mut self.retired)) { self.retired = retired; return; }
        }
        if self.submitted { return; }
        let published = documents.published();
        if self.waiting.as_ref().is_some_and(|request| published.is_some_and(|(id, rev, _)| id == request.key.document && rev == request.key.revision))
            && let Some(request) = self.waiting.take() {
            let Some(document) = documents.get(request.key.document) else { self.cancel(); return; };
            let (Ok(records), Some(source)) = (document.records(), documents.frame_source(request.key.document)) else { self.cancel(); return; };
            let request = Request { press: request, records: records.clone(), source };
            match lane.submit(request) { Ok(()) => self.submitted = true, Err(request) => { let Request { press, source, records } = request; self.waiting = Some(press); self.retired.push(Box::new((source, records))); } }
        }
    }
    pub fn progress(&mut self, documents: &mut Documents, surface: Option<&Surface>, session: &mut answers::Session, view_state: &crate::view_state::ViewState) -> Result<bool, Msg> {
        if let Some(reply) = self.lane.as_ref().and_then(Worker::take) { self.submitted = false; self.ready = Some(reply); }
        if self.current.as_ref().is_some_and(|(key, _)| {
            documents.active().is_none_or(|doc| doc.id() != key.document || doc.lineage() != key.lineage || doc.revision() != key.revision || doc.view().is_ok_and(|view| view.tick != key.tick))
                || key.focus_version != view_state.version() || surface.and_then(Surface::view) != Some(key.view)
        }) { self.cancel(); }
        self.flush(documents);
        let Some(reply) = self.ready.as_ref() else { return Ok(false); };
        let current = documents.active().is_some_and(|doc| doc.id() == reply.key.document && doc.lineage() == reply.key.lineage && doc.revision() == reply.key.revision);
        if reply.serial != self.serial || !current || surface.and_then(Surface::view) != Some(reply.key.view) {
            self.ready = None; return Ok(false);
        }
        let document = documents.active().ok_or_else(unavailable)?;
        let Ok(view) = document.view() else { return Ok(false); };
        if view.tick != reply.key.tick { self.ready = None; return Ok(false); }
        // The facts owner adopts the evaluated frame. Never make select evaluate on the interface thread.
        if document.frame_records_ready().is_none() { return Ok(false); }
        let toggle = !reply.modifiers.contains(Modifiers::ALT) && (reply.modifiers.contains(Modifiers::SHIFT) || reply.modifiers.contains(Modifiers::CTRL) || reply.modifiers.contains(Modifiers::META));
        let hit = reply.hit.clone();
        let add = hit.as_ref().ok().copied().flatten().is_some_and(|(uid, joint)| joint < 0 && view.selection.uids.contains(&uid));
        let id = document.id();
        self.ready = None;
        let hit = hit?;
        if hit.is_none() && toggle { return Ok(false); }
        let (uid, joint) = hit.map_or((Value::Null, -1), |(uid, joint)| (Value::Num(f64::from(uid)), joint));
        let mut options = styk_doc::Obj::new();
        options.set("toggle", Value::Bool(toggle)); options.set("add", Value::Bool(!toggle && add));
        answers::call(documents, id, "select", &[uid, Value::Num(if toggle { -1. } else { f64::from(joint) }), Value::object(options)], session)?;
        Ok(true)
    }
}

impl Drop for Tools {
    fn drop(&mut self) {
        self.cancel();
        if let Some(lane) = self.lane.take() { lane.shutdown(Box::new(std::mem::take(&mut self.retired))); }
    }
}

fn unavailable() -> Msg { Msg::new("errors.editorSessions.finishTheCurrentOperationFirst") }

fn pick(request: Request) -> Reply {
    let hit = query(&request).map_err(|_| Msg::new("errors.engineOwner.notSupported"));
    Reply { serial: request.serial, key: request.key, modifiers: request.modifiers, hit }
}

fn query(request: &Request) -> Result<Option<(u32, i32)>, ()> {
    use crate::engine::{geometry, picking};
    let cancelled = || request.cancel.is_cancelled();
    if cancelled() { return Err(()); }
    let generation = request.source.snapshot(request.key.revision, 0).ok_or(())?;
    let doc = &generation.prepared.doc;
    let frame = generation.prepared.evaluate_cancellable(request.key.tick, &cancelled).ok_or(())?;
    let scene = geometry::build_shapes_cancellable(doc, &frame, None, &cancelled).ok_or(())?;
    let mut hidden = HashSet::new(); let mut locked = HashSet::new();
    if let Some(layers) = &doc.layers {
        for object in &frame.objects {
            let layer = layers.layer_of(object.uid);
            if layers.hidden.iter().any(|id| id == layer) { hidden.insert(object.uid); }
            if request.records.path(&["_styk", "layers", "byId", layer, "locked"]).is_some_and(|value| matches!(value, Value::Bool(true))) || request.focus.as_ref().is_some_and(|focused| !focused.iter().any(|id| id == layer)) { locked.insert(object.uid); }
        }
    }
    let canvas = doc.canvas;
    let matrix = request.key.view.matrix(canvas, None);
    let world = request.key.view.stage_to_document(request.point, canvas, None);
    let options = picking::HandleOptions { selected_uid: request.selected, selected_joint: request.joint as i32,
        hidden_uids: Some(&hidden), locked_uids: Some(&locked), view_scale: request.key.view.zoom, ..Default::default() };
    let handles = picking::handles(&scene, &frame, &options).map_err(|_| ())?;
    let prepared = crate::stage::picking::Prepared { scene: &scene, frame: &frame, handles: &handles.handles };
    let preferred = request.modifiers.contains(Modifiers::ALT).then_some(request.selected).flatten();
    if let Some(hit) = prepared.hover(world, matrix, preferred) {
        let handle = &handles.handles[hit.handle]; return Ok(Some((handle.uid, handle.joint)));
    }
    let static_handles = picking::handles(&scene, &frame, &picking::HandleOptions { select_static: true, ..options }).map_err(|_| ())?;
    let static_prepared = crate::stage::picking::Prepared { scene: &scene, frame: &frame, handles: &static_handles.handles };
    if let Some(hit) = static_prepared.hover(world, matrix, preferred) {
        let handle = &static_handles.handles[hit.handle]; return Ok(Some((handle.uid, handle.joint)));
    }
    // Use the same alpha-aware, topmost artwork query as today's stage; no bounds-only substitute.
    // The picker is local to a press, so decoded pictures cannot accumulate across documents.
    if cancelled() { return Err(()); }
    let body = styk_export::pick::artwork_cancellable(&mut styk_export::pick::Picker::default(), doc, &generation.assets, &frame, world, request.key.view.zoom, &hidden, &locked, &cancelled).map_err(|_| ())?;
    if cancelled() { return Err(()); }
    if let Some(hit) = prepared.segment(world, &picking::SegmentPickOptions { uid: body.map(|hit| hit.uid), scale: request.key.view.zoom, ..Default::default() }).map_err(|_| ())? {
        let handle = &handles.handles[hit.handle]; return Ok(Some((handle.uid, handle.joint)));
    }
    Ok(body.map(|hit| (hit.uid, -1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, atomic::{AtomicBool, Ordering}};
    use std::time::Duration;
    struct Threads;
    impl Spawner for Threads {
        fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), SpawnError> {
            std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|e| SpawnError(e.to_string()))
        }
    }
    struct Source { generation: Arc<styk_engine::Generation>, dropped: mpsc::Sender<std::thread::ThreadId> }
    impl FrameDocument for Source { fn snapshot(&self, _: u64, _: u64) -> Option<Arc<styk_engine::Generation>> { Some(self.generation.clone()) } }
    impl Drop for Source { fn drop(&mut self) { let _ = self.dropped.send(std::thread::current().id()); } }

    #[test]
    fn production_pick_locks_only_a_boolean_true_or_layers_outside_focus() {
        let engine = styk_engine::Engine::new(|| 0., styk_engine::Budgets::for_device(None));
        engine.open(include_bytes!("../../../tests/edit/startup.document.json"), "json", "test").unwrap();
        let generation = engine.generation().unwrap();
        let (dropped, _) = mpsc::channel();
        let source = Arc::new(Source { generation: generation.clone(), dropped });
        for (saved, focus, expected) in [("true", None, None), ("1", None, Some((1, -1))), ("false", Some("other"), None), ("false", Some("layer-1"), Some((1, -1)))] {
            let mut records = styk_doc::json::parse(include_bytes!("../../../tests/edit/startup.document.json")).unwrap();
            records.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap()
                .get_mut("layers").unwrap().make_obj().unwrap().get_mut("byId").unwrap().make_obj().unwrap()
                .get_mut("layer-1").unwrap().make_obj().unwrap().set("locked", styk_doc::json::parse(saved.as_bytes()).unwrap());
            let view = View::default();
            let request = Request { press: Press {
                serial: 1, key: Key { document: DocumentId::preview(1), lineage: generation.lineage, revision: generation.revision, tick: 0., view, focus_version: 0 },
                cancel: Cancel::new(), focus: focus.map(|id| vec![id.to_owned()].into()), point: view.document_to_stage([480., 280.], [960, 540], None), selected: None, joint: -1, modifiers: Modifiers::NONE,
            }, records, source: source.clone() };
            assert_eq!(query(&request).unwrap(), expected, "saved={saved}, focus={focus:?}");
        }
    }

    #[test]
    fn cancellation_and_teardown_end_a_slow_artwork_miss_and_dispose_on_the_worker() {
        // A repository PNG starts cold on every job. Hold its first decoder read until
        // the press is cancelled; no sleep, image-size threshold or desktop input.
        for teardown in [false, true] {
            let engine = styk_engine::Engine::new(|| 0., styk_engine::Budgets::for_device(None));
            engine.open(include_bytes!("../../styk-eval/tests/fixtures/clip-paint/image-identity.json"), "json", "test").unwrap();
            let generation = engine.generation().unwrap(); assert!(!generation.prepared.doc.images.is_empty());
            let (entered, entered_rx) = mpsc::channel(); let (finished, finished_rx) = mpsc::channel();
            let (dropped, dropped_rx) = mpsc::channel();
            let mut tools = Tools::start_query(&Threads, Arc::new(|| {}), move |request| {
                let source = request.source.snapshot(0, 0).unwrap();
                let first = AtomicBool::new(true);
                let (wake, wait) = mpsc::channel();
                request.cancel.on_cancel(move || { let _ = wake.send(()); });
                let result = styk_eval::assets::decode_picture_cancellable(&source.prepared.doc, &source.assets, styk_eval::assets::Picture::Image(0), &|| {
                    if first.swap(false, Ordering::SeqCst) { return false; }
                    if !request.cancel.is_cancelled() { entered.send(()).unwrap(); wait.recv_timeout(Duration::from_secs(20)).unwrap(); }
                    request.cancel.is_cancelled()
                }).unwrap();
                assert!(result.is_empty()); assert!(request.cancel.is_cancelled());
                finished.send(()).unwrap();
                pick(request)
            }).unwrap();
            let cancel = Cancel::new();
            let key = Key { document: DocumentId::preview(1), lineage: generation.lineage, revision: generation.revision, tick: 0., view: View::default(), focus_version: 0 };
            tools.current = Some((key, cancel.clone()));
            let request = Request { press: Press { serial: 1, key, cancel: cancel.clone(), focus: None, point: [0., 0.], selected: None, joint: -1, modifiers: Modifiers::NONE }, source: Arc::new(Source { generation, dropped }), records: Value::Null };
            assert!(tools.lane.as_ref().unwrap().submit(request).is_ok());
            entered_rx.recv_timeout(Duration::from_secs(20)).unwrap();
            if teardown { drop(tools); } else { tools.cancel(); drop(tools); }
            assert!(cancel.is_cancelled());
            finished_rx.recv_timeout(Duration::from_secs(20)).unwrap();
            assert_ne!(dropped_rx.recv_timeout(Duration::from_secs(20)).unwrap(), std::thread::current().id());
        }
    }
}
