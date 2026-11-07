//! The soundtrack mixed offline: the same mixer as playback, in the 12,000-frame chunks (250 ms) the video export streams to the
//! encoder, and the float WAV `pcmWave` writes.

use std::sync::Arc;

use super::model::RATE;
use super::plan::MixPlan;
use crate::export::flow::AudioSource;

/// `exportChunks`: a range of the plan, chunk by chunk.
pub struct OfflineMixer {
    plan: Arc<MixPlan>,
    next: u64,
    end: u64,
}

/// Frames of one export chunk.
pub const CHUNK_FRAMES: usize = 12_000;

impl OfflineMixer {
    /// `frames` frames from project sample `start`.
    pub fn new(plan: Arc<MixPlan>, start: u64, frames: u64) -> OfflineMixer {
        OfflineMixer { plan, next: start, end: start + frames }
    }

    /// The range of `[start, start + duration)` seconds the way `exportChunks` rounds it.
    pub fn for_seconds(plan: Arc<MixPlan>, start: f64, duration: f64) -> OfflineMixer {
        OfflineMixer::new(plan, (start * RATE as f64).round() as u64, (duration * RATE as f64).round() as u64)
    }
}

impl AudioSource for OfflineMixer {
    fn next_chunk(&mut self, out: &mut Vec<f32>) -> Result<bool, String> {
        if self.next >= self.end {
            return Ok(false);
        }
        let frames = ((self.end - self.next) as usize).min(CHUNK_FRAMES);
        out.clear();
        out.resize(frames * 2, 0.0);
        self.plan.mix(self.next, out).map_err(|e| e.to_string())?;
        self.next += frames as u64;
        Ok(true)
    }
}

/// `pcmWave`: interleaved stereo `f32` as a 32-bit float WAV file.
pub fn pcm_wave(interleaved: &[f32], rate: u32) -> Vec<u8> {
    let data = interleaved.len() * 4;
    let mut bytes = Vec::with_capacity(44 + data);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&3u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2 * 4).to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data as u32).to_le_bytes());
    for value in interleaved {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}
