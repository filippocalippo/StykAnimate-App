# Export experience and high-resolution verification

The export dialog (`src/export-sheet.mjs`, a kit dialog with the id
`export-dialog`) shows a preview beside the settings. The preview draws the
first exported frame through the thumbnail worker (only while the dialog is
open), plays the chosen range with ▶, and carries the trim strip: its two ends
and the typed From and To fields are one range, and All restores the whole
animation. Above the settings, Quick presets (below) fill them in for a
destination. The settings, top to bottom: Name (the file name, today's name until
one is typed, with the extension after it), Format (Video, GIF, Frames and
Project: today's Video, Animated image, Frames & sequences and Editable file),
Type (a visible select whose options are today's export commands; a Project
lists its four types, .piv, .stkz, .stk and .stykmov, and one that cannot be
exported says why), Size (Original, the default, then 1080p, 720p, 4K and
Custom…, which shows Width, Lock ratio and Height; presets keep the artboard's
shape and orientation), then the chosen type's own settings: Quality (Draft,
Great and Max: today's Smaller file, Recommended and Higher quality), Colours ›
Dither for GIF, the JPEG sequence's quality, Sound when the animation has
audible clips, Picture (edges, and whether the type keeps transparency, with
the reason when it does not), and for video Encoding, a titled section that
starts closed as today's Advanced video settings did, shows the codec and rate
in its title and remembers being open (MP4 and AVI codecs, bitrate, and the
installed Windows codecs with Configure…). The foot sums up the output pixels,
frame count, duration and frame rate (or the current frame) and names the type
on the one primary button ("Export MP4"). Irrelevant settings are hidden.
Invalid names, dimensions, memory plans, ranges, GIF rates and active
quality or bitrate inputs mark their field and disable Export with an inline
explanation. The dialog remembers the last export's type, size, quality,
smoothing, bitrate, codecs and Lock ratio (the editor setting
`exportPreferences`; for the session until the settings schema holds it); the
range, the name, Dither and Sound start over each time, and a remembered
custom size of another shape opens as Original. Capability probing, the
installed codec controls (`src/vfw-export-controls.mjs`) and the export
commands remain responsible for providers, codecs, rendering and saving. Video
quality defaults to Great (Recommended). Native encoders select bitrate from
scene complexity; the browser calculates a target from the final dimensions
and frame rate. See the [quality-control contract](EXPORT-FORMATS.md) for
mappings and verification.

For a document the engine draws, the frames come from the engine's export
renderer ([engine rendering: exports](engine/rendering.md#exports)); opening
the dialog starts its worker and GPU device, so the export does not wait for
them (`prewarmExportRenderer`; a worker no export takes within a minute is
released). Progress, Cancel and Stop exporting behave as with the JavaScript
renderer.

## Quick presets

Quick presets (`src/export-presets.mjs`, `#export-presets`) are tiles for where
the animation is going: YouTube (1080p, Max), Shorts, TikTok and Instagram
(1080p, vertical), X (720p), Chat GIF (a GIF at most 480 px on its short side),
Transparent (a PNG sequence at the canvas size) and Best quality (4K, Max; 1080p
where 4K exceeds the export limits). A preset is an ordinary edit of the export
request, so every setting it chose shows in the rows below and stays editable;
the tile shows chosen until one of those settings (type, size, quality or
bitrate mode, or an MP4 codec other than H.264) changes. Video presets use MP4
with H.264 and automatic bitrate. YouTube, Shorts, TikTok and Best quality fall
back to WebM where MP4 is unavailable (the browser); Instagram and X take only
MP4, so there they keep MP4 and Export is disabled with its reason. A preset
chosen while the encoders are being checked is re-applied if its first type
proves unavailable. Presets are not remembered; the choices they made are,
like any other.

Presets never change the picture's shape. Export scales the canvas to the
output size, so a 9:16 size on a 16:9 canvas would stretch the animation; like
the size presets, platform presets scale the canvas's short side. The note
under the tiles (`#export-preset-note`) says what the export will be ("Ready
for TikTok: 1080 × 1920.") or, when the platform shows another shape full
screen, that the video will play with bars and that Canvas size in the scene's
properties changes it. A vertical preset also shows the preview in a 9:16
frame with black bars (`--surface-letterbox`), except at the compact and
minimal tiers, whose preview is a strip. Letterboxing the output itself (a
9:16 file with bars) would need the frame renderer, the tiled and supersampled
paths, SVG and the native encoders to place the picture and is not done.

Under Type and Quality a quiet line (`#export-type-hint`,
`#export-quality-hint`, their controls' `aria-describedby`) says what the
chosen type is for (`exportTypeHint()` in `src/export-request.mjs`) and what
the quality level trades.

Every export runs from one explicit export request (`src/export-request.mjs`):
the format and the choices that apply to it. `exportJob()` derives from it and
the editor's state everything the encoders receive: size, frame range,
quality, smoothing, dither, codec, bitrate or quality preset, sound, the
Windows codec options and the file name. The export dialog holds the request
and runs the chosen type's command, which exports it; a command run without the
dialog (the command palette) exports today's defaults (the artboard size, the
whole animation, 94% quality), never the remembered choices. The derivation keeps
the dialog's quirks, for example a hidden quality field never reaches a format
other than the JPEG sequence. `tests/export-request.test.mjs` compares it with
the dialog-field code it replaced (kept verbatim in
`tests/fixtures/export-legacy.mjs`) over about 47,000 combinations.

`src/export-progress.mjs` owns transient progress only, with no document or pixel
cache. Rendering notifications advance the rendered/remaining counters after
validated frame delivery. Encoder acknowledgments advance the bar. Source frame
numbers respect the selected range; GIF exposes two passes with the real frame
count in each. Elapsed time never manufactures progress. The estimate uses
completed work and elapsed time, appears after three acknowledged frames, and
does not estimate final encoding or file-system latency. The last 5% is reserved
for finalization and saving; the UI never reports 100% before saving succeeds.
The progress replaces the export dialog's settings in place (or opens a dialog
of its own for an export run without it). While it runs, Escape and × ask
"Stop exporting?" first: Keep exporting (focused, so a second Enter or Escape
goes on) or Stop exporting; the question leaves by itself if the export
finishes meanwhile. Cancel export stops at once. Cancellation, closing and failure dispose progress timers, the preview
worker and the codec controls. The existing save layer still stages and
atomically replaces files.

Software export surfaces, tiled supersampling, hard image allowances and editor
GPU-loss recovery are described in [export sampling](export-sampling.md). RAM
tiers are conservative allowances, not measurements of free memory. Driver/OS
termination, arbitrary document complexity and process-wide exhaustion cannot
be guaranteed away. These changes do not silently reduce output resolution.

## September 28, 2026: quick presets and type descriptions

The dialog grew to 960 × min(700, window − 32) so the presets fit above the
settings with Encoding still in view at rest. `node --test
tests/export-presets.test.mjs` (9 tests) checks that every preset keeps the
canvas shape and validates on landscape, portrait and square canvases, the
MP4/WebM fallback, the chat GIF and Best quality sizes, when a preset stays
chosen, the fit notes and every type's description.
`node tests/export-sheet.browser.mjs` adds a step for the presets from the
pointer and the arrow keys, the notes, the 9:16 preview, an MP4-only preset in
the browser, leaving a preset, and a real Chat GIF export whose header is
853 × 480; the other 14 steps and `node tests/export-experience.browser.mjs`
(18 checks, including the 1100×680 and 540×700 fits) pass unchanged. Light,
dark, 1100×680, compact (760×640) and minimal (420×700) screenshots were
inspected (`artifacts/export-redesign`). The desktop layout test
(`tests/export-panel-layout.desktop.mjs`) was not run.

## September 27, 2026: the export dialog

The same 33 exports ran through the redesigned dialog, one fresh page per case
so no remembered choice carried over (`artifacts/ui-redesign/tools/export-equivalence-sheet.mjs`,
recorded in `artifacts/ui-redesign/export-equivalence.json` under `sheet`).
32 of the 33 saved the same file (name, size and SHA-256) with the same options
reaching the workers and the encoder. The one difference is deliberate: a
palette export run after the dialog was closed without exporting now saves
today's defaults. The old dialog left its fields in the page when it closed, so
such a command used the closed dialog's size, range and settings.
`node tests/export-sheet.browser.mjs` checks what the dialog shows at rest,
Format and Type from the pointer and the keyboard, the Project list, Size and
Custom…, the trim strip and its fields, Quality, the preview, Encoding
remembered open, remembered choices and a palette export with today's
defaults.

## September 27, 2026: exports from an explicit request

Before and after `src/export-flow.mjs` moved to the export request, 33 exports
of one three-frame document ran in headless Chrome through the dialog and
through commands without it: WebM (default, a custom size and range, manual
bitrate, Smaller file, 720p), GIF (default, dither, a range with no
smoothing, Simple mode), APNG (Smooth sprites, unlocked size), PNG and SVG
frames, PNG, JPEG (50%), GIF and SVG sequences (including a PNG sequence
chosen after typing 50% for JPEG, and an SVG sequence after choosing no
smoothing), .piv, .stk and .stkz, and one command run after the dialog closed.
Every saved file had the same name, size and SHA-256, and the options that
reached the export workers and the WebCodecs encoder hashed the same (the
document exports, whose worker receives the live document, were compared by
their saved bytes). Desktop-only encoders (MP4, AVI, WMV and Windows AVI) are
covered by the unit comparison, not by this run.

## September 10, 2026 source verification

- `node tests/export-experience.browser.mjs`: 18 checks for presets, summaries,
  inline rejection, format visibility, balanced columns, 1100×680 and 540×700
  layouts, actual 4K APNG output, live counts, two-pass GIF and cancellation.
  Light, dark and compact screenshots were visually inspected.
- `node tests/export-4k.desktop.mjs`: actual sandboxed Electron renderer, worker,
  native IPC/FFmpeg and staged save. MP4 with Smooth sprites, WebM with Smooth
  edges, and MP4 with No smoothing each saved 3840×2160 files. Independent
  FFmpeg decoding produced every expected frame (12 per export), with changing
  image hashes. Recommended quality reached the native encoder without a fixed
  bitrate. The document/revision survived and the live GPU device stayed
  connected. Total measured export plus independent verification time was
  4.63, 3.64 and 3.56 seconds respectively. Electron launch required execution
  outside the tool's restrictive process sandbox.
- `node tests/export-sampling-app.browser.mjs`: the export buttons in the app, every sampling mode,
  cancellation and a lost export surface. The
  browser WebM decode/playback/error/cancellation suite also passed.
- Focused unit/native service checks passed for frame accounting, pending
  encoder windows, resource rejection, timeout cleanup, codecs, native output
  decoding, VFW, streaming limits and cancellation.

Artifacts are under `artifacts/export-experience`, `export-4k` and `export-sampling-app`.
The full root unit run reported **1,600 passed / 9 failed**. Failures are in
untouched animation target/key insertion, onion-skin sampling, property channel
authoring and native-document materialization tests; their import paths do not
include the changed renderer/UI/encoder modules. The complete output is
`artifacts/export-experience/root-unit-tests.log`. This task does not certify
the full dirty workspace or a packaged release.

Encoder options follow the [FFmpeg codec documentation](https://ffmpeg.org/ffmpeg-codecs.html)
and [WebCodecs queue/flush contract](https://www.w3.org/TR/webcodecs/).
