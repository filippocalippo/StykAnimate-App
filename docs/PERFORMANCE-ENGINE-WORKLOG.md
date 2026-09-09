# Engine optimization worklog

## Target and current status

The current target is a smooth 144 Hz canvas/playback for the normal workload and **60 FPS for the fivefold stress workload**, following the user's latest clarification. The implementation must remain general, scalable and visually correct, with no interaction freezes. **This goal is not complete.** The respective frame budgets are 6.94 ms and 16.67 ms; passing unit tests or a fast renderer timer alone does not establish either. Earlier fivefold 144 FPS measurements below retain their original settings as historical evidence.

The original scene is unchanged. The fivefold stress document is constructed in memory: 300 figures, 188,700 segments per frame, four frames, and 189,000 static-mode handle descriptors. Copies retain shared figure definitions, with UIDs, slots, join addresses, and draw orders remapped.

The latest playback preparation investigation is in [PLAYBACK-PREPARATION-PERFORMANCE.md](PLAYBACK-PREPARATION-PERFORMANCE.md). It supersedes the earlier within-packet-only sharing and fixed 128 MiB residency limitations described below. It distinguishes true cold startup, ordinary idle prefetch, replay after edits, and warmed FPS. Editor gesture limitations from the earlier passes remain open.

## Implemented in the first optimization pass

- Object-scoped geometry invalidation now extends through cancellation and native object undo/redo. Pending changes accumulate until a render rather than losing the previously published scene. Joined descendants are included. Frame seeks, structural changes, authored animation and frame-draft history retain their broader invalidation paths until their dependencies can be tracked correctly.
- Onion samples track native interpolation dependencies. Local edits retain unchanged neighboring keyframe samples and styled geometry through commit/history. Unknown, structural, definition, timing, and authored-animation changes still invalidate broadly. Cache revision tracking subscribes directly to editor events, so a handled revision change no longer unconditionally clears the samples again.
- Editor handles use a retained WebGPU pipeline: one ordered instanced draw, fixed CSS-pixel radii, outline rendering, and per-figure record uploads. Unchanged geometry retains its descriptors. Camera/view changes do not rewrite world-space handle records. The Canvas2D path remains for unsupported devices and the builder-highlight composition mode, whose highlight still sits in the Canvas2D overlay.
- Benchmarking now captures module and stylesheet snapshots, reports startup diagnostics, refreshes target coordinates after selection, and builds fivefold scenes without saving PIV files. Target selection no longer probes every handle against every other handle; that quadratic setup work had become expensive in the fivefold test.

## Measured evidence

Timings end at CPU-complete render submission, not physical scanout. Motion inputs are paced by the automation driver; their delivery rate is not a display-FPS measurement. The UI was being edited in another task, and fit zoom changed between runs. Captured sources/styles keep each run coherent, but historical comparisons are indicative rather than a controlled single-variable measurement at an identical viewport. Freeze removal and reduced rebuilt-object counts are corroborated by the raw instrumentation.

| Operation | Original observations | After this pass |
|---|---:|---:|
| Native node release with onion skin, 60 figures | 286–319 ms | 15–21 ms after cache retention; no long tasks |
| Cancel/undo/redo of ordinary object edits | Approximately 150–220 ms long tasks | No long tasks in the repeated control runs; unaffected figures retained |
| Dense static rig motion, 60 figures | 321–347 ms input-to-render p95 | 12–14 ms p95 with GPU handles in the first confirmation |
| Pan, 60 figures | Approximately 2.1–2.3 ms full frame CPU p95 | Approximately 0.5 ms with GPU handles |
| Shared rig release, 60 figures | 470–519 ms | Approximately 275 ms; **still freezes** |
| Shared rig release, 300 figures | Newly measured | 1.16–1.49 seconds; **major unresolved bottleneck** |
| Fivefold rig motion after per-figure GPU groups | Newly measured | First/repeat CPU p95 10.8 / 5.0 ms; input-to-render p95 73.2 / 11.6 ms; **not uniformly within 144 Hz budget** |

The initial fivefold selected-figure test also recorded a 195 ms first-input delay (52 ms CPU long task), followed by cheap repeated translation. This first-interaction spike needs attribution; it must not be hidden by reporting only warmed motion.

The final fivefold grouped run fitted just above 100% zoom and retained roughly 207 MB of editable scene resources before handle buffers. This again exposes the raster-resolution cliff. Playback packet budgets remain 128 MiB each for CPU and GPU, so current memory duplication/cache policy is not sufficient for this workload. The original zoom-dependent playback issue has not been fixed by these changes.

Evidence under `artifacts/`:

- `dense-scene/drag-1788916042280`: onion/cancellation/history retention, before GPU handles.
- `dense-scene/drag-1788916569744`: GPU rig motion and 16 control/navigation actions.
- `dense-scene/drag-1788916816527`: first fivefold figure/node/rig matrix.
- `dense-scene/drag-1788917099969`: fivefold rig with per-figure GPU upload groups.
- `gpu-handle-verification-1788917093405`: GPU pixel assertions at DPR 1/2, painter order, color, fixed radius, translation, visibility, and upload-retention checks.
- `perf-engine-final-unit-tests.tap`: full Node regression suite.

Latest verification: **957/957 unit tests passed**, GPU pixel checks passed at DPR 1 and 2, and the four accepted benchmark runs above completed 46 actions with zero application/console errors. Both fivefold runs confirmed 300 objects in every frame and unchanged source PIV bytes. These checks establish the changes described here; they do not establish the full performance goal.

