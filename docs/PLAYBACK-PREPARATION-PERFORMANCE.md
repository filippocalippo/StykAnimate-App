# Dense-scene playback preparation — 9 September 2026

Playback now reuses artwork, geometry and constant native tweens. This removes substantial preparation work and the mouse-hover geometry rebuild during playback. The original scene can sustain approximately 144 submitted frames/s after preparation in the measured runs. **Instant startup and a freeze-free editor, especially at fivefold density, remain unfinished.**

## Fixture and method

`C:\Users\aleri\Desktop\testreallydense.piv` contains four native keys, 60 figures and 37,740 segments per key, at a native scene rate of 24 FPS. Tests override the scene rate to 144 FPS in memory. The fivefold fixture contains 300 figures and 188,700 segments per key. No benchmark saves the source PIV; its SHA-256 remains `a1f82adf4250d9c57134cd0b21c7f75783fba2068287554458caecf97441fe3b`.

Measurements use the actual Electron/WebGPU application on a Ryzen 5 5500, NVIDIA Lovelace GPU and 144 Hz display, at 1600×1000 and DPR 1. Each run serves a captured source snapshot, including worker modules. Background throttling is disabled only inside the isolated benchmark process: an earlier occluded-window run had 1-second rAF intervals, which cannot be attributed to canvas rendering. FPS measures distinct scene-frame submissions, not physical panel scanout.

The inbetween scenario sets the first three native key durations to eight ticks (25 total ticks), plays stationary, delivers mouse motion for six seconds, stops, inserts three actual inbetween keys (49 total ticks), plays again, changes one figure's angle in the first frame, then plays again. Preparation ends when every test tick has a GPU-prepared frame, rather than after an arbitrary 15-second wait. The following steady phase lasts six seconds. These fixtures fit the configured caches; longer scenes require a separate streaming test.

## Preparation and replay

The latest **base four-key scene** test clears every worker, CPU-packet and GPU-prepared cache immediately before Play. It uses **101% zoom**, crossing the expensive raster-resolution boundary:

| Base scene at 101% zoom, 144 FPS target | 60 figures | 300 figures |
|---|---:|---:|
| Cold Play to all four ticks prepared | **346 ms** | **1,991 ms** |
| Cold first presentation | 302 ms | 1,569 ms |
| Play after one frame edit, all four ticks prepared | **115 ms** | **457 ms** |
| First presentation after that edit | 39 ms | 128 ms |
| Prepared stationary playback | 144.03 FPS | 143.92 FPS |
| Mouse-motion playback | 144.01 FPS | 144.00 FPS |
| Prepared GPU storage after the edit | 23.17 MiB | 112.46 MiB |

Evidence: `artifacts/dense-scene/playback-input-1788922457868` and `playback-input-1788922491587`. Both runs retained the source PIV and captured application sources unchanged, with no application errors, no mouse-triggered editable-geometry access, and no buffering or observed long tasks in their warmed playback phases. The original-scene **edit command itself** still produced a 174 ms long task; the 115 ms figure measures subsequent playback preparation, not the entire editing interaction.

The expanded inbetween scenario is more demanding:

| Measurement at 100% zoom and 144 FPS target | Original scene, 60 figures | Fivefold scene, 300 figures |
|---|---:|---:|
| Play to all 25 ticks prepared | 0.997 s, explicitly cold worker/CPU/GPU caches | 3.809 s, normal application idle prefetch allowed |
| First presentation during that phase | 316 ms | 297 ms |
| Play after inserting three keys, all 49 ticks ready | 1.051 s | 7.194 s |
| Play after changing one frame, all 49 ticks ready | 0.926 s | 2.942 s |
| First presentation after that frame edit | 90 ms | 100 ms |
| Stationary playback after preparation | 144.01 FPS | 143.67 FPS |
| Mouse motion during playback | 144.06 FPS | 144.00 FPS |
| Playback after insertion, once prepared | 144.00 FPS | 143.34 FPS |

Original-scene evidence: `artifacts/dense-scene/inbetweens-1788922325497`. Fivefold evidence: `artifacts/dense-scene/inbetweens-1788922166085`. The fivefold run predates additional diagnostic fields, but includes the final pose/tween/raster algorithms. No application errors or source-file modifications were reported. Mouse phases performed no `editor.geometry` accesses and no observed main-thread long tasks. Some warmed fivefold intervals reached 21–28 ms; an average near 144 FPS does not mean every frame met 6.94 ms.

During this pass, the fivefold 49-tick edit-to-ready measurement fell from **21.07 s → 15.38 s → 4.36 s → 2.94 s** as worker raster retention, immutable geometry descriptors, alternate exact poses, and constant tween reuse were introduced. These are successive isolated runs, not a randomized A/B study. The first run overlapped an early unit-test process during setup; the later runs did not. The raw artifacts retain the configuration and per-packet timings:

- `inbetweens-1788921613925`: retained worker rasters; edit-to-ready 21.07 s.
- `inbetweens-1788921780494`: immutable geometry descriptors; 15.38 s.
- `inbetweens-1788921935385`: alternate exact poses and retained frame-edit baseline; 4.36 s.
- `inbetweens-1788922166085`: exact constant native tween reuse; 2.94 s.

