# Desktop architecture

StykAnimate separates the editable Pivot document, background work, and presentation. Changing the renderer or transport should not change file semantics or editor commands.

## Document and commands

`editor.mjs` and its builder/range extensions operate on native figure IDs, object UIDs, segment record order, joins, media tables, and keyframes. History records affected state. Selection, editor visibility/locks, viewport transforms, and renderer caches are distinct from animation data. Shared definition edits propagate through instances and remain undoable. Rig topology traversals avoid recursive stack growth and repeated full-tree scans.

`src/pivot/` holds the established evaluation, validation, background and geometry semantics. Incremental geometry carries changed object slots without retaining a chain of prior scenes. A live whole-figure drag retains its geometry and changes only per-object GPU translations; the model commits the final coordinates once. Joint/rig edits update affected objects and joined descendants.

## Import and native codec

Electron reads selected source files through its isolated bridge. A persistent loopback codec process uses the supplied PIV/STK readers and writers. The app-specific modern reader bulk-unpacks numeric arrays and omits obsolete scalar-edit binding allocations. Optional `orjson` accelerates large response encoding; the standard-library path remains available. This does not replace the binary grammar.

The import worker performs fetch/JSON parsing. `document-transport.mjs` transfers bounded document fragments rather than cloning one entire expanded scene into the UI. Its default packet estimate is 256 KiB with a 3 ms preparation budget and receiver acknowledgments. Large strings, pose arrays and records are split; unknown fields and numeric values remain intact. The same transport supplies playback snapshots and native document exports.

The backend source/document cache has 24 entries and a 384 MiB budget. Source imports are limited to 128 MiB; decoded/native documents to 256 MiB. A native document is retained once because it already contains original source bytes. These are cache/input limits, not a promise that total application working set stays under those values. See [backend contract](../backend/README.md).

## WebGPU and prepared playback

`renderer.mjs` compiles root-local line, circle and polygon records into GPU storage buffers. WGSL performs primitive coverage, color gradients, transforms and clipping. Object translation/opacity/visibility are separate records. Cached compatibility textures preserve complex Pivot compositing at the object boundary, including glyph paths, sprites, outlines and isolated opacity. They have a 4,096-pixel dimension cap, so extreme zoom has a finite detail limit. The complete scene is not flattened into one texture.

`playback-worker.mjs` evaluates exact native ticks, compiles typed primitive packets, and rasterizes compatibility objects with OffscreenCanvas. `playback.mjs` holds a bounded CPU packet LRU; the app configures 128 MiB / 72 packets. `prepared-frames.mjs` keeps a separate GPU LRU of 128 MiB / 48 packets, matching the worker's maximum frame size. Each GPU packet uploads once; cached playback binds retained buffers and submits without main-thread scene evaluation or tessellation. Document revisions and resource/device changes invalidate the relevant caches. Missing packets hold the transport for preparation rather than silently skipping native output ticks. Background assets and the editor renderer have separate lifetimes and budgets.

Compatibility textures are cropped to the camera-visible stage with a sampling guard, preserving their original pixel grid and individual figure identities. Raster resolution is rounded once, after applying the native camera to the physical viewport scale. Zoom changes update worker view options without retransmitting an unchanged document. Scrubbing keeps one preparation request in flight, shows completed previews, and coalesces newer pointer positions to the latest requested tick.

An oversized prepared packet is rejected explicitly rather than bypassing its memory budget. Compatibility-heavy frames can therefore need additional preparation or fail their budget check; sampled corpus success does not establish coverage of every frame in a large imported project.

The virtualized timeline draws visible exposures and labels, with a separate playhead. Scrubbing requests worker-prepared frames; frame-local changes can update the worker mirror without retransmitting every keyframe. The editor schedules rendering when state changes or playback runs, with no permanent idle rendering loop. See [renderer details and benchmarks](renderer.md).

## Saving, recovery and exports

