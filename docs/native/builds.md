# Native interface build measurements

K-fastui, Windows, Rust 1.99.1, 2026-11-08. These are developer build timings, not application
runtime benchmarks. The machine queue reserves its exclusive bench class for the orchestrator;
these runs used the permitted heavy class, with other queued jobs on the machine. Treat the
numbers as directional. No linker default was changed.

## Method

Both hosts and both test harnesses use the same checkout and locked dependencies. The queue's
dev/test settings apply: debug information off, workspace opt-level 1, dependencies opt-level 3,
incremental compilation. Each linker has one excluded warm-up and three measured samples, in
alternating order. No measured outlier is removed.

Each sample first builds the original source with the selected linker, then makes the same
single-file edit and measures the rebuild. Hosts and UI tests change the band's Export label
to `Export!` in `styk-ui/src/shell/text.rs`; core tests touch `field.rs` with a comment to force a
relink without changing test behaviour. Original bytes are restored after each target. Host
captures use the band at 1560x900, scale 1, through the existing headless path.

`cargo rustc --locked --manifest-path engine/Cargo.toml -p <package>` selects the host binary,
or `--lib --profile test` selects the unit-test harness (the unit graph is checked). Only the
selected root receives `-Z time-passes -C linker=<link.exe or bundled rust-lld.exe>`; the temporary
measurement environment sets `RUSTC_BOOTSTRAP=1`. Link time is rustc's `link_binary` phase.
Rebuild time includes Cargo and compilation; edit-to-PNG also includes the capture process.
This does not introduce unstable flags or a new linker into normal builds.

The first attempt rebuilt unrelated dependencies even after warm-up. The seed had hard-linked
mutable Cargo fingerprints and build-script metadata across checkouts. The attempt was discarded;
only this checkout's metadata links were replaced with private copies, preserving contents and
timestamps. The reported run rejects any warm sample that rebuilds packages outside its edited
UI/core and host. Immutable dependency artifacts remain seeded. No shared tool or seed was edited.

## Results

Seconds; medians of three warm samples. Lower is better.

| Target | MSVC link | LLD link | MSVC rebuild | LLD rebuild |
| --- | ---: | ---: | ---: | ---: |
| stykanimate | 2.273 | 1.981 | 5.440 | 5.990 |
| styk-screens | 1.163 | 1.205 | 3.312 | 3.554 |
| styk-core-tests | 1.041 | 1.317 | 2.679 | 3.029 |
| styk-ui-tests | 2.670 | 4.282 | 4.903 | 7.090 |

The default-MSVC edit-to-PNG loop measured **6.463 s through the app and 4.218 s through the preview**
(35% lower median). The corresponding LLD medians were 7.772 s and 4.408 s. The renderer and
catalogue are identical; this measures the smaller build/link host, not a different picture path.

**Decision: keep MSVC as the default for dev, test and release.** LLD improved the app's median
link phase slightly but did not improve its median rebuild, and had worse median link/rebuild
times on the other three targets. Variability is substantial (the UI-test MSVC sample reached
20.578 s linking; one app LLD rebuild reached 37.135 s). No blanket faster-linker claim or
profile change is justified by this shared-machine run. A later exclusive batch may reassess it.

### Every measured sample

Each cell lists runs 1, 2 and 3 in seconds; excluded warm-ups are retained in the local evidence.

| Target | Linker | Link samples | Rebuild samples |
| --- | --- | --- | --- |
| stykanimate | msvc | 2.017, 2.273, 2.627 | 4.706, 5.440, 7.611 |
| stykanimate | lld | 1.981, 3.206, 1.547 | 5.990, 37.135, 5.544 |
| styk-screens | msvc | 1.330, 1.163, 1.160 | 3.818, 3.312, 3.224 |
| styk-screens | lld | 0.859, 1.205, 2.920 | 3.268, 3.554, 5.036 |
| styk-core-tests | msvc | 2.896, 1.041, 0.896 | 5.344, 2.679, 2.550 |
| styk-core-tests | lld | 1.317, 0.777, 1.340 | 3.797, 2.417, 3.029 |
| styk-ui-tests | msvc | 2.020, 2.670, 20.578 | 4.375, 4.903, 24.524 |
| styk-ui-tests | lld | 1.989, 4.282, 7.594 | 4.086, 7.090, 10.150 |

Local evidence: `artifacts/fastui/link-results.json`, the per-sample compiler logs, and the
app/remaining measurement logs. These generated outputs are ignored, not release assets.

## Interface chunk jobs

- Iterate with queued `cargo check`/`cargo clippy` on the owning crates, and a separate
  `cargo build -p styk-screens` plus PNG capture for the current catalogue screen.
- At a coherent milestone, run the affected crates' tests and `cargo xtask check` through the
  queue. The latter retains the real app's reference comparisons and adds exact app/preview
  identity for every catalogue entry; it builds the preview separately to avoid feature unification.
- A linker change additionally needs the full affected Rust tests and the PE/map release-isolation
  check with that linker. Release linker settings remain unchanged here.

See [patterns.md](patterns.md) for the preview command and model boundary.
