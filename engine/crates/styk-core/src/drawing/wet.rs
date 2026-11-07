//! The wet ink's bookkeeping: which dabs the preview still shows, and when it stops showing them.
//!
//! The worker answers a batch in two steps: its dabs first ([`Reply::Dabs`](super::worker::Reply::Dabs)), the tiles that
//! contain them later ([`Reply::Tiles`](super::worker::Reply::Tiles)), both tagged with the batch's sequence. The preview
//! shows a batch from the first reply until the frame in which its tiles are on the GPU, and not a frame longer or
//! shorter: no gap (a dab in neither layer) and no double paint (a dab in both). The ledger decides that, with no GPU in
//! it, so the rule is tested on its own; the pad's `prepare` feeds it and draws what it says.

use super::worker::WetDab;
use std::collections::VecDeque;
use std::sync::Arc;

/// A wet segment older than this many frames retires whatever the tiles say (the JavaScript wet ink's age limit).
pub const MAX_AGE_FRAMES: u64 = 30;

#[derive(Clone, Debug)]
struct Batch {
    stroke: u64,
    seq: u64,
    dabs: Arc<[WetDab]>,
    born: u64,
}

/// What the preview shows, and why batches left it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LedgerStats {
    /// Batches retired because their tiles were uploaded.
    pub retired_by_tiles: u64,
    /// Batches retired by age (their tiles never arrived in time).
    pub retired_by_age: u64,
    /// Batches dropped with a cancelled or failed stroke.
    pub dropped: u64,
    /// Replies ignored because they belonged to a stroke already gone.
    pub stale: u64,
}

/// The wet batches of the strokes in flight.
#[derive(Debug, Default)]
pub struct WetLedger {
    batches: VecDeque<Batch>,
    /// Strokes the ledger has heard of and not seen end, to recognise stale replies.
    open: Vec<u64>,
    /// The highest sequence whose tiles are all on the GPU.
    uploaded_seq: u64,
    /// The highest sequence whose tiles have been received (uploaded or waiting).
    received_seq: u64,
    frame: u64,
    stats: LedgerStats,
}

impl WetLedger {
    pub fn new() -> WetLedger {
        WetLedger::default()
    }

    pub fn stats(&self) -> LedgerStats {
        self.stats
    }

    /// The frame being prepared; advance it once per frame, before the frame's replies are applied.
    pub fn begin_frame(&mut self) -> u64 {
        self.frame += 1;
        self.frame
    }

    /// Batches the preview shows now.
    pub fn visible(&self) -> impl Iterator<Item = &[WetDab]> {
        self.batches.iter().map(|b| &*b.dabs)
    }

    /// Dabs the preview shows now.
    pub fn visible_dabs(&self) -> usize {
        self.batches.iter().map(|b| b.dabs.len()).sum()
    }

    pub fn batches(&self) -> usize {
        self.batches.len()
    }

    /// A stroke began.
    pub fn stroke_started(&mut self, stroke: u64) {
        if !self.open.contains(&stroke) {
            self.open.push(stroke);
        }
    }

    /// The worker reported a batch's dabs. `eligible` is false for brushes the preview cannot match closely (erase,
    /// smudge, special blends): their exact pixels only.
    pub fn dabs(&mut self, stroke: u64, seq: u64, dabs: Vec<WetDab>, eligible: bool) {
        if !self.open.contains(&stroke) {
            self.stats.stale += 1;
            return;
        }
        if eligible && !dabs.is_empty() {
            self.batches.push_back(Batch { stroke, seq, dabs: dabs.into(), born: self.frame });
        }
    }

    /// The worker reported a batch's tiles, `queued` of which wait for upload (the others are already on the GPU or the
    /// batch changed none). Returns false for a reply of a stroke that is gone.
    pub fn tiles_received(&mut self, stroke: u64, seq: u64) -> bool {
        if !self.open.contains(&stroke) {
            self.stats.stale += 1;
            return false;
        }
        self.received_seq = self.received_seq.max(seq);
        true
    }

    /// The upload queue now holds tiles of batches from `oldest_waiting` on (`None` when it is empty); everything before
    /// that is on the GPU. Retires the batches whose tiles are all there, in this same frame.
    pub fn uploaded(&mut self, oldest_waiting: Option<u64>) {
        self.uploaded_seq = match oldest_waiting {
            Some(seq) => seq.saturating_sub(1),
            None => self.received_seq,
        };
        let done = self.uploaded_seq;
        let before = self.batches.len();
        self.batches.retain(|b| b.seq > done);
        self.stats.retired_by_tiles += (before - self.batches.len()) as u64;
    }

    /// Retires the batches past their age limit.
    pub fn age(&mut self) {
        let frame = self.frame;
        let before = self.batches.len();
        self.batches.retain(|b| frame - b.born < MAX_AGE_FRAMES);
        self.stats.retired_by_age += (before - self.batches.len()) as u64;
    }

    /// A stroke ended (kept or discarded): replies for it after this are stale.
    pub fn stroke_ended(&mut self, stroke: u64) {
        self.open.retain(|s| *s != stroke);
    }

    /// A stroke was cancelled or failed: its preview goes at once.
    pub fn stroke_dropped(&mut self, stroke: u64) {
        let before = self.batches.len();
        self.batches.retain(|b| b.stroke != stroke);
        self.stats.dropped += (before - self.batches.len()) as u64;
        self.stroke_ended(stroke);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dab(i: usize) -> WetDab {
        WetDab { x: i as f32, y: 0.0, radius: 2.0, opacity: 1.0 }
    }

    #[test]
    fn a_batch_is_shown_from_its_dabs_until_the_frame_its_tiles_are_uploaded() {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1);
        ledger.begin_frame();
        ledger.dabs(1, 1, vec![dab(0), dab(1)], true);
        ledger.uploaded(None);
        assert_eq!(ledger.visible_dabs(), 2, "the tiles have not arrived");
        ledger.begin_frame();
        assert!(ledger.tiles_received(1, 1));
        ledger.uploaded(None);
        assert_eq!(ledger.visible_dabs(), 0, "uploaded in this frame: the preview leaves in it");
        assert_eq!(ledger.stats().retired_by_tiles, 1);
    }

