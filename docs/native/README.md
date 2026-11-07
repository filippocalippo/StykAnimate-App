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

**Updated 2026-11-07 17:00.** The Claude API rate limit stopped every Sonnet task on 2026-11-06 at about 19:20; T3 re-arms limited
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

**The owner's second decision of 2026-11-07** ([N8](decisions/0008-windows-only-review-by-risk.md)): Windows only in this
phase (macOS, Linux and the web build not tested or run; the architecture stays portable); Sonnet implements, no Sonnet
checkers; GPT-6.1 Sol reviews by risk; the orchestrator reads every diff before merging; proof proportionate to risk.
In-flight chunks finish with no new review round unless a finding is a blocker.

**In flight.**

| Chunk | What | Where | State |
| --- | --- | --- | --- |
| Gate b13 | local `engine-rust` `99c62189` (two merges never run together) | `perf/batches/b13/` | **passed and pushed**: check, `npm test` 2705/2705, Rust workspace, parity, web, every smoke (the video smoke needed the bundled encoder copied into the gate checkout). Benchmark deferred to the cleanup batch (one exclusive run after M, D, X) |
| M | movieclip saves that reopen, nested clips, clip copies reserved, the store lock that never waits on a page thread | **merged into `native-app` `7d3266c1`** | three GPT rounds; on the merged tree 1,071 Rust tests, 63 JavaScript, `engine:parity` ok |
| M2 | refused saves found by a drawing-publishing fuzz (seeds 62 and 132 fixed; 403, 408), the fuzz as a bounded regression | `t3/movieclip-drawing-saves`, in M's worktree | resumed on `7d3266c1` |
| D | drawing-undo atlas work, its compile fix, the polygon cache removed | **merged into `native-app` `7881b55b`** | review fixes: a refused replacement decode blanks the places it reused (lazily, within the renderer's budget) and leaves none waiting, on the stage and in exports (resident exports through X's `clear_cel`, once); decoded bounds and ink shared by every view of a tile payload; dedup across the whole list. 547 tests of six crates; parity at the next gate |
| S4 | audio: the mixer ported line for line (document order, f32 per clip), FFmpeg decoding as today, one 768 MiB decoded budget, a lock-free stream clock the frames follow, WASAPI output, scrub, the export's offline mixer | `t3/native-audio-timeline-sync` `62952d36` (on S3's branch: merges after S3) | done: mixer goldens bit-identical to today's at every chunk size; decoded bytes equal; real device clock 1.69 ms from loopback, 0.02 ms jitter, 0 underruns under load; scrub first sound 9.9 ms. Note for the timeline chunk: open the device on a job thread (it waits for its thread). Review (GPT-6.1 Sol xhigh): 7 findings (`perf/native/spikes/reviews/S4-audio-diff-review.md`: the clock after an underrun mid-refill, embedded audio over its reservation, teardown outside reclamation, unbounded preparation, stderr kept whole, the scrub throttle, the waveform cache's exemption); fixing |
| S6 | the shell: frameless chrome, snap layouts, DPI, window state per monitor setup, single instance, associations with today's ProgIDs, the updater, the installer | `t3/native-shell-spike-s6` `d18d8727` | done: the chrome subclass (snap layouts through `HTMAXBUTTON`, chained with the pen's), restore in screen coordinates, single instance over a current-user pipe with acknowledged bounded delivery, today's eight ProgIDs, the updater with a signed feed ([N9](decisions/0009-signed-update-feed.md)), an NSIS installer that today's updater runs and that keeps today's uninstall key; sandboxed installer tests (an Electron-layout fixture upgraded as the updater runs it), `--shell-check` 24 passed. Review (GPT-6.1 Sol xhigh): 17 findings, one blocker (the old uninstaller pointed at the new destination); fixing, then one re-check of the installer and the update chain |
| LP | the 250 MB Pivot file natively (opens, memory released: the browser's held gigabyte is the WebAssembly allocator's high-water mark); the padded `.piv` export (`Codec::export_tree` from the tree, bytes equal to the service's, reserving 4x the retained bytes first) | `t3/native-large-pivot-files` `881fa2fd` | checker (`perf/native/findings/LP-check.md`): padded files byte-identical to the service at every size it accepts, the reservation boundary exact and released on every path, cancel at every poll clean, the 250 MB file released over three cycles; breaks: edited real files differ in the sign byte of -0.0 (review finding 1). Fixing the review's 3 findings and the checker's cancel latency (0.5 s on a 60 MB padded file) and size-limit notes |
| X | export frames independent of export order, picture and cel residency in exports | **merged into `native-app` `3961a119`** | the cause was the lone-glyph mask atlas (now placed afresh per export frame); review fixes: a refused cel decode is blank, the glyph atlas resets its layers on a page-size change, a stale decode attempt never touches a newer one, a dropped export releases what landed. Checked natively: four documents, 1080p and 4K, whole layout and paged, every order identical to alone |
| FP | the native renderer draws today's frames (native wgpu against Chromium's WebGPU on the same document and tick: S3 found sub-level differences, PSNR 66-68 dB) | `t3/native-renderer-frame-parity` `a25d9f7c` | one cause fixed: DX12's FXC folds `prim.wgsl`'s clip position into a different rounding than Vulkan and Chromium, and with vertices snapped to 1/256 px thin triangles changed coverage (one pixel 64 levels off); `clip_pos` now divides first (a cross-backend test fails on the old shader in 40,651 of 81,920 positions; Chromium's own frames unchanged over 23 reference sets). The CPU rasterizer is bit-identical in WebAssembly and natively. `styk_render::native_instance_descriptor()` chooses DX12 with FXC on Windows (Chromium matches DX12 bit for bit on pictures and translucent fills): the native app uses it. Left: 4-467 pixels per set one level off. A third, different attempt (render targets, blending, multisampling against Dawn's choices) runs before it counts as a floor. Review (GPT-6.1 Sol xhigh, `perf/native/findings/FP-review.md`): 5 findings (the test accepts folded arithmetic and runs a compute proxy, DX12 required instead of preferred, the floor not shown per cause, coverage only of the export path, a GPU test that passes without a GPU); fixing |
| S5 | the web build of the native app | T3 worktree, Sonnet, from `396e430d` | stopped (N8): wrapping up with the constraints it found in `docs/native/web.md` |
| X2 | tdd2 ticks 183-188 differ between identical runs of the browser export (two hashes recur per tick) | stopped (N5): browser-side; notes in `perf/native/findings/X2-browser-export-determinism.md`; native criterion: identical frames across runs |
| I | the inventory | `docs/native/INVENTORY.md` | done: 1,270 rows, all todo; regenerate the appendices with `perf/native/tools/` |
| N0 | the foundation: vendored iced and its git dependencies, the nine crates, the off-screen window (headless where a window cannot be hidden), PrintWindow screenshots, tokens (460 colours equal to Chromium's; dynamic geometry as functions), icons, Inter 4.001 and Inter Tight 3.004 | **merged into `native-app` `59a39d7c`** | reviewed by GPT-6.1 Sol, findings fixed. Empty window 197 MB private (target 150), start to first PNG about 0.9 s (directional) |
| S2a | fields, focus, input methods, right to left: focus scopes with restoration and F6, the text-entry hotkey gate, roving, field roles, bounded coalesced field history, intake limits before mutation, clipboard replies tied to their request, RTL geometry; the component sheet and the screen catalogue | `t3/native-text-input-rtl` `f500835a` | done: caret sequences equal Chromium's (logical motion, measured), lam-alef inserts both scalars, 200-char field p50 7.2 ms; review and checker findings fixed (`bb8f1dd1`, tests failing first in `632aaf98`). Open: the paragraph, word and line-break limits it added go (a new limit is not a speed fix): today's maxlength stays, long paragraphs are made fast instead (a 16,300-character line types at p50 28-36 ms, Chromium 5.8). No IME installed here (manual check) |
| S2b | the text tool compiler (a line-for-line port of the opentype.js paths) and the font service | **merged into `native-app` `5e7b3cd3`** | figure JSON byte-equal to today's (73 fixture steps, 507 over 169 installed fonts, 10,647 in the checker's own sweep); NFC pinned to Unicode 15.1 (Electron 39's ICU 74.2, swept over the whole BMP); saves equal; 207 faces in today's order in 65 ms (today about 170 ms warm); nine review findings fixed, eight shown failing first |
| S3 | native video export, headless: the same FFmpeg with the same arguments and today's PNG frames, the VFW helper, staging and commit, cancellation that wakes every wait, no timer | `t3/22617e23` `42f363d8` | done: MP4/AVI/WMV byte-identical to today in 36 cases (the checker's 70-case FFmpeg matrix: 0 mismatches); WebM identical except two random track IDs that differ between two runs of today's exporter (checker: 70 cases, 0 mismatches; VFW, kill and the cancel sweep hold); lossless and alpha exact; VFW identical; 300 s suspended encoder and 200 s paused producer give identical files; cancel 23-44 ms at 4K; 4K export memory 1.47 GiB (today 1.8-2.1). Fixing the re-check's 5 findings (`perf/native/spikes/reviews/S3-video-recheck.md`: kept artifacts swept, a poller holding its device, poll errors dropped, a child outside its job, PID reuse) and the checker's cancel during the flush (up to 29 s on a 373 MB output; `perf/native/findings/S3-check.md`). The checker's 4K memory (1.2 GiB in our process, the export's own share 110 MiB) goes to chunk RM; `styk-video` folds into `styk-cli` (`app-tools`) |
| S1 | pen input: WM_POINTER subclass with history, promotion by provenance, lifecycle events, bounded queue keeping terminal events, today's stroke rules in `styk-core::drawing`, dabs on the drawing worker, wet ink retired in the frame its tiles upload, the pen lab (developer build) | `t3/pen-tablet-input` `270ccc4b` | the 12 review findings fixed (stroke-scoped cancel, a queue that keeps every admitted gesture's end, a worker never joined on the interface thread, whole-batch tile installs with eviction and acks only for installed tiles, `prepare` budgeted to 3 ms); all system input injection removed (N6); parity identical in 7 scenarios through a real `.styk` save and reopen; stress with the zoom applied: no skipped frame, `prepare` at most 0.7 ms (the earlier 27-31 ms frames were other jobs). The re-check's 8 findings and the checker's 7 fixed (streamed dab generation through a bounded batcher, acks by contiguous frontier, 16 open strokes and 1,024 queued requests at most, tile replies in parts of 64, stamped atlas changes with superseded batches removed, LRU eviction of visible tiles, a stable history clock, today's capture as a fixture, save and reopen through the editing session); self-tests 26 PASS, stress worst frame 8.10 ms. Re-check 2 (GPT-6.1 Sol xhigh, `perf/native/spikes/reviews/S1-pen-recheck2.md`): 9 more, most from evicting visible atlas tiles where today's app holds the required set up to its hard budget; history changes during an open stroke (today cancels the stroke). Second checker run in progress; both go to S1 together, with the atlas corrected to today's model |
| S2t | typography: any weight, optical size, features, tracking through iced, cosmic-text and cryoglyph; bundled Inter replaces an installed static one; Chromium's baseline rounding; stylesheet fallback order (Segoe UI for Arabic and Hebrew, Microsoft YaHei UI for CJK, as Chromium); fonts ready before any text widget | **merged into `native-app` `47d2e9be`** | widths within 0.03 px of Chromium at 100/150 %, light and dark; GPT-6.1 Sol's four findings fixed (default ASCII shaping, a type-level font-readiness proof, features splitting runs, a fallback check that can fail) |
| S2c, S2d | ClearType-style subpixel text on Windows where Chromium draws it, Skia's dark-mode contrast curve, DirectWrite glyph masks with Skia's scaler choices on a worker | `t3/subpixel-text` `99ca6360` | done: ink error against Chromium's ClearType 0.010-0.021 for Inter (marks 0.052-0.116), 0.007-0.034 for Arabic, Hebrew and CJK, widths within 0.03 px; the interface thread never rasterizes. Review (GPT-6.1 Sol xhigh): 9 findings, the partial-text frames a blocker; the glyph worker's protocol (pending forever, unbounded, a lock the interface waits on, a fallback on the interface thread), Windows' explicit ClearType and smoothing-off settings. Fixing; one re-check after |
| S1-S6 | risk spike designs, in `perf/native/spikes/S*.md` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/spikes/reviews/`); briefs ready in `perf/briefs/native/` (S1, S2a fields, S2t typography, S2b text tool, S3 video), launched when N0 merges |
| Designs | docking, developer tools, Settings, in `perf/native/designs/` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/designs/reviews/`); decisions in `decisions-on-open-questions.md`; each implementation chunk first revises its design with the review into `docs/native/` |

