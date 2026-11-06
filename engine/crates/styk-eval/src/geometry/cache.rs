//! The existing movieclip scene cache, with retained-buffer accounting.
//! Accounting happens after a scene builds; cache hits do not walk geometry.

use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::sync::Arc;

use super::{ObjectSpatial, RigJoint, Scene};
use crate::spatial::MeshGeometry;
use crate::vfx::FrameVfx;

mod budget;
mod resolved;
pub(crate) use resolved::{Resolved, arc_allocation};
pub use budget::SceneBudget;
use budget::Reservation;

#[derive(Debug)]
pub struct RetainedScene {
    // Drop the retained scene reference before releasing its reservation.
    scene: Arc<Scene>,
    _reservation: Reservation,
}
impl RetainedScene {
    /// Borrow the one immutable derived scene while its owning worker lease
    /// charges the lineage. Callers must keep the lease through presentation ACK.
    pub fn scene(&self) -> &Arc<Scene> { &self.scene }
}
impl SceneBudget {
    /// Retain an actual worker-built scene in the SAME lineage budget as its
    /// movieclip caches. Rejection drops no caller payload under a shared lock.
    /// Keep this owner on the worker; its disposal releases the scene first.
    pub fn retain_worker(self: &Arc<Self>, scene: Arc<Scene>) -> Result<RetainedScene, Arc<Scene>> {
        match self.reserve(scene.retained_bytes) {
            Some(reservation) => Ok(RetainedScene { scene, _reservation: reservation }),
            None => Err(scene),
        }
    }
}

/// One movieclip's evaluated local scenes. The entry limit and clear-all
/// eviction policy are the existing owner's; the byte limit additionally
/// bounds retained derived buffers. Each entry also owns a reservation in the
/// typed Document's aggregate lineage budget; shared authored resources remain
/// separate from this derived-scene accounting.
#[derive(Debug)]
pub struct ClipSceneCache {
    entries: HashMap<u64, RetainedScene>,
    bytes: usize,
    budget: usize,
}

impl Default for ClipSceneCache {
    fn default() -> Self {
        Self::with_budget(Self::DEFAULT_BUDGET)
    }
}

impl ClipSceneCache {
    pub const MAX_ENTRIES: usize = 64;
    pub const DEFAULT_BUDGET: usize = 64 * 1024 * 1024;

    pub fn with_budget(budget: usize) -> Self {
        Self { entries: HashMap::new(), bytes: 0, budget }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &u64) -> Option<&Arc<Scene>> {
        self.entries.get(key).map(|entry| &entry.scene)
    }

    /// O(1): sum of the immutable cached scenes' derived-buffer charges.
    pub fn retained_bytes(&self) -> usize {
        self.bytes
    }

    pub fn clear(&mut self) {
        // Release buckets too: touching many clips must not leave every empty
        // cache holding a former 64-entry allocation outside the aggregate cap.
        self.entries = HashMap::new();
        self.bytes = 0;
    }

    /// Called under the clip's existing mutex after an off-thread build. A
    /// simultaneous build may have won publication: return that scene without
    /// replacing it or counting it twice. An oversized result stays usable by
    /// its caller but is not retained by this cache and does not evict others.
    pub(super) fn publish(&mut self, key: u64, scene: Arc<Scene>, shared: &Arc<SceneBudget>) -> Arc<Scene> {
        if let Some(cached) = self.entries.get(&key) {
            return cached.scene.clone();
        }
        let bytes = scene.retained_bytes;
        if bytes > self.budget {
            return scene;
        }
        if self.entries.len() >= Self::MAX_ENTRIES || self.bytes > self.budget - bytes {
            self.clear();
        }
        let Ok(retained) = shared.retain_worker(scene.clone()) else { return scene };
        self.bytes += bytes;
        self.entries.insert(key, retained);
        scene
    }
}

fn buffer<T>(values: &Vec<T>) -> usize {
    values.capacity().saturating_mul(size_of::<T>())
}

