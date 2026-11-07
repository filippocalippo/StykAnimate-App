//! Frames for an export (and for thumbnails, which pin a revision the same way).
//!
//! An export draws one revision of the document from its first frame to its last, while
//! the interface may go on drawing the stage. [`ExportFrames`] pins the generation the
//! export started from and evaluates its ticks as playback does, with effects and without
//! the figures hidden for the editing session (exports show what the document shows: its
//! hidden layers stay hidden), a few ticks ahead on the engine's workers. Its pictures are
//! decoded for the export's own renderer, which has its own GPU device.
//!
//! Memory is bounded: at most [`AHEAD`] frames wait to be taken, and decoded images wait
//! only until the renderer takes them: pictures are decoded [`DECODERS`] at a time, and only
//! while the ones waiting are under the engine's picture budget ([`crate::Budgets::picture_bytes`]).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use styk_eval::assets::DecodedImage;

use crate::frames::{produce, FrameData};
use crate::sync::Shared;
use crate::{Engine, Generation};

/// Frames prepared ahead of the one the export draws, at most (the export worker draws as
/// many as six ahead while earlier ones are read back).
pub const AHEAD: usize = 8;

/// Pictures decoded at the same time at most: more than the engine has workers would only wait.
const DECODERS: usize = 8;

/// A picture an export has yet to decode.
#[derive(Clone, Copy)]
enum Todo {
    Image(usize),
    Cel(usize),
    /// A drawing cel an export asked for ([`ExportFrames::request_cels`]), the asker's number for this attempt with it.
    Asked(usize, u64),
    /// A drawing cel decoded for what decoding it does to the document (its artwork bounds, which frames need), its pixels let go.
    Bounds(usize),
}

impl Todo {
    fn picture(self) -> crate::images::Picture {
        match self {
            Todo::Image(index) => crate::images::Picture::Image(index),
            Todo::Cel(cel) | Todo::Bounds(cel) | Todo::Asked(cel, _) => crate::images::Picture::Cel(cel),
        }
    }
}

#[derive(Default)]
struct State {
    epoch: u64,
    ready: HashMap<u32, Arc<FrameData>>,
    inflight: HashSet<u32>,
    /// Requested frames wait here while this renderer preloads its pictures.
    pending: Vec<u32>,
    images: Vec<Arc<DecodedImage>>,
    /// Places a refused decode left to write over with nothing, made into tiles as the renderer takes them ([`crate::images::take_cleared`]).
    cleared: Vec<(u32, u64)>,
    /// Pictures not yet landed (to decode, decoding, or just decoded), and the ones still to start.
    images_left: usize,
    todo: VecDeque<Todo>,
    /// Pictures being decoded now, and what they will take (estimated).
    decoding: usize,
    decoding_bytes: usize,
    /// Pixels in `images`.
    image_bytes: usize,
    /// The export asks for pictures as its frames need them ([`ExportFrames::decode_cels`]): `images_left` counts the drawing cels,
    /// which a frame waits for, and `pictures_left` the pictures asked for, which only the frame that draws them waits for.
    resident: bool,
    pictures_left: usize,
    /// Drawing cels asked for ([`ExportFrames::request_cels`]) that landed, each with the images of its attempt, in the order they landed.
    landed_cels: VecDeque<LandedCel>,
}

/// One attempt to decode a drawing cel an export asked for, as it ended: its images, none when the decode was refused (the memory
/// could not hold its work). Its images travel with it, so that an attempt that ended after a later one for the same cel started
/// (the cel's page left its layer and came back) cannot be mistaken for it.
pub struct LandedCel {
    pub cel: usize,
    /// The number the asker gave this attempt ([`ExportFrames::request_cels`]).
    pub attempt: u64,
    pub images: Vec<Arc<DecodedImage>>,
}

/// Starts the bounded set of requested frames once their resource rectangles
/// are authoritative. No thread waits for PNG decoding to finish.
fn prepare_pending(engine: &Engine, generation: &Arc<Generation>, state: &Arc<Shared<State>>, ended: &Arc<AtomicBool>) {
    let (ticks, epoch) = {
        let mut state = state.lock();
        if ended.load(Ordering::Relaxed) || state.images_left != 0 {
            return;
        }
        (std::mem::take(&mut state.pending), state.epoch)
    };
    for tick in ticks {
        let (generation, state, ended, clock) = (generation.clone(), state.clone(), ended.clone(), engine.inner.clock);
        engine.spawn(move |_| {
            if ended.load(Ordering::Relaxed) {
                return;
            }
            let data = produce(&generation, tick as f64, &[], true, false, clock);
            let mut state = state.lock();
            if ended.load(Ordering::Relaxed) || epoch != state.epoch {
                return;
            }
            state.inflight.remove(&tick);
            state.ready.insert(tick, Arc::new(data));
        });
    }
}

