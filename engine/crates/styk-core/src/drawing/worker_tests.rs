use super::*;
use std::sync::{Condvar, Mutex};
use styk_services::input::Modifiers;

const WAIT: Duration = Duration::from_secs(20);

fn settings(extra: &str) -> Arc<str> {
    format!("{{\"size\":8,\"hardness\":1,\"color\":[10,20,30],\"opacity\":1,\"flow\":1,\"spacingRatio\":0.1{extra}}}").into()
}

fn worker() -> Worker {
    Worker::spawn(Vec::new(), Arc::new(|| {}))
}

fn begin(worker: &Worker, id: u64, erase: bool, mapping: Mapping, settings: &Arc<str>) {
    worker.command(StrokeCommand::Begin { id, erase, mapping, modifiers: Modifiers::NONE }, settings);
}

fn stroke(worker: &Worker, id: u64, points: &[(f64, f64)], settings: &Arc<str>, mapping: Mapping) {
    begin(worker, id, false, mapping, settings);
    for (i, &(x, y)) in points.iter().enumerate() {
        worker.command(StrokeCommand::Sample { id, x, y, pressure: 0.5 + 0.4 * (i as f64 / points.len() as f64), time_ms: i as f64, lean: None }, settings);
    }
    worker.command(StrokeCommand::End { id }, settings);
}

/// Replies until `done` accepts one; all of them are returned.
fn until(worker: &Worker, done: impl Fn(&Reply) -> bool) -> Vec<Reply> {
    let mut seen = Vec::new();
    loop {
        let reply = worker.wait(WAIT).expect("the worker answers");
        // A consumer acknowledges the batches it has installed; these tests install nothing, so each one is acknowledged at once.
        if let Reply::Tiles { seq, .. } = &reply {
            worker.ack(*seq);
        }
        let end = done(&reply);
        seen.push(reply);
        if end {
            return seen;
        }
    }
}

fn snapshot(worker: &Worker, token: u64) -> Vec<(i64, i64, Vec<u8>)> {
    worker.send(Request::Snapshot { token });
    let replies = until(worker, |r| matches!(r, Reply::Snapshot { .. }));
    let Some(Reply::Snapshot { mut tiles, .. }) = replies.into_iter().last() else { unreachable!() };
    tiles.sort_by_key(|t| (t.1, t.0));
    tiles
}

/// The pixels of some tiles, asked for as the consumer does.
fn fetch(worker: &Worker, tiles: &[(i64, i64)]) -> Vec<TileUpdate> {
    worker.send(Request::Fetch { tiles: tiles.to_vec() });
    let replies = until(worker, |r| matches!(r, Reply::Pixels { .. }));
    let Some(Reply::Pixels { tiles }) = replies.into_iter().last() else { unreachable!() };
    tiles
}

fn line() -> Vec<(f64, f64)> {
    (0..40).map(|i| (20.0 + i as f64 * 3.0, 30.0 + (i as f64 * 0.4).sin() * 10.0)).collect()
}

#[test]
fn a_stroke_replies_with_dabs_before_the_tiles_that_replace_them_in_sequence() {
    let worker = worker();
    stroke(&worker, 1, &line(), &settings(""), Mapping::default());
    let replies = until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let mut dabs_at = Vec::new();
    let mut tiles_at = Vec::new();
    for (i, reply) in replies.iter().enumerate() {
        match reply {
            Reply::Dabs { seq, dabs, .. } => {
                assert!(!dabs.is_empty());
                dabs_at.push((*seq, i));
            }
            Reply::Tiles { seq, tiles, .. } => {
                assert!(!tiles.is_empty());
                tiles_at.push((*seq, i));
            }
            Reply::Finished { stroke, changed_tiles, dabs } => assert_eq!((*stroke, *changed_tiles > 0, *dabs > 0), (1, true, true)),
            other => panic!("{other:?}"),
        }
    }
    assert!(!dabs_at.is_empty() && dabs_at.len() == tiles_at.len());
    for ((dseq, dpos), (tseq, tpos)) in dabs_at.iter().zip(&tiles_at) {
        assert_eq!(dseq, tseq);
        assert!(dpos < tpos, "the dabs are known before their tiles");
    }
    assert!(dabs_at.windows(2).all(|pair| pair[1].0 > pair[0].0));
}

