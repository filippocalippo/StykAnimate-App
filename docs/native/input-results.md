# Pen and tablet input: what was measured (spike S1, revised 2026-11-07 after the diff review, the re-check and the checker)

The design is [input.md](input.md); this page is what the code did against its acceptance criteria. Latencies are measured
with the display at **144 Hz (6.94 ms a frame), present mode Fifo** (iced's `AutoVsync`; the compositor's
`desired_maximum_frame_latency` is 1), release build with the `devtools` feature, an RTX 4070 SUPER and a Ryzen 5 5500, in a
`probe` slot on a machine other jobs were using. **No system-level input injection is used** (decision N6): the first version
of this page rested on a synthetic pen injected into a window on the screen; those runs, and every number from them, are
withdrawn. Nothing here is a number from a tablet: none was used, and the `WM_POINTER` subclass itself is covered by tests of
its pure parts only (`pen_sample`, `phase_of`, `cancels`, `promotion`, `scale_himetric`, and `HistoryClock` for the times of history entries).

How to run it: `stykanimate --self-test standard|blocked|behaviour|stress[:seconds] --out <folder> --size 900x500` in a
`devtools` build with `STYK_BACKGROUND_WINDOW=1` (the window opens off-screen, out of the taskbar and without focus). A feeder thread pushes scripted samples into the pad's input queue as a
platform source would, stamped with the clock at the push; the pad reads them, the stroke rules run, the worker draws, the
tiles reach a real GPU texture. It writes `samples.csv`, `frames.csv`, `pushed.csv`, `report.txt` and `screenshot.png`.
`--pen-lab` opens the lab by hand.

## Results

| | Criterion | Result |
| --- | --- | --- |
| A1 | Fields reach the pad exactly | **Pass**, standard run: tool (the script's second stroke is the eraser end), barrel and phase 0 mismatches, tilt and pressure error 0, position error 0 (the script's samples through the queue; the OS side is the platform tests above) |
| A2 | Every sample, in order, none twice | **Pass**, standard and blocked runs: 1200 delivered, 1184 of 1184 in contact, monotonic, no duplicates, the queue shed nothing |
| A2 | Interface thread blocked 50 ms twenty times | **Pass**: all 1200 delivered in order, queue high-water 16, nothing dropped; the 27 frame gaps over twice the median are the blocks |
| A3 | Same events, native against today's app | **Pass**: see "Parity" (7 scenarios, 25 stages compared against a committed capture) |
| A4 | Latency | see "Latency"; no display-latency gate is claimed |
| A5 | Interface thread never blocks (D7) | **Pass** (standard and stress runs): `update` max 70 and 30 us; the `prepare`'s **own work** max 363 and 567 us against a 3 ms budget (the whole `prepare` including the graphics API's queue calls 1369 and 670 us: one first-frame texture write took 1.3 ms of it, which is the driver's time and is now reported apart); the 200,000 px gap is generated on the worker (longest generation 91 ms, longest raster 3.5 ms) |
| A5 | No frame skipped while the worker works (stress, 64x zoom and mirror, then a huge gap) | **Pass**: median frame 6.95 ms, worst 8.10 ms over 128 frames; 0 frames over twice the median |
| A6 | Stroke logic | 22 unit tests of `StrokeInput` plus the parity run |
| A7 | Behaviour (scripted samples) | **Pass**: barrel over the pad opens the palette once; a press that begins on a control starts no stroke; a finger alone draws when the setting says so; a finger within 700 ms of the pen is ignored |
| A8 | Queue saturation, release, a new stroke | **Pass** (unit tests; the queue is bounded at `CAPACITY + RESERVE` whatever the terminals do) |
| A9 | Retirement: no gap, no double paint, delays, staged installs, cancel, stale | **Pass**: logic tests (`wet`, `tile_sync`) and two tests that draw the pad on the real GPU and compare it with the cel pixel for pixel, through clear, undo, a moved view and a view that moves over a stroke's ink mid-stroke |
| A10 | A real tablet | **Not run** |
| not tested | Hover reaching a toolkit widget, press-and-hold, the eraser flags a driver reports, `WM_POINTER` history on a real device | need the operating system's own input: by hand with a tablet |

