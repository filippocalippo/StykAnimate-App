# Memory

## Native export ownership

`Engine::for_export` creates an engine with no stage picture consumer. Publication
still prepares the document and generated materials; `ExportFrames` alone requests
picture pixels and cel bounds. `Engine::new` and `with_notifier` retain their stage
preloading behavior. The headless commands use a 32 MiB decode queue, drained after
each engine step; a larger picture is decoded alone under the existing admission
protocol. GPU upload batches release their decoded and staging copies before taking
more. CPU exports retain the pixels their rasterizer reads. Input file buffers are
dropped after opening.

For more than two sprite pages, native frame sources use the existing `Resident`
exporter. Two pages are a soft working-set budget; all pages a frame draws are held
and grow the atlas when necessary. Native exports also protect the previous
complete frame while loading the next: capacity is bounded by the largest union
of two adjacent working sets (or the initial two pages), not by export length.
Older pages remain eligible for eviction; an unchanged working set is not uploaded
again. Unused pictures are not decoded. Drawing cels
are first decoded for their bounds, then their visible tiles are requested and
uploaded under the same readiness/refusal protocol as other resident exports.
Uploads wait on the exporter's interruptible GPU poller, so cancellation or device
loss also wakes a pending upload batch. A frame never draws partial residency.

The native video worker prefetches exactly its next ordered frame after submitting
the current frame's last tile and before waiting for readback. Evaluation/decode
and uploads can overlap the submitted drawing. An empty upload batch never waits
for the GPU; actual staging batches retain their existing byte bound and wait.
All of this work remains inside the producer's draw-time measurement. The next
frame stays in the existing bounded `ExportFrames` cache until taken. Reverse and
shuffled orders use the caller's actual successor. No extra decode thread or queue
is created; cancellation uses the same interrupt and disposer.

Native devices use wgpu's default allocation policy. The small-block and geometric
pool experiments were removed after exclusive paired measurements; pool design is
deferred until native commitment can be measured. Resource lifetime retention and
byte bounds remain. Live GPU allocations and reserved allocator blocks are
separate, overlapping measures; neither attributes all process-private commitment.
Native exports keep at most one frame's tiles in flight, within the existing
64 MiB readback budget. Serializing tiles reduced overlap but regressed frame time
in paired measurements; the tiles remain pipelined. Browser hosts still pipeline
tiles and frames to hide mapping latency across processes.

Isolation page counts and power-of-two primitive capacities retain their high-water
marks while the renderer is alive. Unused isolation, MSAA and effect slots remain
available to the next frame. Readbacks retain one frame's tile capacity for the
export. The existing disposal path releases these owners at export end or document
close; no frame-count timer stands in for stage idle time.
Exact page/effect dimensions still follow the frame because normalized sampling
depends on them; changing those dimensions still replaces the texture. Array
textures retain D11's two-layer minimum. Stage admission includes retained capacity
and actual replacement dimensions, including both owners during replacement, without
raising its byte limit. Non-exact callers retain dimensions until view
reconfiguration or owner close; the native stage uses exact dimensions for parity.
Pipelines and effect uniforms remain reusable.

`styk video --memory-report <report.jsonl>` records process private bytes, counted
Rust heap bytes and peak, and wgpu allocator totals and allocation labels. It also
emits `styk-trace` memory counters. Detail JSON is built lazily only when reporting
is enabled; ordinary video frames do not construct diagnostic values.
`styk stage-memory <input> <frames.styk-auto>
<WxH> <report.jsonl>` drives the production K-stage host with `frame` automation
steps, including normal close and reclamation. Both diagnostics require `app-tools`;
they create no window. These quantities overlap and must not be added as if they
were independent owners. Measurements and comparisons belong in ignored artifacts.

The engine, its documents, their edit sessions and history, and the decoded pictures share one
WebAssembly memory with a fixed maximum (2 GiB, else the largest the browser reserves:
[D14](decisions/0014-shared-memory-maximum.md)). A module that runs out of it aborts
(`rust_oom`, `RuntimeError: unreachable`) and is gone for the session, so no document may be able to
take the memory: what grows is bounded, the work that allocates in pieces nothing can refuse first asks,
and what the memory cannot hold is refused with a message.

## Where the memory goes

Measured on 2026-10-24 on the private documents (Node and the Electron app; sizes in MiB; `live` is what the
allocator has handed out, `heap` the linear memory, which dlmalloc never gives back):

| | file | live after opening | peak while opening |
| --- | --- | --- | --- |
| tdd2 uriel nemesis (263 figures, 589 ticks, 116 pictures) | 39 | 159 | 275 |
| svr_uriel | 21 | 180 | 202 |
| testingupload.styk | 35 | 297 | 393 |

Three things filled the memory of a large document, each without a bound:

1. **Decoded pictures waiting for the stage.** Every picture of a document was decoded at once on the
   workers and queued until the stage took it (8 MiB a frame, and only while it drew a frame that
   lacked a picture): opening tdd2 held 759 MiB of pixels in the queue for as long as nothing drew,
   1,576 MiB of heap in the app.
2. **The editor session's typed-view cache never released a record.** The session and the engine each
   convert the document with a loader of their own, and each held the other's records alive: every
   edit, undo and redo left a full set of typed figures and keyframes behind.
3. **The image table grew with every undo and redo.** The loader names an image by the address of its payload;
   an undo that builds a record anew has a payload of its own at another address, and the table
   (append-only: an index names an image for good) took the picture in again. tdd2 gained 70 to 110
   MiB for each undo and redo.

