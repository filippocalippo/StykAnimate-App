use super::*;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use styk_services::input::Modifiers;
use styk_services::SystemClock;

const WAIT: Duration = Duration::from_secs(20);

fn settings(extra: &str) -> Arc<str> {
    format!("{{\"size\":8,\"hardness\":1,\"color\":[10,20,30],\"opacity\":1,\"flow\":1,\"spacingRatio\":0.1{extra}}}").into()
}

/// Starts a task on a thread, for tests: the core's tests cannot use `styk-platform`'s spawner (the core never reaches the platform).
struct TestThreads;

impl Spawner for TestThreads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), SpawnError> {
        std::thread::Builder::new().name(name.to_string()).spawn(job).map(|_| ()).map_err(|error| SpawnError(error.to_string()))
    }
}

fn clock() -> Arc<dyn Clock> {
    Arc::new(SystemClock::new())
}

fn worker() -> Worker {
    Worker::spawn(Vec::new(), Arc::new(|| {}), clock(), &TestThreads).expect("the worker starts")
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
        if let Reply::Tiles { seq, last: true, .. } = &reply {
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
    let Some(Reply::Pixels { tiles, .. }) = replies.into_iter().last() else { unreachable!() };
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
    let Some(Reply::Changed { tiles, .. }) = replaced.last() else { unreachable!() };
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
    let Some(Reply::Cancelled { stroke, restore, .. }) = replies.last() else { unreachable!() };
    assert_eq!(*stroke, 2);
    assert!(!restore.is_empty());
    assert!(fetch(&worker, restore).iter().all(|(tx, ty, pixels, _)| before.iter().find(|t| (t.0, t.1) == (*tx, *ty)).map(|t| &t.2) == pixels.as_ref()), "the cel still holds what it held");
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
    let clock = clock();
    let sent = clock.now();
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 0.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 200_000.0, y: 0.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    let send_time = clock.now() - sent;
    assert!(send_time < Duration::from_millis(5), "the interface thread only queued: {send_time:?}");
    // The worker is inside the brush's call for the gap when the cancel comes.
    std::thread::sleep(Duration::from_millis(30));
    let asked = clock.now();
    worker.command(StrokeCommand::Cancel { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Cancelled { .. } | Reply::Failed { .. }));
    assert!(matches!(replies.last(), Some(Reply::Cancelled { stroke: 1, .. })));
    let landed = clock.now() - asked;
    assert!(landed < Duration::from_millis(150), "the cancel landed after {landed:?}: the brush kept generating the gap");
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
    let reopened = Worker::spawn(saved.clone(), Arc::new(|| {}), clock(), &TestThreads).expect("the worker starts");
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
    std::thread::sleep(Duration::from_millis(30));
    let alive = worker.alive();
    let clock = clock();
    let started = clock.now();
    drop(worker);
    let took = clock.now() - started;
    assert!(took < Duration::from_millis(250), "closing waited {took:?} for the stroke in progress");
    // And the thread itself stops within moments, not when the 400,000 pixel gap is finished.
    let deadline = clock.now() + Duration::from_millis(150);
    while alive.upgrade().is_some() && clock.now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(alive.upgrade().is_none(), "the worker thread was still running 150 ms after it was told to stop");
}

/// Returns only after the worker has consumed the hold and cannot consume another request until released.
fn held(worker: &Worker) -> Arc<(Mutex<bool>, Condvar)> {
    let hold = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered, reached) = channel();
    assert!(worker.send(Request::Hold { release: hold.clone(), entered }));
    reached.recv_timeout(WAIT).expect("the worker entered the hold");
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
        if let Reply::Tiles { seq, tiles, last, .. } = reply {
            assert!(tiles.len() <= MAX_BATCH_TILES, "a reply carries at most {MAX_BATCH_TILES} tiles, this one {}", tiles.len());
            if last {
                tiles_replies.push(seq);
            }
        }
    }
    assert_eq!(tiles_replies.len() as u64, MAX_OUTSTANDING, "{tiles_replies:?}: the batches ahead of the consumer are bounded");
    // R4: acknowledging the newest alone (as a cancelled stroke's acknowledgement would) frees nothing: the frontier needs every
    // earlier batch too.
    worker.ack(*tiles_replies.last().unwrap());
    std::thread::sleep(Duration::from_millis(300));
    let mut more = 0;
    while let Some(reply) = worker.wait(Duration::from_millis(50)) {
        more += usize::from(matches!(reply, Reply::Tiles { last: true, .. }));
    }
    assert_eq!(more, 0, "an acknowledgement past a gap let batches out of turn");
    for seq in &tiles_replies[..tiles_replies.len() - 1] {
        worker.ack(*seq);
    }
    std::thread::sleep(Duration::from_millis(300));
    let mut more = 0;
    while let Some(reply) = worker.wait(Duration::from_millis(50)) {
        more += usize::from(matches!(reply, Reply::Tiles { last: true, .. }));
    }
    assert_eq!(more as u64, MAX_OUTSTANDING, "with the gap closed it goes on, four batches further");
    let clock = clock();
    let started = clock.now();
    worker.command(StrokeCommand::Cancel { id: 1 }, &settings);
    until(&worker, |r| matches!(r, Reply::Cancelled { .. }));
    let landed = clock.now() - started;
    assert!(landed < Duration::from_secs(2), "{landed:?}");
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
    let clock = clock();
    // A gap long enough to time on this machine: doubled until the brush takes over 5 ms to fill it, so the comparison
    // below measures something however fast the machine is (a fixed 20,000 px gap took under 5 ms on a quiet run).
    let mut gap = 20_000.0;
    let direct_ms = loop {
        let mut path = BrushStroke::new(brush.clone(), Some(brush.seed));
        let started = clock.now();
        for (i, x) in [0.0, gap].into_iter().enumerate() {
            path.sample(&Sample { x, y: 30.0, pressure: Some(1.0), time: Some(i as f64), ax: Some(0.0), ay: Some(0.0) }, &mut |_| {}).unwrap();
        }
        let ms = (clock.now() - started).as_secs_f64() * 1e3;
        if ms > 5.0 || gap >= 1_280_000.0 {
            break ms;
        }
        gap *= 2.0;
    };
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 30.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: gap, y: 30.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
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

