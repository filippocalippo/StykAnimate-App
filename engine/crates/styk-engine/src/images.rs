//! Image pixels, decoded in the background and handed to the renderer in pieces.

use std::collections::HashSet;
use std::sync::Arc;

use styk_draw::{DrawList, K_BG_IMAGE, K_IMAGE};
use styk_eval::assets::{AtlasEntry, Assets, PAGE};

use crate::{Engine, Generation, TaskQueue};

pub use styk_eval::assets::DecodedImage;

pub(crate) mod residency;

/// What decoding a picture came to: its pixels, or (the memory refused it) the places to write over with nothing.
pub(crate) struct Decoded {
    pub(crate) images: Vec<DecodedImage>,
    pub(crate) cleared: Vec<(u32, u64)>,
}

/// One bounded upload batch. Refused placements contain clearing tiles, not
/// successful picture data; a complete-frame presenter must not acknowledge them.
pub struct PictureBatch {
    pub images: Vec<Arc<DecodedImage>>,
    pub refused: Vec<u64>,
}

/// Takes from `cleared` the places that `max_bytes` of pixels leave room for after `bytes` were taken (one at least when `first`: nothing
/// else was), for the caller to make tiles of with [`styk_eval::assets::blank_tile`] once it has let go of its lock.
pub(crate) fn take_cleared(cleared: &mut Vec<(u32, u64)>, first: bool, bytes: usize, max_bytes: usize) -> Vec<(u32, u64)> {
    let room = max_bytes.saturating_sub(bytes) / styk_eval::assets::BLANK_TILE_BYTES;
    let count = if first { room.max(1) } else { room }.min(cleared.len());
    cleared.split_off(cleared.len() - count)
}
pub use residency::{drawing_pages, has_place, images_on, on_demand, pictures_of, Acquired, PlaceIndex, Residency, ATLAS_PAGES};

