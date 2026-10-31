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

### Pages kept against a budget

A document whose layout has more than `ATLAS_PAGES` (12) pages is not held whole
(`styk_engine::Residency`, `styk-wasm/src/stage/pictures.rs`). Measured on tdd2 (`styk pages`: the layout's pages each
frame draws from, over 589 ticks): one frame draws from at most 3 of its 20 pages (0.4 on average), and the 48 frames
after one from 4.7 on average, 18 at most. So the stage's sprite texture has the empty layer 0 and `ATLAS_PAGES` layers (832 MiB for 12),
the layout's pages are mapped onto them by a table the shader reads (`sprite_layer` in prim.wgsl, `Renderer::map_sprite_page`;
a page without a layer reads layer 0 and draws nothing), and:

- the unit of loading is the picture, the unit of residency the page: a frame needs a few pictures, each is decoded from
  the document's encoded bytes and uploaded on its own (`Engine::decode_images`, the frame's ahead of the queue and
  decoded three at a time across the workers, `DEMAND_DECODES` times the picture budget above), into the layer of its page;
  the page is given a layer when its first picture is wanted, and the least recently shown page leaves for it. The pages
  of the frame being drawn are never taken, so only a frame that draws from more pages than there are layers makes the
  texture grow (for that frame's pages, by copying the texture once: the budget is soft in that case only). The number
  of layers is `Engine::atlas_pages` (`ATLAS_PAGES` unless `EngineHandle::set_atlas_pages` says otherwise before the
  document opens).
- a document of this size is not decoded with the document and its idle upload of every picture does not run. A
  table of what each tick draws (`Engine::request_picture_table`, `picture_table.rs`) is made on the workers when
  nothing else waits (`Engine::spawn_idle`: after frames and pictures, never before): each tick is evaluated and encoded
  as a frame is, and the pictures its draw list names are kept. Playback loads the pictures of the next 72 ticks from it
  (`Stage::pictures_ahead`), the interface tells the stage the tick the person went to (`Stage::hint_tick`, from
  `engine-stage.mjs`) and the pictures of the 12 ticks on each side are loaded; these are asked for behind what a frame
  waits for. A table belongs to one revision: an edit makes the next one when asked for.
- a frame draws only when every picture it draws is in: until then `Stage::render_*` returns false, the picture on show
  stays, and `pictures_pending` says what to wait for (the same rule as pictures still on their way when a document
  opens, `waitForPictures`); the pictures a frame waits for are uploaded whole at once, the others a slice of 8 MiB a frame
  (a 4K picture, 64 MiB, goes in over eight frames, `Renderer::upload_rows`). A picture that cannot be decoded does not hold a frame back
  once nothing is being decoded; one the engine refused for want of memory is asked for again three times first.
- drawing cels' pages (they are decoded with the document) and the live drawing slots keep their layers for good;
  frame thumbnails need their pictures loaded too, take layers only from pages the frame on show does not draw, and wait
  otherwise. Exports, the preview worker and the thumbnails' CPU path hold their own atlases and are unchanged.

Measured on 2026-10-31 on tdd2 with a release build (one run each, off-screen app run beside other agents' builds: directional;
a jump is a seek to a far tick until the app paints it, a drag ends at the last tick; GPU process private bytes, MiB; the empty
app's is 403–417):

| atlas layers | jump to picture p50 / p90 / worst (ms) | drag end (ms) | playCold: late frames, over 100 ms, worst (ms) | playWarm: same | GPU settled | GPU after jumps and drags |
| --- | --- | --- | --- | --- | ---: | ---: |
| whole layout (20 pages, before) | 44 / 84 / 243 | 22–39 | 1, 0, 65 | 0, 0, 49 | 1,946 | 1,928 |
| 12 + empty | 45–60 / 217–226 / 279–463 | 41–55 | 1–2, 0, 65–80 | 0, 0, 48–56 | 1,389–1,409 | 1,590–1,631 |
| 6 + empty | 44–45 / 139–149 / 310–522 | 26–36 | 1, 0–1, 94–95 | 1, 1, 110–119 | 1,019–1,022 | 1,217–1,272 |

The jump rows are the cost of a picture that is not on the GPU: it is decoded (a 4K picture takes 100 to 300 ms) and uploaded
before its frame draws, and the picture on show stays until then (the first change of this kind took up to 1,849 ms: a page
of pictures decoded one after another). Only a document held whole answers a jump at once. Pictures a frame is
about to need are loaded ahead (playback, drag), so those rows are close to the whole layout's.

A texture the last handle to is dropped is not given back by
the browser until it collects it: a sprite texture that was replaced (the grow above, another document) is `destroy`ed
once its texels are copied (before this, two grows kept 960 MiB beyond the atlas). The 280 to 400 MiB of the GPU process
that no counter names is in the empty app already (the stage's own allocations there are 12 MiB of targets); this change
does not name it (hypothesis: the driver and the browser's device and pipelines).

A document of up to `ATLAS_PAGES` pages keeps today's behaviour: a texture of the layout's size, every picture decoded and uploaded
with the document. A picture shown at 4K on a 4K display is never reduced. Left: the page is the unit (a page with 16
small pictures loads them all; a page of one 4K picture is a 64 MiB upload); a smaller level of a picture shown small would
need the owner's decision.

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
