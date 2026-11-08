# RM lifetime retention and isolated timing candidates

Historical candidate record. Both exclusive matrices have since completed; the
selected configuration and current open items are in [render-memory.md](render-memory.md).

This follows the rejected timing candidate `0e7c4ab4`. The historical measurements
in [render-memory.md](render-memory.md) remain historical; they do not certify the
new code. No performance matrix was run for this follow-up. The orchestrator runs
the prepared matrix on the drained exclusive bench before selecting changes.

## Ownership

Isolation page counts and primitive buffers keep their high-water capacity.
Unused isolation arrays, their MSAA target and effect slots survive quiet frames.
The frame-count shrink timers are removed. Renderer destruction releases these
owners at document close/export end; the export disposer releases readbacks and
sprite textures off the caller. Existing readback capacity already had this
lifetime and is unchanged. Admission counts retained owners and replacement
overlap; no byte limit or tolerance was raised.

Native sprite residency protects the last complete frame's pages while preparing
the next. Its capacity grows for the largest adjacent-frame union, rather than
evicting and uploading the alternating working set. Other pages remain eviction
candidates. The browser policy is unchanged.

Exact isolation/effect texture dimensions remain frame-derived because their
normalized sampling arithmetic affects output pixels. A change of dimensions
still replaces those textures. This follow-up prevents capacity shrink and
unused-frame retirement; it does not claim to eliminate that remaining cost.

## Regressions

| Owner | New coverage and fail-first evidence |
| --- | --- |
| Isolation / MSAA | `isolation_and_msaa_reuse_across_quiet_frames_and_release_at_close` compares texture handles across equal, smaller and empty frames, then verifies allocator ownership disappears. Together with the primitive test: `0 passed; 2 failed` before the fix. |
| Primitives | `primitives_reuse_capacity_and_release_at_close` compares buffer handles after large/small/empty lists and verifies release. |
| Effects | `exact_effect_slots_reuse_after_quiet_frames_and_release_at_close` compares the slot handle across active/quiet/active frames and verifies release; `0 passed; 1 failed` before the fix. |
| Atlas | `native_adjacent_frames_keep_their_sprite_pages_until_export_end` uses the default native source with overlapping two-page frames; exactly three loads, zero evictions, no new loads on repeat, then release; `0 passed; 1 failed` before the fix. |
| Readbacks | `readbacks_reuse_buffers_and_release_at_export_end` compares real tile buffer handles over three rendered frames and waits for the existing disposer before checking release. No production change was needed. |

The updated unfrozen lifetime tests also compare pixels against a fresh renderer.
Frozen fixtures and the existing cancellation/refusal tests are unchanged.
Fail-first logs are `artifacts/rm/retention-fail-first.log`,
`effects-reuse-fail-first.log` and `adjacent-corrected-fail-first.log`.
The initial adjacency test used an out-of-range picture index; its failure is
invalid evidence. With the indices corrected, the old policy fails specifically
on one eviction versus zero, and the current policy passes. Both logs are kept.

Verification through the heavy queue:

```text
cargo check (render/export/CLI, app-tools, tests): exit 0
cargo clippy (render/export/CLI, app-tools, --no-deps): exit 0, existing warnings
render/export full test run: 120 passed; 1 failed; 0 ignored
corrected adjacency regression: 1 passed; 0 failed; 0 ignored; 10 filtered out
bash -n timing.sh; node --check timing-run.mjs and build helper: exit 0
cargo xtask check: exit 0
screenshots: active, 22 references (23 catalogue screens)
```

The one failed test above was the new test's invalid index, corrected and rerun;
121 unique tests pass across those runs. The complete outputs remain in
`artifacts/rm/retention-tests.log`, `adjacent-corrected-pass.log` and
`retention-final-checks.log`. All 22 available screenshot references stayed within
their existing limits; component-sheet still has no reference. No screen changed.

## Timing handoff

Run `bash artifacts/rm/timing.sh` from this checkout in the orchestrator's exclusive
bench slot. It must not be run by the implementation agent. The launcher invokes
`artifacts/rm/timing-run.mjs`; private paths stay only in the ignored
`artifacts/rm/bench-inputs.json`. It sets `STYK_BACKGROUND_WINDOW=1`.

`artifacts/rm/timing-binaries/manifest.json` identifies every executable by SHA-256
and the implementation source head. The original executable is
`artifacts/rm/styk-before.exe`; the six following executables are under
`artifacts/rm/timing-binaries/`:

