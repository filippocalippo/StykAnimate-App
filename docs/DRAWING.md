# Drawing in StykAnimate

Draw is a workspace preset in the existing editor. It uses the studio tool rail,
Properties inspector, theme, exposure sheet, clipboard, history and exporters.
Entering Draw does not change the animation. The rail's + creates a drawing
layer; otherwise select an existing visible, unlocked drawing layer.

Switching to Build finishes pending drawing operations before starting the
figure session. Build keeps a selected editable figure, otherwise clears the
drawing selection and selects a visible, unlocked figure layer. If none exists,
it creates one; discarding the new Build session also removes that layer.
Drawing cels never become Build figures.

## Workflow

- **B / E:** Brush / Eraser. Ink, Brush pen, Pencil, Liner, Nib, Marker,
  Soft, Airbrush, Charcoal, Chalk, Dry brush, Sponge, Blender and Oil presets
  are starting points; each defines the whole tip, dynamics and blend.
  A live preview stroke in Properties reflects the current tip. Size,
  opacity, flow, hardness, pressure curves and smoothing remain editable with
  the same numeric fields and scrubbing used elsewhere. **Tip** sets the
  shape (Round, or the Chalk, Bristle and Sponge image tips), roundness,
  angle (fixed, following the stroke direction, or following pen tilt) and
  spacing. **Stroke** sets the start and end tapers and the smoothing mode:
  Average (a trailing average) or Pulled string (the tip moves only once the
  pointer pulls it past the string length, and the stroke ends at the tip).
  **Texture** chooses the grain (Noise, Paper, Canvas), its strength and
  scale; grain is anchored to the drawing, so overlapping strokes reveal the
  same paper, and it caps how much paint a pixel can hold, so pits stay light
  however often they are painted. **Dynamics** maps pressure to size, opacity
  and flow and adds size, opacity and angle jitter and scatter. **Pen
  pressure** is a global tablet curve (a Bézier with Soft, Linear and Firm
  presets) that applies to every brush and persists with the brush library.
  **Painting** chooses the blend mode (Normal, Behind,
  Multiply, Screen, Overlay, Color, Smudge) and **Lock alpha**, which recolours
  existing paint without covering empty pixels. Smudge carries the colour under the tip along the
  stroke (Smudge length) and can mix in the brush colour (Color mix); it
  composites each dab immediately, since every dab reads the previous result.
  The colour under the tip is averaged on a grid of at most 64×64 samples, so
  large smudge tips cost the same pickup as a 64-pixel one.
- **Quick bar and sliders:** the stage header shows the active
  tool's everyday settings (brush: preset, colours, size, opacity, flow,
  smoothing, mirror). Drawing settings use Krita-style slider fields shared by
  the quick bar and Properties: press or drag to set, arrow keys and the wheel
  (quick bar) step, double-click types a value. A readout on the canvas
  confirms size, opacity and hardness changes. Number keys set opacity
  (1 = 10% … 0 = 100%) and Shift+[ / ] change hardness. Presets show a stroke
  drawn by the real brush engine. The bar sits in the stage header, above the canvas, so it never covers the artboard.
  The bar names the active tool and, for painting tools, shows the colour
  rail next to the colour pair: the first eight colours of the palette the
  colour picker shows (the project's, the recent ones or a personal
  palette), +N when there are more (it opens the picker with all of them)
  and, while the brush colour is not yet in that palette, + to save it. The
  rail exists only in Draw.
  Clicking either colour opens the shared colour picker under it: it changes
  the brush colour live while you drag, ends with the palette and keeps the
  eyedropper. It writes the setting directly, so it keeps working while the
  bar or Properties re-render.
- **Pop-up palette:** right-clicking the canvas with a painting tool (Brush,
  Eraser, Fill, Shape) opens Krita's pop-up palette at the pointer:
  the colour pair, the palette's colours, brush presets and size and opacity sliders.
  Choosing a preset or colour, clicking elsewhere or Escape closes it; a
  closed palette holds no controls, so there is one live copy of each.
- **Assist:** mirror painting across the stage's vertical and/or horizontal
  centre (Shift+M toggles horizontal). Shift-click draws a straight line from
  the previous stroke's end; Alt-click (Brush, Fill) picks the visible colour;
  Ctrl-drag resizes the brush. **M** flips the view horizontally to check
  proportions; like view rotation it is temporary and never changes pixels.
- **U:** shapes. Drag a line, rectangle or ellipse; outlines are real brush
  strokes (selection clipping, symmetry and undo included) and Fill shape
  fills the interior. Shift constrains to 45° lines, squares and circles.
- **Colours and brushes:** a second colour sits beside the main one (X
  swaps them); the palette's colours appear as swatches in Properties too.
  Painted colours join the app's twelve recent colours, shared with every
  colour picker. Save brush stores the current tip as a custom preset. Recent
  colours and brushes persist in local storage (optional; the app works
  without it); project colours save with the project, and personal
  palettes stay on this computer for every project.
