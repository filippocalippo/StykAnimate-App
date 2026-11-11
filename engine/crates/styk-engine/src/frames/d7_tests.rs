//! Actual cache-owner regressions: shared State must only move small heads.
use super::*;
use crate::Budgets;

fn engine() -> Engine { Engine::new(|| 0.0, Budgets::for_device(None)) }

fn dense(generation: u64, tick: f64) -> FrameData {
    let mut list = DrawList::default();
    list.points = vec![[1.0, 2.0]; 65_536];
    FrameData { generation, tick, list: Arc::new(list), camera: None, background: (0, 0, 0.0), ms: 1.0 }
}

fn seeded() -> Engine {
    let engine = engine();
    engine.open(br#"{"version":5,"canvas_width":320,"canvas_height":200,"fps":20,"figure_types":[],"backgrounds":[],"keyframes":[{"duration_raw":2,"objects":[]},{"duration_raw":1,"objects":[]}]}"#, "json", "d7").unwrap();
    let work = { let state = engine.inner.state.lock(); state.frames.work(state.current.clone()) };
    work.prepare_now(&engine, Sample::new(0.5).unwrap()).unwrap();
    let (generation, hidden, effects, epoch) = {
        let state = engine.inner.state.lock();
        (state.current.as_ref().unwrap().id, state.frames.hidden.clone(), state.frames.effects, state.frames.epoch)
    };
    work.finish(&engine, Sample::new(0.5).unwrap(), epoch, &hidden, effects, dense(generation, 0.5), false).unwrap();
    assert!(engine.frame_at(0.5).is_some());
    engine
}

#[test]
fn frame_d7_hidden_reset_never_allocates_or_destroys_under_state() {
    let engine = seeded();
    let (_, counts) = crate::allocation::watch(&engine.inner.state as *const _ as usize, || engine.set_hidden(&[71, 73]));
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
}

#[test]
fn frame_d7_resource_invalidation_never_allocates_or_destroys_under_state() {
    let engine = seeded();
    let (_, counts) = crate::allocation::watch(&engine.inner.state as *const _ as usize, || engine.inner.state.lock().frames.invalidate_resources());
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
}

#[test]
fn frame_d7_ready_read_returns_while_state_is_busy() {
    let engine = seeded();
    let (sent, received) = std::sync::mpsc::channel();
    let held = engine.inner.state.lock();
    let ui = engine.clone();
    let reader = std::thread::spawn(move || { sent.send(ui.frame_at(0.5).is_none()).unwrap(); });
    let answer = received.recv_timeout(std::time::Duration::from_secs(1));
    // Release and join even on the old implementation, so the failure is a
    // bounded assertion rather than a hung test process.
    drop(held);
    reader.join().unwrap();
    assert!(matches!(answer, Ok(true)), "busy UI lookup must return cold before State release: {answer:?}");
}

#[test]
fn frame_d7_storage_contention_and_busy_mutations_return_before_worker_release() {
    let engine = seeded();
    let storage = { engine.inner.state.lock().frames.storage.clone() };
    let held = storage.lock().unwrap();
    assert!(engine.prepared_frame(0.5, None).is_none());
    assert!(!engine.frame_ready_at(0.5));
    assert!(engine.frame_metadata(0.5).is_none());
    assert!(engine.try_generation_header().unwrap().is_some(), "storage contention cannot replace the coherent document header");
    drop(held);
    let epoch = engine.frame_metadata(0.5).unwrap().epoch;
    let held = engine.inner.state.lock();
    let ui = engine.clone();
    let (sent, received) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        sent.send((ui.try_set_hidden(&[73]), ui.try_set_effects(false), ui.try_request_samples(0.5, &[0.5, 1.25]),
            ui.try_generation_header(), ui.try_frame_stats().is_none())).unwrap();
    });
    let answer = received.recv_timeout(std::time::Duration::from_secs(1));
    drop(held); reader.join().unwrap();
    let (hidden, effects, request, header, stats_cold) = answer.expect("try admission must return before State release");
    assert_eq!((hidden, effects, request), (FrameAdmission::Busy, FrameAdmission::Busy, FrameAdmission::Busy));
    assert_eq!(header, Err(FrameAdmission::Busy)); assert!(stats_cold);
    assert_eq!(engine.frame_metadata(0.5).unwrap().epoch, epoch, "Busy did not apply a setting");
}

#[test]
fn frame_d7_completion_trim_duplicate_and_stale_disposal_are_outside_state() {
    let engine = seeded();
    let (work, generation, epoch, hidden, effects) = {
        let mut state = engine.inner.state.lock();
        state.frames.budget = 700;
        state.frames.playhead = Sample::new(0.5).unwrap();
        (state.frames.work(state.current.clone()), state.current.as_ref().unwrap().id, state.frames.epoch, state.frames.hidden.clone(), state.frames.effects)
    };
    for (tick, received_epoch, expected) in [(1.25, epoch, true), (0.5, epoch, true), (0.5, epoch.wrapping_sub(1), false)] {
        let data = dense(generation, tick);
        let (frame, counts) = crate::allocation::watch(&engine.inner.state as *const _ as usize,
            || work.finish(&engine, Sample::new(tick).unwrap(), received_epoch, &hidden, effects, data, false));
        assert_eq!(frame.is_some(), expected);
        assert_eq!((counts.allocations, counts.deallocations), (0, 0), "tick={tick} epoch={received_epoch}: {counts:?}");
    }
    assert!(engine.frame_at(0.5).is_some(), "the actual protected playhead survives an oversized list");
    assert!(engine.frame_at(1.25).is_none());
}

