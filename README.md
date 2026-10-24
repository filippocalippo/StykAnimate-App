<p align="center">
  <img src="assets/brand/svg/stykanimate-horizontal-primary.svg" alt="StykAnimate" width="420">
</p>

<p align="center">
  A free, open-source stick figure animation app for Windows, Linux and the browser.<br>
  Opens Pivot (<code>.piv</code>, <code>.stk</code>) and Stick Nodes projects, and keeps your work on your device.
</p>

<p align="center">
  <a href="https://stykanimate.com">Website</a> ·
  <a href="https://app.stykanimate.com">Open in the browser</a> ·
  <a href="https://github.com/filippocalippo/styk-animate-releases/releases/latest">Download</a> ·
  <a href="https://discord.gg/WTssQKBaJp">Discord</a> ·
  <a href="https://www.youtube.com/channel/UCZg7hZc23PNufzxnX8mCaCw">YouTube</a>
</p>

## Features

- **Pose stick figures** with fixed-length joints, IK for arms and legs, stretchy nodes and 3D figures with depth.
- **Build your own figures** from lines, circles, polygons, text and images, with a shared rig and per-part styles.
- **Two timelines:** a Simple, Pivot-style frame strip and an Advanced timeline with layers, folders, keys and easing.
- **Motion paths, onion skins and camera moves,** including camera follow.
- **Particle effects** (explosions, auras, beams, smoke) and brushes for drawing.
- **Community library:** insert figures and movieclips shared by other animators.
- **Export** MP4, WebM (with transparency), GIF, APNG, PNG/JPEG/SVG frames, and editable `.piv`/`.stk`.
- **27 interface languages**, light and dark themes, a touch interface for phones and tablets.

Everything (decoding, editing, saving and rendering) runs locally. Optional, consent-based diagnostics are described in [docs/telemetry.md](docs/telemetry.md).

## Get StykAnimate

- **Windows and Linux:** download Setup, Portable or the AppImage from the [releases page](https://github.com/filippocalippo/styk-animate-releases/releases/latest). Installed apps update themselves.
- **Browser:** open [app.stykanimate.com](https://app.stykanimate.com). It works offline once loaded.

## Build from source

Requirements: Node.js 22+ (CI uses 24.11) and Python 3.11+ (CI uses 3.12). Windows and Linux are tested on every change; macOS has an untested build target.

```sh
npm ci
python -m pip install -r backend/requirements-fast.txt
npm start            # desktop app (Electron)
npm run serve        # or the editor in your browser at http://127.0.0.1:47831
```

Set `STYK_PYTHON` to choose a Python interpreter. Optional native helpers speed up large imports (`npm run build:frame-scan`); the Python fallbacks always work.

Packaging, on the matching operating system:

```sh
python -m pip install -r scripts/requirements-build.txt
npm run build:sidecar
npm run pack && npm run verify:package
npm run dist:win     # or dist:linux, dist:mac
```

The browser build: `npm run web:build`, then `npm run web:preview`. See [Web build](docs/WEB.md), [Linux](docs/LINUX.md) and [Touch interface](docs/TOUCH.md).

## Tests

```sh
npm run check        # syntax, stylesheet lint
npm test             # unit tests
python -m unittest discover -s backend -p "test_*.py"
```

Browser tests (`tests/*.browser.mjs`) run against `npm run serve` with Chrome or Playwright Chromium, for example `node tests/timeline.browser.mjs`. Some tests read a local corpus of Pivot projects that is not distributed; they skip and name the missing file. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) shows what runs on every pull request.

## How the code is organized

| Location | Responsibility |
| --- | --- |
| `src/editor*.mjs`, `src/pivot/` | Document model, commands, undo/redo, rigs, native evaluation and validation |
| `src/renderer*.mjs`, `src/prepared-frames.mjs` | WebGPU rendering, incremental edits, GPU playback packets |
| `src/playback*.mjs`, `src/document-transport.mjs` | Worker evaluation, playback caches, bounded document snapshots |
| `src/import-*.mjs`, `backend/`, `codecs/`, `native/` | Pivot and Stick Nodes decoding, the Python codec service, native helpers |
| `src/document-export*.mjs`, `src/image-*.mjs`, `src/video-export.mjs` | Saving, recovery and image/video export |
| `src/app.mjs`, `src/shell/`, `src/ui/`, `src/styles/` | Interface, workspaces, timelines and styles |
| `src/locales/`, `src/localization*.mjs` | Translations |
| `desktop/` | Electron main process, preload bridge, file access, updates |
| `web/` | Browser build: service worker and Cloudflare configuration |
| `tests/`, `scripts/` | Tests, smoke tests, benchmarks, build and release scripts |
| `docs/` | Feature contracts and architecture |

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Feature behavior is documented in `docs/`, for example [the timeline](docs/TIMELINE.md), [scene editing](docs/SCENE-EDITING.md) and [the renderer](docs/renderer.md).

## Contributing

Bug reports, ideas, translations and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

StykAnimate is free software: you can redistribute it and/or modify it under the terms of the [CC0](LICENSE), version 3 or (at your option) any later version. Bundled third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Trademarks

The StykAnimate name and logo identify the official project. The CC0 lets you fork and redistribute the code, but please give modified versions a different name and icon so people can tell them apart from official releases.

StykAnimate is an independent project. It is not affiliated with or endorsed by Pivot Animator or Stick Nodes; those names are used only to describe file compatibility.