- **Filters** (Select and Transform tools): blur, hue/saturation/lightness,
  brightness/contrast and invert apply to the selection, or to the whole
  drawing when nothing is selected, as one undoable step. Blur works on
  premultiplied colour so transparent pixels never darken edges; pixels
  outside the selection keep their exact bytes.
- **[ / ]:** change brush size. **G:** fill with tolerance, expansion and gap
  closing; optionally sample visible artwork while writing only to this
  drawing.
- **L:** select pixels by lasso, rectangle, ellipse or magic wand (tolerance,
  gap closing and optional all-layer sampling). Shift adds to the selection,
  Alt subtracts; a click without dragging deselects. Brush strokes and fills
  stay inside the selection outline. Ctrl+A selects everything reachable,
  Ctrl+Shift+I inverts, Ctrl+Shift+A deselects and Shift+Backspace fills the
  selection with the current colour. Corner handles scale and the top handle rotates the floating selection
  (Shift snaps to 15°; a modifier at press chooses a selection mode instead).
  Drag inside the selection to move its
  pixels, set scale/angle in Properties, Enter to apply or Escape to cancel.
  Copy/cut/paste uses the shared clipboard and Delete removes selected pixels
  without touching the clipboard. Timeline focus retains frame clipboard and
  frame deletion routing.
- **V:** transform the whole cel using the existing pose controls. Pixel
  selection and cel pose are distinct. **H / middle mouse / held Space:** pan. A
  finger pans in the desktop layout and draws in the touch interface until a pen
  is used. Settings › Interface › Draw with a finger chooses Until a pen is used,
  Always (also in the desktop layout) or Never. A drawing finger uses the
  selected Draw tool through the same pixel transaction, undo and save paths as
  mouse or pen. Two fingers always navigate: a second finger cancels the first
  finger's provisional edit and pinches around their midpoint. Remaining fingers
  cannot edit until lifted. A recent pen gesture suppresses touch from a palm.
- Brush and Eraser retain independent tip settings. Properties contains tool
  controls; timing actions stay in the timeline. Dynamics and Resolution
  are collapsed until needed.
- New cels default to 2 pixels per scene unit; Resolution offers 1×, 2×
  and 4× and an explicit undoable resample. Pixel filtering offers Smooth
  and Nearest (pixel art) for resampling, selections and pixel paste. View rotation is temporary.
  Neither zoom nor stage resizing resamples ink.

All shortcut bindings are configurable in the existing shortcut preferences.
**A** creates a blank at the playhead inside a hold, or a next blank after
its exposure at an existing key. It affects only the active drawing layer in
both Simple and Advanced timelines, including the Animate workspace.
**Shift+A** extends the exposure. There is no additional F5 extension
command. **F7** inserts a blank key; Copy here has no extra default shortcut.
The timeline toolbar offers Blank frame and Next copied drawing; the context
menu offers Blank here and Copy here. Next actions insert one frame by default
and shift later keys on targeted layers. Copy here and Blank preserve later timing. Multi-layer commands validate
all targets before publication. Unrelated layers keep their timing.

Adding a blank or copied key beyond the last exposure extends that exposure up
to the requested frame; only the requested new key changes its content. An
explicit blank exposure stays blank when extended.

Painting anywhere in a hold edits its owning cel. Painting a blank exposure
creates a cel; its creation and first stroke undo together. Painting beyond a
layer end requires an explicit key first. Erasing everything retains the key.
Drawing rows carry a brush icon, DRAW badge and tinted exposure spans; wide
exposures display small cel thumbnails. First-stroke previews use the same layer
order as committed drawings and playback, including while other layers are hidden.
Existing onion settings apply, with key mode sampling distinct neighboring drawing
exposures inside the selected frame range. Without Scene VFX, ghosts stay above lower
layers and behind the current artwork on their own layer. Scene VFX retains its
unfiltered ghost overlay above the camera preview. Frame mode keeps its explicit
frame-based sampling.

## Document contract

`report._styk.layers.byId[id].drawing` is `{version: 1}`. Drawing layers contain
at most one drawing image object per exposure. `_styk.drawing` on its figure
contains `{version, celId, pixelsPerUnit, revision, bounds}` at version 2, or
`{version: 1, celId, width, height, pixelsPerUnit, origin, crop, revision,
empty}` for unmigrated cels. Version 2 pixels live in a sparse 64×64 tile store
with unbounded coordinates; the store is the single authoritative raster and
`bounds` is the occupied-pixel bounding box. Painting allocates only touched
tiles; strokes may cross the stage edge and negative coordinates freely.
Sparse bounds are validated against the tile format's signed 32-bit tile
coordinates, not a dense image's dimensions. Widely separated marks therefore
remain reopenable without allocating the empty area between them.
Brush hover and pointer-leave repaint only the editor overlay. Pixel changes,
navigation and other scene changes still invalidate artwork normally. Bounds
queries never decode a v2 cel's carrier PNG; doing so would repeatedly reload
and discard that placeholder. Loading a cel, drawing a stroke and running a
pixel operation suspend speculative playback and timeline-thumbnail work;
completion or cancellation releases the interaction gate.
Legacy v1 cels keep their full surface until the first pixel edit migrates
them; migration and its stroke are one undo command and pixel positions are
preserved exactly, including rotated and mirrored poses.

