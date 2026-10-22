# Desktop architecture

StykAnimate separates the editable Pivot document, background work, and presentation. Changing the renderer or transport should not change file semantics or editor commands.

## Document and commands

`startup-document.mjs` supplies Blue for application startup and File → New. Camera, Scene and Layer 1 each contain one constant key at frame 1, held through frame 10. Blue is an ordinary 2D stick figure with ten named joints, a filled circular head, symmetric limbs and slightly bent elbows/knees. Four independent two-bone hand/foot IK controllers start enabled and unpinned, without stretching. `scripts/build-startup-blue.mjs` builds the native lines/circle and configures IK through the editor, generating a synchronous data factory; every new document owns independent editable data without rig setup at startup. STYK/STKZ retain the editable IK controls; Pivot STK/PIV retain ordinary 2D artwork and baked poses, without IK controllers. The Bubble helper and `demo.mjs` remain separate legacy tutorial/test fixtures.

Several projects can be open in one window; one is live in the editor and the others rest as detached editor sessions with their history. See [Project tabs](PROJECT-TABS.md).

The app opens on Home, a page over the workspace with the person's projects (the desktop's project list), Start and the tutorials; it holds no document and steps aside when one comes to the front. Tutorials run in the editor itself on a practice animation, their strip in the stage header. See [Home](HOME.md) and [Tutorials](TUTORIALS.md).

`editor.mjs` and its builder/range extensions operate on native figure IDs, object UIDs, segment record order, joins, media tables, and keyframes. History records affected state. Selection, editor visibility/locks, viewport transforms, and renderer caches are distinct from animation data. Shared definition edits propagate through instances and remain undoable. Rig topology traversals avoid recursive stack growth and repeated full-tree scans.

Build Figure presentation lives in `builder-mode.mjs`, `builder-outliner.mjs`, and `styles/legacy/30-builder-workspace.css`. The side toolbar retains its layout, with Chain pen beside Line; commands use the existing dispatcher. `builder-toolbar.mjs` owns the top bar’s native popover menus: bounded viewport placement, focus return, arrow navigation, type-ahead, and dismissal. Its session-scoped listeners are released on exit; commands continue through the existing delegated dispatcher. The bar exposes its part commands, including two direct flip buttons, and adapts labels to its available width; Test rig and Done sit in the top band, beside a quiet Export. Selection gating and checked menu states remain in the builder controller. `builder-context-menu.mjs` supplies joint, branch, fill and empty-canvas menus shared by canvas and hierarchy right-clicks; the controller bounds targets to the current session and routes fill/branch commands through existing editor methods. Context-menu pages reuse the app menu and restore focus to their source. Build hides the timeline by default; its footer toggle shows it, and the shell remembers the choice with Build's panel arrangement. The outliner is the Structure panel: the shell docks it and sets its width (232px, narrowing to 200px, then a strip whose button opens it as a sheet). The outliner uses iterative hierarchy traversal and fixed 30 px virtual rows, observes viewport resizing, and only replaces row markup when it changes. Canvas selection reveals collapsed ancestors; keyboard navigation and accessible tree state share the same row model. Drag exclusion covers the full descendant set, including malformed cycles.

`src/pivot/` holds the established evaluation, validation, background and geometry semantics. Incremental geometry carries changed object slots without retaining a chain of prior scenes. A live whole-figure drag retains its geometry and changes only per-object GPU translations; the model commits the final coordinates once. Joint/rig edits update affected objects and joined descendants.

Evaluated native segment records also supply the ordered drawable list. Geometry consumers treat these shared records as immutable. Opacity-only frame changes retain exact joints and rebind appearance metadata; renderers can retain opaque group artwork and apply the fade after compositing. Worker packets traverse object groups without flattening the scene. These are derived caches, independent of saved poses and history.

Prepared playback distinguishes worker readiness from GPU readiness. A bounded startup window uploads one packet per animation frame and waits for its GPU queue before advancing. Expensive preparation may increase the window from one tenth to one quarter of a second of animation, capped by the existing core-dependent queue and actual cache residency. Later rendering retains normal cache eviction and exact tick order. Cancelled startup cannot publish a stale queue completion.

Figure insertion, clipboard paste and decoded library drops share the range command planner. Validation and identity allocation finish before publication; undo retains inserted definitions and affected poses rather than the destination library. Published movieclip documents are immutable: clipboard/history copy the figure shell and retain that captured animation. Entering a clip clones its document; committing nested edits publishes a replacement. Imported external documents receive their own copy. Canvas pose commits retain the exact gesture preview when membership and playback settings are unchanged.

