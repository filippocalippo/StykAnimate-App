# Linux support

StykAnimate develops and ships for Windows and Linux from one source tree. A
change is not done until it works on both; CI runs the unit suite on both.
Apple Silicon Macs build a local app as described in [macOS support](MACOS.md).

## GPU (WebGPU)

Electron's Chromium does not enable WebGPU on Linux by default. Without help the
editor would report "No compatible WebGPU adapter" and use the Canvas 2D
compatibility renderer on a capable GPU. `desktop/gpu-switches.cjs` adds the
Vulkan feature and the WebGPU opt-in on Linux before Electron starts, merging any
`--enable-features` given on the command line. Windows and macOS are unchanged.

On a Wayland desktop with XWayland available, ordinary startup automatically
relaunches through X11 so the window can display Vulkan-backed content. No extra
flags are needed for `npm start` or the packaged app. An explicit
`--ozone-platform` launch argument takes precedence; Electron's internally
selected platform does not. `STYK_WAYLAND=1` keeps native Wayland; combine it
with `STYK_GPU_UNSAFE=0` to use the compatibility renderer.

- `STYK_GPU_UNSAFE=0` leaves Chromium's own driver allowlist untouched (use it to
  diagnose a driver problem; the app then uses the compatibility renderer).
- `STYK_GPU_UNSAFE=1` forces the WebGPU opt-in on any platform.
- The renderer still rejects software adapters (SwiftShader) and falls back to
  Canvas 2D, so a machine without a working Vulkan driver edits and plays back
  correctly, only more slowly. Virtual displays such as Xvfb have no GPU.

Verified on NVIDIA (proprietary driver) under Wayland. Mesa (Intel/AMD) uses the
same switches but has not been verified here.

## Build and package

```bash
npm ci
uv venv .venv --python 3.12.9          # or: python3.12 -m venv .venv
uv pip install --python .venv/bin/python -r scripts/requirements-build.txt
npm run build:frame-scan               # needs a C++17 compiler (g++ or clang)
npm run build:sidecar                  # freezes the Pivot codec with PyInstaller
npm run verify:sidecar
npm run build:video-encoder            # stages the bundled ffmpeg
version=$(node -p 'require("./package.json").version')
npm run dist:linux -- --x64 --publish never "--config.directories.output=release/$version"
npm run release:verify -- "release/$version" --platform=linux
```

The `build:*` scripts run through `scripts/run-python.mjs`, which uses
`STYK_PYTHON`, then the repository `.venv`, then `python3`/`python`, so a bare
`python` is not required. The native scanner builds into
`native/bin/linux-x64/` (untracked); Windows keeps its tracked
`native/bin/x64/`, so a Linux build never dirties or breaks the Windows one.

### AppImage and the Chromium sandbox

`package.json` selects electron-builder's static-runtime AppImage toolset
(`toolsets.appimage`, currently a beta). Its launcher adds `--no-sandbox` only
when user namespaces are unavailable, and the desktop entry carries no
`--no-sandbox`. The default legacy toolset put `--no-sandbox` in the desktop entry
unconditionally, disabling the renderer sandbox whenever the app was started from
a menu or file association. The static runtime also needs no `libfuse2`, which
recent Ubuntu releases no longer install. On systems that restrict unprivileged
user namespaces (Ubuntu 24.04+ AppArmor) without a profile for the app, the
launcher falls back to `--no-sandbox` rather than failing to start.

The desktop entry registers the document types (`.styk`, `.stkz`, `.stykmov`,
`.piv`, `.stk`, `.nodes`, `.nodemc`, `.stknds`) and the `stykanimate://` scheme,
and `StartupWMClass=stykanimate` groups the window under its launcher.
Passing a document path on the command line opens it.

The coordinated release workflow publishes the AppImage and `latest-linux.yml`
alongside the Windows files. Starting with the next release after 1.2.0, a writable
AppImage checks for updates, downloads them and offers **Restart to update** with
the usual save/cancel prompt. Keep it in a writable folder such as `~/Applications`.
Updates replace the same filename atomically, so existing launchers still work.
Projects and preferences live outside the AppImage. Version 1.2.0 users need one
manual download of the first updater-enabled release. See [updates](UPDATES.md).

## Testing on Linux

```bash
npm run check && npm test                          # unit tests (also on Windows in CI)
python3 -m unittest discover -s backend -p "test_*.py"
npx playwright install chromium                    # once, for the browser tests
npm run serve &                                    # the codec and dev host on :47831
STYK_URL=http://127.0.0.1:47831 node tests/timeline.browser.mjs
xvfb-run -a npm run test:boot                      # boots the app from source
xvfb-run -a npm run test:boot:packaged             # boots release/linux-unpacked
npm run test:web                                   # the web build, end to end
```