// R1: the brush streams into bounded batches; a long gap never exists as a list of dabs.
#[test]
fn generation_stops_after_a_few_batches_while_nothing_is_acknowledged_however_long_the_gap() {
    let worker = worker();
    let settings = settings(",\"size\":2");
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 0.0, y: 30.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    // A 200,000 pixel gap is about 800,000 dabs at this size and spacing.
    worker.command(StrokeCommand::Sample { id: 1, x: 200_000.0, y: 30.0, pressure: 1.0, time_ms: 1.0, lean: None }, &settings);
    std::thread::sleep(Duration::from_millis(800));
    let made = worker.shared.generated.load(Ordering::Relaxed);
    let batches = (MAX_OUTSTANDING + 2) as usize;
    assert!(made <= batches * 8192, "{made} dabs were made with no acknowledgement: the gap was generated ahead of the consumer");
    assert!(made > 1000, "and generation did start: {made}");
    worker.command(StrokeCommand::Cancel { id: 1 }, &settings);
    until(&worker, |r| matches!(r, Reply::Cancelled { .. }));
}

// R6: a transfer is bounded whatever one dab covers.
#[test]
fn one_huge_dab_is_sent_in_parts_of_at_most_the_tile_limit_and_the_batch_ends_once() {
    let worker = worker();
    let settings = settings(",\"size\":900");
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 500.0, y: 500.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Finished { .. } | Reply::Failed { .. }));
    let mut parts: HashMap<u64, Vec<(u32, bool, usize)>> = HashMap::new();
    for reply in &replies {
        if let Reply::Tiles { seq, part, last, tiles, .. } = reply {
            assert!(tiles.len() <= MAX_BATCH_TILES);
            parts.entry(*seq).or_default().push((*part, *last, tiles.len()));
        }
    }
    let total: usize = parts.values().flatten().map(|p| p.2).sum();
    assert!(total > MAX_BATCH_TILES, "the dab covers more than one reply's worth: {total}");
    for (seq, list) in &parts {
        assert!(list.iter().enumerate().all(|(i, p)| p.0 == i as u32), "batch {seq}: parts in order");
        assert_eq!(list.iter().filter(|p| p.1).count(), 1, "batch {seq}: one last part");
        assert!(list.last().unwrap().1, "batch {seq}: the last part is last");
    }
}

