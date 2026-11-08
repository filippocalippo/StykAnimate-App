# K-dev review fixes

The review of `e82a1b66` found three major defects. This record supersedes the earlier
literal-marker release-isolation evidence in `devtools-verification.md`.
All builds/tests below run in the shared heavy queue. Frozen fixtures and thresholds are unchanged.

## Linked release code

The new compiled negative control uses enabled `styk-trace`, calls `mark!` and reads `ring_bytes()`.
With the old guard, the executable and its map were both accepted:

```text
optimized trace code escaped the guard: release markers: clean (2 artifacts)
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.95s
```

After replacing literal scanning with PE-associated linker-symbol inspection:

```text
test result: ok. 37 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
compiled_enabled_trace_is_rejected:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.68s
developer_cli_resolution_is_rejected:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 37 filtered out; finished in 3.34s
shipping features: styk-app/stykanimate clean (850 resolved entries; target x86_64-pc-windows-msvc; default features; normal/build edges)
shipping features: styk-cli/styk clean (396 resolved entries; target x86_64-pc-windows-msvc; default features; normal/build edges)
release symbols: clean (148808 linked symbols; PE/map identity matched)
release symbols: clean (190507 linked symbols; PE/map identity matched)
```

Commands used separate invocations of `cargo rustc --manifest-path engine/Cargo.toml --locked
-p styk-app --bin stykanimate --release -- -C link-arg=/MAP:<absolute.map>` and the corresponding
`-p styk-cli --bin styk` command. The environment kept `CARGO_PROFILE_RELEASE_DEBUG=0`;
no debug-info increase or PDB scan was used. `check-shipping-features` runs `cargo tree -e
normal,build,features` for those packages/default features and the rustc host target, with locked
resolution. Its negative control resolves the real CLI graph with `--features app-tools`.
The artifact check requires a nonempty symbol table, PE/map module/timestamp/image-base agreement,
and rejects mangled trace/devtools symbols. The map is link evidence, not a scan for string literals.

## Picture-pressure export

A new synthetic three-picture fixture has 768 decoded RGBA bytes. The test first establishes two
identical pixel hashes with a 4096-byte pending-picture budget, then runs the production profile
host with 512 bytes. Each picture fits individually; all three do not. The old profile loop failed:

```text
called `Result::unwrap()` on an `Err` value: "export frame unavailable"
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s
```

An earlier fixture draft failed pose validation; that failure is not counted as regression evidence.
The fix consumes/uploads a bounded batch between engine steps, continuing until no images remain.
It also supplies the CPU renderer's normal asset source for pictures evicted from its bounded cache.

The fixed production pressure path and existing CLI integration checks passed:

```text
profiled_export_drains_pictures_under_pressure:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s
profile_cli:
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.40s
```

## Comparable task-runner measurements

The ignored, explicitly queued `xtask/tests/profile_flow.rs` regression runs two real `xtask profile`
commands and then `xtask compare`. The old task launcher successfully produced profiles, but
comparison rejected their debug build labels:

```text
{"cause":"comparison requires release builds and a real measurement clock","hint":"profile <file> open|frame|export|scenario.styk-auto [--out new-directory] [--runs 3..32]","input":null,"what":"developer command failed","where":"profile"}
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 33.99s
```

The measuring CLI operation now selects `--release`; both `profile` and `scenario` use it.
The same test then passed, also running `xtask scenario open` and checking all three profile labels:

```text
task-runner comparison: {"a":{"max":1.9685,"mean":0.9515333333333333,"n":3,"p50":0.48840000000000006,"p95":1.9685,"p99":1.9685},"b":{"max":1.5569,"mean":0.8236666666666668,"n":3,"p50":0.4983999999999999,"p95":1.5569,"p99":1.5569},"budget_missed":false,"delta_ms":0.009999999999999842,"floor_ms":0.2721000000000002,"regression":false,"verdict":"within noise"}
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 48.25s
```

This checks comparability, not a performance target. A regression verdict is also a valid test
outcome; the test does not retry or tune a threshold. Non-measuring inspection/schema/compare
commands still use the dev CLI build. The retained profiles are in
`artifacts/xtask-profile-flow-26500/`; shipping executables and matching maps are preserved together
in `artifacts/release-isolation/`, independently of later developer builds at the Cargo output path.

## Final guard results

```text
xtask: test result: ok. 37 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
design: 183 generated files are current
features: developer views are optional and off by default
deps: 20 engine-side crates reach no toolkit or front-end crate (styk-cli reaches styk-core, styk-services, styk-platform, styk-devtools only through its non-default app-tools feature)
lock: engine/Cargo.lock has no git source
trace: 11 names each have one owner
release symbols: clean (148808 linked symbols; PE/map identity matched)
release symbols: clean (190507 linked symbols; PE/map identity matched)
```

The ignored resolution test was explicitly run separately (2 passed, including the parser test);
its ignored status in the ordinary unit run is not a missing check. The existing unused
`styk-render::PictureState::layer` warning remains outside scope. There are no views or screenshot
scores, no changed frozen fixtures, no tuned thresholds and no additional review round.
