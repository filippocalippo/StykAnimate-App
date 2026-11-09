//! Publishing a generation: the replaced generation, its frame cache, image store and owned queued
//! decodes leave the state by moving pointers, and are dropped later by a worker.
//!
//! Everything fresh (the frame cache, the image store, the decode tasks of images the new generation adds) is
//! built before the state lock is taken; under it nothing is allocated or dropped.

use std::sync::Arc;

use crate::{Engine, Generation, State, TaskQueue, frames, images};

/// Opaque worker-owned payload. The interface must never own its last strong reference: dropping it
/// releases the replaced generation's resources.
pub struct PublicationRetirement {
    pub(crate) generation: Option<Arc<Generation>>,
    pub(crate) frames: frames::Cache,
    pub(crate) images: Option<images::Store>,
    pub(crate) tasks: TaskQueue,
}

impl PublicationRetirement {
    pub(crate) fn needs_worker(&self) -> bool {
        self.generation.is_some() || self.frames.has_storage() || self.images.as_ref().is_some_and(images::Store::has_storage) || !self.tasks.is_empty()
    }
}

/// A generation with everything its publication will install, built outside the state lock.
struct Prepared {
    previous: Option<Arc<Generation>>,
    generation: Arc<Generation>,
    frames: Option<frames::Cache>,
    images: Option<images::Store>,
    tasks: TaskQueue,
    same_lineage: bool,
    image_delta: usize,
}

impl Prepared {
    fn new(generation: Arc<Generation>, current: Option<Arc<Generation>>, atlas_pages: u32, preload_stage: bool) -> Self {
        let previous = current.as_ref().filter(|previous| previous.lineage == generation.lineage);
        let count = if preload_stage { generation.prepared.doc.images.len() } else { 0 };
        let known = previous.as_ref().map_or(0, |previous| previous.prepared.doc.images.len().min(count));
        let cels: Vec<usize> = generation.assets.cels.keys().copied().filter(|cel| preload_stage && !previous.as_ref().is_some_and(|old| old.assets.cels.contains_key(cel))).collect();
        let mut tasks = TaskQueue::new();
        // A document whose pictures the stage keeps a few pages at a time decodes their soft copies, and the pictures
        // themselves when a frame needs them.
        for index in known..count {
            tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), images::picture_of_image(&generation, atlas_pages, index)));
        }
        for cel in &cels {
            tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), images::Picture::CelChanged(*cel)));
        }
        if generation.anchors.is_some() {
            for row in 0..styk_eval::vfx::generated::atlas::ROWS {
                if styk_eval::vfx::generated::atlas::ready(row).is_none() {
                    tasks.push_back(crate::OrdinaryTask::Run(Box::new(move |_: &Engine| { styk_eval::vfx::generated::atlas::row(row); })));
                }
            }
        }
        let same_lineage = previous.is_some();
        Self {
            previous: current,
            frames: Some(frames::Cache::new(0)),
            images: Some(images::Store::for_publication(generation.lineage, count + cels.len())),
            same_lineage, image_delta: count - known + cels.len(), generation, tasks,
        }
    }

    /// Whether the state still holds the generation this was prepared against.
    fn current(&self, state: &State) -> bool {
        match (&self.previous, &state.current) {
            (None, None) => true,
            (Some(before), Some(current)) => Arc::ptr_eq(before, current),
            _ => false,
        }
    }

    /// Only pointer/scalar operations. All fresh owners/nodes were built above.
    fn install(&mut self, state: &mut State) -> PublicationRetirement {
        let frames = state.frames.exchange_publication(self.frames.take().expect("prepared once"), self.generation.id);
        let images = if self.same_lineage {
            state.images.grow(self.image_delta);
            None
        } else {
            Some(std::mem::replace(&mut state.images, self.images.take().expect("prepared once")))
        };
        let tasks = if self.same_lineage {
            state.tasks.append(&mut self.tasks);
            TaskQueue::new()
        } else {
            let lineage = state.current.as_ref().map(|generation| generation.lineage);
            let mut retired = TaskQueue::new();
            let mut surviving = TaskQueue::new();
            // Run closures have their own owners. Only this lineage's decodes belong to the
            // replaced publication. Move existing nodes, preserving FIFO and deferring every
            // payload/node destruction until retirement runs outside the shared lock.
            while let Some(mut node) = crate::detach_task(&mut state.tasks) {
                let owned = match node.front().expect("detached task") {
                    crate::OrdinaryTask::Run(_) => false,
                    crate::OrdinaryTask::Decode(generation, _) => Some(generation.lineage) == lineage,
                    crate::OrdinaryTask::Redecode(scope) => Some(scope.lineage) == lineage,
                };
                if owned { retired.append(&mut node); } else { surviving.append(&mut node); }
            }
            surviving.append(&mut self.tasks);
            state.tasks = surviving;
            retired
        };
        let generation = state.current.replace(self.generation.clone());
        PublicationRetirement { generation, frames, images, tasks }
    }
}

