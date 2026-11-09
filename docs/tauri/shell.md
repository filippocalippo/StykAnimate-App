# The desktop shell (Tauri)

The desktop app is `engine/crates/styk-desktop`, a Tauri 2 crate in the engine workspace. It opens today's web
interface in a WebView2 window and answers the page's privileged calls. This page covers area 1: the crate's layout,
the web host, the bridge, the window, links and second launches, updates and packaging. The decision and the IPC
inventory are in [README.md](README.md); the move for existing users is in
[updater-migration.md](updater-migration.md).

## Layout

| Path | What it is |
|---|---|
| `src/lib.rs` | `run()`: calls `shell::register`, `files::register`, `services::register`, and nothing else per area |
| `src/registry.rs` | `Desktop`: the Tauri builder plus each area's commands (`commands![...]`), state and start-up work; joins the areas' commands into Tauri's single handler |
| `src/shell/` | area 1: window, web host, links, single instance, GPU switches, updates, release notes |
| `src/files/`, `src/services/` | areas 2 and 3 |
| `capabilities/main.json` | the page's permissions: exactly the app's commands (`allow-<command>`), plus listening to events |
| `build.rs` | declares exactly the commands `capabilities/main.json` allows, so an unlisted command cannot be called |
| `tauri.conf.json` | identity (`app.stykanimate.desktop`), bundle, file associations, updater feed and public key |
| `windows/installer-hooks.nsh` | removes an Electron copy before installing, creates `Documents\StykAnimate\library`, restarts after an Electron-driven update |

A unit test (`capabilities_allow_exactly_the_registered_commands`) fails when a command is registered but not
allowed, or allowed but not registered. An area adds a command in three places: its module's `commands![...]`, its
section of `capabilities/main.json`, and its section of `src/desktop-bridge.mjs`.

Area state goes in Tauri's managed state (`desktop.builder(|b| b.manage(...))` or `app.manage` in
`desktop.setup`). `app.state::<shell::Shell>()` gives every area the user-data folder (`user_data`, where the
Electron app kept it), this process's folder (`instance_dir`), whether the copy is `packaged`, the document state and
three hooks: `set_open_file` (area 2 reads a file opened from outside for `styk:file-opened`), `on_page_start` (the
page is loading again: its old documents can no longer be written) and `on_before_quit` (flush before exit or an
update). Errors the page shows are `shell::Failure`: the message in the current language and its `messageKey`.

## Build and run

```
npm run engine:build                                   # the engine's WebAssembly, once
cd engine && cargo run -p styk-desktop                 # development copy: pages from the source tree
node scripts/tauri-build.mjs --exe                     # shipping executable, engine/target/release/StykAnimate.exe
node scripts/tauri-build.mjs                           # Setup, Portable, latest.json, latest.yml in release/<version>/
node scripts/tauri-build.mjs --developer               # the same with the WebView2 inspector on
```

A **development copy** (`cargo run`, no `custom-protocol` feature) serves the page from the source tree, as
`electron .` did: `STYK_BUNDLE_DIR` lays an app bundle over the modules, and `.desktop-data` in the source tree is
the profile unless `STYK_USER_DATA_DIR` names another. A **packaged** build (`tauri build`) embeds the staged pages
(`build/tauri-web`, made by `scripts/tauri-stage-web.mjs` with the bundle laid over) and uses `%APPDATA%\StykAnimate`.

**Developer build versus shipping build.** The cargo feature `devtools` (`--developer`) turns on the WebView2
inspector (`STYK_DEVTOOLS=1` opens it at start) and lets `STYK_REMOTE_DEBUGGING_PORT` open the DevTools port the
smokes drive. Debug builds have both too. The shipping build has neither: no inspector, no port. Area 5's tools hang
off the same feature.

## The web host

