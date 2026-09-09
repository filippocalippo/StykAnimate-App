# Dense-scene performance investigation — 9 September 2026

**Playback has a reproducible zoom-dependent performance cliff.** With `testreallydense.piv`, playback sustains the intended 24 FPS at 100% zoom, falls to **8.57–10.81 FPS at 101–200%**, and fails to start at 400% because one prepared frame exceeds the memory budget. Frame changes also cause approximately **200 ms main-thread stalls**. These are separate problems: repeated packet preparation during playback, and synchronous geometry/raster reconstruction during editing.

This pass adds measurement tools and the requested small FPS indicator. It does not implement the optimization proposals below. The desktop source file was read through the application's importer and its SHA-256 remained unchanged.

**Expanded gesture investigation:** [First and repeated node/figure drags, rig mode, release, cancellation, undo/redo, and navigation](DENSE-SCENE-DRAG-BENCHMARK.md). It finds 144–166 ms releases when moving all 60 figures, approximately 3 input/render cycles per second in dense rig mode with 470–519 ms releases, 286–319 ms onion-skin node releases, and substantial full-scene rebuilds on cancellation/history. The original single-figure renderer timing below does not capture those costs.

## Scene and measurement conditions

| Property | Measured value |
|---|---:|
| Input size | 42,667 bytes |
| Stored frames / target rate | 4 / 24 FPS |
| Canvas | 960 × 540 |
| Figures per frame | 60 instances of the same 629-segment definition |
| Segments per frame | 37,740 |
| Static segments | 34,920 (92.5%) |
| Polygon fills per frame | 5,460 |
| Emitted drawables / visible handle descriptors | 36,120 / 2,880 |
| Objects requiring compatibility textures | 60 / 60 |
| Expanded document JSON in the diagnostic | 3,372,064 bytes |

The compatibility decision is triggered by polygons in all 60 figures. Object transparency, global outlines, and curved alpha/gradient segments did not trigger it in this scene. The first instance's 91 polygons have at most 177 points, so its fallback is the polygon intersection test, rather than the `>256` point cutoff. The test may conservatively classify touching edges too; this investigation does not establish that every flagged polygon needs rasterization.

A comparison of root position, scale, angles, lengths, bends, color, transparency, joins, and runtime segment fields found **only one object differing from frame 1 in each subsequent frame**. This makes reuse of unchanged figure geometry and textures a particularly promising next experiment. Wire record offsets were excluded from that comparison; it is not a complete semantic-equivalence proof.

Measurements used visible Electron 39.8.10 / Chromium 142 on Windows 11 (10.0.26200), an AMD Ryzen 5 5500, 12 logical CPUs, approximately 64 GiB RAM, and the WebGPU adapter reported as `nvidia · lovelace`. The content area was 1600 × 1000 CSS pixels, device pixel ratio 1; observed display callbacks were approximately 144 Hz. Each launch used an isolated profile with default advanced-timeline preferences, handles enabled, onion skin disabled, loop enabled, and autosave at 2.5 seconds. The restricted process launch could not open Electron; measurements used approved host GPU access with Electron's renderer sandbox retained.

## Playback benchmarks

The zoom sweep below was recorded **before the FPS UI was added**, with no CPU sampling. Each row contains two consecutive eight-second windows. FPS is the rate of consecutive distinct scene-tick submissions, not the rate of `requestAnimationFrame` callbacks and not `1000 / renderer.frameMs`.

| Zoom | FPS, run 1 | FPS, run 2 | p95 frame gap, run 1 / 2 | Result |
|---|---:|---:|---:|---|
| 100% | 24.01 | 24.00 | 48.7 / 48.5 ms | All four frames stay cached |
| 101% | 10.49 | 9.55 | 133.7 / 155.6 ms | Repeated CPU and GPU cache evictions |
| 200% | 10.81 | 8.57 | 133.2 / 158.1 ms | Repeated CPU and GPU cache evictions |
| 400% | No frames | No frames | Not applicable | `playback_frame_budget`; playback stops |

At 101%, the first eight-second window rebuilt **41 packets**, evicted **41 CPU packets**, and uploaded **85 GPU frames**, evicting **82**. At 100%, the second window required **zero new packet compilations, GPU uploads, or evictions**. The slowest 200% window reached a **233 ms frame gap**.

