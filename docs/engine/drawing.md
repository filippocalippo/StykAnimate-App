# Engine: the drawing raster engine

The raster engine of the Draw workspace (docs/DRAWING.md) in Rust: `engine/crates/styk-drawing`,
run by the drawing workers and the brush model through its own WebAssembly module
(`engine/crates/styk-drawing-wasm` → `src/engine/pkg/styk_drawing.js`), reached from
JavaScript only through `src/engine/engine-drawing.mjs` and `src/engine/engine-drawing-worker.mjs`
([D17](decisions/0017-drawing-raster-engine.md)). Stage S6 of the plan. The engine's stage draws
the workspace itself: strokes, fills and floating selections as they change ([Live cels](#live-cels)),
and the fill and the wand read the artwork it draws ([Sampling the artwork](#sampling-the-artwork)).
No JavaScript raster engine or renderer takes part.

## What runs where

| Thread | Engine |
| --- | --- |
| Interface (controller) | `RustBrushStroke` (`createBrushStroke`): input samples to dab shapes, tails, tail versions; `paintStroke`: the inspector's brush sample and the preset thumbnails, small strokes rasterized synchronously |
| Stroke worker | `Strokes` (`begin`/`dabs`/`end`/`cancel`, batches and undo records) |
| Pixel worker | `drawingEngineOperation`: fill, wand, filters, fill-mask, select, selection, paste, resample, decode-tiles, decode-legacy, encode-pngs, encode-tiles, copy-selection, thumbnail, prepare-tiles, preview |
| History worker | `encodeHistoryChunk`/`decodeHistoryChunk` (IndexedDB, hashing and compression stay platform services) |
| Interface (stage) | `Stage::live_cel_*`: the tiles of the cels being edited, in the engine's own atlas pages |
| Preview worker | `Previews::composite`: the artwork of a frame on the CPU, for the fill and the wand |

Each worker instantiates its own module (no threads, no shared memory, stable Rust), so a
worker is still terminated to cancel its job and its memory goes with it. Tiles enter the
module one copy each (`Tiles`, owned buffers) and leave one copy each (`Output`, copied into
fresh, transferable arrays); a commit's full replacement tiles return as the buffers they
arrived in. Every module object is freed after the call. Canvas work (preview bitmaps,
thumbnail scaling) and base64 stay in JavaScript.

Memory: a module's linear memory grows to its largest job's working set and never shrinks,
where JavaScript's garbage collector would release it. So after each job a pixel worker whose
instance holds more than `DRAWING_ENGINE_RETAINED_BYTES` (256 MiB, room for the 64 MiB
encoded-tile cache) replaces it with a fresh one (`releaseDrawingEngineMemory`); the encode
cache is refilled through the publication protocol's resend of missing tiles. The stroke
worker does the same between strokes, the history worker after every chunk. A preview worker
keeps its source cache (it is bounded by the viewport and accounted by its client). Jobs
themselves are bounded by the same working-memory budgets as before (`maxBytes`, the owner's
hard budget), checked by the same code.

Still JavaScript, and why: the authoritative `TileStore` on the interface thread, its memory
accounting (`drawing-tile-memory.mjs`) and history orchestration (`drawing-history.mjs`,
`drawing-preparation.mjs`'s `DrawingPreparation`), which hold the JavaScript buffers that
display, saving and the workers share; the presenters and reduced levels for the JavaScript
renderer (`drawing-raster.mjs`), which go with it; Pivot flattening for export
(`drawing-flatten.mjs`, the export path). The commits themselves are the engine session's
commands and history entries ([History](#history)); the buffers stay here.

## History

A stroke, an erase, a fill, a pasted or moved selection and a resample are ordinary entries of the engine session's
history (`styk-edit/src/drawing_pixels.rs`): labels, weights, grouping in batches, the 80-entry and byte limits, the
revision and the dirty state are the session's, as for every other edit. The session never takes pixels (a stroke is
megabytes, never JSON): its entry names the cel and the **record** of the interface's pixel history, which holds the
before and after tiles (`DrawingHistory`: memory, then IndexedDB for records of 64 KiB and more), and carries the
weight the interface measured. `src/engine/engine-owner-drawing.mjs` is the interface's half:

* **Commit** (`commitDrawingPixels`): the store checks its memory (`checkHistory`), the session records the entry, which
  names the record the history is about to make (for the first stroke on a blank exposure or on a v1 cel it writes the
  cel's definition and key into the layer sheet in the same entry; the call carries the cel's figure and object, not
  its pixels), then the tiles apply to the store, the history tracks the record, and the cel's definition (revision,
  bounds) is sent to the session (`@publishCel`), all before the call's events reach the interface. A commit the session
  refuses leaves no record; the pixels stay with the caller. A commit whose tiles the store cannot apply after the
  session recorded the entry is taken back (`@retractDrawing`: the entry, with the cel it created, leaves the history
  as the last entry; the redo branch its recording dropped stays dropped) and the record's identity is not used
  again, so no entry names a record the history never made. The session records the entry as the last step of the
  call for the same reason.
* **Grouped edits** (`movieclipBatch`): the commits of a group are entries of the group. When the group fails the
  interface first takes their tiles back, last commit first (`drawingBatch` names them), then the session aborts the
  group and reverts its document and history.
* **Undo and redo**: the session names the pixel commits of the entry on top (`drawingReplay`: cel and record, in the
  order it applies them). The interface pins and loads those records (a cold record comes from the disk), prepares large
  replacements in the pixel worker, checks nothing changed meanwhile (document, revision, cancellation), and only then
  runs the session's undo or redo and applies the tiles in the same synchronous step. A failed read, a cancelled replay
  or an intervening edit changes neither the pixels nor the history. A cel the undo removed (a creation undone) keeps
  its pixels in the store for the redo.
* **Weights**: a record whose tiles reach the disk weighs only its metadata; one whose write failed or whose tiles came
  back weighs its pixels again. Either change reaches the session (`@drawingBytes`), which holds the history to its
  byte limit; the entries it retires and the pose sources only they kept alive are collected in the session and in the
  interface's read view alike (the answer's document changes are adopted as a call's).
* **Retention**: when a call retires an entry that referred to drawings (the limit, a new edit after undos, an aborted
  group) the answer says `drawingRetired`, and the store lets go of the records and cels no entry refers to any more
  (`drawingRefs`: disk files, tiles, cel entries).
* **Resample**: the session makes the cel of the new resolution (its identity is a draw of the call, its anchors scale with
  the ratio) as one layer sheet entry; the interface installs the resampled tiles under it. The old cel keeps its pixels
  for the undo.

A document the session refuses to edit refuses a commit (`errors.engineOwner.notSupported`) as it refuses a new
drawing layer: the editor no longer records drawing entries of its own under the owner.

## Live cels

The engine draws a drawing cel from its published tiles (`image_assets[0].styk_tiles`, decoded on
its workers), which are encoded some time after the pixels change. While the workspace paints,
the tile store of the interface thread holds the pixels first, so the interface hands the engine the
tiles that changed and the stage draws those instead (`engine/engine-live-cels.mjs`,
`styk_eval::live`):

* A cel is held live when its pixels are not published yet, or when it is the one the workspace
  watches (`DrawingResources.watch`: the cel under the playhead of the active drawing layer, so
  its first stroke finds it ready). A published cel that is no longer watched stays held until
  room is needed (four of them), then the least recently used goes.
* The interface sends tiles per frame, at most 96 a call and 6 ms of calls a frame; each
  `TileStore` keeps a bounded log of the keys that changed (`changes('engine-live')`), and a
  store replaced or a log overflowed is compared tile by tile against what was sent. The cel is
  drawn from its live tiles once its first registration is complete, so a half-sent cel never
  shows. The tiles are raw straight-alpha RGBA, 16 KiB each; the engine reduces them to levels 1
  to 8 as the published path does (`down_tile`, with the same filter on empty tiles), builds each
  drawn tile's slot with its border texels (`bordered`) and writes only the slots a change reaches:
  the tile, the tiles around it and the parents that cover it, at every level.
* The slots are pages of the sprite atlas after the document's own (`PAGE_SLOTS` = 3,600 slots a
  page, at most four pages). A texture of more layers is allocated by copying the old one on the
  GPU (`Renderer::grow_sprites`): the document's pictures are not decoded again. A document that
  gains an atlas page (a publication) allocates the atlas anew as it always did and writes the
  live slots again from the engine's copy of their tiles. When the slots are used up the engine
  drops the cel and the interface lets go of published ones before trying again.
* A live cel draws what the published cel of the same pixels draws: the same quads, levels,
  parent records and tile order (`styk-eval/tests/drawing.rs`, `live/tests.rs`: every slot
  equals the published decode's, built in pieces, with removals). Only the atlas places differ.
  A frame draws it in the figure's place among the layers, onion skins included. The effect
  bounds of a drawing still follow its published ink bounds.
* A floating selection is a second set of tiles on the same cel (`float`) drawn through the
  selection's transform right after the cel, which holds the pixels the selection left
  (`selection.remainder`). Dragging, scaling or rotating sends six numbers (`live_cel_matrix`),
  never tiles. The preview samples bilinearly whatever the commit's filter is; the committed
  pixels are the worker's.
* A first stroke on a blank exposure draws a cel the document does not hold yet. The frame is
  drawn from a draft of the editor's report with the cel added (`documentReport` of the render
  request): the stage hands the engine the figures and layer assignments the draft adds
  (`EngineHandle.set_draft`) and the engine draws its document with them until the next publication
  of the document, or the first frame without a draft (`clear_draft`). The stored tree, the typed views
  and what the session and the planners read never include a draft (`Engine::publish_draft`).
* Wet ink (`drawing-wet-ink.mjs`) retires on `entry.presentedStamp`, which the stage sets to the
  stamp of the pixels the frame it drew carried (`LiveCels.presented`).

`Stage::live_cel_tiles`, `_show`, `_matrix`, `_clear_float`, `_drop`, `_reset` and `_stats` are the
whole interface; the engine never reads the interface's tile store. Playback, thumbnails, exports and
the camera monitor draw published tiles, as before (`drawingBarrier` publishes first).

## Sampling the artwork

A fill or a wand set to sample all layers reads the artwork of the frame, not the cel alone, in
the cel's pixels. `engine/engine-composite.mjs` brings the engine's document to the editor's
revision (`engineDocument`, after `drawingBarrier` published every drawing) and asks the preview
worker for a `width × height` rectangle through the matrix from the scene to the cel's pixels:
`Previews::composite` draws `ExportFrames::composite(tick)` (the frame's figures on transparency,
without the layers the document hides, the background, effects, parallax or the scene camera)
with the CPU rasterizer, in tiles of at most 1,024 pixels so the working set stays bounded, and hands
the straight RGBA over. Regions up to 64 megapixels, as before; the same budget checks guard the
reservation. Edges are the rasterizer's four samples, not Canvas 2D's coverage, so a zero-tolerance
fill can differ by a pixel along an edge.

## Exactness

The port follows the JavaScript engine it replaced operation for operation: `Math.round` and the
`Uint8ClampedArray` store conversion, single-precision coverage, grain and soft-falloff
tables where the JavaScript used `Float32Array`, `Map` insertion order for tiles, undo
records and plans, V8's `sin`, `cos`, `atan2`, `hypot` and `pow` (`styk-math`, D16) in the
brush model, textures and selections. Published tiles are byte-identical: `zlib.rs` writes
the same deflate stream as `zlib-sync.mjs`, `png.rs` the same PNG. `x ** y` for custom
pressure-size and opacity curves is V8's own `pow`, and the fixtures were recorded with Node
pinned to it (`engine/tools/v8-pin.mjs`): Node 24's default is the platform's, which gave
different dab shapes on Windows (MSVC) and Linux (glibc) in the one fixture with such
curves (size curve 1.7, opacity curve 0.6). A browser's `**` is the platform's, so a dab
there can differ in its last digits; the exponents 1, 2 and 0.5 are `x`, `x * x` and a
square root in every engine.

## Parity

The fixtures under `engine/crates/styk-drawing/tests/fixtures` were recorded from the JavaScript
engine in Node (inputs and SHA-256 prefixes of every output) and are frozen: the JavaScript is
deleted and the recording tool with it. `cargo test -p styk-drawing --test parity` replays them:

| Fixture file | Cases | What must match |
| --- | --- | --- |
| strokes | 60 strokes, 41,146 dabs, 498 worker batches | every dab shape; every batch's seeded tiles, dirty tiles and rectangle; undo records; the `sample()` path with its live tail |
| brush | settings, pen curves, jitter, dab shapes, atlas, stroke paths | values bit for bit |
| fills | 16 (tolerance, gap closing both ways, expansion, clips, sample-all, blank cels, budgets, refusals) | undo records, tiles or error key |
| masks | wand, dense fill, lasso masks, combine, invert, crop, edges, fill-mask | masks and tiles |
| filters | blur, HSL, brightness/contrast, invert, masked and not, refusals | undo records and tiles |
| selections | polygon, mask, whole-cel and over-budget capture | selected and remaining tiles with bounds |
| transforms | moves, rotations, mirror, extreme scales, removal, resampling, affine, singular and out-of-range | undo records, tiles, coverage, support bounds |
| levels | three cels, levels 1–5 | every reduced tile in order |
| codecs | tile PNGs, deflate, other encoders' PNGs, broken PNGs, blobs, the encode cache, undo chunks, preparation, clipboard, paste, stroke region | bytes and error keys |

`tests/drawing-engine.test.mjs` runs every pixel-worker request, the stroke worker's protocol,
the brush model and the undo codec through the facades in Node, checks the engine hands its
memory back, and that every error key the crate can raise is in the English catalogue.
`tests/drawing.test.mjs`, `drawing-selection.test.mjs`, `drawing-preparation.test.mjs` and the
other drawing tests run the controller, the resources and the history against the engine's
operations in Node. `cargo test -p styk-edit drawing_pixels` and
`tests/engine-owner-drawing.test.mjs` state the commits as session entries: the entry and its weight, the retirement of
records, strokes undone and redone exactly as on the plain editor (pixels, bounds, labels, events, dirty state), a created or
migrated cel with its first stroke, a resample, and a cold undo from the disk that fails, is cancelled or finds the history
changed. `scripts/smoke-drawing.mjs` (`npm run test:drawing:desktop`) paints in the
Electron app with two brushes, erases, fills sampling all layers, selects with the wand, moves
and applies the selection, undoes and redoes each step, paints, erases and undoes again on a turned and
mirrored view (comparing what the stage shows), saves, restarts and reopens the file, and checks that
the stage drew every step from live cels without refusing a frame. `STYK_SMOKE_SHOTS=<folder>` keeps a
screenshot of each step.

The live cels' slots are tested against the published decode of the same tiles
(`engine/crates/styk-eval/src/live/tests.rs`) and their quads against the published cel's
(`engine/crates/styk-eval/tests/drawing.rs`).

## Measurements

Measured on the shared development machine while the JavaScript engine still existed (load
average 7–18 during the runs; engines interleaved in the same runs; numbers are medians unless
ranges are given). They are evidence for these runs, not for other machines, and the scripts that
produced them went with the JavaScript engine.

Node, worker requests through both facades, 7 rounds, JavaScript → Rust: enclosed fill 145 →
38.7 ms, whole-stage fill 422 → 138, magic wand 490 → 150, blur 995 → 407, hue/saturation
225 → 150, selection capture 11.9 → 7.9, rotated transform commit 53.8 → 44.1, resampling to
half 92.0 → 81.8 and to double 526 → 366, publishing 1,069 tiles 1,098 → 429, decoding them
323 → 184 ms. Stroke worker totals per stroke 0.66–1.01× JavaScript's time and pen-up
0.23–0.39×. Slower in Rust: preparing 64 tiles 0.43 → 0.88 ms (the copy into the module) and
the brush model on the interface thread 2.6–8.4 → 3.2–9.9 µs per sample (calls across the
boundary); undo chunks encode in 0.27–0.38 ms (JavaScript 0.24–0.36) and decode in
0.20–0.22 ms (JavaScript 0.26–0.29).

Memory (each workload alone in a fresh process; peak resident growth): the module's linear
memory grows to the job's working set, 5–12 MiB for strokes, 40–68 MiB for fills and the wand,
171 MiB for a whole-stage blur, 34–45 MiB for transforms and publication, where JavaScript's
garbage-collected peaks were 0–22 MiB except blur (149 MiB) and publication (59 MiB). The
instance is replaced after a job once it holds more than 256 MiB.

Live drawing in a browser (`tests/drawing-latency.browser.mjs`, blank 1080p cel at 2×, Canvas 2D,
four interleaved rounds), input-to-visible p50 JavaScript/Rust: small 30.1/29.6, pencil
40.7/32.3, charcoal 30.1/29.5, soft 160 px 56.1/39.0, oil 26.4/32.9 ms; pen-up to commit
57.3/52.2, 65.7/52.6, 59.5/52.9, 79.3/79.4, 47.9/57.2 ms. Worker memory after a few strokes
and a fill (`measureUserAgentSpecificMemory`): pixel worker 32.9 MiB (JavaScript 21.5), stroke
worker 7.6 (3.6), history worker 6.7 (2.9).

Undo and redo on a dense 2,040-tile cel (large soft strokes whose undo records are on the disk
tier), 10 interleaved rounds, JavaScript → Rust: back to back, undo 222 → 199 ms, redo 306 →
200 ms; with publication settled first, undo 645 → 634 and redo 678 → 659 ms. Every undo or
redo starts a publication of its revision (the playback cache's barrier); it ran during the
next undo or redo, and its blob assembly in the pixel worker (150–180 ms) queued the replay's
tile preparation, so publication now pauses while a replay is prepared
(`DrawingHistory.replaying()`, docs/DRAWING.md). An undo or redo is mostly its 15 history chunk
reads (IndexedDB, decompression, checksum, decoding: 95–113 ms of history-worker time) and 7–9 ms
of tile preparation. Fill medians were 96–122 ms (JavaScript 111–151) and publication 359–394 ms
(369–674).