Each accepted benchmark has raw per-action timings and source hashes. Development runs that failed startup/target validation are not accepted as performance measurements. The original [baseline](DENSE-SCENE-PERFORMANCE.md) and [gesture investigation](DENSE-SCENE-DRAG-BENCHMARK.md) remain historical evidence, not current pass/fail claims.

## Second pass: retained artwork and playback scheduling

Exact object-local artwork now shares compatibility textures between equivalent instances. The registry compares numeric geometry and full definition/style metadata; a hash match alone is insufficient. It has bounded coordinate records and definition snapshots. An explicit rigid-translation hint keeps existing vector/raster resources across a move commit while the editor still produces the original native geometry. Pose edits clear that hint. Live pose previews avoid expensive content interning.

Playback packets now give identical artwork with an identical local camera crop one bitmap and one transferable. Ordered instances keep separate transforms and draw commands. Packet lifetime and GPU ownership remain unchanged: sharing is **within a packet**, not yet across frames. The source scene reduces from 60 compatibility bitmaps to 30 per packet. The fivefold fixture needs 149 distinct bitmaps: native world-coordinate float rounding and local camera crops distinguish many otherwise similar instances. We do not quantize these differences away.

The 1,000 FPS indicator stress test exposed duplicate animation scheduling: `editor.seek()` could request the next callback during `loop()`, and `loop()` then requested a second callback. The loop now retains the already queued request. The indicator test also rejects playback submission rates above the independently measured display callback rate. This removes an inflated measurement (approximately 281 submissions/s on a 144 Hz display); the retest remained within display cadence. These are submitted scene frames, not proof of physical panel scanout.

| Latest playback measurement | Result | Limitation |
|---|---:|---|
| 60 figures, original 24 FPS, 100–200% zoom | Approximately 24 FPS; no buffering or long tasks during the measured phases | Prepared packets could warm before playback starts |
| 60 figures, 24 FPS, 400% zoom | 4.86–5.00 FPS | One 79.07 MiB frame fits; four cannot remain resident |
| 300 figures, 144 FPS, 100%, first measured run | 84.50 FPS over the phase; first presentation 842 ms after start | Still preparing frames; long intervals approach 1 second |
| 300 figures, 144 FPS, 100%, warmed run | 144.00 FPS; interval p95 7.1 ms, maximum 17.3 ms | No buffering/long tasks, but not every interval meets 6.94 ms |
| 300 figures, 144 FPS, 101% zoom | 0.82–0.95 FPS | Only one 98.12 MiB packet fits; repeated compilation takes roughly 1 second |

At 101–200% zoom, the original scene's four uploaded frames now occupy 79.10 MiB together, below the unchanged 128 MiB GPU budget. At 400%, **each** frame needs about that amount. The fivefold scene's four frames occupy 98.24 MiB at 100%; at 101%, **one** frame occupies 98.12 MiB. CPU packet budgets have the same capacity problem. These measurements identify residency and repeated preparation as the playback bottleneck; a fast `renderPrepared()` timer does not remedy it.

The focused 60-figure drag run measured group release at **97.6–108.2 ms**, down from the original 144–166 ms observation. Native geometry rebuild still consumed 81–88 ms, while incremental GPU preparation took about 1 ms and did not rasterize the moved figures. Shared rig release remained **259–290 ms**: about 60 ms in commit/history, 74–88 ms rebuilding geometry, and 88–103 ms in renderer preparation. These nested method timings must not be added indiscriminately. This remains a freeze, not a completed optimization.

The latest fivefold gesture confirmation, after the scheduling fix, is below. Each first/repeat cell represents one gesture in one process, not a statistically stable distribution across machines. All latency values are milliseconds; motion p95 pools that gesture's matched events.

| Gesture, 300 figures | First move, first / repeat | Motion input-to-render p95, first / repeat | Full frame CPU p95, first / repeat | Release, first / repeat | Long task maximum |
|---|---:|---:|---:|---:|---:|
| Selected figure | 4.4 / 4.2 | 7.3 / 7.8 | 0.9 / 0.7 | 15.2 / 8.8 | None observed |
| Branching node | 17.1 / 14.1 | 14.2 / 13.0 | 8.9 / 6.1 | 19.8 / 18.5 | None observed |
| Shared static rig node | 22.4 / 11.6 | 22.4 / 19.6 | 17.0 / 12.2 | **1520.9 / 1690.7** | **1273** |

The earlier fivefold first-figure delay was not reproduced in this confirmation. Rig motion and release are worse than the best earlier grouped-handle run, so this pass does **not** establish a rig performance improvement. The latest motion sample includes roughly 3.6 ms geometry and 3 ms renderer p95, with other application work contributing to the full frame timer. The release path still needs work across document propagation, geometry, and resource preparation; further attribution must use matching viewport and source snapshots.

Verification for this pass:

- 965/965 Node tests passed in `artifacts/shared-artwork-final-unit.tap` after the final scheduling guard; its behavior is additionally checked in the desktop FPS run.
- `artifacts/artwork-gpu-1788919436695/report.json`: zero pixel difference for identical instances, independent style changes, resource eviction/restoration, zoom boundaries, native fractional drag preview/commit continuity, shared playback at two resolutions, and two visible instances with different camera crops. No asynchronous GPU validation warnings were reported.
- `artifacts/dense-scene/drag-1788918643600`: focused group/rig timings before the scheduling guard.
- `artifacts/dense-scene/drag-1788919328380`: fivefold first/repeat figure, node, and rig confirmation after the guard; raw timings and `drag-summary.md`/`.json` retained.
- `artifacts/dense-scene/stress-1788918894967`: original scene at 24 FPS, four zoom levels; before the scheduling guard.
- `artifacts/dense-scene/stress-1788919256576`: fivefold 144 FPS confirmation after the scheduling guard.
- `artifacts/dense-scene/fps-ui-1788919197042`: green/red indicator, 14 px right and 12 px top offsets, 16 px height, hidden on pause; screenshot visually inspected. Red is tested with an intentional 1,000 FPS target rather than depending on a known slowdown. Coherence uses a 5% tolerance for the one-second counting window.

