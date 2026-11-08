# RM geometric pools and upload-ahead candidate

Follow-up to `da35fb8f`. The orchestrator's exclusive matrix at
`artifacts/rm/timing-2026-11-08T09-07-48-325Z/` completed 56/56 exports in
695.311 seconds, with identical H.264 bytes for every document and binary.
Its B/C regressions remain the reason for this candidate; no timing claim is made
for the new code before the next exclusive matrix.

## Changes and verification

Native allocation hints now allow the pinned wgpu allocator to double its blocks
from 8 MiB device / 4 MiB host to the original 256/128 MiB ceilings. Growth belongs
to each device and memory type, rather than to a new engine allocator. Dedicated
large-resource allocations retain the backend's existing policy. Retained owners
keep their allocations; no frame-based shrink or new byte limit was introduced.

`growing_native_owners_allocate_geometric_blocks` grows real device and host
buffers through 128 MiB and checks the logarithmic block-count bound derived from
the geometric sum, retention through submission, and release. It failed before
the fix at 50 MiB: four new blocks where the geometric sum permits three. The
separate small-owner test verifies that a 4 MiB working set never gets a large
block. This replaces the obsolete expectation that a growing 64 MiB workload must
always use blocks no larger than 16 MiB; no frozen test or fixture changed.

The export worker evaluates and uploads one actual successor after submitting all
current-frame tiles, before arming their readback latch. This overlaps CPU decode
and GPU drawing without another thread or queue. Empty upload batches do not wait
for GPU completion; staging pixels still flush under the existing byte bound.
The successor uses `ExportFrames`' existing bounded cache, the adjacent-page union,
the requested order and transparency policy. Prefetch work stays inside measured
draw time, including the evaluation moved there from the next call.

The native stage reads one cached playback successor in consumer order, including
reverse order and wrapping. It uploads bounded slices while the current submission
is pending, then stops speculating. A future decode or budget refusal cannot
discard the current complete picture. Current and next pages are protected within
the existing limits; atlas capacity stays until the owning painter closes.

`prefetched_frame_draws_without_uploading_again` failed without prefetch and now
checks that future pixels upload before their draw, that their draw records zero
additional picture uploads, that the current frame's pixels stay equal while its
atlas grows from two to three layers for overlapping two-page frames, and
cancellation reaches the prefetch/readback boundary. The stage's equivalent test failed without prefetch
and checks upload reuse and budget refusal. The scheduler-order test failed
without the worker seam; it covers forward, reverse, wrap and retired tickets.

```text
geometric fail-first: 0 passed; 1 failed (50 MiB: 4 blocks > 3)
geometric lifetime suite: 8 passed; 0 failed
export prefetch fail-first: 0 passed; 1 failed
stage/order fail-first: 0 passed; 2 failed
render/export/core/CLI tests: 654 passed; 0 failed; 14 ignored
export tests after removing the empty upload wait: 54 passed; 0 failed
cargo check and clippy (--no-deps): exit 0, existing warnings
cargo xtask check: exit 0; 22 screenshot references within existing limits
bash/node syntax checks: exit 0
```

Logs are under `artifacts/rm/`: `geometric-fail-first.log`, `geometric-checks.log`,
`prefetch-fail-first.log`, `stage-prefetch-fail-first.log`, `prefetch-tests.log` and
`prefetch-final-checks.log`. Component-sheet still has no screenshot reference.
Rustfmt is unavailable for the installed 1.99.1 toolchain; no component was
installed. No web build, Electron run, frozen-fixture rewrite or threshold change
was performed. The previously recorded parity prerequisite limitation remains.

## Next exclusive timing run

`bash artifacts/rm/timing.sh` runs the four executables named and SHA-256-identified
in `artifacts/rm/timing-geometric/manifest.json`: `before.exe`, `final.exe`,
`no-pools.exe` and `no-residency.exe`, all in that directory. Each is rebuilt through
the heavy queue, with `final` last so the release target contains the final code.
`before` is `fdb0d4dd` plus the same Rust counting allocator used by the earlier
instrumented baseline. The other two variants each subtract only the named group
from `final`. All source overlays are restored after their builds.

