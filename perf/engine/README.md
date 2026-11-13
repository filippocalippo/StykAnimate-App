# The engine tier

`npm run perf -- run` measures the whole app: a window, a graphics process, real input. It answers "how does it feel",
takes minutes, and its numbers move with everything else on the machine. The engine tier is the fast loop for working on
the engine itself (`engine/`, built into `src/engine/pkg/`): the shipped WebAssembly bytes run in Node, on the generated
documents of `perf/workloads.mjs`, without a window or a graphics card, one layer of the engine at a time.

```
npm run perf -- engine [--workload small,medium,large,stress] [--scale] [--benchmark open,frame] [--rounds 5] [--label <name>]
npm run perf -- engine-compare <base> [head] [--all] [--fail-on-worse]
npm run perf -- list                      the benchmarks, with the layer each exercises
```

`engine` writes `artifacts/perf/engine/<label>/` (`result.json`, `summary.txt`, schema `styk-perf-engine/1`) and prints
the summary. `--scale` runs the scaling sizes instead of the workloads (both with `--workload`). `--benchmark` takes ids or
layers (`edit` is both drags). `engine-compare` says what changed between two runs beyond their own noise, with the rule of
`compare` (`perf/lib/compare.mjs`); the head defaults to the latest run.

**Every number is one thread's.** Node runs the engine without its worker threads: what the engine queues runs on the
calling thread when asked (`EngineHandle.step`). The app spreads playback, opening and saving over its workers, so read a
rate here as what each worker adds, and a time as what one thread spends.

## The benchmarks

| Id | Layer | What it measures |
| --- | --- | --- |
| `open` | open | The editor loads the document's JSON: the engine's open with its phases (decode, prepare, views: `OpenedDocument` timings), then the interface's read view and state. |
| `session` | edit session | The engine owner starts the session from the opening (`start_session`) and publishes it (`activate`). |
| `frame` | evaluate and draw list | `EngineHandle.frame_info`: a frame evaluated and its draw list built on this thread. Cold is the first after a publication; warm ones follow, at a keyframe and between two. |
| `playback` | evaluate and draw list | Frames a second one thread prepares from the queue playback fills (`request`, then `step`), and the frame cache each takes. |
| `reads` | interface reads | What the interface reads after a seek (`editor.evaluatedFrame`, `editor.geometry`, `src/engine/engine-shown.mjs`), whole and inside the engine. |
| `edit.pose` | edit session | A pose drag through the owner: begin, 60 steps, commit, undo, redo; each call inside the engine and whole, the answer's size, the geometry read after a step. |
| `edit.move` | edit session | The same for moving a figure (`beginTranslationDrag`, `moveSelection` from the start). |
| `save` | files | `save_project` through `makeProjectFile`: the `.styk` file with its phases (lift, check, sections, assemble) and its size. |
| `export` | files | `export_document` as the Pivot export asks (`output: 'codec'`), per exported frame. |
| `raster` | CPU rasterizer | `ExportRenderer.create_cpu`: a frame prepared, drawn tile by tile and read out, at 1280×720 and 1920×1080. |

Every benchmark also reports `memory.peak`: the most engine memory a round added above what the engine held when it
began (`EngineHandle.memory()`, `reset_memory_peak()`). Each workload reports what the engine holds for it once open.

Edits, reads, saves and exports go through the app's own code (`src/editor.mjs`, `src/engine/engine-owner.mjs`,
`src/engine/engine-document-export.mjs`), so they send what the app sends (the view, the lazy tables the read view holds,
the request) and measure what a person waits for; a call's time inside the engine comes from the generated classes'
methods, wrapped by the runner (`recorder` in `run.mjs`).

Left out, because Node has no graphics device: the stage (`Stage`, every GPU draw), the GPU export renderer, previews and
thumbnails drawn on the graphics card. `EditSession.from_document` is not measured: a session made from JSON cannot
publish (`activate` refuses), and the app starts every session from the document's opening. The codec that turns the
export's request into a `.piv` file is a module of its own, not part of the engine.

## How a run measures

- **Rounds interleaved.** Every workload is opened in an editor the engine owns, and every benchmark set up and warmed
  up on it; then round 1 of every benchmark of every workload runs, then round 2, … A burst of other work on the machine
  falls on every workload's rounds alike and widens their spread, instead of moving one workload's median (run one size
  after another, a scaling run read such a burst as a bend in the curve).
- **Warm-up.** A benchmark repeats until it has measured 200 ms (at least once, at most 1.5 s with its preparation): V8
  compiles the engine's WebAssembly and the interface's JavaScript for speed only after they have run, and a first run is
  up to three times slower.
- **A round is a batch.** A round repeats its benchmark until it has measured about 25 ms, for calls of a fraction of a
  millisecond, and reports the mean of its repetitions; a drag's step is the mean of its 60 steps. The metric is the median
  of the rounds with their spread (`src/devtools/stats.mjs`), and the runs' own rounds are kept in `result.json`.
- **A known state.** Before every round the workload's document is published afresh and the engine's queue run, so
  nothing a round before prepared is still held. Each benchmark's `prepare` puts the engine in the state it needs and says
  why (a new publication for a cold frame, an editor that has just loaded the document for a session, an undo after a drag).
- **Work is cut, not rounds.** Playback prepares about a million segments a repetition (4 to 48 frames); a Pivot export of
  more than a million segment-frames exports the same figures cut to as many ticks; a drag reads the geometry after every
  fifth step. The default run (four workloads, five rounds) takes about 40 s of processor time, `--scale` about 35 s.
- **The machine.** A run records how busy the processor was before and after it (`backgroundLoad`) and how much
  processor time it used: a run that took far longer than its processor time waited for other programs, and its numbers
  are slower and noisier for it.

## Scaling and capacity

`--scale` runs `open`, `frame` and `edit.pose` on `scaled()` documents of 1,000 to 200,000 segments a frame (figures of 50
segments, 41 frames). For each metric marked `scale` the summary gives the median at each size, the slope (milliseconds
per thousand segments), whether it grows linearly (the exponent of the power fitted from 10,000 segments up, linear from
0.85 to 1.15), and the size where it crosses 16.7 ms and 33.3 ms (read on the line between the two sizes around it).

The capacity figures come first in the summary: how many segments one thread can build a frame of within one frame at 60
and at 30 frames a second, for a frame between keyframes (what playback builds most), the first frame after a publication
(a seek right after an edit) and a pose step (the engine and the interface adopting its answer). A capacity is compared
between runs with the spread of the crossings of each round's values.

## Adding a benchmark

A benchmark is an object in `benchmarks.mjs` (the header there is its contract): an id, the layer it exercises, metrics
defined like a scenario's (`perf/lib/metrics.mjs`; `floor` is the least change that counts, `scale` puts it in a scaling
run), `headline` for the summary, and `setup`, `prepare`, `run`, `reset`, `teardown`. Measure with `performance.now()` or
`context.measure(work)` (whole time, time inside the engine, answer sizes); put back in `reset` what `run` changed; never
rely on what another benchmark left. Add it to `BENCHMARKS`, and to `SCALING_BENCHMARKS` when it says something about
how a cost grows. `tests/perf-engine.test.mjs` checks the definitions.
