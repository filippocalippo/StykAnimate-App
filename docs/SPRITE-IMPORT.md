# Sprite image import

PNG, GIF and BMP sprite imports now apply Pivot's automatic transparency rule.
If a decoded image contains any transparency, that alpha is retained. Otherwise,
every pixel matching the bottom-left RGB color becomes transparent. The native
manual documents this behavior for sprite loading; backgrounds are a separate
image workflow. [Pivot sprite manual](https://pivotanimator.net/help5-2/sprites.htm),
[background manual](https://pivotanimator.net/help5-2/backgrounds.htm).

JPEG and WebP are additional supported formats and preserve their pixels by
default. All background imports preserve their pixels. The image's actual byte
signature determines the default, even when a filename or MIME label disagrees.
No additional import dialog is required.

The existing API remains compatible:

```js
await imageFileToFigure(file, {signal});
await imageFileToFigure(file, {preserveOpaqueBackground: true, signal});
await imageFileToBackground(file, {signal});
```

Explicit `preserveOpaqueBackground: true` retains opaque sprite backgrounds;
`false` requests the bottom-left rule, including for extra image formats. Existing
source alpha always wins. Results remain regular reusable figure/background
objects containing embedded PNG bytes and the original source name.

`media-image-worker.mjs` decodes the image, reads alpha, applies any color key and
compresses the normalized PNG outside the UI thread. The worker returns a Blob;
the caller asynchronously converts it to the existing data-URL asset format.
Native PNG/GIF/BMP headers are checked before allocating decoded surfaces, and
decoded dimensions are checked for every format. Defaults allow 16 Mi pixels,
64 MiB source/normalized PNG bytes and a 120-second timeout. An AbortSignal stops
the worker; successful and failed imports dispose it and its temporary surfaces.
Animated image inputs become a single still sprite rather than animation frames.

Verification:

- Five media unit tests cover factories, undo/redo/serialization, source signatures,
  explicit options, color-key matching and alpha precedence.
- [30 browser checks](../artifacts/media-worker/report.json) decode actual PNG,
  BMP, GIF, JPEG and WebP files; verify transparency, source-alpha precedence,
  background preservation, mislabeled signatures, dimension rejection, cancellation
  and retry. Neither main-thread Canvas nor OffscreenCanvas pixel reads occur
  during imports.
- Actual New and Open interrupt a deliberately deferred image worker through both
  application file-input routes. The worker is terminated before decoding starts,
  its delayed message is cleared, and no image reaches the replacement document.
  Selecting the same image immediately afterward succeeds.
- The actual app file input imports PNG/BMP/GIF without extra prompts. Actual
  PIV/STK Export and the supplied native decoder preserve the normalized PNG bytes
  exactly. The [resulting scene](../artifacts/media-worker/imported-sprites.png)
  was visually inspected.

These checks cover the specified import behavior and byte preservation. They do
not establish every original-Pivot sprite deformation, reflection or sampling
combination.