impl Engine {
    /// Makes `generation` the engine's document: numbers it, prepares what its publication installs, and
    /// installs it. A publication racing this one makes it prepare again against the new state. Returns the
    /// generation's id and what it replaced.
    pub(crate) fn install_generation(&self, mut generation: Generation) -> (u64, PublicationRetirement) {
        let id = self.inner.next_generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        generation.id = id;
        if styk_eval::vfx::generated::has_generators(&generation.prepared.doc) {
            generation.anchors = Some(Arc::new(crate::anchors::Anchors::new()));
        }
        let generation = Arc::new(generation);
        loop {
            let current = self.inner.state.lock().current.clone();
            let mut prepared = Prepared::new(generation.clone(), current, self.atlas_pages(), self.inner.preload_stage);
            let retirement = {
                let mut state = self.inner.state.lock();
                prepared.current(&state).then(|| prepared.install(&mut state))
            };
            if let Some(retirement) = retirement {
                self.inner.state.notify_all();
                return (id, retirement);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Budgets, OrdinaryTask};
    use std::sync::{Barrier, atomic::{AtomicUsize, Ordering}};

    const DOCUMENT: &[u8] = br#"{"version":5,"canvas_width":20,"canvas_height":20,"fps":12,"figure_types":[],"keyframes":[{"duration_raw":1,"objects":[]}],"backgrounds":[]}"#;

    fn engine() -> Engine {
        let engine = Engine::new(|| 0.0, Budgets::for_device(None));
        engine.open(DOCUMENT, "json", "first").unwrap();
        while engine.step() {}
        engine
    }

    fn held_worker(engine: &Engine) -> (Arc<Barrier>, std::thread::JoinHandle<()>) {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (start, end) = (entered.clone(), release.clone());
        engine.spawn(move |_| { start.wait(); end.wait(); });
        let engine = engine.clone();
        let worker = std::thread::spawn(move || while engine.step() {});
        entered.wait();
        (release, worker)
    }

    #[test]
    fn publication_preserves_queued_runs_before_frames_and_idle_work() {
        let engine = engine();
        let (release, worker) = held_worker(&engine);
        let ran = Arc::new(AtomicUsize::new(0));
        for expected in 0..2 {
            let ran = ran.clone();
            engine.spawn(move |engine| {
                assert!(engine.frame(0).is_none(), "ordinary jobs precede frames");
                assert_eq!(ran.fetch_add(1, Ordering::SeqCst), expected);
            });
        }
        let idle = ran.clone();
        engine.spawn_idle(move |engine| {
            assert!(engine.frame(0).is_some(), "idle work follows frames");
            assert_eq!(idle.load(Ordering::SeqCst), 2);
        });
        engine.open(DOCUMENT, "json", "replacement").unwrap();
        engine.request(0, &[0]);
        release.wait();
        worker.join().unwrap();
        assert_eq!(ran.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn publication_retires_only_replaced_lineage_decodes_and_redecodes() {
        let engine = engine();
        let (release, worker) = held_worker(&engine);
        let old = engine.generation().unwrap();
        let weak = Arc::downgrade(&old);
        let other = Arc::new(Generation { lineage: old.lineage + 100, id: 0, revision: 0,
            prepared: old.prepared.clone(), assets: old.assets.clone(), open_ms: 0.0, anchors: None });
        let mut jobs = TaskQueue::new();
        jobs.push_back(OrdinaryTask::Decode(old.clone(), images::Picture::Image(0)));
        jobs.push_back(OrdinaryTask::Redecode(images::DecodeScope { lineage: old.lineage, epoch: 0 }));
        jobs.push_back(OrdinaryTask::Decode(other.clone(), images::Picture::Image(0)));
        jobs.push_back(OrdinaryTask::Redecode(images::DecodeScope { lineage: other.lineage, epoch: 0 }));
        engine.inner.state.lock().tasks.append(&mut jobs);
        let pointer = &engine.inner.state as *const _ as usize;
        let (_, counts) = crate::allocation::watch(pointer, || engine.open(DOCUMENT, "json", "replacement").unwrap());
        assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
        // Inspect before releasing the worker: cancellation must detach old work, not merely reject its result.
        let remaining: Vec<_> = engine.inner.state.lock().tasks.iter().map(|task| match task {
            OrdinaryTask::Decode(g, _) => g.lineage, OrdinaryTask::Redecode(s) => s.lineage,
            OrdinaryTask::Run(_) => panic!("unexpected run"),
        }).collect();
        drop(old);
        release.wait();
        worker.join().unwrap();
        assert_eq!(remaining, vec![other.lineage, other.lineage]);
        assert!(weak.upgrade().is_none(), "retirement releases the old generation on the worker");
        assert_eq!(engine.pictures_decoded(), 0);
    }
}