Movieclip presence clocks on ordinary layer sheets use a temporary projection containing only instance identities, playback descriptors and continuation records. The existing sheet sampler handles blank spans, remapped native time and frame replacements; the clock never interpolates unrelated joints or builds artwork. The derived index is reused across seeks and invalidated with document edits. Legacy authored channels and inherited movieclip sources retain the general evaluator. `tests/movieclip-membership.test.mjs` compares projected membership with that evaluator and traps reads of unrelated pose arrays.



Native connector and Smart Stretch relationships use the shared geometry evaluator,
an iterative cached dependency plan and sparse editor commands. Connector midpoint
positions reuse length channels; there is no second pose graph. Build Figure owns
setup UI and a detached pose tester. See [rig contracts and verification](RIG-CONSTRAINTS.md).

## Import and native codec

Electron reads selected source files through its isolated bridge. A persistent loopback codec process uses the supplied PIV/STK readers and writers. The app-specific modern reader bulk-unpacks numeric arrays and omits obsolete scalar-edit binding allocations. Optional `orjson` accelerates large response encoding; the standard-library path remains available. This does not replace the binary grammar.

The import worker performs fetch/JSON parsing. `document-transport.mjs` transfers bounded document fragments rather than cloning one entire expanded scene into the UI. Its default packet estimate is 256 KiB with a 3 ms preparation budget and receiver acknowledgments. Large strings, pose arrays and records are split; unknown fields and numeric values remain intact. The same transport supplies playback snapshots and native document exports.

The backend source/document cache has 24 entries and a 384 MiB budget. Source imports are limited to 128 MiB; decoded/native documents to 256 MiB. A native document is retained once because it already contains original source bytes. These are cache/input limits, not a promise that total application working set stays under those values. See [backend contract](../backend/README.md).

## WebGPU and prepared playback

`renderer.mjs` compiles root-local line, circle and polygon records into GPU storage buffers. WGSL performs primitive coverage, color gradients, transforms and clipping. Object translation/opacity/visibility are separate records. Cached compatibility textures preserve complex Pivot compositing at the object boundary, including glyph paths, sprites, outlines and isolated opacity. Supported opaque native outlines stay as vectors at high zoom, retaining compiled geometry across viewport changes and submitting only visible ranges. Other high-zoom artwork is cropped on its original pixel grid before device and memory limits apply, preserving detail without allocating complete magnified figures. `raster-view.mjs` supplies the shared editor/worker crop policy; existing raster caches retain its variants and own their lifetimes. The complete scene is not flattened into one texture.

`playback-worker.mjs` evaluates exact native ticks, compiles typed primitive packets, and rasterizes compatibility objects with OffscreenCanvas. `playback.mjs` and `prepared-frames.mjs` hold bounded CPU and GPU packet LRUs. Their hardware-based retention targets and related pixel-cache allocations are defined in `playback-budget.mjs`; an individual worker packet uses a smaller allowance to leave upload headroom. Each GPU packet uploads once; cached playback binds retained buffers and submits without main-thread scene evaluation or tessellation. Document revisions and resource/device changes invalidate the relevant caches; retained scene geometry is rebuilt for any figure definition a patch replaces, and decoded drawing stores only serve their own revision, so incremental mirror updates never render superseded tiles or bounds. Missing packets hold the transport for preparation rather than silently skipping native output ticks. A crashed playback worker pool is replaced on its next use and reloads the document; one document revision allows two consecutive restarts without a delivered packet, so a scene that reliably crashes the worker reports its error instead of restarting in a loop. Background assets and the editor renderer have separate lifetimes.

Compatibility textures are cropped to the camera-visible stage with a sampling guard, preserving their original pixel grid and individual figure identities. Raster resolution is rounded once, after applying the native camera to the physical viewport scale. Zoom changes update worker view options without retransmitting an unchanged document. Advanced ruler scrubbing keeps one editable preparation in flight through canvas submission and coalesces newer pointer positions to the latest requested tick. The ruler displays the pending pointer target; the editor retains the tick of the scene being prepared. Release forces the exact final seek. Inspector refreshes and thumbnail work wait until scrubbing finishes.

