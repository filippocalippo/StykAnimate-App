# Performance: measuring the app

How StykAnimate's speed is measured, explained and compared. One system answers three questions:

1. **How does it feel?** Scenarios a person does (open, play, drag a joint, scrub, save, export) run in the real app with
   real input, on documents from a small scene to 200,000 segments, on this machine and as lesser machines.
2. **Why?** Every scenario says where its time went: by thread of every process, by layer of the app, by function, by
   call into the engine, and by the kind of work the browser itself did.
3. **Did it change?** Two runs are compared scenario by scenario, and a difference counts only beyond the runs' own noise.

The live view of the same measurements, inside the running app, is the Developer panel ([DEVTOOLS.md](DEVTOOLS.md)).
Both read the same recorders through the same code, so a number in a report and a number in the panel mean the same.

```
npm run perf -- run                      the quick suite: about four minutes
npm run perf -- run standard             every scenario; `list` shows every suite
npm run perf -- run --scenario pose --workload stress --env software
npm run perf -- show                     the latest run on a page
npm run perf -- show pose.drag-joint     one scenario in full: metrics, frames, spans, attribution
npm run perf -- compare before           the latest run against the run labelled "before"
npm run perf -- report                   the run as one HTML page (artifacts/perf/runs/<label>/report.html)
npm run perf -- engine                   the engine by itself, in Node, in about a minute
npm run perf -- engine-compare before    the latest engine run against the one labelled "before"
npm run perf -- list                     scenarios, workloads, environments, suites, engine benchmarks
```

| The question | Ask |
| --- | --- |
| Did my change make something a person does slower or faster? | `run --label before`, the change, `run --label after`, `compare before after` |
| Why is this scenario slow? | `show <run> <scenario>`: the frames by phase, the spans, the calls into the engine, the layers and functions of every thread, the interface writes |
| What does an engine layer cost, and how does it grow with the scene? | `engine`, `engine --scale` ([perf/engine/README.md](../perf/engine/README.md)) |
| How does the app hold up without a graphics card, or on an old laptop? | `run machines` |
| What does a feature (pictures, effects, movieclips, a camera, text, shapes, a long timeline) cost? | `run features` |
| What is slow while I use the app, right now? | the Developer panel's Performance tab and its Record button ([DEVTOOLS.md](DEVTOOLS.md#panels)) |
| What should be improved first? | `report`: every grade on one page, what most needs work, each scenario with where its time went |

## The loop for a change

```
npm run perf -- run --label before          # on the code as it is
# … change the code; `npm run engine:build -- --names` after an engine change …
npm run perf -- run --label after
npm run perf -- compare before after        # what got better or worse beyond noise
npm run perf -- show after pose.drag-joint  # where the time goes now
```

Narrow the run to what the change touches (`--scenario`, `--workload`, `--env`): one scenario on one workload takes
about fifteen seconds. A run prints its summary and writes `artifacts/perf/runs/<label>/`. Exit code 1 means a
scenario failed or a launch did not complete; `compare --fail-on-worse` exits 1 when something got worse.

