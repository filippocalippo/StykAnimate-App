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

**The owner's second decision of 2026-11-07, with its final rules** ([N8](decisions/0008-windows-only-review-by-risk.md)):
Windows only (the architecture stays portable). GPT-6 Astra implements back-end and logic, Sonnet the screens, one Opus
implementer the reference slice (the interface architecture and the Inspector, `docs/native/patterns.md`); GPT-6.1 Sol is
the only reviewer, by risk; logic stays out of the views; `cargo xtask check` guards the rules. In-flight chunks finish with
no new review round unless a finding is a blocker.

**In flight.**

| Chunk | What | Where | State |
| --- | --- | --- | --- |
| Gate b13 | local `engine-rust` `99c62189` (two merges never run together) | `perf/batches/b13/` | **passed and pushed**: check, `npm test` 2705/2705, Rust workspace, parity, web, every smoke (the video smoke needed the bundled encoder copied into the gate checkout). Benchmark deferred to the cleanup batch (one exclusive run after M, D, X) |
| M | movieclip saves that reopen, nested clips, clip copies reserved, the store lock that never waits on a page thread | **merged into `native-app` `7d3266c1`** | three GPT rounds; on the merged tree 1,071 Rust tests, 63 JavaScript, `engine:parity` ok |
| M2 | refused saves found by a drawing-publishing fuzz (seeds 62 and 132 fixed; 403, 408), the fuzz as a bounded regression | **merged into `native-app` `06644f8b`** | a drawing cel keeps its one image through every edit (checked after the edit, so a flip or a length change today allows still works), import and paste refuse a damaged cel at the commit, and damaged cels from earlier saves open repaired (in movieclips and retained scenes too); `scripts/fuzz-movieclips-docs.mjs --regression`: 11 seeds in 34 s with a deadline; 1,167 Rust tests, parity, 70 JavaScript |
| D | drawing-undo atlas work, its compile fix, the polygon cache removed | **merged into `native-app` `7881b55b`** | review fixes: a refused replacement decode blanks the places it reused (lazily, within the renderer's budget) and leaves none waiting, on the stage and in exports (resident exports through X's `clear_cel`, once); decoded bounds and ink shared by every view of a tile payload; dedup across the whole list. 547 tests of six crates; parity at the next gate |
| S4 | audio: the mixer ported line for line (document order, f32 per clip), FFmpeg decoding as today, one 768 MiB decoded budget, a lock-free stream clock the frames follow, WASAPI output, scrub, the export's offline mixer | **merged into `native-app` `c33a9369`** | the mixer bit-identical to today's at every chunk size; the review's seven findings fixed; the interface side of preparation nonblocking (one-slot atomic handoffs, cancel by the job's token); tasks through `styk_services::Spawner`; real device 1.69 ms from loopback, 0 underruns, scrub first sound 6-8.5 ms. Behaviour: after an underrun the clock reads Starting until the next heard frame. Note for the timeline chunk: open the device on a job thread |
| S6 | the shell: frameless chrome, snap layouts, DPI, window state per monitor setup, single instance, associations with today's ProgIDs, the updater, the installer | **merged into `native-app` `06b0c9fe`** | the chrome subclass (snap layouts, registered with the input subclass chain), restore in screen coordinates, single instance over a current-user pipe (identification level, server checked), today's ProgIDs and the `stykanimate` link, the signed updater (N9) verified through one handle, an NSIS installer whose uninstaller removes only its manifest's files and never through a link, today's uninstaller run only on a validated record (threat model N10); 13 sandboxed installer tests, `--shell-check` 24. Owner's manual pass: snap flyout, real monitors, UAC, the real upgrade. Before packaging: vendor the NSIS plugins now taken from electron-builder's cache |
| LP | the 250 MB Pivot file natively (opens, memory released: the browser's held gigabyte is the WebAssembly allocator's high-water mark); the padded `.piv` export (`Codec::export_tree` from the tree, bytes equal to the service's, reserving 4x the retained bytes first) | **merged into `native-app` `fcf2d21a`** | saved bytes equal the codec's route (signed zero, NaN and infinity normalised as its JSON does); the digest hashes in 1 MiB pieces (it expanded shared values per occurrence); export memory checked as it grows through `Reservation::overrun` and the native `styk_alloc::Counting` allocator, which `styk-app` installs (K-doc); cancel seen in 0.2 ms; the 256 MiB payload limit is today's |
| X | export frames independent of export order, picture and cel residency in exports | **merged into `native-app` `3961a119`** | the cause was the lone-glyph mask atlas (now placed afresh per export frame); review fixes: a refused cel decode is blank, the glyph atlas resets its layers on a page-size change, a stale decode attempt never touches a newer one, a dropped export releases what landed. Checked natively: four documents, 1080p and 4K, whole layout and paged, every order identical to alone |
| FP | the native renderer draws today's frames (native wgpu against Chromium's WebGPU on the same document and tick: S3 found sub-level differences, PSNR 66-68 dB) | **merged into `native-app` `99328d21`** | the clip position equal on every backend (`fma` after the division; a cross-backend raster test fails on the old shader: 8 of 280,000 pixels differ between DX12 with FXC and Vulkan); `styk_render::native_gpu` prefers DX12 with FXC and falls back; the CPU rasterizer bit-identical in WebAssembly and natively. Floor recorded (below) |
| S5 | the web build of the native app | **merged into `native-app` `0012d378`** (the design only) | stopped (N8): `docs/native/web.md` keeps the design and 14 binding constraints on today's code; the spike's code is on the local branch `spike/s5-web-code` (`8dbd68bf`), unmerged |
| X2 | tdd2 ticks 183-188 differ between identical runs of the browser export (two hashes recur per tick) | stopped (N5): browser-side; notes in `perf/native/findings/X2-browser-export-determinism.md`; native criterion: identical frames across runs |
| I | the inventory | `docs/native/INVENTORY.md` | done: 1,270 rows, all todo; regenerate the appendices with `perf/native/tools/` |
| N0 | the foundation: vendored iced and its git dependencies, the nine crates, the off-screen window (headless where a window cannot be hidden), PrintWindow screenshots, tokens (460 colours equal to Chromium's; dynamic geometry as functions), icons, Inter 4.001 and Inter Tight 3.004 | **merged into `native-app` `59a39d7c`** | reviewed by GPT-6.1 Sol, findings fixed. Empty window 197 MB private (target 150), start to first PNG about 0.9 s (directional) |
| S2a | fields, focus, input methods, right to left: focus scopes with restoration and F6, the text-entry hotkey gate, roving, field roles, bounded coalesced field history, intake limits before mutation, clipboard replies tied to their request, RTL geometry; the component sheet and the screen catalogue | **merged into `native-app` `546bdeea`** | caret sequences equal Chromium's, lam-alef inserts both scalars; no limits beyond each field's own `maxlength` (a field without one takes 65,536 characters, so a paste is bounded work: a named difference); long paragraphs fast through a shaped-run cache and two small cosmic-text patches (a 16,300-character line types at p50 13.4 ms, p95 15.8 ms). Real IME: the owner's manual check (N7) |
| S2b | the text tool compiler (a line-for-line port of the opentype.js paths) and the font service | **merged into `native-app` `5e7b3cd3`** | figure JSON byte-equal to today's (73 fixture steps, 507 over 169 installed fonts, 10,647 in the checker's own sweep); NFC pinned to Unicode 15.1 (Electron 39's ICU 74.2, swept over the whole BMP); saves equal; 207 faces in today's order in 65 ms (today about 170 ms warm); nine review findings fixed, eight shown failing first |
| S3 | native video export, headless: the same FFmpeg with the same arguments and today's PNG frames, the VFW helper, staging and commit, cancellation that wakes every wait, no timer | **merged into `native-app` `bf24de2c`** | byte-identical to today's in 70 cases (WebM only in its random track UIDs), VFW equal, translucent WebM a test; cancel at every stage in milliseconds, the flush on a helper (today renames without flushing; the native flush is kept, a cancel never waits for it); children created suspended in their kill-on-close job; kept videos marked for the sweep; GPU disposal and the GPU wait on native-only helper threads. 4K memory: the renderer's share goes to RM. Left for K-guards: `styk-cli/src/win.rs` (a measurement tool) into `styk-platform` |
| S1 | pen input: WM_POINTER subclass with history, promotion by provenance, lifecycle events, bounded queue keeping terminal events, today's stroke rules in `styk-core::drawing`, dabs on the drawing worker, wet ink retired in the frame its tiles upload, the pen lab (developer build) | **merged into `native-app` `64a6f912`** | every review and checker finding fixed (the atlas on today's memory model: visible tiles and the staged batch held up to 4 pages, only out-of-view tiles evicted; a history change cancels the open stroke; refusals roll back; no extra preview overlap); the drawing worker through `styk_services::Spawner` and the injected clock; one `styk-platform::input` owner (S2a's IME, the pen subclass, one subclass id registry). Known: atlas pages never given back (memory work), ink drawn out of view blank for a fetch round trip when the view reaches it (Draw workspace). Real pen: the owner's manual check |
| S2t | typography: any weight, optical size, features, tracking through iced, cosmic-text and cryoglyph; bundled Inter replaces an installed static one; Chromium's baseline rounding; stylesheet fallback order (Segoe UI for Arabic and Hebrew, Microsoft YaHei UI for CJK, as Chromium); fonts ready before any text widget | **merged into `native-app` `47d2e9be`** | widths within 0.03 px of Chromium at 100/150 %, light and dark; GPT-6.1 Sol's four findings fixed (default ASCII shaping, a type-level font-readiness proof, features splitting runs, a fallback check that can fail) |
| S2c, S2d | ClearType-style subpixel text on Windows where Chromium draws it, Skia's dark-mode contrast curve, DirectWrite glyph masks with Skia's scaler choices on a worker | **merged into `native-app` `7b650edb`** | ink error against Chromium's ClearType 0.010-0.021 (marks 0.052-0.116); no frame is ever shown with a glyph missing (no deadline: the last complete frame is held, retried every 8 ms, as Chromium waits for raster); the repertoire prepared before readiness (no font lock shared with the interface); a glyph consumer per window; masks reserved in a 16 MB budget before allocation; a `Suboptimal` texture presented, no acquire without present; Chromium's precedence for smoothing off and ClearType settings. Known: `font_gate` failed once on a loaded machine and passed six runs since |
| S1-S6 | risk spike designs, in `perf/native/spikes/S*.md` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/spikes/reviews/`); briefs ready in `perf/briefs/native/` (S1, S2a fields, S2t typography, S2b text tool, S3 video), launched when N0 merges |
| Designs | docking, developer tools, Settings, in `perf/native/designs/` | Sonnet, then GPT-6.1 Sol | reviewed, every finding accepted (`perf/native/designs/reviews/`); decisions in `decisions-on-open-questions.md`; each implementation chunk first revises its design with the review into `docs/native/` |

Spike design findings so far: desktop video export already runs a bundled FFmpeg 7.1 sidecar (WebCodecs is the
browser's fallback only), so the native export runs the same FFmpeg with the same arguments and aims at identical bytes;
the pen reaches iced only as touch with pressure, so a `WM_POINTER` subclass reads pen history (tilt, eraser, barrel,
timestamps) into a ring; iced has no right-to-left layout, Tab order or focus ring, and its Windows IME is IMM32 only:
those are ours (`styk-design`, `styk-core`) plus a few small fork patches; Inter must be converted from WOFF2 to TTF.

**Next, in order.** After FP merges: chunk RM, the renderer's and engine's memory (`perf/briefs/native/RM-render-memory.md`: at 4K our export process holds 1.2 GiB next to the encoder's 0.7, against a 1.5 GiB total; a 256 MiB sprite atlas and a one-time 265 MiB renderer allocation among it). After S3 merges: compare the native `styk-cli video` export
with today's export of the same documents (FP's bytes are still not equal; sizes within 0.2 %). After the spikes pass: the
skeleton (`perf/briefs/native/skeleton-plan.md`, implementers by N8): K-guards (Astra: the guards of `cargo xtask check`)
done at `3b1d3b09` (eight guards with 16 failing fixtures, the tree at zero, warm check 4.7 s); review: seven ways a mistake slips through (macros, blocking through traits, re-exports, test-like names, a self-approving allow list, qualified clocks) and the pen lab's blocking self-test; fixing, with the engine types the core passes on gathered in `styk_core::engine`, K-doc (Astra: documents and the engine host; milestone 1, the session seam of
`docs/native/documents.md`, **merged `bd9e9d2a`**; the rest running) and R-slice (the one Opus implementer: the interface
architecture and the Inspector, `patterns.md`; started on `bd9e9d2a`), K-shell (Sonnet: the window and the top band, `perf/briefs/native/K-shell.md`) started on `06b0c9fe`; running too: K-frames (Astra xhigh, frame scheduling; done at `e1eb652c`: the engine's `produce` now goes through the shared `frame_builder`, CPU readiness 1.2-1.4 ms first frame and 0.93 ms move p95 on svr_uriel and tdd2; review: lookahead evicts the nearest frames, interface-side readiness compares dense keys, the parity tests miss effect parameters; fixing, parity to report) and K-dev (Astra high, the developer
tools' engine, `perf/briefs/native/K-dev-engine.md`); then K-rec, K-cmd, K-widgets,
K-dock, K-stage; then the skeleton gate. No interface work starts until S1 and S2a pass in a native window.

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
shell creates iced's wgpu instance from `styk_render::native_gpu`'s choice (DX12 with FXC preferred on Windows; a fork
patch if iced cannot take one), so the stage draws on the backend that matches today's frames (FP).

**Manual checks for the owner** (cannot be automated on this machine without touching the owner's screen or system,
decision N6): a pass with a real pen or tablet in the pen lab (developer build); a pass with real input methods (Microsoft
Japanese IME, Pinyin, the Arabic and Hebrew keyboards) in the component sheet's fields; the export's full-disk case; the shell's pass (`docs/native/shell.md`: the snap-layouts flyout and zones, Win+arrows and drag snapping, resize cursors, shadow and corners, pacing while the system moves the window, two monitors with mixed DPI and a top or left taskbar, restoring a maximized window, the real upgrade from today's installed app). Before the first native release: the update signing key ([N9](decisions/0009-signed-update-feed.md)).

**Numbers.** None measured on the native app yet. Today's app: batch 12 in `docs/RUST-ENGINE-PORT.md`; the prototype's
numbers in `perf/native-ui-test-*.txt` (outside the repository).

**Floors recorded.** Frames (FP, `docs/native/frame-parity.md`): 1,286 of 21,120,000 pixels over nine document sets
(0.006 %) differ from today's, all by one level but two, the same in two runs of today's app (stable, not the reference's
own variation); only analytic strokes (lines, arcs, outlines, hairlines) and gradients, where both stacks compute equal
radii and widths and the coverage differs in the last bits; polygon fills, discs, boxes, pictures and text equal. Attempts:
about 50 arithmetic variants, position from the fragment coordinate, shader resolves (worse), Dawn's resolve toggle
(no change); equal sample sums rule the resolve out. Consequence: exported MP4 bytes are not equal to today's (sizes
within 0.2 %).

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
