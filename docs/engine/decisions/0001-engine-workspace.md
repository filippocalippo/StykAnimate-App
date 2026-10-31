# D1: The engine workspace grows from the measured prototype

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

The port needed a Rust starting point. `experiments/styk-native` (a Rust and wgpu prototype) already read Pivot and native files, evaluated frames and drew them, and its measurements set the performance bar for the port.

## Decision

The engine lives in `engine/` at the repository root, a Cargo workspace with one crate per concern (`crates/*`). It started as a copy of the prototype's core, which stays in `experiments/styk-native` untouched so its numbers remain reproducible.

## Evidence

Parity with the prototype on day one: Jay on a new app (repaired) matched the editor exactly and TDD2 URIEL NEMESIS 3 on 21 of 24 sampled frames (the rest was pinned IK, since ported). The prototype's numbers are in `experiments/styk-native/README.md`.

## Consequences

One owner per concern from the start: `styk-doc` (store), `styk-formats` (containers), `styk-piv` (Pivot codec), `styk-eval` (evaluation, encoding), `styk-draw` (draw-list format), `styk-render` (GPU), `styk-raster` (CPU), `styk-engine` (scheduler, mirror), `styk-wasm` (browser binding), `styk-cli` (tools).
