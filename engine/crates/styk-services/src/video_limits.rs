//! The limits of a video export request and the checks that enforce them, ported from `validateConfig`
//! (`desktop/video-export-service.cjs`) and the checks `encodeNativeVideo` (`src/native-video-export.mjs`) runs first.
//! Order matters: the first failing check names the error, as today's.

use crate::video::*;

/// A video request as typed, before it is checked: numbers are what a person or a script supplied.
#[derive(Clone, Debug, PartialEq)]
pub struct RawVideoConfig {
    pub format: String,
    /// `None`: the format's default codec.
    pub codec: Option<String>,
    pub width: f64,
    pub height: f64,
    pub fps: f64,
    pub total_frames: f64,
    /// `None`: 0.8.
    pub quality: Option<f64>,
    /// `None`: 1 GiB.
    pub max_bytes: Option<f64>,
    pub bitrate: Option<f64>,
    pub audio: bool,
}

/// Which check refused a request: the one `encodeNativeVideo` runs in the page, or the service's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    Native,
    Service,
}

fn invalid(key: &str, message: String) -> VideoError {
    VideoError::Invalid { key: key.to_string(), message }
}

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

fn integer(value: f64, min: f64, max: f64, label: &str) -> Result<f64, VideoError> {
    if !is_integer(value) || value < min || value > max {
        return Err(invalid("desktop.videoExportService.errors.nameMustBeAnIntegerBetweenMinAndMax", format!("{label} must be an integer between {min} and {max}.")));
    }
    Ok(value)
}

fn finite(value: f64, min: f64, max: f64, label: &str) -> Result<f64, VideoError> {
    if !value.is_finite() || value < min || value > max {
        return Err(invalid("desktop.videoExportService.errors.nameMustBeBetweenMinAndMax", format!("{label} must be between {min} and {max}.")));
    }
    Ok(value)
}

/// The checks `encodeNativeVideo` runs before it asks the desktop for an encoder, in its order. `max_pixels` is the
/// interface's export bound (67,108,864; 16,777,216 on Safari).
pub fn check_native(raw: &RawVideoConfig, max_pixels: f64) -> Result<(), VideoError> {
    let container = Container::parse(&raw.format).ok_or_else(|| invalid("errors.nativeVideoExport.chooseWebmMp4AviOrWmvForNative", "Choose WebM, MP4, AVI or WMV for native video export.".into()))?;
    if let Some(codec) = &raw.codec
        && !container.codecs().iter().any(|c| c.id() == codec)
    {
        return Err(invalid("errors.nativeVideoExport.chooseASupportedCodecForThisVideoFormat", "Choose a supported codec for this video format.".into()));
    }
    let max = MAX_SIDE as f64;
    if !is_integer(raw.width) || !is_integer(raw.height) || raw.width < 1.0 || raw.height < 1.0 || raw.width > max || raw.height > max || raw.width * raw.height > max_pixels {
        return Err(invalid("errors.nativeVideoExport.nativeVideoSupportsUpToMillionPixelsPer", format!("Native video supports up to {} million pixels per frame.", (max_pixels / 1e6).round())));
    }
    if !raw.fps.is_finite() || raw.fps < 1.0 || raw.fps > 1000.0 || !is_integer(raw.total_frames) || raw.total_frames < 1.0 || raw.total_frames > MAX_FRAMES as f64 {
        return Err(invalid("errors.nativeVideoExport.chooseAValidVideoFrameRateAndFrame", "Choose a valid video frame rate and frame count.".into()));
    }
    let quality = raw.quality.unwrap_or(0.9);
    if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return Err(invalid("errors.nativeVideoExport.videoQualityMustBeBetweenZeroAndOne", "Video quality must be between zero and one.".into()));
    }
    if let Some(bitrate) = raw.bitrate
        && (!bitrate.is_finite() || bitrate < 1000.0 || bitrate > 200e6)
    {
        return Err(invalid("errors.nativeVideoExport.videoBitrateMustBeBetween1KbitS", "Video bitrate must be between 1 kbit/s and 200 Mbit/s.".into()));
    }
    let max_bytes = raw.max_bytes.unwrap_or(MAX_OUTPUT_BYTES as f64);
    if !is_integer(max_bytes) || max_bytes < MIN_OUTPUT_BYTES as f64 || max_bytes > MAX_OUTPUT_BYTES as f64 {
        return Err(invalid("errors.nativeVideoExport.nativeVideoSizeMustBeLimitedToBetween", "Native video size must be limited to between 1 KiB and 1 GiB.".into()));
    }
    Ok(())
}

