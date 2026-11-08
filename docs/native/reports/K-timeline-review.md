# K-timeline part 1 review follow-up

Review base: `436cda99`. Frozen fixtures and thresholds are unchanged.

## Reproductions

All commands use the machine queue, label T1. Baseline production code was unchanged
when the regression binaries were compiled; subsequent fixes do not alter those binaries.

- `timeline-review-baseline-core.log`: `14 passed; 1 failed` in `stage_surface`.
  Space left transport `Starting` while its real session seek worker was held.
  The final regression additionally enters `Playing` through a real rendered submission,
  holds the document lane before its next seek, and exercises both Space and Escape.
- `timeline-review-baseline-policy.log`: `12 passed; 3 failed; 1 ignored`.
  Ctrl-toggle produced `[]` instead of `["scene"]`; global Period reached tick 7 instead
  of 6; the stale ABA revert emitted a change instead of refusing it.
- `timeline-review-baseline-app.log`: `0 passed; 1 failed; 23 filtered out`.
  The production window installed three subscriptions instead of two while a document
  worker was pending. The regression also finishes opening through its real Progress stream.

## Independent fixes verified

- `timeline-review-fixed-core.log`: `stage_surface`: `15 passed; 0 failed`;
  `timeline_core`: `15 passed; 0 failed; 1 ignored` (the explicit save-oracle test).
- `timeline-review-app-serial.log`: `7 passed; 0 failed; 17 filtered out`.
  The preceding parallel app run passed the new test but its existing global engine-clock
  assertion read another test's zero. The serial run keeps those single-window fixtures isolated.
- `timeline-review-pause-mutation.log`: removing just the terminal pending-gate exception
  makes the strengthened, already-playing held-worker regression fail: `Buffering` instead
  of `Paused`, `0 passed; 1 failed`. The exception was restored afterwards.
- `timeline-review-final-settings.log`: `6 passed; 0 failed` through real LocalStorage,
  including final-drain sharing refusal, preservation of the last complete file, no later retry,
  ordinary backoff/retry, unknown fields, newer-schema refusal and legacy import.
- Self-check extended global navigation to a playhead already beyond the document end.
  `timeline-review-global-return-baseline.log`: `0 passed; 1 failed` (105 instead of 6).
  After clamping that path, `timeline-review-global-return-fixed.log`: `16 passed; 0 failed; 1 ignored`.
- The subscription regression now holds the document worker and feeds an actual redraw to the
  production recipes, checking emitted Frame messages rather than recipe count. It preserves
  consumed Progress messages and releases the worker to finish opening through the real handler.
  Restoring idle-based polling fails it (`timeline-review-redraw-mutation.log`: `0 passed; 1 failed`);
  the restored fix passes all app tests (`timeline-review-redraw-fixed.log`: `24 passed; 0 failed`).

## Pre-integration verification

While the required recovery merge was still absent from origin, the completed changes at
`0574e4be` ran through the queue (`T1 pre-integration verification`):

- `cargo build -p styk-app`: exit 0 (`timeline-review-build.log`).
- `cargo test -p styk-core -p styk-services -p styk-app -- --test-threads=1`:
  38 suites, **827 passed, 0 failed, 10 ignored**, exit 0 (`timeline-review-suites.log`).
- `cargo xtask check`: exit 0, including source/dependency guards, screenshot limits and
  app/preview parity (`timeline-review-check.log`). No frozen fixture or threshold changed.
- Queue result: `BUILD_EXIT=0 TEST_EXIT=0 GUARD_EXIT=0`.

These checks cover the independent fixes and Settings' maintenance API. They do not claim
that the recovery integration or the drafted real-quit regression has run yet.

## Recovery integration

