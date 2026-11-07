//! WAV recordings as the mixer reads them: `inspectWave`, `sample` and `wavePeaks` of `src/audio-pcm.mjs`.
//!
//! A plain WAV is mixed at its own rate; everything else is turned into 48 kHz stereo `s16` WAV by FFmpeg first
//! (`styk-platform::audio`) and read the same way, as today.

use std::sync::Arc;

use super::model::MAX_SECONDS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WavFormat {
    /// 1 (integer PCM) or 3 (float).
    pub code: u16,
    pub channels: u16,
    pub sample_rate: u32,
    /// Bytes per frame.
    pub stride: u16,
    pub bits: u16,
}

/// Why a file is not a WAV the mixer reads directly. Every one of them sends the file to the decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WavError {
    /// Not a RIFF/WAVE file, or a header the mixer does not read (`thisWavEncodingNeedsTheDesktopAudioDecoder`).
    Unsupported,
    Truncated,
    /// Shorter than one sample or longer than an hour.
    Duration,
}

impl std::fmt::Display for WavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            WavError::Unsupported => "this recording needs an audio decoder",
            WavError::Truncated => "the WAV recording is truncated",
            WavError::Duration => "recordings must be between one sample and one hour",
        })
    }
}

/// The bytes of a recording and whatever accounts for them (a memory reservation that is given back when the last holder
/// lets go, see `store`).
pub struct SourceBytes {
    data: Vec<u8>,
    _hold: Option<Box<dyn Send + Sync>>,
}

impl SourceBytes {
    pub fn new(data: Vec<u8>) -> SourceBytes {
        SourceBytes { data, _hold: None }
    }

    /// Bytes whose accounting lives as long as they do.
    pub fn held(data: Vec<u8>, hold: Box<dyn Send + Sync>) -> SourceBytes {
        SourceBytes { data, _hold: Some(hold) }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.data
    }
}

impl std::fmt::Debug for SourceBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SourceBytes({} bytes)", self.data.len())
    }
}

/// A WAV file in memory and the parsed place of its samples. `bytes` is the whole file, as the blob is in JavaScript.
#[derive(Clone, Debug)]
pub struct WavSource {
    pub format: WavFormat,
    /// Where the first frame starts in `bytes`.
    pub offset: usize,
    pub frames: u64,
    pub duration: f64,
    pub bytes: Arc<SourceBytes>,
}

impl WavSource {
    pub fn new(header: WavHeader, bytes: Arc<SourceBytes>) -> WavSource {
        WavSource { format: header.format, offset: header.offset, frames: header.frames, duration: header.duration, bytes }
    }

    pub fn data(&self) -> &[u8] {
        self.bytes.as_slice()
    }
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Where a WAV's samples are and how they are laid out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WavHeader {
    pub format: WavFormat,
    pub offset: usize,
    pub frames: u64,
    pub duration: f64,
}

/// `inspectWave` on a file: what it reads of a WAV, and what it refuses.
pub fn inspect_wave(bytes: Arc<SourceBytes>) -> Result<WavSource, WavError> {
    let header = parse_wave(bytes.as_slice())?;
    Ok(WavSource { format: header.format, offset: header.offset, frames: header.frames, duration: header.duration, bytes })
}

