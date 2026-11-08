# K-dev integration: guards and the shared automation language

The required dependency merge includes K-guards (`3f147585`) and K-shell's automation parser
(`4228bdea`), through native-app `5d3e95d7`. No further catch-up merges follow it. Guard modules,
Clippy configurations and screen limits are preserved; no frozen fixture or threshold was changed.

## Changes and decisions

- Keep worker-only capture, protocol and profiling code in `styk-devtools-engine`. The existing
  `styk-devtools` remains the guarded UI crate. This preserves the UI's no-I/O/no-blocking boundary
  and gives the CLI a toolkit-free dependency closure instead of granting lint exemptions.
- Core owns inspection read models and privately adapts engine snapshots. During K-doc's exclusive
  worker handoff, new inspection requests return `DocumentsError::Busy`; earlier immutable tickets
  remain readable. This preserves ownership without blocking or inventing a partial snapshot.
- Use the platform's real clock adapter. Only trace tests enable services' `test-fakes` feature:
  the standalone enabled-trace test exposed the missing fake after K-guards moved real clocks.
- Delete the tooling parser. Add `frame`, `export` and budget declarations to
  `styk_core::automation`; reuse its existing `advance`. Budget syntax also belongs to core so
  judging budgets does not introduce a second parser. Measurement and verdicts stay in the worker.
- Headless runners reject unsupported UI steps before spawning and check actual AST/string
  capacities as well as the existing action and budget counts. Core keeps its 64 KiB script bound.
- `xtask scenario` delegates to `profile --scenario`, which uses the shared parser to find the
  input. Paths are relative to the script. All opens must match the hashed input; otherwise the
  profile's compatibility metadata would describe a different workload. Repository scenarios
  now use `styk-auto/1` and `open <file>`.
- Keep the existing pen-lab inspection-import exception. Permit only core's automation API as
  the additional developer-engine import; all owner inspection restrictions still apply.
- Leave the dependency allow-list for the orchestrator to approve, as instructed. Required changes:

| Dependency | Additional allowed users |
| --- | --- |
| `serde_json` (new entry) | `styk-cli`, `styk-devtools-engine` |
| `zmij` (new entry) | `serde_json` |
| `serde` | `serde_json`, `styk-devtools-engine` |
| `foldhash`, `indexmap`, `itoa`, `memchr`, `rustversion`, `serde_core`, `serde_derive` | `serde_json` |

These include optional dependency declarations inspected by the guard. The allow-list is unchanged.
The required toolchain has no rustfmt component; no global tools were installed.
GPU timing and Tracy remain for K-stage, as already accepted. No views were added in this chunk.

## Regression evidence

The shared-parser regression was run before implementation and failed at its actual parser call:

```text
called `Result::unwrap()` on an `Err` value: ScriptError { line: 3, message: "unknown step \"frame\"" }
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 268 filtered out
```

It now passes with frame/export/budget/advance steps and line-numbered failures. The CLI integration
also covers script-relative paths, export bytes, budget source lines and refusal of a mismatched
hashed input. Its first assertion incorrectly inspected the short answer for full-only export hashes;
requesting `--full` corrected the test without changing production output.

The earlier K-doc full-core run hit the pre-existing drawing test's minimum-duration assertion.
The required K-shell merge includes the owner's adaptive-workload repair; the final core run passes
273 tests. This chunk did not change that workload or its threshold. Inspection handoff coverage
checks the production `SessionOwner::take` transition, old ticket contents and restoration.

## Verification

All builds/tests/checks use the shared heavy queue on Windows, locked dependencies and the prescribed
environment. Output and matching shipping executables/maps are retained in `artifacts/guards-merge/`.
Release builds have debug information disabled; MSVC linker maps supply symbols and are checked
against the corresponding PE identity. Shipping and developer builds are separate.

Current parser and integration results:

```text
core: test result: ok. 273 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.40s
developer engine: test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
CLI unit: test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.53s
CLI integration: test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.38s
xtask unit: test result: ok. 37 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
native guard fixtures: tests 28; pass 28; fail 0
inspection APIs: inventory current; tools use owner inspection and core automation APIs (existing pen lab exception)
trace: 10 names each have one owner
schemas: protocol and profile are current
```

