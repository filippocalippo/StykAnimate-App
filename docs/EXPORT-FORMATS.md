# Export formats and encoder capabilities

`getExportCapabilities({width,height,fps,desktop})` returns format descriptions with
`supported`, an explicit unavailable `reason`, the real `extension`/`mimeType`,
and codec/quality fields where applicable. Query again when dimensions or frame
rate change. Browser video uses the available WebCodecs VP8/VP9 encoder for WebM and
H.264 for MP4; native formats depend on the desktop's probed, bundled FFmpeg executable.

Video Quality defaults to **Great** (Recommended), with **Draft** (Smaller file)
and **Max** (Higher quality) alternatives. Bitrate and MP4/AVI codec controls are
in the export dialog's **Encoding** section, closed until opened (it remembers
being open). Automatic mode uses native quality targets:
H.264 CRF, VP9 constant quality with `-b:v 0`, or MPEG-4/WMV quantizer quality.
Bitrate therefore follows scene complexity instead of a fixed source-size guess.
Browser WebCodecs uses a target calculated from final output dimensions, frame
rate and the selected preset. Changing resolution recalculates it. Manual mode
accepts 0.1–200 Mbit/s, preserves the entered value when dimensions change, and
hides the quality selector it overrides. Lossless AVI ignores bitrate/quality;
installed VFW codecs retain their own provider-specific controls.

`src/export-video-quality.mjs` is the common preset/planning layer. Recommended,
Smaller file and Higher quality map to existing encoder quality values 0.8, 0.55
and 0.95. For browser output, their target-rate multipliers are 1, 0.5 and 1.6
over `max(1e6, width * height * fps * 0.18)`, bounded to 0.1–80 Mbit/s. These are
encoding targets, not predictions or promises of exact file size or identical
perceptual quality across codecs. Rendering memory limits remain independent.

Automatic controls are checked by `tests/export-video-quality.test.mjs` and
`tests/export-auto-quality.browser.mjs` (10 actual UI checks, including 1080p/4K
encoder configurations and manual/automatic switching). The updated
`tests/export-bitrate.browser.mjs` independently decodes the manual-rate output.
`tests/export-4k.desktop.mjs` also checks that the real native IPC request carries
the Recommended quality target without an explicit bitrate before decoding the
saved 4K MP4/WebM files. Screenshots and requests are under
`artifacts/export-auto-quality`, `artifacts/export-bitrate`, and
`artifacts/export-4k`.

| ID | Output | Encoder and controls |
| --- | --- | --- |
| `webm` | Video-only WebM | Desktop VP9 with transparency, quality and bitrate controls; portable WebCodecs VP8/VP9 fallback is opaque, with Opus sound where the browser encodes it. |
| `mp4` | Video-only MP4 | Native H.264 or Pivot-compatible MPEG-4 Part 2; quality or bitrate control. Without a desktop encoder, the browser's WebCodecs H.264 (High, else Main, else Baseline profile at the lowest level that fits) in a local muxer; opaque, black matte, an odd width or height padded by one pixel, bitrate from the same target as browser WebM. Sound is AAC where the browser encodes it. |
| `avi` | Video-only AVI | Native MPEG-4 Part 2/Xvid tag, FFV1 lossless RGB, or uncompressed RGB. Quality/bitrate applies to MPEG-4. |
| `vfw` | Windows AVI | Genuine installed 32-bit/64-bit Windows compressors and codec-specific configuration, plus native uncompressed AVI. See [Windows codec integration](WINDOWS-CODECS.md). |
| `wmv` | Video-only ASF with `.wmv` extension | Native Windows Media Video 8; quality or bitrate control. |
| `gif` | Animated GIF | Portable adaptive palette, binary transparency, frame delay quantization; 1–50 fps. |
| `apng` | Animated PNG | Portable lossless color/alpha and rational frame delays. |
| `png-sequence` | Numbered PNGs in ZIP | Lossless color and alpha. |
| `jpeg-sequence` | Numbered JPEGs in ZIP | Adjustable JPEG quality; white matte. |
| `gif-sequence` | Numbered still GIFs in ZIP | Per-frame adaptive palette, optional Sierra Lite Dither and binary transparency. |
| `svg-sequence` | Numbered SVGs in ZIP | Editable vectors, embedded image assets and outlined text from the existing SVG exporter. |

