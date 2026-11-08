# K-dev verification

All builds and tests ran on Windows through the shared heavy queue with labels beginning `V`.
The target was seeded before the first build. No frozen fixture or parity threshold was changed.
The copied encoder was used for CLI unit tests and is removed before handoff.

## Targeted results

The following are the actual summary lines from the queued checks (filtered tests are intentional).

```text
styk-trace, enabled:
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.18s
styk-trace, disabled:
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
styk-trace, documentation:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
styk-platform, dev_control_tests:
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 84 filtered out; finished in 0.02s
styk-platform, windows::instance::tests:
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 71 filtered out; finished in 2.06s
styk-core, inspect:::
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 172 filtered out; finished in 0.01s
styk-services, control::tests:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 162 filtered out; finished in 0.00s
styk-services, inspection::tests:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 162 filtered out; finished in 0.00s
xtask:
test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
styk-cli, --features app-tools --bin styk (encoder present):
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 12.51s
styk-cli, --features app-tools --test profile_cli:
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.45s
```

The export test establishes a byte-identical baseline with two existing CLI exports, compares the
scenario's PNG with that baseline, and requires identical pixel hashes across its three runs.
The protocol tests cover byte limits and exact continuation offsets. Pipe tests inspect the actual
DACL and an impersonation attempt, then cancel during accept, partial read, silent host and blocked
write. Core tests pin a revision across edits and compare original records after undo.
Renderer inspection was compiled; it performs no GPU work, and no GPU-timing claim is made.

## Guards

```text
design: 183 generated files are current
features: developer views are optional and off by default
deps: 20 engine-side crates reach no toolkit or front-end crate (styk-cli reaches styk-core, styk-services, styk-platform, styk-devtools only through its non-default app-tools feature)
lock: engine/Cargo.lock has no git source
inspection APIs: inventory current; tools import owner inspection APIs only (existing pen lab exception)
schemas: protocol and profile are current
```

## Scope

No Electron/browser suite, whole-workspace sweep, GPU timing or visual comparison was run for this
engine-only chunk. The fixture profile example is a diagnostic run on a shared machine, not a speed
acceptance gate. See `devtools-engine.md` for capability boundaries and deferred owner adapters.

## Live-thread regression

The negative control replaced the live-thread lookup with a completed-event-only lookup. It failed
on the production handler, with the open span still alive and no completed event on that thread:

```text
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 17 filtered out; finished in 0.00s
```

After restoring the live-thread lookup, the full developer-tools suite passed:

```text
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
```

Developer app build, including the optional views:

```text
Finished `dev` profile [optimized] target(s) in 1m 17s
trace: 11 names each have one owner
```

The first developer app build exposed a private clock accessor; it was made public so the reader
shares the host's injected clock. The successful build above includes that fix.

## Retained-reply regression

A negative control removed the caller's reservation while preserving the real pipe request and
worker. The regression rejected 131072 accounted bytes where the live server plus completed,
unread reply require 262144 bytes:

```text
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 89 filtered out; finished in 0.00s
```

With the reservation retained until the operation is dropped, all six transport tests passed
(the summary is above). An initial incorrectly qualified exact filter ran zero tests; that run
is not counted as evidence.

## Release fixture example

Two three-run profiles used the unchanged repository fixture `engine/tests/edit/startup.document.json`
and the `export` scenario. They ran through core document loading and `styk-export`; no GPU or
presentation timing is included. The input SHA-256 was
`6b1572a59bcc486d99881b97752b9c6771b94d4fd505c39750b1d1adaf14e543`.
Both profiles identified the build as `release`, the measurement clock as `real`, and logical time
as `fixed`. Actual output excerpts (milliseconds):

```json
{"samples_ms":[309.1197,17.9165,14.7285],"capture":{"bytes":645,"dropped":0}}
{"samples_ms":[27.0914,15.6423,12.5314],"capture":{"bytes":639,"dropped":0}}
{"a":{"max":309.1197,"mean":113.92156666666666,"n":3,"p50":17.9165,"p95":309.1197,"p99":309.1197},"b":{"max":27.0914,"mean":18.4217,"n":3,"p50":15.6423,"p95":27.0914,"p99":27.0914},"budget_missed":false,"delta_ms":-2.2741999999999987,"floor_ms":9.563999999999997,"regression":false,"verdict":"within noise"}
```

These are shared-machine diagnostic results, not evidence of a speed improvement. No threshold
was changed or run discarded. The ignored artifacts remain in `artifacts/devtools-final-a` and
`artifacts/devtools-final-b` for review.

The separate default shipping CLI build completed and its marker scan reported:

```text
Finished `release` profile [optimized] target(s) in 4m 12s
release markers: clean (1 artifacts)
```

The developer CLI was then rebuilt separately with `app-tools` for the profiles. The final
handoff also rebuilds the developer app and shipping app after merging the text changes; their
final summaries are recorded below. The shipping CLI does not enable those text or tool features.

## Merged text build

After merging the upstream text changes, the final transport/tools checks and separate app builds
reported:

```text
styk-platform, dev_control_tests:
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 84 filtered out; finished in 0.02s
styk-devtools:
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
developer app:
Finished `dev` profile [optimized] target(s) in 5m 11s
shipping app:
Finished `release` profile [optimized] target(s) in 2m 38s
release markers: clean (1 artifacts)
```

## K-frames integration

The subsequent K-frames merge changed the shared frame builder. The focused owner and CLI
integration checks were rerun on that merged tree; timings were not remeasured:

```text
styk-core, inspect:::
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 191 filtered out; finished in 0.00s
styk-engine, inspect:::
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 64 filtered out; finished in 0.00s
styk-cli, --features app-tools --test profile_cli:
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.36s
```

The earlier evaluation-inspection regression also passed:

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 81 filtered out; finished in 0.00s
```

There are no new views, so screenshot scores are not applicable. The existing unused
`styk-render::PictureState::layer` warning is outside this chunk. GPU timings and Tracy are
assigned to K-stage. The temporary tooling parser will be replaced with `styk_core::automation`
after the K-shell handoff, as required by the updated architecture decision.

Final merged artifacts and guards (queued run exit status 0):

```text
developer app: Finished `dev` profile [optimized] target(s) in 1m 14s
shipping app: Finished `release` profile [optimized] target(s) in 27.54s
release markers: clean (1 artifacts)
developer CLI: Finished `release` profile [optimized] target(s) in 24.08s
design: 183 generated files are current
features: developer views are optional and off by default
deps: 20 engine-side crates reach no toolkit or front-end crate (styk-cli reaches styk-core, styk-services, styk-platform, styk-devtools only through its non-default app-tools feature)
lock: engine/Cargo.lock has no git source
trace: 11 names each have one owner
schemas: protocol and profile are current
inspection APIs: inventory current; tools import owner inspection APIs only (existing pen lab exception)
```

Raw logs are retained locally in the ignored `artifacts/devtools-verification/` directory.
The copied encoder and temporary probes were removed for handoff; `engine/target` and the
`node_modules` junction remain for the reviewer. No screen was shown and no process was stopped.