/// `validateConfig`: the service's own checks, in its order, giving the typed request.
pub fn check_service(raw: &RawVideoConfig) -> Result<FfmpegRequest, VideoError> {
    if raw.audio && raw.total_frames / raw.fps > MAX_AUDIO_SECONDS {
        return Err(invalid("desktop.videoExportService.errors.audioVideoExportsSupportUpToOneHour", "Audio video exports support up to one hour.".into()));
    }
    let container = Container::parse(&raw.format).ok_or_else(|| invalid("desktop.videoExportService.errors.chooseWebMMP4AVIOrWMVVideo", "Choose WebM, MP4, AVI, or WMV video.".into()))?;
    let codec = match &raw.codec {
        None => container.codecs()[0],
        Some(id) => *container
            .codecs()
            .iter()
            .find(|c| c.id() == id)
            .ok_or_else(|| invalid("desktop.videoExportService.errors.chooseASupportedCodecForTheSelectedVideoFormat", "Choose a supported codec for the selected video format.".into()))?,
    };
    let width = integer(raw.width, 1.0, MAX_SIDE as f64, "Video width")?;
    let height = integer(raw.height, 1.0, MAX_SIDE as f64, "Video height")?;
    if width * height > MAX_FFMPEG_PIXELS as f64 {
        return Err(invalid("desktop.videoExportService.errors.nativeVideoExportSupportsUpTo16MillionPixelsPerFrame", "Native video export supports up to 16 million pixels per frame.".into()));
    }
    let fps = finite(raw.fps, 1.0, 1000.0, "Video frame rate")?;
    let total_frames = integer(raw.total_frames, 1.0, MAX_FRAMES as f64, "Video frame count")?;
    let quality = finite(raw.quality.unwrap_or(0.8), 0.0, 1.0, "Video quality")?;
    let max_bytes = integer(raw.max_bytes.unwrap_or(MAX_OUTPUT_BYTES as f64), MIN_OUTPUT_BYTES as f64, MAX_OUTPUT_BYTES as f64, "Video size limit")?;
    let bitrate = raw.bitrate.map(|b| finite(b, 1000.0, 200e6, "Video bitrate")).transpose()?;
    Ok(FfmpegRequest {
        container,
        codec,
        width: width as u32,
        height: height as u32,
        fps,
        total_frames: total_frames as u32,
        rate: Rate { quality, bitrate },
        max_bytes: max_bytes as u64,
        audio: raw.audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw() -> RawVideoConfig {
        RawVideoConfig { format: "mp4".into(), codec: None, width: 64.0, height: 36.0, fps: 24.0, total_frames: 48.0, quality: None, max_bytes: None, bitrate: None, audio: false }
    }

    #[test]
    fn a_plain_request_passes_both_checks() {
        check_native(&raw(), 67_108_864.0).unwrap();
        let request = check_service(&raw()).unwrap();
        assert_eq!((request.codec, request.rate.quality, request.max_bytes), (Codec::H264, 0.8, 1 << 30));
    }

    #[test]
    fn the_service_is_stricter_about_pixels_than_the_interface() {
        let mut big = raw();
        big.width = 5000.0;
        big.height = 5000.0;
        check_native(&big, 67_108_864.0).unwrap();
        assert!(matches!(check_service(&big), Err(VideoError::Invalid { key, .. }) if key.ends_with("UpTo16MillionPixelsPerFrame")));
    }

    #[test]
    fn sound_is_limited_to_an_hour() {
        let mut long = raw();
        long.audio = true;
        long.total_frames = 3601.0 * 24.0;
        assert!(matches!(check_service(&long), Err(VideoError::Invalid { key, .. }) if key.ends_with("SupportUpToOneHour")));
        long.audio = false;
        check_service(&long).unwrap();
    }

    #[test]
    fn each_limit_refuses_the_value_just_outside_it() {
        let edits: Vec<Box<dyn Fn(&mut RawVideoConfig)>> = vec![
            Box::new(|r| r.width = 0.0),
            Box::new(|r| r.width = 16385.0),
            Box::new(|r| r.height = 1.5),
            Box::new(|r| r.fps = 0.5),
            Box::new(|r| r.fps = 1001.0),
            Box::new(|r| r.total_frames = 0.0),
            Box::new(|r| r.total_frames = 1_000_001.0),
            Box::new(|r| r.quality = Some(1.1)),
            Box::new(|r| r.bitrate = Some(999.0)),
            Box::new(|r| r.bitrate = Some(2e8 + 1.0)),
            Box::new(|r| r.max_bytes = Some(1023.0)),
            Box::new(|r| r.max_bytes = Some((1u64 << 30) as f64 + 1.0)),
        ];
        for edit in edits {
            let mut r = raw();
            edit(&mut r);
            assert!(check_native(&r, 67_108_864.0).is_err());
            assert!(check_service(&r).is_err());
        }
    }
}
