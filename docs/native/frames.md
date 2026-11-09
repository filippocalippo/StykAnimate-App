# Native frame scheduling

`styk_core::frames::Frames` owns requests for one open document lifetime. K-doc supplies
`FrameDocument::snapshot(revision, resource_epoch)` on a worker: an immutable
`Arc<Generation>` for exactly that document state, or a refusal. No document tree,
session, generation or dense frame is read or dropped on the interface path. K-doc's
panel seam is available; its worker publication/snapshot API is still pending, so
this trait is the integration boundary rather than a second document store. Sources outside
the document host, such as catalogue fixtures, expose an optional atomic
`publication_receipt()` so pending facts can retry after publication. This stamp is the
only source read allowed on the interface; snapshot and picture access remain worker-only.

The host constructs a pool through `styk_services::Spawner` (the desktop supplies
`styk_platform::spawn::ThreadSpawner`), injects `Clock` and a coalescing event-loop wake,
and chooses the worker count within its application-wide budget. A pool accepts one
to eight workers. Construction borrows the source owner, so even a first-worker
start failure cannot destroy that document on the interface thread. A start failure
is returned and any workers already started are asked to exit. The scheduler does
not stop the document engine or its other jobs.

## Interface contract

- `request(consumer, tick, inputs)` replaces that consumer's demand. Stage has a reserved
  slot; then come 48 playback, 48 onion, eight preview and eight thumbnail slots.
  There is no queue node per pointer move. Invalid slots and inputs are refused.
- A preparation key contains document lifetime, revision, resource epoch, exact
  fractional tick, hidden figures, effects, camera application, canvas culling,
  background override, figure translations and ordered onion settings (including
  per-ghost hidden figures). Zero has numeric identity; NaN/infinity are refused.
  Navigation is absent: backing size/density, zoom, pan, rotation, flip, quality and
  samples belong to the painter's presentation key. Camera and clipping also supply
  its drawing policy. Repeating a consumer's preparation key preserves its request
  token, including while preparation is in flight. Pan/zoom neither cancel nor
  rebuild a list; the same Arc reaches Renderer::set_list for upload reuse.
  Admission hashes preparation inputs outside the queue lock. Workers resolve hash
  collisions with complete key equality.
- `revise` cancels all old requests immediately through atomic identities. The
  resource epoch must advance when image/cel bounds change without an edit. Revision
  and resource changes are not inferred by reading the engine on the interface.
- `flush` returns immediately for an empty outbox, without taking the queue lock or
  waking either the interface or workers. Otherwise it tries the queue lock once.
  On contention, the latest request remains in a bounded interface outbox and
  schedules a retry wake. Call it on progress and subsequent event-loop turns.
- `with_ready` tries once and returns Busy, Pending, Evicted, Ready or a visible
  failure. It verifies the latest consumer identity and resolves a scalar cache
  index plus unique entry ID: no key scan or dense comparison runs on this path.
  Workers repair indices when compacting the cache; IDs reject a reused slot.
  It borrows the matching draw list only for the callback. The callback submits the draw; it must not prepare,
  wait for GPU readback, clone dense list fields or retain CPU frame ownership.
  A presenter can keep its previous GPU picture while the next request is pending.
- The native stage instead uses a crate-private worker ticket. Only its paint worker
  can take an immutable ready-list handle and resolve the matching generation; the
  interface receives a detached GPU picture from `stage::Painter`. This avoids
  renderer preparation under the ready-cache lock. Ticket currency is checked at
  lookup, publication and handoff. See [stage.md](stage.md) for its extra retained
  list and GPU byte bounds.
- `cancel`, `revise`, `close` and Drop never wait for a worker. Close is irrevocable;
  a reopened document gets a new scheduler/document identity. Workers release ready
  frames, their reuse state, and the source on all shutdown paths.

