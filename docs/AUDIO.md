# Audio editing, playback and export

Simple and Advanced share `_styk.audio`, the same audio commands, and the same
worker mixer. Audio lanes align to the exposure grid in Advanced and to the
actual scene exposure spans in Simple. Switching modes preserves recordings and
edits. No audio is attached implicitly to a figure or nested movieclip.

## Using audio

Click the **Audio** music-note icon in the timeline toolbar to open audio editing.
Audio controls start hidden, including when opening a project with recordings.
A small dot on the icon indicates that the project contains audio. Clicking the
icon again, or **Close audio**, returns the space to animation. Hiding controls
does not mute sound, stop playback, edit the project or add an undo step.

In **Advanced**, audio tracks appear beneath animation layers in the same
viewport, sharing its frame ruler, zoom, horizontal/vertical scrolling and
playhead. The Audio group toolbar remains below the ruler while scrolling
through sound tracks. Selecting a sound clip puts its editing controls in the
existing timeline footer; selecting an animation cell or layer restores frame
tools. In **Simple**, Audio is a dedicated tab occupying the filmstrip area;
close it to return to scene previews. A horizontal scrollbar appears when needed
and supports arrow keys and Home/End. The main transport stays available.

Use the timeline's existing resize handle or **Expand timeline** for more room.
The handle also supports arrow keys. Switching modes retains the open tab and
selected audio clip for the current document; this state is not saved in a
project or remembered at the next launch. See [Audio interface design](AUDIO-UX.md)
for the research and verification behind this layout.

Import a recording with **Import audio** or drop a file onto the audio lanes.
The Import button starts at the playhead, using the selected audio track or a new
track. Dropping a file places it at the indicated time and track. **+ Track** adds
an empty lane; double-click an empty lane to import into it. Each track has a
visible options menu, volume slider, mute and solo controls.
When all scene tracks are unlocked, a longer recording extends the animation
in the same undo step. Locked animation tracks are left intact; **Fit animation**
can extend the scene later. Clip edits can also extend past the animation end;
playback and export always obey the animation range.

Drag a clip horizontally to retime it or vertically to another track; the
highlighted destination and waveform preview show where it will land. Drop onto
the **new track** row to create a track and move the clip in one undo step.
Dragging near the edges scrolls horizontally or vertically. Shift-drag keeps
the original time when changing tracks. Escape cancels an unfinished drag.

Drag clip edges to trim; drag its round top handles to adjust fades. Movement
snaps to frames, the playhead and nearby clip edges, with a visible snap guide;
Alt-drag turns off snapping for finer positioning. The selection bar shows exact
start/end times, volume, Split, Duplicate, Delete and Details. Double-click a clip, press Enter,
or use Audio clip properties for exact start/source/duration, volume and fades.
The properties panel also selects its destination track and track volume.
Track names are editable; M mutes and S solos. Clips on the same track may
overlap. Volume is 0–400%; overlapping samples saturate at full scale. Reduce
clip or track volume when the mix clips.

With focus in audio lanes, S splits at the playhead; Delete removes a clip;
Ctrl/Cmd-C/X/V copies/cuts/pastes at the playhead; Ctrl/Cmd-D duplicates after
the selected clip; left/right arrows nudge one frame (Shift: ten), and up/down
arrows transfer it to the adjacent track while keeping timing. Undo/redo use the shared
project history. These shortcuts never act on animation frames behind audio.
The audio clipboard retains one recording and can paste into another project.

**Scrub sound** enables short audio previews while dragging either timeline.
It is off by default. **Ripple** is also off by default. When enabled, inserting
or removing time across every scene layer shifts audio and splits clips at the
edit boundaries. Single-layer edits and ordinary pose changes leave sound in
place. FPS changes keep audio in seconds, at its original speed; they retime the
animation relative to sound. Neither option modifies recording bytes.

## Ownership and resource limits

`audio-model.mjs` validates version-1 audio state. Each embedded asset has an ID,
name, byte size, duration, a bounded waveform summary and original file bytes in
192 KiB base64 chunks. Native container v2 stores these `data_base64` fields in
its existing binary sections. Clips reference an asset ID and contain start,
source offset, duration, gain, fade-in and fade-out, all in seconds or linear
gain. Tracks contain stable IDs, names, gain, mute, solo and clip lists.

The engine session runs every audio command (`engine/crates/styk-edit/src/audio.rs`): it validates the state and records small edit
commands. Unchanged assets/tracks are shared. Added and removed media count
toward history retention without serializing their bytes to measure a command.
Deleting the last clip reference removes its embedded asset from the live
project; undo retains it under the existing history budget. As with other large
commands, the most recent command can exceed that budget by itself.

Audio asset validation yields during cooperative project loading/import.
Prepared animation and raster-export snapshots omit audio entirely. Audio-only
commands advance the saved revision without discarding prepared animation
pixels. Saving/recovery still use the existing worker snapshots and atomic file
replacement. Audio is portable inside `.styk`; external source files are not
needed after import. Figure/Pivot/image/GIF exports contain no soundtrack.