#[test]
fn a_batch_gathers_dabs_up_to_the_tile_limit_and_a_single_dab_goes_alone() {
    let dab = |left: f64, right: f64| Dab { x: (left + right) / 2.0, y: 32.0, radius: (right - left) / 2.0, left, right, top: 0.0, bottom: 64.0, opacity: 1.0, flow: 1.0, cos: 1.0, sin: 0.0 };
    let mut batcher = Batcher::new(8192);
    let mut out = Vec::new();
    // Dabs each one tile wide, 100 of them in a row: batches of 64 tiles.
    for i in 0..100 {
        if let Some(batch) = batcher.push(dab(i as f64 * 64.0, i as f64 * 64.0 + 64.0)) {
            out.push(batch);
        }
    }
    assert!(!out.is_empty() && out.iter().all(|(_, tiles)| tiles.len() <= MAX_BATCH_TILES), "{:?}", out.iter().map(|b| b.1.len()).collect::<Vec<_>>());
    // One dab that alone covers 100 tiles is a batch of its own, never merged with its neighbours.
    let mut batcher = Batcher::new(8192);
    assert!(batcher.push(dab(0.0, 64.0)).is_none());
    let before = batcher.push(dab(0.0, 6400.0));
    assert_eq!(before.map(|b| b.0.len()), Some(1));
    let after = batcher.push(dab(0.0, 64.0));
    assert_eq!(after.map(|b| b.1.len()), Some(100));
}

// B3: a cancel names a stroke; any other id changes nothing.
#[test]
fn a_cancel_for_a_stroke_that_is_not_open_leaves_the_open_stroke_alone() {
    let worker = worker();
    let settings = settings("");
    begin(&worker, 1, false, Mapping::default(), &settings);
    for (i, &(x, y)) in line().iter().enumerate() {
        worker.command(StrokeCommand::Sample { id: 1, x, y, pressure: 0.8, time_ms: i as f64, lean: None }, &settings);
    }
    // The command is dropped where it is made; and a cancel that reaches the thread by name is ignored there too.
    worker.command(StrokeCommand::Cancel { id: 99 }, &settings);
    worker.requests.send(Request::Cancel { id: 99 }).unwrap();
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Finished { .. } | Reply::Cancelled { .. } | Reply::Failed { .. }));
    assert!(matches!(replies.last(), Some(Reply::Finished { stroke: 1, changed_tiles, .. }) if *changed_tiles > 0), "{:?}", replies.last());
    assert!(!snapshot(&worker, 1).is_empty());
}

// R5: strokes, requests and ends are bounded and each stroke ends once.
#[test]
fn presses_and_requests_past_the_limits_are_refused_and_counted_and_a_stroke_ends_once() {
    let worker = worker();
    let settings = settings("");
    let hold = held(&worker);
    let accepted = (0..100u64).filter(|&id| worker.command(StrokeCommand::Begin { id, erase: false, mapping: Mapping::default(), modifiers: Modifiers::NONE }, &settings)).count();
    assert_eq!(accepted, MAX_OPEN);
    assert_eq!(worker.refused(), (100 - MAX_OPEN) as u64);
    // Ends and cancels of strokes never admitted are dropped, not queued; a second end of an admitted one too.
    for id in 0..100u64 {
        worker.command(StrokeCommand::End { id }, &settings);
        worker.command(StrokeCommand::End { id }, &settings);
        worker.command(StrokeCommand::Cancel { id }, &settings);
    }
    let sent = (0..MAX_QUEUED_CONTROL + 10).filter(|_| worker.send(Request::Ping { token: 1 })).count();
    // The acknowledged hold has already left the queue.
    assert_eq!(sent, MAX_QUEUED_CONTROL);
    release(&hold);
    let mut pongs = 0;
    let mut ended = 0;
    while pongs < MAX_QUEUED_CONTROL {
        match worker.wait(WAIT).expect("the worker answers") {
            Reply::Pong { .. } => pongs += 1,
            Reply::Finished { .. } | Reply::Cancelled { .. } | Reply::Failed { .. } => ended += 1,
            _ => {}
        }
    }
    assert!(ended <= MAX_OPEN, "at most one end a stroke: {ended}");
}

