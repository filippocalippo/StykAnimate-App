//! The mixer: `mixAudio` of `src/audio-pcm.mjs`, line for line.
//!
//! Floating-point order is behaviour here. Clips are summed **in the order given** (document order: track, then clip), the sum
//! of one output sample is held in `f32` after every clip (`output[i] += x` on a `Float32Array`), the arithmetic is `f64`
//! with the same grouping as the JavaScript, and the saturator runs last. A different clip order changes bits (the
//! `three-clip-cancellation` golden). The same function serves playback, scrubbing and export.

use std::collections::HashMap;
use std::sync::Arc;

use super::model::{clip_gain_at, Clip, RATE};
use super::wav::{clamp_unit, sample, WavSource};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MixError {
    /// `invalidAudioMixRange`: a block is 1 to 48000 frames.
    Range,
    /// `prepareTheAudioRecordingBeforePlayingOrExporting`: a clip in range has no source.
    MissingSource,
}

impl std::fmt::Display for MixError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            MixError::Range => "invalid audio mix range",
            MixError::MissingSource => "prepare the audio recording before playing or exporting",
        })
    }
}

/// Adds one clip's contribution to `out` (stereo interleaved, `frames` frames starting at project sample `start_sample`).
/// This is the body of `mixAudio`'s loop over clips.
pub fn mix_clip(clip: &Clip, source: Option<&WavSource>, start_sample: u64, frames: usize, out: &mut [f32]) -> Result<(), MixError> {
    let rate = RATE as f64;
    let start = start_sample as f64 / rate;
    let end = (start_sample + frames as u64) as f64 / rate;
    if clip.start >= end || clip.start + clip.duration <= start {
        return Ok(());
    }
    let source = source.ok_or(MixError::MissingSource)?;
    let source_rate = source.format.sample_rate as f64;
    let from = f64::max(0.0, ((clip.start - start) * rate - 1e-7).ceil());
    let to = f64::min(frames as f64, ((clip.start + clip.duration - start) * rate - 1e-7).ceil());
    let source_start = f64::max(0.0, ((start + from / rate - clip.start + clip.offset) * source_rate).floor()) as i64;
    let source_end = f64::min(source.frames as f64, ((start + to / rate - clip.start + clip.offset) * source_rate).ceil() + 1.0) as i64;
    let window = source_end - source_start;
    let data = &source.data()[source.offset..];
    let (stride, bytes_per_sample, channels) = (source.format.stride as usize, source.format.bits as usize / 8, source.format.channels as usize);
    let (from, to) = (from as i64, to as i64);
    let mut i = from;
    while i < to {
        let time = (start_sample as i64 + i) as f64 / rate;
        let position = (time - clip.start + clip.offset) * source_rate;
        let index = i64::max(0, position.floor() as i64 - source_start);
        let next = i64::min(window - 1, index + 1);
        let fraction = position - position.floor();
        if index >= window {
            i += 1;
            continue;
        }
        let gain = clip_gain_at(clip, time);
        for c in 0..2usize {
            let channel = c.min(channels - 1) * bytes_per_sample;
            let a = sample(data, (source_start + index) as usize * stride + channel, &source.format);
            let b = sample(data, (source_start + next) as usize * stride + channel, &source.format);
            let slot = &mut out[i as usize * 2 + c];
            *slot = (*slot as f64 + (a + (b - a) * fraction) * gain) as f32;
        }
        i += 1;
    }
    Ok(())
}

/// The fixed saturator: every sample into [-1, 1], independent of chunking.
pub fn saturate(out: &mut [f32]) {
    for value in out {
        *value = clamp_unit(*value as f64) as f32;
    }
}

/// `mixAudio(clips, sources, startSample, frames)` into `out` (`frames * 2` values; the length sets `frames`).
pub fn mix_audio(clips: &[Clip], sources: &HashMap<Arc<str>, WavSource>, start_sample: u64, out: &mut [f32]) -> Result<(), MixError> {
    let frames = out.len() / 2;
    if out.len() % 2 != 0 || frames < 1 || frames > RATE as usize {
        return Err(MixError::Range);
    }
    out.fill(0.0);
    for clip in clips {
        mix_clip(clip, sources.get(&clip.asset_id), start_sample, frames, out)?;
    }
    saturate(out);
    Ok(())
}
