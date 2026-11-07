//! A decoder that writes megabytes of diagnostics is drained through a fixed scratch and only the tail is kept, as today's
//! service keeps the last 2,048 characters while it drains: the bytes live at the peak stay small (a counting allocator).
#![cfg(windows)]

#[path = "../../styk-core/tests/support/alloc.rs"]
mod alloc;

use styk_platform::audio::FfmpegAudioDecoder;
use styk_services::audio::{AudioDecoder, AudioError};
use styk_services::Cancel;

#[global_allocator]
static COUNTING: alloc::Counting = alloc::Counting;

#[test]
fn megabytes_of_stderr_are_drained_through_a_fixed_scratch_keeping_the_tail() {
    let work = std::env::temp_dir().join(format!("styk-audio-stderr-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let program = work.join("flood.cmd");
    std::fs::write(&program, "@echo off\r\nfor /L %%i in (1,1,40000) do @echo flood line %%i of the decoder diagnostics 1>&2\r\nexit /b 1\r\n").unwrap();
    let decoder = FfmpegAudioDecoder::new(&program, work.join("work"));
    let baseline = alloc::reset_peak();
    let error = decoder.decode(b"anything", 1.0, &mut |_| Ok(()), &Cancel::new()).unwrap_err();
    let new_at_peak = alloc::peak().saturating_sub(baseline);
    let AudioError::Decode(message) = error else { panic!("{error:?}") };
    assert!(message.trim_end().ends_with("flood line 40000 of the decoder diagnostics"), "the tail is kept: {message:?}");
    assert!(message.len() < 2200, "only a bounded tail: {} bytes", message.len());
    assert!(new_at_peak < 256 * 1024, "{new_at_peak} bytes were live at the peak for about 2 MB of diagnostics");
    let _ = std::fs::remove_dir_all(work);
}