## What the review's findings became

Each has a regression test that I saw fail without the fix ("mutation": the fix removed, or the reviewed code run) unless it says
otherwise. The first twelve are the diff review's (head 08d30f1e, fixed in the previous round); the next two tables are this
round's: the re-check's R1 to R8 and the checker's B1 to B7 (the review's twelve that the re-check found holding are listed
for completeness).

### This round: the re-check (R) and the checker (B)

| # | Finding | Fix | Regression test and what it showed |
| --- | --- | --- | --- |
| R1 | Worker memory unbounded: the brush collected its points and dabs for a whole gap before the gate ran | the brush streams: each dab goes to a bounded batcher and a full batch is rasterised before the brush makes more; no list of points or dabs exists | `generation_stops_after_a_few_batches_while_nothing_is_acknowledged_however_long_the_gap` (a 200,000 px gap, nothing acknowledged: at most 6 batches of dabs are made, not 800,000). **Mutation** (gate off): fails |
| R2 / B1 | Pending batches could resurrect undone ink; a fetch in a stroke returned the cel and erased the stroke's ink | worker: every change carries a stamp, a fetch answers from the open stroke; atlas: a reply that gives a tile back (undo, redo, clear, cancel, fetch) removes it from every queued and half-written batch | `an_undo_removes_its_tiles_from_the_batches_still_waiting`, `fetched_pixels_replace_the_older_queued_batch_for_that_tile_and_a_later_batch_follows_them`, `a_cancel_removes_its_restored_tiles_from_other_queued_batches` (**mutation**: all three fail); `a_fetch_during_a_stroke_returns_its_ink_and_stamps_only_grow_through_undo` (**mutation**: fails); on the GPU `a_view_that_moves_over_the_open_strokes_ink_shows_it_and_keeps_it` (**mutation**: 877 pixels of the frame differ from the cel) |
| R3 / B2 | A full pending queue hid the `Cancelled` reply; a view that pinned more inked tiles than the atlas held deferred a batch forever | no gate on replies (what waits is bounded by the worker's window); hidden tiles dropped on arrival; a stroke batch takes the slot of the least recently used visible tile, a fetched tile is declined and counted | `a_cancel_is_taken_and_frees_the_worker_even_when_the_atlas_is_pinned_and_batches_are_waiting`, `a_stroke_batch_takes_the_slots_of_the_least_recently_used_visible_tiles_when_the_view_pins_more_than_the_atlas_holds` (**mutation**: fails), `a_batch_larger_than_the_whole_atlas_shows_what_fits_and_is_acknowledged`, `a_fetched_tile_is_declined_not_retried_while_every_slot_holds_a_shown_tile`, `tiles_the_view_does_not_show_are_dropped_on_arrival` (**mutation**: fails) |
| R4 | A cancel's acknowledgement of a later batch let five batches out | the acknowledgement is a contiguous frontier | `the_worker_stays_within_its_outstanding_batches_until_they_are_acknowledged` now acknowledges the newest alone and requires nothing to come out, then closes the gap. **Mutation** (old prefix rule): fails |
| R5 | The request queue was unbounded (Begin, End, settings, other requests) | at most 16 open strokes, a stroke ends once, ends of strokes never admitted dropped where made, other requests past 1,024 refused; all counted | `presses_and_requests_past_the_limits_are_refused_and_counted_and_a_stroke_ends_once` (**mutation**: fails) |
| R6 | The 64-tile limit had bypasses (a huge first dab, the provisional tail, the first install of a frame) | the batcher cuts at 64 tiles and a single huge dab is a batch of its own, sent in parts of at most 64 (`part`, `last`); the atlas writes a few tiles a call (at least one) and flips the batch whole | `one_huge_dab_is_sent_in_parts_of_at_most_the_tile_limit_and_the_batch_ends_once` (**mutation**: fails), `a_batch_gathers_dabs_up_to_the_tile_limit_and_a_single_dab_goes_alone` (**mutation**: fails), `a_big_batch_is_written_over_several_calls_and_appears_whole_in_the_last`, `every_call_places_at_least_one_tile_whatever_the_budgets`, `a_batch_arriving_in_parts_is_not_complete_until_the_last_and_its_preview_stays_until_then` |
| R7 | Zero-QPC history got a different time in each message | `HistoryClock`: one mapping per pointer, `(time, content)` identity, distinct increasing times | `an_entry_two_messages_carry_gets_one_time_and_is_delivered_once` and four more in `styk-services`; `history_entries_that_share_a_millisecond_are_all_kept_when_their_times_are_made_distinct` through `StrokeInput` with the clock |
| R8 | The save and reopen helper bypassed the document | a drawing layer is made by the editing session, the stroke committed as its pixel entry, the cel published, the document written as a container, read back, and a session started on it (validating the drawing and the layer sheet) | `pen_save.rs`, and the `reopen` stage of every `pen_parity.rs` scenario compare the tiles, the cel's pose and its layer. **Mutations**: without `@publishCel` "the tile blob survives" fails; with the root x of the object written as 0 the pose comparison fails (`(0, 80)` against `(120, 80)`) |
| B3 | `Cancel{99}` destroyed the open stroke | a cancel for an id that is not the open stroke changes nothing, at the command and in the thread | `a_cancel_for_a_stroke_that_is_not_open_leaves_the_open_stroke_alone` (**mutation** of the thread's check: fails; the reviewed code destroyed the stroke) |
| B4 | The parity test returned as a pass without a capture | the capture of today's app is committed (`tests/fixtures/pen/capture.json.zst`, 163 KB to 17 KB; `STYK_PEN_PARITY` replaces it); the test fails if it cannot read it or compares fewer than 25 stages | run with the fixture moved away: "the committed capture of today's app reads: ... NotFound", test **FAILED** |
| B5 | A brush's `workingBytes` could raise the stroke's memory cap | the worker's cap (512 MiB) is the ceiling | `a_brush_cannot_raise_the_strokes_working_budget_above_the_workers` (**mutation**: fails) |
| B6 | A press on a pointer still open was refused with a notice | ignored, as today's `down()` returns while a gesture is open; counted in `ignored` | `a_press_for_a_pointer_whose_gesture_is_open_is_ignored_and_the_stroke_goes_on` (**mutation**: fails) |
| B7 | The A5 prepare-slice check failed once at 10.8 ms under load | the graphics API's queue calls are timed apart and the check is on the pad's own work; a uniform block that did not change is not written | `a_uniform_block_that_has_not_changed_is_not_written_again` (**mutation**: fails); the self-test prints own, whole and graphics-API times (`own 363 us; whole 1369 us of which graphics API 1335 us`), and 185 uniform writes were skipped in the stress run |

### The previous round: the diff review's twelve

Mutation means I removed the fix and saw the test fail. "failed on 08d30f1e" means I ran the test on the reviewed code.

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | A cancel truncated an earlier queued stroke | cancel by stroke identity, one abort flag per stroke | `cancelling_a_later_stroke_does_not_truncate_an_earlier_queued_one`: **failed on 08d30f1e** (0 tiles, 0 dabs); `a_cancel_behind_a_held_worker_leaves_the_stroke_queued_before_it_whole` |
| 2 | Refused uploads acknowledged as shown | `TileSync`: acknowledge only what is in the view, evict outside it (the deferral and drop of that round became the stroke-batch eviction above) | `a_stroke_far_longer_than_the_atlas_stays_within_it_and_is_acknowledged_whole`. The old behaviour was also **measured**: 1081 tiles uploaded and 5466 refused uploads acknowledged in one stress run of 08d30f1e |
| 3 | Partial uploads double-paint | batches appear whole (now staged over frames, see R6) | the randomised `no_dab_is_ever_missing_or_painted_twice_whatever_the_delays`; the GPU tests |
| 4 | `prepare` unbounded; channels unbounded | whole `prepare` budgeted (3 ms); preview capped (32,768); the worker rasterises at most 4 batches ahead of acknowledgements; batches cut at 64 tiles; no pixels in undo/redo/cancel replies; samples refused past 131,072 | `the_worker_stays_within_its_outstanding_batches_until_they_are_acknowledged`, `the_ledger_holds_no_more_dabs_than_its_cap_and_drops_the_oldest_batch_first`, `a_worker_too_far_behind_refuses_samples_and_says_so`, `a_fetch_returns_at_most_the_fetch_limit`, `fetches_are_bounded_not_repeated_and_empty_tiles_are_remembered` |
| 5 | Terminal events defeated the queue bound | gestures admitted are tracked; the reserve holds one end per gesture; nothing is evicted | `terminal_events_never_grow_the_queue_past_its_bound` and two more: **all failed on 08d30f1e** |
| 6 | Dropping the worker joined on the interface thread | never join; abort flags; the brush's loops check the flag | `dropping_the_worker_does_not_wait_for_the_work_it_has_queued`: **failed on 08d30f1e** (waited 1.47 s) |
| 7 | Lifecycle gaps | mouse `WM_CAPTURECHANGED`; any cancel flag on pen and touch | `a_cancel_is_read_with_or_without_a_lift` (the message handling itself needs a window) |
| 8 | Zero-QPC history collapsed to one timestamp | first `history_times`, since R7 `HistoryClock` | see R7 |
| 9 | "Save and reopen" bypassed saving; no moved or rotated cel | see R8; a scenario with the cel rotated and moved as an object | `pen_save.rs`, the `moved-and-rotated-cel` scenario of `pen_parity.rs` |
| 10 | A5 ran at 1x, and generation was mis-timed | the view changes only after the first stroke has captured its mapping; generation is the time of the brush's own calls less rasterising within them | `the_time_to_generate_dabs_is_the_time_the_brush_took` |
| 11 | Raw preview ignored the stroke's own eligibility; the anchor bridged strokes | `Live` carries the stroke and its eligibility; the anchor belongs to a stroke | `the_dab_the_preview_continues_from_belongs_to_its_stroke_and_goes_with_it` |
| 12 | Inspector controls started strokes | `Context::region` | `a_press_outside_the_drawing_surface_starts_nothing_and_a_stroke_may_leave_it` (**mutation**); behaviour run |

## What the 27-31 ms stress frames were

Not the pad's own work. On the reviewed commit (08d30f1e), with a timer around each phase of `prepare` and the machine quiet, the
same stress ran 306 frames with a worst gap of 7.9 ms and a slowest `prepare` of 0.99 ms. It uploaded 1081 tiles in 41 frames and
refused, yet acknowledged, 5466 (finding 2), and it did not skip a frame. So the 27 to 31 ms frames of the first run came from
competing jobs on the machine (the probe slot is not exclusive, and other builds were running); no phase of `prepare` explains
them, and I cannot name the competing process. With the fixes, the stress shows no frame over twice the median in two runs.

## Parity with today's app

`scripts/pen-parity-capture.mjs` drives today's app (Chrome, the web build served from this checkout, the DevTools Input domain
for pen events and synthetic pointer events for the interrupted stroke; Electron is used only for this) and records, per
scenario, the brush the controller posted, the camera and the cel's pixel matrix, **the events the page received** (Chrome
rounds positions and pressure to single precision and stamps its own times), and the SHA-256 of every tile after the stroke,
after undo, after redo and after a save and reopen. The capture is committed (`engine/crates/styk-core/tests/fixtures/pen/capture.json.zst`) and
`engine/crates/styk-core/tests/pen_parity.rs` replays the received events through `StrokeInput`, `Mapping` and the drawing worker,
and for "reopen" saves the cel through the engine: a drawing layer made by the editing session, the stroke committed as its
pixel entry, the cel published with its tiles encoded by the drawing codec, the `.styk` container written and read back by the
file layer, a session started on the result, the tiles decoded from it, and the cel's pose and layer read back.

