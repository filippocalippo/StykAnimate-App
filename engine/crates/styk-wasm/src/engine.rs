//! The engine as JavaScript sees it.

use styk_engine::document::Draft;
use styk_engine::{Budgets, Engine};
use wasm_bindgen::prelude::*;

use crate::{clock, js_error};

/// The engine. Create one, give its [`EngineHandle::address`] to each worker.
#[wasm_bindgen]
pub struct EngineHandle {
    pub(crate) engine: Engine,
    /// Documents being opened (open.rs).
    pub(crate) jobs: crate::open::Jobs,
}

/// A counter JavaScript hands over, if it is an exact nonnegative integer.
pub(crate) fn counter(value: f64) -> Option<u64> {
    (value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0).then_some(value as u64)
}

#[wasm_bindgen]
impl EngineHandle {
    /// `device_memory_gib` is `navigator.deviceMemory` where the browser has it; `memory_maximum_bytes` the
    /// maximum of the memory the page gave the module (D14), which the allocator keeps a reserve of.
    #[wasm_bindgen(constructor)]
    pub fn new(device_memory_gib: Option<f64>, memory_maximum_bytes: Option<f64>) -> EngineHandle {
        if let Some(bytes) = memory_maximum_bytes.filter(|bytes| bytes.is_finite() && *bytes > 0.0) {
            styk_alloc::set_limit(bytes as usize);
        }
        EngineHandle { engine: Engine::with_notifier(clock, Budgets::for_device(device_memory_gib), Some(notify_progress)), jobs: Default::default() }
    }

    /// An address a worker passes to [`worker_run`]. Each call adds one owner.
    pub fn address(&self) -> usize {
        Box::into_raw(Box::new(self.engine.clone())) as usize
    }

    /// Consumes a worker ticket whose message failed to transfer.
    pub fn forget_address(&self, address: usize) {
        if address != 0 {
            // SAFETY: the caller owns the untransferred address produced above.
            drop(unsafe { Box::from_raw(address as *mut styk_engine::Engine) });
        }
    }

    /// Address of the 32-bit progress counter in the module's memory, for
    /// `Atomics.waitAsync`: it changes whenever background work finishes.
    pub fn progress_address(&self) -> usize {
        self.engine.progress().as_ptr() as usize
    }

    /// The open document's `[generation, lineage, revision]` (all zeros before the first document), or
    /// undefined while the engine is busy: this never waits on worker cache or publication locks.
    pub fn try_document_identity(&self) -> Option<Vec<f64>> {
        self.engine.generation_identity_now().map(|identity| identity.map(|value| value as f64).to_vec())
    }

    /// Whether the open document is drawn with the draft that `token` named in [`EngineHandle::set_draft`]:
    /// a publication of the document itself takes a draft out.
    pub fn draft_held(&self, token: f64) -> bool {
        counter(token).is_some_and(|token| self.engine.draft_held(token))
    }

    /// Draws the open document with a draft added until its next publication or [`EngineHandle::clear_draft`]: the
    /// figure definitions `figures` (a JSON array) go after the document's own, and `assignments` (a JSON object, the
    /// object `unique_id` to the id of its layer) joins its layer assignments. This is how the stage draws the cel a
    /// first stroke is about to create, which the document only has once the stroke commits.
    pub fn set_draft(&self, token: f64, figures: &str, assignments: &str) -> Result<(), JsError> {
        let token = counter(token).ok_or_else(|| js_error("the draft token is not a counter"))?;
        let figures = styk_doc::json::parse(figures.as_bytes()).map_err(|_| js_error("the draft's figures are not JSON"))?;
        let assignments = styk_doc::json::parse(assignments.as_bytes()).map_err(|_| js_error("the draft's layer assignments are not JSON"))?;
        let (Some(figures), Some(assignments)) = (figures.as_arr().map(<[_]>::to_vec).or_else(|| (figures.array_len() == Some(0)).then(Vec::new)), assignments.as_obj().cloned()) else {
            return Err(js_error("the draft is a list of figures and an object of layer assignments"));
        };
        self.engine.publish_draft(token, &Draft { figures, assignments }).map(|_| ()).map_err(|error| js_error(error.to_json()))
    }

