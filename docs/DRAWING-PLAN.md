# Raster drawing implementation plan

Status: implemented in the shared editor. Verification and measured limits are recorded in `artifacts/drawing/VERIFICATION.md`; physical pen and cross-device certification remain hardware-dependent.

Integration correction: retain A and Shift+A as the existing Add Frame and Extend commands. On a drawing layer A creates a blank only on that layer. Copy here is configurable without a second default key, Blank uses F7, and there is no duplicate F5 command. Drawing tools live in the studio rail and Properties inspector.

## 1. Goal and scope

Add responsive raster drawing and frame-by-frame animation to StykAnimate's existing document, exposure sheet, history, renderer, saving, and export paths. Drawings and stick figures must coexist with independent timing. Users should recognize the distinction between extending a drawing, copying it into a new key, and starting a blank drawing.

The target is excellent painting with familiar animation timing. This is not a promise of Adobe Animate vector-editing parity: raster strokes do not retain selectable vector paths, arbitrary-resolution scaling, or shape tweening.

The first complete release includes:

- Dedicated drawing layers in the shared timeline and a Draw workspace preset.
- Hard and soft brushes, pressure, stabilization, erasing, eyedropper, and fill.
- Blank/copy drawing keys, holds, independent duplication, retiming, and onion skin.
- Lasso selection with move/scale/rotate, whole-drawing transforms, and canvas view rotation.
- Stroke-level undo in the existing history, reliable native saving/recovery, and verified exports.
- Bounded memory, asynchronous encoding, and measured responsiveness.

Defer vector conversion, editable stroke objects, procedural brush scripting, shape morphing, collaborative painting, infinite canvas, and automatic raster-to-vector tracing. Tilt and elaborate textured brushes can follow the initial release. Do not add a persistent stroke log merely to support speculative future features.

## 2. Existing owners and constraints

Inspect these contracts and their current callers before editing. Proposed new module names below are suggestions, not requirements to create parallel infrastructure.

| Concern | Existing owner / contract |
| --- | --- |
| Document, commands, history | `src/editor.mjs`, `src/animation-history.mjs`, `docs/ARCHITECTURE.md` |
| Layers and independent exposures | `src/editor-layer-sheet.mjs`, `src/layer-sheet.mjs`, `src/editor-layers.mjs`, `src/layers.mjs` |
| Timeline UI and shortcuts | `src/layer-timeline.mjs`, `src/timeline-hotkeys.mjs`, `src/hotkeys.mjs`, `docs/TIMELINE.md`, `docs/animation-modes.md` |
| Sprite representation | `src/media-authoring.mjs`, especially `createImageFigure` |
| Image decoding | `src/media-image-worker.mjs` |
| Rendering and ordering | `src/engine/engine-stage.mjs`, `src/scene-order.mjs`, `docs/engine/rendering.md` |
| Onion skin | `src/onion-controller.mjs`, `src/onion-skin.mjs`, `src/onion-range.mjs` |
| Worker synchronization | `src/playback-patch.mjs` |
| Memory and prepared playback | `src/playback-budget.mjs`, `src/playback-resources.mjs`, `docs/ADAPTIVE-PREVIEW.md` |
| Persistence and recovery | `src/document-export.mjs`, `src/document-export-worker.mjs`, `src/browser-recovery.mjs`, `docs/document-exports.md`, `docs/native-file-format.md` |
| Rendered and native export | `src/engine/engine-export.mjs`, `src/engine/engine-export-worker.mjs`, `src/pivot-export-materialize.mjs`, `engine/crates/styk-export` |

Observed constraints to preserve:

- Simple and Advanced views share one document; do not create a drawing-only timeline or history.
- `sheetInsertKey` and `sheetDuplicateFrameAfter` currently copy poses. This alone does not establish independent mutable drawing assets.
- The current Add Frame button inserts a key or duplicates into the following cell depending on the selection. Drawing commands must have explicit meanings rather than inherit ambiguous UI labels.
- History currently defaults to 80 commands and 48 MiB; inspect both undo and redo accounting before adding pixel payloads.
- The current media image worker is a one-request import worker. Do not assume it is already a persistent drawing encoder.
- Document exports use bounded transport and revision checks. Do not serialize or clone the full document on the UI thread.
- Runtime resources must stay outside serialized document records: the existing exporter preserves unknown fields.