/// The header of `data` as `inspectWave` reads it.
pub fn parse_wave(data: &[u8]) -> Result<WavHeader, WavError> {
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(WavError::Unsupported);
    }
    let (mut format, mut payload, mut at, mut chunks) = (None, None, 12usize, 0);
    while at + 8 <= data.len() && {
        chunks += 1;
        chunks <= 4096
    } {
        let kind = &data[at..at + 4];
        let size = u32_at(data, at + 4).ok_or(WavError::Truncated)? as usize;
        if at + 8 + size > data.len() {
            return Err(WavError::Truncated);
        }
        if kind == b"fmt " && size >= 16 {
            let mut code = u16_at(data, at + 8).ok_or(WavError::Unsupported)?;
            // JavaScript reads the sub-format at byte 32 of a 48-byte view, which throws (and so decodes) when the file ends first.
            if code == 0xfffe && size >= 40 {
                code = u16_at(data, at + 32).ok_or(WavError::Unsupported)?;
            }
            format = Some(WavFormat {
                code,
                channels: u16_at(data, at + 10).ok_or(WavError::Unsupported)?,
                sample_rate: u32_at(data, at + 12).ok_or(WavError::Unsupported)?,
                stride: u16_at(data, at + 20).ok_or(WavError::Unsupported)?,
                bits: u16_at(data, at + 22).ok_or(WavError::Unsupported)?,
            });
        } else if kind == b"data" {
            payload = Some((at + 8, size));
        }
        at += 8 + size + size % 2;
        if format.is_some() && payload.is_some() {
            break;
        }
    }
    let (Some(format), Some((offset, size))) = (format, payload) else { return Err(WavError::Unsupported) };
    let supported = matches!(format.channels, 1 | 2)
        && matches!(format.code, 1 | 3)
        && matches!(format.bits, 8 | 16 | 24 | 32)
        && !(format.code == 3 && format.bits != 32)
        && format.stride as u32 == format.channels as u32 * format.bits as u32 / 8
        && (8000..=192_000).contains(&format.sample_rate)
        && size % format.stride as usize == 0;
    if !supported {
        return Err(WavError::Unsupported);
    }
    let frames = (size / format.stride as usize) as u64;
    let duration = frames as f64 / format.sample_rate as f64;
    if duration <= 0.0 || duration > MAX_SECONDS {
        return Err(WavError::Duration);
    }
    Ok(WavHeader { format, offset, frames, duration })
}

/// `sample(view, at, format)`: one sample as a number in [-1, 1]; a value that is not finite is 0.
#[inline]
pub fn sample(data: &[u8], at: usize, format: &WavFormat) -> f64 {
    let value = if format.code == 3 {
        f32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as f64
    } else if format.bits == 8 {
        (data[at] as f64 - 128.0) / 128.0
    } else if format.bits == 16 {
        i16::from_le_bytes([data[at], data[at + 1]]) as f64 / 32768.0
    } else if format.bits == 24 {
        let raw = data[at] as i32 | (data[at + 1] as i32) << 8 | (data[at + 2] as i8 as i32) << 16;
        raw as f64 / 8_388_608.0
    } else {
        i32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as f64 / 2_147_483_648.0
    };
    if value.is_finite() { clamp_unit(value) } else { 0.0 }
}

/// `Math.max(-1, Math.min(1, value))`, signed zeros kept as JavaScript keeps them.
#[inline]
pub fn clamp_unit(value: f64) -> f64 {
    let capped = if value > 1.0 { 1.0 } else { value };
    if capped < -1.0 { -1.0 } else { capped }
}

/// `wavePeaks`: 80 bins per second (4096 at most), each the largest absolute sample over all channels, rounded to four decimals.
pub fn wave_peaks(source: &WavSource) -> Vec<f64> {
    let count = ((source.duration * 80.0).ceil().max(1.0)).min(4096.0) as usize;
    let mut peaks = vec![0.0f64; count];
    let data = &source.data()[source.offset..];
    let (stride, bytes_per_sample) = (source.format.stride as usize, source.format.bits as usize / 8);
    for frame in 0..source.frames as usize {
        let bin = (count - 1).min((frame as f64 * count as f64 / source.frames as f64).floor() as usize);
        for channel in 0..source.format.channels as usize {
            let value = sample(data, frame * stride + channel * bytes_per_sample, &source.format).abs();
            if value > peaks[bin] {
                peaks[bin] = value;
            }
        }
    }
    peaks.iter().map(|&value| js_round(value * 10000.0) / 10000.0).collect()
}

/// `Math.round`: halves go up.
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 { floor + 1.0 } else { floor }
}
