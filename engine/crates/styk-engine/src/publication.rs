//! Publishing a generation: the replaced generation, its frame cache, image store and queued tasks leave
//! the state in one exchange of pointers, and are dropped later by a worker.
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
    fn new(generation: Arc<Generation>, current: Option<Arc<Generation>>) -> Self {
        let previous = current.as_ref().filter(|previous| previous.lineage == generation.lineage);
        let count = generation.prepared.doc.images.len();
        let known = previous.as_ref().map_or(0, |previous| previous.prepared.doc.images.len().min(count));
        let cels: Vec<usize> = generation.assets.cels.keys().copied().filter(|cel| !previous.as_ref().is_some_and(|old| old.assets.cels.contains_key(cel))).collect();
        let mut tasks = TaskQueue::new();
        for index in known..count {
            tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), images::Picture::Image(index)));
        }
        for cel in &cels {
            tasks.push_back(crate::OrdinaryTask::Decode(generation.clone(), images::Picture::Cel(*cel)));
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
            std::mem::replace(&mut state.tasks, std::mem::take(&mut self.tasks))
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
            let mut prepared = Prepared::new(generation.clone(), current);
            let retirement = {
                let mut state = self.inner.state.lock();
                prepared.current(&state).then(|| prepared.install(&mut state))
            };
            if let Some(retirement) = retirement {
                if let Some(previous) = &retirement.generation {
                    crate::planning::invalidate_generation(self, previous.id);
                }
                self.inner.state.notify_all();
                return (id, retirement);
            }
        }
    }
}
