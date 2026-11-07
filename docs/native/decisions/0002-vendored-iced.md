# N2. iced and its pre-release dependencies are vendored at one revision

**Date:** 2026-11-06. **Status:** accepted.

**Decision.** iced is used at git revision `8ff48c42b0d5188223501ea1ccc506fd5beaf36a`, the first that uses wgpu 30, the
engine's version. It and its own git dependencies (`iced-rs/winit` at `48116469f15d3bc52b5e56bb516694be8882870d`,
`iced-rs/cryoglyph` at `cf38ed5ea0cfe95270b31ced2910560a7fcc5003`, `hecrj/cosmic-text` at
`6adc2364289fd241daed751948a03d0aea5a31ca`) are copied into `vendor/` and patched in by path, so `Cargo.lock` holds no
git source. Each folder has a `VENDOR.md`: upstream, revision, what was left out (examples, benchmarks, docs), and every
local fix with its reason and the upstream issue.

**Why.** The API of this pre-release iced moves between revisions (four breaking changes showed up in one test), and a
git dependency can disappear or be force-pushed. A copy in the repository can never break the build from outside, keeps
fixes reviewable as ordinary diffs, and keeps iced and the engine on one wgpu device. A git submodule would need a fork
repository published on GitHub, which is the owner's call.

**Moving on.** iced 0.15, when it ships, replaces the copy in one deliberate change behind a gate (all suites, the
screenshot comparison, the benchmark). CI fails if `Cargo.lock` gains a git source.