An oversized prepared packet is retried with lower raster detail. The editable renderer also plans its active texture set before allocation; original geometry, handles and image assets remain intact. See [Adaptive preview memory](ADAPTIVE-PREVIEW.md) for source-image copies, cancellation, cache allocations, full-quality export, validation and remaining browser/format limits. A scene that cannot fit even its minimal records or decode through the available runtime can still fail; sampled corpus success does not establish coverage of every frame in a large imported project.

The virtualized timeline draws visible exposures and labels, with a separate playhead. Scrubbing uses cooperative editable geometry and renderer preparation to preserve selection handles and onion skins; frame-local changes can update the playback worker mirror without retransmitting every keyframe. The editor schedules rendering when state changes or playback runs, with no permanent idle rendering loop. See [renderer details and benchmarks](renderer.md).

## Thumbnail worker synchronization

Image-only preview workers use `image-resources.mjs` for encoded sources, crop
selection, decoded variants, byte accounting and disposal. Playback extends
that same image owner with drawing tiles and vector/raster caches in
`playback-resources.mjs`; image decoding does not import the geometry evaluator
or create rendering caches. Diagnostics retain one completed image job, not a
history of requests. `tests/image-resources.browser.mjs` verifies decoding with
the geometry module unavailable, exact pixels, reuse, cancellation and residency.

`thumbnail-renderer.mjs` and playback share the retained-source comparison and
validated patch contract in `playback-patch.mjs`. Unchanged historical poses and
figure definitions remain in the thumbnail worker; edits send source additions,
replacements and deletions with changed native frames and render metadata.
Definition edits explicitly dirty source poses because legacy commands can repair
them in place. Legacy background tables still accompany thumbnail patches.

Transfers are acknowledged in chunks of at most 64 KiB with a 2 ms construction
target. The worker validates the complete patch before publishing it. The main
thread updates its reference mirror only after the matching revision's ACK;
uncertain source IDs survive cancellation, including an edit undone while its
worker commit is awaiting acknowledgement. Pauses resume staged chunks, while
document edits discard stale staging. Replacement documents, native frame topology
changes, worker failures and idle disposal use the full snapshot fallback.
The existing eight-request bound and filmstrip bitmap cache remain the owners of
queued work and displayed previews. Source mirrors clear when their worker dies.
See `tests/thumbnail-patch.test.mjs` and `tests/thumbnail-source-patches.browser.mjs`.

## Saving, recovery and exports

Audio has its own immutable document state, editor commands and bounded mixer
worker. Both timeline views share its clip UI; Web Audio schedules preview and
the existing FFmpeg service muxes an offline mix into video. Prepared scene
snapshots omit recordings. Native project saving retains original audio bytes.
See [Audio architecture and verification](AUDIO.md) for timing, codecs and limits.

`DocumentExporter` receives the live report directly. Calling `editor.serialize()`, `structuredClone(report)`, or `JSON.stringify(report)` first would reintroduce a full UI pause. Bounded snapshots reach a dedicated worker, which normalizes the document, validates it, serializes it, and requests native output. Only derived keyframe-object `runtime_segments` caches are omitted. A revision change or active edit aborts the snapshot; recovery is rescheduled after the next idle period. Native STYK stores original source bytes and digest metadata so unchanged source export remains possible after a backend restart.

The worker returns a Blob. `native-files.mjs` writes or reads it through acknowledged 256 KiB IPC chunks, without whole-file ArrayBuffer/base64 conversion. Desktop main stages output and atomically replaces the destination only after completion. Cancellation preserves the previous file. Recovery uses the fixed desktop profile; browser recovery uses IndexedDB. See [document export contract](document-exports.md).

`ExportFrameRenderer` receives bounded document chunks and evaluates/rasterizes export frames in a worker. Current-frame images, sequences and videos use this shared path, including No smoothing, Smooth edges and supersampled Smooth sprites. SVG retains paths and embedded raster assets. Animation image compression, GIF quantization and ZIP assembly run in an encoding worker with one source frame in flight. Document replacement or cancellation stops the rendering job.

Desktop video streams PNG frames in acknowledged chunks to the bundled FFmpeg encoder. VP9 WebM preserves transparency; MP4/AVI/WMV use Pivot's black matte. The browser has opaque WebCodecs encoders with exact timestamps and local muxers: VP8/VP9 in WebM, and H.264 in MP4 (`mp4-muxer.mjs`) where the browser can encode it. Windows AVI can instead stream BGR24 to isolated 32-bit/64-bit helpers using genuine installed VFW compressors and their configuration dialogs. Capability probing describes the actual provider, codecs, alpha behavior and limits; no hosted encoder is required. See [export formats](EXPORT-FORMATS.md), [image exports](image-exports.md) and [installed Windows codecs](WINDOWS-CODECS.md).

