# Engine: WebAssembly, threads and scheduling

How the engine runs in the app (`engine/crates/styk-engine`,
`engine/crates/styk-wasm`, `src/engine/*.mjs`), and why
([D3](decisions/0003-threaded-webassembly.md), [D6](decisions/0006-pinned-nightly-wasm.md),
[D7](decisions/0007-interface-thread-never-blocks.md)).

## Pieces

- `Engine` (`styk-engine`): the open document as a `Generation` (lineage,
  revision, prepared document, assets), a task queue, the frame cache and
  image decoding. Every change publishes a new generation; results computed
  for an older one are dropped.
  Publication retires only queued decodes and redecodes of the replaced lineage.
  Generic `Engine::spawn` jobs and work owned by another lineage survive in their
  existing order, before new publication work and frames; idle jobs still follow
  frames. Queue nodes are detached without allocating or disposing payloads under
  State; retirement releases the removed nodes and generation on a worker.
- Frame scheduler (`frames.rs`): the interface admits ticks with
  `try_request_samples`; workers evaluate and encode them (`FrameData`: draw
  list, camera, background). `Budgets::for_device` supplies the existing logical
  eviction target (48–384 MiB by `navigator.deviceMemory`, and at most a sixteenth of the memory:
  [memory.md](memory.md)); the protected playhead
  and separately retained payloads prevent treating it as a physical memory cap.
  Try hidden/effects setters advance the epoch; playback retries only its latest
  pending controls while Busy keeps it cold.