## 3. User-visible behavior: settle before implementation

### Layers and workspace

A drawing layer is a user layer with drawing-specific authoring behavior, backed by the existing layer sheet. It contains one cel at a time, not one layer per stroke or per key. Drawing layers can be ordered among figure layers, hidden, locked, renamed, duplicated, and deleted through existing commands.

For the first release, drawing layers accept drawing cels; ordinary figure layers retain their current behavior. Reject unsupported paste/migration targets with an actionable explanation. Offer an explicit image-to-drawing conversion if image import into drawing layers is supported. Do not silently convert rigs into drawings.

Entering Draw selects the active drawing layer or the most recently used unlocked drawing layer. If none exists, offer a visible New drawing layer action; entering the workspace alone does not mutate the document. Drawing requires an eligible visible, unlocked layer. Scene, Camera, and figure layers are not implicit paint targets.

Draw is a presentation preset: expose Brush, Eraser, Fill, Eyedropper, Select, Transform, and Pan; hide rig handles; show brush controls and the exposure sheet. Preserve the user's prior layout and onion-skin preference on exit. Both timeline views can display the same drawings.

### Cels, keys, and time

Example: key A at frame 1, key B at frame 5, blank key at frame 7 means A appears on frames 1–4, B on 5–6, then nothing until another key or the layer end.

| Action | Required result |
| --- | --- |
| Paint on an occupied key | Add pixels to that cel; do not insert a key. |
| Paint within a held exposure | Edit its owning cel; every frame in that hold reflects the change. Highlight the affected exposure. |
| Paint on an explicit blank exposure | Create a cel at that blank key, preserving its exposure boundaries. First stroke and cel creation undo together. |
| Paint beyond layer end / outside an exposure | Require an explicit Blank drawing or Copy drawing action; no invisible duration extension from a stray stroke. |
| Blank drawing at playhead | Insert or replace a key with a blank exposure until the next key; preserve earlier frames and later keys. Replacement is undoable. |
| Copy drawing at a held cell | Split at the playhead with an independent copy of the visible cel; preserve duration and later keys. |
| Copy drawing at an existing key | No-op with feedback; use the separate next-drawing action to advance. |
| Next blank / next copied drawing | Insert after the current exposure, using a chosen exposure length (default one frame); shift subsequent keys only on selected drawing layers. |
| Extend exposure | Lengthen the current hold and shift later keys on selected layers; do not duplicate pixels. |
| Duplicate layer / paste drawing keys | Independent editable cels by default, with relative timing preserved. |
| Delete keys | Use the existing clear-key timing semantics; deleting a boundary may extend the preceding exposure. This is not the Blank command. |
| Remove frames | Remove time and shift later keys according to existing sheet semantics. |
| Erase all pixels | Leave an authored empty cel/key and its timing intact; never delete time implicitly. |

Preserve the sheet's opening-key invariant and make out-of-range actions follow its validated duration limits. Multi-layer operations validate every target before publishing; reject atomically if any target is locked or incompatible. Do not change unrelated layers or existing figure-layer shortcuts.

Wire explicit Insert copied key, Insert blank key, and Extend exposure actions through the existing shortcut system. Use existing A for a blank on the active drawing layer, Shift+A for Extend and F7 for Blank here. Copy here has no extra default shortcut; bindings remain configurable. Document the difference between insertion at the playhead and insertion of additional time.

Cel content always holds between drawing keys. Do not morph pixels or crossfade between drawings automatically. Allow whole-cel position, rotation, scale, and opacity editing through existing pose machinery. Keep transform interpolation separate from cel identity: initial drawing exposures use held transforms; any optional transform tween must be explicit and must not blend different drawings.

### Onion skin and editing scope

