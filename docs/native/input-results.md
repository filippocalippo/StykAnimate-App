# Pen and tablet input: what was measured (spike S1, revised 2026-11-07 after the diff review)

The design is [input.md](input.md); this page is what the code did against its acceptance criteria. Latencies are measured
with the display at **144 Hz (6.94 ms a frame), present mode Fifo** (iced's `AutoVsync`; the compositor's
`desired_maximum_frame_latency` is 1), release build with the `devtools` feature, an RTX 4070 SUPER and a Ryzen 5 5500, in a
`probe` slot on a machine other jobs were using. **No system-level input injection is used** (decision N6): the first version
of this page rested on a synthetic pen injected into a window on the screen; those runs, and every number from them, are
withdrawn. Nothing here is a number from a tablet: none was used, and the `WM_POINTER` subclass itself is covered by tests of
its pure parts only (`pen_sample`, `phase_of`, `cancels`, `promotion`, `scale_himetric`, `history_times`).

How to run it: `stykanimate --self-test standard|blocked|behaviour|stress[:seconds] --out <folder> --size 900x500` in a
`devtools` build with `STYK_BACKGROUND_WINDOW=1`. A feeder thread pushes scripted samples into the pad's input queue as a
platform source would, stamped with the clock at the push; the pad reads them, the stroke rules run, the worker draws, the
tiles reach a real GPU texture. It writes `samples.csv`, `frames.csv`, `pushed.csv`, `report.txt` and `screenshot.png`.
`--pen-lab` opens the lab by hand.

## Results

| | Criterion | Result |
| --- | --- | --- |
| A1 | Fields reach the pad exactly | **Pass**, 5 runs: tool (the script's second stroke is the eraser end), barrel and phase 0 mismatches, tilt and pressure error 0, position error 0 (the script's samples through the queue; the OS side is the platform tests above) |
| A2 | Every sample, in order, none twice | **Pass**, 5 runs of 1200: 1200 delivered, 1184 of 1184 in contact, monotonic, no duplicates, the queue shed nothing |
| A2 | Interface thread blocked 50 ms twenty times | **Pass**, 2 runs: all 1200 delivered in order, queue high-water 15, nothing dropped; the 19 frame gaps are the blocks |
| A3 | Same events, native against today's app | **Pass**: see "Parity" |
| A4 | Latency | see "Latency"; no display-latency gate is claimed |
| A5 | Interface thread never blocks (D7) | **Pass in the 7 runs that record slices** (3 standard, 2 blocked, 2 stress): `update` max 27 to 86 us, `prepare` max 0.23 to 0.73 ms against a 3 ms budget; the 200,000 px gap is generated on the worker (146 and 162 ms) |
| A5 | No frame skipped while the worker works (stress, 64x zoom and mirror, then a huge gap) | **Pass**, 2 runs: median frame 6.96 and 6.95 ms, worst 9.87 and 12.15 ms over about 260 frames; 0 frames over twice the median |
| A6 | Stroke logic | 22 unit tests of `StrokeInput` plus the parity run |
| A7 | Behaviour (scripted samples) | **Pass**, 2 runs: barrel over the pad opens the palette once; a press that begins on a control starts no stroke; a finger alone draws when the setting says so; a finger within 700 ms of the pen is ignored |
| A8 | Queue saturation, release, a new stroke | **Pass** (unit tests; the queue is bounded at `CAPACITY + RESERVE` whatever the terminals do) |
| A9 | Retirement: no gap, no double paint, delays, whole installs, cancel, stale | **Pass**: logic tests (`wet`, `tile_sync`) and a test that draws the pad on the real GPU and compares it with the cel pixel for pixel, through clear, undo and a moved view |
| A10 | A real tablet | **Not run** |
| not tested | Hover reaching a toolkit widget, press-and-hold, the eraser flags a driver reports, `WM_POINTER` history on a real device | need the operating system's own input: by hand with a tablet |

## What the review's findings became

