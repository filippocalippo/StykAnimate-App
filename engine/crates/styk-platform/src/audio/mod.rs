//! Audio on the operating system: the bundled FFmpeg as the decoder ([`decode`]), and the Windows output ([`wasapi`]), both
//! behind the `styk_services::audio` traits. Design: `docs/native/audio.md`.

pub mod decode;
#[cfg(windows)]
pub mod wasapi;

pub use decode::FfmpegAudioDecoder;
#[cfg(windows)]
pub use wasapi::{QpcClock, WasapiOutput};