| Quantized raster resolution | CPU packet size | Four packets | CPU budget |
|---|---:|---:|---:|
| 1×, through 100% zoom at DPR 1 | 9.85 MiB | 39.39 MiB | 128 MiB |
| 2×, just above 100% through 200% | 39.36 MiB | 157.42 MiB | 128 MiB |
| 4×, just above 200% through 400% | Exceeds 128 MiB per packet in this scene | Cannot prepare | 128 MiB |

The GPU prepared-frame cache independently has a 128 MiB limit. At 2× it can hold only three frames as well. Thus fitting CPU packets alone would not eliminate texture upload churn. These accounting figures exclude the retained editor textures, browser surfaces, and other process memory.

Three initial six-second warm runs at fit-to-canvas zoom measured **24.03, 24.00, and 24.00 FPS**, without long tasks. With genuinely emptied CPU/GPU packet caches, the CPU-profiled diagnostic needed **389 ms to the first submitted frame** and approximately **210–222 ms per worker packet**; its seven-second average was 22.11 FPS because the later cached repetitions hide the slow opening cycle. The initial harness phase named `playback-cold` was discovered to have already-warm CPU packets; treat it only as first playback/GPU upload, not cold preparation. The harness now names that phase explicitly and has a separate `playback-empty-caches` phase.

An isolated worker experiment without CPU sampling measured **145–186 ms per packet at 1×**, and **150–183 ms at 2×**. Approximately half was geometry construction and half was compilation/raster work. The 24 FPS budget is **41.67 ms**, so a stream of uncached frames cannot keep up on this machine. Warm playback works because it avoids that work entirely.

The final unprofiled run, with the new presentation instrumentation, confirmed **24.00 FPS in all three warm windows**. Empty caches took **173.1 ms from `play()` to the first submission**, prepared four packets at **170.2 ms mean**, and recorded four buffering episodes. Its seven-second average was **22.44 FPS**, recovering to 24 FPS once cached. Phase-to-first-frame figures from the older harness include automation/profiler start overhead; the new startup metric begins inside `play()` and excludes that overhead.

## Editing and navigation

The initial measurements below were collected without CPU sampling. Pointer actions used real browser input and checked that the view or figure position changed. Frame changes called the editor's normal `selectFrame` entry point and waited for a render submission; their latency is not physical display latency.

| Operation | Result |
|---|---|
| 12 frame changes | Median **211.5 ms**, p95/max **242.5 ms** request-to-render; 12 long tasks, **185–246 ms** range for frame/long-task observations |
| 12 zoom wheel steps, crossing raster buckets | Four long tasks; mean **100.3 ms**, max **109 ms**; renderer call max **103.7 ms** |
| Pause and return to editing | One **250 ms** long task |
| Canvas pan, handles enabled | rAF p95 **20.8 ms**; renderer p95 **0.3 ms**; no long tasks |
| Same pan, handles disabled | rAF p95 **7.0 ms**; renderer p95 **0.3 ms**; no long tasks |
| Move one figure, 24 input steps | Renderer p95 **0.3 ms**, maximum **2.7 ms**; commit **4.5 ms**; no long tasks |
| Six selection changes | Renderer p95 **0.3 ms**; no long tasks |

The ordinary root translation path is already efficient in this case. This does not establish that moving every figure, rotating a dense joint hierarchy, or editing at high zoom is equally cheap.

The final unprofiled run reproduced these categories: frame-change median **172.5 ms**, maximum **196 ms**, 12 long tasks; four zoom stalls up to **78 ms**; and a **187 ms** pause-return stall. It had no JavaScript errors and no changes to the recorded source files during the run. These variations are separate measurements, not evidence that the FPS indicator optimized the renderer.

Three additional real timeline scrubs reached the exact held final frame before release. Early previews lagged or skipped intermediate targets while the worker compiled packets, then caught up after the pointer held still. Returning to the editable frame produced one **143–168 ms** long task per scrub. Each scrub compiled 5–6 packets at approximately **145–150 ms mean**. Scrubbing and playback use different camera modes, so switching modes invalidates the current packet view; the pipeline should retain correct separate views or share camera-independent resources rather than blindly reusing clipped bitmaps.

## What is causing it

**1. Frame caches duplicate complete object textures and encounter a hard resolution cliff.** `playback-worker.mjs` quantizes raster scale with `2 ** ceil(log2(scale))`, including device scale and the camera. A small zoom change can quadruple pixel storage. `playback.mjs` and `prepared-frames.mjs` retain packets by frame/revision, with independent byte budgets. The four-frame working set no longer fits after the first resolution boundary. The loop waits for the next exact packet instead of skipping it, so cache misses directly stretch the animation. These policies explain the observed evictions and low FPS. At DPR 2, the same physical-resolution boundary can occur at a lower CSS zoom; that is a code-based inference, not a measured second-monitor result.

