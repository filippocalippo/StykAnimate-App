# Native renderer memory: RM kept set

The orchestrator selected the second exclusive matrix's **no-pools** configuration:
default wgpu allocation policy, headless stage-picture suppression, bounded cel
draining, one frame of pipelined readbacks, lifetime retention, adjacent-frame
residency and upload-ahead. Small-block and geometric pool hints, their shared
helper and all four pool-policy tests are removed. The default policy is the
measured variant's `MemoryHints::Performance`; no benchmark switch remains.

**Accepted trade-off:** B costs **2.004 ms/frame (+4.26%)**, from 47.054 to 49.058,
for **1,585.61 MiB (1.55 GiB)** less peak own private memory, from 2,688.88 to
1,103.26 MiB. Both runs support the slowdown. A and D are neutral within the
observed noise; C is faster and approximately equal in memory. This is explicit
acceptance of the B trade-off, not satisfaction of the original no-slowdown rule.
The 780 MiB target and native commitment attribution remain **open**, not floors.

Measurements use Windows / RTX 4070 SUPER. A-D identify the brief's documents,
read in place. Exports use 120 frames, 3840x2160, H.264 Great, edges smoothing and
Vulkan. The orchestrator ran both timing matrices on the drained exclusive slot;
implementation builds, tests and confirmation exports use the heavy queue.
No input, frozen fixture, parity threshold or encoder argument changed.

## Exclusive timing matrices

Every cell is **mean draw ms/frame / maximum own private MiB**, retaining both
runs. Subtractions are from that matrix's all/final candidate, not cumulative.
The matrix names are historical: second-matrix `final` contains rejected pools;
second-matrix `no-pools` is the kept set. Do not compare absolute times across
different matrices as a controlled prefetch experiment.

First matrix: `artifacts/rm/timing-2026-11-08T09-07-48-325Z/`, **56/56 complete**,
695.311 seconds, identical H.264 bytes for all binaries on each document.

| Doc | Before | All | No pools | No readbacks | No residency | No adjacency | No retention |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 53.738 / 1429.50 | 54.808 / 1150.11 | 54.896 / 1360.93 | 53.933 / 1183.44 | 53.617 / 1158.66 | 57.217 / 1153.25 | 56.867 / 1049.99 |
| B | 50.204 / 2690.13 | 55.638 / 955.55 | 53.942 / 1104.68 | 57.304 / 994.01 | 52.008 / 2009.45 | 57.988 / 930.32 | 55.346 / 948.76 |
| C | 45.583 / 725.44 | 49.129 / 752.77 | 47.000 / 720.23 | 48.621 / 784.32 | 49.021 / 748.19 | 49.813 / 752.14 | 53.383 / 751.50 |
| D | 43.875 / 873.99 | 42.892 / 616.57 | 43.246 / 839.90 | 46.392 / 649.16 | 44.225 / 617.68 | 46.679 / 616.08 | 45.417 / 868.51 |

Second matrix: `artifacts/rm/timing-2026-11-08T10-01-20-195Z/`, **32/32 complete**,
387.165 seconds, identical H.264 bytes for all binaries on each document.

| Doc | Before | Geometric final | No pools: kept | No residency |
| --- | ---: | ---: | ---: | ---: |
| A | 52.092 / 1414.97 | 50.767 / 1216.95 | 52.142 / 1376.35 | 50.104 / 1218.12 |
| B | 47.054 / 2688.88 | 50.817 / 1272.23 | 49.058 / 1103.26 | 50.050 / 2362.59 |
| C | 45.296 / 725.75 | 45.663 / 941.98 | 43.692 / 719.88 | 45.354 / 941.67 |
| D | 41.288 / 876.36 | 42.808 / 739.36 | 41.221 / 837.54 | 41.308 / 742.03 |