#[test]
fn the_cel_matches_the_engine_run_directly_on_the_same_samples() {
    let worker = worker();
    let points = line();
    stroke(&worker, 7, &points, &settings(""), Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let native = snapshot(&worker, 1);
    // The reference: the engine's own brush and stroke engine, one pass, no worker.
    let mut value = json::parse(settings("").as_bytes()).unwrap();
    let object = value.make_obj().unwrap();
    object.set("erase", Value::Bool(false));
    object.set("seed", Value::Num(7.0));
    let brush = Brush::normalize(&value).unwrap();
    let mut path = BrushStroke::new(brush.clone(), Some(brush.seed));
    let mut engine = StrokeEngine::new();
    engine.begin(1, &value, None).unwrap();
    let mut dabs = Vec::new();
    for (i, &(x, y)) in points.iter().enumerate() {
        let input = Sample { x, y, pressure: Some(0.5 + 0.4 * (i as f64 / points.len() as f64)), time: Some(i as f64), ax: Some(0.0), ay: Some(0.0) };
        path.sample(&input, &mut |d| dabs.push(d)).unwrap();
    }
    path.finish(&mut |d| dabs.push(d));
    let mut seeds = Vec::new();
    let mut seen = HashSet::new();
    for dab in &dabs {
        for ty in tile_range(dab.top, dab.bottom) {
            for tx in tile_range(dab.left, dab.right) {
                if seen.insert((tx, ty)) {
                    seeds.push(SeedTile { tx, ty, pixels: None });
                }
            }
        }
    }
    engine.dabs(1, 1.0, &dabs, seeds, None).unwrap();
    let changes = engine.end(1).unwrap().unwrap();
    let mut expected = TileStore::new();
    apply_tile_changes(&mut expected, &changes, true).unwrap();
    let mut expected: Vec<(i64, i64, Vec<u8>)> = expected.iter().map(|t| (t.tx as i64, t.ty as i64, t.pixels.to_vec())).collect();
    expected.sort_by_key(|t| (t.1, t.0));
    assert!(!native.is_empty());
    assert_eq!(native.len(), expected.len());
    assert!(native == expected, "the worker's tiles differ from the engine's");
}

#[test]
fn undo_and_redo_restore_the_cel_exactly() {
    let worker = worker();
    assert!(snapshot(&worker, 1).is_empty());
    stroke(&worker, 1, &line(), &settings(""), Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let drawn = snapshot(&worker, 2);
    assert!(!drawn.is_empty());
    worker.send(Request::Undo);
    let replaced = until(&worker, |r| matches!(r, Reply::Changed { .. }));
    let Some(Reply::Changed { tiles }) = replaced.last() else { unreachable!() };
    assert!(!tiles.is_empty());
    assert!(fetch(&worker, tiles).iter().all(|t| t.2.is_none()), "undo of the only stroke empties every tile it touched");
    assert!(snapshot(&worker, 3).is_empty());
    worker.send(Request::Redo);
    until(&worker, |r| matches!(r, Reply::Changed { .. }));
    assert!(snapshot(&worker, 4) == drawn, "redo restores the same pixels");
}

#[test]
fn a_cancelled_stroke_leaves_the_cel_untouched_and_names_the_tiles_to_restore() {
    let worker = worker();
    let settings = settings("");
    stroke(&worker, 1, &line(), &settings, Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let before = snapshot(&worker, 1);
    begin(&worker, 2, true, Mapping::default(), &settings);
    for &(x, y) in &line() {
        worker.command(StrokeCommand::Sample { id: 2, x, y, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    }
    // The eraser already changed tiles on the interface's side; the cancel restores them.
    until(&worker, |r| matches!(r, Reply::Tiles { stroke: 2, .. }));
    worker.command(StrokeCommand::Cancel { id: 2 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Cancelled { .. }));
    let Some(Reply::Cancelled { stroke, restore }) = replies.last() else { unreachable!() };
    assert_eq!(*stroke, 2);
    assert!(!restore.is_empty());
    assert!(fetch(&worker, restore).iter().all(|(tx, ty, pixels)| before.iter().find(|t| (t.0, t.1) == (*tx, *ty)).map(|t| &t.2) == pixels.as_ref()), "the cel still holds what it held");
    assert!(snapshot(&worker, 2) == before);
}

#[test]
fn an_interrupted_stroke_ends_and_keeps_its_ink_as_one_undo_step() {
    let worker = worker();
    let settings = settings("");
    begin(&worker, 1, false, Mapping::default(), &settings);
    for &(x, y) in &line()[..10] {
        worker.command(StrokeCommand::Sample { id: 1, x, y, pressure: 0.8, time_ms: x, lean: None }, &settings);
    }
    // An interrupt reaches the worker as the same End a lift does.
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    assert!(!snapshot(&worker, 1).is_empty());
    worker.send(Request::Undo);
    until(&worker, |r| matches!(r, Reply::Changed { .. }));
    assert!(snapshot(&worker, 2).is_empty(), "one undo removes all of it");
}

#[test]
fn a_mirrored_stroke_paints_both_sides_in_one_undo_step() {
    let worker = worker();
    let mapping = Mapping { mirror_x: Some(100.0), ..Mapping::default() };
    stroke(&worker, 1, &[(20.0, 30.0), (40.0, 30.0), (60.0, 30.0)], &settings(""), mapping);
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let tiles = snapshot(&worker, 1);
    let columns: HashSet<i64> = tiles.iter().map(|t| t.0).collect();
    // x 20..60 is tile 0; the mirror at 100 puts the other half at x 140..180 (tiles 2 and 3).
    assert!(columns.contains(&0) && columns.contains(&2), "{columns:?}");
    worker.send(Request::Undo);
    until(&worker, |r| matches!(r, Reply::Changed { .. }));
    assert!(snapshot(&worker, 2).is_empty());
}

#[test]
fn a_huge_gap_costs_the_worker_not_the_caller_and_a_cancel_still_lands() {
    let worker = worker();
    let settings = settings(",\"size\":2");
    begin(&worker, 1, false, Mapping::default(), &settings);
    let sent = Instant::now();
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 0.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 200_000.0, y: 0.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    let send_time = sent.elapsed();
    assert!(send_time < Duration::from_millis(5), "the interface thread only queued: {send_time:?}");
    worker.command(StrokeCommand::Cancel { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Cancelled { .. } | Reply::Failed { .. }));
    assert!(matches!(replies.last(), Some(Reply::Cancelled { stroke: 1, .. })));
    // The worker is usable again.
    stroke(&worker, 2, &line(), &settings, Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { stroke: 2, .. }));
}

#[test]
fn samples_of_a_cancelled_or_unknown_stroke_are_ignored() {
    let worker = worker();
    let settings = settings("");
    worker.command(StrokeCommand::Sample { id: 9, x: 1.0, y: 1.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    worker.command(StrokeCommand::End { id: 9 }, &settings);
    worker.send(Request::Ping { token: 5 });
    let replies = until(&worker, |r| matches!(r, Reply::Pong { .. }));
    assert_eq!(replies.len(), 1);
    assert_eq!(worker.queued(), 0);
}

#[test]
fn a_malformed_brush_fails_the_stroke_and_not_the_worker() {
    let worker = worker();
    stroke(&worker, 1, &line(), &Arc::from("not json"), Mapping::default());
    let replies = until(&worker, |r| matches!(r, Reply::Failed { .. }));
    assert!(matches!(replies.last(), Some(Reply::Failed { stroke: 1, .. })));
    stroke(&worker, 2, &line(), &settings(""), Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { stroke: 2, .. }));
}

#[test]
fn the_cel_survives_a_save_and_reopen_through_a_snapshot() {
    let worker = worker();
    stroke(&worker, 1, &line(), &settings(""), Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let saved = snapshot(&worker, 1);
    let reopened = Worker::spawn(saved.clone(), Arc::new(|| {}));
    assert!(snapshot(&reopened, 1) == saved);
    // Painting over reopened pixels seeds from them: the old ink is still there beside the new.
    stroke(&reopened, 2, &[(20.0, 60.0), (100.0, 60.0)], &settings(""), Mapping::default());
    until(&reopened, |r| matches!(r, Reply::Finished { .. }));
    let after = snapshot(&reopened, 2);
    assert!(after.len() >= saved.len());
    assert!(saved.iter().all(|t| after.iter().any(|a| (a.0, a.1) == (t.0, t.1))));
}

#[test]
fn cancelling_a_later_stroke_does_not_truncate_an_earlier_queued_one() {
    let worker = worker();
    let settings = settings(",\"size\":2");
    // A long first stroke keeps the worker busy while the rest queues behind it.
    begin(&worker, 10, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 10, x: 0.0, y: 400.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 10, x: 60_000.0, y: 400.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    stroke(&worker, 11, &line(), &settings, Mapping::default());
    begin(&worker, 12, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 12, x: 30.0, y: 30.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Cancel { id: 12 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Finished { stroke: 11, .. } | Reply::Failed { stroke: 11, .. }));
    let Some(Reply::Finished { changed_tiles, dabs, .. }) = replies.last() else { panic!("stroke 11 did not finish: {replies:?}") };
    assert!(*changed_tiles > 0 && *dabs > 0, "the earlier stroke kept its ink: {changed_tiles} tiles, {dabs} dabs");
}

#[test]
fn dropping_the_worker_does_not_wait_for_the_work_it_has_queued() {
    let worker = worker();
    let settings = settings(",\"size\":2");
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 0.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 400_000.0, y: 0.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    drop(worker);
    let took = started.elapsed();
    assert!(took < Duration::from_millis(250), "closing waited {took:?} for the stroke in progress");
}

/// Queues commands behind a held worker, then releases it.
fn held(worker: &Worker) -> Arc<(Mutex<bool>, Condvar)> {
    let hold = Arc::new((Mutex::new(false), Condvar::new()));
    worker.send(Request::Hold(hold.clone()));
    hold
}

fn release(hold: &Arc<(Mutex<bool>, Condvar)>) {
    *hold.0.lock().unwrap() = true;
    hold.1.notify_all();
}

#[test]
fn a_cancel_behind_a_held_worker_leaves_the_stroke_queued_before_it_whole() {
    let worker = worker();
    let settings = settings("");
    let hold = held(&worker);
    stroke(&worker, 1, &line(), &settings, Mapping::default());
    begin(&worker, 2, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 2, x: 30.0, y: 30.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Cancel { id: 2 }, &settings);
    release(&hold);
    let replies = until(&worker, |r| matches!(r, Reply::Cancelled { stroke: 2, .. }));
    let finished = replies.iter().find_map(|r| if let Reply::Finished { stroke: 1, changed_tiles, dabs } = r { Some((*changed_tiles, *dabs)) } else { None });
    assert!(finished.is_some_and(|(tiles, dabs)| tiles > 0 && dabs > 0), "{finished:?}");
}

#[test]
fn the_worker_stays_within_its_outstanding_batches_until_they_are_acknowledged() {
    let worker = worker();
    let settings = settings(",\"size\":2");
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 30.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 30_000.0, y: 30.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    std::thread::sleep(Duration::from_millis(600));
    let mut tiles_replies = Vec::new();
    while let Some(reply) = worker.wait(Duration::from_millis(50)) {
        if let Reply::Tiles { seq, tiles, .. } = reply {
            assert!(tiles.len() <= MAX_BATCH_TILES, "a batch carries at most {MAX_BATCH_TILES} tiles, this one {}", tiles.len());
            tiles_replies.push(seq);
        }
    }
    assert_eq!(tiles_replies.len() as u64, MAX_OUTSTANDING, "{tiles_replies:?}: the batches ahead of the consumer are bounded");
    // An acknowledgement lets it go on; a cancel wakes it at once.
    worker.ack(*tiles_replies.last().unwrap());
    std::thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    worker.command(StrokeCommand::Cancel { id: 1 }, &settings);
    until(&worker, |r| matches!(r, Reply::Cancelled { .. }));
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

#[test]
fn the_time_to_generate_dabs_is_the_time_the_brush_took() {
    let worker = worker();
    let settings = settings(",\"size\":2");
    // The same gap, timed around the brush itself.
    let mut value = json::parse(settings.as_bytes()).unwrap();
    let object = value.make_obj().unwrap();
    object.set("erase", Value::Bool(false));
    object.set("seed", Value::Num(1.0));
    let brush = Brush::normalize(&value).unwrap();
    let mut path = BrushStroke::new(brush.clone(), Some(brush.seed));
    let started = Instant::now();
    for (i, x) in [0.0, 20_000.0].into_iter().enumerate() {
        path.sample(&Sample { x, y: 30.0, pressure: Some(1.0), time: Some(i as f64), ax: Some(0.0), ay: Some(0.0) }, &mut |_| {}).unwrap();
    }
    let direct_ms = started.elapsed().as_secs_f64() * 1e3;
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 30.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 20_000.0, y: 30.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let reported: f64 = replies.iter().filter_map(|r| if let Reply::Dabs { generate_ms, .. } = r { Some(*generate_ms) } else { None }).sum();
    assert!(direct_ms > 5.0, "the gap is long enough to time: {direct_ms} ms");
    assert!(reported >= direct_ms * 0.5, "the worker reported {reported} ms of generation for a gap the brush took {direct_ms} ms to make");
}

#[test]
fn a_worker_too_far_behind_refuses_samples_and_says_so() {
    let worker = worker();
    let settings = settings("");
    let hold = held(&worker);
    begin(&worker, 1, false, Mapping::default(), &settings);
    let sample = |i: usize| StrokeCommand::Sample { id: 1, x: i as f64 * 0.01, y: 5.0, pressure: 1.0, time_ms: i as f64, lean: None };
    let refused = (0..MAX_QUEUED_SAMPLES + 50).filter(|&i| !worker.command(sample(i), &settings)).count();
    assert_eq!(refused, 50);
    assert_eq!(worker.refused(), 50);
    assert_eq!(worker.queued(), MAX_QUEUED_SAMPLES);
    // An end is never refused.
    assert!(worker.command(StrokeCommand::End { id: 1 }, &settings));
    worker.command(StrokeCommand::Cancel { id: 1 }, &settings);
    release(&hold);
    until(&worker, |r| matches!(r, Reply::Cancelled { .. } | Reply::Finished { .. }));
}

#[test]
fn a_fetch_returns_at_most_the_fetch_limit() {
    let worker = worker();
    let tiles: Vec<(i64, i64)> = (0..(FETCH_LIMIT as i64 + 30)).map(|i| (i, 0)).collect();
    assert_eq!(fetch(&worker, &tiles).len(), FETCH_LIMIT);
}
