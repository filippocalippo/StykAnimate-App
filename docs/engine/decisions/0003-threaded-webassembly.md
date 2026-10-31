# D3: One WebAssembly module with threads

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Each JavaScript playback worker held its own copy of the document. The engine needs parallel evaluation and preparation over one shared document, and synchronous queries from the interface thread.

## Decision

The engine is one WebAssembly module over a `SharedArrayBuffer` memory, run by a pool of Web Workers (`src/engine/engine-worker.mjs`). Every host sends cross-origin isolation headers (COOP `same-origin`, COEP `require-corp`, CORP `same-origin`): the development server, the desktop app scheme and the loopback host for browser development (`desktop/web-host.cjs`), the web build (`web/_headers`). A page that is not cross-origin isolated runs the same module without workers, in slices on the interface thread (`engine.pump()`).

## Evidence

URIEL 3 opens in 0.66 s once warm in WebAssembly; frames prepare in about 3.5 ms on average; a background commit is seen about 10 ms after it lands (the engine calls `Atomics.notify`).

## Consequences

The build needs a pinned nightly toolchain (D6). Memory is shared, so its maximum is fixed when the memory is created (D14).
