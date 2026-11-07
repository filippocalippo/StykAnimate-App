use super::*;
use crate::drawing::worker::WetDab;

fn tile(tx: i64, ty: i64) -> (i64, i64, Vec<u8>) {
    (tx, ty, vec![(tx as u8).wrapping_add(ty as u8); 4])
}

/// A whole batch in one part.
fn batch(stroke: u64, seq: u64, tiles: &[(i64, i64)]) -> Reply {
    part(stroke, seq, 0, true, tiles)
}

fn part(stroke: u64, seq: u64, part: u32, last: bool, tiles: &[(i64, i64)]) -> Reply {
    Reply::Tiles { stroke, seq, stamp: seq, part, last, tiles: tiles.iter().map(|&(x, y)| tile(x, y)).collect(), raster_ms: 0.0, newest_ns: seq * 10 }
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

    fn resident(&self) -> Vec<(i64, i64)> {
        let mut keys: Vec<(i64, i64)> = self.sync.resident().map(|(k, _)| k).collect();
        keys.sort();
        keys
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
    assert_eq!(rig.sync.waiting(), 0);
}

#[test]
fn tiles_the_view_does_not_show_are_dropped_on_arrival() {
    let mut rig = Rig::new(16, rect(0, 0, 1, 0));
    rig.accept(batch(1, 1, &[(0, 0), (500, 0), (501, 0)]));
    assert_eq!(rig.sync.stats().hidden, 2);
    rig.install(96);
    assert_eq!(rig.resident(), [(0, 0)]);
}

// R3 / B2: a view that pins more inked tiles than the atlas holds must neither stall the worker nor lose the tiles being drawn.
#[test]
fn a_stroke_batch_takes_the_slots_of_the_least_recently_used_visible_tiles_when_the_view_pins_more_than_the_atlas_holds() {
    let mut rig = Rig::new(4, rect(0, 0, 4, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0)]));
    rig.install(96);
    assert_eq!(rig.resident().len(), 3);
    rig.accept(batch(1, 2, &[(3, 0), (4, 0)]));
    assert_eq!(rig.install(96), 2, "the new batch lands whole");
    assert_eq!(rig.acked, [1, 2], "both are acknowledged: the worker is never left waiting");
    let resident = rig.resident();
    assert_eq!(resident.len(), 4);
    assert!(resident.contains(&(3, 0)) && resident.contains(&(4, 0)), "the tiles just drawn are shown: {resident:?}");
    assert_eq!(rig.sync.exact_ns(), 20);
}

#[test]
fn a_batch_larger_than_the_whole_atlas_shows_what_fits_and_is_acknowledged() {
    let mut rig = Rig::new(2, rect(0, 0, 5, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0)]));
    rig.install(96);
    assert_eq!(rig.acked, [1]);
    assert_eq!(rig.sync.resident_count(), 2);
    assert_eq!(rig.sync.stats().unshown, 1, "the tile that did not fit is counted");
}

#[test]
fn a_cancel_is_taken_and_frees_the_worker_even_when_the_atlas_is_pinned_and_batches_are_waiting() {
    let mut rig = Rig::new(2, rect(0, 0, 1, 0));
    for seq in 1..=4u64 {
        rig.accept(batch(1, seq, &[(0, 0), (1, 0)]));
    }
    // Four batches are queued, none installed; the cancel is accepted at once and acknowledges them all.
    rig.accept(Reply::Cancelled { stroke: 1, restore: vec![(0, 0), (1, 0)], stamp: 9 });
    assert_eq!(rig.acked, [1, 2, 3, 4]);
    assert_eq!(rig.sync.waiting(), 0);
    let asked = rig.sync.plan_fetch(64);
    assert!(asked.contains(&(0, 0)) && asked.contains(&(1, 0)));
}

#[test]
fn a_fetched_tile_is_declined_not_retried_while_every_slot_holds_a_shown_tile() {
    let mut rig = Rig::new(2, rect(0, 0, 2, 0));
    rig.accept(Reply::Pixels { tiles: vec![(0, 0, Some(vec![1; 4]), 1), (1, 0, Some(vec![1; 4]), 1), (2, 0, Some(vec![1; 4]), 1)] });
    assert_eq!(rig.sync.resident_count(), 2);
    assert_eq!(rig.sync.stats().unshown, 1);
    let asked: Vec<(i64, i64)> = (0..5).flat_map(|_| rig.sync.plan_fetch(64)).collect();
    assert!(!asked.contains(&(2, 0)), "the declined tile is not asked for every frame: {asked:?}");
    rig.sync.set_visible(rect(2, 0, 2, 0));
    assert!(rig.sync.plan_fetch(64).contains(&(2, 0)), "a new view asks again");
}