#[test]
fn frame_d7_resource_union_before_request_and_after_request_have_exact_order() {
    for replace_after in [false, true] {
        let engine = seeded();
        while engine.step() {}
        let before = engine.frame_stats().prepared;
        if !replace_after { engine.request_samples(1.25, &[1.25, 2.5]); }
        engine.inner.state.lock().frames.invalidate_resources();
        if replace_after {
            engine.request_samples(1.25, &[1.25, 2.5]);
            // A second coalesced invalidation cannot resurrect the old cached
            // sample that the intervening replacement request discarded.
            engine.inner.state.lock().frames.invalidate_resources();
        }
        assert!(engine.frame_at(0.5).is_none(), "old resource epoch is stale immediately");
        let (_, counts) = crate::allocation::watch(&engine.inner.state as *const _ as usize, || { while engine.step() {} });
        assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
        assert_eq!(engine.frame_at(0.5).is_some(), !replace_after);
        assert!(engine.frame_at(1.25).is_some()); assert!(engine.frame_at(2.5).is_some());
        assert_eq!(engine.frame_stats().prepared - before, if replace_after { 2 } else { 3 }, "resource reset preserves totals");
    }
}

#[test]
fn frame_d7_repeated_settings_have_one_deferred_storage_owner_and_no_cleanup_queue() {
    let engine = seeded(); while engine.step() {}
    let ready = engine.frame_at(0.5).unwrap(); let old = Arc::downgrade(&ready); drop(ready);
    let (storage, queued) = { let state = engine.inner.state.lock(); (state.frames.storage.clone(), state.retained_tasks.len()) };
    let (_, counts) = crate::allocation::watch(&engine.inner.state as *const _ as usize, || {
        for index in 0..1_000 { assert_eq!(engine.try_set_effects(index % 2 == 1), FrameAdmission::Applied); }
    });
    assert_eq!((counts.allocations, counts.deallocations), (0, 0), "{counts:?}");
    {
        let state = engine.inner.state.lock();
        assert!(Arc::ptr_eq(&storage, &state.frames.storage));
        assert_eq!(state.retained_tasks.len(), queued, "toggles cannot append a cleanup per call");
    }
    assert!(old.upgrade().is_some(), "dense destruction has not run on the calling interface");
    assert!(engine.frame_at(0.5).is_none());
    while engine.step() {}
    assert!(old.upgrade().is_none(), "the actual worker maintenance destroys the displaced list");
    assert_eq!(engine.frame_stats().prepared, 0);
}

#[test]
fn frame_d7_metadata_header_and_readiness_do_not_retain_dense_arcs() {
    let engine = seeded();
    let snapshot = engine.prepared_frame(0.5, None).unwrap();
    let counts = (Arc::strong_count(&snapshot.frame), Arc::strong_count(&snapshot.frame.list), Arc::strong_count(&snapshot.generation));
    let (_, allocations) = crate::allocation::watch(&engine.inner.state as *const _ as usize, || {
        assert!(engine.frame_ready_at(0.5));
        assert!(engine.frame_matches(0.5, snapshot.generation.id, snapshot.epoch));
        assert_eq!(engine.frame_metadata(0.5).unwrap().tick, 0.5);
        assert_eq!(engine.try_generation_header().unwrap().unwrap().generation, snapshot.generation.id);
    });
    assert_eq!((allocations.allocations, allocations.deallocations), (0, 0));
    assert_eq!((Arc::strong_count(&snapshot.frame), Arc::strong_count(&snapshot.frame.list), Arc::strong_count(&snapshot.generation)), counts);
}

#[test]
fn frame_d7_paused_actual_completion_cannot_replace_the_new_resource_or_settings_epoch() {
    for resource in [false, true] {
        let engine = seeded(); while engine.step() {}
        let before = engine.frame_stats().prepared;
        engine.request_samples(0.5, &[1.25]);
        let work = { let state = engine.inner.state.lock(); state.frames.work(state.current.clone()) };
        let barriers = Arc::new([std::sync::Barrier::new(2), std::sync::Barrier::new(2)]);
        let pointer = &engine.inner.state as *const _ as usize;
        let worker = engine.clone(); let pause = barriers.clone();
        // Work::step's fourth actual State lock follows take_wanted and produce.
        // The old tick is inflight. Completion holds storage, but no State
        // guard, so interface controls can still supersede it immediately.
        let old = std::thread::spawn(move || crate::allocation::with_pause(pointer, 4, pause, || work.step(&worker)));
        barriers[0].wait();
        if resource { engine.inner.state.lock().frames.invalidate_resources(); }
        else { engine.set_effects(false); engine.request_samples(1.25, &[1.25]); }
        assert!(engine.prepared_frame(1.25, None).is_none(), "a superseded completion is cold before maintenance");
        barriers[1].wait(); assert!(old.join().unwrap());
        assert_eq!(engine.frame_stats().prepared, if resource { before } else { 0 }, "old data is rejected before new worker preparation");
        while engine.step() {}
        let fresh = engine.prepared_frame(1.25, None).unwrap();
        let after = engine.prepared_frame(1.25, Some((fresh.generation.id, fresh.epoch))).unwrap();
        assert!(Arc::ptr_eq(&fresh.frame, &after.frame), "old completion cannot replace the actual new frame");
        assert_eq!(engine.frame_stats().prepared, if resource { before + 2 } else { 1 }, "rejected old work does not increment new totals");
    }
}
