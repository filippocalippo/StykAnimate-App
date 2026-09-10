# Connected figure editing: architecture and verification

Measured on 2026-09-10 using the four exact PIV files in C:/Users/aleri/Downloads, installed Chrome headless, WebGPU on NVIDIA Lovelace, and a 1600 × 1000 viewport. Original files were only read. These are measurements on this machine, not a promise of a fixed frame rate on arbitrary hardware or documents.

## Final real-file results

First editor-operation duration in milliseconds, including synchronous change listeners. The last column measures the largest requestAnimationFrame interval during the complete editing and 50-seek workload.

| Advanced workload | Frames | Figures / segments | Connected parts moved | Selection | Pose commit | Move commit | Max rAF interval |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Uriel Nemesis 2 | 132 | 439 / 13967 | 263 | 2.5 | 18.2 | 13.3 | 20.9 |
| Akane (1) | 826 | 201 / 6239 | 86 | 2.1 | 16.0 | 10.5 | 13.9 |
| Akane (2) | 194 | 179 / 18817 | 172 | 0.9 | 17.1 | 10.8 | 20.9 |
| Akane (3) | 1479 | 643 / 15054 | 105 | 2.3 | 16.9 | 11.0 | 34.8 |

All four final Advanced runs and both final Simple runs passed physical joint dragging, a single undo command, and exact pose restoration. They recorded no main-thread long tasks of 50 ms or more. Uriel originally measured 3,072 ms for a pose commit and 2,898.8 ms for a move commit; the earlier optimization pass measured 27.5 / 26.6 ms.

Fresh-import tests perform the first physical gesture before any model selection, pose, or translation command. The scene must first be drawn to locate a visible handle. Each test includes 24 physical pointer movements and exact undo.

| Workload | Pointer-down to render submission (ms) | Pointer-down to GPU completion (ms) | Release to GPU completion (ms) |
| --- | ---: | ---: | ---: |
| Uriel Nemesis 2 | 5.2 | 9.0 | 24.5 |
| Akane (1) | 5.4 | 9.4 | 29.8 |
| Akane (2) | 6.4 | 11.7 | 33.5 |
| Akane (3) | 7.0 | 13.2 | 32.8 |

GPU completion uses queue.onSubmittedWorkDone. It includes outstanding queue work and is not a hardware timestamp or a monitor scan-out measurement. Some movement/release samples took longer than the initial press, up to 40.4 ms across these runs.

## History pressure and retiming

The 1,479-frame / 105-part synthetic case now moves a shared marker in 3.3 ms and scales all markers in 3.3 ms. The audit measured 59.3 ms and 486.9 ms respectively. The new move command charges 646,454 bytes instead of 31,487,862 bytes, retaining one shared sequence and one native sample rather than 105.

A 100-operation stress run crosses the existing 48 MiB history budget and exercises undo/redo while entries are evicted. Repeated retiming measured p50 1.1 ms, p95 1.8 ms, and maximum 9.3 ms. It retained 77 commands using 49791968 accounted bytes. An intermediate run exposed a 1,265 ms source-pruning freeze; pruning now traverses shared sequences once and skips history when every generated source is still live.

## Architecture changes

