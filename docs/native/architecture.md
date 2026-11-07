# The native app: architecture

StykAnimate becomes one native Rust program per platform: the engine running natively, an iced interface, no Electron,
no Chromium and no Node at runtime. This page is the target the port builds toward; [README.md](README.md) holds the
plan, the Handoff and where the work stands, and [decisions/](decisions/) the reasons.

## Crates

Everything is one Cargo workspace (`engine/`, members `engine/crates/*`). The engine crates keep their boundaries
([../engine/README.md](../engine/README.md)). The app adds:

| Crate | Owns | Depends on |
| --- | --- | --- |
| `styk-trace` | The instrumentation layer: `span!`, `counter!`, `mark!` macros. With its `enabled` feature off (the release build) they compile to nothing; on, they feed a small ring buffer of recent spans and, when a tool asks, `tracing` subscribers (Perfetto, Tracy). | nothing when off |
| `styk-services` | The platform service traits and their plain data types: files, dialogs, clipboard, fonts, storage, recovery, updates, audio output, video encoding, image codecs, telemetry, support, shell (single instance, protocol, associations, window state), input devices, network. Test fakes for each. No OS code. | std |
| `styk-platform` | The implementations of `styk-services` per target: `windows/`, `macos/`, `linux/`, `web/`. | `styk-services`, OS crates |
| `styk-core` | The application core, plain Rust, no toolkit: app and view state (documents, tabs, selection, tools, playhead, panels), every command and shortcut and undo grouping, the docking layout model and its solver, settings, the view models panels display, the stage's view (zoom, pan, hit-testing, drag sessions), frame scheduling, the automation mode. | engine crates, `styk-services`, `styk-trace` |
| `styk-design` | The design system: tokens (both themes), icons, bundled fonts (Inter, Inter Tight), and the shared iced widgets in their every state. Generates the CSS custom properties, the SVG sprite and the component sheet for the design studio. | iced and `styk-core` for shared focus and field state (behind `widgets`) |
| `styk-ui` | The iced front end: lays out and draws what the core holds and turns input into core commands. Shell, docking widgets, stage, timeline, inspector, panels, dialogs, Home, Settings, drawing, build, text input. | `styk-core`, `styk-design`, iced |
| `styk-devtools` | The developer tools ([devtools.md](devtools.md)). Compiled only with the app's `devtools` feature. | `styk-core`, `styk-ui`, `styk-design`, `styk-trace` |
| `styk-app` | The binary `stykanimate`: command line, startup, wiring of platform services into the core, the window. Feature `devtools`. | everything above |
| `styk-cli` | The headless tools (`styk` binary); its `video` command (feature `app-tools`, off by default) drives a video export of a document through the core's planning and flow, the engine's frame source and the platform's encoder services. `cargo xtask deps` lets it reach `styk-core`, `styk-services` and `styk-platform` only through that feature. | engine crates; `styk-core`, `styk-services`, `styk-platform` with `app-tools` |
| `xtask` | The task runner (`cargo xtask ...`, alias in the repository's `.cargo/config.toml`). | std |

Dependencies point one way: `styk-app` → `styk-ui` → `styk-core` → engine crates and `styk-services`. Nothing in the
engine or the core depends on iced, `styk-ui` or `styk-devtools`. A different front end (a touch layout, Slint, a newer
toolkit) sits on `styk-core` without rewriting a feature; the core's features are tested without a window.

## One owner per concern

- **The document and its history** live in `styk-edit` sessions, one per project tab and one per movieclip entered,
  called directly in Rust by `styk_core::documents`. There is no read view, no JSON patch and no second copy of the
  document: the interface reads the session through narrow queries (`styk-edit`'s and `styk-eval`'s typed views) and
  view models the core builds from them, cached by document revision.
  The first implemented panel seam and its worker-prepared session handoff are in [documents.md](documents.md).
- **View state** (selection, tools, playhead, layer focus, panels, zoom and pan) lives in `styk-core`. It is sent to
  the session with each call as the JavaScript editor sends it today.
- **Commands.** Every user action is a `styk_core::Command`. Shortcuts, menus, the command palette, buttons and the
  automation mode all produce commands; one registry names them, gives their labels, shortcuts and enabled state. Undo
  grouping is the core's: a gesture is one history entry.
- **Arrangement.** The docking layout model is the only owner of where panels are; its solver fits it to the window
  and the screens. Panels never place themselves ([docking.md](docking.md)).
- **Settings** are typed records in the core, read and written through `styk-services::storage`. Today's settings,
  recovery files, project library and recent files are imported on first launch.

## The iced boundary

The UI follows iced's model: `update(Message)` maps the message to `core.dispatch(Command)` (or to a view-only change in
the UI's own widget state, such as a hover), and the core answers with effects (open a dialog, start a job, request a
frame) that the UI turns into iced tasks. `view` reads the core's state and view models and never computes a feature.
Widget state that iced keeps (text cursors, scroll offsets) stays in iced; anything a feature depends on is the core's.

