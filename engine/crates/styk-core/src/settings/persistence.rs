//! Schema-1 transactions and the single-flight settings lane. All parsing and storage work runs off the interface.
use super::{Change, Error, put, string};
use crate::layout::store::SaveQueue;
use std::sync::Arc;
use styk_doc::{Obj, Value};
use styk_services::{
    Cancel, SpawnError, Spawner,
    storage::Storage,
    worker::{Worker, run_future},
};
pub const FILE: &str = "settings.json";
pub const LEGACY: &str = "editor-settings.json";
// Names from today's DEFAULT_EDITOR_SETTINGS; later typed groups extend this same owner.
const LEGACY_KEYS: &[&str] = &[
    "locale",
    "theme",
    "uiScale",
    "uiScaleMode",
    "touchInterface",
    "fingerDraw",
    "hotkeys",
    "timelineMode",
    "replaceKeyframesOnDrop",
    "showHandles",
    "showCamera",
    "showUnselectedHandles",
    "canvasGrid",
    "canvasZoomGesture",
    "smoothZoom",
    "marqueeSelection",
    "pasteDepth",
    "altDragDuplicate",
    "canvasGuideVertical",
    "canvasGuideHorizontal",
    "canvasGuidesLocked",
    "canvasGridSpacing",
    "canvasGridOpacity",
    "canvasGuideX",
    "canvasGuideY",
    "motionPaths",
    "motionPathRange",
    "motionPathLabels",
    "motionPathDots",
    "motionPathAllTargets",
    "motionPathJoints",
    "motionPathSpeed",
    "motionPathRelative",
    "motionPathFalloffRadius",
    "motionPathFalloffShape",
    "autoSizeHandles",
    "outlineHandles",
    "builderShowStaticHandles",
    "builderSmartSnapping",
    "builderHighlightSegment",
    "builderCanvasColor",
    "useBuilderCanvasColor",
    "builderOutlinerWidth",
    "handleSize",
    "onionCount",
    "onionAhead",
    "onionJoined",
    "onionOpacity",
    "onionBefore",
    "onionRangeBefore",
    "onionRangeAfter",
    "onionAfter",
    "onionStep",
    "onionFade",
    "onionTint",
    "onionBeforeColor",
    "onionAfterColor",
    "onionScope",
    "onionMode",
    "onionCamera",
    "onionShowOnTop",
    "onionTimelineMarkers",
    "autoKey",
    "loopPlayback",
    "fitViewOnPlayback",
    "playbackQuality",
    "autosaveSeconds",
    "inspectorSections",
    "exportPreferences",
    "showHomeOnStartup",
    "homeLayout",
    "homeSort",
    "tutorialsDone",
];
pub const MAX_BYTES: usize = 1024 * 1024;

fn blank() -> Value {
    let mut file = Value::object(Obj::new());
    put(&mut file, "schema", Value::Num(1.));
    for key in ["values", "view", "shortcuts", "extra"] {
        put(&mut file, key, Value::object(Obj::new()));
    }
    file
}
fn decode(bytes: &[u8]) -> Result<Value, Error> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::Invalid);
    }
    let value = styk_doc::json::parse(bytes).map_err(|_| Error::Invalid)?;
    if !value.is_object() {
        return Err(Error::Invalid);
    }
    Ok(value)
}
fn schema(value: &Value) -> Result<(), Error> {
    match value.get("schema").and_then(Value::as_f64) {
        Some(n) if n > 1. => Err(Error::NewerSchema),
        Some(1.) => Ok(()),
        _ => Err(Error::Invalid),
    }
}
fn merge(into: &mut Value, patch: &Value) {
    if let Some(entries) = patch.as_obj() {
        for (key, value) in entries.iter() {
            if ["values", "view", "shortcuts", "extra"].contains(&key.as_ref()) {
                let mut section = into.get(key).cloned().unwrap_or_else(|| Value::object(Obj::new()));
                if let Some(fields) = value.as_obj() {
                    for (name, value) in fields.iter() {
                        put(&mut section, name, value.clone());
                    }
                }
                put(into, key, section);
            } else if key.as_ref() != "schema" {
                put(into, key, value.clone());
            }
        }
    }
}
pub fn change_patch(change: &Change) -> Value {
    let mut section = Value::object(Obj::new());
    put(&mut section, change.id.key(), change.new.clone());
    let mut patch = Value::object(Obj::new());
    put(&mut patch, change.id.section(), section);
    patch
}

