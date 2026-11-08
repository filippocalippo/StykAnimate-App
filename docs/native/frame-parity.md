# Frame parity: the native renderer against today's frames

Chunk FP, 2026-11-07, Windows only (decision N8: the web build is not part of this phase). The question: does the native app
(wgpu on the desktop GPU) draw the frames today's app draws (Chromium's WebGPU), for exports and for the stage? S3 had found one
end-to-end export comparison whose frames differed (decoded PSNR 66 to 68 dB). This page records where they differ, what was
fixed and what is left.

## Method

- **Reference frames** are the export worker's own pictures: `createExportFrameRenderer(...).renderNativeTick(tick, {preserveAlpha: false})`
  in today's app (Electron, WebGPU, an NVIDIA RTX 4070 SUPER, driver 32.0.16.1742), the PNG the worker hands to FFmpeg. They are
  taken **over black** (the engine's matte, what MP4 gets): the canvas's premultiplied round trip is lossless then, so the PNG is
  the straight frame the engine drew. Native frames are `styk export <file> <ticks> <folder> --matte` on the same machine: the
  same Rust renderer and the same `prim.wgsl`.
- **Documents** (in place, never copied): the four owner documents (59 frames, about 21 million pixels: tdd2 ticks 100-105,
  180-190, 400-405; svr_uriel 100-105, 440-447; AyameDemo 100-105, 400-405; testingupload 500-505, 1200-1203), fourteen generated
  one-primitive-kind documents (256 by 192, twelve objects, four frames), and one generated document of many thin subpixel
  triangles. Generated documents go to both sides as the report the app holds after import (the app normalises a hand-written
  report on import). Effects, blend modes, onion skins and the camera were not isolated in generated documents; the owner
  documents draw effect layers, particles, camera views and layered scenes.
- **Today's frames twice.** The owner documents were rendered by today's app a second time, to tell what is stable from what the
  reference itself varies in (X2 found two outcomes between identical runs).
- **Bisect**: a delta-debugging driver reduced a one-keyframe copy of a document to the objects that still make one pixel differ,
  then single primitive kinds were switched off in the vertex shader, and shader expressions were replaced through a probe build
  that read the shader from a file and, in both stacks, through probe shaders that print intermediate values as amplified bits.
  The probes are not in the repository.

## What was ruled out

- **Evaluation and draw lists.** The CPU rasterizer drawn by Chromium's WebAssembly build and by the native build gave
  **bit-identical frames** on tdd2 ticks 180-190, svr_uriel 440-447, AyameDemo 400-405, testingupload 500-505 and two generated
  documents (0 of 11 million pixels differ). Every difference is the GPU stack.
- **The output side** (render target, blending, multisampling), for the residue below: the target is `Rgba8Unorm` with no sRGB view
  in both stacks, the blend state is one pipeline descriptor in the shared WGSL pipeline, there is no alpha-to-coverage, sample
  mask or dithering, and four samples are resolved. The resolve cannot be the cause: at every one of the 15 pixels of the
  AyameDemo residue the four samples sum to a multiple of four, so any rounding of the average gives the same value and the
  samples themselves differ. Replacing the hardware resolve by a shader resolve (exact float average, round half up, truncation,
  round half even) made every variant worse (37 to 149 differing pixels against 15). Flipping Dawn's D3D12 render-pass toggle
  changed no pixel in Chromium.

## Which backend

Native wgpu on this machine picks **Vulkan** by default. Chromium's WebGPU gave frames bit-identical to wgpu's DX12 backend on
pictures and translucent polygons (Vulkan differed in 603 and 460 pixels of the generated documents by one or two levels), and
after the fix below DX12 is closer to Chromium than Vulkan in seven of nine real document sets, equal in one (Vulkan is closer
in tdd2 400-405, 119 pixels against 134). Chromium therefore most likely draws on Direct3D 12 here (its adapter does not say).

`styk_render::native_gpu` is how a native host gets its device: on Windows **Direct3D 12 with FXC is preferred**, then the other
backends are tried in turn when its instance, adapter or device cannot be had; `WGPU_BACKEND` and `WGPU_DX12_COMPILER` still
decide when set (an explicit choice is the only attempt); elsewhere wgpu's own choice is the only attempt. FXC is named, never a
DXC found on the search path (the copy shipped with Electron crashes wgpu on this machine). `styk export` uses it and prints the
backend it drew on. Test: `tests/native_gpu.rs` (the attempt lists, the fallback with the Direct3D 12 attempt forced to fail, all
attempts failing reporting every reason, a device from the host).

## Cause fixed: the clip position (DX12 compiler)

The vertex stage turned a screen position into clip space as `t / size * 2 - 1`. The hardware snaps that position to a 1/256
pixel grid before it decides which of a pixel's four samples a triangle covers, so one bit moves an edge across a sample. WGSL
lets a compiler reassociate; FXC folded `t / size * 2` into `t * (2 / size)`, which rounds differently from Vulkan and from
Chromium. The sliver triangles of a smear figure (svr_uriel tick 446, pixel (392, 372)) differed by 64 levels, a quarter of
the coverage; the minimal reproduction was two objects. `clip_pos` in `prim.wgsl` now divides first and doubles after
(`let q = t / view.dest.xy; fma(q.x, 2.0, -1.0), fma(q.y, -2.0, 1.0)`). That form keeps Direct3D 12 and Vulkan equal on this
machine; nothing in the language guarantees it, which is why a test holds it.

- **Test:** `styk-render/tests/clip_position.rs` draws 2,500 thin subpixel triangles at each of three sizes that are not powers
  of two (700×400, 1000×650, 599×331) through the production primitive pipeline on Direct3D 12 with FXC named and on Vulkan, and
  requires the frames equal byte for byte; and rectangles on whole pixels must cover exactly their pixels on either backend (a
  broken pipeline fails there, the fold does not). With the old shader: `[700, 400]: 8 of 280000 pixels differ between Direct3D 12
  (FXC) and Vulkan on NVIDIA GeForce RTX 4070 SUPER`; with the new one both pass. Without both backends it fails (or, with
  `STYK_ALLOW_NO_GPU=1`, is ignored) with the reason; it exists on Windows only. An exact CPU model of the GPU's division and
  snapping was tried and dropped: a GPU's division need not be exactly rounded (Vulkan's is not), so the model is wrong in rare
  cases, and the cross-backend comparison is the check that does not depend on it.