Use existing ordering, range, tint, opacity, and visibility controls. In drawing-key mode, sample distinct neighboring exposures rather than repeated frames of the current held cel. Preserve explicit frame-based sampling if already offered. Blank keys remain timing boundaries but contribute no pixels. Other layers retain their own timing and visibility rules.

Show which drawing and exposure are being edited. The lasso edits pixels within that cel; the whole-drawing transform changes its pose. Make these separate tools. Selection is transient; pixel changes are undoable. Whole-drawing transforms should retain source pixels until an explicit raster edit/resample requires otherwise.

## 4. Data ownership and compatibility

Use the existing image-figure representation as the rendered/persistent carrier. Add a versioned drawing metadata record and drawing-layer marker, validated at import. Exact field names must follow existing schema conventions after inspection.

Drawing metadata must define stable cel identity, pixel dimensions, pixels-per-scene-unit, logical canvas origin, crop offset/bounds, and schema version. Empty cels need an explicit valid representation; never create an invalid zero-size image. Keep the scene-space origin stable when cropping or extending ink bounds so drawings do not jump.

Distinguish layer identity, exposure/key identity, cel identity, sprite definition identity, and pose/object identity. A hold references one cel. A copied key receives a new cel identity and an independently editable definition, even when immutable encoded bytes are initially shared. Do not blindly allocate new object UIDs per key: verify the existing evaluator, layer membership, selection, and onion anchoring requirements first.

Copy-on-write may share immutable pixel data until the first edit, but mutation must detach before touching shared pixels. Clipboard, layer duplication, nested movieclips, cross-project paste, undo, and redo must all obey this invariant. Retain referenced assets while reachable from document, history, clipboard, or pending work; collect them when those owners release them.

Native STYK persistence must preserve drawing metadata and raster pixels. PIV/STK compatibility is visual sprite compatibility, not a promise that external editors retain drawing-layer semantics. SVG embeds raster artwork rather than manufacturing vector paths. An external sprite without drawing metadata remains an ordinary image unless explicitly converted.

Resolution defaults to two pixels per scene unit for new cels; offer 1×, 2× and 4× with current cel dimensions. Changing the default affects new cels only. An explicit resample command handles existing cels and states that enlarging raster pixels cannot recover lost detail. Camera zoom and stage resize must not silently resample artwork.

## 5. Runtime and rendering

### Surface ownership

Introduce a document-scoped drawing resource owner, keyed by cel identity and pixel revision. It owns editable surfaces, immutable snapshots, encoded revisions, decode/encode jobs, dirty rectangles, and disposal. DOM nodes, canvases, ImageBitmaps, GPU textures, promises, and worker handles never enter document data or history records.

Start with a bounded full editing surface and tile-based undo; do not describe this as sparse tiled storage. Use 64×64 tiles initially, then measure readback overhead. Grow the surface around the view as painting moves beyond it, with no fixed stage-sized drawing boundary. Copy pixels in a worker, translate image anchors, and undo growth with its stroke. Bound allocation and reject oversized edits without clipping paint. Sparse tiled storage remains a future architecture decision.

Only the actively edited cel needs a mutable surface. Keep recently visited immutable decoded cels in a byte-budgeted cache, not a fixed eight-frame cache. Dirty surfaces cannot be evicted until their latest committed pixels are safely retained elsewhere. When memory is exhausted, apply bounded backpressure with feedback; never discard dirty work.

### Live presentation

Add a direct image resource path within the existing scene ordering/compositing system, avoiding full compatibility rerasterization for each brush sample. Track dirty rectangles and upload at most once per presentation frame when possible. Verify the actual WebGPU copy API and resource limits before assuming rectangle uploads are supported as proposed.

The live drawing must obey layer order, camera, pose transforms, opacity, clipping, onion ordering, and Canvas fallback. Erasing must reveal the correct layers beneath it immediately. Do not put the authoritative painted picture into a topmost overlay. A cursor/predicted-tail overlay is allowed only if it cannot change stored pixels or misrepresent erasing/compositing.

