# Audio: playback in sync with the timeline

Status: design for chunk S4 (audio), revised with its review (every finding accepted), 2026-11-07. The behaviour to match is
today's ([../AUDIO.md](../AUDIO.md)); this page says how the native app keeps it and where it differs underneath. Code:
`styk-services::audio` (traits, the stream driver, the fake device), `styk-platform::audio` (WASAPI output, the FFmpeg
decoder), `styk-core::audio` (model, mixer, sources, transport, clock), `styk-cli audio` (the headless soundtrack mix).

## Decisions

1. **The decoder and the resampler are today's.** Everything that is not a plain WAV is decoded by the bundled FFmpeg 7.1
   with today's arguments (`-map 0:a:0 -vn -sn -dn -t 3600.001 -ar 48000 -ac 2 -c:a pcm_s16le -f wav`, the same format
   whitelist, the same input and output limits and 120 s timeout), for preview and export alike. No Symphonia, no other
   resampler: imported waveforms and exported soundtracks keep their bytes.
2. **One mixer, ported line for line.** `styk_core::audio::mix` is `mixAudio` of `src/audio-pcm.mjs`: clips in document
   order (never sorted), `f64` arithmetic, a store to `f32` after every contribution, the saturator last. Goldens are
   today's `audio-pcm.mjs` output, compared bit for bit.
3. **Today's semantics stay.** An audio edit pauses playback; scrub sound is off by default, retriggers after 100 ms and
   plays an 80 ms slice with a hard cut; there are no ramps and no live plan swaps. The 40 ms scheduling lead of Web Audio
   is not copied (it exists because Web Audio needs it); the device clock is the master, as today. Anything better is a
   separate proposal.
4. **The audio device clock is the master.** A frame is presented only when the heard position has reached it, frames are
   never skipped, the video may lag the sound, never lead it (`app.mjs:1660-1715`).

## Sources

`WavSource` is a RIFF file in memory plus its parsed format: `inspect_wave` is `inspectWave` (format codes 1 and 3, also in
a `WAVE_FORMAT_EXTENSIBLE` header, 8/16/24/32 bits, 1 or 2 channels, 8 kHz to 192 kHz, at most 4096 chunks, a `data` chunk
that is a whole number of frames, 1 sample to 3600 s). `decode_source` is today's `decode`: try `inspect_wave` on the
original bytes; on any error run FFmpeg to a WAV in a private temporary folder and `inspect_wave` that. A plain WAV is
mixed at its own rate with linear interpolation; everything else is 48 kHz stereo `s16` from FFmpeg.

