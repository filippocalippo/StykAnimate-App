//! The bounded queue between an input source and the application core, and what it does when it is full.

use super::{InputEvent, Phase};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

/// Called when the queue goes from empty to not empty, to wake the event loop that will drain it.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

/// Events the queue holds before it starts to shed.
pub const CAPACITY: usize = 4096;

/// Room kept beyond [`CAPACITY`] for terminal events and the overflow notice, so a gesture can always end.
pub const RESERVE: usize = 64;

/// Gestures the queue keeps open at once. Each may need one terminal event, and there is one overflow notice, so
/// `MAX_GESTURES + 1` fits in the reserve and the queue never holds more than `CAPACITY + RESERVE` events.
pub const MAX_GESTURES: usize = RESERVE - 1;

/// What the queue has done since it was made.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QueueStats {
    /// Events waiting now.
    pub queued: usize,
    /// The most events that ever waited at once.
    pub high_water: usize,
    /// Hover samples dropped because the queue was full.
    pub dropped_hover: u64,
    /// Contact samples dropped because the queue was full: a stroke lost points.
    pub dropped_moves: u64,
    /// Presses refused because the queue was full; their strokes are refused with them.
    pub refused_downs: u64,
    /// Overflow notices queued.
    pub overflows: u64,
    /// Lifts, interrupts and contact samples of a gesture the queue never admitted: redundant, so not queued.
    pub ignored: u64,
}

struct Inner {
    events: VecDeque<InputEvent>,
    /// Events lost since the last drain, for the notice.
    lost: u32,
    /// Pointers whose press was admitted and whose end has not been.
    open: Vec<u32>,
    /// Whether the notice for the current run of losses is already queued.
    noticed: bool,
    stats: QueueStats,
    waker: Option<Waker>,
}

/// A bounded multi-producer queue of input events. Clones share one queue. Its lock is held only to move a few bytes, so
/// the interface thread never waits on it for long.
///
/// **Overflow protocol.** Below [`CAPACITY`] every event is kept in order. At capacity a hover sample is dropped
/// (the oldest queued hover makes room for a new one), a contact sample is dropped and counted, and a press is refused;
/// the first loss queues one [`InputEvent::Overflowed`], which the consumer reads as "the stroke in progress is
/// damaged": it ends and keeps its ink, and the next press starts clean. The queue tracks the gestures it has admitted: the
/// end of an admitted gesture (a pen lifting, an interrupt) is always accepted, into a reserve that holds exactly one end per
/// open gesture ([`MAX_GESTURES`], more presses are refused and said so) and the notice, so the queue never holds more than
/// `CAPACITY + RESERVE` events and nothing is ever evicted to make room. An end for a gesture that was never admitted is
/// redundant and only counted.
#[derive(Clone)]
pub struct InputQueue {
    inner: Arc<Mutex<Inner>>,
    capacity: usize,
}

impl Default for InputQueue {
    fn default() -> InputQueue {
        InputQueue::with_capacity(CAPACITY)
    }
}

impl std::fmt::Debug for InputQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputQueue").field("capacity", &self.capacity).field("stats", &self.stats()).finish()
    }
}

impl InputQueue {
    pub fn new() -> InputQueue {
        InputQueue::default()
    }

