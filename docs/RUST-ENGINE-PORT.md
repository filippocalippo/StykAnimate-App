# Rust engine port: the living plan

The single source of truth for moving StykAnimate's engine from JavaScript and Python to
Rust. It is updated at every milestone. Read this page and `git log engine-rust` to resume;
nothing here should need re-deriving.

- **Branch:** `engine-rust` (from `main` at `96ebce85`), public on GitHub since 2026-10-22 and followed
  in a draft pull request against `main`; nothing released. That day its history was moved onto the
  open-source history: commit IDs written earlier on this page and in `docs/engine/` are the old ones,
  and [`engine/history-map.tsv`](../engine/history-map.tsv) gives the commit each became.
- **Status in one line:** the cutover is complete: the Rust engine is the app's only engine
  (2026-10-25); the next phase is performance.
- **Handoff:** the next section: how the app works now, gate results, what remains, known
  differences and the next phase. The milestone log stops at the cutover; git history has the rest.

## Handoff (2026-10-26, cutover complete)

**Where it stands.** The Rust engine is the app's only engine. On the user's steer of 2026-10-24
(cut over completely and delete the JavaScript engine, clean and correct, quickly; performance
tuning is a later phase) the five cuts are done: (1) the engine owner is the only path and the
shadow, adoption packets, mirror write-back and every opt-in or off switch are gone; (2) the mirror
is gone: the engine opens files into its own store and the stage draws the session's document;
(3) the JavaScript renderer, playback workers, prepared frames, effect executors and frame
fallbacks are gone; (4) the JavaScript command implementations and evaluation are gone and the
interface reads engine queries; (5) nothing Python ships. `engine-rust` at `3bb99e16` passed the
cut-4 gate and is pushed; the draft pull request against `main` is unchanged.

**How the app works now.**
- Each open document is a `styk-edit` session: one per project tab, one per movieclip entered. The
  engine opens it from the file's bytes (`src/engine/engine-open.mjs`). The owner
  (`src/engine/engine-owner.mjs`) installs every session command on the editor
  (`src/engine/engine-commands.mjs`, held to the session's dispatch by
  `tests/engine-owner-command-list.test.mjs`). The editor keeps a read view patched from the
  session's answers, and its own view state (selection, playhead, tools, layer focus, sent with
  every call). Nothing writes the read view in place; tests run the owner in verify mode, which
  catches it.
- The frame on show, its geometry, the timeline, onion skins, trails, the camera shot and the
  values the inspector shows are session queries (`src/engine/engine-shown.mjs`,
  [engine/evaluation.md](engine/evaluation.md)). A read never fails for a document that opened.
- Stage, playback, thumbnails, previews and exports are the engine's. Pivot, STK, STKZ and STYKMOV
  files are made from the session's document (`styk_edit::export`) in the document export worker;
  a `.styk` save keeps its container path, and an unchanged document saves byte-identical.
- The recorded tapes and fixtures are frozen: nothing re-records them, and a behaviour change
  updates the test that states it ([engine/README.md](engine/README.md), "Fixtures").

**Gate (2026-10-25, clean worktree, final commits).** `npm run check` clean; `npm test` 2438 pass,
0 fail, 21 skipped (owner tapes 511 / 32708 steps, 0 failing); Rust workspace 1052 pass, 0 fail;
the app on the three large private documents: open, play, pose, IK, movieclip create, enter and
leave, effect, undo and redo all pass (screenshots checked; the large `.styk`'s movieclip entry of
about 93 MB exceeds the 48 MiB history and retires older entries, as before); drawing smoke pass;
save smoke 11 of 11; video export decodes every format; `npm run pack` and the packaged boot
(13 of 13) pass; no Python file in the package.

**Measured (tdd2 uriel nemesis.piv, 41 MB, two runs each, same machine, background window).**

| | main (`def97214`) | engine-rust (`3bb99e16`, optimised build) |
| --- | --- | --- |
| open to first frame on show | 22.6 s, 20.8 s | 5.1 s, 5.6 s |
| longest gap, 8 s of playback | 63 ms (second run: playback stalled, 7 frames) | 49 ms, 35 ms |
| peak private memory, all app processes | 3.1 GB, 2.4 GB | 4.6 GB, 4.0 GB |

Opening is about four times faster and playback is as smooth or smoother; peak memory is about
1.5 GB higher. Memory is the first item of the performance phase.

**What is still JavaScript, and why.** The interface (view state, selection and seeking, handles,
picking and marquee over the engine's groups, inspector, timeline, dialogs); validation of stored
data that open, save and paste run (`src/pivot/model.mjs`) and the `.styk` container layout before
the Rust writer; reads of stored data (`src/pivot/read-view.mjs`) and the instance style overlay
(`resolveInstanceFigure`, no time math); interface math (gizmo quaternions, easing curves);
import, codec hosting, media, text and the Stick Nodes decoder; the drawing tile store (its raster
work is `styk-drawing`'s); `spatial-mesh-legacy.mjs` with `scripts/convert-spatial-meshes.mjs`, a
developer converter. `Editor.serialize()` is used by tests and smoke scripts only. Python remains
for development only: the codec oracle in `backend/` and building the video encoder. In Rust,
`styk-edit` keeps its native-timeline editing (the app never edits one; the tapes do) and `load`
still builds the `figureNames` and `tracks` indexes that the frozen load fixtures record.

**Known differences** (behaviour chosen on purpose, with the reason in the commit or doc):
- The Graphics mode setting is gone (the engine draws with WebGPU, or WebGL2 where there is none).
- Rare refusals with a localized message instead of an edit: an animation-origin figure that holds
  a 3D pose, mesh, movieclip or drawing; combining groups with Stick Nodes shapes, meshes,
  movieclips, drawings or origins; the keyframe commands of a native timeline.
- Pictures reach the stage up to about 2 s after opening; pictures that do not fit the engine's
  memory are not shown (counted) instead of failing; opens and edits are refused, with a message,
  when memory is short.
- A very large movieclip edit retires older history entries (as before); bake publication and
  creating a movieclip on very large layers are one synchronous step (see the next phase).
- Group width and height across several keys are measured with the engine's bounds (close to,
  not exactly, the typed value when strokes do not scale); a draw-order key written over a bezier
  key is constant (the old editor refused the edit).
- A figure joined to a hidden movieclip comes loose at its geometry root; layer poses that join in
  a ring leave one figure loose; a join to a slot outside the frame comes loose.
- Library `.stkz` files of spatial IK figures can differ from before by about one unit in the last
  place of solved angles (solved once instead of twice); a re-exported `.stk` is re-encoded.
- Browser pages that are not cross-origin isolated cannot make Pivot or figure files (the desktop
  app and the site are isolated).

**Next phase and open items.**
- Performance: peak memory on large documents (above); bake publication and movieclip creation on
  very large layers (0.3 to 2.6 s in a development build); geometry reads of very dense frames;
  scrub painting; leaving a movieclip after an edit sends the clip's document once.
- Translations: 305 English messages have no translation in the 26 packs.
- Pre-existing, not changed: the polygon draft's instruction message hides its Finish and Cancel
  buttons (Enter and Esc work); Combine refuses on a layer sheet when one figure came from Import
  figure; reopening an exported unconverted nested movieclip shows each odd tick with the pose of
  the even tick before it (the JavaScript export did the same).
- Outside this repository: the telemetry collector should accept the backend value `webgl2` and drop
  the deleted module names; CI and release workflows still install Python for the codec tests and
  the video encoder build.
- Tests: some browser tests need local sample files or hard-code a port; tests that read
  `editor.frame` on layer-sheet documents may be stale (read `evaluatedFrame`).

**Working on this branch.** `AGENTS.md` describes the rules now in force. App runs from scripts and
agents set `STYK_BACKGROUND_WINDOW=1`. The disk is short: share one cargo target directory and build
only the crates you change.

## Handoff (2026-10-11, third agent; superseded by the 2026-10-26 handoff above)

**Where it stands:** S0–S4 done; S6 done for the raster engine. S5 phase 3 has begun under
D19 (user, 2026-10-11): one engine session per document owns document and history
(`src/engine/engine-owner.mjs`, `?engineOwner=on`, not yet the default). Every recorded tape
(325) gives the editor's documents, selection, history and frame on show with it; in the app
28 tapes match. Calls the session refuses run in the editor and are written back.

**Counters now:** inventory **175 js / 123 partial / 34 ported / 23 verified / 1 removed**;
**OWNED_CLASSES 5** (shadow mode, still the default); **owner:** all document classes
eligible, 3,020 of 4,409 tape calls native; **deleted JS modules 2**.

**Next:** make the owner the default. Blocker: the editing cost rule fails on the largest
document (URIEL 3 in the app: C 145.9 ms against J 54.4 ms over 86 calls; Jay passes, C/J
1.02). The session re-evaluates the whole frame on show after each change (~1.3 ms natively,
2–4× that in WebAssembly); per-figure memoized records are the planned fix. Then delete the
shadow and its per-command packets, port the refusals, phase 2 queries, renderer deletion.

**Rules in force (user, 2026-10-11):**

- No subagents, workflows, delegated tasks or new threads. One agent, sequential, this checkout.
- Never push, tag, open a PR, publish or release without asking. Local commits are expected.
- D7, D10, D13, D15, D16, D18 stand. The JavaScript of a subsystem is the oracle until it is deleted.
- Editing cost: a class or command passes if `C <= 1.05 × J` or `(C − J) / calls <= 0.1 ms`,
  with exact behaviour. No micro-optimisation beyond that.
- No long benchmarks. The engine-1 matrix is **cancelled**. Before deleting the JavaScript
  renderer, one sanity comparison under 15 minutes: Electron with WebGPU, one run each of
  `TDD2 URIEL NEMESIS 3.styk` and `tdd2 uriel nemesis.piv` (open time, playback longest gap,
  joint drag p95, peak memory) against baseline-0 (section 5).
- Every commit moves a counter (inventory status, OWNED_CLASSES, app-owned commands or
  deleted JS modules). New infrastructure only when it blocks the next item. Short commit
  messages and milestone notes; logs go under `tmp/`.

**Verification per commit:** focused crate tests (the workspace only when shared types
change); affected recorded replays and byte-stable regeneration; `npm run check` and the
touched JS tests; for app behaviour, the affected recorded tapes in the real app:
`node scripts/engine-app-tape.mjs <tape…> --require <methods>` (default mode against
`?engineEdit=off`, every step and full undo compared). Full `npm run engine:parity` runs in
the background on a committed HEAD at most every ~2 h, and before a JS deletion and the
final report; last green `53c11b8f`. Bisect a failing checkpoint from the last green and fix
forward.

**Worktrees (2026-10-11):** the 51 subagent worktrees were removed after saving each one's
uncommitted diff and untracked sources under `tmp/worktree-patches/` (`INDEX.txt` lists head,
patch size and files). The only unmerged commit, `5fbb3696` (WIP: smooth drawing cels in
effect layers as Canvas), stays on branch `worktree-agent-a94722e0321bf1854`. Kept:
`tmp/baseline-worktree` (`96ebce85`) and `../StykAnimate-Mobile` (untouched).

**Environment:** Node 24, `STYK_PYTHON=$PWD/.venv/bin/python`, `unset ELECTRON_RUN_AS_NODE`
before Playwright or Electron, `nice -n 15` for heavy builds, git identity through
`GIT_AUTHOR_*`/`GIT_COMMITTER_*`. Do not copy the private corpus into the repository;
restore `artifacts/` after browser tests.

### Starting commands

```sh
export STYK_PYTHON=$PWD/.venv/bin/python
npm run engine:build
npm run engine:test
npm run engine:parity                    # committed-source full checkpoint
npm run check
node engine/tools/edit-scenarios.mjs
node engine/tools/edit-replay.mjs <scenario.json> <reference.json>
(cd engine && cargo build --release -p styk-cli)
engine/target/release/styk edit-replay engine/tests/edit/<name>.reference.json
node scripts/engine-edit-shadow.mjs --own --warm --exact-math [--file doc.json]
node scripts/engine-edit-shadow.mjs --own --default --figures-gate --exact-math [--file doc.json]
node scripts/engine-app-parity.mjs …
node scripts/engine-app-tape.mjs layer-list-sheet --require renameLayer
node scripts/engine-inventory.mjs --render
```

## 1. What "the engine" is

Everything that is not interface or a platform service: file formats, the document, commands
and history, evaluation, geometry, rigs and IK, movieclips, effects, drawing raster work,
playback preparation, rendering, export frame production. The inventory lists every module:

- [`docs/engine/INVENTORY.md`](engine/INVENTORY.md), generated from `engine/inventory.tsv` by
  `node scripts/engine-inventory.mjs --render`. The check (`node scripts/engine-inventory.mjs`)
  fails when a source file has no row, so a new module cannot skip the classification.
- At the start: **355 engine modules, 4,056 KiB of JavaScript and Python** (JS engine 320
  modules; Python codec and service 20; C++ scanner 1), against 165 interface modules, 47
  platform services and 17 application-service modules that stay.

| Rust owner | Holds | Modules at start | Source at start |
| --- | --- | ---: | ---: |
| `styk-doc` | lossless document store, validation, structure | 2 | 28 KiB |
| `styk-formats` | `.styk`/`.stkz`/`.stykmov` containers, PIV/STK codec, Stick Nodes, save | 57 | 728 KiB |
| `styk-eval` | timeline, tweening, layer sheet, movieclips, rigs/IK, camera, effect sampling, geometry, picking | 83 | 774 KiB |
| `styk-render` | wgpu renderer (WebGPU, WebGL2, native), effects, generators, images, CPU rasterizer | 52 | 708 KiB |
| `styk-engine` | the facade: scheduler, thread pool, frame cache, budgets, thumbnails, playback | 24 | 216 KiB |
| `styk-edit` | commands, history, selection, clipboard, sessions | 86 | 1,212 KiB |
| `styk-drawing` | raster drawing: tiles, brushes, strokes, fill, selection, history | 36 | 270 KiB |
| `styk-export` | export frames, PNG/GIF/APNG/SVG/ZIP, audio mix | 15 | 122 KiB |

## 2. Engine boundary

```
 JS (interface only)                         Rust (engine/, one WebAssembly module + native tools)
 ───────────────────                         ────────────────────────────────────────────────────
 app.mjs, panels, timeline, inspector   ──►  commands (batched)            styk-edit
 Editor facade (src/engine/…)           ◄──  versioned query results       styk-engine (facade)
 overlay canvas (handles, guides)       ◄──  handle positions, picking     styk-eval
 platform services (files, codecs,      ──►  bytes in / bytes out          styk-formats, styk-export
   WebCodecs, Web Audio, IPC)
 <canvas>                               ◄──  presents prepared frames      styk-render (wgpu)
```

- The engine owns the document. JS holds no second copy of animation data on interactive paths.
- Commands go in as small messages; small, versioned query results come out (inspector values,
  timeline rows, handle positions, selection). No per-object calls inside frame loops.
- Background work (evaluation, preparation, decoding, effects, export) runs on a WebAssembly
  thread pool over one shared memory; results carry the document revision and stale ones are
  dropped. The UI thread never evaluates or rasterizes during playback or gestures.
- Draw lists are view independent (world units); pan and zoom rewrite one uniform.

The JS side of the boundary lives in `src/engine/` only. Nothing else imports the wasm module.

## 3. Method: strangler stages

The JavaScript engine stays as the oracle until a subsystem is proven, then it is deleted.
Each stage leaves the app fully working, with its tests, parity results and docs.

| Stage | Subsystem | Replaces | Gate while both exist |
| --- | --- | --- | --- |
| S0 | Plan, inventory, baseline measurements, "before" screenshots, workspace, wasm build | — | — |
| S1 | Formats: container reader/writer, PIV/STK codec, Stick Nodes | `native-container.mjs` and the vendored zstd (both deleted: the workers open and save through `styk-formats::files`), `zlib-sync.mjs` (drawing tiles only now), Python codec + Pyodide + PyInstaller sidecar, C++ scanner | Python codec remains a test oracle only |
| S2 | Document store + evaluation + geometry (all features: IK, channels, meshes, follow camera, text) | `src/pivot/`, evaluation modules | Rust evaluation checked against JS per primitive |
| S3 | Renderer (WebGPU, WebGL2, CPU), effects, generators, images; playback on the thread pool | `renderer*.mjs`, `playback*.mjs`, `prepared-frames.mjs`, `vfx-*` executors, Canvas 2D renderer | per document: a scene using a feature the new renderer lacks keeps the old renderer |
| S4 | Export frames, thumbnails, library previews | `export-frame-*`, `thumbnail-*`, `library-preview-*`, image codecs | per format |
| S5 | Editing: gestures first (pose, move, IK), then commands by group, history, clipboard | `editor*.mjs` and friends | per command group: unported commands run in JS on checked-out frames and write back |
| S6 | Drawing raster engine | `drawing-*` (not the controller/view) | Draw workspace keeps the old path until parity |
| S7 | Remove dead machinery, final docs, final measurements | stand-ins, crop caches, density buckets, settle repaints | — |

Parity bar (never loosened to pass): geometry within float tolerance; pixels equal except at
anti-aliased edges; unchanged `.styk` and PIV saves byte-identical; exports within the
tolerance the current export tests use.

### Parity harness

| Tool | Checks |
| --- | --- |
| `engine/tools/reference.mjs` + `styk compare` | geometry, primitive by primitive, against the JS editor |
| `engine/tools/reference-render.mjs` + `styk diff` | pixels against the app's renderer |
| `engine/tools/container-parity.mjs` | the document the app's open path produces against the Rust store's reader (`styk container json`), and the bytes the app's save path writes against the file (`styk container roundtrip` does the same in the store); the JavaScript reader it was checked against is deleted |
| `engine/tools/container-fixtures.mjs` → `engine/tests/containers` | the repository's native files (projects of versions 1 and 2 with every section kind, a figure, movieclips), written from fixture documents through the app's save path; regeneration is byte-stable and the parity container stage compares them. No engine test reads the local asset packs |
| `engine/tools/ik-fixtures.mjs`, `engine/tools/eval-fixtures.mjs` → `cargo test -p styk-eval` | small projects the editor builds with its own commands, and what it evaluates (IK, movieclip replacements); regeneration is byte-stable |
| `scripts/engine-app-parity.mjs` | the running app with and without the engine (`?engine=off`): stage pixels per tick, with onion skins and after playback |
| `styk edit-replay --worker <reference.json>` | recorded worker-only native/sheet commands through the same strict every-step comparator |
| `scripts/engine-edit-shadow.mjs --selection-adoption --focused --own --warm --exact-math` | actual new-ID selection after duplicate/paste, history and full undo |
| `styk parity formats` (S1) | decoded documents and written bytes against the JS and Python codecs |
| `scripts/ui-snapshots.mjs --touch --compare … --chrome-only` | the interface, pixel by pixel |

The tools and scripts run on Windows as well as Linux, from a folder whose path has a drive letter and
a space: a file URL becomes a path with `fileURLToPath` (never `.pathname`; `tests/windows-paths.test.mjs`
guards it), an absolute path given to `import()` goes through `pathToFileURL`, the Rust CLI is
`styk.exe`, and the Python codec oracle runs through `engine/tools/decode-piv.mjs` (the interpreter
`scripts/run-python.mjs` picks) instead of a shell script. The tools that run the editor import
`engine/tools/v8-pin.mjs` first, so `Math.pow` is V8's own on every platform (Node 24's default is the
platform's; D16).

Corpus: every file in `~/Downloads`, `~/Downloads/pivs`, `~/Downloads/WafflesPack` (127 files,
with its `.stk` folders), the repository fixtures and asset packs. `Jay on a new app.styk`
(unrepaired) is rejected by the current editor ("Pose array does not match its figure"); the
engine must reject it the same way.

## 4. Decisions

Each gets an ADR under `docs/engine/decisions/` when it lands.

| # | Decision | Why | Status |
| --- | --- | --- | --- |
| D1 | The engine workspace is `engine/` at the repository root, started from `experiments/styk-native` (kept as the measured reference). | One owner per concern; the prototype's numbers stay reproducible. | done |
| D2 | The document store is a lossless, copy-on-write tree (ordered keys, exact numbers, packed numeric arrays) with typed evaluation views derived per record. | Saves must be byte-identical and unknown fields must survive; the prototype's typed model is read-only and lossy. An edit clones only the records it touches. | done (store, typed views per changed record) |
| D3 | One WebAssembly module with threads (SharedArrayBuffer, COOP/COEP on the web build, Cloudflare and the Electron host). | One shared document for every worker instead of one copy per worker (today each playback worker holds its own). Synchronous queries from the UI thread. | done (headers on every host; playback of supported documents runs on it) |
| D4 | Strangler gate for the renderer (`src/engine/engine-eligibility.mjs` named the first feature of a document the engine lacked; deleted once the engine drew every document), per command group for editing. | The app must work at every commit. | renderer gate deleted; editing gated per command group |
| D5 | zstd from the C library (`zstd-sys` 1.5.7) compiled to WebAssembly and natively. | Measured: at level 3 it reproduces the bytes of the vendored zstd build on all 448 version 2 files of the corpus. | done |
| D6 | One threaded WebAssembly build, on a pinned nightly (`nightly-2026-09-15`, `-Z build-std` with atomics, 2 GiB shared memory). A page that is not cross-origin isolated runs the same module without workers, in slices on the interface thread. | Stable Rust ships no atomics-enabled standard library for `wasm32-unknown-unknown`. One build keeps one bundle. | done |
| D7 | The interface thread never blocks: shared state is taken with a spinning lock (critical sections are a queue push or a pointer swap), and no rayon in WebAssembly (parallelism there is whole frames on the engine's workers). | `Atomics.wait` throws on a browser's interface thread; rayon parks the calling thread. Found the hard way: the first frame prepared on the interface thread trapped. | done |
| D8 | The renderer uses instance attributes for primitive records and float textures for its lookup tables (gradients, isolation group placements, polyline vertices), one sampler per texture. | WebGL2 has no storage buffers and binds one sampler per texture. One pipeline serves WebGPU, native and WebGL2; output is identical to the storage-buffer pipeline (mean difference 0.000/255 on the compared frames). | done |
| D9 | The engine build output is `src/engine/pkg/` (git-ignored), built by `node scripts/engine-build.mjs`; CI builds it. | A 4 MiB binary per engine change would bloat history; the web and desktop builds already copy `src/`. | done |
| D10 | Never strip the WebAssembly profile (`strip = false`); wasm-bindgen removes the name section itself. | wasm-bindgen's thread transform finds each thread's stack pointer and thread-local base by symbol name; a stripped module picked the wrong globals and corrupted memory on the first allocation. | done |
| D11 | Array textures always have at least two layers. | WebGL2 creates a one-layer array texture as a plain 2D texture; isolation groups and onion composites sampled black. | done |
| D12 | While commands run in JavaScript, the engine holds a mirror of the document (`src/engine/engine-mirror.mjs`): changed records staged per batch, committed atomically by revision. An edit frame crosses as the pose on screen with `null` for every object whose geometry the editor did not rebuild; onion ghosts are poses kept by an id. | No whole-document transfer on interactive paths; a gesture never waits for a commit. | in use until S5 |
| D13 | App-level pixel parity (`scripts/engine-app-parity.mjs`) fails a step when any pixel differs by more than 32 levels together with all eight neighbours, or the mean difference exceeds 0.25 levels. | The two renderers cover edge pixels by different rules: differences one or two pixels thick along outlines are expected, a moved, missing or recoloured shape differs over an area. The threshold is fixed; it is not tuned to pass. | done |
| D14 | The page creates the engine's shared memory with the largest maximum the browser reserves (2 GiB, else 1 GiB, else 512 MiB; override `stykanimate.engine.memory`), and budgets caches to it. | Mobile WebKit may refuse a 2 GiB reservation. Desktop Chromium and WebKit accept 2 GiB and grow it; the fallback path is exercised by refusing the larger maxima. Real iOS devices are unverified. | done |
| D15 | Editing moves to the engine command by command (`docs/engine/editing.md`): a ported facade method runs in `styk-edit` and returns the changed records and event detail, which the JavaScript document and history adopt; unported commands run in JavaScript and reach the engine through the mirror. Every port is checked by the command-replay harness (`engine/tools/edit-replay.mjs`): documents byte for byte, selection, history and events after every step. | The app keeps working at every commit while about 800 editor methods move; the harness turns each port into a mechanical comparison. | in use; revised 2026-10-03: ported commands run in shadow in the app before ownership flips, class by class; the engine edits large figure and 3D documents by default ([ADR](engine/decisions/0015-commands-record-for-record.md)) |
| D16 | Engine arithmetic whose results are stored in documents uses `styk-math`: fdlibm 5.3 `sin`, `cos`, `atan2`, V8's `hypot` and V8's own `pow`, bit for bit as Node computes them. | The harnesses run the editor in Node and compare bytes; Rust's `f64::sin` differed from it for 2.7 % of two million inputs, `f64::atan2` 17 %. Browsers disagree among themselves too (Chromium 153 differs from Node for 3.9 % of sines and 17 % of `atan2`), so the app already stores last-digit differences per browser: the engine gives one answer everywhere. Node 24's `Math.pow` is the platform's (it differs between Windows and Linux for 0.05 % of inputs), so the recording tools pin it to V8's own with `--no-use-std-math-pow` (`engine/tools/v8-pin.mjs`). | in use ([ADR](engine/decisions/0016-v8-exact-math.md)) |
| D17 | The drawing raster engine is its own crate, `styk-drawing`, bound as a separate non-threaded WebAssembly module (`styk-drawing-wasm`) that each drawing worker instantiates for itself; JavaScript reaches it through `src/engine/engine-drawing.mjs`. | The drawing workers cancel a job by terminating the worker; a terminated thread of the shared-memory engine module could die holding its allocator or a lock (D7) and block every other thread. Tiles already cross to the workers in bounded transfers, so a module per worker costs no extra copy. | in use ([ADR](engine/decisions/0017-drawing-raster-engine.md)) |
| D18 | What the editor draws at random (identities, seeds) is drawn through one module (`src/editor-draws.mjs`) and handed to the engine with the call: the replay recorder draws a fixed sequence and records each step's draws; the facade records the editor's draws and sends them with the engine's run; the engine takes them in order and by kind, answering `Unported` when it would draw what it was not handed. | Ports of commands that draw are compared record for record like the others (D15), and recordings stay reproducible. | in use ([ADR](engine/decisions/0018-editor-draws.md)) |
| D19 | One engine session per document owns the document and history; each answer carries a copy-on-write document patch the editor applies to its read view; refused calls run in JavaScript and are written back. | Per-command adoption code (200–400 lines per family) would be discarded by phase 3; a generic patch makes porting a command just its Rust implementation and replays. | in progress ([ADR](engine/decisions/0019-engine-owns-the-document.md)) |

## 5. Baseline (current app, before any engine change)

Measured on the code of `96ebce85`: a worktree (`tmp/baseline-worktree`, detached at `96ebce85`,
with this checkout's `node_modules`, `.venv` and native binaries linked in) driven by
`scripts/engine-bench-matrix.sh baseline-0 tmp/baseline-worktree <first round> <last round>`,
which runs `scripts/engine-benchmark.mjs` once per configuration and file. Results:
`artifacts/engine-rust/bench/baseline-0/`; tables: `node scripts/engine-bench-summary.mjs baseline-0`,
written to [`docs/performance/RUST-ENGINE-BASELINE.md`](performance/RUST-ENGINE-BASELINE.md).

**Protocol.** Each run starts a fresh profile, opens the file once and never saves it; window
1440×900 (Electron applies its page zoom of 1.25), default settings, light theme, English.
Before each run the driver waits until the 1-minute load average is below 3 (12 threads),
for at most 10 minutes, and records the load at start and end and the busiest processes
(runs that never saw an idle machine are listed as busy). Three rounds; each round runs every
configuration of every file once, the file order reversed on even rounds, so slow changes in
machine load spread over all cells. Cells are the median with the range of the three runs.
Other work on the machine during round 1 ran under `nice -n 19`.

**Configurations:** Electron with WebGPU; Electron without WebGPU (Canvas 2D fallback); the web
build in Chromium and in WebKit; Electron at 4× CPU throttle (WebGPU and Canvas 2D); the web
build in Chromium at phone size with touch. **Files:** `TDD2 URIEL NEMESIS 3.styk`,
`Jay on a new app (repaired).styk`, `svr_uriel.piv`, `tdd2 uriel nemesis.piv` (41 MB).
**Workloads:** open and first frame, a full playback pass, scrubbing, zoom fit→11× and pan at
8× as wheel input, a joint drag in the densest frame, brush strokes on a new drawing layer,
onion skin toggles, PNG sequence, GIF and MP4/WebM export of 120 frames, resident memory of
the whole process tree and GPU memory; cold start (5 runs) and web build size separately.

**Status (2026-10-03 00:34):** the three rounds are complete for all seven configurations of
all four files: [`docs/performance/RUST-ENGINE-BASELINE.md`](performance/RUST-ENGINE-BASELINE.md)
has every table. The port's builds and two subagents ran on the machine during rounds 2 and
3 (not under `nice -n 19` throughout, as the protocol intended); each run still waited for
an idle machine, and the four runs that started busy are listed in the report. Headline
medians of three runs with their range (Electron with WebGPU):

| File | Open | Playback gaps over 2 intervals | Longest gap | Joint drag p95 | Peak resident |
| --- | ---: | ---: | ---: | ---: | ---: |
| TDD2 URIEL NEMESIS 3.styk | 2.71 s (2.71–2.76) | 1 | 146 ms (118–250) | 10.3 ms (10.2–11.4) | 2,330 MiB (2,330–2,360) |
| Jay on a new app (repaired).styk | 0.62 s (0.57–0.67) | 0 (0–1) | 90 ms (83–132) | 914 ms (47–931) | 1,981 MiB (1,948–2,046) |
| svr_uriel.piv | 11.3 s (10.9–11.3) | 0 | 83 ms | 7.5 ms (7.1–8.2) | 3,433 MiB (3,275–3,468) |
| tdd2 uriel nemesis.piv | 21.4 s (20.8–21.6) | 1 | 1,174 ms (1,119–1,244) | 11.5 ms (11.3–12.2) | 3,627 MiB (3,551–3,632) |

Cold start (Electron, WebGPU, editor view, 5 runs): ready in a median of 4,246 ms (4,122–4,515).
Web build at the baseline commit: 61.3 MiB raw, 17.4 MiB at Brotli 5, of which the Python
runtime is 13.3 / 5.8 MiB, JavaScript 23.1 / 4.7 MiB and WebAssembly 6.5 / 2.0 MiB.

### Tests at the baseline commit

Run on the branch before any engine change to `src/` (code identical to `96ebce85`); logs in
`artifacts/engine-rust/baseline/`.

| Suite | Result |
| --- | --- |
| `npm run check` | passes |
| `npm test` | 4,374 tests: 4,341 pass, 6 fail, 26 skipped, 1 todo |
| Python (`unittest discover -s backend`) | 161 tests pass, 47 skipped |

Failures that are not the port's (same on `main`):

- `tests/hand-face-pack.test.mjs`: 5 tests (lines 41, 80, 127, 185, 222).
- `tests/impact-fx-pack.test.mjs`: 1 test (line 160).
- `tests/autopose-sole-gesture.test.mjs:82` is the documented Linux-only stall, marked todo.
- Browser suites: the timeline tests named in `docs/LINUX.md` and `tests/app.browser.mjs`
  (needs WebGPU) fail the same way before the port; to be re-recorded when the browser
  suites are run for the final comparison.

### Interface before the port

`artifacts/engine-rust/ui/before/`: 292 images, every one settled (three identical captures):
desktop at 1440×900 and 1024×700 and the four touch layouts, light and dark, 40 states.
Command: `node scripts/ui-snapshots.mjs --label before --out artifacts/engine-rust/ui --sizes 1440x900,1024x700 --touch`.
Two states the current interface no longer has are skipped on both sides (`polygon-rows`), and
`recent-files` logs a page error in a browser (it needs the desktop bridge) but is captured.

## 6. Open problems

- **Planning jobs on the engine's workers** (2026-10-24): the editor's layer-move and
  in-between planners run on the engine's worker threads (`src/engine/engine-planning.mjs`,
  `Engine::plan_layers`, `Engine::plan_inbetweens`); the JavaScript playback worker no longer
  plans. Open: (1) a layer-sheet document never reaches the layer planner, because the editor
  plans its moves itself on the interface thread (`prepareSheet`, sliced), so the engine's
  sheet kernel (`sheet_layer_plan`) is not used by the app; (2) an in-between on a layer sheet,
  or of authored poses with camera-motion or effect clips, answers `EngineUnported` and is
  planned on the interface thread in slices (as is any host without worker threads); (3) the
  browser and Akane runs of `docs/INSERT-INBETWEEN.md` were made with the old worker planner
  and are not repeated; (4) no recorded tape reaches a background planner (the tapes with layer
  commands move layers and folders, not figures), so the recordings under `engine/tests/layer-migration`,
  `layer-sheet-migration` and `inbetween` are the evidence.
- **Owner gesture mirror reuses `_drag` when a begin replaces an open gesture** (2026-10-24,
  low): `gesture()` keeps the mirrored engine `_drag` object when a `begin*` call commits the
  open gesture and starts another in the same call, so the figure-handle pivot marker and a
  later takeover read the old gesture's uid, origin and `before`. Documents and history stay
  exact; the app's pointer handlers cancel an open drag before beginning one. Fix with the
  owner default: a begin that returns a drag while an engine drag is mirrored makes a new one.
- **Stand-in coverage after the asset packs left** (2026-10-24): five of 30 deliberate
  breakages went unnoticed by the repository documents that replaced the asset packs in the
  engine tests (effect alpha and softness in the CPU/GPU comparison, an entry margin and a
  tile shift in export tiles, a zoom level in smooth sprites); no solid-text lone-glyph,
  captions-in-effects or beam case in `gpu_parity`.
- **Opening large Pivot files (2026-10-24, `perf-open`):** the codec's and the engine commit's hotspots were one cause: dlmalloc grows the WebAssembly memory a page at a time and each `memory.grow` costs 1.1-1.7 ms in Node on Windows whatever its size (`dlmalloc::sys::System::alloc` in the named profiles; ~24 K grows for a 1.5 GB working set). `styk-alloc` (the global allocator of `styk-wasm` and `styk-codec-wasm`) grows ahead in 16-128 MiB steps, halving at the memory's maximum (D14); output bytes are unchanged (the import body of all nine private documents hashes the same as the native codec's). Node probe, medians of three interleaved runs at 3-65 % machine load, before -> after: `tdd2 uriel nemesis.piv` codec import 5.2 -> 2.7 s (CPU 10.3 -> 2.9 s), engine commit 1.7 -> 0.6 s; `svr_uriel.piv` 4.9 -> 2.3 s and 2.2 -> 0.5 s. Native `styk-piv` imports the same documents in 0.9-1.1 s. Still open on the way to the 4 s / 2.5 s targets: the mirror's JavaScript lifting (~2.4 s CPU for tdd2, of which ~1.3 s are the base64 scans in `document-lift.mjs`; its fingerprint is pinned by a collision test) and the engine's image decoding that follows the commit (2.8 s, on workers in the app), the codec's remaining 2.7 s (1.5 s of it software SHA-256 in WebAssembly: the source's id and `document_digest` of the canonical document), and the document's three crossings (see the open-path finding in the handoff above), which the engine loading documents itself removes.

