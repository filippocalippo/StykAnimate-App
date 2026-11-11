# Private typed allocation observation

`eval::retained::observe` is an explicitly invoked worker prerequisite with no
runtime caller. It returns an opaque scalar descriptor, not a reservation,
cache, physical lease or whole Frame/Generation memory total. No public data
shape or existing eviction, Scene, raw-record or glyph policy changes.

The source Document and optional known source glyph slices stay strongly held
through the call. Their visited allocations seed one transient identity set and
are excluded from `additional_covered_bytes`. Addresses are never retained
across calls. Source byte results cover only the visited typed children, not the
Document/Prepared/Generation/raw/Assets ownership graph. An additional allocation
may also belong to an unvisited source branch; the result does not classify every
additional byte as newly allocated.

Covered requested allocations use the same checked Arc layout and DrawList
capacity owner, plus the same Resolved effect/id/paint owner used by Scene
accounting. The observation covers Frame buffers; Object headers/numeric slices,
playback restart buffers, color transitions and flat spatial headers; styles'
key/palette/paint payloads; derived Figure strings, vectors, nested polygon and
text buffers, plan vectors, palettes and drawing tile payloads; typed pose and
resolved VFX stacks; and optional actual encoded DrawLists, including shared
triangle slices. Borrowing a parameter may briefly clone its Paint Arc; no Arc
is retained by the descriptor. Owning visitors live with doc, style and vfx.

Uncovered bits explicitly report source ownership, mutable Assets, opaque map
tables and encountered unvisited IK, rig, shape/sprite, origin, mesh, movieclip,
parallax and spatial map branches. HashMap/BTree allocation layouts are never
inferred from public capacity/length. FigurePlan map capacity and spatial/style
map presence only mark gaps. Mutable caches are never locked or traversed.
Cancellation and accounting refusal retain encountered gaps and return no usable
charge. No admission route adopts a partial result.

Native unit tests observe real System allocation IDs, requested sizes and actual
thread IDs in a bounded test-only ledger, independent of accounting formulas.
They exercise actual evaluation, Loader, style parsing/resolution, paint sampling
and encoding owners. Complete covered fixtures compare retained live allocator
receipts; map-bearing fixtures assert explicit partial coverage. Sources remain
strongly held and unchanged through cancellation. This proves covered worker
allocations, not eventual UI last-owner release, global process memory or a
no-threads route. The ignored dense worker diagnostic is a loaded cost probe,
not baseline-0 or engine-1.