All listed benchmark runs retained the original PIV bytes, recorded no application/console errors, and reported no source changes during their execution. The early content-signature experiments were slower on group commits; they are development evidence, not claimed wins. Cold startup, high zoom, shared rig commit, and broad sustained interaction remain unresolved.

## Next work identified after the second pass (historical)

1. Extend reusable artwork ownership across frame packets, with bounded CPU/GPU resource accounting and correct eviction, document revision, asset and camera handling. Within-frame sharing and rigid-translation retention are implemented; cross-frame duplication still causes the zoom cache cliff.
2. Make shared-definition commits and restoration update dependencies incrementally or prepare the changed scene without blocking interaction. Preserve propagation across frames, joins, animation origins and undo.
3. Replace full-frame playback resource duplication with bounded shared resources; verify cold playback, repeated playback, frame changes, pause, scrubbing, 100% boundary crossings and 144 FPS scenes at both 1x and 5x size.
4. Attribute remaining first-interaction spikes and rig-mode activation costs; reduce work proportional to total handle count on changed-object updates.
5. Validate the complete matrix at explicit zoom values on the current UI, with high-frequency input, CPU/GPU/presentation evidence, sustained memory checks, and regression coverage for advanced editor modes. The builder-highlight fallback and authored/draft history also need scalability coverage before claiming the full goal.

No successful small-scene check, warmed frame timer, or partially improved benchmark is sufficient to mark this goal complete.

## Third pass: cross-frame reuse, mouse input, inbetweens and preparation latency

Detailed methodology and evidence: [PLAYBACK-PREPARATION-PERFORMANCE.md](PLAYBACK-PREPARATION-PERFORMANCE.md).

CPU packets and GPU-prepared frames now share bitmap/texture ownership across frames. Resource-footprint forecasting replaces the assumption that every tick owns an unrelated full bitmap set. Memory-tier cache defaults are capped at 512 MiB per CPU/GPU cache, with an explicit 128 MiB fallback. This resolves the demonstrated four-frame residency cliff at 101% zoom; the application no longer reinstates its old hard-coded CPU limit.

The playback worker retains bounded raster originals across frame-only revisions, gives packets separate transferable clones, and disposes originals when the document/assets are replaced. It caches immutable compatibility/bounds descriptors, retains one bounded alternate exact pose per independent object, propagates parent changes to joined descendants, and reuses the computed native tween for exactly constant endpoints with easing disabled. Full signatures and native floating-point values remain intact. Stable resource identities use SHA-256 of complete artwork/crop content; the fast local hash still requires a full comparison.

Hover pointer movement now exits during playback/preview, preventing editable-geometry materialization. The real mouse-motion phases confirm zero editor geometry accesses, no buffering and approximately 144 FPS after preparation. The existing modest top-right FPS indicator still measures presented scene submissions against the configured scene rate.

| Latest cold base playback, 101% zoom, 144 FPS target | 60 figures | 300 figures |
|---|---:|---:|
| Empty worker/CPU/GPU caches to four prepared ticks | 346 ms | 1,991 ms |
| First presentation | 302 ms | 1,569 ms |
| Play after one frame edit to four prepared ticks | 115 ms | 457 ms |
| First presentation after edit | 39 ms | 128 ms |
| Stationary / mouse-motion FPS | 144.03 / 144.01 | 143.92 / 144.00 |
| Prepared GPU bytes after edit | 23.17 MiB | 112.46 MiB |

Evidence: `playback-input-1788922457868` and `playback-input-1788922491587` under `artifacts/dense-scene`. All source files and PIV bytes remained unchanged during those frozen-source runs, with no application errors. Warm phases had no buffering or observed long tasks. The original scene's edit command still had a 174 ms long task, separate from its subsequent 115 ms replay preparation.

For the 25/49-tick inbetween workflow at 100% zoom, the original scene measured 997 ms from truly cold Play to 25 prepared ticks, 1,051 ms after inserting three keys to prepare 49 ticks, and 926 ms to reprepare after a one-frame edit (`inbetweens-1788922325497`). The fivefold scene measured 3.81 s, 7.19 s and 2.94 s respectively, with idle prefetch allowed before the first phase (`inbetweens-1788922166085`). Earlier same-turn edit-to-ready runs measured 21.07 s, 15.38 s and 4.36 s as the reuse stages were added. These are indicative successive runs, not randomized repeated A/B trials.

Verification completed:

- **997/997 tests passed**, `artifacts/playback-preparation-final-unit.tap`.
- **474 JavaScript files checked, zero syntax errors**, `artifacts/playback-preparation-syntax.log`.
- **18 real GPU comparisons, zero pixel difference**, with no reported validation warnings: `artifacts/artwork-gpu-1788922265039/report.json`. Coverage includes independent bitmap/texture lifetime, full worker resource disposal, revision changes, fractional native transforms and native/tween transitions.
- The source PIV hash remained unchanged in every completed accepted benchmark. Earlier harness-only failures (initial navigation and cache discovery), an occluded-window 1 Hz run, and benchmarks before frozen-source serving are retained as diagnostics, not accepted engine-performance results.

