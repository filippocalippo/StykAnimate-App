//! Exports, as the core runs them.
//!
//! [`video`] turns the video part of the export dialog's request into the job an encoder is given, with today's limits
//! and messages (`src/export-request.mjs`, `src/native-video-export.mjs`, `desktop/video-export-service.cjs`).
//! [`flow`] runs a video export: preflight, rendering, finalizing, committing. The export dialog and its presentation
//! are not here.

pub mod flow;
pub mod video;

pub use video::{plan_video, AudioClip, ExportError, JobContext, Stage, VideoFields, VideoJob};
