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

Display frames are measured only while the overlay or a capture watches, so the tools cost nothing when closed.

## Panels

`src/devtools/panels.mjs` is one floating panel, marked DEVELOPER, opened with **Ctrl+Shift+D**. It has five tabs:
- **Profiler.** Record, or take the last 5 s from the ring after a hitch. A timeline shows one lane per thread (the
  interface, display frames, input); wheel zooms and a click selects a span, with its arguments, similar spans and its
  children. The span table lists count, total, p50, p95 and worst. **Export Perfetto** saves Chrome trace JSON for
  ui.perfetto.dev.
- **Logs.** Filter by level, module and text; copy as JSON lines.
- **Parameters.** Change values live, reset them, and save or load named sets.
- **Inspector.** The read view's document tree, paged 50 rows at a time. The big tables list their rows without
  fetching records. Also: the evaluated frame on show, the history labels, and the log of edit session calls, which
  can be saved.
- **Jobs.** Engine threads, lost workers, preparation, the frame cache, pictures pending and busy; the stage's
  geometry and submit times; memory (JS heap, the engine's linear memory, live and peak, the frame cache, GPU); and
  every worker the page started.

The **performance overlay** (**Ctrl+Shift+O**) sits over the stage and lets input through. It shows:
- frame time, p50, p95 and worst;
- late frames;
- paint p95 and playback fps;
- queue depths and memory;
- a bar strip of recent frames.

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
| `metrics`, `threads` | the overlay's numbers; the page's workers |
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
| `document.mark`, `document.wait` | `{token}`: wait until another document is in front and drawn (what `open {path}` and a project switch wait for) |
| `process.metrics` | over the pipe: the app's processes, their CPU time and memory |
| `dialog.answer` | over the pipe: answers the main process's next save or open dialog. `{kind: "save" \| "open", path}` (absolute) or `{kind, cancel: true}` queues one answer; `{clear: true}` drops those waiting; `{unanswered: "cancel"}` cancels a dialog nothing answered instead of showing it, and keeps an error box (`showErrorBox`) from showing (`"show"` again restores both). Every answer returns `{pending, unanswered, asked}`: the answers waiting and the last 16 dialogs asked, with their title, default path and what answered them |

There is deliberately no operation that runs arbitrary code: the browser inspector is there for that.

`dialog.answer` exists because a script cannot see or click a native dialog and must never leave one waiting on the screen of
whoever is at the computer: it wraps `dialog.showSaveDialog`, `showOpenDialog` and `showErrorBox` inside `desktop/devtools.cjs`,
so the packaged app has neither the file nor a line for it. Production IPC still takes no path from the page; only a client of
the developer pipe, which only the current user reaches, gives one. A profiling run (`perf/lib/app.mjs`) sets `unanswered:
"cancel"` as it starts and answers each dialog its scenarios cause (`App.answerDialog`).

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
  reaching the edit session, the Perfetto export, and each panel and the overlay rendering without errors.
- `tests/devtools.test.mjs` also holds the packaged app to its file lists (no `desktop/devtools.cjs`, no
  `src/devtools/`) and the shipped desktop code to carrying no developer marker.
- The shipping check on the shipping bundle (`build/app`) and the built site (`build/web`).
