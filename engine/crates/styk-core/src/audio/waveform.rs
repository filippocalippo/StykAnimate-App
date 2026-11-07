//! The key of a drawn waveform. The drawn bars depend on much more than the recording: two clips of one recording with
//! different trims draw different bars, and the track's volume sets their height (`src/audio-timeline.mjs` 260-262). A view
//! model cached by the asset and the zoom alone would show one clip's bars on another.

use std::collections::HashMap;
use std::sync::Arc;

use super::model::Clip;

/// Every input that changes the bars of one clip. Floats are compared by their bits: an edit and its undo give equal keys.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WaveformKey {
    /// The recording: its id and the size and duration stored in the asset (its revision).
    pub asset: (Arc<str>, u64, u64),
    pub source_offset: u64,
    pub duration: u64,
    /// The clip's gain times its track's (it sets the bar height).
    pub effective_gain: u64,
    pub fade_in: u64,
    pub fade_out: u64,
    /// A muted track draws its bars faint.
    pub track_muted: bool,
    /// Horizontal scale (pixels per second) and the clip's width in pixels.
    pub pixels_per_second: u64,
    pub width_px: u32,
}

impl WaveformKey {
    /// `clip` is the audible-style clip whose `gain` already holds the track gain.
    pub fn new(asset: (Arc<str>, u64, u64), clip: &Clip, track_muted: bool, pixels_per_second: f64, width_px: u32) -> WaveformKey {
        WaveformKey {
            asset,
            source_offset: clip.offset.to_bits(),
            duration: clip.duration.to_bits(),
            effective_gain: clip.gain.to_bits(),
            fade_in: clip.fade_in.to_bits(),
            fade_out: clip.fade_out.to_bits(),
            track_muted,
            pixels_per_second: pixels_per_second.to_bits(),
            width_px,
        }
    }
}

/// A cache of view models by key, bounded in entries and bytes; the least recently used goes first.
pub struct WaveformCache<V> {
    max_entries: usize,
    max_bytes: usize,
    bytes: usize,
    clock: u64,
    entries: HashMap<WaveformKey, (V, usize, u64)>,
}

impl<V> WaveformCache<V> {
    pub fn new(max_entries: usize, max_bytes: usize) -> WaveformCache<V> {
        WaveformCache { max_entries, max_bytes, bytes: 0, clock: 0, entries: HashMap::new() }
    }

    pub fn get(&mut self, key: &WaveformKey) -> Option<&V> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|entry| {
            entry.2 = clock;
            &entry.0
        })
    }

    /// Caches `value` (`bytes` big). A value that alone is over the byte limit is refused (`false`) and the entry it would have
    /// replaced is gone: the limit has no exemption for the last entry.
    pub fn insert(&mut self, key: WaveformKey, value: V, bytes: usize) -> bool {
        self.clock += 1;
        if let Some((_, old, _)) = self.entries.remove(&key) {
            self.bytes -= old;
        }
        if bytes > self.max_bytes || self.max_entries == 0 {
            return false;
        }
        self.entries.insert(key, (value, bytes, self.clock));
        self.bytes += bytes;
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let oldest = self.entries.iter().min_by_key(|(_, e)| e.2).map(|(k, _)| k.clone()).expect("an entry to evict");
            if let Some((_, old, _)) = self.entries.remove(&oldest) {
                self.bytes -= old;
            }
        }
        true
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(offset: f64, duration: f64, gain: f64) -> Clip {
        Clip { asset_id: Arc::from("sound-a"), start: 1.0, offset, duration, gain, fade_in: 0.1, fade_out: 0.2 }
    }

    fn key(c: &Clip, muted: bool) -> WaveformKey {
        WaveformKey::new((Arc::from("sound-a"), 1000, 5.0f64.to_bits()), c, muted, 100.0, 300)
    }

    #[test]
    fn clips_of_one_recording_with_different_trims_gains_or_track_state_have_different_keys() {
        let base = clip(0.0, 3.0, 1.0);
        assert_ne!(key(&base, false), key(&clip(0.5, 3.0, 1.0), false), "source offset");
        assert_ne!(key(&base, false), key(&clip(0.0, 2.0, 1.0), false), "duration");
        assert_ne!(key(&base, false), key(&clip(0.0, 3.0, 0.5), false), "clip or track gain");
        assert_ne!(key(&base, false), key(&base, true), "a muted track");
        let moved = Clip { start: 9.0, ..base.clone() };
        assert_eq!(key(&base, false), key(&moved, false), "moving a clip on the timeline does not change its bars");
        let faded = Clip { fade_in: 0.3, ..base.clone() };
        assert_ne!(key(&base, false), key(&faded, false), "fade in");
    }

    #[test]
    fn an_edit_and_its_undo_hit_the_same_entry_and_the_cache_is_bounded() {
        let mut cache: WaveformCache<Vec<u8>> = WaveformCache::new(3, 100);
        let a = clip(0.0, 3.0, 1.0);
        cache.insert(key(&a, false), vec![1], 40);
        let edited = clip(0.5, 2.5, 1.0);
        cache.insert(key(&edited, false), vec![2], 40);
        let undone = clip(0.0, 3.0, 1.0);
        assert_eq!(cache.get(&key(&undone, false)), Some(&vec![1]), "undo returns the first key");
        cache.insert(key(&clip(1.0, 1.0, 1.0), false), vec![3], 40);
        assert!(cache.bytes() <= 100, "bounded by bytes");
        assert!(cache.get(&key(&edited, false)).is_none(), "the least recently used went first");
        assert!(cache.get(&key(&undone, false)).is_some());
        for i in 0..10 {
            cache.insert(key(&clip(i as f64, 1.0, 1.0), true), vec![0], 1);
        }
        assert!(cache.len() <= 3, "bounded by entries");
    }

    #[test]
    fn a_value_over_the_byte_limit_is_refused_not_kept_as_the_one_exempt_entry() {
        let mut cache: WaveformCache<Vec<u8>> = WaveformCache::new(8, 100);
        let first = key(&clip(0.0, 3.0, 1.0), false);
        cache.insert(first.clone(), vec![1], 40);
        cache.insert(first.clone(), vec![2; 1 << 20], 1 << 20);
        assert!(cache.get(&first).is_none(), "the oversized value is not cached, and it replaced the old one");
        assert_eq!((cache.len(), cache.bytes()), (0, 0));
        let other = key(&clip(1.0, 1.0, 1.0), false);
        cache.insert(other.clone(), vec![3], 100);
        assert!(cache.get(&other).is_some(), "a value that fits exactly is kept");
    }
}