| Scenario | Tiles | Commit | Undo | Redo | Save and reopen (engine container) |
| --- | --- | --- | --- | --- | --- |
| plain pen stroke, pressure and tilt | 43 | identical | identical | identical | identical |
| view zoomed 2.5x and panned | 18 | identical | identical | identical | identical |
| symmetry mirror | 57 | identical | identical | identical | identical |
| flat tip turning with the tilt, zoomed 1.7x | 22 | identical | identical | identical | identical |
| interrupted (capture lost half way): keeps its ink | 21 | identical | identical | identical | identical |
| **the cel rotated and moved as an object after its first mark** | 39 | identical | identical | identical | identical |
| Escape half way: discarded | 0 | cel unchanged | | | |

Old-versus-old baseline: each scenario is captured twice; the two runs of today's app agree on every tile hash at every stage
that is compared and differ only in the events' timestamps (the fields that differed are skipped, and the test counts at least 25
stages compared). The test fails when the native path is wrong (with the tilt's x sign flipped, all 22 tiles of the tilt scenario
differ) and when it has no capture. `pen_save.rs` also draws on a cel turned 32 degrees, scaled and moved, in a view turned the
other way and zoomed, and requires the reopened document's cel to equal the worker's, tile for tile, at the pose it was placed
at, through undo and redo. Limits: the web build is not the Electron shell (the engine is the same); the document is the
recorded tape's first document with one drawing layer, not a whole animation; the pose is checked as the object record the
session wrote and the file kept, not by redrawing the reopened document.

