# Native DX12 frame determinism (ND)

## Result and scope

**Platform floor, not a rendering fix.** Exact repeatability still fails on the tested DX12 stack.
Production code and the preferred DX12/FXC backend are unchanged. No pixel tolerance, quantization,
backend switch or frozen fixture change conceals the discrepancy.

Measured on Windows, NVIDIA GeForce RTX 4070 SUPER, driver 32.0.16.1742 (617.42), wgpu 30.0.1,
FXC. Investigation base: `12fc49e1775e21e42f97f23709f5dd576cbb0e0b`, descending from native-app
`337b2906603ab58b08f43f6d4c4ac6b70c40e2b3`. Evidence is in the checkout's ignored `artifacts/nd/`.
Private inputs were read in place. The retained shader uses invented geometry, with no project data.

## Confirmed cause and exclusions

The trigger is the DX12 rasterizer's `MultisampleEnable = TRUE` with four-sample RGBA8 UNORM
targets and translucent triangles on the tested NVIDIA driver. Clearing that flag, while keeping
four samples, removes the independent reproduction. wgpu 30.0.1's DX12 backend sets it whenever
the sample count exceeds one. The precise vendor implementation responsible is not observable;
attributing it to a particular compression or scheduling optimization would be speculation.

1. **Freeze and inspect the production path.** A single immutable evaluated draw list, the same
   compiled pipeline, the same device and sequential render/readback still change bytes. On A/131
   at 1080p, 29 of 29 comparisons differed; D/541 at 4K differed in 16 of 29. There is no new
   evaluation or shader compilation between those frames. A/131 uses triangles, analytic strokes
   and isolated groups, without effects, glyphs or paints. There are no shader atomics or reductions.
   Reading all four samples found identical isolation targets and resolved layer atlases, but
   different main-target samples. One pixel changed from sample values `255,255,162,255` to
   `231,231,231,231` (RGB, each sample opaque), resolving to 232 versus 231. The difference
   remained when the main samples were stored and read **before** a separate resolve pass.
   This excludes PNG encoding, readback rounding, MSAA resolve alone, tile/submission overlap,
   stale layer contents and upload/use races as the source of that failure.
2. **Remove the renderer altogether.** `msaa_determinism.rs` creates an independent wgpu pipeline:
   one opaque triangle and two constant-alpha quads repeated on a grid, 4x MSAA, RGBA8 UNORM,
   premultiplied blending. No production renderer, shader, document, vertex buffer, sampled texture,
   uniform, upload, cache or tile is used. Readback is local to the test and checks mapping errors.
   Repeating the same draw on each of three fresh DX12 devices changed two of 29 frames, by one
   channel level. Disabling FXC optimization reproduced the same failure. Keeping primitive order
   but issuing one draw per shape made the discrepancy reproducible in every comparison (86 pixels
   in the initial standalone probe). Vulkan and all-opaque DX12 controls were byte-identical.

3. **Remove wgpu and shader translation.** A temporary C++/HLSL program used D3D12 directly,
   FXC shader model 5.1, feature level 11.0, explicit clears, resource transitions, resolve,
   fence completion and mapped readback. It drew the same invented triangle/quad grid. With
   `MultisampleEnable = FALSE`, all three devices gave 0/29 changed frames, including partitioned
   draws. Changing only that flag to `TRUE` gave 2/29 changed frames on each device, at iterations
   12 and 26, just like the wgpu reproduction; partitioned draws differed in 29/29 comparisons.
   Toggling `IndependentBlendEnable` did not affect the result. Logs: `direct-flags.log`,
   `direct-raster.log`, `direct-raster-split.log`, `direct-blend.log`, `direct-both.log`.
   The diagnostic source was removed after use; the portable wgpu reproducer is retained.

The constant, flat fragment output and unoptimized-FXC control rule out our analytic coverage
arithmetic and FXC optimization as necessary causes. Direct D3D12 reproduces it without wgpu,
Naga, Rust or StykAnimate. Fresh devices, explicit clears and completed readbacks exclude an
uninitialized application resource or an in-flight application buffer. This is a platform/driver
floor on this machine, not a statement about every NVIDIA driver or GPU.

For feature levels 10.1 and higher, Microsoft's [D3D12 rasterizer-state contract](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_rasterizer_desc)
says this flag selects the line algorithm and does not change triangle MSAA. The four-sample
target remains four-sample in the stable control. The experiment therefore does not merely
disable antialiasing to hide the error.

## Attempts and rejected changes