Browser and Electron tests import `chromium` and `_electron` from
`tests/support/playwright.mjs`, which is where launch policy lives: installed
Chrome is used when present and Playwright's Chromium otherwise, and Electron
launches drop `ELECTRON_RUN_AS_NODE`
(terminals started by another Electron app, such as VS Code, export it, and
Electron then runs the app as plain Node where `app` is undefined). Overrides:
`STYK_BROWSER_PATH`, `STYK_BROWSER_CHANNEL`, `STYK_BROWSER_GPU=1`.

Browsers Playwright launches run the editor's Canvas 2D renderer on Linux by default:
its output can be read back reliably. `STYK_BROWSER_GPU=1` adds the Vulkan/WebGPU
switches, which gives the editor a real WebGPU device. Many renderer tests need a
device (`renderer.device`, `queue`) and only run that way; a few pixel tests need
the Canvas 2D output. On the development machine (Chromium 153 from Playwright
1.63, NVIDIA, Wayland) the full browser suite of 289 scripts passes 131 by default
and about 150 with `STYK_BROWSER_GPU=1`. The failures are not new: run with the GPU
switches, 140 of the 146 scripts that failed had exactly the same outcome on the original
code (commit 8ff66d5); of the other six, four hard-code a port only the comparison
server occupied, one was a timing flake and one now passes. They need private samples, the
lab server or another port, need WebGPU, or no longer match the interface.

Known limit of that Chromium build: with WebGPU active, the editor submits its draws
(2 draw calls, 11 primitives, no validation errors, no lost device) but the canvas is
never displayed, so screenshots and readbacks are empty. A five-line page that only
clears a WebGPU canvas does display, with `--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan
--use-angle=vulkan`, so it is specific to this browser, driver and content, not to the
canvas usage flags or to the editor's validation. Electron 39's Chromium 142 displays
the same editor correctly with the app's own switches and with those extra ones
(identical figure pixels in all three configurations), and that is what ships. If a
future Electron shows an empty canvas on Linux, start with the extra flags above on the
command line (they are merged with the app's) and Settings → Graphics mode → Canvas 2D.

Many profiling scripts need private sample projects. `corpusPath()` finds them under
your home directory (`Downloads/…`) or in the folder `STYK_CORPUS_DIR` names, and a
missing file fails at once with that instruction. Tests that need the Pivot sample
corpus beside the repository skip with the reason unless it is there or
`STYK_REQUIRE_FIXTURES=1`.

Known gaps on Linux, all outside the shipping editor's runtime: a share of
the `tests/*.browser.mjs` scripts are not run by CI and no longer match the current
interface on any platform.

## Shutdown and processes

The desktop app keeps a pipe on the codec's stdin and the codec exits at EOF
(`--exit-on-stdin-close`), so a crash, `kill -9` or out-of-memory kill of the
editor never leaves the codec running with its caches. Normal quit and SIGTERM
stop it through Electron's quit handlers as before.

## Why WebGPU is on by default

Before `desktop/gpu-switches.cjs`, Electron on Linux found no WebGPU adapter and the
editor used the Canvas 2D compatibility renderer. `scripts/benchmark-synthetic-scene.mjs`
measures the difference with no private files: it clones the startup figure into a
dense scene and zooms it through the app's own Ctrl+wheel handler, so every frame
redraws the whole scene. Median of three runs, 4 s each, real desktop app on
Wayland (AMD Ryzen 5 5500, NVIDIA RTX 4070 SUPER, 144 Hz display):

| Scene | Renderer | Frames/s | 95th percentile frame | Worst frame |
| --- | --- | --- | --- | --- |
| 300 figures | WebGPU | 141.8 | 7.0 ms | 14.0 ms |
| 300 figures | Canvas 2D | 19.7 | 61.5 ms | 69.5 ms |
| 1500 figures | WebGPU | 89.3 | 16.0 ms | 27.8 ms |
| 1500 figures | Canvas 2D | 4.7 | 299 ms | 299 ms |

The 300-figure WebGPU row is the display's refresh rate, not the renderer's limit.
One machine and one driver: treat the ratio as indicative. If a driver initialises
WebGPU but cannot present it, Settings → Graphics mode → Canvas 2D (or
`STYK_GPU_UNSAFE=0`) restores the compatibility renderer.
