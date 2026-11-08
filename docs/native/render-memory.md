# Native renderer memory: RM

Measured on Windows, RTX 4070 SUPER, from `fdb0d4dd` with diagnostic instrumentation
and implementation head `3f5a1a4b`. A–D are the four documents in the brief's order. Private
documents were read in place. Each export covers 120 frames at 1920×1080 or
3840×2160, with the original backend, sampling, codec and quality arguments.
All builds, tests and measurements used the machine's **heavy** queue; timing is
directional because other jobs share the machine. No frozen reference was changed.

This is a **review candidate, not an acceptance pass**. The process-memory target,
complete private-memory attribution, zero PNG differences and the no-slowdown
criterion are evaluated below; a passing unit test does not substitute for them.

## Ownership and the large jump

The original A 4K run crosses a GPU allocator block boundary between ticks 137 and
138: process private increases **257.1 MiB**, GPU reservation **256 MiB**, live GPU
allocations **23.8 MiB**, and live Rust allocation is unchanged. This reproduces the
brief's approximately 265 MiB jump at a slightly different tick. The reservation
belongs to wgpu's growing allocation pools: isolation arrays grow **15.625 MiB**
and their MSAA target **8.125 MiB**. Those allocations cross the next 256 MiB block
boundary; live suballocations and retained isolation capacity keep the pool in use.
The exporter owns the device through the job;
it is not a new 265 MiB document or frame cache.

GPU allocator labels, reserved blocks, Rust live/peak bytes and process private are
recorded at startup, document open, renderer setup, every completed frame and exit.
`styk-trace` receives the same scalar counters. The opt-in `video --memory-report`
and `stage-memory` commands are documented in `../engine/memory.md`. The latter
drives the real K-stage host and painter through parsed automation frame steps.

These are overlapping accounts: do not add GPU allocations to process private or
Rust live to GPU reservation. Allocator slack is reserved minus allocated. The
remaining process-private bytes include native/driver heaps, mapped backing and
allocator commitment that wgpu and the Rust allocator do not identify individually.
They are **unattributed**, not evidence of an unavoidable floor. A completed-frame
checkpoint can miss a transient peak; video's separate 50 ms sampler is used for
the target judgement. Stage has checkpoint measurements only.
The stage's end checkpoint follows host/painter shutdown, while the diagnostic
still holds its document generation. The video's end checkpoint precedes renderer
destruction. Neither is a claim that every command-local allocation has been freed.

| Document | Size | Sampled own peak, before → after (MiB) | Draw ms/frame, before → after |
| --- | --- | ---: | ---: |
| A | 1920x1080 | 1148.6 → 873.4 | 13.34 → 12.35 |
| A | 3840x2160 | 1486.0 → 1040.6 | 65.74 → 70.42 |
| B | 1920x1080 | 2662.5 → 821.2 | 14.51 → 18.27 |
| B | 3840x2160 | 2736.8 → 994.9 | 58.36 → 69.18 |
| C | 1920x1080 | 685.8 → 547.0 | 13.01 → 11.49 |
| C | 3840x2160 | 763.3 → 792.5 | 53.90 → 57.98 |
| D | 1920x1080 | 828.4 → 614.3 | 10.70 → 12.43 |
| D | 3840x2160 | 908.0 → 894.9 | 56.77 → 58.26 |

4K: maximum peak and median mean draw time of three runs; 1080p: one run.
All four final 4K process peaks exceed 780 MiB. C also exceeds its baseline peak;
the large reductions on A and B do not establish the target for every document.

A, 4K H.264: completed-frame ownership (MiB), before → after. Peaks in this
table are checkpoint peaks, not the higher sampled transient peaks above.

