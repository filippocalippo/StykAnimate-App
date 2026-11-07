# Pen and tablet input: what was measured (spike S1, 2026-11-07)

The design is [input.md](input.md); this page is what the code did against its acceptance criteria. Every latency is
measured with the machine's display at **144 Hz (6.94 ms a frame), present mode Fifo** (iced's `AutoVsync`; the
compositor's `desired_maximum_frame_latency` is 1), release build with the `devtools` feature, an RTX 4070 SUPER and a
Ryzen 5 5500, on a machine other jobs were using: the measurements ran in a `probe` slot, which is not exclusive, so tails
are directional. Nothing here is a number from a physical tablet: none was used.

How to run it: `stykanimate --self-test standard|blocked|behaviour|stress[:seconds] --out <folder> --size 900x500
--inject-on-screen` in a `devtools` build with `STYK_BACKGROUND_WINDOW=1` set (the window is made all but invisible, topmost,
at the screen's corner, and nothing is injected unless it is the topmost window at nine points of its client area).
`--pen-lab` opens the lab by hand. It writes `samples.csv`, `frames.csv`, `inject.csv`, `report.txt` and `screenshot.png`.

## What a run injects

A synthetic pen (`InjectSyntheticPointerInput`) at 240 Hz for 5 s: two strokes of a sine across the pad, pressure ramping
0.1 to 1, tilt sweeping −60 to 60 degrees, a barrel pulse in the middle of the first stroke, eight hover reports before
each press. 1200 reports of which 1184 are in contact. (The system's synthetic pen cannot carry the eraser end; see
[input.md](input.md) section 6. The second stroke is injected with the tip.)

## Results by criterion

| | Criterion | Result |
| --- | --- | --- |
| A1 | Fields: tool, barrel, phase exact; tilt within 1 degree; pressure within 1/1024 | **Pass**, 6 runs: 0 mismatches, tilt error 0, pressure error 0, position error 0.03 px. The eraser end is not injectable; `pen_sample` and `StrokeInput` carry it and are unit tested |
| A2 | 1200 ± 2 samples, no duplicates, monotonic, median gap 4.17 ± 0.3 ms | **Pass on the samples in contact**: 1184 of 1184 in all 6 runs, monotonic, no duplicates, median gap 4.000 ms. The total of all samples was 1197, 1200, 1201 in the three standard runs (hover reports are partly the system's own, and an injected hover report repeats the one before it to the millisecond and the pixel, so it cannot be told from a re-delivery). The gap is 4.000 ms and not 4.17 because injected reports are stamped to the millisecond |
| A2 | Interface thread blocked 50 ms twenty times: every sample arrives, history flagged, in order | **Pass**, 3 runs: 1184 of 1184 contact samples, 540, 573 and 583 of them history entries (against 440 to 473 unblocked), monotonic, no duplicates |
| A3 | Same original events, native against today's app | **Pass**: see "Parity" |
| A4 | Latency | see "Latency"; no gate is claimed |
| A5 | Interface thread never blocks (D7) | **Partly.** Dab generation and rasterisation run on the worker and `update` queues in microseconds (one run: 1.9 µs to queue the stress input). Slices were not always under 4 ms: see "Slices" |
| A6 | Stroke logic | 20 unit tests of `StrokeInput` plus the parity run |
| A7 | Behaviour | **Pass**, 2 runs of 5 checks (below) |
| A8 | Queue saturation, release, a new stroke | **Pass** (unit tests: `after_saturation_and_release_a_new_stroke_is_whole`, `terminal_events_survive_even_when_the_reserve_is_gone`) |
| A9 | Retirement: no gap, no double paint, delayed replies, partial uploads, cancel, stale | **Pass** as logic: `no_dab_is_ever_missing_or_painted_twice_whatever_the_delays` (200 random arrival patterns), the cancel and stale tests, and the worker's tests. Not checked as rendered pixels |
| A10 | A real tablet | **Not run** |

### A7, behaviour (2 of 2 runs each)

- A pen hovering over a toolkit button area raises its enter event (the promotion reaches iced).
- A barrel press while hovering over the pad opens the palette once.
- A finger alone draws once the setting is on (1 stroke, 12 to 13 touch samples); within 700 ms of the pen it does not
  (0 strokes, 12 to 13 touch samples delivered).
- A stationary 1.5 s pen press raises no context menu (0 `WM_CONTEXTMENU`) and makes one stroke. The run did not show that
  Windows would have raised one without the tablet-service property, so this does not prove the property is needed.
- No promoted mouse message became a stroke: 0 mouse strokes while 400 to 590 promoted messages passed to iced.

## Parity with today's app

`scripts/pen-parity-capture.mjs` drives today's app (Chrome, the web build served from this checkout, the DevTools Input
domain for pen events and synthetic pointer events for the interrupted stroke) and records, per scenario, the brush the
controller posted to its stroke worker, the camera and the cel's pixel matrix, **the events the page received** (Chrome
rounds positions and pressure to single precision and stamps its own times, so the script's own numbers are not the events),
and the SHA-256 of every tile after the stroke, after undo, after redo and after a save and reopen through the document
exporter. `engine/crates/styk-core/tests/pen_parity.rs` replays the received events through `StrokeInput`, `Mapping` and the
drawing worker and compares the tiles.

| Scenario | Tiles | Commit | Undo | Redo | Save and reopen |
| --- | --- | --- | --- | --- | --- |
| plain pen stroke, pressure and tilt | 43 | identical | identical | identical | identical |
| view zoomed 2.5x and panned | 18 | identical | identical | identical | identical |
| symmetry mirror across the vertical axis | 57 | identical | identical | identical | identical |
| flat tip turning with the pen's tilt, zoomed 1.7x | 22 | identical | identical | identical | identical |
| interrupted (capture lost half way): keeps its ink | 21 | identical | identical | identical | identical |
| Escape half way: discarded | 0 | cel unchanged | | | |

Old-versus-old baseline: the capture is made twice for each scenario; the two runs of today's app agree on every tile hash
at every stage and differ only in the events' timestamps. The native tiles match the first run's, byte for byte.

The test fails when the native path is wrong: with the tilt's x sign flipped, all 22 tiles of the tilt scenario differ; with
positions taken as the script sent them (double precision) instead of as Chrome delivered them, 6 of 43 tiles differed
until the capture recorded the delivered events. Two limits: the cel is not moved or rotated as an object, only viewed at
other zooms and mirrored (a transformed cel's pose enters through the same pixel matrix, which the zoomed scenarios and
the unit tests cover); and the capture needs Chrome and the built app, so the test passes without checking anything
unless `STYK_PEN_PARITY` names a capture.

## Latency (injection to the end of the `prepare` of the first frame showing the sample)

This is the nearest observable point before `queue.submit`; wgpu has no present-timing API, so nothing here says when a pixel
reached the panel, and no display-latency gate is claimed (`DwmGetCompositionTimingInfo` cannot say which frame held a sample).
Percentiles are over the 1184 contact samples of a 5 s run; "fr" is frames of 6.94 ms.

| Run | Queue read p50 | Preview p50 / p95 / p99 / max (ms) | Exact tiles p50 / p95 / p99 / max (ms) |
| --- | --- | --- | --- |
| standard 1 | 3.94 | 8.79 / 12.44 / 27.21 / 80.44 | 8.80 / 13.98 / 30.13 / 83.36 |
| standard 2 | 4.06 | 8.78 / 12.39 / 18.74 / 33.46 | 8.84 / 13.12 / 21.36 / 38.94 |
| standard 3 | 3.87 | 8.59 / 11.46 / 11.87 / 18.00 | 8.60 / 11.46 / 12.03 / 20.42 |

The median is 1.24 to 1.27 frames for both: the preview and the exact tiles show in the same frame, because the worker
returns the tiles of a 12 px round brush before the frame that shows the sample is prepared (the medians differ by
0.01 to 0.06 ms). The p99 and max
of runs 1 and 2 are scheduling: the same runs show frame gaps over twice the period (12, 11) and update or prepare slices of
several milliseconds, on a machine other jobs were using; run 3 had 3 such gaps and no slice over 0.8 ms. The cause of the
tail is not measured, only the symptom.

The browser row: `tests/drawing-latency.browser.mjs`, scenario `blank-small` (size 8, hard, 240 Hz, 4 s, CDP mouse events on the
exact scene), 3 runs: p50 36.7 to 49.0 ms, p95 57.0 to 71.2 ms, p99 65.7 to 149.5 ms. It is **not** the same workload: its
input is CDP mouse input (not a pen), its probe reads the scene after the app renders (it does not observe the wet-ink
canvas, so the review's preview latency has no browser number here), and its clock starts at the browser's event timestamp,
not at injection. It says only that the exact-pixel path of today's app is several times slower than the native exact
path on this machine.

## Slices (A5)

`update` and `prepare` are measured each frame (microseconds, max of the run):

| Run | update max | prepare max |
| --- | --- | --- |
| standard 1 / 2 / 3 | 259 / 5808 / 260 | 8222 / 4485 / 727 |
| blocked 1 / 2 / 3 | 261 / 404 / 356 | 1335 / 1191 / 795 |
| stress 1 / 2 | 1382 / 352 | 7518 / 3731 |

The criterion was 4 ms. Four of the eight standard and stress runs exceeded it in `prepare` and one in `update`. In an
earlier profiling run a section with no work in it (an empty loop) took 147 ms, so some of these are the thread being
descheduled; that is a hypothesis for the others, not a measurement.

The stress run (a 2 px brush, a coordinate gap of 200,000 pixels, deep zoom, a mirror, one stroke of about 800,000 dabs
and one at 64x) finished both strokes with the interface thread only queuing (the worker's longest dab generation 3.5 and
10 ms, longest raster 11.2 and 9.2 ms in the two runs), but **the criterion "no frame skipped" fails**: the worst frame was 31
and 27 ms against a 6.9 ms median over about 450 frames. The cause is not isolated. Known contributors: the atlas holds 1024
tiles and the stroke touches about 3,000 (`atlas full` counts uploads refused: the pad does not evict or page, which is the
stage's residency job), and the number of batches (about 100 per stroke) each bring a reply.

## What is left

- A real tablet pass, and the eraser end through a driver.
- Wet ink for translucent strokes (a union layer), and rendered checks (pixels) of the retirement rule.
- `prepare` and frame-gap tails under load: find what the long frames are, then bound it (the per-frame upload budget is
  96 tiles or 3 ms; it was not shown to be the cause).
- Tile residency for the stage (the pad's atlas never evicts).
- WinTab, macOS and Linux sources (designed in [input.md](input.md), not built), and `xtask pen-inject` (the injection runs
  from the lab's self-test, which needs the window it injects into).
- Two runs in which the injected pen input went to a window other than the test window (it was covered; nothing was
  checked then): that is why the self-test now injects only after finding the test window topmost over its whole client
  area. If it hit a window of yours, it was a hover and a pen stroke near the bottom-right corner.
