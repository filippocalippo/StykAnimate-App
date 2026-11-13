# Writing a scenario

A scenario is one thing a person does in the app, measured the same way every time. `docs/PERFORMANCE.md` explains
the whole system; this page is the contract between a scenario and the runner (`perf/lib/run.mjs`).

A file per area of the app (`canvas.mjs`, `timeline.mjs`, …) exports its scenarios as named constants and as a
default array; `index.mjs` lists the files in the order a run executes them. A scenario's id is `<area>.<what>`.

```js
export const pan = {
  id: 'canvas.pan', area: 'canvas', title: 'Pan the canvas', kind: 'gesture',
  description: 'Drags with the middle button round a circle for 1.5 s. …',
  async run(context) {
    const {centre} = await context.stage();
    await context.input.stroke(context.paths.circle({x: centre.x - 160, y: centre.y}, 160), {durationMs: 1500, button: 'middle'});
  },
};
```

## The fields

| Field | Meaning |
| --- | --- |
| `id`, `area`, `title` | The id is what `--scenario` takes; the area groups scenarios in reports; the title is what a person reads. |
| `description` | What the person does and which parts of the app that exercises, in a sentence or two. It is printed with the result. |
| `kind` | `gesture`: something continuous (a drag, playback, scrolling), judged by its frames. `operation`: one action with an end (open, save, undo), judged by how long it takes. |
| `when(context)` | Optional. Returns a string to skip the scenario on this document ("the document has one frame"); the string is the reason shown. |
| `setup(context)` | Optional, once, not measured. Finds what the scenario needs (a handle to press, an element's place) and returns it as `state`. |
| `run(context, state)` | The measured stretch. May return `{metrics: {…}, notes: […]}`. |
| `reset(context, state)` | Optional, after every pass, not measured. Puts back what `run` changed (an undo, a seek) so the next pass starts equal. |
| `teardown(context, state)` | Optional, once at the end. Undoes what `setup` changed. |
| `judge` | `{metric, limits: [good, fair, poor]}`, or a list of them: the grade is the worst. Default (`defaultJudge` in `perf/lib/metrics.mjs`): a gesture on the frame time a person sees (`frame.felt`) and on input delay (`input.p95`); an operation on `duration` against `LIMITS.response`. Set the limits from what a person tolerates for this action, never from today's number. |
| `metrics` | Definitions of the scenario's own metrics: `{'export.fps': {title, unit, better: 'higher', digits}}`. Their values come back from `run`. |
| `passes` | A fixed number of timed passes, for a scenario that cannot repeat (the first open). |
| `settle` | `false` when the scenario ends without a frame to wait for. By default the capture ends when the frame on show is the document's current state. |
| `profile` | `false` to skip the profiled pass (a scenario that cannot run twice). |
| `timeoutMs` | The most one pass may take (default two minutes). |

## What the runner does around `run`

1. `context.rest()`: nothing playing, nothing covering the stage, the first frame, nothing selected, the scene fitted.
2. `when`, then `setup`.
3. For each timed pass: start the app's capture, `run`, wait for the frame, stop the capture, `reset`.
4. One profiled pass with the sampling profiler on every thread and the browser's trace. An operation repeats here
   (with its `reset`) until a second and a half has been watched, so a 5 ms undo still has samples to explain it.
5. `teardown`.

Every capture already reports the frames, the interface thread's work by phase, input latency, long tasks, the calls
into the engine and what the engine's threads prepared. A scenario adds only what is its own: an operation's exact
duration when the capture's length is not it (`{metrics: {duration: opened.ms}}`), an export's frames per second.

## The context

- `context.app`: the app (`perf/lib/app.mjs`): `request(op, args)` is the developer tools' control channel
  (`docs/DEVTOOLS.md` lists the operations), `evaluate(fn, argument)` runs a function in the page, `open(file)` opens a
  document, `quiet()` closes what covers the stage, `shell(op, args)` is the desktop's own half.
  `answerDialog(kind, file)` answers the desktop's next save or open dialog with a path (`null`: cancel) and `dialogs()`
  says which dialogs came and what answered them: a run never shows a native dialog, so a scenario that saves or exports
  answers its dialog first (`save.mjs`, `export.mjs`). Files a scenario writes go in a `scratchFolder` (`perf/lib/files.mjs`)
  under the system's temp folder, removed in its teardown.
- `context.request`, `context.evaluate`: the same two, shorter.
- `context.input`: `stroke(path, {durationMs, hz, button, pressure})`, `wheel(x, y, {notches, deltaY, durationMs, ctrl})`,
  `click(x, y)`, `key(name, {ctrl, shift, alt})`, `keys(name, {count, durationMs})`, `move`, `down`, `up`, `hold`,
  `release` (`perf/lib/input.mjs`). A stroke with `pressure(t)` is a pen: the page sees pen pointer events with that
  pressure. `context.paths` has `line`, `circle`, `wave` and `sweep`.
- `context.stage()`: the stage's rectangle and centre in window pixels. `context.rect(selector)`: the same for the
  first visible element matching a selector (it throws when nothing does). `context.press(selector)`: a real click on
  its middle. `context.until(test, {what, timeoutMs})`: waits until a function is truthy in the page.
- `context.state()`: the document, playback and view. `context.settle()`: waits for the frame. `context.sleep(ms)`.
- `measure(context, state, summary)`: an optional field of the scenario, called after each pass with the capture's
  full summary; returns more metrics. `summary.shown` says when the stage drew which tick and when each input
  happened (`perf/lib/latency.mjs` turns them into a latency).
- `context.workload`: the workload and what it holds (`measured.segmentsPerFrame`, `measured.frames`).
  `context.facts`: what the app runs as (the renderer, the display's rate, the engine's threads).

## Rules

- **Input is real input.** Press, drag and type through `context.input`; reach for `context.evaluate` to read, or to
  start something that has no gesture. A scenario that calls the app's internals measures those internals, not what a
  person waits for.
- **Gestures run on a clock.** `stroke`, `wheel` and `keys` take a duration and keep it however slow the app is, so a
  scenario costs the same time on every machine and a slow app shows as fewer, later frames. Keep a gesture near 1.5 s.
- **Find places, do not assume them.** Read an element's rectangle in `setup`; sizes change with the window, the
  layout and the display's scale. Throw with a sentence that says what was missing.
- **Leave the app as you found it.** After `reset` and `teardown` the document, the selection and the settings are
  what they were: the next scenario runs in the same app.
- **Check that it happened.** A drag that never started measures nothing and looks fast. Verify the effect (the
  revision changed, the file exists, the tick moved) and throw when it did not.
- **No file from outside the repository.** A scenario works on the generated workloads (`perf/workloads.mjs`); what
  it needs beyond them it builds itself.
- **Windows and Linux.** Nothing in a scenario depends on the platform; what does lives in `perf/lib/`.