Layer IDs identify tracks, key IDs identify exposure boundaries, cel IDs identify
editable pixels, figure type IDs identify sprite definitions. Object UIDs stay
stable within a drawing layer. Copied keys get independent cel/definition IDs.
Copied cels share frozen tiles until an edit diverges them. Copying an evicted
cel also captures its pending undo/redo changes against the published base.
Clipboard capture
forks the store at copy time; a subsequent source edit cannot alter the
captured copy. Runtime values never enter document data. Pixel clipboard data
includes the source tiles and selection's full pixel-to-world affine pose, so
pastes preserve position, rotation and mirroring across different cel poses
without rasterizing the copy and filtering it again on paste. Older dense PNG
packets, including ones with only a world origin, remain readable. New sparse
packets require a current StykAnimate version at the destination. Aligned copies and
right-angle rotations/reflections preserve exact nonzero-alpha RGBA. Scaling
and transformed selections use a shared worker rasterizer. Paste compositing, fill and tile history run in the
drawing worker.
Lasso capture scans occupied tile rows in the pixel worker. Its even-odd polygon
describes empty selected space without a dense mask; one tile-sized coverage
buffer is reused. Fully selected tiles share the immutable cel buffers, while
partial tiles retain separate selected and remaining pixels. Bounds are prepared
in the worker too. Temporary selection surfaces use the same bounded preview
worker, mip and scratch caches as cels and participate in memory accounting,
without entering document publication. Previews never change the cel store.
Applying a selection touches only source and destination tiles; integer
translations preserve exact RGBA. Empty distance and polygon area impose no
pixel-allocation limit. Commands await the transaction, and Escape, seeking or
replacing the document discards stale capture replies and releases temporary
surfaces. Lasso input remains bounded to 8,192 vertices and the working memory
budget. Rectangles, ellipses and flipped selections use the same sparse
preview and commit path. Add/subtract/invert masks, magic wand, filled shapes,
and blur retain a 16-megapixel region limit. Invert, brightness/contrast and
hue/saturation/lightness visit occupied tile intersections instead of allocating
the whole coordinate span, with a 16-megapixel occupied-work limit and the same
working-memory budget. Unchanged tiles retain their pixels and encoded data;
changed tile originals become the undo record without another snapshot copy.
Blur reuses one scratch surface across its three passes. All these operations
share the transaction gate; rejected or cancelled operations leave the cel untouched.

`drawing-transform.mjs` is the shared affine kernel for selection commits,
paste and resolution changes. It plans output tiles from occupied source
tiles, preflights memory and coordinate bounds, and includes filter footprints
when seeding existing destination tiles. Premultiplied bilinear sampling uses
box-filtered mip levels for reduction; nearest sampling preserves pixel-art
edges. Sampling uses a bounded source window per output tile, with sparse
lookups for extreme reductions. No full drawing rectangle is allocated during
resampling. Exact tile-aligned translations into empty destination tiles copy
bytes directly; overlapping tiles still use the same source-over sampler.
Individual jobs are limited by available working memory. Selection and resample
jobs also retain their 384 MiB ceiling; clipboard jobs use the owner's available
allowance, leaving one scratch budget for previews.

`drawing-clipboard.mjs` owns the version-2 sparse pixel packet. It transports
64×64 PNG tiles through the existing bounded native clipboard wire protocol,
reuses published PNG bytes, and encodes partial selections in the pixel worker.
The index and affine matrix seed only relevant destination tiles, including the
filter footprint, without decoding PNGs on the UI thread. Decode validates PNG
dimensions before inflation, limits concurrent streams to eight, preserves index
order and settles in-flight streams before reporting failure. No sparse-copy
limit depends on bounding-box area or distance between occupied tiles.

Small PNG tiles use bounded synchronous zlib in codec workers. For larger
images, the exact PNG decoder feeds IDAT byte views directly to the decompression
stream, awaits input backpressure and releases both stream endpoints on failure.
Reconstruction stays in its bounded scan buffer; unfiltered RGBA rows use byte
copies and never pass through a premultiplied canvas. All five PNG filters and
8-bit RGB/RGBA remain supported. Drawing PNGs, tile blobs and native containers
share byte/base64 helpers with a portable fallback for older runtimes. File
formats, checksum checks, expected dimensions and allocation limits are unchanged.

Packet bounds remain explicit: at most 32,768 tiles, 128 MiB of PNG text and
64 KiB of encoded data per tile. Actual jobs may hit the available pixel working
budget earlier. Native wire transfers retain their 256 MiB limit and 256 KiB
chunks; the shared wire decoder has a separate 512 MiB resident allowance.
These are component allocation bounds, not a whole-process RSS guarantee.
Legacy dense clipboard PNGs retain their original 16 MP / 8192-pixel limits.

