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

## Integration prerequisite still absent

The final fetch still resolves `origin/native-app` to `2e63867812761407fdc8b2d5c5ae80b5957b9792`.
`git log origin/native-app --oneline --grep='Merge K-rec views'` returns no match. Its handoff
records that the recovery merge was withdrawn before push. No withdrawn or unpublished recovery
commit was merged into this branch. Finding 2 therefore remains open: the Settings maintenance
API is tested, but the shared quit fence and real Discard/Settings/layout regression still need
the specified published recovery merge. The draft regression is retained in the ignored
`artifacts/timeline_quit_tests.rs` for that integration; it is not claimed as compiled or passing.

Self-check: done for the committed diff. The additional beyond-end global-navigation case was
found and fixed; regression subscriptions now inspect actual emitted messages. Existing session
queues, input routing and Settings ownership remain shared; frozen fixtures and thresholds are
unchanged. The unresolved quit-order finding above is not presented as complete.

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