- Images: decoded on workers (`take_images` hands them to the renderer a few
  megabytes per frame, and only a budget of them is decoded ahead of it: [memory.md](memory.md));
  drawing cels decode one task each. The stage remembers which
  atlas places it uploaded (`Uploaded`); a frame drawn while some picture it shows is
  still on its way is drawn again once it can be shown (`Stage::pictures_pending`:
  on the next frame for pictures decoded and waiting, else after the progress counter
  advances; `waitForPictures` in `engine-stage.mjs`). A document with more sprite pages than the stage's texture keeps
  (`Engine::atlas_pages`) is not decoded whole: the workers make the soft copy of each picture as the document opens (`Picture::Soft`),
  the stage asks for the pictures a frame draws (`Engine::decode_images`, ahead of the queue, three at a time) and for those of
  the ticks playback and the person are about to reach (the table `Engine::picture_row` reads, made by `Engine::spawn_idle`
  tasks that run after everything else), and draws a frame soft where a picture is not in yet
  ([memory.md](memory.md#pages-kept-against-a-budget-soft-copies-in-their-place)).
- `styk-wasm`: `EngineHandle` (commands and queries over wasm-bindgen),
  `Stage` (a wgpu surface on a canvas, edit frames and ghosts, prepared
  frames), `worker_run` (a worker's loop).
- `src/engine/engine.mjs`: loads the module with shared memory, starts
  two workers at launch (`engine-worker.mjs`); `grow()` starts the rest, up to `navigator.hardwareConcurrency - 1` and at most 8, when a file or a
  large document opens, when playback prepares frames for someone waiting (not the idle warm-up) and when an export starts, so an empty editor holds
  two threads (about 40 MiB less than eight). Work queued meanwhile runs on the threads there are. Without cross-origin isolation the same module
  runs without workers through `pump()`. `src/engine/engine-start.mjs`, the page's first script (index.html), asks the browser for the scene's WebGPU adapter at once
  (`engine-adapter.mjs`: the answer takes most of a second on a first launch, so it comes back while the engine loads; it is handed to the
  engine's own request with the same options, and its description is the adapter's name in the status line), loads the engine and starts the
  stage over the scene canvas as soon as the module is instantiated, before its threads have joined (`loadEngine({stage})`); the application's
  `loadEngine()` and `createStage()` take what it started (`stageHandoff`). The engine asks for each device's adapter once
  (`styk-wasm` `gpu.rs`): WebGPU where the browser gives an adapter, else WebGL2, with no separate detection request. `join` hands another thread what it needs to join the engine (the
  compiled module, the memory, a stack size, the progress counter's address).
- The export worker (`src/engine/engine-export-worker.mjs`, one per export, see
  [rendering.md](rendering.md#exports)): joins the shared memory like a preparation
  worker but keeps its event loop, because its GPU device (WebGPU in the worker, else
  WebGL2 on an `OffscreenCanvas`) answers through promises. The export dialog starts
  one when it opens (`warm`: joining the engine and getting an `ExportDevice`);
  `ExportRenderer` (`styk-wasm`) takes the device, pins the export's revision
  (`styk_engine::export::ExportFrames`),
  asks the preparation workers for the next frames and its pictures, draws and reads
  back. It ends with `release`: the device is destroyed, the read-backs it rejects
  settle (their answers run through the module), then the renderer is freed and the
  thread's stack and thread-local storage given back (`__wbindgen_thread_destroy`)
  before the worker closes, with no turn of its event loop in between (a call into the
  module after the destructor writes through a stack the shared memory has taken back:
  cancelling an export of URIEL 3 crashed the page that way until the answers were
  let through first); a worker that does not answer within 5 s is terminated only if it is outside the engine at that moment
  (what it held then stays allocated in the shared memory; see "Ending a worker" below). A worker that gets no GPU
  device draws the export with the CPU rasterizer (`ExportRenderer::create_cpu`,
  styk-raster), each tile when asked for. Pages that are not cross-origin isolated
  cannot export.
- The document export worker (`src/document-export-worker.mjs`, kept for as long as exports follow one another) joins the
  shared memory and calls `export_document` (`styk-wasm`) on the engine's document at the editor's revision (Pivot and figure
  files), or `save_project` on the snapshot of an edit session (a `.styk` project), as one synchronous stretch of work that asks a
  flag in shared memory for cancellation between the ticks it bakes or the steps it takes (see
  [document.md](document.md#exports-of-the-document)). It is never terminated while it is inside the engine (see "Ending a worker"):
  the interface raises the flag and sends `release`, the worker finishes the call it is in, gives its thread back
  (`__wbindgen_thread_destroy`) and closes. A project save also lends the work of its three hashes and three frames to up to three of the engine's other workers as ordinary tasks
  (`Engine::run_together`: whoever starts a job first owns it, and the save thread runs what no worker has started, so a save never waits
  for a worker that does not come); the preparation workers keep at least one thread free. A job owns everything it touches (`'static`; the blocks are `Arc`s): a worker may still be running one when the save has returned, whether it failed, was stopped, or lost its own thread (WebAssembly aborts on a panic, and `__wbindgen_thread_destroy` gives the stack back), and nothing it reads or writes may be freed meanwhile. A job that panics (where panics unwind) is caught and the wait ends with `JobsFailed::Panicked`; a thread that traps cannot say so, so the page reports the `error` event of an engine thread (`EngineHandle.worker_lost`, `engine.mjs`) and the wait, which looks every 25 ms, ends with `JobsFailed::WorkerLost`. Either is a failed save with the code `worker_failed` (`errors.documentExport.documentExportFailed`): the previous file and the unsaved work are untouched and the next save works. A save that is cancelled drops the result; a compression that takes a while after the
  cancel costs only CPU, and the next save gets a worker of its own at once. The flag is raised on every path that ends the worker.
- The preview worker (`src/engine/engine-preview-worker.mjs`, one per page,
  `engine-previews.mjs`; see [rendering.md](rendering.md#thumbnails-library-previews-and-the-camera-monitor)):
  joins the shared memory like the export worker and keeps its event loop for a GPU
  device of its own, on which it draws library files' posters and hover animations
  (`styk_wasm::preview::Previews`), or the CPU rasterizer where it gets none; it also
  draws on the CPU the frame thumbnails the stage cannot draw, from the engine's document
  (waiting on the progress counter for their frames and pictures, as the export worker
  does). It starts with the first request, runs requests one
  at a time and is released after five idle minutes, as the export worker is (device
  destroyed, pending answers let through, then the thread destroyed); it is never
  terminated to cancel a preview (a cancelled request's answer is dropped), and never while inside the engine ("Ending a worker").
- Frame thumbnails and the camera monitor are drawn by the stage on the interface
  thread (`styk-wasm/src/views.rs`), the only work done there being the draw itself:
  a thumbnail's frame is prepared on the preparation workers (`ExportFrames::prefetch`)
  and the interface waits for it on the progress counter; `ExportFrames::ready` only
  looks.

## Rules

- The interface thread must never block. Readiness and admission use one-shot
  `Shared::try_lock` and return cold or Busy without replacing the current owner.
  `Shared::lock` can wait and belongs on workers or synchronous tools; a short
  critical section does not justify interface spinning. Waiting is cooperative
  `Atomics.waitAsync` on the engine's progress counter, which Rust bumps with
  `Atomics.notify`. Read the
  counter (`progressSeen()`) before checking for a result and wait with that value
  (`whenProgress(seen, timeoutMs)`): both waitAsync and polling use the
  requested timeout (default and ceiling 250 ms; cache/project retries
  use 16 ms). An idle lock can release without publishing progress. A timeout
  rechecks readiness without changing the counter. Publishing the document (`Engine::activate`,
  `publish_tree`, [document.md](document.md)) takes the document's lock only for pointer exchanges;
  a worker that reads the document (an edit session starting) tries it once.
- **No blocking lock on the interface thread, whatever its critical section.** `Mutex::lock` waits with `memory.atomic.wait32`, which
  throws on a page thread (`RuntimeError: Atomics.wait cannot be called in this context`). The exception passes through the engine's frames
  without unwinding them, so the objects the call was made on (the `Stage` and the `EditSession` it was given) stay marked as borrowed for
  good: every later call answers `recursive use of an object detected which would lead to unsafe aliasing in rust`, the stage stops drawing,
  and a save cannot take its snapshot, so the project cannot be saved from that session. It happened on a movieclip's scene cache (`styk_eval::geometry::clip_scene`,
  taken by the interface thread and by the workers that prepare frames; seen on a project restored after a crash, whose frames were being
  prepared as it opened). A mutex the interface thread shares with workers is therefore taken with `styk_doc::lock::once` (one
  attempt: a cache is skipped where busy and the work done again) or, where the interface thread cannot go without it (the engine's
  store, the picture and snapshot registries), `styk_doc::lock::spinning`; `Shared::try_lock` and `Shared::lock` are the engine
  state's own. The interface smoke `scripts/smoke-movieclip-save.mjs` (`STYK_TRACE_WASM=1`) names the first call that throws.
- No rayon in WebAssembly: `styk_eval::par::map` is sequential there;
  parallelism is whole frames on workers.
- Library code has no clock, file or thread of its own: the host injects a
  clock (`styk_wasm::clock`), and native tools use rayon through `par`.

## Ending a worker

A thread of the shared memory ended in the middle of a call into the engine can hold its allocator or a lock for good, and every thread
that needs them then waits for ever (the engine freezes). So the interface never ends a worker that is inside the engine, and does not
rely on the engine work being short. `src/engine/engine-guard.mjs`: every worker that joins the engine has a *guard*, a word of shared
memory the interface creates (`workerGuard`) and sends with its first message. The worker holds the guard (`inside`) for each
synchronous stretch in which it calls the engine: joining, the document export or save, the renderer's and the previews' methods
(`guarded` wraps an object so that every method call is such a stretch), and giving its thread back. The interface ends a worker
(`releaseWorker`) when it answers `release` with `released`, or when 5 s have passed and it can *claim* the guard (compare-exchange
from outside to claimed); a worker that finds the guard claimed does not enter. Exactly one of the two wins. A thread holds one count however many views of the word it was sent (every message brings a new one). An `error` event from the worker ends the watch and the worker: the exception has unwound its stretches, and the guard with them. A worker found inside is
looked at again 5 s later (the `release` it was sent waits in its queue): the cancel flag the caller raised (for a save) makes the engine work stop at its next question, and the
worker releases when the call returns. Promise continuations the engine runs after a GPU read-back settles (the export and preview
workers) are not wrapped; they are short and run in the event loop, where the worker answers `release` between them.

## When an engine thread traps

WebAssembly aborts on a panic: the thread's wasm instance traps, no destructor runs, and the thread cannot report its own end. What follows, and what the engine does about it:

- **A save's own thread** (the export worker). The worker's own `catch` turns the trap into a reply (`{ok: false, error: {…, trapped: true}}`; `engine-document-export.mjs` marks as trapped anything a call into the engine throws that is not the engine's JSON failure, whether the `unreachable` of a panic or a JavaScript exception thrown through its frames), so it is that reply that the page sees; an uncaught trap shows as the worker's `error` event instead, and both end the same way. A failure the engine reported came back through a destructor that dropped its reservation already; the page names it again for every failed reply, which is harmless, and not for a cancel or a timeout, where the worker is still running. The save fails with the localized message of the failure (`errors.documentExport.theDocumentExportWorkerStopped`; the engine's own text, `unreachable`, is kept as the error's `cause` for the diagnostics). The memory the save had reserved was held by a guard that died with the thread's stack, so the save names its reservation (`styk_alloc::reserve_named`, a number the interface chose and sent with the save) and the page gives it back (`EngineHandle.release_reservation`); a reservation left to leak would refuse every later save and edit. The job a helper had is the next case. Whoever shows a failed save (`fail()` for every save a person asks for) says it; `performNativeSave` itself leaves the status line at "Save failed" and ends the busy task, so a caller that does not show it never leaves "Saving project…" on the screen.
- **A helper of a save.** The page reports the thread (`worker_lost`), the save's wait ends with an error (`Engine::run_together`, above). Nothing can be done from outside for the memory that thread held: its stack and whatever it had allocated for the job (about 270 MiB after a helper trapped in the frames of tdd2) stay allocated to the end of the session. Nothing frees it, and nothing in the engine reads it.
- **Other waiters on a dead worker are not handled.** A frame job on a thread that trapped leaves its tick in flight (`Storage.inflight`) until the next revision or grid change clears it, so that frame is never prepared in between; an image re-decode on one keeps `images.preparation_active()` true, which holds back ordinary tasks and frames (`frames/cache.rs`) until the preparation is cancelled. A small step through `workers_lost` would close both: when the count moves, clear `inflight` (and requeue the wanted ticks) and cancel the image preparation, under the state lock, with the epoch bumped so a late result of a live worker is refused. It needs a trapped thread to test against and is not done: a thread that traps inside the state lock leaves it locked, which nothing outside can undo.

## Prepared samples

The native host's request owner is [`styk_core::frames`](../native/frames.md).
Its bounded consumer slots, revision/resource identities, worker-owned ready cache
and borrowed presentation callback are separate from the browser's existing cache
controls below. Both prepare through the engine's common `frame_builder` pipeline;
the native interface never calls a synchronous frame preparation entry.

Fractional interface playback requests use `Engine::try_request_samples` and `frame_at`
on the existing frame cache. `FrameData::tick` is now `f64`; integer entry points remain
available. A request does not synchronously prepare a cold sample on the interface.
`Engine::prepared_frame` tries the current State and same cache Storage once,
checking generation, cached frame and epoch coherently. `frame_matches` checks that same identity
without retaining a draw list. App keys are `engine:generation:epoch:sample`; hidden
figures, effect settings and resource-bound changes supersede them even if the same
sample is already ready again. Metadata and native drawing both validate this ticket.
Cold or stale reads do not prepare work and do not advance the actual shown head.

`FrameSnapshot`, `Engine::{prepared_frame,frame_matches,frame_epoch_current,
prepared_frame_now_at}` and `MonitorFrame::prepared_ticket` are additive portable APIs
for the mobile pin. `prepared_frame_now_at` is explicitly worker/CLI preparation: it
returns the actual produced snapshot even when immediate cache trimming evicts it,
preserving the existing `frame_now_at` and explicit wait-render behavior. The browser
adds `EngineHandle::frame_ticket_ready`, generation/epoch metadata, `Stage::render_ticket`
and the fixed five-scalar `shown_identity` getter: kind, generation, exact sample or
edit stamp, prepared epoch, edit-effects flag. It changes only after a successful draw.
This closes prepared-ticket substitution; shared-State latency, dense retirement and
live edit-scene preparation remain in the D7 audit, rather than being certified here.

Camera monitor and preview work share this prepared owner and resource readiness.
Their complete presenter leases, retained charges and final-drop threads remain part
of the D7 audit; a weak frame identity alone does not certify last-owner retirement.

The cache retains one Storage owner plus a small control head in State. Workers move
coalesced controls under State after acquiring Storage; they never wait for Storage
while holding State. Dense construction, scanning, sorting, reset, completion, trimming
and rejected-frame disposal run outside State. Actual State allocation/drop probes and
held-lock tests cover these paths. Existing logical estimates, 90% trimming and protected
playhead behavior remain unchanged. Physical DrawList/Generation/style/glyph ownership,
presenter leases, aggregate charging and shutdown ACK are still open.

Portable pin additions are `FrameAdmission` (Busy=0, Unchanged=1, Applied=2),
`FrameMetadata`, `GenerationHeader`, Engine try request/settings/header/generation/stats/
images methods, `frame_ready_at`, `frame_metadata`, `generation_for_frame_epoch` and
`generation_identity_now`. The scalar identity reader delegates to the same four-scalar
header owner; no document returns zero identity, while contention returns Busy.
Existing integer and explicit worker preparation APIs remain available.

Mobile pin compatibility: `Engine::stage` now returns a checked result and
`FrameData::tick` changes from `u32` to `f64`. Callers should retain error handling and use integer wrappers where appropriate.

## Building

`npm run engine:build` (`scripts/engine-build.mjs`): nightly `nightly-2026-09-15`,
`-Z build-std=std,panic_abort`, `+atomics,+bulk-memory,+mutable-globals,+simd128`,
imported shared memory (maximum 2 GiB), wasm-bindgen 0.2.129 `--target web`,
output in `src/engine/pkg/` ([D9](decisions/0009-generated-engine-build-output.md)).
Never strip the profile ([D10](decisions/0010-keep-wasm-symbols.md)).

All three modules (engine, codec, drawing) are compiled with `+simd128`: WebAssembly SIMD is in Chrome 91, Firefox 89 and
Safari 16.4, the last being the floor `OffscreenCanvas` already sets for the web build (`src/web-support.js` explains a browser
that lacks it). The compiler only vectorises where the IEEE result is identical, and WebAssembly has no fused multiply-add
(relaxed SIMD stays off), so stored arithmetic is unchanged: `styk-math`'s results in the built module equal V8's `Math`
bit for bit (checked on 1.4 million inputs for `sin`, `cos`, `asin`, `acos`, `log`, `atan2`, `hypot`).

`npm run engine:build -- --dev` is the iteration build (profile `wasm-dev`: no LTO, 256 codegen units, incremental, D10 kept): a change in `styk-eval` rebuilds in about 25 s against about 5 minutes for the release profile. It is for iterating and diagnosis, and no number measured on it is a result. The first build on a machine compiles the dependencies once (about 8 minutes).

## Memory growth

Rust's allocator on `wasm32-unknown-unknown` (dlmalloc) asks the host for more linear memory
exactly when its free space runs out: one 64 KiB page at a time for the many small records of
a document. Every `memory.grow` is a host call that commits the pages and replaces the
memory's buffer, and in Node on Windows a grow of a large memory costs about 1.1 to 1.7 ms
whatever the step (one page or 2,048 alike; less while the memory is small). Opening a large Pivot file made tens of thousands of them: the codec
module spent most of its CPU time in `dlmalloc::sys::System::alloc` (the function that calls
`memory.grow`), and the engine's commit of the same document several times its own work.

`engine/crates/styk-alloc` is the global allocator of the engine module (`styk-wasm`) and the
codec module (`styk-codec-wasm`): the standard allocator, and whenever it had to grow the
memory it grows it further in one step (an eighth of the memory, between 16 and 32 MiB) and
returns the extra pages to the allocator's free space. A step the memory cannot take (the
shared memory's maximum, [D14](decisions/0014-shared-memory-maximum.md)) is halved until one
fits. Near the maximum this can refuse a later large request that the standard allocator
would have met, within one step of the ceiling (not seen on any document). Allocation results, and so documents and
bytes, are unchanged; the memory ends at most one step larger than the document needs, in pages
that are committed but untouched, which the browser counts as the app's memory (Electron's private bytes are the commit
charge): steps of up to 128 MiB left that much dead at the top of a large document's memory, and 32 MiB reach the
largest memory in about seventy steps of a millisecond or two each. The drawing module keeps the standard allocator: its memory
grows in few, large steps.

Measure it by opening a large Pivot file in Node (`engine-open.mjs`: the engine's open job and the
read view) with and without the allocator, comparing CPU time as well as
wall time: the cost of a grow rises with the machine's load.

## The allocator's caches and lock

The engine's threads share one heap. `styk-alloc` gives each thread a bounded cache of small blocks (at most 125 KiB, a few KiB in practice) behind a lock of its own that spins ([memory.md](memory.md#the-allocator-and-its-threads)). A thread that ends through `__wbindgen_thread_destroy` hands its cache back when it frees its thread-local block; a thread that is terminated or traps takes its cache with it (it stays
allocated, as the rest of what that thread held does), and one that traps while it holds the lock leaves it held, as it did when the toolchain's allocator spun on it.

Measured 2026-11-11 (desktop app, 2,000 figures of 100 segments with onion skins, a figure selected): making a seek's frame on a worker
(the session's conversion and build of the frame, its onion skins and its draw list, taken by the stage when it was made; the picture on
show stays meanwhile) cut the stage's own time per seek from about 140 ms to about 22 ms, but the interface's reads of the frame made
meanwhile (the inspector evaluates and reads the whole frame on every update while a figure is selected) took 120 to 146 ms instead
of 50 to 60, and a seek's picture took about 0.6 s to appear. Both threads allocate heavily at once and the large blocks and the
caches' refills go through the one lock, so neither gains: interface time per seek was no better than before and the picture came
later. The approach was dropped. It would pay with workers that allocate from heaps of their own and with an interface that reads only
the objects it shows of a dense frame (the inspector's `figureDescriptor` and `joinedDrawingSetsView` read the whole frame).

A playhead drag in such a scene (or a run of frame steps, a held key: [TIMELINE.md](../TIMELINE.md#stepping-through-a-dense-scene)) does not make the editing frame at all until the release: it shows the frames the preparation
workers make for playback, and nothing on the interface thread evaluates or reads a frame meanwhile (the inspector, the library's
selection and the camera monitor wait for the release; a seek queued a pass of the chrome through the drawing controller until
then). `src/engine/engine-scrub.mjs` keeps at most three of those frames being made at once and shows the newest one ready; the
rule, the order and the measurements are in [TIMELINE.md](../TIMELINE.md#scrubbing-a-dense-scene). The request names where the
cache counts from when it is full (`playhead` of `try_request_samples`, `prepareRange(ticks, {playhead})` in
`engine-playback.mjs`): the cache drops first the frames furthest forward from it, which in a forward drag counted from the
pointer were the frames finished just behind it.

## Testing

`cargo test -p styk-engine` (scheduler, opening and publishing documents, export frames prepared ahead, thumbnail frames never
evaluated by the thread asking); `node --test tests/engine-allocator-threads.test.mjs` (threads on the allocator); `node --test tests/engine-export.test.mjs` (the export
worker's start, release and fallbacks); `node --test tests/engine-previews.test.mjs`
(the preview worker's queue, cancellation, failure and idle release);
`engine/viewer/` (a bare page over the engine with `window.viewer` benchmarks);
the app parity tool.

## Native instance clocks and cancellable Select queries

Native application hosts use `Engine::with_clock` and a captured `HostOptions::clock`;
opened and restored sessions receive that source through `Session::set_clock_source`.
The function-pointer constructors remain available to existing engine hosts. Save
workers take an owned clock source, so parallel jobs do not borrow interface state or
share an application timestamp. Parallel app instances and fixed-clock tests are independent.

The Select lane owns one cancellation per press and one latest waiting intent. Its
checked evaluation, geometry, image-decoding and raster APIs discard incomplete work.
Cancellation never mutates an already published generation. Teardown cancels before
handing retained payloads to `Worker::shutdown`, which disposes them on the worker;
the interface neither frees those payloads nor joins the worker.

The same query cancellation reaches movieclip source evaluation (including fractional
local time), nested scene construction and attached-mesh vertex/face loops, and pose
channels' source-track sampling and detached-parent geometry. Cancelled clip scenes
are never inserted into the shared clip cache. Non-cancelled calls retain the same
arithmetic and traversal order; `styk-eval` tests compare geometry and draw-list bits
from independent cold loaders as well as the frozen engine fixture suites.