## Workspace and desktop boundary

The top band holds the mark (whose menu holds the application menus), the open projects as tabs, the workspace switch, and undo/redo, Save and Export. The stage header (`src/shell/stage-head.mjs`), the
stage island's first row above `#viewport`, holds the location (the Scene with its size and background
colour) or the active tool's options, the one message, and the view toggles (joints, motion paths, grid,
effects preview; static handles and highlight part in Build), zoom and Fit. Nothing interactive sits inside
`#viewport`.
Figure effects can isolate joined descendants through a render-only container;
see [Effects and connected figures](VFX.md) for scope, draw-order and timing rules.
The left tool rail has a divided stacking group: normal clicks move to front/back,
and Shift-click moves one step. These use the existing selection-order command.
Normal right-click opens a short menu for the hit figure or an empty-stage menu;
clicking a selected figure preserves multi-selection. More figure actions holds
less frequent commands. Shift + right-drag retains joint bending; Held R handle
editing can use the same modified secondary gesture. Escape closes menus and
returns focus, and pointer-down outside dismisses them before another gesture.

Custom HTML/CSS provides compact editable controls, native keyboard/text behavior and a consistent neutral palette. The animation scene uses the custom GPU canvas.

The shell (`src/shell/`) lays the editor out as islands on the window's field: the tool rail centered vertically inside the stage, an optional left dock (Build's Structure), the stage island (the stage header and `#viewport`), the right dock (the Properties, VFX and Library tabs) and the timeline island under them (full width by default). `panel-registry.mjs` describes the panels, `layout-schema.mjs` stores each workspace's arrangement (the rail left or right, the timeline full width or under the stage, and each panel docked on a side, folded to a strip, floating (Properties, VFX, Library and Build's Structure) or hidden), its saved layouts and the shared sizes (schema v2, with a v1 mirror that 1.1 reads), `layout-solver.mjs` fits a layout into the window (width and height tiers, the default timeline height, #viewport's 360×200 minimum and the stage insets `fittedView()` uses), and `layout-store.mjs` loads it before the first layout and saves it debounced and merge-on-write through the workspace preferences IPC (localStorage in the browser). The top band holds three clusters: the mark and the open projects as tabs (each with its picture, its name and its state; see [Project tabs](PROJECT-TABS.md)), the workspace switch, and Undo, Redo, Save and Export. The menubar stays in the markup as the source of the mark's menus and never shows. In a session (Build, a movieclip being edited, the Camera selected) `topbar.mjs`'s `syncBandSession` shows that session's buttons (Build's Test rig, a movieclip's Cancel, and the session's Done) and turns the one Export into a quiet button beside Done. The rail (`rail.mjs`) shows only the current workspace's tools, centered beside the canvas in every workspace; Animate's + opens the Add menu (a stick figure, text, an image, figures from a file, a movieclip, another copy of a figure in the project, the examples), Draw's + makes a drawing layer, and a tool with variants (Select pixels, Shapes, Draw's +, the Tweener) lists them from its corner tick. `topbar.mjs` also measures the band's width after each of its fold steps whenever its content changes; the solver folds the band's words and spacing first (the primary's word last) and folds the menubar into the StykAnimate menu only where even the last step does not fit (the minimal width tier). `dock-host.mjs` applies each solution in one commit and is the only module that shows or hides a panel: feature modules hear `onVisibility` (the VFX rows in the Advanced timeline follow the VFX panel's visibility). At compact width the band's Properties button opens the inspector as a sheet, a folded side is a strip whose icons open sheets, and at the low height tier the timeline is its header and Timeline… opens its body as a sheet; panel roots keep their place in the DOM while a sheet shows them. Fitting a layout into a small window never rewrites it. `window.styk.workspace` exposes sizes, the stored preferences, presets, docking, floating and Focus; `flushPreferences()` lets close and tests await the last write. `dock-keyboard.mjs` adds F6 region cycling and the keyboard panel move, `dock-tabs.mjs` makes the tabs (and strip icons) the panels' handles: drag one to dock or float the panel at the one drop target under the pointer, or open its menu to dock, float, fold or hide it. Dragging into the canvas floats without a modifier; Shift keeps floating near a dock. Drops above or below a dock's content split it into two islands, whose divider resizes their stored shares. Dropping on a tab row merges panels. Structure retains a visible tab as its drag handle. The tool palette's grip moves it between the stage's sides (also Left/Right keys), retaining vertical centering. These gestures use the same per-workspace arrangement and saved presets; no panel roots or document data are copied. `layout-popover.mjs` is View › Layout… (Ctrl+Alt+L): the workspace's presets as dock maps, saved presets (rename, update, delete), one position per panel, Reset and Save as preset…. Each of them only calls the workspace API, so they cannot disagree. `shell-commands.mjs` registers the shell's commands in the `actions` map.

`src/app.mjs` wires the editor, the renderer and the panels together. The panels' own handling lives beside it in modules that app.mjs calls with a context object (`{editor, state, …}`, getters for what it creates later): `inspector-bindings.mjs` maps each inspector control to the editor command its change applies, in order, so the first binding whose selector matches takes the change (a Build-only control passes it on outside Build). `timeline-host.mjs` is the one place that constructs the Simple or Advanced timeline (`mount()`, with the app's scrub, range and history callbacks), wires the timeline header's own controls (the Simple │ Advanced switch, the frame rate, the zoom) and writes what the header shows: the transport readouts, the play button's state, Edit selected frames and the pressed mode. `export-flow.mjs` owns exporting: every export command (registered in `actions` before app.mjs wraps them), the export renderer's job and writing the result. Each export runs from one explicit request (`export-request.mjs`): `exportJob()` derives the size, range, quality, codec, sound and file name the encoders receive. The export dialog (`export-sheet.mjs`, its own kit dialog) holds the request, previews the animation through the thumbnail worker while it is open, runs the chosen type's command and shows its progress in place; a command run without it (the command palette) exports today's defaults, with its progress in a dialog of its own. Its choices persist in the `exportPreferences` editor setting. `app-dialogs.mjs` holds the app's own prompts, each its own dialog from the kit (`src/ui/ui-dialog.mjs`): Save changes?, the project's name, Recent files, Performance, the import notes, the Stick Nodes pack picker and Discard frame changes?. `index.html` gives the header static slots, `[data-slot=start]`, `[data-slot=transport]` and `[data-slot=end]` (the three clusters) and `[data-slot=ruler-tools]`, which hold today's controls and take no box of their own until the shared header lays them out. The chrome updates by surface (`src/ui/ui-invalidation.mjs`): app.mjs declares the title, the transport, the layers, VFX, the inspector, Edit selected frames and the stage hint, the status readouts, the Add dialog's lists and the shell, each with the reasons that make it stale. `queueUI()` marks them all and one pass a frame updates what is marked, in that order; `updateUI()` updates every surface at once (startup, a restored document). Playback stays quiet: while playing only the transport updates, at most every 200 ms (the readout at 5 Hz), and the title, which writes only when the name or saved state changes; the playheads move on their own, and every other surface waits for the first pass after playback stops. The canvas repaints after a pass only when the pass updated a surface, so a surface waiting for its time costs no redraws. Surfaces and the modules that follow every editor change (the onion controls, the canvas guides, the Library's save button, the session breadcrumb, the timeline host) write through `src/ui/dom-write.mjs`, which compares with the element's current value first, so an unchanged value writes nothing. `tests/playback-quiet.browser.mjs` holds playback to this, with a ratchet of the known remaining writers and their milestones. The stage header (`.stage-head`, the stage island's first row above `#viewport`) is `src/shell/stage-head.mjs`: its start (`[data-slot=stage-start]`) shows the location crumb, or the active tool's options (a bar rendered by `src/ui/tool-options.mjs` from the tool's option descriptors, or a host it adopts until its tool has them: Draw's quick bar, the chain and polygon controls); its end (`[data-slot=stage-end]`) holds the view toggles, re-parented with their ids, then zoom and Fit; and it places the one message (`src/ui/ui-toast.mjs`'s `#toast` host, in the top layer) over its centre, covering the start while it shows but never the view cluster, or on a line of its own under the header when its whole text does not fit there. It shows a pick mode's instruction while the mode lasts (Join, Connect joints, image and copy placement, Chain, Polygon, the Tweener) and a quiet "Slow · N of M fps" while playback misses its target, read at most once a second. app.mjs updates it as the `stagehead` surface, and at once when a workspace or a view toggle changes. `index.html` keeps static hosts for the inspector's header too: the target (`[data-slot=inspector-target]`, with `#inspector-context` and `#object-actions`) and, under it, the host of the scope line and the quick actions row (`[data-slot=inspector-head]`).