Map pointer coordinates through CSS scaling, device pixel ratio, viewport pan/zoom/rotation, camera, cel pose, and crop origin. Unit-test inverse mappings, including mirrored/scaled drawings. View rotation is presentation state and must not alter saved artwork or exported camera output.

### Input and brush engine

Use pointer capture, coalesced samples when available, and an ordinary pointer-event fallback. Resample by distance for consistent dab spacing; preserve pressure and timestamps. Support zero-length taps, slow curves, fast strokes, pressure release, mouse input, and configurable size/opacity pressure curves. Keep stabilization optional and bounded.

Define opacity versus flow explicitly: stroke opacity controls the stroke's overall contribution; flow controls accumulation of dabs. Test overlapping dabs, repeated passes, and semitransparent erasing. A temporary bounded stroke surface may be needed to implement the chosen compositing rule correctly.

Map pen eraser/buttons where the runtime exposes them; allow keyboard alternatives. Ignore touch painting while a pen is active and retain deliberate touch navigation. Predicted samples are optional preview only; authoritative pixels/history contain real samples only.

Pointer-up commits once. Escape/pointer cancellation/lost capture roll back the uncommitted stroke. Navigation, workspace switches, save, and play explicitly finish a valid active gesture before proceeding. Test blur and device interruption so no stroke remains stuck or commits twice.

Keep the main-thread path limited to bounded input and brush work. Measure Canvas readback and stamping on target devices; do not assume Chromium always accelerates the chosen canvas. If per-frame work exceeds the budget, move raster work behind bounded worker messages while preserving immediate input feedback and cancellation.

## 6. History and asynchronous publication

### Unified undo

One completed stroke is one command in the existing chronological history. Store the original pixels of each touched tile once plus required cel/crop metadata. Undo/redo must restore exact RGBA bytes. Fill, selection transform, resolution change, and first-stroke cel creation each have explicit atomic commands.

Adapt history dispatch deliberately: existing editor undo is synchronous. If restoring an evicted cel requires asynchronous preparation, add a serialized history-preparation path before moving the history cursor, or retain sufficient CPU tile state for synchronous application. Never let an awaited drawing restore race a later timeline command. Failed preparation must leave document and history position unchanged.

Preserve drawing history across frame changes and mixed operations such as stroke → duplicate key → stroke → retime → undo. Never add a separate drawing undo stack. A new edit clears redo and releases unreachable drawing resources.

Increase count allowances for small drawing commands only after measurement, while maintaining a shared byte budget and chronological eviction. Account for both undo and redo retained bytes, shared snapshots, and temporary compression buffers. Define oversized-command handling before mutation: reject with guidance or use a bounded undo representation; do not silently create an unbounded history entry.

### Pixel revisions and PNG encoding

During a session, committed pixels may be newer than the encoded PNG carrier. A completed stroke immediately advances the semantic document revision and marks unsaved state. Encoding is derived publication, not another user edit or undo entry.

Use a bounded scheduler with one latest requested revision per cel. Each job carries document generation, cel identity, and pixel revision. Encode an immutable snapshot, never a concurrently changing surface. Discard stale results after undo, deletion, replacement documents, or later strokes. Bound retained snapshots and queued work.

Frame flips must not wait for PNG compression. Revisit committed pixels directly when resident; decode safely when needed. Workers requiring encoded assets wait for matching publication or receive a supported immutable pixel transfer. They must never claim a newer document revision while displaying older drawing pixels.

Save, recovery, clipboard capture, playback startup, and export need an explicit revision barrier: finish the active gesture, obtain all required committed drawing revisions, and snapshot through existing bounded transport. Cancellation or further mutation follows the existing exporter contract. No operation silently uses an old PNG. Do not mark the document saved until the exact snapshot is committed to disk.

A failed encode retains dirty pixels and unsaved state, reports the failure, and allows retry. Recovery must capture committed strokes even if normal idle encoding has not completed. Extend the encoder via an appropriate worker lifecycle; do not reuse the single-shot import worker without changing and testing that contract.

## 7. Fill and selection

