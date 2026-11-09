# V0 review fixes

Implementation: `da46a5d0162df643894d3d18df5a682f98f024ef` on `t3/native-v0-visible-loop`, after merging `origin/native-app` at `924708fd` in `315b45e0`.
Status: complete. Full suites, clippy, native guard, shipping features, real-window interaction and all regression probes passed.
This report supersedes the colour, untitled-close and serial-test decisions in the original V0 report.
Conflicts: `styk-core/src/app.rs`, `styk-core/src/commands/metadata.rs`, `styk-ui/src/message.rs`; retained Files and Developer routing and the idle-wake changes.

## Findings and regression evidence

| Item | Fix and test |
| --- | --- |
| 0 | Removed `inspector/color.rs`, native colour requests/answers, swatch continuation and script colour step. Resolved instance facts, lineage and pending-context rebuild remain. Source search and the existing Inspector/facts tests cover the retained paths. |
| 1 | Surface forwards terminal cancellation before pick adoption, with pointer identity; overflow cancels the current press. Production InputQueue interruption/overflow and unrelated-pointer tests cover both routes. |
| 2 | Each Select job has cancellation observed in evaluation, geometry, artwork reads and raster work. Worker shutdown owns disposal; one submitted job and one lightweight waiting press remain bounded. The slow artwork-miss test checks cancel/teardown and worker-thread disposal; checked-output tests reject partial results and compare uncancelled bytes. |
| 3 | Recovery's immediate effects reach Core's shared consumer. Untitled Close/Quit Save uses the file picker; cancellation restores the same answerable prompt and unchanged document. Close/quit Save fences edits through completion. Tests save, reopen the bytes, close/quit, cancel and retry Save. |
| 4 | Picker runs register with the owner window lifetime; destruction, quit and session end cancel them. No app HWND reaches the modal worker, whose hook closes its own dialog. Token and real message-only-window tests reject late results and new runs after destruction. |
| 5 | The module and every input caller use the shared `devtools` feature. Numeric entry now checks the unattended-window guard too. An isolated child test checks both entry guards; shipping feature resolution checks the default graph. |
| 6 | Open uses all six localized desktop filters, including `.stk`, `.stkz`, `.stykmov` and alternate filters. English/Italian list tests and the native UTF-16 terminator test cover the request and Windows adapter. |
| 7 | Picking accepts only boolean `true` as a saved lock and excludes layers outside the document/lineage focus lock. Production-query tests cover truthy non-booleans; runtime tests cover focused and unfocused layers. |
| 8 | App, engine, document and session capture the injected clock per instance. Two parallel app instances assert independent times; all suites use the queue-default parallel test harness (`RUST_TEST_THREADS=4`), with no serial override. |

The full parallel suite exposed a Properties facts retry loop while a checkpoint held publication. `ed250a7c` retries an unpublished key only when its publication receipt changes, including a receipt arriving before the old reply is consumed. The new ordering regression and the mounted stalled-checkpoint regression both passed; their original idle/hang bounds are unchanged. Core also retires deadlines after session expiry. Non-frozen tests that expected untitled Save to be unavailable now exercise the enabled picker and its cancellation.

## Verification

The combined queued verification uses default parallel execution (`RUST_TEST_THREADS=4` from the queue, no serial override). The following full 11-package run returned **0**; final harness summaries are counted once per target, excluding nested child-process summaries. Log: `tmp/v0-review-finishline-suites.log`; counts: `tmp/v0-review-finishline-counts.json`.

| Suite | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| styk-app | 84 | 0 | 0 |
| styk-core | 723 | 0 | 11 |
| styk-edit | 519 | 0 | 0 |
| styk-engine | 197 | 0 | 2 |
| styk-eval | 257 | 0 | 3 |
| styk-export | 54 | 0 | 0 |
| styk-formats | 55 | 0 | 0 |
| styk-platform | 201 | 0 | 23 |
| styk-raster | 36 | 0 | 0 |
| styk-services | 172 | 0 | 0 |
| styk-ui | 70 | 0 | 1 |
| **Total** | **2368** | **0** | **40** |

Clippy on the same 11 packages, all targets: **exit 0**, `Finished dev profile [optimized] target(s) in 54.64s`; existing warnings remain. Shipping features: **exit 0**, app **885 resolved entries**, CLI **397 resolved entries**, both clean on `x86_64-pc-windows-msvc` with default features and normal/build edges. Logs: `tmp/v0-review-finishline-clippy.log`, `tmp/v0-review-finishline-shipping-features.log`.

`cargo xtask check`: **exit 0**. **68** screenshot comparisons stayed within existing limits (largest differing-pixel fraction **0.036473214**, its limit **0.039**); **57** app/preview pairs had identical PNG bytes; two engine-rendered stage cases are app-only as specified by the guard. Ten developer-screen comparisons were included. Developer app build: **exit 0**. Logs: `tmp/v0-review-finishline-guard.log`, `tmp/v0-review-finishline-dev-build.log`; score summary: `tmp/v0-review-screen-evidence.json`.

Real-window interaction: **exit 0**, all assertions passed: fixture open, empty/figure/joint selection, numeric X **480 -> 520**, undo **480**, redo **520**, save, reopen with history **0**, switch and close the second tab. All ten PrintWindow captures were inspected; the figure position, Properties values, dirty state and tabs agree. Log: `tmp/v0-review-session-proof-real-window.log`; hashes/dimensions: `tmp/v0-review-captures.json`.

