//! Runtime fixtures and resource-lifetime tests of the existing clip cache.
//! Query/render results must not depend on whether a local scene is retained.
use std::path::Path;
use std::sync::{Arc, Mutex};

use styk_eval::doc::Movieclip;
use styk_eval::geometry::{self, ClipSceneCache, ObjectGeometry, ObjectSpatial, RawSegment, RigJoint, Scene};
use styk_eval::picking::{self, HandleOptions};

fn document(name: &str) -> Arc<styk_eval::Document> {
    Arc::new(styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap())
}

fn clip(name: &str, budget: usize) -> Movieclip {
    let document = document(name);
    let prepared = Arc::new(styk_eval::eval::Prepared::new(document.clone()));
    Movieclip { duration: prepared.total_ticks as f64, source_start: 0.0, pivot: [0.0; 2], document, meshes: None, drawing_sets: Vec::new(), drawing_rotation: None, prepared, cache: Mutex::new(ClipSceneCache::with_budget(budget)) }
}

#[test]
fn byte_eviction_releases_old_scenes_and_oversized_results_stay_uncached() {
    let mut clip = clip("picking/native-order-static.json", usize::MAX);
    let charge = geometry::clip_scene(&clip, 0.0).retained_bytes;
    assert!(charge > 1000);
    clip.cache = Mutex::new(ClipSceneCache::with_budget(charge * 2));
    let first = geometry::clip_scene(&clip, 0.0);
    assert!(Arc::ptr_eq(&first, &geometry::clip_scene(&clip, 0.0)));
    let weak = Arc::downgrade(&first);
    drop(first);
    geometry::clip_scene(&clip, 1.0);
    assert!(weak.upgrade().is_some());
    assert_eq!(clip.cache.lock().unwrap().len(), 2);
    geometry::clip_scene(&clip, 2.0);
    assert!(weak.upgrade().is_none(), "byte eviction releases the cache's Arc");
    assert_eq!(clip.cache.lock().unwrap().len(), 1);
    assert!(clip.cache.lock().unwrap().retained_bytes() <= charge * 2);

    clip.cache = Mutex::new(ClipSceneCache::with_budget(charge - 1));
    let uncached = geometry::clip_scene(&clip, 0.0);
    assert!(!uncached.items.is_empty(), "oversized scene remains available to its caller");
    let weak = Arc::downgrade(&uncached);
    assert!(!Arc::ptr_eq(&uncached, &geometry::clip_scene(&clip, 0.0)));
    assert!(clip.cache.lock().unwrap().is_empty());
    assert_eq!(clip.cache.lock().unwrap().retained_bytes(), 0);
    drop(uncached);
    assert!(weak.upgrade().is_none());
}

#[test]
fn the_existing_entry_cap_and_clear_release_every_retained_reference() {
    let clip = clip("picking/native-order-static.json", usize::MAX);
    let first = geometry::clip_scene(&clip, 0.0);
    let weak = Arc::downgrade(&first);
    drop(first);
    for tick in 1..ClipSceneCache::MAX_ENTRIES {
        geometry::clip_scene(&clip, tick as f64);
    }
    assert_eq!(clip.cache.lock().unwrap().len(), 64);
    assert!(weak.upgrade().is_some());
    let next = geometry::clip_scene(&clip, 64.0);
    assert!(weak.upgrade().is_none());
    assert_eq!(clip.cache.lock().unwrap().len(), 1);
    let weak = Arc::downgrade(&next);
    drop(next);
    clip.cache.lock().unwrap().clear();
    assert!(weak.upgrade().is_none());
    assert_eq!(clip.cache.lock().unwrap().retained_bytes(), 0);
    assert!(clip.cache.lock().unwrap().is_empty());

    let last = geometry::clip_scene(&clip, 3.0);
    let weak = Arc::downgrade(&last);
    drop(last);
    drop(clip);
    assert!(weak.upgrade().is_none(), "disposing the clip releases its cache");
}

