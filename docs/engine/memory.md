# Memory

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

`styk-alloc` now keeps a cache of small blocks for each thread and puts a lock that sleeps behind it (`cache.rs`, `lock.rs`):

- **Caches.** A request of up to 508 bytes is served from a list of the thread's own, one for each of 63 sizes (8 * k + 4 bytes: the room the
  heap's chunks give, so a size wastes nothing the heap would not have). The heap's lock is taken once for a batch of 2 to 16 blocks to fill an
  empty list or empty a full one (a list holds at most twice a batch before half of it goes back). A block belongs to no thread: its size comes with every
  free, so a block freed by another thread than the one that made it joins the freeing thread's list. The cache of a thread holds at most
  2.5 KiB of a size and **125 KiB in all (a few KiB in practice)**, in the thread's thread-local block. A thread that ends hands its lists back when it
  frees that block (`__wbindgen_thread_destroy`, in `GrowAhead::dealloc`); a thread that is terminated or traps loses at most that,
  which stays allocated like the rest of what the thread held ([threading.md](threading.md#when-an-engine-thread-traps)).
  wasm-bindgen allocates a new thread's stack and thread-local block before the thread has a thread-local base, and frees them after setting it to an address no
  memory has: the allocator reads the base (`llvm.wasm.tls.base`) and serves those calls from the heap directly.
- **The lock.** A thread that finds it held spins for a few microseconds, then sleeps on it (`memory.atomic.wait32`) and is woken by the holder, instead of burning a core
  for as long as the holder takes (a `memory.grow` of 16 to 32 MiB holds it for 1 to 3 ms). The interface thread never sleeps (D7): every thread whose scope has no `document` is marked as
  one that may (`styk_alloc::this_thread_may_sleep`, at the module's start). In the runs below no thread ever slept (the holds are shorter than the spin);
  the sleep is for a holder the system has put to sleep.
- **The count of live bytes** is kept for each thread and added to the shared counter in steps of 16 KiB (a request of 8 KiB or more at once), so that every call does not
  write a cache line all the threads share. `live_bytes()` is exact for the thread that asks and short by at most that step for each of the others;
  `peak_bytes()` is never below it. A free that reaches the counter before its allocation does leaves it negative for a moment, so it is read as signed.
  Large requests are refused against it as before (`refuses`, `LARGE_BYTES`, `reserve` are unchanged).

Release builds, medians of 3 runs (`slot.mjs probe`, so the machine was not idle and the figures are directional), the same files and harness before and after:

| | before | after |
| --- | ---: | ---: |
| open of the large `.styk`, 0 / 2 / 3 / 6 helpers | 4,741 / 2,206 / 2,172 / 2,342 ms | 2,679 / 1,820 / 1,681 / 1,635 ms |
| open tdd2 / svr_uriel (3 helpers) | 1,773 / 1,229 ms | 1,439 / 1,133 ms |
| save of tdd2 / svr_uriel / the large `.styk` | 3,742 / 3,764 / 2,225 ms | 3,430 / 3,310 / 1,657 ms |
| heap after the open: large `.styk` / tdd2 / svr_uriel | 443–475 / 445 / 303 MiB | 443 / 446 / 281 MiB |
| live peak of the open: large `.styk` / tdd2 / svr_uriel | 290 / 345 / 236 MiB | 291 / 345 / 237 MiB |
| playback, worst gap between shown frames (tdd2 / svr_uriel / large `.styk`) | 48.3 / 55.3 / 70.1 ms | 48.1 / 55.1 / 70.2 ms |
| allocator lock, large `.styk` open, 3 helpers: holds / found held | 7.8 M calls / 4.0 M | 570 k holds / 150 k |
| wait per busy helper in that open (counting build) | 0.8–0.95 s | 25–70 ms |
| worst wait of the interface thread, opening tdd2 / svr_uriel / the large `.styk` | 35.9 / 17.6 / 4.7 ms | 4.0 / 0.03 / 2.4 ms |
| interface thread finding the lock held during playback and save | up to 0.12% of its calls, 2.5 ms | never |

A single thread opens 1.8 times faster as well: a block from a list costs a few instructions where the heap's `malloc` and `free` cost about a hundred nanoseconds. The open still does not
get faster beyond three helpers (1,681 against 1,635 ms): what is left of the lock is 25 to 70 ms of waiting for each helper, about 5% of the open, so the limit is the work that does not divide, not the allocator;
the cap of three helpers (`MAX_OPEN_HELPERS`) stays. The playback figures did not move (frames are shown every display refresh; the allocator was not what limited them).
`engine.memory()` reports `lockHolds`, `lockContended` and `lockSleeps` (all threads, since the module started).

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
- **The frame cache** stays under an eighth of the memory (240 MiB of 2 GiB), whatever
  `navigator.deviceMemory` says.
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

Left: pages are allocated for the whole layout while the pictures are uploaded over two seconds, and nothing is
evicted; a picture resident only while frames use it (re-uploaded from its encoded bytes), or a smaller level of a picture
shown small, would bring the atlas under the pictures a frame samples, at the cost of the rules for a picture that is
not there yet (`Stage::pictures_pending`). A picture shown at 4K on a 4K display cannot be reduced.

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
| Opening a file or text (`Engine::open_document`) | 16 bytes per byte, at least 96 MiB (measured peaks: 7 to 14 bytes per byte for documents of 4 to 41 MiB) | the open error `errors.engine.outOfMemory` (`code` `out_of_memory`); the interface asks first (`admit_open`, which also tries the one block the copy of the file needs), because copying a file into the module cannot be refused |
| Decoding a picture or a drawing cel | the decoded size twice and the bordered size twice (`decode_image_working_bytes`); three times the cel | the picture is not shown, like one that cannot be decoded (`picturesRefused` in `engine.memory()`) |
| Decoding a picture again for a frame (`Images::ensure`) | as above | the frame is not drawn (a thumbnail or pose is refused, a CPU export stops with the message) |
| An editing call, and activating a session | 64 MiB (an undo or a redo: 256 MiB), or the most any call of the session has taken beyond what it held when it began, a quarter more (measured on tdd2: a pose or a movieclip edit 2 MiB, undoing a movieclip edit 380 MiB at its peak) | the answer `{status: 'error', error: 'errors.engine.outOfMemory'}`; the document is unchanged |

`engine.memory()` (`EngineHandle.memory`) reports the linear memory, the bytes handed out and their peak
since `reset_memory_peak`, the reserved bytes, the ceiling, the pictures waiting and the frame cache.

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