/// Which places of a sprite atlas hold their pixels: what a renderer that takes decoded
/// images a slice at a time ([`Engine::take_images`]) has uploaded, so it can tell
/// whether a frame it drew lacks some of its pictures and should be drawn again once
/// they arrive (the stage, `styk-wasm`). A few bytes per picture of the document.
#[derive(Default)]
pub struct Uploaded {
    places: HashSet<u64>,
    /// Places of cels the document replaced since the atlas was laid out, which the new cel was given (a replaced cel's slots go to the
    /// next, [`Assets::extended`]): what they hold is the old cel's until the new one's tiles are in, so a frame that draws them waits.
    refilling: HashSet<u64>,
    /// The numbers of the placements seen ([`Assets::placement`]), the assets they were seen in, and whether any assets were seen before.
    seen: HashSet<u64>,
    assets: u64,
    primed: bool,
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
        self.refilling.clear();
        self.seen.clear();
        self.assets = 0;
        self.primed = false;
    }

    /// The atlas `assets` lays out is the document in front: the cels it placed since the last assets seen (the document replaced
    /// the cels before them) are to be written, so their places hold no pixels until their tiles are in ([`Uploaded::refilling_in`]).
    /// The first assets seen after the atlas was allocated are not new: nothing was there before them.
    pub fn observe(&mut self, assets: &Assets) {
        if self.assets == assets.id() && self.primed {
            return;
        }
        self.assets = assets.id();
        for (serial, written) in assets.placements() {
            if !self.seen.insert(serial) || !self.primed {
                continue;
            }
            for slot in written {
                if let Some(entry) = assets.drawing.get(slot as usize).filter(|entry| entry.valid) {
                    let at = place(entry.layer, entry.x, entry.y);
                    self.places.remove(&at);
                    self.refilling.insert(at);
                }
            }
        }
        self.seen.retain(|serial| assets.holds_placement(*serial));
        self.primed = true;
    }

    /// Whether `list` draws a place that is being refilled with the pixels of the cel that replaced the one it held: a frame that drew
    /// it now would show the old cel's tiles among the new cel's.
    pub fn refilling_in(&self, list: &DrawList) -> bool {
        !self.refilling.is_empty()
            && list.prims.iter().any(|p| match p.kind & 255 {
                K_IMAGE => self.refilling.contains(&record_place(p.b[2], p.c[0], p.c[1])),
                K_BG_IMAGE => self.refilling.contains(&record_place(p.a[2], p.c[0], p.c[1])),
                _ => false,
            })
    }

    /// How many places are waiting for the pixels of the cel that replaced the one they held.
    pub fn refilling(&self) -> usize {
        self.refilling.len()
    }

    /// A live drawing slot was written at the corner `(x, y)` of page `layer`.
    pub fn mark(&mut self, layer: u32, x: u32, y: u32) {
        self.places.insert(place(layer, x, y));
    }

    /// The `count` pages that began at page `from` (the live pages) begin at `to` (greater) now: what was written to them stays.
    pub fn move_pages(&mut self, from: u32, to: u32, count: u32) {
        if to <= from {
            return;
        }
        for k in (0..count).rev() {
            let moved: Vec<u64> = self.places.iter().copied().filter(|place| (place >> 32) as u32 == from + k).collect();
            for place in moved {
                self.places.remove(&place);
                self.places.insert(place & 0xffff_ffff | ((to + k) as u64) << 32);
            }
        }
    }

    /// The pictures of the atlas page `layer` were taken away.
    pub fn forget_page(&mut self, layer: u32) {
        self.places.retain(|place| (place >> 32) as u32 != layer);
    }

    /// Whether the picture laid out at `entry` is in the atlas.
    pub fn has(&self, entry: &AtlasEntry) -> bool {
        self.places.contains(&place(entry.layer, entry.x, entry.y))
    }

    /// How many pictures the atlas holds.
    pub fn len(&self) -> usize {
        self.places.len()
    }

    /// `image` was written into the atlas `assets` lays out. Whether it was not there before.
    pub fn record(&mut self, assets: &Assets, image: &DecodedImage) -> bool {
        let entry: Option<&AtlasEntry> = if image.drawing { assets.drawing.get(image.index as usize) } else { assets.atlas.get(image.index as usize) };
        entry.filter(|e| e.valid).is_some_and(|e| {
            let at = place(e.layer, e.x, e.y);
            self.refilling.remove(&at);
            self.places.insert(at)
        })
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

/// What decoding image `index` of `generation`'s document is for: the image itself, or, when the pages of its pictures
/// are kept a few at a time ([`Residency`]), only its soft copy (the stage asks for the picture when a frame needs it,
/// [`Engine::decode_images`]).
pub(crate) fn picture_of_image(generation: &Generation, atlas_pages: u32, index: usize) -> Picture {
    if residency::on_demand(&generation.assets, atlas_pages) { Picture::Soft(index) } else { Picture::Image(index) }
}

fn pictures_to_decode(generation: &Generation) -> usize {
    generation.prepared.doc.images.len() + generation.assets.cels.len()
}

/// Whether `picture` is a drawing cel that the engine's document does not place as `generation` did: it was replaced, and its slots
/// are another cel's or free.
fn superseded(state: &crate::State, generation: &Generation, picture: Picture) -> bool {
    let (Picture::Cel(cel) | Picture::CelChanged(cel)) = picture else { return false };
    let placement = generation.assets.placement(cel);
    placement != 0 && !state.current.as_ref().is_some_and(|current| current.lineage == generation.lineage && current.assets.holds_placement(placement))
}

/// The pixels decoding `picture` produces, as far as is known without decoding it.
pub(crate) fn estimate(generation: &Generation, picture: Picture) -> usize {
    generation.assets.picture_bytes(picture)
}

/// How many pictures a document kept a few pages at a time decodes at once, in units of the picture budget: a frame
/// waits for the pictures it needs, so they are decoded across the workers instead of one after another (a 4K picture
/// is the budget by itself, and holds about four times that while it is decoded).
const DEMAND_DECODES: usize = 3;

#[derive(Default)]
pub(crate) struct Store {
    /// The document lineage these images belong to.
    lineage: u64,
    /// Decoded and not yet taken by the renderer.
    ready: std::collections::LinkedList<Arc<DecodedImage>>,
    /// Bytes of pixels in `ready`, and the estimated bytes of the pictures being decoded now.
    ready_bytes: usize,
    /// Places a refused decode left to write over with nothing ([`styk_eval::assets::cleared_slots`]), as slot and placement: made into tiles
    /// only as the renderer takes them, so a large refusal never holds a tile for each at once.
    cleared: Vec<(u32, u64)>,
    inflight_bytes: usize,
    /// Pictures to decode that wait for the renderer to take some of the ready ones ([`Budgets::picture_bytes`]).
    parked: TaskQueue,
    /// The stage asks for the pictures it needs ([`Engine::decode_images`]): they are decoded [`DEMAND_DECODES`] at a time.
    demand: bool,
    epoch: u64,
    redecode_pending: bool,
    preparing: Option<DecodeScope>,
    remaining: usize,
    refused_images: HashSet<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DecodeScope { pub(crate) lineage: u64, pub(crate) epoch: u64 }
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
    pub(crate) fn has_storage(&self) -> bool { !self.ready.is_empty() || !self.cleared.is_empty() || !self.parked.is_empty() }

    pub(crate) fn for_publication(lineage: u64, count: usize) -> Self {
        Self { lineage, remaining: count, ..Self::default() }
    }

    /// Whether a picture of about `estimate` bytes may be decoded now: the pictures waiting and being decoded are
    /// under `budget`, or there are none (a picture larger than the budget is decoded alone). Counts it as
    /// being decoded when it may.
    pub(crate) fn admit_decode(&mut self, budget: usize, estimate: usize) -> bool {
        let budget = if self.demand { budget.saturating_mul(DEMAND_DECODES) } else { budget };
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
    pub(crate) fn decode_pixels(&self, generation: &Generation, picture: Picture) -> Decoded {
        self.inner.pictures_decoded.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let before = match picture {
            Picture::Cel(cel) | Picture::CelChanged(cel) => generation.assets.cels.get(&cel).map(|(tiles, _)| (tiles.clone(), tiles.artwork_bounds())),
            Picture::Image(_) | Picture::Soft(_) => None,
        };
        match styk_eval::assets::decode_picture(&generation.prepared.doc, &generation.assets, picture) {
            Ok(decoded) => {
                if let Picture::Image(index) = picture {
                    let mut state = self.inner.state.lock();
                    if state.images.lineage == generation.lineage { state.images.refused_images.remove(&index); }
                }
                if let Some((tiles, bounds)) = before
                    && tiles.artwork_bounds() != bounds
                {
                    self.drawing_bounds_changed(generation, &tiles);
                }
                Decoded { images: decoded, cleared: Vec::new() }
            }
            Err(_) => {
                if let Picture::Image(index) = picture {
                    let mut state = self.inner.state.lock();
                    if state.images.lineage == generation.lineage { state.images.refused_images.insert(index); }
                }
                self.inner.pictures_refused.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                // A cel placed among slots the document had is drawn from slots that hold the pixels of the cel before, until its own are written:
                // a refused cel is written over with nothing, like a picture that cannot be decoded is not shown, so a frame never draws the old.
                Decoded { images: Vec::new(), cleared: styk_eval::assets::cleared_slots(&generation.assets, picture) }
            }
        }
    }

    /// Decodes one picture a worker took from the queue and keeps its pixels for the renderer.
    pub(crate) fn decode_picture(&self, generation: &Arc<Generation>, picture: Picture) {
        let estimate = estimate(generation, picture);
        let epoch = {
            let mut state = self.inner.state.lock();
            if state.images.lineage != generation.lineage { state.images.finish_decode(estimate); return }
            // A cel the document has replaced since gave its slots to the next: nothing is decoded for it.
            if superseded(&state, generation, picture) {
                state.images.finish_decode(estimate);
                state.images.remaining = state.images.remaining.saturating_sub(1);
                return;
            }
            state.images.epoch
        };
        let Decoded { images, mut cleared } = self.decode_pixels(generation, picture);
        let mut ready: std::collections::LinkedList<_> = images.into_iter().map(Arc::new).collect();
        let bytes = ready.iter().map(|image| image.rgba.len()).sum::<usize>();
        let mut state = self.inner.state.lock();
        state.images.finish_decode(estimate);
        if state.images.lineage != generation.lineage || state.images.epoch != epoch { return }
        state.images.remaining = state.images.remaining.saturating_sub(1);
        if superseded(&state, generation, picture) { return }
        state.images.ready_bytes += bytes;
        state.images.ready.append(&mut ready);
        state.images.cleared.append(&mut cleared);
    }

    /// Resource workers can finish an earlier revision's decode after a commit.
    /// Its correction also applies to a current revision that shares that cel.
    pub(crate) fn drawing_bounds_changed(&self, generation: &Generation, cel: &Arc<styk_eval::doc::DrawingTiles>) {
        {
            let mut state = self.inner.state.lock();
            let retained = state.current.as_ref().is_some_and(|current| {
                current.lineage == generation.lineage && current.assets.cels.contains_key(&cel.key())
            });
            if !retained {
                return;
            }
            state.frames.invalidate_resources();
        }
        self.inner.state.notify_all();
    }

    /// Whether every picture the engine was asked to decode is decoded and taken by the renderer: the atlas holds what the document in front
    /// names, so a cel that replaces another can keep the slots of the tiles they share ([`Assets::extended_inheriting`]). `false` when
    /// the state is busy: nothing is kept then.
    pub(crate) fn pictures_settled(&self) -> bool {
        self.inner.state.try_lock().is_some_and(|state| state.images.remaining == 0 && state.images.ready.is_empty() && state.images.cleared.is_empty() && state.images.inflight_bytes == 0 && state.images.parked.is_empty())
    }

    /// Decoded images the renderer has not uploaded yet, up to `max_bytes` of pixels
    /// (at least one image), so one frame never uploads more than it can afford.
    pub fn take_images(&self, max_bytes: usize) -> Vec<Arc<DecodedImage>> {
        self.take_picture_batch(max_bytes).images
    }

    /// As take_images, with explicit refusal provenance for complete-frame hosts.
    pub fn take_picture_batch(&self, max_bytes: usize) -> PictureBatch {
        let mut taken = std::collections::LinkedList::new();
        let mut stale = std::collections::LinkedList::new();
        let mut bytes = 0;
        let blanks;
        let released = {
            let mut state = self.inner.state.lock();
            while let Some(image) = state.images.ready.back() {
                // The tile of a cel whose slots another cel was given since it was decoded would overwrite that cel's: it is dropped.
                if image.placement != 0 && !state.current.as_ref().is_some_and(|current| current.assets.holds_placement(image.placement)) {
                    state.images.ready_bytes = state.images.ready_bytes.saturating_sub(image.rgba.len());
                    let tail = state.images.ready.len() - 1;
                    stale.append(&mut state.images.ready.split_off(tail));
                    continue;
                }
                if !taken.is_empty() && image.rgba.len() > max_bytes.saturating_sub(bytes) { break }
                bytes += image.rgba.len();
                let tail = state.images.ready.len() - 1;
                taken.append(&mut state.images.ready.split_off(tail));
            }
            state.images.ready_bytes = state.images.ready_bytes.saturating_sub(bytes);
            // The places a refused decode left to write over with nothing, as many as the budget leaves room for; those of a cel whose slots
            // another cel was given since are dropped, like its tiles.
            let current = state.current.clone();
            state.images.cleared.retain(|&(_, placement)| current.as_ref().is_some_and(|current| current.assets.holds_placement(placement)));
            blanks = take_cleared(&mut state.images.cleared, taken.is_empty(), bytes, max_bytes);
            let state = &mut *state;
            state.images.release_parked(&mut state.tasks, self.inner.picture_bytes)
        };
        // Pictures that waited for room are decoded now.
        if released { self.inner.state.notify_all(); }
        // Node disposal and output allocation happen after the shared lock.
        drop(stale);
        let refused = blanks.iter().map(|(_, placement)| *placement).collect();
        let images = taken.into_iter().chain(blanks.into_iter().map(|(slot, placement)| Arc::new(styk_eval::assets::blank_tile(slot, placement)))).collect();
        PictureBatch { images, refused }
    }

    /// Decodes pictures of `generation`'s document that a document kept a few pages at a time ([`Residency`]) needs:
    /// images `indices`. `urgent` ones (a frame waits for them) go ahead of the queue, the others (the pictures of
    /// the ticks ahead) behind it. Their pixels reach the renderer through [`Engine::take_images`] like the rest, under
    /// the picture budget ([`DEMAND_DECODES`] times it, for a document kept this way).
    pub fn decode_images(&self, generation: &Arc<Generation>, indices: &[usize], urgent: bool) {
        self.request_picture_jobs(generation, indices.iter().copied().map(Picture::Image), urgent);
    }

    /// Refill evicted drawing cels through the same bounded picture queue and
    /// decoder as initial publication. Callers coalesce requests by placement.
    pub fn decode_cels(&self, generation: &Arc<Generation>, cels: &[usize]) {
        self.request_picture_jobs(generation, cels.iter().copied().map(Picture::Cel), true);
    }

    fn request_picture_jobs(&self, generation: &Arc<Generation>, pictures: impl Iterator<Item=Picture>, urgent: bool) {
        let mut job = crate::TaskQueue::new();
        let mut count = 0;
        for picture in pictures { job.push_back(crate::OrdinaryTask::Decode(generation.clone(), picture)); count += 1; }
        if count == 0 { return; }
        {
            let mut state = self.inner.state.lock();
            if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) || state.images.lineage != generation.lineage { return }
            state.images.remaining += count;
            state.images.demand = true;
            if urgent {
                job.append(&mut state.tasks);
                std::mem::swap(&mut state.tasks, &mut job);
            } else {
                state.tasks.append(&mut job);
            }
        }
        self.inner.state.notify_all();
    }

    /// Moves the decodes of images `indices` that are queued already ahead of the rest of the queue: a frame waits for them now, and
    /// they were asked for behind it, as pictures of the ticks ahead or of a thumbnail. A picture being decoded is on its way.
    pub fn promote_images(&self, generation: &Arc<Generation>, indices: &[usize]) {
        if indices.is_empty() { return }
        let mut state = self.inner.state.lock();
        if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) || state.images.lineage != generation.lineage { return }
        let wanted = |task: &crate::OrdinaryTask| matches!(task, crate::OrdinaryTask::Decode(queued, Picture::Image(index)) if queued.lineage == generation.lineage && indices.contains(index));
        if !state.tasks.iter().any(wanted) { return }
        let (mut front, mut rest) = (crate::TaskQueue::new(), crate::TaskQueue::new());
        while let Some(task) = state.tasks.pop_front() {
            if wanted(&task) { front.push_back(task) } else { rest.push_back(task) }
        }
        front.append(&mut rest);
        state.tasks = front;
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
            let mut fresh = Store::for_publication(generation.lineage, pictures_to_decode(&generation));
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
                tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), picture_of_image(&generation, self.atlas_pages(), index)));
            }
            for &cel in generation.assets.cels.keys() {
                tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), Picture::Cel(cel)));
            }
            let mut fresh = Store::for_publication(generation.lineage, pictures_to_decode(&generation));
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

    /// Refusal is distinct from a malformed/empty picture. Complete-frame hosts
    /// preserve their last picture on refusal instead of acknowledging blanks.
    pub fn images_refused(&self, generation: &Generation, indices: &[u32]) -> bool {
        let state = self.inner.state.lock();
        state.images.lineage == generation.lineage && indices.iter().any(|i| state.images.refused_images.contains(&(*i as usize)))
    }

    /// Actual decoder executions, for worker diagnostics and reuse measurements.
    pub fn pictures_decoded(&self) -> usize { self.inner.pictures_decoded.load(std::sync::atomic::Ordering::Relaxed) }

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
        (state.images.remaining, state.images.ready.len() + state.images.cleared.len())
    }
}

#[cfg(test)]
mod tests;