fn arc<T>() -> usize {
    size_of::<T>().saturating_add(2 * size_of::<usize>())
}

fn strings(values: &Vec<String>) -> usize {
    values.iter().fold(buffer(values), |bytes, value| bytes.saturating_add(value.capacity()))
}

fn spatial(value: &ObjectSpatial) -> usize {
    [arc::<ObjectSpatial>(), buffer(&value.frames), buffer(&value.depths), buffer(&value.authored), buffer(&value.start_raws)]
        .into_iter().fold(0usize, usize::saturating_add)
}

fn mesh(value: &MeshGeometry) -> usize {
    [arc::<MeshGeometry>(), buffer(&value.positions), buffer(&value.depth), buffer(&value.triangles), buffer(&value.materials), buffer(&value.z), buffer(&value.colors)]
        .into_iter().fold(0usize, usize::saturating_add)
}

/// The evaluated containers/stacks, including resolved payloads above.
fn vfx(value: &FrameVfx, resolved: &mut Resolved) -> usize {
    let mut bytes = [arc::<FrameVfx>(), buffer(&value.scene), buffer(&value.objects), buffer(&value.roots), buffer(&value.generators), strings(&value.warnings)]
        .into_iter().fold(0usize, usize::saturating_add);
    resolved.stack(&value.scene);
    for generator in &value.generators {
        resolved.effect(&generator.effect);
    }
    for object in value.objects.iter().flatten() {
        bytes = bytes.saturating_add(buffer(&object.figure)).saturating_add(buffer(&object.segments));
        resolved.stack(&object.figure);
        for (_, stack) in &object.segments {
            bytes = bytes.saturating_add(buffer(stack));
            resolved.stack(stack);
        }
        if let Some(attached) = &object.attached {
            bytes = bytes.saturating_add(buffer(&attached.stack)).saturating_add(buffer(&attached.members));
            resolved.stack(&attached.stack);
        }
    }
    bytes
}

