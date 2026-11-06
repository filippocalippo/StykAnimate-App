# D17: The drawing raster engine is its own crate, run by the drawing workers in its own module

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4 (proposed row).

## Context

The drawing workspace paints with a raster engine written in JavaScript (docs/DRAWING.md):
the brush model on the interface thread computes every dab's shape, and dedicated workers do
the pixel work: the stroke worker rasterizes dabs into tiles, the pixel worker fills,
captures and transforms selections, filters, resamples, encodes and decodes tiles and
prepares commits, a history worker encodes undo chunks for the disk tier. Tiles cross to
these workers as transferred `ArrayBuffer`s in bounded batches, and a worker is
**terminated** to cancel its job (Escape, a superseded operation, a timeout, a failure): the
next request starts a fresh one. The authoritative tile store, undo history, GPU residency
and the renderer's presenters stay on the interface thread in JavaScript objects.

The plan names `styk-drawing` as the owner of raster drawing. Two questions: which crate,
and how JavaScript reaches it.

## Decision

- `engine/crates/styk-drawing` holds the raster engine: sparse tiles with JavaScript `Map`
  order, the brush model and textures, the stroke raster and the stroke worker's engine,
  fill, selections and the magic wand, capture, the affine kernel, filters, reduced levels,
  the exact synchronous zlib and PNG of published tiles, the tile blob and encode cache,
  undo chunks, commit preparation and the clipboard's worker side. It is pure: no clock,
  thread, I/O or WebAssembly binding; it depends on `styk-math` (V8's `sin`, `cos`,
  `atan2`, `hypot`, D16) and `styk-doc` (settings arrive as JSON).
- `engine/crates/styk-drawing-wasm` binds it as a **separate, non-threaded WebAssembly
  module** (`src/engine/pkg/styk_drawing.js`, stable Rust, like the Pivot codec), which each
  drawing worker instantiates for itself. JavaScript reaches it only through
  `src/engine/engine-drawing.mjs`, whose facades keep the interfaces the workers already
  answer (`StrokeEngine`, the pixel worker's operations, `materializeDrawingTiles`, the
  history codec).

## Why not the engine's threaded module

- **Cancellation by termination.** A thread of the shared-memory engine module that is
  terminated while it holds the allocator or a spin lock (D7) blocks every other engine
  thread and the interface thread for good. The drawing workers must stay killable.
- **The memory model already fits.** Tiles are transferred to a worker in bounded batches;
  a per-worker linear memory holds exactly that working set and is released when the worker
  ends. Copying a 16 KiB tile into the module is a memcpy against milliseconds of raster work.
- **Pages without cross-origin isolation** draw as before: the module needs no shared memory
  and no atomics, so it builds on stable Rust.
- When the engine draws the workspace itself (the GPU brush and live strokes, S3 item 6), the
  engine links `styk-drawing` too: the code is shared, the memory is not.

## Evidence

The recorded fixtures hold 60 strokes (41,146 dabs in 498 worker batches:
every preset with pen pressure and tilt, over artwork and on blank cels, every blend mode, alpha lock, dense, soft and polygon
selections, smudge, custom pressure curves, both stabilizers, tapers, mirrors, scatter and
jitter, coordinates 6.4 million pixels out), fills, the magic wand, masks, filters, selection
capture, transforms, paste, levels and codecs through the JavaScript modules in Node;
`cargo test -p styk-drawing --test parity` replays them: every dab shape, every batch the
stroke worker returns, every undo record, tile, PNG, blob and chunk is byte-identical
(1,067 checks), and deliberately broken kernels fail them.

## Consequences

- A third WebAssembly module ships; each drawing worker instantiates its own.
- Linear memory never shrinks: a worker replaces an instance that grew past 256 MiB after a
  job (between strokes for the stroke worker), so an idle worker cannot keep the peak of its
  largest job, as JavaScript's collector would not.
- `x ** y` (custom pressure-size and opacity curves) is `styk_math::pow`, V8's own `pow`,
  natively and in WebAssembly (D16); the fixtures are recorded with Node pinned to it
  (`engine/tools/v8-pin.mjs`), so they replay on every platform. A browser's `**` is the
  platform's and can differ in the last digit.
- The JavaScript modules remain the oracle and the fallback until nothing calls them.
  The authoritative store (`TileStore` on the interface thread), its memory accounting, the
  renderer's presenters and the GPU brush (WGSL on the JavaScript renderer's device) stay
  JavaScript until the engine owns drawing display.