iced is vendored under `vendor/iced` at one revision, with its pre-release git dependencies (`winit`, `cryoglyph`,
`cosmic-text`) beside it, patched in by path ([decisions/0002](decisions/0002-vendored-iced.md)). iced and the engine
use the same wgpu at all times.

## Threads (D7 holds)

The interface thread runs iced's event loop, the core's `dispatch` and the view. It never waits on a worker.

- **Frames**: `styk_core::frames` asks for frames by (document, revision, tick, view) from a pool of worker threads:
  evaluate (`styk-eval`), geometry, draw list (`styk_eval::drawlist`). One frame of a huge scene splits across threads,
  and unchanged parts are reused (`build_remembering_plain_over`, the draw-list run cache). Results carry the revision
  they were made for; stale ones are dropped. The frame cache is bounded by bytes and keyed by revision.
- **Jobs**: opening, saving, autosave, picture decoding, exports, thumbnails and previews run as `styk-engine` jobs on
  worker threads, with bounded queues and cancellation.
- **Audio** has its own output thread; **input** from the pen arrives on the event loop with its timestamps.

## One GPU device

The stage is an iced `shader` widget on iced's own wgpu device: `styk_render::Renderer` renders into its frame in
`prepare`, and `present` draws it into iced's pass, with no copy and no second device. Onion skins, thumbnails,
timeline previews, the camera monitor and drawing use the engine's renderers on the same device. GPU caches are bounded
by bytes and released by resource lifetime; pictures are paged with the engine's residency, never all uploaded at once.
The drag split (the frame cut into what is below and above the dragged figure, only that figure rebuilt per move)
becomes an engine feature used by dragging, drawing over heavy scenes and previews.

The device comes from `styk_render::native_gpu`: on Windows DX12 with the FXC shader compiler preferred, falling back to
the other backends when it cannot be had (an explicit `WGPU_BACKEND` is the only attempt), the backend whose frames match Chromium's bit for bit on pictures and translucent fills ([frame-parity.md](frame-parity.md));
the shell creates iced's compositor from that choice, so the stage, previews and exports draw on one backend. The web
build keeps the browser's WebGPU.

## The automation mode and the benchmark

`stykanimate --automation <script>` runs a script of timestamped steps (commands, pointer and pen samples at stage
coordinates, keys, waits, measurements, screenshots) against the real app, through the same core commands the
interface sends. `--clock fixed` and fixed seeds make runs deterministic. The benchmark scenarios are such scripts; the
same scripts run headless through `styk-cli` where no window is needed. There is no benchmark-only branch in normal paths.

`STYK_BACKGROUND_WINDOW=1` opens every window off-screen, without focus and without a taskbar entry. Screenshots of a
window are taken with PrintWindow (Windows) by the app itself or by `xtask`, never from the screen.

## Builds

Run from the repository root (`cargo xtask` also works from `engine/`); the workspace is `engine/Cargo.toml`.

- **Release** (`cargo build --manifest-path engine/Cargo.toml --release -p styk-app`): what ships and what is measured; no
  developer tools, no symbols of `styk-devtools`, instrumentation compiled to nothing.
- **Developer** (`--features devtools`, same optimisation as release): the tools, the control channel, live parameters.
- **Quick** (`--profile quick`): incremental, optimised dependencies; for iterating, never measured. A one-line change
  rebuilds in about 3 to 4 seconds. Linking with `rust-lld` (`CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=rust-lld.exe`) saves
  about a second of that and works, but it is an opt-in, not the repository default: changing the linker makes cargo
  rebuild every crate of a target folder once, which would cost every other build on a shared machine.
- **Tasks** (`cargo xtask check`): `design check` (generated tokens and icons are current; see
  [design-system.md](design-system.md)), `deps` (the engine and the core reach no iced, `styk-ui` or `styk-devtools`) and
  `lock` (`engine/Cargo.lock` holds no git source). `cargo xtask fonts` is the typography check against Chromium
  ([typography.md](typography.md)); it needs a GPU and Chromium, so it is not part of `check`.
- **Unattended runs**: `STYK_BACKGROUND_WINDOW=1 stykanimate --screenshot out.png` keeps the run off the desktop of
  the person at the computer, as far as each platform allows (`styk_platform::unattended`), waits for the first complete
  frame, writes it and exits:

  | Platform | What it does |
  | --- | --- |
  | Windows | Window created hidden and off-screen, shown without activation as a tool window: no focus, no taskbar button. Captured with PrintWindow. |
  | Linux, X11 | Override-redirect window, off-screen: the window manager never sees it, so no focus and no taskbar entry. Captured from iced's renderer. |
  | Linux, Wayland | No window. A compositor ignores the requested position, so the interface is drawn offscreen by the same renderer. |
  | macOS | No window: the system activates an application as it opens its first window, and AppKit keeps windows on a screen. Drawn offscreen. |

  `STYK_BACKGROUND_WINDOW=headless` draws offscreen on every platform. Any other value is an error, so a typo cannot open a
  window. A run with no window needs `--screenshot` (or, later, `--automation`) to produce anything.