Spike design findings so far: desktop video export already runs a bundled FFmpeg 7.1 sidecar (WebCodecs is the
browser's fallback only), so the native export runs the same FFmpeg with the same arguments and aims at identical bytes;
the pen reaches iced only as touch with pressure, so a `WM_POINTER` subclass reads pen history (tilt, eraser, barrel,
timestamps) into a ring; iced has no right-to-left layout, Tab order or focus ring, and its Windows IME is IMM32 only:
those are ours (`styk-design`, `styk-core`) plus a few small fork patches; Inter must be converted from WOFF2 to TTF.

**Next, in order.** After FP merges: chunk RM, the renderer's and engine's memory (`perf/briefs/native/RM-render-memory.md`: at 4K our export process holds 1.2 GiB next to the encoder's 0.7, against a 1.5 GiB total; a 256 MiB sprite atlas and a one-time 265 MiB renderer allocation among it). After S3 merges: compare the native `styk-cli video` export
with today's export of the same documents (FP's bytes are still not equal; sizes within 0.2 %). After the spikes pass: the
skeleton in ten chunks (`perf/briefs/native/skeleton-plan.md`): wave 1 K-doc (documents and the engine host), K-frames
(frame scheduling), K-cmd (commands and shortcuts), K-widgets-a (controls); wave 2 K-rec (recovery and autosave),
K-widgets-b (menus, popovers, dialogs), K-stage, then K-dock, K-shell, K-dev; then the skeleton gate. No interface work starts until S1 and S2a pass in a native window.

**Kept off the branches on purpose.** `t3/fix-save-differs` and `t3/resave-keeps-layout` change saved bytes: the owner's
decision, unmerged. `t3/speed-joint-drag-frame` is an unfinished optimisation with no measured gain: not this phase's.
The Electron-only leftovers of `t3/export-timeout-performance` (the keep-alive, `desktop/video-export-service.cjs`
timeouts, Electron benchmark rows) are not fixed in Electron; their problems are acceptance criteria for the native
export.

**Carried into later chunks** (found on the way; each is an acceptance criterion where it applies): the native app sets
`styk_alloc`'s memory limit from the machine (natively there is none, so engine reservations refuse nothing until it is
set: engine host chunk); export frames identical across runs (X2, `perf/native/findings/X2-browser-export-determinism.md`);
bounded export memory at 4K, with WebM alpha's VP9 encoder share a floor candidate (S3); no lock the interface thread can
wait on and a clean open of the 250 MB Pivot file (`perf/native/findings/LP-styk-wasm.md`); the movieclip enter/leave
leak (chunk M); AyameDemo's stale `total_output_frames` in the editor (`perf/native/findings/M-total-frames.md`); the
shell creates iced's wgpu instance from `styk_render::native_instance_descriptor()` (DX12 with FXC on Windows; a fork patch
if iced cannot take a descriptor), so the stage draws on the backend that matches today's frames (FP).

**Manual checks for the owner** (cannot be automated on this machine without touching the owner's screen or system,
decision N6): a pass with a real pen or tablet in the pen lab (developer build); a pass with real input methods (Microsoft
Japanese IME, Pinyin, the Arabic and Hebrew keyboards) in the component sheet's fields; the export's full-disk case; the shell's pass (`docs/native/shell.md`: the snap-layouts flyout and zones, Win+arrows and drag snapping, resize cursors, shadow and corners, pacing while the system moves the window, two monitors with mixed DPI and a top or left taskbar, restoring a maximized window, the real upgrade from today's installed app). Before the first native release: the update signing key ([N9](decisions/0009-signed-update-feed.md)).

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
7. **Localization** in every language (macOS, Linux and the web build are later ports, N8).
8. **Electron removed**, with the JavaScript interface; the docs pass, the final gate and the report.

Gates: the Rust workspace tests and the engine parity suites; the native smoke scenarios (open, edit, save, reopen,
export, recovery); the screenshot comparison; the full benchmark, native against today's app; while JavaScript remains,
`npm run check` and `npm test`.
