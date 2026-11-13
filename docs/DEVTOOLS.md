# Developer tools

Profiling and debugging tools for the people and agents working on StykAnimate. They exist **only in a developer
launch** of a source checkout; a packaged app carries no line of them, no channel that reaches them and no pipe, and
checks prove it (`scripts/check-devtools-shipping.mjs`, `tests/devtools.test.mjs`).

## Two launches

| | Packaged app, and `npm start` | Developer launch: `npm run dev` |
|---|---|---|
| How | `electron .` | `electron . --styk-developer`, or `STYK_DEVELOPER=1`; a packaged app ignores both |
| `desktop/devtools.cjs` | not packaged, never required | required by `desktop/main.cjs` |
| Browser inspector | the View menu's item, in source checkouts only | also F12 and Ctrl+Shift+I |
| Early script `src/devtools/early.js` | not run | run by the preload script before any page script |
| `src/devtools/` web files | not packaged (`isDeveloperPath`, the build's file lists) | loaded on demand |
| Named pipe `\\.\pipe\stykanimate-dev-<pid>` (a socket file in the temp folder outside Windows) | absent | served, current user only |
| Inspector protocol port | absent | with `STYK_REMOTE_DEBUGGING_PORT=<port>` only |

The preload script's part is a few lines: with the launch argument it asks the main process for the early script and
the bridge's name, runs the script in the page (`webFrame.executeJavaScript`, before the page's first script) and
exposes the bridge the control channel answers through. Without the argument none of it runs.

The interface code is the same in both. Three small hooks are shipping code, and each is inert without a developer
launch:
- **`src/trace.mjs`, the one instrumentation layer.** Call sites build span arguments only behind `if (tracing)` or an
  open span, and live parameters' specs are module constants, so the shipping build pays a null check and allocates
  nothing (`tests/devtools.test.mjs` scans for it). `traceBegin/traceEnd/traceComplete/traceInstant/traceCounter` and
  `tuned(name, default, spec)`. Its sink is `globalThis.__stykTrace`, which only the early script defines: in the
  shipping build each call is a null check and `tuned` returns its default.
- **`src/devtools-gate.mjs`.** It loads `src/devtools/devtools.mjs` by URL when the early script marked the page
  (`__STYK_DEVTOOLS__`). The URL is built at run time, so no bundler follows it: the tools are never in a bundle.
- **`window.styk.requestRender`.** It draws the scene again on the next frame; the control channel waits on it.

Instrumented once, at the owning layer:
- the frame loop's `paint` (src/app.mjs);
- `stage draw` and `stage draw prepared` (src/engine/engine-stage.mjs), with the geometry and submit times;
- every edit session call, by method (src/engine/engine-owner.mjs `sessionCall`);
- `engine load` (src/engine/engine.mjs).

The browser itself reports long tasks and input-to-paint latency per event.

Live parameters are registered where they are used:
- `playback.lookaheadFrames`, the frames prepared ahead of the playhead;
- `engine.workers`, the preparation threads (applies on reload);
- `engine.atlasPages`, the sprite pages kept resident;
- `devtools.lateFrameMs`, the late-frame threshold.

## The early script

`src/devtools/early.js` is a classic script the developer launch's preload script runs in the page before its first script, so it
runs before the engine starts. With the tools closed it keeps only small bounded rings:
- **spans:** 65,536 entries in typed arrays; names interned, at most 65,535;
- **logs:** 4,096 rows. It captures the console (a `[module]` prefix names the module), uncaught errors and rejections;
- **workers:** at most 512 rows, each with its messages in and out and its errors;
- **long tasks and slow inputs** (input over 16 ms), from the browser's own observers;
- **live parameters,** with the values kept in `localStorage` for this developer profile.

Display frames are measured only while the panel, the overlay or a capture watches, so the tools cost nothing when closed.

## Panels

One panel, marked DEVELOPER, opened with **Ctrl+Shift+D**, and the performance overlay, **Ctrl+Shift+O**. Both are
watchers (`runtime.watch` in `src/devtools/devtools.mjs`): while either is on screen the frame recorder, the engine
boundary meter and the sampler run (four samples a second); closed, collapsed or parked, nothing samples, ticks or
redraws, and no `display frame` span enters the ring (`tests/devtools.browser.mjs` checks it). Every refresh of the
panel is a span, `devtools panel`, and every drawing of the overlay one, `devtools overlay`: the tools' own cost shows
in what they measure. The panel's text is developer-only English, outside the localized catalogue.

