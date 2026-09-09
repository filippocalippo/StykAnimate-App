# Image and vector exports

`src/image-export.mjs` exports:

```js
const blob = await exportAnimation({
  format: 'apng', // 'gif', 'png-sequence', or 'jpeg-sequence'
  width, height, fps, totalFrames,
  renderFrame: async index => canvas,
  onProgress: ({completed, total, progress}) => {},
  signal: abortController.signal,
  loop: true,
  quality: 0.94, // JPEG only
});
```

The renderer supplies a complete output-size frame. A transferable ImageBitmap
snapshots it and moves to a dedicated worker. One frame is in flight at a time;
the next render starts only after the previous frame is encoded. Quantization,
LZW compression, browser PNG/JPEG compression, CRC checksums, and container
writing run in the worker. Terminating the worker cancels expensive operations.
No network, backend endpoint, Python imaging library, npm codec, or ffmpeg is
required by production exports.

GIF uses local palettes: up to 255 opaque colors are preserved exactly, with
one transparent palette entry. Richer frames use weighted median-cut color
quantization and cached RGB555 lookup. Alpha below 128 becomes transparent;
partial opaque edges are composited against white because GIF has only binary
transparency. Its frame delays use cumulative centisecond rounding, avoiding
accumulating a rounded delay on every frame. GIF export accepts 1–50 fps to avoid
the minimum-delay clamping commonly imposed by image players. APNG and video
support higher rates.

APNG is lossless and preserves full alpha. Each frame replaces the whole canvas;
source blending prevents transparent pixels from showing stale preceding frames.
Frame delays use rational numerators and denominators. For example, 24 fps is
encoded as exactly 1/24 second. Chromium's ImageDecoder reports that duration
truncated to 41 milliseconds; Pillow independently reads 41.666666 milliseconds.
The file retains the rational timing.

PNG/JPEG sequence ZIPs contain `frame-000001.png` or `.jpg` onward, plus
`animation.json` recording dimensions, FPS, count, duration, and filename pattern.
PNG preserves alpha; JPEG uses a white matte. ZIP stores the already-compressed
image files with CRC32 and a complete central directory.

Exports are bounded to 512 MiB encoded output, 16 million pixels per frame,
and dimensions no greater than 16,384 pixels. ZIP supports 65,534 image frames
plus its manifest; GIF/APNG support 100,000 frames. Requests outside these limits
fail explicitly rather than truncate. `maxBytes` can lower the size limit.

`src/svg-export.mjs` independently exports `exportSVG({report,frame,geometry,
width,height,resources,cameraEnabled:true})`. It writes actual vector strokes,
circles, curves, polygons, gradients, and glyph outlines; sprite and background
pixels are embedded image resources. It preserves camera and layer transforms
and grouped opacity. The function's API comments document additional defaults.

Validation:

```text
node tests/image-export-browser.mjs
node tests/svg-export.browser.mjs
python tests/verify-image-artifacts.py  # requires Pillow for independent QA only
```

The browser tests decode every GIF/APNG frame, validate colors/transparency and
timing, decompress the PNG/JPEG sequence entries, verify ZIP checksums, and test
cancellation, output bounds, and renderer failures. A rich-color GIF exercises
LZW code-width changes and dictionary reset. Pillow and Python's ZIP reader
independently verify the resulting artifacts. Reports and usable exports are
saved in `artifacts/image-export-*` and `artifacts/vector-export.*`.

Format sources: [PNG/APNG specification](https://www.w3.org/TR/png-3/),
[GIF89a specification](https://www.w3.org/Graphics/GIF/spec-gif89a.txt), and
[PKWARE ZIP application note](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
The Graphics Interchange Format is the copyright property of CompuServe
Incorporated; GIF is a service mark of CompuServe Incorporated.