    /// Takes the draft out of the open document, if it is drawn with one.
    pub fn clear_draft(&self) {
        self.engine.clear_draft();
    }

    /// The interface revision of the open document, or -1 when there is none.
    pub fn revision(&self) -> f64 {
        self.engine.try_generation_header().ok().flatten().map_or(-1.0, |header| header.revision as f64)
    }

    /// Length of the open document in ticks (0 when there is none).
    pub fn total_ticks(&self) -> u32 {
        self.engine.try_generation_header().ok().flatten().map_or(0, |header| header.total_ticks)
    }

    /// Replaces the ticks wanted in the background, most urgent first.
    pub fn request(&self, playhead: u32, ticks: &[u32]) {
        self.engine.request(playhead, ticks);
    }

    /// Replaces fractional sample requests; the interface transfers Float64Array.
    pub fn request_samples(&self, playhead: f64, ticks: &[f64]) {
        self.engine.request_samples(playhead, ticks);
    }

    pub fn frame_ready(&self, tick: f64) -> bool {
        self.engine.frame_ready_at(tick)
    }

    /// A ready frame belongs to this exact generation and settings/resource epoch.
    pub fn frame_ticket_ready(&self, generation: f64, epoch: f64, tick: f64) -> bool {
        let (Some(generation), Some(epoch)) = (counter(generation), counter(epoch)) else { return false; };
        self.engine.frame_matches(tick, generation, epoch)
    }

    /// What the interface draws around a prepared frame (the camera outline, the
    /// background being shown), as the JSON of a keyframe without objects;
    /// `undefined` while the frame is not ready.
    pub fn frame_meta(&self, tick: f64) -> Option<String> {
        let frame = self.engine.frame_metadata(tick)?;
        let generation = frame.generation;
        let epoch = frame.epoch;
        let camera = match frame.camera {
            Some(c) => format!("{{\"x\":{},\"y\":{},\"scale\":{},\"angle_rad\":{},\"is_default\":{}}}", c.x, c.y, c.scale, c.angle, c.is_default),
            None => "null".to_string(),
        };
        let (a, b, mix) = frame.background;
        Some(format!("{{\"tick\":{tick},\"generation\":{generation},\"epoch\":{epoch},\"camera\":{camera},\"background_id\":{a},\"background_id_b\":{b},\"background_mix\":{mix},\"objects\":[]}}"))
    }

    /// Prepares `tick` on the calling thread if needed and describes its draw list as
    /// JSON (`{prims, groups, passes, ms}`); `undefined` when the tick does not exist.
    /// For tests and tools: the interface never needs a frame's contents.
    pub fn frame_info(&self, tick: u32) -> Option<String> {
        let frame = self.engine.frame_now(tick)?;
        Some(format!("{{\"prims\":{},\"groups\":{},\"passes\":{},\"ms\":{:.3}}}", frame.list.prims.len(), frame.list.groups.len() - 1, frame.list.passes.len(), frame.ms))
    }

    /// A per-object description of an evaluated tick, for comparing engine builds.
    pub fn describe_tick(&self, tick: u32) -> Option<String> {
        let generation = self.engine.generation()?;
        Some(styk_eval::describe_tick(&generation.prepared, tick))
    }

    /// Sets the figures hidden for this session, by identity. Hidden layers come from the document.
    pub fn set_hidden(&self, uids: &[u32]) {
        self.engine.set_hidden(uids);
    }

    /// 0=Busy (unchanged), 1=Unchanged, 2=Applied. UI never spins on State.
    pub fn try_set_hidden(&self, uids: &[u32]) -> u32 { self.engine.try_set_hidden(uids) as u32 }

    pub fn try_request_samples(&self, playhead: f64, ticks: &[f64]) -> u32 {
        self.engine.try_request_samples(playhead, ticks) as u32
    }

    /// Prepares frames with or without effects (the editor's effects preview).
    pub fn set_effects(&self, on: bool) {
        self.engine.set_effects(on);
    }

    pub fn try_set_effects(&self, on: bool) -> u32 { self.engine.try_set_effects(on) as u32 }

