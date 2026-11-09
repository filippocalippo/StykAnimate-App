# V0 second review follow-up

Implementation head: `f21ca9f728976b52214a14cc212320704bd29131`; base: `f94b74ef`.
Commits: `24588e13` (restored close prompt), `f21ca9f7` (nested cancellation). No push.

1. Picker cancellation retained the close prompt's pre-settlement stamp. Restore now preserves the prompt ID and stamps the current document.
   Four `documents_host` regressions cover Save/Discard retries at the root and inside a movieclip, unchanged settled records on cancellation, edit fences, successful close, and reopening saved bytes with the edit intact.
   Restoring the old code reproduced `HostError::Stale` for both movieclip retries; both root cases still passed.
2. Nested clip and pose-channel work lost the cancellation callback. The same callback now reaches fractional clip evaluation, nested geometry, mesh vertex/face loops, pose sampling/composition and detached-parent geometry. Partial scenes cannot enter the clip cache.
   Five `styk-eval::cancel_tests` cover dense nested evaluation/geometry, pose sampling with no owned output figures, mesh vertices/faces, and uncancelled geometry/draw-list bit equality from independent cold loaders.
   Four removed-token probes failed at their intended behavioral assertions; restoring the code passed. Arithmetic order is unchanged.
3. `docs/native/recovery.md` now describes the shared effect consumer, untitled Save, restored prompt identity/current stamp, and the accepted-Save edit fence through close/quit completion.

Verification ran in one V0-priority machine-queue job, with the ordinary parallel test harness:
- `cargo test --locked -p styk-core -p styk-eval -p styk-engine -p styk-raster`: **1,213 passed, 0 failed, 16 ignored**.
- The three engine fixture crates also ran with `--release`: **493 passed, 0 failed, 5 ignored**.
- `cargo clippy --locked -p styk-core -p styk-eval -p styk-engine -p styk-raster --all-targets`: exit **0**, existing warnings.
- `cargo xtask check`: exit **0**; 68 screenshot comparisons passed, 57 app/preview pairs were byte-identical, two stage screens remain app-only by contract.
- Five negative checks: expected exit **101**, each with a failing behavioral assertion. All temporary mutations were restored; validated source hashes match the committed implementation.
Evidence: `tmp/v0-followup-{suites,release-fixtures,clippy,guard}.log`, `tmp/v0-followup-negative-results.json`, and the two counts JSON files.

## Decisions
- Continued the reviewed branch without another reset or merge: this is the requested follow-up on `f94b74ef`.
- Used in-memory dense variants and checkpoint counts, rather than changing frozen fixtures or timing thresholds. The release fixture run matches `scripts/engine-parity.mjs`; the owner's container/wasm checks were left to the owner.
- Required a shared (`Sync`) callback because nested geometry uses the existing parallel builder; ordinary public entry points keep their uncancelled behavior.
- Removed only obsolete test executables from this task's prior logged runs to protect disk reserve. Current default/release executables, build folders and evidence remain. Other worktrees and the owner's incremental cache were untouched.
- Kept the required catalogue's existing headless harness and reserved release documents unchanged. No desktop input was injected.

Self-check: done. Reviewed the final diff, confirmed no frozen fixture/threshold/private-document changes, and retained the verified implementation and evidence.
Identity log: `f21ca9f7 | author=Alessio <79365152+filippocalippo@users.noreply.github.com> | committer=Alessio <79365152+filippocalippo@users.noreply.github.com>`
