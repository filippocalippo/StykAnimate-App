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

fn pixels(tiles: Vec<(i64, i64, Option<Vec<u8>>, u64)>, upto: u64) -> Reply {
    Reply::Pixels { tiles, upto }
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
    /// One page of `slots` that may not grow.
    fn new(slots: usize, visible: TileRect) -> Rig {
        Rig::paged(slots, 1, visible)
    }

    fn paged(slots: usize, pages: usize, visible: TileRect) -> Rig {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1, true);
        let mut sync = TileSync::new(slots, pages);
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

    fn slot_of(&self, key: (i64, i64)) -> Option<u32> {
        self.sync.resident().find(|(k, _)| *k == key).map(|(_, slot)| slot)
    }

    /// No slot belongs to two tiles, none is both resident and free, and none lies beyond the pages.
    fn assert_slots_sound(&self) {
        let mut seen = HashSet::new();
        for (key, slot) in self.sync.resident() {
            assert!(seen.insert(slot), "slot {slot} belongs to two tiles ({key:?} and another)");
            assert!((slot as usize) < self.sync.capacity(), "slot {slot} is beyond the {} pages", self.sync.pages());
        }
        for slot in &self.sync.free {
            assert!(!seen.contains(slot), "slot {slot} is resident and free");
        }
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

// Today's model: the required set (every visible tile and the batch being staged) is held above the soft budget by growing a page.
#[test]
fn a_view_that_pins_more_than_a_page_holds_grows_the_atlas_and_keeps_every_visible_tile() {
    let mut rig = Rig::paged(4, 3, rect(0, 0, 8, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0), (3, 0)]));
    rig.install(96);
    rig.accept(batch(1, 2, &[(4, 0), (5, 0), (6, 0)]));
    rig.install(96);
    assert_eq!(rig.sync.pages(), 2, "the second batch needed a page");
    assert_eq!(rig.resident().len(), 7, "no visible tile was evicted to make room");
    assert_eq!(rig.sync.stats().evicted, 0);
    assert_eq!(rig.acked, [1, 2]);
    rig.assert_slots_sound();
}

#[test]
fn above_the_hard_budget_a_tile_is_refused_visibly_and_the_batch_is_still_acknowledged() {
    let mut rig = Rig::new(2, rect(0, 0, 5, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0), (2, 0)]));
    rig.install(96);
    assert_eq!(rig.acked, [1], "the worker is never left waiting");
    assert_eq!(rig.sync.resident_count(), 2);
    assert_eq!(rig.sync.stats().refused, 1, "the tile that did not fit is counted: the pad reports the memory full");
    rig.assert_slots_sound();
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

// Finding 4 of the second re-check: a refusal must not outlive the room that ends it.
#[test]
fn a_refused_tile_is_asked_for_again_once_a_slot_is_free() {
    let mut rig = Rig::new(2, rect(0, 0, 2, 0));
    rig.accept(pixels(vec![(0, 0, Some(vec![1; 4]), 1), (1, 0, Some(vec![1; 4]), 1), (2, 0, Some(vec![1; 4]), 1)], 0));
    assert_eq!(rig.sync.resident_count(), 2);
    assert_eq!(rig.sync.stats().refused, 1);
    let asked: Vec<(i64, i64)> = (0..5).flat_map(|_| rig.sync.plan_fetch(64)).collect();
    assert!(!asked.contains(&(2, 0)), "the refused tile is not asked for every frame: {asked:?}");
    // A tile of the view turns out empty (an undo): its slot is free, and the refused tile is asked for again.
    rig.accept(pixels(vec![(0, 0, None, 2)], 0));
    assert!(rig.sync.plan_fetch(64).contains(&(2, 0)), "the room is there now");
}

// Finding 1 of the second re-check: a slot belongs to one tile.
#[test]
fn a_tile_the_view_has_left_is_not_evicted_by_its_own_update_and_no_slot_is_shared() {
    let mut rig = Rig::paged(2, 2, rect(0, 0, 1, 0));
    rig.accept(pixels(vec![(0, 0, Some(vec![1; 4]), 1), (1, 0, Some(vec![1; 4]), 1)], 0));
    // The view moves to B only; A is resident, out of view, and a stroke batch updates it.
    rig.sync.set_visible(rect(1, 0, 1, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.install(96);
    rig.assert_slots_sound();
    // Then C enters the view and is fetched: it must not reuse A's slot.
    rig.sync.set_visible(rect(1, 0, 2, 0));
    rig.accept(pixels(vec![(2, 0, Some(vec![3; 4]), 2)], 0));
    rig.assert_slots_sound();
    assert_eq!(rig.resident(), [(0, 0), (1, 0), (2, 0)]);
}

// Finding 3 of the second re-check: nothing is written in place over a tile the view shows, however the atlas is filled.
#[test]
fn a_batch_that_updates_every_resident_tile_of_a_full_atlas_is_staged_in_new_slots_and_shown_whole() {
    let mut rig = Rig::paged(2, 2, rect(0, 0, 1, 0));
    rig.accept(pixels(vec![(0, 0, Some(vec![1; 4]), 1), (1, 0, Some(vec![1; 4]), 1)], 0));
    rig.sync.take_writes();
    let before = (rig.slot_of((0, 0)), rig.slot_of((1, 0)));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0)]));
    assert_eq!(rig.install(1), 1, "one tile within the budget");
    let writes = rig.sync.take_writes();
    assert!(writes.iter().all(|w| Some(w.slot) != before.0 && Some(w.slot) != before.1), "no resident slot was overwritten: {writes:?}");
    assert_eq!((rig.slot_of((0, 0)), rig.slot_of((1, 0))), before, "the view still shows the old tiles");
    assert!(rig.acked.is_empty());
    assert_eq!(rig.install(1), 1);
    assert_ne!(rig.slot_of((0, 0)), before.0);
    assert_eq!(rig.acked, [1]);
    rig.assert_slots_sound();
}

