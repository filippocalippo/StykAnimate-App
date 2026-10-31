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

`cargo test -p styk-alloc -p styk-engine -p styk-eval` (the picture budget in `images/tests.rs` and
`export.rs`, the refusals in `tests/open.rs`, the loader in `tests/incremental.rs`), and
`tests/engine-memory.test.mjs`, `tests/engine-stage.test.mjs`; the bounded pictures of the CPU rasterizer in
`styk-raster/tests/image_budget.rs`.
