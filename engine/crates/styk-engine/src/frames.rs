//! Frame preparation and its cache.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use styk_eval::doc::Camera;
use styk_eval::drawlist::{DrawList, Overrides, encode_with};
use styk_eval::geometry::build;

use crate::{Clock, Engine, Generation};

/// A prepared frame: everything the renderer needs for one tick.
pub struct FrameData {
    pub generation: u64,
    pub tick: f64,
    pub list: Arc<DrawList>,
    /// The scene's camera at this tick.
    pub camera: Option<Camera>,
    /// The scene's backgrounds at this tick: both ids and the mix between them (0 to 255).
    pub background: (u32, u32, f64),
    /// Time spent preparing it.
    pub ms: f32,
}

/// One coherent read of the existing prepared-frame owner. Its epoch also
/// identifies the hidden/effect settings and decoded resource bounds.
pub struct FrameSnapshot {
    pub generation: Arc<Generation>,
    pub frame: Arc<FrameData>,
    pub epoch: u64,
}

/// Preparation totals since the document opened.
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameStats {
    pub prepared: u64,
    pub total_ms: f64,
    pub worst_ms: f32,
    /// Frames prepared on the calling thread because no worker had them ready.
    pub inline: u64,
    pub cached: usize,
    pub cached_bytes: usize,
}

/// Figures the session hides: by identity, and by the layers the document hides.
pub(crate) fn hidden_slots(generation: &Generation, frame: &styk_eval::eval::Frame, hidden_uids: &[u32]) -> Vec<bool> {
    let layers = generation.prepared.doc.layers.as_ref().filter(|layers| !layers.hidden.is_empty());
    if hidden_uids.is_empty() && layers.is_none() {
        return Vec::new();
    }
    frame
        .objects
        .iter()
        .map(|object| hidden_uids.contains(&object.uid) || layers.is_some_and(|layers| layers.hidden.iter().any(|id| id == layers.layer_of(object.uid))))
        .collect()
}

pub(crate) fn produce(generation: &Generation, tick: f64, hidden_uids: &[u32], effects: bool, clock: Clock) -> FrameData {
    let started = clock();
    let prepared = &generation.prepared;
    let frame = prepared.evaluate(tick);
    let scene = build(&prepared.doc, &frame);
    let hidden = hidden_slots(generation, &frame, hidden_uids);
    // Prepared frames are shown through the scene camera, which moves parallax layers,
    // and the generated effects beside a figure with it (`offsetGeneratorBatch`).
    let translations = frame.parallax.as_ref().map(|p| p.translations(&[])).unwrap_or_default();
    // Generated effects, with their targets' earlier positions from the generation's cache.
    let mut batch = generation.anchors.as_ref().filter(|_| effects).and_then(|anchors| {
        let sampler = anchors.sampler(clock, f64::INFINITY);
        styk_eval::vfx::generated::build(prepared, &frame, &scene, Some(tick), Some(&sampler), 1.0)
    });
    if let (Some(batch), Some(parallax), Some(layers)) = (batch.as_mut(), frame.parallax.as_ref(), prepared.doc.layers.as_deref()) {
        batch.offset(|uid| Some(parallax.of_uid(layers, uid)));
    }
    let overrides = Overrides { hidden: &hidden, translations: &translations, bypass_effects: !effects, generators: batch.as_ref(), ..Default::default() };
    let list = Arc::new(encode_with(&prepared.doc, &generation.assets, &scene, &overrides));
    FrameData {
        generation: generation.id,
        tick,
        list,
        camera: scene.camera,
        background: scene.background,
        ms: (clock() - started) as f32,
    }
}

/// A finite, nonnegative sample in the existing frame cache. Integer and fractional
/// callers share these identities; positive and negative zero have one identity.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub(crate) struct Sample(u64);

impl Sample {
    fn new(time: f64) -> Option<Sample> {
        (time.is_finite() && time >= 0.0).then(|| Sample(if time == 0.0 { 0 } else { time.to_bits() }))
    }
    pub(crate) fn time(self) -> f64 { f64::from_bits(self.0) }
    fn ahead(self, playhead: Sample, total: u32) -> f64 {
        (self.time() - playhead.time().rem_euclid(total.max(1) as f64)).rem_euclid(total.max(1) as f64)
    }
}
impl From<u32> for Sample {
    fn from(tick: u32) -> Self { Sample((tick as f64).to_bits()) }
}

