# V0: visible editing loop

Base: `c76127388cd636474e6bee2cc7e283f77a31bb6a` (`origin/native-app`).
Implementation head: `bee73dda4051f3ef80382a33a75495276b6c6621` on `t3/native-v0-visible-loop`.
The subsequent commit contains this verification report only; no code changed after the checks.

## Gaps and owners

- Queued command-line opens had no wake. `TopBand::open_all` now notifies the existing document pump; the mounted runtime test opens without synthetic redraw/poll events. The recovery restore test also checks stage attachment and Properties.
- Stage presses stopped at `Core::stage_event`. The new bounded `styk_core::tools` Select lane uses existing pickers and the session selection. Figure, joint, empty, cancellation and supersession tests cover it.
- The new pick caller initially projected the query twice. It now supplies document coordinates, matching the existing picker contract. The fitted/panned regression and the real fitted stage reject the original call.
- The UI adapter discarded `RequestFrame`. It now schedules document publication, and the band refreshes history through the same pump. The mounted number test asserts that task before consuming unrelated worker events.
- Swatches had no service continuation, and Properties read the base figure after an instance colour edit. Solid figure/joint colours now use session commands; the facts worker supplies resolved instance styles. Core and mounted tests check colour, history, undo and reopen.
- Facts were keyed by tab ID/revision without lineage. Closing the last tab can reuse both; lineage now participates in requests and result adoption. A replacement-document regression checks the displayed colour.
- Resolving instance styles initially held the previous selection's layout while loading. The current context now builds immediately with pending controls. The existing multi-selection Inspector test exposed the regression and keeps its original expectation (`tmp/v0-inspector-pending-red.log`).
- File commands and immediate picker effects had no app path. Core routes them to Documents, the existing overlay menu exposes them, and Windows pickers implement the asynchronous service. Tests cover save/reopen, cancelled/failed/stale answers, switching and closing.
- Picker replies bypassed the normal per-dispatch session-report reset. They now start a fresh report, so obsolete replies cannot replay clipboard/session events; a dedicated regression checks this boundary.
- Off-screen posted clicks were erased by Windows MouseLeave before iced processed the batch. An unattended-only window subclass preserves the scripted cursor; it never moves the desktop pointer and removes itself at window destruction. Real-window checks exercise mounted controls.
- Automation previously sampled a pending stage. It now waits for the current picture to be ready before advancing or capturing.
- Final visual inspection exposed a capture of the previous figure panel while the renderer held a new joint panel for glyph preparation. The automation now uses the existing glyph-readiness gate and restarts its unchanged settling interval after an incomplete frame. The window script also asserts joint length 78, and the core selection regression checks the Joint model explicitly.
- A tab's release could arrive in the press's OS batch before its tracking subscription existed. The always-mounted raw adapter now ends that press; tab activation also schedules publication. The mounted subscription regression and real-window switch/close steps cover it.

## Verification

All builds, tests and the app run use the machine queue. Frozen fixtures and screenshot limits are unchanged.

- App build: `Finished dev profile [optimized] target(s) in 40.83s` (exit 0, `tmp/v0-build-final.log`).
- Required core/UI/app/services suites: exit 0, **1004 passed, 0 failed, 12 ignored** across their final runs. Per crate: core 707/0/11, UI 70/0/1, app 56/0/0, services 171/0/0 (passed/failed/ignored). Core/UI/services results are in `tmp/v0-required-tests.log`; the final app rerun is in `tmp/v0-app-final.log`. Existing ignored tests are unchanged.
- Final core loop: `test result: ok. 10 passed; 0 failed; 0 ignored` (`tmp/v0-loop-final.log`), including the strengthened joint model/length assertion. Final app units: `test result: ok. 50 passed; 0 failed; 0 ignored`, including the three mounted loop tests and glyph-capture regression; app integration: `test result: ok. 6 passed; 0 failed; 0 ignored`.
- Extended platform suite: exit 101, **188 passed, 1 failed, 23 ignored** in aggregate (`tmp/v0-platform-tests.log`). Its only failure is the base-reproduced memory-region diagnostic described below; audio, file, recovery and session integration tests pass with the existing encoder bundle.
- Changed-crate clippy, all targets: `Finished dev profile [optimized] target(s) in 30.42s` (exit 0, `tmp/v0-clippy-verified.log`); after the final app-only capture fix, app clippy: `Finished dev profile [optimized] target(s) in 16.63s` (exit 0, `tmp/v0-clippy-final.log`). Existing repository warnings remain; none points to an added V0 module.
- Native guard: `V0 guard-final exit 0` (`tmp/v0-glyph-capture.log`, details in `tmp/v0-guard-final.log`). Dependency/source/interface guards pass; `screenshots: active, 58 references (59 catalogue screens)`, all within unchanged limits. Preview parity: 57 identical PNGs (zero differing pixels); two stage screens are app-only by contract.
- Real off-screen window: `V0 window-final exit 0` (`tmp/v0-glyph-capture.log`); all script assertions passed. The stage moves from X 480 to 520, Undo restores it, Redo reapplies it, colour becomes DC3C3C, and saved/reopened/switched/closed states retain it. All eleven final PNGs match the previously visually inspected good captures byte-for-byte; the final joint capture was also reinspected and shows Torso/78 px.
- Removed-wire checks: open wake, same-batch tab release, fitted pick projection, frame-publication adapter, facts lineage, picker dispatch reset and glyph capture readiness each produced `test result: FAILED. 0 passed; 1 failed` (exit 101). Each failed at its intended behavioral assertion. Restoring the files was byte-for-byte; the passing checks run on the restored implementation. Logs: `tmp/v0-red-{open-wake,tab-release,pick-projection,frame-adapter,facts-lineage,dialog-report,glyph-capture}.log`.
- Earlier fail-first evidence: the original unrouted press stranded selection (`tmp/v0-selection-red.log`); the original base-figure swatch stayed blue after the colour command (`tmp/v0-colour.log`).
- `git diff --check`: exit 0. No frozen fixtures, limits, published history or private documents changed.