The B residency subtraction falls from 3.629 ms in the first matrix to 0.767 ms
in the second; the latter still saves 1,090.36 MiB against whole-atlas loading.
That supports upload-ahead, but does not isolate its cost independently of pool
interactions. Geometric pools cost B 1.758 ms and 168.96 MiB, and C 1.971 ms and
222.11 MiB, relative to the kept set. They are rejected rather than tuned.

## Owner account for the kept set

The requested A/B confirmation exports use the freshly rebuilt kept source and
collect owner checkpoints with `--memory-report`. The baseline owner account is
the first original instrumented `fdb0d4dd` 4K run, selected in advance, not the
best of its three runs. The exclusive matrices did not collect per-owner logs.
Current A/B results and the complete start/document/first/peak/end accounts are
retained in `artifacts/rm/kept-confirmation/`.

Fresh confirmation, one run each, against the two exclusive no-pools runs:

| Doc | Fresh sampled peak MiB | Exclusive no-pools peaks MiB | Frames / file bytes | Exact comparisons |
| --- | ---: | ---: | ---: | --- |
| A | 1310.03 | 1332.57 / 1376.35 | 120 / 14166800 | Both files identical |
| B | 1091.23 | 1092.41 / 1103.26 | 120 / 7883136 | Both files identical |

These confirmation peaks do not replace the exclusive maximum or establish a
new timing result. A is 66.32 MiB below the exclusive maximum, B 12.03 MiB below;
both still miss 780 MiB. No run was repeated to select a lower peak.

Owners at each run's highest completed-frame private checkpoint (not matched
ticks): A before tick 207 / kept 195; B before 122 / kept 206.

| Owner, MiB | A before | A kept | B before | B kept |
| --- | ---: | ---: | ---: | ---: |
| Process private | 1425.79 | 1301.30 | 2425.10 | 1084.17 |
| Rust live (all CPU owners) | 261.46 | 184.90 | 252.50 | 202.05 |
| Sprite atlas | 128.00 | 128.00 | 1280.00 | 192.00 |
| Isolation arrays | 87.50 | 87.50 | 16.88 | 33.75 |
| MSAA targets | 63.75 | 63.75 | 63.75 | 63.75 |
| Resolved frame | 8.44 | 8.44 | 8.44 | 8.44 |
| Readbacks | 63.28 | 31.64 | 63.28 | 31.64 |
| Glyph masks | 32.00 | 32.00 | 0.00 | 2.00 |
| Primitive buffer | 32.00 | 8.00 | 0.13 | 2.00 |
| Other GPU allocations | 1.10 | 1.10 | 1.10 | 1.10 |
| GPU allocated total | 416.07 | 360.43 | 1433.57 | 334.68 |
| GPU reserved total | 768.00 | 768.00 | 1728.00 | 768.00 |
| GPU allocator slack | 351.93 | 407.57 | 294.43 | 433.32 |
| Private minus Rust (overlapping, unattributed) | 1164.33 | 1116.40 | 2172.60 | 882.12 |

Lifetime checkpoints (MiB). `owners.json` retains every GPU label at every point:

| Document / version | Point | Private | Rust live | GPU allocated | GPU reserved |
| --- | --- | ---: | ---: | ---: | ---: |
| A before | start | 1.60 | 0.01 | 0.00 | 0.00 |
| A before | document | 137.70 | 98.39 | 0.00 | 0.00 |
| A before | first | 900.94 | 236.38 | 316.20 | 512.00 |
| A before | peak | 1425.79 | 261.46 | 416.07 | 768.00 |
| A before | end | 1182.69 | 236.59 | 416.07 | 768.00 |
| A kept | start | 1.61 | 0.01 | 0.00 | 0.00 |
| A kept | document | 134.79 | 98.39 | 0.00 | 0.00 |
| A kept | first | 790.41 | 182.50 | 284.55 | 512.00 |
| A kept | peak | 1301.30 | 184.90 | 360.43 | 768.00 |
| A kept | end | 1078.00 | 182.70 | 384.43 | 768.00 |
| B before | start | 1.57 | 0.01 | 0.00 | 0.00 |
| B before | document | 149.93 | 126.93 | 0.00 | 0.00 |
| B before | first | 2413.12 | 244.76 | 1384.82 | 1728.00 |
| B before | peak | 2425.10 | 252.50 | 1433.57 | 1728.00 |
| B before | end | 2372.66 | 245.59 | 1454.32 | 1984.00 |
| B kept | start | 1.56 | 0.01 | 0.00 | 0.00 |
| B kept | document | 146.36 | 126.93 | 0.00 | 0.00 |
| B kept | first | 787.51 | 192.10 | 201.18 | 512.00 |
| B kept | peak | 1084.17 | 202.05 | 334.68 | 768.00 |
| B kept | end | 1074.77 | 192.83 | 334.68 | 768.00 |

