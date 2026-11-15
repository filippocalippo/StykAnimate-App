//! Where generated effects' targets were on earlier ticks, kept across frames
//! (docs/engine/vfx.md, Generated effects). Particles keep the place their target
//! had when they were born, so a frame's batch reads targets on up to a lifetime of
//! earlier ticks; consecutive frames share almost all of them.
//!
//! One cache per document generation, shared by the workers preparing playback
//! and the interface thread drawing edit frames. A miss evaluates the document's
//! generator targets (and only them) at that tick once. An edit that leaves every
//! figure's motion as it was (an effect's parameters, colours, clip timing) hands the
//! cache on to the next generation ([`Anchors::follow`]), so trails survive it. While a
//! frame's budget is spent, a sample is answered with the nearest tick known, so
//! nothing jumps far when the exact one arrives. Lookups take the spinning lock for a
//! map access; evaluation runs outside it (two threads may evaluate the same tick; the
//! second result is dropped).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use styk_eval::doc::Document;
use styk_eval::eval::Prepared;
use styk_eval::vfx::generated::anchors::{anchor, evaluate_targets, Anchor, Sample, Sampler};
use styk_eval::vfx::paint::js_round;
use styk_eval::vfx::{Kind, Target};

use crate::sync::Shared;
use crate::Clock;

/// Entries kept at most, over every document of the generation.
const MAX_ENTRIES: usize = 4096;

/// One target of one document: (document, target, with what is attached).
type Track = (usize, Target, bool);

#[derive(Default)]
struct State {
    /// Per target, its anchors by tick and when each was last used.
    tracks: HashMap<Track, BTreeMap<i64, (Option<Arc<Anchor>>, u64)>>,
    entries: usize,
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

/// Whether two documents move every figure the same way on every tick: the same figures,
/// keyframes, layers, timing sources, animation and canvas (shared, unchanged), whatever
/// their effects. Conservative: anything not shared counts as changed.
pub fn same_motion(a: &Document, b: &Document) -> bool {
    fn same<T>(x: &[Arc<T>], y: &[Arc<T>]) -> bool {
        x.len() == y.len() && x.iter().zip(y).all(|(p, q)| Arc::ptr_eq(p, q))
    }
    fn same_opt<T>(x: &Option<Arc<T>>, y: &Option<Arc<T>>) -> bool {
        match (x, y) {
            (None, None) => true,
            (Some(p), Some(q)) => Arc::ptr_eq(p, q),
            _ => false,
        }
    }
    a.canvas == b.canvas
        && a.fps == b.fps
        && a.auto_easing == b.auto_easing
        && a.origins == b.origins
        && same(&a.figures, &b.figures)
        && same(&a.keyframes, &b.keyframes)
        && same_opt(&a.layers, &b.layers)
        && same_opt(&a.sheet, &b.sheet)
        && same_opt(&a.animation, &b.animation)
        && same_opt(&a.movieclip_source, &b.movieclip_source)
        && a.frame_sources.len() == b.frame_sources.len()
        && a.frame_sources.iter().all(|(k, v)| b.frame_sources.get(k).is_some_and(|w| Arc::ptr_eq(v, w)))
}

impl Anchors {
    pub fn new() -> Anchors {
        Anchors::default()
    }

    /// The next generation's cache: this one's anchors when `next` moves every figure as
    /// `previous` did (an edit of effects alone), an empty one otherwise.
    pub fn follow(&self, previous: &Prepared, next: &Prepared) -> Anchors {
        let fresh = Anchors::new();
        if !same_motion(&previous.doc, &next.doc) {
            return fresh;
        }
        let (old_root, new_root) = (previous as *const Prepared as usize, next as *const Prepared as usize);
        let state = self.state.lock();
        let mut moved = fresh.state.lock();
        for ((doc, target, attached), entries) in &state.tracks {
            let doc = if *doc == old_root { new_root } else { *doc };
            moved.entries += entries.len();
            moved.tracks.insert((doc, *target, *attached), entries.clone());
        }
        moved.uses = state.uses;
        drop(moved);
        fresh
    }