At the end of this pass the full goal remained active. Next priorities were dependency-aware retention of unaffected frame packets across edits; cooperative/sparse duration and inbetween history/render updates; shared static-rig release; and sustained streaming/high-zoom/input validation beyond a resident 49-tick working set. Corrected fivefold duration/insertion maxima were 921–965 ms: the earlier 1,119 ms notification belonged to setup, outside the measured phase. Some warmed frame intervals exceeded 20 ms. No claim of a freeze-free application was supported.

## Fourth pass: sparse timing history and retained editor navigation

Duration and Extend commands now record only the changed duration fields, retaining the native figure arrays and frame IDs. Undo/redo apply the same sparse fields, update frame lookup and timeline state, and preserve selection semantics. Simple-mode field checkpoints support discard and history; interpolated/authored poses still reevaluate when timing changes. A native pose at the same key's start can keep its geometry.

The editor now uses the bounded exact geometry cache for native frame navigation, clearing it before mutable edits and definition changes. Inbetween publication may keep the baseline because it publishes separately owned new frames without changing existing figures or definitions. Property edits arriving immediately after a seek resolve the retained baseline before mutation, so subsequent object-scoped invalidation has a valid current pose.

A new real GPU comparison caught and fixed an integration bug during this work: choosing an alternate cached geometry object must also mark that slot changed relative to the last displayed scene. Reusing native geometry does not make the GPU notification optional. Tests now exercise alternating keys, duration history, inserted keys, and fresh-reference pixels. Intermediate pre-fix navigation runs are diagnostic evidence, not final correctness evidence.

The benchmark now drains pending long-task records and filters by each task's actual start time. It retains excluded records separately. This avoids counting a late setup notification against the next action. For example, the initial timing-only run's 1,214 ms notification ended before the duration phase began. The harness also records HTTP startup failures and handles source-file removals during final verification without losing normal report cleanup.

Focused duration confirmation on 300 figures (`artifacts/dense-scene/timing-1788923313264`, 144 FPS scene, native key at 100% zoom): duration commands took **4.2 ms first / 1.6 ms repeat**; undo/redo **0.7–2.0 ms**. History for the three changed keys was **1,202 bytes**. Geometry remained retained and no main-thread long tasks started inside any of the eight measured operation phases. These measurements cover duration/Extend/history architecture, not arbitrary editor actions.

Real GPU verification: **27 comparisons, zero pixel difference**, with no reported GPU validation warnings, `artifacts/artwork-gpu-1788923872087/report.json`. Focused CPU tests cover mutable edits, cancel/history, document/definition replacement, joins, sparse duration validation/selection, and Simple discard. The latest broad run reached **1,021/1,022 passing** (`artifacts/timing-navigation-verification.tap`); the remaining failure is `tests/style-opacity.test.mjs:135`, which expects an outline-opacity inspector control absent from concurrently changed UI. The earlier easing assertions were updated by that concurrent work and are no longer failing. Syntax verification checked **489 files with zero errors**, plus a subsequent direct check of the final renderer profiling additions.

The corrected full fivefold confirmation is `artifacts/dense-scene/inbetweens-1788923897450`. It served captured source modules/styles despite subsequent workspace changes, reported no application errors, and preserved the PIV bytes. Duration command/history work took **3.6 ms / 1,202 bytes**. During the duration, insertion and local-edit phases, the longest editor geometry calls were **14.1 / 13.9 / 13.6 ms**, down from whole-scene rebuilds in the hundreds of milliseconds. Insertion completed in **640.5 ms**, including **138.4 ms** of cooperative staging and **8.1 ms** commit time.

This did **not** remove every freeze: that same run rasterized 146 editor textures during layout refreshes, taking **236 / 333 / 246 ms** in renderer calls and producing **260 / 351 / 261 ms** long tasks in those phases. Worker preparation after insertion still took **6.91 s** for 49 ticks; after a local edit it took **3.55 s**. Warmed after-insertion/after-edit playback returned to approximately **144 FPS**, but the stationary phase averaged 143 FPS and preparation included a 112 ms long task. The measured geometry gain is real; a freeze-free workflow is not yet established.

An additional four-key fivefold run (`playback-input-1788924146666`) measured a local edit's geometry at **9.9 ms**, renderer at **11.6 ms**, with no long tasks inside that edit phase; mouse playback measured 144 FPS. It also recorded 146 raster-resolution cache misses cumulatively, alongside initial uncached artwork and some released resources. The profiler now records per-render miss reasons and small resolution samples to distinguish cold artwork, released textures, generation changes and resolution changes. That final per-render reset was added after this diagnostic run, so its recorded counters are cumulative and must not be misread as one-frame counts.

Next work remains: retain bounded reusable editor raster variants across layout/view transitions, trace the remaining resize/resolution changes, retain unaffected playback packets across local revisions, and retest ordinary/rig drags, high zoom and sustained memory on the corrected engine. The full goal remains active.

## Fifth pass: bounded editor raster ownership

The per-render diagnostics confirmed two independent causes of unnecessary repainting. Crossing from the initial fit scale (1.0037) to 100% changed the raster resolution from 2 to 1, destroying the previous variant. Returning from a different pose also found released textures: one local-edit render had **145 released unchanged artworks plus one uncached changed artwork**. The geometry/artwork identity was already reusable; texture ownership prevented reuse.

