# Dense-scene gesture benchmark — 9 September 2026

**The worst editing delays occur in rig mode and when an operation finishes or restores state.** On `testreallydense.piv`, ordinary figure translation is cheap while moving. Moving all 60 figures then releasing costs **144–166 ms**. A shared static rig-node drag updates at roughly **3 input/render cycles per second**, and its release takes **470–519 ms**. Onion-skin node release costs **286–319 ms**. Cancelling a node drag and undoing/redoing even a single figure translation rebuild the scene and cause approximately **150–220 ms stalls**.

This extends [the playback and navigation investigation](DENSE-SCENE-PERFORMANCE.md). Only the benchmark harness, summaries, and documentation were changed in this follow-up; the optimization proposals remain proposals.

## What was measured

The scene has 60 instances of a 629-segment figure: 37,740 segments per frame, four frames, and a 24 FPS scene rate. Hardware and runtime match the original report: Ryzen 5 5500, Nvidia Lovelace adapter, Electron 39.8.10, 1600 × 1000 content area, DPR 1. Ordinary gesture tests use the fitted view, approximately 94%; explicit high-zoom cases use 200%. Imports initially show the last frame; onion tests explicitly use the second frame with the default two-before/one-after settings, producing two available onion frames.

The broad matrix ran **96 gestures: 16 scenarios × two freshly imported documents × three consecutive drags**. It covers selected/unselected figure roots, leaf and branching nodes, Ctrl-stretch, right-button bend, Alt figure transformation, 10/60-figure groups, 200% zoom, onion skin, shared static rig nodes, rapid unpaced input, and dragging after a frame change. Additional runs confirmed the main findings with captured source modules, compared rig overlays, and tested body picking, hover, marquee, pan, wheel zoom, Escape, and three undo/redo pairs. Separate CPU profiles identify expensive functions.

“First drag” means the first gesture after reload/import, once the scene and handles are visible. It does **not** include import or initial scene preparation. A repeat uses the same target after the preceding commit, without undo/reset. The second trial reloads the document in the same Electron process, so it is not a second cold process launch. Frame-change cases separately include the intervening seek stall.

Real trusted browser pointer input is used, with actual drag kind, target UID/joint, and resulting pose checked. Most drags use 24 moves, 16 ms requested pacing, and a 50 ms hold after the first move. Rig tests use 12 moves; rapid-input tests use 48 with no explicit pacing. Automation round trips and browser backpressure affect delivered input frequency: that frequency is **not a measured maximum human-input throughput or display FPS**. The rig case’s roughly 300 ms rAF gaps independently confirm its poor cadence.

The metrics distinguish:

- **Down handler:** event capture through the application’s pointer handler.
- **Input → render:** browser event timestamp through CPU-complete scene/overlay submission, including dispatch delay. It excludes physical display scanout.
- **Frame CPU:** the full application render loop, including geometry and overlay work. This is broader than `renderer.frameMs`.
- **Release:** pointer-up through its resulting submitted frame, including deferred commit/rebuild work.
- **Long task:** Chromium’s observed main-thread long-task duration; this does not account for all compositor/GPU waiting.

Motion p95 values pool matched input/render observations within each first/repeat group. Inputs coalesced before rendering do not receive invented individual latency samples. Small first/release sample counts are shown as ranges, not statistically stable population estimates.

## First drag versus repeated dragging

The following **unprofiled, frozen-source confirmation** has two first gestures and two repeats per scenario. All values are milliseconds. The rig row uses the final run, which waits explicitly for the release render.

| Gesture | First move, first gesture | First move, repeat | Motion input → render p95, first / repeat | Motion CPU p95, first / repeat | Release, all observed gestures |
|---|---:|---:|---:|---:|---:|
| Move selected figure | 4.4–4.9 | 1.1–4.8 | 7.7 / 7.4 | 0.6 / 0.5 | 9.9–15.6 |
| Branching node, 441 descendants | 13.6–17.4 | 13.4–13.8 | 12.9 / 12.3 | 8.3 / 6.7 | 15.4–23.1 |
| Move all 60 figures | 9.0–27.8 | 3.2–7.8 | 8.9 / 8.2 | 2.5 / 1.9 | **144.3–165.5** |
| Branching node with onion skin | 11.5–13.4 | 7.4–13.2 | 51.1 / 12.0 | 9.3 / 5.6 | **286.4–318.6** |
| Shared static rig node, all handles | **289.1–295.6** | **285.9–329.9** | **346.8 / 320.6** | 33.6 / 32.8 | **469.9–518.9** |

