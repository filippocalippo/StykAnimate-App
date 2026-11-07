//! Decoded recordings and the memory they may take.
//!
//! Today the cache holds decoded recordings up to 768 MiB, evicts the ones the active mix does not need, and an active mix over
//! the limit fails explicitly and releases the cache. Natively a decoded buffer lives as long as anything holds it, so
//! eviction alone does not bound memory: one [`Budget`] counts every live allocation of decoded audio (a recording being
//! decoded, one pinned by a plan, one evicted but still held by a playing plan), by a [`Reservation`] that lives exactly as
//! long as the bytes do. Reserving comes **before** copying; a failed or cancelled decode gives its reservation back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use styk_services::audio::{AudioDecoder, AudioError};
use styk_services::Cancel;

use super::model::{Asset, RATE};
use super::wav::{parse_wave, SourceBytes, WavSource};

/// `CACHE_BYTES`.
pub const CACHE_BYTES: u64 = 768 * 1024 * 1024;

/// A bound on bytes shared by everything that holds decoded audio.
pub struct Budget {
    limit: u64,
    used: AtomicU64,
}

impl Budget {
    pub fn new(limit: u64) -> Arc<Budget> {
        Arc::new(Budget { limit, used: AtomicU64::new(0) })
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    pub fn used(&self) -> u64 {
        self.used.load(Ordering::SeqCst)
    }

    /// Takes `bytes` or refuses; nothing is taken on a refusal.
    pub fn reserve(self: &Arc<Budget>, bytes: u64) -> Result<Reservation, AudioError> {
        self.take(bytes)?;
        Ok(Reservation { budget: self.clone(), bytes })
    }

    fn take(&self, bytes: u64) -> Result<(), AudioError> {
        let mut used = self.used.load(Ordering::SeqCst);
        loop {
            let next = used.checked_add(bytes).filter(|&n| n <= self.limit).ok_or(AudioError::OverBudget { needed: used.saturating_add(bytes), limit: self.limit })?;
            match self.used.compare_exchange_weak(used, next, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Ok(()),
                Err(actual) => used = actual,
            }
        }
    }
}

/// Bytes taken from a [`Budget`]; given back when dropped.
pub struct Reservation {
    budget: Arc<Budget>,
    bytes: u64,
}

impl Reservation {
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Grows or shrinks to `bytes`. A growth that does not fit leaves the reservation as it was.
    pub fn resize(&mut self, bytes: u64) -> Result<(), AudioError> {
        if bytes > self.bytes {
            self.budget.take(bytes - self.bytes)?;
        } else {
            self.budget.used.fetch_sub(self.bytes - bytes, Ordering::SeqCst);
        }
        self.bytes = bytes;
        Ok(())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

type Key = (Arc<str>, u64, u64);

struct Entry {
    key: Key,
    source: WavSource,
    /// A counter that grows at every use: the least recently used goes first.
    used: u64,
}

/// The decoded recordings of one document, shared by its plans.
pub struct SourceStore {
    budget: Arc<Budget>,
    decoder: Arc<dyn AudioDecoder>,
    entries: Mutex<(Vec<Entry>, u64)>,
    /// One decode at a time, as today (one audio import at a time).
    decoding: Mutex<()>,
}

/// The decoded duration may differ from the stored one by this much (`1 / 100`).
const DURATION_TOLERANCE: f64 = 1.0 / 100.0;

/// Bytes a decoded recording of `seconds` takes as the decoder writes it: a WAV header and 48 kHz stereo 16-bit.
pub fn decoded_bytes(seconds: f64) -> u64 {
    44 + (seconds * RATE as f64 * 4.0).ceil() as u64
}

impl SourceStore {
    pub fn new(budget: Arc<Budget>, decoder: Arc<dyn AudioDecoder>) -> Arc<SourceStore> {
        Arc::new(SourceStore { budget, decoder, entries: Mutex::new((Vec::new(), 0)), decoding: Mutex::new(()) })
    }

    pub fn budget(&self) -> &Arc<Budget> {
        &self.budget
    }

    /// Recordings the cache holds (pinned or not).
    pub fn cached(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).0.len()
    }

    /// Drops every cached recording nothing else holds. What a plan holds stays until the plan lets go.
    pub fn release_unpinned(&self) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.0.retain(|e| Arc::strong_count(&e.source.bytes) > 1);
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).0.clear();
    }

