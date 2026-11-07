# Frame parity: the native renderer against today's frames

Chunk FP, 2026-11-07. The question: does the native app (wgpu on the desktop GPU) draw the frames today's app draws (Chromium's
WebGPU), for exports and for the stage? S3 had found one end-to-end export comparison whose frames differed (decoded PSNR 66 to
68 dB). This page records where they differ, what was fixed and what is left.

## Method

- **Reference frames** are the export worker's own pictures: `createExportFrameRenderer(...).renderNativeTick(tick, {preserveAlpha: false})`
  in today's app (Electron, WebGPU, an NVIDIA RTX 4070 SUPER, driver 32.0.16.1742), the PNG the worker hands to FFmpeg. They are
  taken **over black** (the engine's matte, what MP4 gets): the canvas's premultiplied round trip is lossless then, so the PNG is
  the straight frame the engine drew. Straight alpha frames (WebM) go through that canvas step and were not compared here.
- **Native frames** are `styk export <file> <ticks> <folder> --matte` on the same machine: the same Rust renderer, the same
  `prim.wgsl`, on the wgpu DX12 and Vulkan backends.
- **Documents** (in place, never copied): the four owner documents (tdd2 ticks 100-105, 180-190, 400-405; svr_uriel 100-105,
  440-447; AyameDemo 100-105, 400-405; testingupload 500-505, 1200-1203; 59 frames, about 21 million pixels) and fourteen generated
  documents of 256 by 192 with twelve objects each, four frames, one primitive kind each (line, circle, filled circle, square line,
  curve, polygon fill, outline, text, picture, gradient, and the translucent forms of line, filled circle, polygon and
  picture). The generated documents are given to both sides as the report the app holds after import (the app normalises a
  hand-written report on import: lines read as translucent when given to the engine raw). Effects, blend modes, onion skins and
  the camera were not isolated in generated documents; the owner documents draw effect layers, particles, camera views and
  layered scenes.
- **Bisect**: a delta-debugging driver reduced a one-keyframe copy of a document to the objects that still make one pixel differ
  (Chromium frame against native frame, rendered for every trial), then single primitive kinds were switched off in the vertex
  shader, and shader expressions were replaced one at a time through a probe build that read the shader from a file. The probes
  are not in the repository.

## What was ruled out

- **Evaluation and draw lists.** The CPU rasterizer drawn by Chromium's WebAssembly build and by the native build gave
  **bit-identical frames** on tdd2 ticks 180-190, svr_uriel 440-447, AyameDemo 400-405, testingupload 500-505 and two generated
  documents (0 of 11,000,000 pixels differ). Both sides evaluate the document the same way; every difference is the GPU stack.
- **A cause in the document or the draw list order**: the frame of a document opened natively equalled the frame of the same
  document cut to one keyframe (checked for the reductions).

## Which backend

Native wgpu on this machine picks **Vulkan** by default. Chromium's WebGPU gave frames bit-identical to wgpu's DX12 backend on
pictures and translucent polygons (Vulkan differed in 603 and 460 pixels of the generated documents by one or two levels), and
after the fix below DX12 is closer to Chromium than Vulkan in seven of nine real document sets, equal in one (Vulkan is closer
in tdd2 400-405, 119 pixels against 134). Chromium therefore most likely draws on Direct3D 12 here (its adapter does not say). `styk_render::native_instance_descriptor()` now gives native hosts Direct3D 12 with FXC on
Windows (never a DXC found on the search path: DXC differs again, and the copy shipped with Electron crashes wgpu on this
machine); `WGPU_BACKEND` and `WGPU_DX12_COMPILER` still choose. `styk export` uses it.

## Cause 1, fixed: the clip position (DX12 compiler)

The vertex stage turned a screen position into clip space as `t / size * 2 - 1`. The hardware snaps that position to a 1/256
pixel grid before it decides which of a pixel's four samples a triangle covers, so a one-bit change moves an edge across a
sample. The DX12 compiler (FXC) folded `t / size * 2` into `t * (2 / size)`, which rounds differently; Vulkan and Chromium did
not. The sliver triangles of a smear figure (svr_uriel tick 446, a pixel at (392, 372)) differed by 64 levels, a quarter of the
coverage; the minimal reproduction was two objects. `clip_pos` in `prim.wgsl` now divides first and doubles after
(`let q = t / view.dest.xy; fma(q.x, 2.0, -1.0), fma(q.y, -2.0, 1.0)`), which no compiler can fold.

- **Test:** `styk-render/tests/clip_position.rs` compiles the shader's own `clip_pos` (cut out of `prim.wgsl`) into a compute
  pass on every desktop adapter and requires each result within an ulp of the exact value and the backends bit-identical for five
  sizes that are not powers of two. Before the fix: `Dx12 ... differs from Vulkan ... in 40651 of 81920 clip positions`; after:
  ok. (A GPU's division need not be exactly rounded; Vulkan's is not, so the test compares backends, not the exact value.)
- **Today's app is unchanged:** the fixed shader rebuilt into the WebAssembly engine gave Chromium frames bit-identical to the
  old ones on all 23 reference sets (0 differing pixels).
- Explicit `fma` in the world-to-screen transform was tried first and changed nothing at the pixel (native DX12 and Vulkan still
  differed there), so it is not part of the fix.

## The table: native DX12 against Chromium, matte frames

| Document, ticks | Frames | Pixels | Differing before | After | Worst (levels) before, after |
| --- | ---: | ---: | ---: | ---: | --- |
| tdd2 100-105 | 6 | 1,920,000 | 340 | 71 | 1, 1 |
| tdd2 180-190 | 11 | 3,520,000 | 572 | 95 | 2, 2 |
| tdd2 400-405 | 6 | 1,920,000 | 427 | 134 | 46, 1 |
| svr_uriel 100-105 | 6 | 1,680,000 | 206 | 48 | 2, 1 |
| svr_uriel 440-447 | 8 | 2,240,000 | 283 | 156 | 64, 1 |
| AyameDemo 100-105 | 6 | 3,900,000 | 25 | 4 | 14, 1 |
| AyameDemo 400-405 | 6 | 3,900,000 | 514 | 467 | 14, 1 |
| testingupload 500-505 | 6 | 1,224,000 | 654 | 158 | 1, 1 |
| testingupload 1200-1203 | 4 | 816,000 | 233 | 153 | 1, 1 |

Vulkan, for comparison (unchanged by the fix): 71, 198 (worst 6), 119, 244 (2), 493 (11), 7, 503, 278, 164 pixels in the same order.
After the fix, 0.0001 % to 0.019 % of pixels differ, all by one level except two pixels of two (tdd2 180-190).

Generated documents, DX12 (the fix changed none of them; they were close before): circle, filled circle (also translucent),
polygon fill (also translucent), square line, text, picture (also translucent) **0 of 196,608 pixels differ in four frames**;
curve 1, line 1 translucent and 3 plain, gradient 8, outline 9 (all one level).

## Byte comparison of exports

Today's FFmpeg arguments for MP4 (H.264, quality 0.8; `desktop/video-export-service.cjs`), run on Chromium's PNG frames and
on native PNG frames of the same ticks, with the bundled FFmpeg 7.1 (S3 showed the encoder path is byte-exact from identical
frames, and the encoder gives the same bytes twice on today's frames: true for all four):

| Document | Today's file | Native frames, before the fix | After |
| --- | ---: | ---: | ---: |
| tdd2 180-190 | 63,198 B | 63,524 B | 63,606 B |
| svr_uriel 440-447 | 107,395 B | 107,498 B | 107,355 B |
| AyameDemo 400-405 | 39,395 B | 39,345 B | 39,355 B |
| testingupload 500-505 | 37,885 B | 37,919 B | 37,994 B |

No file is byte-equal: a lossy encoder turns the one-level pixels left into different bytes, within 0.2 % of the size. Byte
equality for these exports needs bit-equal frames (see the floor). `styk-video` is not in this branch (S3's branch); the full
export of the same frames through it is the follow-up once S3 folds it.

## Floor: what remains

About one pixel in 10,000 to 50,000 differs by a level (two at most) between native DX12 and Chromium.

- **Where**: the interior of filled regions that arcs and triangles paint (AyameDemo 400-405: isolated pixels ±1 in a field of
  (165, 48, 51), found by delta debugging to one object; at the same place the other GPU stack has neighbours that differ),
  hairlines and gradients, and in tdd2 ticks 180-190 pixels of the reddish translucent shapes (not isolated to a primitive kind),
  which are the pixels the browser smoke X2 found alternating between two outcomes between identical runs: Chromium itself is
  not deterministic there, so no native frame can equal every run of it.
- **Attempt 1, the arithmetic of the shader.** On the AyameDemo reduction (15 pixels) every one of these changed the frame in
  no pixel: 32 forms of `sd_segment` (builtin `dot` and `length` against explicit `fma` chains in either order), 7 forms of the
  arc's `abs(length(v) - r)`, three forms of the hairline fade, the reciprocal of the scale refined by a Newton step, two forms
  of `unpack4x8unorm`, four forms of the gradient `mix`, rounding the triangle colour to a byte first. A change that does
  alter the frame (a 1 % opacity change) alters 8,660 pixels, so the probe was live.
- **Attempt 2, the interpolation.** Computing the fragment's world position from the fragment coordinate instead of the
  interpolated vertex output made the frame worse (284 pixels, worst 3).
- **Why it is outside the app's control:** the compilers of the two stacks differ (FXC through wgpu against Chromium's shader
  path, DXC being unusable here), and the arithmetic they differ in is not in anything the shader can name. D13 holds: the
  parity thresholds are not touched, and the fixed difference is small enough to say that today's frames and native frames are
  the same picture. The residue is recorded here for the checker and the native Handoff as a floor.

## For the checker and the orchestrator

- `styk-render/tests/clip_position.rs` fails on the old shader and passes on the new one on this machine (DX12 and Vulkan). Where
  only one backend exists it holds only the one-ulp check.
- `styk-render/tests/native_instance.rs` holds the backend and compiler choice.
- Stage fidelity (iced's presentation of the frame, the screenshot comparison of every screen with a stage) was not measured:
  no native stage exists yet. The renderer is the same, so what holds for frames holds for the stage up to the presentation copy.
- Straight alpha frames (WebM, VFW) were not compared; they go through the legacy canvas step (`docs/native/video-export.md` in S3).