Each has a regression test; where I saw it fail first on the reviewed code, it says so ("failed on 08d30f1e"). "Mutation"
means I removed the fix and saw the test fail. Where neither is stated, the test was written with the fix and the old code
was not run against it.

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | A cancel truncated an earlier queued stroke | cancel by stroke identity, one abort flag per stroke | `cancelling_a_later_stroke_does_not_truncate_an_earlier_queued_one`: **failed on 08d30f1e** (0 tiles, 0 dabs); `a_cancel_behind_a_held_worker_leaves_the_stroke_queued_before_it_whole` |
| 2 | Refused uploads acknowledged as shown | `TileSync`: acknowledge only installed tiles, evict outside the view, defer or drop and count | `a_batch_the_view_pins_too_many_slots_for_is_deferred_not_acknowledged_as_shown`, `a_stroke_far_longer_than_the_atlas_stays_within_it_and_is_acknowledged_whole`, `a_batch_larger_than_the_whole_atlas_is_dropped_acknowledged_and_counted`. The old behaviour is also **measured**: 1081 tiles uploaded and 5466 refused uploads acknowledged in one stress run of 08d30f1e |
| 3 | Partial uploads double-paint | batches install whole | `a_batch_is_installed_whole_in_one_call_whatever_the_tile_budget`, the randomised `no_dab_is_ever_missing_or_painted_twice_whatever_the_delays` now with whole-batch installs; the GPU test |
| 4 | `prepare` unbounded; channels unbounded | whole `prepare` budgeted (3 ms); replies taken one at a time under a byte bound; preview capped (32,768); the worker rasterises at most 4 batches ahead of acknowledgements; batches cut at 64 tiles; no pixels in undo/redo/cancel replies; samples refused past 131,072 | `the_worker_stays_within_its_outstanding_batches_until_they_are_acknowledged` (**mutation**: 10 batches instead of 4), `ingestion_stops_when_the_waiting_batches_hold_too_much`, `the_ledger_holds_no_more_dabs_than_its_cap_and_drops_the_oldest_batch_first`, `a_worker_too_far_behind_refuses_samples_and_says_so`, `a_fetch_returns_at_most_the_fetch_limit`, `fetches_are_bounded_not_repeated_and_empty_tiles_are_remembered` |
| 5 | Terminal events defeated the queue bound | gestures admitted are tracked; the reserve holds one end per gesture; nothing is evicted | `terminal_events_never_grow_the_queue_past_its_bound`, `a_terminal_event_never_removes_a_press_or_a_move`, `a_lift_or_interrupt_of_a_gesture_that_was_never_admitted_is_counted_not_queued`: **all three failed on 08d30f1e** |
| 6 | Dropping the worker joined on the interface thread | never join; abort flags; the brush's loops check the flag | `dropping_the_worker_does_not_wait_for_the_work_it_has_queued`: **failed on 08d30f1e** (waited 1.47 s) and, with the brush's check removed, the thread outlives the call (**mutation**) |
| 7 | Lifecycle gaps | mouse `WM_CAPTURECHANGED`; any cancel flag on pen and touch | `a_cancel_is_read_with_or_without_a_lift` (the message handling itself needs a window) |
| 8 | Zero-QPC history collapsed to one timestamp | `history_times` from each entry's `dwTime`, strictly increasing | `history_entries_that_share_a_millisecond_are_all_kept_when_their_times_are_made_distinct` (through `StrokeInput`: 5 of 5 kept where the old rule kept 1), the `history_*` tests of `styk-services` |
| 9 | "Save and reopen" bypassed saving; no moved or rotated cel | the cel goes through the drawing tile codec into a document written as a `.styk` container and read back by `files::open_document`; a scenario with the cel rotated and moved as an object | `pen_save.rs` (needs no capture), the `reopen` stage and the `moved-and-rotated-cel` scenario of `pen_parity.rs` |
| 10 | A5 ran at 1x, and generation was mis-timed | the view changes only after the first stroke has captured its mapping; generation is the time of the brush's own calls | `the_time_to_generate_dabs_is_the_time_the_brush_took` (the worker reports at least half the time the same gap takes the brush directly); the stress run's "longest dab generation 146 ms" |
| 11 | Raw preview ignored the stroke's own eligibility; the anchor bridged strokes | `Live` carries the stroke and its eligibility; the anchor belongs to a stroke and goes with it | `the_dab_the_preview_continues_from_belongs_to_its_stroke_and_goes_with_it`. The eligibility is decided when the stroke begins from the stroke's own tool; the raw-preview draw itself is only exercised by the GPU test's stroke |
| 12 | Inspector controls started strokes | `Context::region`: a press outside the pad starts nothing, a stroke it owns goes on | `a_press_outside_the_drawing_surface_starts_nothing_and_a_stroke_may_leave_it` (**mutation**: fails with the check removed); behaviour run "a press that begins on a control starts no stroke" |

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
after undo, after redo and after a save and reopen. `engine/crates/styk-core/tests/pen_parity.rs` replays the received events
through `StrokeInput`, `Mapping` and the drawing worker, and for "reopen" saves the cel through the engine: the tile codec, a
document, the `.styk` container written and read back by the file layer, the tiles decoded from what came out.

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
and differ only in the events' timestamps. The test fails when the native path is wrong (with the tilt's x sign flipped, all 22
tiles of the tilt scenario differ). `pen_save.rs` also draws on a cel turned 32 degrees, scaled and moved, in a view turned the
other way and zoomed, and requires the container's cel to equal the worker's, tile for tile, through undo and redo. Limits:
the web build is not the Electron shell (the engine is the same); the test passes without checking anything unless
`STYK_PEN_PARITY` names a capture; the document the container test writes carries the tile blob in an image asset as the app's
documents do but is not a whole animation (the editor session's own publication of a cel is not exercised).

## Latency (push to the end of the `prepare` of the first frame showing the sample)

In-process: from the feeder's push, so it includes the queue, the pad's `update`, the worker, the tile installation and the
frame wait; it excludes the operating system's pointer path. wgpu has no present-timing API, so nothing says when a pixel
reached the panel and no display-latency gate is claimed. Percentiles over the 1184 contact samples (the preview over the 591 of
the first stroke: the script's second stroke is an eraser stroke and is not previewed); "fr" is frames of 6.94 ms.

| Run | Queue read p50 | Preview p50 / p95 / p99 / max (ms) | Exact tiles p50 / p95 / p99 / max (ms) |
| --- | --- | --- | --- |
| standard 1 | 3.18 | 8.65 / 11.44 / 12.80 / 13.09 | 8.70 / 11.70 / 12.86 / 15.89 |
| standard 2 | 3.84 | 9.36 / 12.26 / 12.43 / 13.49 | 9.39 / 12.47 / 12.90 / 15.16 |
| standard 3 | 3.46 | 9.72 / 12.63 / 12.74 / 13.57 | 9.00 / 12.61 / 12.74 / 15.91 |
| blocked 1 (50 ms blocks) | 4.24 | 9.88 / 44.23 / 55.27 / 57.42 | 9.86 / 44.23 / 54.38 / 57.99 |

The median is 1.25 to 1.4 frames; the preview and the exact tiles appear in the same frame (the worker returns the tiles of a
12 px brush before the frame is prepared). Under a blocked interface thread the tail is the block (50 ms), by construction. The
browser row of the first version of this page (`tests/drawing-latency.browser.mjs`, p50 36.7 to 49.0 ms) measured CDP mouse
input on the exact scene, not the same workload; the comparison it made is not repeated here.

## What is left

- A real tablet pass: the `WM_POINTER` source on a device, history from a driver, the eraser flags, hover over a widget,
  press-and-hold.
- Wet ink for translucent strokes (a union layer). Today a stroke below full opacity shows exact pixels only.
- The editor session's own publication of a cel in the parity save step (the container and codec are exercised, not the
  session's `@publishCel`).
- WinTab, macOS and Linux sources (designed in [input.md](input.md), not built); the pen-lab inspector as the developer
  tools' Input panel.
- The brush's single `sample` call is not bounded in memory: a gap of 200,000 px with a 2 px brush holds some 800,000 dabs
  in the worker before it returns (cancel and shutdown stop it within a curve step; the interface thread never sees it).
