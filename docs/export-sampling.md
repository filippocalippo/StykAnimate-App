# Export sampling

Pixel exports share three native Pivot choices. **Smooth edges** is the default:
vector edges have coverage antialiasing and sprites use nearest-neighbor sampling.
**No smoothing** uses hard shape edges while retaining figure, segment, gradient
and background opacity. **Smooth sprites** renders at twice the requested width
and height, then averages each 2×2 premultiplied block into the requested output
size. It affects the rendered pixels before GIF palette conversion, image
compression or video encoding. Transparent GIF and JPEG/video matte behavior
still belongs to the selected encoder.

The [official image export guide](https://pivotanimator.net/help5-2/separate_images.htm)
and [video export guide](https://pivotanimator.net/help5-2/video.htm) describe these
three choices. Read-only inspection of the supplied executable independently
confirms factor two, its specialized four-pixel average, the default choice,
and the disabled smoothing control for SVG. See
[the static evidence](../artifacts/native-static/export-sampling.json) and its
[reproducible audit](../tests/export-sampling-native-static.py).

SVG exports retain editable vector geometry, portable outlined text and embedded
sprite pixels. Pixel sampling choices do not apply to SVG; the native SVG
workflow also disables this control.

## Rendering API

```js
import {createExportFrameRenderer} from './src/engine/engine-export.mjs';
const frames = createExportFrameRenderer({
  width: 600, height: 340,
  smoothing: 'edges', // 'none' or 'sprites'
  signal: controller.signal,
  getRevision: () => editor.revision,
}, {stage, playback, revision: editor.revision, range: [startTick, endTick]}); // vector: true for SVG
try {
  await frames.load(report);
  // Existing image/video encoders await this callback before requesting another.
  const renderFrame = index => frames.renderTick(startTick + index);
  const renderSVGFrame = index => frames.renderSVGTick(startTick + index);
  // For an unsaved current pose, use frames.renderFrame(currentFrame).
} finally {
  frames.dispose();
}
```

The app creates its renderer through `createExportFrameRenderer(options, {stage, playback,
revision, range, vector})` (`src/engine/engine-export.mjs`), which returns `EngineExportFrames`: a
worker that joins the engine and draws the frames the stage would show with its own GPU device, or
with the engine's CPU rasterizer where it gets none ([engine rendering: exports](engine/rendering.md#exports)).
It fails where the engine has no worker threads (a page that is not cross-origin isolated) or does not
draw the document. The three sampling choices keep their meaning: Smooth edges antialiases shapes and
samples sprites to the nearest texel; No smoothing draws every shape fully in or out (on every
frame, including those with effects, generated effects or 3D); Smooth sprites draws twice as large
and averages each 2×2 block in premultiplied colour.

Only one frame request is active. Encoders already await this callback, so they
provide backpressure. A changed document revision or cancellation stops the
session; disposing releases the worker and output surface.
The optional `onFrame({stage, tick})` callback reports `rendering` before a
request and `rendered` only after a complete frame has been validated. It does
not count encoder completion or saving. The application releases the renderer
as soon as the last source frame is acknowledged, before final container
assembly and saving; single-image exports release it after image encoding.
The output canvas is reused and must be consumed before requesting the next
frame. SVG methods return independent Blobs. Ordinary output dimensions
remain limited to 16,384 pixels per side and 67 million pixels total (16.7
million in Safari, matching its canvas surface limit); Smooth
sprites additionally limits each output side to 8,192 so its intermediate
sampling coordinates stay within 16,384 pixels.

Native FFmpeg video uses `renderNativeTick(tick, {preserveAlpha})` instead of
presenting a bitmap on the UI thread. The worker applies the black matte
in place when alpha is not supported and returns `{blob, width, height}` with a
lossless PNG. `encodeNativeVideo({renderNativeFrame})` validates the result and
streams acknowledged 256 KiB chunks without allocating its legacy PNG worker.
The presentation canvas stays 1×1 until a canvas consumer requests a frame.
Timeout, revision checks, cancellation and final-frame disposal are unchanged;
the conservative pixel allowance has not been increased.

## Export failure containment

The engine's export renderer bounds its GPU memory by drawing frames in tiles of at most
2,048 rendered pixels a side and reading them back through at most 64 MiB of buffers; a GPU
out-of-memory error or a lost device climbs the same ladder below (smaller tiles, then one new
worker with a new device, then failure), and cancellation asks its worker to free its engine
memory and device before it ends ([engine rendering: exports](engine/rendering.md#exports)).
`exportMemoryPlan` validates a request against a working allowance: six frame-sized pixel buffers (ten for the additional
crisp readback work), scratch surfaces, and decoded images. Its allowance is
64 MiB–2 GiB based on the device RAM hint (real system memory on desktop, the
browser's bucketed RAM tier on the web), or 256 MiB when unavailable. Tests can
pass `maxWorkingBytes` to exercise smaller allowances. Legal output dimensions
are never refused for budget reasons: the plan floors at what the frame needs
and reduces the render tile size instead. PNG dimensions are checked before pixel decoding;
other images use available asset metadata and a post-decode check that closes an
oversized bitmap. Images keep their original resolution; they are not silently
downsampled for export. These allowances do not measure free RAM or include the
document, compressed sources, encoder internals, and other applications.

The app permits one raster export at a time and releases speculative playback
pixels before starting. Worker requests time out after two minutes. Recoverable
frame failures first retry the same frame at progressively smaller raster tiles,
then rebuild the worker and canvas once at the smallest tile before the export
fails; a successful tile size is reused for later frames. Cancellation,
exhausted retries, invalid frame dimensions and unrecoverable 2D surface loss
stop the export and release its worker/output pixels. An invalid frame is never knowingly submitted
as a successful frame. Native video jobs are cancelled when their frame worker
fails or stalls. Browser WebM encoding requests a software encoder. Its pending
input window targets 32 MiB of RGBA source pixels, at least one and at most four
frames (one at 4K; a single larger frame may exceed 32 MiB). The window includes
submitted frames awaiting encoded output, since
`encodeQueueSize` alone excludes internally retained frames. Flushing each full
window preserves quality mode and avoids waiting indefinitely for codec
lookahead to fill. Existing output-frame validation rejects dropped frames.
FFmpeg uses one filter thread and two encoding threads; H.264 uses the `fast`
preset with `zerolatency` tuning at every resolution to remove its lookahead
and B-frame queues. Quality targets and manual bitrate controls are unchanged.
Native output chunks become Blob parts rather
than retaining the complete file as JavaScript ArrayBuffers.

See [export experience and verification](export-experience.md) for the panel,
progress semantics, measured 4K throughput and desktop export evidence.

If the editor's graphics device is lost, its GPU resources are destroyed and the
scene canvas is replaced, with a stage on a new device, automatically. The
document, playhead, undo history and active export remain available. Recovery
makes two attempts and leaves Save and a manual Retry available if the new
device cannot start. Driver resets, total process memory exhaustion and
browser/OS termination remain outside this guarantee.

Regression commands:

```powershell
node --test tests/engine-export.test.mjs tests/export-robustness.test.mjs tests/native-video-export.test.mjs tests/vfw-video.test.mjs
```

`stats` reports the frame time and the engine's counts of the last tile. Worker time does not include
image presentation, encoder work, filesystem writes or display timing.

## Verification

```powershell
node --test tests/export-sampling.test.mjs
python tests/export-sampling-native-static.py
cargo test --manifest-path engine/Cargo.toml -p styk-export
node tests/export-sampling-app.browser.mjs
python tests/export-sampling-app-decode.py
```

The engine's sampling is checked pixel by pixel in `engine/crates/styk-export/tests` (tiles against the
whole frame, crisp edges without partly covered pixels, Smooth sprites as the 2×2 average of a frame drawn
twice as large, the black matte). The app harness drives the real buttons: the
PNG, APNG, SVG and PNG-sequence exports with each relevant setting. Current-frame export
includes the unsaved Simple working pose; animation export uses the stored
poses and preserves the dirty working pose. Progress and Cancel appear before
the worker loads, and cancellation produces no download. The decoder harness independently opens the
resulting files with Pillow: APNG frame movement, the working-pose/stored-animation distinction,
numbered stored PNG poses and the downloaded sprite coverage. These checks do not establish native
pixel-edge tie-breaking or GDI+ fallback pixel identity.