Pointer-down itself was at most 1.6 ms for the selected figure, 1.5 ms for the branching node, 6.3 ms for the 60-figure group, and 2.9 ms for the rig node. There is no evidence of a large general “first pointer-down” initialization penalty at fit zoom. The first node render is somewhat more expensive, but release and rig overlay costs are much larger. The first onion gestures also have a dispatch-delay tail during movement that their 9.3 ms CPU p95 conceals.

Additional coverage from the broad run follows. These are **observations from an earlier run with concurrent source edits**, not a controlled before/after comparison with the table above. Two first and four repeated gestures were recorded for each row.

| Gesture | First move range | Motion p95, first / repeat | Release range | Detail |
|---|---:|---:|---:|---|
| Unselected figure root | 3.1–21.6 | 7.0 / 7.3 | 9.0–14.3 | Selection and translation verified |
| Leaf node | 11.3–12.2 | 12.7 / 12.4 | 14.6–20.5 | No descendants |
| Ctrl-stretch node | 9.5–12.8 | 12.3 / 12.9 | 14.9–19.5 | Actual pose gesture and edit verified |
| Right-button bend | 9.8–17.1 | 16.9 / 11.9 | 15.8–19.1 | Actual bend gesture verified |
| Alt figure transformation | 10.3–13.8 | 12.7 / 12.2 | 15.8–19.5 | Actual figure-transform gesture verified |
| Move 10 figures | 5.6–7.6 | 7.7 / 7.9 | 27.9–59.7 | Exactly 10 roots changed |
| Branching node at 200% | 21.5–265.0 | 19.9 / 17.3 | 14.1–31.7 | One 265 ms first-input outlier, mostly dispatch delay |
| Figure root at 200% | 6.2–6.8 | 7.5 / 7.2 | 8.8–14.9 | Translation remains inexpensive |
| Branching node, unpaced input | 12.6–16.0 | 30.7 / 24.7 | 38.0–46.9 | Increased queueing under faster delivery |
| Figure after frame change | 4.9–8.7 | 6.7 / 7.5 | 8.0–12.4 | Separate seek long task up to 178 ms |
| Node after frame change | 8.8–15.7 | 12.4 / 12.2 | 15.9–19.3 | Separate seek long task up to 169 ms |

The earlier 60-figure run also contained a **364 ms release / 380 ms long-task outlier**. The frozen confirmation reproduced the usual 144–166 ms release range; it does not explain or erase that older outlier. Similarly, the 265 ms first-input delay at 200% should not be generalized to every first drag without further repetition.

## Rig overlay experiment

The same static joint was edited with three overlay configurations. These are diagnostic configuration changes inside the isolated benchmark document, not application optimizations.

| Configuration | Handle descriptors | Motion input → render p95, first / repeat | Motion CPU p95, first / repeat | Release |
|---|---:|---:|---:|---:|
| All figure handles | 37,800 | 316.6 / 411.5 ms | 34.7 / 48.6 ms | Approximately 0.5 seconds |
| Selected figure handles plus other roots | 689 | **13.2 / 13.1 ms** | 7.8 / 6.7 ms | 208–262 ms |
| Overlay disabled after pointer-down | Disabled during motion | **9.6 / 10.1 ms** | 3.0 / 3.5 ms | 208–232 ms |

All-handles input delivery was 2.5–3.0 events/sec with p95 rAF gaps of 299–389 ms; selected handles produced approximately 24–27 delivered events/sec under the same paced driver and approximately 7 ms p95 rAF gaps. Disabling the overlay *after* down does not remove already queued work: its first move still sometimes waits 270–297 ms. Its subsequent motion is the useful ablation result.

This strongly implicates the handle overlay. `drawCanvasHandles` invalidates its cached surface when geometry identity changes, then paints every handle with separate arc/fill/stroke operations. A pose edit changes that geometry. One sampled 12-move rig gesture spent **433 ms inclusive in overlay rendering**, of **627 ms in the render loop** across the whole gesture. Another spent 291 ms in `paintHandle`, nested inside 434 ms in `drawCanvasHandles`.

