# D5: zstd from the C library

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Version 2 containers compress their skeleton with zstd, and unchanged saves must be byte-identical with what the vendored JavaScript/WebAssembly zstd produces.

## Decision

`styk-formats` uses `zstd-sys` 1.5.7 (the C library) at level 3, compiled natively and to WebAssembly.

## Evidence

It reproduces the bytes of the vendored build on all 448 version 2 files of the corpus.

## Consequences

A C toolchain (clang for the wasm target) is part of the engine build.