Editor styles load through `src/styles/app.css`, the only stylesheet `index.html` links. It declares the cascade layers and imports every sheet in cascade order; see [Design system](DESIGN-SYSTEM.md). Modules do not link stylesheets at runtime, except that the desktop feedback shell links `src/styles/support-bridge.css` when Feedback first opens, so the website's shared `src/support-center.css` loads only when needed; `src/styles/features/support-desktop.css` restyles it for the editor from the `features` layer. `npm run check` enforces this and the layer rules with `scripts/check-css.mjs`. Colours, type and spacing come from `src/styles/tokens.css`, the StykAnimate brand tokens for the light and dark themes; `src/styles/legacy-bridge.css` points the older `--theme-*` names at them. The UI fonts ship in `assets/fonts/` and load through `src/styles/base/fonts.css`.

Electron uses context isolation, sandboxed renderer code, and no renderer Node globals. Native IPC exposes specific file/stream/window/preference operations, not arbitrary filesystem commands. Workspace preferences live in a fixed, atomically written user-data JSON file capped at 16 KiB. They and recovery survive a restarted process even though its loopback origin changes.

`desktop/web-host.cjs` owns the desktop's loopback origin. It streams public web
assets asynchronously while `desktop/backend.cjs` starts the Python codec in
parallel. `/api/` requests use the same origin and stream through a bounded
16-request proxy with backpressure and four separate cancellation slots; pending
requests do not buffer their uploads.
Closing a client releases its proxy slot, and quitting aborts both pending codec
startup and the running child. Codec failure leaves WebGPU editing, Undo/Redo,
native project saving and local native reopening available. Pivot/STK conversion
still requires the codec. Import/export controllers own an opaque job identity
and send cancellation independently of their worker. The proxy also cancels
disconnected requests over a separate bounded control connection pool. Python
admits one heavy request at a time before reading its body, with at most 16
active/queued requests; health and cancellation bypass that queue. Cooperative
checks in decode, validation, fingerprint and writer loops release cancelled
work, and source-cache publication is ordered against cancellation. Individual
native/standard-library operations finish before the next check. Browser development
continues to use the Python server's static host. The deployable web build has no server: the same codec runs in WebAssembly behind the same request contract
(`codec-request.mjs`, `backend/browser_service.py`); see [Web build](WEB.md). On phones and
tablets the same editor runs its touch interface (`src/touch/`), which re-arranges the shell and
turns fingers into the desktop's pointer events; see [Touch interface](TOUCH.md).