However, CPU work alone does not explain the roughly 300 ms cadence: dispatch waits dominate the total. The overlay ablation supports a browser rendering/compositor bottleneck associated with the canvas work, but these traces do **not** isolate exact GPU execution time, driver behavior, or physical presentation. Inclusive CPU entries are nested and must not be added together.

## Other canvas actions

These are unprofiled observations from the final frozen-source run, with handles enabled except for the deliberate body-picking case.

| Action | Result |
|---|---|
| Hover across empty/dense regions, 60 inputs each | No long tasks; no scene render was needed. Earlier confirmation handler p95 was 0.9 / 0.7 ms. |
| Middle-button pan, first plus two repeats | Input → render p95 **10.5 / 8.6 / 9.3 ms**; full CPU p95 **2.3 / 2.2 / 2.1 ms**; no long tasks |
| Wheel pan, 12 steps | Input → render p95 **15.4 ms**; no long tasks |
| Ctrl-wheel zoom, 94% → 193% | Input → render p95 **108.4 ms**; full CPU p95 **75.1 ms**; **77 ms** long task crossing the raster bucket |
| Marquee across scene | All **60 figures selected**; input → render p95 **21.8 ms**; no long tasks |
| Body pick and figure drag, handles disabled | Intended/actual UID 61; exactly one root moved; input → render p95 **7.6 ms**, CPU p95 **0.3 ms**; no long tasks |
| Escape during branching-node drag | Exact pre-drag pose restored and drag cleared; **180.1 ms** matched input → render, **183 ms** long task |
| Undo single-figure drag, three operations | Long tasks **169 / 169 / 147 ms** |
| Redo same drag, three operations | Long tasks **166 / 198 / 176 ms**; committed pose restored after each pair |

Keyboard latency can attach to a later key event in the same shortcut sequence, so the table uses directly observed long-task durations for undo/redo rather than claiming exact physical key-to-display latency. The earlier frozen control run independently recorded 153–218 ms undo/redo long tasks and a 165 ms cancellation stall.

## Causes and optimization priorities

1. **Retain translations through commit.** During root dragging, the application uses transient transforms and cached textures. On release, it materializes positions, invalidates affected geometry, and rerasterizes those objects. In the sampled 60-figure release, `commitDrag` itself took 13.6 ms, followed by **70.5 ms geometry construction and 104.2 ms renderer update**, rasterizing all 60 objects. Investigate preserving object-local geometry/textures and committing their transforms without reconstructing unchanged artwork. This explains why the old renderer-only drag benchmark looked fast while release still feels slow.

2. **Make handle caching local to the changed figure.** Keep unchanged rig handles retained, repaint changed handles only, and investigate clipped/batched drawing. The all-handles versus selected-handles experiment supplies direct evidence for prioritizing this. Preserve picking behavior and visible handles when evaluating a real optimization; hiding them is only an attribution experiment here.

3. **Scope cancellation/history invalidation to changed objects.** `Editor.cancelDrag` drops geometry, and `_applyCommand` calls `_invalidate({timing:true})` even when restoring one object’s position. The sampled undo rebuilt all 60 objects: **91.3 ms geometry + 79.1 ms renderer preparation**. Cancellation similarly measured **91.0 + 86.9 ms**. The command bookkeeping itself is not the main cost. Retain unaffected objects and their raster resources through undo/redo/cancel.

4. **Preserve unrelated onion frames on commit.** `OnionSkinCache.invalidate` clears all samples for non-live edits, and `get` clears them again when the editor revision changes. Editing the current frame therefore discards the unchanged neighboring samples. One profiled release had **367 ms full render CPU**, 120 rasterized onion objects, and 181 draw calls. Across that gesture, onion retrieval consumed **195 ms inclusive**, and renderer preparation **203 ms inclusive**. Investigate dependency-aware invalidation by frame/figure definition and retention of styled onion textures. This evidence concerns the newly fixed onion implementation captured in these runs.

5. **Split shared rig commit work from preview.** A rig preview changes one instance; committing updates the shared definition and matching instances across source frames. The measured current frame changed all 60 objects and 240 angle entries. A sampled commit took approximately **65–67 ms**, including about 13–14 ms recording history, then rebuilt the current scene’s geometry and 60 textures. Even with the overlay reduced, release remains over 200 ms. Preserve semantic propagation and undo while investigating incremental compilation or staged preparation.