`styk-app` is the window's own origin, answered in `shell/web_host.rs` with today's rules from `web-host.cjs`: GET
and HEAD only; the page's own files (`index.html`, root styles and images, `src`, `vendor`, `assets`, and in a
development copy `tests` and `artifacts`); nothing hidden, no drive letters or backslashes, only the types the page
loads; ETags and 304s. WebView2 sees it as `http://styk-app.localhost/`, a secure context. Every answer carries COOP
`same-origin`, COEP `require-corp` and CORP `same-origin`, so the page is cross-origin isolated and the engine runs
its threads. The bridge reports `crossOriginIsolated`, `SharedArrayBuffer` and the WebGPU adapter at start
(`startup_report`); a packaged copy that is not isolated says so in a dialog instead of running on the no-worker
fallback.

## The bridge

`src/desktop-bridge.mjs` defines `window.stykDesktop` with exactly preload's names, arguments and answers, over
`invoke` and `listen`. The window injects it before the page's own scripts, after `window.__STYK_BOOT__` (the values
preload gave synchronously: `platform`, `memoryBytes`, `startupView`). It is a plain script (no imports), so it runs
as an initialization script and does nothing in a browser. Errors reject as `Error` objects with the native message
and `messageKey`. `pageListening()` waits until every listener the page registered is on before it asks the native
side to send what it held (shell/pushes.rs, the port of page-pushes.cjs). The title bar's `-webkit-app-region: drag`
areas are the window's caption: WebView2's non-client region support (on in wry) moves, snaps and maximizes it.

## Window, links and second launches

- The window is frameless on Windows (the page draws its title bar and buttons), 1560 × 1000 by default, at least
  1000 × 680. Its place is kept in `window-state.json` in the user-data folder (normal bounds in physical pixels, the
  monitor's scale, maximized), and used next time only when a monitor still shows its title bar; otherwise the
  window opens centred. The Electron app kept no window place, so there is nothing to read from it.
- `STYK_BACKGROUND_WINDOW=1` opens it off-screen, without focus, out of the taskbar, and keeps it drawing there.
- Closing with unsaved work asks Save, Discard or Cancel (one project by name, several by count); Save sends
  `save-and-close` to the page. `window` with a stale checkpoint is refused, as today.
- **Single instance.** The first process per profile owns a named pipe (`\\.\pipe\StykAnimate-<profile hash>`); as
  with Electron, every later ordinary launch still opens its own window and project (with a `workspaces/<pid>`
  folder for its recovery copies and browser storage), and only `stykanimate://` links go to the first window. A
  launch with a file opens that file in its window. `new_window` starts such a process.
- `stykanimate://open`, `privacy`, `library` and `library/<public id>` are accepted, as today. A packaged first
  process registers itself as the handler for the current user (as `setAsDefaultProtocolClient` did).
- File associations are the Electron app's: the same extensions, names (ProgIDs) and roles, in `tauri.conf.json`.
- GPU switches: WebView2 enables WebGPU through D3D12 with no opt-in (`STYK_GPU_UNSAFE=1` adds it). Its sandboxed GPU
  process cannot load the runtime's `dxcompiler.dll` (the runtime ships no `dxil.dll`; error 87, no WebGPU device), so
  the app passes `--disable-dawn-features=use_dxc` and Dawn compiles shaders with FXC, sandbox kept on (`shell/gpu.rs`;
  `STYK_GPU_DXC=1` keeps DXC). Development builds also take `STYK_EXTRA_BROWSER_ARGS` for diagnosis.

## Updates

`shell/updates.rs` keeps electron-updater's behaviour on `tauri-plugin-updater`: installed copies check 10 s after
start and hourly; a newer stable version is downloaded and its minisign signature verified; it installs only on
Restart to update, after the unsaved-work question; development, portable and not-installed copies report why they
do not update. The feed is `latest.json` on the same GitHub releases (`.../releases/latest/download/latest.json`).
`scripts/tauri-build.mjs` writes it, and `latest.yml` for Electron copies.

## Test hooks and smokes

`tests/support/tauri-app.mjs` launches the app with a DevTools port and drives the page with Playwright, with the
`launch`/`firstWindow`/`close` surface the Electron smokes used. There is no main process to evaluate code in: a
smoke that stubbed Electron's dialogs needs a native hook from the area that owns the dialog. Smokes ported so far:
`smoke-boot`, `smoke-launch-link`, `smoke-updates` (area 1's).