These are actual containers and encoders, not aliases selected by extension.
Windows VFW choices come from installed 32-bit and 64-bit compressors that accept
the requested RGB24 frame size; each codec's own configuration dialog is
available when supported. Video is currently silent. Native MP4/MPEG-4/WMV
encoders add a one-pixel black edge on the right/bottom when requested dimensions
are odd; capabilities expose the encoded dimensions and a notice for the UI.
FFV1 and uncompressed RGB preserve exact input dimensions and RGB values,
including odd sizes. Desktop VP9 WebM preserves alpha and exact dimensions.
The remaining FFmpeg video formats and Windows VFW use a black matte, matching
Pivot's video behavior. Browser WebM capabilities explicitly report `alpha: false`.

`exportAnimation({...options,format:'gif-sequence'})` uses the existing canvas
`renderFrame(index)` callback. SVG sequences use `renderSVGFrame(index)` returning
SVG text or a Blob, normally from `exportSVG`. Both return a ZIP with
`frame-000001.ext` numbering and `animation.json` containing exact frame rate,
count and filename pattern. CRC calculation, ZIP assembly, GIF quantization and
image compression stay in a worker. One frame is processed at a time. Animated
GIF renders twice to collect one palette from all frames, then encode; numbered
GIF stills retain one pass. The Boolean `dither` option is independent of edge
smoothing. See [GIF color, bounds and native compatibility](gif-export.md).

`encodeNativeVideo({format,codec,width,height,fps,totalFrames,renderFrame,quality,
bitrate,signal,onProgress,desktop})` returns an encoded Blob. The app instead
supplies `renderNativeFrame`, which gets lossless PNGs directly from the scene
worker and avoids the canvas/bitmap round trip and second worker. The original
`renderFrame` canvas callback remains supported. Both paths preserve RGBA for
WebM or composite the other native formats over black. H.264 uses `fast` with
`zerolatency`, two encoding threads and unchanged CRF/bitrate controls.
The desktop receives a declared
frame followed by acknowledged chunks of at most 256 KiB. There is no lossy
intermediate video. The service validates PNG structure and dimensions, accepts
only fixed encoder/container choices, and owns temporary output paths. It accepts
no renderer-selected executable, output path or command-line options. Cancel and
failed rendering dispose the encoder and temporary output. Completed output
moves disk-to-disk into a native save dialog destination — staging beside the
destination so a failed copy never leaves a truncated file — or falls back to
bounded chunked readback on desktop builds without the save channel.

Raster images are limited to 67 million pixels per frame (16.7
million in Safari, matching its canvas surface limit); the native FFmpeg service
separately limits video to 16,777,216 pixels per frame. Dimensions are limited to
16,384 pixels. ZIP sequences allow up to 65,534 frames, reserving one
entry for timing metadata. When a streamed destination is available — the
desktop file transfer or the File System Access API — encoders write output as
it is produced, so the in-memory bound applies to chunks in flight and the
output limit is 16 GiB (just under 4 GiB for ZIP sequences, which store 32-bit
offsets); without a streamed destination the 512 MiB output bound still holds.
Native FFmpeg video uses 1 GiB and Windows VFW video 256 MiB, matching
their desktop transfer and native helper limits. Frame
progress is reported after each complete source frame. Animated GIF reports
`palette` and `encode` phases with `total = 2 * totalFrames`; native progress also
distinguishes final encoding and completed output transfer.