`DocumentExporter` receives the live report directly. Calling `editor.serialize()`, `structuredClone(report)`, or `JSON.stringify(report)` first would reintroduce a full UI pause. Bounded snapshots reach a dedicated worker, which normalizes the document, validates it, serializes it, and requests native output. Only derived keyframe-object `runtime_segments` caches are omitted. A revision change or active edit aborts the snapshot; recovery is rescheduled after the next idle period. Native STYK stores original source bytes and digest metadata so unchanged source export remains possible after a backend restart.

The worker returns a Blob. `native-files.mjs` writes or reads it through acknowledged 256 KiB IPC chunks, without whole-file ArrayBuffer/base64 conversion. Desktop main stages output and atomically replaces the destination only after completion. Cancellation preserves the previous file. Recovery uses the fixed desktop profile; browser recovery uses IndexedDB. See [document export contract](document-exports.md).

`ExportFrameRenderer` receives bounded document chunks and evaluates/rasterizes export frames in a worker. Current-frame images, sequences and videos use this shared path, including No smoothing, Smooth edges and supersampled Smooth sprites. SVG retains paths and embedded raster assets. Animation image compression, GIF quantization and ZIP assembly run in an encoding worker with one source frame in flight. Document replacement or cancellation stops the rendering job.

Desktop video streams PNG frames in acknowledged chunks to the bundled FFmpeg encoder. VP9 WebM preserves transparency; MP4/AVI/WMV use Pivot's black matte. The browser has an opaque WebCodecs VP8/VP9 fallback with exact timestamps and a local muxer. Windows AVI can instead stream BGR24 to isolated 32-bit/64-bit helpers using genuine installed VFW compressors and their configuration dialogs. Capability probing describes the actual provider, codecs, alpha behavior and limits; no hosted encoder is required. See [export formats](EXPORT-FORMATS.md), [image exports](image-exports.md) and [installed Windows codecs](WINDOWS-CODECS.md).

## Workspace and desktop boundary

Custom HTML/CSS provides compact editable controls, native keyboard/text behavior and a consistent neutral palette. The animation scene uses the custom GPU canvas. Layers, Properties and Timeline can float, move, resize and redock without changing the document. `initWorkspaceLayout({preferences,onPersist})` restores normalized geometry; settled changes are debounced and asynchronous writes are ordered. `flushPreferences()` lets close/tests await the last write.

Electron uses context isolation, sandboxed renderer code, and no renderer Node globals. Native IPC exposes specific file/stream/window/preference operations, not arbitrary filesystem commands. Workspace preferences live in a fixed, atomically written user-data JSON file capped at 16 KiB. They and recovery survive a restarted process even though its loopback origin changes.

Windows source execution and packaged snapshots are verified. A distributable includes the frozen codec sidecar, current web assets, source grammar, and licenses. Rebuild and verify the package after source changes; earlier smoke reports do not certify newer bytes. macOS/Linux targets require their own builds and actual platform verification.

## Reproducible evidence

| Concern | Command | Report |
| --- | --- | --- |
| Prepared UI playback/drag | `node tests/renderer-ui-performance.mjs --fps=60` | `artifacts/renderer-ui-performance-60fps.json` |
| Native imported-rig edits | `node tests/renderer-edit-profile.mjs "path/to/project.piv"` | `artifacts/renderer-edit-profile/report.json` |
| Whole-app edit/autosave scheduling | `node tests/edit-freeze-profile.mjs "path/to/project.piv"` | `artifacts/edit-freeze-<project>/report.json` |
| Source-bearing save/restart/export | `node tests/document-export-browser.mjs "path/to/project.piv"` | `artifacts/document-export-browser*.json` |
| Exact native file streaming | `npm run test:streams:desktop` | `artifacts/native-streams-smoke.json` |
| Workspace process restart | `npm run test:preferences:desktop` | `artifacts/desktop-preferences-smoke.json` |
| Sampled prepared raster corpus | `node tests/renderer-corpus.mjs --prepared` | `artifacts/renderer-corpus-prepared/summary.json` |

The UI tests use the local development server; profile scripts accept `STYK_URL`. Artifacts name the fixture, phase, timing scope, and observed limitations. Long-task absence, total job duration, CPU submission, GPU completion, and display latency are separate measurements.
