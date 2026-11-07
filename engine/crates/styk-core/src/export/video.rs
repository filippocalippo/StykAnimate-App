//! The video part of an export request: what the dialog's choices become, with today's limits and messages.
//!
//! A port of `videoExportArguments` for the FFmpeg provider (`src/export-request.mjs`), the checks of
//! `encodeNativeVideo` (`src/native-video-export.mjs`) and of the service's `validateConfig`
//! (`desktop/video-export-service.cjs`), in their order: the first failing check names the error. The fixture
//! `tests/fixtures/video-export-jobs.tsv` is generated from the JavaScript (`scripts/generate-video-export-fixtures.mjs`)
//! and holds the native code to it for thousands of combinations, errors included.

use styk_services::video::{codec_dimensions, Codec, Container, FfmpegRequest, VideoError};
use styk_services::video_limits::{check_native, check_service, RawVideoConfig};

/// The export dialog's video fields, as `buildExportRequest` holds them (numbers are what `Number()` made of the text).
#[derive(Clone, Debug, PartialEq)]
pub struct VideoFields {
    /// `mp4`, `webm`, `avi` or `wmv`.
    pub format: String,
    pub width: f64,
    pub height: f64,
    /// First and last played frame, 1-based, inclusive.
    pub from: f64,
    pub to: f64,
    pub smoothing: String,
    /// `recommended`, `small` or `high` (empty: recommended).
    pub video_quality: String,
    /// `auto` or `manual` (empty: auto).
    pub bitrate_mode: String,
    pub bitrate_mbps: f64,
    /// The codec the MP4 and AVI selects show (empty: the format's default).
    pub codec_mp4: String,
    pub codec_avi: String,
    pub audio: bool,
    /// A typed file name without extension; `None` or blank: the document's name.
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioClip {
    pub start: f64,
    pub duration: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct JobContext {
    /// Played frames of the animation.
    pub total_frames: f64,
    pub fps: f64,
    /// The document's name, the default file name.
    pub name: String,
    pub audio_clips: Vec<AudioClip>,
    /// The interface's per-frame pixel bound (67,108,864; 16,777,216 on Safari).
    pub max_pixels: f64,
}

impl JobContext {
    pub fn new(total_frames: f64, fps: f64, name: &str) -> JobContext {
        JobContext { total_frames, fps, name: name.to_string(), audio_clips: Vec::new(), max_pixels: 67_108_864.0 }
    }
}

/// Which of today's three checks refused a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Request,
    Native,
    Service,
}

/// A refused request: the localisation key of the message (a message that has none carries its English text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportError {
    pub stage: Stage,
    pub id: String,
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.id)
    }
}

impl std::error::Error for ExportError {}

fn request_error(key: &str) -> ExportError {
    ExportError { stage: Stage::Request, id: key.to_string() }
}

fn video_error(stage: Stage, error: VideoError) -> ExportError {
    match error {
        VideoError::Invalid { key, .. } => ExportError { stage, id: key },
        other => ExportError { stage, id: other.to_string() },
    }
}

/// What the exporter draws: the output size, the range and the sampling (`exportOptionsFromRequest`).
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub width: f64,
    pub height: f64,
    /// Zero-based first tick and the tick after the last.
    pub start: f64,
    pub end: f64,
    pub quality: f64,
    pub smoothing: String,
}

/// The job a request becomes: what to draw and what to hand the encoder.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoJob {
    pub options: Options,
    pub fps: f64,
    pub ticks: f64,
    /// The codec asked for (`None`: the format's default).
    pub codec: Option<String>,
    pub extension: &'static str,
    pub filename: String,
    pub include_audio: bool,
    /// The quality the encoder receives, beside the bitrate when one was typed.
    pub rate_quality: f64,
    pub rate_bitrate: Option<f64>,
    /// The validated encoder request.
    pub encode: FfmpegRequest,
}

const MAX_SIDE: f64 = 16_384.0;
/// The quality every format but the JPEG sequence exports with (today's hidden-field value).
const DEFAULT_QUALITY: f64 = 0.94;

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

fn illegal_name(name: &str) -> bool {
    name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20)
}