mod cache;
pub(crate) use cache::{Cache, Work};

/// Small prepared metadata copied without retaining a dense frame or generation.
#[derive(Clone, Copy, Debug)]
pub struct FrameMetadata {
    pub generation: u64, pub epoch: u64, pub tick: f64,
    pub camera: Option<Camera>, pub background: (u32, u32, f64),
}

/// One coherent scalar generation header. Busy is separate from no document.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenerationHeader {
    pub generation: u64, pub lineage: u64, pub revision: u64, pub total_ticks: u32,
}

pub use cache::Admission as FrameAdmission;

impl Engine {
    pub fn request(&self, playhead: u32, ticks: &[u32]) {
        self.request_keys(Sample::from(playhead), ticks.iter().copied().map(Sample::from).collect(), false);
    }

    pub fn request_samples(&self, playhead: f64, ticks: &[f64]) {
        let Some(playhead) = Sample::new(playhead) else { return; };
        self.request_keys(playhead, ticks.iter().copied().filter_map(Sample::new).collect(), false);
    }

    /// Single UI admission; Busy has not replaced the previous request.
    pub fn try_request_samples(&self, playhead: f64, ticks: &[f64]) -> FrameAdmission {
        let Some(playhead) = Sample::new(playhead) else { return FrameAdmission::Unchanged; };
        self.request_keys(playhead, ticks.iter().copied().filter_map(Sample::new).collect(), true)
    }

