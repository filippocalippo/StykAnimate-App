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
| `styk-cli video` | Drives all of it headless (`cargo run -p styk-cli --features app-tools -- video <file> <first-last> <out> ...`); the `app-tools` feature is the only way `styk-cli` reaches `styk-core`, `styk-services` and `styk-platform` (`cargo xtask deps`). |

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
   writes and flushes a probe file in it, and, when the destination exists, checks it is a file that is not read-only and
   opens it with the DELETE right and full sharing (what the replacing rename needs; it changes nothing, so the destination
   is never moved aside, not even for a moment). It runs before the encoder is probed. A failure names the folder or file
   and stops before frame 1. At commit the rename can still lose a race
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
over black (every other format, the engine's matte) into `buf`; nothing is allocated per frame. The writer thread encodes each frame as a PNG (fast compression) and sends it to FFmpeg as today's app does
(`-f image2pipe -c:v png -framerate F -i pipe:0`): the arguments are today's in full. Two cheaper inputs were tried and
rejected on evidence. `-f rawvideo` hands the scaler rows of exactly `width * 4` bytes, for which it rounds differently
(WebM at 65 by 33 and 161 by 91 gave other bytes; a test keeps the observation). Uncompressed PAM images fixed that but made
the encoder queue whole frames: at 4K it took 350 MiB more than with PNG (H.264 1,097 against 744 MiB, WebM with alpha 2,333
against 1,984), for 9% more time on H.264 (the PNG encode on the writer thread) and none on WebM. PNG keeps today's bytes and today's encoder memory.

**WebM with transparency keeps today's canvas mapping.** Today's frames go through a canvas, which stores premultiplied
colour: the colour of a translucent pixel comes out of the PNG changed (alpha is exact, opaque pixels are exact, the colour
under alpha 0 becomes black). `styk-export::legacy_canvas` applies the mapping, measured in Chromium over every colour and
alpha level (`scripts/generate-legacy-canvas-fixture.cjs`), to the straight frames of WebM, and only there. Installed Windows
codecs get straight frames without it (their legacy path is not the same canvas step; see the report).

Memory is bounded by the pool of three frame buffers, the 64 MiB of read-back slots, the engine's `AHEAD` draw lists and the
encoder child. The producer waits on an empty pool and never allocates.

## Flow

`Preflight` (limits, destination probes, capabilities) → `Rendering` (frames, pipe, audio concurrently) →
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

## What the spike measured (2026-11-07, Ryzen 5 5500, RTX 4070 SUPER, shared machine)

- **Arguments.** `styk-platform/tests/ffmpeg_arguments.rs` holds `args::encoder_args` and `mux_args` to 2,382 command lines
  generated from today's `validateConfig`, `encoderArguments` and `muxAudio` (every codec by every preset by a manual
  bitrate, sizes, frame rates, limits and refusals). `styk-core/tests/video_jobs.rs` holds the request-to-job derivation to
  3,380 records from `videoExportArguments`, `encodeNativeVideo` and `validateConfig`, refusals included.
- **Bytes.** Today's service (driven from Node with the same frames) is run twice, then the native export. Every codec in
  MP4, AVI and WMV gives equal bytes in all runs. WebM differs between two runs of today's service in exactly two 8-byte
  fields, found by structure: the `TrackUID` (EBML id `73 C5`) and the `TagTrackUID` (`63 C5`), random per file (a larger file holds a second copy of each later on, found by the same structure). They are the only bytes native
  WebM may differ in, and it differs in nothing else, with translucent frames from Chromium's canvas included.
- **Windows codecs.** Uncompressed (both architectures), Microsoft Video 1 (x64) and Cinepak (x86) AVI files equal today's
  helper output. Cinepak at its default quality differs between two runs of today's service (the codec is not
  deterministic); native equalled the first run.
- **Memory** (4K, H.264 Great, 120 frames, private bytes): the export adds 0.8 GB (a heavy document) to 1.6 GB (a light one)
  to the process before it starts, of which the encoder is 1.1 GB (x264 at 4K with today's arguments); today's figure is
  1.8 to 2.1 GiB. At 1080p a 1,872-frame export grows 10 MiB between frame 200 and frame 1,871.
- **Cancel** at 4K ends in 23 to 44 ms with nothing left behind; with the encoder suspended, 0.2 ms; during the finish,
  8 to 40 ms; during the audio pass, 41 to 51 ms.
- **No timer.** An encoder suspended for 300 s and a producer paused for 200 s end in the same file, byte for byte.
- **One reference run against today's app** (`tests/export-4k.desktop.mjs`, its 12-frame document at 3840 by 2160, shared
  machine, directional): today's app 5.3 s (MP4, Smooth sprites), 7.7 s (WebM), 4.1 s (MP4, no smoothing); `styk-cli video` on
  the same document 4.5 s, 5.6 s and 2.1 s, document open excluded. The files are not byte-equal across the two apps
  (82,699 against 81,639 bytes for the first): the frames come from two GPU stacks (Chromium's WebGPU and wgpu), and the
  decoded videos agree at 66 to 68 dB PSNR. Byte parity holds for the encoder path, from identical frames.
- **Not decided here:** export order independence (the engine renders 52 of 64 frames of one document differently when drawn
  in reverse; engine chunk X fixes it, and the check `--no-encode --frame-hashes --order` is ready for it), the full-disk
  case (needs an administrator to make a small volume), and an input-latency test of the interface during an export (needs
  the shell).

## Fixes after the review and the check (2026-11-07)

Each has a test that fails without it (shown by breaking the fix in turn; the run is in the S3 report).

- **A cancel wakes a frame waiting for the GPU.** The wait is on a condition variable that the mapping callbacks and
  `Interrupt::interrupt` both notify (`styk-export::interrupt`); the GPU's own wait runs on a poller thread nothing waits
  for. The job's `Cancel` is wired to it, a producer stopped that way reports the cancel, and the CPU path checks between
  tiles. An interrupted exporter is dropped, not reused.
- **A cancel can no longer be followed by a replaced destination.** `Cancel::begin_commit` is the commit boundary: the flush
  of the finished file happens before it (an edit or close during a slow flush still cancels), the rename after it (a cancel
  from then on is too late and changes nothing).
- **The finish waits for the progress reader** before it trusts the frame count and the helper's `complete` line, and on an
  error it ends the encoder before joining the pipe writer. The flow takes its frame count from the request.
- **The destination probe tests the real operation:** a file made in the stage is renamed into the destination's folder
  (a folder that takes subfolders but not files is refused), then once more under a name as long as the destination's (a
  failure there names the file, not the folder).
