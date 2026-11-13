# App start

What happens between launching the desktop app and a usable window, how it is measured, and what keeps it short.
`npm run perf -- run` times the launch as its `app.start` scenario ([PERFORMANCE.md](PERFORMANCE.md#how-a-run-works)): fresh processes on fresh profiles, started from a
bundle built from the checkout, from the process's launch to `window.styk.ready`, which `init()` sets after the stage exists and drawing is possible. The result names the
steps on the way (the desktop shell, the page and its scripts, the interface, the stage and its graphics device), which `init()` marks with `tracePhase`.

## The path

1. **Process to window** (`desktop/main.cjs`): Electron starts, `start()` reads the preferences, serves the app (`desktop/web-host.cjs`) and creates the window.
2. **Window to the page**: the page loads from the privileged scheme `styk-app://app`, which the main process answers itself (no sockets).
   Chromium's renderer main thread pays a fixed cost per request, so the number of requests matters more than their size.
3. **The scripts and styles**: the packaged app serves the application as a bundle (below): about a dozen files at launch. From source the page loads about 370 modules
   and 92 stylesheets, which is slower to start and exists so that tests and development see the sources.
4. **The engine and the stage** (`src/engine/engine-start.mjs`, the page's first script): the engine's WebAssembly compiles; once the page has painted its
   first frame, the scene's WebGPU adapter is asked for and the stage starts over the scene canvas (as soon as the module is instantiated too) (below, "Asking for the device sooner").
5. **`init()`** (`src/app.mjs`): settings, locale, the shell, then the stage (`createRenderer`), which takes the stage started in step 4 and waits for it.

## The bundle

`scripts/build-app.mjs` (esbuild, `npm run app:bundle`) writes `build/app`: an overlay of files that answer in place of the web assets with the same paths.

- The page's entries (`src/app.mjs`, `src/engine/engine-start.mjs`, `src/engine/engine.mjs`) are bundled together and share chunks (`src/chunks/`).
  `engine.mjs` is an entry so that a script importing it from the page gets the application's engine rather than a second copy.
- Every `src/**/*-worker.mjs` is a self-contained bundle at its own path, so `new Worker(new URL('./x-worker.mjs', import.meta.url))` finds it.
  `tests/app-bundle.test.mjs` fails when a worker the application starts is not an entry.
- `import.meta.url` becomes the module's own URL (`/src/...` on the page's origin) because modules locate their neighbours with it (the engine's WebAssembly, the codec glue).
- The stylesheet (`src/styles/app.css` and the ninety-odd files it imports) is one file; its fonts and images stay files of the web assets, with their `url()`s rewritten to resolve from the bundled sheet.
  Scripts wait for the page's stylesheets, so those requests held back the first script (paired probe runs: ready about 240 ms sooner with the sheet bundled, on top of the scripts). The sheet is not minified: custom properties keep their text.
- `index.html` is the source page with its `modulepreload` links replaced by the bundle's launch files, so the fetches start while the head is parsed.
- Everything else stays unbundled and is served from the web assets: the stylesheets loaded later by a module (`support-bridge.css`), fonts, WebAssembly and its glue (`src/engine/pkg/`, loaded by URL),
  and the modules the main process reads (`src/localization.mjs` and its neighbours, `src/stats/schema.mjs`).

The overlay is `resources/bundle` in a packaged app (`before-pack.cjs` builds it, `package.json` ships it); `desktop/main.cjs` hands it to the web host. From source,
`STYK_BUNDLE_DIR=build/app electron .` serves a bundle built by `npm run app:bundle`; without it the page loads the modules, so a plain `npm start` always runs the code on disk.
A bundle named by `STYK_BUNDLE_DIR` that is missing stops the app from starting. The browser build (`docs/WEB.md`) is not bundled.

A change in a module reaches a packaged app through the bundle: a script that loads source modules by URL and shares state with the application (as the developer tools do for the canvas's handles)
needs the module as an entry (`PAGE_ENTRIES` in `scripts/build-app.mjs`), or it gets its own copy.

The scripts are not minified: five interleaved runs each gave the same ready time (1,100 ms against 1,095) and DOMContentLoaded (374 against 405 ms) for 1.5 MB less, and a stack trace keeps its function names. esbuild keeps legal comments at the end of a script, and a vendored library's licence header is turned into one, so opentype.js's MIT notice stays in the bundle beside `vendor/text/opentype.LICENSE` and `THIRD_PARTY_NOTICES.md`, which ship with the web assets.

**Stack lines for statistics.** A `problem` report names our own modules and lines (docs/STATISTICS.md, "Problems"; `src/stats/stack.mjs`). Bundled, a stack line would be `chunk-HASH.mjs:LINE`, or `app.mjs` at a line of the bundle. The build therefore reads each script's source map once (`frameTable` in `scripts/build-app.mjs`), keeps the lines that came from a module of ours (every module under `src/` except the engine's generated glue and the language files) as `{modules, runs}`, where a run is `[module index, last line, bundle line, source line, ...]`, writes the page's and the workers' tables to one file, `src/frame-map.json`, and deletes the maps. Nothing reads the file at start: the collector fetches it the first time it describes a problem, and reads a line as the module and its source line, as it would be unbundled. Covering every module instead of 44 made the tables 438 KB instead of 73 KB (370 KB for the page's scripts, 68 KB for the workers'), 1.3 % of the 32.9 MB bundle; parsing them takes about 6 ms, which is why they are no longer a script the page runs before its modules (the 44-module tables were).

## Asking for the device sooner

What the stage waits for is a chain of round trips to the browser's graphics process, each of which waits for that process's one main thread and for the
page's interface thread to take the answer. Before November 2026 the chain was: the engine's WebAssembly ready, its first two threads joined, then wgpu's
WebGPU detection (an adapter asked for and dropped), the adapter, the device, and on a machine whose driver Chromium refuses for WebGPU, a fourth request
for the adapter's name. A worker asked for its own adapter and device meanwhile, which warmed nothing the page uses: each page and worker has its own
connection to the graphics process. Now (spans of the `graphics calls` and `engine start` lanes, `npm run perf -- show <run> app.start`):

- **The adapter is asked for once the page has painted** (`src/engine/engine-adapter.mjs`), beside the engine's compile, and its answer is handed to the engine's
  own request with the same options (wgpu asks through `navigator.gpu`, so the hand-off is there; a second stage, after a lost device, asks afresh). Its
  description names the adapter in the status line, which the warm-up worker did before; the worker is gone. The page's first WebGPU call holds the
  interface thread while its connection is set up (`syncMs` on the span: 2 to 300 ms, more when the graphics process is busy); it did so before too, inside the stage.
- **One adapter request per device** (`engine/crates/styk-wasm/src/gpu.rs`, used by the stage, the preview worker and the export worker): WebGPU where the
  browser gives an adapter, else WebGL2, without wgpu's detection. On a busy machine (other builds at 100% of the processor) the detection took 1.1 s and the
  adapter after it 0.66 s; a machine whose driver is refused waits for one "no adapter" instead of two.
- **The stage starts before the engine's threads join** (`loadEngine({stage})`): it needs the engine's handle, not its threads.
- **Both wait for the page's first paint** (at most 0.3 s, `afterFirstPaint` in `engine-start.mjs`): started before it, their synchronous parts (the
  connection's setup, WebGL2's shader link) held the first pixels back by 0.2 to 0.5 s on every environment.
- **A WebGL2 stage is named by the engine** (`adapterName` in `src/engine/engine-stage.mjs`): asking WebGPU for the name of a WebGL2 stage waited for one more
  "no adapter", up to 1.5 s, and would have named another device.

On a refused driver (`--env webgl`) the largest single wait is the engine's primitive shader program: its link status (`gl: getProgramParameter`) holds the
interface thread for about 1.6 s on a cold profile, the shader translated and compiled behind it (ANGLE on Direct3D 11). wgpu's GL backend asks for the status
at once, so the compile cannot overlap anything on that thread; the stage now starts it before the interface is built, so the interface waits for it instead of after it.
A program cache in the profile makes later launches cheaper; the measured start is always a fresh profile.

## The stage's wait for the graphics process

Marks across a launch (bundled app, fresh profile, a quiet machine; page milliseconds) put the stage's creation at about 0.55 s and its end at about 1.9 s. Its
three calls to the browser (`requestAdapter` for the detection wgpu does, `requestAdapter` and `requestDevice`) took 0.7 s, 0.4 s and 0.08 s, but the same calls in a bare window
take 0.15 s, 0 s and 0.05 s, and leaving out the detection request (emulated in the page) changed nothing then; see "Asking for the device sooner" for what it costs where the chain waits for a busy interface thread. The graphics process's one main thread was busy: a trace showed it
rasterizing the interface (`RasterDecoderImpl::DoEndRaster`, 0.36 s and then 0.41 s, compiling shaders on a cold cache) while the stage's WebGPU commands
waited behind it.

**Rasterizing the interface on the CPU (`--disable-gpu-rasterization`) was tried and is not in.** On Windows 11 (Ryzen 5 5500, RTX 4070 SUPER, Electron 39, a
bundled source launch, fresh and reused profile, 1× display scale) it made the stage ready at 1.8 s against 2.6 s (median of five interleaved launches; every pair faster; 1.5 to 1.8
against 2.3 to 3.1 s on a warm profile) and changed 15 to 21 % of the pixels of Home and the editor by one level on average. A review then ran tdd2 for 7 s of
playback at 24 fps at **2× display scale**: with the switch 22, 17 and 12 stutters, worst frame interval 85 to 98 ms, and the renderer's raster threads at 16 to 21 s of CPU;
without it 0 stutters, 48 ms. At 1×, 1.25× and 1.5× there was no difference. 200 % is a common scale on Windows and a window moves between displays, so a scale-dependent
choice is not an option, and 0.8 s of start is not worth a stutter on such a machine. Do not try it again without the 2× playback numbers above.

**A side finding from it:** 16 to 21 s of raster CPU in 7 s of playback at 2× means the interface repaints a great deal during playback. GPU rasterization hides that cost; it is
real work either way: on the renderer's raster threads with the switch, on the graphics process otherwise, where the stage's commands wait. Less repainting would help both.

## Measured and left alone

- **Pipelines.** Creating the stage's pipelines and shader modules takes 0 ms at the call (the work is asynchronous); the engine's primitive shader
  takes about 0.33 s to compile in a cold profile and 3 to 5 ms with the on-disk cache (`DawnWebGPUCache` in the profile, kept between launches), and the
  first picture is drawn 10 to 20 ms after `styk.ready`: the compile overlaps the rest of the stage. Compiling with DXC instead of FXC
  (`--enable-dawn-features=use_dxc`) changed it by about 20 ms.
- **Detection request.** Leaving out wgpu's WebGPU detection request (emulated in the page) changed the stage's time by nothing in an earlier quiet measurement; it is
  left out now ("Asking for the device sooner"), because each request of the chain waits for the interface thread and the graphics process.
- **Yields in `init()`.** A macrotask yield after the shell and before the timeline mounts moved the stage's median 65 ms (noise-sized) and left ready where it was; events could then
  run on a half-built interface, so it is not in.
- **The engine before the application.** `src/app.mjs` awaits `loadEngine()` at the top of its body (`useEngine(await loadEngine())`), because the
  editor it builds next opens its document in the engine. The body (about 90 ms) therefore starts after the WebAssembly is fetched, compiled and its
  threads have joined (about 0.2 s, during which the interface thread is idle): the one serialization left on the way to `ready`.
- **`init()`'s synchronous block** (about 0.3 s: the shell, the timeline, the inspector, the first style and layout pass) holds the stage's continuations back by about 0.2 s.

## What the main process pushes at startup

The main process sends the file the app was launched with, a `stykanimate://` link's menu action (`privacy`) and the menu's own actions as soon as the page has loaded. `src/app.mjs`
waits for the engine at the top of its body, and a module that waits does not hold the load event back, so the listeners could be registered after the message: it was dropped
and the file or the link silently did nothing. Bundled, the page loads sooner than the engine: launching with a file opened it in 1 of 8 launches, and `stykanimate://privacy`
opened the privacy settings in 0 of 3 (it is also why `smoke-home`'s "opening a file at launch" failed now and then from source, where the window is narrower).

Everything the main process pushes now goes through one queue (`desktop/page-pushes.cjs`): it is kept, in order, until the page says its listeners are on
(`desktop.pageListening()`, called when `init()` has registered them and the editor is ready, `styk:page-listening`), and kept again when the page loads again.
`tests/page-pushes.test.mjs` fails if the main process sends one of these channels to the page directly, and `scripts/smoke-launch-link.mjs` launches the app with a file
and with the link three times each (source, bundled source, `--packaged`). A listener for a new push needs no early registration: it is registered where the others are.

Smokes that need the application's own state go through `window.styk` (for a language, `window.styk.loadLocale`), not through a module imported by URL, which on a bundled
app is a second copy; `tests/app-bundle.test.mjs` lists the few imports that are fine.

## What was tried against the stage's wait, without the CPU rasterization switch

Quiet machine, a bundled source launch, fresh profile, median of five or six launches per row (stage ready, ms from the spawn). The machine's own display scale was 125 % for some runs; `--force-device-scale-factor` sets the scale named.

| Change (injected before the first paint) | 1× | 2× |
| --- | --- | --- |
| none | 2,089 | 2,530 |
| no `backdrop-filter` | 2,172 | 2,617 |
| no shadows or filters | 2,234 | 2,670 |
| none of those, and no radii or gradients | 2,318 | 2,634 |
| none (a noisier run) | 3,280 | 3,010 |
| side panels and title bar not painted (`content-visibility: hidden`) | 3,188 | 2,967 |
| nothing painted until the stage is ready, then everything | 3,256 | 3,039 |
| none (a third run) | 2,330 | 2,420 |
| every 2D canvas a software canvas (`willReadFrequently`) | 2,195 | 2,817 |

Nothing moves it: less to paint does not shorten the wait. A trace of the graphics process agrees (two launches each, 1×): with nothing painted its main thread still ran 1.57 s of
`RasterDecoderImpl::DoEndRaster` tasks (1.39 s in the baseline), two of them about 0.33 s each and the first before any script runs. So those are not the visible page's content: they are
the raster path's own first-use work (its context and shaders, cold) and the canvases' drawing. The stage's WebGPU commands (0.7 to 0.9 s of tasks) queue between them, and after
`Stage.create` the same thread compiles the engine's primitive shader (0.48 to 0.60 s in `HandleDawnCommands`), which is what the first picture waits for: `styk.ready` is set before it,
and the first-frame counter (`engineStats.frames`) counts frames submitted, not shown. Compiling it earlier would mean creating the same pipeline from a worker of the page, a second copy of the renderer's
pipeline description in JavaScript that Dawn's cache would only share if every detail matched; `createRenderPipelineAsync` is not offered by wgpu. Neither was done.

Shader caches persist: after a launch the profile holds `GPUCache` (1.6 MB), `DawnGraphiteCache` (0.5 MB) and `DawnWebGPUCache` (5.6 MB), and the next launch of the same profile read them (the bare-window
pipeline compile fell from 0.33 s to 3 to 5 ms). The stage's ready time on a reused profile was within the noise of a fresh one at both scales (1×: 2,029, 1,996, 2,417 against 2,089), so the cold part is
not what holds the stage; Home as the first view (the default launch) gave 2.4 to 3.1 s at 1× and 2.4 to 2.7 s at 2×, the same range.

What is left of the floor, in order: Electron to a window (about 0.45 s), the page and the engine to the application module (about 0.6 s with the bundle), then the stage, whose
wait is the graphics process's one main thread working through two cold raster tasks, the adapter and device, and the pipeline compile, in that order, none of which JavaScript can reorder.