// B5: a brush may ask for a working budget, never for more than the worker allows.
#[test]
fn a_brush_cannot_raise_the_strokes_working_budget_above_the_workers() {
    let worker = worker();
    // A tiny budget is honoured: one stroke over many tiles fails visibly, the worker goes on.
    let settings = settings(",\"size\":300,\"workingBytes\":20000");
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 500.0, y: 500.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Finished { .. } | Reply::Failed { .. }));
    assert!(matches!(replies.last(), Some(Reply::Failed { stroke: 1, .. })), "{:?}", replies.last());
    // A huge one is clamped: the value the engine receives is the worker's own cap.
    assert_eq!(working_bytes_for(Some(1e18)), WORKING_BYTES);
    assert_eq!(working_bytes_for(None), WORKING_BYTES);
    assert_eq!(working_bytes_for(Some(1000.0)), 1000.0);
}

// B1 (worker half): a fetch during a stroke answers with the stroke's pixels, and stamps only grow.
#[test]
fn a_fetch_during_a_stroke_returns_its_ink_and_stamps_only_grow_through_undo() {
    let worker = worker();
    let settings = settings("");
    begin(&worker, 1, false, Mapping::default(), &settings);
    for (i, &(x, y)) in line().iter().enumerate() {
        worker.command(StrokeCommand::Sample { id: 1, x, y, pressure: 0.8, time_ms: i as f64, lean: None }, &settings);
    }
    let replies = until(&worker, |r| matches!(r, Reply::Tiles { last: true, .. }));
    let mut sent: HashMap<(i64, i64), (u64, Vec<u8>)> = HashMap::new();
    for reply in &replies {
        if let Reply::Tiles { stamp, tiles, .. } = reply {
            for (tx, ty, pixels) in tiles {
                sent.insert((*tx, *ty), (*stamp, pixels.clone()));
            }
        }
    }
    assert!(!sent.is_empty());
    let keys: Vec<(i64, i64)> = sent.keys().copied().collect();
    for (tx, ty, pixels, stamp) in fetch(&worker, &keys) {
        let (sent_stamp, sent_pixels) = &sent[&(tx, ty)];
        assert_eq!(pixels.as_ref(), Some(sent_pixels), "tile {tx},{ty}: the fetch holds the stroke's ink, not the empty cel");
        assert_eq!(stamp, *sent_stamp);
    }
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    worker.send(Request::Undo);
    let undo = until(&worker, |r| matches!(r, Reply::Changed { .. }));
    let Some(Reply::Changed { stamp, tiles }) = undo.last() else { unreachable!() };
    assert!(sent.values().all(|(s, _)| s < stamp), "the undo's stamp is newer than every batch's");
    for t in fetch(&worker, tiles) {
        assert_eq!(t.3, *stamp);
    }
}

