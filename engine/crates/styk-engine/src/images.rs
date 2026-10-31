//! Image pixels, decoded in the background and handed to the renderer in pieces.

use std::collections::HashSet;
use std::sync::Arc;

use styk_draw::{DrawList, K_BG_IMAGE, K_IMAGE};
use styk_eval::assets::{AtlasEntry, Assets, PAGE};

use crate::{Engine, Generation, TaskQueue};

pub use styk_eval::assets::DecodedImage;

/// Which places of a sprite atlas hold their pixels: what a renderer that takes decoded
/// images a slice at a time ([`Engine::take_images`]) has uploaded, so it can tell
/// whether a frame it drew lacks some of its pictures and should be drawn again once
/// they arrive (the stage, `styk-wasm`). A few bytes per picture of the document.
#[derive(Default)]
pub struct Uploaded {
    places: HashSet<u64>,
}

/// An atlas place by its page and corner (the gutter excluded), as records name it.
fn place(layer: u32, x: u32, y: u32) -> u64 {
    (layer as u64) << 32 | (y as u64) << 16 | x as u64
}

/// The place a record's atlas rectangle starts at: its page and `uv` corner.
fn record_place(layer: f32, u0: f32, v0: f32) -> u64 {
    let page = PAGE as f32;
    place(layer as u32, (u0 * page).round() as u32, (v0 * page).round() as u32)
}

impl Uploaded {
    /// The atlas was allocated again: it holds nothing.
    pub fn clear(&mut self) {
        self.places.clear();
    }

    /// A live drawing slot was written at the corner `(x, y)` of page `layer`.
    pub fn mark(&mut self, layer: u32, x: u32, y: u32) {
        self.places.insert(place(layer, x, y));
    }

    /// How many pictures the atlas holds.
    pub fn len(&self) -> usize {
        self.places.len()
    }

    /// `image` was written into the atlas `assets` lays out.
    pub fn record(&mut self, assets: &Assets, image: &DecodedImage) {
        let entry: Option<&AtlasEntry> = if image.drawing { assets.drawing.get(image.index as usize) } else { assets.atlas.get(image.index as usize) };
        if let Some(e) = entry.filter(|e| e.valid) {
            self.places.insert(place(e.layer, e.x, e.y));
        }
    }

    /// Whether `list` samples an atlas place that holds no pixels yet: a picture or a
    /// drawing cel tile (every display level of a cel is in a list) not uploaded.
    pub fn lacks(&self, list: &DrawList) -> bool {
        list.prims.iter().any(|p| match p.kind & 255 {
            K_IMAGE => !self.places.contains(&record_place(p.b[2], p.c[0], p.c[1])),
            K_BG_IMAGE => !self.places.contains(&record_place(p.a[2], p.c[0], p.c[1])),
            _ => false,
        })
    }
}

pub(crate) use styk_eval::assets::Picture;

/// The pixels decoding `picture` produces, as far as is known without decoding it.
pub(crate) fn estimate(generation: &Generation, picture: Picture) -> usize {
    generation.assets.picture_bytes(picture)
}

#[derive(Default)]
pub(crate) struct Store {
    /// The document lineage these images belong to.
    lineage: u64,
    /// Decoded and not yet taken by the renderer.
    ready: std::collections::LinkedList<Arc<DecodedImage>>,
    /// Bytes of pixels in `ready`, and the estimated bytes of the pictures being decoded now.
    ready_bytes: usize,
    inflight_bytes: usize,
    /// Pictures to decode that wait for the renderer to take some of the ready ones ([`Budgets::picture_bytes`]).
    parked: TaskQueue,
    epoch: u64,
    redecode_pending: bool,
    preparing: Option<DecodeScope>,
    remaining: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DecodeScope { lineage: u64, epoch: u64 }
impl DecodeScope {
    fn current(self, images: &Store) -> bool { (self.lineage, self.epoch) == (images.lineage, images.epoch) }
}

/// All exits (including worker unwind) release only this matching preparation.
/// A replaced lineage/epoch cannot clear a newer worker's selection barrier.
struct Preparation<'a> { engine: &'a Engine, scope: DecodeScope }
impl Drop for Preparation<'_> {
    fn drop(&mut self) {
        {
            let mut state = self.engine.inner.state.lock();
            if state.images.preparing == Some(self.scope) { state.images.preparing = None; state.images.redecode_pending = false; }
        }
        self.engine.inner.state.notify_all();
    }
}

impl Store {
    pub(crate) fn has_storage(&self) -> bool { !self.ready.is_empty() || !self.parked.is_empty() }

    pub(crate) fn for_publication(lineage: u64, count: usize) -> Self {
        Self { lineage, remaining: count, ..Self::default() }
    }