#[test]
fn cache_admission_and_eviction_leave_draw_lists_and_queries_unchanged() {
    for name in ["picking/native-order-static.json", "picking/sheet-order-static.json", "picking/joined-rig.json", "picking/spatial-perspective.json", "spatial/mesh-in-movieclip.json", "vfx/movieclip.json"] {
        let mut clip = clip(name, ClipSceneCache::DEFAULT_BUDGET);
        let frame = clip.prepared.evaluate_clip(2.0);
        let assets = styk_eval::assets::Assets::build(&clip.document);
        let cached = geometry::clip_scene(&clip, 2.0);
        let handles = picking::handles(&cached, &frame, &HandleOptions::default()).unwrap();
        let drawing = format!("{:?}", styk_eval::drawlist::encode(&clip.document, &assets, &cached));
        assert!(cached.retained_bytes > 0);
        clip.cache = Mutex::new(ClipSceneCache::with_budget(0));
        let uncached = geometry::clip_scene(&clip, 2.0);
        assert!(!Arc::ptr_eq(&cached, &uncached));
        assert_eq!(cached.retained_bytes, uncached.retained_bytes, "{name}: charge");
        assert_eq!(handles, picking::handles(&uncached, &frame, &HandleOptions::default()).unwrap(), "{name}: queries");
        assert_eq!(drawing, format!("{:?}", styk_eval::drawlist::encode(&clip.document, &assets, &uncached)), "{name}: draw list");
        assert!(clip.cache.lock().unwrap().is_empty());
    }
}

#[test]
fn derived_metadata_spatial_rig_mesh_and_vfx_buffers_are_charged() {
    let mut scene = Scene {objects: vec![ObjectGeometry::default()], ..Default::default()};
    scene.account_buffers();
    let base = scene.retained_bytes;
    // Capacity, not length: even unresolved/empty query arrays retain storage.
    scene.objects[0].ends.reserve_exact(13);
    scene.objects[0].starts.reserve_exact(13);
    scene.objects[0].lengths.reserve_exact(13);
    scene.objects[0].raw_segments.reserve_exact(13);
    scene.account_buffers();
    let metadata = scene.retained_bytes;
    assert_eq!(metadata - base,
        scene.objects[0].ends.capacity() * std::mem::size_of::<[f64; 2]>() +
        scene.objects[0].starts.capacity() * std::mem::size_of::<[f64; 2]>() +
        scene.objects[0].lengths.capacity() * std::mem::size_of::<f64>() +
        scene.objects[0].raw_segments.capacity() * std::mem::size_of::<RawSegment>());
    let mut space = ObjectSpatial::default();
    space.frames.reserve_exact(13);
    space.depths.reserve_exact(13);
    space.authored.reserve_exact(13);
    space.start_raws.reserve_exact(13);
    scene.objects[0].spatial = Some(Arc::new(space));
    scene.objects[0].rig = Some(Arc::from(vec![RigJoint::default(); 13]));
    scene.account_buffers();
    assert!(scene.retained_bytes > metadata + 13 * std::mem::size_of::<RigJoint>());

    let prepared = styk_eval::eval::Prepared::new(document("spatial/mesh-skinned.json"));
    let mut mesh_scene = geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    assert!(!mesh_scene.meshes.is_empty());
    let full = mesh_scene.retained_bytes;
    let meshes = std::mem::take(&mut mesh_scene.meshes);
    mesh_scene.account_buffers();
    assert!(full > mesh_scene.retained_bytes + meshes.len() * std::mem::size_of::<Arc<styk_eval::spatial::MeshGeometry>>());

    let prepared = styk_eval::eval::Prepared::new(document("vfx/attached.json"));
    let mut vfx_scene = geometry::build(&prepared.doc, &prepared.evaluate(2.0));
    let full = vfx_scene.retained_bytes;
    assert!(vfx_scene.vfx.take().is_some());
    vfx_scene.account_buffers();
    assert!(full > vfx_scene.retained_bytes);
}

#[test]
fn repeated_derived_arcs_are_charged_once_inside_a_scene() {
    let mut mesh = styk_eval::spatial::MeshGeometry::default();
    mesh.positions = vec![1.0; 600];
    let mesh = Arc::new(mesh);
    let mut scene = Scene {meshes: vec![mesh.clone(), mesh.clone()], ..Default::default()};
    scene.account_buffers();
    let shared = scene.retained_bytes;
    scene.meshes[1] = Arc::new((*mesh).clone());
    scene.account_buffers();
    assert!(scene.retained_bytes > shared + 600 * std::mem::size_of::<f32>());

    let mut vfx = styk_eval::vfx::FrameVfx::default();
    vfx.roots = vec![1; 100];
    let vfx = Arc::new(vfx);
    scene.vfx = Some(vfx.clone());
    scene.clip_vfx = vec![Some(vfx.clone()), Some(vfx.clone())];
    scene.account_buffers();
    let shared = scene.retained_bytes;
    scene.clip_vfx[1] = Some(Arc::new((*vfx).clone()));
    scene.account_buffers();
    assert!(scene.retained_bytes > shared + 100 * std::mem::size_of::<u32>());
}
