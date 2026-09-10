# Movieclips in the layer timeline

A movieclip is a reusable figure containing a local animation. Insert it on the selected layer, alongside other figures or clips. It does not automatically create a layer. Its internal document has its own layers and frames; Edit movieclip opens that document, Done saves the shared definition, and Cancel restores the parent. Make unique gives an instance a separate definition.

Use Animation → New movieclip, Movieclip from selection, or Movieclip from frame range. Selection capture creates a reusable pose; range capture preserves the selected motion. Connected figures are included together. Replacement preserves surrounding figures and draw order. Interleaved selections that cannot be represented by a single container are rejected atomically.

The inspector provides Loop, Once/hold, Once/hide and Single frame, source frame, speed, start/end, transform and opacity. Playback follows the scene clock deterministically: scrubbing backwards and rendering an export produce the same local frame as playback. Extending an exposure extends the placement; copied or moved cells carry the clip clock with them. Simple Add preserves the copied clip's visible phase at the appended scene frame.

Restart here resets phase at the playhead without changing earlier frames. Split makes two placements with continuous playback. Break apart frame replaces the current output frame with editable figures; adjacent breaks reuse the same child identities. Bake animation expands a placement while preserving prior breaks. These changes are layer pose edits and are grouped for undo.

There are no per-figure clip bars or separate property timelines. Outer posing, clipboard operations, holds and tweens use the layer's frame cells. Several clips can share one row; use another layer when their frame editing needs to be independent.

Definitions live in the figure table as `_styk.movieclip`. Instances contain `_stykMovieclip` playback settings. `_movieclipSample` and runtime geometry are transient and excluded from pose capture. Imported clips may retain source documents to preserve cropped easing exactly. Geometry is shared by instances sampling the same immutable definition and time, with bounded local caches.

STYK saving retains the editable nested documents. Pivot export expands the evaluated scene in the worker; image, SVG and video exports use the same evaluator. Existing export limits remain: at most 100,000 Pivot output frames / two million objects, and 5,000 ticks / 250,000 objects for interactive Bake. Pivot cannot represent one opacity operation around overlapping child figures; unsupported expansion still reports that limitation.

Verification: `tests/layer-movieclips.test.mjs` covers conversion, nested edits, shared definitions, clocks, restart, movement, split, break, bake, undo and export. `tests/movieclip-commands.browser.mjs` exercises the actual inspector and mode switches. See [the layer timeline](layer-timeline.md) for cell controls and architecture.
