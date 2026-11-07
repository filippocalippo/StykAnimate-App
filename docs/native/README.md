# The native app

StykAnimate is moving from Electron (a JavaScript interface over the Rust engine compiled to WebAssembly) to one native
Rust program: the engine running natively, an iced interface, no Electron, Chromium or Node at runtime. Every feature
carries over, the look and feel stay 1:1 with today's app except a redesigned Settings and a new docking system, and
everything gets faster. The owner decided this on 2026-11-05.

- [architecture.md](architecture.md): the target: crates, owners, threads, the GPU, builds.
- [decisions/](decisions/): the decision log of this phase (N1, N2, ...).
- [INVENTORY.md](INVENTORY.md): every feature and surface of today's app (1,270 feature rows, 276 commands, 129 IPC
  channels, 93 stylesheets), its native owner, test, screen ID and status.
- `docking.md`, `devtools.md`, `settings.md`: the new designs, written before they are built.

## Handoff (keep current; read this first to resume)

**Updated 2026-11-07 13:45.** The Claude API rate limit stopped every Sonnet task on 2026-11-06 at about 19:20; T3 re-arms limited
tasks and they resumed on 2026-11-07 12:37 (none had lost work: the spikes had only merged N0). Branch `native-app` from `engine-rust` `99c62189`, pushed. The main checkout is on
`native-app`; merges into `engine-rust` happen in `wt/int-engine-rust` ([N3](decisions/0003-branches-and-integration.md)).
The orchestrator's briefs and tools live outside the repository in `perf/` (`perf/briefs/native-common.md` for every
agent, `perf/briefs/native/<chunk>.md` per chunk, `perf/merge.sh <sha> <message> [native-app|engine-rust]`).

**In flight.**

| Chunk | What | Where | State |
| --- | --- | --- | --- |
| Gate b13 | local `engine-rust` `99c62189` (two merges never run together) | `perf/batches/b13/` | **passed and pushed**: check, `npm test` 2705/2705, Rust workspace, parity, web, every smoke (the video smoke needed the bundled encoder copied into the gate checkout). Benchmark deferred to the cleanup batch (one exclusive run after M, D, X) |
| M | movieclip save fix merged, the rest of the movieclip branch, the refused gesture sequence | T3 worktree, Sonnet | running |
| D | drawing-undo atlas work, its compile fix, the polygon cache removed | `t3/drawing-undo` `c8987efd` | done: merged cleanly, `placement: 0`, polygon cache removed; "two frames matched no state" not reproduced in 30 runs (new probe); in review (GPT-6.1 Sol xhigh, Sonnet checker) |
| X | export frames independent of export order, picture and cel residency in exports | `t3/native-export-performance` `39d10510` | done: the cause was the lone-glyph mask atlas (a mask's place in it moved edge sampling by a level), now placed afresh per export frame; regression test fails without it. GPT-6.1 Sol found two majors (a refused cel decode marked complete over stale tiles; the glyph atlas keeping its layer count past its 64 MiB budget): back with the implementer; Sonnet checker running |
| I | the inventory | `docs/native/INVENTORY.md` | done: 1,270 rows, all todo; regenerate the appendices with `perf/native/tools/` |
| N0 | the foundation: vendored iced and its git dependencies, the nine crates, the off-screen window (headless where a window cannot be hidden), PrintWindow screenshots, tokens (460 colours equal to Chromium's; dynamic geometry as functions), icons, Inter 4.001 and Inter Tight 3.004 | **merged into `native-app` `59a39d7c`** | reviewed by GPT-6.1 Sol, findings fixed. Empty window 197 MB private (target 150), start to first PNG about 0.9 s (directional) |
| S1, S2a, S2t, S2b, S3 | spikes: pen; fields, focus, IME, RTL; typography; the text tool compiler; video export | T3 worktrees, Sonnet, on N0 | running |
| S1-S6 | risk spike designs, in `perf/native/spikes/S*.md` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/spikes/reviews/`); briefs ready in `perf/briefs/native/` (S1, S2a fields, S2t typography, S2b text tool, S3 video), launched when N0 merges |
| Designs | docking, developer tools, Settings, in `perf/native/designs/` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/designs/reviews/`); decisions in `decisions-on-open-questions.md`; each implementation chunk first revises its design with the review into `docs/native/` |

Spike design findings so far: desktop video export already runs a bundled FFmpeg 7.1 sidecar (WebCodecs is the
browser's fallback only), so the native export runs the same FFmpeg with the same arguments and aims at identical bytes;
the pen reaches iced only as touch with pressure, so a `WM_POINTER` subclass reads pen history (tilt, eraser, barrel,
timestamps) into a ring; iced has no right-to-left layout, Tab order or focus ring, and its Windows IME is IMM32 only:
those are ours (`styk-design`, `styk-core`) plus a few small fork patches; Inter must be converted from WOFF2 to TTF.

**Next, in order.** After M merges: L (the blocking locks in `styk-wasm/src/open.rs` and `stage.rs`, the 250 MB Pivot file
that fails and the memory it keeps) and P (the padded `.piv` export that is refused). Then the remaining spikes: S4 audio, S5 the web build, S6 the shell (briefs to write from their reviewed designs).
No interface work starts until S1 and S2a pass in a native window.

**Kept off the branches on purpose.** `t3/fix-save-differs` and `t3/resave-keeps-layout` change saved bytes: the owner's
decision, unmerged. `t3/speed-joint-drag-frame` is an unfinished optimisation with no measured gain: not this phase's.
The Electron-only leftovers of `t3/export-timeout-performance` (the keep-alive, `desktop/video-export-service.cjs`
timeouts, Electron benchmark rows) are not fixed in Electron; their problems are acceptance criteria for the native
export.

**Numbers.** None measured on the native app yet. Today's app: batch 12 in `docs/RUST-ENGINE-PORT.md`; the prototype's
numbers in `perf/native-ui-test-*.txt` (outside the repository).

**Floors recorded.** None.

## Plan

1. **Inventory and risk spikes.** The inventory first; the engine cleanup beside it. Spikes retire the hard risks with
   working code and a measurement: pen and text first (no interface work starts until both pass in a native window),
   then video export, audio, the web build, the shell.
2. **Skeleton.** The window and shell; the design-system crate; the engine host (documents, tabs, open, save, recovery,
   autosave); the stage with the automation mode and the benchmark; the developer tools' foundation (instrumentation,
   profiler, performance overlay, logs, live parameters, headless runs, profile and compare commands, the control
   channel, the task runner). Gate.
3. **Animate workspace**: stage tools, joints and handles, the inspector, the timeline and layers, playback, undo and
   redo, onion skins, the camera, the scene, movieclips, VFX. Gate.
4. **Draw workspace**: brushes and pressure, cels and layers, selections and fills. Gate.
5. **Build workspace.** Gate.
6. **Everything else**: Home, the project library, tutorials, export flows, the new Settings, the support center,
   telemetry consent, updates, the community library, every remaining inventory row.
7. **Localization** in every language, the web build, macOS and Linux in CI.
8. **Electron removed**, with the JavaScript interface; the docs pass, the final gate and the report.

Gates: the Rust workspace tests and the engine parity suites; the native smoke scenarios (open, edit, save, reopen,
export, recovery); the screenshot comparison; the full benchmark, native against today's app; while JavaScript remains,
`npm run check` and `npm test`.