These accounts overlap. Rust live includes the document, evaluation and CPU
buffers; GPU allocations and reserved backing cannot be added to process private.
Allocator slack is reserved minus allocated. Private minus Rust is an overlapping
unattributed account, not a disjoint driver total. GPU labels do not expose native
host commitment versus device backing. Completed-frame checkpoints can miss a
transient peak; the separate 50 ms sampler judges the process target. The video
end checkpoint precedes renderer destruction; teardown is verified by lifetime
tests, not inferred from that checkpoint. C/D kept-set process peaks come from
the exclusive matrix; no new C/D owner or stage run was requested or substituted.

The original A 4K jump remains explained: between ticks 137 and 138, private bytes
rose 257.1 MiB, GPU reservation 256 MiB and live GPU allocations only 23.8 MiB,
with Rust live unchanged. Isolation grew 15.625 MiB and MSAA 8.125 MiB, crossing
a default allocation-block boundary. This is retained backing owned by the GPU
device, not a new 265 MiB document cache. Default pools are restored deliberately;
removing them did not produce a favorable overall cost in the measured designs.

## Kept changes and fail-first coverage

| Change / owning layer | Regression and evidence |
| --- | --- |
| Suppress stage-picture work in headless exports (`styk-engine`) | `a_headless_export_has_one_picture_consumer` failed with 403 stage picture tiles queued without a stage consumer. `Engine::for_export` leaves that queue empty while export cels still decode. |
| Drain every bounded cel/upload batch (`styk-export`, CLI) | `one_cel_can_span_several_upload_batches` failed with pending pictures after the final decoder stopped. The real 4096x2048 cel crosses the 32 MiB boundary; `a_small_decode_queue_preserves_all_cpu_pixels` compares against whole-decode pixels. Decoded/staging copies leave after upload; CPU pixels remain owned where needed. Input bytes leave after open. |
| Resident native sprites (`styk-export`) | `headless_frame_source_allocates_only_resident_sprite_pages` failed at four pages instead of two for unused pictures. Visible pages can exceed the soft two-page budget; refused/partial loads never become ready. Cel pixels equal the original whole-atlas output. |
| One frame of pipelined readbacks (`styk-export`) | `native_readbacks_are_sized_for_the_tiles_of_one_frame` failed with eight slots instead of one at 1080p. Four 4K tiles stay pipelined within 64 MiB; the slower serial-tile experiment was removed. `readbacks_reuse_buffers_and_release_at_export_end` verifies reuse and disposer release; no new change was needed for that lifetime. |
| Retain isolation/MSAA and primitive capacity (`styk-render`) | `isolation_and_msaa_reuse_across_quiet_frames_and_release_at_close` and `primitives_reuse_capacity_and_release_at_close`: `0 passed; 2 failed` before retention. Equal/smaller/empty frames keep handles, close releases owners, and pixels match a fresh renderer. |
| Retain effects (`styk-render`) | `exact_effect_slots_reuse_after_quiet_frames_and_release_at_close`: `0 passed; 1 failed` before retention; active/quiet/active frames reuse the handle, close releases it. |
| Protect adjacent complete working sets (`styk-export`) | `native_adjacent_frames_keep_their_sprite_pages_until_export_end`: corrected fail-first `0 passed; 1 failed` on an eviction instead of zero. Three loads for overlapping two-page frames, no repeat loads, release at end. The earlier invalid-index test failure is not counted as evidence. |
| Prefetch export successor (`styk-export`, CLI) | `prefetched_frame_draws_without_uploading_again`: `0 passed; 1 failed` without prefetch. Next draw uploads zero pixels; current pixels stay equal while its in-flight atlas grows from two to three layers; cancellation reaches the prefetch/readback boundary. |
| Prefetch stage playback (`styk-core` worker) | `prefetched_stage_frame_records_no_upload_when_drawn` and `painter_prefetch_follows_playback_order_and_rejects_retired_requests`: `0 passed; 2 failed` without the seams. Tests cover zero draw-time uploads, budget refusal, forward/reverse/wrap order and retired revisions. |

