# D20: A software rasterizer draws runs of primitives with the simplest shader that holds them

Status: accepted (2026-11-13). Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4. Refines [D8](0008-renderer-without-storage-buffers.md): one WGSL shader still serves every backend.

## Context

Without a usable graphics card (a virtual machine, a remote desktop, a blocked driver) Chromium draws WebGL2 on the
processor with SwiftShader, and the app was not usable there: playing the smallest scene delivered half its frame rate
and every gesture that redraws the stage took 50 to 150 ms a frame. One draw call was most of it: the document's
background, one rectangle over the frame, cost 61 of 78 ms (switching that draw off left 16.9 ms).

`prim.wgsl` shades every kind of primitive in one fragment function. SwiftShader runs a quad of fragments through both
sides of every branch with the lanes masked, so each pixel of the background paid for the code of pictures, drawing
tiles, glyphs, gradients, composites and generated effects. Measured in the app, small scene, no graphics card:

| The primitive fragment shader | Frame seen, playing |
| --- | --- |
| as it is | 100 ms |
| the same, with an early return for the background's kind | 102 ms (no gain: the masked code still runs) |
| one constant colour for every primitive (the floor) | 23 ms |

(That launch ran on a busy machine; the background's share matches the quiet baseline's.)

## Decision

- The shader keeps one source and gets more fragment entry points over the same functions: `fs_flat` (triangles and the
  view's fill in their own colour), `fs_stroke` (those and segments, discs and rings), `fs_vector` (those and boxes, arcs,
  polylines), `fs_image` (pictures and drawing tiles), `fs_composite` (isolated groups' layers) and `fs_main`
  (everything, as before). Each holds the code of fewer kinds, so a software rasterizer runs only that code. Each simpler
  one also has a `_plain` form, used for an upright view with the native painter (the stage), without the turned
  artboard's clip and the Canvas painter's masks. Each simpler class has a vertex entry point of its own too (`vs_flat`,
  `vs_stroke`, …), over the same corner functions as `vs_main`.
- On a software rasterizer a pass draws each run of primitives with the simplest entry point that holds every kind in
  it (`styk-render/src/shading.rs`): a paint record (a gradient), a face of a depth run, an additive record, a lone glyph,
  the background picture, a generated effect, or a run mixing the kinds of two simpler ones takes `fs_main`. The root's background is a run of its own (it was its own draw call already).
  A list whose kinds alternate is merged into at most 64 other runs, the shortest drawn with the shader their
  neighbours need, so the draw calls stay bounded.
- Only where the device is a software rasterizer: `wgpu::DeviceType::Cpu`, which wgpu reports for SwiftShader and
  llvmpipe (from the WebGL renderer string, which a real card never matches), lavapipe and WARP. On a graphics card
  every primitive still draws with `fs_main`, one draw a pass, as before: the general shader is as fast there, and one
  shader keeps the frame the same whatever compiler builds it.
- Nothing about the picture changes: no lower resolution and no change of multisampling on a software device.

## Evidence

- Pixels: `styk-render/tests/shading.rs` draws every vector kind over opaque, translucent and no backgrounds, and six
  repository documents (gradients, outlined text, isolated groups with effects, 3D faces, generated effects, a drawing cel), each in
  six views (fitted, the canvas smaller than the view, partly off screen, through the camera, turned and mirrored, the
  Canvas painter of the camera monitor), smooth and crisp, with the runs on and off: byte for byte the same on Vulkan
  (RTX 4070 SUPER) and on WARP. On Direct3D 12 with FXC on the graphics card one pixel of the Canvas painter moved by one
  level between the two shaders, which is why a graphics card keeps the general one. Refactoring `fs_main` into the shared
  functions changed no pixel: 432 frames of the same lists and views, drawn before and after on Vulkan, both Direct3D 12
  adapters and GL, were byte-identical.
- In the app on SwiftShader the stage's picture with the runs on and off was the same in all 28 views compared (the
  small, busy, pictures, effects, camera, labels and shapes scenes in four views each, device pixels of the composited
  page), and playing went from 109 to 24 ms a frame on the small scene and from 165 to 48 ms on the busy one, in one
  launch on a busy machine ([rendering.md](../rendering.md#without-a-graphics-card)).

## Consequences

- A frame on a software device costs several draw calls instead of one a pass (the background, then usually one or two
  runs), and up to ten more pipelines can be built, each with the first frame that needs it (the stage of a stick-figure
  scene builds two: the flat and stroke shaders' plain forms).
- Glyphs, gradients, the background picture and generated effects still draw with the general shader on a software
  device: the next step if their per-pixel cost matters there is another entry point beside these.
- The live parameter `stage.shadingRuns` (developer tools) turns the runs on (1) or off (0) over the device's choice, so
  the two can be measured and compared in the app.