/// Starts decoding the pictures still to do, up to [`DECODERS`] at once and while the pictures waiting to be taken
/// (and those being decoded) are under the engine's picture budget; one is always started when nothing is held,
/// so a picture larger than the budget is decoded alone.
fn start_decoders(engine: &Engine, generation: &Arc<Generation>, state: &Arc<Shared<State>>, ended: &Arc<AtomicBool>) {
    let budget = engine.inner.picture_bytes;
    let (jobs, epoch) = {
        let mut held = state.lock();
        let mut jobs = Vec::new();
        while held.decoding < DECODERS && !held.todo.is_empty() {
            let bytes = held.image_bytes + held.decoding_bytes;
            if bytes >= budget && bytes > 0 { break }
            let todo = held.todo.pop_front().expect("checked above");
            let estimate = crate::images::estimate(generation, todo.picture());
            held.decoding += 1;
            held.decoding_bytes += estimate;
            jobs.push((todo, estimate));
        }
        (jobs, held.epoch)
    };
    for (todo, estimate) in jobs {
        let (generation, state, ended) = (generation.clone(), state.clone(), ended.clone());
        engine.spawn(move |engine| {
            if ended.load(Ordering::Relaxed) {
                return;
            }
            let decoded = engine.decode_pixels(&generation, todo.picture());
            pictures_ready(engine, &generation, &state, &ended, epoch, estimate, todo, decoded);
        });
    }
}

fn pictures_ready(engine: &Engine, generation: &Arc<Generation>, state: &Arc<Shared<State>>, ended: &Arc<AtomicBool>, epoch: u64, estimate: usize, todo: Todo, decoded: crate::images::Decoded) {
    let crate::images::Decoded { images, cleared } = decoded;
    {
        let mut state = state.lock();
        if ended.load(Ordering::Relaxed) || epoch != state.epoch {
            return;
        }
        if state.resident && matches!(todo, Todo::Image(_) | Todo::Cel(_) | Todo::Asked(..)) {
            state.pictures_left = state.pictures_left.saturating_sub(1);
        } else {
            state.images_left = state.images_left.saturating_sub(1);
        }
        state.decoding = state.decoding.saturating_sub(1);
        state.decoding_bytes = state.decoding_bytes.saturating_sub(estimate);
        if !matches!(todo, Todo::Bounds(_)) {
            state.image_bytes += images.iter().map(|image| image.rgba.len()).sum::<usize>();
            let images = images.into_iter().map(Arc::new);
            match todo {
                // A refused attempt lands with no images, and the resident renderer clears the cel's places itself (it knows the layers its
                // pages hold): the places the decode names are not queued, so a refused cel is cleared once, and an attempt that ended
                // after a later one started can never write over the slots of the later one.
                Todo::Asked(cel, attempt) => state.landed_cels.push_back(LandedCel { cel, attempt, images: images.collect() }),
                _ => {
                    state.images.extend(images);
                    state.cleared.extend(cleared);
                }
            }
        }
    }
    start_decoders(engine, generation, state, ended);
    prepare_pending(engine, generation, state, ended);
}

/// The frames and pictures of one export. Dropping it abandons work not yet done.
pub struct ExportFrames {
    engine: Engine,
    generation: Arc<Generation>,
    state: Arc<Shared<State>>,
    /// Set when the export ends: tasks still queued do nothing.
    ended: Arc<AtomicBool>,
}

impl Engine {
    /// Pins the open document for an export, when it is the interface's `revision`.
    pub fn export_frames(&self, revision: u64) -> Result<ExportFrames, String> {
        let generation = self.generation().ok_or("no document is open")?;
        if generation.revision != revision {
            return Err(format!("the engine holds revision {} of the document, the export is of revision {revision}", generation.revision));
        }
        if generation.playable_ticks() == 0 {
            return Err("the document has no frames yet".into());
        }
        Ok(ExportFrames { engine: self.clone(), generation, state: Arc::new(Shared::new(State::default())), ended: Arc::new(AtomicBool::new(false)) })
    }
}