Windows and Linux source execution and packaged builds are verified; CI builds, packages and boots the Linux AppImage, and runs the unit suite on both ([Linux support](LINUX.md)). A distributable includes the frozen codec sidecar, current web assets, source grammar, and licenses. Rebuild and verify the package after source changes; earlier smoke reports do not certify newer bytes. Local Apple Silicon macOS builds are verified on one Mac but not built in CI, signed for distribution or published ([macOS support](MACOS.md)). Platform-specific behaviour lives in the owning layer: Chromium's GPU switches in `desktop/gpu-switches.cjs`, the application menu in `desktop/native-menu.cjs`, Mach-O checks in `scripts/macos-binaries.mjs`, native library locations in `native_scan.build_directory()`, interpreter discovery in `scripts/run-python.mjs`.

## Canvas guides and grid

`src/canvas-guides.mjs` owns a fixed-size DOM overlay and a popover. It does not
modify document poses, history, renderer caches or export surfaces. The vertical
X and horizontal Y guides have independent visibility, scene-pixel inputs,
edge-handle dragging, arrow-key nudges (Shift: 10 pixels), Escape cancellation,
and a shared lock. Positions are clamped to the scene and stored as proportions
in editor preferences, so they adapt when a different canvas size is loaded;
these are workspace aids rather than per-project animation data. Numeric fields
reuse `PropertyControls` for drag adjustment (Shift/Alt for finer steps), direct
typing and Escape rollback. Live previews stay local; release commits preferences.

