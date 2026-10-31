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
- Frame scheduler (`frames.rs`): the interface admits ticks with
  `try_request_samples`; workers evaluate and encode them (`FrameData`: draw
  list, camera, background). `Budgets::for_device` supplies the existing logical
  eviction target (48–384 MiB by `navigator.deviceMemory`, and at most an eighth of the memory:
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
  advances; `waitForPictures` in `engine-stage.mjs`).
- `styk-wasm`: `EngineHandle` (commands and queries over wasm-bindgen),
  `Stage` (a wgpu surface on a canvas, edit frames and ghosts, prepared
  frames), `worker_run` (a worker's loop).
- `src/engine/engine.mjs`: loads the module with shared memory, starts
  `navigator.hardwareConcurrency - 1` workers, at most 8 (`engine-worker.mjs`), and
  without cross-origin isolation runs the same module without workers through
  `pump()`. `src/engine/engine-start.mjs`, the page's first script (index.html), loads the engine and requests the scene canvas's
  graphics device while the application's modules are still arriving; the application's `loadEngine()` and `createStage()` take
  what it started (`prepareStage`, `stageHandoff`). `join` hands another thread what it needs to join the engine (the
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
  let through first); a worker that does not answer within 5 s is terminated
  (what it held then stays allocated in the shared memory). A worker that gets no GPU
  device draws the export with the CPU rasterizer (`ExportRenderer::create_cpu`,
  styk-raster), each tile when asked for. Pages that are not cross-origin isolated
  cannot export.
- The document export worker (`src/document-export-worker.mjs`, kept for as long as exports follow one another) joins the
  shared memory for the Pivot and figure files and calls `export_document` (`styk-wasm`) on the engine's document at the
  editor's revision, as one synchronous stretch of work that asks a flag in shared memory for cancellation between the
  ticks it bakes (see [document.md](document.md#exports-of-the-document)). It is not terminated while it may be inside the
  engine: the interface raises the flag and sends `release`, the worker gives its thread back
  (`__wbindgen_thread_destroy`) after the call returns and closes, and one that does not answer within 5 s is terminated.
  A `.styk` save does not join the engine.
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
  terminated to cancel a preview (a cancelled request's answer is dropped), because a
  thread of the shared memory terminated mid-call could hold the allocator or a lock.
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
- No rayon in WebAssembly: `styk_eval::par::map` is sequential there;
  parallelism is whole frames on workers.
- Library code has no clock, file or thread of its own: the host injects a
  clock (`styk_wasm::clock`), and native tools use rayon through `par`.

## Prepared samples

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
`-Z build-std=std,panic_abort`, `+atomics,+bulk-memory,+mutable-globals`,
imported shared memory (maximum 2 GiB), wasm-bindgen 0.2.129 `--target web`,
output in `src/engine/pkg/` ([D9](decisions/0009-generated-engine-build-output.md)).
Never strip the profile ([D10](decisions/0010-keep-wasm-symbols.md)).

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
memory it grows it further in one step (an eighth of the memory, between 16 and 128 MiB) and
returns the extra pages to the allocator's free space. A step the memory cannot take (the
shared memory's maximum, [D14](decisions/0014-shared-memory-maximum.md)) is halved until one
fits. Near the maximum this can refuse a later large request that the standard allocator
would have met, within one step of the ceiling (not seen on any document). Allocation results, and so documents and
bytes, are unchanged; the memory ends at most one step larger than the document needs, in pages
that are committed but untouched (opening tdd2 uriel nemesis: engine memory 1,071 to 1,183 MiB). The drawing module keeps the standard allocator: its memory
grows in few, large steps.

Measure it by opening a large Pivot file in Node (`engine-open.mjs`: the engine's open job and the
read view) with and without the allocator, comparing CPU time as well as
wall time: the cost of a grow rises with the machine's load.

## Testing

`cargo test -p styk-engine` (scheduler, opening and publishing documents, export frames prepared ahead, thumbnail frames never
evaluated by the thread asking); `node --test tests/engine-export.test.mjs` (the export
worker's start, release and fallbacks); `node --test tests/engine-previews.test.mjs`
(the preview worker's queue, cancellation, failure and idle release);
`engine/viewer/` (a bare page over the engine with `window.viewer` benchmarks);
the app parity tool.