**2. Frame selection invalidates geometry, then rebuilds the editable scene synchronously.** `Editor._invalidate({viewOnly:true})` drops the current geometry. The render loop calls `editor.geometry`, which executes `buildGeometry`, followed by renderer preparation and compatibility rasterization. In the 12-change CPU profile, geometry construction accounted for approximately **1,000 ms inclusive**, and renderer preparation for **1,014 ms inclusive**, out of a 2,656 ms recording. These are distinct major branches; do not sum nested entries within either branch. CPU hotspots include `objectAt`, `segmentAt`, `arc`, polygon assembly, and `drawPrimitives`.

**3. Changing zoom rerasterizes every compatibility object at a new resolution.** The renderer's raster cache is keyed by geometry and resolution. Crossing a bucket rebuilds 60 textures synchronously. In the zoom CPU profile, `rasterObject` accounted for approximately **350 ms** and `drawPrimitives` for **242 ms**, across the gesture. Replacing these textures immediately also makes repeated movement across the boundary expensive.

**4. Handle overlays add pan work.** The handle surface cache includes view x/y, so panning repaints the 2,880 handle descriptors. In the sampled pan, overlay work occupied approximately **71 ms** across the gesture; total render-loop sampled time was **81 ms with handles versus 11 ms without**. This is secondary to geometry/raster stalls, but the rAF comparison shows an observable navigation cost.

**5. Current CPU render timing conceals worker/cache stalls.** In slow playback, `renderPrepared` still usually takes **0.1–0.2 ms** of main-thread submission work. A fast submission does not imply a ready next frame. An isolated retained-editor GPU-queue test measured **0.2–0.4 ms submission** and **2.9–4.7 ms submission-to-queue-completion**. Queue completion includes scheduling and IPC and is not a GPU timestamp query; it nevertheless gives no evidence that a cached frame's GPU execution is the dominant 100–200 ms problem. No full GPU trace or physical scanout measurement was collected.

Native import decode was approximately **9.6 ms** in the initial run, with **585 ms** file-input-to-editor-ready wall time. Codec work, autosave, and timeline listener dispatch are not supported as the primary cause of the sustained zoom-dependent playback failure. Their costs should not be confused with the measured worker raster and cache churn.

## Proposed optimization order

1. **Reuse unchanged object resources across frames.** Separate frame transforms/order from shareable geometry and raster resources, with explicit ownership and byte accounting. This scene changes only one object's inspected pose/style fields across frames, but currently prepares complete frames. Verify native painter order, alpha, joins, camera clipping, and resource lifetime before relying on sharing.
2. **Make preview raster resolution budget-aware.** Prevent a 1% zoom change from making playback's entire working set uncacheable. Consider bounded preview resolution and deferred sharpening after navigation settles. Keep export quality independent. Merely raising both cache limits is a diagnostic experiment, not a scalable fix.
3. **Prepare editable frames asynchronously and retain unchanged geometry.** Bring the existing staged initial-scene preparation approach to frame changes and scrub release. Preserve the last complete image until the new editable frame is ready. Reuse worker vectors where valid; clipped compatibility textures cannot simply replace full editable objects.
4. **Defer zoom rerasterization and improve overlay retention.** Reproject retained textures during active zoom, then rebuild within a time budget. Reuse the handle surface during pan or cull offscreen descriptors while preserving handle size and hit testing.
5. **Review polygon fallback with visual equivalence tests.** The current fallback is conservative. A safe vector/even-odd solution or smaller raster subgroups might reduce texture duplication, but changing polygon semantics just to benchmark faster would be incorrect.

For the next implementation pass, rerun the same 100%/101%/200% sweep, empty-cache start, frame changes, and scrub-release tests. Suggested acceptance targets are sustained **at least 95% of 24 FPS**, no repeated packet rebuilds for unchanged figures in a warmed four-frame loop, and no **>50 ms** main-thread task on normal frame changes or scrub release. These are proposed targets, not achieved improvements.

## Instrumentation delivered and verification

