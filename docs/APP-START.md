# App start

What happens between launching the desktop app and a usable window, how it is measured, and what keeps it short.
`scripts/benchmark-app.mjs` (`docs/performance/APP-BENCHMARK.md`) times the launch; its `ready` row stops when the application module has
run and `window.styk` exists (before `init()` goes on to create the stage), and `window.styk.ready` is set after the stage exists. Both are worth
watching: the first is what the scoreboard reports, the second is when drawing is possible.

## The path

1. **Process to window** (`desktop/main.cjs`): Electron starts, `start()` reads the preferences, serves the app (`desktop/web-host.cjs`) and creates the window.
2. **Window to the page**: the page loads from the privileged scheme `styk-app://app`, which the main process answers itself (no sockets).
   Chromium's renderer main thread pays a fixed cost per request, so the number of requests matters more than their size.
3. **The scripts and styles**: the packaged app serves the application as a bundle (below): about a dozen files at launch. From source the page loads about 370 modules
   and 92 stylesheets, which is slower to start and exists so that tests and development see the sources.
4. **`init()`** (`src/app.mjs`): settings, locale, the shell, then the stage (`createRenderer`), which waits for the graphics process.

## The bundle

`scripts/build-app.mjs` (esbuild, `npm run app:bundle`) writes `build/app`: an overlay of files that answer in place of the web assets with the same paths.

- The page's entries (`src/app.mjs`, `src/engine/engine-start.mjs`, `src/engine/engine.mjs`) are bundled together and share chunks (`src/chunks/`).
  `engine.mjs` is an entry so that a script importing it from the page (the benchmark does) gets the application's engine rather than a second copy.
- Every `src/**/*-worker.mjs` is a self-contained bundle at its own path, so `new Worker(new URL('./x-worker.mjs', import.meta.url))` finds it.
  `tests/app-bundle.test.mjs` fails when a worker the application starts is not an entry.
- `import.meta.url` becomes the module's own URL (`/src/...` on the page's origin) because modules locate their neighbours with it (the engine's WebAssembly, the codec glue).
- The stylesheet (`src/styles/app.css` and the ninety-odd files it imports) is one file; its fonts and images stay files of the web assets, with their `url()`s rewritten to resolve from the bundled sheet.
  Scripts wait for the page's stylesheets, so those requests held back the first script (paired probe runs: ready about 240 ms sooner with the sheet bundled, on top of the scripts). The sheet is not minified: custom properties keep their text.
- `index.html` is the source page with its `modulepreload` links replaced by the bundle's launch files, so the fetches start while the head is parsed.
- Everything else stays unbundled and is served from the web assets: the stylesheets loaded later by a module (`support-bridge.css`), fonts, WebAssembly and its glue (`src/engine/pkg/`, loaded by URL),
  and the modules the main process reads (`src/localization.mjs` and its neighbours, `src/telemetry-schema.mjs`).

The overlay is `resources/bundle` in a packaged app (`before-pack.cjs` builds it, `package.json` ships it); `desktop/main.cjs` hands it to the web host. From source,
`STYK_BUNDLE_DIR=build/app electron .` serves a bundle built by `npm run app:bundle`; without it the page loads the modules, so a plain `npm start` always runs the code on disk.
A bundle named by `STYK_BUNDLE_DIR` that is missing stops the app from starting. The browser build (`docs/WEB.md`) is not bundled.

A change in a module reaches a packaged app through the bundle: a script that loads source modules by URL and shares state with the application (as the benchmark does for the engine)
needs the module as an entry (`PAGE_ENTRIES` in `scripts/build-app.mjs`), or it gets its own copy.

Identifiers are minified, so a stack trace from a packaged app names minified functions; build with `npm run app:bundle` and read the source for a position.