impl ExportFrames {
    pub fn generation(&self) -> &Arc<Generation> {
        &self.generation
    }

    /// Ticks of the pinned document.
    pub fn ticks(&self) -> u32 {
        self.generation.playable_ticks()
    }

    /// The artwork of `tick` as the drawing workspace samples it for fills and the magic wand:
    /// the figures the document shows, on transparency (no background), without effects, the
    /// scene camera or parallax. Evaluated on the calling thread: a worker's.
    pub fn composite(&self, tick: u32) -> Arc<styk_eval::drawlist::DrawList> {
        let prepared = &self.generation.prepared;
        let frame = prepared.evaluate(tick as f64);
        let scene = styk_eval::geometry::build(&prepared.doc, &frame);
        let hidden = crate::frames::hidden_slots(&self.generation, &frame, &[]);
        let overrides = styk_eval::drawlist::Overrides { hidden: &hidden, background: Some(0), bypass_effects: true, ..Default::default() };
        Arc::new(styk_eval::drawlist::encode_with(&prepared.doc, &self.generation.assets, &scene, &overrides))
    }

    /// Decodes every image and drawing cel of the document on the engine's workers.
    pub fn decode_images(&self) {
        self.decode_images_since(None);
    }

    /// Decodes on the engine's workers the pictures `since` did not have: the images an
    /// earlier generation of the same lineage (whose decoded pictures the caller keeps, at
    /// the same atlas places, `Assets::extended`) did not hold, and the drawing cels it had
    /// not placed. Every picture when `since` is `None` or of another lineage.
    pub fn decode_images_since(&self, since: Option<&Generation>) {
        let generation = &self.generation;
        let count = generation.prepared.doc.images.len();
        let since = since.filter(|earlier| earlier.lineage == generation.lineage);
        let known = since.map_or(0, |earlier| earlier.prepared.doc.images.len().min(count));
        let todo: VecDeque<Todo> = (known..count).map(Todo::Image).chain(generation.assets.cels.keys().copied().filter(|cel| !since.is_some_and(|earlier| earlier.assets.cels.contains_key(cel))).map(Todo::Cel)).collect();
        {
            let mut state = self.state.lock();
            let remaining = todo.len();
            if remaining != 0 {
                state.epoch = state.epoch.wrapping_add(1);
                let mut redo: Vec<_> = state.ready.keys().chain(state.inflight.iter()).copied().collect();
                redo.sort_unstable();
                redo.dedup();
                state.inflight = redo.iter().copied().collect();
                state.pending = redo;
                state.ready.clear();
            }
            state.images_left = remaining;
            state.todo = todo;
            // Pictures an earlier call still decodes land nowhere (their epoch is over).
            state.decoding = 0;
            state.decoding_bytes = 0;
        }
        start_decoders(&self.engine, generation, &self.state, &self.ended);
        prepare_pending(&self.engine, generation, &self.state, &self.ended);
    }

    /// Makes this export one that asks for its pictures and its drawing cels as its frames need them
    /// ([`ExportFrames::request_pictures`], [`ExportFrames::request_cels`]): those of a long document are not all in memory at once.
    /// The cels are decoded once now, for what decoding does to the document (their artwork bounds, which every frame is made from),
    /// and their pixels let go; a frame waits for that and for nothing else here.
    pub fn decode_cels(&self) {
        let generation = &self.generation;
        let todo: VecDeque<Todo> = generation.assets.cels.keys().copied().map(Todo::Bounds).collect();
        {
            let mut state = self.state.lock();
            let remaining = todo.len();
            state.epoch = state.epoch.wrapping_add(1);
            let mut redo: Vec<_> = state.ready.keys().chain(state.inflight.iter()).copied().collect();
            redo.sort_unstable();
            redo.dedup();
            state.inflight = redo.iter().copied().collect();
            state.pending = redo;
            state.ready.clear();
            state.resident = true;
            state.images_left = remaining;
            state.pictures_left = 0;
            state.landed_cels.clear();
            state.todo = todo;
            state.images.clear();
            state.cleared.clear();
            state.image_bytes = 0;
            state.decoding = 0;
            state.decoding_bytes = 0;
        }
        start_decoders(&self.engine, generation, &self.state, &self.ended);
        prepare_pending(&self.engine, generation, &self.state, &self.ended);
    }