impl Scene {
    /// Recompute this scene's derived-buffer charge. The geometry builder calls
    /// this once after all splices. A native caller mutating public scene buffers
    /// can call it explicitly; immutable cache reads use `retained_bytes` only.
    ///
    /// Vec capacities, inline scene/object data and derived Arc allocations are
    /// counted. Repeated derived Arcs within this scene are charged once; they
    /// are conservatively charged again in another cached scene. Resolved
    /// effect/paint payloads are charged even when source-owned, so scene-only
    /// tweens cannot escape the budget. Shared typed figures/documents and
    /// allocator overhead are excluded: this is not a whole-document/process
    /// memory measurement or limit.
    pub fn account_buffers(&mut self) {
        let mut bytes = [arc::<Scene>(), buffer(&self.objects), buffer(&self.items), buffer(&self.points), buffer(&self.figures), buffer(&self.figure_of), strings(&self.warnings),
            buffer(&self.owners), buffer(&self.owner_scales), buffer(&self.chains), buffer(&self.clip_vfx), buffer(&self.meshes), buffer(&self.depths), buffer(&self.transitions), buffer(&self.measured)]
            .into_iter().fold(0usize, usize::saturating_add);
        let mut spaces = HashSet::new();
        let mut rigs = HashSet::new();
        for object in &self.objects {
            bytes = bytes.saturating_add(buffer(&object.ends)).saturating_add(buffer(&object.starts)).saturating_add(buffer(&object.lengths)).saturating_add(buffer(&object.raw_segments));
            if let Some(value) = &object.spatial
                && spaces.insert(Arc::as_ptr(value))
            {
                bytes = bytes.saturating_add(spatial(value));
            }
            if let Some(value) = &object.rig
                && rigs.insert(Arc::as_ptr(value) as *const RigJoint)
            {
                bytes = bytes.saturating_add(value.len().saturating_mul(size_of::<RigJoint>())).saturating_add(2 * size_of::<usize>());
            }
        }
        for chain in &self.chains {
            bytes = bytes.saturating_add(buffer(chain));
        }
        let mut meshes = HashSet::new();
        for value in &self.meshes {
            if meshes.insert(Arc::as_ptr(value)) {
                bytes = bytes.saturating_add(mesh(value));
            }
        }
        let mut effects = HashSet::new();
        let mut resolved = Resolved::default();
        for value in self.vfx.iter().chain(self.clip_vfx.iter().flatten()) {
            if effects.insert(Arc::as_ptr(value)) {
                bytes = bytes.saturating_add(vfx(value, &mut resolved));
            }
        }
        self.retained_bytes = bytes.saturating_add(resolved.bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_display_leases_share_cache_admission_and_release_after_payload_retirement() {
        let mut value = Scene::default();
        value.points = vec![[1.0, 2.0]; 32];value.account_buffers();
        let scene = Arc::new(value);
        let bytes = scene.retained_bytes;
        assert!(bytes > 0);
        let shared = Arc::new(SceneBudget::with_limits(bytes * 2, 2));
        let mut cache = ClipSceneCache::with_budget(bytes * 2);
        cache.publish(1, scene.clone(), &shared);
        assert_eq!((shared.retained_bytes(), shared.retained_entries()), (bytes, 1));
        let display = shared.retain_worker(scene.clone()).unwrap();
        assert!(Arc::ptr_eq(display.scene(), &scene));
        assert_eq!((shared.retained_bytes(), shared.retained_entries()), (bytes * 2, 2));
        let refused = shared.retain_worker(scene.clone()).unwrap_err();
        assert!(Arc::ptr_eq(&refused, &scene));
        assert_eq!((cache.len(), shared.retained_bytes(), shared.retained_entries()), (1, bytes * 2, 2));
        cache.clear();
        assert_eq!((shared.retained_bytes(), shared.retained_entries()), (bytes, 1));
        drop(display);
        assert_eq!((shared.retained_bytes(), shared.retained_entries()), (0, 0));
    }

    #[test]
    fn simultaneous_publication_keeps_the_winner_and_its_charge() {
        let mut cache = ClipSceneCache::default();
        let shared = Arc::new(SceneBudget::default());
        let mut first = Scene::default();
        first.account_buffers();
        let first = Arc::new(first);
        let mut duplicate = Scene::default();
        duplicate.points = vec![[1.0, 2.0]; 100];
        duplicate.account_buffers();
        let duplicate = Arc::new(duplicate);
        let rejected = Arc::downgrade(&duplicate);
        assert!(Arc::ptr_eq(&cache.publish(7, first.clone(), &shared), &first));
        assert!(Arc::ptr_eq(&cache.publish(7, duplicate, &shared), &first));
        assert!(rejected.upgrade().is_none());
        assert_eq!(cache.retained_bytes(), first.retained_bytes);
        assert_eq!(cache.len(), 1);
        assert_eq!(shared.retained_bytes(), first.retained_bytes);
        assert_eq!(shared.retained_entries(), 1);
        drop(cache);
        assert_eq!(shared.retained_bytes(), 0);
        assert_eq!(shared.retained_entries(), 0);
    }

    #[test]
    fn an_oversized_publication_keeps_previously_retained_scenes() {
        let mut first = Scene::default();
        first.account_buffers();
        let first = Arc::new(first);
        let shared = Arc::new(SceneBudget::default());
        let mut cache = ClipSceneCache::with_budget(first.retained_bytes);
        cache.publish(1, first.clone(), &shared);
        let mut huge = Scene::default();
        huge.points = vec![[1.0, 2.0]; 100];
        huge.account_buffers();
        let huge = Arc::new(huge);
        let returned = cache.publish(2, huge.clone(), &shared);
        assert!(Arc::ptr_eq(&returned, &huge));
        assert!(Arc::ptr_eq(cache.get(&1).unwrap(), &first));
        assert!(cache.get(&2).is_none());
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.retained_bytes(), first.retained_bytes);
        assert_eq!(shared.retained_bytes(), first.retained_bytes);
        assert_eq!(shared.retained_entries(), 1);
    }
}