`EditorRasterCache` now owns exact artwork/resolution/generation variants independently of the displayed layout. It retains unused variants with LRU eviction under **128 MiB / 1,024 entries**, and protects every texture used by the newly published layout. Allocation during layout construction may temporarily exceed the budget; if the active scene alone exceeds it, all inactive variants are evicted while required active resources remain valid. Asset-generation changes retire stale inactive variants; document replacement and destruction release the entire cache. Private scene staging transfers or disposes its own cache. No coordinate rounding, reduced resolution or altered pixels was introduced.

The before/after fivefold inbetween runs used the same captured application sources except `renderer.mjs` and the new raster-cache module. Both preserved the source PIV and reported no application errors. The baseline continued serving its snapshot while the workspace renderer was edited; the after run reported no source changes. These are consecutive controlled-source runs, not randomized statistical trials.

| Fivefold scene, 300 figures / 188,700 segments per key | Before | Retained raster variants |
|---|---:|---:|
| Slowest editor render during inbetween insertion | 406.8 ms | 2.9 ms |
| Slowest editor render after local frame edit | 232.8 ms | 6.7 ms |
| Long task during insertion / edit | 425 / 249 ms | None observed / none observed |
| Three-key duration command | 3.5 ms | 3.7 ms |
| Mouse-motion playback after preparation | 144.00 FPS | 144.00 FPS |
| Prepare 49 ticks after insertion | 7,411 ms | 5,895 ms |
| Prepare 49 ticks after edit | 3,503 ms | 2,682 ms |
| First submitted frame after edit | 403 ms | 84 ms |

Evidence: `artifacts/dense-scene/inbetweens-1788924511682/report.json` (before), `artifacts/dense-scene/inbetweens-1788924632894/report.json` (after). The after run's editor cache ended at **127.75 MiB**, with **417 variants / 28 evictions** and **24.14 MiB** of active artwork. This is additional bounded GPU residency: the previous renderer kept only current layout artwork. Prepared-playback caches and GPU buffers have separate budgets/accounting. The preparation-time differences include scheduling variation; the directly observed win is removal of redundant editor rasterization.

The after run had no observed main-thread long tasks in its measured phases, but preparation still buffered and animation-frame gaps reached hundreds of milliseconds. Native geometry/edit handlers also exceeded the 6.94 ms budget in places. Thus neither preparation nor all interaction is yet proven smooth at 144 Hz.

Raw render samples confirm zero rasterizations during insertion and only one changed raster during the local edit. Pause/setup intervals between these named phases are not included in their latency figures. Cold artwork, a previously unseen pose/resolution, or an evicted variant can still require synchronous rasterization; the phase improvement must not be read as elimination of every pause/seek hitch.

Verification: **29 real GPU comparisons with zero pixel difference**, no reported GPU warnings (`artifacts/artwork-gpu-1788924714762/report.json`), including return to an inactive pose/resolution, asset invalidation, private multi-resolution staging disposal/publication, native transitions and playback resource lifetime. **1,024/1,025 unit tests passed** (`artifacts/editor-raster-retention-unit.tap`); the one existing failure remains the concurrently changed outline-opacity inspector assertion. **491 JavaScript files passed syntax checks** (`artifacts/editor-raster-retention-syntax.log`). The system npm launcher pointed to a missing npm CLI, so verification used the equivalent direct Node commands. Three new unit tests cover generation safety, LRU order, entry/byte limits, active-layout protection and single destruction.

Next architectural target: `PlaybackCache.updateDocument()` still invalidates every CPU packet on a local patch, and the app clears every prepared GPU frame. Retaining unaffected packets requires explicit dependency tracking across native neighbor easing, inserted/shifted ticks, authored channels, retained frame sources, camera/view changes and undo. A local-frame shortcut without those dependencies would risk stale animation. Broad fivefold gesture remeasurement is also required before extending the renderer gain to node/rig claims.

### Fivefold gesture remeasurement

`artifacts/dense-scene/drag-1788924810724` completed **88 measured gestures** before an unexpected pointer move interrupted the next rig gesture. The failure capture shows that the requested pointerdown correctly started the rig drag, followed by a pointer move to `(824, 346)` outside the harness's requested trajectory; the subsequent target assertion failed. That interrupted gesture is excluded. The completed data and source hashes are retained, with captured source modules served throughout workspace changes. The PIV remained unchanged. `drag-summary.md` in that directory keeps first gestures and repetitions separate and includes input dispatch delay; the raw `row.parts.*.eventToRenderMs` instead starts at event-handler capture. Do not compare those two latency definitions interchangeably.

The completed sample shows:

- Ordinary single-figure motion had approximately **0.5–0.9 ms pooled CPU p95** at fit scale; input-event-to-submission p95 including dispatch was **7.1–7.7 ms**. First node drags were slower: branch-node first movement **18.5–22.7 ms including dispatch**, versus **6.8–14.2 ms** on repetitions.
- Moving 60 figures remained inexpensive during motion (**1.2–1.8 ms CPU p95**), but release took **107.5–142.6 ms including dispatch**. One release attributed **117.2 ms** to geometry, **15.4 ms** to commit and **1.4 ms** to rendering. These method durations include nested work and should not all be added.
- Shared static-rig release remained **1.38–1.80 s**, and the selected-handles variant reached **1.96 s**. A representative first release spent **288 ms** in the reusable-definition commit, **488 ms** rebuilding editor geometry and **518 ms** in the renderer. Texture reuse cannot eliminate compilation of genuinely changed geometry/artwork across all 300 instances.
- One onion trial recorded **463 / 668 / 126 ms** long tasks inside the measured motion interval, while measured render and editor-geometry calls stayed below 13 ms. Their cause remains unassigned; the observation does not justify blaming rasterization, autosave or garbage collection without a matching trace.