    /// Asks the engine's workers for the pictures `pictures` (indices into the document's images; each once: the caller keeps
    /// what it asked for). They land in [`ExportFrames::take_images`].
    pub fn request_pictures(&self, pictures: &[u32]) {
        {
            let mut state = self.state.lock();
            for &picture in pictures {
                state.todo.push_back(Todo::Image(picture as usize));
                state.pictures_left += 1;
            }
        }
        start_decoders(&self.engine, &self.generation, &self.state, &self.ended);
    }

    /// Asks the engine's workers for the drawing cels `cels` (keys of the document's cels, each with the asker's number for this
    /// attempt): each lands, with its images or none, in [`ExportFrames::take_landed_cels`] under that number. A cel asked for again
    /// is decoded again, and the first attempt still lands: the asker tells them apart by the numbers.
    pub fn request_cels(&self, cels: &[(usize, u64)]) {
        {
            let mut state = self.state.lock();
            for &(cel, attempt) in cels {
                state.todo.push_back(Todo::Asked(cel, attempt));
                state.pictures_left += 1;
            }
        }
        start_decoders(&self.engine, &self.generation, &self.state, &self.ended);
    }

    /// The cels asked for that have been decoded and not yet taken, in the order they landed, up to `max_bytes` of pixels (at least one).
    pub fn take_landed_cels(&self, max_bytes: usize) -> Vec<LandedCel> {
        let mut taken = Vec::new();
        {
            let mut state = self.state.lock();
            let mut bytes = 0;
            while let Some(landed) = state.landed_cels.front() {
                let size = landed.images.iter().map(|image| image.rgba.len()).sum::<usize>();
                if !taken.is_empty() && bytes + size > max_bytes {
                    break;
                }
                bytes += size;
                taken.push(state.landed_cels.pop_front().expect("checked above"));
            }
            state.image_bytes = state.image_bytes.saturating_sub(bytes);
        }
        start_decoders(&self.engine, &self.generation, &self.state, &self.ended);
        taken
    }

    /// Pictures asked for that are being decoded or wait to be taken (an export that asks for them: [`ExportFrames::decode_cels`]).
    pub fn pictures_in_flight(&self) -> usize {
        let state = self.state.lock();
        state.pictures_left + state.images.len() + state.landed_cels.len()
    }

    /// Drawing cels still to be decoded, which frames wait for, in an export that asks for its pictures; every picture otherwise.
    pub fn images_left(&self) -> usize {
        self.state.lock().images_left
    }

    /// Decoded pictures not yet taken, up to `max_bytes` of pixels (at least one).
    pub fn take_images(&self, max_bytes: usize) -> Vec<Arc<DecodedImage>> {
        let mut taken = Vec::new();
        let blanks = {
            let mut state = self.state.lock();
            let mut bytes = 0;
            while let Some(image) = state.images.last() {
                if !taken.is_empty() && bytes + image.rgba.len() > max_bytes {
                    break;
                }
                bytes += image.rgba.len();
                taken.push(state.images.pop().expect("checked above"));
            }
            state.image_bytes = state.image_bytes.saturating_sub(bytes);
            crate::images::take_cleared(&mut state.cleared, taken.is_empty(), bytes, max_bytes)
        };
        taken.extend(blanks.into_iter().map(|(slot, placement)| Arc::new(styk_eval::assets::blank_tile(slot, placement))));
        // Room for more pictures: the ones that waited are decoded now.
        start_decoders(&self.engine, &self.generation, &self.state, &self.ended);
        taken
    }

    /// Pictures still being decoded or waiting to be taken.
    pub fn images_pending(&self) -> usize {
        let state = self.state.lock();
        state.images_left + state.images.len() + state.cleared.len()
    }

    /// Asks the engine's workers for `ticks` (the ones after the frame being drawn), at most
    /// [`AHEAD`] of them waiting or in progress at a time.
    pub fn prefetch(&self, ticks: impl IntoIterator<Item = u32>) {
        let total = self.ticks();
        {
            let mut state = self.state.lock();
            for tick in ticks {
                if state.ready.len() + state.inflight.len() >= AHEAD {
                    break;
                }
                if tick >= total || state.ready.contains_key(&tick) || state.inflight.contains(&tick) {
                    continue;
                }
                state.inflight.insert(tick);
                state.pending.push(tick);
            }
        }
        prepare_pending(&self.engine, &self.generation, &self.state, &self.ended);
    }