The panel computes no measurement of its own. Its numbers are the runtime's summary of a stretch
(`runtime.summarize`, which is `analyze` in `src/devtools/capture.mjs`: the summary the control channel's
`trace.stop` returns and the profiling runner stores), the sampler's reads and the boundary meter's. A gesture recorded
in the panel and the same gesture in a profiling run report the same numbers and the same grade
(`src/devtools/grades.mjs`, which `perf/lib/metrics.mjs` re-exports).

Six tabs; the first opens by default:
- **Performance.** Live, what the interface thread, the engine and memory are doing now:
  - *Frames*: the last three seconds of display frames as a chart. Each column is a frame: the pale bar behind is
    how long it stayed on screen, in front the interface thread's work stacked by phase (input handlers, script,
    rendering). A dashed line marks the display's period, a dotted one the late limit (one and a half periods); a late
    frame's column turns the late colour and gets a triangle over it. With more frames than columns, each column is
    the slowest of its frames. Pointing at a column shows that frame's numbers and the spans that began in it; a click
    keeps it.
  - *Now* (last two seconds): frames per second, the frame time a person sees (`felt`, graded), late frames,
    interface work per frame (p95, share of the period, mean), input delay (p95 graded, p50), paints per second.
  - *Where the interface's time goes*: the heaviest span groups (interface updates by surface, input handlers by
    target, paint, stage draw, the tools' own), milliseconds per second with a bar, count per second, p95 and worst.
    The order holds still while values move: a row passes the one above only when it weighs a quarter more.
  - *Calls into the engine*: the heaviest calls of the last two seconds (calls, total, worst). The tools' own reads of
    the engine are not counted (`unmetered` in `src/devtools/boundary.mjs`).
  - *Engine*: frames its threads prepared per second and the time of one, frames prepared on the interface thread for
    want of a ready one, pictures pending, playback's ready frames, the frame cache, the threads.
  - *Memory*: the JavaScript heap, the engine's memory in use and reserved (its linear memory, which never shrinks),
    the stage's GPU memory, each with its last minute as a line.

  **Record** starts a capture (the control channel's and the runner's kind) and **Stop** ends it; the tab then shows
  exactly that stretch, frozen, with its grade against the limits (the frame time seen against 16.7 / 33.3 / 100 ms
  and the input delay p95 against 34 / 67 / 150 ms; the worse decides, as in a run). **Last 5 s** holds what the rings
  kept of the last five seconds, after a hitch. **Save** downloads the summary as JSON (with its grade); **Perfetto**
  exports the spans as Chrome trace JSON for ui.perfetto.dev. **Live** lets the held stretch go.
- **Profiler.** The held stretch (the same Record, Last 5 s and exports) on a timeline: a lane per thread, in this
  order: `interface` (the app's spans, nested), `display` (a late frame taller and in the late colour), `input` (the
  browser's slow inputs), `long tasks`, `phases` (the app's start), `tasks`, then any other. The wheel zooms; a click
  selects a span and shows its arguments, the spans like it and its children. While a capture runs, the timeline
  follows its last five seconds. Under it, every span group: thread, count, total, p50, p95 and worst.
- **Logs.** Filter by level, module and text; copy as JSON lines. New lines are appended; the newest 500 are kept.
- **Parameters.** Change values live, reset them, and save or load named sets.
- **Inspector.** The read view's document tree, paged 50 rows at a time. The big tables list their rows without
  fetching records. Also: the evaluated frame on show, the history labels, and the log of edit session calls, which
  can be saved.
