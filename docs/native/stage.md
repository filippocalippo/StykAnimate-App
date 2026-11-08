# Native stage host

`styk_core::stage::Host` owns one document's view and stage demand in `Frames`.
`Painter` is the presentation boundary for the later iced shader widget (N2).
Views send navigation messages and borrow the resulting GPU picture; they never
read an engine scene, hold a renderer, or prepare a frame themselves.

## View and input

Coordinates are logical window or stage pixels. `Viewport` supplies the stage's
window origin, size, DPR and layout clearances. `View` maps document points through
the scene camera, zoom/pan, rotation about the artboard centre and horizontal flip;
its inverse preserves the reference's arithmetic order. Backing density is DPR
times preview quality, applied to size, zoom and pan only at the frame request.

Zoom commands use factor 1.2 and clamp to 0.001..100. Fit canvas uses the layout
clearances (24/28/24/28 by default), scale 0.01..2 and JavaScript's rounding rule.
`set_canvas` accepts scene-size changes from the document owner. The fitted snapshot
follows resizes while scale matches and offsets differ by
less than half a pixel, with no rotation/flip. Fit selection uses projected bounds,
120/150 pixel clearance and the reference's 15 pixel upward offset; missing bounds
fall back to Fit canvas. Wheel easing preserves the reference's gains, 40 ms time
constant, 16 ms first step, 64 ms stalled-step cap and 100 ms idle interval.
`advance` receives application clock time; no view timer or OS clock is created.

`pointer` handles captured middle-button, Space and Pan-tool drags. Other presses
are routed back to the tool owner. Cancellation names the captured pointer.
`pen_sample` preserves pressure, tool, provenance, timestamps and terminal events
while adding stage/document coordinates. Automation enters through the same route
after converting stage coordinates to the platform's physical-window convention.
`wheel_pan` preserves the reference's axis swap with Shift. The command/input owner
chooses pan versus zoom from settings and modifiers; it passes the smoothing policy.

`picking::Prepared` is a core-only borrowed query seam over already-prepared scene,
frame and handle data. Handle, hover and segment queries call `styk_eval::picking`
without a second picker or preparation on hover. Tool chunks own producing those
descriptors, selection policy and async artwork picking.

## Painter integration

1. Compose `Frames` with K-doc's `FrameDocument`, injected `Spawner`, `Clock` and
   a coalescing event-loop wake. The document service owns revision/resource epochs.
2. Give `Painter::new` the **same device, queue and target format as iced**. It
   starts one worker through the supplied spawner; reserve that worker in the app's
   global worker budget. It belongs to this document lifetime, not to a widget draw.
3. After navigation, request the tick through `Host::request`, then `Painter::request`.
   Call `Frames::flush` on progress/event-loop turns. View changes invalidate
   painter tickets immediately while leaving the world-space preparation request
   intact. The painter key combines that prepared identity with backing size,
   density, zoom/pan, rotation, flip, quality and sample count.
4. Call `Painter::update` after submitting the previous presentation encoder. It
   consumes at most one reply. `present` records three commands into the widget's
   pass; the widget supplies viewport/scissor. Pending or failed candidates leave
   the last complete picture available. Surface recreation requires a new painter.
5. Close/drop the painter and host when the document closes. Neither joins a worker.
   `worker_exited` is a diagnostic, never something the interface waits for.

The worker borrows a scheduler ticket, takes an immutable ready-list handle under
a short try-lock, then obtains the matching document generation outside that lock.
Sprite decoding runs ahead on the document engine's existing workers; the paint
worker drains bounded batches, uploads, prepares effects/glyphs and polls GPU completion. The UI exchanges owning pointers in bounded
single-item slots; it never locks the renderer or receives dense CPU scene data.
Only a current, completely rendered candidate is published. A cancelled error is
discarded just like cancelled pixels. Returning the previous picture acknowledges
the handoff and allows the next publication. The renderer's output texture is moved
into `RenderedFrame`, then recycled on its worker; it is never copied or overwritten
while displayed. Detached presentation blends premultiplied alpha over the host;
the browser surface retains its copy pipeline. A close
during GPU polling wakes and exits without waiting for a map/readback.

