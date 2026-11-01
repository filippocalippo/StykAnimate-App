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

**The allocator lock** (`std`'s wasm allocator: one spinning lock for every thread). Timed with a gate in front of it, tdd2
and svr_uriel through open, play and scrub, eight workers: a worker finds the lock taken on 5 to 40 % of its calls and
waits 0.1 to 0.9 s in all over the session (waits up to 28 ms); the interface thread makes 8 to 11 million calls, finds the
lock taken on 0.01 to 0.24 % of them, and waits 21 to 182 ms in all, 4.4 to 9.2 ms at the worst. The long waits are holders
that were descheduled on a machine running other builds, not large allocations (the holder's request was under 1 MiB
for all but the pictures'). Not acted on: per-thread caches would be a new allocator for a cost the interface thread
barely pays, and the 7.7 to 11.4 million calls it makes during an open are the read view's, which goes away with it.

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

`cargo test -p styk-alloc -p styk-engine -p styk-eval` (the picture budget in `images/tests.rs` and
`export.rs`, the refusals in `tests/open.rs`, the loader in `tests/incremental.rs`), and
`tests/engine-memory.test.mjs`, `tests/engine-stage.test.mjs`; the bounded pictures of the CPU rasterizer in
`styk-raster/tests/image_budget.rs`.