- An 11 px text-only FPS readout at the canvas's top-right corner, updated at most four times per second. It is hidden while paused, neutral while the first sample forms, green when within 5% of the target, and red below that tolerance. The tolerance avoids treating ordinary scheduling/one-second counting jitter as a failure.
- FPS counts successful scheduled scene submissions, including repeated one-frame loops; repaint-only callbacks do not increment it. A one-second rolling window includes buffering stalls. It is not physical display FPS.
- `styk.performance().presentation` exposes FPS, target, startup delay, submitted frame count, buffering duration/count, and the last 300 inter-presentation intervals. The Performance dialog includes playback FPS, startup, and buffering beside the existing CPU timing fields.
- `scripts/benchmark-dense-scene.mjs` provides isolated Electron inventory, baseline, CPU profiling, zoom stress, worker/GPU microdiagnostics, scrub checks, and FPS UI verification. `scripts/summarize-dense-profiles.mjs` summarizes its Chrome CPU profiles. Recent harness runs preserve relevant source copies and detect changes during a run.
- **32 targeted tests passed**, covering metrics, native/stored playback, cache invalidation/budgets, packet behavior, and patches. Changed JavaScript passed syntax checks. Real Electron checks verified green at **24.0 FPS**, red at approximately **9 FPS**, top/right placement, and hiding after pause. Both rendered states were inspected.

The source workspace was changing concurrently: editor hashes differ between the first baseline and later diagnostic runs, and timeline files changed during this investigation. No unrelated edits were reverted. Renderer, playback cache, worker, prepared-frame, and geometry hashes stayed identical across the original baseline, microdiagnostic, and zoom sweep. Treat runs as separately identified observations, not a controlled optimization before/after comparison. The first diagnostic's optional 4× microtest threw the now-documented budget error; its completed per-phase profiles remain valid, and the isolated microtest was rerun with expected-error capture. Initial `before.renderer` snapshots were live references; only later runs with cloned snapshots, including the zoom sweep, are used for renderer counter deltas.

## Reproduce and inspect evidence

Run from the application directory in PowerShell:

```powershell
npm run benchmark:dense -- 'C:\Users\aleri\Desktop\testreallydense.piv'
$env:STYK_DENSE_MODE = 'stress' # or diagnostic, micro, interactions, fps-ui, probe
npm run benchmark:dense -- 'C:\Users\aleri\Desktop\testreallydense.piv'
Remove-Item Env:STYK_DENSE_MODE
node scripts/summarize-dense-profiles.mjs artifacts/dense-scene/<diagnostic-run>
```

Runs create their own timestamped directories under `artifacts/dense-scene`. They edit only imported, isolated in-memory documents and their own test profiles. They do not save over the desktop PIV.

| Evidence directory under `artifacts/dense-scene` | Contents |
|---|---|
| `baseline-1788913037528` | Initial unprofiled playback and editing baseline; see first-phase naming caveat above |
| `diagnostic-1788913172426` | Per-action CPU profiles, raw event/timing logs, empty-cache measurements, `cpu-summary.json` |
| `micro-1788913271751` | Geometry/handles, worker stage times, packet bytes, GPU queue measurements, expected 4× failure |
| `stress-1788913301871` | Two eight-second playback windows at each zoom, cache counter deltas, screenshots |
| `fps-ui-1788913503553` | FPS UI assertions and `fps-good.png` / `fps-low.png` |
| `interactions-1788913648607` | Three real pointer scrubs, final preview checks, scene comparison, preserved source files |
| `baseline-1788913691354` | Final unprofiled verification with presentation metrics and genuinely empty caches |

Input SHA-256: `a1f82adf4250d9c57134cd0b21c7f75783fba2068287554458caecf97441fe3b`.

Direct evidence: [original zoom sweep](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/artifacts/dense-scene/stress-1788913301871/report.json>), [final baseline](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/artifacts/dense-scene/baseline-1788913691354/report.json>), [CPU attribution](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/artifacts/dense-scene/diagnostic-1788913172426/cpu-summary.json>), [isolated diagnostics](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/artifacts/dense-scene/micro-1788913271751/diagnostics.json>), [FPS UI verification](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/artifacts/dense-scene/fps-ui-1788913503553/report.json>).

Relevant implementation: [worker compilation and raster scale](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/playback-worker.mjs:53>), [CPU packet cache](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/playback.mjs:123>), [GPU packet cache](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/prepared-frames.mjs>), [editable scene geometry](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/editor.mjs:143>), [raster cache](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/renderer.mjs:258>), [polygon compatibility decision](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/renderer-geometry.mjs:60>), [new presentation metrics](<C:/Users/aleri/Desktop/testing pivot/StykAnimate-webapp/src/playback-metrics.mjs>).
