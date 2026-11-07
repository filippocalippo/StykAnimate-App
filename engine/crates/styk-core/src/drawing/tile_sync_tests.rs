use super::*;
use crate::drawing::worker::WetDab;

fn tile(tx: i64, ty: i64) -> (i64, i64, Vec<u8>) {
    (tx, ty, vec![(tx as u8).wrapping_add(ty as u8); 4])
}

fn batch(stroke: u64, seq: u64, tiles: &[(i64, i64)]) -> Reply {
    Reply::Tiles { stroke, seq, tiles: tiles.iter().map(|&(x, y)| tile(x, y)).collect(), raster_ms: 0.0, newest_ns: seq * 10 }
}

fn dab(x: f32) -> WetDab {
    WetDab { x, y: 0.0, radius: 1.0, opacity: 1.0 }
}

struct Rig {
    sync: TileSync,
    ledger: WetLedger,
    acked: Vec<u64>,
}

impl Rig {
    fn new(capacity: usize, visible: TileRect) -> Rig {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1, true);
        let mut sync = TileSync::new(capacity);
        sync.set_visible(visible);
        Rig { sync, ledger, acked: Vec::new() }
    }

    fn accept(&mut self, reply: Reply) {
        let acked = &mut self.acked;
        self.sync.accept(reply, &mut self.ledger, &mut |seq| acked.push(seq));
    }

    fn install(&mut self, max_tiles: usize) -> usize {
        let acked = &mut self.acked;
        self.sync.install(max_tiles, &mut || false, &mut |seq| acked.push(seq))
    }
}

fn rect(x0: i64, y0: i64, x1: i64, y1: i64) -> TileRect {
    TileRect { x0, y0, x1, y1 }
}

#[test]
fn a_stroke_far_longer_than_the_atlas_stays_within_it_and_is_acknowledged_whole() {
    // The review's stress: thousands of tiles in a row, a view that shows a handful.
    let mut rig = Rig::new(16, rect(0, 0, 3, 0));
    for seq in 1..=1000u64 {
        let tiles: Vec<(i64, i64)> = (0..3).map(|i| ((seq as i64) * 3 + i, 0)).collect();
        rig.ledger.dabs(1, seq, vec![dab(0.0)], seq);
        rig.accept(batch(1, seq, &tiles));
        rig.install(96);
        assert!(rig.sync.resident_count() <= 16);
        rig.sync.take_writes();
    }
    assert_eq!(rig.acked.len(), 1000, "every batch is acknowledged");
    assert_eq!(rig.sync.stats().dropped_batches, 0);
    assert_eq!(rig.sync.waiting(), 0);
}

#[test]
fn a_batch_the_view_pins_too_many_slots_for_is_deferred_not_acknowledged_as_shown() {
    let mut rig = Rig::new(4, rect(0, 0, 2, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0)]));
    rig.install(96);
    assert_eq!(rig.sync.resident_count(), 3);
    // Two more shown tiles but one free slot and nothing outside the view to evict.
    rig.sync.set_visible(rect(0, 0, 4, 0));
    rig.accept(batch(1, 2, &[(3, 0), (4, 0)]));
    assert_eq!(rig.install(96), 0);
    assert_eq!(rig.acked, [1], "the second batch is not acknowledged: it is not on the GPU");
    assert_eq!(rig.sync.stats().deferred, 1);
    assert_eq!(rig.sync.waiting_seq(), Some(2));
    assert_eq!(rig.sync.exact_ns(), 10, "exact-pixel progress does not advance for tiles that are missing");
    // The view moves away: the old tiles can go and the batch lands.
    rig.sync.set_visible(rect(3, 0, 4, 0));
    assert_eq!(rig.install(96), 2);
    assert_eq!(rig.acked, [1, 2]);
    assert_eq!(rig.sync.exact_ns(), 20);
}

#[test]
fn a_batch_larger_than_the_whole_atlas_is_dropped_acknowledged_and_counted() {
    let mut rig = Rig::new(2, rect(0, 0, 5, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0)]));
    rig.install(96);
    assert_eq!(rig.sync.stats().dropped_batches, 1);
    assert_eq!(rig.acked, [1]);
    assert_eq!(rig.sync.resident_count(), 0);
}

#[test]
fn a_batch_is_installed_whole_in_one_call_whatever_the_tile_budget() {
    let mut rig = Rig::new(64, rect(0, 0, 9, 0));
    let tiles: Vec<(i64, i64)> = (0..8).map(|x| (x, 0)).collect();
    rig.accept(batch(1, 1, &tiles));
    rig.accept(batch(1, 2, &[(8, 0), (9, 0)]));
    assert_eq!(rig.install(3), 8, "the first batch goes whole though it is over the budget of 3");
    assert_eq!(rig.sync.take_writes().len(), 8);
    assert_eq!(rig.sync.waiting_seq(), Some(2), "the second waits for the next call");
    assert_eq!(rig.install(3), 2);
}