Limits are explicit: 32 MiB per original recording, 96 MiB embedded audio per
project, one hour per recording/timeline, 64 tracks, 4,096 clips, and 32 audible
overlapping clips. Native document/container limits apply in addition to these.
The decoded source Blob cache is limited to 768 MiB and evicts unused sources;
an active mix too large for that cache fails explicitly and releases its cache.
Waveforms have at most 4,096 bins; visible rows and waveform pixels are drawn
only for the current viewport. Hidden audio controls skip waveform painting and
cancel pointer gestures/popovers; transport resources remain owned by the audio
engine. Replacing the timeline releases its jobs, listeners and DOM.
Simple also defers new filmstrip thumbnail work while the Audio tab occupies
that space, retaining only its time mapping and scroll range.

Pointer movement only previews metadata; one validated command commits on
release. Snapping searches a sorted list of boundaries, and Simple exposure
mapping uses binary search. Neither drag preview nor panel resizing clones media
or writes document history. Rulers remain visible while scrolling through tracks.

## Decoder and transport

WAV PCM (8/16/24/32-bit integer or float32, mono/stereo) is read directly using
bounded Blob slices. The desktop decoder accepts WAV, MP3, AAC/M4A, FLAC, Ogg,
Opus, AIFF and supported Matroska audio through the bundled FFmpeg build.
Actual decoder availability depends on that build. Other encodings are rejected
with an error. Compressed audio decodes locally to a temporary stereo 48 kHz
PCM WAV, streamed back in acknowledged chunks of at most 256 KiB. The isolated
preload exposes token-based audio import methods, never arbitrary file paths or
commands. The service bounds input, output, concurrency and operation lifetime,
restricts demuxers/protocols, and removes temporary files on success or failure.

Browsers directly support the same PCM WAV reader. Browser-native compressed
decoding is limited to 8 MiB and two minutes, with decoded size checks; use the
desktop app or WAV for longer compressed recordings. Original bytes, waveform
generation, resampling and mixing stay in the audio worker, except this bounded
browser fallback's native asynchronous `decodeAudioData` operation.

`audio-pcm.mjs` provides the shared stereo mixer with sample-count-based timing,
source trims, overlap, mute/solo, gain and linear fades. Preview and export use
the same mixer, including its full-scale saturation rule. Rendering is divided
into 12,000-sample chunks (250 ms at 48 kHz). Preview schedules less than one
second of PCM through Web Audio's clock; the main thread copies only those
small stereo chunks. Animation holds on missing prepared frames, stopping and
re-anchoring audio with the transport. A mixer underrun pauses with an error.
Pause, seek, loop boundaries, document replacement and cancellation stop stale
scheduled sources. Playback does not silently skip animation frames.

## Video export

**Include audio** defaults on for audible tracks. Desktop FFmpeg export mixes
the selected range offline into a bounded disk stream, then muxes the soundtrack
with the already encoded video using video stream copy. MP4 uses AAC, WebM Opus,
AVI PCM16 and WMV WMA v2. Available encoders are checked before beginning an audio
export. The final output retains the existing size limit and atomic save path.
Audio and video jobs share cancellation and clean up partial files together.

Browser video takes the same mix through WebCodecs (`src/audio-encode.mjs`): AAC in
MP4 and Opus in WebM, each offered only where the browser reports it can encode it.
The whole soundtrack is encoded before the first frame (about 1 MiB a minute) and
handed to the muxer: MP4 stores it as a second track after the video samples, WebM
interleaves it with the video in time order. Sound up to one hour is accepted. The
AAC encoder's priming samples are not trimmed, so sound can start a few
milliseconds late in a player that does not skip them; WebM's Opus header carries
its pre-skip and seek pre-roll. Installed Windows VFW exports still require turning
off Sound explicitly. The export dialog explains this before export, and so does a
browser without the encoder; nothing ever silently discards an audible soundtrack.
Lossy audio formats may contain encoder priming/padding within one codec block;
tests check decoded sample content and container duration with codec-appropriate
tolerances.

## Verification

- `node --test tests/audio.test.mjs tests/audio-service.test.mjs`
- `node tests/audio.browser.mjs` with the local server running
- `node tests/audio-navigation.browser.mjs` for optional navigation, shared Advanced
  coordinates, contextual tools, focus return, hidden playback and launch state
- `node tests/audio-ux.browser.mjs` for timeline resizing/expansion, track transfers,
  drop import placement, fades, volume, snap guides and scrolling during drags
- `node tests/audio.desktop.mjs` with a working Electron environment and bundled FFmpeg
- `node tests/layer-timeline-modern.browser.mjs`
- `node tests/timeline-polish.browser.mjs`
- `npm test` and `npm run check`

Evidence is written under `artifacts/audio/`, `artifacts/audio-navigation/`,
`artifacts/audio-ux/` and `artifacts/audio-desktop/`.
The desktop test imports an actual MP3, exports all four formats plus a selected
range and an MP4 through the export dialog, then independently decodes their
soundtracks. It checks leading/trailing silence, audible samples, durations,
bounded IPC, cancellation/retry and preview clock alignment. Browser checks
cover editing in both views, keyboard isolation, native save/reopen and a cold
audio worker. These are source-workspace checks; packaging and platform-specific
release verification remain part of the release process.
