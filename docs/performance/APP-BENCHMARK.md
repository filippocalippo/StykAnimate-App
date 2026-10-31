# App benchmark

`scripts/benchmark-app.mjs` measures what a person notices in the desktop app: starting, opening, playing, scrubbing, posing, dragging,
drawing, undoing, saving, zooming, switching projects, exporting. It is the scoreboard of the performance phase, so the same code runs
against any checkout, including `main` (the old JavaScript app), or a packaged build. A thing the old app lacks is reported as absent, never
as a failure. `npm run bench:app` is the benchmark itself, `npm run bench:app:run` the runner, `npm run bench:app:summary` the summary.

It drives the real app in an off-screen window that never takes focus (`STYK_BACKGROUND_WINDOW=1`), with real Chromium input through CDP
(no OS mouse or keyboard), a fresh profile each run. Run it on an otherwise idle machine, one app at a time, with no builds going.

## Running

The documents are private test files and never part of the repository. The runner takes them from the command line and from a local JSON
file that stays out of the repository (`--config=<file>` or the `STYK_BENCH_CONFIG` variable):

```json
{
  "files": ["C:/path/heavy.piv", "C:/path/other.styk"],
  "small": "C:/path/small.piv",
  "sides": {"main": "C:/path/checkout-of-main", "now": "C:/path/this-checkout"}
}
```

```
npm run bench:app:run -- --config=bench-config.json --runs=3 --out=artifacts/benchmark-app/mine
npm run bench:app:run -- --sides=now=. --only=scrub,jump,step C:/path/heavy.piv --runs=1
npm run bench:app:run -- --only=empty,home --runs=3 --sides=main=C:/path/main,now=.
npm run bench:app:summary -- artifacts/benchmark-app/mine/all main baseline now
```

Every side is a checkout with its dependencies installed and, for the Rust engine, its engine built in release mode
(`node scripts/engine-build.mjs`; a `--dev` build is never a result). The driver is always this repository's script, so
all sides run identical measurements. `--exe=<label>=<executable>` runs a packaged app of that label instead of its checkout (the checkout
still supplies the driver). Rounds alternate the sides file by file, so a busy moment lands on all of them.

One run by hand: `node scripts/benchmark-app.mjs <label> <checkout> <out-dir> doc <file> [runs] [--save] [--only=a,b] [--small=<file>]`,
or `draw`, or `free`. `--executable=<path>` launches a packaged build.

## Steps

Each is a name for `--only=`; `open` always runs in a document run.

| Scenario | Steps |
| --- | --- |
| `doc <file>` | `idle`, `playCold`, `playWarm`, `scrub`, `jump`, `step`, `poseDrag`, `moveDrag`, `flicker`, `save` (needs `--save`), then `draws`, `zoomPan`, `select`, `timelineInspector`, `onion`, `export`, `tabs` |
| `draw` | the brush run |
| `free` | `empty` (the app after startup with no document, memory by process type), `home` (a Home with 200 projects) |

- **Existing steps** keep their definitions; baselines taken before the newer steps existed stay comparable. `memory` in a document result covers
  only those steps. The newer steps run after it, so a second tab or an export never raises it; `memoryAfterNewSteps` covers the whole session.
- **`empty`**: a separate launch, five seconds after the app is usable, so it never touches `open.openMs`. `medianMiB` is the settled total
  (private memory of every process); `byType` splits it into `browser` (main process), `renderer`, `gpu`, `utility` and `other`.
- **Memory breakdown**: `memoryDetail.snapshots.<step>` after `open`, `playCold`, `playWarm`, `scrub`, `poseDrag` and `flicker`: memory by
  process type, the renderer's JS heap (`jsHeapUsedMiB`, CDP `Runtime.getHeapUsage`) and the engine's WebAssembly memory (`wasmMiB`; null on
  the old app, which has none). `memoryDetail.byType` has the breakdown at the session peak and per phase.
- **`draws`**: `drawsPerFrame` is the engine's frame counter (`state.renderer.engineStats.frames`) divided by the ticks playback showed in 5 s.
  The target is 1. The old app has no such counter (`counter: false`, absent).