The grid clips to the visible stage and uses CSS gradients. Its configured cell
size stays in scene pixels; at low zoom the displayed step doubles until at least
eight screen pixels apart. Rendering uses a constant number of DOM elements,
skips inactive aids, and skips unchanged layout writes. Aids hide during playback
and preview. Grid spacing, opacity, guide visibility, positions and locking use
the existing normalized settings persistence. Guide edits do not dirty projects.
See `tests/canvas-guides.browser.mjs` for UI verification.

## Reproducible evidence

| Concern | Command | Report |
| --- | --- | --- |
| Prepared UI playback/drag | `node tests/renderer-ui-performance.mjs --fps=60` | `artifacts/renderer-ui-performance-60fps.json` |
| Native imported-rig edits | `node tests/renderer-edit-profile.mjs "path/to/project.piv"` | `artifacts/renderer-edit-profile/report.json` |
| Whole-app edit/autosave scheduling | `node tests/edit-freeze-profile.mjs "path/to/project.piv"` | `artifacts/edit-freeze-<project>/report.json` |
| Source-bearing save/restart/export | `node tests/document-export-browser.mjs "path/to/project.piv"` | `artifacts/document-export-browser*.json` |
| Exact native file streaming | `npm run test:streams:desktop` | `artifacts/native-streams-smoke.json` |
| Workspace process restart | `npm run test:preferences:desktop` | `artifacts/desktop-preferences-smoke.json` |
| Sampled prepared raster corpus | `node tests/renderer-corpus.mjs --prepared` | `artifacts/renderer-corpus-prepared/summary.json` |
| Editor UI screenshots and pixel diffs | `node scripts/ui-snapshots.mjs --url <server> --label <name> [--compare <label>]` | `artifacts/ui-redesign/snapshots/<name>/` |

The UI tests use the local development server; profile scripts accept `STYK_URL`. Artifacts name the fixture, phase, timing scope, and observed limitations. Long-task absence, total job duration, CPU submission, GPU completion, and display latency are separate measurements.

## Interface scale and settings

Settings → Animation → Playback includes “Fit view when playback starts”, enabled
by default. Disabling it preserves the current canvas zoom and pan on transport
start. The preference persists through the existing editor settings store.

`src/ui-scale.mjs` owns the 75%–200% presentation range, five-percent steps,
normalization, and application through the narrow desktop `setUIScale` preload
API. `EditorSettings` persists `uiScale` through the existing editor preferences
store and reapplies it at startup. Old or invalid preferences default to 100%.
Electron uses native page zoom so layout, pointer coordinates, viewport sizing,
and device-pixel ratio stay in the same coordinate system. No document data,
canvas view scale, undo history, or export dimensions are changed.

The browser preview keeps browser-native zoom controls; it does not substitute
CSS transforms that would desynchronize interactive editor coordinates.
`src/styles/features/settings.css` owns the Settings presentation: the head
with its search, the sidebar of sections, each page's titled cards, the
shortcut editor and the Feedback page. It sizes everything from container
queries on the dialog and its content pane, so the sidebar becomes a strip of
tabs in a narrow dialog. Native slider keyboard behavior, labeled outputs, tab
navigation, and Escape dismissal are preserved. Verify with
`node --test tests/ui-scale.test.mjs` and `node tests/settings-scale.desktop.mjs`
(isolated profile, process restart, canvas pointer alignment, light/dark and
compact screenshots).

Neither `EditorSettings` nor `HotkeySettings` injects CSS. `EditorSettings`
builds every row from the same few builders (a switch, a select, a block row)
inside titled cards, and takes its words from the localization, falling back to
English in `src/locales/en-dialogs.mjs`. The search in its head renders the
Interface, Canvas and Animation sections together and keeps the rows whose
words match; the rows are the tabs' own markup, so a result changes its setting
as in its tab, and Escape clears the search before it closes Settings.
Shortcut state and binding validation stay in `hotkey-settings.mjs` /
`hotkeys.mjs`, with persistence owned by `EditorSettings`. The Feedback page's
tiles forward their category to the shared `FeedbackUI` draft and *My reports*
opens its inbox; the sidebar Donate action uses the existing `openDonate`
desktop bridge. Neither is part of tab navigation. `FeedbackUI` applies only the
newest open's options once the support center has started, so reopening with
another type while the first open is still loading never ends on the older one.
`node tests/settings.component.browser.mjs` covers the rows and the search;
`node tests/settings-tabs.desktop.mjs` verifies shortcut editing, canvas
controls, feedback categories and the inbox, the donation callback, and
responsive light/dark layouts without submitting feedback or visiting payment
pages.

### Construction gestures