## Latency (push to the end of the `prepare` of the first frame showing the sample)

In-process: from the feeder's push, so it includes the queue, the pad's `update`, the worker, the tile installation and the
frame wait; it excludes the operating system's pointer path. wgpu has no present-timing API, so nothing says when a pixel
reached the panel and no display-latency gate is claimed. Percentiles over the 1184 contact samples (the preview over the 591 of
the first stroke: the script's second stroke is an eraser stroke and is not previewed); "fr" is frames of 6.94 ms.

| Run | Queue read p50 | Preview p50 / p95 / p99 / max (ms) | Exact tiles p50 / p95 / p99 / max (ms) |
| --- | --- | --- | --- |
| standard (this round) | 3.31 | 8.85 / 11.84 / 12.84 / 20.10 | 8.81 / 11.78 / 12.59 / 20.10 |
| blocked (50 ms blocks) | 4.23 | 9.92 / 41.24 / 53.62 / 63.30 | 9.93 / 42.47 / 53.74 / 63.30 |

One run of each this round, in a `probe` slot beside other jobs; the previous round's three standard runs (p50 8.65 to 9.72) agree.
The median is 1.27 to 1.43 frames; the preview and the exact tiles appear in the same frame (the worker returns the tiles of a
12 px brush before the frame is prepared). Under a blocked interface thread the tail is the block (50 ms), by construction. The 20 ms maximum of the standard run is a frame wait on a loaded machine; it is not in the pad's own work (max 363 us). The
browser row of the first version of this page (`tests/drawing-latency.browser.mjs`, p50 36.7 to 49.0 ms) measured CDP mouse
input on the exact scene, not the same workload; the comparison it made is not repeated here.

## What is left

- A real tablet pass: the `WM_POINTER` source on a device, history from a driver, the eraser flags, hover over a widget,
  press-and-hold.
- Wet ink for translucent strokes (a union layer). Today a stroke below full opacity shows exact pixels only.
- A view that moves over a stroke's ink mid-stroke can show a soft edge painted twice for the few frames until the batch that
  covers it is installed (the fetched tile already holds the stroke's dabs and the preview still shows them). It is transient and
  needs a wet stroke and a view change at the same moment; not measured.
- The parity save step starts a session on the reopened document but does not redraw it: the cel's pose is checked as the object
  record, not by pixels of the reopened animation.
- WinTab, macOS and Linux sources (designed in [input.md](input.md), not built); the pen-lab inspector as the developer
  tools' Input panel.