- **`zoomPan`**: 90 real Ctrl+wheel events at 120 Hz in and out, then a 90-move middle-button pan, on the frame at 40 % of the animation.
  Input → paint percentiles, frames per second and the worst gap between the page's frames (the UI freeze).
- **`select`**: a click on a figure's origin, pointer press → the paint after the selection changed, ten times.
- **`onion`**: onion skins on through the app's own action and settings (3 frames each side), then scrub, next-frame key and 5 s of playback as
  the existing steps measure them. The settings are put back.
- **`timelineInspector`**: with the timeline and inspector on show and a figure selected, 10 s of playback. `playhead.delay` and
  `inspector.delay` are how long after a tick was shown the playhead's or the inspector's DOM changed (a `MutationObserver` on each);
  `missed` counts ticks that never showed up there. Plus the playback figures (stutters, long tasks, worst freeze).
- **`export`**: `dialogMs` is the action → the export dialog usable (its Export button enabled); `exportMs` the time to a finished WebM of
  about 2 s of the document in a temporary file, which is deleted.
- **`tabs`**: a second project (the `--small` file, or a new project) opens in a tab, then ten switches to and fro: action → first paint of the other
  document, and memory afterwards.
- **`home`**: the app launches with a library of 200 projects fabricated in its own temporary profile (copies of a small project the app saves
  itself, with a picture each), never the person's library. `homeUsableMs` is launch → every project listed; then the list scrolls.

## Flicker

`flicker` counts pictures that differ from both neighbours while the neighbours agree (A-B-A), and blank pictures between non-blank ones. The raw
counts (`transients`, `blanks`) never changed. Some animations contain an A-B-A themselves (a strobe, a camera that jumps), so a reference is taken
after the raw passes: one picture per tick, as the tick looks once it has fully settled. An A-B-A (or blank) that the reference pictures of the same
ticks show too is the animation's own content (`contentTransients`, `contentBlanks`); the rest are drawing artifacts (`artifactTransients`,
`artifactBlanks`), and zero is the target for those. Idle and drag have no reference: every one counts as an artifact.

- **`flicker-scrub`**: the reference is the paused view at the same view as the pass: each tick shown, nothing drawn or pending for 250 ms, the picture
  of its last draw.
- **`flicker-play`**: the reference is each tick's prepared frame drawn again while paused with the call playback uses, at the view and under the
  overlay playback had (playback fits the view itself), once the frame has all its pictures. The old app keeps the paused editing view without
  onion skins.
- Pictures are read in the animation-frame callback that drew them, as the raw ones are: a WebGPU canvas holds nothing between frames, so a picture
  read later is a blank stage. Until 2026-10-31 the reference was read that way, and its view was whatever the drag steps before it had left, so almost
  nothing matched and nearly every real content blink counted as an artifact.
- `blinks` lists the first twelve A-B-A of a pass (the ticks shown, the blocks, the engine's draw counter, whether it is content). `redrawChanges`
  counts ticks drawn twice whose second picture differs from the first, the blink a person sees from a frame shown before its pictures are in.

## Reading the summary

`benchmark-app-summary.mjs <dir> <label> ...` prints the median of the runs per label for each file, then the scoreboard. The targets live in one
table (`TARGETS`) in the script. Each row shows, per label, the worst file's value, whether it meets the target (✓/✗) and whether it clears the
floor against the base label (`main`, or `--base=`): rows where main is slow, at least 3× faster, memory at most half; rows where main is
already near the display limit (joint and figure drag, brush), at least as good at p50 and better at p95 and p99 with no worst-case freezes; every
other row within 5 % of main. A row the checkout cannot measure reads `absent`.

The display here refreshes at 144 Hz (one refresh is 7 ms); `REFRESH` in the summary assumes it. Latencies end at the app's paint; scan-out adds about
one display frame on every checkout alike. CPU or GPU throttling is not simulated: numbers from different machines are not comparable.
