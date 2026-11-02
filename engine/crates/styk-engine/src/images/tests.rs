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
    Arc::new(DecodedImage { index, drawing: true, soft: false, width: 512, height: 512, rgba: vec![index as u8; 1024 * 1024], placement: 0 })
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

#[test]
fn pictures_a_frame_waits_for_are_decoded_several_at_a_time() {
    let budget = 64 << 20;
    let mut whole = Store::default();
    assert!(whole.admit_decode(budget, budget));
    assert!(!whole.admit_decode(budget, budget), "a document decoded whole decodes one 4K picture at a time");
    let mut demanded = Store { demand: true, ..Store::default() };
    for _ in 0..3 {
        assert!(demanded.admit_decode(budget, budget));
    }
    assert!(!demanded.admit_decode(budget, budget), "the pictures a frame waits for are decoded three at a time, not more");
}

#[test]
fn live_pages_that_move_keep_what_was_written_to_them() {
    let mut uploaded = Uploaded::default();
    uploaded.mark(1, 2, 3);
    uploaded.mark(2, 4, 5);
    uploaded.mark(0, 6, 7);
    // Two live pages that began at page 1 begin at page 2 now.
    uploaded.move_pages(1, 2, 2);
    let held: std::collections::HashSet<u64> = uploaded.places.clone();
    assert_eq!(held, [place(0, 6, 7), place(2, 2, 3), place(3, 4, 5)].into_iter().collect());
    uploaded.move_pages(3, 3, 1);
    assert_eq!(uploaded.len(), 3, "a page that stays is not touched");
}

#[test]
fn a_tile_decoded_for_a_placement_given_up_is_dropped_and_one_for_the_placement_held_is_taken() {
    let engine = drawing();
    let generation = engine.generation().unwrap();
    let key = *generation.assets.cels.keys().next().unwrap();
    let serial = generation.assets.placement(key);
    assert_ne!(serial, 0);
    let tile = |placement| Arc::new(DecodedImage { index: 0, drawing: true, soft: false, width: 68, height: 68, rgba: vec![1; 68 * 68 * 4], placement });
    {
        let mut state = engine.inner.state.lock();
        state.images.ready.push_back(tile(serial + 1000));
        state.images.ready.push_back(tile(serial));
        state.images.ready.push_back(tile(serial + 1000));
        state.images.ready_bytes = 3 * 68 * 68 * 4;
    }
    let taken = engine.take_images(usize::MAX);
    assert_eq!(taken.iter().map(|image| image.placement).collect::<Vec<_>>(), vec![serial], "only the placement the document holds");
    let state = engine.inner.state.lock();
    assert_eq!((state.images.ready.len(), state.images.ready_bytes), (0, 0), "the stale tiles are gone, and are not counted");
}

#[test]
fn a_cel_the_document_replaced_is_not_decoded_and_does_not_hold_the_pictures_pending_back() {
    let engine = drawing();
    let generation = engine.generation().unwrap();
    let key = *generation.assets.cels.keys().next().unwrap();
    // The document in front places no cel: the one decoded for `generation` was replaced.
    let replaced = Arc::new(Generation { id: generation.id + 1, lineage: generation.lineage, revision: generation.revision + 1, prepared: generation.prepared.clone(), assets: Arc::new(Assets::default()), open_ms: 0.0, anchors: None });
    {
        let mut state = engine.inner.state.lock();
        state.current = Some(replaced);
        state.images.remaining = 1;
    }
    engine.decode_picture(&generation, Picture::Cel(key));
    assert_eq!(engine.images_backlog(), (0, 0), "nothing decoded, nothing left to wait for");
    // The document that still places it has it decoded.
    engine.inner.state.lock().current = Some(generation.clone());
    engine.inner.state.lock().images.remaining = 1;
    engine.decode_picture(&generation, Picture::Cel(key));
    let (left, decoded) = engine.images_backlog();
    assert_eq!(left, 0);
    assert!(decoded > 0, "the cel the document places is decoded");
}