## Causes addressed

1. **Mouse hover rebuilt editable geometry during playback.** The pointer-move hover path now exits while playing or previewing. Pan handling remains separate.
2. **Every packet owned duplicate artwork.** CPU bitmap and GPU texture pools now share exact resources between frames, with independent reference counts and bounded admission/eviction. At fivefold density and 101% zoom, an earlier four-frame confirmation improved from roughly 0.8–0.95 FPS to 144 FPS after warming, using 111.81 MiB of shared GPU resources (`stress-1788920097127`).
3. **Inbetween working sets were estimated as unrelated full-frame copies.** Prefetch forecasting now unions resource footprints. It retains bounded metadata about evicted frames and probes only one unknown frame beyond a conservative estimate. CPU and GPU caches use memory-tier budgets capped at 512 MiB each, with a 128 MiB fallback and explicit constructor overrides. The application no longer overrides the CPU cache back to 128 MiB.
4. **Workers redrew unchanged pixels for each new packet and after edits.** Worker-owned originals now survive frame-only revisions. Packets receive independent transferable clones. Full document/asset reloads dispose the originals. Crop and resolution remain part of identity; there is no visual downsampling change.
5. **Each tick repeated compatibility tests, bounds walks and whole-scene construction.** Immutable object geometry retains its descriptors. The worker retains a scene and one bounded alternate pose per independent object, allowing exact native/tween representations to coexist. Joined descendants rebuild when their parent changes. Coordinates are not rounded to obtain a cache hit.
6. **Unchanged figures still interpolated hundreds of angles every tick.** The worker optionally retains the original computed tween when adjacent native endpoint objects are exactly equal and automatic easing is disabled. It preserves native parent-angle floating-point reconstruction; it does not substitute the raw keyframe object. Changed endpoints and easing use the original evaluator.

The local artwork registry still verifies full content after a fast hash. Stable cross-packet keys use SHA-256 over the complete unquantized signature, definition, metadata and crop; they survive eviction of the registry's large comparison records. This is distinct from trusting the fast lookup hash alone.

## Memory and ownership limits

CPU packets and GPU resources have separate budgets. Worker raster originals add at most 128 MiB, reduced when the configured packet budget is lower. Decoded image assets and raster surfaces are separate allocations. Alternate geometry is bounded by 1,024 entries and 250,000 drawables; this is a count bound, **not** a measured byte budget. Constant tween entries are capped at 1,024. GPU/bitmap byte counters describe retained allocations and exclude transient clone/transfer overlap, allocator overhead and native driver allocations.

The original 25-tick cold run used approximately 15.26 MiB of prepared GPU storage. The original 49-tick edited run's known CPU packet/resource footprint was approximately 20.77 MiB. Larger cache budgets did not account for the preparation speedup by themselves: the measured time reductions follow reductions in repeated worker work.

## Remaining problems

- First playback still buffers while its packets are produced. The fivefold inserted scene takes about seven seconds to prepare; this does not meet the intended immediate editing workflow.
- A local edit still invalidates all frame packets and GPU-prepared frame records. Unchanged artwork/geometry survives in the worker, but unaffected ticks are assembled and transferred again. Dependency-aware packet retention is the next significant improvement for edit-to-replay latency.
- At this report's third-pass snapshot, duration editing produced a 921 ms long task and inserting keys a 965 ms long task on the fivefold scene. The insertion command took 1.18 s overall. The original scene showed 159–238 ms long tasks. These figures are corrected by filtering raw task timestamps to each phase: delayed setup notifications of 1,119 ms / 200 ms had previously inflated the duration maxima. The fourth-pass worklog supersedes these timing/navigation results.
- Previous drag benchmarks found shared static-rig release taking 1.5–1.7 s at fivefold density. This playback pass does not claim to fix that. First/repeated figure/node drags, pans, zooms and history evidence remains in `DENSE-SCENE-DRAG-BENCHMARK.md` and `PERFORMANCE-ENGINE-WORKLOG.md`.
- High zoom, scenes exceeding the resident working set, long-running memory behavior, authored animation, image-heavy scenes and difficult joined rigs need broader confirmation before claiming the full performance goal.

## Verification

The real GPU regression compares shared rendering with fresh independent rendering, including style changes, fractional translation, zoom boundaries, camera crop differences, CPU/GPU eviction, frame revision, worker resource disposal, and native/tween boundary transitions. All 18 comparisons had zero pixel difference and no reported GPU validation warnings in `artifacts/artwork-gpu-1788922265039/report.json`.

Focused tests additionally cover exact tween reconstruction, easing bypass, endpoint/definition replacement, alternate-pose eviction and joined descendants, bitmap ownership, cancellation during cloning, and worker patch transport. The final whole suite passed **997/997 tests** (`artifacts/playback-preparation-final-unit.tap`); syntax checks passed for **474 JavaScript files** (`artifacts/playback-preparation-syntax.log`).
