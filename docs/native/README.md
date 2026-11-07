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

**The owner's decisions of 2026-11-07** ([N5](decisions/0005-electron-is-the-reference.md)): today's Electron app is only the
reference for parity. `engine-rust` stays at b13 (`99c62189`); the engine cleanup chunks merge into `native-app` only;
engine chunks are verified with the Rust tests, the parity suites and the save byte checks; browser- or Electron-only work
stops (X2, Electron 4K memory runs, fuzz-harness node crashes unless engine code, the `styk-wasm` locks and the 250 MB
file's binding error) and becomes native acceptance criteria. Each commit is built once: implementer, checker and reviewer
share the implementer's worktree and build; reviewers only read and run one small check; full suites only at gates; the
seed store `wt/shared-target` is back (crates.io dependencies; `node perf/make-seed.mjs <checkout>...` adds to it).

**In flight.**

| Chunk | What | Where | State |
| --- | --- | --- | --- |
| Gate b13 | local `engine-rust` `99c62189` (two merges never run together) | `perf/batches/b13/` | **passed and pushed**: check, `npm test` 2705/2705, Rust workspace, parity, web, every smoke (the video smoke needed the bundled encoder copied into the gate checkout). Benchmark deferred to the cleanup batch (one exclusive run after M, D, X) |
| M | movieclip save fix merged, the rest of the movieclip branch, the refused gesture sequence | `t3/movieclips-native-phase` `d69d5a25` | done: conflicts with `3b15fc79` resolved (original kept in the document, `keep_last` for repaired files), `OpenSource::Tree` fixed, the nested-clip pruning cause fixed (figures kept by definition too); in review (GPT-6.1 Sol xhigh, Sonnet checker) |
| M2 | two more refused saves found by a drawing-publishing fuzz (seeds 62, 132), the repository fuzz made to catch that class, intermittent node segfaults under load | `t3/movieclip-drawing-saves` from `d69d5a25`, Sonnet | running |
| D | drawing-undo atlas work, its compile fix, the polygon cache removed | `t3/drawing-undo` `c8987efd` | done: merged cleanly, `placement: 0`, polygon cache removed; "two frames matched no state" not reproduced in 30 runs (new probe); in review (GPT-6.1 Sol xhigh, Sonnet checker) |
| X | export frames independent of export order, picture and cel residency in exports | **merged into `native-app` `3961a119`** | the cause was the lone-glyph mask atlas (now placed afresh per export frame); review fixes: a refused cel decode is blank, the glyph atlas resets its layers on a page-size change, a stale decode attempt never touches a newer one, a dropped export releases what landed. Checked natively: four documents, 1080p and 4K, whole layout and paged, every order identical to alone |
| FP | the native renderer draws today's frames (native wgpu against Chromium's WebGPU on the same document and tick: S3 found sub-level differences, PSNR 66-68 dB) | T3 worktree, Sonnet | running |
| X2 | tdd2 ticks 183-188 differ between identical runs of the browser export (two hashes recur per tick) | stopped (N5): browser-side; notes in `perf/native/findings/X2-browser-export-determinism.md`; native criterion: identical frames across runs |
| I | the inventory | `docs/native/INVENTORY.md` | done: 1,270 rows, all todo; regenerate the appendices with `perf/native/tools/` |
| N0 | the foundation: vendored iced and its git dependencies, the nine crates, the off-screen window (headless where a window cannot be hidden), PrintWindow screenshots, tokens (460 colours equal to Chromium's; dynamic geometry as functions), icons, Inter 4.001 and Inter Tight 3.004 | **merged into `native-app` `59a39d7c`** | reviewed by GPT-6.1 Sol, findings fixed. Empty window 197 MB private (target 150), start to first PNG about 0.9 s (directional) |
| S2a | fields, focus, input methods, right to left: focus scopes with restoration and F6, the text-entry hotkey gate, roving, field roles, bounded coalesced field history, intake limits before mutation, clipboard replies tied to their request, RTL geometry; the component sheet and the screen catalogue | `t3/native-text-input-rtl` `320c6850` | done: caret sequences equal Chromium's (logical motion, measured), lam-alef inserts both scalars, 200-char field p50 7.2 ms. Open: a 16,300-character single line types at p50 28-36 ms (Chromium 5.8); no IME installed here (manual check). In review (GPT-6.1 Sol xhigh, Sonnet checker) |
| S2b | the text tool compiler (a line-for-line port of the opentype.js paths: TrueType and CFF, GPOS-then-kern, symbol mapping) and the font service (bounded, cancellable walk, containers validated first) | `t3/text-tool-font-service` `cd2d5d9f` | done: figure JSON byte-equal to today's for 73 fixture steps and 507 steps over 169 installed fonts; saves equal in `.styk`, `.piv`, `.stk`; 207 faces listed as today, in 51 ms (today 5.9 s). In review (GPT-6.1 Sol xhigh, Sonnet checker). Open: NFC's Unicode version to pin to V8's; three saved-bytes drafts possibly refused on both sides; 3.3 MB of fixtures to compress |
| S3 | native video export, headless: the same FFmpeg with the same arguments (PAM frames instead of PNG), the VFW helper, staging and commit, cancellation that wakes every wait, no timer | `t3/22617e23` `caa1650d` | done: MP4/AVI/WMV byte-identical to today in 36 cases; WebM identical except two random track IDs that differ between two runs of today's exporter; lossless and alpha exact; VFW identical; 300 s suspended encoder and 200 s paused producer give identical files; cancel 23-44 ms at 4K; 4K export memory 1.47 GiB (today 1.8-2.1). Blocked: order independence until X is in `native-app`. In review (GPT-6.1 Sol xhigh, Sonnet checker in its worktree); `styk-video` folds into `styk-cli` (`app-tools`) |
| S1 | pen input: WM_POINTER subclass with history, promotion by provenance, lifecycle events, bounded queue keeping terminal events, today's stroke rules in `styk-core::drawing`, dabs on the drawing worker, wet ink retired in the frame its tiles upload, the pen lab (developer build) | `t3/pen-tablet-input` `08d30f1e` | done: fields exact, 1184/1184 samples, history recovers a blocked UI, parity with today's app tile-exact through commit, undo, redo, save and reopen, preview latency p50 1.25 frames at 144 Hz. Open: UI slices over 4 ms in 5 of 8 runs, stress frames 27-31 ms. GPT-6.1 Sol found 12 (1 blocker: cancelling a stroke could discard the one before it), being fixed; checker after the fixes ([N6](decisions/0006-no-injected-input-on-the-owners-screen.md): no input injection) |
| S2t | typography: any weight, optical size, features, tracking through iced, cosmic-text and cryoglyph; bundled Inter replaces an installed static one; Chromium's baseline rounding; stylesheet fallback order (Segoe UI for Arabic and Hebrew, Microsoft YaHei UI for CJK, as Chromium); fonts ready before any text widget | **merged into `native-app` `47d2e9be`** | widths within 0.03 px of Chromium at 100/150 %, light and dark; GPT-6.1 Sol's four findings fixed (default ASCII shaping, a type-level font-readiness proof, features splitting runs, a fallback check that can fail) |
| S2c | ClearType-style subpixel text on Windows where Chromium draws it, and Skia's dark-mode contrast curve | `t3/subpixel-text` (S2t's worktree), Sonnet | running |
| S1-S6 | risk spike designs, in `perf/native/spikes/S*.md` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/spikes/reviews/`); briefs ready in `perf/briefs/native/` (S1, S2a fields, S2t typography, S2b text tool, S3 video), launched when N0 merges |
| Designs | docking, developer tools, Settings, in `perf/native/designs/` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/designs/reviews/`); decisions in `decisions-on-open-questions.md`; each implementation chunk first revises its design with the review into `docs/native/` |

