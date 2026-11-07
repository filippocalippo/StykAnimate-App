//! Audio in the application core: the model, the mixer, sources and their memory, the mix plan, the transport and the clock
//! the frame scheduler follows. Design and reasons: `docs/native/audio.md`.
//!
//! Nothing here calls the operating system; the output device and the decoder come through `styk_services::audio`.

pub mod mix;
pub mod model;
pub mod offline;
pub mod plan;
pub mod store;
pub mod transport;
pub mod wav;
pub mod waveform;

pub use mix::{mix_audio, MixError};
pub use model::{clip_gain_at, AudioState, Clip, RATE};
pub use offline::{pcm_wave, OfflineMixer};
pub use plan::{build_plan, MixPlan, PlanClip};
pub use store::{Budget, SourceStore, CACHE_BYTES};
pub use transport::{AudioTransport, Event, MediaClock, Then, WallClock};
pub use wav::{inspect_wave, wave_peaks, SourceBytes, WavFormat, WavSource};
pub use waveform::{WaveformCache, WaveformKey};
