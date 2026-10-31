# D7: The interface thread never blocks

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

`Atomics.wait` throws on a browser's main thread, and rayon parks the calling thread. The first frame prepared on the interface thread trapped.

## Decision

Shared engine state is taken with a spinning lock whose critical sections are a queue push or a pointer swap (`styk_engine::sync::Shared`). Parallelism inside one frame uses `styk_eval::par::map`: rayon natively, sequential in WebAssembly, where parallelism is whole frames on the engine's workers. The interface thread waits with `Atomics.waitAsync`.

## Evidence

No long task on the interface thread comes from the engine in the benchmarks so far (plan section 5 and the milestone log).

## Consequences

Work that must not stall the interface goes through `Engine::spawn` or the frame scheduler, never a blocking wait.