`npm run engine:test` leaves out the iced crates (`styk-app`, `styk-ui`, `styk-devtools`) so the engine suites stay
fast; test those with `cargo test --release -p styk-app -p styk-ui`.

## Platforms

This phase ships and verifies Windows only ([N8](decisions/0008-windows-only-review-by-risk.md)). macOS, Linux, the web
build and mobile come later as ports, not rewrites: every OS call is behind a `styk-platform` trait, no Windows type or
`cfg(windows)` appears outside `styk-platform`, no threading or file assumption only Windows allows, the GPU only through
wgpu, and nothing in the core or the engine that a wasm32 or Unix target could not build (a `cargo check` for wasm32 at
gates). Input, layout tiers and platform services stay behind traits a touch build can implement
([../TOUCH.md](../TOUCH.md)). Constraints found for the web build are in `web.md`.

## The automatic guards

`cargo xtask check` checks generated design files, the Cargo metadata dependency graph (all features and targets),
registry package users against `engine/deps-allow.toml`, and production Rust tokens for Windows code outside
`styk-platform`. Frozen evidence, `tests/` and `benches/` are excluded by path; `cfg(test)` items are skipped.
A separate test module is exempt only when its module declaration requires `test`, never because of its filename.
Feature-gated test helpers live under `tests/support/` and cannot be enabled by production dependencies.
The dependency allow list requires its ownership header and must equal its version at the merge base with
`native-app`: the orchestrator approves changes at the merge, including the initial baseline. Core state in shared
design widgets is allowed; UI and developer-tool views cannot use direct engine paths or `styk_core::engine`.
Platform public re-exports and type aliases cannot expose Windows items. These are textual checks, not a type resolver.
The existing non-default CLI `app-tools` boundary remains.
`cargo test --manifest-path engine/Cargo.toml -p xtask --test native_guards` runs the violating fixtures, including
a real scratch-crate Clippy check and the screenshot failure path, through the existing Node prerequisite.

Clippy checks the app, UI, developer tools, design widgets and the diagnostic library for unwrap/expect, ignored
results, file I/O and blocking calls using `engine/guard-clippy/clippy.toml`. A source scan also catches unwrap/expect
inside local macro bodies. Tests may unwrap. File handles and synchronous receivers are forbidden types; trait
Read/Write methods and receiver iterators are forbidden calls. Device polling is conservatively disallowed
in these interfaces, even for non-wait polls. Design font warm-up is outside the widget-module guard, but starts
through the injected `Spawner` and returns failures. The pen pad state belongs to core; its scripted diagnostic
workload belongs to `styk-text-check`, injected into the developer tool through the core probe protocol.
The probe submits to a bounded worker mailbox through `Spawner` and returns completion messages. Only named task
functions in its private worker module allow blocking I/O and waits; its start/submit entry points retain the interface
lints. Analysis, feeder waits, Behaviour's 800 ms pause and report/CSV writes run there; write and spawn failures reach
the interface. The named platform `disturb_blocked_probe` is the sole
intentional interface sleep, requested only by the explicit Blocked self-test. Capture encoding/writes remain in
the asynchronous platform diagnostic service. The worker never joins on the interface thread.

The web constraint guard rejects direct thread spawning and wall/monotonic clock construction in portable libraries,
including qualified clock paths and same-file clock aliases.
Text jobs use `Spawner`; closing cancels and wakes the worker without joining the interface thread. The production
clock lives in platform; services exposes a real-time clock only behind its explicit `test-fakes` feature for tests.
The document crate's `StdThreads` is likewise a test fake: only dev-dependencies may enable `test-fakes`.
Named native exceptions in the guard must also be inside `cfg(not(target_arch = "wasm32"))`: the export GPU disposal
and wait helpers (web drops in place and uses mapping callbacks), and the optional edit profiler (web has no-op
scope/take). Host binaries, tracing and standalone test modules are outside this portable-library rule.
The renderer receives the platform choice from its caller; it does not inspect Windows configuration itself.

`docs/native/screens/limits.toml` names reference captures from today's app, dimensions and the maximum fraction of
pixels with any RGBA channel difference. The screen IDs come from the catalogue's `id()` function. Missing reference
assignments are reported; assigned but missing images, dimension differences and exceeded limits fail. When a
reference exists, the guard renders through `stykanimate --screen` in headless mode and uses `styk image-diff`.
No window opens, no reference is generated or updated, and no threshold is inferred from the result.

`cargo xtask check --wasm` additionally checks `styk-wasm` (and its engine dependencies), core and services for
`wasm32-unknown-unknown`, with `check --profile wasm-dev`. It shares the pinned nightly, `-Z build-std=std,panic_abort`
and atomics flags with `engine-build.mjs` through `engine-wasm-config.mjs`; the cache is `engine/target/wasm-threads`.
The guard neither imports the executable builder nor installs a toolchain or target. It propagates compiler failures.
This is an optional gate, not part of an implementer's Windows verification; native tools and views are excluded.