fn reserved_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    // `\s*(?:\.|$)` after the device name.
    let ends = |rest: &str| {
        let rest = rest.trim_start();
        rest.is_empty() || rest.starts_with('.')
    };
    let plain = ["con", "prn", "aux", "nul", "conin$", "conout$"].iter().any(|stem| lower.strip_prefix(stem).is_some_and(ends));
    let numbered = ["com", "lpt"].iter().any(|stem| {
        lower.strip_prefix(stem).and_then(|rest| {
            let mut chars = rest.chars();
            chars.next().filter(|c| matches!(c, '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')).map(|_| chars.as_str())
        }).is_some_and(ends)
    });
    plain || numbered
}

/// Why a typed file name cannot be saved (`exportNameError`), as the English text.
pub fn name_error(name: &str) -> Option<&'static str> {
    if name.trim().is_empty() {
        return Some("Enter a file name.");
    }
    if illegal_name(name) {
        return Some("File names cannot contain \\ / : * ? \" < > |.");
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Some("File names cannot end with a dot or a space.");
    }
    if reserved_name(name) {
        return Some("Windows reserves this name. Choose another name.");
    }
    None
}

fn preset_quality(preset: &str) -> Option<f64> {
    match preset {
        "recommended" => Some(0.8),
        "small" => Some(0.55),
        "high" => Some(0.95),
        _ => None,
    }
}

/// Plans a video export of `fields` in `context` for the bundled FFmpeg: the job, or the first check that refuses it.
pub fn plan_video(fields: &VideoFields, context: &JobContext) -> Result<VideoJob, ExportError> {
    let container = Container::parse(&fields.format).ok_or_else(|| request_error("errors.exportRequest.chooseAVideoFormat"))?;
    let codec_asked = match container {
        Container::Mp4 => Some(fields.codec_mp4.as_str()),
        Container::Avi => Some(fields.codec_avi.as_str()),
        _ => None,
    }
    .filter(|c| !c.is_empty());

    // exportOptionsFromRequest
    let smoothing = if fields.smoothing.is_empty() { "edges" } else { fields.smoothing.as_str() };
    if !matches!(smoothing, "edges" | "none" | "sprites") {
        return Err(request_error("errors.exportSampling.chooseSmoothEdgesNoSmoothingOrSmoothSprites"));
    }
    let options = Options { width: fields.width, height: fields.height, start: fields.from - 1.0, end: fields.to, quality: DEFAULT_QUALITY, smoothing: smoothing.to_string() };
    if !is_integer(options.width) || !is_integer(options.height) || options.width < 1.0 || options.height < 1.0 || options.width > MAX_SIDE || options.height > MAX_SIDE || options.width * options.height > context.max_pixels {
        return Err(request_error("errors.exportRequest.exportSizeMustBeWholePixelsUpTo"));
    }
    if !is_integer(options.start) || !is_integer(options.end) || options.start < 0.0 || options.start >= options.end || options.end > context.total_frames {
        return Err(request_error("errors.exportRequest.chooseAValidExportFrameRange"));
    }

    // videoQualityOptions
    let preset = if fields.video_quality.is_empty() { "recommended" } else { fields.video_quality.as_str() };
    let mode = if fields.bitrate_mode.is_empty() { "auto" } else { fields.bitrate_mode.as_str() };
    let choice = preset_quality(preset).ok_or_else(|| request_error("errors.exportVideoQuality.chooseAVideoQualityPreset"))?;
    if !matches!(mode, "auto" | "manual") {
        return Err(request_error("errors.exportVideoQuality.chooseAutomaticOrManualBitrate"));
    }
    let lossless = container == Container::Avi && matches!(codec_asked, Some("ffv1" | "rawvideo"));
    let (rate_quality, rate_bitrate) = if lossless {
        (1.0, None)
    } else if mode == "manual" {
        let mbps = fields.bitrate_mbps;
        if !mbps.is_finite() || !(0.1..=200.0).contains(&mbps) {
            return Err(request_error("errors.exportVideoQuality.enterABitrateBetween01And200"));
        }
        (choice, Some(styk_services::video::js_round(mbps * 1e6)))
    } else {
        (choice, None)
    };

    let ticks = options.end - options.start;
    let (fps, start, end) = (context.fps, options.start, options.end);
    let include_audio = fields.audio && context.audio_clips.iter().any(|clip| clip.start < end / fps && clip.start + clip.duration > start / fps);

    // exportFileName
    let typed = fields.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if let Some(name) = typed
        && let Some(problem) = name_error(name)
    {
        return Err(ExportError { stage: Stage::Request, id: problem.to_string() });
    }
    let extension = container.extension();
    let filename = format!("{}.{extension}", typed.unwrap_or(&context.name));

    // encodeNativeVideo's checks, then the service's.
    let raw = RawVideoConfig {
        format: fields.format.clone(),
        codec: codec_asked.map(str::to_string),
        width: options.width,
        height: options.height,
        fps,
        total_frames: ticks,
        quality: Some(rate_quality),
        max_bytes: None,
        bitrate: rate_bitrate,
        audio: include_audio,
    };
    check_native(&raw, context.max_pixels).map_err(|e| video_error(Stage::Native, e))?;
    let encode = check_service(&raw).map_err(|e| video_error(Stage::Service, e))?;
    Ok(VideoJob {
        options,
        fps,
        ticks,
        codec: codec_asked.map(str::to_string),
        extension,
        filename,
        include_audio,
        rate_quality,
        rate_bitrate,
        encode,
    })
}

