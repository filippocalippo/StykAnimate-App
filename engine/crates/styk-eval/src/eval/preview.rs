//! Read-only in-between samples (`sampleInbetweenPreview`, editor-inbetween.mjs).
//! The caller keeps one sampling view per worker-held generation: typed poses,
//! figures and encoded media remain shared, and no document JSON is copied.

use std::sync::Arc;

use super::{Frame, Prepared};
use crate::channels::{Property, Target};
use crate::doc::{EasingMode, Keyframe};

/// `canInsertBackgroundTransition`: native frames store at most two backgrounds.
pub fn background_pair(a: &Keyframe, b: &Keyframe, ratio: f64) -> bool {
    if ratio == 0.0 || ratio == 1.0 { return true; }
    match (a.background_mix != 0.0, b.background_mix != 0.0) {
        (true, true) => a.background == b.background && a.background_b == b.background_b || a.background == b.background_b && a.background_b == b.background,
        (true, false) => b.background == a.background || b.background == a.background_b,
        (false, true) => a.background == b.background || a.background == b.background_b,
        (false, false) => true,
    }
}

impl Prepared {
    /// Pivot's in-between command forces native interpolation on and automatic
    /// easing off. Build once on the worker, preserving the authored document.
    pub fn inbetween_view(&self) -> Prepared {
        let mut doc = (*self.doc).clone();
        doc.version = 5;
        doc.auto_easing = false;
        Prepared::new(Arc::new(doc))
    }

    /// Samples the pose inserted immediately before `index`, with the same
    /// two-background constraint as the editor. Use on an `inbetween_view()`.
    pub fn inbetween(&self, index: usize, ratio: f64) -> Result<Frame, &'static str> {
        if !ratio.is_finite() || !(0.0..=1.0).contains(&ratio) { return Err("Choose an interpolation ratio from zero to one."); }
        let Some(row) = self.rows.get(index) else { return Err("Choose an existing source frame."); };
        let previous = index.saturating_sub(1);
        let sample_ratio = if index == 0 { 0.0 } else { ratio };
        let tick = self.rows[previous].start as f64 + (row.start - self.rows[previous].start) as f64 * sample_ratio;
        if index > 0 && !background_pair(&self.doc.keyframes[previous], &self.doc.keyframes[index], ratio) {
            return Err("This in-between needs more than two background images.");
        }
        if !self.scene_transition_fits(tick) {
            return Err("This in-between needs more than two background images.");
        }
        Ok(self.evaluate_interval(previous, sample_ratio, tick))
    }

    /// `sceneTransition` over every scene pose channel: whether the Scene track's blend
    /// between two keys at `tick` still names at most two background images.
    pub fn scene_transition_fits(&self, tick: f64) -> bool {
        let Some(channels) = &self.channels else { return true; };
        for (channel, track) in channels.animation.channels.iter().zip(&channels.tracks) {
            if channel.property != Property::Pose || channel.target != Target::Scene { continue; }
            let Some(track) = track else { continue; };
            let at = track.ticks.partition_point(|&start| start <= tick);
            let Some(index) = at.checked_sub(1) else { continue; };
            let Some(next) = track.keys.get(index + 1) else { continue; };
            let key = &track.keys[index];
            if key.easing.is_some_and(|e| e.mode == EasingMode::Constant) { continue; }
            let duration = track.ticks[index + 1] - track.ticks[index];
            if duration > 0.0 && !background_pair(&key.frame, &next.frame, (tick - track.ticks[index]) / duration) {
                return false;
            }
        }
        true
    }
}