| Owner | First frame | Peak checkpoint | End |
| --- | ---: | ---: | ---: |
| Process private | 900.9 → 661.2 | 1425.8 → 958.0 | 1182.7 → 650.7 |
| Rust live (includes document and CPU buffers) | 236.4 → 182.5 | 261.5 → 184.9 | 236.6 → 182.7 |
| Sprite atlas | 128.0 → 128.0 | 128.0 → 128.0 | 128.0 → 128.0 |
| Isolation arrays | 50.6 → 50.6 | 87.5 → 67.5 | 87.5 → 16.9 |
| MSAA targets | 63.8 → 63.8 | 63.8 → 63.8 | 63.8 → 63.8 |
| Resolved GPU frame | 8.4 → 8.4 | 8.4 → 8.4 | 8.4 → 8.4 |
| Readback buffers | 63.3 → 31.6 | 63.3 → 31.6 | 63.3 → 31.6 |
| Glyph masks | 0.0 → 0.0 | 32.0 → 32.0 | 32.0 → 32.0 |
| Primitive buffer | 1.0 → 1.0 | 32.0 → 0.5 | 32.0 → 0.5 |
| Other GPU allocations | 1.1 → 1.1 | 1.1 → 1.1 | 1.1 → 1.1 |
| GPU allocated total | 316.2 → 284.6 | 416.1 → 332.9 | 416.1 → 282.3 |
| GPU reserved total | 512.0 → 302.0 | 768.0 → 370.9 | 768.0 → 304.3 |
| GPU allocator slack | 195.8 → 17.5 | 351.9 → 38.0 | 351.9 → 22.0 |
| Other private (overlaps GPU / native commitment) | 664.6 → 478.7 | 1164.3 → 773.0 | 946.1 → 468.0 |

The retained evidence at `artifacts/rm/memory-account.md`, `.csv` and `.json` gives
all four documents, both resolutions, export and stage, at start, document open,
first frame, peak checkpoint and end, with every GPU allocation label in JSON.


## Changes and fail-first evidence

| Owner / change | Regression and original failure |
| --- | --- |
| Headless engine publication | `export_memory`: 403 stage picture tiles remained with no stage consumer; `Engine::for_export` leaves that queue empty while export cels still decode. |
| Export upload batches | `source_memory`: a real 4096×2048 cel exceeded one 32 MiB batch and returned “pending without runnable decoding work”; every ready batch now drains. The small-queue CPU test compares original whole-decode pixels. |
| Sprite atlas | `headless_frame_source_allocates_only_resident_sprite_pages`: the default source allocated four pages for unused pictures instead of two; existing residency grows for all visible pages and the cel equals the original whole-atlas output exactly. |
| GPU allocation pools | `a_native_device_reserves_small_memory_blocks_for_small_work`: 192 MiB reserved for a 1 MiB buffer; `small_native_owners_do_not_grow_large_allocator_blocks`: small owners grew 32/64 MiB blocks. Shared native hints now use 8–16 MiB device blocks and 4–8 MiB host blocks, with no resource-size limit. |
| Isolation arrays and MSAA | `memory_lifetime`: an empty frame retained 2,097,160 logical layer bytes instead of 16; a one-layer frame retained 2,097,160 instead of 524,296. Exact arrays now match both parities' current needs and unused intermediate MSAA leaves with them; allocator reports also include backend padding. |
| Readback capacity | `memory_lifetime`: native 1080p allocated eight readbacks instead of one. The native source now allocates at most the current frame's tiles (four at 4K), within the existing byte limit. A single-slot experiment was rejected because paired runs regressed frame time. |
| Primitive and effect capacity | `memory_lifetime`: empty artwork retained 16,842,752 primitive bytes and an unused effect retained 262,144 bytes. Exact frames release excess capacity; the primitive assertion compares a fresh owner, including backend padding. |

The existing cancellation, dropped-owner, GPU readback, export refusal and residency
tests remain in the touched-crate run. Upload flushing uses the existing poller and
interrupt latch, so cancellation/device loss wakes the producer rather than waiting
on a blocking device poll. Neither stage limits nor frame/byte tolerances were raised.

## Attempts and remaining limits

The evidence retains five separate configurations: smaller default pools and
lifetime fixes with the whole atlas; resident sprites; one in-flight tile with
primitive/effect retirement; bounded manual allocation pools; and restored tile
pipelining after the timing regression. Their binaries
and measurements are kept in the ignored `artifacts/rm/` folder. These are distinct
owner-level attempts, not repeated runs with a shifted acceptance threshold.