For an engine change the faster loop is `npm run perf -- engine` and `engine-compare`: no window, the same documents,
single-thread costs of each engine layer ([The engine tier](#the-engine-tier)).

### Suites

A suite (`perf/suites.mjs`) is sized by how long its answer is worth waiting for, so it is made of parts: every
scenario on one scene, the core scenarios on the others. The core scenarios are what a person does most, one or two
from each area (`CORE` in that file): open, play, step, scrub, pan, zoom, drag a joint, move a figure, undo, select,
move many, drag an inspector value, a brush stroke, save.

| Suite | Covers | Takes about |
| --- | --- | --- |
| `quick` (the default) | the core scenarios on the small and the large scene, on the graphics card | 4 minutes |
| `standard` | every scenario on the busy scene, the core scenarios on the small and the stress scene | 15 minutes |
| `machines` | the core scenarios on a small scene as each desktop environment, and on the busy scene with no graphics card | 10 minutes |
| `features` | the busy scene plain and with each heavier feature, and a long animation | 10 minutes |
| `drawing` | painting on a drawing layer, with and without a graphics card | 4 minutes |
| `full` | all of the above and the core scenarios in Chrome | 50 minutes |

`--env`, `--workload` and `--scenario` replace the suite's parts with one of their own; what they do not name comes
from the suite's first part. A scenario word is an id or the start of one (`pose`, `timeline.scrub`); an exact id
names only that scenario. A suite that grows past its minutes loses scenarios to a longer one: the short ones are
what keeps measuring a habit.

**Engine function names.** A profile can only name engine functions when the WebAssembly build kept its names:
`node scripts/engine-build.mjs --names` (the code is the same; the file is about 2 MB larger). Without it the timed
numbers are just as valid, and engine time shows as `wasm-function[1234]` under "Engine: other".

**A quiet machine.** Other work on the machine takes time from the app. A run measures the processor's load before
each launch and says so in its summary when it is over 20%; treat such a run's numbers as slower and noisier than the
truth, and compare only runs taken under similar conditions.

## How a run works

`perf/cli.mjs` is the entry; `perf/lib/run.mjs` the runner.

- **One launch per pair of environment and workload.** The runner starts this checkout's app in a developer launch
  (`perf/lib/app.mjs`): scratch data and library folders that the run deletes, a window off-screen that never takes
  focus. It never attaches to an app a person is using and never reads their settings, library or recovery files.
- **The workload's document opens** (the `file.open` scenario, cold), then every scenario runs in that app. Before
  each one the app is put to rest: nothing playing, nothing covering the stage, the first frame, nothing selected, the
  scene fitted.
- **Timed passes, then one profiled pass.** The timed passes run with only the app's own recorders, which cost a few
  microseconds a frame: their median is the scenario's number, their spread its noise. Then one more pass runs with
  the sampling profiler on every thread and the browser's trace (`perf/lib/probes.mjs`): it explains the number, and
  its own timings are discarded because its instruments slow what they watch. An operation that is over in
  milliseconds repeats in the profiled pass until a second and a half has been watched.
- **Input is real input**, sent through the inspector protocol (`perf/lib/input.mjs`): the page receives trusted
  pointer, wheel and key events, and nothing touches the system's mouse or keyboard. Gestures run on a clock: a drag
  lasts 1.5 s however slow the app is, as a hand does not wait for the app, and where the app cannot keep up the
  browser merges the moves it could not deliver, as it does with a real mouse. So a run takes the same time on every
  machine, and a slow app shows as fewer, later frames.
- **Startup** is the launch itself: measured apart, three fresh launches per environment, on a bundle built from this
  checkout as a packaged app starts (`perf/lib/startup.mjs`; [APP-START.md](APP-START.md)), with the app's own steps as
  phases. Every other scenario runs from the sources, where a profile can name the module a function is in.

### How a run reaches the app

Three connections (`perf/lib/app.mjs`):

| Connection | Carries |
| --- | --- |
| The inspector protocol, on the port a developer launch opens (`perf/lib/inspector.mjs`) | input; a profiler session per thread (the page, each engine worker, the export and codec workers); the browser's trace of every process; processor slowdown |
| The developer tools' control channel in the page (`App.request`; [DEVTOOLS.md](DEVTOOLS.md#control-channel)) | the app's own operations (seek, select, undo, settle), captures, the environment the page runs as |
| The control channel's pipe, on the desktop (`App.shell`) | opening a file as the shell does, the processes' memory and processor time |

In the `browser` environment the same code drives headless Chrome on this checkout's sources, with the developer
tools' early script injected before the page's own.

## What is measured

The recorders are the developer tools' (`src/devtools/`): the app is instrumented once, and the panel, the control
channel and the runner all read the same thing.

**Frames** (`src/devtools/early.js`, `frames.mjs`). While something watches, every display frame is recorded with what
the interface thread spent on it, by phase:

| Phase | What |
| --- | --- |
| `handlers` | input handlers that ran during the frame (a drag's pointer moves, a wheel, a key), timed where the browser calls them, so every listener is covered |
| `script` | animation-frame callbacks: the app's paint of the scene and its pass of interface updates |
| `render` | the browser's own style, layout and paint after them, measured to the first task after the frame (an upper estimate) |

A frame is on time while this work stays under the display's period, which a run measures while the app rests.

**The frame time a person sees** (`frame.felt`) weights each frame by how long it stayed on screen. Three freezes of
half a second among a hundred smooth frames are most of what the person looked at; a percentile of the frame count
hides them, this does not. It is what gestures are graded on.

**Input delay** (`input.p95`): from an input event to the end of the frame that followed its handler. For a drag or a
pan that is the whole wait. Where the picture is made off the interface thread and arrives frames later (a seek in a
dense scene), a scenario reads the capture's `shown` series instead: when the stage drew which tick, against when
each input happened (`perf/lib/latency.mjs`).

**Spans**: named stretches of the interface thread, nested: every input handler (`on pointermove (canvas)`), every
animation-frame callback, the `paint`, the `stage draw`, every `interface update` by surface, every
`edit session call` by method, the app's start as phases. [DEVTOOLS.md](DEVTOOLS.md) lists where each is recorded.

**The engine boundary** (`src/devtools/boundary.mjs`): every call the interface thread makes into WebAssembly, by
method: how often, how long in all, the worst. It answers "what did the interface ask of the engine".

**The engine's threads**: frames prepared and the mean time of one.

**The profiled pass** (`perf/lib/attribution.mjs`):

- per thread, processor time by **layer** (below), by engine module, and the heaviest functions with their callers;
- by the browser's own trace: busy and processor time of **every thread of every process** (the page, the workers,
  the graphics process, the browser); what the page's interface thread did by kind (script, style, layout, paint,
  garbage collection); what the graphics process spent on (rasterizing the interface, the stage's commands,
  presenting); how often the browser recalculated style, laid out, painted and rasterized;
- processor time by process.

**Memory**: after every scenario, the memory of the page, the graphics process and the browser process, the engine's
memory in use, its peak and what it has reserved, the JavaScript heap and the GPU memory the stage holds (its buffers, render targets and picture pages).

### Layers

`perf/lib/layers.mjs` is the one table that says which part of the app a function belongs to: a JavaScript module by
its path, a WebAssembly function by its Rust crate, V8's own markers. Groups: `interface` (the timeline, the canvas
overlay and gestures, the inspector, the shell, the editor's read view, the engine's interface modules, the binding
glue, …), `engine` (editing commands, evaluation and draw lists, the GPU renderer, the CPU rasterizer, the document
store, formats, the scheduler, allocation and copying, JSON, …), `browser` (garbage collection, the browser's native
work under a call, built-ins) and `tools` (the measurement itself). A thread parked waiting for work counts as idle.
A new module that belongs to an existing layer needs a row there only when its name does not already match.