Only the workers acquire a blocking lock or wait. Evaluation, encoding, accounting,
cache payload destruction and source destruction run outside the shared queue lock.
Interface requests move only bounded metadata under a one-shot lock. Workers never
hold an engine store lock around evaluation. Completion increments `progress` and
calls the supplied wake outside the queue lock. The host must deliver that wake as
an event, not call back into update synchronously.

## Preparation and memory

`styk_engine::frame_builder::FrameBuilder` is the engine's common worker pipeline:
evaluate, build geometry, encode, optionally cull. The existing engine cache and
exports call its fresh path; native work bursts use `build_remembering_plain_over`
and `encode_composed_remembering`. Large object/encoding maps retain styk-eval's
existing parallel implementation. Onion composition uses `styk_eval::onion::compose`
and the normal encoder, with camera mode hiding onions as in the editor.

Each worker retains its FrameBuilder across short sleeps. Its derived geometry,
scene and encoder buffers are bounded by `cache_bytes / workers`; larger reuse
state is discarded after the work unit without refusing the prepared frame. One
second without work releases reuse state; close releases it immediately at the next
worker boundary. Geometry/encoder owners account vector capacities, nested buffers,
resolved effects and glyph slices, not a multiplier of input size. Shared authored
figures/documents and allocator overhead are separate, as in the existing scene
cache accounting. Cancellation is checked between preparation phases; an executing
engine phase finishes before its scratch can be freed.

The ready cache has a hard byte limit and at most 113 entries. Charges use
`drawlist::retained_bytes_checked`, including buffer capacities, effect stacks and
glyph slices, plus entry and preparation metadata. Request vector capacities are validated
as well as lengths, so a short vector with a huge spare allocation is refused.
Shared allocations across different entries
are conservatively charged again. Oversized single frames are explicitly refused;
there is no first-entry exemption. The current stage entry is protected. Eviction
prefers entries at the requesting priority or below; background work cannot
remove the visible stage to make itself fit. Results always carry their full key.

The byte limit describes retained ready frames, not total process memory. Engine
evaluation scratch, document/assets, movieclip and anchor caches, and renderer/GPU resources have their existing owners and
budgets. At most the configured worker count can prepare frames simultaneously.
No claim is made that a ready-cache limit bounds an individual evaluator allocation.

`lookahead` requests up to 48 unique samples in a half-open range, optionally wrapping.
A separate limit caps the actual retained speculative frame bytes. Range replacement
cancels unused slots; zero budget disables and retires speculation. The timeline
still owns transport, audio gates, startup/buffering policy and presentation deadlines.
Current demands remain recorded after preparation, so their slot order identifies
the nearest samples even across a loop. Eviction and admission compare that order:
farthest speculation is removed or refused first, and nearer requested frames stay
ready. A frame also requested by the stage is protected and charged as stage work.

## Coverage and remaining integration

Core tests exercise real worker units with `ManualSpawner`, exact draw-list parity
against the engine, a revision change during a snapshot, 1,000 superseding preparation requests,
queue contention, priorities, stage protection, byte refusal, bounded lookahead,
spawn failure, injected time and close during preparation. Engine tests compare
reused output with the original evaluate/build/encode composition on repository
fixtures, including fractional ticks, cameras, effects and onion skins. Test-only
lossless encoding compares every typed payload field, including effect parameters,
gradient paints and float bits. Coverage assertions prove generated birth-anchor
sampling and offsets, nonzero parallax, hidden primitives and actual culling.
Dense same-tick preparation inputs (65,536 translations) verify that readiness performs zero
full-key comparisons; collision, cache compaction and reused-slot cases cover tickets.

`FrameDocument::picture_engine` supplies the same document engine to the paint
worker. Its picture workers must already be running through the application's
spawner; a source without that service can still prepare vector-only documents.

This is scheduling infrastructure. K-doc connects the source and revision/resource
notifications; K-stage connects draw submission, picture readiness and live session
poses; timeline/filmstrip chunks connect transport, thumbnail retry and appearance
invalidation. These UI inventory rows remain partial rather than claiming that the
native stage and timeline are already implemented.