// Finding 2 of the second re-check: a history change during an open stroke cancels the stroke first, as today's controller does.
fn history_during_a_stroke(op: HistoryOp, after_undo: bool) {
    let worker = worker();
    let settings = settings("");
    stroke(&worker, 1, &line(), &settings, Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let drawn = snapshot(&worker, 1);
    if after_undo {
        worker.send(Request::Undo);
        until(&worker, |r| matches!(r, Reply::Changed { .. }));
    }
    // Stroke 2 is begun over the same tiles and rasterised.
    begin(&worker, 2, false, Mapping::default(), &settings);
    for (i, &(x, y)) in line().iter().enumerate() {
        worker.command(StrokeCommand::Sample { id: 2, x, y: y + 4.0, pressure: 0.8, time_ms: i as f64, lean: None }, &settings);
    }
    until(&worker, |r| matches!(r, Reply::Tiles { stroke: 2, last: true, .. }));
    worker.send(op.request());
    let replies = until(&worker, |r| matches!(r, Reply::Changed { .. }));
    let cancelled = replies.iter().position(|r| matches!(r, Reply::Cancelled { stroke: 2, .. }));
    let changed = replies.iter().position(|r| matches!(r, Reply::Changed { .. }));
    assert!(cancelled.is_some() && cancelled < changed, "the stroke is cancelled before the history change is announced: {replies:?}");
    let Some(Reply::Changed { tiles, stamp }) = replies.last() else { unreachable!() };
    let Some(Reply::Cancelled { stamp: cancel_stamp, .. }) = cancelled.map(|i| &replies[i]) else { unreachable!() };
    assert!(stamp > cancel_stamp);
    // The rest of the press does nothing: the undone ink does not come back when it ends.
    for (i, &(x, y)) in line().iter().enumerate() {
        worker.command(StrokeCommand::Sample { id: 2, x, y, pressure: 0.8, time_ms: 100.0 + i as f64, lean: None }, &settings);
    }
    worker.command(StrokeCommand::End { id: 2 }, &settings);
    let after = snapshot(&worker, 2);
    match op {
        HistoryOp::Undo => assert!(after.is_empty(), "undo of the only stroke leaves the cel empty, not stroke 2's ink over it"),
        HistoryOp::Clear => assert!(after.is_empty()),
        HistoryOp::Redo => assert!(after == drawn, "redo brings stroke 1 back and not stroke 2 over it"),
    }
    for t in fetch(&worker, tiles) {
        assert_eq!(t.2.is_some(), after.iter().any(|a| (a.0, a.1) == (t.0, t.1)), "the fetch holds what the cel holds");
        assert_eq!(t.3, *stamp);
    }
}

#[test]
fn undo_during_an_open_stroke_cancels_it_first_and_its_ink_does_not_come_back() {
    history_during_a_stroke(HistoryOp::Undo, false);
}

#[test]
fn clear_during_an_open_stroke_cancels_it_first() {
    history_during_a_stroke(HistoryOp::Clear, false);
}

#[test]
fn redo_during_an_open_stroke_cancels_it_first() {
    history_during_a_stroke(HistoryOp::Redo, true);
}

// Finding 8 of the second re-check.
#[test]
fn a_failed_stroke_names_the_tiles_it_reached_and_a_stamp_to_restore_them() {
    let worker = worker();
    let settings = settings(",\"size\":300,\"workingBytes\":20000");
    begin(&worker, 1, false, Mapping::default(), &settings);
    worker.command(StrokeCommand::Sample { id: 1, x: 500.0, y: 500.0, pressure: 1.0, time_ms: 0.0, lean: None }, &settings);
    worker.command(StrokeCommand::End { id: 1 }, &settings);
    let replies = until(&worker, |r| matches!(r, Reply::Failed { .. }));
    let Some(Reply::Failed { restore, stamp, .. }) = replies.last() else { unreachable!() };
    assert!(!restore.is_empty() && *stamp > 0, "{restore:?} at {stamp}");
    for t in fetch(&worker, restore) {
        assert!(t.2.is_none(), "the cel holds nothing where the failed stroke reached");
        assert_eq!(t.3, *stamp);
    }
}

#[test]
fn a_stroke_that_failed_to_begin_is_forgotten_and_does_not_use_up_the_open_strokes() {
    let worker = worker();
    for id in 1..=(MAX_OPEN as u64 * 2) {
        stroke(&worker, id, &line(), &Arc::from("not json"), Mapping::default());
        until(&worker, |r| matches!(r, Reply::Failed { stroke, .. } if *stroke == id));
    }
    assert_eq!(worker.refused(), 0, "no failed press holds a place");
    stroke(&worker, 99, &line(), &settings(""), Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { stroke: 99, .. }));
}