The script runs A-D at 4K H.264 Great with edges smoothing and Vulkan, alternating
all four binaries, two runs each: 32 exports. Both runs, their mean draw ms/frame,
maximum process-private peak and exact MP4 hashes are retained. The 40-minute
overall guard follows the orchestrator's latest harness; it is not a performance
threshold. No new timing matrix is run by the implementation agent.

All four builds succeeded. Runtime source head:
`353fc812f0c1447747d43ab5e7476d60f4fe8104`. The later regression-test extension
checks in-flight atlas growth and changes no production bytes. `final.exe` and the
release target both hash to
`8e93a3718fb3bdcd730a986fb5b921648e726430604ed145fb80bb50bb6e5ed7`.
`artifacts/rm/geometric-handoff.json` verifies all four executable hashes, restored
production sources, the release target, and that only the orchestrator's previous
timing-output directory exists. The new 32-run matrix remains unrun.

## C memory attribution

One fixed-order heavy-queue run each of the original instrumented `before`, new
`final`, and new `no-pools`, at 4K H.264 Great, 120 frames. The instrumented original
is used here because the rebuilt timing baseline does not contain `--memory-report`.
No timing conclusion is drawn from these memory runs. All three MP4s are exactly
970,075 bytes with SHA-256
`5799ba2b43684f9c5af20becf43e215d642855448f4af0c917b73f243704e429`.

| Configuration | Sampled own peak MiB | Peak checkpoint tick | Rust live MiB | GPU allocated MiB | GPU reserved MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 722.89 | 219 | 129.26 | 318.82 | 512.00 |
| Geometric final | 971.10 | 110 | 120.05 | 295.68 | 507.64 |
| Final without pool change | 720.54 | 219 | 120.13 | 287.18 | 512.00 |

The C increase **does not go away**; this candidate exceeds the 780 MiB target.
Comparing the final and no-pools configurations at the **same tick 110** isolates
the pool policy: private bytes differ by **+253.57 MiB**, Rust live by **+371 bytes**,
GPU allocated by **-1,008 bytes**, and GPU reserved by **-4.36 MiB**. The picture,
readback, primitive, isolation and MSAA owners therefore do not account for that
private increase. Final's blocks are 8, 128, 16, 128, 64, 128, four times 7.91015625,
and 4 MiB; default pools use 128, 256, 64 and 64 MiB. Those reports do not identify
which block has native host commitment versus device backing.

The cause is isolated to the geometric pool configuration; the extra private
commitment is **unattributed**, not a proved driver-only allocation or a floor.
Its native/platform breakdown still needs the separate probe requested by the
orchestrator. No geometric ceiling was tuned against C to conceal this result.
Raw owner/checkpoint accounts and the matched-tick comparison are retained in
`artifacts/rm/c-geometric-memory/{summary,attribution}.json` and the three JSONL
streams. The in-flight growth regression separately passed: `1 passed; 0 failed`.

## Decisions

- Use wgpu's existing geometric allocator policy; avoid a parallel allocator,
  dependency patch or backend-specific code. The owner is its device/memory type.
- Prefetch one successor, rather than two, to retain the existing adjacent-frame
  bound. Keep all prefetch cost inside draw time instead of shifting it out of
  the reported metric.
- Wire the existing stage worker and frame scheduler in `styk-core`: the latest
  explicit stage request requires these seams despite the original engine-only
  scope. No view, UI policy or toolkit code changes.
- Speculate on the stage only while its current GPU submission is pending; do not
  delay a complete picture for a future decode. Refuse speculation at existing
  byte limits and let that future frame use the normal error path when requested.
- Keep retention, adjacency and readback bounds as instructed. Use subtractive
  builds with no permanent benchmark flags and rebuild the original baseline.
- Leave the new matrix for the orchestrator. C-only runs are memory attribution,
  not timing evidence or favorable-run selection; their order is fixed in advance.
- Preserve the requested geometric ceilings despite C's regression and report the
  unmatched native commitment. Changing the constants to fit one document would
  hide the result; platform attribution is a separate chunk.
- Keep the installed toolchain and the prior parity limitation; no global tool
  installation or prohibited browser build is used to obtain a passing label.
