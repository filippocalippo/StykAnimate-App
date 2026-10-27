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
}

impl Todo {
    fn picture(self) -> crate::images::Picture {
        match self {
            Todo::Image(index) => crate::images::Picture::Image(index),
            Todo::Cel(cel) => crate::images::Picture::Cel(cel),
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
    /// Pictures not yet landed (to decode, decoding, or just decoded), and the ones still to start.
    images_left: usize,
    todo: VecDeque<Todo>,
    /// Pictures being decoded now, and what they will take (estimated).
    decoding: usize,
    decoding_bytes: usize,
    /// Pixels in `images`.
    image_bytes: usize,
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
            let data = produce(&generation, tick as f64, &[], true, clock);
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
            pictures_ready(engine, &generation, &state, &ended, epoch, estimate, decoded);
        });
    }
}

fn pictures_ready(engine: &Engine, generation: &Arc<Generation>, state: &Arc<Shared<State>>, ended: &Arc<AtomicBool>, epoch: u64, estimate: usize, images: Vec<DecodedImage>) {
    {
        let mut state = state.lock();
        if ended.load(Ordering::Relaxed) || epoch != state.epoch {
            return;
        }
        state.images_left = state.images_left.saturating_sub(1);
        state.decoding = state.decoding.saturating_sub(1);
        state.decoding_bytes = state.decoding_bytes.saturating_sub(estimate);
        state.image_bytes += images.iter().map(|image| image.rgba.len()).sum::<usize>();
        state.images.extend(images.into_iter().map(Arc::new));
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

    /// Decoded pictures not yet taken, up to `max_bytes` of pixels (at least one).
    pub fn take_images(&self, max_bytes: usize) -> Vec<Arc<DecodedImage>> {
        let mut taken = Vec::new();
        {
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
        }
        // Room for more pictures: the ones that waited are decoded now.
        start_decoders(&self.engine, &self.generation, &self.state, &self.ended);
        taken
    }

    /// Pictures still being decoded or waiting to be taken.
    pub fn images_pending(&self) -> usize {
        let state = self.state.lock();
        state.images_left + state.images.len()
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
        let data = Arc::new(produce(&self.generation, tick as f64, &[], true, self.engine.inner.clock));
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
}