Spike design findings so far: desktop video export already runs a bundled FFmpeg 7.1 sidecar (WebCodecs is the
browser's fallback only), so the native export runs the same FFmpeg with the same arguments and aims at identical bytes;
the pen reaches iced only as touch with pressure, so a `WM_POINTER` subclass reads pen history (tilt, eraser, barrel,
timestamps) into a ring; iced has no right-to-left layout, Tab order or focus ring, and its Windows IME is IMM32 only:
those are ours (`styk-design`, `styk-core`) plus a few small fork patches; Inter must be converted from WOFF2 to TTF.

**Next, in order.** L (now: the 250 MB very compressible Pivot file opened natively, memory released on close; the `styk-wasm` locks and its binding error stopped under N5) and P (the padded `.piv` export refused) start from M's head when the D and X checkers finish (at most about ten Sonnet agents at once: more trips the API rate limit): L (the blocking locks in `styk-wasm/src/open.rs` and `stage.rs`, the 250 MB Pivot file
that fails and the memory it keeps) and P (the padded `.piv` export that is refused). Then the remaining spikes: S4 audio, S5 the web build, S6 the shell (briefs to write from their reviewed designs).
No interface work starts until S1 and S2a pass in a native window.

**Kept off the branches on purpose.** `t3/fix-save-differs` and `t3/resave-keeps-layout` change saved bytes: the owner's
decision, unmerged. `t3/speed-joint-drag-frame` is an unfinished optimisation with no measured gain: not this phase's.
The Electron-only leftovers of `t3/export-timeout-performance` (the keep-alive, `desktop/video-export-service.cjs`
timeouts, Electron benchmark rows) are not fixed in Electron; their problems are acceptance criteria for the native
export.

**Manual checks for the owner** (cannot be automated on this machine without touching the owner's screen or system,
decision N6): a pass with a real pen or tablet in the pen lab (developer build); a pass with real input methods (Microsoft
Japanese IME, Pinyin, the Arabic and Hebrew keyboards) in the component sheet's fields; the export's full-disk case.

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
