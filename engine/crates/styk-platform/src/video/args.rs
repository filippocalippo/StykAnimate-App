//! FFmpeg's command lines, ported from `encoderArguments` and `muxAudio` (`desktop/video-export-service.cjs`).
//!
//! The arguments after `-i` are today's, character for character (`tests/ffmpeg_arguments.rs` holds them to a fixture
//! generated from the JavaScript). Only the input segment can differ: today sends PNG frames (`-f image2pipe -c:v png`),
//! the native app sends raw RGBA (`-f rawvideo -pix_fmt rgba -video_size WxH`).

use styk_services::video::{codec_dimensions, js_round, Codec, Container, FfmpegRequest};

/// How frames reach FFmpeg's standard input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// PNG images, one after the other (today's app; the golden test and the parity baseline use it).
    Png,
    /// Raw RGBA frames of the request's size.
    Raw,
}

/// JavaScript's `String(number)` for the finite numbers an export holds (no exponent in range).
fn js_string(value: f64) -> String {
    format!("{value}")
}

/// The arguments of the encoding pass writing `output`.
pub fn encoder_args(request: &FfmpegRequest, output: &str, input: Input) -> Vec<String> {
    let s = |text: &str| text.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-filter_threads", "1", "-y", "-threads", "1"].iter().map(|a| s(a)).collect();
    match input {
        Input::Png => args.extend(["-f", "image2pipe", "-c:v", "png"].iter().map(|a| s(a))),
        Input::Raw => args.extend(["-f", "rawvideo", "-pix_fmt", "rgba", "-video_size"].iter().map(|a| s(a)).chain([format!("{}x{}", request.width, request.height)])),
    }
    args.extend(["-framerate".to_string(), js_string(request.fps), "-i".into(), "pipe:0".into()]);
    args.extend(["-an", "-sn", "-dn", "-map", "0:v:0"].iter().map(|a| s(a)));
    let (encoded_width, encoded_height, _) = codec_dimensions(request.codec, request.width, request.height);
    if encoded_width != request.width || encoded_height != request.height {
        args.extend(["-vf".to_string(), format!("pad={encoded_width}:{encoded_height}:0:0:color=black")]);
    }
    // Packed RGB-to-YUVA conversion rounds alpha 128..254 up by one; the alpha plane is kept apart from chroma conversion.
    if request.codec == Codec::Vp9 {
        args.extend(["-vf".to_string(), "format=rgba,split[c][a];[a]alphaextract[mask];[c]format=yuv420p[color];[color][mask]alphamerge".into()]);
    }
    args.extend(["-c:v".to_string(), request.codec.encoder().into(), "-threads".into(), "2".into(), "-pix_fmt".into(), request.codec.pixel_format().into()]);
    let rate = request.rate;
    let rounded_bitrate = rate.bitrate.map(js_round);
    match request.codec {
        Codec::H264 => {
            args.extend(["-preset", "fast", "-tune", "zerolatency"].iter().map(|a| s(a)));
            match rounded_bitrate {
                Some(bitrate) => args.extend(["-b:v".to_string(), js_string(bitrate)]),
                None => args.extend(["-crf".to_string(), js_string(js_round(38.0 - rate.quality * 20.0))]),
            }
        }
        Codec::Vp9 => {
            args.extend(["-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0", "-lag-in-frames", "0"].iter().map(|a| s(a)));
            args.extend(["-b:v".to_string(), js_string(rounded_bitrate.unwrap_or(0.0)), "-crf".into(), js_string(js_round((1.0 - rate.quality) * 48.0))]);
        }
        codec if codec.quality() => match rounded_bitrate {
            Some(bitrate) => args.extend(["-b:v".to_string(), js_string(bitrate)]),
            None => args.extend(["-q:v".to_string(), js_string(js_round(31.0 - rate.quality * 29.0))]),
        },
        _ => {}
    }
    if request.codec == Codec::Vp9 && rate.quality == 1.0 {
        args.extend(["-lossless".to_string(), "1".into()]);
    }
    if request.container == Container::Mp4 {
        args.extend(["-movflags".to_string(), "+faststart".into()]);
    }
    if request.container == Container::Avi && request.codec == Codec::Mpeg4 {
        args.extend(["-vtag".to_string(), "XVID".into()]);
    }
    // RGB FFV1 and rawvideo avoid chroma subsampling and dimension padding. FFV1 v3's slice grid loses pixels on tiny
    // dimensions in FFmpeg 7.1; its v1 single-slice format preserves those RGB frames exactly.
    if request.codec == Codec::Ffv1 {
        let tiny = request.width < 4 || request.height < 4;
        args.extend(["-level", if tiny { "1" } else { "3" }, "-coder", "1", "-slices", if tiny { "1" } else { "4" }].iter().map(|a| s(a)));
    }
    args.extend(["-fps_mode".to_string(), "cfr".into(), "-fs".into(), request.max_bytes.to_string(), "-progress".into(), "pipe:1".into(), "-f".into(), request.container.muxer().into(), output.into()]);
    args
}

/// The arguments of the second pass: the silent video copied, the 48 kHz stereo f32 mix encoded and muxed beside it.
pub fn mux_args(request: &FfmpegRequest, video: &str, mix: &str, output: &str) -> Vec<String> {
    let codec = request.container.audio_codec();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"].iter().map(|a| a.to_string()).collect();
    args.push(video.into());
    args.extend(["-f", "f32le", "-ar", "48000", "-ac", "2", "-i"].iter().map(|a| a.to_string()));
    args.push(mix.into());
    args.extend(["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", codec].iter().map(|a| a.to_string()));
    if codec != "pcm_s16le" {
        args.extend(["-b:a".to_string(), "192k".into()]);
    }
    args.extend(["-t".to_string(), js_string(request.total_frames as f64 / request.fps)]);
    if request.container == Container::Mp4 {
        args.extend(["-movflags".to_string(), "+faststart".into()]);
    }
    args.push(output.into());
    args
}