impl VideoJob {
    /// The size the encoder writes: the frame's size plus a padded black edge for `yuv420p` codecs.
    pub fn encoded_size(&self) -> (u32, u32) {
        let (w, h, _) = codec_dimensions(self.encode.codec, self.encode.width, self.encode.height);
        (w, h)
    }

    pub fn codec(&self) -> Codec {
        self.encode.codec
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> VideoFields {
        VideoFields {
            format: "mp4".into(),
            width: 960.0,
            height: 540.0,
            from: 1.0,
            to: 48.0,
            smoothing: "edges".into(),
            video_quality: "recommended".into(),
            bitrate_mode: "auto".into(),
            bitrate_mbps: 8.0,
            codec_mp4: String::new(),
            codec_avi: String::new(),
            audio: false,
            name: None,
        }
    }

    #[test]
    fn names_windows_reserves_are_refused() {
        for bad in ["CON", "nul.txt", "com1", "LPT\u{b2}", "aux ", "conin$", "con  .x"] {
            assert!(reserved_name(bad), "{bad:?}");
        }
        for fine in ["console", "com", "comma", "lpt10x", "my con", "conins"] {
            assert!(!reserved_name(fine), "{fine:?}");
        }
    }

    #[test]
    fn a_plain_request_becomes_a_job() {
        let job = plan_video(&fields(), &JobContext::new(48.0, 24.0, "Kick combo")).unwrap();
        assert_eq!((job.filename.as_str(), job.ticks, job.encode.codec), ("Kick combo.mp4", 48.0, Codec::H264));
        assert_eq!(job.rate_quality, 0.8);
        assert_eq!(job.rate_bitrate, None);
    }

    #[test]
    fn a_manual_bitrate_keeps_the_presets_quality() {
        let mut f = fields();
        f.format = "webm".into();
        f.video_quality = "small".into();
        f.bitrate_mode = "manual".into();
        f.bitrate_mbps = 0.25;
        let job = plan_video(&f, &JobContext::new(48.0, 24.0, "x")).unwrap();
        assert_eq!((job.rate_quality, job.rate_bitrate), (0.55, Some(250_000.0)));
    }

    #[test]
    fn an_audible_clip_in_range_asks_for_sound() {
        let mut f = fields();
        f.audio = true;
        let mut ctx = JobContext::new(48.0, 24.0, "x");
        ctx.audio_clips = vec![AudioClip { start: 10.0, duration: 1.0 }];
        assert!(!plan_video(&f, &ctx).unwrap().include_audio);
        ctx.audio_clips = vec![AudioClip { start: 0.5, duration: 1.0 }];
        assert!(plan_video(&f, &ctx).unwrap().include_audio);
    }
}