    /// The frame of `tick`: prepared ahead, or evaluated here when no worker has it;
    /// `None` while a worker is still preparing it (wait for the engine's progress counter).
    pub fn take(&self, tick: u32) -> Option<Arc<FrameData>> {
        let epoch = {
            let mut state = self.state.lock();
            if state.images_left != 0 {
                return None;
            }
            if let Some(frame) = state.ready.remove(&tick) {
                return Some(frame);
            }
            if state.inflight.contains(&tick) {
                return None;
            }
            state.epoch
        };
        if tick >= self.ticks() {
            return None;
        }
        let data = Arc::new(produce(&self.generation, tick as f64, &[], true, false, self.engine.inner.clock));
        let state = self.state.lock();
        (state.epoch == epoch && state.images_left == 0).then_some(data)
    }

    /// The frame of `tick` if a worker has prepared it, left in place; never evaluated here
    /// (the interface thread asks this for thumbnails, which it may not evaluate, D7).
    pub fn ready(&self, tick: u32) -> Option<Arc<FrameData>> {
        let state = self.state.lock();
        if state.images_left != 0 { None } else { state.ready.get(&tick).cloned() }
    }

    /// Frames prepared ahead and not yet taken, or being prepared (at most [`AHEAD`]).
    pub fn waiting(&self) -> usize {
        let state = self.state.lock();
        state.ready.len() + state.inflight.len()
    }

    /// Drops frames prepared for ticks the export will not draw (another range, a retry).
    pub fn forget(&self) {
        self.state.lock().ready.clear();
    }
}