#[test]
fn a_frame_that_draws_the_slots_a_replaced_cel_gave_waits_until_the_new_tiles_are_all_in() {
    use styk_draw::{DrawList, Prim, K_IMAGE};
    use styk_eval::assets::{decode_cel, Assets};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json");
    let mut loader = styk_eval::load::Loader::new();
    let first = loader.document(&styk_doc::json::parse(&std::fs::read(&path).unwrap()).unwrap(), "p").unwrap();
    let cel = |document: &styk_eval::doc::Document| document.figures[0].images.iter().find_map(|image| image.tiles.clone()).unwrap();
    let assets = Assets::build(&first);
    let mut uploaded = Uploaded::default();
    uploaded.observe(&assets);
    for image in decode_cel(&assets, &cel(&first)) {
        uploaded.record(&assets, &image);
    }
    let sampling = |assets: &Assets, tiles: &Arc<styk_eval::doc::DrawingTiles>| {
        let entry = assets.drawing[assets.cel_slots(tiles).unwrap()[0][0] as usize];
        DrawList { prims: vec![Prim { kind: K_IMAGE, group: 0, color: 0, paint: 0, a: [0.0; 4], b: [0.0, 0.0, entry.layer as f32, 0.0], c: entry.uv() }], ..Default::default() }
    };
    assert!(!uploaded.lacks(&sampling(&assets, &cel(&first))) && !uploaded.refilling_in(&sampling(&assets, &cel(&first))), "the cel placed first is in");
    // The same file read again: the next cel, in the slots of the one before.
    let next = loader.document(&styk_doc::json::parse(&std::fs::read(&path).unwrap()).unwrap(), "p").unwrap();
    let replaced = assets.extended(&next);
    uploaded.observe(&replaced);
    let list = sampling(&replaced, &cel(&next));
    assert!(uploaded.refilling_in(&list), "its slots hold the old cel's pixels");
    assert!(uploaded.lacks(&list));
    let tiles = decode_cel(&replaced, &cel(&next));
    let sampled = replaced.cel_slots(&cel(&next)).unwrap()[0][0];
    for image in tiles.iter().filter(|image| image.index != sampled) {
        uploaded.record(&replaced, image);
    }
    assert!(uploaded.refilling_in(&list), "the tile the frame draws is still the old cel's");
    uploaded.record(&replaced, tiles.iter().find(|image| image.index == sampled).expect("the tile is decoded"));
    assert!(!uploaded.refilling_in(&list) && !uploaded.lacks(&list), "every tile in: the frame is drawn");
    // Assets seen again, or a cel that is not new, refill nothing.
    uploaded.observe(&replaced);
    assert!(!uploaded.refilling_in(&list));
}

#[test]
fn a_cel_that_keeps_the_slots_of_the_tiles_it_shares_marks_only_the_slots_it_writes_as_being_refilled() {
    use styk_draw::{DrawList, Prim, K_IMAGE};
    use styk_eval::assets::{decode_cel_changed, Assets};
    use styk_eval::doc::DrawingTiles;
    let png = |value: u8| -> Arc<[u8]> {
        let image = image::RgbaImage::from_pixel(64, 64, image::Rgba([value, 0, 0, 255]));
        let mut bytes = Vec::new();
        image.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        bytes.into()
    };
    let cel = |tiles: Vec<(i32, i32, Arc<[u8]>)>| {
        let levels = styk_eval::drawing::level_tiles(&tiles);
        Arc::new(DrawingTiles::new([0.0; 2], 1.0, None, tiles, levels))
    };
    let document_of = |tiles: &Arc<DrawingTiles>| {
        let mut doc = styk_eval::open(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/drawing-cel.json")).unwrap();
        for image in Arc::make_mut(&mut doc.figures[0]).images.iter_mut().filter(|image| image.tiles.is_some()) {
            image.tiles = Some(tiles.clone());
        }
        doc
    };
    // Two tiles far apart (their level-0 neighbourhoods do not touch); the second is painted again by the next cel.
    let (kept, old_second) = (png(10), png(20));
    let before = cel(vec![(0, 0, kept.clone()), (50, 50, old_second)]);
    let after = cel(vec![(0, 0, kept), (50, 50, png(30))]);
    let (first_doc, next_doc) = (document_of(&before), document_of(&after));
    let a = Assets::build(&first_doc);
    let mut uploaded = Uploaded::default();
    uploaded.observe(&a);
    for image in decode_cel_changed(&a, &before) {
        uploaded.record(&a, &image);
    }
    // The old cel's decode left its ink for the next.
    assert!(before.tile_ink.get().is_some());
    let b = a.extended_inheriting(&next_doc, true);
    uploaded.observe(&b);
    let list = |coord: (i32, i32)| {
        let at = after.levels[0].binary_search_by_key(&(coord.1, coord.0), |&(x, y)| (y, x)).unwrap();
        let entry = b.drawing[b.cel_slots(&after).unwrap()[0][at] as usize];
        DrawList { prims: vec![Prim { kind: K_IMAGE, group: 0, color: 0, paint: 0, a: [0.0; 4], b: [0.0, 0.0, entry.layer as f32, 0.0], c: entry.uv() }], ..Default::default() }
    };
    assert!(!uploaded.refilling_in(&list((0, 0))) && !uploaded.lacks(&list((0, 0))), "the tile it shares is in its slot: a frame that draws it is drawn");
    assert!(uploaded.refilling_in(&list((50, 50))) && uploaded.lacks(&list((50, 50))), "the tile it paints again holds the old cel's pixels until it is written");
    let written = decode_cel_changed(&b, &after);
    assert!(written.iter().all(|image| image.placement == b.placement(after.key())));
    for image in &written {
        uploaded.record(&b, image);
    }
    assert!(!uploaded.refilling_in(&list((50, 50))) && !uploaded.lacks(&list((50, 50))));
}
