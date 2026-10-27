use super::*;
use crate::Budgets;
use std::sync::{Barrier, atomic::{AtomicUsize, Ordering}};

fn clock() -> f64 { 0.0 }
fn drawing() -> Engine {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    engine.open(&std::fs::read(file).unwrap(), "json", "decode lifetime").unwrap();
    while engine.step() {}
    engine.take_images(usize::MAX);
    assert_eq!(engine.images_pending(), 0);
    assert_eq!(engine.inner.state.lock().tasks.len(), 0);
    engine
}
fn image(index: u32) -> Arc<DecodedImage> {
    Arc::new(DecodedImage { index, drawing: true, width: 512, height: 512, rgba: vec![index as u8; 1024 * 1024] })
}
fn pause_worker(engine: &Engine, nth: usize, work: impl FnOnce(Engine) + Send + 'static) -> (Arc<[Barrier; 2]>, std::thread::JoinHandle<()>) {
    let worker = engine.clone();
    let barriers = Arc::new([Barrier::new(2), Barrier::new(2)]);
    let wait = barriers.clone();
    let pointer = &engine.inner.state as *const _ as usize;
    let thread = std::thread::spawn(move || crate::allocation::with_pause(pointer, nth, wait, || work(worker)));
    barriers[0].wait();
    (barriers, thread)
}

#[test]
fn repeated_redecode_requests_coalesce_and_keep_ui_head_exchange_allocation_free() {
    let engine = drawing();
    let count = engine.generation().unwrap().assets.cels.len();
    assert!(count > 0);
    let pointer = &engine.inner.state as *const _ as usize;
    let (_, counts) = crate::allocation::watch(pointer, || for _ in 0..100_000 { engine.redecode_images(); });
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
    assert_eq!(engine.images_backlog(), (count, 0));
    assert_eq!(engine.inner.state.lock().tasks.len(), 1);
    assert_eq!(engine.inner.state.lock().retained_tasks.len(), 0);
    // Each superseded decode generation may retain its existing decode nodes,
    // plus one coalesced preparation. Old nodes precede and drain before it.
    for _ in 0..10 {
        assert!(engine.step());
        engine.redecode_images();
        for _ in 0..1000 { engine.redecode_images(); }
        assert!(engine.inner.state.lock().tasks.len() <= count + 1);
        while engine.inner.state.lock().images.redecode_pending { assert!(engine.step()); }
    }
    while engine.step() {}
    assert_eq!(engine.images_backlog().0, 0);
    assert!(engine.images_backlog().1 > 0);
}

#[test]
fn redecode_retains_old_pixels_until_worker_disposal_and_preserves_lifo_upload_policy() {
    let engine = drawing();
    let old = image(9);
    let weak = Arc::downgrade(&old);
    let mut ready = std::collections::LinkedList::new(); ready.push_back(old);
    engine.inner.state.lock().images.ready.append(&mut ready);
    let pointer = &engine.inner.state as *const _ as usize;
    let (_, counts) = crate::allocation::watch(pointer, || engine.redecode_images());
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
    assert!(weak.upgrade().is_some(), "UI reset does not dispose the final strong pixel owner");
    assert_eq!(engine.inner.state.lock().retained_tasks.len(), 1);
    assert!(engine.step());
    assert!(weak.upgrade().is_none(), "the retained cleanup task owns final disposal");
    while engine.step() {}
    engine.take_images(usize::MAX);
    let mut ready = std::collections::LinkedList::new();
    for index in 1..=3 { ready.push_back(image(index)); }
    engine.inner.state.lock().images.ready.append(&mut ready);
    let (taken, counts) = crate::allocation::watch(pointer, || engine.take_images(1024 * 1024));
    assert_eq!(taken.iter().map(|image| image.index).collect::<Vec<_>>(), [3]);
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
    let (taken, counts) = crate::allocation::watch(pointer, || engine.take_images(usize::MAX));
    assert_eq!(taken.iter().map(|image| image.index).collect::<Vec<_>>(), [2, 1]);
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
}