// Finding 4 of the second re-check: staging over several frames while another tile is fetched ends with every tile shown.
#[test]
fn a_fetch_that_arrives_while_a_batch_is_staged_leaves_no_tile_blank() {
    let mut rig = Rig::paged(4, 2, rect(0, 0, 3, 0));
    rig.accept(pixels((0..4).map(|x| (x, 0, Some(vec![1; 4]), 1)).collect(), 0));
    rig.sync.take_writes();
    rig.accept(batch(1, 1, &[(0, 0), (1, 0)]));
    assert_eq!(rig.install(1), 1);
    // A visible tile is fetched again (a change elsewhere) before the staging ends.
    rig.accept(Reply::Changed { tiles: vec![(3, 0)], stamp: 5 });
    assert_eq!(rig.sync.plan_fetch(64), [(3, 0)]);
    rig.accept(pixels(vec![(3, 0, Some(vec![9; 4]), 5)], 0));
    assert_eq!(rig.install(1), 1);
    assert_eq!(rig.acked, [1]);
    assert_eq!(rig.resident(), [(0, 0), (1, 0), (2, 0), (3, 0)], "every visible tile is shown");
    assert_eq!(rig.sync.stats().refused, 0);
    assert!(rig.sync.plan_fetch(64).is_empty(), "and nothing waits to be fetched");
    rig.assert_slots_sound();
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
    let old_slot = rig.slot_of((0, 0)).unwrap();
    rig.sync.take_writes();
    rig.accept(batch(1, 2, &[(0, 0), (1, 0), (2, 0)]));
    assert_eq!(rig.install(1), 1);
    let writes = rig.sync.take_writes();
    assert_ne!(writes[0].slot, old_slot, "the replacement goes to a new slot");
    assert_eq!(rig.slot_of((0, 0)), Some(old_slot), "the view still has the old tile");
    rig.install(96);
    assert_ne!(rig.slot_of((0, 0)), Some(old_slot));
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
    rig.accept(pixels(vec![(0, 0, Some(vec![9; 4]), 5)], 0));
    let writes = rig.sync.take_writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].pixels, vec![9; 4], "what the cel now holds is what the tile shows");
}

