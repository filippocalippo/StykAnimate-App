//! The mix plan: what plays, resolved to its sources, immutable and shared by `Arc`.

use super::mix::{mix_clip, saturate, MixError};
use super::model::{Clip, RATE};
use super::wav::WavSource;

/// An audible clip with its source.
#[derive(Clone, Debug)]
pub struct PlanClip {
    pub clip: Clip,
    pub source: WavSource,
}

/// The audible clips **in document order** with their sources. Every block is a scan of the clips in that order: with
/// 4096 clips at most that is microseconds per block, and it is exactly the order `mixAudio` sums in.
#[derive(Debug, Default)]
pub struct MixPlan {
    clips: Vec<PlanClip>,
}

impl MixPlan {
    pub fn new(clips: Vec<PlanClip>) -> MixPlan {
        MixPlan { clips }
    }

    pub fn clips(&self) -> &[PlanClip] {
        &self.clips
    }

    pub fn is_empty(&self) -> bool {
        self.clips.is_empty()
    }

    /// The project sample where the last clip ends.
    pub fn end_sample(&self) -> u64 {
        self.clips.iter().map(|c| ((c.clip.start + c.clip.duration) * RATE as f64).ceil() as u64).max().unwrap_or(0)
    }

    /// Mixes `out.len() / 2` frames starting at project sample `start_sample`. Allocation free.
    pub fn mix(&self, start_sample: u64, out: &mut [f32]) -> Result<(), MixError> {
        let frames = out.len() / 2;
        if out.len() % 2 != 0 || frames < 1 || frames > RATE as usize {
            return Err(MixError::Range);
        }
        out.fill(0.0);
        for planned in &self.clips {
            mix_clip(&planned.clip, Some(&planned.source), start_sample, frames, out)?;
        }
        saturate(out);
        Ok(())
    }
}