#[test]
fn the_time_budget_stops_later_batches_but_never_the_first() {
    let mut rig = Rig::new(64, rect(0, 0, 9, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.accept(batch(1, 2, &[(1, 0)]));
    let acked = &mut rig.acked;
    assert_eq!(rig.sync.install(96, &mut || true, &mut |seq| acked.push(seq)), 1);
    assert_eq!(rig.acked, [1]);
}

#[test]
fn ingestion_stops_when_the_waiting_batches_hold_too_much() {
    let mut rig = Rig::new(64, rect(0, 0, 0, 0));
    assert!(rig.sync.has_room());
    let big = Reply::Tiles { stroke: 1, seq: 1, tiles: vec![(0, 0, vec![0; PENDING_BYTES])], raster_ms: 0.0, newest_ns: 1 };
    rig.accept(big);
    assert!(!rig.sync.has_room());
    rig.install(96);
    assert!(rig.sync.has_room());
}

#[test]
fn a_cancelled_stroke_drops_what_it_queued_and_asks_for_its_tiles_back() {
    let mut rig = Rig::new(16, rect(0, 0, 1, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.accept(batch(1, 2, &[(1, 0)]));
    rig.accept(Reply::Cancelled { stroke: 1, restore: vec![(0, 0), (1, 0), (9, 9)] });
    assert_eq!(rig.acked, [1, 2], "the queued batches are acknowledged so the worker is not left waiting");
    assert_eq!(rig.sync.waiting(), 0);
    let asked = rig.sync.plan_fetch(64);
    assert!(asked.contains(&(0, 0)) && asked.contains(&(1, 0)) && !asked.contains(&(9, 9)), "{asked:?}: only tiles the view shows");
}

#[test]
fn fetches_are_bounded_not_repeated_and_empty_tiles_are_remembered() {
    let mut rig = Rig::new(4096, rect(0, 0, 99, 9));
    let first = rig.sync.plan_fetch(1000);
    assert_eq!(first.len(), FETCH_LIMIT);
    assert!(rig.sync.plan_fetch(1000).iter().all(|k| !first.contains(k)), "tiles in flight are not asked for again");
    rig.accept(Reply::Pixels { tiles: first.iter().map(|&(x, y)| (x, y, None)).collect() });
    let again: Vec<(i64, i64)> = (0..20).flat_map(|_| rig.sync.plan_fetch(64)).collect();
    assert!(again.iter().all(|k| !first.contains(k)), "tiles known to be empty are not asked for again");
}

#[test]
fn a_fetched_tile_never_overwrites_a_newer_stroke_batch() {
    let mut rig = Rig::new(16, rect(0, 0, 0, 0));
    let asked = rig.sync.plan_fetch(8);
    assert_eq!(asked, [(0, 0)]);
    // A stroke batch installs the tile while the fetch is in flight; the fetch then answers with the older cel pixels.
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.install(96);
    rig.sync.take_writes();
    rig.accept(Reply::Pixels { tiles: vec![(0, 0, Some(vec![7; 4]))] });
    assert!(rig.sync.take_writes().is_empty());
    assert_eq!(rig.sync.stats().fetch_superseded, 1);
}

#[test]
fn eviction_takes_the_least_recently_used_tile_outside_the_view_first() {
    let mut rig = Rig::new(3, rect(0, 0, 0, 0));
    rig.accept(Reply::Pixels { tiles: vec![(0, 0, Some(vec![1; 4]))] });
    rig.sync.set_visible(rect(10, 0, 10, 0));
    rig.accept(Reply::Pixels { tiles: vec![(10, 0, Some(vec![2; 4]))] });
    rig.sync.set_visible(rect(20, 0, 20, 0));
    rig.accept(Reply::Pixels { tiles: vec![(20, 0, Some(vec![3; 4]))] });
    // Full: (0,0) far and oldest, (10,0) far, (20,0) shown. A new shown tile evicts the oldest far one.
    rig.sync.set_visible(rect(20, 0, 21, 0));
    rig.accept(Reply::Pixels { tiles: vec![(21, 0, Some(vec![4; 4]))] });
    let mut resident: Vec<(i64, i64)> = rig.sync.resident().map(|(k, _)| k).collect();
    resident.sort();
    assert_eq!(resident, [(10, 0), (20, 0), (21, 0)]);
    assert_eq!(rig.sync.stats().evicted, 1);
}

#[test]
fn the_dab_the_preview_continues_from_belongs_to_its_stroke_and_goes_with_it() {
    let mut rig = Rig::new(4, rect(0, 0, 0, 0));
    rig.ledger.stroke_started(2, true);
    rig.accept(Reply::Dabs { stroke: 1, seq: 1, dabs: vec![dab(5.0)], generate_ms: 0.0, newest_ns: 1 });
    assert_eq!(rig.sync.anchor(), Some((1, 5.0, 0.0, 1.0)));
    rig.accept(Reply::Finished { stroke: 1, changed_tiles: 1, dabs: 1 });
    assert_eq!(rig.sync.anchor(), None, "a finished stroke leaves no anchor for the next one to bridge from");
    rig.accept(Reply::Dabs { stroke: 2, seq: 2, dabs: vec![dab(900.0)], generate_ms: 0.0, newest_ns: 2 });
    rig.accept(Reply::Cancelled { stroke: 2, restore: vec![] });
    assert_eq!(rig.sync.anchor(), None);
}