- Explicit `fma` in the world-to-screen transform was tried first and changed nothing at the pixel.

## The table: native DX12 against today's frames, matte

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

"After" is the final build, rerun once: 1,286 of 21,120,000 pixels (0.006 %), all by one level except two pixels of two (tdd2
180-190). Vulkan, for comparison (unchanged by the fix): 71, 198 (worst 6), 119, 244 (2), 493 (11), 7, 503, 278, 164 pixels in
the same order. Generated one-kind documents, DX12 (the fix changed none): circle, filled circle, polygon fill, square line, text,
picture, each also translucent where it has the form, **0 of 196,608 pixels differ in four frames**; curve 1, line 3 (1 translucent),
gradient 8, outline 9 (all one level).

**Representative cases beyond the canvas-size export** (the thin-triangle document, three frames, native against today's app):
an export at 640×480 (a zoom of the 256×192 canvas), smoothing *none* (crisp edges), smoothing *sprites* (supersampled twice), a
tiled export at 4097×2049 (three by two tiles of 2048), and straight alpha at the canvas size: **0 differing pixels in every one**
(3 × 921,600; 3 × 147,456; 3 × 147,456; 8,394,753; and for straight alpha the alpha of all frames equal, 9,184 opaque pixels equal
and 24,900 partly transparent pixels with equal alpha; the colour of a partly transparent pixel goes through the canvas's
premultiplied store in today's app, see `docs/native/video-export.md`). The stage's pan was not compared: no native stage exists,
and the stage is the same renderer with a different view.

## Byte comparison of exports

Today's FFmpeg arguments for MP4 (H.264, quality 0.8; `desktop/video-export-service.cjs`), run on today's PNG frames and on native
PNG frames of the same ticks, with the bundled FFmpeg 7.1 (S3 showed the encoder path is byte-exact from identical frames, and
the encoder gives the same bytes twice on today's frames: true for all four):

| Document | Today's file | Native frames, before the fix | After |
| --- | ---: | ---: | ---: |
| tdd2 180-190 | 63,198 B | 63,524 B | 63,606 B |
| svr_uriel 440-447 | 107,395 B | 107,498 B | 107,355 B |
| AyameDemo 400-405 | 39,395 B | 39,345 B | 39,355 B |
| testingupload 500-505 | 37,885 B | 37,919 B | 37,994 B |

No file is byte-equal: a lossy encoder turns the one-level pixels left into different bytes, within 0.2 % of the size. Byte
equality needs bit-equal frames. `styk-video` is not in this branch (S3's): the export of the same frames through it is the
follow-up once S3 folds it.

## Floor: what remains, per cause

**The recorded nine-set FP comparison was stable**: of the 1,286 differing pixels, none differs between today's two runs, and today's app differs from itself
in 1 pixel of 21 million (tdd2 180-190), so the reference's own variability (X2) explains none of the residue. D13 holds: no
threshold was touched. Every cause below is outside what the shader can name: the two stacks compile the same WGSL with different
compilers (FXC through wgpu; Chromium's own path, DXC being unusable here) and differ in the last bit of float arithmetic.

- **Analytic strokes: lines, arcs, outlines, curves, hairlines** (AyameDemo's flat-field pixels, 15 in the reduction, are the edges
  of arcs over the same colour). Probe shaders printing intermediate values as amplified bits in both stacks: the arc's radius,
  anti-alias width and half-width are **identical** (0 of 650,000 pixels differ), the coverage differs in the last bits in 0.5 to
  6 % of stroke pixels (line 4,444 of 196,608; outline 7,522; curve 1,078; AyameDemo reduction 2,199 of 650,000), which shows as
  ±1 level in 1 to 9 pixels per 786,000. Attempts, none reaching zero: explicit `fma` chains and forms of the distance
  (`sd_segment` in 32 forms, `sd_arc`'s length in 7, the hairline fade in 3, the reciprocal of the scale refined by a Newton step);
  the interpolated world position computed per fragment instead (1,645 differing against 2,199); an exactly rounded square root
  (worse, 3,069) and division (better, 1,919, not zero); the output side as above.
- **Gradients** (8 pixels): the same class; the paint's colour bits differ as well (probe: 12,493 of 196,608 pixels). Four forms
  of `mix` changed no pixel.
- **Translucent shapes**: translucent lines are the stroke class (1 pixel). Translucent polygon fills, discs, boxes, pictures and
  text are bit-identical in the probe and in the frames: **no residue**.
- **tdd2 ticks 180-190** (95 pixels, two at two levels): the reddish translucent shapes of the effect layer; stable in both runs
  of today's app. Not isolated to a primitive kind; presumably the strokes of the figures drawn over them.

### DX12 MSAA repeatability driver floor

ND (2026-11-08) established a separate **run-to-run driver floor** on NVIDIA GeForce RTX 4070 SUPER,
Windows driver 32.0.16.1742 (617.42), wgpu 30.0.1 with DX12/FXC. The trigger is
`D3D12_RASTERIZER_DESC::MultisampleEnable = TRUE` with translucent triangles, four-sample
RGBA8 UNORM targets and premultiplied blending. It is not a new tolerance for frame comparisons.
The stage and PNG export keep DX12/FXC because parity with today's Chromium frames wins.

A frozen evaluated draw list on one device still differed: A/131 at 1080p in 29/29 comparisons,
D/541 at 4K in 16/29. Main-target samples differ before resolve; isolated layers remain identical.
An independent constant-color triangle/quad grid removes the renderer, evaluator, assets and
analytic coverage. A **plain C++/HLSL D3D12 reproducer**, with FXC shader model 5.1, feature level
11.0, explicit clears, transitions, resolve, fences and checked readback, removes wgpu and Naga
too. With the flag set it changes two pixels by one channel level in **2/29 draws per fresh
device**, at iterations 12 and 26, on each of three devices. With only the flag cleared (still
four samples), all three devices give **0/29**, including partitioned draws. With the flag set,
partitioned draws differ in 29/29 comparisons. Unoptimized FXC and `IndependentBlendEnable`
controls do not cure it. This proves the platform/driver cause on this stack, not a particular
driver optimization. The temporary direct-D3D12 source was removed; logs and the retained portable
reproducer are described in [ND's evidence](../../engine/crates/styk-render/tests/msaa-determinism.md).

Observed native ticks are A at 1080p **131, 138, 181**, D at 1080p **571**, and D at 4K **541, 544**.
Most observed native repeat differences are **one channel level**, but not all: RM's final
equality runs (2026-11-08, `docs/native/render-memory.md`) found B (tdd2) at 1080p tick **164**
differing by **eight levels** between runs of the unchanged baseline binary (further baseline runs
reproduce either picture exactly), and A tick **202** varying by **two levels** baseline to baseline.
RM first saw 36 pixels on A/131 and four on D/541; ND's three-process comparisons saw up to **89
pixels** on A/131. These are observations, not bounds or allowances: no test may use them as a
tolerance; exact comparisons run on Vulkan. D/571 was reported by RM but did not recur in
ND's short runs. Vulkan's repeated and partitioned controls are byte-identical, as were RM's
960 RGBA hashes. Chromium/D3D12's X2 frames 183, 184, 185, 186 and 188 differ in 1–3 pixels by
one level; the shared driver cause is **very likely**, not independently proven for the browser.

Clearing the flag in a temporary vendored wgpu-hal 30.0.1 made all six diagnostics pass, but
worsened FP's nine-set comparison from **1,286 to 2,053 / 21,120,000 pixels** (59 frames), with
**767 newly differing pixels** and maximum error **2 to 11 levels**. Counts in the table's order
became `71,207,134,242,489,5,467,270,168`. The old differences remained. The owner rejected that
workaround; the vendor folder and Cargo patch were removed. No version, fixture or threshold changed.

**Test policy:** byte-for-byte export comparisons run on **Vulkan**. Renderer glyph/sprite repeat
tests, export/frame-buffer/policy tests, core stage/export comparisons and app/preview PNG identity
explicitly select Vulkan. Shipping backend selection and FP's Chromium comparison still use DX12.
The four DX12 MSAA diagnostics are explicitly ignored with this section as their reason; their
assertions remain exact. Run them through the machine queue after a driver update:

```text
cargo test -p styk-render --test msaa_determinism dx12_ -- --ignored --test-threads=1 --nocapture
```

The Vulkan repeat/fresh-device and partition controls run in normal renderer suites. `styk export
--verify` remains an exact backend diagnostic: on DX12 it names this floor and may fail; set
`WGPU_BACKEND=vulkan` for the repeatability gate. The Electron determinism smoke also remains an
exact diagnostic and names the floor. Neither tool silently accepts differences. The clip-position
test still compares opaque triangles across DX12/Vulkan (a different compiler regression); clear-only
host presentation, texture upload/readback and single-sample ink tests do not repeat blended MSAA.

#### Upstream issue draft (not submitted)

**DX12 MultisampleEnable causes nondeterministic translucent triangle MSAA on NVIDIA 617.42**

wgpu-hal 30.0.1 sets `D3D12_RASTERIZER_DESC::MultisampleEnable` whenever sample count exceeds one.
On RTX 4070 SUPER / driver 617.42 (32.0.16.1742), a constant-color triangle/quad grid with RGBA8
UNORM, four samples and premultiplied blending changes two pixels by one level in two of 29 draws
on each fresh device. Direct D3D12 without Naga or wgpu, and unoptimized FXC, reproduce it.
Vulkan and opaque DX12 controls are stable. Keeping four samples but clearing only this flag
removes the direct reproduction. Microsoft's [rasterizer contract](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_rasterizer_desc)
says the flag selects the line algorithm and does not affect triangle MSAA at feature level 10.1+.
Please investigate the driver behavior: clearing it changes our Chromium parity from 1,286 to
2,053 differing pixels, maximum 2 to 11 levels, so that workaround was rejected. The portable exact
reproduction is `styk-render/tests/msaa_determinism.rs` and its WGSL grid. No private input is needed.