- **Jobs.** What the Performance tab does not chart: the engine's threads (lost, the document generation, busy), what
  the interface is doing (playing, buffering, importing, playback's buffer), the stage (back end, frames drawn, the
  last draw's geometry and submit times, a refusal), the browser's long tasks and slow inputs since the page started,
  and every worker the page started.

The **performance overlay** is a small pill over the stage's top-left corner that lets input through. It shows the
frame time seen and the input delay p95 (each with its grade), frames per second, late frames, the interface's work
p95 against the period, the frames the engine's threads prepare, memory, and the last two seconds' frame chart in
miniature. It is one canvas, drawn four times a second from reads the tools already keep, with no layout, in the
thread's idle time after a frame; its place is read when the stage's size changes. Measured during a drag at 144 Hz, a
drawing takes about 0.35 ms of script and 0.2 ms of canvas (its span reads about 1 ms on a loaded machine): under
0.05 ms a display frame, and no difference in late frames beyond the noise on the `large` workload.

Live, the Performance tab's chart redraws four times a second (about 0.4 ms) and its numbers and lists twice (about
2.5 ms on the `large` workload during a drag, in the thread's idle time after a frame, so it does not delay the next);
nothing is rebuilt, only text, bar transforms and canvases change, and each section contains its own layout. The tabs listen through
handler properties (`onclick`, `onpointermove`), never `addEventListener`, which the early script times as the app's
input handling.

The code is a folder, `src/devtools/panels/`: `panels.mjs` (the panel, its tabs, when a tab refreshes), a module per
tab (`performance.mjs`, `profiler.mjs`, `logs.mjs`, `parameters.mjs`, `inspector.mjs`, `jobs.mjs`), `overlay.mjs`, and
the shared pieces: `recording.mjs` (the held stretch, shared by Performance and Profiler), `chart.mjs` (the frame
chart), `dom.mjs` (elements, live tables and ranked lists that update in place, canvases that follow their size),
`rank.mjs` (the steady order) and `style.mjs` (the stylesheet over the app's tokens with fallbacks, light and dark,
and the colours the canvases read from it; canvases draw at the display's pixel ratio).

The panel is a dock panel, `developer`, which the tools define at run time (`window.styk.shell.define`): the shipping
build's catalogue and default layouts never name it. Its descriptor's `defaultDock: 'hidden'` places it closed in
every workspace, so the developer build's layouts keep their shape until it is opened. The dock host places a panel
defined after the layouts were read (`placeDefined`, one store update for all workspaces), and `placeHome` honors
`defaultDock`. A layout or saved layout a developer build stored opens in the shipping build: the slot stays as data,
no island or float draws it, and no panel is lost (`tests/dock-developer-panel.test.mjs`). Without a dock host
(a bare page), the panel is a floating window.

The tools never write the read view. Changes go through the app's own actions and commands, so each is a session
command with undo. The tools load beside the app's bundle and never import an app module, which would be a second
copy. The app hands over what they read (`startDevtools(window.styk, {loadEngine, tableOf})`). The exceptions are
`src/canvas-interactions.mjs` and `src/renderer-geometry.mjs`, which the bundle keeps as page entries.

## Control channel

For agents: drive and inspect the running app without the interface. The developer launch (`desktop/devtools.cjs`) serves
`\\.\pipe\stykanimate-dev-<pid>`:
- first instance only, remote clients rejected;
- a DACL that allows only the current user;
- one JSON request per line, at most 64 KiB, answered in order;
- answers bounded to 1 MiB.

The main process hands each request to the page (`__stykDevtoolsReceive(ticket, request)`), and the page answers through the
bridge the preload script exposes. Requests wait at most 120 s.

Until the app has finished starting (the tools load at its end), the early script answers the pipe itself: `hello`
(`toolsLoaded: false`) and `logs`, so an app that fails to start can still say why. Every other operation answers
"not finished starting" until then.

A request is `{id, op, args?, detail?: "short" | "full"}`. The answer is `{id, ok: true, result}`, or
`{id, ok: false, error: {what, where, input, cause, hint}}`. Answers are short by default.

| Op | What it does |
|---|---|
| `hello` | protocol version (1), build, operations |
| `state` | document summary, playback, view, focus, open dialogs, window, cross-origin isolation, WebGPU |
| `metrics`, `threads` | the frames, inputs, paint, queues and memory now; the page's workers |
| `logs` | `{level, module, text, since, limit}` |
| `trace.start`, `trace.stop`, `trace.read`, `trace.recent` | captures; Perfetto JSON in 256 KiB pages; the last `ms` from the ring |
| `params.list`, `params.set`, `params.reset`, `params.save`, `params.load` | live parameters and named sets |
| `doc.tree`, `doc.frame`, `doc.history`, `doc.commands` | the engine inspector's reads, paged |
| `command.list`, `command.run` | the app's command registry (what the palette and menus run) |
| `seek`, `play`, `pause`, `undo`, `redo`, `select`, `view`, `settle` | automation steps; each waits for the frame on show |
| `target.handle` | where to press to drag a joint or move a figure (the view is centred on it) |
| `open` | `{url, name}`: open a document the page can fetch. Over the pipe, `{path}`: the main process opens the file as it opens one from outside, and the answer comes once it is drawn |
| `screenshot` | the stage as a PNG data URL |
| `tools.overlay`, `tools.panel` | show or hide the overlay and the panel |

There is deliberately no operation that runs arbitrary code: the browser inspector is there for that.

`node scripts/styk-dev.mjs <op> [json]` is the client. `trace.save '{"path": "x.json"}'` stops a capture and writes
the Perfetto file.

## Profiling command

```
node scripts/styk-profile.mjs <file> [open|play|scrub|drag|pan-zoom|all] [--runs 3] [--out <new dir>] [--desktop] [--budget "<metric> <op> <value>"]
```

Each run opens the document fresh, then runs the steps:
- **play:** a few seconds from tick 0;
- **scrub:** 60 seeks;
- **drag:** a joint dragged at about 120 Hz, then undone;
- **pan-zoom:** 60 wheel notches with Ctrl held, then a middle-button pan.

Each scenario is one capture. The command writes:
- `summary.txt`, short enough to read in full. Per scenario: time, display frames (p50, p95, worst, late), paint p95,
  edit calls, seek p95 and playback fps. Then the slowest spans, anything unusual (dropped events, logged errors),
  and the budgets;
- `profile.json`, with every number, the medians over runs, each run, and the machine;
- `trace-<scenario>.json` (Perfetto) and `stage.png`, from the first run.

The document is named only by its hash. Budgets judge the median and make the command exit 1 when missed; 2 is a tool
error.

How the command reaches the app:
- **With `--desktop`,** it starts this checkout's app in a developer launch on a fresh scratch data folder
  (`STYK_USER_DATA_DIR`; `--user-data` names one, never the owner's), with `STYK_BACKGROUND_WINDOW=1` and
  `STYK_REMOTE_DEBUGGING_PORT=<port>`. The driver attaches with Playwright's `connectOverCDP`. Input goes through the
  inspector protocol, which is page input, not system input.
- **Without it,** the app runs from this checkout's sources in Chrome, with the early script injected: the same
  tools and measurements, without the desktop shell.

## The shipping build

`node scripts/check-devtools-shipping.mjs --web <dir> --binary <exe>` fails when it finds:
- a file under `src/devtools/`;
- a developer marker in any shipped text or binary, UTF-8 or UTF-16: `__stykDevtoolsEarly`, `__stykDevtoolsReceive`,
  `styk-devtools`, `stykanimate-dev-`;

`--expect-present` runs the opposite check on the developer build, so the markers are known to be real. The shipped
web file selection (`scripts/build-web.mjs selectFiles`) leaves `src/devtools/` out, and `scripts/verify-web.mjs`
accepts the gate's import of it.

## Checks

- `node --test tests/devtools.test.mjs`: the ring, captures, summaries, Perfetto, log filters, inspector paging, the
  inert instrumentation layer, the shipping check and the shipped file set.
- `node tests/devtools.browser.mjs`: the early script injected in Chrome, every control operation, a real joint drag
  reaching the edit session, the Perfetto export, each tab and the overlay rendering without errors, the Performance
  tab during a drag, Record then Stop giving a graded summary with frames and inputs, the tools' own cost, and
  nothing ticking once everything is closed. It writes screenshots to `artifacts/devtools/`.
- `tests/devtools.test.mjs` also holds the packaged app to its file lists (no `desktop/devtools.cjs`, no
  `src/devtools/`) and the shipped desktop code to carrying no developer marker.
- The shipping check on the shipping bundle (`build/app`) and the built site (`build/web`).