`PaintLimits` admits bytes before allocations: output pictures (default 192 MiB,
at most three), resident sprite pixels (512 MiB), and working textures/buffers
(1 GiB, including picture lookup tables and old/new replacement overlap). Sprite arrays grow once per
candidate; old/new arrays plus queued uploads are bounded multiples of the resident
limit. Even failed or cancelled candidates submit/drain their pending uploads
before another candidate starts. The renderer records one owned `FramePlan`
(group placement, isolation rounds and effect recipes). Admission inspects it and
drawing consumes that same plan after resource readiness; driver/pipeline bookkeeping is outside it.
Document/assets and decode reservations remain engine-owned. The scheduler cache
keeps its own byte bound; the worker/renderer may additionally retain at most two
cache-sized lists (previous renderer list plus candidate) until replacement/close.
Refusal is explicit and preserves the previous picture; no partial sprite set is
published. Exact-size render targets preserve export's sizing independently of
previous views. This is admission and lifetime accounting, not a process-RSS limit.

Sprite residency uses document lineage and asset placements, never document revision.
Unchanged cel payloads keep placement serials and texels through pose edits; new
placements explicitly invalidate only replaced slots. Bounds/resource-epoch changes
invalidate prepared geometry without discarding unchanged pixels. The engine's
picture queue supplies bounded batches, including refusal provenance. A refused
replacement is never acknowledged as complete; the last rendered picture remains.
Evicted resources re-enter that same queue. The painter owns its resident page set,
not another decoder or renderer. K-doc provides `FrameDocument::picture_engine`
and runs those workers through the injected service spawner.

The app installs a generic policy hook in vendored `iced_wgpu` before creating a
compositor. Both windowed and headless creation try the engine's `native_gpu`
backend/compiler descriptors, including fallback after device negotiation fails.
iced still owns surface, device, features and limits. See `vendor/iced/VENDOR.md`.

## Automation and verification

The shared K-shell `styk_core::automation` parser owns the line-oriented
`styk-auto/1` language. Stage steps are `pan dx dy`, `zoom factor x y`,
`pointer id down|move|up|cancel left|middle|right x y`,
`pen id hover|down|move|up pen|eraser x y pressure`, `frame tick`,
`play from count` and `measure label`. `advance nanoseconds` supplies input time
with `--clock fixed`; runners timestamp pen samples from that clock. File access,
pacing and measurements remain runner responsibilities. There is no parallel parser.

`scenarios/stage.styk-auto` uses local aliases `scene_a`/`scene_b`; the runner binds
private inputs read in place. No private contents, names or paths belong in reports.
The ignored `stage_benchmark_scenario` is its offscreen runner. Set local
`STYK_STAGE_INPUT_A` and `STYK_STAGE_INPUT_B`, then use the machine queue:
`cargo test --manifest-path engine/Cargo.toml -p styk-core --release --test stage_painter stage_benchmark_scenario -- --ignored --nocapture`.
It reports cold request and open-to-first-ready time separately, every steady
step latency, and per-operation p50/p95 from 120 pan, 120 zoom and 120 playback
samples per input (nearest-rank p95). Settings: 1280x720, DPR/quality 1, 4x MSAA.
Input time is fixed; latency uses an independent real measurement clock. Playback
wraps at the document end. Each candidate completes before the next request:
these are directional worker latencies, not display deadlines or playback FPS.
K-dev owns paced automation and exclusive comparative measurements.

`tests/stage.rs` checks transforms at odd DPRs, fitted/zoom limits, wheel and pointer
semantics, request supersession and frozen browser picking answers. `stage_painter`
draws through the real production worker and presenter to an offscreen target,
compares vector, cel and effect fixtures with `styk export` pixels, exercises repeated replacements, refuses output
and working-byte budgets, and observes worker resource reclamation after close.
No frozen fixture or parity threshold is changed. N2 owns visible screenshots (see "The stage widget").