6. **Keep the playback/cache and zoom work in the original report high priority.** The new wheel benchmark again attributes a resolution-boundary stall to rerasterization. Faster pose handlers alone will not fix the previously measured 9–11 FPS playback or frame-change rebuilds.

Relevant implementation locations in the captured sources are `src/app.mjs` (`drawCanvasHandles`, render loop, pointer-up and wheel handlers), `src/editor.mjs` (`touch`, `commitDrag`, `cancelDrag`, `_applyCommand`), `src/editor-rig.mjs` (`commitRigDrag`), `src/renderer.mjs` (`updateGeometry`, `prepare`, `rasterObject`), and `src/onion-skin.mjs` (`invalidate`, `get`). Each evidence directory contains the exact source bytes, so these remain reviewable if current workspace lines change.

## Evidence integrity and reproduction

The initial broad run encountered **168 `hidden is not iterable` errors in six onion gestures**. Those gestures produced no frames and are excluded from successful measurements. Another task’s subsequent source update fixed that failure; the later frozen onion runs completed without errors. No fix to that production code was made as part of this benchmark follow-up.

Other tasks edited application/timeline files during the broad run. Later runs serve **every captured `src/**/*.mjs` module** from their own snapshot across reloads and workers. Disk edits during those runs are recorded separately and do not replace the captured modules. The final rig/navigation/control run had no application errors and no source changes during execution. One rig release in the earlier confirmation fell outside its fixed observation window; it is not treated as zero latency. The final harness waits for the release render, and the final run captured all four rig releases.

All runs used isolated Electron profiles and verified the original desktop PIV was unchanged, with SHA-256 `a1f82adf4250d9c57134cd0b21c7f75783fba2068287554458caecf97441fe3b`. Pose edits were confined to the benchmark document. Screenshots of rig and normal editing were inspected; programmatic checks verified target selection, group counts, actual pose changes, cancellation restoration, and redo restoration.

Final verification passed syntax checks for all four benchmark/summary scripts and audited **85 actions across four frozen-source runs**: zero application errors, trusted inputs, unchanged original PIV, matching source-snapshot hashes, and all four final rig release samples present. The earlier broad run is intentionally excluded from that clean-run count.

| Evidence directory under `artifacts/dense-scene/` | Purpose |
|---|---|
| `drag-1788914343549` | Broad 96-gesture run; concurrent-source caveat and six failed onion gestures |
| `drag-1788914972635` | Frozen, unprofiled confirmation: 28 drags plus 11 controls; rig overlay comparison |
| `drag-1788915200525` | Final frozen, unprofiled: four rig drags with complete release capture plus 16 controls/navigation actions |
| `drag-cpu-1788914785019` | Eight sampled group/rig/overlay gestures and CPU profiles |
| `drag-cpu-1788915139172` | Two sampled onion gestures and 16 sampled controls/navigation actions |

Each has `report.json`, per-action raw JSON, source snapshots/hashes, screenshots, and generated `drag-summary.json` / `drag-summary.md`. Sampled runs additionally contain `.cpuprofile` files and `cpu-summary.json`. The summary script keeps different runs separate rather than pooling incompatible snapshots or profiled/unprofiled measurements.

```powershell
# Full first/repeat matrix: default two trials, three drags per trial.
$env:STYK_DENSE_MODE='drag'
Remove-Item Env:STYK_DRAG_CASES -ErrorAction SilentlyContinue
node scripts/benchmark-dense-scene.mjs

# Focused release, onion, rig, and control coverage.
$env:STYK_DRAG_CASES='group-60,joint-onion,rig-static,rig-selected-handles,rig-overlay-off,controls'
$env:STYK_DRAG_TRIALS='2'
$env:STYK_DRAG_REPEATS='2'
node scripts/benchmark-dense-scene.mjs

# For attribution, change the mode to drag-cpu and keep its timings separate.
# Replace <run-directory> with the OUTPUT path printed by the benchmark.
node scripts/summarize-dense-drags.mjs <run-directory>
node scripts/summarize-dense-profiles.mjs <run-directory>
```

This is broad coverage of the reported editing problem, not an exhaustive test of every editor feature. Touch/stylus input, joined figures (this scene has none), other hardware/DPRs, long-duration memory growth, constrained-joint variants, and GPU/physical presentation traces remain unmeasured. No claimed maximum throughput is inferred from the paced input driver.
