//! Where generated effects' targets were on earlier ticks, kept across frames
//! (docs/engine/vfx.md, Generated effects; `GeneratorAnchors` in
//! src/vfx-generator-anchors.mjs). Particles keep the anchor their target had
//! when they were born, so a frame's batch reads targets on up to a lifetime of
//! earlier ticks; consecutive frames share almost all of them.
//!
//! One cache per document generation, shared by the workers preparing playback
//! and the interface thread drawing edit frames. A miss evaluates the document
//! at that tick once and reads every generator target of the document there.
//! Lookups take the spinning lock for a map access; evaluation runs outside it
//! (two threads may evaluate the same tick; the second result is dropped).

use std::collections::HashMap;
use std::sync::Arc;

use styk_eval::eval::Prepared;
use styk_eval::vfx::generated::anchors::{anchor, evaluate_at, Anchor, Sample, Sampler};
use styk_eval::vfx::paint::js_round;
use styk_eval::vfx::{Kind, Target};

use crate::sync::Shared;
use crate::Clock;

/// Entries kept at most, over every document of the generation (`maxEntries`).
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    /// The document (a movieclip's prepared timeline, or the generation's own).
    doc: usize,
    target: Target,
    tick: i64,
    attached: bool,
}

#[derive(Default)]
struct State {
    entries: HashMap<Key, (Option<Arc<Anchor>>, u64)>,
    /// Generator targets per document, and whether each covers attached parts.
    targets: HashMap<usize, Arc<[(Target, bool)]>>,
    uses: u64,
}

/// The anchor cache of one generation.
pub struct Anchors {
    state: Shared<State>,
}

impl Default for Anchors {
    fn default() -> Anchors {
        Anchors { state: Shared::new(State::default()) }
    }
}

/// Every target the generator clips of `prepared`'s document sample: each clip's
/// target as the clip covers it, and with its attached parts for an aura.
fn targets_of(prepared: &Prepared) -> Vec<(Target, bool)> {
    let mut out: Vec<(Target, bool)> = Vec::new();
    for clip in prepared.doc.vfx_clips.iter().flat_map(|clips| clips.clips.iter()) {
        if clip.target == Target::Scene || !clip.has_generators() {
            continue;
        }
        let mut add = |entry: (Target, bool)| {
            if !out.contains(&entry) {
                out.push(entry);
            }
        };
        add((clip.target, clip.include_attached));
        if clip.effects.iter().any(|effect| effect.kind() == Kind::Aura) {
            add((clip.target, true));
        }
    }
    out
}

impl Anchors {
    pub fn new() -> Anchors {
        Anchors::default()
    }

    /// Entries held.
    pub fn len(&self) -> usize {
        self.state.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lookup(&self, key: &Key) -> Option<Option<Arc<Anchor>>> {
        let mut state = self.state.lock();
        state.uses += 1;
        let uses = state.uses;
        let entry = state.entries.get_mut(key)?;
        entry.1 = uses;
        Some(entry.0.clone())
    }

    fn targets(&self, prepared: &Prepared) -> Arc<[(Target, bool)]> {
        let doc = prepared as *const Prepared as usize;
        if let Some(found) = self.state.lock().targets.get(&doc) {
            return found.clone();
        }
        let found: Arc<[(Target, bool)]> = targets_of(prepared).into();
        self.state.lock().targets.insert(doc, found.clone());
        found
    }

    fn insert(&self, found: Vec<(Key, Option<Arc<Anchor>>)>) {
        let mut state = self.state.lock();
        state.uses += 1;
        let uses = state.uses;
        for (key, value) in found {
            state.entries.entry(key).or_insert((value, uses));
        }
        if state.entries.len() > MAX_ENTRIES {
            // Drop the least recently used quarter (rarely: a long trail on many targets).
            let mut ages: Vec<u64> = state.entries.values().map(|(_, used)| *used).collect();
            ages.sort_unstable();
            let cut = ages[state.entries.len() - MAX_ENTRIES * 3 / 4];
            state.entries.retain(|_, (_, used)| *used >= cut);
        }
    }

    /// A sampler over this cache that evaluates misses until `deadline` on `clock`
    /// (`f64::INFINITY`: always), then answers `Pending`.
    pub fn sampler(&self, clock: Clock, deadline: f64) -> Sampling<'_> {
        Sampling { anchors: self, clock, deadline }
    }
}

/// [`Anchors`] with a time budget.
pub struct Sampling<'a> {
    anchors: &'a Anchors,
    clock: Clock,
    deadline: f64,
}

impl Sampler for Sampling<'_> {
    fn sample(&self, prepared: &Prepared, target: Target, tick: f64, include_attached: bool) -> Sample {
        let tick = js_round(tick);
        let doc = prepared as *const Prepared as usize;
        let key = Key { doc, target, tick: tick as i64, attached: include_attached };
        if let Some(found) = self.anchors.lookup(&key) {
            return Sample::Ready(found);
        }
        if self.deadline.is_finite() && (self.clock)() > self.deadline {
            return Sample::Pending;
        }
        let (frame, scene) = evaluate_at(prepared, tick);
        let mut wanted: Vec<(Target, bool)> = self.anchors.targets(prepared).to_vec();
        if !wanted.contains(&(target, include_attached)) {
            wanted.push((target, include_attached));
        }
        let mut result = None;
        let found: Vec<(Key, Option<Arc<Anchor>>)> = wanted
            .into_iter()
            .map(|(t, attached)| {
                let value = anchor(&prepared.doc, &scene, &frame, t, true, attached).map(Arc::new);
                if t == target && attached == include_attached {
                    result = value.clone();
                }
                (Key { doc, target: t, tick: tick as i64, attached }, value)
            })
            .collect();
        self.anchors.insert(found);
        Sample::Ready(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cache_keeps_at_most_its_bound() {
        let anchors = Anchors::new();
        for round in 0..3 {
            let found = (0..MAX_ENTRIES as i64).map(|tick| (Key { doc: 1, target: Target::Figure { uid: round }, tick, attached: false }, None)).collect();
            anchors.insert(found);
            assert!(anchors.len() <= MAX_ENTRIES, "{} entries", anchors.len());
        }
        // The newest survive.
        assert!(anchors.lookup(&Key { doc: 1, target: Target::Figure { uid: 2 }, tick: 0, attached: false }).is_some());
    }
}