/// The same service is used by the app worker and tests with K-store's real LocalStorage.
pub struct Store {
    storage: Arc<dyn Storage>,
}
pub struct Loaded {
    pub envelope: Value,
    pub import: Option<Value>,
}
impl Store {
    pub fn new(storage: Arc<dyn Storage>) -> Self {
        Self { storage }
    }
    pub async fn load(&self) -> Result<Loaded, Error> {
        let read = self.storage.load(FILE, MAX_BYTES).await.map_err(|e| Error::Storage(e.to_string()))?;
        if let Some(bytes) = read {
            let envelope = decode(&bytes)?;
            // A future file is readable, but Settings and the transaction independently prohibit writes.
            if schema(&envelope) == Err(Error::Invalid) {
                return Err(Error::Invalid);
            }
            return Ok(Loaded { envelope, import: None });
        }
        let legacy = self.storage.load_legacy(LEGACY, MAX_BYTES).await.map_err(|e| Error::Storage(e.to_string()))?;
        let Some(bytes) = legacy else {
            return Ok(Loaded { envelope: blank(), import: None });
        };
        let old = decode(&bytes)?;
        let mut envelope = blank();
        let mut values = Value::object(Obj::new());
        let mut view = Value::object(Obj::new());
        let mut extra = Value::object(Obj::new());
        for (key, value) in old.as_obj().ok_or(Error::Invalid)?.iter() {
            // Today's stored view preferences, kept separate from user settings. Unknown values stay intact.
            if key.as_ref() == "motionPaths" {
                continue;
            } // Session-only in the Settings design.
            let is_view = key.starts_with("onion")
                || key.starts_with("canvasGrid")
                || key.starts_with("canvasGuide")
                || key.starts_with("motionPath")
                || [
                    "autoKey",
                    "builderSmartSnapping",
                    "builderOutlinerWidth",
                    "inspectorSections",
                    "exportPreferences",
                    "homeLayout",
                    "homeSort",
                    "tutorialsDone",
                ]
                .contains(&key.as_ref());
            if key.as_ref() == "hotkeys" {
                put(&mut envelope, "shortcuts", value.clone());
            } else if is_view {
                put(&mut view, key, value.clone());
            } else if LEGACY_KEYS.contains(&key.as_ref()) {
                put(&mut values, key, value.clone());
            } else {
                put(&mut extra, key, value.clone());
            }
        }
        put(&mut envelope, "values", values);
        put(&mut envelope, "view", view);
        put(&mut envelope, "extra", extra);
        // Normalize the preferences this part consumes through the same typed owner as native changes.
        let mut normalized = super::Settings::default();
        normalized.loaded(envelope.clone());
        for &id in super::SettingId::ALL {
            if old.get(id.key()).is_some() {
                let change = super::Change { id, old: Value::Null, new: normalized.value(id), effects: Vec::new() };
                merge(&mut envelope, &change_patch(&change));
            }
        }
        let mut provenance = Value::object(Obj::new());
        put(&mut provenance, "from", string(LEGACY));
        put(&mut envelope, "imported", provenance);
        Ok(Loaded { import: Some(envelope.clone()), envelope })
    }
    pub async fn save(&self, patch: Value, cancel: &Cancel) -> Result<(), Error> {
        self.storage
            .update(
                FILE,
                MAX_BYTES,
                Box::new(move |old| {
                    let mut envelope = match old {
                        Some(bytes) => decode(bytes),
                        None => Ok(blank()),
                    }
                    .map_err(|_| "settings.invalid".to_string())?;
                    schema(&envelope).map_err(|error| {
                        if error == Error::NewerSchema { "settings.newerSchema" } else { "settings.invalid" }.to_string()
                    })?;
                    merge(&mut envelope, &patch);
                    Ok(styk_doc::json::to_string(&envelope).into_bytes())
                }),
                cancel,
            )
            .await
            .map_err(|e| {
                let message = e.to_string();
                if message.contains("settings.newerSchema") { Error::NewerSchema } else { Error::Storage(message) }
            })
    }
}
enum Request {
    Load,
    Save { patch: Value, cancel: Cancel },
}
pub enum Completion {
    Loaded(Result<Loaded, Error>),
    Saved(Result<(), Error>),
}
pub struct Persistence {
    worker: Worker<Request, Completion>,
    waiting: Option<Request>,
    queue: SaveQueue,
    pending: Value,
    flight: Value,
    cancel: Option<Cancel>,
    loaded: bool,
    read_only: bool,
    retry_at: Option<u64>,
}
impl Persistence {
    pub fn start(spawner: &dyn Spawner, storage: Arc<dyn Storage>, notify: Arc<dyn Fn() + Send + Sync>) -> Result<Self, SpawnError> {
        let store = Store::new(storage);
        let worker = Worker::start(
            spawner,
            "styk settings",
            move |request| match request {
                Request::Load => Completion::Loaded(run_future(store.load())),
                Request::Save { patch, cancel } => Completion::Saved(run_future(store.save(patch, &cancel))),
            },
            notify,
        )?;
        let mut lane = Self {
            worker,
            waiting: Some(Request::Load),
            queue: SaveQueue::default(),
            pending: Value::Null,
            flight: Value::Null,
            cancel: None,
            loaded: false,
            read_only: false,
            retry_at: None,
        };
        lane.queue.mark_changed(0);
        lane.queue.flush(0);
        lane.queue.take_due(0);
        lane.submit(0);
        Ok(lane)
    }
    fn submit(&mut self, now: u64) {
        if let Some(request) = self.waiting.take() {
            self.waiting = self.worker.submit(request).err();
        }
        // A try-lock refusal may have no future worker completion; retain it and schedule admission again.
        self.retry_at = self.waiting.is_some().then_some(now.saturating_add(200));
    }
    pub fn changed(&mut self, change: &Change, now: u64) {
        self.patch(change_patch(change), now);
    }
    fn patch(&mut self, patch: Value, now: u64) {
        merge(&mut self.pending, &patch);
        // The worker serializes the typed patch. Settings has the design's own 1 MiB storage bound;
        // the shared queue supplies scheduling, not the layout file's smaller byte limit.
        self.queue.mark_changed(now);
    }
    pub fn flush(&mut self, now: u64) {
        self.queue.flush(now);
    }
    pub fn deadline(&self) -> Option<u64> {
        [self.retry_at, if !self.read_only { self.queue.deadline() } else { None }].into_iter().flatten().min()
    }
    pub fn idle(&self) -> bool {
        self.loaded && (self.read_only || self.queue.idle()) && self.waiting.is_none()
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }
    pub fn poll(&mut self, now: u64) -> Option<Completion> {
        let answer = self.worker.take();
        match &answer {
            Some(Completion::Loaded(Ok(loaded))) => {
                self.queue.complete(true, now);
                self.loaded = true;
                self.read_only = schema(&loaded.envelope) == Err(Error::NewerSchema);
                if let Some(import) = &loaded.import {
                    let edits = self.pending.clone();
                    self.pending = import.clone();
                    self.patch(edits, now);
                }
            }
            // A corrupt/unreadable file is not permission to replace it with defaults.
            Some(Completion::Loaded(Err(Error::Storage(_)))) => {
                self.queue.complete(false, now);
            }
            Some(Completion::Loaded(Err(_))) => {
                self.queue.complete(true, now);
                self.loaded = true;
                self.read_only = true;
            }
            Some(Completion::Saved(result)) => {
                self.cancel = None;
                if result.is_ok() {
                    // Remove only acknowledged values. Edits made while the write ran remain pending.
                    if let Some(sections) = self.flight.as_obj() {
                        for (section, sent) in sections.iter() {
                            if let Some(fields) = sent.as_obj() {
                                if let Some(current) = self.pending.make_obj().and_then(|v| v.get_mut(section)).and_then(Value::make_obj) {
                                    for (key, value) in fields.iter() {
                                        if current.get(key) == Some(value) {
                                            current.remove(key);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                self.queue.complete(result.is_ok(), now);
                if result == &Err(Error::NewerSchema) {
                    self.read_only = true;
                }
            }
            None => {}
        }
        if !self.read_only && self.waiting.is_none() {
            if self.queue.take_due(now).is_some() {
                if !self.loaded {
                    self.waiting = Some(Request::Load);
                } else {
                    let patch = self.pending.clone();
                    self.flight = patch.clone();
                    let cancel = Cancel::new();
                    self.cancel = Some(cancel.clone());
                    self.waiting = Some(Request::Save { patch, cancel });
                }
            }
        }
        self.submit(now);
        answer
    }
}
impl Drop for Persistence {
    fn drop(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
    }
}
