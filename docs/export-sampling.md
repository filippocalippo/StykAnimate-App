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
import {ExportFrameRenderer} from './src/export-frame-renderer.mjs';
const frames = new ExportFrameRenderer({
  width: 600, height: 340,
  smoothing: 'edges', // 'none' or 'sprites'
  baseURL: location.origin,
  signal: controller.signal,
  getRevision: () => editor.revision,
});
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

The report and current-pose overrides cross to a dedicated worker in bounded
64 KiB chunks with acknowledgement, a 2 ms snapshot budget and no whole-document
JSON pass. The worker evaluates absolute timeline ticks, user-layer visibility,
Scene and Camera channels, embedded media and native geometry. Smooth edges and
Smooth sprites produce transferable image bitmaps; the UI copies each bitmap
onto one reusable output canvas. No smoothing builds self-contained outlined SVG and rasterizes it with the bundled
Rust/WASM resvg engine in the same worker. Chromium's SVG-image rendering hints
did not disable antialiasing in the actual pixel probe, so they are not used as
a substitute. For bitmap quads, clamped edge texels extend beyond the original bounds and
a crisp geometric clip removes boundary coverage antialiasing without filtering
interior texels or thresholding source alpha. The
[native Direct2D audit](../artifacts/native-static/bitmap-smoothing.md) verifies
this separation of aliased geometry and nearest texel sampling. The worker
converts the rasterizer's premultiplied RGBA once for
Canvas ImageData. It never thresholds completed scene alpha, which would destroy
intentional opacity. The unmodified, pinned dependency and source/license links
are in [vendor/resvg](../vendor/resvg/NOTICE.md).

Only one frame request is active. Encoders already await this callback, so they
provide backpressure. A changed document revision or cancellation stops the
session; disposing releases the worker, image resources and output surface.
The output canvas is reused and must be consumed before requesting the next
frame. SVG methods return independent Blobs. A worker's embedded resource cache
uses the existing decoded-image budget of 128 MiB. Ordinary output dimensions
remain limited to 16,384 pixels per side and 16 million pixels total; Smooth
sprites additionally limits each output side to 8,192 so its intermediate
surface fits within 16,384 pixels. No smoothing additionally bounds its temporary
padded bitmap to 128 MiB and 16,384 pixels per side; an extreme minification
that exceeds this buffer reports an error before encoding. A very dense frame can still take appreciable worker time; this is not a zero-latency guarantee.

The constructor's optional `token` is forwarded only to resource requests on
`baseURL`'s origin. `stats` reports document transfer bounds, worker frame time
and intermediate dimensions. Worker time does not include image presentation,
encoder work, filesystem writes, GPU completion or display timing.

## Verification

```powershell
node --test tests/export-sampling.test.mjs
python tests/export-sampling-native-static.py
node tests/export-sampling.browser.mjs
node tests/export-sampling-app.browser.mjs
python tests/export-sampling-decode.py
python tests/export-sampling-app-decode.py
```

The browser harness starts a fresh source backend and uses the real worker and
image encoders, with no application WebGPU renderer active. It compares direct
native-geometry rendering, opaque and translucent paths, outlined glyphs,
rotated checkerboard sprites, independent 2× box-filter expectations, revision
cancellation, unsaved-pose overrides and all portable image/sequence formats.
The decoder harness independently opens the resulting files with Pillow.

Verified results: [137 actual worker/encoder checks](../artifacts/export-sampling/report.json),
[38 independent file-decode checks](../artifacts/export-sampling/decoded.json),
six native static checks and two sampling-bound tests. The maximum observed
premultiplied-channel difference from an independently computed 2× box average
was 1.083/255. Hard line, circle, polygon, curve, outline, glyph and square-line pixels had
only alpha 0/255; the translucent line retained 0/127, gradients retained their
alpha ramps, and object opacity was applied once across overlapping segments.
All six portable image/sequence formats were encoded at all three settings;
actual GIF/APNG and ZIP files were independently decoded. Screenshots of hard
and smooth lines, outlined glyphs and nearest/supersampled rotated sprites were
visually inspected. These focused 128×96 cases validate behavior, not large-scene
throughput or native pixel identity across the complete corpus.

A separate 1,000-figure, 512×384 snapshot exercised each mode. All three produced
zero main-thread long tasks; the largest snapshot slice was 0.3 ms and largest
message was 65,228 bytes. Worker rendering was 17.8 ms for Smooth edges, 14.7 ms
for Smooth sprites and 111.9 ms for the first No smoothing frame including lazy
WASM initialization. These are focused export checks, not playback benchmarks.

The [23 actual app assertions](../artifacts/export-sampling-app/report.json)
exercise the PNG, APNG, SVG and PNG-sequence buttons with each relevant setting.
PNG pixels match the independent worker fixture exactly. Current-frame export
includes the unsaved Simple working pose; animation export uses the stored
poses and preserves the dirty working pose. Progress and Cancel appear before
worker loading, and cancellation produces no download. No uncaught UI or CSP
errors were recorded. The [export controls screenshot](../artifacts/export-sampling-app/smoothing-controls.png)
was visually inspected. [Ten independent download checks](../artifacts/export-sampling-app/decoded.json)
confirm APNG frame movement, the working-pose/stored-animation distinction,
numbered stored PNG poses and the downloaded sprite coverage. These checks do
not establish native pixel-edge tie-breaking or GDI+ fallback pixel identity.
Hard bitmap boundaries and continuous-alpha samples are covered by the worker
proof.

The aliased rotated opaque sprite has only alpha 0/255 and no blended interior
texels. Source alpha 0/64/128/255 remains exactly those four values; applying
half opacity yields 0/32/64/127. A minified sprite retains those same source
levels. All three cases match an independent inverse-transform nearest-sample
oracle away from pixel-edge ties, with zero mismatches across over 12,000
samples per case. Existing vector export regression scenarios retain a maximum
channel difference of 1/255 for camera and bitmap/gradient backgrounds.