Long-task aggregation in both drag summarizers now filters by actual task start within the measured gesture, including when reprocessing earlier raw captures. Raster eviction diagnostics retain only weakly keyed scalar metadata, allowing later misses to distinguish released resources from never-seen artwork without retaining destroyed GPU handles. The final diagnostic adjustment passed 10 focused cache/staging tests and a direct syntax check.

The remaining scenarios completed in `artifacts/dense-scene/drag-1788925293818`: **24/24 measured gestures**, no application errors, unchanged PIV, with captured sources served during a concurrent `onion-skin.mjs` edit. This run's source snapshot also contains concurrent editor/inspector changes relative to the first drag run, so their samples are kept separate. It covers the full overlay-disabled rig scenario, fast node input, and figure/node dragging immediately after changing frames. Overlay-disabled rig release still took **1.22–1.48 s**. Fast node input reached approximately **45–66 input events/s** through automation; first-trial motion had **37.9 ms input-to-submission p95**, with repetitions at **11.8 ms**. This does not establish 144/1,000 Hz input handling. The frame-change-first phases retained **120–140 ms** long tasks even though subsequent motion was much cheaper. The combined captures contain 112 completed gestures, including repeated coverage of the interrupted scenario, not 112 independent scene configurations.

The immediate follow-up priorities are therefore: preserve unaffected playback packets with correct dependencies; move shared rig validation/history/geometry/artwork preparation off uninterrupted input tasks; avoid eagerly rebuilding every moved figure's exact CPU geometry at group release; and trace the remaining cold frame/onion/first-input stalls. Simple root-offset substitution is insufficient for native geometry because endpoints round to Float32 at every segment; any lazy or cooperative replacement must preserve those native calculations and join behavior. The full 144 Hz, fivefold, freeze-free goal remains active.

## Sixth pass: retain playback work across local edits

This pass addresses the repeated preparation after an ordinary native-frame edit. Previously every edit invalidated every CPU packet and GPU frame, even when most sampled frames had no dependency on the edit. `playback-retention.mjs` now records a small metadata/timeline snapshot and retains only packets whose inputs and absolute tick locations remain unchanged. Native interpolation depends on its current and next key; legacy angular unwrapping conservatively invalidates all interpolated samples when any native key changes. Shifted durations invalidate displaced ticks. Structural edits, definition/asset changes, view changes, authored channels and Simple drafts retain their conservative invalidation paths. Pending worker patches accumulate dirty inputs until acknowledgment, so superseding edits cannot accidentally preserve stale packets.

CPU packets and GPU buffers retain their immutable keys/revisions. A separate, controller-unique ownership epoch allows verified unchanged resources to coexist with newly compiled packets; stale worker responses are still rejected by request revision. Pixel identity uses the full artwork fingerprint and raster parameters rather than the document revision. The app now retains matching GPU frames after local edits and explicitly scoped native history changes, including undo/redo. There are no file-name, figure-count or benchmark-specific branches.

The compatibility path without worker OffscreenCanvas now owns its raster textures within the prepared-frame cache, separately from editable-scene eviction. These resources are reference counted, charged to the GPU budget, released on eviction/failed allocation/disposal, and cannot be destroyed by an unrelated editor layout. This closes a lifetime hole uncovered during the cache review.

### Current measured playback

Consecutive isolated Electron runs used captured source modules, a 144 Hz display, the original scene at 144 FPS and the in-memory fivefold document at 60 FPS. These are individual six-second warmed samples, not guarantees across hardware or every possible scene. Preparation starts at the harness's play request after the documented setup; these values are not file-import/cold-process times. No unit suite ran concurrently with these two confirmation benchmarks. The earlier diagnostic `inbetweens-1788925987432` overlapped a unit run and predates the final artwork-key fix, so it is excluded from performance conclusions.

| Measurement | Original, 60 figures / 144 FPS target | Fivefold, 300 figures / 60 FPS target |
|---|---:|---:|
| Prepare all 25 sampled ticks | 809 ms | 3,335 ms |
| First presentation in that preparation phase | 100 ms | 269 ms |
| Warm stationary playback | 143.34 FPS | 60.03 FPS |
| Warm playback while moving the mouse | 144.00 FPS | 60.03 FPS |
| Prepare all 49 ticks after inserting three keys | 1,422 ms | 5,870 ms |
| Warm playback after insertion | 144.00 FPS | 60.03 FPS |
| Packets retained after editing one frame | 41 of 49 | 41 of 49 |
| Packets compiled/uploaded again | 8 | 8 |
| Complete preparation after that edit | **157 ms** | **534 ms** |
| First presentation after that edit | 36 ms | 87 ms |
| Warm playback after edit | 141.34 FPS | 59.98 FPS |
| Known CPU packet/bitmap working set after edit | 21,773,752 bytes | 103,168,776 bytes |

The prior fivefold pass recompiled all 49 ticks after editing and took 2,682 ms at a 144 FPS target. The new fivefold run targets 60 FPS, so that wall-time comparison is indicative, not a same-setting speedup ratio. The directly verified architectural improvement is preserving 41 CPU/GPU packets and rebuilding only eight. Both confirmation runs recorded no application errors and left the source PIV unchanged. The fivefold run served its frozen snapshot while `keyframe-easing-view.mjs` changed in the workspace; the normal run reported no source changes. The subsequent ownership-only fallback fix was checked separately and does not change the benchmark's OffscreenCanvas path.