`builder-construction.mjs` owns the transient chain draft and a figure-scoped spatial index. Joint and sampled-midpoint candidates use a balanced k-d tree; sorted coordinate/length tables supply axis and equal-length targets. Tolerance stays in screen pixels, with point hysteresis and an Alt bypass. Rig gestures snapshot the index once and exclude the edited branch. Snapping changes position, not connectivity: starting at a native joint attaches the new branch; snapping an endpoint onto another joint does not weld handles or introduce cycles.

New builder segments inherit colour and thickness from their native parent handle, including per-instance style edits; explicit thickness arguments take precedence. Chain links carry these values forward. Origin-attached segments retain the default thickness of 8 and the figure's first segment colour (new figures use purple).

Drawing previews snapshot inherited colour and world-space width at gesture start and scale with canvas zoom; zero-width construction lines retain a thin guide. Builder Edit and joint context menus copy the primary selected joint’s displayed paint (including gradients and opacity) and thickness into an app-local clipboard. Paste reuses the existing selection/branch style command as one undo step, preserving topology, shape, rig properties and draw order. Explicit multi-selection targets only those joints.

The chain pen creates no document commands while clicking. Enter, double-click or Finish calls `Editor.addSegments` once. Backspace removes the last point; Escape, tool/session changes, external document edits and the chain context menu cancel the draft. Preview paths rebuild only when points or zoom change. The persisted `builderSmartSnapping` preference is UI state, absent from exported artwork.

Append and rig commands use sparse definition snapshots: history contains appended records or explicitly changed segment indices, plus the existing affected source-pose journal. Unchanged segment references exist only during the synchronous command and never enter its history payload. Origin-support figures retain the full topology repair path. New-figure creation journals a definition splice rather than copying the complete definition table. Geometry invalidation retains unrelated objects while rebuilding every instance and joined dependent of the edited definition; IK, movieclip and slot-remapping cases retain conservative invalidation.

`builder-duplicate-preview.mjs` caches a high-contrast branch silhouette, including circle and polygon fills, in one bitmap capped at 2048 × 2048 pixels. Pointer movement translates the bitmap and queries its joint index. Placement preserves the existing duplicate command's native topology and undo behavior; cancellation drops the bitmap and index.

Builder node selection uses transient native handle IDs scoped to one object UID; Shift-click toggles those IDs in the canvas and hierarchy. Explicit multi-selection style edits target exactly those segments, with a single undo entry; single-node branch editing retains its existing scope. Builder Delete dispatches to segment/branch or selected-fill commands even under Select, so it cannot accidentally remove and recreate the session object. Selection is restored with command history and does not enter the saved figure format.

`builder-fill.mjs` caches directed-edge region discovery by evaluated geometry in a WeakMap. Polyfill Shift-click uses closed line/curve outlines whose native endpoints coincide; dangling strokes are removed from face discovery. Crossings without joints do not create boundary connections, and compound holes are not generated. A preview shows the exact proposed region before committing one native `addPolygon` command. Direct interior clicks select the topmost visible fill in the builder figure, with joints taking precedence; fill color, opacity, order and deletion reuse the existing polygon commands.

## Raster drawing integration

Drawing layers use the ordinary layer-sheet and image-figure contracts.
`editor-drawing.mjs` supplies commands; `drawing-resources.mjs` owns transient
surfaces and worker publication; `drawing-controller.mjs` owns pointer gestures.
`drawing-view.mjs` extends the shared inspector primitives and tool rail.
Pixel history participates in the existing command stream and its shared
undo/redo byte budget. See [drawing ownership and workflow](DRAWING.md).

## Interface localization

`src/localization.mjs` is the one DOM-free lookup/fallback and Intl formatting
service. English messages have exclusive feature ownership; independent JSON packs
supply locale metadata and translations. `src/localization-bindings.mjs` connects
presentation keys explicitly at UI owners and updates retained captions/attributes
on language changes. Numeric drafts, editor documents, command IDs/history, canvas
coordinates and chronological timeline order do not depend on locale. Worker errors
retain diagnostic identity and transfer message metadata through existing replies;
Electron shares the catalog/service through its native facade and existing settings
IPC. Generated registry/context/preload blocks belong to integration, not individual
translators. [LOCALIZATION.md](LOCALIZATION.md) defines the lookup, variant, plural,
RTL and validation contracts; [TRANSLATING.md](TRANSLATING.md) defines pack ownership.