- **Owned editing classes:** large figures, 3D, figures, movieclips and channels are open. The current user cost rule, matching committed checkpoints and actual default core/full-undo proof pass. Exact behavior and D13 are unchanged; no causal speed claim.
- **Channels scope:** the original full paired cost passes at 369.790/352.875 ms, 4.793% and 0.048887 ms excess per full call. Matching c4c580de checkpoint and actual cold default adoption pass; final gate checks cover the two JavaScript files separately. Native/source/origin exclusions and APIs remain unchanged.

- **Superseded figures query hypothesis:** B12 narrows ordinary selected segments in joined frames without pins while preserving complete parents and joined topology. It covers parent slots as well as unrelated joins. Its completed loaded full cost fails startup/joined; those measurements establish no causal savings.

- **Movieclips scope:** recorded gestures/publications are now owned by default. Playback controls remain compared; conversion/Bake app routing remains outside the existing facade. Keep native channels, origins and captured-source documents in their excluded classes; do not enable dense worker-only commands through the class Set. The owner (D19) is not a class: its interface-thread Session runs the native-timeline movieclip commands as the editor did (`editing.md`); awaited Bake and the timed sheet commands stay worker-only.

- **Layer folders:** all five mutators now adopt ordered updates through the original `_layerEdit` tail, with exact actual default query/history/selection/full-undo proof. The getter remains a UI record projection. Their eight metadata siblings adopt too (2026-10-11).

- **Clipboard counters:** repeated-paste counters now match the original workflow in all 34 paired boundaries/full undo and actual simple UI keyboard pastes through counter six. Both broader movieclip UI attempts crash; that remains a final UI/deletion gap, not an overall UI pass.

- **Existing joined one-shot event-time gap:** `moveSelection` can expose stale geometry to live-event listeners before installing its retained result. This remains a final parity/deletion gap; it is not a layer-folder adoption prerequisite.

- **Canonical worker adoption and query readiness:** effect presets/scopes/paints now
  have exact native and app-shadow evidence; `Session::call_values` and borrowed
  closest-joint order are portable prerequisites. Portable quiet/live Core publication
  is integrated; current-ready charge rescoping, exact Editor/Mirror glyph identities,
  encoded worker display and durable actual Stage release remain open. Actual-shown/resource ordering and per-class adoption cost still need the shared
  worker boundary. Broad owned sheet shadow attempts have no final comparison while
  the narrow duplicate/paste check passes. A bounded 180 s retry on `77d2e83b` completed
  its first warm-up round and began the next before timing out; it demonstrates progress,
  not a confirmed hang. This broader worker flow is parked; resume only for a confirmed
  next-class blocker, engine-1 or deletion. It is not an additional movieclips gate
  requirement. These additions do not open ownership or document-class gates.

- **D7 source audit, still open:** the interface calls JSON/edit-scene parsing, geometry
  and draw-list encoding through `Stage::edit_frame`; definitions-only mirror sync calls
  `commit_now` and rebuilds typed views/assets. Frame-cache invalidation, insertion and
  eviction now use the same cache Storage owner outside shared `State`; interface
  readiness tries both locks once and returns cold on contention. Dense last-owner
  Frame/Generation/DrawList/style/glyph drops and aggregate physical charging are not
  closed by this critical-section change. No-thread `Engine::step` time slicing occurs
  between whole jobs, and monitor camera preparation can run inline. Atlas uploads can
  exceed the nominal 8 MiB slice with one large image; their UI duration is unmeasured.
  Prepared generation/epoch/sample substitution is now closed with native tickets and
  actual-shown monitor guards; live edit-scene readiness remains separate. Worker stop
  has no cleanup acknowledgement. Use the existing worker/session,
  frame/cache and retained-task owners when a confirmed next-class blocker, engine-1
  or deletion requires these paths; do not infer another movieclips prerequisite. The
  quiet worker actor alone does not certify them. Static findings are separate from
  Chromium GPU load or delayed animation frames, which do not establish UI lock duration.

- **Prepared playback and hardware-headless capture:** the reviewed renderer batch now
  keeps exact fractional samples in the existing worker frame cache; shipping default
  software web passes stored/preview ticks 3 and 3.5 (4/4, zero solids), fixing the recorded
  integer-preview defect. Broader actual-shown/resource readiness and no-thread fallback
  still prevent renderer deletion. Hardware-opt-in headless web previously returned an
  empty engine canvas for all nine rig views; no new hardware claim or threshold change.