### Newly explicit transition measurements and limits

The benchmark now measures pause-to-edit as its own phase. Earlier playback numbers omitted those transitions. The normal run recorded **398 ms and 201 ms long tasks** on two pauses; the fivefold run recorded **1,141 ms and 979 ms**. One fivefold pause spent 471 ms in editor geometry and 581 ms in the renderer; another spent 533 ms and 362 ms respectively. Returning from prepared playback to exact editable geometry/artwork remains a major synchronous reconstruction path. The inexpensive pause after insertion landed on a more reusable pose; it does not invalidate the other observations.

Warmed averages also hide occasional stalls: the normal post-edit sample had a 75.6 ms maximum presentation interval and 69.4 ms maximum rAF interval; fivefold post-edit had a 41.7 ms maximum presentation interval. Neither had a reported main-thread long task during that warm interval, so the present instrumentation does not assign their cause. Mouse automation delivered 295 and 317 moves over six seconds, respectively; this verifies that trajectory, not a 1,000 Hz physical input device. Playback mouse phases performed no editor-geometry rebuilds.

Structural insertion still invalidates the timeline broadly, and genuinely new tween artwork must be compiled. Fivefold local edit geometry reached 19.8 ms even though no 50 ms long task was recorded. Group release, rig release and first-node/frame/onion limitations from pass five remain open; this pass does not claim improvements to those gestures. Next work should address interruptible exact editor preparation at playback exit and shared-rig release, while preserving native Float32 evaluation, joins, hit testing and history. The target is now explicitly normal 144 FPS / fivefold 60 FPS; **freeze-free operation is not yet achieved**.

### Verification and artifacts

- `artifacts/dense-scene/inbetweens-1788926166658/report.json`: fivefold 60 FPS confirmation, with source snapshot and raw phases.
- `artifacts/dense-scene/inbetweens-1788926278096/report.json`: original-scene 144 FPS confirmation.
- `artifacts/playback-retention-final-focused.tap`: **22/22 passing**, including dependency retention, pending patch cancellation, controller namespace isolation, shared GPU resources, fallback resource lifetime/budgets and editor raster eviction.
- `artifacts/artwork-gpu-1788926652183/report.json`: **47 rendered comparisons, all zero pixel difference**, including 17 retained/new mixed-revision ticks, camera crops, native fractional translation, resource disposal and fallback/editor ownership isolation.
- `artifacts/playback-app-patch.json`: **15 actual-app flows passing**, covering native local edit/undo/redo retention, additions/deletions, multiframe translation/camera, asset tables and authored source history. All checked packets match fresh compilation; no application errors.
- `artifacts/playback-retention-unit.tap`: broader suite **1,037/1,038 passing** before the final fallback ownership adjustment. The remaining failure is the existing inspector `outline_opacity` markup assertion in `tests/style-opacity.test.mjs:135`, in UI files concurrently edited outside this optimization pass. It is recorded rather than hidden or changed opportunistically. The changed ownership paths were subsequently covered by the focused and real-GPU checks above.
- `artifacts/playback-retention-final-syntax.log`: final direct syntax scan completed successfully.

## Seventh pass: compile shared geometry definitions once per build

Native geometry construction used to recreate the segment-ID index, hierarchy traversal and polygon-edge lookup for every figure instance. `pivot/geometry-definition.mjs` now compiles that definition-only data once per geometry build and shares it across instances. The cache belongs to the build request; subsequent mutable definition edits naturally receive a new plan, without a global invalidation protocol. Instance styles resolve their own figure before plan lookup. Individual coordinates, native Float32 endpoint rounding, joins, reverse curved edges, colors and painter order retain their existing evaluation. Malformed duplicate-ID definitions retain the original per-instance edge-map fallback. Segment cycle-detection sets are allocated only when recursive resolution is actually needed, and an absent color override no longer constructs a discarded color object per drawable.

Playback retention also now accounts for the current Auto easing implementation's preceding/following tangent keys. Editing a non-endpoint neighboring key or ending an adjoining Auto run invalidates the affected samples. This is covered by full packet-output comparisons against fresh evaluation, not just retained-frame counts.

### Controlled CPU comparison

`scripts/benchmark-geometry-definition.mjs` imports the unchanged source PIV through the isolated backend and compares the current builder with the captured pre-change source tree in `inbetweens-1788926278096/sources`. Eight paired trials alternate execution order; explicit GC happens outside each timed region. These numbers isolate geometry CPU work in Node and exclude rasterization, input latency and physical presentation. They are not a claim that an entire editor frame now fits the 16.67 ms fivefold budget. Complete per-instance output fingerprints (including native coordinates, segment/polygon/style/asset data and order) match for all four cases. Shared object/figure references are represented by identity in the digest rather than repeatedly serializing the same source table.

| Geometry build | Previous median | Current median | Reduction |
|---|---:|---:|---:|
| Original scene, native key | 89.42 ms | 58.86 ms | 34.2% |
| Original scene, tween | 90.33 ms | 66.86 ms | 26.0% |
| Fivefold scene, native key | 428.66 ms | 345.00 ms | 19.5% |
| Fivefold scene, tween | 412.30 ms | 328.57 ms | 20.3% |