// Finding 5 of the second re-check: a refused undo, redo or clear is kept and sent in order, never lost silently.
#[test]
fn history_the_worker_refused_is_kept_and_sent_in_order_and_what_cannot_be_kept_is_counted() {
    let worker = worker();
    let settings = settings("");
    stroke(&worker, 1, &line(), &settings, Mapping::default());
    until(&worker, |r| matches!(r, Reply::Finished { .. }));
    let drawn = snapshot(&worker, 1);
    let hold = held(&worker);
    while worker.send(Request::Ping { token: 1 }) {}
    let mut outbox = HistoryOutbox::default();
    assert!(!worker.send(Request::Undo), "the queue is saturated");
    assert!(outbox.submit(&worker, HistoryOp::Undo));
    assert!(outbox.submit(&worker, HistoryOp::Redo));
    assert_eq!(outbox.kept(), 2);
    release(&hold);
    // Room again once the pings are answered.
    let mut pongs = 0;
    while pongs < MAX_QUEUED_CONTROL {
        if matches!(worker.wait(WAIT), Some(Reply::Pong { .. })) {
            pongs += 1;
        }
    }
    outbox.flush(&worker);
    assert_eq!(outbox.kept(), 0);
    let replies = until(&worker, |r| matches!(r, Reply::Changed { .. }));
    assert!(matches!(replies.last(), Some(Reply::Changed { .. })), "the undo was applied");
    until(&worker, |r| matches!(r, Reply::Changed { .. }));
    assert!(snapshot(&worker, 2) == drawn, "the undo and the redo were applied in order: the stroke is back");
    // A full outbox counts what it cannot keep.
    let mut full = HistoryOutbox::default();
    let hold = held(&worker);
    while worker.send(Request::Ping { token: 2 }) {}
    assert!(!worker.send(Request::Undo), "the queue is saturated");
    for _ in 0..MAX_KEPT_HISTORY {
        assert!(full.submit(&worker, HistoryOp::Undo));
    }
    assert_eq!(full.kept(), MAX_KEPT_HISTORY);
    assert!(!full.submit(&worker, HistoryOp::Undo));
    assert_eq!(full.lost, 1);
    release(&hold);
}

// Decision N8: the worker starts through the spawner it is given and reads every timing from the clock it is given.
#[test]
fn the_worker_starts_through_the_given_spawner_and_reads_its_times_from_the_given_clock() {
    use styk_services::{FixedClock, ManualSpawner};
    let spawner = Arc::new(ManualSpawner::new());
    let fixed: Arc<dyn Clock> = Arc::new(FixedClock::new());
    let worker = Worker::spawn(Vec::new(), Arc::new(|| {}), fixed, spawner.as_ref()).expect("the worker starts");
    assert_eq!(spawner.names(), ["styk-drawing"], "one named task, and no thread of its own");
    // Nothing runs until the test runs the task; it does so on a thread of the test's choosing.
    let runner = { let spawner = spawner.clone(); std::thread::spawn(move || spawner.run_next()) };
    let settings = settings("");
    stroke(&worker, 1, &line(), &settings, Mapping::default());
    let replies = until(&worker, |r| matches!(r, Reply::Finished { .. }));
    for reply in &replies {
        match reply {
            Reply::Dabs { generate_ms, .. } => assert_eq!(*generate_ms, 0.0, "the generation time comes from the clock, which never moved"),
            Reply::Tiles { raster_ms, .. } => assert_eq!(*raster_ms, 0.0, "the raster time comes from the clock, which never moved"),
            _ => {}
        }
    }
    assert!(replies.iter().any(|r| matches!(r, Reply::Tiles { .. })));
    drop(worker);
    assert!(runner.join().unwrap(), "the task ended when the worker was dropped");
}

#[test]
fn a_spawner_that_cannot_start_the_task_is_reported_not_unwound() {
    struct Refusing;
    impl Spawner for Refusing {
        fn spawn(&self, _: &str, _: styk_services::Job) -> Result<(), SpawnError> {
            Err(SpawnError("no threads".into()))
        }
    }
    let result = Worker::spawn(Vec::new(), Arc::new(|| {}), clock(), &Refusing);
    assert_eq!(result.err(), Some(SpawnError("no threads".into())));
}
