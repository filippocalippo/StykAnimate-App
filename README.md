# StykAnimate-webapp

A local desktop animation editor with a custom WebGPU canvas, Figma-style controls, and an Animate-style timeline. It opens real `.piv` and `.stk` files through the supplied Pivot parsers and writers. Editing, decoding, saving, and rendering stay on the machine.

## Run

On Windows, double-click **`../Start-StykAnimate-webapp.cmd`**. The launcher prefers `release/win-unpacked/StykAnimate.exe`; keep that entire directory together. A packaged build includes its codec runtime and does not require a separate Python or Node installation. `release/baseline-0.1.0/` preserves the earlier verified package.

The verified Windows **0.2.0** release includes separate Setup and Portable executables in `release/`. Native WebGPU, PIV/STK import, saving, recovery, and workspace persistence were exercised in the packaged application. See [release notes](docs/RELEASE-0.2.0.md) and [package verification](artifacts/windows-release-0.2.0.json). For source development:

```sh
npm ci
python -m pip install -r backend/requirements-fast.txt
npm start
```

Development requires Node.js 22+ and Python 3.10+. The optional compiled JSON encoder and C++ native frame scanner accelerate large imports; validated Python fallbacks remain available. Build the scanner with `npm run build:frame-scan` on supported hosts. Set `STYK_PYTHON` to choose an interpreter. With dependencies already installed, Windows can run the current source directly using `node_modules\electron\dist\electron.exe .` from this directory. `npm run serve` starts browser development at `http://127.0.0.1:47831`.

Windows desktop execution is verified. macOS and Linux have build targets, but have not been executed here. Build the sidecar and distribution on each target OS:

```sh
npm run build:sidecar
npm run pack
npm run verify:package
# Installers, on the matching host:
npm run dist:win
npm run dist:mac
npm run dist:linux
```

## Editing

These features describe current source. Package coverage applies only to the exact release artifact verified above.

- Import PIV versions 2–5, reusable STK figures, or self-contained STYK projects. Native timing, camera transforms, sprites, text outlines, polygons, gradients, and joins retain the established Pivot document semantics.
- Select or marquee several figures, move a group, align, rotate, scale, mirror, reorder, join, duplicate, or use the clipboard. Pose joints with fixed lengths or Ctrl-drag to stretch.
- Hold **R** for pose-local Handle Edit, or **Ctrl+R** for its fixed-point mode. The separate **Rig** tool edits the shared figure definition and static construction joints. Create lines, circles, joint-bound polygons, editable text and sprites; split/unsplit, mirror or duplicate branches, delete a joint, change the origin and edit styles with undo/redo.
- Choose **Simple** or **Advanced** in Settings. Simple provides Pivot-style thumbnails, inbetween sliders and stored-frame Add/Update/Discard behavior. Advanced provides independent layers, Scene/Camera tracks, sparse pose/property keys, blank keys and frame ranges. Both have virtualized navigation, native timing, clipboard and Insert Inbetween. Cross-document frame clipboard persists on desktop.
- Float, move, resize, and dock Layers, Properties, or Timeline. Drag a panel grip/title, resize its edges, or use the dock target. Arrow keys move a focused grip; Enter docks and Home resets it. Desktop layout preferences and recovery copies survive process restarts.
- Save STYK projects with recoverable working poses and native Recent Files. Export editable PIV/STK; PNG/JPEG/GIF/SVG frames or numbered sequences; GIF/APNG animation; WebM with VP9 transparency; MP4, WMV and AVI. Windows additionally exposes installed 32/64-bit VFW codecs and real Configure dialogs. Sampling modes include no smoothing, smoothing and 2× sprite filtering. See [format/platform coverage](docs/EXPORT-FORMATS.md).
- Settings includes native canvas handle/onion preferences, timeline mode and 27 supplied interface language choices. Translation is partial: modern controls can remain English. Language changes preserve animation data, history and canvas/time direction; [coverage and boundaries](docs/LOCALIZATION.md) are explicit.

The compact neutral UI uses blue selection accents. Canvas handles follow Pivot colors: red movable joints, orange origins, blue unselected handles, and white joined origins. Static construction joints appear in rig tools. Figures can extend beyond the artboard while editing; playback/export retain document clipping.

Double-click an origin to select its connected figures (Shift adds the group to the selection). Double-click a node to select its descendant branch and attached figures without recoloring the artwork; its inspector enables branch-wide edits. Copy/paste or Duplicate preserves the branch pose, internal polygons, media, and joins; pasted branches use independent figure definitions. Click a different node or clear “Apply to branch” to return to single-node editing.

See [implementation coverage](docs/IMPLEMENTATION.md) and the [Pivot acceptance checklist](docs/PIVOT_PARITY.md) for remaining work. Complete Pivot parity, exhaustive native pixel equality, and zero latency on arbitrary hardware are not established.

## Performance evidence

The architecture separates document/history, visible gesture previews, retained GPU resources and worker jobs. Whole-figure dragging updates GPU transforms; affected joint branches are reevaluated as needed. Prepared playback reuses GPU packets. The C++ frame scanner and binary import transport avoid expanding full native pose JSON; editor validation/indexing yields between bounded work slices. Imports, export snapshots, recovery, native file transfer and asynchronous layer migration use bounded, acknowledged chunks. [Architecture details](docs/ARCHITECTURE.md) describe the separate document, CPU, and GPU caches.

Historical development snapshots recorded on the available Windows / NVIDIA Lovelace machine, with the exact run boundaries in each artifact. These are not measurements of the final combined build:

