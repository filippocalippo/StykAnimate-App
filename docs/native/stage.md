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
   Call `Frames::flush` on progress/event-loop turns. Every view change invalidates
   the prior stage demand immediately; replacement requests carry the full view key.
4. Call `Painter::update` after submitting the previous presentation encoder. It
   consumes at most one reply. `present` records three commands into the widget's
   pass; the widget supplies viewport/scissor. Pending or failed candidates leave
   the last complete picture available. Surface recreation requires a new painter.
5. Close/drop the painter and host when the document closes. Neither joins a worker.
   `worker_exited` is a diagnostic, never something the interface waits for.

The worker borrows a scheduler ticket, takes an immutable ready-list handle under
a short try-lock, then obtains the matching document generation outside that lock.
All sprite decoding, uploads, effect/glyph preparation, renderer calls and GPU
completion polling happen there. The UI exchanges owning pointers in bounded
single-item slots; it never locks the renderer or receives dense CPU scene data.
Only a current, completely rendered candidate is published. A cancelled error is
discarded just like cancelled pixels. Returning the previous picture acknowledges
the handoff and allows the next publication. The renderer's output texture is moved
into `RenderedFrame`, then recycled on its worker; it is never copied or overwritten
while displayed. A close during decoding finishes that indivisible decode; a close
during GPU polling wakes and exits without waiting for a map/readback.

`PaintLimits` admits bytes before allocations: output pictures (default 192 MiB,
at most three), resident sprite pixels (512 MiB), and working textures/buffers
(1 GiB, including picture lookup tables and old/new replacement overlap). Sprite arrays grow once per
candidate; old/new arrays plus queued uploads are bounded multiples of the resident
limit. Even failed or cancelled candidates submit/drain their pending uploads
before another candidate starts. The working bound uses the renderer's own group,
isolation, glyph and effect planners; driver/pipeline bookkeeping is outside it.
Document/assets and decode reservations remain engine-owned. The scheduler cache
keeps its own byte bound; the worker/renderer may additionally retain at most two
cache-sized lists (previous renderer list plus candidate) until replacement/close.
Refusal is explicit and preserves the previous picture; no partial sprite set is
published. Exact-size render targets preserve export's sizing independently of
previous views. This is admission and lifetime accounting, not a process-RSS limit.

The app installs a generic policy hook in vendored `iced_wgpu` before creating a
compositor. Both windowed and headless creation try the engine's `native_gpu`
backend/compiler descriptors, including fallback after device negotiation fails.
iced still owns surface, device, features and limits. See `vendor/iced/VENDOR.md`.

## Automation and verification

K-shell's shared parser was not present at implementation base. The minimal
`styk_core::automation` seam parses `styk-auto/1` timestamped stage steps; runners
own file access, pacing and measurement. K-shell/K-dev extend this module, not a
parallel script format. `scenarios/stage.json` uses local aliases `scene_a` and
`scene_b`: the runner binds them to private inputs read in place. No input contents,
names or paths belong in the scenario or generated reports.

The ignored `stage_benchmark_scenario` test is its headless runner. Set local
`STYK_STAGE_INPUT_A` and `STYK_STAGE_INPUT_B`, then run through the machine queue:
`cargo test --manifest-path engine/Cargo.toml -p styk-core --release --test stage_painter stage_benchmark_scenario -- --ignored --nocapture`.
It reports open-to-first-ready time and 19 request-to-GPU-ready samples per input
(pan, zoom and 16 consecutive playback ticks), at 1280x720, DPR 1, quality 1, 4x MSAA.
It awaits each candidate rather than simulating display deadlines: numbers are
directional worker latency, not window presentation, input latency or playback FPS.
K-dev supplies paced automation and exclusive comparative measurements.

`tests/stage.rs` checks transforms at odd DPRs, fitted/zoom limits, wheel and pointer
semantics, request supersession and frozen browser picking answers. `stage_painter`
draws through the real production worker and presenter to an offscreen target,
compares vector, cel and effect fixtures with `styk export` pixels, exercises repeated replacements, refuses output
and working-byte budgets, and observes worker resource reclamation after close.
No frozen fixture or parity threshold is changed. N2 owns visible screenshots.

## Inventory boundary

Core support exists for ST-003, ST-016..018, ST-020..024, ST-034..036, ST-090..091;
their inventory rows remain `wip` until the widget/tool integration is checked.
ST-001..002, ST-004..015, ST-019, ST-025..033, ST-037..089 and ST-092..104 are left
for their existing owners: chrome, settings/playback integration, tablet/touch
gesture arbitration, grids/guides, selection and artwork queries, handles,
marquee, pose/IK/3D tools, previews and HUD. This host does not edit documents or
introduce live pose/drawing mutation paths. K-doc publication, N2's widget and the
Animate/Draw chunks must connect those existing services before the stage is usable.