Run flood fill off the UI thread with bounded input, output, and queue sizes. Support tolerance, expansion, gap closing, and cancellation. Sample-all-layers reads a revision-consistent composite of eligible visible artwork, excluding onion skins and editor overlays, then writes only to the active cel. Reject stale fill results. Define behavior for transparent boundaries and semitransparent edges; test against halos and leaks.

Lasso creates a transient mask. Move/scale/rotate previews do not repeatedly resample committed pixels. Apply one resample on commit, with one undo command; cancellation restores exact pixels. Clip/expand within the declared paint bounds and preserve scene-space alignment. Support copy/cut/paste of selected pixels through existing clipboard routing, without hijacking timeline-focused shortcuts.

## 8. Implementation milestones and exit gates

### M0 — Contract and integration spike

- Confirm actual command routes, serializers, validation, asset reachability, renderer APIs, and nested-document lifecycle.
- Document precise schema and runtime ownership in `docs/DRAWING.md`.
- Trace save/recovery/clipboard/play/export callers and design their publication barrier.
- Exercise one sprite-backed cel through native save/reopen, crop placement, and layer ordering.
- Prove independent key duplication and the proposed history preparation strategy.

Exit: the data model fits existing sheet/evaluator semantics; no unresolved mutable-sharing or persistence gap. Do not start a full brush UI until this passes.

### M1 — Safe end-to-end vertical slice

- Add drawing layers, blank/independent copied cels, a hard brush, eraser, exact tile undo, and direct live rendering with fallback.
- Implement pixel revisions, bounded encoding, dirty-state handling, save/recovery barriers, and disposal immediately.
- Expose minimal tools behind a development gate until persistence is reliable.

Exit: create drawing, paint, flip, copy, edit copy, undo/redo, save, reopen, and recover pending publication with exact expected pixels. Erasing reveals underlying content; failed saving preserves the previous file and live work.

### M2 — Timeline and workspace

- Add Draw workspace, layer targeting, explicit frame actions, shortcut integration, exposure highlighting, and cel thumbnails.
- Support retiming, multi-layer validation, layer duplication/deletion, clipboard, and both timeline views.
- Integrate distinct-cel onion skin and whole-drawing pose editing.

Exit: every behavior in section 3 has focused coverage. Unrelated figure layers retain their contents/timing, and drawing duplicates remain independent through save/reopen.

### M3 — Drawing usability

- Add pressure, soft brushes, flow/opacity behavior, stabilizer, presets, size shortcuts, eyedropper, and pen eraser support.
- Add view rotation, lasso move/scale/rotate, pixel clipboard, and worker fill.
- Inspect the real desktop UI with a mouse and available pen hardware; test fast strokes and rapid frame flipping.

Exit: no stuck gestures, permanent predicted marks, repeated transform degradation, fill races, or incorrect coordinate mapping. Record actual tablet limitations rather than claiming universal support.

### M4 — Compatibility and lifecycle

- Verify prepared playback, thumbnails, movieclip editing, native persistence, clipboard, and all advertised export formats.
- Test device loss/fallback, worker failure/restart, cancellation, document replacement, history eviction, and closure during encoding.
- Validate metadata and image-size limits on malformed imports.

Exit: exact-revision output is demonstrated; unsupported compatibility cases produce clear errors without corrupting documents. Do not advertise zero exporter changes or editable PIV round trips without evidence.

### M5 — Performance, polish, and release readiness

- Measure the fixtures below, then tune memory budgets, tile size, prefetch, brush queues, and history counts.
- Finish accessibility, tool cursors, focus/shortcut behavior, errors, help, and documentation.
- Add one concise user-facing Unreleased changelog entry only when the feature is complete.

Exit: measured results meet the agreed targets on declared hardware, lifecycle regressions pass, and remaining limits are documented. Implementation does not authorize publishing a release.

Commit each coherent milestone only after its relevant checks pass. Review/stage only task-owned files; preserve unrelated work. Do not commit known-broken intermediate states.

## 9. Verification and performance evidence

### Required behavioral coverage