impl Drop for ExportFrames {
    fn drop(&mut self) {
        self.ended.store(true, Ordering::Relaxed);
        let mut state = self.state.lock();
        state.ready.clear();
        state.images.clear();
        state.cleared.clear();
        state.landed_cels.clear();
        state.image_bytes = 0;
        state.todo.clear();
        state.pending.clear();
        state.inflight.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Budgets;

    fn clock() -> f64 { 0.0 }

    /// The drawing fixture opened by an engine whose pictures may wait only up to `picture_bytes`, and an export of
    /// it that has its cel to decode three times.
    fn export(picture_bytes: usize) -> (Engine, ExportFrames) {
        let engine = Engine::new(clock, Budgets { picture_bytes, ..Budgets::for_device(None) });
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
        engine.open(&std::fs::read(file).unwrap(), "json", "pictures").unwrap();
        while engine.step() {}
        let _ = engine.take_images(usize::MAX);
        let frames = engine.export_frames(0).unwrap();
        let cel = *frames.generation.assets.cels.keys().next().unwrap();
        {
            let mut state = frames.state.lock();
            state.todo.extend([Todo::Cel(cel); 3]);
            state.images_left = 3;
        }
        start_decoders(&engine, &frames.generation, &frames.state, &frames.ended);
        (engine, frames)
    }

    #[test]
    fn an_export_decodes_a_picture_only_while_the_ones_it_has_not_taken_are_under_the_budget() {
        let (engine, frames) = export(usize::MAX);
        while engine.step() {}
        let total = frames.take_images(usize::MAX).len();
        assert_eq!(frames.images_pending(), 0);

        let (engine, frames) = export(1);
        while engine.step() {}
        let first = frames.take_images(usize::MAX).len();
        assert_eq!(first * 3, total, "a picture at a time: the one decoded first leaves no room");
        assert_eq!(frames.state.lock().todo.len(), 1, "the third waits");
        let mut taken = first;
        for _ in 0..4 {
            while engine.step() {}
            taken += frames.take_images(usize::MAX).len();
        }
        assert_eq!(taken, total, "every picture arrives, as the renderer takes the ones before it");
        assert_eq!(frames.images_pending(), 0);
        assert_eq!(frames.state.lock().image_bytes, 0);
    }

    /// An export that asks for its pictures waits for the drawing cels and nothing else: its frames are made while no picture is in,
    /// and a picture asked for lands by itself.
    #[test]
    fn a_resident_export_waits_for_its_cels_only_and_gets_a_picture_when_it_asks() {
        let engine = Engine::new(clock, Budgets::for_device(None));
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/sticknodes-sprites.json");
        engine.open(&std::fs::read(file).unwrap(), "json", "pictures").unwrap();
        while engine.step() {}
        let _ = engine.take_images(usize::MAX);
        let frames = engine.export_frames(0).unwrap();
        let picture = frames.generation().assets.atlas.iter().position(|entry| entry.valid).expect("the fixture has a picture") as u32;
        frames.decode_cels();
        while engine.step() {}
        assert_eq!(frames.images_left(), 0, "a document without cels leaves nothing for a frame to wait for");
        assert!(frames.take(0).is_some(), "a frame is not held back by pictures nobody asked for");
        assert_eq!(frames.pictures_in_flight(), 0, "nothing was asked for");
        frames.request_pictures(&[picture]);
        assert_eq!(frames.pictures_in_flight(), 1);
        while engine.step() {}
        let landed = frames.take_images(usize::MAX);
        assert_eq!(landed.iter().filter(|image| !image.drawing && !image.soft && image.index == picture).count(), 1);
        assert_eq!(frames.pictures_in_flight(), 0);
    }

    /// A cel is decoded once up front for its bounds and its pixels let go; a cel asked for lands with its images and says how many.
    #[test]
    fn a_resident_export_lets_go_of_the_cels_it_decodes_up_front_and_gets_one_when_it_asks() {
        let engine = Engine::new(clock, Budgets::for_device(None));
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
        engine.open(&std::fs::read(file).unwrap(), "json", "pictures").unwrap();
        while engine.step() {}
        let _ = engine.take_images(usize::MAX);
        let frames = engine.export_frames(0).unwrap();
        let cel = *frames.generation().assets.cels.keys().next().expect("the fixture has a cel");
        frames.decode_cels();
        while engine.step() {}
        assert_eq!(frames.images_left(), 0, "the cel was decoded for its bounds");
        assert!(frames.take_images(usize::MAX).is_empty(), "and its pixels were not kept");
        assert!(frames.take_landed_cels(usize::MAX).is_empty(), "nobody asked for it");
        frames.request_cels(&[(cel, 7)]);
        assert_eq!(frames.pictures_in_flight(), 1);
        while engine.step() {}
        let landed = frames.take_landed_cels(usize::MAX);
        assert!(frames.take_images(usize::MAX).is_empty(), "a cel's images come with the attempt that decoded them");
        assert_eq!(landed.len(), 1);
        assert_eq!((landed[0].cel, landed[0].attempt), (cel, 7));
        assert!(!landed[0].images.is_empty() && landed[0].images.iter().all(|image| image.drawing));
        assert_eq!(frames.pictures_in_flight(), 0);
    }

    /// A cel asked for twice (its page left its layer and came back before the first attempt ended) lands twice, each time under the
    /// number its attempt was asked for with and with the images of that attempt, whatever the order they end in: a refusal that ends
    /// after a success is still the first attempt's, and tells nothing of the second's tiles.
    #[test]
    fn the_attempts_to_decode_a_cel_land_each_with_its_own_images_in_whatever_order_they_end() {
        let engine = Engine::new(clock, Budgets::for_device(None));
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
        engine.open(&std::fs::read(file).unwrap(), "json", "pictures").unwrap();
        while engine.step() {}
        let _ = engine.take_images(usize::MAX);
        let frames = engine.export_frames(0).unwrap();
        let cel = *frames.generation().assets.cels.keys().next().expect("the fixture has a cel");
        frames.decode_cels();
        while engine.step() {}
        // Both attempts decoded, in the order they were asked.
        frames.request_cels(&[(cel, 1), (cel, 2)]);
        while engine.step() {}
        let landed = frames.take_landed_cels(usize::MAX);
        assert_eq!(landed.iter().map(|l| l.attempt).collect::<Vec<_>>(), [1, 2]);
        assert!(landed.iter().all(|l| l.cel == cel && !l.images.is_empty()));
        assert_eq!(landed[0].images.len(), landed[1].images.len(), "each attempt came with the whole cel");
        assert_eq!(frames.pictures_in_flight(), 0);
        // The second ends first and the first is refused (it comes with nothing): the records keep their numbers and their images.
        let epoch = frames.state.lock().epoch;
        let tiles: Vec<DecodedImage> = landed[1].images.iter().map(|image| DecodedImage { index: image.index, drawing: true, soft: false, width: image.width, height: image.height, rgba: image.rgba.clone(), placement: 0 }).collect();
        let count = tiles.len();
        pictures_ready(&engine, frames.generation(), &frames.state, &frames.ended, epoch, 0, Todo::Asked(cel, 2), crate::images::Decoded { images: tiles, cleared: Vec::new() });
        pictures_ready(&engine, frames.generation(), &frames.state, &frames.ended, epoch, 0, Todo::Asked(cel, 1), crate::images::Decoded { images: Vec::new(), cleared: Vec::new() });
        assert_eq!(frames.pictures_in_flight(), 2, "two attempts wait to be taken");
        let landed = frames.take_landed_cels(usize::MAX);
        assert_eq!(landed.iter().map(|l| (l.attempt, l.images.len())).collect::<Vec<_>>(), [(2, count), (1, 0)]);
        assert_eq!(frames.pictures_in_flight(), 0);
    }

    /// An export that ends while one attempt at a cel has landed and another is still to be decoded holds nothing: the queued task
    /// keeps the export's state alive until it runs (or for good, if the workers stop), so what the state holds must be let go by the drop.
    #[test]
    fn dropping_an_export_lets_go_of_the_cel_attempts_that_landed() {
        let engine = Engine::new(clock, Budgets::for_device(None));
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
        engine.open(&std::fs::read(file).unwrap(), "json", "pictures").unwrap();
        while engine.step() {}
        let _ = engine.take_images(usize::MAX);
        let frames = engine.export_frames(0).unwrap();
        let cel = *frames.generation().assets.cels.keys().next().expect("the fixture has a cel");
        frames.decode_cels();
        while engine.step() {}
        frames.request_cels(&[(cel, 1), (cel, 2)]);
        assert!(engine.step(), "the first attempt runs");
        let state = frames.state.clone();
        {
            let held = state.lock();
            assert_eq!(held.landed_cels.len(), 1, "the first attempt landed");
            assert!(held.image_bytes > 0 && held.landed_cels[0].images.iter().all(|image| image.drawing));
            assert_eq!(held.pictures_left, 1, "the second attempt is still to be decoded");
        }
        drop(frames);
        let held = state.lock();
        assert!(held.landed_cels.is_empty(), "the landed attempt's images are let go with the export");
        assert_eq!(held.image_bytes, 0, "and so are their bytes");
        assert!(held.todo.is_empty() && held.images.is_empty());
    }

    /// A refused decode names the places it would have written. For a cel the resident export asked for the refusal is its attempt landing with
    /// no images, and the renderer clears the cel's places itself (it knows the layers its pages hold): the engine queues none, so the cel is
    /// cleared once and an attempt that ends late cannot write over the slots of a later one. A cel decoded for an export that keeps an earlier
    /// generation's pictures has no such renderer: its places are queued, to be handed out as tiles.
    #[test]
    fn a_refused_attempt_lands_empty_and_queues_no_places_while_a_refused_plain_cel_queues_its_own() {
        let engine = Engine::new(clock, Budgets::for_device(None));
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
        engine.open(&std::fs::read(file).unwrap(), "json", "pictures").unwrap();
        while engine.step() {}
        let _ = engine.take_images(usize::MAX);
        let frames = engine.export_frames(0).unwrap();
        let cel = *frames.generation().assets.cels.keys().next().expect("the fixture has a cel");
        let epoch = frames.state.lock().epoch;
        let refused = || crate::images::Decoded { images: Vec::new(), cleared: vec![(3, 9), (4, 9)] };
        pictures_ready(&engine, frames.generation(), &frames.state, &frames.ended, epoch, 0, Todo::Asked(cel, 5), refused());
        assert!(frames.state.lock().cleared.is_empty(), "the resident export clears the cel itself");
        let landed = frames.take_landed_cels(usize::MAX);
        assert_eq!((landed.len(), landed[0].attempt, landed[0].images.len()), (1, 5, 0), "the refusal lands as an empty attempt");
        pictures_ready(&engine, frames.generation(), &frames.state, &frames.ended, epoch, 0, Todo::Bounds(cel), refused());
        assert!(frames.state.lock().cleared.is_empty(), "a cel decoded for its bounds is not written");
        pictures_ready(&engine, frames.generation(), &frames.state, &frames.ended, epoch, 0, Todo::Cel(cel), refused());
        assert_eq!(frames.state.lock().cleared, [(3, 9), (4, 9)], "a plain cel's places are queued");
        let tiles = frames.take_images(usize::MAX);
        assert_eq!(tiles.iter().map(|tile| tile.index).collect::<Vec<_>>(), [3, 4], "as tiles, one slot each");
        assert!(frames.state.lock().cleared.is_empty());
    }
}
