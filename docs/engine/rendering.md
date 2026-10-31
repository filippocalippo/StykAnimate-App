# Engine: rendering

How a draw list becomes pixels: the format (`engine/crates/styk-draw`), the GPU
renderer (`engine/crates/styk-render`), the CPU rasterizer
(`engine/crates/styk-raster`), the stage in the app (`src/engine/engine-stage.mjs`),
thumbnails, library previews and the camera monitor (`engine/crates/styk-wasm/src/views.rs`,
`preview.rs`, `src/engine/engine-thumbnails.mjs`, `engine-previews.mjs`) and export frames
(`engine/crates/styk-export`, `src/engine/engine-export.mjs`).

## The draw list (`styk-draw`)

One `Prim` record (64 bytes) per primitive, in world units, so a list is view
independent: pan and zoom change one uniform. Kinds (`K_*`) and flags (`F_*`)
are documented on their constants. Isolation `Group`s (translucent figures,
outlines, onion skins) draw into layers composited by a `K_COMPOSITE` record
at their place in the parent's painter order; group ids are given depth first.
A group whose artwork is filtered has a raster **layer** (`Group::layer` into
`DrawList::layers`, an `EffectLayer`): the rectangles the editor filters on and
the effect stack, opaque to the format ([vfx.md](vfx.md#rendering)). Top-level
artwork holding 3D faces or text has one too, without effects (`LayerKind::Raster`):
the editor draws it from a raster of its own ([Text](#text)). 3D faces are **depth runs**: a
`K_DEPTH_RESET`, then `K_TRI` records with `F_DEPTH` and their corner depths, depth
tested against each other and placed as a whole in painter order
([spatial.md](spatial.md#drawing)).
Paint records live in `DrawList::paints`; `sample_paint` is the reference
evaluation every renderer reproduces. Generated effects are `K_PARTICLE` records
(one per particle, in the shape bits of its kind, in its draw's local units) and
`K_BEAM` records; each points at its draw's rows in `paints` (its transform to the
world and its constants), `F_ADD` marks those blended additively, and
`DrawList::materials` names the particle material rows sprites sample
([vfx.md](vfx.md#generated-effects-on-screen)). An object that is one solid glyph
is a `K_GLYPH` record drawn from a mask of the glyph, followed by the glyph's own
triangles flagged `F_GLYPH_VECTOR`; `DrawList::glyphs` holds each record's
`GlyphMask` and triangles ([Text](#text)).

## GPU (`styk-render`)

| Module | Holds |
| --- | --- |
| `pipeline.rs` | the one WGSL pipeline (`prim.wgsl`) for every kind, bind layouts ([D8](decisions/0008-renderer-without-storage-buffers.md)) |
| `frame.rs` | one frame: isolation layer passes by round and depth, each depth's effect stacks after its passes, then the frame pass (MSAA ×4, resolved once) |
| `isolation.rs` | the layer atlas (8 pages of at least the frame's size, grown for larger effect layers, two for depth parity) and `plan_rounds`: layers that do not fit render in full-resolution rounds, the frame drawn between rounds |
| `images.rs` | the sprite atlas (texture array of 4,096² pages laid out by `styk_eval::assets`: shelves, and the free space an earlier page left before a new page opens), uploads of decoded images and drawing tiles |
| `resources.rs` | GPU record layouts, lookup tables in float textures, buffers |
| `present.rs` | copy into the host's surface, read-back |
| `view.rs` | world → output transform, artboard |
| `effects/` | effect layers ([vfx.md](vfx.md#rendering)): `plan.rs` places each group for the view (density, crop, composite), `mod.rs` writes its group record, `executor.rs` and `passes.wgsl` run effect stacks on pooled slots |
| `materials.rs` | the particle material atlas of generated effects: a placeholder texel until a list names a row, then the editor's procedural rows with their reduced levels (5.9 MB), sampled trilinearly |
| `glyphs.rs`, `glyph.wgsl` | the masks of lone glyphs ([Text](#text)): each glyph filled once per mask size into an atlas of one-channel pages kept across frames (at most 64 MiB), and the per-frame table that tells each `K_GLYPH` record where its mask is |

Drawing cels: every display level's tiles are in the list; the vertex shader
keeps the level `floor(-log2(pixels per cel pixel))` (0–8), using exact comparisons
of the selected tile's pixel density with 0.5 and 1 rather than the GPU's approximate
logarithm at powers of two. The fragment shader premultiplies straight-alpha texels
before filtering across tile borders; each 64×64 tile has two real neighbour texels
on every side (a 68×68 atlas slot), and halo tiles fade past the last occupied tile.
The frame, plain groups on it and camera image use bilinear filtering, as the
editor's GPU drawing display does.

In entry, nested and raster layers, including plain groups inside them, the editor
paints cels with Canvas 2D's `high` smoothing. `effects::plan::Placement::canvas`
marks that sampling rule for both renderers. At exactly 1×, including fractional
translations, it is bilinear; above 1× it is separable Mitchell-Netravali (B=C=1/3,
16 premultiplied taps, colour clamped to its alpha before opacity and blending).
When shrinking, the residual level of detail past 0.5 blends up to half of the
parent reduction into the tile's bilinear sample. An `F_DRAWING` primitive's `paint`
names the parent slot and quadrant in one lookup row; negative tile coordinates use
Euclidean division. The decoder publishes all levels together and the upload queue
takes higher levels first, so a child never samples an unuploaded parent. Crisp
edges keep nearest sampling, and onion tint uses the filtered coverage.

Effect rectangles follow the drawing's tight ink bounds, as `objectBounds` does,
rather than its whole tile coverage. The loader reads the published rectangle;
the existing PNG worker derives authoritative alpha bounds while it already holds
the level-0 pixels. Each immutable `DrawingTiles` retains only that rectangle in
`decoded_bounds`; empty decoded ink keeps the published fallback. Shared cels keep
the correction across document revisions. A changed rectangle invalidates cached
effect lists and requeues requested ticks; a cache epoch rejects earlier workers
and inline preparations. Export preparation holds at most `AHEAD` requests until
its image preload finishes, without waiting on a thread. Cancellation drops those
requests and rejects any earlier completion. Translation follows actual gradient
references once, leaving parent-atlas and generator rows unchanged.

Public crate changes for consumers moving their pin: `DrawingTiles` adds `bounds`,
`decoded_bounds` and `artwork_bounds()`; `Placement` adds `canvas`;
`styk_eval::drawing::BORDER` is 2, so decoded drawing slots are 68×68 instead of
66×66 (6.2% more slot bytes). Sprites retain their one-texel gutter, primitive
records remain 64 bytes, and these changes have no browser-only dependencies.

Verified in Electron on ANGLE/Vulkan at 1440×900, with D13 unchanged: the editor-built
`drawing-cels` document passes fitted, 0.3×, 2× and 3× views (mean beyond two levels
0.0004–0.0049, no solid differences). The five previously failing private-scene
ticks 46 and 61–64 all pass (mean 0.0002–0.0441, maximum 22, no differences above
32). The old whole-tile effect bounds were confirmed by a failing regression before
the correction. Headless web captures are now held until real cel decoding and
preview jobs finish, but the same synthetic document still fails against the
software Canvas fallback at all four views (mean 0.3473–1.3455; up to four solid
differences). Native CPU/GPU comparisons pass all 132 private frame-start thumbnails
and the synthetic document's three thumbnails plus smooth export (mean at most 0.0004,
max 3). Its crisp export still fails exactly as on the pre-change CLI (mean 0.2999,
max 222, no solid pixels). Private web captures timed out twice in animation-frame
settling with tracked resources ready; they remain unverified. These remain open
backend-parity gaps. The final diagnostic timing attempt ran at load 10.27–12.77 and
was too variable to support a cost claim; the idle engine-1 matrix is pending.

The later destination-grid correction passes those same four software-web stage views
on the final main build: mean 0.0682–0.1261, zero solid differences. Default Electron GPU
passes all four views and its engine RGBA output is byte-identical to the retained
original captures; all four software-web legacy captures are also byte-identical.
The draw-list entry marks exactly one published drawing image before tile expansion.
`DrawingGrid::Destination` uses the existing nested placement/filter owner for direct
software edit frames and thumbnails, including a single drawing
inside a movieclip with child/outer effects. Multiple children and ordinary onion
entries retain their existing policy. `DrawingGrid::World` remains the portable default
for prepared playback and ordinary GPU rendering. The private monitor request carries
this policy beside the same captured `MonitorFrame`; it does not rebuild a snapshot.

Final main acceptance additionally passes the real dense single-child movieclip and
the serialized child-Blur/outer-Tint fixture (mean 0.0682 and 0.001352 respectively,
zero solids). Shared-type validation passes 632 native tests and 31 focused JavaScript
tests; both new editor-built fixtures matched when recorded. Eligibility and plan
regressions expose the relevant actual source mutations. The shipping engine is
9,584 KiB (`79ce084e8d9d`); no cost comparison is certified by these loaded runs.

Auxiliary software-WebGL onion views at 320×192 still fail (mean 0.288346), as does
the 278×139 edit monitor (0.714171). An actual empty-background editor monitor
independently reproduces 278 fractional-border pixels (mean 0.352518): Canvas applies
the rectangular clip before background painting, whereas the engine draws one edge.
Native CPU World and Destination outputs are byte-identical to each other and captured
WebGL for that empty scene. This isolates a separate clip/paint owner issue; removing
those border pixels alone would leave the full cel monitor above D13. CPU diagnostics
are not substituted for browser acceptance. Private web and crisp export remain open.

Mobile pin additions: `LayerKind::Entry.single_drawing: bool` in `styk-draw`;
`DrawingGrid::{World, Destination}` and `effects::plan::plan_with_grid` in `styk-render`;
`Renderer::set_drawing_grid` and `Raster::set_drawing_grid` (the latter reuses that same
portable enum). Update exhaustive entry construction. Primitive records remain 64
bytes and no shader/sampler format changed. `Stage::set_canvas_drawing` and the private
monitor wrapper are confined to `styk-wasm`; native callers keep the world-grid default.

Regression coverage lives in the eval and engine `tests/drawing_bounds.rs`, the eval
drawing/translation tests, and `styk-raster/tests/drawing_sampling.rs` (24 CPU/GPU
sampling cases). Bounds tests include late shared-cel decoding, stale same-tick
completions, cancellation and the export queue limit.

Depth runs: a list with faces gets a multisampled `depth24plus` buffer per pass
and two variants of the one shader's pipeline (painter order writing depth; faces
tested `less-equal`), switched where faces begin and end; the vertex shader maps a
corner's depth to its window depth with the editor's expression.

Generated effects: the vertex shader expands each `K_PARTICLE` or `K_BEAM` record
exactly as the editor's generator shader does, in its draw's local units with the
target's pixel in those units, then places it by the draw's transform; the fragment
shader shades it as the editor's does. Runs of `F_ADD` records draw with an additive
pipeline variant (colour and alpha added), created with the first list that has one.

Lone glyphs: before the passes, `GlyphMasks::prepare` lays out each `K_GLYPH`
record's mask for the view's raster density and writes the glyph table (three
texels per record: the texel axes in the world, the origin and mask size, the
mask's place in the atlas); a mask no frame has filled yet is filled then, in the
same command buffer, so no frame waits for one. The vertex shader places the
record's quad from the table and collapses its `F_GLYPH_VECTOR` triangles, or the
other way round where the view gives it no mask; the fragment shader samples the
mask bilinearly, clamped to its own texels, times the record's colour and opacity.

Invariants: no per-frame allocation in steady state; the no-effect path draws
one pass per depth and round and creates no effect resource; a list without 3D
faces creates no depth buffer and a list without additive records no additive
pipeline, and either draws one instanced draw per pass; the material atlas is a
placeholder texel until a list names a row, and the glyph atlas until a list has a
lone glyph; glyph masks are filled only when first needed; WebGL2 limits (no storage buffers, one sampler
per texture, array textures of at least two layers, [D11](decisions/0011-array-textures-two-layers.md)).

## Text

The JavaScript editor's WebGPU renderer (since deleted) never drew text as vectors
below a raster density of 8; the engine draws it the same two ways.

- **Text in an object raster.** Text is one of the things `requiresCompatibilityTexture`
  names: the object holding it (or the movieclip instance, or the connected run) is
  painted by Canvas 2D on a raster of its own (`rasterObject`) on a world-aligned grid
  at `rasterResolution` of the view (a quarter octave at or above the screen's density,
  at least 0.5), then drawn as a texture, sampled bilinearly. The engine gives such an
  entry a `LayerKind::Raster` group on the editor's `objectBounds` (`styk_eval::drawlist`,
  `raster`), drawn on the editor's grid for the view (`effects::plan`, as for 3D
  artwork) and composited bilinearly.
- **A lone glyph from a glyph mask.** An object that is one text segment with one
  visible character, solid, without effects, figure outline or movieclip
  (`glyphTextureDescriptor`; Pivot imports have many, one character per figure) is
  drawn from a mask of the glyph alone: its path filled in glyph space on a grid of
  power-of-two sides, at least 1.25 times the view's raster density, with two texels of
  padding, then drawn as a quad, tinted and faded. `GlyphMask::layout` (styk-draw) is
  that arithmetic, in the editor's order; the test
  `glyph_masks_are_laid_out_as_the_editor_lays_them_out` holds numbers the editor's own
  function printed. The object's opacity goes into the record's colour, as the editor's
  shader applies it, so a lone glyph needs no isolation layer. Above density 8, or for a
  mask above 4,096 texels, the editor rasterizes the object instead; the engine then
  draws the glyph's triangles.

**Masks** (`glyphs.rs`): one mask per glyph tessellation and mask size, shared by every
instance, filled with four samples a texel and resolved, in square one-channel pages of
1,024 texels a side, grown to the frame's largest mask (up to 4,096; growing drops the
masks, which are filled again as they are drawn), at most 64 MiB of pages. They are kept
across frames; when a mask does not fit, the least recently used page that no record of
the frame samples is emptied; a record whose mask cannot be placed is drawn from its
triangles for that frame. The masks
are filled on the GPU in the frame's own command buffer: nothing is rasterized on the
interface thread and nothing is waited for (D7). Entries hold their triangles, so a key
(the triangles' allocation) is never reused while kept; a new document's glyphs age the
old ones out.

**Curves.** Glyph triangles flatten curves within 0.02 glyph units, and finer by halves
for text drawn large (`styk_eval::assets::glyph_level`), so that they stay within 0.1
world units of the outline the editor fills; Pivot text is often drawn 50 to 60 times its
glyph size, where 0.02 glyph units put curves a pixel off at the fitted view. Finer
tessellations are made when first drawn (on the thread drawing, also the interface thread
for edit frames) and kept per document up to 64 MiB, behind a spinning lock held only for
a lookup or an insertion.

**What differs.** Inside a raster, the editor's Canvas 2D in Chromium is GPU-accelerated
at those densities: its text coverage takes nine levels (eighths), and the engine's four
samples five. Measured on two captions of `Impact-FX-Fight.styk` filled by the editor's
own scratch canvas in Electron (accelerated, as `rasterObject` uses it) against the same
glyphs filled by other rules: the edge pixels differ by 22.9 and 26.1 levels on average
from four standard samples; 13.0 and 19.4 from eight standard samples (65 % and 45 % of
edge pixels equal); 16.5 and 17.7 from tiny-skia, a CPU rasterizer; and the editor's own
software canvas (which `rasterObject` uses when zoomed in) differs from the accelerated
one by 13.6 and 17.5. No rule reproduces the accelerated canvas, which depends on the
browser and the GPU, and WebGPU offers one or four samples, not eight; the engine keeps
four samples and the GPU, with no CPU raster or worker job.
Devices without WebGPU: the editor's Canvas 2D fallback draws text as vector paths at the
screen's density, the engine as the WebGPU renderer does, as for polygon seams and
generated effects.

**Measured** (2026-10-03, RTX 4070 SUPER, machine shared with other work at a load
average of 5 to 40). App parity (the app-parity script, since deleted; D13 limits unchanged,
onion skins on, 1,440×900 window, Electron under Xvfb with the Linux Vulkan switches),
the engine on WebGPU against the editor's WebGPU renderer, before (engine-rust at
`904cad9e`) and after:

| Document (steps) | Before: passing, mean beyond 2, solid pixels | After |
| --- | --- | --- |
| 15-Guns-Pivot-3D.styk (5 ticks) | 0/5, 0.387–0.747, 9 | 4/5, 0.185–0.294, 0 |
| Hand-and-Face-Pivot-3D.styk (5 ticks) | 2/5, 0.166–0.431, 4 | 5/5, 0.070–0.174, 0 |
| Vehicles-Pivot-3D.styk (5 ticks at fit, 0.3× and 3×, after playback) | 7/16, 0.039–0.566, 9 | 16/16, 0.017–0.211, 0 |
| Impact-FX-Fight.styk (ticks 30, 108, 157, 185, 192, 205) | 0/6, 0.321–0.382, 0 | 6/6, 0.168–0.217, 0 |
| Impact-FX-Fight.styk (ticks 30, 185 at 0.3× and 3×, after playback) | 2/5, 0.047–0.380, 4 | 5/5, 0.047–0.217, 0 |
| Uriel 19-2-2026.piv (private corpus, lone glyphs; ticks 20, 210, 280, 370) | 2/4, 0.071–0.670, 0 | 4/4, 0.049–0.232, 0 |
| Karate-Fighter-Movement.styk, Katana-Turntable.styk (no text; 16 and 5 steps) | 21/21, ≤ 0.005 | 21/21, unchanged |

Before, the text objects' rectangles held 69–100 % of each step's sum at the fitted view
(Impact: 5–6 % of the stage held 69–79 %, and the stage without them stays at
0.073–0.116, so figure edges are no failing cause of their own); a text pixel differed by
3.2–5.3 levels on average (8.9–10.6 at 0.3×), after by 1.4–2.3. The step still failing,
15 Guns tick 0 (mean 0.294), is the cover page, 13.9 % of it text, which holds 99 % of the
sum: the coverage rule inside the rasters above. Measured while building it, Uriel tick 210
needed the finer curves (0.358 with masks alone, 0.101 with them) and tick 370 the opacity
in the glyph's colour (0.304 with an isolation layer per translucent glyph: 325 groups and
a downscaled round; 0.232 without).

Web target (headless Chromium, the engine on WebGL2 against the editor's Canvas 2D
fallback), before and after: Impact (ticks 30, 108, 185) 0/3 at 0.348–0.434 and 0/3 at
0.414–0.506; Hand & Face (0, 252, 504) 2/3 and 1/3; 15 Guns (0, 3) 0/2 at 0.510–0.845 and
0/2 at 0.610–1.089; Uriel (210, 370) 0/2 at 0.491–0.787 and 0/2 at 0.269–0.780; Katana 2/2
and 2/2. The editor's own two renderers differ more than either from the engine: its
WebGPU pictures against its Canvas 2D pictures 0.491, 0.668, 1.165 and 0.876 (Impact 30,
Hand & Face 0, 15 Guns 0, Uriel 370), the engine on WebGL2 against them 0.414, 0.582,
1.089 and 0.780, and against the WebGPU pictures 0.298, 0.311, 0.475 and 0.348.

Cost. GPU frame (`styk gpubench`, 1,440×900 over 200 zoom levels, p50 of three
interleaved rounds, before → after): Uriel tick 370 1.87 → 0.65 ms and tick 210 1.76 →
1.11 ms (lone glyphs need no layer); 15 Guns 0.25 → 0.24, Impact 0.13 → 0.13, Vehicles
0.28 → 0.27, Karate 0.24 → 0.25, Jay 0.25 → 0.24 ms. Draw-list encoding over every tick
(`styk bench`, three interleaved rounds): Uriel 2.07–2.17 → 2.13–2.71 ms a frame (31,808
→ 34,926 records, the finer curves), 15 Guns 1.50–2.40 → 1.09–1.65, Impact 0.22–0.27 →
0.27–0.30, Jay unchanged (0.37–0.40). Masks: filling those of a new density takes 0.2 to
1.9 ms of a frame (4 to 8 masks, Uriel at 2.2 times the fitted view); in the app the atlas
held 9 masks in 2 MiB at Uriel tick 370's fitted view, at most 64 MiB. Edit frames in the
app (the stage's timing of `render_edit`, Uriel ticks 360 to 380 with onion skins, three
interleaved rounds at loads of 12 to 41): medians 86–412 ms before and 104–408 ms after;
the quietest round 86–96 against 104–108 ms (the draw list holds 26 % more records:
330,238 → 417,744 with the onion skins). Not measured: other GPUs, browsers' frame times.

## CPU (`styk-raster`)

The GPU renderer's pipeline carried out on the CPU, rule for rule, so a frame drawn here is
the frame the stage draws: for devices with neither WebGPU nor WebGL2 and for tools
(`styk raster`, `styk export --cpu`). It replaced a tiny-skia rasterizer that covered edges
as Skia does (a few partial-coverage levels at thumbnail sizes), drew no filter effects,
drew raster entries at the output's density and resolved each depth run to its nearest
faces before compositing it.

| Module | Holds |
| --- | --- |
| `frame.rs` | one frame: each group placed by styk-render's plan, drawn into a target of its own, filtered, composited; every primitive kind |
| `target.rs` | a target with the GPU's samples: four RGBA8 samples a pixel (one for crisp edges), blended one by one, averaged when resolved |
| `coverage.rs` | the GPU's rasterization rules: vertices snapped to 1/256 pixel, the standard four sample positions, the top-left rule |
| `shade.rs` | `prim.wgsl`'s fragment arithmetic: coverage by distance, the strokes' distance functions, texture sampling |
| `effects.rs` | effect recipes run pass by pass with the arithmetic of `passes.wgsl` |
| `glyphs.rs` | masks of lone glyphs, kept across frames |
| `generators.rs` | generated effects: the GPU's quads, its fragment arithmetic |

**One plan for both renderers.** What does not need a GPU lives in styk-render without its
`gpu` feature, which styk-raster depends on: `ViewParams`, `Edges`, where each group is
drawn for a view (`effects::plan`: a translucent figure on its parent's grid, a raster entry
or filtered artwork on the editor's raster grid at its density, the camera image through the
scene camera) and its group record (`effects::record`, here with every layer at the origin
of a target of its own), and effect recipes (`effects::recipe`: the passes `VfxWebGPU.run`
records, with their parameters). The GPU's atlas, rounds and pooled slots are resource
management and have no CPU counterpart: a layer is drawn at full resolution into a target of
its size.

**Rules followed.**

- Samples: a target keeps one colour per pixel until a write covers only some of its
  samples, then four; a write that leaves them equal folds them back. Blending is the
  pipeline's (`One, OneMinusSrcAlpha`; `One, One` for `F_ADD`), each result rounded to 8
  bits as an `Rgba8Unorm` target stores it; resolving averages the samples.
- Strokes, arcs, polylines, discs and rings are covered by distance at each pixel's centre
  (`clamp(0.5 − d / aa, 0, 1)`, hairlines faded to a one-pixel footprint; crisp: in or out),
  over the pixels of the quad the vertex shader draws. A polyline takes each pixel's nearest
  segment.
- Triangles, image and glyph quads, composites, particles and the artboard fill are covered
  by the samples, so adjacent triangles share their edges' samples: no seams between faces,
  glyph triangles or polygons of different colours, and none between a cel's tiles.
- Paints are `sample_paint` at the pixel's centre; sprites bilinear (`F_SMOOTH`) or nearest
  within their gutter; cel tiles premultiplied texel by texel, then sampled across their
  borders by the layer's drawing rule above, at the level its density shows; composites bilinear, clamped to the child
  (nearest with crisp edges); backgrounds nearest.
- Depth runs: the reset's quad sets the far depth, then each face is drawn over what is
  there, sample by sample, where its depth (the vertex shader's window depth, interpolated
  at the sample, stored at 24 bits) is not greater than what the run drew there: translucent
  faces blend in drawing order, an equal depth passes.
- Lone glyphs: masks laid out by `GlyphMask::layout` for the view's raster density, filled at
  four samples a texel and kept across frames by glyph and size (at most 64 MiB, the least
  recently used first out); an instance without a mask draws its triangles.
- Filter effects: after a filtered layer is drawn and resolved, its recipe runs on its
  pixels, each pass written to an RGBA8 slot of its size and sampled bilinearly with edges
  clamped, as on the GPU. Box passes and alpha dilations of a source as large as their
  target take whole texels, so they run with prefix sums and a monotonic queue (equal to
  shading each pixel within a level, `windows_equal_the_shader`).

**What still differs.** Near-coplanar 3D faces: two faces nearly in one plane (a seat on a
tank, a decal on a receiver; measured 7 and 16 steps of the 24-bit buffer apart) resolve by
the last bits of each GPU's vertex arithmetic (where its layer sits in the atlas, fused
multiply-adds, its depth interpolation), which differ between GPUs too; the CPU interpolates
exactly from the snapped vertices. The GPU draws layers too large for its atlas pages at a
lower scale in a lone round (`plan_rounds`); the CPU never does. Texture filtering and
resolves round in the last level.

**Memory.** A frame holds the view-sized target, then one target per isolation group on the
path being drawn (a layer's size: its rectangle on its grid), each four bytes a pixel plus
sixteen per pixel whose samples differ; a filtered layer adds its working slots (at most
eight of its size). Glyph masks stay within 64 MiB. Images are the decoded images the
engine holds, not copied (`Images::add_shared`). Nothing is pooled between frames; exports
bound a frame by drawing it in tiles.

### Measured

`styk raster-parity` draws the same draw lists and views with both renderers (frames as the
app's thumbnails and exports take them from `ExportFrames`; library files as the asset library
opens them) and compares them by D13, limits unchanged, alpha counted. 2026-10-04, RTX 4070
SUPER (Vulkan) for the GPU, the machine shared with other work (load averages 6–21). Before:
the tiny-skia rasterizer (`86124552`); after: this one. Repository corpus: the 388 tracked
`.styk`, `.stkz` and `.stykmov` files and 47 editor-built fixtures (effects, generated
effects, 3D, drawings, text; 2 have no keyframe), thumbnails at up to five frame starts,
exports at three; library previews of the 193 `.stkz` and `.stykmov` files (poster and three
hover frames). Passing steps, both rules (no solid pixel / mean):

| Steps | Before | After |
| --- | --- | --- |
| Thumbnail 320×192 (899) | 435 (857 / 438) | 899 (899 / 899) |
| Thumbnail 512×288 (899) | 607 (857 / 614) | 899 (899 / 899) |
| Thumbnail 96×54 (899) | 144 (790 / 144) | 899 (899 / 899) |
| Export, canvas size, Smooth edges (677) | 645 (645 / 665) | 677 (677 / 677) |
| Export, No smoothing (677) | 629 (645 / 649) | 677 (677 / 677) |
| Library poster (193) | 36 (179 / 36) | 193 (193 / 193) |
| Library hover frame (579) | 52 (520 / 52) | 579 (579 / 579) |
| Private corpus (8 files: URIEL 3 with its blur, glow, bloom and tint, Jay, Pistol-3D, four Pivot imports): thumbnails at three sizes (93) | 49 | 93 |
| Private corpus: exports, both samplings (38) | 33 | 38 |

Twelve frame starts of each of the 180 3D documents (scenes, turntables, demos, packs and
spatial fixtures): 1,244 of 1,244 thumbnails at 320×192 pass, 1,242 at 512×288 and 1,231
exports, every failure by solid pixels where two near-coplanar faces meet (above); no mean
fails. Which effects the documents use (`--census`, every tick): the repository's documents
and asset packs draw no filter effect (9 hold generated effects); the effect fixtures draw all
17 kinds; the private corpus draws blur (99 frames of URIEL 3), glow (54), bloom (47), tint
(36), RGB split (2) and outline (1).

**Time per frame** (native, one thread; `styk raster-parity --repeat 5`, one CPU renderer per
document kept across its frames; three rounds alternating the two builds, the median over three
frame starts per round, the range over rounds; 2026-10-04 07:44–07:47, load averages 9–12 on 12
threads; the tiny-skia rasterizer drew no filter effect, so the effects fixture and URIEL 3 are not
the same work):

| Document | Thumbnail 320×192, tiny-skia → now | Export at the canvas size, tiny-skia → now |
| --- | --- | --- |
| 15-Guns-Pivot-3D.styk (3D, text; 1,920×1,080) | 14.1–25.8 → 9.5–9.8 ms | 386–578 → 95–101 ms |
| Vehicles-Pivot-3D.styk (3D, text; 1,920×1,080) | 12.8–21.4 → 10.2–17.7 ms | 369–544 → 98–157 ms |
| Impact-FX-Fight.styk (captions; 1,920×1,080) | 7.3–9.1 → 3.5–6.0 ms | 219–235 → 79–126 ms |
| Bamboo-Training-Grounds-Demo.styk (800×600) | 16.5–26.8 → 14.9–26.6 ms | 109–179 → 55–101 ms |
| hitoshi vs suzu tomiee ssj.piv (private; 760×420) | 11.2–21.5 → 7.5–13.3 ms | 33–61 → 32–58 ms |
| Karate-Fighter-Movement.styk (3D rig; 800×900) | 2.3–3.5 → 4.4–9.3 ms | 20–34 → 15–32 ms |
| drawing-cel fixture (960×540) | 1.2–1.4 → 2.5–3.9 ms | 2.0–4.2 → 14.1–24.9 ms |
| explosions fixture (generated effects; 960×540) | 0.3–0.7 → 0.6–1.2 ms | 2.2–6.5 → 5.4–9.9 ms |
| TDD2 URIEL NEMESIS 3.styk (private; now with its effects; 800×400) | 6.0–12.6 → 8.0–13.2 ms | 23–44 → 55–88 ms |
| effects fixture (fourteen effects on one figure; 960×540) | 2.3–4.3 → 90–152 ms | 20–29 → 531–858 ms |

Text and 3D scenes draw faster (tiny-skia filled each glyph and face path at the output's density);
drawing cels and plain figures slower (each pixel of a cel's quads is sampled bilinearly, where
tiny-skia's pattern fill is vectorised); filter effects cost what their passes cost, a few to tens
of milliseconds a pass at export sizes. In the app's export, frames are drawn in tiles of at most
1,024 pixels (`styk export --cpu`, 1,920×1,080, median of 5 frames, load 9–12: Impact 83 ms,
15 Guns 97 ms, URIEL 3 145 ms; hitoshi 336 ms before the stroke interiors were filled without the
square root, then 417–422 ms against 553–568 ms without it, interleaved at load 15–17). The
WebAssembly engine module grew by 109 KiB (7,980,628 → 8,092,410 bytes without wasm-opt, the
build before this work against this one).

## Encoding over the last frame

A gesture changes a few objects of a frame of hundreds. The edit frame is the session's `ShownScene`
([evaluation.md](evaluation.md#the-interfaces-frame)), built over the one before it, and its scene says which build made each
object's geometry (`Scene::built_in`, numbered across every memory). `EditScene` keeps what the last frame was encoded as
(`drawlist::EncodeMemory`), and `encode_composed_remembering` encodes only the objects whose build is not the one it kept; the list
is the list encoded whole (`styk-eval/tests/build_memory.rs`). Only a plain frame is kept: nothing in it draws effects, 3D faces or
text, no drawing cel is live, and an object being dragged is encoded afresh (its translation is applied after encoding).
What the encoder keeps is judged by numbers, never by addresses: the assets by `Assets::id` (each `Assets::extended` is numbered) and a
scene by its `Scene::stamp` (each build is numbered, and a built scene is never changed). The onion skins are kept the same way: a ghost
is encoded once and drawn again while it is the same scene (stamp) under the same hidden slots, tint, effects setting and assets, so a
gesture does not encode them at every step; none is kept while a drawing cel is live. `styk-eval/tests/build_memory_stale.rs` compares
every such list with the list encoded whole.

## In the app

`src/engine/engine-stage.mjs` draws the page's scene canvas (`#scene`) with the
engine: the edit frame (the one the open document's session shows, `Stage::edit_session`: nothing crosses from
the interface), onion skins (the poses the session plans, `Stage::set_onions`: [evaluation.md](evaluation.md#the-interfaces-views)) and prepared playback frames of every document
([D4](decisions/0004-strangler-gate.md), [Every document](#every-document)); no other
renderer draws a frame. The WebGPU surface is configured with
premultiplied alpha so the page shows through the pasteboard. Through the scene
camera (prepared playback frames, and edit frames in the camera preview) the scene is
seen through the shot (follow clips, camera-motion impulses) and parallax layers
move: the frame's per-object offsets ([evaluation.md](evaluation.md#the-scene-camera))
join the drag translations of the draw list. Filter effects are
drawn by the engine; the effects preview switch reaches it through
`Stage::set_effects` and `EngineHandle::set_effects`. Generated effects are drawn
by the engine (an edit frame whose trails are still being sampled asks the app for
another frame, `Stage::refining`); so are 3D meshes, surfaces, poses and drawings a
spatial bone turns.

### Picking artwork

A click on artwork (`pick` in `src/app.mjs`) asks the stage which figure the frame it drew last paints at the point
(`Stage::pick_artwork`, `styk_export::pick`): the figures are taken from the top of the draw order down, those hidden or
locked left out, and each whose measured bounds reach the point (a movieclip's contents always) is drawn alone, without the
background or effects, into a three-pixel surface centred on the point at the view's scale by the CPU rasterizer. The first
whose centre pixel has any coverage is the answer, `{slot, uid}`. A click hits what is painted: fills, curves, pictures,
meshes, movieclip contents and transparency. The pictures it samples stay decoded between clicks within the rasterizer's budget.

### Every document

The engine draws every document the editor holds: no document keeps the JavaScript
renderer (the renderer and the eligibility gate are gone). What the stage does with a frame it
cannot draw is a condition of the frame, never another renderer:

- **Not ready yet.** The document is committing (`engine_busy`: drawn again at the engine's next
  progress), a followed camera pose awaits its worker (`Stage::camera_pending`: the frames sync, then
  a redraw) or the surface is being resized (`Stage::surface_pending`: the next animation frame).
  `render` returns false and the previous picture stays.
- **A drawing in progress** is not a condition: strokes not yet published, fills, floating selections
  and the first stroke on a blank exposure (the new cel being previewed) are drawn from the tiles the
  interface holds for them ([Live cels](drawing.md#live-cels)).
- **Refused.** An error from the store, a sync or the draw is reported once (`onError`), the previous
  picture stays and the document's next revision is tried again (`engine-failure.mjs`: a refusal
  belongs to one revision of one document, no longer to the page).
- **A lost device.** Polled every second and on every frame (`Stage::device_lost`, and
  `take_device_errors` for errors nothing captured, which would otherwise panic and stop the engine
  module); the stage reports it (`onStatus`) and draws nothing more. The app replaces the canvas and
  creates a stage on a new device: the engine keeps the document and decodes the pictures again
  (`Engine::redecode_images`). `Stage::lose_device` destroys the device for the tests of that path.
- **A turned or mirrored Draw view.** `Stage::set_view_orientation` (rotation in radians about the
  artboard's centre, then a horizontal mirror, as `cameraMatrix` in `renderer-geometry.mjs` places
  it): `styk_eval::view::orientation` composes after the scene camera, and the artboard, its
  background, the camera image of scene effects and the artboard clip follow the turned quad
  (`orient_*` in the view uniform of `prim.wgsl`; `orientation` tests in styk-render).
- **The quality ladder.** The surface scale through `resize` and the edge sampling through
  `Stage::set_multisampled` (four samples or one).
- **A surface larger than the device's textures** is clamped (`Stage::max_texture`).
- **An engine that cannot start** (no shared memory, no graphics device) is a localized error
  (`errors.engineStage.theDrawingEngineCouldNotStart`) in the renderer panel.

Checked in Electron on WebGPU (2026-10-24): the start document, the `auras` generator fixture and a large
private Pivot file (735 ticks): still, scrub, play, the Draw view turned 30° and mirrored, onion skins and the camera
preview, every frame drawn by the engine (`engineStats.refusal` null); `Stage::lose_device` was reported at the next
poll and the app was drawing again on a new stage within 1.5 s, with the picture restored.

Two conditions of a document the gate used to count:

- **Movieclips nested deeper than 16 levels.** Nothing in the engine limits the depth but the
  store's: it reads 512 levels of JSON, a clip taking five of them, so 100 clips open and 102 are
  refused (the stage then keeps its previous picture and reports the refusal, as for any document the engine refuses). A file
  opens eight levels (`validateMovieclipGraph`), so only nested editing in a session builds
  deeper documents: `deep-seventeen` and `deep-twenty-four`
  (recorded fixtures, frozen: each clip made, placed and entered in turn, the figure
  at the bottom animated through every level, loaded without the file
  check) match the editor primitive by primitive at five ticks, and changing the pose at the
  bottom of the chain breaks the comparison (`styk-eval/tests/document.rs`). The gate counted
  from zero, so 17 levels passed it and 18 did not.
- **Frame drafts.** `_styk.simpleFrameDraft` (the Simple timeline's working frame,
  [SIMPLE-FRAME-DRAFTS.md](../SIMPLE-FRAME-DRAFTS.md)) keeps the stored pose and animation beside
  the working ones. The stage draws the frame the session shows, and its onion skins (the stored
  pose among them) from the poses the session plans for them, so a draft reaches the engine only as
  metadata nothing it evaluates reads; its playback, thumbnails and exports hold the document as
  the editor does. The app gives every document a layer sheet, which deletes the draft of a native
  one (a draft a file brings with its sheet stays in the document, unused until drafts are
  enabled); `frame-draft-add` and `frame-draft-update` are native projects saved with a draft,
  `frame-draft-sheet` a sheet document carrying one, each compared with the editor by
  `styk-eval/tests/document.rs`. The stored-frame view of the JavaScript playback
  (`storedFrames`: the Simple timeline of a document *without* a layer sheet, derived by
  `storedFrameReport`: no Add pose, the stored animation, no keys for an empty draft) is not
  applied by the engine's playback adapter; the app never asks for it (`syncPlayback` asks only
  where there is no sheet).
- **An animation with no keys**, as Pivot permits one (`empty-animation`). The editor holds it as
  one empty working pose (and a draft marking it, which the sheet deletes), so the engine receives
  one key. A document holding no keys has no playable ticks (`Generation::playable_ticks`) and no
  artwork.

App parity (D13 limits unchanged) on these documents with onion skins and after playback, in a
1,440×900 window, 2026-10-24: the web build (headless Chromium) and Electron on WebGPU, each
`deep-seventeen`, `deep-twenty-four`, `frame-draft-add`, `frame-draft-update`,
`frame-draft-sheet` (also with the draft enabled in the app, `--frame-draft`) and
`empty-animation`: 14 runs and 120 steps, every one drawn by the engine, no solid pixel, mean
difference at most 0.049 levels (web) and 0.036 (Electron). The engine's thumbnail and export document sync
(`engineDocument`) accepted `deep-twenty-four` and `frame-draft-sheet` in the web build, and
the thumbnail drawn was the engine's.

**Pictures that arrive after the frame.** Pictures and drawing cels decode on the engine's
workers after a document opens, and the stage uploads them a slice at a time (8 MiB a
frame) when it draws. A still frame drawn before its pictures arrived used to stay without
them until something else drew (URIEL 3 opened at tick 44: its drawing cel missing, 23,783
solid pixels in app parity). The stage now notes the atlas places it has uploaded
(`styk_engine::Uploaded`) and, after each frame, whether that frame samples a place not
filled yet while pictures are still on their way (`Stage::pictures_pending`: looked up only
then); the interface draws again on the next frame when the missing pictures are decoded and
wait for upload, or once the engine's progress counter advances when they are still decoding
(`waitForPictures` in `engine-stage.mjs`: one `Atomics.waitAsync` at a time, dropped when
another frame is drawn, a timeout without progress waiting again without drawing, at most a
minute). A picture that cannot be decoded ends the waiting once nothing else is pending.
The document's other pictures are taken in while the stage is idle (`Stage::upload_pictures`,
`uploadRemainingPictures`), and workers decode them only while the ones waiting are under a budget
([memory.md](memory.md)).
Measured opening URIEL 3 at tick 44 in Electron: 9 and 13 extra frames in two runs, all within
the first 1.3 s, none afterwards; the cel is there.

## Thumbnails, library previews and the camera monitor

The other places the editor draws pictures use the same GPU renderer as the stage, so they show what the
stage shows. Where no GPU path serves them (a stage on WebGL2 for thumbnails, a worker without a GPU
device or whose canvas gives no pixels for library previews and exports), the CPU rasterizer draws the
same pixels in a worker ([CPU](#cpu-styk-raster), [The CPU paths](#the-cpu-paths)). No picture outside the
stage is drawn by JavaScript renderer code: where the engine cannot draw one (a failed engine, a page
without the engine's worker threads, a stage that gets no GPU device at all), the picture is not drawn.

**Frame thumbnails** (the timeline's filmstrip cards at 320×192, the export dialog's stage and
strip at up to 512×288 and 96×60): `src/engine/engine-thumbnails.mjs` is the object the filmstrip and the export dialog
draw with (`renderThumbnail` resolves `false` for a thumbnail the engine did
not draw, and the filmstrip asks again later). For a thumbnail it brings the engine to the
editor's revision (`src/engine/engine-document.mjs`, the synchronisation exports use), then asks
the stage (`renderThumbnail` in `engine-stage.mjs`, `Stage::prepare_thumbnail` and
`render_thumbnail` in `styk-wasm/src/views.rs`): the tick's frame is prepared on the engine's
workers by an `ExportFrames` pinned to the revision (the interface thread only checks
`ExportFrames::ready`, never evaluates, D7), every picture of the document is uploaded first,
then a renderer of the thumbnails' own, sampling the stage's sprite atlas
(`Renderer::share_sprites`), draws it on the stage's device into an `OffscreenCanvas`, framed as
the filmstrip frames it (`styk_engine::thumbnails::card`: the canvas fitted and centred on a
`#f5f5f5` card, through the scene camera, effects drawn, the document's hidden layers hidden),
and the interface copies that canvas onto the card in the same task. Where the stage cannot draw
thumbnails (a WebGL2 stage cannot present one device to a second canvas; a WebGPU canvas failing the
magenta probe), the preview worker below draws them on the CPU (`Previews::thumbnail`): it holds an
engine handle (an address made when the request is sent, consumed in the worker), pins the revision
with an `ExportFrames`, waits on the engine's progress counter for the frame (prepared on the engine's
workers) and every picture (decoded there once per document lineage: a later revision decodes only
the images and drawing cels the earlier one lacked, `ExportFrames::decode_images_since`), rasterizes
the card with styk-raster and hands it over as an `ImageBitmap`, which the interface draws onto the
card. No copy of the document goes to a thumbnail worker. Thumbnails show parallax layers moved by the camera, as playback does.

**Library previews** (`src/library-files.mjs`, `src/library-hover-preview.mjs`): one preview
worker per page (`src/engine/engine-previews.mjs`, `engine-preview-worker.mjs`) joins the
engine's shared memory and gets a GPU device of its own (WebGPU in the worker, else WebGL2 on its
`OffscreenCanvas`). It opens a library file apart from the open document
(`styk_engine::thumbnails::library`, `styk_wasm::preview::Previews`) and draws it with the stage's
renderer: a saved asset's poster from its saved bytes (tick 0, or the first of fifteen evenly
spaced ticks with artwork, fitted to its bounds with a tenth of margin, on transparency), and the
hover animation (fitted to the union of sixteen sampled frames, grown by every frame drawn). Bounds
are the editor's: `objectBounds` with each item's effect padding
(`styk_eval::drawlist::artwork_bounds`) joined with the generated effects' reach
(`Batch::bounds`, `generatorBatchBounds`). Each picture leaves the canvas as an `ImageBitmap`
(`transferToImageBitmap`); nothing is read back. The card's backdrop is chosen in the worker from
sixteen 40-pixel samples by `libraryPreviewMatte` (`src/library-matte.mjs`). Requests run one at a time; one cancelled before it starts is never sent. The
worker stays between hovers and is released after five idle minutes (its device destroyed, its
memory and thread stack freed, then it ends; terminated if it does not answer within 5 s). A worker
that gets no GPU device, or whose canvas fails the probe, draws the same pictures with the CPU
rasterizer (`Previews::create_cpu`) and puts them on a 2D `OffscreenCanvas` to hand them over the
same way; a file the engine cannot read shows no preview. The worker's
first answer says which (`EnginePreviewWorker.stats.backend`, `cpu`, `gpuRefusal`).

**Other pictures** (`src/engine/engine-pictures.mjs`): the preview worker also draws what the interface needs
beyond the stage. `sketch` (`Previews::sketch`) opens a small document the interface built, as a library
file is opened (`json` is the editor's own document form), draws its frame at a tick placed as a
`Placement` says (the canvas fitted on a card, the canvas through its scene camera at a zoom and pan, the
artwork fitted with a margin, or a given matrix) on transparency, a colour or the document's own
backgrounds, and says whether the frame has artwork. It draws the effects catalogue's stills
(`src/vfx-preset-preview.mjs`: a figure on a dark stage at a characteristic tick), the asset library's
figure thumbnails, the background dialog's preview and the rig test's pictures (the test editor's pose
framed by the dialog's view, and the examples gallery). `pose` (`Previews::pose`) draws a pose of the open
document, like an edit frame of the stage but through the camera it carries, with the document at the
editor's revision: the parallax monitor (`src/camera-motion-ui.mjs`), which shows how a camera position
moves the layers. Both run in the worker, on its device or the CPU, one request at a time, and hand the
picture over as an `ImageBitmap`; a request cancelled before it starts is never sent.

**The camera monitor** (`src/camera-monitor.mjs`, in the Camera inspector): where the engine drew
the stage's frame, `drawCameraMonitor` on the stage (`Stage::render_monitor`) draws that frame
again through the scene camera, on the stage's device with a renderer of the monitor's own: a
prepared playback frame from the cache, or the edit frame encoded again with the camera's parallax
and without onion skins (kept while the frame does not change). The auxiliary worker
draws WebGL2 monitor requests through the engine's CPU path. A picture that arrives from the worker asks the app
for the monitor alone to be painted again (`onMonitorPicture`), never for another scene render.

Prepared playback packets bind generation, cache epoch and exact finite sample. The
native drawing boundary refuses stale or malformed tickets and preserves the scalar
actual shown identity, surface and renderer ownership. A monitor captures that actual
shown ticket and checks its epoch before and after worker preparation; it cannot repair
an old ticket using newer hidden/effect/resource settings. Same-epoch cache eviction
can still be repaired on the worker. Bitmap acceptance checks the native monitor version
again. While cold, the existing accepted bitmap is painted again at the same view,
because the camera inspector clears its canvas before calling the adapter; resized or
moved views never stretch the previous bitmap. There is still one pending request and
one accepted bitmap, and late replacements close without advancing either shown head.

The final prepared-ticket build is 9,817,728 bytes (9,588 KiB, SHA `d155ab99b159`).
Focused native checks pass 140 engine tests and 35 playback/stage/preview JavaScript
tests. Four actual source mutations expose missing ticket/epoch or wait-result guards
and restore byte-exact. The real app checks generation, hidden/effect epochs, malformed
keys, native-boundary refusals and retained worker-monitor pixels while preserving
document/history/selection. Auxiliary cel pixel parity remains separately open; this
identity correction does not change its clipping or sampling policy.

The direct Canvas monitor now has an explicit portable paint context. An actual-Shown
Edit ticket selects `PaintContext::CanvasDirect`; prepared playback and ordinary GPU,
export and library paths keep the Native default. `styk_eval::view::background_bounds`
matches the existing camera-aware background owner without preparing another frame.
GPU and CPU apply the Canvas artboard mask at each root paint/composite, preserving
isolated-child opacity and painter order. Solid rectangle coverage uses the original
matrix classification, including tiny nonzero skew, and transformed backgrounds keep
all four paint corners. General rotated analytic coverage remains separate work.
No primitive kind, draw-list format, stored field or parity threshold changes.

Portable mobile pin additions are `BackgroundBounds`, `background_bounds`,
`styk_render::paint::{PaintContext, CanvasClip, PaintQuad, mask_premultiplied,
background_image_bounds, rect_pixel_area}` and the explicit Renderer/Raster
paint-context setters. The shared private GPU view uniform and shader carry this
context together; clients must rebuild both. The browser-private
`MonitorRequest::direct_canvas` stays in styk-wasm. Current generation/cache epoch/weak frame identity and monitor ticket owners
remain unchanged. Active scene-effects camera-image composition, the full drawing-cel
monitor residual, auxiliary onion, crisp export and complete D7 remain open.

The composed shipping build is 10,124,565 bytes (9,887 KiB, SHA `b155e35fe6a6`).
Shared-type checks pass 743 native tests, 45 focused JavaScript tests and check;
all 3,618 fixture JSON stay byte-stable. The actual adapter passes six direct monitor
cases each on web, default Electron and forced CPU web, plus both tiny-angle cases
on web at DPR 1. Maximum means are .057554, .072203, .057554 and .025180 respectively,
with zero solid pixels and unchanged D13. Four original default Electron cel stage
views remain byte-identical to the preserved prior captures. A separate full cel
monitor diagnostic still fails on web at mean .362844 and Electron at .710108;
these diagnostics are not included in the 24 passing comparisons. The Electron
corner-overlap result varies within D13 from isolated source evidence; its cause
is not established, so no deterministic pixel or performance improvement is claimed.
Logs and source/artifact receipts: `tmp/root-verification-temp/renderer-publication-*`.

The recorded ordinary solid-background camera-monitor correction now splits the
existing root paint from its foreground. `CanvasForeground` omits only the single
resolved solid root fill; the same ready frame and draw list still produce the
foreground on the preview worker. Its 19-scalar descriptor carries the exact solid
rectangle, colour, camera matrix, clip and DPR with that bitmap. SceneFX, non-solid
backgrounds and generated/glyph/depth sources retain their existing routes.

The renderer records a GPU source only after its effect execution succeeds and the
owning composite actually consumes it, including transformed show bounds, clip,
opacity and nested consumption. Hidden, unplaced or clipped sources cannot set the
receipt. A direct source uses the recorded `ImageData` bitmap adaptation; a completed
GPU source keeps its existing GPU bitmap. CPU preparation reuses the pixels already
drawn. GPU direct-source adaptation still draws on both GPU and CPU in the worker;
this is bounded existing work, not a claimed speed improvement.

The monitor records an actual successful paint on its DOM canvas. Only a GPU source
that is this canvas's first successful paint schedules the existing invalidation
once. Document/stage switches and backing-size changes preserve that history, so
empty-to-undo and DPR restore follow the editor's destination. The old nonthreaded
route records success only after `drawImage` completes. Context recovery controls
use synthetic DOM events; they do not certify physical device loss.

Additional mobile pin notes: `PaintContext::CanvasForeground` changes exhaustive enum
matches; `Renderer::root_gpu_source`, `drawlist::plain_solid_background` and the
EditScene/MonitorFrame predicates are portable additions. The public paint helpers
include `PaintQuad::rectangle`, `pixel_area` and `canvas_alpha(matrix, pixel)`.
The DPR monitor argument, `monitor_background`, `monitor_pixels` and completion
callback belong to styk-wasm/browser adapters. Primitive records remain 64 bytes.
Final composed source/artifact and app receipts are recorded with the renderer
milestone in the plan; earlier failing captures above remain historical evidence.

**Home and project pictures** are read from the stage's canvas (`stagePicture` in `src/app.mjs`):
the engine's canvas where the engine draws the scene. They need no path of their own.

**The GPU first, then the CPU.** A thumbnail on the stage's device takes about a millisecond and
samples the stage's own atlas; the CPU takes 3–40 ms in the worker (below) and needs the pictures
decoded for it. So the GPU draws wherever it can, and the CPU where no GPU path exists. The CPU
rasterizer of the time (tiny-skia, since replaced by the GPU's pipeline on the CPU,
[CPU](#cpu-styk-raster)) was tried first for thumbnails and library previews (no device, no shared
atlas, works without a GPU) and dropped, measured in the app: its
edges take three partial-coverage levels where the editor's Canvas 2D takes about 220 and the GPU
about 250 (a library poster: mean difference 0.52 from Canvas 2D on a plain figure, edges only); it
draws no filter effects (such frames had to fall back); and near-coplanar 3D faces resolve
differently from the GPU (15 Guns tick 5 at 512×288: 21 solid pixels against the GPU's picture,
where a receiver face showed through a stock). Drawing on the GPU gives the stage's pixels: an engine
thumbnail equals the engine's export frame of that tick at the canvas's size (`--export-check`
below: 89 of 121 identical, the rest within 2 levels but one pixel at 24, mean ≤ 0.008), and export
frames equal the stage's.

**Testing**: `cargo test -p styk-engine --test thumbnails` (thumbnail frames prepared on workers and
never evaluated by asking, the library fit and wrap-around, a file's own pictures),
`cargo test -p styk-engine --lib` (the card's framing), `cargo test -p styk-eval --test vfx_layers`
(`artwork_bounds` with effect padding) and `--test generators` (`Batch::bounds` holds every live
particle), `node --test tests/engine-previews.test.mjs` (which renderer draws a thumbnail, the
preview worker's CPU thumbnails from the engine's document, the thumbnails not drawn, the preview
worker's queue, messages made when sent, cancellation, failure and release, the camera monitor's
one pending request), `tests/camera-monitor-visibility.test.mjs`, `tests/asset-library.browser.mjs`
in the app. Measured when the pictures moved to the
engine (Electron, an RTX 4070 SUPER): a 320×192 thumbnail of an open document took 1.7–7 ms on the stage's
device (the first 1.8–8.8 ms, no worker to start), a library poster 11–34 ms and a hover frame
0.5–2 ms once the preview worker ran, the camera monitor 0.5–0.7 ms of the interface thread. Not
measured: other GPUs, Windows, macOS, a real display, the web build in browsers with WebGPU, packaged
builds.

### The CPU paths

Where no GPU path serves them, thumbnails, library previews and exports are drawn by styk-raster
in their workers, never on the interface thread (D7), with nothing to wait for but the engine's
workers: thumbnails and library previews in the preview worker (`Previews::thumbnail`,
`Previews::create_cpu`), exports in the export worker (`ExportRenderer::create_cpu`,
`styk_export::CpuExport`: tiles of at most 1,024 pixels a side, each drawn when asked for, at most
four waiting, so nothing is drawn ahead). Pictures are the decoded images the engine's workers give
them, shared rather than copied; the preview worker keeps those of the open document's lineage
between thumbnails and lets them go with its idle release (five minutes) or a new document; an
export's go with its worker. A stage that gets no GPU device at all holds no document in the engine: thumbnails and exports
are then not drawn (library previews still use the CPU there).

**Measured** (a parity script since removed with the JavaScript paths it compared against, `--cpu-check`, Electron under Xvfb with
`--use-angle=vulkan`, 2026-10-04, load averages 8–18): each engine thumbnail drawn by the stage's
GPU and again by the preview worker's CPU, each library poster and hover frame by a GPU preview
worker and a CPU one, and an export frame of each tick at the canvas size by a GPU export worker and
a CPU one, compared by D13. Seven repository documents (15 Guns, Vehicles, Impact, Karate, the
effects, explosions and drawing-cel fixtures) and URIEL 3 (private corpus), five frame starts each,
three library files: 140 steps, 139 pass; the one failure is 15 Guns tick 1's export (9 solid
pixels where near-coplanar faces meet, as natively). Times as the interface sees them (the request
until the picture is on the card), medians over the ticks, GPU / CPU: thumbnails at 320×192
2.3–3.8 / 8.9–27.7 ms for the scenes (15 Guns 27.7, URIEL 3 22.8, Vehicles 15.5, Karate 10.2,
Impact 8.9), 1.4–1.9 / 3.5–7.9 ms for the explosions and drawing-cel fixtures, and 1.4 / 153.7 ms
for the effects fixture (fourteen effects on one figure); at 512×288 0.7–4.5 / 6.3–38.1 ms
(effects fixture 272.2 ms); at 96×54 0.7–6.1 / 1.0–20.7 ms (effects fixture 115.7 ms). An export's
first frame, the worker's start included: GPU 420–1,086 ms (its device), CPU 244–768 ms (effects
fixture 1,035 ms).

## Exports

For a document the engine draws, export frames (PNG, PNG and JPEG sequences, GIF, APNG and
video frames) come from the engine: the frame the stage would show at that tick, through the
scene camera, at the export's size and sampling, without onion skins. The encoders (the PNG,
GIF, APNG and ZIP writers, WebCodecs, FFmpeg, the audio mix) are unchanged and receive the
same canvases and PNG frames as before. SVG is the engine's too (below): the frame's draw list written as
vector artwork. A page without the engine's worker threads cannot export.

Composited No smoothing frames preserve the editor's existing `exportSVG` fallback
policy. Active effect scopes (including its broad owner scan), a truthy generator
batch even with zero emitted particles, or visible mesh/depth artwork select smooth
whole-frame output. Nested scene/container effects propagate through the same typed
VFX/geometry owners. Ordinary frames retain crisp edges. The decision is host metadata
on the live draw list, not a serialized primitive-format change.

Mobile pin changes: public `Frame.export_vfx: Vec<bool>`, `geometry::Item.export_vfx:
bool` and `DrawList.composited_export: bool` affect exhaustive struct literals. Frame
and DrawList callers may use Default; Item callers must supply its new field.
`Smoothing::edges_for`, `Raster::set_edges` and `Renderer::set_edges` are additive.
GPU mode changes reset sample-dependent base/additive/depth pipelines and targets
while retaining the list, pictures, glyphs, atlas and effects. Actual retained
Smooth→Crisp→Smooth tests include image, depth and additive primitives.

The 25 Editor/browser policy records preserve the original 22 inputs byte for byte.
Composited synthetic None output is byte-identical to the original smooth output;
CPU/GPU differ by D13 mean 0.0004, maximum 3, zero solids. The plain drawing No smoothing
sampling gap is separate: CPU versus JavaScript mean 0.5124, zero solids, with the
original and corrected CLI output byte-identical. No policy or threshold was expanded
to conceal that existing gap.

**SVG** (`styk_export::svg`, `ExportRenderer::svg`). An SVG export is editable vectors, written from the
frame's draw list: strokes (round caps, `square` for square lines, arcs as SVG arcs, polylines with round
joins), circles and rings, polygons and the triangles of text merged into one path a run, so no
seam shows, linear and radial gradients as SVG gradients, translucent groups as groups with an
opacity, sprites embedded once (a PNG, JPEG or GIF as it is stored, other formats and colour-keyed
sprites as PNG) and used where they appear, a background picture with its edge pixels stretched over
the rest of the view, and one group carrying the scene camera. Frames that have no vector form
become one embedded picture of the frame, drawn by the CPU rasterizer at the output's size: filter
and generated effects, 3D faces, drawing cels, conic and diamond gradients, and the frames the
document's effects policy composites (`DrawList::composited_export`). The markup differs from
the JavaScript exporter's that this replaced (no `data-object-id` groups, text as triangles rather
than glyph outlines, one element a circle, no edge-extension seams); the picture is the stage's.
An SVG export starts the export worker with `vector` set: it takes no GPU device and no tiles, and
hands over the file as a `Blob`.

**Where it runs.** `src/engine/engine-export.mjs` gives the export a renderer: `EngineExportFrames`,
whose worker is `src/engine/engine-export-worker.mjs`. The worker joins the engine's shared memory like a
preparation worker but keeps its event loop, holds a GPU device of its own (WebGPU in the
worker, else WebGL2 on an `OffscreenCanvas`) and runs `ExportRenderer` (`styk-wasm`): nothing
of an export is evaluated, drawn or read back on the interface thread (D7). `EngineExportFrames` owns what
an export needs around it: one request at a time with a timeout each, progress, revision checks (an edit during
the export cancels it), the retry ladder and the output canvas, so the export dialog and the encoders see
one object. Before the worker starts, the export waits for the engine to hold the export's revision
(`engineDocument` in `engine-document.mjs`: the editor's session publishes every change at its
revision, so this answers at once unless an edit is still on its way) and then asks what only the stage
knows (drawings just published: `prepareExport`).
Starting the worker (its modules, joining the engine, the GPU device and the renderer's
pipelines) took 400–500 ms in Electron, so the export dialog starts one when it opens
(`prewarmExportRenderer`, `ExportDevice`); the export takes it, and a worker no export takes
within a minute is released. A worker that cannot get a GPU device draws the export with the CPU
rasterizer instead ([The CPU paths](#the-cpu-paths)). A document the engine does not draw, a page
without worker threads (not cross-origin isolated) or an engine worker that cannot start the export
fails the export with the reason, decided before the first frame.

**Frames.** `styk_engine::export::ExportFrames` pins the generation of the export's revision
and evaluates ticks as playback does: effects drawn (exports ignore the editor's effects
preview), the session's hidden figures shown, the document's hidden layers hidden, generated
effects with every earlier anchor evaluated. Up to eight following ticks are prepared on the
engine's workers. The pose the editor shows (a PNG of the current frame) crosses as document
chunks and is drawn by an `EditScene` without onion skins. Every
picture of the document is decoded for the export's device before the first frame, so an
export never shows a frame without one.

**Settings** (`styk-export`):

| Export setting | Engine |
| --- | --- |
| Size | The canvas scaled to the output: `scale(output / canvas)` then the scene camera (`view::tile_view`); an output of another shape stretches (`ViewParams::stretch`), as `drawExportScene` does. |
| Smooth edges | `Edges::Smooth`: four samples a pixel, analytic shapes covered by distance; sprites to the nearest texel. |
| No smoothing | `Edges::Crisp`: one sample a pixel at its centre, every shape fully in or out (hairlines one solid pixel), lone glyphs from their outlines, layers and drawing cels to the nearest texel; opacity kept. Crisp edges apply to every frame, including those with effects, generated effects or 3D; filtered pixels stay filtered. |
| Smooth sprites | Drawn at twice the width and height, each 2×2 block averaged in premultiplied colour (`pixels::resolve`). |
| Background | The scene's, from the draw list; transparent where the scene has none. |
| Video without alpha | Composited over black by the engine before any rounding (`matte`). |
| Scene effects | The camera image follows the output's density (`ViewParams::camera_limit` unbounded) within the effect surface (3,968 pixels); the stage caps it at 2,048. |

**Memory** (D11). A frame is drawn in equal tiles of at most 2,048 rendered pixels a side
(`tiles::TILE_SIDE`), each the same view shifted by whole pixels: the renderer's targets (frame,
samples, isolation atlas pages, depth) stay those of one tile whatever the output, about the
stage's own. Tiles are read back into at most eight slots of 64 MiB together; the worker keeps
one tile's pixels and the output canvas. The export's device holds its own sprite atlas, the
size of the stage's. Frames prepared ahead are at most eight draw lists. A GPU out-of-memory
error or a lost device retries the frame with half the tile side, then once with a new worker
and device (the export renderer's ladder), then fails; nothing is written.

**Read-back.** A browser hands a mapped buffer over only when its GPU process gets to it. In
Electron under Xvfb that took 3–5 ms a frame while the page was still and 60–320 ms while the
page repainted (the export dialog's progress repaints every frame), against well under a
millisecond of drawing. So the worker draws the export's next frames ahead into free read-back
slots (at most six frames) while earlier ones are mapped, and puts a frame on its canvas only
when the encoder asks for it; frames drawn ahead for another order (a second GIF pass, the
current pose) are given back unread. WebGL2 (a worker without WebGPU, as headless Chromium here)
completes a read-back only when its device is polled: the worker polls between turns of its event
loop until it does.

**Cancellation and failure.** Cancelling, closing the dialog or a revision change rejects the
pending request at once; the worker is asked to `release`: it destroys the
device, lets the read-backs that rejects settle, frees the renderer and gives back its thread's
stack, then closes ([threading.md](threading.md)). A worker that does
not answer within 5 s is terminated. The save layer is unchanged: a cancelled or failed export
leaves an existing file untouched.

**Why the GPU, measured** (`styk export`, native, RTX 4070 SUPER, 1,920×1,080, Smooth edges, the
median of 10 frames each, the same draw lists, the GPU time including the read-back of the
frame; 2026-10-03, load average 6–7; the CPU column is the tiny-skia rasterizer of the time):

| Document | GPU | CPU (`styk-raster`, tiny-skia) |
| --- | ---: | ---: |
| The start document | 12.6 ms | 14.3 ms |
| Impact-FX-Fight.styk (effects, generated effects, captions) | 13.1 ms | 186.9 ms, without its effects |
| Vehicles-Pivot-3D.styk (3D, text) | 13.6 ms | 409.0 ms |
| 15-Guns-Pivot-3D.styk (3D, text) | 13.7 ms | 444.8 ms |
| generators/explosions.json (generated effects) | 13.3 ms | 258.8 ms |
| hitoshi vs suzu tomiee ssj.piv (private corpus, a Pivot import) | 12.3 ms | 179.8 ms |
| TDD2 URIEL NEMESIS 3.styk (private corpus; effects, drawing cels) | 12.2 ms | 97.6 ms, without its effects |

The CPU rasterizer also draws no filter effects and no camera image, and runs without SIMD in
WebAssembly; WebGPU in a worker draws everything the stage draws with the stage's own renderer. A
native renderer in Electron's main process would have added a second build per platform and an
IPC copy of every frame for what WebGPU in a worker already gives.

### Measured

Recorded 2026-10-03 in Electron under Xvfb (`--use-angle=vulkan`, so WebGPU is the NVIDIA adapter), on a
machine shared with other work, with a parity script since removed with the JavaScript exporter it compared
against.

**Pixels.** Engine export frames against the engine's stage drawing the same tick through the
camera at the same size: **identical, every pixel**, at Smooth edges on all seven documents (21
frames; 1,280×720 for the 16:9 documents and the 960×540 ones, 1,280×640 for URIEL 3, 1,140×630
for hitoshi, each the canvas's own shape).

**Speed** (PNG frames at about 1,920×1,080, the time includes starting the renderer and the first
frame): 20–25 ms a frame for the start document, Impact, Vehicles, 15 Guns and the drawing documents,
41 ms for the explosions fixture, 22–32 ms for URIEL 3. The first frame waits for every picture (URIEL 3:
0.8–0.9 s for its drawing cels). The export's own GPU device costs 52–361 MiB of GPU memory: the
read-back slots (up to 64 MiB), the frame's samples and layer pages, and a second copy of the document's
sprite atlas, the stage keeping its own. Exports through the app (the export dialog opens 1.5 s before each
export): Impact-FX-Fight.styk, 240 frames at 1,920×1,080, PNG sequence 16–19 s, APNG 22–25 s, GIF 53–65 s,
MP4 14–19 s, WebM 15–20 s; the start document's 10 frames at 960×540 took 0.7–1.3 s a format.

**Cancellation and failure** (`--cancel`, `--integrity`): on Impact-FX-Fight.styk and TDD2 URIEL
NEMESIS 3.styk, ten exports aborted after their first frame left no export worker, every worker
said it had released its memory and device, and the engine's memory stayed where it was (87 and
364 MiB); the app's PNG-sequence export over an existing file, cancelled from the progress dialog
after two frames and failed in the engine's worker (a frame outside the animation), left the file
byte for byte as it was and no export worker. The GPU memory `nvidia-smi` attributes to the app
went back down on URIEL 3 (393 → 384 → 383 MiB); on Impact, in a later run, the first cancelled
export left it 42 MiB higher (249 → 291 MiB) and the failed one after it did not raise it (291 →
290 MiB). The engine's memory grew with the first export of a session (Impact 79 → 87 and 83 → 90
MiB, the allocator's high-water mark) and not afterwards. Before the
release order was fixed ([threading.md](threading.md)), cancelling URIEL 3's export crashed the
page, twice in two runs; it did not in the two runs since.

## Testing

`cargo test -p styk-export` (settings and their limits, tiles covering every pixel once, the
output view, the 2×2 average against the JavaScript rule, and on a GPU: tiles against the whole
frame by D13 with no seam along tile edges, crisp edges without partly covered pixels, Smooth
sprites as the average of a frame drawn twice as large, the black matte);
`cargo test -p styk-engine --test export`; `cargo test -p styk-render --test glyphs` (crisp
edges fill no glyph mask); `cargo test -p styk-export --test svg` (plain artwork as vectors, what has no
vector form as one picture); `node --test tests/engine-export.test.mjs` (the worker's protocol, the
retry ladder, cancellation, warming, vector exports); `tests/svg-export.browser.mjs` (the SVG decoded in
the browser against the engine's own pixels); `styk export <file>
<ticks> <out> [--size WxH] [--smoothing edges|none|sprites] [--tile N] [--cpu]`.

`cargo test -p styk-raster` (the target's samples, the rasterization rules, effect windows
against per-pixel shading; strokes covered by distance, no seams between adjacent triangles,
translucent faces blending in drawing order, filtered layers; each fails on the tiny-skia
rasterizer; on a GPU, six repository documents by D13 against styk-render, and the generator
fixture), `styk raster-parity [--export] [--crisp] [--library] [--census] [--ticks N]
[--out dir] --list …` (the CPU against the GPU over a corpus, above);
`cargo test -p styk-render -p styk-raster`; text: `cargo test -p styk-eval --test text`
(raster entries, glyph records and their mask layouts against numbers the editor printed,
finer curves for large text; each fails without its rule), `-p styk-render --test glyphs`
(masks draw the glyphs, are kept across frames, give way to triangles past density 8) and
the `styk-draw` unit test of `GlyphMask::layout`; `styk render` prints the rounds, layer
memory and glyph masks of a frame; `styk render` / `styk raster` /
`styk diff` for native comparisons ([D13](decisions/0013-app-parity-rule.md)).
