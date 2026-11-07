//! A video export, start to finish: `Preflight` (the destination, the encoder) → `Rendering` (frames, sound) →
//! `Finalizing` → `Committing` → done, cancelled or failed.
//!
//! The flow owns no timer: it waits on events (a free buffer, the encoder) and the [`Cancel`] it was given wakes
//! every wait. Nothing here draws or encodes; the frame source and the encoder are passed in.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use styk_services::video::{Committed, FrameLayout, Phase, Progress, VideoError, VideoRequest, VideoService, VideoSession};
use styk_services::Cancel;

/// Draws the frames of an export, in order.
pub trait FrameProducer {
    /// Draws frame `index` (0-based within the export) into `out` as RGBA, rows packed, composited over black when
    /// `layout.matte` (every codec without alpha) and straight otherwise, passed through `styk_export::legacy_canvas`
    /// when `layout.legacy_canvas`. `out` arrives empty with its capacity kept.
    fn frame_into(&mut self, index: u32, layout: &FrameLayout, out: &mut Vec<u8>) -> Result<(), String>;
}

/// The sound of an export, as 250 ms chunks of interleaved stereo f32 at 48 kHz.
pub trait AudioSource {
    /// Fills `out` with the next chunk; `Ok(false)` at the end.
    fn next_chunk(&mut self, out: &mut Vec<f32>) -> Result<bool, String>;
}

/// Runs a video export of `frames` frames to `destination`. `on_start` sees the session once it has begun (a tool
/// reads its encoder process and progress there).
///
/// Any failure and any cancellation ends the encoder and removes what the job made, except a commit that lost a race
/// with another program: that returns [`VideoError::CommitFailed`] with the finished file kept, for
/// [`VideoService::retry_commit`].
pub fn run_video_export(
    service: &dyn VideoService,
    destination: &Path,
    request: &VideoRequest,
    producer: &mut dyn FrameProducer,
    audio: Option<&mut dyn AudioSource>,
    cancel: &Cancel,
    on_start: &dyn Fn(&dyn VideoSession),
) -> Result<Committed, VideoError> {
    // The frame count is the request's: a caller cannot ask the encoder for one count and send another.
    let frames = match request {
        VideoRequest::Ffmpeg(r) => r.total_frames,
        VideoRequest::Vfw(r) => r.total_frames,
    };
    let mut session = service.begin(destination, request, cancel)?;
    on_start(&*session);
    let progress = session.progress();
    match render(&mut *session, frames, producer, audio, cancel, &progress) {
        Ok(()) => session.finish(),
        Err(error) => {
            session.abort();
            Err(error)
        }
    }
}

fn render(session: &mut dyn VideoSession, frames: u32, producer: &mut dyn FrameProducer, audio: Option<&mut dyn AudioSource>, cancel: &Cancel, progress: &Progress) -> Result<(), VideoError> {
    progress.set_phase(Phase::Rendering);
    let layout = session.layout().clone();
    if let Some(audio) = audio {
        let mut chunk = Vec::new();
        loop {
            if cancel.is_cancelled() {
                return Err(VideoError::Cancelled);
            }
            chunk.clear();
            if !audio.next_chunk(&mut chunk).map_err(VideoError::Io)? {
                break;
            }
            session.write_audio(&chunk)?;
        }
    }
    for index in 0..frames {
        let mut buffer = session.acquire()?;
        if cancel.is_cancelled() {
            return Err(VideoError::Cancelled);
        }
        // A producer stopped by the cancel (a wait for the GPU that was woken) reports the cancel, not a failure.
        producer.frame_into(index, &layout, buffer.bytes_mut()).map_err(|error| if cancel.is_cancelled() { VideoError::Cancelled } else { VideoError::Io(error) })?;
        session.submit(buffer)?;
    }
    Ok(())
}

/// The running exports and the document revision each belongs to. An edit, undo, redo, a document replacement or a
/// tab close cancels the exports of that document; an export of another document is untouched.
#[derive(Clone, Default)]
pub struct ExportJobs {
    jobs: Arc<Mutex<HashMap<u64, Owned>>>,
    next: Arc<Mutex<u64>>,
}

struct Owned {
    document: u64,
    revision: u64,
    cancel: Cancel,
}

impl ExportJobs {
    pub fn new() -> ExportJobs {
        ExportJobs::default()
    }

