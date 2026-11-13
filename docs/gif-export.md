# GIF color and dithering

The export dialog's **Dither (GIF)** checkbox controls animated GIF and numbered
GIF frames. It defaults on when the document contains a sprite image asset or a
non-solid background, including an unused library asset. A segment gradient
alone does not enable it automatically. Edge smoothing remains a separate
control. This follows the supplied executable's asset predicate and the intent
of [Pivot's GIF options](https://pivotanimator.net/help5-2/animated_gif.htm).

Animated GIF uses one adaptive palette collected from every rendered frame.
The worker then encodes a second rendering pass using that palette. It reserves
one transparent entry and up to 255 opaque colors. Dither applies Sierra Lite
color-error diffusion; disabling it chooses the nearest palette color. Pixels
outside the changed source rectangle retain their previous palette indices,
which avoids noise changes in stationary areas. Numbered GIF sequences use one
independent palette and one rendering pass per still image.

The alpha cutoff stays at 128. Lower alpha becomes transparent; remaining
partial-alpha colors use the existing white matte. Dither changes RGB selection,
not this binary-alpha policy. Full frames, disposal, cumulative centisecond
rounding and Loop behavior remain intact. At 24 fps, the tested three-frame
animation has 40/40/50 ms delays; GIF timing cannot represent every source rate
exactly.

## API and bounds

```js
import {defaultGIFDither} from './src/gif-options.mjs';
import {exportAnimation} from './src/image-export.mjs';

const blob = await exportAnimation({
  format: 'gif', width, height, fps, totalFrames,
  dither: defaultGIFDither(report),
  // The engine's export frames as RGBA (src/engine/engine-export.mjs), or canvases through renderFrame.
  renderPixels: index => renderer.renderPixelsTick(index),
  signal,
  onProgress: ({phase, completed, total}) => {
    progress.max = total;
    progress.value = completed;
  },
});
```

`dither` must be Boolean. An animated GIF needs every frame twice: a first pass
builds the palette, a second maps and compresses. Progress reports
`phase: 'palette' | 'encode'` and a total of `2 * totalFrames`; other image
formats retain one pass. Root export pins the document revision and
working-pose revision and cancels when either changes. Cancel terminates the
worker (and its helpers) during either pass, including palette construction or
compression.

**Frames.** The app's exports give the encoder the engine's frames as RGBA pixels
(`renderPixels`): the export renderer's worker reads them from the canvas it put the
frame on and transfers them, through the interface thread, to the encoder's worker. A
canvas consumer (`renderFrame`) still works, its canvas snapshotted into a bitmap that
the worker draws and reads back. The pixels are the same either way: a canvas keeps
premultiplied colour, and the pixels have been through that store once in both. While
the worker encodes a frame, the next one is drawn.

**Two passes, one rendering.** When an animation's frames fit in
`gifRetainedBytes()` (256 MiB, or 1/32 of the device's memory where that is less),
the worker keeps the first pass's frames and encodes them in the second, releasing
each as it is written: every frame is rendered once. A longer or larger animation is
rendered twice, and the renderer must then give the same committed image in both
passes.

**Encoding on several threads.** The second pass is spread over helper workers
(`src/gif-frames.mjs`, `src/gif-encode-worker.mjs`): half the processor's threads
less one, at most four, for an animation of three frames or more and 256 × 256 pixels
or more; with fewer than two, the worker encodes alone. They start with the export, so
they have loaded by the second pass. Without dithering a pixel's index depends on the
pixel alone, so the index a pixel outside a frame's changed rectangle keeps from the
frame before is the one it would get anew: each helper maps and compresses whole
frames. With dithering a helper dithers the changed rectangle alone (the error never
leaves it), and the worker puts the frames together in order and compresses them. The
frames are written in order, so the file is the one the worker would write alone, byte
for byte. At most two frames a helper are in flight. These are JavaScript workers of the
encoder, not engine threads: the encoder is JavaScript, and the engine's threads run
engine jobs.

The palette collector keeps exact RGB counts until 65,536 distinct colors, then
folds them into a fixed 32,768-bin RGB555 histogram with weighted channel sums.
It weights all contributing frames. Median cut selects boxes by weighted RGB
variance, splits the widest channel and uses integer weighted means.
Nearest-color lookup uses an exact RGB search tree (the least distance, the lowest
index among equals) and a cache capped at 65,536 entries. Sierra Lite needs only two
RGB rows. Temporal mapping retains one previous RGBA frame and one index buffer.
Encoded output remains bounded at 512 MiB in memory, or 16 GiB when a streamed file
destination is available. Existing limits of 67 million pixels per frame (16.7 million
in Safari), 16,384 pixels per side and 1–50 fps for animated GIF apply.

**How it stays exact.** The encoder reads pixels as 32-bit words: a run of equal
pixels (most of a stick-figure frame) is one histogram update or one palette lookup,
and two frames compare a word at a time. The histogram is an insertion-ordered hash
(the order of first appearance decides palette order and median-cut ties); median cut
sorts each box stably by counting sort (an exact histogram's channels are whole
numbers; an RGB555 histogram's mean channels are ranked first) and sums each box in
the same order, so every mean is the same number. LZW keeps its dictionary in a small
hash table. `tests/fixtures/gif-reference.mjs` keeps the per-pixel encoder these
replaced, and `tests/gif-quantize.test.mjs` checks that today's writes the same bytes
for gradients, transparency, partial alpha, unchanged frames, more than 65,536 colours,
dithering on and off, still frames, and frames finished on helpers out of order.

## Native compatibility boundary

The [binary audit](../artifacts/native-static/gif-dithering.md) confirms that
Pivot's bundled FFmpeg 4.4 uses a full-animation palette, rectangle mapping and
Sierra Lite when Dither is checked. The algorithm references are the matching
[palettegen](https://ffmpeg.org/doxygen/4.4/vf__palettegen_8c_source.html) and
[paletteuse](https://ffmpeg.org/doxygen/4.4/vf__paletteuse_8c_source.html) sources.
The JavaScript implementation follows this workflow, but does not promise
identical palette entries, GIF bytes or native pixels. Its bounded histogram,
palette ordering and RGB tie-breaking can differ. It retains the application's
white matte and stops color error at transparent pixels; native paletteuse can
diffuse hidden RGB error through transparent entries.

The shipped desktop CLI is FFmpeg **7.1**, which also differs from Pivot's
**4.4** DLL. A [separate codec comparison](../artifacts/gif-dithering/ffmpeg-comparison.json)
uses identical RGBA inputs and explicit palette/dither options with that CLI.
Custom-versus-7.1 RGB mean absolute differences were 4.37/5.37 out of 255 for the
gradient and 3.09/4.01 for the sprite (off/on). Binary alpha matched exactly.
This comparison is not a native Pivot pixel oracle. Both render useful GIFs;
these two custom fixtures had slightly lower RGB error than the shipped CLI.
The [comparison sheet](../artifacts/gif-dithering/ffmpeg-comparison.png) was
visually inspected. No additional native GIF pipeline is used.

## Verification

```powershell
node --test tests/gif-quantize.test.mjs
node tests/gif-dithering.browser.mjs
node tests/gif-dithering-app.browser.mjs
python tests/gif-dithering-decode.py
python tests/gif-ffmpeg-compare.py
```

The Python checks require Pillow; the last command also uses the staged Windows
encoder at `build/video-encoder/ffmpeg.exe`. Browser checks start and stop a fresh
source backend. Results:

- Seven quantizer tests cover defaults, adaptive precision, deterministic
  diffusion, unchanged-source rectangles, histogram bounds and binary alpha.
- [Eleven actual worker checks](../artifacts/gif-dithering/report.json) cover
  both passes, frame order, GIF sequences and cancellation in either phase.
- [Nine actual root UI checks](../artifacts/gif-dithering-app/report.json) cover
  the default checkbox, both downloaded GIFs, different decoded output and the
  correct progress maximum/completion. The [dialog](../artifacts/gif-dithering-app/dialog.png)
  was visually inspected; no browser errors were recorded.
- [Thirty-two independent Pillow/container checks](../artifacts/gif-dithering/decoded.json)
  verify global palettes, decoded alpha, 255 grayscale levels, delays, Loop,
  stable stationary pixels and sequence naming/metadata. The
  [decoded image sheet](../artifacts/gif-dithering/contact-sheet.png) was visually
  inspected.

For the 256×128 gradient, Dither reduced RGB error after a two-pixel box blur
from 1.716 to 0.625 out of 255; for the sprite, from 1.245 to 0.778. This measures
low-frequency banding, not every aspect of perceived quality. Raw pixel error
increased from 3.010 to 3.570 and 2.347 to 2.918 respectively. Files grew from
8,489 to 17,928 bytes and 10,829 to 16,007 bytes. The grayscale ramp used 255
shades with mean absolute error 0.0039. These focused fixtures establish option
behavior and container correctness, not full-corpus pixel identity.
