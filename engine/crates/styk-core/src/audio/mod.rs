//! Audio in the application core: the model, the mixer, sources and their memory, the mix plan, the transport and the clock
//! the frame scheduler follows. Design and reasons: `docs/native/audio.md`.
//!
//! Nothing here calls the operating system; the output device and the decoder come through `styk_services::audio`.

pub mod mix;
pub mod model;
pub mod plan;
pub mod wav;

pub use mix::{mix_audio, MixError};
pub use model::{clip_gain_at, AudioState, Clip, RATE};
pub use plan::{MixPlan, PlanClip};
pub use wav::{inspect_wave, wave_peaks, SourceBytes, WavFormat, WavSource};
