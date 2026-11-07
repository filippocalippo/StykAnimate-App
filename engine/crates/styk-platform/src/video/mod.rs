//! Video export on the operating system: the bundled FFmpeg sidecar and the Video for Windows helper, behind the
//! [`styk_services::video`] traits. See `docs/native/video-export.md`.
//!
//! - [`args`]: FFmpeg's command lines, ported from today's service and held to a fixture generated from it.
//! - [`ffmpeg`], [`vfw`]: the services.
//! - [`session`], [`process`]: one export running in an encoder process; cancellation that ends the process.
//! - [`staging`]: the destination probes, the staging directory and the commit.
//! - [`probe`]: the capability probes, the only clock in the export path.

pub mod args;
pub mod ffmpeg;
mod json;
pub mod pixels;
mod probe;
pub mod process;
mod session;
pub mod staging;
pub mod vfw;

pub use ffmpeg::FfmpegVideoService;
pub use vfw::{VfwCodec, VfwVideoService};