- Hold editing changes all frames of that exposure and no other cel.
- Blank/copy insertion preserves earlier exposures, later keys, and unrelated layers.
- Copied keys, layer duplicates, and cross-document pasted cels never share mutable pixels.
- First-stroke creation, erasing to empty, fill, lasso edits, and mixed timeline history restore exact expected pixels and timing.
- Repeated undo/redo works after surface eviction, asset collection, and worker restart.
- Out-of-order encoding, undo during encoding, deletion during fill, and replacement-document completion cannot publish stale results.
- Manual save, autosave/recovery, close/save, play, thumbnails, and exports observe the intended committed revision.
- Rendering matches layer order and transforms under pan, zoom, rotation, camera movement, high DPI, crop changes, and Canvas fallback.
- Native save/reopen preserves editability. PIV/STK reproduce supported visual sprite output. SVG, image sequences, GIF, and video retain timing, placement, alpha, and color within format limits.
- Hidden/locked layers, blank spans, first/last keys, nested movieclips, stage resize, and mixed figure/drawing scenes follow documented behavior.
- Memory-pressure rejection and save cancellation preserve existing files and unsaved pixels.

Use deterministic pixel tests for history and brush rules; use visual tolerances only for renderer sampling/antialiasing. Include actual desktop/browser inspection for visual work and real native codec round trips for interchange claims.

### Representative workloads

Measure before and after on the same hardware, runtime, viewport, brush settings, and quality mode:

1. 640×480 pencil animation with long holds and rapid key flipping.
2. 500 distinct 1920×1080 line-art cels, plus a separate dense/full-frame painting fixture.
3. 2× resolution drawing with large soft brushes, long strokes, erasing, and full-frame fills.
4. Multiple drawing layers over a representative dense stick-figure scene.
5. Sustained paint/flip/undo/save sessions, forcing decode eviction and encoding backlog.

Record stroke processing and presentation latency p50/p95, main-thread stalls, warm/cold cel-flip latency, playback cadence, encode backlog, save barrier duration, CPU/decoded/GPU/history bytes, and long-run memory recovery. Distinguish pointer-to-submit instrumentation from actual input-to-photon measurements. GPU/pen performance cannot be established by CPU throttling alone.

Initial engineering targets, to validate in M0/M1 and report against named hardware:

- Ordinary brush processing stays within a 60 Hz frame budget; target p95 input-to-render-submission within two refresh intervals for the baseline hard-brush fixture.
- Warm cel flips target p95 under 50 ms and do not await PNG encoding; report cold flips separately.
- Playback meets document cadence after bounded preparation; report stalls rather than hiding skipped ticks.
- No unbounded queue/cache growth; repeated fixture cycles settle within configured budgets plus measured transient headroom.
- No avoidable main-thread tasks over 50 ms from drawing publication, serialization, or history preparation in baseline workloads.

If a target fails, identify the owning bottleneck and fix or explicitly scope the supported workload before declaring readiness. Do not silently reduce saved/exported drawing resolution to hit preview targets.

### Commands and documentation

Run `npm run check` after JavaScript changes, focused behavioral tests during each milestone, and `npm test` for integration readiness. Use `npm.cmd` if the workstation's PowerShell launcher fails as described in AGENTS.md. Add real browser/desktop checks for rendering and input; run relevant Python/native tests when changing codecs. Run `npm run changelog:check` when adding the completed feature entry.

Update `docs/DRAWING.md`, `docs/TIMELINE.md`, `docs/animation-modes.md`, `docs/ARCHITECTURE.md`, renderer/export/native-format contracts, and user help where their behavior changes. Record fixtures, hardware, runtime versions, results, and remaining limits under `artifacts/`. Older reports do not certify this implementation.

## 10. Completion definition

The feature is complete when a user can create a drawing layer, draw multiple strokes, hold/copy/blank/retime cels, combine them with stick figures, edit with onion skin and selection tools, undo across frames, save/recover/reopen, and export the exact committed result without shared-copy corruption or unbounded memory. Brush feel must be demonstrated on available hardware; vector-editing parity is explicitly outside scope.