Raw trials and fingerprints are in `artifacts/geometry-definition-1788927343580/report.json`. The statistical median is the average of the two middle observations; that summary was recomputed from the preserved raw samples. The earlier successful `geometry-definition-1788927119811` measures shared plans before the two allocation reductions. An exploratory serialization run was stopped because its diagnostic digest redundantly expanded shared figure references. A later partial run overlapped the ending syntax scan and was stopped/excluded. Neither partial run supports the table.

### Desktop confirmation and reproducible pauses

The original desktop confirmation `inbetweens-1788927427688` encountered an unexpected playback stop and selection change before its pause command. Inbetween preparation then correctly rejected the changing animation. It is excluded from the performance comparison; it is not counted as a successful gesture or attributed to geometry planning. The isolated benchmark window now ignores native desktop mouse events and cannot take keyboard focus, while CDP still supplies the requested interaction events. Input/state diagnostics and a pre-pause playback assertion make unexpected changes visible.

The resulting `inbetweens-1788927551953` completed with no errors or source changes and preserved the PIV. Fivefold warmed playback stayed approximately **60 FPS**, including 323 automated mouse moves over six seconds. Local edits still retained **41/49 packets**, compiling/uploading eight; preparation completed in **522 ms**. Initial 25-tick preparation took 3,095 ms and post-insertion 49-tick preparation took 6,073 ms. One pause reused geometry in 3.3 ms; another required 348 ms of geometry and 614 ms of rendering, producing a **1,043 ms long task**. These poses differ from the preceding pass, so subtracting their pause durations would not be a controlled optimization result.

`STYK_BENCHMARK_PAUSE_TICKS=5,13,21` now activates the actual pause button in a microtask immediately after the specified tick is presented. This preserves the editor/playback packet relationship and makes the sampled pause pose reproducible. It uses DOM button activation rather than physical click dispatch, records that distinction and the activation timestamp, and leaves the subsequent editor reconstruction inside the measured phase. The phase also contains the short wait for the target tick; use the separately reported long tasks and method durations for reconstruction cost.

The fixed-tick run `inbetweens-1788927739560` completed with no errors/source changes and an unchanged PIV:

| Pause phase | Target tick | Largest long task | Editor geometry | Renderer |
|---|---:|---:|---:|---:|
| After mouse playback, 25 ticks | 5 | **1,045 ms** | 338.8 ms | 611.6 ms |
| After inserting three keys, 49 ticks | 13 | 176 ms | 68.2 ms | 17.5 ms |
| After editing one key, 49 ticks | 21 | **780 ms** | 386.8 ms | 327.1 ms |

This run again held roughly 60 FPS warmed, retained 41 packets after the edit, and rebuilt the eight affected packets in 418 ms. Preparation still showed substantial rAF gaps even without reported main-thread long tasks; the geometry microbenchmark does not explain those gaps. The work has reduced CPU reconstruction cost, but **pause-to-edit remains synchronous and visibly freezes**. The next transition change must prepare exact editable geometry/artwork cooperatively or reuse it safely, with cancellation and input handling; it must preserve uncropped editor content, camera behavior, handles and hit testing. Cropped playback bitmaps cannot simply replace the editable canvas.

### Verification

- `artifacts/geometry-definition-final-focused.tap`: **14/14 passing**, including native/legacy mixed-primitive baseline fields, cooperative equivalence/cancellation, mutable definitions, instance-style isolation, cyclic hierarchies, reversed curves, and Auto-easing packet retention.
- `artifacts/artwork-gpu-1788927233004/report.json`: **47 rendered comparisons, zero pixel differences**, covering existing artwork sharing, camera crops, native edits, mixed retained/new revisions, resource ownership and staging.
- `artifacts/geometry-definition-unit.tap`: broad suite **1,044/1,046 passing**. One new assertion initially expected unquantized 0.25 opacity; the native byte value is 64/255. The assertion was corrected and passed in the focused run. The other failure remains the pre-existing inspector `outline_opacity` markup assertion in concurrently edited UI code.
- `artifacts/geometry-definition-syntax.log`: **497 JavaScript files, zero syntax errors**. Subsequent benchmark-only input isolation/fixed-tick changes were exercised by the completed desktop runs above.

### First-gesture confirmation after the geometry change

`artifacts/dense-scene/drag-1788927847405` completed **four of four first gestures** on freshly reloaded fivefold documents: selected figure, branch node, 60-figure group and shared static rig. The PIV remained unchanged and no application errors were recorded. Captured sources were served while `timeline.mjs` changed in the workspace. This focused confirmation contains one gesture per case, not repeated-trial statistics; earlier broad repetition results remain separately identified in pass five.

Motion CPU p95 was 1.0 ms for the single figure, 11.2 ms for the branch node, 1.4 ms for the group and 10.4 ms for the rig. Measured release from handler capture to CPU submission remained **107.2 ms for the group** and **1,288.1 ms for the rig**. The rig release spent 287.5 ms in commit, 273.5 ms in geometry and 657.9 ms in rendering; nested method durations should not all be added. Its rebuilt definition affected all 300 instances, as intended. The first branch-node movement took 23.4 ms from handler capture, still above the 16.67 ms fivefold budget. Automation delivered approximately 21–30 motion events/s in this confirmation; these latencies and CPU samples do not establish high-rate physical-input behavior. Raw records also preserve dispatch delay and input-to-submission values separately.

The lower geometry CPU cost is verified, but the release/transition budget is still missed substantially. General, cancellable preparation and reducing synchronous renderer publication work remain necessary; the overall goal stays incomplete.