- Storing multisample attachments and reading them before resolving did not remove the difference.
- Invariant vertex positions, linear-center interpolation and explicit sample coverage/masks did
  not remove the production failure. Reconstructing world coordinates from fragment position
  still changed one of 29 A/131 frames.
- FXC without optimization happened to stabilize A/131 in a short run, but the independent
  constant-color case still failed. It is not a fix.
- Splitting draws changes pixels even with identical primitive order. It did not establish a
  parity-preserving remedy; the independent assertion exposes that change directly.
- Single-sample rendering removes the failure but changes smooth-edge coverage. Vulkan was stable
  in the controls, but FP already measures a worse native/reference floor on Vulkan. Neither
  change meets the unchanged-frame contract, so the shipping choice remains DX12/FXC.

**Rejected dependency workaround:** with the owner's authorization, wgpu-hal 30.0.1 was temporarily
vendored and changed only to set `MultisampleEnable` for multisampled line topologies. All six
diagnostics then passed, but FP's nine sets worsened from 1,286 to 2,053 differing pixels, with 767
newly differing pixels and maximum error 2 to 11. Counts became `71,207,134,242,489,5,467,270,168`.
The FP stop gate prevented further export/timing sweeps. The owner chose the proven driver floor
over that parity loss, so the vendor folder and Cargo changes were removed. Shipping DX12 is
unchanged. The full decision and preserved upstream issue draft are in
[the accepted floor](../../../../docs/native/frame-parity.md#dx12-msaa-repeatability-driver-floor).

## Exact reproducer

Run from `engine/` through the machine queue:

```text
cargo test -p styk-render --test msaa_determinism dx12_ -- --ignored --test-threads=1 --nocapture
```

The DX12 tests are marked ignored **because they document an unresolved platform floor**, not
because one-level errors are acceptable. Their predicates require zero differing pixels and
fail with the measured stack. The opaque DX12 control is also ignored with the same floor link.
The Vulkan repeat/fresh-device and partition controls run in normal renderer suites; byte-for-byte
export comparisons explicitly select Vulkan. A requested backend or failed
map is an error, never a silently passing test. Compiler selection and flags are pinned in the
test, regardless of environment or Cargo profile. Same-device repeats, fresh-device comparisons
and order-preserving draw partitioning all assert exact bytes.

After a driver/wgpu update or an actual remedy, rerun these tests and the six private-input ticks
three times. Also rerun FP's nine sets and paired timings before changing the production policy.
Passing one short repeat does not establish determinism: the standalone discrepancy is intermittent.

## Initial floor verification (32c41019, before the rejected workaround)

Production source is unchanged. The before and rebuilt-after executables have SHA-256:

```text
before bae10d690d09acd2626c3290d45e7ea662ffd05eea468154f3dfc7f76476d4e3
after  81b4fc121e0ec1e6ebeb63226cc3dc3ecfc81e090bd7c35d7c0e745e3f3f2807
```

Three fresh process exports per case, differing pixels in runs 2 and 3 versus run 1:

| Input/tick | Size | Before | Rebuilt after |
| --- | --- | --- | --- |
| A/131 | 1920x1080 | 33, 2 | 0, 89 |
| A/138 | 1920x1080 | 1, 1 | 0, 0 |
| A/181 | 1920x1080 | 2, 2 | 0, 0 |
| D/571 | 1920x1080 | 0, 0 | 0, 0 |
| D/541 | 3840x2160 | 0, 0 | 10, 10 |
| D/544 | 3840x2160 | 7, 7 | 0, 0 |

All nonzero differences are one channel level. PNG hashes agree exactly when the RGBA hashes
agree. **Three-run equality fails**, exit 1; a zero row is a short-run observation, not a fix.
The input frames already fail before encoding, so videos were not re-encoded to claim equality.

FP's original references were read in place, never regenerated. All nine sets have exactly the
same before/after difference counts and maxima: `71,95,134,48,156,4,467,158,153` pixels, totaling
1,286 of 21,120,000 pixels across 59 frames. Worst differences remain one level; FP's second
set still has a two-level maximum. The strict before/after summary assertion exits 0 (`final-summary.log`).

Paired directional timing in one heavy job, alternating before/after order; three process pairs
per case, each reporting draw-plus-readback p50 over 30 repeats. Median of those three p50s:

| Case | Before (ms) | Rebuilt after (ms) |
| --- | ---: | ---: |
| A/131, 1080p | 9.39 | 9.42 |
| D/541, 4K | 42.63 | 42.05 |

These are directional measurements of unchanged production code, not a claimed optimization.
Individual values and binary hashes are in `timing/summary.json`.

- `cargo check -p styk-render --test msaa_determinism`: exit 0.
- `cargo test -p styk-render`: 59 passed, 0 failed, 6 explicitly ignored diagnostics; exit 0.
- Explicit diagnostics, both initial and final source: `test result: FAILED. 3 passed; 3 failed;
  0 ignored`; exit 101. The three DX12 assertions fail first and remain failing; Vulkan repeats,
  Vulkan partition and opaque DX12 pass. No assertion was relaxed to make this a green fix.
- `cargo clippy -p styk-render --test msaa_determinism --no-deps`: exit 0, no new test warnings.
  Plain clippy is blocked by ten existing `clippy::eq_op` errors in unchanged `styk-math`.
  A later invocation hit a transient Windows proc-macro DLL link lock; the retry passed.
- `cargo build --release -p styk-cli`: exit 0.
- `cargo xtask check`: exit 0, including 24 screenshot references and preview parity
  (the two engine-dependent stage screens are explicitly app-only).

All builds, GPU checks and measurements used the machine queue. Frozen references, thresholds,
shipping backend policy and production sources remain unchanged. The retained test and this
record are the ND deliverable; identical DX12 export frames remain an open platform limitation.

## Accepted-floor audit (2026-11-08)

The current policy is the linked floor in `docs/native/frame-parity.md`. Exact comparison sites
were traced through renderer/export/core tests and repository tools. These now select Vulkan
explicitly, independent of `WGPU_BACKEND`: `styk-render/tests/{glyphs,sprite_pages}.rs`,
`styk-export/tests/{export,frame_into,policy_gpu}.rs`, `styk-core/tests/{stage_painter,stage_surface}.rs`
and `scripts/native-preview-check.mjs` (only app/preview byte identity). The two Vulkan controls
in `msaa_determinism.rs` are normal tests; all four DX12 diagnostics remain explicitly ignored.

`styk export --verify` and `scripts/smoke-export-determinism.mjs` remain exact diagnostic tools,
with a message linking the floor; differences still fail. The generic image-diff and PNG-compare
tools compare supplied files without asserting any backend's repeatability. Video hash output
records the selected adapter and does not itself assert equality. CPU/cel, DOM screenshot,
serialized-file and draw-list comparisons do not repeat DX12 MSAA frames. Texture uploads,
single-sample ink, clear-only host presentation and the opaque cross-backend clip-position
regression keep their existing coverage. The separate reference screenshot check and production
GPU preference remain unchanged.

Decisions: retain the opaque DX12 control with the ignored diagnostic family so a future driver
check runs the controls together; promote Vulkan controls to normal tests to keep an exact
repeat/fresh-device regression. Preserve the preview guard's existing headless capture mode
(no window) while all queued jobs retain `STYK_BACKGROUND_WINDOW=1`. Do not repeat private export
or timing sweeps after the owner accepted the floor; the historical evidence above remains labeled.

### Accepted-floor verification

One heavy queue job, label `D2 accepted DX12 floor verification`; logs in `artifacts/nd-floor/`:

- Targeted `cargo check` and `cargo clippy --no-deps`: exit 0 (existing warnings only).
- `cargo test -p styk-render -p styk-export`, once: renderer **61 passed, 0 failed, 4 ignored**
  DX12 diagnostics; export **47 passed, 0 failed**. Both normal Vulkan controls pass.
- `cargo test -p styk-core --test stage_painter --test stage_surface`: **17 passed, 0 failed**;
  the existing private-input stage benchmark remains ignored.
- Both modified scripts pass `node --check`; native guard unit tests **20 passed, 0 failed**.
- `cargo xtask check`, once: exit 0; dependency allow-list and source guards pass, **24 reference
  screenshots** pass, **23 preview PNGs byte-identical**, two stage screens explicitly app-only.
- Rebuilt debug CLI on the public color-transitions fixture, DX12 `--verify 2`: **1 frame x 2 runs,
  0 differing frames**, with the floor explanation printed. This checks the diagnostic message,
  not the absence of the intermittent driver floor. The old release executable in the target
  folder is not a verified artifact of this change.
- `vendor/wgpu-hal` absent; `engine/Cargo.toml` and `engine/Cargo.lock` match the accepted base.
  No dependency allow-list entry is needed. Frozen fixtures and thresholds are unchanged.