## The high-water mark

The memory only grows (dlmalloc never gives pages back, and a shared memory cannot shrink), so the most it ever held at
once is paid for the whole session: Electron counts every page the module grew to as the app's private bytes, touched or
not. Measured on 2026-10-31 (`slot.mjs probe`, dev build, one run each; MiB; `heap` is the linear memory, `live` what
the allocator handed out, `peak` its high-water mark, `Tab` the renderer's private bytes):

| tdd2 | heap | live | peak | Tab |
| --- | ---: | ---: | ---: | ---: |
| empty app | 18 | 4 | 4 | 177–212 |
| opened (decoded, normalised, typed views, the Pivot original attached) | 304–306 | 284 | 291 | 730–763 |
| pictures decoding (settle) before | 644–682 | 510 | 511 | 1,299–1,359 |
| pictures decoding (settle) after | 467 | 317 | 350 | 1,123 |
| playing, scrubbing, after | 467 | 211–267 | 350 | 1,110–1,208 |

Opening takes the memory to about 300 and the pictures then took it to 680: a live peak of 510 against 213 kept, in the
two seconds the stage takes the document's pictures in. Live blocks of 2 MiB or more, sampled at that peak, named it: four
decoded 4K pictures (28 to 36 each: the pictures being decoded and queued) and **one block of 129**. That block was the
float intermediate of `image::imageops::resize` for a 4,096-wide picture the atlas keeps at 4,094 (the library resizes in two
passes over a float picture of the source's width and the new height), on top of the decoded picture, its resize and its
stored copy: 225 MiB of working memory for one picture, 7.8 times its stored size, while the other 36 large pictures
needed 1.0 to 1.3. `styk_eval::assets::decode_image` now decodes a picture of 8-bit RGB or RGBA at its atlas size into the
end of its final buffer and borders it there (`read_into_tail`, `border_in_place`: 1.0 times the stored size), and resizes
row by row with the library's own weights, order of summing and rounding (`resize_triangle`: a float row, not a float
picture; the tests compare it with the library byte for byte). Pixels are unchanged. The grow-ahead step is 16 to 32 MiB
(was 16 to 128): the pages of a step are committed whether used or not.

What is left of the 150 MiB between the live peak (317) and what stays (211): the Pivot reader's inflated payload while the
tree is built (tdd2: live 186 after the decode against a peak of 314, measured natively), and the pictures in flight and
queued (a thirtieth of the memory). The open's own temporaries are free space afterwards, which later work reuses, so the
heap stays near the open's own peak (300) plus what the pictures add on top of the document.

## The allocator and its threads

Every thread of the engine (the interface, the preparation workers, a save's helpers) allocates from one heap behind one lock, and the
toolchain's allocator takes that lock on every call and spins on it. Measured on 2026-11-01 with a counting lock in front of it (release build, `slot.mjs probe`, one
run each, the open's phases on the large `.styk` with three helpers): **7.8 million allocator calls, 4.0 million of them finding the
lock held; each busy helper waited 0.8 to 0.95 s of an open that took under 2.5 s**, and the interface thread waited up to 36 ms
at once opening tdd2 (17.6 ms svr_uriel, 4.7 ms the large `.styk`; 79 ms in one run, with the machine busy). 98% of the calls are for 508 bytes or less
(80% for 64 or less). Playback was not the problem (workers found the lock held on 1 to 2% of their calls, the interface on 0.1%).

`styk-alloc` now keeps a cache of small blocks for each thread and puts a lock of its own behind it (`cache.rs`, `lock.rs`):

- **Caches.** A request of up to 508 bytes is served from a list of the thread's own, one for each of 63 sizes (8 * k + 4 bytes: the room the
  heap's chunks give, so a size wastes nothing the heap would not have). The heap's lock is taken once for a batch of 2 to 16 blocks to fill an
  empty list or empty a full one (a list holds at most twice a batch before half of it goes back). A block belongs to no thread: its size comes with every
  free, so a block freed by another thread than the one that made it joins the freeing thread's list. The cache of a thread holds at most
  2.5 KiB of a size and **125 KiB in all (a few KiB in practice)**, in the thread's thread-local block. A thread that ends hands its lists back when it
  frees that block (`__wbindgen_thread_destroy`, in `GrowAhead::dealloc`); a thread that is terminated or traps loses at most that,
  which stays allocated like the rest of what the thread held ([threading.md](threading.md#when-an-engine-thread-traps)).
  wasm-bindgen allocates a new thread's stack and thread-local block before the thread has a thread-local base, and frees them after setting it to an address no
  memory has: the allocator reads the base (`llvm.wasm.tls.base`) and serves those calls from the heap directly.
- **The lock.** The heap sits behind a lock of the engine's own, taken once for a batch and once for a growth of the memory (the toolchain's lock
  inside is then never found held); a thread that finds it held spins (`spin_loop`, reading the word until it is free). The holds are short, and a lock that slept would need waking: wasm-bindgen runs a
  module's start function on the first thread only, so only the interface thread could be told from the others by the module, and it must never block (D7) anyway.
- **The count of live bytes** is kept for each thread and added to the shared counter in steps of 16 KiB (a request of 8 KiB or more at once), so that every call does not
  write a cache line all the threads share. `live_bytes()` is exact for the thread that asks and short by at most that step for each of the others;
  `peak_bytes()` is never below it. A free that reaches the counter before its allocation does leaves it negative for a moment, so it is read as signed.
  Large requests are refused against it as before (`refuses`, `LARGE_BYTES`, `reserve` are unchanged).

Release builds (`slot.mjs probe`, so the machine was running other work and every time below is directional; the opens vary by 40% from run to run). The counts, the waits and the
memory do not depend on the load:

| | before | after |
| --- | ---: | ---: |
| allocator lock, large `.styk` open, 3 helpers: calls / found held (counting build) | 7.8 M / 4.0 M | 570 k holds / 150 k |
| wait per busy helper in that open (counting build) | 0.8–0.95 s | 25–70 ms |
| worst wait of the interface thread, opening tdd2 / svr_uriel / the large `.styk` (counting build) | 35.9 / 17.6 / 4.7 ms | 4.0 / 0.03 / 2.4 ms |
| interface thread finding the lock held during playback and save | up to 0.12% of its calls, 2.5 ms | never |
| heap after the open: large `.styk` / tdd2 / svr_uriel | 443–475 / 445 / 303 MiB | 443 / 446 / 281 MiB |
| live peak of the open: large `.styk` / tdd2 / svr_uriel | 290 / 345 / 236 MiB | 291 / 345 / 237 MiB |
| playback, worst gap between shown frames (tdd2 / svr_uriel / large `.styk`) | 48.3 / 55.3 / 70.1 ms | 48.1 / 55.1 / 70.2 ms |
| open with 3 helpers, median of 8 runs taken in turn, parent against new: large `.styk` / tdd2 | 3,366 / 2,385 ms | 3,042 / 2,084 ms |

An independent run in the app (median of several, quieter machine) measured tdd2 1,623 against 1,357 ms and the large `.styk` 2,655 against 1,778 ms. **With no helper the open is
not faster**: in Node, opening the large `.styk` took 2.2–2.7 s on the parent and 2.2–3.1 s on the new allocator, with the same CPU time (a first measurement of 1.8 times came from runs of the two
builds an hour apart on a machine whose load had changed); a single thread never met the lock, and `malloc` and `free` of one thread cost what a list does. What the caches remove
is the waiting of the threads that share the heap. The open still gains nothing from more than three helpers: what is left of the lock is 25 to 70 ms of waiting for each
helper, about 5% of the open, so the limit is the work that does not divide, not the allocator; the cap of three helpers (`MAX_OPEN_HELPERS`) stays. Batches of up to 64 blocks for the smallest
sizes (the batch is a kilobyte of each size, at most 16 blocks) were tried, with the same bound on a cache to within 5 KiB: no consistent difference over 8 runs in turn, so the batch stays.
Playback did not move (frames are shown every display refresh; the allocator was not what limited them).

## The renderer's private bytes

Measured 2026-11-01 on the renderer process (Electron's `Tab`, whose private bytes are the commit charge), dev build,
`slot.mjs` runs on a loaded machine, one launch each. The committed regions come from `VirtualQueryEx` on the renderer,
the first bytes of each large region name what it holds (a zlib header is a Pivot file, `STYK` a native file, `STYKSRC1`
the codec's record of an original); the heaps are `engine.memory()` and `performance.memory`; the codec's share is what
ending its worker gave back. MiB.

| tdd2, settled | before this chunk | what it is |
| --- | ---: | --- |
| the empty app | 187 | |
| WebAssembly memory | 434 | 189 live; the rest is dead space the allocator keeps |
| main-thread V8 heap | 229 | 87 after a collection: 142 of it was garbage waiting for one |
| Pivot codec worker | ~160 | the 39 MiB original it leases, 95 MiB of wasm memory growing to hold the upload, its own heap |
| two more copies of the file | 78 | the buffer the page read it into and the upload the worker was sent, until a collection |
| six more engine workers | ~40 | 6 to 7 each, and 18 more in the wasm memory (stacks): they are needed to prepare frames in parallel |
| compiled WebAssembly | ~4 | the module is compiled once for every thread: private executable memory goes from 5 to 9 |

After freeing the copies as soon as they are copied (the page's buffer, the worker's upload, and in the web build the
original the importer fetched back to read a fingerprint from), tdd2 settled at 1,004 and svr_uriel's codec worker was 99
(20 original, 59 wasm memory). What kept the desktop worker alive was the original it leased, and what kept the original
there was the document fingerprint the saved file carries (`document_sha256`): the codec decoded the project again in a
cold worker to compute it (0.9 to 2.4 s more to open). The engine now computes it from the document it has just read, on a
helper beside the rest of the open (`styk_piv::source_digest`), and describes the file (version, SHA-256) from the facts
the reader already has; the interface gives the engine the file once, written into the memory the document keeps it in
(`begin_source`, `end_source`: a `Vec<u8>` argument would hold it three times at the memory's fullest). The document carries
the original, the codec keeps nothing, and its worker ends two seconds after its last job on both profiles (a worker
started cold answers its first request in 30 to 70 ms). Dev build, one launch each, a loaded machine (directional):
ending the codec worker gave back 15 MiB on tdd2, 2 on svr_uriel and 14 on testingupload.styk (it gave 160, 100 and 0
before); tdd2 opens in 2.8 to 3.7 s, as it did with the lease. The bytes a save writes are unchanged: the four trusted
files save to the hashes they always did.

The Rust codec's lease routes (`/api/source/keep`, `retain`, `release`, `GET /api/source`, and the source cache and lease code
behind them in `styk-piv/src/store.rs`) are not leftovers. The app no longer calls them, but the codec is held to the answers of the
Python service it replaced: `engine/tools/piv/oracle.py` records those routes and the retained-bytes limits, `styk-piv replay`
(`engine/crates/styk-piv/tests/parity.rs`, `engine:parity`) requires identical answers, and `styk-piv`'s own service tests state them. Removing
them means re-recording the oracle's tapes, which are frozen, so they stay until the oracle itself is retired. The app's side of the lease is
gone (`sourceOwners`, `adoptSource`, `detachSource`, `attachSource`, `/api/source/retain` in the import client).

**Opening a Pivot file (what is reserved).** The estimate by the file's size (16 bytes per byte) is wrong in both directions for a Pivot file, which
is a zlib stream: a project of 120 MB of pictures stored as they were inflates to about what it is, and the measured peaks are 5 to 6 bytes per byte
of what is inflated (tdd2: 345 MiB for 54 MiB inflated from 39; svr_uriel: 236 for 42 from 21). So when the estimate by size refuses a `.piv` or `.stk`, the
open inflates it once into a window of 32 KiB, counts the bytes and keeps none (a look at the cancel flag for every megabyte, on the worker that is
opening; about a quarter of a second for 40 MB), and refuses only if 8 bytes per inflated byte do not fit either, with the same message. Before this a
padded Ayame of 122 MB (2 MB of project, the rest noise) was refused with 16 x 122 = 1.9 GB asked of 2 GiB; it opens. A file whose estimate by size fits is
not counted, and one that compresses far better than its size says (20 MB that inflates to 400) still takes the estimate by size: the open's allocations that
cannot be refused are covered by the loss of the worker it ends with (`finish` in `engine-open.mjs`). `scripts/smoke-padded-pivot.mjs` opens such a file in
the app, exports it unchanged and edited, saves it as a project and opens that. The opened padded Ayame exports unchanged (the file again, byte for byte), saves as a project and opens that again at 100 and 122 MB (release build), and
exports edited at 100. The document the codec is sent for a Pivot export is JSON of at most 256 MiB, and it holds the padding twice over, as a project's pictures are
(`data_base64` and `data_url`): at 122 MB it is 265 MB of 268, and at 133 MB the export, edited or not, is refused with "The request exceeds the configured size
limit" while the project opens (as it did with the codec holding the original: the document is the same). That limit is the request's, not the file's: the engine's native export (`Output::Pivot`) writes the file from the tree without a request, and a padded file of 133 MB edited once exports (140,043,076 bytes, identical to what the codec writes given room for the request, 7.4 s, a peak of 2,008 MiB private bytes natively, 1,338 over the edited document that was open: the export asks for the codec's working storage and the original twice, and for the rest as it goes: it is refused, with nothing written, as soon as it has outgrown the memory, see `docs/engine/document.md`). The browser still sends the request.

**A very compressible file, natively.** A Pivot file of 1.1 MB that inflates to the 256 MiB a project may be opens and peaks at 1,368 MiB (5.5 times what it inflates to), holds 599 with the document open, and the process holds what it held before once the document is closed (`tests/memory_release.rs`). The memory that stays after such an open in the browser is the allocator's high-water mark (above), not the engine's. The 256 MiB a project may be, as a file and inflated, is today's limit and not a new one (`codecs/piv_codec.py`: `MAX_PAYLOAD_BYTES = 256 * 1024 * 1024`, "Project exceeds size limit" for a longer file, "Decompressed project exceeds size limit" for a longer payload, a payload of exactly that length read; `the_size_limits_are_those_of_the_python_codec` in `styk-piv`). A cancelled Pivot export is seen within a tenth of a second on a 60 MB padded file (595 ms before the fingerprint and the original's hash asked as they went: `tests/export_cancel.rs`).

**The allocator lock** (`std`'s wasm allocator: one spinning lock for every thread). Timed with a gate in front of it, tdd2
and svr_uriel through open, play and scrub, eight workers: a worker finds the lock taken on 5 to 40 % of its calls and
waits 0.1 to 0.9 s in all over the session (waits up to 28 ms); the interface thread makes 8 to 11 million calls, finds the
lock taken on 0.01 to 0.24 % of them, and waits 21 to 182 ms in all, 4.4 to 9.2 ms at the worst. The long waits are holders
that were descheduled on a machine running other builds, not large allocations (the holder's request was under 1 MiB
for all but the pictures'). Not acted on at the time; the per-thread caches of "The allocator and its threads" above did it afterwards (the 7.7 to 11.4 million calls the interface thread made during an open were the read view's, which goes away with it).

**The file of a project while its skeleton is read.** A `.styk` file is a skeleton of JSON text (147 MiB for
testingupload.styk) and sections, stored in 35 MiB. The open now owns the file's bytes (`OpenSource::Owned`, as for Pivot
files), the sections' tasks borrow it instead of copying what they unpack, and it is let go as soon as the skeleton and the
sections are unpacked (`decode_deferred_owned`), before the skeleton is read into a tree, which is when the memory is
fullest. The heap of testingupload settles at 413 MiB against 475 for the same build without it (two launches each; the
renderer's private bytes 611 to 636 against 668 to 676), live memory unchanged. The 147 MiB skeleton itself stays whole
while it is parsed: reading it in pieces needs the parser to take the skeleton by segments (a JSON value that spans one
is the difficulty: the container's checksum and the parallel sections are laid out for a whole skeleton), and would take
the open's peak from skeleton plus tree to tree plus one segment, 100 to 140 MiB less. Not done.

**Work that is purely transient in an instance of its own.** For pictures it saves nothing: the decoded pixels are the
result and must be in the engine's memory for the stage, and a decode now holds one buffer of the stored size. For the open
it would keep the file, the payload and the tree under construction (about 140 MiB on tdd2, 39 + 100) out of the engine's
memory, at the price of lifting the whole tree out of the other instance and rebuilding it piece by piece here
(`handle.part` already takes 0.9 s to lift it for the interface) with the shared nodes of the pose sequences kept
shared, and two copies of the tree in the renderer while it moves. The open's temporaries are already held for less time
(the file is dropped once inflated, the payload gives back its spare capacity), and the memory they leave is reused by what
follows, so the heap stays within about 30 MiB of the open's own peak (tdd2 304 against a live peak of 291) until the
pictures arrive. Not done.

## What is bounded now

- **Pictures** (`styk_engine::images`, `Budgets::picture_bytes`): a picture is decoded only while the
  decoded pictures waiting for the renderer, and those being decoded, are under a thirtieth of the
  memory (64 MiB of 2 GiB); a decode that finds no room is parked (its queue node moves into the image
  store, nothing is allocated under the lock) and goes back in front of the queue when the renderer takes
  pictures (`Engine::take_images`). One picture larger than the budget is decoded alone. The export
  (`ExportFrames`) decodes up to eight pictures at a time under the same budget. The stage no longer
  depends on a frame drawn for each slice: after a frame it takes in the document's other pictures while
  idle (`Stage::upload_pictures`, `uploadRemainingPictures` in `engine-stage.mjs`: 8 MiB every 16 ms
  after 50 ms without a frame, ending when another frame is drawn). tdd2 opens with 61 MiB queued at
  most, all pictures uploaded within two seconds, and 183 MiB live afterwards (before: 942, heap 1,576).
- **Pictures the CPU holds** (`styk_raster::Images`: the preview worker's thumbnails, poses and camera monitor, and
  the CPU export): the pixels kept are under a sixteenth of the memory (128 MiB of 2 GiB); beyond it the least
  recently used are dropped, and `Images::ensure` decodes again, from the document's encoded pictures
  (`styk_eval::assets::decode_picture`, reserving its working memory), whatever the frame about to be drawn samples
  and the cache lacks. A frame is never short of a picture because of the budget: what it samples is kept while it
  is drawn. The preview worker's GPU device keeps the pictures it was given (`Gpu.uploaded`), so it asks the
  CPU only for the ones the device lacks; before, both kept every picture of the document.
- **The frame cache** stays under a sixteenth of the memory (120 MiB of 2 GiB), whatever
  `navigator.deviceMemory` says. It keeps the frames just ahead of the playhead, so a cap only changes how far ahead
  playback has frames waiting: svr_uriel played 14 s three times at each cap (a dev build, one app launch per cap):
  stutters over 1.5 frames per play 0, 0, 1 at 240 MiB, 0, 1, 0 at 120, 1, 0, 0 at 60 (1, 1, 0 in a second launch), and 4, 1, 1 at
  30 with buffering events; live memory after playing 420, 340, 280 and 250 MiB. 240 MiB held 193 MiB of frames and bought nothing
  the 120 did not.
- **Typed views** (`styk_eval::load::Loader`) are held by a weak reference to the record they were made from
  (`Source`), so they live exactly as long as something holds the record (the document, its history), whoever
  else caches views of it; `release_unused` runs after every conversion, the session's included.
- **Images** are in the loader's table once, however many copies of their payload a record has: a payload
  whose address is unknown is hashed (length and a 64-bit hash, then compared byte for byte) and found
  among the images before it is added. Three undo and redo cycles of tdd2 now stay at 330 and 427 MiB
  live (before: +100 MiB each cycle, 1,136 MiB after three).
- **History** keeps its byte limit (`HistoryLimits`, 48 MiB by default): an entry larger than the limit
  retires the older ones (testingupload's movieclip edit weighs 100 MiB by the history's accounting and
  holds 3 MiB of memory).

## GPU memory

The GPU process is the largest part of the app's memory with a large document open, and it is the
sprite atlas: `styk_render::Renderer::prepare_sprites` allocates every page of the document's layout (4,096² RGBA8,
64 MiB each) when the stage first draws it, whether or not their pictures have been uploaded. `Stage::stats()`
reports it (`spritePages`, `spriteBytes`, with `targetBytes`, `layerBytes`, `glyphBytes` and the rest).
Measured on 2026-10-31 (private bytes of the GPU process, probe runs, one each; the empty app's is 281–300 MiB):

| | tdd2 settled | svr_uriel settled | svr_uriel after play and scrub |
| --- | ---: | ---: | ---: |
| GPU process | 2,273 → 1,877 (second run: 2,135 → 1,853) | 666 | 903 |
| sprite atlas | 1,664 (26 pages) → 1,280 (20 pages) | 128 (2 pages) | 128 |
| frame, MSAA and output targets | 22 | 12 | 27 |
| layer atlases, glyph masks | 5 + 2 | 0 | 60 + 64 |
| not named by any counter | about 300 | about 220 | about 320 |

There is no second copy of the pictures: the atlas is the allocation, 1.5 to 2 times the pixels the pictures hold.
The shelf packer put each 4K picture on a page of its own and never went back to the strips beside and below it (a
fifth of a page each), so a document of many large pictures held pages half empty; it now places an image that fits no
shelf of the current page in the best free space an earlier page left, before opening a new page
(`styk_eval::assets::pack`; a layout within one page is unchanged). About 200 to 300 MiB of the GPU process is named by no counter, in every document (the empty app's 281–404 MiB is not itemised
either); the layer and glyph targets grow with play.

### Pages kept against a budget, soft copies in their place

A document whose layout has more than `ATLAS_PAGES` (4) pages is not held whole (`styk_engine::Residency`,
`styk-wasm/src/stage/pictures.rs`). Measured on tdd2 (`styk pages`: the layout's pages each frame draws from, over 589 ticks):
one frame draws from at most 3 of its 20 pages (0.4 on average), and the 48 frames after one from 4.7 on average, 18 at most.
The stage's sprite texture has `ATLAS_PAGES` layers (256 MiB; `Engine::atlas_pages`, `EngineHandle::set_atlas_pages` before a
document opens), and:

- **Every picture has a soft copy**, always resident: its premultiplied pixels averaged over the 8 × 8 blocks of its atlas page
  (`styk_eval::assets::soften_image`, so it lines up with the picture wherever it lies) in a second array texture with the
  same layout, one texel to 8 of the page's, 2 × 2 pages to a 1,024² layer (`soft_sprites` in prim.wgsl; 20 MiB for tdd2's 116
  pictures). It is made as the document opens, on the workers, one picture at a time under the picture budget (the full
  pixels are dropped as soon as the average is taken, so the module's high-water mark is that of decoding one picture),
  by a `Picture::Soft` decode in place of the `Picture::Image` one a document held whole gets.
- **The shader asks the picture table**, a hash table of one entry per picture (`PictureState` in `styk-render/src/pictures.rs`: corner,
  page, layer + 1; the same hash and at most 16 probes in the shader and on the CPU, `picture_layer`), which layer of the sprite texture
  holds the picture, and draws its soft copy where the answer is none. A picture is put in the table (`Renderer::set_picture`)
  after its last pixel was uploaded, so the change from soft to sharp is one frame: it draws soft, then sharp, never blank
  and never half a picture. A renderer that holds the whole layout (exports, previews, the CPU parity tests, a document of up
  to `ATLAS_PAGES` pages) has every picture in the table at its own page's layer and never draws a soft copy. The soft atlas
  and the table are one more texture and one more binding (D8: textures with `textureLoad` and the one sampler; D11: array
  textures of two layers or more); WebGL2 ran this on software rendering.
- **The unit of residency is the page, the unit of loading the picture.** A page is given a layer when a picture on it is wanted;
  the page whose next use is the farthest (from the table below, else the least recently shown) leaves. The pictures a frame
  draws are decoded (`Engine::decode_images`, ahead of the queue, three at a time across the workers, `DEMAND_DECODES` times the picture
  budget; one asked for earlier behind the queue, as a tick ahead's or a thumbnail's, is moved ahead when a frame waits for it:
  `Engine::promote_images`) and uploaded whole at once; the others a slice of 8 MiB a frame (a 4K picture goes in over eight frames,
  `Renderer::upload_rows`). The pages of the frame being drawn are never taken, so a frame that draws from more pages than there
  are layers makes the texture grow (once, by a copy: the budget is soft only in that case).
- **A table of what each tick draws** (`Engine::request_picture_table`, `picture_table.rs`) is made on the workers when nothing
  else waits (`Engine::spawn_idle`: after frames and pictures): each tick is evaluated and encoded as the stage's frame is
  (culled to the artboard, so a picture only an off-artboard part draws is not one a layer is wanted for), and the
  pictures its draw list names are kept. Playback loads the pictures of the next 72 ticks from it, nearest first
  (`Stage::pictures_ahead`), and the interface tells the stage the tick the person went to (`Stage::hint_tick`, from
  `engine-stage.mjs`) so the pictures of the 12 ticks on each side load too; the same rows say which pages are needed soonest, which
  pages stay. A table belongs to one revision: an edit makes the next one when asked for.
- **A frame draws when every picture it shows is in or has its soft copy**; the sharp pictures of a frame drawn soft are uploaded
  whole as soon as they are decoded and the frame is drawn again (`pictures_pending`, `waitForPictures`). A picture without a soft
  copy yet (a document just opened) makes the frame wait, the picture on show stays (the rule for pictures still on their way).
  A picture that cannot be decoded is not waited for; one the engine refused for want of memory is asked for again three
  times. Pixels of a picture whose page left while it was decoded are not written (`styk_engine::has_place`): the rows already
  written would be missing from the picture when its page is given a layer again.
- **Where the soft copy is seen**: the stage's frame while a picture is not in, and its camera monitor (which shares the stage's
  textures and table, so while the stage waits it draws the soft copy, not a blank). Never in an export, a preview or a saved
  file: those hold their own renderers, whole-layout ones. A frame thumbnail on the stage's device
  (`Stage::pictures_ready_for_view`) follows the same rule as a far jump, soft first, then sharp: it is drawn at once, a picture
  that is not in the texture from its soft copy, and `render_thumbnail` answers 3 (`soft`) instead of 0; the interface shows it,
  does not keep it (the filmstrip neither caches it nor marks the card painted, the export dialog's previews draw it again for a few
  seconds) and asks again until the answer is `drawn`: a thumbnail that is kept is every picture sharp, so it is the pixels of a
  whole-layout draw. The sharp pictures are loaded in a **pool of layers of their own** (`Residency::acquire_spare`, `Stage::request_view_pictures`),
  made when a thumbnail first needs one, so a thumbnail gets its pictures whatever the stage's frame holds (when that is every
  layer, the thumbnails would otherwise wait for the playhead to move): a layer the texture has free is used first (the stage's
  loads take it back like any page's, it is not the pool's), then thumbnails take turns on the pool, the next one's pages taking the
  place of the least recently used page that is not one of its own (the pages of **every** picture the thumbnail draws, those sharp
  already too: a thumbnail's pages never take each other's place, or a view of two pages would swap them for ever), and the pool is as
  large as the most pages one thumbnail needed at once that were not in a layer already (a frame spread over three new pages makes
  three layers). Nothing of the frame on show or of the
  ticks loaded ahead of it is ever taken for a view, and the stage's own loads never take a pool layer (a page of the pool the frame on
  show comes to draw from is used where it is). A person who never has a thumbnail drawn pays nothing; one who does pays one
  layer (64 MiB at 4,096²) for as long as the document is open. A picture without a soft copy yet waits for it (a picture that cannot be
  decoded is not waited for). A thumbnail drawn by the preview worker is always sharp.
- **The table follows the layout**: `Renderer::sync_pictures` runs on every frame (`Stage::sync_atlas`) and makes the table (and the
  soft atlas) know every picture of the layout drawn, whatever the page count: a revision that appends a picture to a page that was
  there is a layout with one more picture, not one more page. The preview worker and the export device key their atlas by the
  number of pictures too. A renderer holding the whole layout has the new picture in the table at its page's layer; a resident one
  has it soft until its pixels are in.
- **A layout of more than 1,024 pages** (`MAX_PAGES`, 64 GiB of pictures) has no row for the pages beyond: their pictures are not
  loaded (counted as lost), the table has no entry for them and the shader draws nothing for them (never another page's picture).
- Drawing cels' pages (decoded with the document) and the live drawing slots keep their layers for good.

Measured on 2026-10-31 on tdd2 with release builds (one run each, an off-screen app run beside other agents' builds: directional;
a jump is a seek to a far tick until the app paints it, a drag ends at the last tick, `soft` is the number of frames drawn with
the soft copy of some picture; GPU process private bytes in MiB, the empty app's is 390–408):

| atlas layers | jump to a drawn frame p50 / p90 / worst (ms) | drag end (ms) | playCold: late frames, over 100 ms, worst (ms), `soft` | playWarm: same | GPU settled | GPU after play |
| --- | --- | --- | --- | --- | ---: | ---: |
| whole layout (20 pages, no soft copies) | 36–44 / 74–84 / 232–243 | 22–39 | 1, 0, 65 | 0, 0, 49 | 1,946 | 1,782–1,784 |
| 12 (least recently shown leaves) | 53 / 101 / 227 | 16–28 | 0, 0, 57, 0 | 0, 0, 52, 0 | 1,361 | 1,282–1,301 |
| 6 | 52 / 100 / 233 | 22–33 | 0, 0, 62, 0 | 0, 0, 55, 0 | 975 | 911–921 |
| 4 (default) | 61 / 111 / 291 | 28–47 | 1, 0, 78, 1 | 0, 0, 46, 1 | 842 | 753–774 |
| 3 | 67 / 127 / 291 | 25–27 | 1, 0, 65, 1 | 0, 0, 58, 1 | not read | 784–808 |

**Where a far jump's time goes** (release build, `tdd2`, 48 jumps across the animation, three runs each of 4 layers and the whole layout, probe
slot beside other jobs): the first frame is drawn 27–42 ms (p50), 59–77 ms (p90) after the seek with 4 layers and 34–41, 65–70 with the whole
layout, and 15–24 ms after a fast drag ends against 22–25. Nearly all of it is the first `render_edit` call, which evaluates the pose
of the tick and encodes its draw list on the interface thread (10–60 ms for 263 figures, the same in both), after about 14 ms of editor work
before the stage is asked; what the pictures add to the frame is `syncMs` ≤ 1.4, `readyMs` ≤ 0.4 and `hintMs` ≤ 0.2 (p95), with a draw 1 ms longer.
A far jump draws soft at once; the sharpening redraws that follow (about ten a jump, one slice of a picture each) are not in the first frame.
Before this was measured, the idle work that makes the table of what each tick draws advanced the engine's progress counter, which wakes every
waiter, and the pictures of a frame drawn soft were uploaded whole inside whichever frame came next.

Memory with the document open, settled, 3,497 MiB (whole layout) to 2,315 MiB (4 layers) for the whole app. 3 layers grow to 4 as
soon as a frame draws from four pages (tdd2: the edit frame with onion skins); 4 is what 3 settles at. A texture whose
last handle is dropped is not given back by the browser until it collects it: a sprite texture that was replaced
(the growth above, another document) is `destroy`ed once its texels are copied (two growths once kept 960 MiB beyond the
atlas). The 280 to 400 MiB of the GPU process that no counter names is in the empty app already (the stage's own
allocations there are 12 MiB of targets); this change does not name it (hypothesis: the driver and the browser's device and
pipelines).

The whole layout's jump times are those of a document with every picture on the GPU. With soft copies a jump draws at once whatever
the number of layers: the first frame after a far jump is soft (29 to 44 of the 48 jumps) and sharp a few frames later, when its
pictures (100 to 300 ms of decoding a 4K picture, three at a time) are in. Before eviction chose the page needed farthest ahead
(least recently shown first), 6 layers showed a soft picture in 11 of 241 frames of playback; with it, in none.

## When the memory cannot hold the work

`styk-alloc` (the allocator of every WebAssembly module) counts the bytes it hands out and knows the
memory's maximum (the page passes it to `EngineHandle`: `createEngineMemory` in `engine.mjs`). It keeps
the last sixteenth (`ceiling`) for the small allocations nothing can refuse (a record, a string, an
error message): a request of 256 KiB or more that would reach into it gets a null pointer, so
`Vec::try_reserve` fails with an error instead of the module aborting. Work that allocates in pieces
first `reserve`s the most it expects to need, for as long as it runs, and is refused (`OutOfMemory`)
when the memory cannot give it; reservations count against every other request.

| Work | Reserves | Refusal |
| --- | --- | --- |
| Opening a file or text (`Engine::open_document`) | 16 bytes per byte, at least 96 MiB (measured peaks: 7 to 14 bytes per byte for documents of 4 to 41 MiB); for a project container, what its parts take (three times the skeleton's text, twice each section: `container::open_cost`, from the sizes in its header), never more than 16 bytes per byte; for a Pivot file that size refuses, 8 bytes per byte of what it inflates to, counted first (`inflated_size`: a window of 32 KiB, nothing kept, cancellable) | the open error `errors.engine.outOfMemory` (`code` `out_of_memory`); the interface asks first (`admit_open`: the copy of the file and the least an open takes, and the one block the copy needs), because copying a file into the module cannot be refused; the open then reserves the rest |
| Decoding a picture or a drawing cel | the decoded size twice and the bordered size twice (`decode_image_working_bytes`); three times the cel | the picture is not shown, like one that cannot be decoded (`picturesRefused` in `engine.memory()`) |
| Decoding a picture again for a frame (`Images::ensure`) | as above | the frame is not drawn (a thumbnail or pose is refused, a CPU export stops with the message) |
| An editing call, and activating a session | 64 MiB (an undo or a redo: 256 MiB), or the most any call of the session has taken beyond what it held when it began, a quarter more (measured on tdd2: a pose or a movieclip edit 2 MiB, undoing a movieclip edit 380 MiB at its peak) | the answer `{status: 'error', error: 'errors.engine.outOfMemory'}`; the document is unchanged |

`engine.memory()` (`EngineHandle.memory`) reports the linear memory, the bytes handed out and their peak
since `reset_memory_peak`, the reserved bytes, the ceiling, the pictures waiting and the frame cache.

## Closing and reopening

Measured 2026-11-01 (dev build, one launch each): tdd2, testingupload.styk and svr_uriel opened as three tabs, closed one
by one, and opened again, three rounds. At the 2 GiB memory: live memory is 667 to 681 MiB with the three open and 16 MiB
once they are closed, every round; the heap reaches 854 MiB in the first round and does not grow in the next two (the
dead space is reused), no document is refused and nothing is raised. At a memory of 896 MiB (the same build with the
maximum lowered): testingupload is refused in each round with `errors.engine.outOfMemory` ("There is not enough memory
for this. Close other projects or save your work and restart StykAnimate."), tdd2 and svr_uriel open, close and open
again, and the engine keeps working: no `unreachable`. An `unreachable` seen at 34144f6a with the same flow was not
reproduced after the changes above; what ended the engine there was most likely an allocation the image decoder cannot
refuse, made when the memory was full: a 4,096-wide picture's resize asked for 129 MiB in one block, on top of
a decoder's own copies, and the memory grew in steps of up to 128 MiB near its maximum. The admission still counts
bytes handed out, not the heap: with a heap full of dead, fragmented space a large request the allocator cannot serve is
refused only where the code asks fallibly (`try_reserve`: the picture buffers, the file copy), and aborts elsewhere
(the image library's own buffers, the inflate output of a Pivot file, the container's raw block). Left.

## Left

- A parked tab keeps the typed views it was opened with (`Publisher.opened`), so a document edited far from its
  opened state holds both: up to 150 MiB more for a 40 MiB Pivot file. Giving them up needs the session to
  keep the last published views instead.
- Undo and redo rebuild records the opened tree shares, and the tree after an undo of a movieclip edit of tdd2
  takes 62 MiB more than the opened one (unpacked pose arrays).
- The history accounts an entry by the size of the records it replaces (100 MiB for one movieclip edit of
  testingupload.styk, 3 MiB of memory), so the byte limit retires older entries sooner than the memory needs.

## Tests

`cargo test -p styk-alloc` (the caches, the lock and the count, with threads), `tests/engine-allocator-threads.test.mjs` (real threads on the module's allocator: blocks freed by other threads, the heap grown together, threads ended the way the export worker ends), `cargo test -p styk-alloc -p styk-engine -p styk-eval` (the picture budget in `images/tests.rs` and
`export.rs`, the refusals in `tests/open.rs`, the loader in `tests/incremental.rs`), and
`tests/engine-memory.test.mjs`, `tests/engine-stage.test.mjs`; the bounded pictures of the CPU rasterizer in
`styk-raster/tests/image_budget.rs`.