| Binary | Difference from `all.exe` |
| --- | --- |
| `no-pools.exe` | Default performance allocation pools. |
| `no-readbacks.exe` | Original readback slot count. |
| `no-residency.exe` | Whole sprite atlas, still using bounded decode batches. |
| `no-adjacency.exe` | Residency without previous-frame protection. |
| `no-retention.exe` | Renderer retirement behavior from `0e7c4ab4`. |
| `all.exe` | Current retention candidate, all groups enabled. |

Each subtraction changes only its stated group; no permanent benchmark flags are
added. Tile pipelining stays enabled in every candidate. The previously rejected
single-slot experiment is not repeated.

The fixed matrix covers A-D, 120 frames, 3840x2160, H.264 Great, edges smoothing,
two runs per executable: 56 exports. Vulkan is explicitly pinned to the original
video backend. Per-document forward/reversed orders rotate,
with no consecutive repeat of one executable. Raw JSON, executable hashes, order,
MP4s and both runs stay in a fresh timestamped directory. Output prints draw
ms/frame and own-process peak private MiB. The summary uses both runs' mean draw
time and maximum peak, and requires all H.264 bytes to match. The 20-minute total
guard bounds each child call too; an incomplete matrix fails without selecting
favorable runs. A 15 GiB free-space reserve is checked before each export.

All six release builds completed through the heavy queue, one per variant,
from source head `657432dd8aceb661a8b0fd4f6b6ad3eaed2ba279`. Their build command was
`cargo build --manifest-path engine/Cargo.toml --release -p styk-cli --features app-tools --locked`
with the queue environment. The final release target matches `all.exe` exactly:
`a215a31b674082378b4e4fa0d5f91312a7f1f04906a2dd1ee9adea0151b489ed`.
Artifact verification reports `binaries: 7`, all hashes matching, sources restored,
and `timingMatrixRun: false`; see `artifacts/rm/handoff-audit.json`.

## A tick 181 and process attribution

Four additional independent baseline DX12 processes exported A at 1080p through
tick 181. All four tick-181 PNGs have SHA-256
`5aaffe515255966d1c9f712e66777c1e9e3c5a3e4a5e46357fcbefcce7eac5b2`;
all six pairwise comparisons have zero differing pixels. This matches the prior
baseline samples. The prior candidate's two-pixel, one-channel-unit discrepancy
therefore has **no demonstrated baseline-self-variation exemption**. No PNG
threshold, exclusion or X2 renderer fix is introduced. Evidence is in
`artifacts/rm/png-baselines/results.json` and its retained PNGs. The fixed repeats
also reproduce baseline variation at A131, D541 and D544.
The four new D571 samples and the original baseline hash also agree, so that
earlier mismatch likewise has no demonstrated exemption. A138's new repeats agree
with each other but differ from the prior baseline probe's PNG hashes. The
historical hash comparison is retained separately; no broader exemption is inferred
for stable frames.

The earlier candidate's Vulkan RGBA, H.264 and normalized WebM checks had zero
differences; these are not re-labelled as measurements of the retention build.
The pending matrix checks H.264 again for every executable and run.

The earlier single-slot render-only A4K checkpoint was 815.4 MiB process private,
120.2 MiB Rust live and 326.3 MiB GPU reserved. Private minus Rust live is
695.2 MiB, an **unattributed overlapping account** including GPU/native commitment,
not a driver-only estimate or a memory floor. Subtracting GPU reservation again
would not identify a disjoint remainder. Further attribution needs the separate
platform/devtools probe. No kept-set peak against 780 MiB is claimed before the
exclusive timing result determines the kept set and one final memory run.

## Decisions

- Use owner teardown, rather than adding an idle timer: it is an authorized
  release point, has an existing disposer, and avoids a second clock policy.
- Preserve exact texture dimensions for pixel arithmetic; retain page counts,
  buffers and inactive owners instead of introducing an unmeasured size cache.
- Bound native residency by adjacent complete frames, not the entire export;
  keep browser behavior and all existing hard limits.
- Use subtractive binaries to isolate groups without production feature flags;
  include separate adjacency and renderer-retention comparisons.
- Stop at prepared, unselected binaries: running the timing script is explicitly
  reserved for the orchestrator. Selection and the kept-set memory measurement
  depend on that evidence and cannot honestly be completed here.
- Fix four additional baseline repeats in advance and report stable A181;
  do not repeat until a favorable PNG result appears or expand the exemption.
- Retain the previous parity prerequisite limitation (missing generated browser
  bindings); no prohibited web build or stale binding substitution is performed.