#[test]
fn prepared_redecode_nodes_precede_later_commands_and_allocate_outside_state() {
    let engine = drawing();
    engine.redecode_images();
    let observed = Arc::new(AtomicUsize::new(0));
    let counter = observed.clone();
    engine.spawn(move |engine| counter.store(engine.images_backlog().1, Ordering::SeqCst));
    let pointer = &engine.inner.state as *const _ as usize;
    let (_, counts) = crate::allocation::watch(pointer, || assert!(engine.step()));
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
    while engine.step() {}
    assert!(observed.load(Ordering::SeqCst) > 0, "a later ordinary command observes the existing decode-before-command order");
}

#[test]
fn replaced_generation_cannot_receive_a_superseded_redecode_preparation() {
    let engine = drawing();
    let before = engine.generation().unwrap();
    engine.redecode_images();
    // step pop -> snapshot -> final install: stop before the third State lock.
    let (barriers, thread) = pause_worker(&engine, 3, |worker| assert!(worker.step()));
    engine.open(br#"{"version":5,"canvas_width":20,"canvas_height":20,"fps":12,"figure_types":[],"keyframes":[{"duration_raw":1,"objects":[]}],"backgrounds":[]}"#, "json", "replacement").unwrap();
    let current = engine.generation().unwrap();
    assert_ne!(before.lineage, current.lineage);
    barriers[1].wait(); thread.join().unwrap();
    assert!(Arc::ptr_eq(&current, &engine.generation().unwrap()));
    assert_eq!(engine.images_backlog(), (0, 0));
    assert_eq!(engine.inner.state.lock().images.lineage, current.lineage);
    assert!(!engine.inner.state.lock().images.redecode_pending);
    assert_eq!(engine.inner.state.lock().tasks.len(), 0);
}

#[test]
fn stopping_before_final_redecode_install_cannot_publish_prepared_decode_nodes() {
    let engine = drawing();
    engine.redecode_images();
    let (barriers, thread) = pause_worker(&engine, 3, |worker| assert!(worker.step()));
    engine.stop();
    assert!(!engine.inner.state.lock().images.preparation_active());
    barriers[1].wait(); thread.join().unwrap();
    assert_eq!(engine.inner.state.lock().tasks.len(), 0);
    while engine.step() {}
}

#[test]
fn a_new_redecode_epoch_refuses_an_actual_inflight_cel_result() {
    let engine = drawing();
    let generation = engine.generation().unwrap();
    let cel = *generation.assets.cels.keys().next().unwrap();
    let count = generation.assets.cels.len();
    let (barriers, thread) = pause_worker(&engine, 2, move |worker| worker.decode_picture(&generation, Picture::Cel(cel)));
    engine.redecode_images();
    barriers[1].wait(); thread.join().unwrap();
    assert_eq!(engine.images_backlog(), (count, 0), "a superseded worker cannot mark the new epoch decoded or restore old ready pixels");
    while engine.step() {}
    assert_eq!(engine.images_backlog().0, 0);
    assert!(engine.images_backlog().1 > 0);
}


#[test]
fn a_second_worker_cannot_select_later_commands_while_decode_nodes_are_being_prepared() {
    let engine = drawing();
    let selected = Arc::new(AtomicUsize::new(0));
    engine.redecode_images();
    let observed = selected.clone();
    engine.spawn(move |_| { observed.fetch_add(1, Ordering::SeqCst); });
    let (barriers, first) = pause_worker(&engine, 3, |worker| assert!(worker.step()));
    let other = engine.clone();
    let second = std::thread::spawn(move || other.step()).join().unwrap();
    let before = selected.load(Ordering::SeqCst);
    barriers[1].wait(); first.join().unwrap();
    assert!(!second, "later ordinary work cannot be selected before decoder nodes exist");
    assert_eq!(before, 0);
    while engine.step() {}
    assert_eq!(selected.load(Ordering::SeqCst), 1);
}


#[test]
fn retained_cleanup_runs_while_preparation_defers_ordinary_frames() {
    let engine = drawing();
    engine.redecode_images();
    engine.request(0, &[0]);
    let (barriers, first) = pause_worker(&engine, 3, |worker| assert!(worker.step()));
    assert!(engine.inner.state.lock().images.preparation_active());
    assert!(!engine.step(), "wanted frames remain deferred until decode jobs are installed");
    let retired = Arc::new(AtomicUsize::new(0));
    let observed = retired.clone();
    engine.spawn_retained(move |_| { observed.fetch_add(1, Ordering::SeqCst); });
    let other = engine.clone();
    assert!(std::thread::spawn(move || other.step()).join().unwrap());
    assert_eq!(retired.load(Ordering::SeqCst), 1);
    assert!(!engine.step());
    assert!(engine.frame(0).is_none());
    barriers[1].wait(); first.join().unwrap();
    assert!(!engine.inner.state.lock().images.preparation_active());
    while engine.step() {}
    assert!(engine.frame(0).is_some());
}

#[test]
fn old_preparation_cannot_clear_a_new_generations_active_barrier() {
    let engine = drawing();
    engine.redecode_images();
    let (old_barriers, old_worker) = pause_worker(&engine, 3, |worker| assert!(worker.step()));
    let old = engine.inner.state.lock().images.preparing.unwrap();
    engine.open(br#"{"version":5,"canvas_width":20,"canvas_height":20,"fps":12,"figure_types":[],"keyframes":[{"duration_raw":1,"objects":[]}],"backgrounds":[]}"#, "json", "replacement").unwrap();
    engine.redecode_images();
    while !engine.inner.state.lock().retained_tasks.is_empty() { assert!(engine.step()); }
    let (new_barriers, new_worker) = pause_worker(&engine, 3, |worker| assert!(worker.step()));
    let new = engine.inner.state.lock().images.preparing.unwrap();
    assert_ne!(old, new);
    old_barriers[1].wait(); old_worker.join().unwrap();
    assert_eq!(engine.inner.state.lock().images.preparing, Some(new));
    assert!(!engine.step(), "stale cleanup cannot release the new selection barrier");
    new_barriers[1].wait(); new_worker.join().unwrap();
    assert!(!engine.inner.state.lock().images.preparation_active());
    let completed = Arc::new(AtomicUsize::new(0));
    let observed = completed.clone();
    engine.spawn(move |_| { observed.fetch_add(1, Ordering::SeqCst); });
    while engine.step() {}
    assert_eq!(completed.load(Ordering::SeqCst), 1);
}

#[test]
fn worker_unwind_releases_its_actual_preparation_and_allows_a_retry() {
    let engine = drawing();
    engine.redecode_images();
    let completed = Arc::new(AtomicUsize::new(0));
    let observed = completed.clone();
    engine.spawn(move |_| { observed.fetch_add(1, Ordering::SeqCst); });
    let worker = engine.clone();
    let pointer = &engine.inner.state as *const _ as usize;
    // The ordinary placeholder was selected/marked active, then the actual
    // preparation fails before its snapshot lock, with no Shared lock held.
    let result = std::thread::spawn(move || crate::allocation::with_failure(pointer, 2, || worker.step())).join();
    assert!(result.is_err());
    assert!(!engine.inner.state.lock().images.preparation_active());
    assert!(!engine.inner.state.lock().images.redecode_pending);
    assert!(engine.step());
    assert_eq!(completed.load(Ordering::SeqCst), 1, "the failed job cannot starve later ordinary work");
    assert!(engine.images_backlog().0 > 0, "no failed preparation certifies undecoded pixels ready");
    engine.redecode_images();
    while engine.step() {}
    assert_eq!(engine.images_backlog().0, 0);
    assert!(engine.images_backlog().1 > 0);
}

/// The drawing fixture opened by an engine whose pictures may wait for the renderer only up to `picture_bytes`,
/// with its cel queued for decoding twice (two pictures).
fn bounded(picture_bytes: usize) -> Engine {
    let engine = Engine::new(clock, Budgets { picture_bytes, ..Budgets::for_device(None) });
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    engine.open(&std::fs::read(file).unwrap(), "json", "picture budget").unwrap();
    let generation = engine.generation().unwrap();
    let cel = *generation.assets.cels.keys().next().unwrap();
    let mut state = engine.inner.state.lock();
    state.tasks.push_back(crate::OrdinaryTask::Decode(generation, Picture::Cel(cel)));
    state.images.grow(1);
    drop(state);
    engine
}

#[test]
fn pictures_beyond_the_budget_wait_until_the_renderer_takes_some() {
    let unbounded = bounded(usize::MAX);
    while unbounded.step() {}
    let total = unbounded.take_images(usize::MAX).len();
    assert!(total > 2, "the tiles of a cel, twice");

    let engine = bounded(1);
    assert_eq!(engine.images_backlog(), (2, 0), "two pictures are to be decoded");
    while engine.step() {}
    let (decoding, decoded) = engine.images_backlog();
    let first = decoded;
    assert_eq!((decoding, first > 0), (1, true), "the second picture waits for the first to be taken");
    assert_eq!(engine.inner.state.lock().images.parked.len(), 1);
    assert_eq!(engine.inner.state.lock().tasks.len(), 0);
    let mut taken = engine.take_images(usize::MAX).len();
    assert_eq!(taken, first);
    assert_eq!(engine.inner.state.lock().images.parked.len(), 0, "taking the first makes room: the second is queued again");
    assert_eq!(engine.inner.state.lock().tasks.len(), 1);
    while engine.step() {}
    taken += engine.take_images(usize::MAX).len();
    assert_eq!(taken, total, "every picture arrives, a slice at a time");
    assert_eq!(engine.images_backlog(), (0, 0));
    assert_eq!(engine.inner.state.lock().images.ready_bytes, 0);
}

#[test]
fn a_picture_waits_in_the_store_and_is_dropped_with_it_when_the_document_is_replaced() {
    let engine = bounded(1);
    while engine.step() {}
    let parked = engine.generation().unwrap();
    assert_eq!(engine.inner.state.lock().images.parked.len(), 1);
    let before = Arc::strong_count(&parked);
    engine.open(br#"{"version":5,"canvas_width":20,"canvas_height":20,"fps":12,"figure_types":[],"keyframes":[{"duration_raw":1,"objects":[]}],"backgrounds":[]}"#, "json", "replacement").unwrap();
    while engine.step() {}
    assert_eq!(engine.inner.state.lock().images.parked.len(), 0);
    assert!(Arc::strong_count(&parked) < before, "the parked task no longer holds the replaced document");
    assert_eq!(engine.images_backlog(), (0, 0));
}

#[test]
fn a_picture_the_memory_cannot_hold_is_not_decoded_and_the_engine_goes_on() {
    let engine = bounded(usize::MAX);
    assert_eq!(engine.pictures_refused(), 0);
    // Decoding reserves what it works with; with 1 MiB of memory a cel of hundreds of tiles does not fit.
    styk_alloc::with_limit(1 << 20, || while engine.step() {});
    assert_eq!(engine.pictures_refused(), 2, "both pictures were refused");
    assert_eq!(engine.images_backlog(), (0, 0), "a refused picture ends the waiting like one that cannot be decoded");
    assert_eq!(engine.inner.state.lock().images.ready_bytes, 0);
    assert_eq!(engine.inner.state.lock().images.inflight_bytes, 0);
    // The document is still the engine's, and a later decode (after a redecode) finds the memory.
    engine.redecode_images();
    while engine.step() {}
    assert!(engine.images_backlog().1 > 0, "the pictures are decoded once the memory is there");
}