    /// The id of the open document generation (0 when there is none). Prepared frames
    /// belong to one generation.
    pub fn generation(&self) -> f64 {
        self.engine.try_generation_header().ok().flatten().map_or(0.0, |header| header.generation as f64)
    }

    /// Runs one unit of background work here. For hosts without worker threads.
    pub fn step(&self) -> bool {
        self.engine.step()
    }

    /// Preparation statistics as JSON.
    pub fn stats(&self) -> String {
        let frames = self.engine.try_frame_stats();
        let images = self.engine.try_images_pending();
        let busy = frames.is_none() || images.is_none();
        let s = frames.unwrap_or_default();
        format!(
            "{{\"prepared\":{},\"totalMs\":{:.3},\"worstMs\":{:.3},\"inline\":{},\"cached\":{},\"cachedBytes\":{},\"imagesPending\":{},\"busy\":{busy}}}",
            s.prepared,
            s.total_ms,
            s.worst_ms,
            s.inline,
            s.cached,
            s.cached_bytes,
            images.unwrap_or_default()
        )
    }

    /// Where the module's memory is, as JSON: `heapBytes` (the linear memory), `liveBytes` (handed out by the
    /// allocator), `peakBytes` (the most at once since the last [`EngineHandle::reset_memory_peak`]),
    /// `reservedBytes` (set aside by work in progress), `ceilingBytes` (what requests may reach before they are
    /// refused), and what the engine holds of it: `imagesReadyBytes` (decoded pictures waiting for the
    /// renderer), `frameCacheBytes`, and `picturesRefused` (pictures not decoded for want of memory).
    pub fn memory(&self) -> String {
        #[cfg(target_arch = "wasm32")]
        let heap = std::arch::wasm32::memory_size::<0>() * styk_alloc::PAGE_BYTES;
        #[cfg(not(target_arch = "wasm32"))]
        let heap = 0;
        format!(
            "{{\"heapBytes\":{heap},\"liveBytes\":{},\"peakBytes\":{},\"reservedBytes\":{},\"ceilingBytes\":{},\"picturesRefused\":{},\"imagesReadyBytes\":{},\"frameCacheBytes\":{}}}",
            styk_alloc::live_bytes(),
            styk_alloc::peak_bytes(),
            styk_alloc::reserved_bytes(),
            styk_alloc::ceiling(),
            self.engine.pictures_refused(),
            self.engine.try_images_ready_bytes().map_or(-1, |bytes| bytes as i64),
            self.engine.try_frame_stats().map_or(-1, |stats| stats.cached_bytes as i64)
        )
    }

    /// Starts measuring the most memory handed out at once from what is handed out now.
    pub fn reset_memory_peak(&self) {
        styk_alloc::reset_peak();
    }

    /// Asks every worker to leave [`worker_run`].
    pub fn stop(&self) {
        self.engine.stop();
    }
}

/// A worker thread's whole life: prepares frames until the engine stops.
/// `address` comes from [`EngineHandle::address`] and is consumed.
#[wasm_bindgen]
pub fn worker_run(address: usize) {
    // SAFETY: `address` was produced by `EngineHandle::address` in this memory and is used once.
    let engine = unsafe { Box::from_raw(address as *mut Engine) };
    engine.work();
}

/// Wakes `Atomics.waitAsync` waiters on the progress counter. Runs on whichever
/// thread finished the work.
fn notify_progress(counter: &std::sync::atomic::AtomicU32) {
    thread_local! {
        /// This thread's view of the shared memory (a view cannot cross threads).
        static MEMORY: std::cell::RefCell<Option<js_sys::Int32Array>> = const { std::cell::RefCell::new(None) };
    }
    let index = counter.as_ptr() as u32 / 4;
    MEMORY.with(|cell| {
        let mut view = cell.borrow_mut();
        // A grown memory has a new buffer; the old view no longer covers it.
        if view.as_ref().is_none_or(|view| view.length() <= index) {
            let memory: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
            *view = Some(js_sys::Int32Array::new(&memory.buffer()));
        }
        if let Some(view) = view.as_ref() {
            let _ = js_sys::Atomics::notify(view, index);
        }
    });
}
