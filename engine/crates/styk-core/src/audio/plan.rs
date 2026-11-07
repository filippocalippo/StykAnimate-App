//! The mix plan: what plays, resolved to its sources, immutable and shared by `Arc`.

use std::sync::Arc;

use styk_services::audio::AudioError;
use styk_services::Cancel;

use super::mix::{mix_clip, saturate, MixError};
use super::model::{AudioState, Clip, RATE};
use super::store::SourceStore;
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

/// `prepare` of the engine: the audible clips that touch `[start, end)` seconds, their recordings decoded (or found in the
/// store), as a plan. Runs on a worker; `cancel` ends it promptly, even inside the decoder.
pub fn build_plan(store: &SourceStore, state: &AudioState, start: f64, end: f64, cancel: &Cancel) -> Result<Arc<MixPlan>, AudioError> {
    let clips: Vec<Clip> = state.audible_clips().into_iter().filter(|clip| clip.start < end && clip.start + clip.duration > start).collect();
    let mut needed: Vec<&super::model::Asset> = Vec::new();
    for clip in &clips {
        let asset = state.asset(&clip.asset_id).ok_or_else(|| AudioError::Decode(format!("the recording {} is missing", clip.asset_id)))?;
        if !needed.iter().any(|a| a.id == asset.id) {
            needed.push(asset);
        }
    }
    let sources = store.ensure(&needed, cancel)?;
    let mut planned = Vec::with_capacity(clips.len());
    for clip in clips {
        let index = needed.iter().position(|a| a.id == clip.asset_id).expect("every clip's recording was collected");
        planned.push(PlanClip { source: sources[index].clone(), clip });
    }
    Ok(Arc::new(MixPlan::new(planned)))
}