    fn lookup(&self, key: &Key) -> Option<WavSource> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.1 += 1;
        let tick = entries.1;
        let entry = entries.0.iter_mut().find(|e| &e.key == key)?;
        entry.used = tick;
        Some(entry.source.clone())
    }

    /// Evicts the least recently used recording nothing but the cache holds and that is not in `keep`. False when none.
    fn evict_one(&self, keep: &[Key]) -> bool {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let victim = entries.0.iter().enumerate().filter(|(_, e)| Arc::strong_count(&e.source.bytes) == 1 && !keep.contains(&e.key)).min_by_key(|(_, e)| e.used).map(|(i, _)| i);
        match victim {
            Some(i) => {
                entries.0.swap_remove(i);
                true
            }
            None => false,
        }
    }

    /// Takes `bytes` for a new allocation, evicting unpinned recordings (not those of `keep`) until it fits.
    fn reserve(&self, bytes: u64, keep: &[Key]) -> Result<Reservation, AudioError> {
        loop {
            match self.budget.reserve(bytes) {
                Ok(reservation) => return Ok(reservation),
                Err(error) => {
                    if !self.evict_one(keep) {
                        // The active mix does not fit: as today, the cache is released and the mix refused.
                        self.release_unpinned();
                        return Err(error);
                    }
                }
            }
        }
    }

    fn grow(&self, reservation: &mut Reservation, bytes: u64, keep: &[Key]) -> Result<(), AudioError> {
        loop {
            match reservation.resize(bytes) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if !self.evict_one(keep) {
                        self.release_unpinned();
                        return Err(error);
                    }
                }
            }
        }
    }

    /// The decoded recordings of `assets`, from the cache or decoded now (`prepare` of the engine). `keep` are the keys of the
    /// whole active mix: none of them is evicted to make room for another.
    pub fn ensure(&self, assets: &[&Asset], cancel: &Cancel) -> Result<Vec<WavSource>, AudioError> {
        let result = self.ensure_all(assets, cancel);
        if matches!(result, Err(AudioError::OverBudget { .. })) {
            // The active mix does not fit: as today, the cache is released with the refusal (what a plan holds stays).
            self.release_unpinned();
        }
        result
    }

    fn ensure_all(&self, assets: &[&Asset], cancel: &Cancel) -> Result<Vec<WavSource>, AudioError> {
        let keep: Vec<Key> = assets.iter().map(|a| a.identity()).collect();
        let mut out = Vec::with_capacity(assets.len());
        let mut pinned = HashMap::new();
        for asset in assets {
            if cancel.is_cancelled() {
                return Err(AudioError::Cancelled);
            }
            let key = asset.identity();
            if let Some(source) = pinned.get(&key).cloned().or_else(|| self.lookup(&key)) {
                pinned.insert(key, source.clone());
                out.push(source);
                continue;
            }
            let source = self.decode(asset, &keep, cancel)?;
            pinned.insert(key.clone(), source.clone());
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.1 += 1;
            let used = entries.1;
            entries.0.push(Entry { key, source: source.clone(), used });
            drop(entries);
            out.push(source);
        }
        Ok(out)
    }

    fn decode(&self, asset: &Asset, keep: &[Key], cancel: &Cancel) -> Result<WavSource, AudioError> {
        let _one_at_a_time = self.decoding.lock().unwrap_or_else(|e| e.into_inner());
        if cancel.is_cancelled() {
            return Err(AudioError::Cancelled);
        }
        // The original is assembled from the document's chunks (at most 32 MiB): reserved before it is copied.
        let mut reservation = self.reserve(asset.size, keep)?;
        let original = asset.original().ok_or_else(|| AudioError::Decode("the embedded recording is not valid".into()))?;
        let source = match parse_wave(&original) {
            // A plain WAV is mixed as it is; the reservation now accounts for these very bytes.
            Ok(header) => WavSource::new(header, Arc::new(SourceBytes::held(original, Box::new(reservation)))),
            Err(_) => {
                let base = original.len() as u64;
                // The decoded output is expected to take [`decoded_bytes`] of the stored duration: reserved before the decoder starts.
                self.grow(&mut reservation, base + decoded_bytes(asset.duration), keep)?;
                let mut grow = |output: u64| self.grow(&mut reservation, base + output, keep);
                let decoded = self.decoder.decode(&original, asset.duration, &mut grow, cancel)?;
                drop(original);
                // From here the decoded bytes are all that is held.
                reservation.resize(decoded.len() as u64)?;
                let header = parse_wave(&decoded).map_err(|e| AudioError::Decode(format!("this recording could not be decoded: {e}")))?;
                WavSource::new(header, Arc::new(SourceBytes::held(decoded, Box::new(reservation))))
            }
        };
        if (source.duration - asset.duration).abs() > DURATION_TOLERANCE {
            return Err(AudioError::Decode(format!("the decoded duration of {} has changed", asset.id)));
        }
        Ok(source)
    }
}
