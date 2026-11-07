//! The FFmpeg sidecar as a [`VideoService`]: the same binary and arguments as today's app, raw RGBA instead of PNG on
//! the pipe.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use styk_services::video::{
    codec_dimensions, Capabilities, CodecSupport, Committed, Container, FfmpegRequest, FrameLayout, VideoError, VideoRequest, VideoService, VideoSession,
};
use styk_services::video_limits::{check_service, RawVideoConfig};
use styk_services::Cancel;

use super::args::{encoder_args, Input};
use super::probe;
use super::session::{Kind, Session};
use super::staging::{self, Stage};

pub struct FfmpegVideoService {
    program: PathBuf,
    probed: Mutex<Option<(Capabilities, String)>>,
}

/// `\bname\b` as a regular expression would find it in `text`.
fn has_word(text: &str, name: &str) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(name).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + name.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

impl FfmpegVideoService {
    pub fn new(program: impl Into<PathBuf>) -> FfmpegVideoService {
        FfmpegVideoService { program: program.into(), probed: Mutex::new(None) }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    fn probe(&self) -> (Capabilities, String) {
        let mut cached = self.probed.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = cached.as_ref() {
            return found.clone();
        }
        let limit = Duration::from_secs(10);
        let ask = |args: &[&str]| probe::run(&self.program, args, limit, 256 * 1024);
        let found = match (ask(&["-version"]), ask(&["-hide_banner", "-encoders"]), ask(&["-hide_banner", "-muxers"])) {
            (Ok(version), Ok(encoders), Ok(muxers)) => {
                let mut codecs = Vec::new();
                for container in [Container::Webm, Container::Mp4, Container::Avi, Container::Asf] {
                    for &codec in container.codecs() {
                        let supported = has_word(&encoders, codec.encoder()) && has_word(&muxers, container.muxer());
                        codecs.push(CodecSupport { container, codec, supported, reason: (!supported).then(|| format!("The native encoder does not support {} in this format.", codec.id())) });
                    }
                }
                (Capabilities { available: codecs.iter().any(|c| c.supported), reason: None, version: version.lines().next().unwrap_or("").to_string(), codecs }, encoders)
            }
            _ => (
                Capabilities {
                    available: false,
                    reason: Some("This desktop build does not include a working native video encoder. Export WebM or use a build with native video support.".into()),
                    version: String::new(),
                    codecs: Vec::new(),
                },
                String::new(),
            ),
        };
        *cached = Some(found.clone());
        found
    }

    /// The arguments the encoding pass runs with for `request` writing `output`.
    pub fn arguments(request: &FfmpegRequest, output: &str) -> Vec<String> {
        encoder_args(request, output, Input::Raw)
    }
}

fn raw_config(request: &FfmpegRequest) -> RawVideoConfig {
    RawVideoConfig {
        format: match request.container {
            Container::Asf => "wmv".into(),
            other => other.muxer().into(),
        },
        codec: Some(request.codec.id().into()),
        width: request.width as f64,
        height: request.height as f64,
        fps: request.fps,
        total_frames: request.total_frames as f64,
        quality: Some(request.rate.quality),
        max_bytes: Some(request.max_bytes as f64),
        bitrate: request.rate.bitrate,
        audio: request.audio,
    }
}

impl VideoService for FfmpegVideoService {
    fn capabilities(&self) -> Capabilities {
        self.probe().0
    }

    fn begin(&self, destination: &Path, request: &VideoRequest, cancel: &Cancel) -> Result<Box<dyn VideoSession>, VideoError> {
        let VideoRequest::Ffmpeg(request) = request else {
            return Err(VideoError::Unavailable("This service encodes with FFmpeg.".into()));
        };
        check_service(&raw_config(request))?;
        let (capabilities, encoders) = self.probe();
        let support = capabilities.codecs.iter().find(|c| c.container == request.container && c.codec == request.codec);
        if !support.is_some_and(|c| c.supported) {
            return Err(VideoError::Unavailable(support.and_then(|c| c.reason.clone()).or(capabilities.reason).unwrap_or_else(|| "The native encoder does not support this format.".into())));
        }
        if request.audio {
            let audio_codec = request.container.audio_codec();
            if !has_word(&encoders, audio_codec) {
                return Err(VideoError::Unavailable(format!("This encoder does not support {audio_codec} audio.")));
            }
        }
        let stage = Stage::create(destination)?;
        let extension = request.container.extension();
        let output = stage.path(&format!("video.{extension}"));
        let (encoded_width, encoded_height, edge) = codec_dimensions(request.codec, request.width, request.height);
        let layout = FrameLayout { width: request.width, height: request.height, bytes: request.width as usize * request.height as usize * 4, matte: !request.codec.alpha(), legacy_canvas: request.codec.alpha(), encoded: (encoded_width, encoded_height), edge };
        let arguments = FfmpegVideoService::arguments(request, &output.to_string_lossy());
        let session = Session::start(&self.program, arguments, Kind::Ffmpeg(request.clone()), layout, stage, output, destination, cancel)?;
        Ok(Box::new(session))
    }

    fn retry_commit(&self, artifact: &Path, destination: &Path) -> Result<Committed, VideoError> {
        commit_kept(artifact, destination)
    }
}

/// Moves a finished video kept by a failed commit over `destination` and removes its stage.
pub(crate) fn commit_kept(artifact: &Path, destination: &Path) -> Result<Committed, VideoError> {
    let bytes = staging::commit(artifact, destination).map_err(|e| VideoError::CommitFailed { artifact: artifact.to_path_buf(), destination: destination.to_path_buf(), message: e.to_string() })?;
    if let Some(stage) = artifact.parent() {
        let _ = std::fs::remove_dir_all(stage);
    }
    Ok(Committed { path: destination.to_path_buf(), bytes, frames: 0 })
}
