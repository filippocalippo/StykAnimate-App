# Native video export

Spike S3, 2026-11-06 (design revised with its review; every finding accepted). Today's app encodes MP4, WebM, AVI and WMV
with a bundled FFmpeg 7.1 process and installed Windows codecs with a Video for Windows helper. The native app runs **the
same binaries with the same arguments**, so its files equal today's byte for byte, with the exceptions named in
[Byte parity](#byte-parity). The export dialog and its interface are not part of this page (they come with the shell and
the dialogs); this page is the headless export path: request, frames, encoder, destination, cancellation.

## What exists

| Where | Owns |
| --- | --- |
| `styk-services::video` | Plain types (`VideoRequest`, `Rate`, `Container`, `VideoCodec`, `Progress`, `VideoError`), the `VideoService` and `VideoSession` traits, the `Cancel` supervisor, a fake service for tests. No OS code. |
| `styk-platform::video` | `FfmpegVideoService` (capability probe, the argument builder, the sidecar session), `VfwVideoService` (the existing `native/bin/*/styk-vfw.exe` helper), `staging` (the destination probe, the staging directory, the commit). |
| `styk-core::export` | The video part of the export request: validation, limits and the job a request becomes (`export-request.mjs` and `video-export-service.cjs validateConfig`, ported), and the flow state machine. |
| `styk-export` | The frame source: `FrameRenderer` (GPU or CPU) writing straight or matte RGBA into a buffer the caller owns. |
| `styk-cli video` | Drives all of it headless: `styk video <file> <first-last> <out> ...`. |

## Rules that hold by construction

1. **No timer in the export path.** Liveness comes from events: encoder exit, a pipe error, the cancel supervisor, a lost
   device. A child that is suspended for ten minutes, or a producer that is paused for ten minutes, ends in the same bytes as
   an undisturbed run. The only clocks are the capability probes (`ffmpeg -version` and the like), which are not an export.
2. **Cancellation is a supervisor, not a flag.** `Cancel` holds an atomic flag and a list of *wakers*. Every component that
   can block registers one when it starts: the session registers one that **ends its child processes** (`TerminateProcess`
   works on a suspended process, and it wakes a blocked pipe write with `BrokenPipe`); the frame pool registers one that
   notifies its condition variable (a producer waiting for a free buffer wakes and returns `Cancelled`); the audio writer
   and the mux register theirs. `Cancel::cancel()` sets the flag and runs the wakers on the calling thread, so it returns
   in microseconds and does not depend on the thread that is blocked. The GPU read-back wait is bounded by the GPU's own
   work (it never waits for the consumer) and the producer checks the flag between frames and tiles; that is the one wait
   the supervisor cannot wake, and its cost is at most one frame (measured as cancel latency). Files are removed by the
   session's `abort`, after the threads that touch them have ended.
3. **Quality is kept beside the bitrate.** `Rate { quality: f64, bitrate: Option<u32> }`. VP9 with a manual bitrate still
   gets its CRF from the quality preset (`-b:v N -crf C`, where Draft, Great and Max give 22, 10 and 2); H.264, MPEG-4 and
   WMV2 take the bitrate instead of the quality. Every preset is crossed with a manual bitrate in the argument golden test.
4. **Producer-specific staging.** A job owns a unique sibling directory of the destination, `.<name>.<uuid>.stage/`, created
   with `create_dir` and holding the outputs under correctly suffixed, initially nonexistent names: `video.<ext>` for the
   FFmpeg output, `mixed.<ext>` for the audio pass (FFmpeg picks the muxer from the suffix), `animation.avi` for the VFW
   helper (which opens with `CREATE_NEW`), `mix.f32` for the sound. The directory is on the destination's volume, so
   committing is a rename and there is no copy path.
5. **Replacement rights are probed before rendering; races are handled at commit.** `plan` creates the staging directory,
   writes and flushes a probe file in it, and, when the destination exists, opens it for write with delete sharing
   *and* renames it onto a second probe name in the same folder and back (a replace the filesystem allows is what the
   commit will do). A failure names the folder or file and stops before frame 1. At commit the rename can still lose a race
   (a viewer opens the file with no delete sharing between the probe and the commit): the finished artifact is **kept**,
   `finish` returns `Err(CommitFailed { artifact })` with its path, and the caller may retry the commit
   (`Committed::retry(dest)`) onto the same or another destination. Cleanup removes the stage only after a successful commit
   or an explicit `discard`.
