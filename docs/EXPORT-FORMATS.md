# Export formats and encoder capabilities

`getExportCapabilities({width,height,fps,desktop})` returns format descriptions with
`supported`, an explicit unavailable `reason`, the real `extension`/`mimeType`,
and codec/quality fields where applicable. Query again when dimensions or frame
rate change. Browser video uses the available WebCodecs VP8/VP9 encoder; native
formats depend on the desktop's probed, bundled FFmpeg executable.

| ID | Output | Encoder and controls |
| --- | --- | --- |
| `webm` | Video-only WebM | Desktop VP9 with transparency, quality and bitrate controls; portable WebCodecs VP8/VP9 fallback is opaque. |
| `mp4` | Video-only MP4 | Native H.264 or Pivot-compatible MPEG-4 Part 2; quality or bitrate control. |
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
bitrate,signal,onProgress,desktop})` returns an encoded Blob. A worker preserves
RGBA for WebM, or composites the other native formats over black, then compresses
each frame as PNG. The desktop receives a declared
frame followed by acknowledged chunks of at most 256 KiB. There is no lossy
intermediate video. The service validates PNG structure and dimensions, accepts
only fixed encoder/container choices, and owns temporary output paths. It accepts
no renderer-selected executable, output path or command-line options. Cancel and
failed rendering dispose the encoder and temporary output. Completed output is
read back in bounded chunks before the ordinary save dialog.

Raster images/native video are limited to 16 million pixels per frame; dimensions
are limited to 16,384 pixels. ZIP sequences allow up to 65,534 frames, reserving one
entry for timing metadata. Portable image/WebM encoders have a 512 MiB output
bound; native video uses 256 MiB to match the desktop file transfer limit. Frame
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

After integration of the shared `ExportFrameRenderer`,
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