### Metrics and grades

A metric has a unit and a direction (`perf/lib/metrics.mjs`). A scenario is graded good, fair, poor or bad on one or
more of its metrics; its grade is the worst. The limits and the rule live once, in `src/devtools/grades.mjs`: the
runner and the Developer panel's Record summary both grade there, so a gesture recorded by hand and the same gesture in
a run get the same word. The limits are fixed and come from how people perceive delay, never from what the app does
today:

| Judged | Good | Fair | Poor | Why |
| --- | --- | --- | --- | --- |
| The frame time seen, in a gesture | ≤ 16.7 ms | ≤ 33.3 ms | ≤ 100 ms | 60 frames a second is smooth, 30 usable, under 10 a slideshow |
| Input delay, in a gesture | ≤ 34 ms | ≤ 67 ms | ≤ 150 ms | two frames at 60 Hz is tight; beyond 150 ms the picture swims behind the hand |
| One action (a click, a key, an undo) | ≤ 100 ms | ≤ 300 ms | ≤ 1 s | 100 ms feels instant; a second keeps the thought |

A scenario with its own tolerance states it (`judge`): opening a document may take a second, playback is judged on
the share of the animation's frame rate that reached the screen.

## Environments

A development machine with a recent graphics card says little about the computers many people animate on
(`perf/environments.mjs`):