    fn request_keys(&self, playhead: Sample, wanted: Vec<Sample>, nonblocking: bool) -> FrameAdmission {
        let old = {
            let mut state = if nonblocking {
                let Some(state) = self.inner.state.try_lock() else { return FrameAdmission::Busy; }; state
            } else { self.inner.state.lock() };
            if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) { return FrameAdmission::Unchanged; }
            let total = state.current.as_ref().map_or(1, |generation| generation.playable_ticks());
            state.frames.request(playhead, total, wanted)
        };
        drop(old); // Request buffers, like frame storage, never drop under State.
        self.inner.state.notify_all();
        FrameAdmission::Applied
    }

    pub fn frame(&self, tick: u32) -> Option<Arc<FrameData>> { self.frame_at(tick as f64) }

    /// A single nonblocking cache read. Never evaluates or repairs a cold sample.
    pub fn frame_at(&self, tick: f64) -> Option<Arc<FrameData>> {
        self.read_prepared(tick, None, |_, frame, _| frame.clone())
    }

    pub fn prepared_frame(&self, time: f64, expected: Option<(u64, u64)>) -> Option<FrameSnapshot> {
        self.read_prepared(time, expected, |generation, frame, epoch| FrameSnapshot {
            generation: generation.clone(), frame: frame.clone(), epoch,
        })
    }

    pub fn frame_matches(&self, time: f64, generation: u64, epoch: u64) -> bool {
        self.read_prepared(time, Some((generation, epoch)), |_, _, _| ()).is_some()
    }

    pub fn frame_ready_at(&self, time: f64) -> bool { self.read_prepared(time, None, |_, _, _| ()).is_some() }

    pub fn frame_metadata(&self, time: f64) -> Option<FrameMetadata> {
        self.read_prepared(time, None, |generation, frame, epoch| FrameMetadata {
            generation: generation.id, epoch, tick: frame.tick, camera: frame.camera, background: frame.background,
        })
    }

    fn read_prepared<R>(&self, time: f64, expected: Option<(u64, u64)>, read: impl FnOnce(&Arc<Generation>, &Arc<FrameData>, u64) -> R) -> Option<R> {
        let tick = Sample::new(time)?;
        let state = self.inner.state.try_lock()?;
        let generation = state.current.as_ref()?;
        let cache = &state.frames;
        if cache.generation != generation.id || expected.is_some_and(|identity| identity != (generation.id, cache.epoch)) { return None; }
        let storage = match cache.storage.try_lock() {
            Ok(storage) => storage,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return None,
        };
        if storage.generation != generation.id || storage.epoch != cache.epoch { return None; }
        let frame = &storage.entries.get(&tick)?.data;
        if frame.generation != generation.id { return None; }
        Some(read(generation, frame, cache.epoch))
    }

    pub fn frame_epoch_current(&self, generation: u64, epoch: u64) -> bool {
        self.inner.state.try_lock().is_some_and(|state| state.current.as_ref().is_some_and(|current| current.id == generation)
            && state.frames.generation == generation && state.frames.epoch == epoch)
    }

    pub fn try_generation_header(&self) -> Result<Option<GenerationHeader>, FrameAdmission> {
        let state = self.inner.state.try_lock().ok_or(FrameAdmission::Busy)?;
        Ok(state.current.as_ref().map(|generation| GenerationHeader {
            generation: generation.id, lineage: generation.lineage, revision: generation.revision, total_ticks: generation.playable_ticks(),
        }))
    }

    /// Try-only generation capture for a worker-bound request. Busy is cold.
    pub fn try_generation(&self) -> Option<Arc<Generation>> { self.inner.state.try_lock()?.current.clone() }

    /// Capture the generation and prepared epoch together even after same-epoch
    /// eviction. The monitor repairs missing samples on its own worker.
    pub fn generation_for_frame_epoch(&self, generation: u64, epoch: u64) -> Option<Arc<Generation>> {
        let state = self.inner.state.try_lock()?;
        let current = state.current.as_ref()?;
        (current.id == generation && state.frames.generation == generation && state.frames.epoch == epoch).then(|| current.clone())
    }

    pub fn frame_now(&self, tick: u32) -> Option<Arc<FrameData>> { self.frame_now_at(tick as f64) }
    pub fn frame_now_at(&self, time: f64) -> Option<Arc<FrameData>> { self.prepared_frame_now_at(time).map(|snapshot| snapshot.frame) }

    /// Worker/CLI preparation returns the actual result even if immediately evicted.
    pub fn prepared_frame_now_at(&self, time: f64) -> Option<FrameSnapshot> {
        let tick = Sample::new(time)?;
        if let Some(ready) = self.prepared_frame(time, None) { return Some(ready); }
        let work = { let state = self.inner.state.lock(); state.frames.work(state.current.clone()) };
        work.prepare_now(self, tick)
    }

    pub fn set_hidden(&self, uids: &[u32]) {
        while self.hidden_admission(uids, false) == FrameAdmission::Busy { std::thread::yield_now(); }
    }

    pub fn try_set_hidden(&self, uids: &[u32]) -> FrameAdmission { self.hidden_admission(uids, true) }

    fn hidden_admission(&self, uids: &[u32], nonblocking: bool) -> FrameAdmission {
        let (before, epoch) = {
            let state = if nonblocking { let Some(state) = self.inner.state.try_lock() else { return FrameAdmission::Busy; }; state } else { self.inner.state.lock() };
            (state.frames.hidden.clone(), state.frames.epoch)
        };
        // Compare/copy outside State. The second guard verifies this actual head.
        let same = &*before == uids;
        let mut replacement = (!same).then(|| Arc::from(uids));
        let (old_hidden, old_request) = {
            let mut state = if nonblocking { let Some(state) = self.inner.state.try_lock() else { return FrameAdmission::Busy; }; state } else { self.inner.state.lock() };
            let cache = &mut state.frames;
            if cache.epoch != epoch || !Arc::ptr_eq(&cache.hidden, &before) { return FrameAdmission::Busy; }
            if same { return FrameAdmission::Unchanged; }
            let old_hidden = std::mem::replace(&mut cache.hidden, replacement.take().expect("changed hidden head"));
            let generation = cache.generation;
            (old_hidden, cache.reset(generation))
        };
        drop((old_hidden, old_request));
        self.inner.state.notify_all();
        FrameAdmission::Applied
    }

    pub fn set_effects(&self, on: bool) { self.effects_admission(on, false); }
    pub fn try_set_effects(&self, on: bool) -> FrameAdmission { self.effects_admission(on, true) }

    fn effects_admission(&self, on: bool, nonblocking: bool) -> FrameAdmission {
        let old_request = {
            let mut state = if nonblocking { let Some(state) = self.inner.state.try_lock() else { return FrameAdmission::Busy; }; state } else { self.inner.state.lock() };
            if state.frames.effects == on { return FrameAdmission::Unchanged; }
            state.frames.effects = on;
            let generation = state.frames.generation;
            state.frames.reset(generation)
        };
        drop(old_request);
        self.inner.state.notify_all();
        FrameAdmission::Applied
    }

    pub fn try_frame_stats(&self) -> Option<FrameStats> { Some(self.inner.state.try_lock()?.frames.summary) }
    pub fn frame_stats(&self) -> FrameStats { self.inner.state.lock().frames.summary }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::cache::Storage as Cache;

    fn frame(generation: u64, tick: u32) -> FrameData {
        FrameData { generation, tick: tick as f64, list: Arc::new(DrawList::default()), camera: None, background: (0, 0, 0.0), ms: 1.0 }
    }

    #[test]
    fn resource_changes_requeue_cached_inflight_and_requested_frames() {
        let mut cache = Cache::new(1024 * 1024);
        cache.reset(7);
        cache.total = 10;
        cache.playhead = 2.into();
        let epoch = cache.epoch;
        cache.finish(7, epoch, 2.into(), Some(frame(7, 2))).unwrap();
        cache.wanted = vec![3.into(), 4.into()];
        assert_eq!(cache.take_wanted(), Some(3.into()));
        cache.invalidate_resources();
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
        let mut rebuilt = Vec::new();
        while let Some(tick) = cache.take_wanted() { rebuilt.push(tick.time()); }
        rebuilt.sort_unstable_by(f64::total_cmp);
        assert_eq!(rebuilt, [2.0, 3.0, 4.0]);
    }

    #[test]
    fn an_old_worker_cannot_finish_or_remove_the_newer_worker_for_the_same_tick() {
        let mut cache = Cache::new(1024 * 1024);
        cache.reset(7);
        cache.wanted = vec![0.into()];
        let old = cache.epoch;
        assert_eq!(cache.take_wanted(), Some(0.into()));
        cache.invalidate_resources();
        let current = cache.epoch;
        assert_eq!(cache.take_wanted(), Some(0.into()));
        assert!(cache.finish(7, old, 0.into(), Some(frame(7, 0))).is_none());
        assert!(cache.inflight.contains(&0.into()), "the new job still owns its tick");
        assert!(cache.finish(7, current, 0.into(), Some(frame(7, 0))).is_some());
        cache.reset(8);
        assert!(cache.finish(7, current, 0.into(), Some(frame(7, 0))).is_none(), "replacement drops old work");
        assert!(cache.entries.is_empty());
    }

    fn sample_frame(generation: u64, tick: Sample) -> FrameData {
        FrameData { generation, tick: tick.time(), list: Arc::new(DrawList::default()), camera: None, background: (0, 0, 0.0), ms: 1.0 }
    }

    #[test]
    fn fractional_resource_invalidation_requeues_exact_samples_and_rejects_old_workers() {
        let mut cache = Cache::new(1024 * 1024);
        cache.reset(7);
        cache.total = 10;
        let half = Sample::new(3.5).unwrap();
        let other = Sample::new(4.25).unwrap();
        cache.playhead = half;
        let old_epoch = cache.epoch;
        cache.finish(7, old_epoch, half, Some(sample_frame(7, half))).unwrap();
        cache.wanted = vec![other];
        assert_eq!(cache.take_wanted(), Some(other));
        cache.invalidate_resources();
        assert_eq!(cache.take_wanted(), Some(half));
        assert_eq!(cache.take_wanted(), Some(other));
        assert!(cache.finish(7, old_epoch, other, Some(sample_frame(7, other))).is_none());
        assert!(cache.inflight.contains(&other), "old worker cannot release newer sample owner");
        assert!(cache.finish(7, cache.epoch, other, Some(sample_frame(7, other))).is_some());
        cache.reset(8);
        assert!(cache.finish(7, old_epoch, half, Some(sample_frame(7, half))).is_none());
    }

    #[test]
    fn fractional_eviction_preserves_exact_playhead_and_existing_byte_budget() {
        let mut cache = Cache::new(700);
        cache.reset(7);
        cache.total = 10;
        let playhead = Sample::new(3.5).unwrap();
        cache.playhead = playhead;
        let epoch = cache.epoch;
        for time in [3.5, 3.0, 4.25, 8.75, 0.5] {
            let sample = Sample::new(time).unwrap();
            cache.finish(7, epoch, sample, Some(sample_frame(7, sample))).unwrap();
        }
        assert!(cache.bytes <= cache.budget);
        assert!(cache.entries.len() < 5);
        assert!(cache.entries.contains_key(&playhead));
        assert_eq!(cache.entries[&playhead].data.tick, 3.5);
    }

}

#[cfg(test)]
#[path = "frames/d7_tests.rs"]
mod d7_tests;