- **Every document is drawn by the engine** (the renderer gate, D4, and its census are gone,
  2026-10-24). Its last two reasons, frame drafts (temporary editing state, only ever shown as
  onion skins) and movieclips nested deeper than 16 levels, left once the engine drew both,
  compared with the editor in the app (Electron WebGPU and the web build: 14 runs, 120 steps, every one
  drawn by the engine, no solid pixel, mean at most 0.049 levels; [rendering.md](engine/rendering.md#every-document)).
  Property channels are drawn by the engine and edited by it on layer sheets (class `channels`, not
  owned by default; `_styk.animation` on a native timeline stays with the editor). Electron's WebGPU
  canvas shows nothing under Xvfb on the Linux machine, so Electron app parity of earlier features ran the
  engine on WebGL2 there. What still sends a frame to the JavaScript renderer is not the
  document: a failed engine, a drawing stroke not yet published, a drawing preview, a rotated or
  mirrored view.
- **Exports through the engine** (`styk-export`, `src/engine/engine-export.mjs`): an export
  holds a second GPU device and a second copy of the document's pictures for its duration
  (+52–361 MiB GPU memory measured); its first frame waits for every picture (URIEL 3:
  0.8–0.9 s); read-backs are slow while the page repaints (measured under Xvfb only), which
  the worker hides by drawing up to six frames ahead. Composited No smoothing now
  preserves the editor's smooth fallback; ordinary plain drawing No smoothing still
  fails CPU/JS D13 at mean 0.5124 (byte-identical before/after this correction).
  Scene-effect camera images
  wider than 3,968 px are upscaled. Not verified: Windows, macOS, real displays, other GPUs,
  Firefox, Safari, packaged builds.
- **Drawing raster engine** (`styk-drawing`, D17): custom pressure curves use `styk_math::pow`,
  V8's own `pow` on every platform (D16); jobs peak higher in module memory (released above
  256 MiB per instance); tile preparation and the per-sample brush model are slower; the GPU
  brush stays JavaScript. Each completed
  publication of a large cel costs the interface thread 0.2–0.7 s while the engine stage syncs
  the new asset (both engines; 2,040-tile cel), now kept out of undo and redo but still paid
  after strokes and fills. Not verified: Windows, macOS, packaged builds, real pens.
- **Property edits, open after the port**: paints (fill styles and effect colours), adding
  effects and presets (random identities), channels on a native timeline and unrecorded
  animation-origin command families stay with the editor. Owned editing of `channels-figure` took 289.3 ms against the editor's
  116.9 ms (one run, loaded machine): records rebuild channel bindings and convert frames for
  geometry on every evaluation, and scrub previews carry whole frames, so the `channels` class
  is not owned until large documents are measured. Bézier easing uses `styk_math::pow`
  (V8's own), which differs in the last bit from the platform's `pow` that V8 13.6 (Node 24's
  default) computes for about 8 % of the easing's `t ** 3` inputs.
- **Previews on WebGL2 and without WebGPU canvases:** thumbnails and library previews are
  drawn by the CPU rasterizer in the engine's preview worker where the stage cannot draw them
  (WebGL2 stages, where one device cannot draw to a second canvas, and WebGPU canvases that
  give no pixels: Electron under Xvfb without ANGLE on Vulkan; a magenta probe decides). The
  camera monitor on a WebGL2 stage still falls back to JavaScript.
- **The CPU rasterizer on nearly coplanar 3D faces:** 13 of 1,244 deep-3D export frames fail
  by solid pixels where faces nearly overlap (the GPU's vertex precision is not reproduced);
  none fail by the mean. Exports fall back to the JavaScript worker only where the engine's
  export worker cannot start.
- **The CPU rasterizer is slower on effects and drawing cels** than the tiny-skia renderer it
  replaced, which skipped effects and multisampling: the effects fixture's thumbnail takes
  90–152 ms (2.3–4.3 ms before), a drawing cel's export frame 14.1–24.9 ms (2.0–4.2 ms);
  it runs in workers only.
- **Thumbnails differ from the JavaScript worker by category:** text and 3D artwork are drawn
  from object rasters at the editor's density, so they look blockier than Canvas 2D at
  96–320 px; Canvas 2D seams and the edge coverage of one-pixel strokes at 96×54 also differ.
  Thumbnails equal the stage and export frames. In-between previews and the camera-motion
  preview still draw in the JavaScript thumbnail worker (a sampled pose that is not in the
  document).
- **Range commands, open after the port**: pasting across frames, movieclips among the changed figures,
  duplicating figures with effect clips, adding, duplicating or deleting across native
  keyframes, ordering one figure's segments, and the builder's segment styles stay in the
  editor. Documents whose poses carry `runtime_segments` keep the range calls in the editor.
  In one run on the start document, owned calls cost what the editor's do (245.9 against
  241.9 ms).
- **Known divergences of the newly drawn features**: the engine tweens a captured movieclip's
  own keyframes where the editor samples its retained source (`movieclipSource`); the follow
  camera reshapes its whole path on every revision where the editor resamples incrementally
  (edit frames use the committed path); records (`styk_eval::records`) now match animation origins, but editing remains limited to
  recorded whole-figure, topology, joint/handle, saved transform-channel, range/join,
  constrained 2D-rig, angle-lock definitions and spatial pose-choice families until remaining command replays land; onion-skin ghosts get no
  parallax (the editor never shows onion skins with the camera on).
- **Captions**: text is drawn as the WebGPU renderer draws it ([rendering.md](engine/rendering.md#text)).
  One step still fails: 15 Guns tick 0 (mean 0.294, its cover page), because Chromium's
  accelerated Canvas 2D fills text with 9 coverage levels and the engine with 4 samples; no
  measured rule reproduces it, and WebGPU offers no 8-sample mode. On devices without
  WebGPU text now looks as on WebGPU devices (the editor's Canvas 2D fallback differs from
  its own WebGPU renderer by 0.49–1.17 levels there), a deliberate difference. Large Pivot
  text flattens finer, so text-heavy documents encode more records (Uriel: 26 % more, edit
  frames 104–108 ms against 86–96 ms in the quietest round), and the first draw of large
  text tessellates on the interface thread (12 ms once at Uriel tick 370): the finer levels
  could be made on the workers.
- **3D editing is ported except joined 3D IK targets**: posing a 3D IK target on joined
  figures and `setSpatialFeetPinned` still run in the editor alone.
- **No-WebGPU devices lose the Canvas 2D fallback's seams.** The JavaScript Canvas 2D
  fallback antialiases each triangle of a polygon fill on its own, so light seams show between
  adjacent faces (asset-pack backgrounds such as `04-waterfall.styk` fail the web-target parity
  bar on this alone: 4 solid pixels, mean 0.265). The default WebGPU renderer uses multisampling
  and has no seams; the engine draws like it on every backend (in Electron the engine's picture
  of `04-waterfall.styk` is identical, pixel for pixel, to the WebGPU renderer's). Recorded as a
  deliberate difference: where a device lacks WebGPU the picture now matches what WebGPU
  devices show.
- **Most JavaScript engine modules cannot be deleted yet**: commands, history and the
  editor's own evaluation (handles, picking, the pose it sends to the engine) still run in
  JavaScript and call the evaluation modules the engine covers; they go when the engine owns
  a document class (S5, D15). Deleted so far: the Python codec runtime, sidecar and their
  loaders (codec merge). Ported editor calls run in shadow (`?engineShadow=on`): on the
  document the app starts with, its pinned variant, a foot with followers and a joined
  assembly every call the shadow script makes now runs in the engine with no difference.
  Native-ready but awaiting app runtime/facade adoption: follow-camera read/bake, joined 3D IK,
  branch thickness, sprite segments, native property gestures, drawing new figures and
  recorded native/sheet movieclip creation, insertion, extension and awaited Bake.
  Joined pinned motion paths and measured-bounds shadow transport now match in the app;
  the app's own bounds callback is measured by the engine itself (`styk-edit/src/bounds.rs`), so
  alignment and camera centering run in the session without a JavaScript callback.
  Follow UI sessions refuse cold ticks/revisions instead of evaluating them on the interface
  thread; native bake replays do not certify UI admission. Still unported in `styk-edit`:
  unrecorded complex origin definitions and motion-path/pose-choice/spatial combinations
  beyond the recorded angle-lock and single-selected-spatial-instance prerequisites
  (range/join and recorded 2D-rig calls now match alongside whole/joint/handle/saved-channel/topology families),
  concurrent stale Bake, unrecorded movieclip/IK/draft combinations, remaining effect
  attachments and origin/projection combinations. Recorded effect presets/scopes and
  measured centring/alignment already match. Asynchronous layer commands still require
  the canonical actor (D7); native in-betweens and session repair after eviction remain
  open. Topology edits run in
  the engine and are compared, but their answers are not adopted: an owned session ends and
  the editor runs them.
- **Engine-owned editing still costs more than the editor on joint poses** (`?engineEdit=on`,
  opt-in): on AyameDemo.piv's 515-segment figure a pose call takes 1.2 ms in WebAssembly
  (0.39 ms natively) plus 0.45 ms adoption against the editor's 0.7 ms; all owned calls
  together cost what the editor's do (899 against 898 ms), frame-drafting commands three
  to six times less. Left: each call converts and draws the posed figure whole where the
  editor rebuilds what changed, and the answer carries the whole figure (14 KB). That
  decides when ownership becomes the default for a document class (D15).
- **The document is held twice until S5** (D12): the editor's JavaScript objects and the
  engine's store and typed views. Measured 2026-10-02 in Electron (WebGPU), one run each after
  opening the file and letting the mirror commit, machine load 4–5 from the baseline rounds
  (`node scripts/engine-memory.mjs <file>`):

  | File | Engine | WebAssembly memory | JS heap | Renderer process | All processes |
  | --- | --- | ---: | ---: | ---: | ---: |
  | Jay on a new app (repaired).styk | on | 153 MiB | 86 MiB | 523 MiB | 1,161 MiB |
  | Jay on a new app (repaired).styk | off | — | 92 MiB | 568 MiB | 1,182 MiB |
  | svr_uriel.piv | on | 268 MiB | 248 MiB | 762 MiB | 1,390 MiB |
  | svr_uriel.piv | off | — | 262 MiB | 1,255 MiB | 1,866 MiB |

  The engine's own memory (store, typed views, assets, decoded images awaiting upload, frame
  cache) is the cost of the mirror; the totals are already lower with the engine because the
  JavaScript renderer's raster caches and the playback workers' document copies are not used
  for documents the engine draws. The JS heap's copy goes when the engine owns the document
  (S5); the final report tracks the trajectory with the same measurement.
- **First use is slow in WebAssembly.** The first file opened after the module loads takes
  about 2.2 s where the same file then takes 0.66 s (URIEL 3). Suspects: baseline-compiler
  code before the optimizing tier is ready, and growing the shared memory. To measure.
- **wasm-opt is not installed** on the development machine: the engine module is 5,720 KiB
  and the codec module 1,496 KiB without it. Bundle budget to be set once it is.
- **The WebGL2 path is only verified on SwiftShader** (headless Chromium). Playwright's
  Chromium does not display a WebGPU canvas here; Electron does.
- **Real iOS and iPadOS devices are unverified** for the engine's shared memory: the page now falls back from 2 GiB to 1 GiB and 512 MiB maxima (D14), but the actual limits of Apple devices were not measured.
- **Effects and cels, remaining backend gaps**: two-texel neighbour borders, Canvas
  minification/Mitchell enlargement, exact level selection, intact atlas references and
  tight alpha bounds now fix private Electron ticks 46 and 61–64 and all four synthetic
  views. Destination-grid sampling now makes original headless software Canvas stage
  views pass 4/4 (means 0.0682–0.1261, zero solid pixels); default GPU output remains
  byte-identical. Auxiliary 320×192 onion views still fail at mean 0.288346 and the
  278×139 edit monitor at 0.714171. A real editor-built empty background independently
  reproduces the monitor's 278 fractional-border pixels (mean 0.352518): Canvas clips
  before painting the background, while the engine paints one unclipped edge. CPU World
  and Destination outputs agree exactly with captured WebGL on that empty scene. Fixing
  this confirmed owner mismatch will not by itself close the remaining cel differences.
  Private web verification is unresolved: two
  bounded retries timed out at tick 46 in the six-animation-frame settle, with all tracked
  resources ready; the cause is not established. Native crisp export of the synthetic
  fixture fails identically on the pre-change CLI (mean 0.2999, max 222, no solid pixels),
  while smooth export and thumbnails pass. Keep these gaps visible before renderer
  deletion. `previewRasterScale` is not followed; effect layers may reach 3,968 px (60 MiB)
  with two to eight pages per atlas.
  Generated effects drawn by the editor's Canvas 2D fallback (tinted sprites, an 8- or
  32-step colour ramp, a 4,000-particle preview budget) differ from its WebGPU renderer, so
  web parity (the engine on WebGL2 against the fallback) cannot pass on them; the engine
  draws them as on WebGPU devices. `Math.pow` and `**` are `styk_math::pow` everywhere in
  the engine: V8's own fdlibm-based `pow`, which Node 24 runs only with
  `--no-use-std-math-pow` (its default is the platform's, which differs between Windows and
  Linux), so the recording tools pin Node to it (`engine/tools/v8-pin.mjs`, D16). URIEL 3's
  explosion targets an object the document does not contain, so neither renderer draws it: an effect with a missing target draws nothing, silently.
- **Some evaluation trigonometry is still the platform's** (D16): tweens, the IK solver,
  rig constraints, 3D quaternions and camera motion use `styk-math` (now with `asin`, `acos`
  and `log1p`), but geometry uses `f64::sin` and `cos`; its points are rounded to single
  precision and match.
- **The codec, open after the merge**: a segment edit to a figure from the synthetic
  `figure-modern.stk` fixture does not survive `.stk` export (the export writes the
  unedited 84 bytes; the Python oracle writes the same bytes, so the defect predates the
  port; corpus `.stk` files round-trip edits); a fresh WebAssembly instance pays about 1 s
  on its first import (1.39 s cold against 0.41 s warm in Node); the personal Windows
  launcher outside the repository (`../Start-StykAnimate-webapp.ps1`) still requires the
  sidecar files, so it would refuse a release built now (`scripts/release-launcher.test.mjs`
  records its contract); Windows, macOS, a packaged build and CI were not run; Python is
  still needed to build the video encoder and VfW helpers for packaging.
- **Shadow editing in a browser compares numbers within 1e-9**: Chromium, WebKit and
  Firefox round `Math.sin`, `cos`, `atan2` and `hypot` differently from Node and from each
  other (D16), so a pose computed in the browser editor differs from the engine's in its
  last digits; byte-for-byte equality is checked in Node.
- **Running out of engine memory is not recovered**: an allocation beyond the reserved maximum traps the module, and the stage does not yet drop the engine for the session safely (a trap inside a held spin lock would block the interface).
- **A lone UTF-16 surrogate in a JSON string** is replaced with U+FFFD by the store
  (JavaScript keeps it). No corpus file has one.
- **Clippy is not clean in `styk-eval`** (18 warnings, mostly complex types and
  `chunks_exact`) and `styk-formats` (one). New crates (`styk-edit`, `styk-math`) are clean.
- **Small features look crisper than in the WebGPU renderer** on `hitoshi vs suzu tomiee ssj.piv`
  (section 7). Suspected cause: the JavaScript renderer draws figures from cached rasters at
  bucketed densities and resamples them. To confirm with the raster cache disabled, then
  record as a deliberate difference or fix.
- **A joint drag on Jay on a new app (repaired) stalls presentation for about 0.7 s** once
  per drag (benchmark `drag` workload: latency p95 914 ms at the baseline, 651 ms with the
  engine drawing; median 419 → 50 ms). No long task runs meanwhile: the app holds the frame
  while asynchronous editor work completes. Not the old renderer's scene preparation (skipped
  since `1d9e30ad`, unchanged latency). To trace in S5, where the engine evaluates for the
  editor.
- **Edit frames rebuild the whole scene's geometry** when any object changes, and every commit
  resets the whole frame cache (tick-range invalidation, `playback-retention.mjs`, is not
  ported). Fine at the sizes measured so far; the dense-drag benchmark will decide.

Resolved since the last update: the omitted derived origin pose/channel record fixtures
are included and checked by the existing exact-record suite; Electron drawing cels under outline/blur/bloom/glow,
including decoded ink-bound correction and stale stage/export preparation; onion skins keep custom paints and draw solid paints in the
skin's tint (`774d1b21`, `066587e3`); `piv.rs` is gone (styk-piv reads Pivot files);
effects are drawn as GPU passes, generated effects included; the baseline benchmark is
complete; the Python codec no longer ships. Earlier: WebKit runs here (missing libraries
unpacked into `~/.cache/styk-webkit-libs`, nothing installed system-wide); pinned IK and
layer-sheet movieclip replacements.

## 7. Parity results

Figure clipboard publication passes 238 Rust tests, three recorded replays /
106 exact calls, 263 JS tests and final Main check in 47.783 s. The scoped warmed
default proof completes in 22.837 s with 13 owned / 17 compared / 33 attempted calls,
including three expected validation errors. All twelve successful clipboard calls
are Native-owned; nine pastes and two nonempty duplicates have positive
Native/engine/adoption clocks. The empty duplicate permits zero adoption time.
All 34 paired document/frame/history/selection/counter boundaries
and full undo match literally. Actual simple UI keyboard pastes reach counter six
with no shadow mismatch. Both broader automated UI attempts crash; neither is a
pass claim. All 6,414 guarded inputs remain unchanged, with no
unexpected errors, mismatches or rounding. Aggregate paste time is 24.860/20.630 ms,
diagnostic only; full-class rows remain 43. Required-profile shipping is 10,293,395
bytes in 55.648 s, with codecs unchanged. The completed `53c11b8f` checkpoint passes
861 native tests, two existing ignored, 64 stages, 60 unchanged generators and
358 containers; it does not certify later folder or clipboard source.

Layer folders pass 236 normal editing-crate tests, zero failed or ignored across
53 result groups; three fresh recorded replays / 58 exact calls; 204 JS tests,
zero failed/skipped; and final Main check. Actual default classes mode adopts all
five mutators with no editor fallback: 5 owned / 15 compared / 20 calls, zero
failed attempts, rounding, mismatches or page errors. All 21 paired boundaries and
both outcomes match literally through undo→redo→undo, including actual Advanced
timeline Ungroup. All 6,412 source/package inputs remain unchanged. The observed
18.360/9.620 ms subtotal is a diagnostic under concurrent checkpoint load, not a
class-cost gate or causal speed claim. Shipping uses the required Wasm profile:
10,291,828 bytes in 118.211 s, with codecs unchanged.

Ordinary sheet Unique passes 233 Rust tests, five recordings / 79 exact calls,
266 JS tests and Main check. The scoped warmed default UI run adopts both Unique
calls at ticks 2 and 2.25, with exact twelve document/history/selection/phase
boundaries and final/full undo. It reports 6 owned / 10 compared / 16 calls,
including four quiet commit preludes, with zero failed attempts, rounding or errors.
The two-call subtotal is 22.030 ms versus 19.740 ms editor-alone, diagnostic only;
full-class rows remain 43 and no causal speed result follows.

Ordinary sheet Split passes 94 focused Rust tests, 12 recordings / 272 exact calls,
225 JS tests, Main check and 1,340 byte-stable fixture JSON. The full warmed default
app run reports 164 owned / 288 compared calls with zero failures, rounding or issues;
its document JSON length of 710,546, 80-entry history, selection and full undo are exact.
The single Split call takes 15.335 ms versus 17.085 ms editor-alone; this adds one
affected-command measurement, not a full-class row or causal speed claim. Build UI
Split/Undo, branch/repeated sessions and drawing/discard pass in 8.754 s without page
errors. Desktop/compact screenshots use the existing compatibility renderer;
this is not engine-1 or GPU certification.


Channels default ownership passes the committed c4c580de checkpoint (856 native,
two existing ignored; 64 stages / 60 unchanged generators / 358 containers), 132 final
focused JS tests, four recordings / 94 exact calls and Main check (2,000 JS /
93 stylesheets / 682 modules / 8,066 references). Actual cold default runs in classes
mode: 31 owned / 15 compared / 46 calls, zero failed attempts, positive Native
pose/move/commit clocks and exact document/history/selection/full undo. Per-method
counts include fallback; the short workload proves admission only. Original full cost
passes both user arms. APIs, shipping, exclusions and D13 are unchanged.

The prior channels full paired behavior/accounting matches; cost 226.105/179.890 ms
and excess 0.133569 ms/full call fail both user arms, with 11.615 ms remaining to the
per-call arm. Channels is closed, its class patch unapplied and default admission unrun.
Existing 17 recordings/303 calls and 129 focused JS tests pass. The fresh committed
39d9 engine checkpoint passes 849 native tests, two existing ignored, 64 stages/60
unchanged generators/358 containers in 6m29, warm Cargo 0.16 s without compilation.
This measurement changes no API/math/D13 or classifier scope.

Movieclips is now owned by default after both original full paired workloads pass the
current cost rule, the committed `379c2dbb` engine checkpoint passes (849 native tests,
two existing ignored, 64 stages/358 containers), and final 87 focused JS/Main checks
pass. Actual default sheet/loose results are 18/31 owned, 12/15 compared and 30/46 calls,
with positive Native core clocks and exact document/history/selection/full undo. The
short default timings are admission proof only. Recorded scope remains 14 tapes/254
calls; comparison-only playback, worker-only conversion/Bake and native/source/origin
exclusions are unchanged. D13, APIs and stored math are unchanged.

B14 retains exact focused verification: 405 native tests (224 edit, 181 eval), two existing ignored; five new controls, 28 recorded replays/942 steps, 82 JavaScript tests and check pass. All 3,670 fixture JSON remain unchanged. Completed full startup/rig/joined-chain behavior and accounting match; literal costs 234.310/212.950,143.690/123.635,164.870/141.245 ms remain FAIL/FAIL/FAIL. Under the current user policy, average excess over the smaller paired full call count is 0.047679/0.067983/0.071809 ms, so all three pass the absolute-average arm. The committed `f4173cf0` engine checkpoint passes 849 native tests, two existing ignored, 64 stages and 358 containers. Final gate verification passes 86 JavaScript tests and Main check; all three actual default runs report 31 owned/15 compared/46 calls, positive Native core clocks and exact full undo. Figures is opened; the short default workload is admission proof, not new cost evidence. No pixel threshold, stored arithmetic or API changes.

B13 passes 400 native tests (219 edit + 181 eval), two existing ignored and zero filtered, including all four effect-reuse controls. Fresh CLI `1280d852` / 347,845,328 B matches 27 recorded references / 925 exact steps with all 39 guards and executable identity stable. All 3,670 JSON fixtures remain unchanged; comparison of 4,256 engine paths differs only at the two reviewed endpoints plus the isolated lane's older inventory notes. Main passes 82 JavaScript tests and check. Source `d271437d`, native receipt `6f0e7504` and independent runtime `f457306b` certify this focused scope. Shipping `e5476f401799` / 10,241,930 B retains the required wasm profile and stable sources, with codec/drawing unchanged. Completed B12 full cost has exact parity/accounting on all three inputs but FAIL/PASS/FAIL cost; review `3c556bdd` and append review `bad26295` preserve all historical evidence. B13 full app cost, matching final checkpoint and default ownership remain pending.

B12 focused verification passes 396 native tests, all 16 unchanged command references / 591 exact steps, 82 JavaScript tests and check (2,000 files). Both new joined numeric/ancestor and publication/cycle/invalid/pin controls execute; all earlier shape guards remain unchanged. Comparison of 4,256 tracked engine paths finds only the two candidate paths and stale isolated-lane inventory notes; all 3,670 JSON fixtures stay exact. Shipping `b65ff69acb49` / 10,241,354 B uses the required wasm profile and stable 1,529-source/three-input maps; codec/drawing packages are unchanged. Native source/runtime reviews `f5463546` / `12347ec9` accept this scope.

The accepted B11 literal full joined diagnostic (`83a2ca49`, native `57cfa98f`, JavaScript `34bb6172`) covers all three 12-call pose ranges, with strict 263,000-byte document, 79 history entries, selection and full undo exact. Its candidate 305.950/JS 280.750 ms and pose engine 17.315 (includes native 15.330) + adoption 22.085/JS 25.860 ms are instrumented concurrent-checkpoint observations. Two negative baseline profiler intervals are preserved and excluded outside every recorded root call. These are diagnostic measurements, not class-cost or engine-1 acceptance. Historical 27 full cost rows and four ordinary diagnostics remain unchanged.

B10 focused verification passes 215 editing-crate tests, including ten recorded full/query context and complete-solution controls; 12 fresh CLI recordings match all 241 steps. Main passes 82 JavaScript tests and check (2,000 files). The 2,296 unchanged engine files and 1,825 crate fixture JSON match Main and the tested native lane; no recordings changed or required regeneration. Shipping `61537fd7901f` / 10,241,121 bytes retains the required profile, stable 1,529 sources and three inputs, and unchanged codec/drawing modules. Source review `223bc16f` and native receipt `833110f0` bind this scope. B10 full app parity/count/accounting now passes, with all three costs FAIL as recorded below; matching checkpoint and actual default adoption remain pending.

B9 focused verification passes 214 editing and 178 evaluation tests, with the same two ignored diagnostics; all nine new tests execute. Fresh CLI replays match 36 tapes / 1,668 steps; all 3,670 fixture JSON and source inputs stay exact. Main passes 70 focused JavaScript tests and check (2,000 files). Shipping `b9cf70669501` / 10,240,701 B is source-stable, retains the required profile, and leaves codec/drawing unchanged. Native receipt `866daca6`, independent runtime review `266780a7`, composition review `61048212`, arc correction review `4b17d903` and shipping receipt `006251b1` identify this scope. The regression failed before and passed after. The predecessor `c0048287` full checkpoint is green at 827 tests / two ignored / 64 stages / 358 containers; B9 full app parity/count/accounting now passes, with startup/joined cost FAIL and rig cost PASS as recorded below; matching checkpoint and actual default admission remain pending.

Latest B7 pose-cost source verification retains its original scope:207 editing-crate tests, six numeric/solver controls,32 unchanged recorded replays/1,519 exact steps,3,670 unchanged engine fixture JSON,56 focused JavaScript tests and check; shippinge95371c6c75e/10,234,289B is source-stable. The unchanged full B7 paired workload now passes strict parity/count/accounting but fails all three cost comparisons. This paragraph retains B7 scope; B8 focused verification is below and its completed full cost fails. A cost fix, matching new checkpoint and default figures admission remain pending.

Latest focused candidate (2026-10-05 06:29 CEST): **201 editing-crate tests**, **21 unchanged recordings / 565 exact steps**, **56 focused JS tests** and check pass. The three reviewed IK files preserve full/compact state, history, events, capture bits, cancellation and current-pose guards. Existing recordings are unchanged, so no fixture regeneration is required. Count proofs remove exactly one same-call evaluation on 22 free and 16 joined active target calls; 34 negative controls retain their counts. The test-only synthetic missing-definition case failed in the unchanged geometry path and was removed without a production or threshold change; three real old/six final guard markers pass. Shipping `ffedaa2273a9` / 10,231,142B keeps the unstripped wasm profile and unchanged codec/drawing. This is focused source/build verification; completed B6 full class cost below fails, and matching final checkpoint/default figures admission remain pending. Public crate API and stored arithmetic are unchanged.

Background full checkpoint on committed `b4ccf993` passes **813 native tests**, **two existing ignored diagnostics**, **64 stages** and **358 containers**, with a clean checkpoint worktree. It ran 05:46–06:26 CEST, overlapping B5 rig/joined cost. The new B6 source requires its own matching checkpoint before a gate flip; no checkpoint was awaited for this focused merge.

Earlier focused figures candidate (2026-10-05 03:37 CEST): 191 owning Rust tests, 24 CLI recordings/640 exact calls, 197 focused JavaScript tests and check pass. The actual editor's new clip-parent recording matches before and after the scoped change; two regeneration rounds preserve all 1,334 edit JSON including 1,332 existing files. The final three clean ordinary-pose app diagnostics preserve document/history/selection/full undo, matching counts, complete attempt accounting and zero errors/rounding/mismatches. They do not open figures: the completed B4 cost below fails despite the green matching checkpoint; future cost fixes and default core adoption remain pending. No threshold changes.

Completed B4 full app cost (committed `3e0fe620`): all three full paired cases pass strict document/history/selection/full undo, eligible method counts and complete failed-attempt accounting with zero errors/mismatches/rounding, but all three cost FAIL (283.545/224.715, 166.180/137.570, 169.650/147.620 ms candidate/JS). The matching full checkpoint passes 805 native tests, two existing ignored diagnostics, 64 stages and 358 containers. Earlier three quota-aborted attempts were incomplete; the archived proof paths are exact. No default figures adoption, next patch milestone or engine-1 result is established. Full cost rows 6→9 and ordinary diagnostic rows remain three; B5 source/focused checks/shipping and actual ordinary app are verified below; new committed-source full cost remains next.

B5 source/build/app proof:199 native tests,30 actual CLI tapes/743 calls, two byte-stable regeneration rounds preserving1,334 old/1,338 final edit JSON; OLD double-capture58/58 proof precedes implementation, final compact/full116-step and exact numeric/drag controls pass. Actual composed-main nine-suite JS147/147 and check2,000/CSS93/682/messages8,066 pass with source/package/HEAD guards. The original57/58 depth-projection test failure is corrected through existing `plain(depth4)` only; the cached69 lane npm-context failure remains preserved, while composed-main standard25-location context generation/check is green with catalog/preload/registry bytes unchanged. Shipping ac4ddf356bac/10,227,868B completes with profile/source guards and unchanged codec/drawing. Actual ordinary app94.55s:31owned/15compared/46calls, all three core methods positive and paired counts match, exact document/history/selection/full undo, zero errors/mismatches/rounding and stable approved dirty sources/HEAD3e/final package/input. Total22.92500001192093 vsJS17.075000017881393ms remains above JS; ordinary rows3→4, not full class-cost acceptance or causal speedup. The completed full B5 results below update the current cost pointer; the ordinary diagnostic remains separate. No API/schema/math/threshold change.

Completed B5 full app cost (committed `b4ccf993`, shipping `ac4ddf356bac`): strict document/history/selection/full undo, matching eligible counts, positive core work and complete failed-attempt accounting pass on all three inputs, but cost FAILS at 239.970/220.625, 292.805/132.530 and 332.620/277.010 ms candidate/JS. Startup/rig/joined owned/compared/failed counts are 163/285/1, 119/171/1 and 125/213/0; rig retains four permitted comparison-only residual calls. Full cost rows 9→12; nine old rows and four ordinary diagnostics remain exact. Rig and joined are loaded with checkpoint compilation, so no causal speed claim follows. Summary `54815043`, reader output `7c798da5` and independent review `b1d35c6f` agree. Figures remains closed; the next scoped candidate, its own verification/shipping/fresh cost, matching checkpoint and default admission are pending. No threshold or port-counter change.

Completed B6 full app cost (committed `05f137ac`, shipping `ffedaa2273a9` / 10,231,142B): strict document/history/selection/full undo, matching eligible counts, positive core native/adoption and complete failed-attempt accounting pass on all three inputs; cost FAILS at 242.460/215.525, 141.795/127.235 and 169.585/142.555 ms candidate/JS. Startup/rig/joined owned/compared/failed counts are 163/289/2, 119/171/1 and 125/213/0; only rig has four comparison-only residual calls. Startup’s failed commitDrag and builder-style attempts and rig’s failed pasteSegmentValues attempt remain included. All 1,529 source/seven package/three input maps match before and after. Full rows12→15, all twelve prior rows, three batch metadata objects and four ordinary diagnostics remain exact. Summary `42a0d1ba`, reader output `20413996` and review `c7723030` agree. Nonzero load is recorded; no idle/causal speed claim, new checkpoint/default admission, B7 runtime result or threshold/port-counter change follows. Figures stays closed.

Completed B7 full app cost (committed `b748119b`, shipping `e95371c6c75e` /10,234,289B): strict document/history/selection/full undo, eligible method counts and complete failed-attempt accounting pass with zero errors/mismatches/rounding. Startup/rig/joined totals are234.390/224.850,135.060/133.930 and153.110/147.280ms candidate/JS, all FAIL. Owned/compared/failed counts are162/286/2,119/171/1 and125/213/0; eligible calls171/128/129 match, and all core native/adoption clocks are positive. Failed attempt times4.375/.190/0ms are included; rig’s four allowed comparison-only residuals remain separate. Before/after1529source/7package/3input maps are exact on Node24.11/Python3.12.9 and required wasm profile. Full rows15→18 preserve all fifteen prior rows, four older batches and four ordinary diagnostics. Reader4b33c96e, summary9cb5a93d, input3e0222e6 and review78164101 agree. These loaded measurements establish no causal speedup, idle engine-1, default ownership or matching new checkpoint. B8 focused verification is below; only its unchanged full figures cost run and required checkpoint/default app proof are next.

Current numbers; each milestone that changes them updates this section.

**App-used ordinary monitor and composited export (2026-10-05):** all 793 native tests
pass (two existing ignored diagnostics), 55 affected JavaScript tests and check pass;
shipping Wasm SHA `9a94cb89d2c9`, 10,201,677 bytes. Four fixture generators run twice and
preserve all 3,660 existing JSON. Main Electron10/10 and software-web10/10 monitor
comparisons pass; full CEL means 0.028777 and 0.169556, all six corner/tiny-camera
Electron cases pixel-identical. Eleven actual lifecycle cases pass, including
empty→undo, live colour, both filter transitions and actual DPR2→1 (DPR2 mean 0.117618).
Synthetic context events certify only the existing DOM recovery path. Every comparison
has zero solid differences and no page errors; D13 is unchanged. Six actual main
No smoothing exports pass at mean 0.2298, max 50, zero solids. Their warm medians are
17.6/93.3 ms engine/JS; six interleaved fresh-renderer rounds give median total
615.5/680 ms, startup 412/448 ms and first frame 202.5/232.0 ms (load 2.7–3.1).
These measurements are separate from engine-1 and do not close plain drawing crisp,
SceneFX monitor, auxiliary onion, global D7 or class gates. Source and artifact guards
remain exact. Evidence: `tmp/root-verification-temp/current-renderer-*`, the final
CEL freeze `tmp/styk-cel-monitor-real-source-final-20261005` and composited policy
freeze `/tmp/styk-composited-export-policy-20261004`.

**Cache/Session foundation (2026-10-04):** 708 shared-type native tests pass; 104
focused JavaScript tests, check and final Wasm pass. All 59 new handoff/quiet/live/
complete-return JSON regenerate twice byte-stable. The 22 affected ordinary CLI
recordings match all 1,456 steps. Quiet Session compares 80 actual editor calls;
portable live Session compares 115 supported calls with complete returns and actual
displays. Eight native-channel tapes and five async preflight tapes remain outside
that admission. Actual prepared-cache keys, Busy-safe controls and retained camera
monitor checks pass; affected remapped-effect stored/fractional views pass web 4/4
(mean .017499) and Electron 4/4 (.024497), zero solids and no page errors. Thresholds
are unchanged. No app writer transfer, live Core coupling or class gate is certified.

**Core/projection/accounting follow-up (2026-10-04):** 505 focused edit/eval/engine tests,
59 JavaScript tests, check and threaded Wasm compile pass. Rebuilt CLI: 50 admitted tapes /
6,581 exact steps plus nine explicit guards; all 13 new evaluated groups / 147 ticks
match. The source and derived JSON regenerate twice byte-stable. Core's actual tests
compare all 115 supported live complete returns/displays and quiet history after live.
Three reviewed source patches and six owning merge adaptations preserve current cache,
replay and Bake owners. No browser adoption, app picture, class gate, physical cap or
performance claim. Eight native-channel authoring tapes remain unadmitted.

**Containers** (`engine/tools/container-parity.mjs`, `styk container roundtrip`): 461 native
files decode to the same document as `src/native-container.mjs`; all 448 version 2 files are
written back byte-identical. Before that reader and writer were deleted (2026-10-23), the app's
Rust-backed path (`styk_formats::files` in the codec module, `src/native-file-codec.mjs`) was
compared with them on 259 repository files and two 16 and 40 MB projects made from private Pivot
files: the same documents (array sharing included), 261 of 261 saves byte-identical to the
JavaScript writer, every version 2 file (252 repository files and both projects) byte-identical
to itself (the embedded original stored first, as the export worker does), and, on 1,760 damaged
copies, the same files accepted with the same documents and the same files refused. Refusals now carry the localized message
where the browser's inflate or `JSON.parse` used to raise its own text.

**Pivot codec** (`engine/tools/piv/parity.sh`, replayed by `styk-piv replay` on the final
binary): 13,369 requests of 679 scenarios answer as the Python codec does: 3,041 imports
(as documents), 121 `STYKPIV1` frame transports (bytes), 5,935 exports (bytes), 4,056 error
responses (status, code and message), 3 native containers, 213 other routes.

**Geometry** (`styk compare` against `engine/tools/reference.mjs`, every primitive and joint):

| File | Ticks compared | Primitives | Joints | Mismatches |
| --- | ---: | ---: | ---: | ---: |
| TDD2 URIEL NEMESIS 3.styk | all 232 | 113,319 | 111,056 | 0 |
| Jay on a new app (repaired).styk | all 26 | 17,238 | 22,698 | 0 |
| hitoshi vs suzu tomiee ssj.piv | 65 (every 4th) | 122,977 | 135,944 | 0 |
| finisher tdd2.piv | 95 (every 4th) | 150,474 | 174,547 | 0 |
| Valthim - Yuki.piv | 2 (every 4th) | 1,487 | 1,801 | 0 |

`svr_uriel.piv` cannot be dumped by the reference tool: its decoded JSON (588 MB) exceeds the
largest string Node can hold. To do: stream the reference from the frame transport.

**Fixtures** (`cargo test -p styk-eval`): 27 IK fixtures built by the editor, 0 mismatches,
and 122 controller outcomes and 599 solved angles equal to the editor's bit for bit with
the same iteration counts (since the solver's trigonometry moved to `styk-math`; within
4.5e-11 rad before); each fixture with a pin fails without the solver. 4 movieclip
replacement fixtures, 0 mismatches, each failing without its replacements.

**Drawing raster engine** (`engine/tools/drawing-fixtures.mjs`, `cargo test -p styk-drawing
--test parity`): 1,067 checks identical: every dab shape, batch, dirty tile and undo record of
60 strokes, 16 fills, masks, filters, selections, transforms, levels 1–5, PNG and blob bytes,
undo chunks, clipboard; `tests/drawing-engine.*` compare the two engines through the app.

**Property channels as records** (`engine/tools/records-fixtures.mjs`): 26 channel and
property-edit documents, 458 ticks identical to the editor's evaluated frame, each differing
without its channels; 1,265 of 1,265 recorded ticks overall.

**Thumbnails, library previews, camera monitor** (`scripts/engine-preview-parity.mjs`,
Electron with `--use-angle=vulkan`, D13). Engine thumbnails against the engine's export
frames of the same ticks: 121 of 121 pass, 89 identical. Against the JavaScript worker: 10,
12 and 1 of 43 steps pass at 320×192, 512×288 and 96×54. Fixtures of figures, drawings,
parallax, follow camera, colour transitions, sprites and effects pass at the two larger sizes;
scenes with text or 3D artwork fail by the mean (0.5–4.4, at most 30 solid pixels), the
waterfall plane by Canvas 2D seams. Library previews: the backdrop is the same for 12 of 12
files, hover bounds equal the editor's, and posters and frames of 3D figures and effects fail
by the mean. Camera monitor: 1 of 6 pass. The web target falls back to the JavaScript paths.

**CPU rasterizer** (`styk raster-parity`, `styk-raster` against `styk-render` on the GPU, D13,
repository corpus): thumbnails 899 of 899 at each of three sizes, export frames 677 of 677
(both samplings), library posters 193 of 193, hover frames 579 of 579; deep 3D (180
documents, 12 frames each) thumbnails 1,244 of 1,244, exports 1,242 and 1,231 of 1,244 (the
failures are solid pixels where faces nearly overlap, section 6). The private corpus, read in
place: thumbnails 93 of 93, exports 38 of 38. In the app (Electron, ANGLE on Vulkan), 139 of
140 GPU-against-CPU comparisons pass (the miss, 9 solid pixels on 15 Guns tick 1, passed 64 of
64 on a recheck).

**Cel milestone** (2026-10-04): 342 Rust tests, full `engine:parity` (201 byte-stable
command recordings, 441 repository containers) and `npm run check` pass; `npm test` retains
4,378 pass / 6 known failures / 26 skipped / 1 todo. Electron at 1440×900 on ANGLE/Vulkan:
`drawing-cels` fitted/0.3×/2×/3× 4/4 pass (mean 0.0004–0.0049, max 19); private ticks
46, 61–64 5/5 pass (mean 0.0002–0.0441, max 22, zero differences above 32). Native
CPU/GPU comparison: all 132 private frame-start thumbnails at 320×192 pass; synthetic
three thumbnails plus smooth export 4/4 pass (mean at most 0.0004, max 3). Crisp synthetic
export fails identically before and after, mean 0.2999, max 222, no solid pixels. Stable
headless web synthetic views 0/4 pass (mean 0.3473–1.3455, max 109, up to four solid pixels);
private web captures remain unverified after animation-frame settle timeouts. The app
harness now waits for currently referenced live cels, preview jobs, uploads and engine
refinement; two equal images alone do not establish readiness. No threshold was changed.

**Destination-grid cel correction** (2026-10-04): the final main shipping build passes
the same four original software-web views (mean 0.0682–0.1261, zero solids) and all four
default Electron GPU views (mean 0.0004–0.0049, max 19, zero solids). All four legacy web
captures and all four default GPU engine captures remain byte-identical to the retained
original outputs. Two editor-built single/multiple-child fixtures regenerate unchanged;
seven eligibility and two plan regressions fail on the relevant source mutants. The
single-child run may carry outer/child effects, but multiple children and ordinary onions
retain their existing policy. Auxiliary onion/monitor, private web and crisp failures
above remain explicit. Focused verification uses 632 native tests for the shared draw
type, 31 JS tests, check and shipping Wasm, without another full checkpoint or cost claim.

**Origin angle-lock definitions and spatial choices** (2026-10-04): 37 added tapes
match 4,882 steps; the 97 affected CLI recordings match 11,029, with no partial
or Unported outcomes in that admitted set. All 186 affected JSON regenerate twice
byte-stable, including 37 derived groups / 357 exact ticks. Focused checks pass
163 edit tests, two records tests, 134 JavaScript tests with one skip, syntax/locales
and shipping Wasm (9,717 KiB, SHA `b743a015efd0`). Source review preserves canonical
Bake/history/source changes through two narrow dispatch/validator adaptations.
Six actual lane mutants are caught and restored. This is offline/worker command
coverage; app adoption, complete enumerable history/returns, class gates and dense
UI cost are not certified. No public crate API changed.

**Origin records and editing** (2026-10-04): 15 specific record groups, 466 ticks
and 4,112 property values match byte for byte. Twenty-one added recordings cover 441
whole-figure gesture steps and 844 Set Origin/topology steps; all 222 recordings replay
fully. Four actual gesture-source mutations are caught. Sixty-eight editor-rejected
malformed support cases are rejected by the typed owner without a panic; 136 attempted
topology commands preserve an existing changed gesture on refusal. Root: 353 Rust tests
pass; 1,000 existing fixture files regenerate unchanged, with 16 new record files. App
shadow with exact math: 47 compared, zero rounded/mismatches/page errors, including
`setOrigin`; the earlier forced/warmed prerequisite run adopted six calls and compared
32, with identical document/history/selection/full undo. Electron and web origin support
ticks 0/3/6 plus onions pass 6/6 each (means 0.0333–0.0370 and 0.0405–0.0520 respectively,
zero solid pixels). No class flip or performance claim; unrecorded families still refuse.

**Origin joints, handles and saved transform channels** (2026-10-04): 13 pose recordings
(998 steps) and 11 channel recordings (1,772 steps, including 870 shown-frame reads) match
exactly; all 246 recordings replay. Six actual source mutants expose omitted ghost updates,
wrong target ticks or skipped attachment ancestors. Complex origin poses have 99 atomic
refusals, invalid channel previews 40, and future/malformed target guards 14. Root runs:
365 Rust tests, wasm build and `npm run check` pass; all 1,097 fixture hashes regenerate
unchanged. The stricter app driver requires each requested command to be compared and
rejects numeric rounding with exact math or page errors. Shadow: 142 exact, zero rounded
or different. Forced ownership: 67 adopted and 75 exact, with identical 289,729-byte
document, 79 history entries, selection and full undo. Edited pose pictures pass 6/6 each
(web mean 0.0747–0.0857; Electron 0.0837–0.0923); edited saved-channel pictures pass 6/6
each (web 0.0286–0.0472; Electron 0.0168–0.0310), zero solid pixels throughout. No class
flip or loaded-machine performance claim. Public crate API unchanged; no mobile pin move
is needed for signatures. The first full run passed Rust suites, all command generators
and 441 containers, but found 54 omitted derived record JSON. The fixture-only correction
adds them: 179 record groups / 2,225 ticks match Rust with zero unported ticks; all 373
record JSON regenerate byte-stable. The complete suite passed on `94a2fcfb`: all fixture
generators, 246 recordings and 441 containers.

**Compact owned responses** (2026-10-04): 18 families / 483 native calls reconstruct full
answers from compact COW draft, retained-frame and sheet deltas; 18 JavaScript adoption
tests preserve untouched references, runtime movieclip samples, ordering/removal and
frame metadata, including a 1,320-segment fixture. Root: 367 Rust tests, full parity, wasm
build and JavaScript checks pass. Actual origin app: 62 adopted + 65 exact comparisons,
zero rounding/differences/page errors; identical 730,987-byte document, 79 history entries,
selection and full undo. Startup retry passes with 165 adopted + 295 exact, identical
290,105-byte document, 80 history entries, selection and full undo; the prior crash has
no comparison result. No class flip or performance claim. Engine wasm 8,724 KiB (SHA-256 `47253e0cbc70…`), unstripped. Additive
`changesOnly` JSON fields leave public Rust call signatures and full shadow responses
unchanged; mobile consumers can keep the default protocol.

**In the app** (`scripts/engine-app-parity.mjs`, rule D13). Web target (headless Chromium,
the JavaScript renderer being its Canvas 2D fallback, WebGL2 for the engine), 29 documents
(the repository's eligible test projects and asset packs, `svr_uriel.piv`, `hitoshi vs suzu
tomiee ssj.piv`, `finisher tdd2.piv`, `tdd2 uriel nemesis.piv`), each at five ticks, with onion
skins and after playback: the engine drew 23 documents (6 refused: text outlines 5, follow
camera 1); 160 of its 189 steps pass. The 29 failing steps are six asset-pack backgrounds
(the Canvas 2D seams, see section 6) and `hitoshi vs suzu tomiee ssj.piv`. Electron target
(the WebGPU renderer): the six backgrounds pass (`04-waterfall.styk` identical pixel for
pixel; the others differ only along the document frame's right edge, at most 25 levels);
`hitoshi vs suzu tomiee ssj.piv` passes 2 of 5 ticks. Its failures are by the mean rule only
(no solid areas): edge antialiasing along thousands of spike edges, and small features the
engine draws crisper than the WebGPU renderer, which presents cached figure rasters (on one
row at tick 129, a green spot peaks at 63,212,138 in the engine and 51,158,105 in the
WebGPU renderer; an outline at 255,127,127 against 243,125,124). Not yet classified beyond
that; open in section 6. The start-up document (Blue, IK controllers) and the IK fixtures
`startup-pinned` and `joined-stretch` pass every step.

**Camera and builder focused milestone** (2026-10-04): shared-type verification passes
393 Rust tests; the 24,280-input logarithm fixture matches V8 bit for bit. Forty-three
JavaScript tests pass. All 140 generator inputs and all 49 command recordings regenerate
unchanged; 45 recordings match 1,290 steps, while four unadmitted origin/native-channel
cases refuse as tested. Forty-one evaluated groups / 362 ticks match; their 82 derived JSON
are committed with the commands. Hardware-web exact app checks: joined motion paths one
adopted + 11 compared, identical document/history/selection/full undo; measured bounds eight
compared; capacity refusal two compared and atomic. No rounding/mismatch/page errors on
these three affected checks. Strict follow adoption check remains red because cold paths
and multi-frame baking need worker-owned preparation; this is a runtime prerequisite,
not an accepted adoption result. Software-web broad driver stopped without a result.
Electron stored/preview/onion pictures pass 9/9 (mean 0.0553–0.0884, maximum 120,
zero solid pixels), with a rendered preview inspected. An earlier launch failed before
capture because the temporary path exceeded Chromium’s socket limit; the successful
retry used the short root-disk `tmp/root-tmp`. Engine wasm 8,845 KiB (+121 KiB);
check passes 1,986 JavaScript files. No gate, threshold or benchmark claim.

**Origin range/rig and native query prerequisites** (2026-10-04): 431 workspace Rust
checks pass for shared types; final focused edit/eval checks pass 178 tests after the
marquee and fractional-read corrections. All 93 affected replays match 12,050 steps
and regenerate unchanged, including 63 new recordings / 9,764 steps. Their 63 derived
groups / 647 ticks are committed; total evaluated coverage is 283 groups / 3,234 ticks.
All 190 origin generator files, 66 handle/body/snap inputs and 22 bounds inputs remain
byte-stable. Query evidence includes 817 handles, 79,021 handle-pick/origin-marquee queries,
51,120 body picks, 20,256 nearest picks, 6,003 snaps and 5,490 explicit bounds predicates;
source app filtering/order is recorded. Native cache tests cover nested clips, concurrent
admission, saturation, late revisions, cancellation and lifetime release. App exact range
14/14 and rig 10/10 calls pass without page errors; costs are loaded-machine observations
and do not open D15 adoption. All 137 focused JS tests, build and check (1,987 files) pass.
Electron pictures 12/12 (mean 0.0087–0.0978), default software web 12/12 (0.0111–0.0795),
zero solids; one rendered rig preview inspected. The added fractional preview probe fails
1/6: preview3.5 equals engine preview3 byte for byte while edit3.5 passes. Its unchanged
integer cache/binding path remains open. Hardware-opt-in web 0/9 captures an empty engine
canvas. Failures remain recorded separately. Engine wasm 8,881 KiB; no gate/threshold change.

**Remaining effects and closest-joint prerequisites** (2026-10-04): focused Rust
183, JavaScript 103 and all 27 affected replays / 898 steps pass. The 12 new VFX
recordings match 392 steps; catalogue/scenario regeneration and 44 closest-joint
inputs are byte-stable. App shadow compares 19 calls exactly, including scope,
built-in preset, group, user preset, gradient paint and six undo/redo pairs. Forced
ownership adopts one paint call, compares 18 and matches document/history/selection
and full undo. The first driver omitted required preset keys and failed before its
comparison; the corrected valid preset passes. No runtime gate or cost claim.
The initial unnecessary native `cargo test --workspace` invocation fails because
browser-only `styk-wasm` Canvas bindings cannot compile for native Linux; scoped
edit/eval tests and the proper threaded Wasm build pass. Engine wasm 8,904 KiB;
checks pass. Typed `Session::call_values` matches the JSON boundary for 830 calls;
closest-joint borrowed order matches 201,792 actual editor queries without a
per-pointer order allocation. Full parity remains a committed-HEAD checkpoint.

### Reviewed worker integration (2026-10-04)

The renderer, movie/layer/history/selection, canonical root publication and sheet motion
batch passes 615 native tests, 307 affected JavaScript tests, check and shipping Wasm.
All 3,153 affected JSON regenerate unchanged. Actual CLI evidence covers 75 admitted
new recordings / 6,446 steps, 16 intentional guards and 64 worker recordings / 643 steps.
Include the 88 new evaluated groups / 798 ticks: totals are 461 command recordings and
371 evaluated groups / 4,032 ticks. Existing every-step comparisons remain exact.

Shipping default software-web stored and fractional camera-preview captures pass 4/4
(mean 0.01781–0.04450, max 67, zero solids); the rendered preview was inspected. Focused
real-app duplicate/paste adopts three calls and compares six, with no differences or
unshadowed calls: document 22,810 bytes, six history entries, selection and full undo match.
Its timing on a loaded machine is not a class-cost or performance claim. The broad sheet
run stalled without a comparison; an initial nonexistent fixture alias and zero-action
focus attempt also remain failed evidence. None substitutes for future complete app
adoption checks. No thresholds, document-class gates or JavaScript deletions changed.

### Scoped publication and pending direct Canvas correction (2026-10-04)

The reviewed, still-uncommitted Renderer32 and verified candidate5 composition passes 743 native tests (one
explicit diagnostic ignored), 45 focused JavaScript tests, check and the actual
shipping build. All 3,618 fixture JSON regenerate stable. The rebuilt CLI matches
50 admitted affected recordings / 6,581 steps and 13 derived groups / 147 ticks;
nine recorded guards remain explicit. New clip/canvas generators and native fixture
suites are registered in the pending renderer patch. Scoped publication consumes its
exact prebuilt generation/assets under the same guard; actual Editor glyph Scene
pairing and runtime Ready/Shown adoption remain separate open work.

On Wasm `b155e35fe6a6`, direct monitor comparisons pass web6/6, default Electron6/6,
forced CPU web6/6 and tiny-angle web2/2, with unchanged D13 and zero solid pixels.
Four original default Electron cel stage comparisons pass and are RGBA-identical to
the preserved prior captures. Full cel monitor diagnostics still fail: web mean
.362844 and Electron .710108; they are excluded from the 24 passing comparisons.
The identical pre-patch Electron run has mean .369287, four strong pixels and max38,
versus 278 strong pixels and max62 after. The Legacy images are byte-identical. This
confirmed regression blocks the renderer commit; passing the focused subset cannot
substitute for fixing the original affected document. The existing direct Canvas path
has one clip and background fill; subsequent GPU-source image operations change the
Legacy edge coverage even when their image destinations do not touch that edge.
The first app driver invocation omitted its monitor flag and made zero comparisons;
the receipt validator rejected it, and the corrected actual comparisons are retained
separately. No threshold or expected pixel was altered. No gate, deletion or performance
claim. Evidence: `tmp/root-verification-temp/renderer-publication-*`.


### Guarded typed pairing and private Frame observation (2026-10-04)

The independently reviewed 23-source batch passes 528 touched-crate tests (two explicit
diagnostics ignored), check, byte-stable typed fixture regeneration twice and the pinned
threaded shipping-profile Wasm typecheck. All 3,634 captured engine JSON remain unchanged.
Actual recorded namespace/glyph observations compare Editor Scene encoding with the same
guarded after-Cache Loader and candidate Assets. Missing or malformed raw/typed sheets
refuse before publication using the existing checked planner. Original failed-before
cases, actual source mutants and independent scope correction review are preserved.

Private Frame observation tests use actual allocator identities and held source owners;
they certify only visited allocation branches. No runtime charge or caller was added.
Core/Stage/app adoption, whole physical union, last-owner release and other typed import
families remain open. Shipping pkg, app behavior, document-class gates and budgets are
unchanged. Evidence: `tmp/root-verification-temp/typed-frame-*`.


### Recorded native worker commands and raw-ready lifetime (2026-10-04)

The exact 27-source union passes 381 touched edit/engine/CLI tests with zero ignored,
check and pinned threaded Wasm typecheck. Four actual Editor generators regenerate
all 3,635 captured JSON twice unchanged. The actual rebuilt CLI matches native TRUE8/93,
old native/sheet10/115 and conventional20/2,562; six paired-input guards and eight
malformed initial observations exit nonzero. Initial comparisons precede the first
call, including a corrupt display later overwritten by a redundant correct observation.
Independent review verified the original TRUE/Raw patches, initial correction and four
required typed test contexts without losing newer typed Loader retirement.

Core tests retain all 18/208 complete calls plus exact current raw charge after ACK,
original-owner wake, detached alias barriers, cancellation/close and State allocation
watches. Original source mutants and failed-before logs are preserved as isolated
proof, not rerun or performance evidence for this union. Browser app paths/gates,
shipping pkg and budgets are unchanged. Evidence: `tmp/root-verification-temp/true-raw-*`.


Completed B10 full app cost (committed `69bbe7ab`, shipping `61537fd7901f` / 10,241,121 B): all three inputs pass strict document/history/selection/full undo, eligible counts, complete failed-attempt accounting and positive actual core work, with zero unexpected errors, mismatches, rounding or page problems. Startup 240.255/214.480, rig 138.295/130.040 and joined-chain 162.835/142.495 ms candidate/JS all FAIL. Rig includes its .24000000953674316 ms failed Native interval once before separate original JS fallback. Owned/compared/failed counts are 163/289/0, 119/171/1 and 125/213/0; eligible calls 171/128/129 match. Before/after 1,529 source/seven package/three input maps are exact. Summary `0e24675c`, input `88c76647` and independent complete acceptance `093c0a27` bind this scope. Full rows 24→27 preserve all old rows/batches/four ordinary diagnostics and milestone text. Figures stays closed; no causal speed gain, matching final checkpoint, default admission or engine-1 claim follows.

Completed B9 full app cost (committed `75bb37f8`, shipping `b9cf70669501` / 10,240,701 B): all three inputs pass strict document/history/selection/full undo, eligible counts, complete failed-attempt accounting and positive actual core work, with zero unexpected errors, mismatches, rounding or page problems. Startup 237.455/229.515 and joined-chain 156.620/138.235 ms candidate/JS FAIL; rig 136.735/141.250 ms PASS includes its .19999998807907104 ms failed attempt. Owned/compared/failed counts are 163/285/0, 119/171/1 and 125/213/0; eligible calls 171/128/129 match. Before/after 1,529 source/seven package/three input maps are exact. Summary `1c68c696`, input `2a9ac16d` and independent complete acceptance `ec7a9a86` bind this scope. Full rows 21→24 preserve all old rows/batches/four ordinary diagnostics and milestone text. The overall figures cost gate stays closed; no causal speed gain, matching final checkpoint, default admission or engine-1 claim follows.

Completed B8 full app cost (committed `c0048287`, shipping `8d47d635183e` / 10,238,324 B): strict document/history/selection/full undo, matched eligible methods and complete failed-attempt accounting pass on all three inputs, with zero differences/mismatches/rounding/page problems. Startup/rig/joined costs are 220.885/191.290, 141.865/121.675 and 167.985/144.420 ms candidate/JS, all FAIL. Owned/compared/failed counts are 163/289/0, 119/171/1 and 125/213/0; eligible calls 171/128/129 match and all core native/adoption clocks are positive. Failed attempts 0/.185/0 ms are included once; only rig retains four allowed comparison-only residuals. Before/after 1,529 source/seven package/three input maps match on Node 24.11/Python 3.12.9 and the required wasm profile. Full rows 18→21 preserve all eighteen older rows, five batch metadata objects, four ordinary diagnostics and historical milestone text. Reader `e2c0c183`, summary `497e06af` and input `112cd258` agree with raw receipts. No causal speedup, idle engine-1, default admission or matching new checkpoint is established. This completed measurement append accompanies the B9 verified figures fix below.

B8 focused verification: 209 editing and 174 evaluation tests pass with the same two ignored diagnostics; all six new controls execute, and 36 recorded tapes match all 1,668 steps. Main passes 70 focused JavaScript tests and check (2,000 files). Shipping `8d47d635183e` / 10,238,324 bytes is source-stable and keeps the required profile. The test-only fixture-scope correction preserves every numeric/full-output comparison; all 3,670 fixture JSON remain exact. No new recorded command or stored arithmetic is introduced. The completed B8 full cost above fails; a cost fix, matching final checkpoint and default figures admission remain pending.

## 8. Work queue

**Immediate command task:** the commands the app still routes to JavaScript. The engine-1
benchmark matrix is cancelled (user, 2026-10-11); a single short sanity comparison precedes
the renderer deletion (Handoff).

What remains, in dependency order. Each item ends with its parity results, docs and the
deletion of what it replaces once nothing calls it. "Agent" marks items run by a subagent
(up to the available five child slots, as authorized during takeover); root reviews and
verifies every integration. Run idle engine-1 and report the baseline table after commands
and class flips, before starting deletion.

**S3, the engine draws every document** (then the JavaScript renderer, playback workers and
effect executors are deleted):

1. Effects rendering: done for every filter type on WebGPU, WebGL2 and the CPU (milestone
   log). Recorded ordinary solid-background CEL monitors pass on Electron and
   software web; SceneFX/onion and plain drawing crisp gaps remain (section 6).
2. 3D: done (milestone log). Left: rotated movieclip drawings (`drawingRotation`), an
   indexed face format (each face is a 64-byte draw-list record), `previewRasterScale`.
3. Generators (particle effects): done (milestone log). Left: the JavaScript generator
   modules go with the JavaScript renderer (item 8).
3a. Captions and text drawn as the WebGPU renderer draws them (glyph textures), which the
   3D catalogue scenes exposed.
4. Property channels on native timelines (scalar, colour, style, effect parameters, camera,
   scene) and pose channels, with animation origins. Records for animation origins now match;
   recorded saved origin x/y/scale/rotation editing and the two saved native origin
   motion families match, including future target and ancestor guards; scalar-only
   motion, native property projection and unrecorded complex combinations remain gated.
5. Small gates: rotated and mirrored views (renderer), follow camera, layer parallax, colour
   transitions, Stick Nodes sprites, retained movieclip sources,
   `runtime_segments` fallbacks; exact fractional prepared playback remains required.
6. Every other drawing path through the engine: thumbnails, library previews, the camera
   monitor, the drawing workspace (live strokes), export frames (S4).
7. A CPU rasterizer for exports, thumbnails and devices without WebGPU or WebGL2: done
   (milestone log). Left: the camera monitor on WebGL2 stages.
8. Delete the JavaScript renderer, raster caches, stand-ins and density buckets, playback
   workers, effect executors; the eligibility gate is gone (2026-10-24).

**S1, formats:** done: the Rust codec runs in the app in place of Pyodide and the Python
sidecar, and the Python codec stays only as the development oracle (milestone log, 10:05).
Left: opening and saving `.styk` through Rust once the engine owns the document (S5);
removing the remaining sidecar names from the brand and release tooling; the personal
Windows launcher (outside the repository) must stop requiring the sidecar.

**S4, export:** frames, PNG sequence, GIF, APNG and video frames come from the engine for
documents it draws (milestone log, 2026-10-03). Thumbnails and library previews too
(milestone log, 2026-10-04); SVG export stays JavaScript (`docs/engine/rendering.md`, Why SVG
stays JavaScript); the audio mix and WebCodecs encoders stay platform services.

**S5, the engine owns the document:** `styk-edit` with history; commands ported group by
group, each checked by a command-replay harness (the same calls run in the JavaScript
editor and in Rust; documents compared byte for byte after every step, undo and redo
included); handle positions, picking and snapping as engine queries; the JavaScript
`Editor` becomes a facade whose unported commands run on a checked-out JSON copy and write
back through the mirror until none remain. Then the JavaScript evaluation, geometry,
IK, rig, movieclip and effect-model modules are deleted.

**S6, drawing raster engine** (brush, fill, selection, tiles, history) in Rust.

**S7:** remove dead machinery, final interface screenshots and comparison, final interleaved
benchmarks, `docs/performance/RUST-ENGINE-PERFORMANCE.md`, documentation set (§5 of the
task), `CHANGELOG.md`, Windows CI.

## Milestone log

| Date | Milestone | What landed | Measured |
| --- | --- | --- | --- |
| 2026-10-02 | S0 | Branch, this plan, inventory (355 engine modules), `engine/` workspace from the prototype, UI snapshot tool with touch layouts and chrome-only comparison, "before" screenshots (292), baseline test results, benchmark driver (`scripts/engine-benchmark.mjs`). | Baseline suites as in section 5. |
| 2026-10-02 | S1a containers | `styk-doc` (lossless store, JavaScript-exact JSON), `styk-formats` (container reader and writer, native document rules). | 461 native files: Rust and JS readers agree on every document; all 448 version 2 files are written back byte-identical. URIEL 3 (43 MiB skeleton) decodes into the store in 0.40 s natively, 63 MiB resident. |
| 2026-10-02 | S2 start | `styk-eval` reads the store; `styk-engine` (generations, scheduler, cache, image decoding); threaded WebAssembly build; renderer without storage buffers; `src/engine/engine.mjs`; `engine/viewer`. | In headless Chromium (WebGL2 on SwiftShader, 8 workers) URIEL 3 opens and draws; frames prepare in 3.5 ms on average in WebAssembly. In Node the module opens URIEL 3 in 0.66 s and `svr_uriel.piv` in 0.19 s once warm. Geometry parity unchanged from the prototype (Jay exact, URIEL 3 21 of 24 sampled frames; pinned IK missing). |
| 2026-10-02 18:32 | S2 incremental views | The `Loader` lives as long as a document lineage and keeps the typed figure, keyframe and pose source of every record whose tree node is unchanged; images interned by payload; style overlays resolved once per base figure. | An edit that replaces one keyframe converts one keyframe (`tests/incremental.rs`). |
| 2026-10-02 18:37 | S3 mirror | `src/engine/engine-mirror.mjs` and `styk-engine` `mirror.rs`: changed records staged per batch (properties, table layouts by old index, lifted records, pose sources) and committed atomically by revision; an invalid batch changes nothing. `EditScene` draws the pose on screen from the changed objects only (D12). | 8 mirror tests (`cargo test -p styk-engine --test mirror`). |
| 2026-10-02 19:03 | S3 editing view in the app | `src/engine/engine-stage.mjs` wraps the JavaScript renderer: for a supported document the engine draws into its own canvas, stacked where `#scene` is; the gate (`engine-eligibility.mjs`) names the first missing feature. Cross-origin isolation headers on the dev server, the desktop host and the web build. D10. | Demo document, engine against the Canvas 2D renderer: 3.4–4.4 k differing pixels at 1440×900, mean 0.055/255, largest 53–79, all on edges. A background commit is seen about 10 ms after it lands instead of 253 ms (the engine now calls `Atomics.notify`). |
| 2026-10-02 19:09 | S3 playback in the app | `src/engine/engine-playback.mjs`: for a supported document a playback packet is a ticket for a tick the engine prepared on its own threads; the playback workers get no copy of the document. | Demo (47 ticks at 24 fps) in headless Chromium (WebGL2 on SwiftShader), measured at 19:50 while the baseline benchmark ran: all 47 ticks presented in order, all by the engine; tick gap median 38.9 ms, largest 77.2 ms (the JavaScript renderer in the same conditions: 49.5 and 101.1 ms). |
| 2026-10-02 19:22 | S2 inverse kinematics | `styk-eval/src/ik/` (solver, follower and attachment tables, rig projection and refinement, analytic spatial limb, joined assemblies, `interpolateIK`), `parity.rs` shared by `styk compare` and the tests and now comparing joints too, 27 editor-built fixtures (`engine/tools/ik-fixtures.mjs`), [`docs/engine/rigs-ik.md`](engine/rigs-ik.md). Written by a subagent; reviewed, merged and re-verified here. | URIEL 3 frames with differences: 31 → 4 of 232 (every tick). Fixtures: 0 mismatches; 122 controller outcomes and 599 solved angles agree with the editor within 4.5e-11 rad with the same iteration counts. Jay: 0 mismatches. Cost on Jay +0.09 ms per frame (0.75 → 0.84). |
| 2026-10-02 19:25 | S3 onion skins | Ghost poses kept by id with their geometry; tint, fade and the placement order of `composeSceneGroups` (`onion.rs`). D11. | Demo with onion skins, engine against the JavaScript renderer, ticks 6, 13, 30: 3,634 / 4,373 / 3,734 differing pixels, largest 79 / 65 / 53, mean 0.057 / 0.054 / 0.060, edges only. |
| 2026-10-02 19:33 | S2 movieclip replacements | Layer keys that replace a movieclip with other figures (capture, break apart, make unique) are applied as `replaceMovieclipFrame` does, tweened along their own pose track; `engine/tools/eval-fixtures.mjs` and the shared `fixture-kit.mjs`. | URIEL 3, every tick: 232 of 232 frames, 113,319 primitives and 111,056 joints, 0 mismatches. Jay: 26 of 26 frames, 17,238 primitives, 22,698 joints, 0. Four fixtures, each failing without its replacements. |
| 2026-10-02 20:05 | S3 IK in the app; tools | Documents with IK controllers are drawn by the engine (the gate no longer refuses them). `scripts/engine-app-parity.mjs` (D13), `scripts/engine-bench-matrix.sh`, `scripts/engine-bench-summary.mjs`; the inventory gains a **partial** status and coverage shares. WebKit runs here. | App parity: see section 7. Inventory: 3 modules covered by Rust, 32 partly (1 % and 17 % of the engine source), none deleted yet. |
| 2026-10-02 20:10 | S1 Pivot codec (agent, reviewed and verified) | `styk-piv`: Pivot 2-5 and `.stk` reading into the store, Pivot 5 and `.stk` writing (bit-exact zlib 1.3.1), the codec service (import JSON and `STYKPIV1`, export, source cache, leases, cancellation, Python's errors); `docs/engine/formats-piv.md`. Not wired into the app yet. | Replay of the Python recording: 13,369 of 13,369 requests identical (section 7). One run each under load: `svr_uriel.piv` imports as JSON in 0.96 s (Python 2.54 s), `tdd2 uriel nemesis.piv` in 0.91 s (2.19 s). 37 unit and 59 integration tests. Inventory: 20 modules covered, 35 partly (7 % and 21 % of the engine source), none deleted. |
| 2026-10-02 20:15 | S3 renderer fixes found by app parity | Under WebGPU the engine presented the pasteboard black (wgpu lists only opaque alpha for WebGPU canvases; the stage now asks for premultiplied). Isolation layers that overflow the atlas are drawn in full-resolution rounds instead of at half resolution (`plan_rounds`, three unit tests). `engine-app-parity.mjs` gains an Electron target. | `04-waterfall.styk` in Electron: identical to the WebGPU renderer. `hitoshi vs suzu tomiee ssj.piv` tick 257: 2 rounds, no downscaling; mean difference 1.71 → 0.70 levels. |
| 2026-10-02 20:24 | S3 onion paints | Onion skins keep a segment's custom paint under the tint, as the editor's do (found by app parity). | `tests/onion.rs` fails without the fix; a painted test figure matches the editor's renderer with onion skins, edges only. |
| 2026-10-02 20:30 | S3 text outlines | Figure outlines around text: each visible glyph stroked with round joins, tessellated once per glyph and width. The last feature that kept the large Pivot files of the corpus on the JavaScript renderer. | `finisher tdd2.piv` matches the WebGPU renderer at five ticks; `tests/text.rs`. |
| 2026-10-02 20:33 | S2 effect evaluation (agent, reviewed and verified) | `styk-eval/src/vfx/`: per-pose stacks, effect clips, movieclip container stacks, connected groups, generated effects as resolved parameters; `reference.mjs --vfx`; nine editor-built fixtures; [`docs/engine/vfx.md`](engine/vfx.md). | URIEL 3: 232 of 232 ticks, effects included, 0 mismatches; the nine fixtures match. |
| 2026-10-02 20:36 | S3 edit-frame fields; parity rule | A frame whose own fields change (background, camera, order) is resent even with no changed object. The app-parity mean ignores differences of two levels or less (D13). | `svr_uriel.piv`'s last tick now shows the background alone, as the editor does. |
| 2026-10-02 20:53 | S3 drawing layers | Drawing cels: exact box-reduced levels 1–8, per-frame level choice, premultiplied bilinear filtering across tiles with halo tiles, view-independent draw lists; cels decode in the background. Unpublished strokes and drawing previews stay with the JavaScript renderer. `engine-app-parity.mjs --zoom`. | Electron, WebGPU: Jay on a new app (repaired) passes at every compared tick, with onion skins and at 0.3× and 3×; its largest cel alone is identical at 1×, 2× and 4×. |
| 2026-10-02 21:04 | S3 return-to-canvas preparation | The stage no longer asks the JavaScript renderer to prepare a scene for documents the engine draws. | Same frame as before on return from playback; the ~0.7 s joint-drag stall is unchanged and recorded in section 6. |
| 2026-10-02 21:22 | Structure; S1 Pivot in the engine; CPU raster | `styk-draw` (the draw-list format, shared); `styk-render` split into pipeline, frame, isolation, images, resources, present, view and effects; `styk_eval::open` reads `.piv`/`.stk` through `styk-piv` and the prototype reader is deleted; `styk-raster` (tiny-skia) draws draw lists on the CPU (`styk raster`). | Geometry parity unchanged on hitoshi, finisher and Valthim (0 mismatches). CPU against GPU: Jay's largest cel identical; URIEL 3 tick 60 0.17/255 mean, Jay tick 13 0.03, hitoshi tick 129 0.18, along edges. `svr_uriel.piv` opens in the CLI in 461 ms (prototype reader ~190 ms). |
| 2026-10-02 21:28 | Scaffold and docs | ADRs D1–D13 in `docs/engine/decisions/`, subsystem pages, `AGENTS.md` and `docs/ARCHITECTURE.md` updated; `npm run engine:build`, `engine:test`, `engine:parity`, `engine:bench`. | `engine:parity` repository tier passes. |
| 2026-10-02 21:31 | CI | `.github/actions/engine-build` (pinned nightly, wasm-bindgen 0.2.129, caches) before the web build, packaging and releases; an engine job runs the Rust tests on Windows and Linux; `web:build`, `pack` and `dist:*` refuse to run without `src/engine/pkg`. | Not run on GitHub Actions from here. |
| 2026-10-02 21:34 | Mobile memory (D14) | The page reserves the engine's shared memory itself: 2 GiB, else 1 GiB, else 512 MiB; `stykanimate.engine.memory` forces one. | Playwright Chromium and WebKit, isolated and not: all three maxima accepted and growable; refusal falls back to 512 MiB. Real Apple devices unverified (section 6). |
| 2026-10-02 21:36 | Mirror memory | `scripts/engine-memory.mjs`; the doubled document (D12) measured with the engine on and off (section 6). | Jay: engine WebAssembly memory 153 MiB; all processes 1,161 MiB on, 1,182 off. `svr_uriel.piv`: 268 MiB; 1,390 on, 1,866 off. |
| 2026-10-02 21:41 | S5 design and JavaScript harness | [`docs/engine/editing.md`](engine/editing.md) (D15): commands ported one at a time record for record, then engine queries, then the engine owns the document. `engine/tools/edit-replay.mjs` and `edit-scenarios.mjs` record the editor's report, state, results and change events after every step. | Recordings are byte-stable. |
| 2026-10-02 21:55 | S5 phase 1 start | `styk-edit`: selection (with add, toggle and `selectMany`), seeking, gestures (begin, commit, cancel, translation scope), moving figures (`fromStart`, `detachExternal`, joined roots refreshed from the engine's geometry), undo and redo; `styk edit-replay`; a cargo test replays every recording. | 7 recordings, 81 steps: the four scenarios of ported calls (61 steps) match the editor at every step (document bytes, state, results, events); the other three match up to their first unported call. Inventory: 22 modules covered, 40 partly (7 % and 25 % of the engine source), none deleted. |
| 2026-10-02 22:07 | S5 transforms; V8-exact maths | `styk-edit`: `rotateSelection`, `scaleSelection`, `scaleSelected`, `mirrorSelection` (whole figures), `rotateFigure`, `centerFigure`, `resetPose`, pivots from the engine's geometry. `styk-math` (D16): V8's fdlibm `sin`, `cos`, `atan2` and `hypot`, now also the IK solver's `hypot`. ADRs D15 and D16. | 9 recordings, 122 steps: six fully ported scenarios (87 steps) match at every step; transform-native matches 20 of 21 steps, up to its deliberately unported branch flip; the other two up to their first unported call. `styk-math` against V8: 0 of 2.8 million inputs differ (Rust's `f64::sin` 2.7 %, `f64::atan2` 17 %). |
| 2026-10-02 22:13 | S5 joint gestures | `styk-edit`: `poseJoint`, `rotateJoint`, `bendJoint` with stretching, isolation and snapping back to the definition; rotations carried into joined figures (`rotationEdits`); `styk_eval::geometry::segment_pose` shared by the geometry and the editor. Rigs, IK, 3D bones and Stick Nodes curves answer `Unported`. | 12 recordings, 188 steps: ten fully ported scenarios (159 steps) match at every step, including every snap branch; transform-native matches 20 of 21 steps up to its unported branch flip; move-sheet waits for layer sheets. |
| 2026-10-02 23:39 | S5 evaluated frame as records | `styk_eval::records`: what a gesture's commit stores (`snapshotPoseFrame(editor.evaluatedFrame)`), for imported layers, authored pose keys, the layer composition, movieclips leaving the frame and layer order; numbers from the typed evaluator. `engine/tools/records-reference.mjs`, `records-fixtures.mjs`, `styk records`, `tests/records.rs`. | Byte-identical to the editor at every tick it produces: Jay on a new app (repaired) 26 of 26, TDD2 URIEL NEMESIS 3 228 of 232 (4 need movieclip frame replacements), 158 of 322 ticks of the 42 editor-built documents (the rest: IK, effect and movieclip-replacement tweens, not ported yet). No produced frame differs. |
| 2026-10-02 23:45 | S5 evaluated records, complete on the corpus | Tweened IK controllers, figure and scene effect stacks and movieclip frame replacements as records; evaluation tweens angles through `styk_math::shortest` (D16: the platform's trigonometry gave `-0.06` for a stored `-0.05999999999999999`). | Byte-identical at every tick: TDD2 URIEL NEMESIS 3 232 of 232, Jay on a new app (repaired) 26 of 26, the 42 editor-built documents 322 of 322. Geometry parity unchanged (URIEL 3: 113,319 primitives, 111,056 joints, 337 effects, 0 mismatches; Jay 0). |
| 2026-10-02 23:50 | S5 evaluated records on Pivot imports | Records follow the editor's unwrapping of Pivot-eased angles along the whole run of keys (`evaluate_native_exact`; the drawing path keeps its constant-time unwrap). Fixture `eval-legacy-winding`. | Pivot files, every 7th tick: hitoshi vs suzu tomiee ssj 37 of 37, finisher tdd2 55 of 55, AyameDemo 105 of 105, Uriel 19-2-2026 60 of 60 identical (hitoshi tick 182 differed by 2π in one angle before). Fixtures 343 of 343; the new one fails without the change. |
| 2026-10-02 23:56 | S2 layers mixing imported and authored keys | After an edit, an imported layer has both kinds of keys; the editor tweens it through a window of the keys around the playhead. The typed evaluator held the authored pose instead (a wrong picture between such keys during playback); it now builds the same window (`mixed_window`), and the records follow. Fixture `sheet-mixed-keys`. | The fixture's 13 ticks: 81 of 117 primitives and 99 of 143 joints differed before, 0 now; its records are identical (fixtures 356 of 356). |
| 2026-10-03 00:07 | S5 gestures on a layer sheet | `styk-edit` runs every ported call the way the app does: a draft of the evaluated frame (`authored.rs`), the commit through the sheet planner (`sheet.rs`: `_commitSheetPose`, `write`, `capture`, `materialize`, `publish`), `layer-sheet` history with undo, redo and the collection of sources from a dropped redo branch; an `Unported` call restores everything it touched. The replay state gained the layer revision and the next frame identity. | 16 recordings, 279 steps: the 15 scenarios of ported calls (258 steps, five of them on layer sheets: 99 steps) match the editor at every step in document bytes, state, results and events; transform-native 20 of 21 (a branch flip is not ported). |
| 2026-10-03 00:16 | S5 movieclips on a layer sheet; cost of a gesture | Gestures on documents with movieclips: an instance is edited in the frame replacement that places it, other figures bake the replacement into their new pose, patch-only boundaries are fixed first; the committed draft stays on show until invalidated, as in the editor (it differs from a fresh evaluation after editing a replacement between its keys). `styk edit-bench`. | 18 recordings, 325 steps: the 17 scenarios of ported calls (304 steps) match at every step. On Pivot imports of about 100 MB (native, one run each, busy machine): a move step 0.01 ms, a joint-pose step up to 0.56 ms, a commit 2–7 ms, the first call on a document 68–102 ms. |
| 2026-10-03 00:17 | S3 filter effects on the GPU (agent, reviewed and merged) | Every filter effect drawn by the engine as GPU passes on WebGPU, native and WebGL2: figures, nodes, connected groups, movieclip containers and the scene stack, ported from `VfxWebGPU.run` (`styk-render/src/effects/`, `styk_eval::vfx::layers`). The gate refuses only generated effects. The engine's memory starts at the size its module declares (a hard-coded size stopped the engine from starting once the module grew). Onion skins draw solid paints in the skin's tint. | The agent's runs: Electron (engine WebGPU against the WebGPU renderer) 30 of 30 steps on 8 effect documents, mean ≤ 0.075; web (WebGL2 against Canvas 2D) 23 of 30, the 7 being 6 scene-camera steps where Canvas 2D clears the camera rectangle and one pixelate edge; URIEL 3 in Electron 103 of 109 ticks (41: the old renderer had not shown a cel yet; 46: a drawing layer's onion skin missing; 61–64: a drawing cel under blur, bloom and glow). `styk gpubench` 1440×900: p50 0.36–1.9 ms with effects, 0.11–0.29 ms without; GPU memory for effect atlases up to 160 MiB. Here: 205 Rust tests on the merged tree; app parity not yet rerun after the merge. |
| 2026-10-03 00:23 | S5 keys and frames of the layer timeline | `styk-edit`: `sheetInsertKey`, `sheetDuplicateFrameAfter`, `sheetSetEasing`, `sheetClearKeys`, `sheetClearFrames`, `sheetInsertFrames`, `sheetRemoveFrames`, `sheetSetDuration`, `sheetAppendFrame` on the planner (blank cells, inherited easing, clip retiming), and the sheet's validation errors in `publish`. | 22 recordings, 417 steps: the 21 scenarios of ported calls (396 steps) match the editor at every step, refused arguments included; a hand-edited document with a clip on the document's clock checks span and restart retiming. |
| 2026-10-03 00:29 | S5 commands that draft the whole frame | `styk-edit`: the editor's `transaction` on a layer sheet, with `joinTo`, `unjoinFigure`, `joinFigure`, `deleteSelection`, `deleteFigure`, `duplicateFigure`; figure-pose counts (`_layerUidCounts`) so that a figure appearing or disappearing bumps the layer revision as in the editor; new figures take their layer from the hints; the replay state carries the next figure identity. | 24 recordings, 476 steps: the 23 scenarios of ported calls (455 steps) match the editor at every step. |
| 2026-10-03 00:34 | Baseline complete | Rounds 2 and 3 of the baseline benchmark; [`docs/performance/RUST-ENGINE-BASELINE.md`](performance/RUST-ENGINE-BASELINE.md). | 84 runs (7 configurations × 4 files × 3), 4 flagged busy; medians and ranges in section 5 and the report. |
| 2026-10-03 00:45 | S5 shadow editing in the app | `styk_edit::session` (calls in, JSON out), `EngineHandle.edit_session` / `EditSession.call` in `styk-wasm`, `Engine::mirrored`, `src/engine/engine-edit-shadow.mjs` (off unless `?engineShadow=on`), `scripts/engine-edit-shadow.mjs`. D15 revised (shadow, then ownership flips per document) and D16 restated (one `Math`, Node's; browsers disagree among themselves). | Headless Chromium, real pointer drags, keyboard undo/redo and commands on four documents: 77 of 77 calls the same as the editor in each (28–53 only in last digits, Chromium's `Math`), engine 28–31 ms against the editor's 58–63 ms for those calls. The start-up document answers `Unported` throughout: it has IK controllers. |
| 2026-10-03 10:05 | S1 the Pivot codec in WebAssembly in the app (agent, reviewed, completed and merged) | Every build opens and writes Pivot files with `styk-piv` compiled to WebAssembly (`engine/crates/styk-codec-wasm`, stable Rust) and run in a worker of the editor page; Pyodide, the PyInstaller sidecar and its scripts, `desktop/backend.cjs` and `src/codec-web-engine.mjs` are deleted; desktop samples come over two IPC calls (`desktop/samples.cjs`); `backend/` and `codecs/` stay as the development oracle. Completed here: CI builds the engine before the unit tests, a stale sweep step, the export contract doc, `scripts/smoke-native-formats.mjs`. | Web build 61.3 → 51.0 MiB raw, 17.4 → 12.5 MiB at Brotli 5 (Python runtime 13.3 / 5.8 MiB → none; WebAssembly 6.5 / 2.0 → 9.7 / 3.0 MiB: engine 5.6 MiB, codec 1.5 MiB). Import medians of three interleaved rounds, measured by the agent before → after: desktop from source (Xvfb, Canvas 2D) `svr_uriel.piv` 12.58 → 4.44 s and `tdd2 uriel nemesis.piv` 28.89 → 6.07 s; web build (headless Chromium) 23.40 → 7.37 s and 20.32 → 8.14 s; development server 2.67 → 3.05 s (the old service had a C++ scanner) and 5.47 → 4.14 s. Same documents, key order and edited-export bytes as the Python service on four files; AyameDemo.piv exports the same 2,091,013 bytes in Chrome 153, Firefox 155 and WebKit 26.6. Here: `npm test` 4,347 of 4,380 pass (the 6 known failures), `engine:test` 208, `engine:parity` all ok, Python oracle 161 pass, `web:verify` ok, desktop round trip 17 of 17. |

| 2026-10-03 11:02 | S5 inverse kinematics in `styk-edit` | Every IK path of the editor's gestures, as the editor runs them: controller targets moving with their figure (`translateIKTargets`); dragging the end of a limb (`poseIKTarget`: a pinned target moves, a free limb is captured as drawn, solved and baked); around pinned limbs, the displayed solution baked before a pose edit, follower offsets turned with their joint, the bend remembered after each change, a stretched end followed by its pin; across joined figures, the assembly's temporary skeleton (`styk_eval::ik::joined::Assembly`, now public and shared with geometry) for all of it, with `_ikPoseSlots` and `_expandIKDrag`. The IK solver and rig constraints use `styk-math`. Only 3D controllers and posing a target in perspective answer `Unported`. | 33 recordings, 654 steps: the 32 scenarios of ported calls (633 steps; 10 new IK scenarios) match the editor at every step in document bytes, state, results and events, and each new IK path breaks at least one of them when removed. The solver's 122 outcomes and 599 angles now equal the editor's bit for bit (`tests/ik.rs` compares exactly). App shadow (headless Chromium): the start-up document 77 of 77 calls, `startup-pinned` 88 of 88, `followers` 88 of 88, `joined` 54 of 54 the same as the editor, none different; engine 82–100 ms against the editor's 167–182 ms for those calls. |

| 2026-10-03 11:10 | S5 Stick Nodes curves | `styk-edit` poses Stick Nodes figures: a straight segment with a sagitta is drawn as a curve whose bend geometry reports as 1e-6, which the pose arithmetic uses. | Recording sticknodes-sheet: 13 of 13 steps match; 1 of 13 without the rule. |
| 2026-10-03 12:01 | S5 engine-owned editing (opt-in) | `?engineEdit=on`: the editor facade runs the calls that change the document in the engine only and adopts their results (the gesture's draft and snapshots, the published sheet through the editor's own `publish` via `adoptLayerSheet`, the committed draft kept on show, selection, next identity); selection, seeking, begin/cancel and history run in both. Session answers carry the replaced tracks only, the gesture's snapshot set and the retained draft. `scripts/engine-edit-shadow.mjs --own` compares a run with the editor alone and one with the engine owning; `--import` opens native files through the page. D15 records the step. | Eight documents (the start-up document, startup-pinned, followers, joined, joined-chain, sheet-layers, sheet-movieclip-loose, and AyameDemo.piv imported, 48.7 MB): 39–65 calls adopted each, documents, history labels and selection the same as with the editor alone, also after undoing everything (28–996 numbers differ in their last digits, D16). Two adoption defects found and fixed on the way (the kept draft, joined roots refreshed at commit). Cost on AyameDemo: see section 6. Shadow mode unchanged (start-up document 77 of 77). `npm test` 4,347 of 4,380 (the 6 known failures). |
| 2026-10-03 12:02 | S3 3D (agent, reviewed and merged) | `styk_eval::spatial` (pose tweens, perspective with near-plane clipping, part proportions, hidden pose choices, surface culling and depth, mesh skinning and splitting, bone-attached movieclip meshes; all through `styk-math`), a depth-tested face run kind in `styk-draw`, drawn by `styk-render` (two depth pipeline variants, depth buffers only for passes with faces, objects with faces drawn from rasters at the editor's density) and `styk-raster` (four-sample depth); records of 3D pose tweens; `engine/tools/spatial-fixtures.mjs` (13 editor-built projects, 120 recorded tweens); the gate lets 3D through except rotated movieclip drawings; `docs/engine/spatial.md`. `styk-edit` refuses 3D documents until replays cover them. | The agent's runs: catalogue drawn by the engine 349 of 358 files (16 before); geometry over all 175 `.styk` scenes (3,215 frames, 92,332 primitives, 323,521 joints) and 183 `.stkz`/`.stykmov` files: 0 mismatches; URIEL 3 and Jay unchanged; records 512 of 512 ticks; Electron parity: Karate fighter 16 of 16 steps, turntables and fixtures pass, 15 Guns, Hand & Face and Vehicles fail in captions only (section 6); web: seven 3D documents pass. Jay (no 3D) cost unchanged (evaluation 1.08 → 0.99 ms, GPU p50 0.26 → 0.27 ms). Here on the merged tree: `engine:test` and `engine:parity` all ok, `npm run check`, shadow 77 of 77 and engine-owned editing on the start-up document unchanged. |

| 2026-10-03 12:21 | S5 rig controls | `styk-edit` poses rigged figures: geometry keeps each rigged joint's space and connector state (`RigJoint`); the pointer goes through `authoredRigTarget` in a rig space (`authored_rig_target_with` reports a collapsed driver), angle locks only stretch, connectors slide (`slideConnector`, `setConnectorPosition`) and bend through the pointer. | rig-sheet 23 of 23 steps, two rigged IK fixtures 9 of 9 each; each rig path breaks rig-sheet when removed. App: a rigged document 77 of 77 shadowed calls the same; engine-owned editing matches the editor alone. |
| 2026-10-03 12:44 | S5 cheaper poses | Rotation targets with sets instead of list scans, a figure's angles changed in one pass, the drag's rotation targets cached (as `_drag.rotationTargets`), joint gestures reading the geometry of the posed figure only (`geometry::build_only`), the 3D check once per document, sessions starting from the mirror's loader and prepared views. | Native pose step on AyameDemo's 515-segment figure 8.42 → 0.39 ms (`styk edit-bench`). App, engine-owned, 36 pointer poses: 200.6 → 56.1 ms in the engine (+15.9 ms adoption) against the editor's 25.3 ms; all owned calls 899 ms against 898 ms. Still opt-in (section 6). |
| 2026-10-03 12:50 | S3 gate census | `engine/tools/gate-census.mjs`: each native document loaded as the app loads it, then the gate. | 382 documents (catalogue, private corpus, fixtures): 370 drawn by the engine, 10 refused for generated effects, 2 do not load in Node. |
| 2026-10-03 13:30 | S5 3D documents, 3D bones, 3D IK frames | The blanket refusal of documents with 3D goes; `styk-edit/src/spatial.rs` turns 3D bones (`setSpatialPose`, `rotateJoint`), drags them flat or in depth (alternate side, mid-drag switch), stretches and twists them, and sets or drags mechanisms' hinges and slides; `styk-math` gains V8-exact `asin` and `acos` (the `libm` crate's: 0 of 15,073 recorded inputs differ, the platform's 1,046 and 605). Frames with 3D IK controllers run every call except posing a 3D target, steering a planted knee, twisting with 3D IK and whole-figure turns; posing a bone of a planted limb releases it, a posed foot plants its orientation, turned followers' 3D orientations follow. | 50 recordings, 948 steps: the 49 scenarios of ported calls (927 steps) match the editor at every step; 13 new 3D scenarios, each new path breaking one when removed. App shadow: a 3D catalogue scene 73 of 73, the Kung-Fu Master and Karate Fighter rigs 78 of 78 each, none different; engine-owned editing on the 3D scene matches the editor alone. |
| 2026-10-03 14:07 | S5 posing 3D IK targets; exact comparison in the browser | `styk-edit/src/spatial_ik.rs`: a planted 3D target moves with its knee kept on its side on screen (`_flatSpatialIKPole`), the depth key pushes it in depth and a plain drag continues from there, `setSpatialIKTarget` sets depth, pole and swivel, a free 3D limb is captured once per gesture and solved without following the target's orientation; IK posing on rigged figures reads drawn angles from the rig (`RigJoint` carries each joint's evaluated angle, bend and length). The shadow driver gains `--exact-math`: the page's `Math` is replaced by the engine's (exported from `styk-wasm`), so a difference is told from Chromium's rounding. | Three recordings replay bit for bit, each path breaking one when removed. App shadow with the engine's `Math`: the Kung-Fu Master and Karate Fighter rigs 95 of 95 each (with Chromium's `Math` a free 3D foot drag differed by 1.54 rad on a nearly straight leg), a 3D scene 74 of 74, the start document 94 of 94, five other documents exact. |
| 2026-10-03 14:42 | S5 steering planted 3D limbs | Dragging a planted knee or elbow swings the limb's bend plane (`getSpatialIKPole`, `setSpatialIKPole`); twisting a bone of a planted limb swings its swivel and twisting the ankle or wrist marker turns the foot or hand; a whole figure turns with its 3D targets, bend planes and planted orientations; `resetSpatialPose` for a bone, a mechanism or the whole rig. No 3D IK path of the gestures is refused now except posing a joined 3D target. The shadow driver adds a planted-knee drag, a right-button twist and a rig reset on figures with 3D bones. | 4 new recordings (102 steps) match the editor at every step; 7 of 8 mutations break one (the eighth, not keeping the foot's twist reference, is equivalent: a planted foot's drawn orientation does not move between samples of one gesture). App shadow with the engine's `Math`: the planted-leg fixture 140 of 140, the two martial-artist rigs 115 of 115 each, a 3D dojo prop 94 of 94. |
| 2026-10-03 14:43 | S3 generated effects (agent, reviewed and merged) | `styk_eval::vfx::generated` (every style of particles, auras, beams, smoke and explosions; layers, anchors on earlier ticks, nested movieclip generators, batches, per-particle evaluation, the 17-row material atlas; V8-exact `exp` in `styk-math`), `K_PARTICLE`, `K_BEAM` and `F_ADD` in `styk-draw`, drawn by `styk-render` (an additive pipeline variant, the material atlas) and `styk-raster`; an anchor cache per generation in `styk-engine` with a 6 ms budget on edit frames (`Stage::refining` asks the app to draw again); `engine/tools/generator-fixtures.mjs` in `engine:parity`; the gate no longer refuses generated effects. | 8 editor-built fixtures, 32 ticks, 8,428 particles bit-exact (sizes within 1e-12: `pow`); the atlas byte-exact. Electron app parity: every fixture passes (35 steps, mean ≤ 0.067, no solid pixel); Impact-FX-Fight 0 of 6 from caption and figure edges (the same with effects off in both); URIEL 3 2 of 4 from a cel not yet uploaded. Gate census 373 → 383 of 384. Engine module +373 KiB. |
| 2026-10-03 15:06 | S5 pose choices | `styk-edit/src/pose_choice.rs`: `setPoseChoice` for groups of 3D bones shown one at a time or all hidden and for presets over existing channels, the selection read back from the channels as `poseChoiceGroups` does; the shadow driver picks another choice on rigs that have them. | 3 recordings (33 steps) match the editor at every step; 7 of 7 mutations break one. App shadow with the engine's `Math` on a Hand-and-Face demo scene: 100 of 100 calls the same; engine-owned editing there matches the editor alone (3.1 MB document, 16 history entries, and after undoing everything). |
| 2026-10-03 15:51 | S5 cheaper commits | Publishing a gesture found each layer key among the earlier ones by scanning and cloning (quadratic in a layer's keys), and every re-read of the document after a commit copied and re-resolved styled frames after looking up every object's figure; keys are now found by identity through a map, only styled objects are looked up, resolved frames stay in the loader's cache, and commits refresh joined roots from the figures concerned only. `scripts/engine-edit-cost.mjs` measures a pose gesture per call in the app. | AyameDemo commit natively 12.7–13.0 ms → 1.5–1.7 ms (interleaved), in WebAssembly 7.7 → 2.7 ms. Per call in the app the engine poses and commits faster than the editor on every figure document measured (start document 0.16 against 0.33 ms a pose, AyameDemo 0.84 against 1.59 ms); 3D documents not yet everywhere. engine:parity all ok. |
| 2026-10-03 16:08 | S5 engine-owned editing on by default for large figure documents (D15) | `editingClass(report)` (`movieclips`, `3d`, `large figures` from 1,000 segments across the figure definitions, `figures`); by default the engine owns the ported calls of the classes in `OWNED_CLASSES`, now `large figures`; `?engineEdit=on/off` and `?engineShadow=on` still decide when set. The shadow driver's `--own --default` runs the app as users get it. | Shadow driver interactions, editor alone against default: 20 figures of 200 segments 163.2/213.6 ms → 100.1/175.8 ms, AyameDemo 946.7/1,171.2 → 757.7/801.8 ms (two rounds), documents, history and selection the same; small figure documents stay with the editor (start document 87.8 ms owned against 76.8 alone), 3D documents untouched in default mode. npm test 4,347/4,380 (the 6 known failures); test:timeline, test:hotkeys:ui and test:touch pass; test:ui stops at its WebGPU check (no WebGPU in headless Chromium here). |
| 2026-10-03 16:21 | S3 the remaining gates (agent, reviewed and merged) | Layer parallax (`styk_eval::parallax`, offsets baked into draw lists, generated effects moving with their layer), the follow camera (`styk_eval::follow`: bounds sampled through `geometry::build_measured`, dead zone, look-ahead, springs, zoom; paths extended in chunks behind a non-blocking swap, D7; edit frames now follow preview camera motion), colour transitions (an index per drawn item into `Scene.transitions`), Stick Nodes sprites, animation origins (`styk_eval::origin`: layout and support-graph kinds, corrected roots, in-between tweens, the rotation `figure_angle` uses), rotated movieclip drawings; new eval, origin and spatial fixtures, each failing without its feature. The gate refuses only property channels, frame drafts and deeply nested movieclips. | engine:test 243 passing; engine:parity all ok (with `origin-fixtures`) on the merged tree. App parity (agent): every new fixture passes on web and Electron (parallax 10/10, follow 13/13, colour transitions 9/9, sprites 7/7, origins 6/6 each, rotated drawings 13/13), a private follow-camera recovery file 16/16 and 11/11; after the merge parallax 3/3 in the app here. Gate census: 382 native documents, 380 drawn, 2 do not load in Node. Cost on documents without the features within noise after two fixes (a colour transition held per item as an index, origin corrections skipped without origins). |
| 2026-10-03 16:54 | S5 IK settings | `styk-edit/src/ik_settings.rs`: `setNodeIK` (switching a controller on pinned where the limb is drawn or off with the limb kept as drawn, pin and release with the released chain's lengths kept, stretch, chain length, bend side, a 3D limb's swivel, the editor's refusals), `rotateIKTarget` (a free limb captured first, its branches turning), `setSpatialFeetPinned`; captures take the controller they are for (`capture_with`). Joined figures answer `Unported`. Measured too: the `3d` class is not yet cheaper in the engine (owned against alone in the app: Dojo interior 270 vs 323 ms, 15 Guns 120 vs 433 ms, but Vehicles 96 vs 76 ms and a moving-parts demo 166 vs 113 ms), so it stays with the editor. | 5 recordings (75 steps) match the editor at every step; 9 of 10 mutations break one (the tenth, the "Both" recapture, is masked by the bend the edit remembers afterwards, in the editor too). App shadow with the engine's `Math`, with the driver changing a limb's IK settings: start document 102/102, planted 3D leg 116/116, every limb pinned 113/113. |
| 2026-10-03 17:26 | S5 the layer list | `styk-edit/src/layers.rs`: the `layers` history entry (`_layerEdit`: changed paths of the layer state, the sheet's tracks following the layers, undo and redo), renaming, colours, visibility, locks, order, new layers and folders; the session counts a sheet as published only when an event says so, as the facade does. The facade runs them in both editors and compares (not adopted), so an engine-owned session lives through layer edits. | 3 recordings (58 steps) match the editor at every step; 9 of 9 mutations break one. App shadow with the engine's `Math`, the driver renaming, colouring, hiding, locking, creating, moving and grouping layers: start document 117/117, two-layer sheet 96/96; owned mode there keeps one session and matches the editor alone. |
| 2026-10-03 17:49 | S5 adding figures | `addFigure` on a layer sheet runs in the engine (`Editor::add_figure`, `commit_sheet_range`: the editor's range commit, which keys only the inserted figure's layer), owned by default with the rest of the large figure class. | 2 recordings (21 steps) match the editor at every step; 4 of 4 mutations break one. App shadow with the engine's `Math`: start document 120/120, two-layer sheet 99/99; owned there matches the editor alone. In default mode on AyameDemo one engine session now carries every interaction of the driver, layer edits and adding a figure included: 1,016.8 ms against 1,112.2 ms with the editor alone, the same document, history and selection. |
| 2026-10-03 18:05 | S5 moving keys | `sheetMoveFrames` runs in the engine: keys moved or copied along their tracks (a key made first where there is none, landing keys replaced, imported keys captured, the track and sheet lengthened), owned by default with the large figure class; moving a movieclip's keys and copying a drawing layer's answer `Unported`. | 2 recordings (18 steps) match the editor at every step; 5 of 6 mutations break one (capturing imported keys before they move is also done by publishing, which captures them at their old tick). App shadow with the engine's `Math`: start document 125/125, two-layer sheet 104/104; owned there matches the editor alone in one session. |
| 2026-10-03 18:17 | S5 the inspector's figure fields | `updateObject` and `updateSelection` run in the engine (scale, position, opacity, name, colour, mirroring, metadata, with the editor's refusals), owned by default with the large figure class. | 2 recordings (23 steps) match the editor at every step; 6 of 6 mutations break one. App shadow with the engine's `Math`, the driver editing a figure from the inspector: start document 128/128, two-layer sheet 107/107; owned there matches the editor alone in one session. |
| 2026-10-03 18:29 | S5 the inspector's segment fields | `updateSegment` runs in the engine (the joint's angle, length and bend as one posed edit; the definition's style fields, with its raw flags, as a `figure` history entry, a new kind in `styk-edit`). | 2 recordings (32 steps) match the editor at every step; 6 of 6 mutations break one. App shadow with the engine's `Math`, the driver editing a segment from the inspector: start document 133/133, rig document 112/112; owned editing on the start document matches the editor alone in one session. |
| 2026-10-03 18:30 | S3 captions and text (agent, reviewed and merged) | Text drawn as the editor's WebGPU renderer draws it: objects holding text are raster entries on the editor's `objectBounds` and grid (`rasterObject`; none of the failing captions was a lone glyph), lone solid glyphs `K_GLYPH` records drawn from masks laid out as `glyphTextureDescriptor` does and filled once per glyph and size into a GPU atlas kept across frames (at most 64 MiB, least recently used pages evicted), their triangles past density 8; large Pivot text flattens finer (within 0.1 world units, a 64 MiB cache). | Electron app parity (limits unchanged): 15 Guns 0/5 → 4/5, Hand & Face 2/5 → 5/5, Vehicles 7/16 → 16/16, Impact-FX-Fight 2/11 → 11/11, a private Pivot file 2/4 → 4/4; documents without text unchanged. GPU p50 unchanged on catalogue scenes, Uriel tick 370 1.87 → 0.65 ms. engine:test 249 passing; engine:parity all ok on the merged tree. |
| 2026-10-03 18:49 | S5 camera motion clips | `setCameraMotion` and `deleteCameraMotion` run in the engine (`styk-edit/src/camera_motion.rs`: `validateCameraMotion` with the editor's tables, muted ranges moved with their clip, the sheet lengthened to the last clip, a `camera-motion` history entry whose history event has no `structural`, as the editor's). | 1 recording (20 steps) matches the editor at every step; 6 of 6 mutations break it. App shadow with the engine's `Math`, the driver editing and deleting a clip: a follow-camera document 116/116, start document 133/133. |
| 2026-10-03 18:49 | S3 property channels (agent, reviewed and merged) | `styk_eval::channels`: `_styk.animation` and a layer sheet's `legacyAnimation` read into typed channels and applied wherever the native timeline is evaluated, inside movieclip documents too: pose channels (`composePoseChannels`: key tracks, masked ranges, base poses, native appearance, joins re-resolved, stacking anchors; only a channel's own figures tweened), then scalar channels with every curve (figure transforms, colour, opacity, depth, outlines, segment and polygon styles, camera, background and colour key, effect parameters, stacks and scopes); `animationEndTick`, presence boundaries, the follow filter, joint direction with origins; a shared native sample of a sheet returned whole. 12 editor-built fixtures in two forms (`channel-fixtures.mjs`, in `engine:parity`). The gate refuses only frame drafts and movieclips nested deeper than 16; styk-edit still refuses documents with channels, now their own editing class (`unported`, not owned by default). | engine:test 247 on the merged branch; engine:parity all ok on the merged tree (with `channel-fixtures`); fixtures 24/24 forms match the editor, each kind and curve required. App parity (agent): web 132/132, Electron on WebGL2 under Xvfb 132/132; here after the merge, a channel fixture 3/3 on the web target. URIEL 3 and Jay geometry and records unchanged. Cost without channels within noise; engine module +97 KiB. |
| 2026-10-03 19:15 | S5 the project palette | `styk-edit/src/palette.rs`: adding, removing and reordering project colours (`#rgb` to `#rrggbbaa` text or bytes, the editor's refusals), one `palette` history entry each. | 1 recording (17 steps) matches the editor at every step; 5 of 6 mutations break it (the sixth is equivalent: the insertion is clamped anyway). App shadow with the engine's `Math`, the driver changing project colours: start document 139/139. |
| 2026-10-03 19:46 | S5 audio tracks and clips | `styk-edit/src/audio.rs`: `setAudioTrack`, `deleteAudioTrack`, `setAudioClip`, `deleteAudioClip` with `validateAudioState` (each recording checked once, by identity, as the editor's `WeakSet`), one `audio` history entry each. Not run in the app yet: the mirror leaves the audio out (recordings up to 96 MiB would be held twice), so they wait for the engine to save (S5). Commands that draw random identities and frame ripples stay in the editor. | 2 recordings (39 steps) match the editor at every step; 14 of 16 mutations break one (the other two are equivalent: recordings are checked when a document opens and these commands add none, and the empty-audio undo is unreachable). |
| 2026-10-03 19:59 | S5 layer focus in the facade | The facade starts no engine session while a layer focus locks layers or a timeline layer selection follows seeks, and ends the current one when either changes (`editing.md`, runtime state). | The driver's new focus step: without the guard, owned editing inserted a key on a focus-locked layer that the editor refuses (a different document and history); with it, shadow 139/139 and owned editing the same as the editor alone. |
| 2026-10-03 20:18 | S5 the timeline clipboard | `styk-edit/src/sheet_clipboard.rs`: `sheetCopyFrames` and `sheetPasteFrames` (over or inserted, on the same layers or on others with new identities, joins and IK followers renamed together), owned with the large figure class; a session pastes only the clipboard it copied (the facade compares the editor's clipboard object). `ownedFrame` now keeps a figure joined to one left out where geometry puts it, and `publish` counts each figure's poses before it changes the document (paste showed the late count missing a layer revision). | 3 recordings (40 steps) match the editor at every step, every other recording still does; 14 of 15 mutations break one (the fifteenth, ordering renamed followers, is equivalent: identities are allocated in ascending order). |
| 2026-10-03 20:36 | S5 polygons | `styk-edit/src/polygons.rs`: `addPolygon`, `updatePolygon` (handles, order, surface removal), `removePolygon`, with the editor's refusals (cycles drawn twice in either direction, handles, colour, opacity, 32-bit order), one `figure` entry each; compared in the app, not adopted. Colour and opacity on a figure on show, and new surfaces, stay in the editor. | 3 recordings (44 steps) match the editor at every step; 12 of 12 mutations break one. App shadow with the engine's `Math`, the driver creating, reshaping and deleting a polygon: start document 150/150; owned editing the same as the editor alone. |
| 2026-10-03 21:03 | S5 effect clips | `styk-edit/src/vfx_clips.rs`: editing, trimming, deleting and reordering effect clips, group order, parameters set or keyed, keys toggled, moved, deleted and eased, the gizmo edit (previews, one entry on commit, cancelled by undo and redo), validated as `validateVfxClips` does against the engine's effect registry (cross-checked against the editor's: 22 types, every parameter's name, kind, default and range); compared in the app, not adopted. Adding, pasting and duplicating clips and effects (random identities and seeds), paints and connected scopes stay in the editor. The shadow driver now draws identities deterministically so runs with and without engine-owned editing compare. | 1 recording (66 steps) matches the editor at every step; 20 of 20 mutations break it. App shadow with the engine's `Math`, the driver adding a glow and editing it: start document 161/161; owned editing the same as the editor alone. |
| 2026-10-03 21:27 | S5 batches; an editor fix | `styk-edit` records `movieclipBatch` as the editor does (`beginBatch`, `endBatch`, `abortBatch`; one `movieclip-batch` entry, the revision before it, sources collected after it, a failed batch undone), and the facade opens and closes the session's batch around the editor's, so the timeline's batched edits stay in the session. Found by the batch recording: the editor's `_restoreSelection` moved the playhead without dropping the cached frame on show, so undoing a batch whose last step was at another frame lost the selection and showed a stale frame; fixed in the editor (the oracle) first. A 3D pose step measured natively (Vehicles, 105-bone figure): 0.19 ms, two thirds of it the figure's 3D geometry, as in the editor; 3D documents stay with the editor (D15). | 1 recording (18 steps) matches the editor at every step; 7 of 8 mutations break it (collecting sources after the batch is not distinguished: its entries keep theirs referenced). Every other recording re-records byte-identical with the editor fix; `npm test` 4347 passing, the 6 known failures. App shadow with the engine's `Math`: start document 164/164, the batched step no longer ends the session; owned editing the same as the editor alone. |
| 2026-10-03 21:42 | S5 the timeline's layer selection | `styk-edit` holds `_sheetSelection` as the editor does: `selectSheetLayer`, seeks selecting the chosen layer's figures on show, `keepSelectionOnSeek`, other selections dropping it, history restoring it; `setActiveLayer`. The facade hands it over with every call instead of keeping sessions off while a layer row is selected. | 1 recording (44 steps) matches the editor at every step; 8 of 8 mutations break it. App shadow with the engine's `Math`: start document 173/173, calls the engine did not see 10 → 5; owned editing the same as the editor alone. |
| 2026-10-03 22:15 | S5 the facade: branches and records changed in place | No engine session while a branch is selected (the editor's `deleteSelection` then deletes the branch, the engine's the figure), and the records the editor changes in place, as its change events name them, are resent to the mirror before the next session (a topology edit had left sessions posing the old pose arrays). | The driver's branch step (the deletion kept): without the guard owned editing diverged (45 history entries against 32); without the resend the owned run failed the editor's pose validation and shadow showed 3 differences. With both: shadow 173/173, calls the engine did not see 7, owned editing the same as the editor alone. |
| 2026-10-03 22:30 | S5 the figure clipboard | `styk-edit/src/figure_clipboard.rs`: `copySelection`, `cutSelection`, `pasteSelection` at the playhead (`insertionPlan`, `insert`, `_commitSheetRange` with new definitions published as the sheet's assets and removed by its undo) and `duplicateSelection`; paste and duplicate owned with the large figure class, adoption carrying the added definitions; a session pastes only the clipboard it copied. Movieclips, drawings, figures with effect clips and clipboards from another document or format version stay in the editor. The driver names drawn identities by first appearance when it compares runs. | 3 recordings (46 steps) match the editor at every step; 14 of 16 mutations break one (the others are equivalent where reachable: a join to a figure left out is dropped again when pasted, and a parent definition losing the node needs topology edits not ported yet). App shadow with the engine's `Math`: start document 182/182; owned editing (3 pastes and a duplicate adopted) the same as the editor alone. |
| 2026-10-03 22:43 | S4 export frames from the engine (agent, reviewed and merged) | Documents the engine draws export PNG, PNG and JPEG sequences, GIF, APNG and video frames from the stage's renderer in a worker with its own GPU device (`styk-export`: settings, 2,048-px tiles, the output view, pixel resolve, read-back slots; crisp edges in `styk-render`; `ExportFrames`; `ExportDevice`/`ExportRenderer`; `engine-export.mjs`, started while the export dialog is open). Fixed on the way: the mirror's commit waited on the interface thread and lost batches when the browser refused the wait (now it reports busy and the caller retries), progress waits that missed a wake-up, a page crash when cancelling an export, WebGL2 read-backs that never completed. SVG stays JavaScript. | Engine export frames equal the stage's at the same tick, every pixel, on 7 documents (21 frames). Impact, 240 frames at 1080p through the app: PNG sequence 16.4–18.6 s against 67.2–102.3 s, MP4 13.8–19.1 against 57.6–63.7 s; URIEL 3, 60 frames: 2.6–3.7 against 82.8–86.4 s. Ten aborted exports left no worker or memory behind; a cancelled export over an existing file left it unchanged. engine:test 273; npm test 4,357/4,390 (the 6 known failures); desktop export smoke 5/5 under xvfb. |
| 2026-10-03 22:57 | S5 project settings | `styk-edit/src/project.rs`: `setFPS` (with the frame delay format 4 stores), `setCanvasSize`, `updateProject`, one `fields` entry each; compared in the app. | 2 recordings (21 steps) match the editor at every step; 5 of 5 mutations break one. App shadow with the engine's `Math`: start document 188/188; owned editing the same as the editor alone. |
| 2026-10-03 23:12 | S5 importing figures | `importFigure` on the paste machinery (`styk-edit/src/figure_clipboard.rs`): a file's first frame or a single definition as new figures with new definitions, centred on its unjoined roots, joins named by slot kept, the first figure selected; owned with the large figure class. | 1 recording (11 steps) matches the editor at every step; 4 of 5 mutations break it (the fifth, the paste mode of an import, is equivalent: imported definitions are always new). App shadow with the engine's `Math`: start document 192/192; owned editing (the import adopted) the same as the editor alone. |
| 2026-10-03 23:29 | S5 layer parallax | `setLayerParallax` (`styk-edit/src/layers.rs`): a figure layer's response to camera travel, validated as `validateParallax`, one `layers` entry. | 2 recordings (17 steps) match the editor at every step; 3 of 3 mutations break one. App shadow with the engine's `Math`: start document 196/196; owned editing the same as the editor alone. |
| 2026-10-03 23:37 | S5 renaming movieclips | `renameMovieclip` with the `movieclip-definition` history entry (`styk-edit/src/movieclips.rs`); shadowed in the app. | 1 recording (12 steps) matches the editor at every step; 5 of 5 mutations break it. |
| 2026-10-03 23:49 | S5 movieclip playback on a frame | `setMovieclipPlayback` and `setMovieclipDrawing` on the frame on show with `validatePlayback` (`styk-edit/src/movieclips.rs`); shadowed in the app. | 2 recordings (27 steps) match the editor at every step; 6 of 6 mutations break one. |
| 2026-10-03 23:59 | S5 frames dragged between rows | `sheetTransferFrames` as one call (`styk-edit/src/sheet_clipboard.rs`): copy, clear when moving and paste in one batch, the clipboard left as it was; compared in the app. | 1 recording (11 steps) matches the editor at every step; 3 of 3 mutations break it. App shadow with the engine's `Math`: start document 198/198; owned editing the same as the editor alone. |
| 2026-10-04 00:38 | S5 Handle Edit Mode | `beginHandleEditDrag`, `editHandlePosition`, `commitHandleEditDrag`, `cancelHandleEditDrag` (`styk-edit/src/handle_edit.rs`, with `handleEditSegmentPose` on `styk-math`): a handle of the current pose moved with the arcs meeting it kept or bent from either end, figures joined at it moving with it, a gesture brought back to its start restoring what it moved; pinned limbs from their solved angles and stretched lengths; owned with the large figure class. | 7 recordings (94 steps) match the editor at every step; 13 of 13 mutations break one. App shadow with the engine's `Math`: start document 205/205; owned editing (3 handle moves and a commit adopted) the same as the editor alone. |
| 2026-10-04 00:44 | S6 the drawing raster engine (agent, reviewed and merged) | styk-drawing (tiles, brush model, stroke compositing, fill and wand, masks, filters, selection capture, transforms, reduced levels, PNG with a byte-exact deflate, tile blobs and the encode cache, undo chunks, clipboard) and styk-drawing-wasm, a separate non-threaded module per drawing worker (D17); the stroke, pixel and history workers and the brush model run it by default (`?drawingEngine=off`); an instance holding more than 256 MiB is replaced after a job. Publication now waits while an undo or redo is being prepared (it had been finishing inside the next one: blob assembly plus the stage's figure update). | 1,067 recorded checks identical; Node: fill 145→39 ms, wand 490→150, blur 995→407, publish 1,069 tiles 1,098→429; app, dense cel, back-to-back undo/redo 199/200 ms against JavaScript 222/306 (10 interleaved rounds; 1,011/1,226 before the fix); Electron: identical cels and blobs, files cross between engines pixel for pixel; job memory peaks higher (fills 40–68 MiB vs 16). |
| 2026-10-04 00:44 | S5 animated properties (agent, reviewed and merged) | `styk_eval::records` composes property channels as records (`records/channels.rs`, sharing `Channel::sample_at`) for a sheet's `legacyAnimation`, `_styk.animation` and the one-key channels of property edits; Bézier `t ** 3` through the platform's `pow`. `styk-edit/src/property_edit.rs`: `addAnimationKeys`, the sheet branches of begin/preview/commit/cancelAnimationEdit, `setSceneColor`, `setSceneBackground`, `setBackgroundColor`, `updateFigureStyle`, `updatePolygon` opacity, `setVfxParameter`; the session holds scrub previews and the app compares them. Documents with `legacyAnimation` are edited by the engine (a pose-slot bug fixed on the way), as class `channels`, not owned by default. | Records: 26 channel and property fixtures, 458 ticks identical, each failing without its channels; 1,265/1,265 overall. Replays: 17 recordings, 303 steps match; mutations: records 6 caught and 3 equivalent, commands 13 of 14 (1 equivalent), a wrong preview caught in the app, the geometry step 2 of 2. App with the engine's `Math`: start document 227/227, owned the same as the editor alone; channels-figure 200/200, owned the same; channels-pose 152/152; channels-vfx 184/184. |
| 2026-10-04 01:13 | S5 whole figures by a handle | `beginFigureHandleDrag`, `transformFigureHandle`, `commitFigureHandleDrag`, `cancelFigureHandleDrag` (`styk-edit/src/figure_transform.rs`): the selected figures and those joined below them turned and scaled about the dragged figure's origin, turns past a half turn accumulated, Ctrl and Shift locks, restored at the start; owned with the large figure class (the editor's turn count kept up on adoption). | 3 recordings (68 steps) match the editor at every step; 10 of 12 mutations break one (the other two are equivalent on recorded documents: restoring rather than recomputing a figure back at its start differs only with `runtime_segments`, and a hole in an angle list never survives loading). App shadow with the engine's `Math`: start document 241/241; owned editing the same as the editor alone. |
| 2026-10-04 02:08 | S5 handle commands | `styk-edit/src/handle_commands.rs`: `nudgeHandle` (screen pixels through the view's zoom, rotation and mirroring and the frame's camera, onto moving, posing, bending, Handle Edit Mode or the whole-figure transform), `alignHandle`, `locateEditedHandle`, `segmentValues`, `beginSegmentValueEdit`, `setSegmentValues` (relative to the incoming tangent through joined origins), `copySegmentValues`, `pasteSegmentValues`; segments as drawn shared with Handle Edit Mode (`drawn_segments`). Follow clips and camera motion active at the playhead stay with the editor (the engine's records do not carry the editor's runtime camera tick; the playhead's is used). Copied text is compared as a view. | 5 recordings (186 steps) match the editor at every step; 28 of 30 mutations break one (two equivalent: pasted lengths are checked again by `setSegmentValues`, and the arc end's `(bend × steps) / steps` never differs from the bend on recorded values). App shadow with the engine's `Math`: start document 256/256, channels-figure 212/212; owned editing the same as the editor alone. |
| 2026-10-04 02:41 | S5 camera commands | `styk-edit/src/camera_commands.rs` on a layer sheet: `copyCamera`, `pasteCamera`, `setCameraValues`, `resetCamera`, `transformCamera`, `alignCameraToView`, `locateCamera` (changed values keyed through `addAnimationKeys`), camera drags with their preview as the frame on show (`commitDrag`/`cancelDrag` route to them; other calls during one stay with the editor), `locateHandle`; owned with the large figure class, drag previews compared. `centerCamera`, `applyCameraToFigures` and native-timeline camera snapshots stay JavaScript. | 1 recording (67 steps) matches the editor at every step; 16 of 16 mutations break it. App shadow with the engine's `Math`: start document 269/269, channels-figure 225/225; owned editing the same as the editor alone (the start document's camera calls cost 0.6–0.9 ms in the editor, 1.0–3.8 ms owned with adoption). |
| 2026-10-04 03:32 | S5 movieclips on the timeline | Moving and copying a movieclip's keys (`sheetMoveFrames`: clips on the document's clock shift their span and restarts, `shiftClipTime`); timeline frames holding clips on the presence clock copied with their phases (`presence_elapsed` exposed by `styk-eval`) and pasted under new identities that carry on from there, continuations included; moving them to another row leaves continuations on the source (`Retain moved movieclip phase`). | 3 recordings (35 steps) match the editor at every step; 8 of 9 mutations break one (the span shift is equivalent for presence-clock clips, which keep their span). App: the movieclip document's shadow lost its three timeline gaps (property edits on keys with clip replacements and pasting clip instances remain); owned editing the same as the editor alone, 143.2 ms against 207.8 ms. |
| 2026-10-04 03:42 | S5 property edits on keys with movieclip replacements | A property edit on a key whose movieclip frames are replaced keeps the replacements and writes the key's pose from the frame without them (`Records::evaluated_options(tick, clips, skip_patches)` in `styk-eval`, `at(…, {skipMovieclipPatches: true})`). | 1 recording (11 steps) matches the editor at every step; 4 of 4 mutations break it. |
| 2026-10-04 04:06 | S5 figures across frames, figure order, branch flips, recolouring (agent, reviewed and merged) | `styk-edit/src/range.rs`, `range_plan.rs`: `applyFigureRange` and `planFigureFrameOperation` (appearance, order with depths at ±1,000,000, join, detach, delete, duplicate, reset, centre, scale, rotate, flips, branch flips) at the playhead or across a range, committed as one `_commitSheetRange` (generalised to several ticks) or as a native `figure-range` entry; `moveSelectionInFrames`, `bringToFront`, `sendToBack`, `moveSelectionLayer`, `orderSelection`, `mirrorFigure`. `styk-edit/src/recolor.rs`: `editFigureColors`, `setFigureColor`, `replaceFigureColor`, `resetFigureColors` and a polygon's colour. Owned with the large figure class. Found while porting: the app's timeline ranges lost their ticks across JSON (owned `setSceneColor` with a range selected keyed the playhead only); fixed in the facade (`{"@array", "sheetTicks"}`). | 18 recordings (427 steps) match at every step, `transform-native` now 21 of 21; mutations 88 of 92 caught (4 equivalent or indistinguishable). App with the engine's `Math` (agent's runs): start document 270/270, `channels-figure` 236/236, the colours document 271/271; owned editing the same as the editor alone. |
| 2026-10-04 04:43 | S5 the camera baked into the figures | `applyCameraToFigures` on a layer sheet (`applyAuthoredCameraToFigures`, `styk-edit/src/camera_commands.rs`): per chosen frame, each figure keyed where the camera shows it (root through the inverse camera matrix with `styk-math`, scale, rotation) and the camera keyed back to the identity; the camera lookup shared with handle nudges (`effective_camera`, `camera_linear`). | 1 recording (17 steps) matches the editor at every step; 7 of 7 mutations break it. App shadow with the engine's `Math`: start document 307/307; owned editing the same as the editor alone. |
| 2026-10-04 04:47 | S3 item 6 / S4 thumbnails, library previews, camera monitor (agent, reviewed and merged) | Frame thumbnails of documents the engine draws are drawn on the stage's WebGPU device (`styk_engine::thumbnails::card`, `styk_wasm::views`, `src/engine/engine-thumbnails.mjs`): frames prepared on workers by an `ExportFrames` pinned to the revision (`ready` only on the interface thread, D7), a second renderer sharing the sprite atlas (`Renderer::share_sprites`). Library posters and hover animations come from one GPU preview worker (`styk_engine::thumbnails::library`, `styk_wasm::preview`; bounds from `artwork_bounds` with effect padding and `Batch::bounds`). The camera monitor is drawn by `Stage::render_monitor`. SVG export stays JavaScript (editable vectors, not the draw list). JavaScript fallback for in-between previews, refused documents, WebGL2 stages and canvases failing a pixel probe. The JavaScript worker's parallax fixed first. styk-raster: cel tiles without seams; not used (3 AA levels, no filter effects, z-fight). | Thumbnails vs engine export frames 121/121 (89 identical); vs JavaScript worker 10/12/1 of 43 at 320×192/512×288/96×54 (text, 3D rasters, Canvas 2D seams by the mean); library mattes 12/12 the same; monitor 1/6. Bamboo 48 thumbnails 334–362 ms vs 6.5–11.3 s; first thumbnail 2–9 ms vs 0.65–3.2 s; library poster 11–34 ms vs 0.69–0.91 s; monitor 0.5 ms vs 19–127 ms on the interface thread (load 18–27). engine:test 295, engine:parity ok, npm test 6 known failures (agent's runs). |
| 2026-10-04 05:02 | S5 the engine owns 3D documents (D15) | `3d` joins `OWNED_CLASSES` (`src/engine/engine-edit-shadow.mjs`): the shadow driver's 3D commands and gestures are all ported, and owned editing is identical to the editor's and cheaper on every 3D document measured. The shadow driver notes steps a document refuses instead of stopping (Kung-Fu Master refuses deleting the joint that carries its mesh). | `--own --warm --exact-math`: planted leg 101.5 ms against 217.6, Kung-Fu Master 228.9 against 510.1, Hand-Right 480.3 against 513.4, each the same as the editor alone; Kung-Fu Master shadow 189/190 (one `setNodeIK` outside the frame not ported). The app's default (`--own --default --exact-math`): planted leg 134 calls owned, 396.2 against 417.0 ms; Hand-Right 111 owned, 184.7 against 400.2 ms; joined-chain (`figures`) none owned. With the browser's own `Math`, one owned 3D angle differed from the editor's by 4.6e-6 rad (D16). |
| 2026-10-04 05:58 | S5 movieclip instances pasted, deleted and changed across frames | The figure clipboard pastes movieclip instances (definitions shared unless unique, `movieclipSamples`, an instance pasted where it is not on show keeping its identity, others on the presence clock from their start, `snapshotFigureDefinition`); movieclips alone are inserted as frame replacements of their own (`replaceAt`, `createFrame` in `styk-edit/src/sheet.rs`) and a pasted movieclip keys the playhead; deleting a movieclip instance (`sheetDeleteFigures`) and range deletions with movieclips leave replacements by nothing; range duplicates restart movieclips on the presence clock; range operations on movieclips run on layer sheets. | 2 recordings (61 steps) match the editor at every step; 16 of 16 mutations break one. App: the movieclip documents' shadow 229/229 (nothing left unported); owned the same as the editor alone but costlier on these small documents (433.9 against 299.4 ms), so `movieclips` stays with the editor; start document 307/307. |
| 2026-10-04 06:26 | S5 movieclip playback across every frame | `setMovieclipPlayback(patch, {allFrames: true})` for clips on the presence clock (`sheetSetMovieclipPlayback`, `styk-edit/src/movieclips.rs`): every key of the clip's layer rewritten from the frame without its replacements (which it keeps), every replacement holding the clip recaptured; `restartMovieclip` and `removeMovieclipRestart` through it. Clips on the document's clock stay with the editor there. | 1 recording (27 steps) matches the editor at every step; 5 of 6 mutations break it (the restart's rounding of the playhead is unreachable in ported paths: presence clips refuse restarts). App shadow with the engine's `Math`: the movieclip document 241/241, start document 307/307. |
| 2026-10-04 06:57 | S5 commands that draw identities (D18); camera motion clips added | `src/editor-draws.mjs` and the draws protocol (recorder, replay, session view, facade); `styk-edit/src/camera_motion.rs`: `addCameraMotion` (`createCameraMotion`, each preset, a follow clip following the selection), `copyCameraMotion`, `pasteCameraMotion`, `duplicateCameraMotion`, `randomizeCameraMotion` with the editor's identities and seeds. | 2 recordings (34 steps) match the editor at every step, draws included; 7 of 7 mutations break one. App shadow with the engine's `Math`: start document 317/317 (the five calls handed the editor's draws); owned editing the same as the editor alone. |
| 2026-10-04 07:30 | S5 effect stacks | `styk-edit/src/vfx_stack.rs`: `addVfx`, `removeVfx`, `resetVfx`, `duplicateVfx`, `moveVfx`, `reorderVfx`, `pasteVfx` on figures, segments and the scene (new identities from the editor, D18; which effects the scene takes, `Kind::on_scene`, in the `styk-eval` registry); `setVfxParameter` shares their target checks. Presets, `setVfxScope` and pasting with attached parts stay JavaScript. | 1 recording (31 steps) matches the editor at every step; 9 of 9 mutations break it. App shadow with the engine's `Math`: start document 324/324, channels-figure 279/279; owned editing the same as the editor alone. |
| 2026-10-04 08:00 | S5 effect clips added, copied and pasted | `styk-edit/src/vfx_clips.rs`: `addVfxClip` (generated effects timed at the playhead, `GENERATOR_DURATIONS`), `copyVfxClip` (effects sampled between number and colour keys), `pasteVfxClip` (keys or values), `duplicateVfxClip`, `addVfxGroupEffect`; `src/editor-vfx-clips.mjs` draws its identities and seeds through `editorDraws` (D18). Presets stay JavaScript. | 1 recording (40 steps) matches the editor at every step; 12 of 14 mutations break it (the other two are equivalent here: effect identities are unique, the at-key guard matters only for paint colours). App shadow with the engine's `Math`: start document 336/336, the new calls among them; owned editing the same as the editor alone. |
| 2026-10-04 08:40 | S3 item 7: the CPU rasterizer | `styk-raster` draws as `styk-render` does: four-sample edges blended per sample, the GPU's depth rules (24-bit), glyph masks, every effect pass from the recipes `styk-render` records (`effects/recipe.rs`; `styk-render`'s `gpu` feature leaves the shared arithmetic without wgpu). Thumbnails and library previews where the stage cannot draw them and exports without a GPU device are drawn on the CPU in their workers (`?engineCpu=on` forces it). `styk raster-parity` compares it with the GPU. | Parity in section 7 (thumbnails 899/899 at three sizes, exports 677/677, deep 3D 1,244/1,244 thumbnails). Native timings against the tiny-skia renderer, machine load 9–12: 15 Guns export frame 386–578 → 95–101 ms, Impact 219–235 → 79–126 ms; slower where effects and multisampling are now drawn (section 6). In the app, CPU thumbnails 8.9–27.7 ms at 320×192 against 2.3–3.8 ms on the GPU. WebAssembly module +109 KiB (8,092,410 bytes). |
| 2026-10-04 09:30 | S5 builder and rig family | `styk-edit/src/builder.rs` (segment styles, branch caps and fill, polygon opacity, figure name and outline, drawing order keyed after a live preview or written into the definition), `rig_behavior.rs` (rig validation as `rigConstraintPlan`, `setRigBehavior`, Smart Stretch, stretch bindings, angle lock, secondary angle reference), `topology.rs` (add, delete, mirror, move, split, duplicate segments; rig joints, connectors and weighted joints; `replaceFigureDefinition`; topology history with its repair, validation and rollback), `rig_drag.rs` (Rig tool drags). JavaScript fix: moving a segment in the builder repacks every pose in the new order. | 22 recordings (734 steps) match the editor at every step; 98 of 101 mutations break them (3 equivalent). App shadow with the engine's `Math`: start document 395/395, `rig.document.json` 319 the same, channels-figure 260/260; owned editing the same as the editor alone on all three. Engine and adoption against the editor alone: `moveBuilderOrder` ×3 3.8 + 5.6 ms against 9.1 ms, `setBuilderOrder` 1.1 + 1.4 against 4.4 ms. |
| 2026-10-04 10:05 | S5 app sessions replayed natively; IK settings on any figure | `?engineEditCapture=on` keeps each edit session's starting document and calls; `scripts/engine-edit-shadow.mjs --capture <folder>` saves the sessions that meet a refusal, a difference or another error, and `styk edit-session` replays them in `styk-edit`. The first refusal found with it: configuring IK on a figure after the first captured the limb from the native keyframe instead of the frame on show (`styk-edit/src/spatial_ik.rs`). | `ik-settings-second-figure-sheet` (17 steps) matches the editor at every step and refuses at step 4 without the fix. App owned run with `--warm` and the engine's `Math`: `setNodeIK` no longer refused; the same as the editor alone. |
| 2026-10-04 10:40 | S5 the editor's camera under camera motion | `styk_eval::camera::impulse` and `moved` compute `sampleCameraMotion` and `cameraAtTime` with V8's `Math` in the editor's order of operations (`styk-math` gains `log1p`, fdlibm's as V8 has it: the `libm` crate's musl rewrite differed for 17 of 12,129 inputs; seeds wrap as ToInt32); `styk-edit` composes the editor's camera from them, so handle nudges and baking the camera no longer refuse frames a motion clip moves. Follow clips still refuse. | `camera-motion-handles-sheet` (37 steps, every preset, overlapping clips, muted ranges, a seed at the top of its range, a bake over 61 frames) matches the editor at every step; the muted-range, frame-rate and seed mutants break it; 8 last-bit mutants (platform functions, radians in another order) cannot show there because the baked camera reaches the document through single-precision pose fields, and `styk-math`'s tests pin the functions (12,129 `log1p` inputs bit for bit). |
| 2026-10-04 10:50 | S5 motion paths; S3 a still frame redrawn once its pictures arrive | Merged: `styk-edit/src/motion_path.rs` (motion-path edits on a layer sheet: origins, joints, IK targets, movieclip instances, the camera, falloffs of each shape; pointer moves compared in the app, the commit owned), and the stage's picture wait (`styk_engine::Uploaded`, `Stage::pictures_pending`, `waitForPictures` in `src/engine/engine-stage.mjs`: a frame drawn while its pictures decode is drawn once more when they arrive, through `Atomics.waitAsync`, at most a minute); `scripts/engine-app-parity.mjs --electron-arg`. | Motion paths: 14 recordings (370 steps) match at every step, 16 of 18 mutations break them (one more only the weights test, one unreachable); shadow with the engine's `Math` 392/392, owned the same as the editor alone. Pictures: URIEL 3 opened at ticks 44 and 45, 23,783 and 21,232 solid pixels before, both pass after (mean 0.009, 0.091); 9–13 extra frames within the first 1.3 s (load 13–19). |
| 2026-10-04 11:34 | S3 drawing cels under effects (handoff reviewed and completed for Electron) | Parent atlas rows remain intact through translation; exact density selection, two-texel neighbour borders and Canvas minification/Mitchell enlargement are shared by GPU and CPU. Existing decode work derives tight alpha bounds; bounded stage/export queues reject stale preparation through a cache epoch. App captures wait for live artwork and refinement. Platform-neutral API changes for a mobile pin: `DrawingTiles` adds `bounds`, `decoded_bounds`, `artwork_bounds()`; `Placement` adds `canvas`; drawing `BORDER=2` makes slots 68×68 (+6.2% bytes), sprites unchanged. Engine wasm 8,591 KiB, +24 KiB from takeover. | 342 Rust tests; full parity including 201 byte-stable command recordings and 441 containers; check clean, npm test six known failures. Electron synthetic 4/4 + private 5/5; native private thumbnails 132/132 + synthetic smooth 4/4. Stable software web synthetic fails 0/4; private web settle timeout and pre-existing crisp export remain open. Final microbenchmark attempts at load 10.27–12.77 were too variable to interpret; no performance claim, idle engine-1 still pending. |
| 2026-10-04 12:03 | S5 animation-origin records, whole figures and topology | `styk_eval::records` shares typed origin arithmetic at exact/fractional keys and scalar previews while preserving raw keys, unknown fields and COW nodes. `styk-edit::origin` synchronizes pivots/offsets/ghosts through gestures; `origin_topology` reroots and repairs/compacts support and joined poses through recorded construction edits. The typed compiler validates raw support before a live gesture can commit. `setOrigin` enters the shadow topology facade; no adoption/class flip. No public crate signatures or fields changed; stricter malformed-support refusal is portable. Engine wasm 8,705 KiB, +114 KiB from cel milestone. | 353 Rust tests and check pass; npm test retains 4,378 pass/6 known failures/26 skip/1 todo. Fifteen origin record groups (466 ticks/4,112 values), 21 new recordings (1,285 steps), four source mutants caught; 68 malformed descriptors/136 atomic refusals. All 222 recordings and 1,000 existing fixture hashes stable. App shadow 47 exact incl. Set Origin/history; prior forced prerequisite 6 adopted+32 exact, full undo identical. Electron/web pictures 6/6 each. Full repository parity passed on the committed snapshot: all fixture generators, 222 recordings and 441 containers; remaining origin families stay gated. |

| 2026-10-04 12:54 | S5 origin joints, handles and saved transform channels | Shared typed origin synchronization preserves retained ghosts through posing and both handle gesture owners. Saved x/y/scale/rotation channel edits compare stored and shown poses; admission inspects actual future key targets and attachment ancestors before changing live state. The app driver requires requested calls and exact numeric equality. Public crate API unchanged; engine wasm 8,713 KiB (+8 KiB). No class flip or deletion. | 365 Rust tests, build and check pass; 24 new recordings/2,770 exact steps, all 246 replays and 1,097 fixture hashes stable; six actual source mutants caught. Atomic refusals cover 99 complex poses, 40 invalid previews and 14 future/malformed target cases. App shadow 142 exact; forced ownership 67 adopted+75 exact, identical document/79 history entries/selection/full undo. Edited pictures web 12/12 and Electron 12/12. Full repository parity follows on the committed snapshot. |
| 2026-10-04 13:22 | S5 complete the origin pose/channel fixture set | Include the 54 evaluated-record JSON generated from the previous milestone’s new scenarios. The first full parity run exposed their omission from `e5bb439f`; production source, crate API and eligibility are unchanged. Root preparation is isolated in `engine-root-integration`. | The exact Rust record suite passes all 179 groups / 2,225 ticks with zero unported ticks; all 373 record JSON regenerate byte-stable. The preceding full run passed Rust suites, command regeneration and 441 containers; its only failure was the missing files. Complete parity passed on this committed fixture set: all generators, 246 command recordings and 441 containers. |
| 2026-10-04 14:01 | S5 compact owned session responses | Session view `changesOnly` returns changed COW draft/retained figures, sheet fields, explicit order/removal and retained metadata; adopted result views are not duplicated. Full shadow/native responses remain default. Public Rust signatures unchanged; additive JSON protocol, portable/mobile pin note. User focused-merge/checkpoint verification policy recorded in handoff. | 18 recorded families / 483 native reconstruction calls and 18 JavaScript adoption tests pass. Root 367 Rust tests, wasm build (8,724 KiB), check (1,982 files) and full parity/246 recordings/441 containers pass. Origin app 62 adopted + 65 exact, 730,987-byte document/79 entries/full undo identical; startup retry 165 adopted + 295 exact, 290,105-byte document/80 entries/full undo identical, no rounding/differences/page errors. Earlier startup browser crash has no result; no class flip or performance claim. |

| 2026-10-04 14:05 | Preserve release test cache through regeneration | Origin atomic-refusal unit tests read their identical editor-built fixtures at runtime instead of embedding regenerated JSON into the test binary. No production behavior, crate API, parity profile, threshold or gate change. | Cargo fingerprint proves the original mtime trigger; two affected tests pass. Actual guard-fixture regeneration changes no tracked bytes, then the release unit build is fresh in 0.05 s with both tests passing (previous redundant rebuild 65 s). npm check passes; full parity is reserved for checkpoints under the new policy. |

| 2026-10-04 14:38 | S5 camera, measured bounds and remaining builder prerequisites | V8-exact follow logarithms and cached native follow reads/bakes; joined spatial IK, branch thickness, native-property tokens, sprite insertion and library/new-figure history match recorded native/sheet commands. Measured app bounds cross the shadow boundary once. Fix joined pinned motion-path errors and atomic identity-capacity refusal in the editor oracle. Mobile pin API additions: `styk_math::log`, `Prepared::travel_ready`, `Pose::shot`, `CommandKind::FigureSplice`; browser-only `math_log` stays in `styk-wasm`. Engine wasm 8,845 KiB (+121 KiB). | 393 Rust tests, 43 affected JS tests, build and check (1,986 files) pass; 140 fixture inputs and 49 recordings regenerate unchanged. The 45 admitted recordings match 1,290 steps; four origin/native-channel guards remain explicit. Include 82 derived JSON / 41 groups / 362 exact ticks. App: joined paths 1 adopted + 11 exact, bounds 8 exact, capacity 2 exact; document/history/selection/full undo preserved. Electron stored/preview/onion pictures 9/9, mean 0.0553–0.0884, zero solids. Strict follow adoption remains open at cold revision/tick D7 guards; broad software driver stopped without a result. No class flip, deletion or performance claim. Log fixture regeneration leaves release test fresh in 0.04 s. |

| 2026-10-04 15:27 | S5 origin ranges, joins and constrained rigs; native query prerequisites | Origin range/join/2D rig synchronization and strict nested validation preserve live gestures, raw support and history. Borrowed handle/body/snapping/marquee queries and existing movieclip scene cache reservations share one prepared geometry owner. Fix fractional inspector reads while keyframe writes/begins remain whole-tick. Mobile pin API: `CommandKind::Frame`, `rig::validate_2d`, public picking/`RawSegment`/`SceneBudget`, scene-budget and prepared-geometry fields/methods (details above). Engine wasm 8,881 KiB (+36 KiB). No document-class flip, deletion or adoption claim. | Shared-type workspace validation 431 Rust tests; final focused edit/eval 178 tests and 137 JS tests pass, check 1,987 files. All 93 affected recordings match 12,050 steps, including 63 new / 9,764; regeneration is byte-stable for these recordings, 190 origin inputs, 66 picking inputs and 22 bounds inputs. Add 126 evaluated JSON / 63 groups / 647 ticks. App range 14 and rig 10 exact calls, no page errors. Electron 12/12 and default software web 12/12 pictures pass, zero solids. Fractional preview 3.5 is incorrectly prepared as tick 3; hardware-opt-in web captures an empty canvas. Both failures remain open with evidence. Runtime fixture reads keep regenerated edit/eval test targets fresh (0.11 s debug). |

| 2026-10-04 15:43 | S5 remaining effect commands and typed session/query prerequisites | Strict paint validation and existing gradient interpolation, all 13 built-in presets, user-preset key remapping and D18 draws, attached scope depth/boundaries. Add one typed Session response entry and borrowed closest-joint ordering; mobile APIs noted above. Identical embedded production catalogue regeneration preserves mtime. Engine wasm 8,904 KiB (+23 KiB). No ownership/class gate, deletion or performance claim. | 183 touched-crate Rust tests, 103 focused JS tests, check and Wasm build pass. All 27 affected replays / 898 steps match; 12 new / 392 steps, 25 VFX JSON and 44 joint inputs regenerate unchanged. App 19 exact; forced paint adoption 1 + 18 exact, identical 14,533-byte document, six history entries, selection and full undo, no page errors. Session typed/JSON 830 calls and actual closest-joint 201,792 queries match. Initial malformed app-driver preset corrected; unnecessary native whole-workspace attempt exposes browser-only Canvas target errors, scoped/native and Wasm checks pass. Full parity reserved for committed checkpoints. |

Work is active in the isolated lanes listed in the handoff. Frozen uncommitted snapshots
are review inputs, not completed milestones or class ownership evidence.

| 2026-10-04 17:05 | S3/S5 recorded worker movieclips, history, canonical publication and fractional rendering | Integrate reviewed renderer and movie/layer/history/selection owners, bounded native/sheet planning, canonical COW root admission/paired publication with terminal-ACK retirement, exact displaced-generation cleanup, native scalar authoring and recorded origin sheet motion. Preserve retained movieclip/VFX source clocks and one checked SheetPlan/history owner. Fix atomic insertion/capacity refusal and bounded new-ID selection exchange in the editor/facade. Portable mobile API changes: checked Engine stage/layer/publication APIs, opaque admission and prepared/guarded editor publication, history limits/checkpoints, selection/motion accessors, retained source/effect fields; FrameData.tick is f64 and PlanError::Unported carries String (details in editing/threading). Wasm 9,528 KiB (+624 KiB). No class gate or deletion. | 615 shared-type native tests, final seven planner unit tests, 307 focused JS tests, check/changelog and shipping Wasm pass. All 3,153 affected JSON stay stable; 88 new evaluated groups / 798 ticks (371 / 4,032 total). CLI 75 new admitted tapes / 6,446 exact steps + 64 worker tapes / 643 steps; 16 guards remain explicit, 461 ordinary tapes total. Software stored/fractional preview 4/4, zero solids; actual duplicate/paste 3 adopted + 6 exact, same 22,810-byte document / six history entries / selection / full undo. Broad app run stalled without result; wrong alias and empty-focus attempts retained. Independent full source reviews and actual source mutants retained. Full committed 53e3bdd9 checkpoint green (421 tests / 358 containers); complete post-regeneration release target fresh in 0.43 s, cold isolated first run 2,297.5 s. Next checkpoint no earlier than 17:54 CEST; no performance claim. |

| 2026-10-04 17:20 | S5 recorded native origin motion and exact row-splice history | Five no-channel native remote-time origin families reuse the checked frame/membership/attached-layer/history owners. Keep native one-tick shown poses held and raw samples distinct in the existing bounded cache, with scalar channels on the fractional clock. Portable mobile API additions: FrameSlice, CommandKind::Ranges (exhaustive matches need updating), Records::evaluated_editor_with. Wasm 9,582 KiB (+54 KiB). No app gate, adoption change, deletion or performance claim. | Shared-type checks: 623 native tests; 79 focused JS tests, check and shipping Wasm pass. All 65 motion JSON regenerate byte-stable. Thirty admitted affected CLI tapes / 5,799 exact steps include five new native admissions / 969 steps; 11 explicit guards remain. Actual worker weights and enumerable history match 22 editor commands; five raw/shown fractional cases preserve scalar x=635 at tick 3.5. Initial cfgtest private-field access corrected through the existing history summary, no public test helper added. Independent source review passes; full suite remains reserved for committed checkpoints. |

| 2026-10-04 17:38 | S3 destination-grid drawing-cel correction | Integrate the independently reviewed 18-path freeze through the existing drawing entry, placement/filter, Raster and Renderer owners. Explicit destination grid for direct software edits/previews; world grid remains default for prepared/GPU paths. Single-child drawing clips retain child/outer effects; multiple-child entries keep existing policy. Mobile pin additions: LayerKind::Entry.single_drawing, DrawingGrid, plan_with_grid and Renderer/Raster grid setters (rendering.md). Wasm 9,584 KiB (+2 KiB). No class gate, deletion or performance claim. | Shared-type checks pass 632 native tests, 31 focused JS tests, check and shipping Wasm. Two editor-built fixtures regenerate byte-stable; actual eligibility/plan source mutations are caught. Final main software-web original cel 4/4 and default Electron GPU 4/4 pass, zero solids; all four Legacy web and default GPU engine RGBA captures remain byte-identical. Dense single-child and serialized child-Blur/outer-Tint each pass 1/1. Auxiliary onion .288346 and edit-monitor .714171 remain failed; an actual empty-background monitor isolates 278 fractional clip/paint border pixels independently. Source audit records remaining D7/UI and stale-ticket paths; broad figures retry makes progress through one warm-up round then times out at 180 s without comparison. Full suite reserved for committed checkpoints. Logs: tmp/root-verification-temp/cel-destination-*. |

| 2026-10-04 18:16 | S3 prepared generation/epoch/sample tickets and retained actual monitor frame | Bind existing cached frames and metadata coherently to one generation/cache epoch, validate again at native drawing, and advance only the successful scalar shown head. Prepared monitor workers refuse newer hidden/effect/resource sources and retain the accepted same-view bitmap while cold. Preserve explicit worker wait results after immediate cache eviction. Portable pin additions: FrameSnapshot; Engine prepared_frame/frame_matches/frame_epoch_current/prepared_frame_now_at; MonitorFrame prepared_ticket. Browser-only ticket/getter exports stay in styk-wasm. Wasm 9,588 KiB (+4 KiB), SHA d155ab99b159. No class gate, deletion or performance claim. | 140 owning-engine tests, 35 focused playback/stage/preview JS tests, check/changelog and final shipping build pass. Four actual-source mutants fail and restore hash-exact. Independent review identifies and closes the tiny-cache wait compatibility regression before commit. Final actual app verifies generation and hidden/effect epochs, six malformed keys and three native-boundary/cold refusals, unchanged actual shown surface/ownership/document/history/selection, and retained worker-monitor pixels. Original software-web stored/preview ticks 3 and 3.5 pass 4/4 (means .017812–.044503); default Electron GPU passes 4/4 (.032218–.034970), zero solids and unchanged D13. Initial one-shot driver requests were displaced by normal UI prefetch; successful driver follows existing repeated bounded request protocol, without synchronous preparation. Full checkpoint continues on committed 9728e86e in its persistent target. Broader live-readiness/State/retirement D7 and auxiliary pixel gaps remain open. Logs: tmp/root-verification-temp/prepared-ticket-*. |

| 2026-10-04 18:31 | S5 recorded saved-native origin motion | Extend the existing native Draft/channel/source/history owners for the two previously recorded saved-origin motion families. Live scalar order remains transient; repeated writes reuse source IDs, with canonical registration at commit. Authoritative and motion display reads remain separate worker prerequisites. Portable pin addition: Records::new_native_draft. Wasm 9,604 KiB (+16 KiB), SHA e06a24b83579. No app adoption, class gate, deletion or performance claim. | Independently reviewed 16-path freeze; 286 touched edit/eval tests, 92 focused JS tests, check and shipping build pass. All 67 affected JSON regenerate byte-stable. CLI admits 32 affected tapes / 6,165 exact steps, including the two saved tapes / 366 calls, and retains nine explicit guards. Fourteen affected capture tapes / 138 steps and 19 worker insertion tapes / 153 steps also match. Actual 42 draft displays, 122 lifecycle states and eight enumerable Animation commands certify ordering/registration/retention; four real lane mutants fail and restore. Initial owning-crate run catches an obsolete select-refusal expectation; remove only the newly recorded selection refusal, preserving all five unrecorded mutator/atomicity checks, and rerun the full touched crates green. Full checkpoint remains active on immutable 9728e86e. Logs: tmp/root-verification-temp/saved-native-*. |

| 2026-10-04 19:02 | S5 awaited worker Bake and canonical history/record observation | Integrate independently reviewed 173-path canonical and 14-path TOP freezes with three reviewed adaptations preserving saved-native sources and current generator lists. Bake reuses Records/materializer, plural expansion, native capture and checked SheetPlan/history owners; optional replay record capture is disabled on normal calls. Portable pin changes: CommandKind::LayerSheet.retain_geometry, styk_eval::vfx::remap_owner and replay_worker_with_source_budget. Wasm 9,701 KiB (+97 KiB), SHA 055ecc07c3d8. No app adoption, class gate, deletion or performance claim. | Shared-type validation passes 659 native tests and 194 focused JS tests. Final corrective slice passes 153 owning edit tests, check, 159 JSON artifacts regenerated twice byte-stable and the same shipping Wasm bytes. CLI default 37 families/234 exact calls, Frame/Ranges observer 27, native VFX reads 24, original remappers 16, separate explicit 1 GiB object-limit 4; default/runtime source allowance remains 128 MiB. Final native/sheet remapped-effect stored/preview pictures pass software web 4/4 mean .017499 and default Electron GPU 4/4 mean .024497, zero solids, unchanged D13. Final CLI initially disproves stale-refusal lane claim: step 2 actually differs. Preserve failed evidence; add actual yield-time rename metadata and generic pre-dispatch capability refusal, with all original 159 JSON fields preserved and a failing-before regression plus independent review. Stale trace now 1/4 then explicitly unported at step 2; actor/yield parity remains open. Full checkpoint continues on immutable 9728e86e. Logs: tmp/root-verification-temp/canonical-bake-*. |

| 2026-10-04 19:30 | S5 recorded origin angle-lock definitions and spatial choices | Integrate independently reviewed angle45/spatial80 freezes as one focused batch, preserving canonical Bake/history/source changes with two reviewed dispatch/validator adaptations. Same typed origin, raw definition, choice, support and history owners; figure/parent posing, multiple spatial instances and unrecorded native-projection/complex metadata remain refused. No public crate API or mobile pin signature change. Wasm 9,717 KiB (+16 KiB), SHA b743a015efd0. No app adoption, class gate, deletion or performance claim. | 163 owning edit tests, two records tests, 134 focused JS tests plus one skip, check (1,996 files/7,010 messages) and shipping build pass. CLI 97 affected admitted tapes/11,029 exact steps, including 37 new/4,882 steps; all 37 derived groups/357 ticks match. All 186 JSON regenerate twice byte-stable. Six actual lane source mutants fail and restore; 42 angle and 57 choice atomic guards, schema five accepted/26 rejected loads. Existing labels/flags/undo-redo and shown frames are covered, full enumerable history/new returns remain separate. Full committed 9728e86e checkpoint green: 47 stages, 615 release-selection tests and 358 containers; all 127 release test executables fresh after regeneration in 0.22 s. Next regular no earlier than 19:54 CEST. Logs: tmp/root-verification-temp/origin-constraints-choice-*. |

| 2026-10-04 19:55 | S3/S5 nonblocking cache, quiet canonical actor and exclusive live Session foundation | Integrate independently reviewed cache, quiet-actor and portable-live freezes with reviewed shared-owner adaptations. One Storage/cache owner; one-shot UI readiness/admission; dense cache work outside State; same finite progress owner for coalesced Busy retries. The quiet Core pairs editor/mirror publication and worker retirement; portable live capability consumes the same Session and guards actual working displays with a private epoch. Close inherited expiry/input defects and no-progress/Ready-Busy cancellation regressions before integration. Mobile API additions in editing/threading; browser bindings confined to styk-wasm. Wasm 9,862 KiB (+145 KiB), SHA e5c3d8b2a7ca. No class gate, deletion or performance claim. | 708 shared-type native tests, 104 unique affected JS tests, final project13, check (1,999 files/7,010 messages), shipping Wasm and independently reviewed actual source mutants pass. All 59 Editor-built JSON regenerate twice byte-stable; four generators join full checkpoints. CLI22 admitted tapes/1,456 exact steps. Quiet80 editor calls and portable live115 supported calls compare full state/events/document/display/complete returns and exported history fields/weights; eight native-channel and five async-preflight tapes remain unadmitted. Actual main cache/ticket/monitor controls pass with six malformed and three cold/native refusals preserving shown/document/history/selection. Final remapped-effect software web4/4 mean .017499 and default Electron4/4 .024497, zero solids, unchanged D13. Correct pre-Ready Busy abort through per-attempt cancellation/view checks after actual failed-before2vs1 regression; no postcommit rollback/resubmit. State allocation/drop and held-lock probes certify scoped cache paths, not whole D7. Dense last owners/physical leases/shutdown, Core live coupling/ready-shown and app writer transfer remain open. Full checkpoint last green9728e86e; next starts on committed HEAD after this milestone. Logs: tmp/root-verification-temp/cache-quiet-live-*. |

| 2026-10-04 19:58 | Correct the shared progress-helper staging omission | Immediate postcommit status identifies verified src/engine/engine.mjs left unstaged by the manually assembled100-path list. Supply its unchanged independently reviewed helper in a new commit; no history rewrite. The previous65e1db72 snapshot is incomplete and must not be pinned. No crate API, gates, budgets or thresholds change. | All47 affected progress/playback/bootstrap/project JavaScript tests and npm check (1,999 files/7,010 messages) pass on the exact corrected sources. No native/app rebuild needed because those bytes are unchanged. Original milestone evidence preserved with omission diagnosis; background checkpoint starts only on corrected committed HEAD. Stage future source lists from the union of every contributing source manifest, then assert only known unrelated paths remain unstaged. Logs: tmp/root-verification-temp/cache-quiet-live-progress-stage-correction-*. |
| 2026-10-04 20:35 | S5 portable Core live coupling, native scalar projection and retained encoded accounting | Batch three independently reviewed native owners. Preserve the same Session, Mirror stored/history transition, SceneBudget and terminal-ACK roots. Adopt original native curves through marker/Draft/Records/typed sampler and share one Resolved allocation visitor; Scene saturation and all budgets stay exact. Mobile additions: WorkerSession::prepare_worker_history, Handle::submit_live, Records::pose_source_frame with unique-ID hint precondition, drawlist retained_bytes_checked/RetainedBytesError. Browser writer, current raw charge, glyph identity, upload/Shown/release and stop remain open. | Focused edit/eval/engine: 505 tests, one diagnostic ignored; JS: 59 tests; check: 1,999 files; pinned threaded Wasm compile passes. Rebuilt CLI: 50 admitted tapes / 6,581 exact steps, nine explicit guards. Projection: 204 curves / 1,620 samples / 200 missing first writes. All 3,577 source JSON stay stable; 13 new derived groups / 147 ticks / 26 JSON regenerate twice stable (421 groups total). Shipping pkg rebuild deferred to renderer app milestone; no app adoption, picture, gate, deletion or performance claim. Exact 34-source composition and six owning adaptations reviewed. Checkpoint805688d5 compile-only exit 143 attempt preserved; same HEAD/cache continuation running, next regular run 21:59 CEST. Evidence: tmp/root-verification-temp/core-projection-accounting-*. |
| 2026-10-04 21:35 | S5 scoped pre-publication generation and assets | Commit the independently reviewed five-path native candidate separately from the held Renderer32 patch. Same worker Mirror guard/CommitMarker/Loader and final State exchange; borrowed exact prebuilt generation/assets, single consuming commit and worker retirement. Working displays reuse the acknowledged generation; identical stored JSON still publishes genuine history revisions. Add portable WorkerPublication/WorkerEditPublication and Engine::prepare_record_publication_worker/prepare_edit_publication_worker APIs; mobile pin may move after downstream review. Actual Editor glyph pairing, Core Ready/Shown adoption, raw-ready charging and physical D7 remain open. | Fresh touched-crate run: all 182 styk-engine tests pass. Original isolated 117 focused tests and three actual source mutants caught/restored; all five root source hashes match that immutable freeze. Previously verified unchanged check, recorded CLI 50 admitted tapes/6,581 exact steps/nine guards and 13 derived groups/147 ticks remain green. No command recording, JavaScript or app adoption changed. Full committed 805688d5 checkpoint passes 56 stages/691 release-selected tests/358 containers; all 136 release executables fresh after regeneration in 0.23 s. Original Electron CEL regression blocks the separate renderer commit and is preserved in the handoff. Logs: tmp/root-verification-temp/scoped-candidate-* and renderer-publication-*. |
| 2026-10-04 22:02 | S5 guarded typed Scene/assets pairing and private Frame allocation observation | Batch two independently reviewed, disjoint freezes with one reviewed vfx module declaration adaptation. Opt-in pairing borrows the same guarded after-Cache Loader and exact candidate assets, preserving image namespace and actual imported glyph identities; six malformed/missing typed sheets refuse atomically through the existing checked planner. Private Frame observation reuses existing allocation visitors and a strongly held source baseline; it exposes gaps and has no runtime caller or charge. Mobile additions: GuardedTypedCache, GuardedPublication::typed_cache_worker, Engine::prepare_edit_typed_publication_worker; Frame observers remain private. No Core/Stage/app adoption, budget, gate, deletion or performance claim. | Touched edit/engine/eval tests: 528 pass, two explicit diagnostics ignored; npm check and generator syntax pass. Two typed regeneration runs preserve all 3,634 captured engine JSON. Pinned shipping-profile threaded Wasm typecheck passes; pkg remains unchanged. Actual recorded typed namespace/glyph comparisons and refusal guards pass in native tests. Independently reviewed typed scope correction closes six real failed-before cases; Frame allocator ledger and 18 actual source mutants remain preserved. Exact 23-source composition plus parity registration verified unchanged. Renderer32 remains uncommitted due to original full-CEL Electron regression. Full checkpoint last green805688d5; next eligible21:59 CEST. Evidence: tmp/root-verification-temp/typed-frame-*. |
| 2026-10-04 22:17 | S5 recorded native TRUE worker lifecycle and current-ready raw retention | Batch independently reviewed TRUE11 plus corrected strict Worker/Core/CLI8 with Raw9 and four scoped typed-test contexts; preserve three earlier owning prerequisite adaptations and all newer typed Loader/CommitMarker owners. Same AuthoredDrag/Draft/Records/response/history/source and guard; one-shot host errors remain exact. Strict replay compares actual initial heads before dispatch and validates lossless counters. Continue SAME receiver charge for current raw record after terminal ACK; detached aliases block preparation until physical worker disposal and wake only original Core. No new budget, public runtime route, gate, deletion or performance claim. Mobile addition: replay::replay_session_live_worker; legacy APIs unchanged. | 381 touched edit/engine/CLI tests, zero ignored; check and pinned threaded Wasm typecheck pass. Four generators twice keep all 3,635 captured JSON stable. Actual rebuilt CLI TRUE8/93 + old10/115 + conventional20/2,562 exact; six pairing/refusal guards and eight malformed initial cases exit nonzero. Independent Raw composition65cc33b6 and strict-initial13993953 reviews clean, preserving all original freezes/source mutants. Source27 + checkpoint script union exact; no app adoption or pkg rebuild. Full checkpoint4f4808c0 started22:02 CEST in persistent isolated target, last green805688d5; merges continue. Logs: tmp/root-verification-temp/true-raw-*. |
| 2026-10-05 00:04 | Preserve drawing edges and effects in camera previews and exports | App uses the recorded ordinary solid-background CanvasForeground source/paint path, actual completed GPU-source consumption and DOM-canvas paint history; resize/undo/source switches preserve the editor's pixels. Composited No smoothing follows the existing exportSVG policy; retained CPU/GPU mode changes preserve images/atlas/depth/additive artwork. Mobile API changes: Frame.export_vfx, Item.export_vfx, DrawList.composited_export (update exhaustive literals); portable background/paint helpers and CanvasForeground enum match; edges_for/set_edges, root_gpu_source and worker predicates additive. Browser metadata/DPR/callback stay in styk-wasm/adapters. **Counters:** inventory 176 js/122 partial→175 js/123 partial (35 ported/22 verified/1 removed unchanged); OWNED_CLASSES 2→2; deleted JS modules 2→2; engine-1 0/28→0/28, new affected export medians 17.6/93.3 ms engine/JS. Next: figures checkpoint and its three recorded blockers; general prerequisite lanes stay parked. | Composed main: 793 native tests pass, two existing diagnostics ignored; 55 affected JS tests, check2,000, shipping Wasm9a94cb89/10,201,677B. Four generators twice preserve3,660JSON. Actual Electron10/web10/lifecycle11 pass unchanged D13, zero solids/errors; full CEL .028777/.169556, six Electron corners exact, actual DPR2 .117618 and restoredDPR1 .025672. Six main composited None exports pass .2298/max50/zero solids; paired fresh medians total615.5/680ms, startup412/448ms, first202.5/232ms, load2.7–3.1. Plain drawing None .5124 remains pre-existing and byte-identical; SceneFX/onion/globalD7 remain open. Independently reviewed production/adaptations/source18 plus two corrections (final source19); source/pkg snapshots unchanged. Full checkpoint last green4f4808c0; required figures checkpoint starts on this committed milestone. Evidence current-renderer-* plus final source19 and export-policy freezes. |
| 2026-10-05 02:03 | Match segment pastes and measure figures editing cost | The actual app's existing owned route keeps pose/selection identities and uses compact COW values; recorded explicit-null refusal and an implicit clipboard guard preserve the ordinary editor's behavior. Failed eligible owned attempts are included before JS fallback. This unblocks the figures parity/cost gate; startup/joined cost remains the immediate bounded blocker. Mobile: no public crate API or response schema changes. **Counters:** inventory175js/123partial/35ported/22verified/1removed unchanged (notes updated); OWNED_CLASSES2→2; deletedJS2→2; engine-1 0/28→0/28, **three new fully accounted figures cost rows**, startup296.120/240.125ms, rig161.945/162.520ms, joined167.865/149.640ms candidate/JS. | 182 owning Rust tests;10 affected recorded replays/293 exact calls including62 newly recorded clipboard calls;2 fixture regenerations preserve2185 existing editJSON and all2189 final editJSON byte-for-byte (3664 engineJSON total).106 focused JS and check2000 pass; Wasm6d128ac/10,202,308B retains profile/noStrip. Three actual paired app runs pass strict document/history/selection/fullundo and source/package stability with complete accounting; startup and joined cost FAIL, rig passes narrowly. Fresh existing3d default smoke modeclasses adopts42 and compares15; all three core methods adopt, strict document/history/selection/fullundo match with zero errors. Full69 checkpoint64stages/791release-tests/358containers and warm144binaries0.328s/zero recompile passed; new source needs matching checkpoint before figures opens. Evidence figures-clipboard-final-*, figures-cost-js, figures-candidate-clipboard-final-1 and class-gate report. |
| 2026-10-05 02:49 | Preserve ordinary pose previews and measure the figures gate | The existing large-figure/3D app route assembles response keys once, skips adopted no-op endpoint scans and retains exact ordinary committed previews; joined, clock, order and cancellation fallbacks keep their owners. This batch unblocks figures cost verification; the unchanged cost gate still fails, so next work is bounded to scoped free-IK geometry and the reviewed view/snapshot helpers. Mobile: no public crate API, response schema or stored arithmetic changes. **Counters:** inventory175js/123partial/35ported/22verified/1removed unchanged (notes updated); OWNED_CLASSES2→2; deletedJS2→2; engine-1 0/28→0/28, **three additional fully accounted figures benchmark rows**, startup259.940/218.420ms, rig142.325/131.325ms, joined165.510/150.130ms candidate/JS. | 182 owning Rust tests;10 affected recordings/293 exact calls;191 focused JS/check2000 pass. Wasm36ed40b5/10,204,765B retains profile/noStrip. All three full paired app runs pass exact document/history/selection/full undo, counts, complete attempt accounting and stable1528sources/7pkg/3inputs; all three cost FAIL, load2.8–13.7, no causal improvement claim. Existing3d default smoke again42owned/15compared, all core adopted, exact/zeroerrors. Separate reviewed full-startup private profile exits0 with stable inputs/exact parity; instrumented timing is not gate evidence, Native symbols/history cost unproved. Independent five-path union and all three cost recomputations CLEAN. Full69 remains last green; matching final committed class checkpoint/default figures admission pending. Evidence figures-cost-batch2-*, figures-candidate-batch2-1, b2-union review and class-gate report. |
| 2026-10-05 03:37 | Keep figure gestures exact and measure the remaining editing cost | Scope free-limb geometry through existing join ancestors, preserve unchanged view/metadata and ordinary draft snapshots, and share private history heads until a write. This directly unblocks the figures cost gate; full paired cost is next. Mobile: no public crate API or response schema changes. **Counters:** inventory175js/123partial/35ported/22verified/1removed unchanged (notes updated); OWNED_CLASSES2→2; deletedJS2→2; engine-1 0/28→0/28; **ordinary diagnostic benchmark rows0→3**, candidate/JS22.800/17.005,22.760/17.205,22.380/17.170ms. Existing six full rows unchanged, latest three FAIL; no causal speedup or class acceptance claim. | Reviewed native191/0/0 including five history alias controls, budgets/pruning/batches/undo/redo, publication rollback/zero-allocation exchange, full recorded replay and worker guards; actual CLI24tapes/640calls; 197JS/check2000 pass. New actual-editor clip-parent13calls match old engine before porting and final native; scoped ancestor full/compact26rows byte-exact. Two oracle regenerations preserve1332old/1334final editJSON. Final Wasmd0aebc42/10,222,396B/profile/noStrip; three clean paired ordinary diagnostics each31owned15compared, core24pose/2move/3commit positive, source/package/input/HEAD stable, exact document/history/selection/fullundo and zero errors/rounding. Instrumented CPU profile is diagnostic only and maps through identical executable-section names. Last green full69; final committed checkpoint/default figures/full cost pending. Evidence class-gate report, figures-cost-batch3/batch4, final view/IK and history COW freezes/reviews. |
| 2026-10-05 05:19 | Reuse figure views and same-call captures; preserve layer membership indexes | Existing Cache/Loader typed pair and one-call IK evaluated pose/full solved map stay the owners; each updated controller spec recomputes, 2D/3D baseline/ancestor behavior remains exact. Unchanged compact layer publication retains record/source-GC indexes; changed layers/undo/redo rebuild. This directly unblocks the measured figures cost owner. No public crate API/schema/math/gate/threshold change. **Counters:** inventory175js/123partial/35ported/22verified/1removed unchanged (notes); OWNED_CLASSES2→2; deletedJS2→2; engine-1 0/28→0/28. Completed full cost rows6→9, all three new B4 FAIL; ordinary diagnostic rows3→4, latest22.925/17.075ms candidate/JS. No causal speedup or class acceptance. | Native12 patch588882d8/manifest e88044bf/independent faddbef6 exact;199 Rust,30CLI743,2regens1334old/1338final exact. OLD2D/3D double-capture58/58 precedes change; final116compact/full and numericbits/drag controls pass. Original57/58 test projection failure fixed with existing depth4 helper; cached69 stale npm-context failure preserved. Main147/147 JS/check2000/CSS93+682/messages8066 pass after25 location-only context updates; preload/registry/catalog unchanged. Shipping ac4ddf356bac/10,227,868B/profile/noStrip,58.89s/sourceStable; codec831eb/1,532,303B and drawing69df/449,096B unchanged. Actual ordinary paired app94.55s:31owned15compared46calls, core24pose/2move/3commit all positive, exact document/history10/selection/full undo, zero errors/mismatches/rounding, complete attempted-cost accounting and stable approved HEAD3e/dirty sources/package/input. Pose native5.930ms+parse.850ms+adopt9.255ms. Full B4 rows remain283.545/224.715,166.180/137.570,169.650/147.620ms FAIL; quota-aborted attempts remain incomplete. Next new committed candidate checkpoint/full three-document cost/default figures adoption before opening. Evidence class-gate report, Native final12 and JS main receipts, figures-cost-batch5-shipping-completion, b5-shipping-1. |
| 2026-10-05 06:29 | Reuse the evaluated pose when editing IK | Settings and active free/joined target edits reuse the original same-call tuple before mutation; this directly unblocks the figures cost gate. No public crate API or stored-arithmetic change; mobile needs no API adaptation. **Counters:** inventory175js/123partial/35ported/22verified/1removed unchanged (notes); OWNED_CLASSES2→2; deletedJS2→2; engine-1 0/28→0/28; **full class-cost benchmark rows9→12** with B5 candidate/JS239.970/220.625,292.805/132.530,332.620/277.010ms, all FAIL. | One full styk-edit round201/0/0, fresh CLI21tapes565/565, main56JS/check2000/CSS93/682/messages8066. Same-call counts:22free+16joined each evaluation-1;34one-shot/pinned controls unchanged; graph solver counts exact;20settings boundaries and3old/6final guard markers pass. Original synthetic unknown-figure panic preserved; only that unreachable test setup removed, six recorded current-pose controls unchanged. No recordings changed or regenerated. Source3 patch9e223352/manifest3cf36ef2 and79-artifact inventorye5adaa85; buildffedaa2273a9/10,231,142B/profile,60.92s/sourceStable, codec/drawing unchanged. B5 full matrix accounting/parity/core/source guards are exact, rig/joined overlap checkpoint builds and establish no causal speed claim. Background b4cc full checkpoint813/twoignored/64stages/358containers is green and clean; the changed candidate needs its own checkpoint. Fresh committed-candidate full cost, matching checkpoint and default admission are next. |
| 2026-10-05 07:22 | Avoid extra work when posing joints | Packed angles retain ordered duplicate additions and packing; the selected shape angle retains the entire joined solve, controller conflicts and duplicate-identity/global fallback while omitting unrelated angle-query solves. This directly unblocks the figures cost gate. No public crate API/schema or stored-arithmetic change; mobile needs no API adaptation. **Counters:** inventory175js/123partial/35ported/22verified/1removed unchanged (notes); OWNED_CLASSES2→2; deletedJS2→2; engine-1 0/28→0/28; **full class-cost benchmark rows12→15**, new B6 candidate/JS startup242.460/215.525, rig141.795/127.235, joined169.585/142.555ms, all FAIL. No B7 speed or class acceptance is claimed. | One unfiltered owning-crate round207/0/0, all six new controls executed; fresh CLI32tapes1519/1519; 435 native/config hashes change only reviewed3 and 3670 fixtureJSON stay exact. Main56JS/check2000/CSS93/682/messages8066 pass. Composition patcha85175dd and independent sourcedbaa1d11/runtime98e8b0d7 CLEAN; native completionf3307237. Shippinge95371c6c75e/10,234,289B (+3147B), required profile/sourceStable,57.79s; codec/drawing unchanged. B6 full parity/count/accounting passes with all three cost FAIL, no own heavy-build overlap or causal speed claim. Latest full green b4cc813/twoignored/64stages/358containers. Next committed B7 full cost, matching checkpoint and default figures adoption. |
| 2026-10-05 08:25 | Skip drawing preparation when posing joints | The existing geometry owner omits unused render output for eligible ordinary shape queries; complex geometry, ancestors and stored arithmetic stay exact. Assembly followers retain their first full read and skip a discarded second Scene. Known rig/static fallbacks include session cleanup in their existing timing. This unblocks the next figures cost run. Mobile: additive platform-neutral `build_only_for_shape` API, query geometry only; existing public types/schema unchanged. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged (notes updated); OWNED_CLASSES 2→2; deleted JS 2→2; engine-1 0/28→0/28; completed full class-cost rows 15→18 from B7, all three FAIL at 234.390/224.850, 135.060/133.930, 153.110/147.280 ms. | 383 owning Rust tests pass (209 edit + 174 eval), two existing diagnostics ignored; six new controls pass; fresh CLI 36 tapes / 1,668 exact steps; all 3,670 fixture JSON unchanged. Main 70 JavaScript tests and check 2,000 pass. Native receipt 9b236200 / review 8ab37927; main source review 227d67c5; guard v2 review 4391f0d5 includes cleanup once. Original failed fixture assumptions are preserved and corrected only in the new test, review 4e876748; every numeric/full-output comparison remains. Shipping 8d47d635183e / 10,238,324 B, 64.70 s, required profile/source-stable, codec/drawing unchanged. B7 full parity/count/accounting and positive core clocks pass, costs fail; no causal gain is claimed. Latest full green remains b4ccf993. Next: unchanged committed B8 full cost, its matching checkpoint and actual default adoption before opening figures. |
| 2026-10-05 09:42 | Query only the selected joint during figure edits | The existing geometry loop retains ancestors and full complex/joined/pinned/ambiguous fallbacks; invalid or overflowing geometry retries the original full owner. The existing coherent raw/typed pair reuses an unchanged IK table while other fields convert normally. This unblocks the figures cost gate. Mobile: additive portable `build_joint_for_shape` and `Loader::edit_frame_reusing_ik` APIs; stored fields/schema unchanged. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged; OWNED_CLASSES 2→2; deleted JS 2→2; benchmark full class-cost rows 18→21 (completed B8, three FAIL); engine-1 0/28→0/28. | 392 owning Rust tests (214 edit, 178 eval), two existing diagnostics ignored; all nine new tests execute. Fresh CLI 36 tapes / 1,668 exact steps; 3,670 fixture JSON unchanged; Main 70 JS/check 2,000 pass. The curve regression fails before and passes after. Native receipt 866daca6, independent runtime review 266780a7, composition review 61048212 and correction review 4b17d903; shipping receipt 006251b1: b9cf70669501 / 10,240,701 B, required profile, 65.06 s/source-stable, codec/drawing unchanged. Predecessor c0048287 full checkpoint 827/two ignored/64 stages/358 containers is green. B9 unchanged full cost, matching final checkpoint and positive actual default core adoption remain next; no causal speed claim. |
| 2026-10-05 10:48 | Use numeric geometry during IK drags | Active unpinned IK contexts use the existing all-joint query owner and skip unused ordinary draw items; capture and the full solved map retain their numeric inputs. Default/one-shot/pinned calls and rich/ancestor fallback remain unchanged. This unblocks the measured figures cost gate. Public crate APIs, schema and stored math are unchanged; mobile needs no API adaptation. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged (notes); OWNED_CLASSES 2→2; deleted JS 2→2; benchmark full class-cost rows 21→24 (B9 FAIL/PASS/FAIL); engine-1 0/28→0/28. | 215 editing tests, zero failures/ignored; ten recorded-prefix numeric/full-solution controls and existing guards pass; fresh CLI 12 tapes / 241 exact steps. Main 82 JS/check 2,000 pass; 2,296 unchanged engine files / 1,825 crate fixture JSON match the native lane. No recordings changed. Source review 223bc16f and native receipt 833110f0; shipping 61537fd7901f / 10,241,121 B, 55.17 s, required profile/source-stable, codec/drawing unchanged. Full48 diagnostic parity/full undo and clocks validate (126918e0, Native 845fb023, JS d64bffbc); no removable adoption work was found, and instrumented clocks are not gate evidence. Completed B9 strict full parity/accounting passes at 237.455/229.515, 136.735/141.250 and 156.620/138.235 ms candidate/JS: FAIL/PASS/FAIL. Next fresh committed B10 full cost, matching checkpoint and actual default figures adoption; no speed gain is claimed. |
| 2026-10-05 11:32 | Skip join ordering during ordinary joint drags | Existing selected-joint guards prove no frame joins or pins, so the same builder constructs the selected slot without unused join-order vectors. Global figures, warnings, draw-order publication and full/nonfinite fallbacks remain exact. This targets the figures cost gate. APIs, schema and stored math are unchanged; mobile needs no adaptation. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged (notes); OWNED_CLASSES 2→2; deleted JS 2→2; full class-cost rows 24→27 (B10, three FAIL); engine-1 0/28→0/28. | 394 native tests (215 edit, 179 eval), two existing ignored; new publication and existing recorded shape controls pass. Fresh CLI 15 tapes / 576 exact steps; all 3,670 fixture JSON unchanged. Main 82 JS/check 2,000 pass. Source review cd71cd87, native receipt c925ad49 and runtime review ddc6369e; shipping 15cbbdc513ea / 10,241,300 B, 102.17 s, required profile/source-stable, codec/drawing unchanged. B10 full parity/accounting passes at 240.255/214.480, 138.295/130.040 and 162.835/142.495 ms, all cost FAIL, independent 093c0a27; historical rows stay exact. Background full checkpoint 69bbe7ab runs separately. Joined initial selection remains full; literal joined profiling, fresh passing cost, final checkpoint and default adoption are next. No measured B11 speed gain. |
| 2026-10-05 12:06 | Skip unused segments when dragging joined figures | An ordinary selected-joint query narrows selected segments when the frame has no pins, retaining complete parents and original joined topology, warnings, publication and full fallbacks. This targets the measured figures class-cost blocker. Mobile: the existing portable query's semantic scope includes joined no-pin frames; signature/schema/stored math are unchanged. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged (notes); OWNED_CLASSES 2→2; deleted JS 2→2; measured full-workload joined instrumented diagnostic 0→1 at candidate/JS 305.950/280.750 ms; official full class-cost rows 27→27; engine-1 0/28→0/28. | 396 native tests (215 edit, 181 eval), two existing ignored; both new controls and all old guards pass. Fresh CLI 16 tapes / 591 exact steps; all 3,670 fixture JSON unchanged. Main 82 JS/check 2,000 pass. Source f5463546, native 74d5902c, runtime 12347ec9; shipping b65ff69acb49 / 10,241,354 B, 68.33 s/source-stable, required profile, codec/drawing unchanged. Full B11 joined diagnostic parity/counts/clock bridges accept with signed-sample exclusions (83a2ca49/57cfa98f/34bb6172); no removable adoption duplicate found. Instrumented timings establish no speed gain. Predecessor 69bbe7ab checkpoint passes 837 native/two existing ignored, 64 stages and 358 containers with a clean checkout. Next: fresh committed three-document cost, matching final checkpoint and actual default adoption before figures opens. |
| 2026-10-05 12:54 | Reuse unchanged effects while posing figures | Existing coherent raw/typed conversion shares warning-free effect tables; malformed/ambiguous data retain the original ordered diagnostics. This targets the measured figures cost blocker. Mobile: existing portable Loader API gains this reuse; signature/types/stored math/schema are unchanged. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged (notes); OWNED_CLASSES 2→2; deleted JS 2→2; full class-cost benchmark rows 27→30; engine-1 0/28→0/28. | 400 owning Rust tests, two existing ignored; four new controls; 27 recorded replays / 925 exact steps; 3,670 fixtures unchanged; 82 JS/check pass. Native receipt 6f0e7504, independent runtime f457306b. Shipping e5476f401799 / 10,241,930 B, 64.07 s, required profile/source-stable, codec/drawing unchanged. Completed B12 full costs 245.100/205.235, 132.080/133.770, 153.885/138.660 ms FAIL/PASS/FAIL preserve parity/full undo/accounting, review 3c556bdd / append bad26295. No causal gain or B13 cost claim. Next unchanged committed B13 cost, matching checkpoint and actual default adoption; figures remains closed. |
| 2026-10-05 13:58 | Reuse unchanged fields while posing figures | Existing coherent raw/typed conversion retains ordinary typed nonpose fields only within the 64-field same-Shape/raw-node guard. Changed pose conversion, metadata, rich/diagnostic fallbacks and duplicate-key lookup remain exact. Mobile: existing portable Loader semantics extend; signatures/types/stored math/schema are unchanged. **Counters:** inventory 175 js / 123 partial / 35 ported / 22 verified / 1 removed unchanged (notes); OWNED_CLASSES 2→2; deleted JS 2→2; full class-cost benchmark rows 30→33; engine-1 0/28→0/28. | 405 native tests (224 edit, 181 eval), two existing ignored, zero failed/filtered; all five new controls pass. Fresh CLI adc8cff6 / 347,875,280 B matches 28 references / 942 exact steps, 40 guards; 3,670 fixture JSON unchanged, source comparison039aebc1. Main 82 JS/check (2,000 files) pass. Source/native/runtime fe0538d3/f1ddde1f/1b63f9ef. Shipping10b6b47a17ed / 10,243,996 B, 81.92 s, required profile/source-stable, codec/drawing unchanged. Completed B13 full costs229.250/228.405,132.270/120.710,150.580/153.405 ms FAIL/FAIL/PASS preserve parity/full undo/accounting, reviewf26a1d97/appendf07d57a2. No causal saving, hit-rate or B14 cost claim. Next unchanged committed B14 cost, matching checkpoint and actual default adoption; figures remains closed. |
| 2026-10-05 13:44 UTC | Enable default figure editing | Open the existing `figures` class after exact behavior, matching checkpoint and positive default core adoption. The user-approved class-cost rule permits up to +5% or 0.1 ms average excess per conservative full timed call. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 2→3; deleted JS 2→2; full cost rows 33→36; engine-1 0/28→0/28. | B14 excess 0.047679/0.067983/0.071809 ms over 448/295/329 calls passes the absolute-average arm; old literal FAIL rows remain exact. Matching committed engine checkpoint: 849 native tests, two existing ignored, 64 stages/358 containers. Final gate: 86 focused JS/check pass; actual default startup/rig/joined each31 owned/15 compared/46 calls, positive Native core clocks and exact full undo. Exact behavior/D13/API/stored math remain unchanged. Next movieclips, then channels. |

| 2026-10-05 14:12 UTC | Enable default movieclip editing | Open the existing layer-sheet movieclips gesture/publication class; playback comparison and native/source/origin exclusions remain unchanged. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 3→4; deleted JS 2→2; full cost rows 36→38; engine-1 0/28→0/28. | Full sheet/loose costs 246.210/228.600 and 202.875/176.945 ms pass the user rule at 0.042332/0.076041 ms excess per full call. Matching committed engine checkpoint: 849 native, two existing ignored, 64 stages/358 containers. Final gate: 87 focused JS/Main check and actual default 18/31 owned, positive Native core clocks and exact full undo pass. Exact behavior/D13/API/stored math unchanged; next channels. |


| 2026-10-05 14:27 UTC | Measure saved-channel editing cost | Exact behavior passes; cost fails, so channels stays closed. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 4→4; deleted JS 2→2; full cost rows 38→39; engine-1 0/28 unchanged. | Candidate/JS 226.105/179.890 ms over 346 calls: 0.133569 ms excess/call, 11.615 ms gap to the limit. Checkpoint: 849 native/2 ignored, 64 stages/60 unchanged generators/358 containers in 6m29; warm Cargo 0.16 s. Focused 129 JS tests and 17 recordings/303 calls pass. |

| 2026-10-05 14:54 UTC | Reuse imported frames during channel editing | Share successful source samples within one sheet evaluation; focused output/count controls pass 3→1. Targets the channels cost gate. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 4→4; deleted JS 2→2; full cost rows 39→40; engine-1 0/28 unchanged. | 184 Rust/2 ignored; 36 recordings/687 exact calls; 125 JS/Main check pass. Full cost 233.630/174.045 ms fails at 0.172211 ms excess/call, leaving 24.985 ms. Behavior is exact; channels stays closed. APIs and stored math unchanged. |

| 2026-10-05 15:38 UTC | Keep preparation when selecting the current layer | Skip an identical raw active-layer string before copy-on-write; preserve changed writes and selection/history behavior. Targets channels cost. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 4→4; deleted JS 2→2; full cost rows 40→41; engine-1 0/28 unchanged. | 226 Rust; 53 recordings/2,060 exact calls; 125 JS/Main check pass. Full cost 224.030/181.885 ms fails at 0.121806 ms excess/call, leaving 7.545 ms. Channels stays closed; APIs and stored math unchanged. |

| 2026-10-05 16:18 UTC | Skip redundant source-retention scans | Current references or directly retained history captures can end cleanup when they cover every generated source; otherwise retain the original full path. Targets channels cost; APIs, schema and stored math unchanged. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 4→4; deleted JS 2→2; full cost rows 41→42; engine-1 0/28 unchanged. | 92 focused Rust; 53 recordings / 2,060 exact calls; 125 JS/Main check pass. Full cost 240.965/176.585 ms fails at 0.186069 ms excess/call, leaving 29.780 ms. Channels stays closed; no causal speed claim. |

| 2026-10-05 16:48 UTC | Keep the moved frame during one-shot adoption | Successful isolated one-shot moves publish the original authored COW frame and preserve ready/pending scoped geometry; complex/joined fallback is unchanged. Targets channels cost. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 4→4; deleted JS 2→2; full cost rows 42→43; engine-1 0/28 unchanged. | 128 JS/Main check; seven recordings / 158 exact calls. Original full cost 369.790/352.875 ms passes both arms at 4.793% and 0.048887 ms excess/call. Default ownership stays closed pending checkpoint/default proof; no causal speed claim. |

| 2026-10-05 17:11 UTC | Edit channel animations in the engine by default | Open channels after full paired cost, matching committed checkpoint and actual cold default core/full-undo proof. APIs, exclusions and D13 are unchanged. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 4→5; deleted JS 2→2; full cost rows 43 unchanged; engine-1 0/28 unchanged. | Full cost 369.790/352.875 ms passes at 4.793% and 0.048887 ms excess/call; checkpoint 856 native/2 ignored, 64 stages/358 containers; 132 JS, four recordings / 94 exact calls and Main check pass. Cold default: 31 owned/15 compared/46 calls, positive core clocks and exact full undo; admission only, no causal speed claim. |

| 2026-10-05 18:05 UTC | Split builder segments through the engine | Ordinary sheet Split adopts the changed definition/poses through the original history tail; unsupported contexts retain fallback. Additive opt-in Session JSON; Rust signatures/math unchanged. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 5→5; deleted JS 2→2; affected-command measurements 0→1; full cost rows 43 unchanged; engine-1 0/28 unchanged. | 94 Rust; 12 recordings / 272 exact calls; 225 JS/Main check; 1,340 stable JSON. One warmed Split 15.335/17.085 ms with exact full undo; Build UI Split/Undo/branch/repeated sessions/drawing/discard pass, screenshots inspected (compatibility renderer). No causal speed claim. |

| 2026-10-05 18:47 UTC | Make independent movieclip copies through the engine | Ordinary sheet Unique adopts the shallow definition copy and original sheet batch/history tail; unsupported contexts retain fallback. Additive opt-in Session JSON; Rust signatures/math unchanged. **Counters:** inventory 175 js/123 partial/35 ported/22 verified/1 removed unchanged; OWNED_CLASSES 5→5; deleted JS 2→2; affected-command measurements 1→2; full cost rows 43 unchanged; engine-1 0/28 unchanged. | 233 Rust; five recordings / 79 exact calls; 266 JS/Main check pass. Two warmed default UI copies preserve twelve paired boundaries and full undo, with positive Native/adoption clocks. Observed 22.030/19.740 ms is diagnostic, not a class-cost gate or causal speed claim. |

| 2026-10-05 19:17 UTC | Edit layer folders through the engine | All five mutators adopt ordered updates through the original layer history tail; the getter remains a UI projection. Additive opt-in Session JSON; Rust signatures/layout/math unchanged. **Counters:** inventory 175 js/123 partial/34 ported/23 verified/1 removed (one ported→verified); OWNED_CLASSES 5→5; deleted JS 2→2; command measurements 2→7; full cost rows 43 unchanged; engine-1 0/28 unchanged. | 236 Rust; three recordings / 58 exact calls; 204 JS/Main check pass. All five default commands adopt without editor fallback; actual Ungroup, 21 paired boundaries and full undo are exact. Observed 18.360/9.620 ms is diagnostic under concurrent checkpoint load, not a class-cost gate or causal speed claim. |
| 2026-10-05 20:00 UTC | Preserve clipboard paste counters | Paste and duplicate publish certified counters through original events and clipboard restoration; additive opt-in Session JSON, Rust signatures/math unchanged. **Counters:** inventory unchanged 175/123/34/23/1; classes 5→5; deleted JS 2→2; command rows 7→8; full cost rows 43 and engine-1 0/28 unchanged. | 238 Rust / 106 recorded calls / 263 JS and Main check pass. All 34 paired boundaries and full undo match; aggregate paste 24.860/20.630 ms is diagnostic only. |
| 2026-10-11 | Adopt layer metadata, project settings and movieclip rename | The leftover diff from the stopped agent, finished: the eight layer metadata commands, `setFPS`/`setCanvasSize`/`updateProject` and sheet `renameMovieclip` adopt the engine's answer in the default classes mode. New `scripts/engine-app-tape.mjs` replays recorded tapes in the app. Worktrees archived and removed. **Counters:** inventory 175/123/34/23/1 unchanged; OWNED_CLASSES 5; app-owned commands 98→110; deleted JS 2. | styk-edit tests and 126 adoption tests pass; check passes. In the app, seven tapes (101 steps, 43 owned calls) match the editor alone at every step and after full undo. |
| 2026-10-11 | D19: the engine owns the document | Generic document patches (`styk_edit::patch`, checked on every native replay step); the owner (`engine-owner.mjs`): persistent session per document, patches applied copy-on-write to the read view, session history with external entries for editor-run calls (`external.rs`), gestures mirrored, sessions per tab, start from the mirror with `@shape`, legacy Pivot pose caches materialized like the editor. Tools: `tests/engine-owner.test.mjs`, `scripts/engine-app-tape.mjs --owner`, `scripts/engine-owner-cost.mjs [--app]`. **Counters:** inventory unchanged; OWNED_CLASSES 5; deleted JS 2. | 325 tapes / 8,308 steps match in Node from the document and from the mirror (with legacy caches); 28 app tapes match. Cost in the app: Jay C 91.4 / J 89.5 ms (pass), URIEL 3 C 145.9 / J 54.4 ms (fail). Patch key-order fix: native heavy calls 6.3 → 2 ms. |
| 2026-10-23 | S7 Windows; S5 owner gestures; S1 native files | The tools and tests run on Windows paths; effect-clip and property edits and native movieclip commands run in the session; `.styk`/`.stkz`/`.stykmov` open and save through `styk-formats` in the codec module, the JavaScript container codec and vendored zstd deleted. **Counters:** owner editor calls 1,389 → 849; inventory 175/123/34/23/1 → 173/126/33/23/2; deleted JS modules +2 (native-container, vendored zstd). | Owner tapes 0 failing in both variants; `npm test` on Windows 4,121, 0 fail; old and new container codecs equal on 259 native files and two large documents (documents, saves, cache) before deletion. |
| 2026-10-24 | D16 pow; S5 motion paths | `styk_math::pow` is V8's legacy fdlibm pow and every fixture tool pins Node to it (`engine/tools/v8-pin.mjs`); motion-path edits run in the session (redo under an open edit hands it to the editor). **Counters:** engine pow call sites on platform pow 9 → 0; owner editor calls 849 → 549. | pow: 0 mismatches on 6.17 M recorded and 2 M fresh inputs; regeneration byte-stable on Windows and Linux; four crates 455 tests pass; owner tapes 0 failing. |
