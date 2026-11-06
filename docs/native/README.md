# The native app

StykAnimate is moving from Electron (a JavaScript interface over the Rust engine compiled to WebAssembly) to one native
Rust program: the engine running natively, an iced interface, no Electron, Chromium or Node at runtime. Every feature
carries over, the look and feel stay 1:1 with today's app except a redesigned Settings and a new docking system, and
everything gets faster. The owner decided this on 2026-11-05.

- [architecture.md](architecture.md): the target: crates, owners, threads, the GPU, builds.
- [decisions/](decisions/): the decision log of this phase (N1, N2, ...).
- `INVENTORY.md` (lands with step 1): every feature and surface of today's app, its native owner, test and status.
- `docking.md`, `devtools.md`, `settings.md`: the new designs, written before they are built.

## Handoff (keep current; read this first to resume)

**Updated 2026-11-06 18:45.** Branch `native-app` from `engine-rust` `99c62189` (not pushed yet). The main checkout is on
`native-app`; merges into `engine-rust` happen in `wt/int-engine-rust` ([N3](decisions/0003-branches-and-integration.md)).
The orchestrator's briefs and tools live outside the repository in `perf/` (`perf/briefs/native-common.md` for every
agent, `perf/briefs/native/<chunk>.md` per chunk, `perf/merge.sh <sha> <message> [native-app|engine-rust]`).

**In flight.**

| Chunk | What | Where | State |
| --- | --- | --- | --- |
| Gate | local `engine-rust` (`99c62189`: two merges never run together) | `wt/perf-now`, `perf/batches/b13/` | release build passed; suites running |
| M | movieclip save fix merged, the rest of the movieclip branch, the refused gesture sequence | T3 worktree, Sonnet | running |
| D | drawing-undo atlas work, its compile fix, the polygon cache removed | T3 worktree, Sonnet | running |
| X | export frames independent of export order, picture and cel residency in exports | T3 worktree, Sonnet | running |
| I | the inventory, 12 areas, into `perf/native/inventory/` then `INVENTORY.md` | workflow, Sonnet | running |

**Next, in order.** After M merges: L (the blocking locks in `styk-wasm/src/open.rs` and `stage.rs`, the 250 MB Pivot file
that fails and the memory it keeps) and P (the padded `.piv` export that is refused). Then N0, the foundation: vendored
iced, the crates, a window with `STYK_BACKGROUND_WINDOW`, tokens, icons and fonts, window screenshots. Then the risk
spikes on N0: S1 pen and tablet, S2 text (both before any interface work), S3 native video export, S4 audio, S5 the
web build, S6 the shell.

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