Cut publishes the complete clipboard before removing pixels. Failed writes
preserve the selection, artwork and undo cursor. Cancellation covers native
reads/writes, worker work and the final revision check; a cancelled transfer
cannot commit a cut or paste. If cancellation arrives after native publication,
the new clipboard may already be visible, but the artwork remains intact.

Fill, shapes, filters, copy, paste, resample, selection capture and commits share one pixel transaction
gate. Save and editing commands await publication; a following pointer gesture
retains its samples until the preceding operation commits. Escape cancels the
worker, discards its late result and releases reservations. Input copying yields
every 128 tiles so preparing a large job does not monopolize the UI thread.
Whole-scene paste matches drawing and figure layer kinds, creates missing layers,
and shifts surplus destination layers together in the same undo command.

The persistent carrier is an ordinary PNG image figure so pose, anchor and
transform tooling keep working. Authored v2 cels carry a transparent 1×1 PNG;
committed pixels publish as a `styk_tiles` data URL holding a bounded blob of
per-tile PNGs. Legacy exporters flatten source tiles on demand. Unmigrated v1 cels still publish a full `data_url` PNG.
Metadata, PNG header sizes, decode bounds and CRCs are validated. Pixel content
and initial transforms hold between keys; pixel morphs and implicit crossfades
are not supported.

## Runtime and performance

The raster work below runs in the Rust drawing engine (`styk-drawing`,
[docs/engine/drawing.md](engine/drawing.md)): the stroke, pixel and history
workers each load its WebAssembly module, and the controller's brush model
computes dab shapes with it. The JavaScript raster engine it replaced is gone;
its recorded answers are the engine's frozen test oracle.

`drawing-resources.mjs` owns sparse tile stores, worker jobs and disposal for
one report. Resident tiles are limited by a budget scaled from device memory
(192–768 MiB; the hard ceiling for unpublished work is at least 768 MiB);
accounting deduplicates
pixel buffers, so copy-on-write forks share counted bytes until they diverge.
The owner indexes resident pixel references. Enrolling or removing a store
visits its tiles once; subsequent tile-map writes update reference counts
directly. Warm reservations inspect resident store membership and changed
tiles, without rebuilding sets of every pixel buffer. Multiple tile positions
sharing one array retain it until the last reference is removed. Store byte
counts use the fixed 64×64 RGBA tile size. Scratch and mip eviction inspect
their own caches, without scanning source pixels. Collection, transient
release and disposal detach observers and release the index's references.
New work reserves before it is rejected: presenter scratches free first, then
derived mip levels, then published-clean stores (which re-decode on demand),
while unpublished work is never evicted. A presenter asked for an evicted cel
kicks its re-decode itself — real failures back off behind `decodeError`
instead of retrying every frame — and v2 renderers keep their last texture or
draw nothing rather than flashing the stale 1×1 placeholder. Cold requests
coalesce into a bounded queue: at most two decodes wait, and a newer seek
supersedes the oldest. Once publication finishes, clean stores above the
budget are trimmed farthest from the playhead first — distance over every
drawing layer, measured circularly because playback and scrubbing loop — then
least recently used, keeping the cel at the playhead. Reserving room for new
work evicts in the same order. Strokes
adopt tiles without reserving, so this is what bounds memory after painting.
A cold decode is split across a small pool of codec workers by 8×8-tile blocks;
each block owns its mip tiles up to level 3, so every shard also builds its
mip levels and the cel arrives display-ready at any zoom.
Seeking prefetches the two unique neighbouring cels on each side of the
playhead plus the current one, queued last so it wins eviction. Thumbnails
have one worker, at most 48 queued requests and 256 small cached images;
their pump pauses while a stroke or a scrub owns the thread.

The selection is a polygon or bounded pixel mask on one cel (the outline). It clips stroke
coverage in the worker and confines fills; moving, scaling or rotating
selected pixels floats them into a separate preview derived from the outline,
committed as one undo step. An untransformed float shows the exact stored
pixels. Sparse worker previews preserve translucent colors and avoid allocating
the empty space between distant selected tiles.