## The stage widget

`styk_ui::stage` is the iced shader widget; `styk_core::stage::Surface` is everything it would otherwise decide. A
surface is one document's `Host`, its `Painter` and the input policy; `Core` holds one per open document
(`set_stage`, `stage`, `close_stage`) and runs its events as `Command::Stage(Event)` through `Core::dispatch`.

- **Input.** The widget turns toolkit events into `Event`s and publishes them as messages: the mouse and fingers become
  `Pointer` events (stage coordinates, one pointer identity each; middle button, Space and the Pan tool pan through
  `Host::pointer`, other presses come back as `Outcome::routed` for the tool owner, which does not exist yet), the
  wheel becomes `Wheel` (the surface converts lines to today's 100 px notch and the toolkit's sign to the browser's,
  then picks zoom or pan from Ctrl/Cmd and the Zoom gesture setting, with the setting's smoothing), Space and the
  pen queue's samples become `Space` and `Pen`. Events outside the stage, and moves with no button down, are not sent.
  Each redraw while `Surface::moving` sends `Tick`, which advances wheel easing on the application clock.
  Automation steps (`pan`, `zoom`, `pointer`, `frame`) are the same events (`Event::from_step`).
- **Size and density** are read where they are known: the primitive's `prepare` gives `Surface::prepare` the widget's
  logical bounds and the window's scale factor, and the surface resizes the host (a fitted view follows).
- **The frame loop** is the contract of "Painter integration": `prepare` is called after the previous frame's encoder was
  submitted and does, in order, resize, painter creation for a new graphics context (a new `Pipeline` has a new
  `GpuId`: surface recreation means a new painter), the demand (`Host::request`, `Painter::request`), scheduler
  `flush`, `Painter::update`; `draw` first records the artboard backing, then `Painter::present` into the widget's
  pass. A pending or failed candidate leaves the last complete picture on show. The surface's lock is only ever taken
  with `try_lock` and by the interface thread alone; nothing waits on it, on the worker or on the GPU.
- **Redraws** follow the work: the widget asks for another frame (`Surface::needs_frames`) only while a demand is
  pending or the view is easing. The painter's own wake (the event loop's coalescing wake, given to the surface by its
  owner) is the other signal; the owner of a window turns it into a redraw.
- **The artboard backing** (today's `#artboard`: an 8 px checkerboard seen where the scene is transparent, a 1 px ring
  and a soft drop) is drawn by the widget's own small pipeline (`stage/backing.wgsl`) at `Surface::artboard()`.
- **Not here:** tools, handles, the marquee, grids and guides, the HUD, the header and the rail. The surface keeps
  the stage's tick (`Event::Frame`) until the timeline owns it.

`tests/stage_surface.rs` (styk-core) covers the input policy through `Core::dispatch`, the render path on a real device
(call order, one update and one present per frame, the picture kept while a demand is pending, a new painter for a new
context) and the automated interaction `docs/native/scenarios/stage-interaction.styk-auto`, whose last frame equals
`styk export`'s byte for byte. `styk-app/src/stage_widget_tests.rs` drives the widget itself in the toolkit's headless
renderer. Screens `stage-fit` and `stage-fit-dark` (`styk_core::screens::stage`) are compared with today's stage by
`engine/crates/styk-app/automation/stage-reference/screens.mjs`.

## Inventory boundary

Core support exists for ST-003, ST-016..018, ST-020..024, ST-034..036, ST-090..091;
their inventory rows remain `wip` until the widget/tool integration is checked.
ST-001..002, ST-004..015, ST-019, ST-025..033, ST-037..089 and ST-092..104 are left
for their existing owners: chrome, settings/playback integration, tablet/touch
gesture arbitration, grids/guides, selection and artwork queries, handles,
marquee, pose/IK/3D tools, previews and HUD. This host does not edit documents or
introduce live pose/drawing mutation paths. K-doc publication, N2's widget and the
Animate/Draw chunks must connect those existing services before the stage is usable.