Embedded assets are the document's `_styk.audio.assets` (chunks of base64). The chunks are joined once per decode into **one buffer
of the stated size, reserved first**: each base64 chunk is decoded straight into it, so no second copy of the original exists
(the original, at most 32 MiB, is in memory as in today's worker). Peak new allocation is measured against the reservation.

### Memory (decoded buffers)

Today the cache holds decoded sources up to 768 MiB, evicts the ones the mix does not need, and an active mix over the limit
fails explicitly ("the active audio mix exceeds 768 MiB") and releases its cache. Natively a decoded buffer lives as long as
anything holds it, so eviction alone does not bound memory. One `Budget` counts **every live allocation of decoded audio**:

| Class | What | Released |
| --- | --- | --- |
| decoding | reserved **before** the decode starts (WAV: the file size; FFmpeg: `44 + 4 * 48000 * duration` from the asset, raised to the real size when the output file is known and before it is read) | when the decode ends, replaced by the pinned size |
| pinned | referenced by the plan that is playing or being prepared | when the last `Arc` of the buffer drops |
| retired | evicted from the cache but still held by a playing plan | same: the `Arc` drop credits the budget (a drop guard) |

The limit is 768 MiB for the three classes together. A reservation that does not fit after evicting every unpinned source
is refused with today's explicit error and the cache of unpinned sources is released; nothing is half-held: a failed or
cancelled decode returns its reservation (a guard). Preparing is single-file: one decode at a time (today: one import).
Reclamation of buffers never happens on the output thread (see Handoff).

## The mix plan

`MixPlan` = the audible clips (`audibleClips`: track not muted, soloed if any is, `track.gain > 0`, `clip.gain > 0`,
`gain = clip.gain * track.gain`) **in document order**, each with its source. A block is a scan of the clips in that order
(at most 4096 of them, microseconds per block; a start-sorted index would only find candidates and was not needed). This is
the fix for review finding 3: the sum rounds to `f32` after each contribution, so order changes bits (amplitudes 1, 2^-24 and -1 starting
at .02, 0 and .01 give `[0, 0]` at sample 1440 in document order and `5.96e-8` sorted by start). The three-clip case is a
golden. The plan is immutable and shared by `Arc`; building it is a worker job.

## The clock

### Units

- **Project time** is seconds; a *project sample* is `round(seconds * 48000)`.
- **Stream frames** are frames written to the endpoint since the device stream's last reset (its *epoch*). The stream format
  is 48 kHz stereo `f32`, so stream frames and project samples have the same rate.
- **Device position** is `IAudioClock::GetPosition`: a position in the units of `IAudioClock::GetFrequency()` (not
  necessarily frames or 48 kHz) paired with a QPC value **in 100 ns units**. `stream_frames_heard = position * 48000 / frequency`.
  The reader never assumes `frequency == 48000`.
- **Host time** is nanoseconds of a monotonic clock (`HostClock`); on Windows QPC, the same base as the 100 ns pair.

### The mapping

The render callback writes **segments** into a ring (a seqlock, fixed size, no allocation): `Playing { stream_start, frames,
project_start }` for a stretch that renders project samples `project_start..` contiguously, `Held { stream_start, frames,
at }` for silence that is not project time (after the range end, a gap the device played while the callback missed
deadlines). Adjacent contiguous stretches coalesce. The output thread writes the **device clock cell** (a seqlock) once per
period: `{ epoch, position, frequency, host_100ns, rendered_frames }`.

Reading `media_time_at(host_ns)`:

```
heard = position * 48000 / frequency + (host_ns / 100 - host_100ns) * 48000 / 1e7     (extrapolated, >= 0, <= rendered_frames)
segment = the segment of this epoch containing floor(heard)
media = project_start + (heard - stream_start)         for Playing        (fractional, f64)
media = at                                             for Held
time = min(range_end, media) / 48000
```

Because the segment table and the device cell are separate, a read takes both consistently (retry a few times, then return
the previous reading: it never blocks and never waits).

### Validity and boundaries

A reading is `Stopped { at }`, `Starting { at }` (the command is queued, or the callback applied it but no frame has reached
the endpoint) or `Running { time }`. Every command carries a **generation**, issued by the transport; the callback
publishes the generation it applied; the cell carries the epoch. A reading is `Running` only when (a) the applied generation
equals the generation issued, (b) the segments and the cell carry the same epoch, (c) `position > 0` in that epoch, i.e.
the first rendered frame has been heard. Until then the media time holds at the start time (as today during the lead).

- **Nonzero start.** `Play { from, end }` begins a new epoch whose first segment is `Playing { 0, _, from }`.
- **Seek, loop, range end.** Each is a new `Play`: a new epoch and generation, as today (`app.mjs` restarts audio); a loop
  restarts at the range start. Nothing is mapped across the boundary.
- **Silence.** After the range end the callback renders silence and the segment is `Held { at: end }`: media time stays at
  the end and the transport reports `Ended`.
- **Stall.** The frame scheduler holds the frame while the next frame is not ready; as today it stops the audio and
  re-anchors (a `Stop` then a `Play` from the current tick).
- **Underrun** (below) inserts a `Held` segment for the gap that the device played.

## The output

### Format negotiation

The renderer asks for 48 kHz stereo `f32`. At open the endpoint's mix format `F` (`GetMixFormat`) decides:

1. **Direct (low period).** If `F` is 48 kHz `f32` with any channel count, initialise `IAudioClient3` shared with
   `InitializeSharedAudioStream(F)` at the smallest period the engine reports (`GetSharedModeEnginePeriod`). We write `F`
   ourselves: stereo goes to front-left and front-right, other channels are silent (`map_channels`; a mono endpoint gets the
   mean `(L + R) / 2`). No conversion by the system.
2. **Converted (the ordinary shared mode).** Otherwise (44.1 or 96 kHz, an integer or odd format, or the low-period
   initialisation is refused) initialise `IAudioClient::Initialize` shared, event driven, with the 48 kHz stereo `f32` format
   and `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`: the system converts rate and channels.
3. If both are refused the open fails with a message; playback falls back to the wall clock (no sound, the toast says so).

`OutputInfo` reports the path taken, the endpoint format, the period and `GetStreamLatency`. The stream is event driven and
the thread runs in the MMCSS "Pro Audio" class.

### Stream driver and the three kinds of stop

One `StreamDriver` (in `styk-services`) holds the protocol and runs against an `Endpoint` (WASAPI, or the fake). Per wake it
first lets the renderer **apply a waiting command** (`RenderSource::poll`), so a stop or a new play takes effect at the next
wake even when the device buffer is full and has no room for a block (found by the fake: the first version asked only when
there was room, and a stop waited for the buffer to drain); then it reads the padding, asks the renderer for the free frames,
writes them and publishes the clock cell. The renderer answers
`Continue`, `Restart` or `Idle`:

| Kind | What happens to what is queued | Used for |
| --- | --- | --- |
| **Transport cancel** (`Idle`, `Restart`) | `Stop()` then `Reset()`: **queued sound is discarded now**; the epoch increases; the device position restarts at 0 | `stop()`, seek, loop, a new `Play`, an audio edit, scrub retrigger and release |
| **Silence** | the stream keeps running and the renderer writes zeros; queued sound before it **still plays** | after the range end until the transport notices; a gap |
| **Endpoint stop** | `Stop()` without reset; resumes where it was | never used while a transport command is pending; device loss |

A `Play` always begins with cancel: the stream is stopped and reset, the buffer is filled with the first blocks of the new
generation, and then started. `Starting` covers the time until the first frame is heard, so a high-latency (Bluetooth)
output simply stays `Starting` longer; the frame scheduler follows the clock and does not need to know the latency.

### Underruns

An underrun is a deadline missed by the output thread or the renderer, and it can open **anywhere in a wake**: between the
position read and the padding query, or between the padding query and the submit. A gap whose extent is unknown must not be
mapped, so the driver never guesses it: it checks three times and **flushes and re-anchors** when any says the device ran dry.
(1) The device position is past what was written. (2) The padding is 0 while the stream was running. (3) After the submit, the
position is read again: the device cannot have played any of the new frames before they were submitted, so a position past what
was written before the block, by more than the time since the submit allows, is silence the device played (`Endpoint::write`
returns the submit time for this). Re-anchoring is a new epoch (stop, reset, refill, start) where the renderer is; in case (3) the
block that went into the flushed device is given back to the renderer (`RenderSource::rewind`), so no sound is skipped. The clock
reads `Starting` until the first new frame is heard, so the video holds meanwhile (`media_time()` is `None`), and the `underruns`
counter rises. Where a device's position stops with its data nothing is mapped wrongly and nothing needs doing. The fake device
injects delays inside a wake (before the padding query, before the submit) and holds the clock to the sample the device is
playing. The mixer itself cannot miss a deadline for I/O: all sources are resident before `Play` is accepted.

### Device loss

`AUDCLNT_E_DEVICE_INVALIDATED` (or any fatal endpoint error) ends the thread's loop with `DeviceLost`; the transport sees the
flag, reports it, and the frame scheduler falls back to the wall clock at the current tick (playback continues silently with
a toast) until the user plays again, which reopens the default endpoint.

## The handoff (user interface thread to the output thread)

The output thread never locks, allocates, frees a large block or waits.

- **Commands.** `Play { generation, plan, from, end }` and `Stop { generation }` go through a **single mailbox** of an
  `AtomicPtr<Command>`: the sender swaps in its command, the output thread swaps the mailbox to null once per wake. A newer
  command replaces an unread one, so **Stop can never be lost behind a full queue** (the newest intent always wins, and
  nothing is queued that could overflow). The replaced command comes back to the *sender* from the swap and is handed to the
  reclaimer. Commands are numbered by one issuer, so "the newest" is well defined; a command whose generation is older than
  the one applied is ignored (stale).
- **Reclamation.** When the renderer replaces a plan (or finishes one) it does not drop it: the plan moves into the command box
  that carried the new one (`retired`), and that box is pushed onto a lock-free stack (a pointer swap; the box already exists,
  so no allocation). The sender takes the whole stack on each call and sends every box to the **reclaimer thread**, which
  drops them. Large buffers are therefore freed neither on the output thread nor on the interface thread.
- **Events.** The renderer publishes state, not messages: `applied_generation`, `ended_generation`, `underruns`,
  `device_lost`. State cannot overflow and a terminal event cannot be dropped.
- **Prepare jobs.** One worker thread, one request waiting (a newer one replaces it), one result waiting (an unpolled older one
  is replaced and freed on the worker), handed over by **atomic one-slot handoffs**: the interface side takes no lock the worker holds, only puts a request, takes a result and cancels through the job's own token (a short critical section with no waiting inside); the worker parks when idle. However many prepares are asked for, the process has one thread and each handoff holds
  one item. `prepare` returns a job identity; starting another prepare cancels **that one job** (its `Cancel` wakes a blocked
  FFmpeg wait and kills the process); a finished job is accepted only if its identity is the transport's current one, otherwise
  the plan is reclaimed and never reaches the output ("prepare A, then stop or edit, then A completes" starts nothing). `poll`
  takes at most one result and hands a bounded number of items (64) to the freeing thread.
- **Reclamation is bounded.** The freeing thread's queue holds 256 items; what does not fit waits in a backlog of at most 256;
  past that the oldest is freed on the caller and counted (`reclaim_overflows`): visible and recoverable, never a block, and zero
  at the pace of a person.
- **Every exit hands its plans over.** The device thread, on any way out of its loop (close, device lost), leaves the renderer's
  plan in the control block's graveyard (`RenderSource::retire`); the closer frees it. Closing the transport moves the output, the
  mailbox, the cache, the worker (and the result it may hold) and the freeing thread's backlog to a closing thread. Errors on the
  output thread carry the system code only (`AudioError::Hresult`), so no text is built where nothing may allocate.
- **Scrub.** `scrub(tick)` is a throttled `prepare` plus `Play { from: tick time, end: from + 80 ms }` with no ramps; a retrigger
  needs **more than** 100 ms since the last (`performance.now() - audioScrubAt > 100`), and the time of the last one is kept when
  the gesture ends (`stopAudioScrub()` leaves `audioScrubAt` alone); the release is `Stop`. Scrubbing and playing use the same renderer and the same mixer.

## Export

`OfflineMixer` mixes a range in 12,000-frame chunks with the same `mix` (the same code, the same order); it is the
`AudioSource` that `styk_core::export::flow::run_video_export` (S3) streams to the encoder. `styk audio <project> <out.wav> [--start s] [--duration s]` mixes a document's soundtrack to a float32
WAV the way `pcmWave` writes it; it is how the goldens are checked end to end.

## Waveform cache key

Peaks are computed at import (`wave_peaks`: 80 bins per second, at most 4096, the largest absolute sample over channels,
rounded to 4 decimals) and stored in the asset unchanged. The drawn bars depend on more than the asset, so a view model is
cached by `WaveformKey`: asset id and revision (size and duration of the asset), the clip's **source offset**, **duration**,
the **effective gain** (clip gain times track gain, which sets the bar height), fade in, fade out, the track's mute (alpha),
the horizontal scale (pixels per second) and the clip's pixel width. Two clips sharing an asset with different trims differ
by key; undo and redo return the same key and hit the same entry. The cache is bounded by bytes and entries, with no exemption: a value that alone is over the byte limit is refused.

## Verification

| Check | Where |
| --- | --- |
| Mixer equals today's `mixAudio` bit for bit: formats 8/16/24/32/f32, extensible, mono/stereo, 8/22.05/44.1/48/96 kHz, offsets, fades, overlaps, saturation, the cancellation-sensitive three-clip case, chunks of 1, 480, 12000 and 48000 frames | `styk-core` test `audio_goldens`, goldens from `scripts/generate-audio-goldens.mjs` (run twice: old against old) |
| Peaks equal `wavePeaks` | same |
| Clock across nonzero starts, seeks, loops, silence, stalls, underruns, units (frequency 44100, 96000, 10 MHz), 44.1/48/96 kHz and multichannel endpoints | `styk-core` and `styk-services` tests with the fake device |
| Handoff: stop priority, stale prepare, saturated mailbox, reclamation off the output thread | `styk-core` tests |
| Memory: oversubscription, cancellation, concurrent prepares, resident bytes | `styk-core` tests |
| Real device: the endpoint this machine has (format, path, period), the clock against a loopback capture of clicks, stress under load, decoding and an export, scrub latency with a time-coded signal | `styk-cli` tests (`--features app-tools`, `--ignored`), loopback capture of the same endpoint |
| The FFmpeg decoder: today's arguments and bytes, limits, cancel and timeout waking a child that never exits, temporary folders swept | `styk-platform` test `audio_decode` (the bundled FFmpeg; it fails, not skips, without it) |
| A saved project's soundtrack through `styk audio` equals the goldens byte for byte | `styk-cli` test `audio_cli` |

## Notes for the wiring

- `WasapiOutput::open` waits for the device thread to report the opened stream (tens of milliseconds, more with a slow driver):
  the app builds its `AudioTransport` on a job thread, never in `update`/`view` (D7).
- Children of the decoder die with the app through the job object that `styk_platform::video::process::spawn` joins them to
  (S3's chunk); the audio decoder uses that function and adds none of its own.

## Cancellation checks under machine load

The platform suite synchronizes on the actual child or flush helper, with bounded hang guards.
Video cancellation ends a suspended audio-pass child and reaps it before returning; a commit
returns cancellation while its flush is held. Both flush/receiver completion orders remove the
stage and preserve the destination. Decoder timeout kills and reaps a child with no natural exit.
Decoder cancellation likewise waits for child startup, cancels a child with no natural exit,
and checks that it was reaped and its scratch folder removed before returning.
The core transport test holds the decoder after it acknowledges cancellation: its reservation
must remain accounted until it returns. An empty prepare on the same serial worker then
acknowledges cleanup before the test checks the budget; a decoder's private cancellation flag
is not a completion event. Stop must return while that decoder return gate is still closed.

The original latency workloads and bounds remain quiet-machine gate checks (1 s for audio-pass
cancellation, 1 s for decoder cancellation, 100 ms for transport stop, 250 ms for flush cancellation,
3 s for decoder timeout). The orchestrator runs these
with the machine quiet, through the queue, from `engine/`:

```sh
timeout 300 cargo test -p styk-platform quiet_gate_ -- --ignored --test-threads=1
timeout 300 cargo test -p styk-core quiet_gate_transport_cancel -- --ignored --test-threads=1
```

These ignored measurements are required at the gate; a loaded functional suite does not certify latency.