Verification: `tests/export-capabilities.test.mjs` and
`tests/native-video-export.test.mjs` pass ten capability/transport checks.
`tests/image-sequences.browser.mjs` passes 33 actual browser checks for numbering,
CRC, timing, vector preservation, independent GIF/SVG decoding, alpha, cancel and
subsequent export. The screenshot in
[`artifacts/image-sequences/preview.png`](../artifacts/image-sequences/preview.png)
was visually inspected. `tests/native-video.desktop.mjs` passes 28 named real
Electron checks plus independent codec/timestamp/pixel assertions: all six native
presets, five new export buttons, three codec-selector variants, native saves,
authored Scene changes, cancellation and subsequent exports. FFV1/rawvideo preserve
every RGB byte at 161 × 91. The six UI videos decode all 16 frames at 16 fps;
WMV timestamps have its container's millisecond quantization. Expanded/collapsed
export dialogs have no horizontal overflow and were visually inspected.
See [`artifacts/native-video-renderer/report.json`](../artifacts/native-video-renderer/report.json).
The direct native service suite separately passes 18 tests, including bounded
input/output, malformed PNG rejection and exact lossless RGB at tiny/odd sizes.

The later `tests/webm-alpha.desktop.mjs` adds six focused checks of the actual
desktop UI: the FFmpeg provider is selected, MP4/AVI choices remain usable after
an installed Cinepak configuration dialog, a typed 0.25 Mbit/s reaches the encoder
as 250,000 bits/s, and the ordinary Save flow creates a six-frame VP9 WebM.
Independent `libvpx-vp9` decoding preserves transparent background pixels and
the moving figure's alpha of 127. The export controls and decoded frame were
visually inspected; the dialog has no horizontal overflow. See
[`artifacts/webm-alpha-renderer/report.json`](../artifacts/webm-alpha-renderer/report.json).
Windows installed-codec service, UI, configuration, keyframe interval, decoding
and output-limit evidence is listed in [Windows codec integration](WINDOWS-CODECS.md).

After integration of the shared export renderer (now `EngineExportFrames`),
`tests/worker-video.desktop.mjs` passes nine additional actual desktop checks.
WebM and VFW cancellation stops both workers and native jobs without opening
Save; subsequent exports save and independently decode six frames in order.
The chosen No smoothing/Smooth sprites values reach the scene worker. VP9 at
100% quality retains exact alpha values 0 and 127; uncompressed VFW preserves the
supersampled edge levels and black matte. A codec lookup cannot enable Windows
AVI while `canExport()` is false, while Configure stays available. Dialog
close/reopen lifecycle and the final export layout are also checked. See
[`artifacts/worker-video-renderer/report.json`](../artifacts/worker-video-renderer/report.json).

The later [black-matte desktop regression](../artifacts/native-video-matte/report.json)
passes five checks across four real saved outputs. Independent decoding verifies
MP4 H.264, AVI FFV1 and WMV2 transparent corners and partial-opacity colors over
black; odd-dimension padding matches its black-edge notice. WebM still retains
alpha 0/127 and exact odd dimensions. Capabilities expose `matte: "black"` for
opaque native codecs and `matte: null` for alpha-preserving WebM. This follows
[Pivot's documented video transparency](https://pivotanimator.net/help5-2/video.htm).

GIF dithering adds [11 worker checks](../artifacts/gif-dithering/report.json),
[nine actual root checkbox/download checks](../artifacts/gif-dithering-app/report.json),
[32 independent GIF decode checks](../artifacts/gif-dithering/decoded.json) and
seven quantizer unit tests. Source-alpha policy, delays, Loop and GIF-sequence
behavior remain intact. The color-rich fixtures show reduced low-frequency
banding with Dither; the custom palette is not claimed pixel-identical to
Pivot's FFmpeg 4.4 or the desktop's FFmpeg 7.1. [GIF verification](gif-export.md)
records the measured image differences and reproducible commands.

The platform-specific encoder is staged in `build/video-encoder`, with license,
build and source provenance, and is included by the packaging configuration.
These source-app checks do not establish that a subsequently rebuilt Windows,
macOS or Linux release artifact was tested.

Primary format references: [FFmpeg formats](https://ffmpeg.org/ffmpeg-formats.html),
[FFmpeg encoders](https://ffmpeg.org/ffmpeg-codecs.html),
[WebCodecs](https://www.w3.org/TR/webcodecs/),
[GIF89a](https://www.w3.org/Graphics/GIF/spec-gif89a.txt).
