# D14: The shared memory's maximum adapts to what the device can reserve

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

A shared WebAssembly memory cannot move when it grows, so browsers reserve its
maximum up front. The engine is linked with a 2 GiB maximum. Mobile WebKit
(iOS, iPadOS) has a smaller address-space budget per process; a page that
cannot reserve 2 GiB must not lose the engine.

## Decision

The page creates the memory itself (`createEngineMemory` in
`src/engine/engine.mjs`) and hands it to the module: 2 GiB, else 1 GiB, else
512 MiB, the first the browser accepts. It starts at the size the module
declares for the memory it imports, read from the module's import section
(`declaredMemoryPages` in `src/engine/engine-memory.mjs`): that size grows with
the module's static data, and a smaller memory does not link, which leaves the
page on the JavaScript renderer with only a console warning. A memory of 1 GiB or less budgets the
frame cache like a 2 GiB device (48 MiB). If no maximum can be reserved the
engine does not start and the JavaScript renderer draws, as without the engine
build.

## Evidence

Measured on 2026-10-02 with Playwright's Chromium and WebKit (Linux builds),
cross-origin isolated and not: a shared memory with a 2 GiB, 1 GiB or 512 MiB
maximum is created and grows to 252 MiB in both; the engine loads threaded in
both; with the first two maxima refused (simulated), the 512 MiB memory is
used; the override is honoured. Not measured: real iOS and iPadOS devices,
whose limits differ from desktop WebKit.

## Consequences

The module's declared maximum stays 2 GiB (`scripts/engine-build.mjs`); the
page may choose less. The page also tells the engine the maximum it got
(`new EngineHandle(deviceMemory, maximumBytes)`), and the allocator keeps the last
sixteenth of it for what nothing can refuse: work that cannot be held is refused
with a message instead of the module trapping, and the caches that held the memory
are bounded ([../memory.md](../memory.md)). An allocation nothing checks that goes
beyond the maximum still traps the module; recovering from that (leaving the engine
for the session without blocking the interface) is not implemented, nor is
verification on real Apple devices.

## 4 GiB on the desktop (2026-10-24)

Not taken. The trap in the gate (tdd2 uriel nemesis, 41 MB, then a movieclip edit; a
second large document opened beside a shown one) was not a lack of address space:
decoded pictures queued without a bound (759 MiB), the editor session's typed-view cache
never released a record, and each undo and redo added the document's pictures to the
image table again (70 to 110 MiB each). With those bounded, in the desktop app:
tdd2 holds 183 MiB after opening (before: 942, 1,576 MiB of heap); tdd2, svr_uriel and
testingupload.styk open in tabs of one app, each posed, edited with a movieclip and an
effect, undone and redone, peak at 1,107 MiB of linear memory and 899 MiB handed out
(of 1,920 MiB below the reserve). Opening the three twice more, one after the other, keeps
six large documents open at 1,298 MiB handed out; the seventh open (tdd2 again) is refused
with "There is not enough memory for this. Close other projects…" (`errors.engine.outOfMemory`),
the app plays on, and a smaller document (svr_uriel) still opens after it, at 2,020 MiB of
linear memory and 1,496 MiB handed out, with no page error. One large document, or two,
leave more than 1 GiB. A 4 GiB maximum would double the address space every page reserves
for no document the measurements need, and a pointer above 2 GiB crossing to JavaScript has
to be unsigned everywhere; it can be reconsidered if a document is found whose opened
state alone nears 1 GiB.