Every brush and the eraser — including tip shape, grain, scatter, pressure flow,
every blend mode, alpha lock, selection clipping and smudge — rasterize in the
stroke worker, which commits through the same transaction and history as every
other pixel operation. The engine's stage draws each batch of tiles as it returns
([live cels](engine/drawing.md#live-cels)).

The brush model (`drawing-brush.mjs` holds the settings; the engine's `BrushPath`
the geometry) runs on the main thread and is pure geometry. `RustBrushStroke`
maps input through the pen pressure curve into the stroke path (stabilization,
curve joining, dab spacing and arc length), then turns each path dab into its
final tip — pressure size, tapers, size/opacity/angle jitter, scatter, per-dab
opacity and flow, tip angle — with exact pixel bounds. Jitter is a hash of the
stroke seed and the dab index, so a dab's shape never depends on painting order. Each batch seeds the stroke worker with exactly the
tiles its shapes reach, and the worker refuses a dab outside its seeded tiles
rather than painting over a blank guess. A start taper shrinks the tip and its
spacing over the first pixels. An end taper cannot be known until pen-up, so
dabs within the taper length of the pen stay a provisional tail: both
the raster paints it at full size into scratch coverage over the final
coverage every update and replace it the next, and at pen-up the tail is
re-spaced along its path and tapered to a point. Final pixels are identical to
painting the finished shapes once (the stroke fixtures of `styk-drawing`). A tap
paints a full dot whatever the tapers. Smudge keeps the round tip and has no
end taper, because every smudge dab reads the previous one. Image tips and
grains are generated procedurally and deterministically on first use into one
atlas the raster samples with bilinear formulas; it computes grain once per tile.
Symmetry feeds each mirrored sample into its own pipeline (with its own jitter
seed) so mirrored strokes keep even spacing while sharing one coverage buffer
and undo step.
Wet ink (`drawing-wet-ink.mjs`) draws the part of a stroke that is not yet
on screen — the last presented dab, dabs in flight or pending, the raw
pointer and its predicted position — on a desynchronized canvas between the
scene and the overlay, at most every 8 ms (pens can report several hundred
samples a second). Points closer than a CSS pixel merge and consecutive
segments of one width share a path: a canvas call per dab once flooded the
compositor with fine brushes and stalled every frame. The stage records each
cel's `presentedStamp` when a frame it drew carried the tiles of that stamp, and a
batch's wet segments retire one frame after their stamp is presented, so the
exact stroke is always on screen before its preview leaves. Only brushes the preview
matches closely use it (normal blend, firm round analytic tips, flow ≥ 50%, no
selection clip); erasing, smudging and special blends show exact pixels only.

The stage hands the engine the tiles of a cel that changed, a slice of them each
frame, so a frame without a geometry change draws only what the stroke added.
A pointer interrupted mid-gesture (lost capture, `pointercancel`, window
blur) finishes the gesture and keeps its ink; only Escape discards it.

At most one dab batch is in flight: while the stroke worker is busy, input
samples accumulate and become dabs only as the next batch leaves, so a brush
slower than the pointer never queues stale work or an unbounded dab list. Samples arrive through `pointerrawupdate` where available,
and an idle worker takes a batch immediately instead of at the next frame.
Dabs accumulate stroke coverage only; colour is composited once per batch over
each tile's dirty span, since it depends only on final coverage, the pixels
the stroke first saw and the blend mode. Soft falloff uses a per-stroke
lookup table indexed by squared distance.

`drawing-pixels.mjs` rasterizes real, distance-resampled samples. Stroke opacity
caps the whole stroke, while flow accumulates dabs. Pressure release cannot
remove previously deposited paint. Stabilization is a distance-windowed
weighted average of the raw path — a linear-ramp centroid over
`stabilization × 48` screen pixels of trailing path length, converted through
the cel pose and zoom at stroke start — so every input
sample yields output with no dead zone and the finish drains the tail to the
exact endpoint. Pushed points, raw or smoothed, are joined by quadratic
midpoint segments sampled by arc length, which keeps corners smooth at zero
lag. Coalesced events have an ordinary-event
fallback. Running distance and weighted sums replace repeated tail scans;
Distance sampling follows the pressure-adjusted tip diameter, including
pressure ramps, so a light stroke does not become a row of separated dabs.
the smoothing window retains at most 4,096 samples, including stationary pen
input, and release drains it in linear time. This limit affects only the
smoothing history, not the input samples sent for painting. A stroke snapshots
its pixel transform once. The main thread generates the final dabs and posts
512 per batch, or up to 8,192 for tips small enough that 512 would make
round trips the bottleneck (their batch covers about the same pixel area),
with one batch outstanding. Acknowledgments release pending dabs before the
final end message. Seed regions cover the actual dab extents, preserving
existing pixels and exact undo records across batches. A stroke retains at
most 65,536 input samples (minutes of 240 Hz pen input); a fine brush's dab
count no longer limits stroke length. Exceeding the working memory limit
cancels and rolls back the transaction.
A gesture queued behind a closing stroke retains its samples within that bound;
canvas publication coalesces into one animation-frame callback. Pointer
capture, cancellation,
lost capture, Escape and blur cannot leave a half-committed stroke.
Frame and structural commands wait for the closing stroke's pixel commit;
view-only navigation does not discard its final worker reply. The completed
stroke still belongs to the exposure where it started.

Pixel transactions with more than 1 MiB of expanded replacement tiles prepare
those tiles in the pixel worker before committing. The owner reserves the
complete replacement set plus one 1 MiB input batch, protects its source stores
from eviction, and validates every returned tile and its alpha bounds. The
editor then adopts the prepared buffers in one synchronous transaction. History
keeps separate, unchanged before/after buffers. Cancellation, a newer edit,
worker failure or document disposal discards the prepared set and releases its
reservation. A closing stroke retains its visible preview while preparation is
pending; saving and the next gesture wait for that transaction. Resampling
adopts the worker's already-complete pixel buffers directly.

The preparation worker reuses its transferred full-tile buffers; it expands
only compact uniform colors. The main thread's original history arrays stay
unchanged. Its lightweight entry point loads codecs and other pixel operations
on demand in the same worker, keeping their caches for later requests. A module
load failure releases that worker and rejects all pending requests so retrying
can start a fresh one. This adds no extra worker or queue.

Undo belongs to the editor's chronological history. Before/after tile records
are exact; absent sides are `null` and uniform tiles use a four-byte color
representation. Where workers and IndexedDB are available, records of at least
64 KiB move to a session-owned disk tier. Its dedicated worker encodes, hashes
and optionally compresses chunks of at most 1 MiB. Partial manifests and chunks
commit together; only a completed manifest allows RAM eviction. The hot tier
retains 16 MiB by default, and disk writes stop at 512 MiB of stored chunks.
Queued writes and pinned replays can exceed the hot retention target, but their
resident bytes and worker scratch count against the owner's working-memory
limit. A failed write preserves the exact RAM records and restores their shared
history weight. Subsequent edits use RAM history for that session.

The shared 48 MiB budget counts command metadata and records without disk
backing, across undo and redo. The existing 80-command limit still applies. An
oversized newest command remains undoable; allocation checks reject work before
changing authoritative pixels. Small warm undo stays synchronous. Cold or large
undo/redo returns a promise, pins all children of the command, loads any cold
pixel data and prepares all large replacements before applying any child.
Retired history buffers remain accounted while an outstanding replay uses them.
Cancelled or damaged reads, failed preparation and
intervening edits leave both pixels and the history cursor unchanged. Canvas,
timeline and audio shortcuts share the drawing transaction gate so saving and
the next pen gesture wait for asynchronous replay. Deferred changes on evicted cel stores
retain their own accounted pixel bytes until those stores are reconstructed.

Disk history is temporary, not a dependency of saved documents. A main-thread
Web Lock protects each session across worker restarts; new sessions reclaim
abandoned sessions only after acquiring their locks. Interrupted writes in the
same session are reclaimed when its worker reopens the database. Without Web
Locks, only explicit disposal deletes a session. Closing a document releases
its cache and worker. Native saving and recovery remain self-contained.
Desktop startup additionally clears temporary IndexedDB storage in its own
Chromium workspace session before opening the editor, because its loopback
origin changes between launches. Desktop preferences, recovery and library
data use native files; they must not be placed in this temporary database tier.

Fill, paste, resample and
thumbnails compute in workers over bounded tile regions. Lasso preview always
uses the original selection, with one resample when applied.

The pixel worker keeps a bounded per-cel cache of encoded tile PNGs. Each
publication sends pixels only for tiles whose PNG is not already trusted.
Transfers run after the synchronous editor commit in batches of at most 1 MiB,
with one publication batch in flight and its capacity reserved against working memory.
Large batches split across up to four codec workers; their raw and encoded
buffers are reserved before dispatch, then adopted into the publication cache.
Partial worker replies cache exact tile PNGs; the final ordered key list
assembles the complete blob in the worker. The document's saved asset changes
only after that complete revision is ready. Missing worker-cache entries
trigger one bounded resend of retained PNGs. A legacy PNG with ancillary data
larger than a batch is re-encoded from its exact 64×64 pixels instead.
Generation, cel, revision and store-mutation checks reject stale results
between batches. Cancellation, document disposal and worker failure release
the transfer reservation. Tiles are PNG-encoded synchronously by
`zlib-sync.mjs` (greedy LZ77 with one dynamic-Huffman block; plain or
adaptively filtered rows, whichever LZ77 can reuse more of), and decoded with
its table-driven inflate; per-tile compression streams cost more in setup than
the work itself. Larger images keep the native streams. The blob format and
PNG bytes stay standard, so older files and other readers are unaffected. encoding retains dirty work for retry, and the publication debounce yields to
active strokes and scrubbing. Publication also pauses between batches while an
undo or redo loads and prepares its tiles (`DrawingHistory.replaying()`): the
replay is about to replace the revision being published, and finishing it (the
blob's assembly in the pixel worker, then the figure update it triggers on the
interface thread, 0.2–0.7 s on a 2,040-tile cel) would land inside the replay.
The replayed revision publishes once the replay ends, or the unchanged one if it
fails. A gesture's pin on its tile store ends inside
the commit, before the change broadcast — the playback/export barriers that
broadcast triggers always see the committed tiles, and pixel commits reach
the playback worker as sparse figure updates instead of full snapshots.
Exact PNG encoding/decoding avoids
premultiplication rounding in saved pixels. Encoding is derived publication,
not another edit.

The resource owner retains each cel's published blob and bounds independently
of figure snapshots. Undo/redo can replace those snapshots while encoding is
in flight. Publications reconnect to the current definition by cel identity;
save barriers and cold decode restore the same published base, including after
resampling and eviction. Uncommitted preview bounds never enter this snapshot.

Paused playback and scrubbing use the same lazy drawing resource owner, including
drawings contained only in nested movieclips. Cooperative scene preparation carries
the viewport dimensions and the live tile backend. Composite raster variants track drawing presenter stamps
and decoded stores, so completion of a decode or preview invalidates an empty raster.
Existing cache budgets and preparation leases retain their lifetime guarantees.
A parent caches a nested cel publication without writing back into the child definition;
changed revisions, undo and superseded decodes replace only that cached cel.

The scratch-canvas presenter below serves the JavaScript painters of drawing geometry
(`pivot/geometry.mjs`) that remain; the editing canvas is the engine's stage, which draws
cels, onion skins and floating selections from the tiles it holds. Drawing textures participate in the normal scene compositor, including
ordering, opacity, erasing, camera and clipping. Tiles are painted into
tile-anchored scratch canvases; each presenter keeps a bounded LRU of them,
and a request contained in an already-painted cover reuses it without
repainting, so zooming inside a painted region and alternating WebGPU/Canvas
anchors never share or thrash one canvas. Each scratch tracks its own pending
dirty rect; WebGPU uploads those dirty regions and Canvas draws the scratch
once. Mip levels escalate to 8 (256×) so coverage of any span fits the
texture limit, and the scratch clamps to that limit around the visible span
as a final guarantee — a drawing is never rejected for size. Overlays contain only cursor and selection
feedback. Canvas and SVG use smooth drawing filtering; imported Pivot sprites
retain their existing sampling.

The retained WebGPU layout refreshes drawing entries by pixel stamp and view,
including empty and previously offscreen cels, without rebuilding unrelated
scene geometry. Retaining an earlier texture applies only to pending pixel or
preview work. A decoded store with no visible pixels draws nothing, including
while the eraser is still held or when only offscreen paint remains.
Effects bypass views are idempotent, so render preparation
does not wrap an already prepared view and invalidate the scene each frame.
The camera's dotted outline clips its path before Canvas expands the dashes;
offscreen perimeter length therefore cannot dominate drawing at deep zoom.


Dense live cels (more than 64 tiles) use a separate preview worker. Its source
cache keeps one viewport's tiles and mip chain; tile versions identify changed
inputs. Preview requests load only tile sampling; PNG codecs and general
editing operations load on their own request paths. During the first preview,
the presenter can borrow its last completed synchronous scratch without
allocating or rasterizing another image. Its store, mip level, dimensions and
visible overlap must still match. Empty or offscreen artwork clears normally.
The main thread copies source tiles in bounded chunks and submits only
changed tiles on later revisions. At most three cel requests wait behind the
active job. A job captures tile versions and freezes only the changed input
tiles before copying in yielding batches. Later writes copy on write, so each
completed image represents one consistent revision even while painting
continues. Snapshot and transfer buffers reserve working memory before copying
and release it when the job finishes or is cancelled.

Completed ImageBitmaps share the scratch budget; eviction and disposal close
them. A completed snapshot may trail newer input and remains visible while the
next revision is prepared. Growing covers and pans can reuse the newest
overlapping snapshot from the same surface and mip level. Dropped, replaced or
disposed surfaces cannot accept old replies or reuse another surface's image.
A failed source revision backs off until pixels change. WebGPU uploads a
preview only when that image changes, and retains an existing texture while its
replacement is prepared. Small cels use the synchronous dirty-region path.
Preview canvases use CPU-backed storage for tile uploads, avoiding GPU readback
when the Canvas 2D fallback draws the resulting image.
Cold previews may take longer in wall time than synchronous rasterization,
but input is not blocked by their mip calculation. Worker source/preview working
sets are included in resource reservations. Source tiles, resident drawing
history and deferred pixel records share the owner reservation limit. Encoded
document strings, other editor history, browser overhead and GPU allocations
remain separate memory categories; these budgets are not a process-RSS limit.

Thumbnail mip generation also runs in the worker. Playback/export providers
count source tiles, mip tiles and scratch canvases in their retained bytes and
release derived resources on eviction. Decode rejects tile counts beyond the
available provider memory before allocating pixel buffers.

## Saving, reuse and exports

Native save, recovery, close/save, shared clipboard, library capture, playback,
thumbnail snapshots and exports wait for committed pixel publication. Existing
revision checks and atomic file replacement remain authoritative. Recovery
captures committed work; active uncommitted gestures are not recovery entries.
Nested movieclip scope changes flush before snapshotting and dispose child
runtime resources on exit. Replacing a document disposes abandoned workers.

STYK keeps editable drawing metadata, layers, timing and exact raster pixels.
PIV/STK provide visual sprite compatibility, not editable drawing-layer semantics.
SVG embeds raster artwork. Image sequences, GIF, APNG and WebM use the existing
frame renderer and encoders. External images remain images; there is no implicit
rig conversion or vector tracing.

## Evidence and limits

Run `node --test tests/drawing.test.mjs`; the browser suites
(`tests/drawing-*.browser.mjs`) run against the local app at port 47839 (or set
`STYK_URL`). See [verification report](../artifacts/drawing/VERIFICATION.md).
`tests/drawing-latency.browser.mjs` measures input-to-frame latency.
The pan, expansion and shortcut refinements have a separate regression suite:
`node tests/drawing-ux.browser.mjs`; see its [report](../artifacts/drawing-ux/VERIFICATION.md). A run writes its
screenshots and ux.json to the ignored `artifacts/drawing-ux-latest`; set
`STYK_DRAWING_UX_OUT=artifacts/drawing-ux` to refresh the recorded report.
`npm run test:drawing:desktop` paints through real input in the Electron app,
saves natively, restarts the process and verifies every cel reopens
pixel-identical, with live strokes, a fill that samples all layers and a
selection moved and applied checked on the engine's stage.
`tests/drawing-tools.browser.mjs` covers selection shapes and modes, clipped
painting and fills, the magic wand, symmetry, straight lines, colour picking,
brush resizing, view flipping and alpha lock through real input,
`tests/drawing-stroke.browser.mjs` covers the worker stroke pipeline,
`tests/drawing-save.browser.mjs` covers save/reload/recovery fidelity and
`tests/drawing-timeline.browser.mjs` covers cache bounding and the
drawing-free-document overhead contract.
Browser tests exercise native codec reopening, pixel fidelity, nested scopes,
fill/selection/resample history, clipboard, both renderer paths and encoders.

Mouse/browser checks and deterministic pressure tests do not certify physical
pen drivers, input-to-photon latency or every GPU. Pen tilt steers tilt-mode tips; vector strokes and
resolution-independent drawing are outside this implementation. Fill follows
stage plus artwork bounds, independently of zoom. The `drawing-fill.mjs` worker
kernel allocates masks only for reached tiles and the gap/expansion halo, so a
small enclosed fill is independent of distant artwork or total bounds area.
Tolerance still compares premultiplied RGBA; gap closing and expansion retain
four-neighbour distances across tile boundaries. Uniform tiles use a fast path.
Source pixels, masks, pending work and prepared output share a memory budget;
reached empty tiles reserve their future output before traversal continues.
Output and history are prepared before adoption, so a rejected operation never
partially edits the drawing. Cancellation terminates the worker and the next
operation starts a fresh worker. Sample all layers captures visible evaluated
artwork in a separate, cancellable worker. Publication completes before the
fill reserves memory, including the destination cel's latest ink. Render
definitions are shared in a frame-only snapshot sent in acknowledged packets
of at most 64 KiB; pose arrays and the animation library are excluded.
Capture uses the existing renderer and full-resolution asset decoding, then
transfers its RGBA buffer to the pixel worker without cloning it. The capture
worker terminates after each operation to release renderer/device caches.
Its full canvas retains the 64-megapixel limit: subdividing native Canvas paths
can alter antialiased coverage and fill boundaries. Canvas, readback, opacity
isolation and source snapshot bytes are reserved before capture; decoded images
and drawing sources receive bounded allowances. Effects retain the renderer's
separate allocation limits, so the drawing allowance is not a total-process
memory ceiling. Cold capture has additional worker and snapshot overhead; see
the audit for the measured responsiveness/throughput tradeoff.
New clipboard packets,
sparse lasso capture, resampling and transformed paste output are bounded by
occupied tiles and available memory instead of a
dense bounding-box limit. The embedded tile-blob and native-container limits
remain separate persistence constraints.

## Camera zoom quality and the road to vector ink

The sparse tile engine keeps scene dimensions, drawing resolution, editor zoom
and camera zoom as separate contracts. Choose resolution before drawing: 2×
uses four times the pixels of 1×, and 4× uses sixteen times as many. For a
raster shot, source pixels per scene unit should cover the maximum camera
magnification multiplied by the export scale. Upscaling an old cel smooths its
existing samples; it cannot recover lost detail.
[Canvas image smoothing](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled)
controls filtering, not the amount of source detail. Exports always render
the authoritative source tiles at output resolution; preview mip levels never
substitute for them.

Raster tiles — including the sparse allocation, copy-on-write cel sharing,
visible-tile streaming and bounded caches the format now provides — remain
the right representation for Soft and textured paint. For arbitrarily deep
zooms, the recommended next step is a hybrid drawing layer:

- Store Ink and Pencil as editable pressure-aware vector paths, rasterized or
  tessellated at the required view/export scale in workers. Keep the existing
  layer sheet, cel ownership, commands, clipboard and save pipeline. Bound the
  derived geometry cache by scale and revision. Vector artwork can scale without
  the source-resolution limit of bitmap ink; see [SVG](https://developer.mozilla.org/en-US/docs/Web/SVG).
- Keep Soft and textured paint as raster tiles alongside the vector layer,
  sharing the same sparse world coordinates and streaming path.
- Design vector erasing, fill boundaries and mixed vector/raster compositing as
  explicit document semantics, including undo and backward-compatible export.
  Existing cels remain raster; tracing would be an optional, lossy operation.

These are proposed follow-up changes, not capabilities of the current raster cel
format. Implementing a second standalone drawing workspace would lose the shared
editing and animation behavior this integration preserves.