Fail-first logs remain in `artifacts/rm/`: `decode-fail-first.log`,
`large-cel-fail-first.log`, `resident-fail-first.log`, `fail-first.log`,
`retention-fail-first.log`, `effects-reuse-fail-first.log`,
`adjacent-corrected-fail-first.log`, `prefetch-fail-first.log` and
`stage-prefetch-fail-first.log`. Pool-policy fail-first logs are historical evidence
for rejected experiments, not coverage claimed for this kept set. Cancellation,
device-loss, dropped-owner and refusal tests remain. No test threshold was raised.

## Open items

1. **Recover B's 2.004 ms/frame.** This accepted cost is not a floor. Ranked suspects:
   - Residency preparation and upload synchronization first: its isolated B cost
     was 3.629 ms before upload-ahead and remains 0.767 ms with geometric pools.
     Inspect page-set preparation, remaining batch flush waits and decode overlap.
     The second matrix has no combined no-pools/no-residency variant, so 0.767 ms
     is not a measured decomposition of the kept set's entire 2.004 ms.
   - Exact texture-dimension replacement and its allocation/queue interaction
     next. Retention prevents capacity shrink, but dimensions still change for
     pixel arithmetic. Pools clearly affected B, while removing retention changed
     first-matrix B only -0.292 ms (noise); this is a hypothesis, not a proven cause.
   - Readback scheduling and adjacency are lower-priority profiling sites, not
     candidates for removal: their first-matrix subtractions cost B +1.667 and
     +2.350 ms respectively. Keep both, as instructed. No per-frame cost is hidden
     by moving prefetch out of the reported draw interval.
2. **Process memory above 780 MiB:** exclusive kept-set A 1,376.35, B 1,103.26 and
   D 837.54 MiB; C 719.88 MiB. The remaining commitment includes unattributed native
   and driver allocations. A platform/devtools probe in a later chunk must split
   native heaps, mapped backing and driver commitment; the engine's overlapping
   counters cannot do so. The historical render-only A checkpoint of 815.4 MiB,
   with 120.2 MiB Rust live and 326.3 MiB GPU reserved, demonstrates that video
   output buffers alone do not explain it. It does not establish a floor.
3. **Pools deferred:** design and measure first in a later chunk, with the new
   native probe. Neither the 8-16 MiB policy nor 8-256 MiB geometric policy remains.