| Environment | The app runs as |
| --- | --- |
| `gpu` | this machine: WebGPU on the graphics card |
| `webgl` | a graphics card whose driver Chromium does not trust for WebGPU: the engine draws with WebGL2 |
| `software` | no usable graphics card (a virtual machine, a remote desktop, a blocked driver): Chromium composites and draws WebGL on the processor |
| `low-end` | an old laptop: no graphics card, four processor threads four times slower, 4 GB (two engine threads, small caches, 1 GiB of engine memory) |
| `browser` | the web build's host: headless Chrome on the graphics card |

An environment sets Chromium switches, a processor slowdown for the page's threads, and what the page reports and
starts with (`STYK_DEVTOOLS_ENVIRONMENT`, read only by a developer launch: the processor count and memory the app
sizes its threads and caches by, and live parameters such as `engine.workers` and `engine.memoryMaximumMiB`).

**What an environment cannot do.** It cannot slow the graphics process or take real memory away. `software` and
`low-end` run the software rasterizer at this machine's processor speed: a real computer without a graphics card is
slower still. Read their numbers as a floor for that computer. With no WebGL at all the app cannot start
([ARCHITECTURE.md](ARCHITECTURE.md#the-stage-and-playback)); a run in such an environment ends with that message.

## Workloads

Generated from a seed (`perf/workloads.mjs`), so a run needs no file from outside the repository and two machines
measure the same document. Every figure moves on every frame, the worst honest case for evaluation and drawing.

| Workload | A frame draws | Frames |
| --- | --- | --- |
| `starter` | the document the app starts with: one figure | 10 |
| `small` | 12 figures, 240 segments | 121 |
| `medium` | 80 figures, 3,200 segments | 129 |
| `large` | 500 figures, 30,000 segments | 111 |
| `stress` | 2,000 figures, 200,000 segments: the scene the app must stay usable on | 101 |

Feature workloads (`perf/workload-features.mjs`) are the busy scene with one feature added, so the difference from
`medium` is that feature's cost: `sprites` (pictures on the limbs), `effects` (glow, shadow, outline, tint and blur),
`movieclips` (the figures inside clips two deep), `camera` (a camera that pans, zooms and turns on every frame), `text`
(a label on every figure), `shapes` (half-transparent filled polygons), and `long` (the small scene over 4,001 frames:
what a long timeline costs). `npm run perf -- list` describes each.

## Scenarios

A scenario is one thing a person does, with real input, verified to have had its effect
([perf/scenarios/README.md](../perf/scenarios/README.md) is the contract; `npm run perf -- list` names all of them).
One file per area under `perf/scenarios/`:

| Area | Scenarios |
| --- | --- |
| Files and projects | open, import a Pivot file, save as, save again, the recovery copy, new, close, a second project, switching |
| Playback | play; play with the effects preview off; play without the camera |
| Timeline | step, jump, scrub, zoom, scroll, add, duplicate and remove a frame, play with a figure selected |
| Canvas | pan, zoom, move the pointer over the scene |
| Posing and history | drag a joint, move a figure, undo and redo |
| Selection | click, a selection rectangle, move many figures, select all |
| Interface | drag an inspector value, switch workspace, fold and close a panel, focus mode, a panel tab, a divider, the window's size, onion skins, the main menu, the command palette |
| Drawing | a brush stroke, a large soft brush, the eraser, a stroke on a painted cel, fill, undo, lasso and move |
| Export | PNG, GIF, WebM, MP4, Pivot |

A scenario is a `gesture` (continuous input on a clock, judged on its frames and its input delay) or an `action`
(one thing that ends, judged on how long the person waits).

## Results

`artifacts/perf/runs/<label>/` (git-ignored):

- `result.json` (schema `styk-perf/1`): the machine (no name, user or path), the build, and per pair every scenario
  with its metrics as median and spread, its criteria and grade, the first pass's frames, spans and engine calls, and
  the profiled pass's attribution; the memory checkpoints; what failed and why;
- `summary.txt`: what `show` prints;
- `report.html`: after `npm run perf -- report`;
- `raw/`, with `--raw`: per scenario the app's own trace and the browser's (both open at ui.perfetto.dev) and a
  `.cpuprofile` per thread (Chrome's developer tools open them).

### Comparing two runs

`compare` (`perf/lib/compare.mjs`) pairs the scenarios both runs measured on the same environment and workload. A
metric changed only when the difference is larger than twice the wider of the two runs' spreads between passes, and
never less than five percent or the smallest step the unit resolves. A run compared with itself says "same"
everywhere. Raising a threshold to make a comparison pass hides which of the code and the expectation is wrong: when
a result is noisy, take more passes (`--passes`) on a quieter machine.

### The report

`npm run perf -- report [run …] [--engine <engine run>] [--notes <file.md>] [--out <file.html>]` writes one page that
needs nothing else to open (`perf/report/`): every scenario's grade on every pair of environment and workload, what
most needs work, startup by phase, memory, and each scenario in full (its metrics with their spread, its frames, where
the time went by thread, layer and function, the calls into the engine, the interface writes). Several runs go on one
page: the first is the baseline the others are compared with. `--engine` adds an engine run (capacity, cost per
thousand segments, how each cost grows); `--notes` puts a Markdown file of findings at the top, for the person who
decides what to improve. The same data as text, for an agent or a terminal, is `show`.

`perf/report/model.mjs` shapes the data once (it is tested without a browser); the page's modules
(`perf/report/page/`) only draw it, and `perf/report/build.mjs` puts them and the data into the one file.

## The engine tier

`npm run perf -- engine` runs the engine's own bytes in Node, on the same generated documents, one layer at a time and
on one thread: opening, starting a session, building a frame, preparing playback, the interface's reads after a seek,
a pose and a move with undo and redo, saving, the Pivot export, the CPU rasterizer. It takes about a minute, needs no
window and no graphics card, and its numbers are steadier than the app's. `engine --scale` runs sizes from 1,000 to
200,000 segments and reports how each cost grows and how large a scene one thread carries within a frame.
`engine-compare` compares two runs after bringing both to one machine speed.
[perf/engine/README.md](../perf/engine/README.md) is its contract. Results go to `artifacts/perf/engine/<label>/`.

## Adding to it

- **A scenario**: [perf/scenarios/README.md](../perf/scenarios/README.md) is the contract. A file per area; real
  input; a gesture on a clock; the effect verified; the app left as it was. Add it to a suite only when the suite
  still fits its minutes.
- **An engine benchmark**: an object in `perf/engine/benchmarks.mjs` ([perf/engine/README.md](../perf/engine/README.md)).
- **A workload**: a row in `perf/workloads.mjs` (a feature workload in `perf/workload-features.mjs`), generated and
  deterministic.
- **An environment**: a row in `perf/environments.mjs`, with what it cannot imitate said in its description.
- **A span**: at the layer that owns the work, through `src/trace.mjs` ([DEVTOOLS.md](DEVTOOLS.md)); span arguments
  are built only when tracing, so the shipping build pays a null check.
- **A layer**: a row in `perf/lib/layers.mjs`.

`tests/perf.test.mjs` holds the pure parts (layers, attribution, grades, comparison, latency, suites);
`tests/perf-workloads.test.mjs` that every workload is the document it says; `tests/perf-scenarios-interface.test.mjs`
and `tests/perf-scenarios-files.test.mjs` the scenarios' own helpers; `tests/perf-report.test.mjs` the report's model;
`tests/perf-engine.test.mjs` the engine tier's definitions, scaling and comparison; `tests/devtools.test.mjs` the
recorders' reads and that the shipping build carries none of the tools. The runner itself needs a window and is
verified by running it.

## What it cannot tell

- **Time on the graphics card itself.** The graphics process's processor time is measured; how long the card takes to
  execute what it was sent is not. With a capable card it is small; with software rendering the work is processor
  time in the graphics process, which is measured.
- **The last step to the eye.** Input delay ends when the interface thread has finished the frame; composition and
  the display add about one more frame on every machine alike.
- **A real small machine.** See Environments.
- **Other platforms' drivers.** A number from one graphics card says little about another.