    /// A queue that sheds after `capacity` events (tests use a small one).
    pub fn with_capacity(capacity: usize) -> InputQueue {
        InputQueue {
            inner: Arc::new(Mutex::new(Inner { events: VecDeque::new(), lost: 0, open: Vec::new(), noticed: false, stats: QueueStats::default(), waker: None })),
            capacity,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sets what wakes the consumer when the queue stops being empty.
    pub fn set_waker(&self, waker: Waker) {
        self.lock().waker = Some(waker);
    }

    /// Adds an event, applying the overflow protocol. Returns whether the event was kept.
    pub fn push(&self, event: InputEvent) -> bool {
        let (kept, wake) = {
            let mut inner = self.lock();
            let was_empty = inner.events.is_empty();
            let kept = self.admit(&mut inner, event);
            let high = inner.events.len();
            inner.stats.high_water = inner.stats.high_water.max(high);
            (kept, if was_empty && !inner.events.is_empty() { inner.waker.clone() } else { None })
        };
        if let Some(wake) = wake {
            wake();
        }
        kept
    }

    fn admit(&self, inner: &mut Inner, event: InputEvent) -> bool {
        match event {
            InputEvent::Overflowed { .. } => false,
            InputEvent::Interrupted { pointer, .. } => {
                // The end of a gesture the queue admitted always fits (the reserve is kept for exactly these); one it never
                // admitted is redundant: nothing is open for it.
                if Self::close(inner, pointer) {
                    inner.events.push_back(event);
                    true
                } else {
                    inner.stats.ignored += 1;
                    false
                }
            }
            InputEvent::Sample(sample) => match sample.phase {
                Phase::Up => {
                    if Self::close(inner, sample.pointer) {
                        inner.events.push_back(event);
                        true
                    } else {
                        inner.stats.ignored += 1;
                        false
                    }
                }
                Phase::Down => {
                    if inner.open.contains(&sample.pointer) {
                        // A press for a pointer whose gesture is still open (its lift never came): today's controller ignores a
                        // second pointerdown while a gesture is open (`down` returns), and so does this. The stroke goes on.
                        inner.stats.ignored += 1;
                        return false;
                    }
                    if inner.events.len() < self.capacity && inner.open.len() < MAX_GESTURES {
                        inner.open.push(sample.pointer);
                        inner.events.push_back(event);
                        true
                    } else {
                        inner.stats.refused_downs += 1;
                        self.note_loss(inner);
                        false
                    }
                }
                Phase::Move => {
                    if !inner.open.contains(&sample.pointer) {
                        // Its press was refused (and said so): the rest of that stroke is not queued.
                        inner.stats.ignored += 1;
                        false
                    } else if inner.events.len() < self.capacity {
                        inner.events.push_back(event);
                        true
                    } else {
                        inner.stats.dropped_moves += 1;
                        self.note_loss(inner);
                        false
                    }
                }
                Phase::Hover => {
                    if inner.events.len() < self.capacity {
                        inner.events.push_back(event);
                        return true;
                    }
                    inner.stats.dropped_hover += 1;
                    match inner.events.iter().position(|queued| matches!(queued, InputEvent::Sample(s) if s.phase == Phase::Hover)) {
                        Some(at) => {
                            inner.events.remove(at);
                            inner.events.push_back(event);
                            true
                        }
                        None => false,
                    }
                }
            },
        }
    }

    /// Takes a pointer out of the open gestures; whether it was open.
    fn close(inner: &mut Inner, pointer: u32) -> bool {
        match inner.open.iter().position(|p| *p == pointer) {
            Some(at) => {
                inner.open.swap_remove(at);
                true
            }
            None => false,
        }
    }

    fn note_loss(&self, inner: &mut Inner) {
        inner.lost = inner.lost.saturating_add(1);
        if !inner.noticed {
            inner.noticed = true;
            inner.stats.overflows += 1;
            inner.events.push_back(InputEvent::Overflowed { dropped: 0 });
        }
    }

    /// Moves every queued event, oldest first, to the end of `out`. The overflow notice carries the number of events lost
    /// since the previous drain.
    pub fn drain(&self, out: &mut Vec<InputEvent>) {
        let mut inner = self.lock();
        let lost = inner.lost;
        out.extend(inner.events.drain(..).map(|event| match event {
            InputEvent::Overflowed { .. } => InputEvent::Overflowed { dropped: lost },
            other => other,
        }));
        inner.lost = 0;
        inner.noticed = false;
    }

    pub fn stats(&self) -> QueueStats {
        let inner = self.lock();
        QueueStats { queued: inner.events.len(), ..inner.stats }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{InterruptReason, PenSample, Tool};
    use super::*;

    fn sample(time_ns: u64, phase: Phase) -> InputEvent {
        let mut sample = PenSample::at(time_ns, 1, Tool::Pen, time_ns as f64, 0.0);
        sample.phase = phase;
        InputEvent::Sample(sample)
    }

    fn drained(queue: &InputQueue) -> Vec<InputEvent> {
        let mut out = Vec::new();
        queue.drain(&mut out);
        out
    }

    #[test]
    fn events_keep_their_order() {
        let queue = InputQueue::with_capacity(8);
        for t in 0..5 {
            assert!(queue.push(sample(t, if t == 0 { Phase::Down } else { Phase::Move })));
        }
        let times: Vec<u64> = drained(&queue).iter().map(|e| if let InputEvent::Sample(s) = e { s.time_ns } else { u64::MAX }).collect();
        assert_eq!(times, [0, 1, 2, 3, 4]);
        assert!(drained(&queue).is_empty());
    }

    #[test]
    fn a_full_queue_drops_hover_first_and_never_a_pen_up() {
        let queue = InputQueue::with_capacity(4);
        queue.push(sample(0, Phase::Hover));
        queue.push(sample(1, Phase::Down));
        queue.push(sample(2, Phase::Move));
        queue.push(sample(3, Phase::Move));
        // Full. A new hover replaces the oldest hover.
        assert!(queue.push(sample(4, Phase::Hover)));
        // A move is lost and the loss is announced once.
        assert!(!queue.push(sample(5, Phase::Move)));
        assert!(!queue.push(sample(6, Phase::Move)));
        // The pen lifting gets in whatever the queue holds.
        assert!(queue.push(sample(7, Phase::Up)));
        let events = drained(&queue);
        assert_eq!(events.iter().filter(|e| matches!(e, InputEvent::Overflowed { .. })).count(), 1);
        assert!(matches!(events.last(), Some(InputEvent::Sample(s)) if s.phase == Phase::Up));
        assert!(events.iter().any(|e| matches!(e, InputEvent::Overflowed { dropped: 2 })));
        let stats = queue.stats();
        assert_eq!((stats.dropped_moves, stats.overflows), (2, 1));
    }

    fn pointer_sample(pointer: u32, time_ns: u64, phase: Phase) -> InputEvent {
        let mut sample = PenSample::at(time_ns, pointer, Tool::Pen, 0.0, 0.0);
        sample.phase = phase;
        InputEvent::Sample(sample)
    }

    #[test]
    fn terminal_events_never_grow_the_queue_past_its_bound() {
        let queue = InputQueue::with_capacity(8);
        // Every pointer that is let in may end; nothing else may ride the reserve.
        for pointer in 0..10 {
            queue.push(pointer_sample(pointer, pointer as u64, Phase::Down));
        }
        for pointer in 0..10_000u32 {
            queue.push(InputEvent::Interrupted { pointer, time_ns: 1, reason: InterruptReason::CaptureLost });
            queue.push(pointer_sample(pointer % 50, 5, Phase::Up));
        }
        assert!(queue.stats().high_water <= 8 + RESERVE, "{:?}", queue.stats());
        assert!(queue.stats().queued <= 8 + RESERVE);
    }

    #[test]
    fn a_terminal_event_never_removes_a_press_or_a_move() {
        let queue = InputQueue::with_capacity(4);
        queue.push(pointer_sample(1, 1, Phase::Down));
        queue.push(pointer_sample(1, 2, Phase::Move));
        queue.push(pointer_sample(1, 3, Phase::Move));
        queue.push(pointer_sample(1, 4, Phase::Move));
        for pointer in 100..(100 + 2 * RESERVE as u32) {
            queue.push(InputEvent::Interrupted { pointer, time_ns: 9, reason: InterruptReason::Canceled });
        }
        queue.push(pointer_sample(1, 10, Phase::Up));
        let events = drained(&queue);
        let times: Vec<u64> = events.iter().filter_map(|e| if let InputEvent::Sample(s) = e { Some(s.time_ns) } else { None }).collect();
        assert_eq!(times, [1, 2, 3, 4, 10], "the stroke is whole and its lift is last");
    }

    #[test]
    fn a_lift_or_interrupt_of_a_gesture_that_was_never_admitted_is_counted_not_queued() {
        let queue = InputQueue::with_capacity(2);
        queue.push(pointer_sample(1, 1, Phase::Hover));
        queue.push(pointer_sample(1, 2, Phase::Hover));
        assert!(!queue.push(pointer_sample(5, 3, Phase::Down)), "a press with no room is refused, and said so");
        assert!(!queue.push(pointer_sample(5, 4, Phase::Up)));
        assert!(!queue.push(InputEvent::Interrupted { pointer: 5, time_ns: 5, reason: InterruptReason::FocusLost }));
        let events = drained(&queue);
        assert_eq!(events.iter().filter(|e| matches!(e, InputEvent::Overflowed { .. })).count(), 1);
        assert!(queue.stats().ignored >= 2);
    }

    #[test]
    fn after_saturation_and_release_a_new_stroke_is_whole() {
        let queue = InputQueue::with_capacity(16);
        queue.push(sample(0, Phase::Down));
        for t in 1..200 {
            queue.push(sample(t, Phase::Move));
        }
        queue.push(sample(200, Phase::Up));
        let first = drained(&queue);
        assert!(first.iter().any(|e| matches!(e, InputEvent::Overflowed { .. })));
        assert!(matches!(first.last(), Some(InputEvent::Sample(s)) if s.phase == Phase::Up));
        // Released: the next stroke arrives complete and in order, with no notice.
        queue.push(sample(300, Phase::Down));
        for t in 301..310 {
            queue.push(sample(t, Phase::Move));
        }
        queue.push(sample(310, Phase::Up));
        let second = drained(&queue);
        assert_eq!(second.len(), 11);
        assert!(!second.iter().any(|e| matches!(e, InputEvent::Overflowed { .. })));
    }

    #[test]
    fn a_press_for_a_pointer_whose_gesture_is_open_is_ignored_and_the_stroke_goes_on() {
        let queue = InputQueue::with_capacity(16);
        queue.push(pointer_sample(1, 1, Phase::Down));
        queue.push(pointer_sample(1, 2, Phase::Move));
        // The lift was lost; a second press arrives for the same pointer, then the stroke continues and ends.
        assert!(!queue.push(pointer_sample(1, 3, Phase::Down)));
        queue.push(pointer_sample(1, 4, Phase::Move));
        queue.push(pointer_sample(1, 5, Phase::Up));
        let events = drained(&queue);
        assert!(!events.iter().any(|e| matches!(e, InputEvent::Overflowed { .. })), "no overflow notice ends the stroke");
        let times: Vec<u64> = events.iter().filter_map(|e| if let InputEvent::Sample(s) = e { Some(s.time_ns) } else { None }).collect();
        assert_eq!(times, [1, 2, 4, 5]);
        // The lift closed it: the next press is a new stroke.
        assert!(queue.push(pointer_sample(1, 6, Phase::Down)));
    }

    #[test]
    fn a_press_is_refused_with_its_stroke_when_the_queue_is_full() {
        let queue = InputQueue::with_capacity(2);
        queue.push(sample(0, Phase::Hover));
        queue.push(sample(1, Phase::Hover));
        assert!(!queue.push(sample(2, Phase::Down)));
        assert_eq!(queue.stats().refused_downs, 1);
        assert!(drained(&queue).iter().any(|e| matches!(e, InputEvent::Overflowed { .. })));
    }

    #[test]
    fn the_waker_runs_when_the_queue_stops_being_empty() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let woken = Arc::new(AtomicUsize::new(0));
        let queue = InputQueue::new();
        let counter = woken.clone();
        queue.set_waker(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        queue.push(sample(0, Phase::Down));
        queue.push(sample(1, Phase::Move));
        assert_eq!(woken.load(Ordering::SeqCst), 1);
        drained(&queue);
        queue.push(sample(2, Phase::Move));
        assert_eq!(woken.load(Ordering::SeqCst), 2);
    }
}