| Workload | Measured result | Evidence |
| --- | --- | --- |
| 1,000-figure drag, 59 samples | Renderer CPU p95 **0.6 ms**; zero geometry bytes uploaded; one draw call | [UI benchmark](artifacts/renderer-ui-performance-60fps.json) |
| Prepared 1,000-figure playback at 60 FPS | **59.88** warm effective FPS; renderer CPU p95 **0.2 ms**, editor render-section p95 **0.4 ms**; no skipped ticks in the sampled run | [UI benchmark](artifacts/renderer-ui-performance-60fps.json) |
| Akane frame 1478: 643 figures / 15,054 segments | Editing a 105-object connected rig: mutation + geometry + GPU submission p95 **5.7 ms** | [Incremental edit profile](artifacts/renderer-edit-profile/report.json) |
| Complete Akane playback, 1,872 output ticks at 16 FPS | All ticks submitted in order; **117.264 s** versus **116.938 s** nominal first-to-last, interval p95 **69.5 ms**, p99 **70 ms**; isolated maximum **363.1 ms** | [Full-animation verification](artifacts/edit-freeze-16-akane-vs-akato-segundo-round--3--full-playback-budgeted/presentation-summary.json) |
| Akane recovery autosave | Earlier **8.84 s** animation-frame gap removed; **zero UI long tasks**, animation-frame interval p95 **7.0 ms** in the measured autosave phase | [Current profile](artifacts/edit-freeze-16-akane-vs-akato-segundo-round--3--after-worker/report.json), [before](artifacts/edit-freeze-16-akane-vs-akato-segundo-round--3-/report.json) |
| Akane backend import and encoded response | **10.92 → 4.84 s**; binary decode itself remained about **4.21 s** | [Before](artifacts/backend-akane-profile.json), [after](artifacts/backend-akane-profile-after.json) |
| Optional C++ Akane decode component | **668.8 ms**, including **11.9 ms** native frame wrapper; excludes HTTP, JavaScript materialization and rendering | [Component diagnostic](artifacts/backend-akane-cpp-scan.json) |
| Native 200 MiB Blob transfer | File save **2.37 s**, recovery write **2.11 s**, read **1.28 s**; zero renderer long tasks and exact SHA verification | [Native streaming smoke](artifacts/native-streams-smoke.json) |

Matched original-Pivot versus current-app import/input/full-playback acceptance remains open in the [full-goal ledger](docs/GOAL-ACCEPTANCE.md). These measurements cover different phases; they are not interchangeable end-to-end latency figures. A browser long task is a task over 50 ms. CPU submission excludes GPU completion and display scanout. The Akane audit found and fixed repeated speculative rasterization that caused sustained dense-scene stalls; rare scheduling gaps remain. Large imports and background saves can still take seconds; cache misses can require playback preparation. Prepared playback supersedes the initial main-thread playback implementation.

## Verify

Run core checks from this directory:

```sh
npm run check
npm test
python -m unittest discover -s backend -p test_server.py
node scripts/test-reference.mjs
```

Start `npm run serve` for UI tests. The following groups reproduce the main acceptance paths; they use installed Chrome or Playwright Chromium:

```sh
node tests/creation.browser.mjs
node tests/builder.browser.mjs
node tests/rig.browser.mjs
node tests/timeline.browser.mjs
node tests/workspace-panels.browser.mjs
node tests/workspace-persistence.browser.mjs
node tests/document-export-browser.mjs
node tests/image-export-browser.mjs
node tests/svg-export.browser.mjs
node tests/renderer-ui-performance.mjs --fps=60
node tests/renderer-corpus.mjs --prepared
npm run test:preferences:desktop
npm run test:streams:desktop
npm run test:desktop
npm run test:desktop:packaged
```

The native round-trip tests include saving a 207.95 MB Akane project, restarting the codec service, reopening it, and exporting the original PIV SHA exactly. The GPU corpus compares 101 sampled frames from all 37 supplied PIV files against the established Canvas renderer. Prepared rendering matches the normal GPU path for those samples; antialiasing differences against the reference remain. Test reports live in `artifacts/`; package smoke evidence applies to the package snapshot actually tested.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/editor*.mjs`, `src/pivot/` | Document commands/history, rig construction, native evaluation and validation |
| `src/renderer*.mjs`, `src/prepared-frames.mjs` | WebGPU primitives, incremental edits, bounded GPU playback packets |
| `src/playback*.mjs`, `src/document-transport.mjs` | Worker evaluation, CPU packet cache, bounded document/frame snapshots |
| `src/import-*.mjs`, `src/editor-load.mjs`, `backend/`, `native/piv-frame-scan.cpp` | Native/Python decoding, binary frame transport, source preservation and cooperative editor preparation |
| `src/document-export*.mjs`, `src/native-files.mjs` | Worker save/recovery snapshots and native Blob streaming |
| `src/image-*.mjs`, `src/svg-export.mjs`, `src/video-export.mjs` | Image/vector/video encoding and containers |
| `src/text-authoring.mjs`, `src/media-authoring.mjs` | Portable glyph outlines, sprites and backgrounds |
| `src/app.mjs`, `src/timeline.mjs`, `src/simple-timeline.mjs`, `src/workspace-*.mjs` | Custom interaction, two timeline modes and movable workspace |
| `src/settings.mjs`, `src/localization*.mjs`, `src/locales/` | Persistent editor preferences and explicit language bindings |
| `desktop/`, `scripts/`, `native/vfw-bridge.cpp` | Isolated Electron bridge, Recent Files/clipboard/preferences, native encoders, sidecar and packaging |

The original `tools/`, `studio/`, and native `StykAnimate/` projects remain separate. Third-party font/parser/triangulation licenses are retained with their vendored files.
