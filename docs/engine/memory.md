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
  budget) and uploaded whole at once; the others a slice of 8 MiB a frame (a 4K picture goes in over eight frames,
  `Renderer::upload_rows`). The pages of the frame being drawn are never taken, so a frame that draws from more pages than there
  are layers makes the texture grow (once, by a copy: the budget is soft only in that case).
- **A table of what each tick draws** (`Engine::request_picture_table`, `picture_table.rs`) is made on the workers when nothing
  else waits (`Engine::spawn_idle`: after frames and pictures): each tick is evaluated and encoded as a frame is, and the
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
  file: those hold their own renderers, whole-layout ones. A frame thumbnail on the stage's device (`Stage::pictures_ready_for_view`)
  draws a picture that is not in from its soft copy only when the soft copy has a texel for every pixel the picture covers on the
  card along both of its axes (a streak stretched along one is loaded sharp) (`styk_engine::pictures_needing_sharp`: a 4K picture on a card of a few hundred pixels); a picture it cannot resolve is loaded
  like the stage's own, and the texture grows once for it if no layer is free, so a thumbnail always finishes and the stage keeps its
  frame (before, a thumbnail asked for every picture sharp, was refused a layer when the four were taken and requested nothing).
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
