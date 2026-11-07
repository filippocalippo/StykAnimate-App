//! Times and identity for the history entries of pointer messages.
//!
//! The system hands a pen's samples in messages that each carry the history since the last one, and two messages can carry
//! the same entry. A source must therefore (1) give an entry the same time whichever message delivers it, so that a repeat is
//! recognised, and (2) give entries that share a time (millisecond stamps) distinct, increasing times, because the stroke
//! rules skip a sample whose time is not after the last one.
//!
//! An entry with a high-resolution counter keeps it. An entry with only a millisecond stamp (`dwTime`, which wraps at 2^32) is
//! placed by a mapping fixed once for the pointer: the first message's newest entry is taken to be the moment the message
//! arrived, and every later entry is that moment plus its distance in milliseconds. The mapping is the same for every
//! message of the pointer, so an overlapping entry is mapped to the same time however late its message arrived; it is fixed
//! again only if it drifts a quarter of a second from the arrival times.

use std::collections::VecDeque;

/// One history entry of a pointer message, as the system reported its time: the high-resolution counter converted to
/// nanoseconds (0 when the system gave none) and the millisecond clock (`dwTime`, which wraps at 2^32).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntryTime {
    pub counter_ns: u64,
    pub millis: u32,
}

/// Entries remembered to recognise a repeat.
const RECENT: usize = 64;

/// How far (nanoseconds) the newest mapped entry may be from the message's arrival before the mapping is fixed again.
const DRIFT_NS: u64 = 250_000_000;

/// The clock of one pointer's history.
#[derive(Debug, Default)]
pub struct HistoryClock {
    pointer: Option<u32>,
    /// The millisecond stamp and the nanosecond time it is mapped to.
    base: Option<(u32, u64)>,
    /// The last time handed out, for the distinct-time rule.
    last: u64,
    /// `(raw time, content)` of the entries already delivered.
    recent: VecDeque<(u64, u64)>,
}

impl HistoryClock {
    pub fn new() -> HistoryClock {
        HistoryClock::default()
    }

    /// Forgets the mapping and what was delivered (a new pointer, or a pointer that has been away).
    pub fn restart(&mut self) {
        *self = HistoryClock::default();
    }

    fn raw(&mut self, entry: EntryTime, newest_millis: u32, now_ns: u64) -> u64 {
        if entry.counter_ns != 0 {
            return entry.counter_ns;
        }
        let (base_millis, base_ns) = *self.base.get_or_insert((newest_millis, now_ns));
        let delta = i64::from(entry.millis.wrapping_sub(base_millis) as i32);
        (base_ns as i64 + delta * 1_000_000).max(0) as u64
    }

    /// The time for one entry of a message, or `None` if an earlier message already delivered it. `content` identifies what the
    /// entry says (position, pressure, phase) so two different entries of one millisecond are not taken for each other;
    /// `newest_millis` is the stamp of the message's newest entry and `now_ns` the time the message arrived.
    pub fn admit(&mut self, pointer: u32, entry: EntryTime, content: u64, newest_millis: u32, now_ns: u64) -> Option<u64> {
        if self.pointer != Some(pointer) {
            self.restart();
            self.pointer = Some(pointer);
        }
        if entry.counter_ns == 0 {
            if let Some((base_millis, base_ns)) = self.base {
                let newest = base_ns as i64 + i64::from(newest_millis.wrapping_sub(base_millis) as i32) * 1_000_000;
                if newest.abs_diff(now_ns as i64) > DRIFT_NS {
                    self.base = None;
                    self.recent.clear();
                }
            }
        }
        let raw = self.raw(entry, newest_millis, now_ns);
        if self.recent.contains(&(raw, content)) {
            return None;
        }
        if self.recent.len() == RECENT {
            self.recent.pop_front();
        }
        self.recent.push_back((raw, content));
        let time = raw.max(self.last + 1);
        self.last = time;
        Some(time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(millis: u32) -> EntryTime {
        EntryTime { counter_ns: 0, millis }
    }

    /// Delivers one message of `(millis, content)` entries, oldest first, arriving at `now_ns`.
    fn deliver(clock: &mut HistoryClock, entries: &[(u32, u64)], now_ns: u64) -> Vec<Option<u64>> {
        let newest = entries.last().unwrap().0;
        entries.iter().map(|&(millis, content)| clock.admit(1, entry(millis), content, newest, now_ns)).collect()
    }

    #[test]
    fn an_entry_two_messages_carry_gets_one_time_and_is_delivered_once() {
        let mut clock = HistoryClock::new();
        let first = deliver(&mut clock, &[(100, 1), (101, 2)], 1_000_000_000);
        // The next message arrives 30 ms late and repeats entry 101.
        let second = deliver(&mut clock, &[(101, 2), (102, 3)], 1_031_000_000);
        assert_eq!(first, [Some(999_000_000), Some(1_000_000_000)]);
        assert_eq!(second[0], None, "the repeat is recognised although its message came later");
        assert_eq!(second[1], Some(1_001_000_000), "the new entry keeps its distance from the others, not the late arrival");
    }

    #[test]
    fn entries_of_one_millisecond_get_distinct_increasing_times_across_messages() {
        let mut clock = HistoryClock::new();
        let a = deliver(&mut clock, &[(100, 1), (100, 2)], 5_000_000_000);
        let b = deliver(&mut clock, &[(100, 2), (100, 3), (101, 4)], 5_002_000_000);
        let times: Vec<u64> = a.iter().chain(b.iter()).flatten().copied().collect();
        assert_eq!(times.len(), 4, "entry 2 was delivered once");
        assert!(times.windows(2).all(|pair| pair[1] > pair[0]), "{times:?}");
    }

    #[test]
    fn a_millisecond_clock_that_wraps_keeps_its_order() {
        let mut clock = HistoryClock::new();
        let times = deliver(&mut clock, &[(u32::MAX - 1, 1), (1, 2)], 100_000_000);
        assert_eq!(times[1].unwrap() - times[0].unwrap(), 3_000_000);
    }

    #[test]
    fn a_counter_is_kept_and_a_new_pointer_starts_afresh() {
        let mut clock = HistoryClock::new();
        assert_eq!(clock.admit(1, EntryTime { counter_ns: 5_000, millis: 9 }, 1, 9, 1), Some(5_000));
        assert_eq!(clock.admit(1, EntryTime { counter_ns: 9_000, millis: 9 }, 2, 9, 1), Some(9_000));
        // Another pointer: what pointer 1 delivered is forgotten, and times are not ordered against it.
        assert_eq!(clock.admit(2, EntryTime { counter_ns: 5_000, millis: 9 }, 1, 9, 1), Some(5_000));
    }

    #[test]
    fn a_mapping_that_has_drifted_is_fixed_again() {
        let mut clock = HistoryClock::new();
        deliver(&mut clock, &[(100, 1)], 1_000_000_000);
        // Ten seconds on, the millisecond clock has moved 9.9 s: far from the arrival time, so the mapping is taken afresh.
        let later = deliver(&mut clock, &[(20_000, 2)], 12_000_000_000);
        assert_eq!(later, [Some(12_000_000_000)]);
    }
}