The follow-up fetched `origin/native-app` at `680a064f859465da609a451d187c583a61b1a402`, containing
the published recovery merge `f1d97af6` and storage-load fix `7948bb11`. The merge preserves the
document host's quit fence and replaces the separate PrepareExit/ExitReady handshake with the
recorded quit order: panel/session settlement, documents, QuitReady, layout plus Settings drain,
placement, exit. Final maintenance passes the fence; input and deferred edits do not. Session
end cancels/detaches both preference lanes and retains the existing platform-derived bound.

`timeline-quit-regression.log`: **1 passed, 0 failed**, 2.23 s. The real App runtime and mounted
Discard button cover a dirty saved project with pending Settings and layout, successful drain,
Settings refusal, and session end while both transactions are held. Settings uses LocalStorage;
the layout adapter holds its existing transactional save. Unknown Settings fields and the last
complete files survive; Discard does not save the project; neither completion admits input.

`timeline-quit-mutation.log`: omitting only `flush_settings()` from App's quit order produces
**0 passed, 1 failed**, at “final Settings write starts through the quit fence: Timeout”. The
production call was restored. The harness uses the app's actual installed subscriptions and
the recovery harness's mounted deadline adapter, without synthetic progress ticks.

Self-check: done. Merge reconciliation keeps one message catalogue and overlay notice identity;
ordinary Settings flushes expedite the existing queue without activating layout's final-refusal
policy. Core document polling leaves refresh effects for the app's delivery adapter. The prior
beyond-end navigation and emitted-subscription checks remain. No frozen fixture or threshold changed.

Final queued verification (`T1 final quit verification`):

- `cargo build -p styk-app`: success (`timeline-quit-build.log`). The final poll-adapter
  self-check fix landed before the tests; the default app artifact was refreshed afterwards:
  `T1 final app artifact`, **exit 0**, 25.96 s (`timeline-quit-final-build.log`).
- `cargo test -p styk-core -p styk-ui -p styk-app -p styk-platform -- --test-threads=1`:
  **53 suites, 1,002 passed, 0 failed, 32 ignored** (`timeline-quit-suites.log`). This includes
  all 45 app unit tests, the real-quit regression restored after mutation, six real Settings-storage
  tests, the held-seek pause regression and the merged recovery/edit-fence tests.
- `cargo xtask check`: success (`timeline-quit-guard.log`), including source/dependency and
  clippy guards, screenshot limits and **57 identical app/preview PNGs**; two stage screens retain
  their documented app-only exemption. The combined queue command's final exit status was **0**.

## Decisions

- Retain stop cleanup on the existing session call queue. This avoids a second settlement
  owner and keeps stop immediate while the exclusive session is unavailable.
- Global Advanced frame actions preserve selection; focused timeline actions retain cell
  movement. Simple mode still selects exposure cards, matching `src/app.mjs`.
- Mutation identity is local to each setting and uses allocation identity, with no wrapping
  counter or on-disk change. An unrelated setting cannot invalidate a valid revert.
- Automation readiness remains separate from redraw scheduling. A running script uses its
  existing finite frame-settlement steps only once workers are ready; pending work wakes
  through Progress.
- Ready-session pause keeps its existing immediate finish. Only an unavailable session queues
  cleanup: the existing playback/fit test caught and prevented an unnecessary asynchronous delay.
- Run app unit fixtures serially because they share the process's single engine clock; do not
  change its assertion, sleep or threshold to hide parallel interference.
- Use the recovery quit contract's existing policy for Settings: after document clearance,
  final persistence refusal safely abandons the proposal; session end detaches immediately.
  Ordinary preference saves retain their retry policy.
- Retain only a coalesced pre-admission quit intent while panel/session work settles; recovery
  and Documents remain the sole owners of confirmation, clearance and the final edit fence.
- Use the existing native catalogue and overlay identity owner after the merge; remove the
  timeline's earlier separate catalogue and notice counter.
- Keep personal preference services absent in screens, scripts and unattended runs, matching
  recovery's isolation. Tests supply their own storage and consume the real subscriptions.
