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
| `styk-design` | The design system: tokens (both themes), icons, bundled fonts (Inter, Inter Tight), and the shared iced widgets in their every state. Generates the CSS custom properties, the SVG sprite and the component sheet for the design studio. | iced (widgets only behind its `widgets` feature) |
| `styk-ui` | The iced front end: lays out and draws what the core holds and turns input into core commands. Shell, docking widgets, stage, timeline, inspector, panels, dialogs, Home, Settings, drawing, build, text input. | `styk-core`, `styk-design`, iced |
| `styk-devtools` | The developer tools ([devtools.md](devtools.md)). Compiled only with the app's `devtools` feature. | `styk-core`, `styk-ui`, `styk-design`, `styk-trace` |
| `styk-app` | The binary `stykanimate`: command line, startup, wiring of platform services into the core, the window. Feature `devtools`. | everything above |
| `xtask` | The task runner (`cargo xtask ...`, alias in the repository's `.cargo/config.toml`). | std |

Dependencies point one way: `styk-app` → `styk-ui` → `styk-core` → engine crates and `styk-services`. Nothing in the
engine or the core depends on iced, `styk-ui` or `styk-devtools`. A different front end (a touch layout, Slint, a newer
toolkit) sits on `styk-core` without rewriting a feature; the core's features are tested without a window.

## One owner per concern

- **The document and its history** live in `styk-edit` sessions, one per project tab and one per movieclip entered,
  called directly in Rust by `styk_core::documents`. There is no read view, no JSON patch and no second copy of the
  document: the interface reads the session through narrow queries (`styk-edit`'s and `styk-eval`'s typed views) and
  view models the core builds from them, cached by document revision.
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

## The automation mode and the benchmark

`stykanimate --automation <script>` runs a script of timestamped steps (commands, pointer and pen samples at stage
coordinates, keys, waits, measurements, screenshots) against the real app, through the same core commands the
interface sends. `--clock fixed` and fixed seeds make runs deterministic. The benchmark scenarios are such scripts; the
same scripts run headless through `styk-cli` where no window is needed. There is no benchmark-only branch in normal paths.

`STYK_BACKGROUND_WINDOW=1` opens every window off-screen, without focus and without a taskbar entry. Screenshots of a
window are taken with PrintWindow (Windows) by the app itself or by `xtask`, never from the screen.

## Builds

- **Release** (`cargo build --release -p styk-app`): what ships and what is measured; no developer tools, no symbols of
  `styk-devtools`, instrumentation compiled to nothing.
- **Developer** (`--features devtools`, same optimisation as release): the tools, the control channel, live parameters.
- **Quick** (`--profile quick`): incremental, optimised dependencies, fast linking; for iterating, never measured.

## Platforms

Windows is first-class and packaged. macOS and Linux build and run from the same code in CI and pass the smoke tests.
Mobile is not shipped: input, layout tiers and platform services stay behind traits a touch build can implement
([../TOUCH.md](../TOUCH.md)). The browser editor keeps working at every gate (see the README's platform section for
which web build serves it).