- **The stage name is short** (`.styk-<process>-<unique>.stage`) and independent of the destination's; a destination name
  over 255 characters is refused naming the file.
- **Nothing outlives the app.** Every child joins a Windows job object that kills its members when the app's last handle
  closes, a hard kill included, a suspended encoder included. A stage left by a killed app is swept by the next export to
  that folder when its process is gone and it has sat untouched for two minutes (today's idle timer); anything else in the
  folder is left alone. Elsewhere the child is ended by a direct `kill` and reaped by its waiter thread, never waited for by
  the cancelling thread.
- **Input is PNG, as today's.** PAM, the first fix for odd sizes, cost the encoder 350 MiB more at 4K (above).
- **Tests fail loudly without the encoder** instead of passing silently; a bad `--size` is refused with a message.
- **The headless driver is `styk-cli video`** behind the non-default `app-tools` feature; `cargo xtask deps` allows
  `styk-cli` to reach `styk-core`, `styk-services` and `styk-platform` only through it (the manifest is read, since the
  lock file cannot tell a feature from a dependency) and holds those three away from the toolkit and from other front-end crates.

### Memory at 4K (svr_uriel, 120 frames, private bytes)

| | today's service | native |
| --- | --- | --- |
| H.264 encoder child | 711 MiB (driver 136) | 744 MiB |
| WebM with alpha encoder child | 1,896 MiB (driver 121) | 1,984 MiB |

Our process: 140 MiB the document, 67 decoded pictures, 78 adapter, 201 device, 67 exporter, 256 sprite atlas (all before the
first frame, 773 MiB once the decoded copies are dropped), then 110 MiB for the first frame (three frame buffers, the read-back
slots, the resolved tile) and, on this document, a one-time 265 MiB at tick 135 that is the same at 1080p (a renderer
allocation, not the export's). The export's own share is about 110 MiB; the rest is the renderer's and the engine's
and is the floors rule's to take up (a candidate: the sprite atlas pages and the effect slots).

### Order independence (A9)

Frames drawn forward, reversed, shuffled and interleaved with frames of another open document, 64 frames at 640 by 360 each,
on svr_uriel, tdd2, AyameDemo and testingupload: 0 differing frames in every case (the same check found 52 and 29 differing
frames on svr_uriel before chunk X).

## Fixes after the re-check (2026-11-07)

Windows only in this phase (decision N8): the video module is built on Windows only, and no Unix process code is written.
`ChildGuard` is the one place a process is ended; a Unix implementation replaces its handle by a stable one (a pidfd on
Linux) and nothing above it changes.

- **A kept video is not swept.** A commit that lost a race writes a `kept` marker into the stage, naming the process that holds
  the video. The sweep honours it: while that process lives the stage is not touched; once it is gone, only after the marker has
  been idle for the two minutes of today's service (which keeps such a file in its reading session and deletes it when the
  session has been idle that long). A retry claims the stage first (the marker names it and is touched).
- **A cancel during the flush returns at once.** Today's service renames without flushing; the native one flushes first so that
  a power cut after the rename cannot leave an empty file, and runs the flush on a helper thread. A cancel wakes the commit
  while the helper goes on; the helper then closes the file and removes the stage. The destination is still never replaced
  after a cancel (the commit boundary is after the flush).
- **Cancelled GPU resources are disposed of elsewhere.** A dropped `GpuExport` hands its device, queue, renderer and buffers
  to a disposal thread (at most four waiting; more each get a thread of their own), so dropping it never waits for the GPU
  to go idle. The poller thread owns its own device clone and ends after the wait it is in. A stalled GPU keeps the resources it
  holds, not the thread that cancelled.
- **A failing wait for the GPU wakes the producer.** A poll error becomes a terminal error of the frame latch.
- **A child joins its job before it runs.** It is created suspended, assigned to the kill-on-close job, then resumed.
- **Translucent WebM is held to today's file in a test** (`styk-cli`, `translucent_webm_equals_the_file_made_from_the_canvas_pngs_of_todays_app`):
  the canvas-mapped frames of today's app as PNG through today's arguments against the native session, and the same without the
  mapping, which differs.

## Cancellation checks under machine load

The platform suite synchronizes on the actual child or flush helper, with bounded hang guards.
Video cancellation ends a suspended audio-pass child and reaps it before returning; a commit
returns cancellation while its flush is held. Both flush/receiver completion orders remove the
stage and preserve the destination. Decoder timeout kills and reaps a child with no natural exit.

The original latency workloads and bounds remain quiet-machine gate checks (1 s for audio-pass
cancellation, 250 ms for flush cancellation, 3 s for decoder timeout). The orchestrator runs these
with the machine quiet, through the queue, from `engine/`:

```sh
timeout 300 cargo test -p styk-platform quiet_gate_ -- --ignored --test-threads=1
```

These ignored measurements are required at the gate; a loaded functional suite does not certify latency.