The earlier window attempt failed because the harness output directory was absent; creating the task-owned directory fixed the harness, without changing the app or script. The terminal-deadline removal probe initially had no pending UI timer, then its strengthened test hit a borrow-check error; both are retained, not counted as regression proof. The final focused proof supersedes those attempts: removing the guard failed at the mounted wake assertion (`expired session end must not publish another window wake`, **exit 101**); restored source passed (**1 passed, 0 failed**, **exit 0**). Earlier suite failures and interrupted compilations are also retained as evidence, not counted as passes.

**24 negative checks confirmed their intended failures**, with every source mutation restored byte-for-byte. Behavioral probes returned **101** with failing test assertions; default-feature contamination returned **1**. The per-route test names, exit statuses and logs are in `tmp/v0-review-negative-evidence.json`: open wake, tab release, fitted projection, frame adapter, facts lineage, fresh dialog report, glyph capture, pen cancellation, overflow cancellation, job cancellation, Save consumer, prompt restoration, owner destruction, owner quit, numeric-entry guard, shipping feature contamination, filters, strict lock, focus lock, instance clock, unpublished-facts retry, preview publication, pause registration and terminal deadlines. Positive coverage is in the full suites and `tmp/v0-review-session-proof-session-restored.log`.

The parallel rerun exposed two additional paths: catalogue/test publications bypass the normal document-host receipt, and MemoryStorage could release a pause between observing it and registering its waker. Preview publications now expose an atomic receipt through FrameDocument; the fake storage rechecks its pause under the registration lock and schedules a retry if release already happened. Existing Inspector/core/UI interaction tests cover the former; a new ordering regression and the unchanged developer-panel test cover the latter.

The session-end test now mounts the wake widget after expiration with a live UI timer pending. This proves the terminal deadline route rather than relying on an already idle overlay. No test timing or iteration bound changed.

No frozen fixtures, screenshot limits, parity thresholds, private documents or reserved release files changed. The inventory generator reported six pre-existing browser inventory errors; `tmp/v0-review-inventory.log` records them.

## Development feature

The feature is **`devtools`**, reusing the existing developer-tools feature. `styk-app/devtools` enables core, platform and developer UI/tracing; core and platform forward `styk-services/devtools`. A participating crate adds `dependency-name/devtools` to its own `devtools` feature; builds opt in with `--features devtools`. There is no automation-only flag.

## Captures

The number-only real-window script passed and wrote these inspected PrintWindow captures to `artifacts/native-v0-review/`: `01-open.png`, `02-figure.png`, `03-joint.png`, `04-edited.png`, `05-undo.png`, `06-redo.png`, `07-saved.png`, `08-reopened.png`, `09-switched.png`, `10-closed.png`.

## Decisions

- The latest merge instruction takes precedence over the initial fresh-checkout reset; existing V0 commits are preserved. Colour commit/picker ownership stays with B1/B3.
- Reused `devtools` across crates for G1. A1 receives `ViewState::set_layer_focus_lock(document, lineage, focused)`; V0 adds no layer-focus controls.
- Native dialog workers own their modal windows without borrowing the app HWND. Unattended interaction supplies file answers at the service boundary; actual OS chooser visibility is not exercised. Cancellation is cooperative between work units; third-party codec primitives are not forcibly preempted.
- Final checks were batched, then interrupted to protect disk reserve while other worktrees were also building. Machine free space fell below 15 GB even after this run's compilers stopped. Only this run's processes were stopped. Cargo package cleanup and local cache compression restored headroom; the final restart disables incremental caches (`CARGO_INCREMENTAL=0`) while retaining the ordinary dev/test optimization and queue-default parallel harness; direct cache deletion was automatically rejected, with no deletion from those commands. The other worktrees and shared dependency store were untouched.
- Native Rust checks replace Electron/browser runs under native-common. Required catalogue guards retain their built-in headless renderer; the real-window interaction uses `STYK_BACKGROUND_WINDOW=1` and PrintWindow, with no desktop capture or injected input. Reserved release documents remain unchanged. The inventory generator's six existing browser inventory errors remain outside this native fix round.
- Updated only non-frozen obsolete Save expectations because untitled Save is now supported. Publication receipts include catalogue sources because those bypass the document host. The fake-storage ordering fix addresses the parallel wake timeout without increasing any bound. The missing output folder was a harness error; the unchanged script passed after creating its task-owned destination.
- No new performance claim or tuned timing bound; tests prove cancellation by ordering with hang guards. The build folder, encoder bundle, dependency junction and evidence logs remain for review; temporary probe scripts are removed. Final free disk space was 44.3 GiB when checked. Nothing is pushed.

Self-check: done. Additional findings fixed and tested: unpublished-facts retry loop, terminal deadlines surviving session expiry, preview publication receipts and the fake-storage pause-registration race. Final diff has no frozen-file edits, threshold changes, leftover probe mutations or unrelated changes.
Identity: `79365152+filippocalippo@users.noreply.github.com 79365152+filippocalippo@users.noreply.github.com` for author and committer throughout this branch's V0 commits.
