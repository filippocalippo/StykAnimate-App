# Animation mode performance

Measured on 2026-09-09 on an AMD Ryzen 5 5500, Node 24.11.0, Windows. Browser checks used installed Chrome, WebGPU on an NVIDIA Lovelace adapter, and a 1440×960 viewport. These are editing measurements on this machine, not a guarantee of playback FPS or latency on other hardware.

## Workloads and measurements

The same fixture and operation sequence were run before optimization and twice afterward, in separate Node processes without concurrent benchmarks. Each case uses native two-tick frames and linear scalar curves. The many-keys case deliberately extends authored animation beyond the native frames, so Add must preserve and shift the continuing authored tail.

| Workload | Native frames | Figures per frame | Scalar keys |
| --- | ---: | ---: | ---: |
| Small | 100 | 10 | 1,000 |
| Long | 10,000 | 10 | 10,000 |
| Dense | 200 | 500 | 50,000 |
| Many keys | 1,000 | 20 | 200,000 |

Each Node run measures cold geometry separately, then seven edit/undo/redo cycles in each mode, eight previews per gesture, native pose edits, seven clean mode round trips, and three working-frame Add/undo/discard cycles. Timing excludes fixture construction; loading is reported separately. With only seven or three samples, the reported p95 is effectively the maximum; use repeated runs when investigating a regression.

Median model operation times in milliseconds; the final column gives the range of medians across the two final runs:

| Workload / operation | Before | After |
| --- | ---: | ---: |
| 200,000 keys / Simple scalar commit | 72.4 | 5.1–5.5 |
| 200,000 keys / Simple undo | 158.7 | 0.7–0.8 |
| 200,000 keys / Simple redo | 263.5 | ≈0.5 |
| 200,000 keys / Simple pose commit | 65.8 | 0.6–0.7 |
| 200,000 keys / Add working frame | 569.7 | 88.8–95.7 |
| 10,000 frames / Add working frame | 212.6 | 25.1–28.8 |
| 500 figures / Add working frame | 141.3 | 36.4–37.5 |

Clean mode transitions in the model remained below 0.02 ms at the median. This excludes mounting the timeline UI. A dirty Add transition also creates a frame and therefore includes that operation's cost.

The browser benchmark loads each large workload into the real app, renders between edits using animation frames, and tracks main-thread long tasks. It exercises five scalar and native pose edits per mode, undo/redo, Settings mode changes, and Add. It verifies the added pose and frame count and fails on uncaught page errors. The final run found no tasks over 50 ms during the sampled Advanced or Simple editing phases. Browser Add took 25.7 ms for Long, 40.4 ms for Dense, and 89.0 ms for Many keys; the last case produced a 95 ms long task. Frame interval p95 during editing ranged from 7.1 to 20.9 ms. These intervals are responsiveness samples, not a playback benchmark. Screenshots of all three workloads are saved for inspection.

Add still scales with the number of affected keys and native frames. The 200,000-key case can briefly pause the UI; the final Node run's slowest Add was 118 ms. Automatic easing may also require bounded local sampling. Raster-heavy scenes, maximum-size documents, continuous playback, and lower-end devices need separate workloads before making broader claims.

## Memory and regression guards

A separate process exercises 200 committed pose edits on 2,000 native frames, 20 figures per frame, and 40,000 scalar keys, with a 12-command history. After explicit garbage collection every 50 edits, retained source captures stayed at 13 and history at 12 commands. Heap usage grew by 117,040 bytes (about 114 KiB) between edits 100 and 200. The test verifies the final pose and fails if retained growth exceeds 8 MiB or source/history bounds are exceeded. This checks a plateau after history fills, rather than expecting each undoable edit to allocate nothing.

The general timing runner records process heap/RSS and within-workload retained growth. It runs multiple workloads in one process, so those are not isolated per-document allocation measurements. The original baseline's `loadedHeapBytes` difference can be affected by collection of the preceding workload and must not be used for a memory comparison. Use the isolated memory test for retention claims. History byte accounting is an estimate, not measured heap size.

`tests/animation-performance.test.mjs` supplies deterministic guards without machine-dependent millisecond assertions:

- An edit and Simple undo/redo must not read unrelated key payloads, serialize the full animation, or validate it again.
- Undo/redo snapshots must remain intact through subsequent key edits.
- Expired captured poses must be collected after bounded history fills, while retained history still replays correctly.
- Incremental Add validation must match full validation and reject invalid new easing and shifted timeline limits.
- A plain append must leave untouched native tracks native and preserve prior figure, camera, and background output across hold, linear, ease-in, ease-out, and Bézier interpolation.

The final full unit run passed 1,090 of 1,092 tests, with the same two failures present before this performance work: `clipboard-legacy-codec.test.mjs` and the outline-opacity markup expectation in `style-opacity.test.mjs`. The subsequently added interpolation guard also passed; all six performance regression tests pass. The mode browser regression passed all eight checks, all three large-workload browser cases passed, and syntax checking reported zero errors.

## Architecture constraints

Animation history shares immutable channel records. Every editing operation must copy a channel before changing its keys, target, or nested values. Replay reuses the table reference; history byte estimates serialize only changed channels and cache their sizes in a WeakMap. New animation operations must preserve this invariant to keep history correct and work proportional to the edit.

Frame-source collection visits each shared pose channel once per sweep, caches its referenced IDs, and intersects the smaller of that set and the collectible-source set. Live documents, draft checkpoints, and both history stacks remain retention roots. WeakMaps do not keep expired commands or channels alive.

Internal history restore reuses previously validated state. Project loading and persisted checkpoint restoration still validate untrusted data. The Add planner's `trustedSource` path is only for the validated Editor projection: it checks shifted time bounds and total channel/key limits, then validates new/changed keys. Clipboard callers retain full validation. Existing key values are shared only when immutable; shifted key records are copied.

A plain append after the native final frame leaves unaffected native Scene, Camera, and layer tracks native. Authored pose tracks still receive their required boundary keys. Automatic easing and authored tails use the preservation planner. This avoids generating a movie's worth of Scene/Camera keys merely to append a pose.

## Reproduce

Run the benchmarks sequentially on an otherwise idle machine. Raw JSON includes source hashes for the Node timing runs; output is under `artifacts/animation-mode-performance/`.

```sh
node --test tests/animation-performance.test.mjs tests/animation-mode-sync.test.mjs tests/frame-clipboard-authored.test.mjs
node --expose-gc scripts/benchmark-animation-modes.mjs local
node --expose-gc scripts/benchmark-animation-modes.mjs local-repeat
node --expose-gc scripts/benchmark-animation-memory.mjs
```

With the development server running at `http://127.0.0.1:47831` (or `STYK_URL` set to another address):

```sh
node tests/animation-mode-performance.browser.mjs
node tests/animation-mode-sync.browser.mjs
```

Recorded comparison files are `before.json`, `after.json`, and `after-repeat.json`; browser output is `browser.json`, and isolated retention output is `memory.json`. Package scripts also expose `benchmark:animation-modes`, `benchmark:animation-memory`, `test:animation-performance`, and `test:animation-performance:browser`.
