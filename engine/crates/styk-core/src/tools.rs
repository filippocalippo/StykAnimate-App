//! Stage tools own input interpretation, never selection or history. V0 supplies Select's click.
//! Geometry and artwork queries run only on this bounded worker, through the existing pickers.
use std::collections::HashSet;
use std::sync::Arc;
use crate::{answers, documents::{DocumentId, Documents}, engine::Value, frames::FrameDocument, i18n::Msg};
use crate::stage::{Surface, View, input::{Button, Pointer, PointerPhase}};
use styk_services::{Spawner, SpawnError, input::Modifiers, worker::Worker};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Key { document: DocumentId, lineage: u64, revision: u64, tick: f64, view: View }
struct Request {
    serial: u64, key: Key, source: Arc<dyn FrameDocument>, records: Value,
    point: [f64; 2], selected: Option<u32>, joint: i64, modifiers: Modifiers,
}
struct Reply { serial: u64, key: Key, modifiers: Modifiers, hit: Result<Option<(u32, i32)>, Msg> }

/// One submitted query and one latest waiting press. Superseding input invalidates by event identity.
pub struct Tools {
    lane: Worker<Request, Reply>,
    serial: u64,
    waiting: Option<Request>,
    submitted: bool,
    ready: Option<Reply>,
}

impl Tools {
    pub fn start(spawner: &dyn Spawner, wake: Arc<dyn Fn() + Send + Sync>) -> Result<Self, SpawnError> {
        Ok(Self { lane: Worker::start(spawner, "styk-select", pick, wake)?, serial: 0, waiting: None, submitted: false, ready: None })
    }
    pub fn cancel(&mut self) { self.serial = self.serial.wrapping_add(1); self.waiting = None; self.ready = None; }
    pub fn pending(&self) -> bool { self.waiting.is_some() || self.submitted || self.ready.is_some() }

    pub fn pointer(&mut self, pointer: Pointer, documents: &Documents, surface: &Surface) -> Result<(), Msg> {
        if pointer.phase == PointerPhase::Cancel { self.cancel(); return Ok(()); }
        if pointer.phase != PointerPhase::Down || pointer.button != Button::Left { return Ok(()); }
        self.cancel();
        let document = documents.active().ok_or_else(unavailable)?;
        let view = document.view().map_err(|_| unavailable())?;
        let key = Key { document: document.id(), lineage: document.lineage(), revision: document.revision(), tick: view.tick, view: surface.view().ok_or_else(unavailable)? };
        self.waiting = Some(Request { serial: self.serial, key, source: documents.frame_source(document.id()).ok_or_else(unavailable)?,
            records: document.records().map_err(|_| unavailable())?.clone(), point: pointer.point,
            selected: view.selection.uid, joint: view.selection.joint, modifiers: pointer.modifiers });
        self.flush(documents);
        Ok(())
    }
    fn flush(&mut self, documents: &Documents) {
        if self.submitted { return; }
        let published = documents.published();
        if self.waiting.as_ref().is_some_and(|request| published.is_some_and(|(id, rev, _)| id == request.key.document && rev == request.key.revision))
            && let Some(request) = self.waiting.take() {
            match self.lane.submit(request) { Ok(()) => self.submitted = true, Err(request) => self.waiting = Some(request) }
        }
    }
    pub fn progress(&mut self, documents: &mut Documents, surface: Option<&Surface>, session: &mut answers::Session) -> Result<bool, Msg> {
        if let Some(reply) = self.lane.take() { self.submitted = false; self.ready = Some(reply); }
        if self.waiting.as_ref().is_some_and(|request| {
            documents.active().is_none_or(|doc| doc.id() != request.key.document || doc.lineage() != request.key.lineage || doc.revision() != request.key.revision || doc.view().is_ok_and(|view| view.tick != request.key.tick))
                || surface.and_then(Surface::view) != Some(request.key.view)
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

fn unavailable() -> Msg { Msg::new("errors.editorSessions.finishTheCurrentOperationFirst") }

fn pick(request: Request) -> Reply {
    let hit = query(&request).map_err(|_| Msg::new("errors.engineOwner.notSupported"));
    Reply { serial: request.serial, key: request.key, modifiers: request.modifiers, hit }
}

fn query(request: &Request) -> Result<Option<(u32, i32)>, ()> {
    use crate::engine::{geometry, picking};
    let generation = request.source.snapshot(request.key.revision, 0).ok_or(())?;
    let doc = &generation.prepared.doc;
    let frame = generation.prepared.evaluate(request.key.tick);
    let scene = geometry::build_shapes(doc, &frame, None);
    let mut hidden = HashSet::new(); let mut locked = HashSet::new();
    if let Some(layers) = &doc.layers {
        for object in &frame.objects {
            let layer = layers.layer_of(object.uid);
            if layers.hidden.iter().any(|id| id == layer) { hidden.insert(object.uid); }
            if request.records.path(&["_styk", "layers", "byId", layer, "locked"]).is_some_and(Value::truthy) { locked.insert(object.uid); }
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
    let body = styk_export::pick::artwork(&mut styk_export::pick::Picker::default(), doc, &generation.assets, &frame, world, request.key.view.zoom, &hidden, &locked).map_err(|_| ())?;
    if let Some(hit) = prepared.segment(world, &picking::SegmentPickOptions { uid: body.map(|hit| hit.uid), scale: request.key.view.zoom, ..Default::default() }).map_err(|_| ())? {
        let handle = &handles.handles[hit.handle]; return Ok(Some((handle.uid, handle.joint)));
    }
    Ok(body.map(|hit| (hit.uid, -1)))
}