#[test]
fn a_big_batch_is_written_over_several_calls_and_appears_whole_in_the_last() {
    let mut rig = Rig::new(64, rect(0, 0, 9, 0));
    let tiles: Vec<(i64, i64)> = (0..8).map(|x| (x, 0)).collect();
    rig.accept(batch(1, 1, &tiles));
    assert_eq!(rig.install(3), 3);
    assert_eq!(rig.sync.take_writes().len(), 3);
    assert_eq!(rig.sync.resident_count(), 0, "nothing of the batch is in the view yet");
    assert_eq!(rig.sync.waiting_seq(), Some(1));
    assert!(rig.acked.is_empty());
    assert_eq!(rig.install(3), 3);
    assert_eq!(rig.sync.resident_count(), 0);
    assert_eq!(rig.install(3), 2);
    assert_eq!(rig.sync.resident_count(), 8, "the last call puts the whole batch into the view");
    assert_eq!(rig.acked, [1]);
    assert_eq!(rig.sync.waiting_seq(), None);
}

#[test]
fn every_call_places_at_least_one_tile_whatever_the_budgets() {
    let mut rig = Rig::new(64, rect(0, 0, 9, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0)]));
    let acked = &mut rig.acked;
    assert_eq!(rig.sync.install(96, &mut || true, &mut |seq| acked.push(seq)), 1);
    assert!(rig.acked.is_empty());
    let acked = &mut rig.acked;
    assert_eq!(rig.sync.install(0, &mut || true, &mut |seq| acked.push(seq)), 1);
    assert_eq!(rig.acked, [1]);
}

