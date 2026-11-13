# D21: Without a graphics card, the stage is drawn by the CPU rasterizer on the engine's workers

Status: accepted (2026-11-13). Refines [D20](0020-software-rasterizer-shading-runs.md) and keeps [D7](0007-interface-thread-never-blocks.md).

## Context

With the narrower shaders of D20 the small scene was usable without a graphics card, the busy one (3,200 segments a frame) was not:
every gesture that redraws the stage stayed at 36 to 52 ms a frame on SwiftShader. A profile of dragging a joint there showed the
interface thread spending 33 of its 38 ms a frame inside the browser's own rendering step, waiting rather than computing (busy
1,728 ms, processor time 410 ms over the pass): with software compositing a WebGL canvas is read back into a bitmap for the compositor
every frame, and the page's thread is held until SwiftShader has rasterized the frame. The app's own script was 5 ms a frame and the
engine's threads were 1% busy. The engine has a CPU rasterizer (`styk-raster`) held to the GPU renderer's pixels by D13 for exports.

A prototype answered the question before anything was built: the same frames drawn by the CPU rasterizer in bands on the engine's
workers and put on a 2D canvas over the scene canvas. On the busy scene a joint drag showed a picture every 11 ms (input to picture
13.7 ms at the 95th percentile), panning 10 ms, and the browser's rendering step fell from 33 to 2 ms a frame: the interface thread
no longer waits.

## Decision

- **Where.** Only where the stage's device is a software rasterizer (`wgpu::DeviceType::Cpu`, D20's detection: SwiftShader, llvmpipe,
  WARP, lavapipe) and the engine has worker threads. Never on a graphics card. Without threads (a page that is not cross-origin
  isolated) its tasks would run on the interface thread, so the device draws.
- **What.** Every frame the stage draws goes through `Stage::draw` as before: edit frames, prepared playback and scrub frames, onion
  skins, the camera view, effects, pictures and drawing cels (the live ones too), the turned or mirrored Draw view. Only the last step
  changes: the frame is asked of `styk_engine::stage_raster` instead of drawn on the device. The device and its renderer stay: the
  stage keeps uploading pictures to it, so picture readiness, residency and soft copies work as before, and it draws again at once
  when the processor is switched off.
- **How.** A task on a worker readies the frame (the decoded pictures the stage took from the engine, shared; any it lacks decoded
  there; the live cels' slots; the glyph masks) and queues one task per band of 64 rows; each band is the same view moved up by its
  first row (`styk_raster::Bands`), and writes straight RGBA rows into the frame's buffer. The page copies the newest finished frame
  out of the engine's memory and puts it on a 2D canvas laid over the scene canvas (`putImageData`), when the progress counter says a
  task finished. One frame is drawn at a time and a newer request replaces the one waiting.
- **What it shows.** A frame is drawn by the CPU rasterizer, so the picture is the GPU renderer's (D13), not SwiftShader's: the CPU
  rasterizer gained the turned view to cover the stage's last paint context. The device's own frames on SwiftShader differ from both
  (below).
- **Measured as pictures.** A picture shown after its frame has its own span (`stage picture`); the capture's `shown` series, playback's
  delivered frames and the developer tools' `settle` count pictures shown, and a gesture is judged on the pictures too
  (`picture.felt`, `picture.input.p95`), so a stage whose frames run at the display's rate while its pictures lag cannot read as smooth.
- **Fallback and switch.** A frame whose pictures cannot be held in memory switches the stage to the device for good. The live parameter
  `stage.processor` (1, 0, -1 for the device's choice) switches between the two in the app.

## Evidence

[rendering.md](../rendering.md#the-stage-on-the-processor) has the measurements in full. On the busy scene without a graphics card
every core scenario went from fair or poor to good (zoom fair: its pictures stand still 17.8 ms): a joint drag's picture within
12.8 ms of the input (63.6 ms before), playing 100% of the frames (88.2%), the effects scene playing 100% (4.1%). On a graphics
card nothing changed. The old-laptop environment gains less and loses in a zoom and a step's latency (see Consequences).

- **Pixels in the app.** Seven scenes (small, busy, pictures, effects, camera, labels, shapes) in five views each (fitted, zoomed in and
  partly off screen, the canvas smaller than the view, through the camera, turned and mirrored with onion skins), device pixels of the
  composited page with the stage's backdrop made plain: on the graphics card the processor stage against WebGPU passed D13 in 35 of
  35 views, every pixel within 2 levels in 27 of them, within 8 for filled shapes and within 63 on a few edge texels of pictures (mean
  at most 0.011). Without a graphics card against the WebGL2 stage on SwiftShader it passed 28 of 35 (0 solid pixels, mean up to 0.22,
  edges up to 18 levels apart): the seven others are where SwiftShader departs from the GPU renderer, pictures and text sampled
  differently (mean 0.28 to 0.43) and, zoomed in on the effects scene, figures with glow and shadow left out of SwiftShader's frame
  altogether (30,583 solid pixels), which the processor stage draws.
- **Bands.** `styk-raster/tests/bands.rs`: seven repository documents with text, 3D faces, filter and generated effects and a drawing
  cel, upright and turned, drawn in bands against the whole frame: at most one level on a handful of edge pixels. The turned view
  against the GPU renderer: 0 solid pixels, mean at most 0.004. `styk-engine/tests/stage_raster.rs`: frames drawn on real worker threads
  against the whole frame, the queue, the buffers, the live cels' slots.

## Consequences

- Without a graphics card the stage costs the engine's workers what the CPU rasterizer costs (a few milliseconds a frame on the busy
  scene, across them) and the interface thread a copy of the frame (2.5 MB at 1,160 × 540) and a `putImageData`.
- A picture is shown a frame after the one that asked for it at best: the overlay (handles) can lead the figure by a frame during a drag.
- The old-laptop environment slows the page and its threads but cannot slow the graphics process, so there SwiftShader keeps the
  machine's whole speed while the CPU rasterizer runs on two slowed threads: it understates what the processor stage gains on a real
  slow computer, where SwiftShader would be slowed too.
- The statistics' renderer field still says WebGL2 for such a stage (the device in use); telling the two apart there is a product
  decision about what the statistics send.
- Next, if the cost on the workers matters: draw only the part of the frame a stroke or a drag changed (as the GPU stage does for
  strokes, `Renderer::redraw_within`), and reuse the bands' targets between frames.