    /// Registers an export of `document` at `revision`; returns its id and the cancellation to run it with.
    pub fn start(&self, document: u64, revision: u64) -> (u64, Cancel) {
        let id = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            *next += 1;
            *next
        };
        let cancel = Cancel::new();
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Owned { document, revision, cancel: cancel.clone() });
        (id, cancel)
    }

    /// The document changed: it is now at `revision`. Cancels its exports of any other revision.
    pub fn document_changed(&self, document: u64, revision: u64) {
        let stale: Vec<Cancel> = self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values().filter(|j| j.document == document && j.revision != revision).map(|j| j.cancel.clone()).collect();
        for cancel in stale {
            cancel.cancel();
        }
    }

    /// The document was closed or replaced: cancels all its exports.
    pub fn document_closed(&self, document: u64) {
        let owned: Vec<Cancel> = self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values().filter(|j| j.document == document).map(|j| j.cancel.clone()).collect();
        for cancel in owned {
            cancel.cancel();
        }
    }

    /// The export ended (committed, failed or cancelled).
    pub fn finished(&self, id: u64) {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    pub fn running(&self) -> usize {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_services::video::fake::FakeVideoService;
    use styk_services::video::{Codec, Container, FfmpegRequest, Rate};

    fn request() -> VideoRequest {
        VideoRequest::Ffmpeg(FfmpegRequest { container: Container::Mp4, codec: Codec::H264, width: 3, height: 3, fps: 24.0, total_frames: 5, rate: Rate { quality: 0.8, bitrate: None }, max_bytes: 1 << 30, audio: false })
    }

    struct Numbers {
        drawn: u32,
        cancel_at: Option<(u32, Cancel)>,
    }

    impl FrameProducer for Numbers {
        fn frame_into(&mut self, index: u32, layout: &FrameLayout, out: &mut Vec<u8>) -> Result<(), String> {
            assert!(layout.matte, "H.264 has no alpha");
            if let Some((at, cancel)) = &self.cancel_at
                && *at == index
            {
                cancel.cancel();
            }
            out.extend(std::iter::repeat_n(index as u8, 36));
            self.drawn += 1;
            Ok(())
        }
    }

    #[test]
    fn frames_arrive_in_order_and_the_export_commits() {
        let service = FakeVideoService::default();
        let mut producer = Numbers { drawn: 0, cancel_at: None };
        let done = run_video_export(&service, Path::new("out.mp4"), &request(), &mut producer, None, &Cancel::new(), &|_| {}).unwrap();
        assert_eq!(done.frames, 5);
        let recording = service.recording.lock().unwrap();
        assert_eq!(recording.frames.iter().map(|f| f[0]).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
        assert!(recording.committed && !recording.aborted);
    }

    #[test]
    fn a_cancel_during_rendering_aborts_and_stops_drawing() {
        let service = FakeVideoService::default();
        let cancel = Cancel::new();
        let mut producer = Numbers { drawn: 0, cancel_at: Some((2, cancel.clone())) };
        let error = run_video_export(&service, Path::new("out.mp4"), &request(), &mut producer, None, &cancel, &|_| {}).unwrap_err();
        assert_eq!(error, VideoError::Cancelled);
        assert_eq!(producer.drawn, 3);
        let recording = service.recording.lock().unwrap();
        assert!(recording.aborted && !recording.committed);
    }

    #[test]
    fn an_encoder_failure_aborts_the_job() {
        let service = FakeVideoService { fail_after: Some(1), ..Default::default() };
        let mut producer = Numbers { drawn: 0, cancel_at: None };
        let error = run_video_export(&service, Path::new("out.mp4"), &request(), &mut producer, None, &Cancel::new(), &|_| {}).unwrap_err();
        assert!(matches!(error, VideoError::Encoder(_)));
        assert!(service.recording.lock().unwrap().aborted);
    }

    #[test]
    fn an_edit_cancels_the_exports_of_that_document_only() {
        let jobs = ExportJobs::new();
        let (_, mine) = jobs.start(1, 7);
        let (_, other) = jobs.start(2, 7);
        jobs.document_changed(1, 7);
        assert!(!mine.is_cancelled(), "same revision: no change");
        jobs.document_changed(1, 8);
        assert!(mine.is_cancelled());
        assert!(!other.is_cancelled());
        jobs.document_closed(2);
        assert!(other.is_cancelled());
    }

    #[test]
    fn a_finished_job_is_forgotten() {
        let jobs = ExportJobs::new();
        let (id, _) = jobs.start(1, 1);
        assert_eq!(jobs.running(), 1);
        jobs.finished(id);
        assert_eq!(jobs.running(), 0);
    }
}
