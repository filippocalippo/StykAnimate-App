# D10: Never strip the WebAssembly profile

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

wasm-bindgen's thread transform finds each thread's stack pointer and thread-local base by symbol name. With `strip = true` it picked the wrong globals and the module corrupted memory on its first allocation.

## Decision

The `wasm` Cargo profile sets `strip = false`; wasm-bindgen removes the name section itself (`--remove-name-section`) after its transform.

## Evidence

The app loads and runs; before the change it hung at the first allocation ("memory access out of bounds").

## Consequences

Size is reduced by wasm-opt and wasm-bindgen, never by Cargo's strip.