    /// Entries held.
    pub fn len(&self) -> usize {
        self.state.lock().entries
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lookup(&self, track: &Track, tick: i64) -> Option<Option<Arc<Anchor>>> {
        let mut state = self.state.lock();
        state.uses += 1;
        let uses = state.uses;
        let entry = state.tracks.get_mut(track)?.get_mut(&tick)?;
        entry.1 = uses;
        Some(entry.0.clone())
    }

    /// The known anchor of `track` nearest `tick` (a present one).
    fn nearest_known(&self, track: &Track, tick: i64) -> Option<Arc<Anchor>> {
        let state = self.state.lock();
        let entries = state.tracks.get(track)?;
        let before = entries.range(..=tick).rev().find_map(|(t, (a, _))| a.clone().map(|a| (tick - t, a)));
        let after = entries.range(tick..).find_map(|(t, (a, _))| a.clone().map(|a| (t - tick, a)));
        match (before, after) {
            (Some(b), Some(a)) => Some(if a.0 < b.0 { a.1 } else { b.1 }),
            (Some(b), None) => Some(b.1),
            (None, Some(a)) => Some(a.1),
            (None, None) => None,
        }
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

    fn insert(&self, found: Vec<(Track, i64, Option<Arc<Anchor>>)>) {
        let mut state = self.state.lock();
        state.uses += 1;
        let uses = state.uses;
        for (track, tick, value) in found {
            let entries = state.tracks.entry(track).or_default();
            if let std::collections::btree_map::Entry::Vacant(slot) = entries.entry(tick) {
                slot.insert((value, uses));
                state.entries += 1;
            }
        }
        if state.entries > MAX_ENTRIES {
            // Drop the least recently used quarter (rarely: a long trail on many targets).
            let mut ages: Vec<u64> = state.tracks.values().flat_map(|e| e.values().map(|(_, used)| *used)).collect();
            ages.sort_unstable();
            let cut = ages[state.entries - MAX_ENTRIES * 3 / 4];
            let mut kept = 0;
            for entries in state.tracks.values_mut() {
                entries.retain(|_, (_, used)| *used >= cut);
                kept += entries.len();
            }
            state.tracks.retain(|_, e| !e.is_empty());
            state.entries = kept;
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
        let tick = js_round(tick).max(0.0) as i64;
        let doc = prepared as *const Prepared as usize;
        let track = (doc, target, include_attached);
        if let Some(found) = self.anchors.lookup(&track, tick) {
            return Sample::Ready(found);
        }
        if self.deadline.is_finite() && (self.clock)() > self.deadline {
            return Sample::Pending;
        }
        let mut wanted: Vec<(Target, bool)> = self.anchors.targets(prepared).to_vec();
        if !wanted.contains(&(target, include_attached)) {
            wanted.push((target, include_attached));
        }
        // Only the targets' geometry, not the whole document's.
        let (frame, scene) = evaluate_targets(prepared, tick as f64, &wanted);
        let mut result = None;
        let found: Vec<(Track, i64, Option<Arc<Anchor>>)> = wanted
            .into_iter()
            .map(|(t, attached)| {
                let value = anchor(&prepared.doc, &scene, &frame, t, true, attached).map(Arc::new);
                if t == target && attached == include_attached {
                    result = value.clone();
                }
                ((doc, t, attached), tick, value)
            })
            .collect();
        self.anchors.insert(found);
        Sample::Ready(result)
    }

    fn nearest(&self, prepared: &Prepared, target: Target, tick: f64, include_attached: bool) -> Option<Arc<Anchor>> {
        let doc = prepared as *const Prepared as usize;
        self.anchors.nearest_known(&(doc, target, include_attached), js_round(tick).max(0.0) as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cache_keeps_at_most_its_bound() {
        let anchors = Anchors::new();
        for round in 0..3 {
            let found = (0..MAX_ENTRIES as i64).map(|tick| ((1, Target::Figure { uid: round }, false), tick, None)).collect();
            anchors.insert(found);
            assert!(anchors.len() <= MAX_ENTRIES, "{} entries", anchors.len());
        }
        // The newest survive.
        assert!(anchors.lookup(&(1, Target::Figure { uid: 2 }, false), 0).is_some());
    }

    #[test]
    fn anchors_survive_an_edit_that_moves_no_figure() {
        use styk_eval::vfx::generated::stage::{Clip, Motion, Stage};
        let mut stage = Stage::new(30.0).clip(Clip::new(Some(1), "aura"));
        stage.figures[0].motion = Motion::Walk;
        let before = Arc::new(stage.prepare());
        let anchors = Anchors::new();
        let target = Target::Figure { uid: 1 };
        let clock: Clock = || 0.0;
        for tick in 0..10 {
            assert!(matches!(anchors.sampler(clock, f64::INFINITY).sample(&before, target, tick as f64, true), Sample::Ready(Some(_))));
        }
        // An effect's settings changed: the same figures and keyframes, other clips.
        let mut edited = (*before.doc).clone();
        edited.vfx_clips = None;
        let after = Arc::new(Prepared::new(Arc::new(edited)));
        let kept = anchors.follow(&before, &after);
        assert_eq!(kept.len(), anchors.len());
        let doc = &*after as *const Prepared as usize;
        assert!(kept.lookup(&(doc, target, true), 5).is_some_and(|a| a.is_some()), "found under the new generation");
        // A pose changed: nothing is kept.
        let mut moved = (*before.doc).clone();
        moved.keyframes = moved.keyframes.iter().map(|k| Arc::new((**k).clone())).collect();
        let after = Arc::new(Prepared::new(Arc::new(moved)));
        assert!(anchors.follow(&before, &after).is_empty());
    }

    #[test]
    fn a_pending_sample_is_answered_with_the_nearest_known_tick() {
        let anchors = Anchors::new();
        let at = |x: f64| Some(Arc::new(Anchor { point: [x, 0.0], center: [x, 0.0], bottom: 0.0, height: 0.0, measure: 0.0, segments: None }));
        let track = (1, Target::Figure { uid: 7 }, false);
        anchors.insert(vec![(track, 10, at(10.0)), (track, 20, at(20.0)), (track, 30, None)]);
        assert_eq!(anchors.nearest_known(&track, 14).unwrap().point[0], 10.0);
        assert_eq!(anchors.nearest_known(&track, 17).unwrap().point[0], 20.0);
        // A tick where the target was absent is not an answer.
        assert_eq!(anchors.nearest_known(&track, 29).unwrap().point[0], 20.0);
        assert!(anchors.nearest_known(&(1, Target::Figure { uid: 8 }, false), 14).is_none());
    }
}
