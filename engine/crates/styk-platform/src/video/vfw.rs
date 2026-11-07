//! Installed Windows (Video for Windows) codecs through the existing `native/bin/<arch>/styk-vfw.exe` helper, speaking
//! the protocol of `native/VFW.md`. Windows only; elsewhere every call says so.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use styk_services::video::{
    js_round, Arch, Capabilities, Committed, FrameLayout, VfwRequest, VideoError, VideoRequest, VideoService, VideoSession, MAX_FRAMES, MAX_SIDE, MAX_VFW_PIXELS, VFW_MAX_FRAME_BYTES,
};
use styk_services::Cancel;

use super::ffmpeg::commit_kept;
use super::json::{json_bool, json_number, json_text};
use super::pixels::bgr24_stride;
use super::probe;
use super::process;
use super::session::{Kind, Session};
use super::staging::Stage;

/// An installed compressor as the helper lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VfwCodec {
    pub arch: Arch,
    pub handler: u32,
    pub fourcc: String,
    pub name: String,
    pub supported: bool,
    pub reason: String,
    pub quality: bool,
    pub configure: bool,
    pub keyframes: bool,
    pub data_rate: bool,
}

pub struct VfwVideoService {
    x64: PathBuf,
    x86: PathBuf,
}

fn unsupported() -> VideoError {
    VideoError::Unavailable("Installed Video for Windows codecs are available only in the Windows desktop app.".into())
}

/// The frame rate as a reduced fraction (denominator 1e6, then the gcd), as the service computes it.
pub fn rational_fps(fps: f64) -> (u64, u64) {
    let numerator = js_round(fps * 1_000_000.0) as u64;
    let denominator = 1_000_000u64;
    let (mut a, mut b) = (numerator, denominator);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    (numerator / a, denominator / a)
}

/// The helper's `--encode` arguments (without the program).
pub fn encode_args(request: &VfwRequest, output: &str) -> Vec<String> {
    let (numerator, denominator) = rational_fps(request.fps);
    let quality = if request.supports_quality { js_round(request.quality * 10000.0) as i64 } else { -1 };
    let keyframes = if request.supports_keyframes { request.keyframe_every } else { 0 };
    let data_rate = if request.supports_data_rate { js_round(request.bitrate as f64 / 8.0) as u64 } else { 0 };
    let mut args: Vec<String> = vec![
        "--encode".into(),
        output.into(),
        request.handler.to_string(),
        request.width.to_string(),
        request.height.to_string(),
        numerator.to_string(),
        denominator.to_string(),
        request.total_frames.to_string(),
        quality.to_string(),
        keyframes.to_string(),
        data_rate.to_string(),
    ];
    if let Some(state) = &request.state_file {
        args.push(state.to_string_lossy().into_owned());
    }
    args
}

impl VfwVideoService {
    pub fn new(x64: impl Into<PathBuf>, x86: impl Into<PathBuf>) -> VfwVideoService {
        VfwVideoService { x64: x64.into(), x86: x86.into() }
    }

    fn helper(&self, arch: Arch) -> Result<&Path, VideoError> {
        if !cfg!(windows) {
            return Err(unsupported());
        }
        let path = match arch {
            Arch::X64 => &self.x64,
            Arch::X86 => &self.x86,
        };
        if path.is_file() { Ok(path) } else { Err(VideoError::Unavailable(format!("The {} Windows codec helper is not bundled.", if arch == Arch::X86 { "x86" } else { "x64" }))) }
    }

    /// The compressors installed for `arch`, with whether each takes `width` by `height` RGB24 frames.
    pub fn list(&self, arch: Arch, width: u32, height: u32) -> Result<Vec<VfwCodec>, VideoError> {
        let helper = self.helper(arch)?;
        let text = probe::run(helper, &["--list", &width.to_string(), &height.to_string()], Duration::from_secs(15), 2 * 1024 * 1024).map_err(VideoError::Unavailable)?;
        Ok(text
            .split("{\"handler\":")
            .skip(1)
            .filter_map(|entry| {
                let entry = format!("{{\"handler\":{entry}");
                Some(VfwCodec {
                    arch,
                    handler: json_number(&entry, "handler")? as u32,
                    fourcc: json_text(&entry, "fourcc").unwrap_or_default(),
                    name: json_text(&entry, "description").filter(|d| !d.is_empty()).or_else(|| json_text(&entry, "name")).unwrap_or_default(),
                    supported: json_bool(&entry, "supported").unwrap_or(false),
                    reason: json_text(&entry, "reason").unwrap_or_default(),
                    quality: json_bool(&entry, "quality").unwrap_or(false),
                    configure: json_bool(&entry, "configure").unwrap_or(false),
                    keyframes: json_bool(&entry, "keyframes").unwrap_or(false),
                    data_rate: json_bool(&entry, "dataRate").unwrap_or(false),
                })
            })
            .collect())
    }