The ignored resolution, compiled trace negative control and profile-flow tests are run explicitly
with release verification. Full workspace, web and Electron suites are not run under the chunk rules.

Independent guards, transport and trace results on the final automation tree:

```text
independent guards: dependency direction and source isolation pass
interface: both Clippy guard configurations pass
screenshots: active, 4 references (5 catalogue screens)
trace disabled: test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
trace enabled: test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.23s
single-instance pipe: test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 87 filtered out; finished in 2.07s
developer control: test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 93 filtered out; finished in 0.02s
feature-resolution negative controls: test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 36 filtered out; finished in 1.18s
compiled enabled-trace negative control: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.39s
shipping features: styk-app/stykanimate clean (850 resolved entries; target x86_64-pc-windows-msvc; default features; normal/build edges)
shipping features: styk-cli/styk clean (396 resolved entries; target x86_64-pc-windows-msvc; default features; normal/build edges)
```

Both trace configurations also pass their one doctest. Changed-crate `cargo check` and Clippy
exit successfully; Clippy retains non-fatal style/test warnings, recorded in the log.

| Inherited screen guard | Differing-pixel fraction | Approved maximum |
| --- | ---: | ---: |
| band | 0.006193732 | 0.007000000 |
| band-build | 0.007753333 | 0.008000000 |
| band-dark | 0.005599003 | 0.006000000 |
| band-folded | 0.009344136 | 0.010000000 |

The existing component-sheet entry has no reference yet; it was reported as pending, not scored.

Shipping artifact and end-to-end task-runner results:

```text
stykanimate: release symbols: clean (243697 linked symbols; PE/map identity matched)
styk: release symbols: clean (190545 linked symbols; PE/map identity matched)
test profile_and_scenario_produce_comparable_release_measurements ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 56.68s
```

The flow runs two `xtask profile` commands, compares them and also runs `xtask scenario open`;
all three profiles are asserted to be release measurements. Its actual comparison output was:

```json
{"a":{"max":2.4673,"mean":1.1552666666666667,"n":3,"p50":0.5578,"p95":2.4673,"p99":2.4673},"b":{"max":1.7848,"mean":1.3924333333333332,"n":3,"p50":1.2771,"p95":1.7848,"p99":1.7848},"budget_missed":false,"delta_ms":0.7192999999999999,"floor_ms":0.35129999999999995,"regression":false,"verdict":"within noise"}
```

This is a shared-machine diagnostic, not a performance acceptance measurement. The complete final
queue exits 1 solely because `cargo xtask check` refuses the unapproved dependencies above. All
independent guard stages were also run directly so this refusal did not hide another guard failure.
The full guard's final output follows; its success is still pending the owner's allow-list update.

```text
design: 183 generated files are current
features: developer views are optional and off by default
deps: 20 engine-side crates reach no toolkit or front-end crate (styk-cli reaches styk-core, styk-services, styk-platform, styk-devtools-engine only through its non-default app-tools feature)
lock: engine/Cargo.lock has no git source
engine/deps-allow.toml:76: allow-list: serde_json may not use foldhash
engine/deps-allow.toml:123: allow-list: serde_json may not use indexmap
engine/deps-allow.toml:124: allow-list: serde_json may not use itoa
engine/deps-allow.toml:151: allow-list: serde_json may not use memchr
engine/deps-allow.toml:230: allow-list: serde_json may not use rustversion
engine/deps-allow.toml:238: allow-list: serde_json may not use serde
engine/deps-allow.toml:238: allow-list: styk-devtools-engine may not use serde
engine/deps-allow.toml:239: allow-list: serde_json may not use serde_core
engine/deps-allow.toml:240: allow-list: serde_json may not use serde_derive
engine/Cargo.lock:2557: allow-list: unapproved package serde_json
engine/Cargo.lock:4452: allow-list: unapproved package zmij
native guards failed (exit code: 1)
```

Evidence logs: `automation-red.log`, `automation-green.log`, `automation-tests-tail.log`,
`automation-validation.log` and `final-guard.log` in `artifacts/guards-merge/`. Earlier review-fix
fail-first evidence remains documented in `devtools-review-fixes.md`.