| Configuration | A peak MiB | B peak MiB | A draw ms/frame | B draw ms/frame |
| --- | ---: | ---: | ---: | ---: |
| Whole atlas; smaller pools and lifetime fixes | 1173.8 | 2097.3 | 64.05 | 55.60 |
| Resident sprite pages | 1240.7 | 1098.9 | 110.85 | 84.90 |
| One native tile; primitive/effect retirement | 1124.2 | 882.4 | 63.58 | 66.22 |
| Bounded 8–16 MiB allocator pools | 958.8 | 920.6 | 85.75 | 64.84 |
| Restored tile pipeline; final | 987.4 | 981.6 | 45.78 | 67.17 |

Alternating before/after and after/before pairs in one heavy-queue job (two runs
per version and document, mean draw ms/frame; every file has identical bytes):

| Document | Before | After | Change |
| --- | ---: | ---: | ---: |
| A | 58.50 | 71.72 | 22.6% |
| B | 58.96 | 73.35 | 24.4% |
| C | 56.72 | 63.21 | 11.4% |
| D | 53.60 | 66.86 | 24.7% |

The paired measurements fail the directional no-slowdown requirement. Restoring
tile overlap removed the single-slot mechanism, but did not establish unchanged
frame time. Exact owners can recreate resources when successive working sets
change, and residency can upload newly visible pages; their remaining timing cost
has not been isolated from shared-machine load. This is an open acceptance blocker,
not a speed claim or a reason to discard the measurements.

The single-slot attempt's render-only A at 4K reaches 815.4 MiB at a completed-frame checkpoint with
120.2 MiB Rust live and 326.3 MiB GPU reserved. The video-writing path therefore
does not explain all the remaining private memory. Its two extra full RGBA buffers
account for 63.3 MiB of the video/render-only Rust-live difference; native/driver
commitment needs further attribution before claiming a process-memory floor.

The WebM encoder floor is a separate process, with the original libvpx arguments.
Two baseline runs measured 1,895.6 and 1,895.9 MiB for the encoder alone. Changing
encoder arguments or the platform video service is outside RM; these figures are
an observed floor candidate for those fixed arguments, not a universal codec limit.

## Validation and decisions

The final strict comparison exits **1**: 960 Vulkan RGBA frame hashes compared,
**0 different**; 16 H.264 files compared, **0 different**; two WebM files compared,
**0 different after only the two baseline-proven UID fields below**. The 960 native
DX12 PNG files include **six differences**: A at 1080p ticks 131, 138 and 181;
D at 1080p tick 571 and at 4K ticks 541 and 544. No PNG tolerance or whitelist was
introduced. Full results are in `artifacts/rm/equality.json` and
`artifacts/rm/png-differences.json`.

The separate PNG diagnosis repeats the original binary: A tick 131 differs in
36 pixels, and D tick 541 in four, all by at most one channel unit. Thus the old
DX12 path is itself nondeterministic on these frames. That does not explain every
final mismatch: the single-slot diagnostic also found two changed pixels at A
tick 181 while its two baseline samples agreed. The final strict zero-difference
requirement remains failed, and no baseline fixture was replaced.

Final touched-crate tests (`styk-render`, `styk-export`, `styk-engine`, `styk-cli`,
with `styk-cli/app-tools`, dev profile, one test thread) exit **0**: **326 passed,
0 failed, 7 ignored**, across 56 test-result lines including doc tests.
`cargo check` and touched-crate `cargo clippy -- --no-deps` exit **0**, with existing
warnings; the measured release build reports `Finished release profile ... in 15.68s`.
Dependency-wide clippy previously failed in unchanged `styk-math` NaN comparisons
(`clippy::eq_op`); it is not reported as a clean dependency-wide check.

The single requested `npm run engine:parity` invocation ran the Rust fixture
suites: **1,354 passed, 0 failed, 5 ignored**, across 228 test-result lines. Its
JavaScript container fixture step fails with `ERR_MODULE_NOT_FOUND` for
`src/engine/pkg/styk_engine.js`; the nine container comparisons likewise lack
`styk_codec.js`. No stale WebAssembly package was substituted. The command exits
**1**, with these final results:

```text
ok   Rust fixture suites (1224.3 s)
ok   math fixtures regenerate unchanged (0.2 s)
FAIL container fixtures regenerate unchanged (0.1 s)
ok   styk CLI build (190.3 s)
ok   live worker command replays (0.2 s)
FAIL containers (9 repository files) (0.9 s)
```

The first `cargo xtask check` caught this change's incorrect placement of
`dep:styk-trace` in `app-tools`. The CLI now declares the instrumentation crate as
a normal dependency; `styk-devtools-engine` still enables its tracing feature only
for app tools. The guard's allowed dependency list was not changed.

After that manifest repair, both default and app-tools CLI `cargo check`, app-tools
clippy and the release build pass; CLI tests report **14 passed, 0 failed,
5 ignored**. `cargo xtask check` passes with a directly captured child exit **0**.
Its first successful-looking run had an ambiguous PowerShell status after stderr
redirection, so the guard alone was repeated to capture that exit explicitly.

```text
design: 183 generated files are current
locales: 28 catalogue files equal src/locales
features: developer views are optional and off by default
metadata: dependency direction and registry allow-list pass (453 packages)
source: Windows isolation, view boundaries, macro unwrap/expect and web Clock/Spawner constraints pass
interface: clippy guards pass
screenshots: active, 22 references (23 catalogue screens)
```

All 22 screenshot comparisons stay within their unchanged limits. The largest
differing-pixel fraction is **0.019534363**, against that reference's **0.022** limit;
`component-sheet` has no reference. The standard guard builds the native app and
captures its catalogue with background-window mode enabled.

The measured app-tools executable has SHA-256
`45660da2aa65875122040b12857a64c991b7b25bb9ec676c2d1d56f9a8cbcd37`.
The rebuilt executable after the manifest repair has SHA-256
`d102ed764e39789d8a53f4b23c5e7ab3d767089adba18bab64ad98bec350fd73`.
Their `.text`, `.data`, `.pdata` and `.reloc` sections are byte-identical. All 24
changed file bytes are in the COFF/debug timestamps and CodeView PDB GUID; the
comparison identifies **0 unexplained bytes**. The files are not claimed to have
identical hashes. `artifacts/rm/manifest-binary-comparison.json` retains the section
hashes and parsed metadata ranges; no renderer or engine Rust source changed after
the recorded memory/frame/export matrix.

`node scripts/engine-inventory.mjs --render` leaves generated files unchanged but
reports six pre-existing JavaScript inventory issues (three absent modules and
three unlisted modules). They are outside this native memory change. No web build,
Electron smoke, root JavaScript suite or cross-platform build was run, per N8.
The current build target, final executable and raw evidence remain for review.

- Preserve the original video backend (Vulkan here) and native PNG/stage preference
  (DX12/FXC here), because switching them would invalidate byte/pixel comparisons.
- Retain the stage's existing 1 GiB guard: A's 4K stage run completes 15 frames
  before and 36 after, then refuses. The other requested runs are reported separately;
  this is not a completed 120-frame stage comparison for A at 4K.
- WebM is not literally deterministic: old-versus-old differs only in `TrackUID`
  and `TagTrackUID`, eight bytes each. Structural EBML parsing established their
  locations; only those fields are normalized for the final comparison.
- DX12 adds allocation padding. Compare an empty primitive owner with its freshly
  created allocation rather than assuming its logical 64 KiB size equals its report.
- Preserve D11's two-layer minimum and the existing portable atlas layout; RM does
  not introduce a separate native packing or sampling convention.
- Keep the mandatory heavy queue. Do not substitute an exclusive benchmark or
  select only favorable timing runs to turn the no-slowdown requirement into a pass.
- Run Rust tests with one test thread per binary to avoid concurrent GPU-device
  tests multiplying memory on the shared machine; test assertions are unchanged.
- Keep OS-specific investigation behind platform traits. The allowed crates cannot
  add a Windows heap/driver walk to split the remaining native commitment, and the
  available portable reports do not expose that split.
- Run the mandatory parity command once despite its JavaScript container dependency;
  report the missing package instead of building the web target forbidden by N8 or
  repeating the command with a mismatched prebuilt package.
- Keep the build folder and dependency junction for review, as native-common rule 2
  requires. The orchestrator owns review and shipping; this implementation was not
  pushed and started no additional agents.