    /// Opens the compressor's own configuration dialog over `owner` (a window handle) and saves its state to
    /// `state_file`. Blocks until the dialog closes: waiting for a person is not a timeout.
    pub fn configure(&self, arch: Arch, handler: u32, width: u32, height: u32, owner: u64, state_file: &Path) -> Result<(), VideoError> {
        let helper = self.helper(arch)?;
        let mut command = Command::new(helper);
        command.args(["--configure", &handler.to_string(), &width.to_string(), &height.to_string(), &owner.to_string()]).arg(state_file);
        let (child, _pipes) = process::spawn(&mut command, false).map_err(|e| VideoError::Unavailable(e.to_string()))?;
        let status = child.wait();
        if status.success() { Ok(()) } else { Err(VideoError::Encoder("The codec's settings could not be saved.".into())) }
    }
}

impl VideoService for VfwVideoService {
    fn capabilities(&self) -> Capabilities {
        let available = cfg!(windows) && (self.x64.is_file() || self.x86.is_file());
        Capabilities { available, reason: (!available).then(|| "Installed Video for Windows codecs require the Windows desktop app.".into()), version: String::new(), codecs: Vec::new() }
    }

    fn begin(&self, destination: &Path, request: &VideoRequest, cancel: &Cancel) -> Result<Box<dyn VideoSession>, VideoError> {
        let VideoRequest::Vfw(request) = request else {
            return Err(VideoError::Unavailable("This service encodes with an installed Windows codec.".into()));
        };
        let invalid = |message: &str| VideoError::Invalid { key: "desktop.vfwExportService.errors.labelMustBeAnIntegerFromMinToMax".into(), message: message.into() };
        if request.width < 1 || request.height < 1 || request.width > MAX_SIDE || request.height > MAX_SIDE {
            return Err(invalid("Video width and height must be integers from 1 to 16384."));
        }
        if request.width as u64 * request.height as u64 > MAX_VFW_PIXELS {
            return Err(invalid("Video exceeds the 67 million pixel limit."));
        }
        if bgr24_stride(request.width) as u64 * request.height as u64 > VFW_MAX_FRAME_BYTES {
            return Err(invalid("A video frame exceeds the 64 MiB limit."));
        }
        if !(1.0..=1000.0).contains(&request.fps) || request.total_frames < 1 || request.total_frames > MAX_FRAMES || !(0.0..=1.0).contains(&request.quality) {
            return Err(invalid("Choose a frame rate from 1 to 1000, 1 to 1,000,000 frames and a quality from 0 to 1."));
        }
        let helper = self.helper(request.arch)?.to_path_buf();
        let stage = Stage::create(destination)?;
        // The helper creates its output itself (CREATE_NEW): the name must not exist.
        let output = stage.path("animation.avi");
        let layout = FrameLayout { width: request.width, height: request.height, bytes: request.width as usize * request.height as usize * 4, matte: false, legacy_canvas: false, encoded: (request.width, request.height), edge: None };
        let arguments = encode_args(request, &output.to_string_lossy());
        Ok(Box::new(Session::start(&helper, arguments, Kind::Vfw(request.clone()), layout, stage, output, destination, cancel, None)?))
    }

    fn retry_commit(&self, artifact: &Path, destination: &Path) -> Result<Committed, VideoError> {
        commit_kept(artifact, destination)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_frame_rate_is_a_reduced_fraction() {
        assert_eq!(rational_fps(24.0), (24, 1));
        assert_eq!(rational_fps(29.97), (2997, 100));
        assert_eq!(rational_fps(23.976), (2997, 125));
        assert_eq!(rational_fps(1000.0), (1000, 1));
    }

    #[test]
    fn controls_the_codec_does_not_advertise_are_not_sent() {
        let mut request = VfwRequest {
            arch: Arch::X64,
            handler: 1668707181,
            width: 161,
            height: 91,
            fps: 24.0,
            total_frames: 10,
            quality: 0.9,
            keyframe_every: 5,
            bitrate: 800_000,
            supports_quality: true,
            supports_keyframes: false,
            supports_data_rate: true,
            state_file: None,
        };
        let args = encode_args(&request, "out.avi");
        assert_eq!(args[8..11], ["9000", "0", "100000"]);
        request.supports_quality = false;
        request.supports_keyframes = true;
        request.supports_data_rate = false;
        let args = encode_args(&request, "out.avi");
        assert_eq!(args[8..11], ["-1", "5", "0"]);
    }
}
