//! The audio state of a document and what is audible of it: `src/audio-model.mjs`.
//!
//! Times are seconds, never frames. The state is read from `_styk.audio`; the engine session (`styk-edit`) owns every edit
//! and validates it, so this module trusts a document that opened and only refuses what it cannot play.

use std::sync::Arc;

use styk_doc::Value;

/// `AUDIO_RATE`: the mixer's rate. A project sample is one frame at this rate.
pub const RATE: u32 = 48_000;
/// `MAX_AUDIO_SECONDS`.
pub const MAX_SECONDS: f64 = 3600.0;
/// `MAX_AUDIO_VOICES`: overlapping audible clips.
pub const MAX_VOICES: usize = 32;

/// One clip as the mixer plays it. `gain` is the clip's gain times its track's (`audibleClips`).
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub asset_id: Arc<str>,
    pub start: f64,
    pub offset: f64,
    pub duration: f64,
    pub gain: f64,
    pub fade_in: f64,
    pub fade_out: f64,
}

#[derive(Clone, Debug)]
pub struct Track {
    pub gain: f64,
    pub mute: bool,
    pub solo: bool,
    pub clips: Vec<Clip>,
}

/// A recording embedded in the document: the original file's bytes in chunks, which are joined to decode it.
#[derive(Clone, Debug)]
pub struct Asset {
    pub id: Arc<str>,
    pub size: u64,
    pub duration: f64,
    chunks: Vec<Value>,
}

impl Asset {
    /// The original file, the chunks joined. `None` when a chunk is not base64.
    pub fn original(&self) -> Option<Vec<u8>> {
        let mut bytes = Vec::with_capacity(self.size as usize);
        for chunk in &self.chunks {
            bytes.extend_from_slice(&chunk.get("data_base64")?.payload_bytes()?);
        }
        Some(bytes)
    }

    /// Tells recordings apart in a cache: the id never names two different files in one document.
    pub fn identity(&self) -> (Arc<str>, u64, u64) {
        (self.id.clone(), self.size, self.duration.to_bits())
    }
}

/// `report._styk.audio`.
#[derive(Clone, Debug, Default)]
pub struct AudioState {
    pub assets: Vec<Asset>,
    pub tracks: Vec<Track>,
}

fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

impl AudioState {
    /// The state of a document tree; the empty state when it has no audio (`audioState`).
    pub fn from_document(document: &Value) -> Option<AudioState> {
        match document.path(&["_styk", "audio"]) {
            Some(audio) => AudioState::from_value(audio),
            None => Some(AudioState::default()),
        }
    }

    /// The state in the document's own shape. `None` for a shape the editor would not have accepted.
    pub fn from_value(audio: &Value) -> Option<AudioState> {
        let mut state = AudioState::default();
        for (key, asset) in audio.get("assets")?.as_obj()?.iter() {
            let chunks = asset.get("chunks")?.elements()?.iter().collect();
            state.assets.push(Asset { id: Arc::from(&**key), size: num(asset.get("size"))? as u64, duration: num(asset.get("duration"))?, chunks });
        }
        for track in audio.get("tracks")?.elements()?.iter() {
            let mut clips = Vec::new();
            for clip in track.get("clips")?.elements()?.iter() {
                clips.push(Clip {
                    asset_id: Arc::from(clip.get("assetId")?.as_str()?),
                    start: num(clip.get("start"))?,
                    offset: num(clip.get("offset"))?,
                    duration: num(clip.get("duration"))?,
                    gain: num(clip.get("gain"))?,
                    fade_in: num(clip.get("fadeIn"))?,
                    fade_out: num(clip.get("fadeOut"))?,
                });
            }
            state.tracks.push(Track { gain: num(track.get("gain"))?, mute: track.get("mute")?.as_bool()?, solo: track.get("solo")?.as_bool()?, clips });
        }
        Some(state)
    }

    pub fn asset(&self, id: &str) -> Option<&Asset> {
        self.assets.iter().find(|asset| &*asset.id == id)
    }

    /// `audibleClips`: tracks that are not muted (and soloed when any track is), with gain over 0; their clips with gain over 0;
    /// each with the track's gain multiplied in. **Track order, then clip order** (this is the order the mixer sums in).
    pub fn audible_clips(&self) -> Vec<Clip> {
        let solo = self.tracks.iter().any(|track| track.solo);
        let mut clips = Vec::new();
        for track in self.tracks.iter().filter(|track| !track.mute && (!solo || track.solo) && track.gain > 0.0) {
            for clip in track.clips.iter().filter(|clip| clip.gain > 0.0) {
                clips.push(Clip { gain: clip.gain * track.gain, ..clip.clone() });
            }
        }
        clips
    }

    /// `audioEnd`: where the last clip ends, in seconds.
    pub fn end(&self) -> f64 {
        self.tracks.iter().flat_map(|track| track.clips.iter()).fold(0.0, |end, clip| f64::max(end, clip.start + clip.duration))
    }
}

/// `clipGainAt`: the clip's gain at `time`, linear fades, 0 outside `[start, start + duration)`.
pub fn clip_gain_at(clip: &Clip, time: f64) -> f64 {
    let local = time - clip.start;
    if local < 0.0 || local >= clip.duration {
        return 0.0;
    }
    let fade_in = if clip.fade_in != 0.0 { local / clip.fade_in } else { 1.0 };
    let fade_out = if clip.fade_out != 0.0 { (clip.duration - local) / clip.fade_out } else { 1.0 };
    clip.gain * js_min3(1.0, fade_in, fade_out)
}

/// `Math.min(a, b, c)` on numbers that are not NaN here (a fade length of 0 is guarded above).
fn js_min3(a: f64, b: f64, c: f64) -> f64 {
    let mut least = a;
    for value in [b, c] {
        if value < least {
            least = value;
        }
    }
    least
}