#[test]
fn fetched_pixels_replace_the_older_queued_batch_for_that_tile_and_a_later_batch_follows_them() {
    let mut rig = Rig::new(16, rect(0, 0, 0, 0));
    rig.accept(batch(1, 1, &[(0, 0)]));
    rig.accept(pixels(vec![(0, 0, Some(vec![7; 4]), 1)], 0));
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

// Finding 9 of the second re-check: a fetched tile of the open stroke holds the ink of the batches whose preview is still shown.
#[test]
fn a_fetched_tile_of_the_open_stroke_waits_for_the_batches_it_includes_so_the_preview_is_not_painted_over_it() {
    let mut rig = Rig::new(16, rect(0, 0, 3, 0));
    rig.ledger.dabs(1, 1, vec![dab(0.0)], 1);
    rig.accept(batch(1, 1, &[(1, 0), (2, 0)]));
    // The view just reached tile 0, which the stroke inked in batch 1 (hidden then); the fetch holds batch 1's ink.
    rig.accept(pixels(vec![(0, 0, Some(vec![5; 4]), 1)], 1));
    assert!(rig.sync.take_writes().is_empty(), "not shown while batch 1 is still to appear: its preview would paint twice");
    assert_eq!(rig.install(1), 1);
    assert!(rig.sync.take_writes().iter().all(|w| (w.tx, w.ty) != (0, 0)));
    assert_eq!(rig.install(1), 1);
    // The batch is in the view (and its preview retires in this very frame): the fetched tile comes with it.
    rig.ledger.uploaded(rig.sync.waiting_seq());
    assert_eq!(rig.ledger.visible_dabs(), 0);
    let writes = rig.sync.take_writes();
    assert!(writes.iter().any(|w| (w.tx, w.ty) == (0, 0) && w.pixels == vec![5; 4]), "{writes:?}");
    assert!(rig.resident().contains(&(0, 0)));
}

#[test]
fn a_fetched_tile_with_no_stroke_in_flight_is_shown_at_once() {
    let mut rig = Rig::new(16, rect(0, 0, 0, 0));
    rig.accept(pixels(vec![(0, 0, Some(vec![5; 4]), 1)], 0));
    assert_eq!(rig.sync.take_writes().len(), 1);
    assert_eq!(rig.resident(), [(0, 0)]);
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

// Finding 8 of the second re-check: a stroke that failed after some of its batches appeared gives its tiles back.
#[test]
fn a_failed_stroke_restores_the_tiles_its_batches_reached_through_the_stamped_path() {
    let mut rig = Rig::new(16, rect(0, 0, 3, 0));
    rig.accept(batch(1, 1, &[(0, 0), (1, 0)]));
    rig.install(96);
    rig.sync.take_writes();
    rig.accept(batch(1, 2, &[(1, 0), (2, 0)]));
    rig.accept(Reply::Failed { stroke: 1, message: "memory".into(), restore: vec![(0, 0), (1, 0), (2, 0)], stamp: 6 });
    assert_eq!(rig.acked, [1, 2], "its queued batch is acknowledged");
    assert_eq!(rig.sync.waiting(), 0);
    let asked = rig.sync.plan_fetch(64);
    assert!(asked.contains(&(0, 0)) && asked.contains(&(1, 0)) && asked.contains(&(2, 0)), "installed ink is fetched back: {asked:?}");
    rig.accept(pixels(vec![(0, 0, None, 6), (1, 0, None, 6), (2, 0, None, 6)], 0));
    assert!(rig.resident().is_empty(), "the cel holds nothing there: the ghost ink is gone");
    assert!(!rig.ledger.is_stroke_open(1));
}

// Finding 5 of the second re-check: a request the worker refused is asked for again.
#[test]
fn a_fetch_the_worker_refused_is_asked_for_again() {
    let mut rig = Rig::new(16, rect(0, 0, 1, 0));
    let asked = rig.sync.plan_fetch(64);
    assert_eq!(asked.len(), 2);
    assert!(rig.sync.plan_fetch(64).is_empty(), "in flight, not asked twice");
    rig.sync.fetch_refused(&asked);
    let again = rig.sync.plan_fetch(64);
    assert!(again.contains(&(0, 0)) && again.contains(&(1, 0)), "{again:?}");
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
    rig.accept(pixels((0..4).map(|x| (x, 0, Some(vec![1; 4]), 3)).collect(), 0));
    assert_eq!(rig.sync.resident_count(), 4, "all four slots are free again");
    rig.assert_slots_sound();
}

#[test]
fn fetches_are_bounded_not_repeated_and_empty_tiles_are_remembered() {
    let mut rig = Rig::new(4096, rect(0, 0, 99, 9));
    let first = rig.sync.plan_fetch(1000);
    assert_eq!(first.len(), FETCH_LIMIT);
    assert!(rig.sync.plan_fetch(1000).iter().all(|k| !first.contains(k)), "tiles in flight are not asked for again");
    rig.accept(pixels(first.iter().map(|&(x, y)| (x, y, None, 0)).collect(), 0));
    let again: Vec<(i64, i64)> = (0..20).flat_map(|_| rig.sync.plan_fetch(64)).collect();
    assert!(again.iter().all(|k| !first.contains(k)), "tiles known to be empty are not asked for again");
}

#[test]
fn eviction_takes_the_least_recently_used_tile_outside_the_view_first() {
    let mut rig = Rig::new(3, rect(0, 0, 0, 0));
    rig.accept(pixels(vec![(0, 0, Some(vec![1; 4]), 1)], 0));
    rig.sync.set_visible(rect(10, 0, 10, 0));
    rig.accept(pixels(vec![(10, 0, Some(vec![2; 4]), 1)], 0));
    rig.sync.set_visible(rect(20, 0, 20, 0));
    rig.accept(pixels(vec![(20, 0, Some(vec![3; 4]), 1)], 0));
    // Full: (0,0) far and oldest, (10,0) far, (20,0) shown. A new shown tile evicts the oldest far one.
    rig.sync.set_visible(rect(20, 0, 21, 0));
    rig.accept(pixels(vec![(21, 0, Some(vec![4; 4]), 1)], 0));
    assert_eq!(rig.resident(), [(10, 0), (20, 0), (21, 0)]);
    assert_eq!(rig.sync.stats().evicted, 1);
    assert_eq!(rig.sync.stats().pages_grown, 0);
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
