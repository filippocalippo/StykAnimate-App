# D6: One threaded WebAssembly build on a pinned nightly

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Stable Rust ships no atomics-enabled standard library for `wasm32-unknown-unknown`, which threads need.

## Decision

`scripts/engine-build.mjs` builds with `nightly-2026-09-15`, `-Z build-std=std,panic_abort`, target features `+atomics,+bulk-memory,+mutable-globals`, imported shared memory, and wasm-bindgen 0.2.129 (`--target web`). The output goes to `src/engine/pkg/` (D9). One module serves pages with and without cross-origin isolation.

## Evidence

The module is 4.4 MiB without wasm-opt (not installed on the development machine).

## Consequences

The toolchain is pinned in the build script and in CI; moving it is a deliberate change with a rebuild and the parity suite.