6. **Decoding checks force an alpha-capable decoder.** WebM comparisons run `ffmpeg -c:v libvpx-vp9 -i file` (the native VP9
   decoder ignores the alpha side channel, so `-pix_fmt rgba` alone reads 255 everywhere). The expected alpha values come
   from the source frames, not from the decoded file's own claim.
7. **Pixel parity includes the legacy `putImageData` step.** Today's FFmpeg frames pass through `context.putImageData`
   (`engine-export-worker.mjs`) and `convertToBlob` before the PNG reaches FFmpeg. The pixel analysis (A7) decodes the legacy
   PNGs and compares them with the native pixels exactly, translucent colours and Smooth sprites included; a compatibility
   conversion is added only if a measured difference needs one.
8. **Revision ownership and cancellation.** An export job holds the document id and revision it started from. An edit,
   undo, redo, a document replacement or a tab close cancels the job (the core's dispatch calls `Cancel::cancel` for every
   job whose `(document, revision)` no longer matches). A cancelled job cannot commit and cannot post progress to another tab:
   each progress update and the commit carry the job's id, and `finish` re-checks the flag after the last child exits and
   before the rename.
9. **Padding only for `yuv420p` codecs.** H.264, MPEG-4 and WMV2 pad an odd width or height by a black pixel on the right or
   bottom (`pad=W':H':0:0:color=black`). VP9 (`yuva420p`), FFV1, rawvideo and VFW keep odd sizes.

## Frames

The producer thread draws on **its own wgpu device** (`GpuExport`, as the worker does today), so `PollType::wait_indefinitely`
never waits for the interface's frames. `FrameRenderer::frame_into(buf)` draws the tiles of a frame (all tiles are queued
before the first is mapped, as many as there are read-back slots) and writes straight RGBA (WebM with alpha, VFW) or RGBA
over black (every other format, the engine's matte) into `buf`; nothing is allocated per frame. Raw RGBA goes to FFmpeg
(`-f rawvideo -pix_fmt rgba -video_size WxH -framerate F -i pipe:0`) where today it sends PNG; everything after `-i` is
today's argument list. Whether raw input gives the same bytes as the PNG round trip is the first check of the spike (A2);
the fallback, if it did not, is `image2pipe` with PNGs from the `png` crate at `Fast`.

Memory is bounded by the pool of three frame buffers, the 64 MiB of read-back slots, the engine's `AHEAD` draw lists and the
encoder child. The producer waits on an empty pool and never allocates.

## Flow

`Preflight` (limits, capabilities, destination probes, free-space note) → `Rendering` (frames, pipe, audio concurrently) →
`Finalizing` (close the pipe, wait for exit, mux sound, check the frame count and the size cap) → `Committing` (flush,
rename) → `Done | Failed | Cancelled`. The sound keeps today's two passes (silent video, then `-c:v copy` with the audio
codec) so container bytes match.

## Byte parity

Native output must equal today's output byte for byte, except fields shown to differ between two runs of today's exporter on
identical input. The baseline is measured, not assumed: today's `VideoExportService` runs twice on the same PNG frames; the
fields that differ between those two files (offset, what it is, why it varies) are the only ones allowed to differ
natively, and each is named in the report and masked only there. No `-fflags +bitexact`, no argument change. The first
thing found by the review (two WebM files of identical input differing at 16 offsets) is such a field: the WebM muxer writes
a random segment UID and a `DateUTC`-style stamp.

## Limits kept exactly

Width and height 1..16384, at most 16,777,216 pixels per frame for FFmpeg video; fps finite 1..1000; 1..1,000,000 frames;
quality 0..1; bitrate 1000..200,000,000 bit/s; output cap 1024 bytes..1 GiB (`-fs`); sound at most one hour. VFW: 256 MiB
output, 64 MiB per frame, 1 MiB codec state, 16 retained states. Messages are the same sentences, kept as localisation keys.

## What this page does not decide

The export dialog; the progress presentation (the core publishes `Progress`, the interface decides how to show it); GIF,
APNG and the picture sequences (same flow, a later chunk); the Save dialog (the destination arrives as a path).