    #[test]
    fn a_partial_upload_keeps_the_older_batch_until_all_of_its_tiles_are_there() {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1);
        ledger.begin_frame();
        ledger.dabs(1, 1, vec![dab(0)], true);
        ledger.dabs(1, 2, vec![dab(1)], true);
        ledger.tiles_received(1, 1);
        ledger.tiles_received(1, 2);
        // The upload budget took only part of batch 1's tiles: the queue still starts at batch 1.
        ledger.uploaded(Some(1));
        assert_eq!(ledger.batches(), 2);
        // Next frame: batch 1 is whole, batch 2 waits.
        ledger.begin_frame();
        ledger.uploaded(Some(2));
        assert_eq!(ledger.batches(), 1);
        ledger.begin_frame();
        ledger.uploaded(None);
        assert_eq!(ledger.batches(), 0);
    }

    #[test]
    fn a_delayed_reply_is_covered_by_the_preview_until_the_age_limit() {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1);
        ledger.begin_frame();
        ledger.dabs(1, 1, vec![dab(0)], true);
        for _ in 0..(MAX_AGE_FRAMES - 1) {
            ledger.begin_frame();
            ledger.uploaded(None);
            ledger.age();
        }
        assert_eq!(ledger.batches(), 1, "still shown one frame before the limit");
        ledger.begin_frame();
        ledger.age();
        assert_eq!(ledger.batches(), 0);
        assert_eq!(ledger.stats().retired_by_age, 1);
    }

    #[test]
    fn a_cancelled_stroke_loses_its_preview_and_its_late_replies_are_stale() {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1);
        ledger.begin_frame();
        ledger.dabs(1, 1, vec![dab(0)], true);
        ledger.stroke_dropped(1);
        assert_eq!(ledger.batches(), 0);
        ledger.dabs(1, 2, vec![dab(1)], true);
        assert!(!ledger.tiles_received(1, 2));
        assert_eq!(ledger.batches(), 0);
        assert_eq!(ledger.stats(), LedgerStats { dropped: 1, stale: 2, ..LedgerStats::default() });
    }

    #[test]
    fn an_ineligible_brush_never_shows_a_preview() {
        let mut ledger = WetLedger::new();
        ledger.stroke_started(1);
        ledger.begin_frame();
        ledger.dabs(1, 1, vec![dab(0)], false);
        assert_eq!(ledger.batches(), 0);
        assert!(ledger.tiles_received(1, 1));
    }

    /// Every dab is in the preview or in the uploaded tiles at every frame, and in only one of them: the rule, checked
    /// over many arrival patterns with a small upload budget.
    #[test]
    fn no_dab_is_ever_missing_or_painted_twice_whatever_the_delays() {
        // A deterministic generator, so a failure replays.
        let mut state = 0x2545F4914F6CDD1Du64;
        let mut next = move |bound: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % bound
        };
        for _ in 0..200 {
            let mut ledger = WetLedger::new();
            ledger.stroke_started(1);
            let batches = 1 + next(12) as usize;
            // Replies in flight: (frame they arrive, tiles) in worker order.
            let mut dab_arrival: Vec<u64> = Vec::new();
            let mut tile_arrival: Vec<u64> = Vec::new();
            let mut at = 0;
            for _ in 0..batches {
                at += next(3);
                dab_arrival.push(at);
                tile_arrival.push(at + next(4));
            }
            for i in 1..batches {
                tile_arrival[i] = tile_arrival[i].max(tile_arrival[i - 1]);
            }
            let tiles_per_batch: Vec<usize> = (0..batches).map(|_| 1 + next(5) as usize).collect();
            let mut waiting: VecDeque<(u64, usize)> = VecDeque::new();
            let mut on_gpu = vec![false; batches];
            let budget = 2;
            for frame in 1..=(at + 40) {
                ledger.begin_frame();
                for i in 0..batches {
                    if dab_arrival[i] + 1 == frame {
                        ledger.dabs(1, i as u64 + 1, vec![dab(i)], true);
                    }
                    if tile_arrival[i] + 1 == frame {
                        ledger.tiles_received(1, i as u64 + 1);
                        waiting.push_back((i as u64 + 1, tiles_per_batch[i]));
                    }
                }
                let mut spent = 0;
                while spent < budget {
                    let Some(front) = waiting.front_mut() else { break };
                    let take = front.1.min(budget - spent);
                    front.1 -= take;
                    spent += take;
                    if front.1 == 0 {
                        on_gpu[front.0 as usize - 1] = true;
                        waiting.pop_front();
                    }
                }
                ledger.uploaded(waiting.front().map(|w| w.0));
                let shown: Vec<f32> = ledger.visible().flat_map(|b| b.iter().map(|d| d.x)).collect();
                for i in 0..batches {
                    let known = dab_arrival[i] + 1 <= frame;
                    let in_tiles = on_gpu[i];
                    let in_wet = shown.contains(&(i as f32));
                    if known {
                        assert!(in_tiles || in_wet, "frame {frame}: dab {i} is in neither layer (gap)");
                    }
                    assert!(!(in_tiles && in_wet), "frame {frame}: dab {i} is in both layers (double paint)");
                }
            }
        }
    }
}