## Captures

PrintWindow captures from the real off-screen app, in `artifacts/native-v0/`:

1. `01-open.png` — command-line repository fixture, fitted stage.
2. `02-figure.png` — figure selected after clearing selection.
3. `03-joint.png` — selected joint and its Properties.
4. `04-edited.png` — mounted root X field committed to 520, one undo entry.
5. `05-undo.png` — band Undo restores X 480.
6. `06-redo.png` — band Redo restores X 520.
7. `07-colour.png` — solid figure colour changed, second undo entry.
8. `08-saved.png` — Save As completed, clean document.
9. `09-reopened.png` — saved bytes reopened through the band's Open menu.
10. `10-switched.png` — original tab restored to the front.
11. `11-closed.png` — reopened tab closed, original stage and Properties retained.

The earlier held-frame failure is retained as `03-joint-before-property-assertion.png`; it is diagnostic evidence, not one of the eleven final captures.

## Decisions

- The explicit autonomous instruction overrides the common plan-review pause; the plan was committed first without waiting.
- Existing views are reused. Windows common file/solid-colour dialogs supply the service boundary for this slice; full paint/menu views, gradients, selection decorations, dragging and marquee remain later work.
- Untitled close/quit Save availability remains the existing recovery contract. Save or Save As establishes a target before closing; no recovery/quit protocol was broadened.
- Real-window automation drives mounted widgets with window-addressed mouse/key messages and toolkit focus operations. File/colour answers are injected at the service boundary because unattended runs must not open desktop dialogs. Interactive Windows dialogs were compiled, not exercised visibly.
- The existing alpha-aware artwork picker is reused through an optional engine-only `styk-export` dependency; no external dependency was added.
- Native checks replace Electron/browser gate runs as native-common requires. No performance claim or threshold change is made.
- `CHANGELOG.md`, `docs/RUST-ENGINE-PORT.md` and `docs/native/README.md` remain untouched because native-common reserves them for the orchestrator; the V0 contract and report carry this chunk's documentation.
- The inventory generator ran; its six unrelated browser inventory errors remain: three removed modules still listed (`desktop/export-destinations.cjs`, `src/export-guard.mjs`, `src/source-record.mjs`) and three unlisted modules (`src/figure-types.mjs`, `src/lazy-table.mjs`, `desktop/page-pushes.cjs`). Generated V0 rows are updated without changing those contracts.
- Commits use the requested Alessio author/committer identity; the unrelated coauthor template was not attributed to this work.
- Document-free registry/overlay tests formerly used Save and Menu as unimplemented-action sentinels. They now use the still-unimplemented Export command, preserving the identity, focus and deadline assertions; Save and Menu are covered through the real document host and real-window save/reopen. These tests are not frozen fixtures.
- The changed-crate suite is run with `--test-threads=1`: the existing process-global app engine clock races between parallel tests (the deadline test observed 160 instead of 2200 in `tmp/v0-parallel-clock.log`). No assertion, production clock or timing threshold was changed.
- The extended platform suite's memory-region diagnostic also fails on the exact base platform sources: `test result: FAILED. 138 passed; 1 failed; 5 ignored` (`tmp/v0-platform-base.log`), classifying a thread stack as `private_unknown`. This unchanged diagnostics issue is outside V0; no expectation or threshold was relaxed. The final platform rerun is recorded separately from the required core/UI/app suites.
- FFmpeg-dependent platform tests require the ignored bundled encoder. The existing repository bundle was copied into this checkout's `build/video-encoder/ffmpeg.exe`; no tool was installed or upgraded.

Self-check: done. The whole diff was reviewed against the native Known findings: fixed unowned messages/missing wakes, same-batch terminal release loss, incomplete facts identity, stale editable instance values, pending context layout, per-dispatch report leakage and capture of a held glyph frame. Worker work and queues remain bounded; selection/history/save stay with their existing owners; mounted wiring tests reject removed wires; cancellation and stale answers settle without applying obsolete edits. No frozen fixture, threshold, private document or unrelated source was changed. Completed V0 probe scripts are removed; logs, captures, the build folder, encoder bundle and dependency junction remain for review.