- Shared pose sequences survive batch move, scale, duplicate, delete, easing, undo, redo, worker transfer, and native saving. Independent edits use copy-on-write. Validation and history accounting visit shared storage once. Whole-track selection retains shared key-ID sets and selected-key lookups use an index.
- Pose sampling restricts interpolation to requested figures and their attachment ancestors at both endpoints. Captured pose sources contain only edited figures and the ancestors needed to reconstruct their world positions. Unknown authoritative fields remain independently owned; runtime geometry is omitted before cloning.
- The retained geometry cache matches persistent figure IDs across insertion, deletion, and slot/order changes. Unchanged points and compiled artwork survive metadata rebinding. Joined figures may reuse alternate poses only when their exact parent anchor matches. Caches remain bounded.
- Geometry, artwork signatures, polygon/vector compilation, and onion geometry expose cooperative checkpoints inside dense figures. Dense editing seeks prepare an unpublished scene, then activate it only if the document, frame, revision, and view still match. Simple working-frame notifications finish before preparation captures its revision. Pointer gestures cancel pending work and remain usable immediately.
- Definition revisions preserve exact artwork signatures across ordinary edits while invalidating in-place definition changes. Commit-time property comparisons use object/definition indexes and avoid re-reading unchanged appearance. X/Y property projection shares evaluated coordinates and restricts coordinate geometry to attachment ancestors.
- Playback transfer yields while editing or preparing a frame. Thumbnail work pauses during gestures and preparation. Animation undo and known native-frame undo send worker patches. Full snapshots remain for structural changes and uncertain history.
- Inspector updates retain DOM controls, focus, entered values, and disclosure state. Timeline scroll mapping avoids repeated layout reads. Large-scene handle picking uses a spatial index for known uniform projections, preserving exact hit boundaries, painter order, and nearest-hit ties.
- Persistent timeline rig membership is distinct from temporary attachments. Consistent parent identities form compact shared rows; a pickup/drop or switch between parents does not permanently merge independent rigs. Motion still follows the current native join graph. In Akane (2), the largest current attachment component includes multiple stable rigs and a temporary host, which remain individually addressable in the timeline.

## Native-file compatibility

Native STYK saving packs pose key arrays into a versioned shared-sequence table. The live editor expands that table back to its existing immutable-array model before validation. Legacy version-1 files remain readable. New compact animation version-2 saves require this updated reader; older builds cannot read the new pose-sequence representation. Pivot PIV export keeps its existing native format.

Binary save/reopen testing confirms one shared sequence, exact retimed joints at several ticks, and unchanged animation values. Corrupt references are rejected. Nested movieclip documents and Simple draft baselines use the same storage boundary.

## Verification and remaining limits

Full unit suite: 1,208 passed, zero failures. Syntax checks: 555 JavaScript files, zero errors. Regression coverage includes shared edits, independent member changes, collision atomicity, source collection under history pressure, ancestor remapping, coordinate-cache invalidation, cooperative dense-figure work, malformed stored references, picking parity, and worker priority.

Browser checks passed native save/reopen, Simple/Advanced synchronization, connected selection/copy/paste, timeline retiming and expansion, 20,000-row virtualization, property controls, thumbnail patches, cancellation, pause/resume, and starting a drag during pending preparation. GPU artwork verification produced zero pixel differences in 48 cases covering sharing, eviction, retiming, pose changes, and staged activation.

No multi-second editing freeze occurred in the final measured workloads. This does not establish universal 60 FPS or zero latency: final Advanced authored seeks took up to roughly 75 ms through GPU completion. The extended Simple Akane (3) run reached 130 ms seek completion and a 69.5 ms rAF interval while its cooperative tasks remained below 50 ms. Import, very large individual rasterization/triangulation calls, other hardware, and unlimited document sizes are not covered by a fixed latency guarantee. Profiling, garbage collection, and concurrent machine load influence timings.

## Reproduction and artifacts

Run the local server, then benchmarks sequentially:

```powershell
node scripts/serve.mjs
node scripts/benchmark-connected-editing.mjs 'C:/Users/aleri/Downloads/tdd2 uriel nemesis 2.piv' uriel-verified
node scripts/benchmark-cold-pointer.mjs 'C:/Users/aleri/Downloads/tdd2 uriel nemesis 2.piv' uriel-cold-verified
node scripts/benchmark-connected-transactions.mjs
node --test tests/*.test.mjs
node tests/editing-architecture.browser.mjs
node scripts/check.mjs
```

Raw reports, aligned CPU profiles, screenshots, and logs are in artifacts/connected-editing/. Final real-file runs use *-verified; the history test uses transactions/report.json. Intermediate profiles are retained so newly discovered regressions and their fixes remain reviewable.