#[test]
fn a_tile_that_is_replaced_keeps_showing_its_old_pixels_until_the_batch_is_whole() {
    let mut rig = Rig::new(16, rect(0, 0, 9, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.install(96);
    let old_slot = rig.sync.resident().find(|(k, _)| *k == (0, 0)).unwrap().1;
    rig.sync.take_writes();
    rig.accept(batch(1, 2, &[(0, 0), (1, 0), (2, 0)]));
    assert_eq!(rig.install(1), 1);
    let writes = rig.sync.take_writes();
    assert_ne!(writes[0].slot, old_slot, "the replacement goes to a new slot");
    assert_eq!(rig.sync.resident().find(|(k, _)| *k == (0, 0)).unwrap().1, old_slot, "the view still has the old tile");
    rig.install(96);
    assert_ne!(rig.sync.resident().find(|(k, _)| *k == (0, 0)).unwrap().1, old_slot);
}

// R2 / B1: a batch queued before an undo must not cover the pixels the undo gave back.
#[test]
fn an_undo_removes_its_tiles_from_the_batches_still_waiting() {
    let mut rig = Rig::new(16, rect(0, 0, 3, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.install(96);
    rig.sync.take_writes();
    // Batch 2 (tiles 0 and 1) is queued and not installed when the undo of stroke 0 arrives for tile 0.
    rig.accept(batch(1, 2, &[(0, 0), (1, 0)]));
    rig.accept(Reply::Changed { tiles: vec![(0, 0)], stamp: 5 });
    assert_eq!(rig.sync.stats().superseded, 1);
    rig.install(96);
    let written: Vec<(i64, i64)> = rig.sync.take_writes().iter().map(|w| (w.tx, w.ty)).collect();
    assert_eq!(written, [(1, 0)], "tile 0 is not written from the older batch");
    assert_eq!(rig.acked, [1, 2]);
    let asked = rig.sync.plan_fetch(64);
    assert!(asked.contains(&(0, 0)), "and it is fetched, because it is resident and changed: {asked:?}");
    rig.accept(Reply::Pixels { tiles: vec![(0, 0, Some(vec![9; 4]), 5)] });
    let writes = rig.sync.take_writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].pixels, vec![9; 4], "what the cel now holds is what the tile shows");
}

#[test]
fn fetched_pixels_replace_the_older_queued_batch_for_that_tile_and_a_later_batch_follows_them() {
    let mut rig = Rig::new(16, rect(0, 0, 0, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.accept(Reply::Pixels { tiles: vec![(0, 0, Some(vec![7; 4]), 1)] });
    assert_eq!(rig.sync.stats().superseded, 1);
    rig.install(96);
    let writes = rig.sync.take_writes();
    assert_eq!(writes.len(), 1, "the fetch wrote the tile; the older batch did not overwrite it");
    assert_eq!(writes[0].pixels, vec![7; 4]);
    // A batch that arrives after the fetch is newer and does go on top.
    rig.accept(batch(1, 2, &[(0, 0)]));
    rig.install(96);
    assert_eq!(rig.sync.take_writes()[0].pixels, tile(0, 0).2);
}

#[test]
fn a_cancel_removes_its_restored_tiles_from_other_queued_batches() {
    let mut rig = Rig::new(16, rect(0, 0, 3, 0));
    rig.ledger.stroke_started(2, true);
    rig.accept(batch(2, 1, &[(0, 0), (1, 0)]));
    rig.accept(batch(1, 2, &[(1, 0), (2, 0)]));
    rig.accept(Reply::Cancelled { stroke: 2, restore: vec![(0, 0), (1, 0)], stamp: 4 });
    rig.install(96);
    let written: Vec<(i64, i64)> = rig.sync.take_writes().iter().map(|w| (w.tx, w.ty)).collect();
    assert_eq!(written, [(2, 0)]);
}

#[test]
fn a_batch_arriving_in_parts_is_not_complete_until_the_last_and_its_preview_stays_until_then() {
    let mut rig = Rig::new(16, rect(0, 0, 9, 0));
    rig.ledger.dabs(1, 1, vec![dab(0.0)], 1);
    rig.accept(part(1, 1, 0, false, &[(0, 0), (1, 0)]));
    assert_eq!(rig.sync.waiting_seq(), Some(1));
    assert_eq!(rig.install(96), 0, "nothing of an unfinished batch is installed");
    rig.ledger.uploaded(rig.sync.waiting_seq());
    assert_eq!(rig.ledger.visible_dabs(), 1, "the preview still shows the batch");
    rig.accept(part(1, 1, 1, true, &[(2, 0)]));
    assert_eq!(rig.install(96), 3);
    rig.ledger.uploaded(rig.sync.waiting_seq());
    assert_eq!(rig.ledger.visible_dabs(), 0);
    assert_eq!(rig.acked, [1]);
}

#[test]
fn a_cancelled_stroke_drops_what_it_queued_and_asks_for_its_tiles_back() {
    let mut rig = Rig::new(16, rect(0, 0, 1, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.accept(batch(1, 2, &[(1, 0)]));
    rig.accept(Reply::Cancelled { stroke: 1, restore: vec![(0, 0), (1, 0), (9, 9)], stamp: 3 });
    assert_eq!(rig.acked, [1, 2], "the queued batches are acknowledged so the worker is not left waiting");
    assert_eq!(rig.sync.waiting(), 0);
    let asked = rig.sync.plan_fetch(64);
    assert!(asked.contains(&(0, 0)) && asked.contains(&(1, 0)) && !asked.contains(&(9, 9)), "{asked:?}: only tiles the view shows");
}

#[test]
fn a_cancel_while_a_batch_is_half_written_gives_its_slots_back() {
    let mut rig = Rig::new(4, rect(0, 0, 3, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0), (3, 0)]));
    assert_eq!(rig.install(2), 2);
    rig.accept(Reply::Cancelled { stroke: 1, restore: vec![], stamp: 2 });
    assert_eq!(rig.acked, [1]);
    rig.accept(Reply::Pixels { tiles: (0..4).map(|x| (x, 0, Some(vec![1; 4]), 3)).collect() });
    assert_eq!(rig.sync.resident_count(), 4, "all four slots are free again");
}

#[test]
fn fetches_are_bounded_not_repeated_and_empty_tiles_are_remembered() {
    let mut rig = Rig::new(4096, rect(0, 0, 99, 9));
    let first = rig.sync.plan_fetch(1000);
    assert_eq!(first.len(), FETCH_LIMIT);
    assert!(rig.sync.plan_fetch(1000).iter().all(|k| !first.contains(k)), "tiles in flight are not asked for again");
    rig.accept(Reply::Pixels { tiles: first.iter().map(|&(x, y)| (x, y, None, 0)).collect() });
    let again: Vec<(i64, i64)> = (0..20).flat_map(|_| rig.sync.plan_fetch(64)).collect();
    assert!(again.iter().all(|k| !first.contains(k)), "tiles known to be empty are not asked for again");
}

#[test]
fn eviction_takes_the_least_recently_used_tile_outside_the_view_first() {
    let mut rig = Rig::new(3, rect(0, 0, 0, 0));
    rig.accept(Reply::Pixels { tiles: vec![(0, 0, Some(vec![1; 4]), 1)] });
    rig.sync.set_visible(rect(10, 0, 10, 0));
    rig.accept(Reply::Pixels { tiles: vec![(10, 0, Some(vec![2; 4]), 1)] });
    rig.sync.set_visible(rect(20, 0, 20, 0));
    rig.accept(Reply::Pixels { tiles: vec![(20, 0, Some(vec![3; 4]), 1)] });
    // Full: (0,0) far and oldest, (10,0) far, (20,0) shown. A new shown tile evicts the oldest far one.
    rig.sync.set_visible(rect(20, 0, 21, 0));
    rig.accept(Reply::Pixels { tiles: vec![(21, 0, Some(vec![4; 4]), 1)] });
    assert_eq!(rig.resident(), [(10, 0), (20, 0), (21, 0)]);
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
    rig.accept(Reply::Cancelled { stroke: 2, restore: vec![], stamp: 1 });
    assert_eq!(rig.sync.anchor(), None);
}