4. **X2 native frame nondeterminism remains separate.** Four extra old-binary
   samples agreed at A tick 181 and D571; their historical candidate differences
   have no demonstrated baseline-self-variation exemption. Baseline variation is
   demonstrated at A131, D541 and D544, and historical A138 samples disagree.
   No tolerance or blanket exemption was introduced; see the retained
   [PNG investigation](render-memory-followup.md#a-tick-181-and-process-attribution).

## Equality, verification and provenance

Both exclusive matrices have exact H.264 equality for every run and binary.
The new A/B confirmation compares complete files against **both** second-matrix
no-pools files for that document, and checks the CLI's SHA-256 against the file.

```text
cargo check (render/export/engine/core/CLI, app-tools, tests): exit 0
cargo clippy (same crates, --no-deps): exit 0, existing warnings
touched-crate tests: 845 passed; 0 failed; 16 ignored (83 result lines)
cargo build --release -p styk-cli --features app-tools --locked: exit 0
cargo xtask check: exit 0; 22 screenshot references within unchanged limits
A/B 4K confirmation: 2 exports; both equal to both no-pools matrix runs
```

Logs: `artifacts/rm/kept-checks.log`, `kept-test-summary.json` and
`kept-confirmation.log`. Component-sheet still has no screenshot reference.
The built executable and a retained copy at `artifacts/rm/kept-confirmation/styk.exe`
have SHA-256 `0c3b0f8099ec991f0d16f1b9a1b33bf40bdad0e84e87d869fb3eab6534577313`.
`kept-confirmation/verification.json` records each production-source hash and
compares it to the measured no-pools snapshot, allowing only removal of the
constant default-policy helper and its two fields. It records the pre-commit
parent `c08c163f`; the hashed working sources are the kept change. No runtime
source changed after these checks or measurements.

Fresh file SHA-256:

- A: `ac8abfeb9861c89f5ff6d31c647dabfe78ed79290ee6c478ec340d586e5a4855`
- B: `d5c3654a1196f04ad7dc9bd5bc2aae0737de970f7841a6a7212a5af254056e1e`

Earlier candidate evidence remains explicitly historical: 960 Vulkan RGBA hashes,
zero differences; 16 H.264 files, zero differences; two WebM files, zero differences
after normalizing only the baseline-proven eight-byte `TrackUID` and `TagTrackUID`
fields. It is not relabeled as a new kept-set RGBA/WebM run. Original before/after
1080p/4K export and stage owner accounts remain at `artifacts/rm/memory-account.*`;
the original report is retained at `artifacts/rm/render-memory-initial-report.md`.
The old A4K stage run stopped at its unchanged 1 GiB admission limit; it was never
claimed as a completed 120-frame stage comparison.

The earlier requested parity command ran Rust fixtures: **1,354 passed, 0 failed,
5 ignored**. Its JavaScript container steps failed because generated
`styk_engine.js`/`styk_codec.js` bindings were absent (`ERR_MODULE_NOT_FOUND`),
exit 1. No prohibited web build or stale bindings were substituted. Rustfmt is
unavailable in the installed toolchain. No global component was installed.
The prior WebM encoder observations, 1,895.6/1,895.9 MiB for fixed libvpx arguments,
describe that separate process only; they do not establish an RM process floor.

## Decisions

- Follow the orchestrator's kept-set selection and explicit B trade-off. Remove
  allocator policy and tests cleanly rather than leave an unused constant helper.
  Pinned wgpu derives `Performance` as its default, preserving the measured policy.
- Keep owner teardown as the release point and exact dimensions for sampling
  parity; no new idle timer, size cache, allocation limit or pool tuning is added.
- Keep one actual ordered successor in existing bounded caches, with all work
  included in draw timing. Stage prefetch stays on its worker and stops once the
  current GPU submission completes; the explicit stage request permits these
  core seams without interface work.
- Run exactly one new A and one new B export in that fixed order, with full owner
  logs. Compare bytes to both exclusive no-pools runs; report every peak without
  rerunning for a favorable sample. Use the first existing baseline owner run.
- Retain both complete matrices and their measurements, including rejected pool
  results. Do not add or subtract group timings as if their interactions were
  measured, or turn the native commitment remainder into a floor.
- Leave platform attribution, pool redesign and X2 to their later chunks. Keep
  frozen fixtures, existing limits, the toolchain and prior parity limitation.
- Leave the build target, dependency junction and raw evidence for Sol review;
  no merge, push, review delegation or new timing matrix is performed here.