    /// Whether a picture of about `estimate` bytes may be decoded now: the pictures waiting and being decoded are
    /// under `budget`, or there are none (a picture larger than the budget is decoded alone). Counts it as
    /// being decoded when it may.
    pub(crate) fn admit_decode(&mut self, budget: usize, estimate: usize) -> bool {
        let held = self.ready_bytes + self.inflight_bytes;
        if held >= budget && held > 0 { return false }
        self.inflight_bytes += estimate;
        true
    }

    /// A picture admitted by [`Store::admit_decode`] is no longer being decoded (whether or not its pixels are
    /// kept: a store that was replaced meanwhile counts it against whichever store is current, which is never
    /// negative and corrects itself with the next store).
    fn finish_decode(&mut self, estimate: usize) { self.inflight_bytes = self.inflight_bytes.saturating_sub(estimate); }

    /// Keeps a decode task until the renderer has taken pictures. Moves the node; nothing is allocated.
    pub(crate) fn park(&mut self, task: &mut TaskQueue) { self.parked.append(task); }

    /// The pictures waiting for the renderer were taken: the parked tasks go back in front of the queue
    /// when there is room for more.
    fn release_parked(&mut self, tasks: &mut TaskQueue, budget: usize) -> bool {
        if self.parked.is_empty() || self.ready_bytes + self.inflight_bytes >= budget { return false }
        self.parked.append(tasks);
        std::mem::swap(&mut self.parked, tasks);
        true
    }

    pub(crate) fn preparation_active(&self) -> bool { self.preparing.is_some() }
    pub(crate) fn cancel_preparation(&mut self) { self.preparing = None; }
    pub(crate) fn start_preparation(&mut self, scope: DecodeScope) {
        if scope.current(self) && self.redecode_pending { self.preparing = Some(scope); }
    }

    /// A later revision of the same document added `count` images.
    pub fn grow(&mut self, count: usize) {
        self.remaining += count;
    }
}

impl Engine {
    /// The pixels of `picture` of `generation`: the image or every display level of the drawing cel. The decoders
    /// allocate in pieces nothing can refuse, so a picture is decoded only when the memory can hold its work; one it
    /// cannot hold is not shown (like one that cannot be decoded) and the engine goes on ([`Engine::pictures_refused`]).
    pub(crate) fn decode_pixels(&self, generation: &Generation, picture: Picture) -> Vec<DecodedImage> {
        let before = match picture {
            Picture::Cel(cel) => generation.assets.cels.get(&cel).map(|(tiles, _)| (tiles.clone(), tiles.artwork_bounds())),
            Picture::Image(_) => None,
        };
        match styk_eval::assets::decode_picture(&generation.prepared.doc, &generation.assets, picture) {
            Ok(decoded) => {
                if let Some((tiles, bounds)) = before
                    && tiles.artwork_bounds() != bounds
                {
                    self.drawing_bounds_changed(generation, &tiles);
                }
                decoded
            }
            Err(_) => {
                self.inner.pictures_refused.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Vec::new()
            }
        }
    }

    /// Decodes one picture a worker took from the queue and keeps its pixels for the renderer.
    pub(crate) fn decode_picture(&self, generation: &Arc<Generation>, picture: Picture) {
        let estimate = estimate(generation, picture);
        let epoch = {
            let mut state = self.inner.state.lock();
            if state.images.lineage != generation.lineage { state.images.finish_decode(estimate); return }
            state.images.epoch
        };
        let mut ready: std::collections::LinkedList<_> = self.decode_pixels(generation, picture).into_iter().map(Arc::new).collect();
        let bytes = ready.iter().map(|image| image.rgba.len()).sum::<usize>();
        let mut state = self.inner.state.lock();
        state.images.finish_decode(estimate);
        if state.images.lineage != generation.lineage || state.images.epoch != epoch { return }
        state.images.remaining = state.images.remaining.saturating_sub(1);
        state.images.ready_bytes += bytes;
        state.images.ready.append(&mut ready);
    }

    /// Resource workers can finish an earlier revision's decode after a commit.
    /// Its correction also applies to a current revision that shares that cel.
    pub(crate) fn drawing_bounds_changed(&self, generation: &Generation, cel: &Arc<styk_eval::doc::DrawingTiles>) {
        {
            let mut state = self.inner.state.lock();
            let retained = state.current.as_ref().is_some_and(|current| {
                current.lineage == generation.lineage && current.assets.cels.contains_key(&(Arc::as_ptr(cel) as usize))
            });
            if !retained {
                return;
            }
            state.frames.invalidate_resources();
        }
        self.inner.state.notify_all();
    }

    /// Decoded images the renderer has not uploaded yet, up to `max_bytes` of pixels
    /// (at least one image), so one frame never uploads more than it can afford.
    pub fn take_images(&self, max_bytes: usize) -> Vec<Arc<DecodedImage>> {
        let mut taken = std::collections::LinkedList::new();
        let mut bytes = 0;
        let released = {
            let mut state = self.inner.state.lock();
            while let Some(image) = state.images.ready.back() {
                if !taken.is_empty() && image.rgba.len() > max_bytes.saturating_sub(bytes) { break }
                bytes += image.rgba.len();
                let tail = state.images.ready.len() - 1;
                taken.append(&mut state.images.ready.split_off(tail));
            }
            state.images.ready_bytes = state.images.ready_bytes.saturating_sub(bytes);
            let state = &mut *state;
            state.images.release_parked(&mut state.tasks, self.inner.picture_bytes)
        };
        // Pictures that waited for room are decoded now.
        if released { self.inner.state.notify_all(); }
        // Node disposal and output allocation happen after the shared lock.
        taken.into_iter().collect()
    }

    /// Queues one coalesced preparation in the same ordinary worker queue.
    /// Pending counters change immediately, but dense task preparation/disposal
    /// never happens on the caller (a Stage may call this on the interface).
    pub fn redecode_images(&self) {
        let mut job = crate::TaskQueue::new();
        job.push_back(crate::OrdinaryTask::Redecode(DecodeScope { lineage: 0, epoch: 0 }));
        let retired = {
            let mut state = self.inner.state.lock();
            if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) || state.images.redecode_pending { return }
            let Some(generation) = state.current.as_ref() else { return };
            let mut fresh = Store::for_publication(generation.lineage, generation.prepared.doc.images.len() + generation.assets.cels.len());
            fresh.epoch = state.images.epoch.wrapping_add(1);
            fresh.redecode_pending = true;
            *job.front_mut().expect("prebuilt placeholder") = crate::OrdinaryTask::Redecode(DecodeScope { lineage: fresh.lineage, epoch: fresh.epoch });
            let retired = std::mem::replace(&mut state.images, fresh);
            state.tasks.append(&mut job);
            retired
        };
        if retired.has_storage() { self.spawn_retained(move |_| drop(retired)); }
        self.inner.state.notify_all();
    }

    pub(crate) fn prepare_redecode(&self, scope: DecodeScope) {
        let _preparation = Preparation { engine: self, scope };
        loop {
            let (generation, epoch) = {
                let state = self.inner.state.lock();
                if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) || !scope.current(&state.images) || !state.images.redecode_pending || state.images.preparing != Some(scope) { return }
                let Some(generation) = state.current.clone() else { return };
                (generation, state.images.epoch)
            };
            let mut tasks = crate::TaskQueue::new();
            for index in 0..generation.prepared.doc.images.len() {
                tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), Picture::Image(index)));
            }
            for &cel in generation.assets.cels.keys() {
                tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), Picture::Cel(cel)));
            }
            let mut fresh = Store::for_publication(generation.lineage, generation.prepared.doc.images.len() + generation.assets.cels.len());
            fresh.epoch = epoch.wrapping_add(1);
            let retired = {
                let mut state = self.inner.state.lock();
                if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) || !scope.current(&state.images) || !state.images.redecode_pending || state.images.preparing != Some(scope) { return }
                if state.images.epoch != epoch || !state.current.as_ref().is_some_and(|current| Arc::ptr_eq(current, &generation)) { None }
                else {
                    // Decode work precedes commands queued after its preparation
                    // placeholder, exactly as the original immediate enqueue.
                    tasks.append(&mut state.tasks);
                    std::mem::swap(&mut state.tasks, &mut tasks);
                    Some(std::mem::replace(&mut state.images, fresh))
                }
            };
            if let Some(retired) = retired { drop(retired); self.inner.state.notify_all(); return }
        }
    }

    /// Pictures the engine did not decode because it was too low on memory.
    pub fn pictures_refused(&self) -> usize { self.inner.pictures_refused.load(std::sync::atomic::Ordering::Relaxed) }

    /// Images of the open document still being decoded or waiting for upload.
    pub fn images_pending(&self) -> usize {
        let state = self.inner.state.lock();
        state.images.remaining + state.images.ready.len()
    }

    /// Try-only scalar diagnostic; Busy is distinct from complete resources.
    pub fn try_images_pending(&self) -> Option<usize> {
        let state = self.inner.state.try_lock()?;
        Some(state.images.remaining + state.images.ready.len())
    }

    /// Bytes of decoded pixels waiting for [`Engine::take_images`]; `None` while the engine is busy.
    pub fn try_images_ready_bytes(&self) -> Option<usize> {
        let state = self.inner.state.try_lock()?;
        Some(state.images.ready.iter().map(|image| image.rgba.len()).sum())
    }

    /// Images of the open document still being decoded, and decoded ones waiting for
    /// [`Engine::take_images`].
    pub fn images_backlog(&self) -> (usize, usize) {
        let state = self.inner.state.lock();
        (state.images.remaining, state.images.ready.len())
    }
}

#[cfg(test)]
mod tests;
